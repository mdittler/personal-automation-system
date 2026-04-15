/**
 * Space service.
 *
 * Manages named shared data spaces with defined membership.
 * Handles CRUD operations on space definitions, membership management,
 * and per-user active space tracking.
 *
 * Storage:
 * - Definitions: data/system/spaces.yaml — keyed by space ID
 * - Active spaces: data/system/active-spaces.yaml — { userId: spaceId | null }
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { SpaceDefinition } from '../../types/spaces.js';
import {
	MAX_MEMBERS_PER_SPACE,
	MAX_SPACES,
	MAX_SPACE_ID_LENGTH,
	MAX_SPACE_NAME_LENGTH,
	SPACE_ID_PATTERN,
} from '../../types/spaces.js';
import type { HouseholdService } from '../household/index.js';

/** SAFE_SEGMENT — must match the same pattern used elsewhere in PAS. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;
import { ensureDir } from '../../utils/file.js';
import { readYamlFile, readYamlFileStrict, writeYamlFile } from '../../utils/yaml.js';
import type { UserManager } from '../user-manager/index.js';
import type { VaultService } from '../vault/index.js';

/** Shape of spaces.yaml: { spaceId: SpaceDefinition } */
type SpaceData = Record<string, SpaceDefinition>;

/** Shape of active-spaces.yaml: { userId: spaceId | null } */
type ActiveSpaceData = Record<string, string | null>;

export interface SpaceServiceOptions {
	dataDir: string;
	userManager: UserManager;
	logger: Logger;
	/**
	 * Optional — when present, validates that all members of a `kind: 'household'`
	 * space belong to the same household as the space itself.
	 * Absent in transitional mode (pre-migration): cross-household check is skipped.
	 */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
}

/** Validation error for space operations. */
export interface SpaceValidationError {
	field: string;
	message: string;
}

export class SpaceService {
	private readonly spacesPath: string;
	private readonly activeSpacesPath: string;
	private readonly dataDir: string;
	private readonly userManager: UserManager;
	private readonly logger: Logger;

	private spaces: SpaceData = {};
	private activeSpaces: ActiveSpaceData = {};

	/** Optional vault service for symlink management. */
	private vaultService?: VaultService;

	/** Optional — wired post-migration. When absent, cross-household check is skipped. */
	private householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;

