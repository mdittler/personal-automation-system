/**
 * Agent bucket environment (REQ-REG-AGENT-002). One fresh seeded runtime per
 * TRIAL: base household seed + optional overlay, `{date:±N}` placeholders
 * expanded to the runtime's "today" in its configured timezone. Integrity is
 * verified before every build so a tampered fixture never runs.
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestContext } from '@core/services/context/request-context.js';
import type { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import type { MessageContext, PhotoContext } from '@core/types/telegram.js';
import type { Logger } from 'pino';
import { expandDatePlaceholders } from '../oracles/outcome.js';
import { todayInTimezone } from '../shared/cache-key.js';
import { verifyFixtureIntegrity } from './seed.js';
import { type TierOverride, createSeededRuntime } from './seeded-runtime.js';

export interface AgentEnvironmentOptions {
	/** `regression/fixtures/agent` */
	fixturesDir: string;
	productionConfigPath: string;
	envPath?: string;
	providerRegistry?: ProviderRegistry;
	tierOverride?: TierOverride;
	logger?: Logger;
}

export interface AgentEnvironment {
	userId: string;
	householdId: string;
	dataDir: string;
	telegram: { sent: ReadonlyArray<{ userId: string; text: string }> };
	routeMessage: (ctx: MessageContext) => Promise<void>;
	routePhoto: (ctx: PhotoContext) => Promise<void>;
	dispose: () => Promise<void>;
}

const OVERLAY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EXPANDABLE = /\.(ya?ml|md)$/;

export function validateOverlayName(name: string): void {
	if (!OVERLAY_RE.test(name))
		throw new Error(`agent environment: invalid overlay name: ${JSON.stringify(name)}`);
}

/** Recursively copy `src` into `dest`, expanding date placeholders in .yaml/.md files. */
export async function copySeedTree(src: string, dest: string, today: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	for (const name of await readdir(src)) {
		const from = join(src, name);
		const to = join(dest, name);
		if ((await stat(from)).isDirectory()) {
			await copySeedTree(from, to, today);
		} else if (EXPANDABLE.test(name)) {
			await writeFile(to, expandDatePlaceholders(await readFile(from, 'utf8'), today), 'utf8');
		} else {
			await copyFile(from, to);
		}
	}
}

export async function createAgentEnvironment(
	opts: AgentEnvironmentOptions,
	overlay?: string,
): Promise<AgentEnvironment> {
	const integrity = await verifyFixtureIntegrity(join(opts.fixturesDir, 'seed.sha256'));
	if (!integrity.ok) {
		throw new Error(
			`agent environment: fixture integrity check failed: ${integrity.failures.map((f) => `${f.path}=${f.reason}`).join(', ')}`,
		);
	}
	if (overlay !== undefined) validateOverlayName(overlay);
	const env = await createSeededRuntime({
		tmpPrefix: 'regression-agent-',
		productionConfigPath: opts.productionConfigPath,
		...(opts.envPath ? { envPath: opts.envPath } : {}),
		...(opts.providerRegistry ? { providerRegistry: opts.providerRegistry } : {}),
		...(opts.tierOverride ? { tierOverride: opts.tierOverride } : {}),
		...(opts.logger ? { logger: opts.logger } : {}),
		user: { id: 'agent-user-0', name: 'Agent User 0' },
		householdSeedId: 'agent-hh-0',
		writeSeed: async ({ dataDir, householdId, timezone }) => {
			const today = todayInTimezone(timezone);
			const foodDest = join(dataDir, 'households', householdId, 'shared', 'food');
			await copySeedTree(join(opts.fixturesDir, 'household', 'food'), foodDest, today);
			if (overlay !== undefined) {
				await copySeedTree(join(opts.fixturesDir, 'overlays', overlay, 'food'), foodDest, today);
			}
		},
	});
	const scope = { userId: env.userId, householdId: env.householdId };
	return {
		userId: env.userId,
		householdId: env.householdId,
		dataDir: env.dataDir,
		telegram: env.telegram,
		routeMessage: (ctx) =>
			requestContext.run(scope, () => env.runtime.services.router.routeMessage(ctx)),
		routePhoto: (ctx) =>
			requestContext.run(scope, () => env.runtime.services.router.routePhoto(ctx)),
		dispose: env.dispose,
	};
}
