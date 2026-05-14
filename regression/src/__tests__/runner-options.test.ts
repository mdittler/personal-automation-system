/**
 * `resolveManifestDefaults` tests (REQ-REG-CLI-MAN-001).
 *
 * Validates precedence between `--no-manifest`, `--run-id`, `--manifest-dir`,
 * and the `DATA_DIR` env var.
 */

import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliOptions } from '../runner/args.js';
import { resolveManifestDefaults } from '../runner/runner-options.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const REPO_ROOT = '/tmp/fake-repo-root';

function makeCli(over: Partial<CliOptions> = {}): CliOptions {
	return {
		dryRun: false,
		json: false,
		help: false,
		listOnly: false,
		noCache: false,
		noManifest: false,
		...over,
	};
}

describe('resolveManifestDefaults', () => {
	describe('defaults — manifest writing is on by default', () => {
		it('no --run-id, no DATA_DIR → manifestDir under <repoRoot>/data/system/regression-runs; runId is a UUID', () => {
			const out = resolveManifestDefaults(makeCli(), {}, REPO_ROOT);
			expect(out.manifestDir).toBe(resolvePath(REPO_ROOT, 'data', 'system', 'regression-runs'));
			expect(out.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});

		it('explicit --run-id → that id used; default manifestDir', () => {
			const out = resolveManifestDefaults(makeCli({ runId: VALID_UUID }), {}, REPO_ROOT);
			expect(out.runId).toBe(VALID_UUID);
			expect(out.manifestDir).toBe(resolvePath(REPO_ROOT, 'data', 'system', 'regression-runs'));
		});

		it('DATA_DIR=/tmp/data → manifestDir under /tmp/data/system/regression-runs', () => {
			const out = resolveManifestDefaults(makeCli(), { DATA_DIR: '/tmp/data' }, REPO_ROOT);
			expect(out.manifestDir).toBe(resolvePath('/tmp/data', 'system', 'regression-runs'));
		});

		it('DATA_DIR with relative path → resolved against cwd', () => {
			const out = resolveManifestDefaults(makeCli(), { DATA_DIR: './data' }, REPO_ROOT);
			expect(out.manifestDir).toMatch(/data\/system\/regression-runs$/);
		});
	});

	describe('--manifest-dir explicit override', () => {
		it('--manifest-dir=<path> → that path; DATA_DIR ignored', () => {
			const out = resolveManifestDefaults(
				makeCli({ manifestDir: '/custom/manifests' }),
				{ DATA_DIR: '/should-be-ignored' },
				REPO_ROOT,
			);
			expect(out.manifestDir).toBe('/custom/manifests');
		});

		it('--manifest-dir without --run-id → auto-generated UUID', () => {
			const out = resolveManifestDefaults(
				makeCli({ manifestDir: '/custom/manifests' }),
				{},
				REPO_ROOT,
			);
			expect(out.manifestDir).toBe('/custom/manifests');
			expect(out.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});
	});

	describe('--no-manifest precedence — wins over runId AND manifestDir', () => {
		it('--no-manifest alone → manifestDir null; runId null', () => {
			const out = resolveManifestDefaults(makeCli({ noManifest: true }), {}, REPO_ROOT);
			expect(out.manifestDir).toBeNull();
			expect(out.runId).toBeNull();
		});

		it('--no-manifest + --run-id → manifestDir null; runId preserved (for logging)', () => {
			const out = resolveManifestDefaults(
				makeCli({ noManifest: true, runId: VALID_UUID }),
				{},
				REPO_ROOT,
			);
			expect(out.manifestDir).toBeNull();
			expect(out.runId).toBe(VALID_UUID);
		});

		it('--no-manifest + --manifest-dir → manifestDir null (no-manifest wins)', () => {
			const out = resolveManifestDefaults(
				makeCli({ noManifest: true, manifestDir: '/custom/path' }),
				{},
				REPO_ROOT,
			);
			expect(out.manifestDir).toBeNull();
		});

		it('--no-manifest + --run-id + --manifest-dir → manifestDir null; runId preserved', () => {
			const out = resolveManifestDefaults(
				makeCli({ noManifest: true, runId: VALID_UUID, manifestDir: '/x' }),
				{ DATA_DIR: '/should-be-ignored' },
				REPO_ROOT,
			);
			expect(out.manifestDir).toBeNull();
			expect(out.runId).toBe(VALID_UUID);
		});

		it('--no-manifest + nothing else + DATA_DIR set → manifestDir null (env ignored)', () => {
			const out = resolveManifestDefaults(
				makeCli({ noManifest: true }),
				{ DATA_DIR: '/var/data' },
				REPO_ROOT,
			);
			expect(out.manifestDir).toBeNull();
		});
	});

	describe('runId is UUID-shaped when auto-generated', () => {
		it('produces a UUIDv4-shaped string', () => {
			// 10 calls — flake-proof randomness check.
			for (let i = 0; i < 10; i++) {
				const out = resolveManifestDefaults(makeCli(), {}, REPO_ROOT);
				expect(out.runId).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
				);
			}
		});

		it('successive calls produce different UUIDs', () => {
			const a = resolveManifestDefaults(makeCli(), {}, REPO_ROOT);
			const b = resolveManifestDefaults(makeCli(), {}, REPO_ROOT);
			expect(a.runId).not.toBe(b.runId);
		});
	});
});
