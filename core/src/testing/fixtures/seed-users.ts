/**
 * seedUsers() helper for integration and load tests.
 *
 * Seeds a minimal but fully wired SystemConfig with N users distributed
 * across H households. Writes the config to a temp pas.yaml, initialises
 * HouseholdService, and creates each household so households.yaml exists.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import type { SystemConfig } from '../../types/config.js';
import type { RegisteredUser } from '../../types/users.js';
import { HouseholdService } from '../../services/household/index.js';
import { writeYamlFile } from '../../utils/yaml.js';

export interface SeedOptions {
	dataDir: string;
	users: number;
	households: number;
}

export interface SeededUser {
	id: string;
	name: string;
	householdId: string;
}

export interface SeedResult {
	config: SystemConfig;
	configPath: string;
	households: string[];
	users: SeededUser[];
}

export async function seedUsers(opts: SeedOptions): Promise<SeedResult> {
	const { dataDir, users: userCount, households: householdCount } = opts;

	if (!Number.isInteger(householdCount) || householdCount <= 0) {
		throw new Error('seedUsers: households must be a positive integer');
	}
	if (!Number.isInteger(userCount) || userCount <= 0) {
		throw new Error('seedUsers: users must be a positive integer');
	}

	await mkdir(join(dataDir, 'data', 'system'), { recursive: true });

	// Pre-compute placeholder household names (hh-0, hh-1, …). The actual
	// stored IDs are derived from the return value of createHousehold() so
	// that slugification is always the source of truth.
	const householdNames: string[] = [];
	for (let h = 0; h < householdCount; h++) {
		householdNames.push(`hh-${h}`);
	}

	const seededUsers: SeededUser[] = [];
	const registeredUsers: RegisteredUser[] = [];

	// We don't know final IDs until after createHousehold() resolves, so
	// temporarily assign names as placeholders; we'll patch with real IDs below.
	for (let i = 0; i < userCount; i++) {
		const id = `user-${i}`;
		// householdNames is guaranteed non-empty (householdCount > 0 check above)
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by householdCount > 0 guard
		const householdId = householdNames[i % householdCount]!;
		seededUsers.push({ id, name: `User ${i}`, householdId });
		registeredUsers.push({
			id,
			name: `User ${i}`,
			isAdmin: i === 0,
			enabledApps: ['*'],
			sharedScopes: [],
			householdId,
		});
	}

	const stubRef = { provider: 'stub', model: 'stub-model' };

	const config: SystemConfig = {
		port: 3000,
		dataDir: join(dataDir, 'data'),
		logLevel: 'silent',
		timezone: 'UTC',
		telegram: { botToken: 'stub-token' },
		claude: { apiKey: '', model: 'stub-model' },
		llm: {
			providers: {
				stub: {
					type: 'openai-compatible',
					name: 'Stub',
					apiKeyEnvVar: '',
					defaultModel: 'stub-model',
				},
			},
			tiers: {
				fast: stubRef,
				standard: stubRef,
				reasoning: stubRef,
			},
		},
		gui: { authToken: 'stub-gui-token' },
		api: { token: 'stub-api-token' },
		cloudflare: {},
		webhooks: [],
		n8n: { dispatchUrl: '' },
		users: registeredUsers,
		backup: {
			enabled: false,
			path: join(dataDir, 'backups'),
			schedule: '0 3 * * *',
			retentionCount: 7,
		},
	};

	const configPath = join(dataDir, 'pas.yaml');
	await writeYamlFile(configPath, config);

	const logger = pino({ level: 'silent' });
	const householdService = new HouseholdService({
		dataDir: join(dataDir, 'data'),
		users: registeredUsers,
		logger,
	});
	await householdService.init();

	// Group users by placeholder household name to find the first user per household
	const firstUserByName = new Map<string, string>();
	for (const u of seededUsers) {
		if (!firstUserByName.has(u.householdId)) {
			firstUserByName.set(u.householdId, u.id);
		}
	}

	// Create households and capture actual IDs from return values so that
	// slugification is always the source of truth (not the pre-declared names).
	const nameToActualId = new Map<string, string>();
	const householdIds: string[] = [];
	for (const hhName of householdNames) {
		// biome-ignore lint/style/noNonNullAssertion: seededUsers is non-empty (users > 0 implied by householdCount > 0)
		const firstUserId = firstUserByName.get(hhName) ?? seededUsers[0]!.id;
		const household = await householdService.createHousehold(hhName, firstUserId, [firstUserId]);
		nameToActualId.set(hhName, household.id);
		householdIds.push(household.id);
	}

	// Patch seededUsers and registeredUsers with the real household IDs.
	for (const u of seededUsers) {
		u.householdId = nameToActualId.get(u.householdId) ?? u.householdId;
	}
	for (const u of registeredUsers) {
		u.householdId = nameToActualId.get(u.householdId as string) ?? u.householdId;
	}

	return {
		config,
		configPath,
		households: householdIds,
		users: seededUsers,
	};
}
