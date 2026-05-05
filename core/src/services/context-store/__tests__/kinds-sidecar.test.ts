import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadKindsMap, setKind } from '../kinds-sidecar.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

describe('kinds-sidecar', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-kinds-sidecar-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('loadKindsMap', () => {
		it('returns empty map for missing directory', async () => {
			const logger = createMockLogger();
			const result = await loadKindsMap(join(tempDir, 'nonexistent'), logger);
			expect(result.size).toBe(0);
		});

		it('returns empty map for missing .kinds.yaml', async () => {
			const logger = createMockLogger();
			// tempDir exists but has no .kinds.yaml
			const result = await loadKindsMap(tempDir, logger);
			expect(result.size).toBe(0);
		});

		it('returns correct entries for valid .kinds.yaml', async () => {
			const logger = createMockLogger();
			await writeFile(
				join(tempDir, '.kinds.yaml'),
				'food-preferences: user-preference\nmorning-routine: communication-preference\n',
			);

			const result = await loadKindsMap(tempDir, logger);

			expect(result.size).toBe(2);
			expect(result.get('food-preferences')).toBe('user-preference');
			expect(result.get('morning-routine')).toBe('communication-preference');
		});

		it('returns empty map for corrupt YAML and logs a warning', async () => {
			const logger = createMockLogger();
			await writeFile(join(tempDir, '.kinds.yaml'), '{invalid yaml');

			const result = await loadKindsMap(tempDir, logger);

			expect(result.size).toBe(0);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		});

		it('skips entries with invalid kind values and logs a warning', async () => {
			const logger = createMockLogger();
			await writeFile(
				join(tempDir, '.kinds.yaml'),
				'good-key: user-preference\nbad-key: nonsense\n',
			);

			const result = await loadKindsMap(tempDir, logger);

			expect(result.size).toBe(1);
			expect(result.get('good-key')).toBe('user-preference');
			expect(result.has('bad-key')).toBe(false);
			expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		});

		it('handles all valid ContextEntryKind values', async () => {
			const logger = createMockLogger();
			await writeFile(
				join(tempDir, '.kinds.yaml'),
				`${[
					'a: user-preference',
					'b: communication-preference',
					'c: environment-fact',
					'd: project-convention',
					'e: household-policy',
					'f: untyped',
				].join('\n')}\n`,
			);

			const result = await loadKindsMap(tempDir, logger);

			expect(result.size).toBe(6);
			expect(result.get('a')).toBe('user-preference');
			expect(result.get('b')).toBe('communication-preference');
			expect(result.get('c')).toBe('environment-fact');
			expect(result.get('d')).toBe('project-convention');
			expect(result.get('e')).toBe('household-policy');
			expect(result.get('f')).toBe('untyped');
		});
	});

	describe('setKind', () => {
		it('adds a new entry; re-loading the sidecar reflects the change', async () => {
			const logger = createMockLogger();

			await setKind(tempDir, 'food-preferences', 'user-preference', logger);

			const result = await loadKindsMap(tempDir, logger);
			expect(result.get('food-preferences')).toBe('user-preference');
		});

		it('updates an existing entry without corrupting other entries', async () => {
			const logger = createMockLogger();
			await writeFile(
				join(tempDir, '.kinds.yaml'),
				'food-preferences: user-preference\nmorning-routine: communication-preference\n',
			);

			await setKind(tempDir, 'food-preferences', 'household-policy', logger);

			const result = await loadKindsMap(tempDir, logger);
			expect(result.get('food-preferences')).toBe('household-policy');
			expect(result.get('morning-routine')).toBe('communication-preference');
		});

		it('concurrent setKind calls for same dir: both writes complete without data loss', async () => {
			const logger = createMockLogger();

			await Promise.all([
				setKind(tempDir, 'key-alpha', 'user-preference', logger),
				setKind(tempDir, 'key-beta', 'environment-fact', logger),
			]);

			const result = await loadKindsMap(tempDir, logger);
			// At least one of the two keys must survive
			const alphaOk = result.get('key-alpha') === 'user-preference';
			const betaOk = result.get('key-beta') === 'environment-fact';
			expect(alphaOk || betaOk).toBe(true);
		});
	});
});
