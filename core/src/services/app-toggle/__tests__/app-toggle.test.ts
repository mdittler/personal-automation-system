import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readYamlFile } from '../../../utils/yaml.js';
import { AppToggleStore } from '../index.js';

const logger = pino({ level: 'silent' });

describe('AppToggleStore', () => {
	let tempDir: string;
	let store: AppToggleStore;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-toggle-'));
		store = new AppToggleStore({ dataDir: tempDir, logger });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('returns config default when no overrides exist', async () => {
		const result = await store.isEnabled('user1', 'echo', ['*']);
		expect(result).toBe(true);
	});

	it('returns false when app not in enabled list and no override', async () => {
		const result = await store.isEnabled('user1', 'todo', ['echo']);
		expect(result).toBe(false);
	});

	it('returns true when app is in enabled list', async () => {
		const result = await store.isEnabled('user1', 'echo', ['echo', 'notes']);
		expect(result).toBe(true);
	});

	it('override takes precedence over config defaults', async () => {
		await store.setEnabled('user1', 'echo', false);
		const result = await store.isEnabled('user1', 'echo', ['*']);
		expect(result).toBe(false);
	});

	it('can enable an app that was not in config defaults', async () => {
		await store.setEnabled('user1', 'todo', true);
		const result = await store.isEnabled('user1', 'todo', ['echo']);
		expect(result).toBe(true);
	});

	it('persists overrides to YAML file', async () => {
		await store.setEnabled('user1', 'echo', false);
		await store.setEnabled('user2', 'notes', true);

		const data = await readYamlFile<Record<string, Record<string, boolean>>>(
			join(tempDir, 'system', 'app-toggles.yaml'),
		);

		expect(data).toEqual({
			user1: { echo: false },
			user2: { notes: true },
		});
	});

	it('getOverrides returns user overrides', async () => {
		await store.setEnabled('user1', 'echo', false);
		await store.setEnabled('user1', 'notes', true);

		const overrides = await store.getOverrides('user1');
		expect(overrides).toEqual({ echo: false, notes: true });
	});

	it('getOverrides returns empty object for unknown user', async () => {
		const overrides = await store.getOverrides('unknown');
		expect(overrides).toEqual({});
	});

	it('getAllOverrides returns all user overrides', async () => {
		await store.setEnabled('user1', 'echo', false);
		await store.setEnabled('user2', 'notes', true);

		const all = await store.getAllOverrides();
		expect(all).toEqual({
			user1: { echo: false },
			user2: { notes: true },
		});
	});

	it('handles missing YAML file gracefully', async () => {
		const result = await store.isEnabled('user1', 'echo', ['echo']);
		expect(result).toBe(true);
	});
});