	/** Promise chain for serializing write operations (prevents concurrent YAML corruption). */
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: SpaceServiceOptions) {
		this.dataDir = options.dataDir;
		this.spacesPath = join(options.dataDir, 'system', 'spaces.yaml');
		this.activeSpacesPath = join(options.dataDir, 'system', 'active-spaces.yaml');
		this.userManager = options.userManager;
		this.logger = options.logger;
		this.householdService = options.householdService;
	}

	/**
	 * Inject the HouseholdService after construction (bootstrap wiring).
	 * Mirrors the pattern used by DataStoreServiceImpl.
	 */
	setHouseholdService(svc: Pick<HouseholdService, 'getHouseholdForUser'>): void {
		this.householdService = svc;
	}

	/** Load space definitions and active spaces from disk. */
	async init(): Promise<void> {
		await ensureDir(join(this.dataDir, 'system'));

		const strictResult = await readYamlFileStrict(this.spacesPath);
		if (strictResult === null) {
			// File doesn't exist — no spaces configured
		} else if ('error' in strictResult) {
			this.logger.warn(
				{ error: strictResult.error },
				'Failed to parse spaces.yaml — treating as empty',
			);
		} else {
			const rawSpaces = (strictResult.data as Record<string, unknown>) ?? {};
			const validSpaces: SpaceData = {};
			for (const [key, value] of Object.entries(rawSpaces)) {
				if (!isValidSpaceEntry(key, value)) {
					this.logger.warn({ spaceKey: key }, 'Excluding invalid space entry from operational map');
					continue;
				}
				validSpaces[key] = value as SpaceDefinition;
			}
			this.spaces = validSpaces;
		}

		this.activeSpaces = (await readYamlFile<ActiveSpaceData>(this.activeSpacesPath)) ?? {};
		this.logger.info({ count: Object.keys(this.spaces).length }, 'Space service initialized');
	}

	/** Set the vault service for symlink management (optional, called after VaultService is created). */
	setVaultService(vault: VaultService): void {
		this.vaultService = vault;
	}

	/** Get all space definitions. */
	listSpaces(): SpaceDefinition[] {
		return Object.values(this.spaces).sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Get a single space definition by ID. */
	getSpace(id: string): SpaceDefinition | null {
		return this.spaces[id] ?? null;
	}

	/**
	 * Create or update a space definition.
	 * Returns validation errors (empty array = success).
	 */
	async saveSpace(def: SpaceDefinition): Promise<SpaceValidationError[]> {
		const errors = this.validateSpace(def);
		if (errors.length > 0) return errors;

		return this.enqueue(async () => {
			// Check max spaces limit (only on create)
			const isNew = !this.spaces[def.id];
			if (isNew && Object.keys(this.spaces).length >= MAX_SPACES) {
				throw new SpaceLimitError(`Maximum ${MAX_SPACES} spaces allowed`);
			}

			this.spaces[def.id] = def;
			await this.persist();

			this.logger.info({ spaceId: def.id }, isNew ? 'Space created' : 'Space updated');

			// Rebuild vaults for all members of the new/updated space
			if (this.vaultService) {
				for (const memberId of def.members) {
					await this.vaultService
						.rebuildVault(memberId)
						.catch((err) =>
							this.logger.warn(
								{ err, userId: memberId },
								'Failed to rebuild vault after space save',
							),
						);
				}
			}
		}).then(
			() => [],
			(err) => {
				if (err instanceof SpaceLimitError) {
					return [{ field: 'id', message: err.message }];
				}
				throw err;
			},
		);
	}

	/**
	 * Delete a space definition.
	 * Clears active space for any users in this space.
	 * Does NOT delete data on disk.
	 */
	async deleteSpace(id: string): Promise<boolean> {
		if (!this.spaces[id]) return false;

		return this.enqueue(async () => {
			if (!this.spaces[id]) return;

			// Capture members before deletion for vault cleanup
			const memberIds = [...this.spaces[id].members];

			delete this.spaces[id];

			// Clear active space for any users in this space
			let activeChanged = false;
			for (const [userId, activeId] of Object.entries(this.activeSpaces)) {
				if (activeId === id) {
					this.activeSpaces[userId] = null;
					activeChanged = true;
				}
			}

			await this.persist();
			if (activeChanged) {
				await this.persistActiveSpaces();
			}

			this.logger.info({ spaceId: id }, 'Space deleted (data preserved on disk)');

			// Remove space symlinks from all former members' vaults
			if (this.vaultService) {
				await this.vaultService
					.removeSpaceFromAll(id, memberIds)
					.catch((err) =>
						this.logger.warn(
							{ err, spaceId: id },
							'Failed to remove space from vaults after delete',
						),
					);
			}
		}).then(() => true);
	}

	/** Check if a user is a member of a space. */
	isMember(spaceId: string, userId: string): boolean {
		const space = this.spaces[spaceId];
		if (!space) return false;
		return space.members.includes(userId);
	}

	/** Get all spaces where a user is a member. */
	getSpacesForUser(userId: string): SpaceDefinition[] {
		return this.listSpaces().filter((s) => s.members.includes(userId));
	}

	/**
	 * Add a member to a space.
	 * Validates the user is registered and not already a member.
	 */
	async addMember(spaceId: string, userId: string): Promise<SpaceValidationError[]> {
		const space = this.spaces[spaceId];
		if (!space) return [{ field: 'spaceId', message: 'Space not found' }];

		if (!this.userManager.isRegistered(userId)) {
			return [{ field: 'userId', message: 'User is not registered' }];
		}

		if (space.members.includes(userId)) {
			return [{ field: 'userId', message: 'User is already a member' }];
		}

		if (space.members.length >= MAX_MEMBERS_PER_SPACE) {
			return [{ field: 'members', message: `Maximum ${MAX_MEMBERS_PER_SPACE} members allowed` }];
		}

		// R5: Reject cross-household members for household-kind spaces (post-migration only).
		if (space.kind === 'household' && space.householdId && this.householdService) {
			const memberHousehold = this.householdService.getHouseholdForUser(userId);
			if (memberHousehold !== null && memberHousehold !== space.householdId) {
				return [
					{
						field: 'members',
						message: `User ${userId} belongs to household "${memberHousehold}", not "${space.householdId}"`,
					},
				];
			}
		}

		return this.enqueue(async () => {
			space.members.push(userId);
			await this.persist();
			this.logger.info({ spaceId, userId }, 'Member added to space');

			// Add space symlinks to the new member's vault
			if (this.vaultService) {
				await this.vaultService
					.addSpaceLink(userId, spaceId)
					.catch((err) =>
						this.logger.warn({ err, userId, spaceId }, 'Failed to add space link to vault'),
					);
			}
		}).then(() => []);
	}

	/**
	 * Remove a member from a space.
	 * Also clears active space if the user was in this space.
	 */
	async removeMember(spaceId: string, userId: string): Promise<SpaceValidationError[]> {
		const space = this.spaces[spaceId];
		if (!space) return [{ field: 'spaceId', message: 'Space not found' }];

		if (space.createdBy === userId) {
			return [{ field: 'userId', message: 'Cannot remove the space creator' }];
		}

		const idx = space.members.indexOf(userId);
		if (idx === -1) {
			return [{ field: 'userId', message: 'User is not a member' }];
		}

		return this.enqueue(async () => {
			space.members.splice(idx, 1);
			await this.persist();

			// Clear active space if user was in this space
			if (this.activeSpaces[userId] === spaceId) {
				this.activeSpaces[userId] = null;
				await this.persistActiveSpaces();
			}

			this.logger.info({ spaceId, userId }, 'Member removed from space');

			// Remove space symlinks from the removed member's vault
			if (this.vaultService) {
				await this.vaultService
					.removeSpaceLink(userId, spaceId)
					.catch((err) =>
						this.logger.warn({ err, userId, spaceId }, 'Failed to remove space link from vault'),
					);
			}
		}).then(() => []);
	}

	/** Get the active space ID for a user, or null. */
	getActiveSpace(userId: string): string | null {
		const spaceId = this.activeSpaces[userId] ?? null;
		if (!spaceId) return null;

		// Validate the space still exists and user is still a member
		if (!this.isMember(spaceId, userId)) {
			// Stale active space — clear it
			this.activeSpaces[userId] = null;
			this.persistActiveSpaces().catch((err) =>
				this.logger.error({ err, userId, spaceId }, 'Failed to clear stale active space'),
			);
			return null;
		}

		return spaceId;
	}

	/**
	 * Set the active space for a user.
	 * Pass null to exit space mode.
	 */
	async setActiveSpace(userId: string, spaceId: string | null): Promise<SpaceValidationError[]> {
		if (spaceId !== null) {
			const space = this.spaces[spaceId];
			if (!space) return [{ field: 'spaceId', message: 'Space not found' }];
			if (!space.members.includes(userId)) {
				return [{ field: 'spaceId', message: 'You are not a member of this space' }];
			}
		}

		return this.enqueue(async () => {
			this.activeSpaces[userId] = spaceId;
			await this.persistActiveSpaces();
			this.logger.info({ userId, spaceId }, spaceId ? 'Entered space mode' : 'Exited space mode');
		}).then(() => []);
	}

	// --- Private helpers ---

	/** Enqueue a write operation to serialize concurrent access. */
	private enqueue(fn: () => Promise<void>): Promise<void> {
		const p = this.writeQueue.then(fn, fn);
		this.writeQueue = p.then(
			() => {},
			() => {},
		);
		return p;
	}

	private validateSpace(def: SpaceDefinition): SpaceValidationError[] {
		const errors: SpaceValidationError[] = [];

		// ID validation
		if (!def.id) {
			errors.push({ field: 'id', message: 'Space ID is required' });
		} else if (!SPACE_ID_PATTERN.test(def.id)) {
			errors.push({
				field: 'id',
				message:
					'Space ID must start with a letter and contain only lowercase letters, numbers, and hyphens',
			});
		} else if (def.id.length > MAX_SPACE_ID_LENGTH) {
			errors.push({
				field: 'id',
				message: `Space ID must be at most ${MAX_SPACE_ID_LENGTH} characters`,
			});
		}

		// Name validation
		if (!def.name?.trim()) {
			errors.push({ field: 'name', message: 'Space name is required' });
		} else if (def.name.length > MAX_SPACE_NAME_LENGTH) {
			errors.push({
				field: 'name',
				message: `Space name must be at most ${MAX_SPACE_NAME_LENGTH} characters`,
			});
		}

		// Members validation
		if (!Array.isArray(def.members)) {
			errors.push({ field: 'members', message: 'Members must be an array' });
		} else {
			if (def.members.length > MAX_MEMBERS_PER_SPACE) {
				errors.push({
					field: 'members',
					message: `Maximum ${MAX_MEMBERS_PER_SPACE} members allowed`,
				});
			}
			for (const memberId of def.members) {
				if (!this.userManager.isRegistered(memberId)) {
					errors.push({ field: 'members', message: `User ${memberId} is not registered` });
				}
			}
		}

		// Duplicate member check
		if (Array.isArray(def.members)) {
			const uniqueMembers = new Set(def.members);
			if (uniqueMembers.size !== def.members.length) {
				errors.push({ field: 'members', message: 'Duplicate members are not allowed' });
			}
		}

		// Creator validation
		if (!def.createdBy) {
			errors.push({ field: 'createdBy', message: 'Creator is required' });
		} else {
			if (!this.userManager.isRegistered(def.createdBy)) {
				errors.push({ field: 'createdBy', message: 'Creator is not a registered user' });
			}
			if (Array.isArray(def.members) && !def.members.includes(def.createdBy)) {
				errors.push({ field: 'createdBy', message: 'Creator must be a member of the space' });
			}
		}

		// kind + householdId invariant
		if (def.kind === 'household') {
			if (!def.householdId) {
				errors.push({
					field: 'householdId',
					message: "householdId is required for spaces of kind 'household'",
				});
			} else if (!SAFE_SEGMENT.test(def.householdId)) {
				errors.push({
					field: 'householdId',
					message: 'householdId must be a valid SAFE_SEGMENT string (letters, digits, hyphens, underscores)',
				});
			}
		} else if (def.kind === 'collaboration') {
			if (def.householdId) {
				errors.push({
					field: 'householdId',
					message: "householdId must not be set for spaces of kind 'collaboration'",
				});
			}
		}

		// R5: When HouseholdService is wired (post-migration), validate that all members
		// belong to the same household as the space itself (for kind='household' spaces).
		// Absent → transitional mode, cross-household check skipped.
		if (def.kind === 'household' && def.householdId && this.householdService) {
			for (const memberId of def.members ?? []) {
				const memberHousehold = this.householdService.getHouseholdForUser(memberId);
				if (memberHousehold !== null && memberHousehold !== def.householdId) {
					errors.push({
						field: 'members',
						message: `User ${memberId} belongs to household "${memberHousehold}", not "${def.householdId}"`,
					});
				}
			}
		}

		return errors;
	}

	private async persist(): Promise<void> {
		await ensureDir(join(this.dataDir, 'system'));
		await writeYamlFile(this.spacesPath, this.spaces);
	}

	private async persistActiveSpaces(): Promise<void> {
		await ensureDir(join(this.dataDir, 'system'));
		await writeYamlFile(this.activeSpacesPath, this.activeSpaces);
	}
}

/** Internal error for space limit exceeded (used to propagate from enqueue). */
class SpaceLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SpaceLimitError';
	}
}

/**
 * Validate a raw space entry from YAML: must be an object with required string fields.
 * Excludes malformed entries from the operational space map.
 *
 * Accepts entries where `kind` is missing (legacy) — these are allowed through so that
 * the migration runner can backfill the kind field. A missing kind is treated as valid
 * at load time; the migration runner will set kind='household' on all legacy entries.
 *
 * Entries that have `kind` set must use a recognised value ('household' or 'collaboration').
 */
function isValidSpaceEntry(key: string, value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;

	if (
		typeof v['id'] !== 'string' ||
		v['id'] !== key ||
		typeof v['name'] !== 'string' ||
		v['name'].length === 0 ||
		!Array.isArray(v['members']) ||
		typeof v['createdBy'] !== 'string'
	) {
		return false;
	}

	// If kind is present, it must be a known value
	if (v['kind'] !== undefined && v['kind'] !== 'household' && v['kind'] !== 'collaboration') {
		return false;
	}

	return true;
}
