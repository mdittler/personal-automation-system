/**
 * Integration test: end-to-end per-user config propagation.
 *
 * This is the canonical regression test for the per-user config runtime
 * propagation bug (fixed 2026-04-09). It exercises the full path that
 * previously failed silently:
 *
 *   1. A user edits config in the GUI, which calls `setAll(userId, values)`
 *      — a write to `data/system/app-config/<appId>/<userId>.yaml`.
 *   2. The infrastructure dispatches an incoming message inside
 *      `requestContext.run({ userId }, handler)`.
 *   3. The handler calls `services.config.get(key)`.
 *   4. The value returned MUST be the user's override, not the manifest
 *      default.
 *
 * Before the fix, step 4 silently returned the manifest default because
 * `AppConfigServiceImpl.setUserId` was never called in production and
 * the service had no other way to learn whose request it was serving.
 *
 * This test lives separately from the unit tests so that a grep for
 * "per-user-runtime" lands readers on the scenario that motivated the
 * fix, not just the unit-level assertions.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { requestContext } from '../../context/request-context.js';
import { AppConfigServiceImpl } from '../app-config-service.js';

let tempDir: string;

const nutritionDefaults: ManifestUserConfig[] = [
	{
		key: 'macro_target_calories',
		type: 'number',
		default: 2000,
		description: 'Daily calorie target',
	},
	{
		key: 'macro_target_protein',
		type: 'number',
		default: 100,
		description: 'Daily protein target (g)',
	},
	{
		key: 'dietary_preferences',
		type: 'multiselect',
		default: ['omnivore'],
		description: 'Dietary preferences',
		options: ['omnivore', 'vegetarian', 'vegan', 'pescatarian'],
	},
];

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-per-user-runtime-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/**
 * Simulates a dispatch entry point: the router wraps the handler in
 * `requestContext.run`, then calls the handler. The handler reads
 * `services.config.get` — the classic H11.x pattern.
 */
async function dispatchAs<T>(userId: string, handler: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, handler);
}

describe('per-user config runtime propagation', () => {
	it('GUI-saved overrides reach handlers via requestContext', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		// Step 1 — alice saves custom macro targets in the GUI
		await service.setAll('alice', {
			macro_target_calories: 2400,
			macro_target_protein: 160,
		});

		// Step 2+3+4 — alice sends a message; the router wraps dispatch in
		// requestContext.run; the handler reads the config
		const aliceCalories = await dispatchAs('alice', () =>
			service.get<number>('macro_target_calories'),
		);
		const aliceProtein = await dispatchAs('alice', () =>
			service.get<number>('macro_target_protein'),
		);

		expect(aliceCalories).toBe(2400);
		expect(aliceProtein).toBe(160);
	});

	it('users without overrides see manifest defaults', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		// alice has overrides
		await service.setAll('alice', { macro_target_calories: 2400 });
		// bob does not

		const bobCalories = await dispatchAs('bob', () =>
			service.get<number>('macro_target_calories'),
		);
		expect(bobCalories).toBe(2000);

		// alice's override must not leak to bob
		const bobPrefs = await dispatchAs('bob', () =>
			service.get<string[]>('dietary_preferences'),
		);
		expect(bobPrefs).toEqual(['omnivore']);
	});

	it('partial overrides merge cleanly — unset keys fall through to defaults', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		// alice only overrides one of three keys
		await service.setAll('alice', { macro_target_calories: 2400 });

		const calories = await dispatchAs('alice', () =>
			service.get<number>('macro_target_calories'),
		);
		const protein = await dispatchAs('alice', () =>
			service.get<number>('macro_target_protein'),
		);
		const prefs = await dispatchAs('alice', () =>
			service.get<string[]>('dietary_preferences'),
		);

		expect(calories).toBe(2400); // overridden
		expect(protein).toBe(100); // default
		expect(prefs).toEqual(['omnivore']); // default
	});

	it('get() outside a requestContext scope returns defaults (not user data)', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		await service.setAll('alice', { macro_target_calories: 2400 });

		// Calling get() without establishing a request context — e.g., a
		// one-off startup probe — must not accidentally return any user's
		// data. It falls through to the manifest default.
		const calories = await service.get<number>('macro_target_calories');
		expect(calories).toBe(2000);
	});

	it('concurrent dispatches for different users do not leak config', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		await service.setAll('alice', { macro_target_calories: 2400 });
		await service.setAll('bob', { macro_target_calories: 1800 });
		await service.setAll('carol', { macro_target_calories: 3000 });

		const results = await Promise.all([
			dispatchAs('alice', async () => {
				await new Promise((r) => setTimeout(r, 3));
				return service.get<number>('macro_target_calories');
			}),
			dispatchAs('bob', async () => {
				await new Promise((r) => setTimeout(r, 1));
				return service.get<number>('macro_target_calories');
			}),
			dispatchAs('carol', async () => {
				await new Promise((r) => setTimeout(r, 2));
				return service.get<number>('macro_target_calories');
			}),
		]);

		expect(results).toEqual([2400, 1800, 3000]);
	});

	it('GUI getAll(userId) cross-user read still works from outside any context', async () => {
		const service = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'food',
			defaults: nutritionDefaults,
		});

		await service.setAll('alice', { macro_target_calories: 2400 });

		// The GUI config editor calls getAll(userId) without being inside
		// alice's request context. This must still work — it's the
		// explicit override path.
		const all = await service.getAll('alice');
		expect(all.macro_target_calories).toBe(2400);
		expect(all.macro_target_protein).toBe(100); // default merged in
	});
});
