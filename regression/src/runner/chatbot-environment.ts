/**
 * Chatbot bucket environment (REQ-REG-006, REQ-REG-012).
 *
 * One environment per chatbot bucket run — all chatbot cases share the
 * same seeded household + composed runtime.
 *
 * Codex C2: builds composeRuntime using the REAL pas.yaml LLM config
 * (loaded via `loadSystemConfig`), then overrides ONLY `dataDir`, users,
 * and timezone. The runner-supplied `ProviderRegistry` is forwarded so
 * the chatbot runtime shares CostTracker scope with the rest of the
 * suite. A `--model-matrix` tier override (added in Task 12) flows in
 * via `tierOverride` so local Gemma runs work end-to-end.
 *
 * Codex I4: the entire post-mkdtemp path is wrapped in try/catch; on
 * any failure (config load, seedUsers, fixture write, composeRuntime),
 * the tmp root is rm'd before the error propagates.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { composeRuntime, type RuntimeHandle } from '@core/compose-runtime.js';
import { loadSystemConfig } from '@core/services/config/index.js';
import { HouseholdService } from '@core/services/household/index.js';
import type { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import {
	fakeTelegramService,
	type FakeTelegramService,
} from '@core/testing/fixtures/fake-telegram.js';
import type { SystemConfig } from '@core/types/config.js';
import type { ModelRef } from '@core/types/llm.js';
import type { RegisteredUser } from '@core/types/users.js';
import { writeYamlFile } from '@core/utils/yaml.js';
import pino, { type Logger } from 'pino';
import { verifyFixtureIntegrity } from './seed.js';

export interface TierOverride {
	fast?: ModelRef;
	standard?: ModelRef;
	reasoning?: ModelRef;
}

export interface ChatbotEnvironmentOptions {
	seedJsonPath: string;
	seedShaPath: string;
	/** Path to real config/pas.yaml. */
	productionConfigPath: string;
	/**
	 * Path to the `.env` file with provider/Telegram tokens. Defaults to a
	 * sibling `.env` of the production config's parent directory (i.e.
	 * `dirname(dirname(productionConfigPath))/.env`) so callers can pass
	 * just `productionConfigPath` and have things work regardless of cwd.
	 */
	envPath?: string;
	/** Optional shared ProviderRegistry — when present, composeRuntime reuses it (shared CostTracker scope). */
	providerRegistry?: ProviderRegistry;
	/** Optional tier override (used by --model-matrix). Each override merges into the loaded LLM config. */
	tierOverride?: TierOverride;
	logger?: Logger;
}

export interface ChatbotEnvironment {
	tmpRoot: string;
	dataDir: string;
	userId: string;
	householdId: string;
	telegram: FakeTelegramService;
	runtime: RuntimeHandle;
	dispose: () => Promise<void>;
}

interface SeedJson {
	version: number;
	users: Array<{ id: string; name: string; isAdmin: boolean }>;
	households: Array<{ id: string; members: string[] }>;
	foodSeed?: {
		receipts?: Array<{ path: string; contents: string }>;
		priceLists?: Array<{ path: string; contents: string }>;
	};
}

