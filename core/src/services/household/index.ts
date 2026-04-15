/**
 * Household service.
 *
 * Manages top-level tenant boundaries. Each registered user belongs to
 * exactly one household. Provides boundary assertion helpers used by
 * DataStore and other services to enforce per-household data isolation.
 *
 * Storage:
 * - Definitions: data/system/households.yaml — keyed by household ID
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { Household } from '../../types/household.js';
import type { RegisteredUser } from '../../types/users.js';
import { ensureDir } from '../../utils/file.js';
import { readYamlFileStrict, writeYamlFile } from '../../utils/yaml.js';

/** Shape of households.yaml: { householdId: Household } */
type HouseholdData = Record<string, Household>;

/** SAFE_SEGMENT pattern — must match the same pattern used elsewhere in PAS. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;

/**
 * Thrown when two users that are expected to share a household do not.
 * Used by requireSameHousehold() and assertUserCanAccessHousehold().
 */
export class HouseholdBoundaryError extends Error {
	constructor(
		public readonly householdIdA: string | null,
		public readonly householdIdB: string | null,
		detail?: string,
	) {
		super(
			detail ??
				`Household boundary violation: ${householdIdA ?? 'none'} vs ${householdIdB ?? 'none'}`,
		);
		this.name = 'HouseholdBoundaryError';
	}
}

/**
 * Thrown when a user tries to access a household they do not belong to.
 */
export class UserBoundaryError extends Error {
	constructor(
		public readonly actorId: string,
		public readonly targetId: string,
		detail?: string,
	) {
		super(detail ?? `User boundary violation: actor=${actorId} target=${targetId}`);
		this.name = 'UserBoundaryError';
	}
}

export interface HouseholdServiceOptions {
	dataDir: string;
	/** Initial user list to build the userId→householdId map. */
	users: ReadonlyArray<RegisteredUser>;
	logger: Logger;
}

export class HouseholdService {
	private readonly householdsPath: string;
	private readonly dataDir: string;
	private readonly logger: Logger;

	private households: HouseholdData = {};

	/**
	 * Hot-path lookup: userId → householdId.
	 * Built from the users list at construction and kept in sync via syncUser().
	 */
	private readonly userHouseholdMap: Map<string, string> = new Map();

	/**
	 * Registry of RegisteredUser objects for getMembers() lookups.
	 * Populated at construction from the users option and kept in sync via syncUser().
	 */
	private readonly memberRegistry: RegisteredUser[] = [];

