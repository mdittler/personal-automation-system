/**
 * Seeded runtime builder shared by the chatbot and agent buckets
 * (REQ-REG-006, REQ-REG-025, REQ-REG-AGENT-002).
 *
 * Creates a temp data dir, loads the REAL pas.yaml (Codex C2) overriding only
 * dataDir/users/telegram/gui/api tokens, applies an optional tier override,
 * creates one household with one admin user, writes the Food app's own
 * household.yaml, lets the caller write seed files, and composes the runtime
 * with a fake Telegram. Any failure after mkdtemp removes the temp dir (Codex I4).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type RuntimeHandle, composeRuntime } from '@core/compose-runtime.js';
import { loadSystemConfig } from '@core/services/config/index.js';
import { HouseholdService } from '@core/services/household/index.js';
import type { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import {
	type FakeTelegramService,
	fakeTelegramService,
} from '@core/testing/fixtures/fake-telegram.js';
import type { SystemConfig } from '@core/types/config.js';
import type { ModelRef } from '@core/types/llm.js';
import type { RegisteredUser } from '@core/types/users.js';
import { writeYamlFile } from '@core/utils/yaml.js';
import pino, { type Logger } from 'pino';

export interface TierOverride {
	fast?: ModelRef;
	standard?: ModelRef;
	reasoning?: ModelRef;
}

export interface SeededRuntimeOptions {
	tmpPrefix: string;
	productionConfigPath: string;
	envPath?: string;
	providerRegistry?: ProviderRegistry;
	tierOverride?: TierOverride;
	logger?: Logger;
	user: { id: string; name: string };
	householdSeedId: string;
	/** Write seed files. Called after the household exists, before composeRuntime. */
	writeSeed: (ctx: {
		dataDir: string;
		householdId: string;
		userId: string;
		timezone: string;
	}) => Promise<void>;
}

export interface SeededRuntime {
	tmpRoot: string;
	dataDir: string;
	userId: string;
	householdId: string;
	timezone: string;
	telegram: FakeTelegramService;
	runtime: RuntimeHandle;
	dispose: () => Promise<void>;
}

/**
 * Pure config transform: the production config with every benchmark-specific
 * override applied. Exported so the guarantees (no real integrations, no guard
 * rejections graded as model failures, tier overrides incl. reasoning
 * fallthrough) are unit-tested rather than living only on the integration path.
 */
export function buildSeededConfig(
	realConfig: SystemConfig,
	opts: { dataDir: string; users: RegisteredUser[]; tierOverride?: TierOverride },
): SystemConfig {
	const config: SystemConfig = {
		...realConfig,
		dataDir: opts.dataDir,
		users: opts.users,
		telegram: { botToken: 'regression-stub' },
		gui: { authToken: 'regression-stub' },
		api: { token: 'regression-stub' },
		// Never let a benchmark runtime reach the operator's real integrations:
		// data writes in a trial must not fire real outbound webhooks or n8n.
		webhooks: [],
		n8n: { ...realConfig.n8n, dispatchUrl: '' },
	};
	if (opts.tierOverride) {
		if (!config.llm) {
			throw new Error('seeded runtime: --model-matrix override requires llm config in pas.yaml');
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
	// The run budget governs benchmark spend. Production safeguard caps would
	// otherwise reject calls *inside* the app, which catches the error and
	// sends a polite reply — grading a guard rejection as a model failure.
	if (config.llm) {
		config.llm = {
			...config.llm,
			safeguards: {
				defaultRateLimit: { maxRequests: 100_000, windowSeconds: 3600 },
				defaultMonthlyCostCap: 1_000,
				globalMonthlyCostCap: 1_000,
				defaultHouseholdRateLimit: { maxRequests: 100_000, windowSeconds: 3600 },
				defaultHouseholdMonthlyCostCap: 1_000,
			},
		};
	}
	return config;
}

export async function createSeededRuntime(opts: SeededRuntimeOptions): Promise<SeededRuntime> {
	const productionConfigPath = resolve(opts.productionConfigPath);
	const envPath = opts.envPath ?? join(dirname(dirname(productionConfigPath)), '.env');
	const tmpRoot = await mkdtemp(join(tmpdir(), opts.tmpPrefix));
	try {
		const dataDir = join(tmpRoot, 'data');
		await mkdir(join(dataDir, 'system'), { recursive: true });
		const realConfig = await loadSystemConfig({
			configPath: productionConfigPath,
			envPath,
			mode: 'strict',
		});
		const users: RegisteredUser[] = [
			{
				id: opts.user.id,
				name: opts.user.name,
				isAdmin: true,
				enabledApps: ['*'],
				sharedScopes: [],
				householdId: 'placeholder',
			},
		];
		const config = buildSeededConfig(realConfig, {
			dataDir,
			users,
			...(opts.tierOverride ? { tierOverride: opts.tierOverride } : {}),
		});
		const configPath = join(tmpRoot, 'pas.yaml');
		await writeYamlFile(configPath, config);

		const logger = opts.logger ?? pino({ level: 'warn' });
		const householdService = new HouseholdService({
			dataDir,
			users,
			logger: logger.child({ service: 'household' }),
		});
		await householdService.init();
		const created = await householdService.createHousehold(opts.householdSeedId, opts.user.id, [
			opts.user.id,
		]);
		for (const u of users) u.householdId = created.id;

		// The Food app's requireHousehold reads its OWN household.yaml from the
		// shared food path (apps/food/src/utils/household-guard.ts).
		const foodHouseholdPath = join(
			dataDir,
			'households',
			created.id,
			'shared',
			'food',
			'household.yaml',
		);
		await mkdir(dirname(foodHouseholdPath), { recursive: true });
		await writeFile(
			foodHouseholdPath,
			[
				'---',
				`title: ${opts.householdSeedId}`,
				'app: food',
				'tags:',
				'  - food/household',
				'---',
				`id: ${created.id}`,
				`name: ${opts.householdSeedId}`,
				`createdBy: ${opts.user.id}`,
				'members:',
				`  - ${opts.user.id}`,
				'joinCode: REG001',
				'createdAt: 2026-05-12T00:00:00.000Z',
				'',
			].join('\n'),
			'utf8',
		);

		const timezone = config.timezone || 'UTC';
		await opts.writeSeed({ dataDir, householdId: created.id, userId: opts.user.id, timezone });

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
			userId: opts.user.id,
			householdId: created.id,
			timezone,
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