export async function createChatbotEnvironment(
	opts: ChatbotEnvironmentOptions,
): Promise<ChatbotEnvironment> {
	const seedJsonPath = resolve(opts.seedJsonPath);
	const seedShaPath = resolve(opts.seedShaPath);
	const productionConfigPath = resolve(opts.productionConfigPath);
	// Default .env location: sibling of the config dir's parent.
	// e.g. `/repo/config/pas.yaml` -> `/repo/.env`.
	const envPath = opts.envPath ?? join(dirname(dirname(productionConfigPath)), '.env');

	// REQ-REG-006: integrity check first — runs BEFORE mkdtemp so a tampered
	// seed never leaves any tmp directory on disk.
	const integrity = await verifyFixtureIntegrity(seedShaPath);
	if (!integrity.ok) {
		throw new Error(
			`chatbot environment: fixture integrity check failed: ${integrity.failures
				.map((f) => `${f.path}=${f.reason}`)
				.join(', ')}`,
		);
	}

	const seed = JSON.parse(await readFile(seedJsonPath, 'utf8')) as SeedJson;
	if (seed.version !== 1) {
		throw new Error(`chatbot environment: unsupported seed version ${seed.version}`);
	}

	const tmpRoot = await mkdtemp(join(tmpdir(), 'regression-chatbot-'));
	try {
		const dataDir = join(tmpRoot, 'data');
		await mkdir(join(dataDir, 'system'), { recursive: true });

		// Codex C2: load real pas.yaml so providers / CostTracker / safeguards
		// match production. Override only dataDir, users, households, telegram.
		const realConfig = await loadSystemConfig({
			configPath: productionConfigPath,
			envPath,
			mode: 'strict',
		});

		// Seeded users start with a placeholder householdId; patched below
		// after HouseholdService.createHousehold returns the canonical id.
		const users: RegisteredUser[] = seed.users.map((u) => ({
			id: u.id,
			name: u.name,
			isAdmin: u.isAdmin,
			enabledApps: ['*'],
			sharedScopes: [],
			householdId: 'placeholder',
		}));

		const config: SystemConfig = {
			...realConfig,
			dataDir,
			users,
			telegram: { botToken: 'regression-stub' },
			gui: { authToken: 'regression-stub' },
			api: { token: 'regression-stub' },
		};
		if (opts.tierOverride) {
			if (!config.llm) {
				throw new Error(
					'chatbot environment: --model-matrix override requires llm config in pas.yaml',
				);
			}
			config.llm = {
				...config.llm,
				tiers: {
					fast: opts.tierOverride.fast ?? config.llm.tiers.fast,
					standard: opts.tierOverride.standard ?? config.llm.tiers.standard,
					...(opts.tierOverride.reasoning !== undefined
						? { reasoning: opts.tierOverride.reasoning }
						: config.llm.tiers.reasoning !== undefined
							? { reasoning: config.llm.tiers.reasoning }
							: {}),
				},
			};
		}

		const configPath = join(tmpRoot, 'pas.yaml');
		await writeYamlFile(configPath, config);

		const logger = opts.logger ?? pino({ level: 'warn' });
		const householdService = new HouseholdService({
			dataDir,
			users,
			logger: logger.child({ service: 'household' }),
		});
		await householdService.init();
		const seededHousehold = seed.households[0];
		if (!seededHousehold) {
			throw new Error('chatbot environment: seed.json must declare at least one household');
		}
		const firstUserId = seededHousehold.members[0];
		if (!firstUserId) {
			throw new Error('chatbot environment: seeded household must declare at least one member');
		}
		const created = await householdService.createHousehold(
			seededHousehold.id,
			firstUserId,
			seededHousehold.members,
		);
		for (const u of users) u.householdId = created.id;

		// Write food seed files under the household-shared path.
		const expand = (p: string): string => p.replace('{householdId}', created.id);
		for (const fixture of [
			...(seed.foodSeed?.receipts ?? []),
			...(seed.foodSeed?.priceLists ?? []),
		]) {
			const fullPath = join(dataDir, expand(fixture.path));
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, fixture.contents, 'utf8');
		}

		const telegram = fakeTelegramService();
		const runtime = await composeRuntime({
			config,
			configPath,
			dataDir,
			telegramService: telegram,
			logger,
			...(opts.providerRegistry ? { providerRegistry: opts.providerRegistry } : {}),
		});

		const dispose = async (): Promise<void> => {
			try {
				await runtime.dispose();
			} finally {
				await rm(tmpRoot, { recursive: true, force: true });
			}
		};

		return {
			tmpRoot,
			dataDir,
			userId: firstUserId,
			householdId: created.id,
			telegram,
			runtime,
			dispose,
		};
	} catch (err) {
		// Codex I4: any failure between mkdtemp and the successful return must
		// clean up the temp dir before the caller sees the error.
		await rm(tmpRoot, { recursive: true, force: true });
		throw err;
	}
}