	/** Promise chain for serializing write operations (prevents concurrent YAML corruption). */
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: HouseholdServiceOptions) {
		this.dataDir = options.dataDir;
		this.householdsPath = join(options.dataDir, 'system', 'households.yaml');
		this.logger = options.logger;

		// Build userId→householdId map and member registry from initial user list
		for (const user of options.users) {
			if (user.householdId) {
				this.userHouseholdMap.set(user.id, user.householdId);
			}
			this.memberRegistry.push(user);
		}
	}

	/** Load household definitions from disk. Call once after construction. */
	async init(): Promise<void> {
		await ensureDir(join(this.dataDir, 'system'));

		const strictResult = await readYamlFileStrict(this.householdsPath);
		if (strictResult === null) {
			// File doesn't exist — no households configured yet
		} else if ('error' in strictResult) {
			this.logger.warn(
				{ error: strictResult.error },
				'Failed to parse households.yaml — treating as empty',
			);
		} else {
			const rawHouseholds = (strictResult.data as Record<string, unknown>) ?? {};
			const validHouseholds: HouseholdData = {};
			for (const [key, value] of Object.entries(rawHouseholds)) {
				if (!isValidHouseholdEntry(key, value)) {
					this.logger.warn(
						{ householdKey: key },
						'Excluding invalid household entry from operational map',
					);
					continue;
				}
				validHouseholds[key] = value as Household;
			}
			this.households = validHouseholds;
		}

		this.logger.info(
			{ count: Object.keys(this.households).length },
			'Household service initialized',
		);
	}

	/**
	 * Create a new household.
	 *
	 * The household ID is generated from the name via slugification.
	 * If the generated slug conflicts with an existing ID, a numeric suffix is appended.
	 *
	 * @param name - Human-readable household name.
	 * @param createdBy - User ID of the creator (becomes first admin).
	 * @param adminUserIds - Additional admin user IDs (creator always added).
	 */
	async createHousehold(
		name: string,
		createdBy: string,
		adminUserIds: string[] = [],
	): Promise<Household> {
		const trimmedName = name.trim();
		if (!trimmedName) {
			throw new Error('Household name is required');
		}

		const baseSlug = slugify(trimmedName);
		if (!SAFE_SEGMENT.test(baseSlug)) {
			throw new Error(
				`Cannot generate a valid ID from name "${name}". Use alphanumeric characters, hyphens, or underscores.`,
			);
		}

		return this.enqueue(async () => {
			// Find a unique slug
			let id = baseSlug;
			let suffix = 2;
			while (this.households[id]) {
				id = `${baseSlug}-${suffix}`;
				suffix++;
			}

			// Merge adminUserIds, always including createdBy
			const admins = Array.from(new Set([createdBy, ...adminUserIds]));

			const household: Household = {
				id,
				name: trimmedName,
				createdAt: new Date().toISOString(),
				createdBy,
				adminUserIds: admins,
			};

			this.households[id] = household;
			await this.persist();

			this.logger.info({ householdId: id, createdBy }, 'Household created');
			return household;
		});
	}

	/** Get a household by ID. Returns null if not found. */
	getHousehold(id: string): Household | null {
		return this.households[id] ?? null;
	}

	/** Get all households, sorted by name. */
	listHouseholds(): Household[] {
		return Object.values(this.households).sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Hot-path: get the household ID for a user.
	 * Uses the in-memory userId→householdId map — O(1).
	 * Returns null if user has no household assigned.
	 */
	getHouseholdForUser(userId: string): string | null {
		return this.userHouseholdMap.get(userId) ?? null;
	}

	/**
	 * Get all registered users that belong to a household.
	 * Scans the userId→householdId map; does not read from disk.
	 *
	 * Note: The returned users are the RegisteredUser objects that were passed
	 * to syncUser() / the constructor. The caller is responsible for providing
	 * user objects via syncUser() when users join or leave.
	 */
	getMembers(hhId: string): RegisteredUser[] {
		return this.memberRegistry.filter((u) => u.householdId === hhId);
	}

	/**
	 * Add a user to an admin role within a household.
	 * No-op if already an admin.
	 */
	async addAdmin(hhId: string, userId: string): Promise<void> {
		const hh = this.households[hhId];
		if (!hh) {
			throw new Error(`Household "${hhId}" not found`);
		}

		return this.enqueue(async () => {
			const hh2 = this.households[hhId];
			if (!hh2) throw new Error(`Household "${hhId}" not found`);

			if (!hh2.adminUserIds.includes(userId)) {
				hh2.adminUserIds = [...hh2.adminUserIds, userId];
				await this.persist();
				this.logger.info({ householdId: hhId, userId }, 'Admin added to household');
			}
		});
	}

	/**
	 * Remove a user from the admin role within a household.
	 * Throws if the user is the last admin (must always have at least one admin).
	 */
	async removeAdmin(hhId: string, userId: string): Promise<void> {
		const hh = this.households[hhId];
		if (!hh) {
			throw new Error(`Household "${hhId}" not found`);
		}

		return this.enqueue(async () => {
			const hh2 = this.households[hhId];
			if (!hh2) throw new Error(`Household "${hhId}" not found`);

			if (!hh2.adminUserIds.includes(userId)) {
				// Not an admin — silently succeed (idempotent)
				return;
			}

			if (hh2.adminUserIds.length <= 1) {
				throw new Error(
					`Cannot remove the last admin from household "${hhId}". Assign another admin first.`,
				);
			}

			hh2.adminUserIds = hh2.adminUserIds.filter((id) => id !== userId);
			await this.persist();
			this.logger.info({ householdId: hhId, userId }, 'Admin removed from household');
		});
	}

	/**
	 * Assert that two users belong to the same household.
	 * Throws HouseholdBoundaryError if they differ (or either has no household).
	 */
	requireSameHousehold(userIdA: string, userIdB: string): void {
		const hhA = this.getHouseholdForUser(userIdA);
		const hhB = this.getHouseholdForUser(userIdB);
		if (hhA === null || hhB === null || hhA !== hhB) {
			throw new HouseholdBoundaryError(
				hhA,
				hhB,
				`Users "${userIdA}" (household: ${hhA ?? 'none'}) and "${userIdB}" (household: ${hhB ?? 'none'}) do not share a household`,
			);
		}
	}

	/**
	 * Assert that a user belongs to a specific household.
	 * Throws HouseholdBoundaryError if mismatched.
	 */
	assertUserCanAccessHousehold(userId: string, hhId: string): void {
		const userHhId = this.getHouseholdForUser(userId);
		if (userHhId !== hhId) {
			throw new HouseholdBoundaryError(
				userHhId,
				hhId,
				`User "${userId}" (household: ${userHhId ?? 'none'}) cannot access household "${hhId}"`,
			);
		}
	}

	/**
	 * Remove a user from the in-memory userId→householdId map and member registry.
	 * Does NOT modify households.yaml — the actual user removal from pas.yaml is
	 * handled by UserMutationService. Call this after a user is removed.
	 */
	removeUser(userId: string): void {
		this.userHouseholdMap.delete(userId);
		const idx = this.memberRegistry.findIndex((u) => u.id === userId);
		if (idx >= 0) {
			this.memberRegistry.splice(idx, 1);
		}
	}

	/**
	 * Sync a user into the userId→householdId map.
	 * Call this when a user is registered, updated, or their householdId changes.
	 * Also adds the user to the member registry for getMembers().
	 */
	syncUser(user: RegisteredUser): void {
		if (user.householdId) {
			this.userHouseholdMap.set(user.id, user.householdId);
		} else {
			this.userHouseholdMap.delete(user.id);
		}

		// Update member registry
		const idx = this.memberRegistry.findIndex((u) => u.id === user.id);
		if (idx >= 0) {
			this.memberRegistry[idx] = user;
		} else {
			this.memberRegistry.push(user);
		}
	}

	// --- Private helpers ---

	/** Enqueue a write operation to serialize concurrent access. */
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.writeQueue.then(fn, fn) as Promise<T>;
		this.writeQueue = p.then(
			() => {},
			() => {},
		);
		return p;
	}

	private async persist(): Promise<void> {
		await ensureDir(join(this.dataDir, 'system'));
		await writeYamlFile(this.householdsPath, this.households);
	}
}

/**
 * Slugify a string into a SAFE_SEGMENT-compatible ID.
 * Converts to lowercase, replaces spaces and special chars with hyphens,
 * collapses consecutive hyphens, trims leading/trailing hyphens.
 */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Validate a raw household entry from YAML: must be an object with required fields.
 */
function isValidHouseholdEntry(key: string, value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v['id'] === 'string' &&
		v['id'] === key &&
		SAFE_SEGMENT.test(v['id']) &&
		typeof v['name'] === 'string' &&
		v['name'].length > 0 &&
		typeof v['createdAt'] === 'string' &&
		typeof v['createdBy'] === 'string' &&
		Array.isArray(v['adminUserIds'])
	);
}
