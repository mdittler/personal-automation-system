/**
 * Integration test: food app per-user macro targets end-to-end.
 *
 * This is the food-app-level counterpart to
 * `core/src/services/config/__tests__/per-user-runtime.integration.test.ts`.
 * The core test pins the infrastructure contract (setAll → requestContext.run
 * → service.get returns the override). This test pins the app-level contract:
 * a user's GUI-saved `macro_target_*` values must actually reach
 * `handleNutritionCommand` through the real `AppConfigServiceImpl` + the real
 * `requestContext`, so a future regression to the Phase 30 "setUserId never
 * called" bug fails loudly here in addition to the core fence.
 *
 * Why this exists on top of the mock-based handler test:
 *   `nutrition-handler.test.ts` stubs `services.config.get` directly. That
 *   is useful for handler logic but blind to the bug that motivated this
 *   file — if `AppConfigServiceImpl.setUserId` were ever dropped again, the
 *   stubbed test would still pass because it never exercises the real class.
 *
 * Closeout for Phase H11.x (backlog items #1 / #22).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These are deep relative imports into core's source tree. Food tests
// normally consume core via the `@pas/core/...` subpath exports, but this
// test needs two internals (`AppConfigServiceImpl`, `requestContext`) that
// are not part of the public app-facing surface and should not become one
// just for a single test. Deep relative imports are safe here because
// vitest runs .ts files directly (no dist build required) and test files
// are already outside tsc's rootDir.
import { AppConfigServiceImpl } from '../../../../../core/src/services/config/app-config-service.js';
import { requestContext } from '../../../../../core/src/services/context/request-context.js';
import type { ManifestUserConfig } from '../../../../../core/src/types/manifest.js';

import { handleNutritionCommand } from '../../handlers/nutrition.js';

// Mirror of the macro_target_* entries in apps/food/manifest.yaml. Kept
// inline rather than parsed from the manifest at runtime so a drift in
// either direction (manifest change without test update, or vice versa)
// is obvious in review.
const macroDefaults: ManifestUserConfig[] = [
	{
		key: 'macro_target_calories',
		type: 'number',
		default: 0,
		description: 'Daily calorie target (0 = not set)',
	},
	{
		key: 'macro_target_protein',
		type: 'number',
		default: 0,
		description: 'Daily protein target in grams (0 = not set)',
	},
	{
		key: 'macro_target_carbs',
		type: 'number',
		default: 0,
		description: 'Daily carbs target in grams (0 = not set)',
	},
	{
		key: 'macro_target_fat',
		type: 'number',
		default: 0,
		description: 'Daily fat target in grams (0 = not set)',
	},
	{
		key: 'macro_target_fiber',
		type: 'number',
		default: 0,
		description: 'Daily fiber target in grams (0 = not set)',
	},
];

/** Dispatches a handler the same way the router does: inside requestContext.run. */
async function dispatchAs<T>(userId: string, handler: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, handler);
}

/**
 * Build a per-user scoped-store factory. Each userId gets its own mock
 * store; the optional `targetsYaml` seeds the `nutrition/targets.yaml`
 * read so the YAML-base overlay path is exercised.
 */
function buildUserStoreRegistry(seeds: Record<string, string | null> = {}) {
	const stores = new Map<string, ReturnType<typeof createStore>>();
	function createStore(seed: string | null) {
		return {
			read: vi.fn(async (path: string) => {
				if (path === 'nutrition/targets.yaml') return seed;
				return null;
			}),
			write: vi.fn().mockResolvedValue(undefined),
			append: vi.fn().mockResolvedValue(undefined),
			exists: vi.fn().mockResolvedValue(false),
			list: vi.fn().mockResolvedValue([]),
			archive: vi.fn().mockResolvedValue(undefined),
		};
	}
	return {
		forUser: (userId: string) => {
			let store = stores.get(userId);
			if (!store) {
				store = createStore(seeds[userId] ?? null);
				stores.set(userId, store);
			}
			return store;
		},
	};
}

/**
 * Build a minimal CoreServices-shaped object where `config` is the REAL
 * `AppConfigServiceImpl`, and everything else is a vi.fn stub. This is
 * the key difference from `nutrition-handler.test.ts`, which mocks
 * `services.config.get` directly.
 */
