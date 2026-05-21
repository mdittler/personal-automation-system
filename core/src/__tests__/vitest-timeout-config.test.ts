/**
 * Regression guard for the `composeRuntime` integration-test timeout flake.
 *
 * Root cause (confirmed 2026-05-21): integration tests that build a full
 * runtime via `composeRuntime()` rely on Vitest's *default* 5000ms test
 * timeout. `composeRuntime()` alone takes ~250ms–1.6s, and under full-suite
 * CPU contention (534 test files in parallel) a `composeRuntime`-backed test
 * — e.g. `message-rate-tracker-wiring.integration.test.ts` — intermittently
 * exceeds 5000ms and fails with `Test timed out in 5000ms`. It passes in
 * isolation and on rerun because the contention is gone. This is the
 * "rare intermittent full-suite flake" the open-items entry tracks.
 *
 * The fix raises the global `testTimeout`/`hookTimeout` in
 * `core/vitest.config.ts` so the default 5000ms can never silently apply.
 * A generous timeout does not slow passing tests down — it only changes when
 * a genuinely hung test is killed — so this is safe for the fast unit tests
 * too.
 *
 * This guard fails deterministically if either knob is missing or set below
 * the safe threshold, so the flake's root cause cannot silently regress.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Minimum safe timeout. `composeRuntime` integration tests observed up to
 * ~1.6s for the build alone in stress runs; the 5000ms default leaves no
 * headroom under contention. 15000ms gives a comfortable margin while still
 * catching a genuinely hung test.
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

	it('declares a hookTimeout at or above the safe threshold so composeRuntime in beforeAll/beforeEach cannot time out', async () => {
		const source = await readFile(CONFIG_PATH, 'utf-8');
		const hookTimeout = extractNumericOption(source, 'hookTimeout');

		expect(
			hookTimeout,
			'core/vitest.config.ts must set an explicit `test.hookTimeout` — composeRuntime() runs inside beforeAll/beforeEach hooks and the default 5000ms is too tight under full-suite load',
		).toBeDefined();
		expect(hookTimeout as number).toBeGreaterThanOrEqual(MIN_SAFE_TIMEOUT_MS);
	});
});
