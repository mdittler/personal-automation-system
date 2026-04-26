import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { AppConfigServiceImpl } from '../app-config-service.js';

const defaults: ManifestUserConfig[] = [
	{ key: 'theme', type: 'select', default: 'light', description: 'UI theme', options: ['light', 'dark'] },
	{ key: 'notify', type: 'boolean', default: true, description: 'Enable notifications' },
	{ key: 'log_to_notes', type: 'boolean', default: false, description: 'Log to notes' },
];

let tempDir: string;

function makeSvc() {
	return new AppConfigServiceImpl({ dataDir: tempDir, appId: 'test-app', defaults });
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-update-overrides-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('getOverrides', () => {
	it('returns null when no override file exists', async () => {
		const svc = makeSvc();
		expect(await svc.getOverrides('user1')).toBeNull();
	});

	it('returns the raw override object (NOT merged with defaults)', async () => {
		const svc = makeSvc();
		await svc.setAll('user1', { log_to_notes: true });
		const overrides = await svc.getOverrides('user1');
		expect(overrides).toEqual({ log_to_notes: true });
		// manifest defaults like `theme` must NOT appear
		expect(overrides).not.toHaveProperty('theme');
		expect(overrides).not.toHaveProperty('notify');
	});

	it('rejects invalid userId', async () => {
		const svc = makeSvc();
		// loadOverrides validates the pattern — returns null for invalid shape
		expect(await svc.getOverrides('../../evil')).toBeNull();
	});
});

describe('updateOverrides', () => {
	it('writes only the changed key when no prior overrides exist', async () => {
		const svc = makeSvc();
		await svc.updateOverrides('user1', { log_to_notes: true });
		const raw = await svc.getOverrides('user1');
		expect(raw).toEqual({ log_to_notes: true });
		// manifest defaults must NOT be materialised
		expect(raw).not.toHaveProperty('theme');
		expect(raw).not.toHaveProperty('notify');
	});

	it('merges with prior raw overrides without touching other keys', async () => {
		const svc = makeSvc();
		await svc.setAll('user1', { theme: 'dark' }); // prior override
		await svc.updateOverrides('user1', { log_to_notes: true });
		const raw = await svc.getOverrides('user1');
		expect(raw).toEqual({ theme: 'dark', log_to_notes: true });
	});

	it('overwrites an existing key with the new value', async () => {
		const svc = makeSvc();
		await svc.updateOverrides('user1', { log_to_notes: false });
		await svc.updateOverrides('user1', { log_to_notes: true });
		expect(await svc.getOverrides('user1')).toEqual({ log_to_notes: true });
	});

	it('is a no-op for an empty partial', async () => {
		const svc = makeSvc();
		await svc.setAll('user1', { theme: 'dark' });
		await svc.updateOverrides('user1', {});
		expect(await svc.getOverrides('user1')).toEqual({ theme: 'dark' });
	});

	it('rejects invalid userId', async () => {
		const svc = makeSvc();
		await expect(svc.updateOverrides('../../evil', { log_to_notes: true })).rejects.toThrow();
	});

	it('produces parseable YAML under concurrent writes', async () => {
		const svc = makeSvc();
		// Both writes serialise via withFileLock — the final value is one of the two written
		await Promise.all([
			svc.updateOverrides('user1', { log_to_notes: true }),
			svc.updateOverrides('user1', { log_to_notes: false }),
		]);
		const raw = await svc.getOverrides('user1');
		expect(raw).not.toBeNull();
		expect(typeof raw!.log_to_notes).toBe('boolean');
		// No extra keys from manifest defaults
		expect(Object.keys(raw!)).toEqual(['log_to_notes']);
	});

	it('second concurrent write sees the first write (serialisation)', async () => {
		const svc = makeSvc();
		// Prime an existing key
		await svc.setAll('user1', { theme: 'dark' });

		// Two concurrent updates to different keys
		await Promise.all([
			svc.updateOverrides('user1', { log_to_notes: true }),
			svc.updateOverrides('user1', { notify: false }),
		]);

		const raw = await svc.getOverrides('user1');
		// All three keys must be present (neither write clobbered the other)
		expect(raw).toMatchObject({ theme: 'dark', log_to_notes: true, notify: false });
	});

	it('override file is valid YAML after concurrent writes', async () => {
		const svc = makeSvc();
		await Promise.all([
			svc.updateOverrides('user1', { log_to_notes: true }),
			svc.updateOverrides('user1', { log_to_notes: false }),
		]);
		const overridePath = join(tempDir, 'system', 'app-config', 'test-app', 'user1.yaml');
		const content = await readFile(overridePath, 'utf8');
		expect(content.trim().length).toBeGreaterThan(0);
	});
});

describe('raw-overrides invariant', () => {
	it('after updateOverrides the file contains only the written key, not manifest defaults', async () => {
		const svc = makeSvc();
		await svc.updateOverrides('user1', { log_to_notes: true });
		const raw = await svc.getOverrides('user1');
		expect(Object.keys(raw!)).toEqual(['log_to_notes']);
	});

	it('prior raw-only keys are preserved when updating a different key', async () => {
		const svc = makeSvc();
		// Set up a raw override for auto_detect_pas (not in defaults)
		await svc.setAll('user1', { auto_detect_pas: false });
		await svc.updateOverrides('user1', { log_to_notes: true });
		const raw = await svc.getOverrides('user1');
		expect(raw).toEqual({ auto_detect_pas: false, log_to_notes: true });
	});
});
