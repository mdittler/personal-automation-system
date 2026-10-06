/**
 * Chatbot bucket environment (REQ-REG-006, REQ-REG-012, REQ-REG-025).
 *
 * One environment per chatbot CASE — built fresh and disposed by the
 * orchestrator so no transcript or session state bleeds between cases. The
 * shared runtime construction lives in `seeded-runtime.ts` (also used by the
 * agent bucket); this module adds the chatbot fixture integrity check and the
 * seed receipts / price lists.
 *
 * Codex C2: composeRuntime uses the REAL pas.yaml LLM config, overriding only
 * dataDir, users, and tokens. The runner-supplied `ProviderRegistry` is
 * forwarded so the runtime shares CostTracker scope with the rest of the suite.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import type { Logger } from 'pino';
import { verifyFixtureIntegrity } from './seed.js';
import { type SeededRuntime, type TierOverride, createSeededRuntime } from './seeded-runtime.js';

export type { TierOverride };

export interface ChatbotEnvironmentOptions {
	seedJsonPath: string;
	seedShaPath: string;
	/** Path to real config/pas.yaml. */
	productionConfigPath: string;
	/**
	 * Path to the `.env` file with provider/Telegram tokens. Defaults to a
	 * sibling `.env` of the production config's parent directory.
	 */
	envPath?: string;
	/** Optional shared ProviderRegistry — when present, composeRuntime reuses it (shared CostTracker scope). */
	providerRegistry?: ProviderRegistry;
	/** Optional tier override (used by --model-matrix). Each override merges into the loaded LLM config. */
	tierOverride?: TierOverride;
	logger?: Logger;
}

export type ChatbotEnvironment = SeededRuntime;

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
	// REQ-REG-006: integrity check before any temp dir exists.
	const integrity = await verifyFixtureIntegrity(resolve(opts.seedShaPath));
	if (!integrity.ok) {
		throw new Error(
			`chatbot environment: fixture integrity check failed: ${integrity.failures
				.map((f) => `${f.path}=${f.reason}`)
				.join(', ')}`,
		);
	}
	const seed = JSON.parse(await readFile(resolve(opts.seedJsonPath), 'utf8')) as SeedJson;
	if (seed.version !== 1) {
		throw new Error(`chatbot environment: unsupported seed version ${seed.version}`);
	}
	const household = seed.households[0];
	if (!household) {
		throw new Error('chatbot environment: seed.json must declare at least one household');
	}
	const user = seed.users[0];
	if (!user) {
		throw new Error('chatbot environment: seed.json must declare at least one user');
	}
	return createSeededRuntime({
		tmpPrefix: 'regression-chatbot-',
		productionConfigPath: opts.productionConfigPath,
		...(opts.envPath ? { envPath: opts.envPath } : {}),
		...(opts.providerRegistry ? { providerRegistry: opts.providerRegistry } : {}),
		...(opts.tierOverride ? { tierOverride: opts.tierOverride } : {}),
		...(opts.logger ? { logger: opts.logger } : {}),
		user: { id: user.id, name: user.name },
		householdSeedId: household.id,
		writeSeed: async ({ dataDir, householdId }) => {
			for (const fixture of [
				...(seed.foodSeed?.receipts ?? []),
				...(seed.foodSeed?.priceLists ?? []),
			]) {
				const fullPath = join(dataDir, fixture.path.replace('{householdId}', householdId));
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, fixture.contents, 'utf8');
			}
		},
	});
}
