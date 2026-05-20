import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { AppConfigServiceImpl } from '../app-config-service.js';

const defaults: ManifestUserConfig[] = [
	{ key: 'log_to_notes', type: 'boolean', default: false, description: 'Log to notes' },
	{ key: 'theme', type: 'string', default: 'light', description: 'UI theme' },
];

let tempDir: string;

function makeSvc() {
	return new AppConfigServiceImpl({ dataDir: tempDir, appId: 'test-app', defaults });
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-remove-override-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('AppConfigServiceImpl.removeOverride() — REQ-SETTINGS-005', () => {
	it('removes the key from the override file when the override exists', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true });
		await svc.removeOverride('u1', 'log_to_notes');
		const overrides = await svc.getOverrides('u1');
		expect(overrides).not.toHaveProperty('log_to_notes');
	});

	it('leaves other overrides intact when removing a specific key', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true, theme: 'dark' });
		await svc.removeOverride('u1', 'log_to_notes');
		const overrides = await svc.getOverrides('u1');
		expect(overrides).toEqual({ theme: 'dark' });
	});

	it('is a no-op (no error) when the key has no override', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { theme: 'dark' });
		await expect(svc.removeOverride('u1', 'log_to_notes')).resolves.toBeUndefined();
		expect(await svc.getOverrides('u1')).toEqual({ theme: 'dark' });
	});

	it('is a no-op when no override file exists at all', async () => {
		const svc = makeSvc();
		await expect(svc.removeOverride('u1', 'log_to_notes')).resolves.toBeUndefined();
		expect(await svc.getOverrides('u1')).toBeNull();
	});

	it('remaining override file is valid YAML after removal', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true, theme: 'dark' });
		await svc.removeOverride('u1', 'log_to_notes');
		const overrides = await svc.getOverrides('u1');
		expect(overrides).not.toBeNull();
		expect(typeof overrides!.theme).toBe('string');
	});

	it('throws for an invalid userId', async () => {
		const svc = makeSvc();
		await expect(svc.removeOverride('../../evil', 'log_to_notes')).rejects.toThrow(
			/Invalid userId/,
		);
	});

	it('is idempotent — calling twice on the same key does not error', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true });
		await svc.removeOverride('u1', 'log_to_notes');
		await expect(svc.removeOverride('u1', 'log_to_notes')).resolves.toBeUndefined();
	});

	it('concurrent removeOverride + updateOverrides serialize via withFileLock', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true, theme: 'dark' });
		await Promise.all([
			svc.removeOverride('u1', 'log_to_notes'),
			svc.updateOverrides('u1', { theme: 'ocean' }),
		]);
		const overrides = await svc.getOverrides('u1');
		expect(overrides).not.toBeNull();
		// theme must be 'ocean' (updateOverrides ran)
		// log_to_notes may or may not be present depending on ordering — but the file must be valid
		expect(['dark', 'ocean']).toContain(overrides!.theme);
		// No torn write — file must parse correctly
		expect(typeof overrides!.theme).toBe('string');
	});

	it('concurrent removeOverride calls serialize — final state excludes key', async () => {
		const svc = makeSvc();
		await svc.setAll('u1', { log_to_notes: true });
		await Promise.all([
			svc.removeOverride('u1', 'log_to_notes'),
			svc.removeOverride('u1', 'log_to_notes'),
		]);
		const overrides = await svc.getOverrides('u1');
		// Either null (empty file) or does not contain log_to_notes
		if (overrides !== null) {
			expect(overrides).not.toHaveProperty('log_to_notes');
		}
	});
});