function buildServices(dataDir: string, userStores: ReturnType<typeof buildUserStoreRegistry>) {
	const config = new AppConfigServiceImpl({
		dataDir,
		appId: 'food',
		defaults: macroDefaults,
	});
	const sends: Array<{ userId: string; text: string }> = [];
	return {
		telegram: {
			send: vi.fn(async (userId: string, text: string) => {
				sends.push({ userId, text });
			}),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
		},
		llm: {
			complete: vi.fn().mockResolvedValue('ok'),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		config,
		data: {
			forUser: vi.fn((userId: string) => userStores.forUser(userId)),
		},
		timezone: 'America/New_York',
		sends, // test-only handle for assertions
	};
}

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-food-per-user-config-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('food per-user macro targets — end-to-end', () => {
	it('GUI-saved override reaches handleNutritionCommand via requestContext', async () => {
		const userStores = buildUserStoreRegistry(); // no YAML seed
		const services = buildServices(tempDir, userStores);

		// Simulate the GUI config editor saving alice's targets.
		await (services.config as AppConfigServiceImpl).setAll('alice', {
			macro_target_calories: 2400,
			macro_target_protein: 160,
		});

		// Dispatch the same way the router does.
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		expect(services.sends).toHaveLength(1);
		const msg = services.sends[0]!.text;
		// Full-line assertions — a bare `.toContain('2400')` would match
		// coincidental substrings (e.g. a future "2400 cal/day average"
		// line), which is too weak for a regression fence.
		expect(msg).toContain('Calories: 2400');
		expect(msg).toContain('Protein: 160g');
	});

	it('partial override layers over YAML base through the real config path', async () => {
		// alice has a historical CLI-saved targets.yaml with all 5 fields,
		// then uses the GUI to override only calories. The handler must
		// render the overridden calories AND the YAML-base protein / carbs
		// / fat / fiber — the backlog item #2 "partial config is lossy"
		// invariant, pinned against the real config service.
		const seededYaml =
			'---\ntitle: Macro Targets\n---\ncalories: 2000\nprotein: 150\ncarbs: 220\nfat: 70\nfiber: 30\n';
		const userStores = buildUserStoreRegistry({ alice: seededYaml });
		const services = buildServices(tempDir, userStores);

		await (services.config as AppConfigServiceImpl).setAll('alice', {
			macro_target_calories: 2500,
		});

		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		expect(services.sends).toHaveLength(1);
		const msg = services.sends[0]!.text;
		// Config override for calories.
		expect(msg).toContain('Calories: 2500');
		// YAML base values for the keys alice did NOT override — if these
		// show as "not set" the overlay logic regressed.
		expect(msg).toContain('Protein: 150g');
		expect(msg).toContain('Carbs: 220g');
		expect(msg).toContain('Fat: 70g');
		expect(msg).toContain('Fiber: 30g');
	});

	it('cross-user isolation: alice and bob see their own overrides', async () => {
		const userStores = buildUserStoreRegistry();
		const services = buildServices(tempDir, userStores);

		await (services.config as AppConfigServiceImpl).setAll('alice', {
			macro_target_calories: 2400,
		});
		await (services.config as AppConfigServiceImpl).setAll('bob', {
			macro_target_calories: 1800,
		});

		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);
		await dispatchAs('bob', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'bob',
				userStores.forUser('bob') as never,
			),
		);

		expect(services.sends).toHaveLength(2);
		const aliceMsg = services.sends[0]!.text;
		const bobMsg = services.sends[1]!.text;
		expect(aliceMsg).toContain('Calories: 2400');
		expect(aliceMsg).not.toContain('1800');
		expect(bobMsg).toContain('Calories: 1800');
		expect(bobMsg).not.toContain('2400');
	});

	it('write path: /nutrition targets set round-trips through the real config service', async () => {
		// This is the write half of the propagation contract. The
		// read-only tests above pass even if `saveTargets` silently fails
		// to persist to the real config service (only the `setAll` mock
		// test in nutrition-handler.test.ts exercises the call shape). To
		// catch a regression where saveTargets calls setAll with the
		// wrong shape or swallows an error, do a real write followed by
		// a real read and assert round-trip equality.
		const userStores = buildUserStoreRegistry();
		const services = buildServices(tempDir, userStores);

		// Step 1: alice sets targets via the CLI dispatch.
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets', 'set', '2500', '180', '250', '80', '35'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		// saveTargets writes to the scoped store AND mirrors to the real
		// AppConfigServiceImpl. Verify the config file actually exists.
		const writtenOverrides = await (services.config as AppConfigServiceImpl).getAll('alice');
		expect(writtenOverrides.macro_target_calories).toBe(2500);
		expect(writtenOverrides.macro_target_fiber).toBe(35);

		// Step 2: a *separate* dispatch reads targets back. At this point
		// the scoped store's `read` mock still returns null for
		// nutrition/targets.yaml (we never wired write→read on the mock),
		// so if the config propagation regressed, the readback would
		// show "not set" for everything.
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		// The last telegram.send call is the one from the read. Pick it
		// deliberately rather than indexing position 1, since saveTargets
		// also sends a confirmation message.
		expect(services.sends.length).toBeGreaterThanOrEqual(2);
		const readMsg = services.sends.at(-1)!.text;
		expect(readMsg).toContain('Calories: 2500');
		expect(readMsg).toContain('Protein: 180g');
		expect(readMsg).toContain('Carbs: 250g');
		expect(readMsg).toContain('Fat: 80g');
		expect(readMsg).toContain('Fiber: 35g');
	});

	it('user persona: updates targets later, new values win over earlier ones', async () => {
		// Realistic multi-step user flow (the "persona" part of this file):
		// Alice sets her targets once, views them, then updates one
		// number and views them again. Each step is dispatched through
		// requestContext exactly the way the router would. The assertion
		// is that the later value wins — catches regressions where a
		// stale cache or immutable first-write would leave old values.
		const userStores = buildUserStoreRegistry();
		const services = buildServices(tempDir, userStores);

		// First save — "I think 2200 calories is right for me"
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets', 'set', '2200', '160', '220', '70', '30'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		// First review — "let me see what's set"
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);
		expect(services.sends.at(-1)!.text).toContain('Calories: 2200');

		// Second save — "actually, I'm bulking, push calories up"
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets', 'set', '2800', '200', '300', '90', '35'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);

		// Second review — new values must win
		await dispatchAs('alice', () =>
			handleNutritionCommand(
				services as never,
				['targets'],
				'alice',
				userStores.forUser('alice') as never,
			),
		);
		const finalMsg = services.sends.at(-1)!.text;
		expect(finalMsg).toContain('Calories: 2800');
		expect(finalMsg).toContain('Protein: 200g');
		expect(finalMsg).not.toContain('Calories: 2200');
		expect(finalMsg).not.toContain('Protein: 160g');
	});
});
