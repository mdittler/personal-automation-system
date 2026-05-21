/**
 * Regression guard for the `composeRuntime` integration-test timeout flake.
 *
 * `composeRuntime()` takes ~250ms–1.6s; under full-suite CPU contention a
 * `composeRuntime`-backed test can exceed Vitest's default 5000ms timeout and
 * fail intermittently. `core/vitest.config.ts` raises `testTimeout`/
 * `hookTimeout` to prevent that; this guard fails if either knob is missing or
 * below the safe threshold, so that root cause cannot silently regress.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Timeout floor: comfortably above the observed ~1.6s `composeRuntime` build
 * cost under contention, while still low enough to catch a genuine hang.
 */
const MIN_SAFE_TIMEOUT_MS = 15_000;

const CONFIG_PATH = fileURLToPath(new URL('../../vitest.config.ts', import.meta.url));

function extractNumericOption(source: string, key: string): number | undefined {
	// Matches e.g. `testTimeout: 30_000` or `testTimeout: 30000` (underscores allowed).
	const match = source.match(new RegExp(`${key}\\s*:\\s*([0-9_]+)`));
	if (!match?.[1]) return undefined;
	const value = Number(match[1].replace(/_/g, ''));
	return Number.isFinite(value) ? value : undefined;
}

describe('core/vitest.config.ts timeout configuration', () => {
	it('declares a testTimeout at or above the safe threshold for composeRuntime integration tests', async () => {
		const source = await readFile(CONFIG_PATH, 'utf-8');
		const testTimeout = extractNumericOption(source, 'testTimeout');

		expect(
			testTimeout,
			'core/vitest.config.ts must set an explicit `test.testTimeout` — the default 5000ms is too tight for composeRuntime integration tests under full-suite load',
		).toBeDefined();
		expect(testTimeout as number).toBeGreaterThanOrEqual(MIN_SAFE_TIMEOUT_MS);
	});

	it('declares a hookTimeout at or above the safe threshold for composeRuntime in beforeAll/beforeEach', async () => {
		const source = await readFile(CONFIG_PATH, 'utf-8');
		const hookTimeout = extractNumericOption(source, 'hookTimeout');

		expect(
			hookTimeout,
			'core/vitest.config.ts must set an explicit `test.hookTimeout` — composeRuntime() runs inside beforeAll/beforeEach hooks and the default 5000ms is too tight under full-suite load',
		).toBeDefined();
		expect(hookTimeout as number).toBeGreaterThanOrEqual(MIN_SAFE_TIMEOUT_MS);
	});
});
