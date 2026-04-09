import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { readYamlFile } from '../../../utils/yaml.js';
import { requestContext } from '../../context/request-context.js';
import { AppConfigServiceImpl } from '../app-config-service.js';

let tempDir: string;

const defaults: ManifestUserConfig[] = [
	{
		key: 'theme',
		type: 'select',
		default: 'light',
		description: 'UI theme',
		options: ['light', 'dark'],
	},
	{ key: 'notify', type: 'boolean', default: true, description: 'Enable notifications' },
	{ key: 'max_items', type: 'number', default: 10, description: 'Maximum items to show' },
];

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-appconfig-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('AppConfigServiceImpl', () => {
	it('get returns manifest default when no overrides', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await requestContext.run({ userId: 'user1' }, async () => {
			expect(await svc.get<string>('theme')).toBe('light');
			expect(await svc.get<boolean>('notify')).toBe(true);
			expect(await svc.get<number>('max_items')).toBe(10);
		});
	});

	it('get returns user override when set', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark' });

		await requestContext.run({ userId: 'user1' }, async () => {
			expect(await svc.get<string>('theme')).toBe('dark');
		});
	});

	it('getAll merges defaults with overrides', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark', notify: false });

		const all = await svc.getAll('user1');
		expect(all).toEqual({
			theme: 'dark',
			notify: false,
			max_items: 10,
		});
	});

	it('setAll writes overrides to YAML file', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark', max_items: 25 });

		const filePath = join(tempDir, 'system', 'app-config', 'test-app', 'user1.yaml');
		const data = await readYamlFile<Record<string, unknown>>(filePath);
		expect(data).toEqual({ theme: 'dark', max_items: 25 });
	});

	it('get resolves userId from the current requestContext', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark' });
		await svc.setAll('user2', { theme: 'blue' });

		await requestContext.run({ userId: 'user1' }, async () => {
			expect(await svc.get<string>('theme')).toBe('dark');
		});

		await requestContext.run({ userId: 'user2' }, async () => {
			expect(await svc.get<string>('theme')).toBe('blue');
		});
	});

	it('get falls through to manifest default outside any requestContext scope', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		// Even if a user has an override...
		await svc.setAll('user1', { theme: 'dark' });

		// ...calling get() outside any requestContext.run cannot see it.
		expect(await svc.get<string>('theme')).toBe('light');
	});

	it('get throws for unknown config key', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await requestContext.run({ userId: 'user1' }, async () => {
			await expect(svc.get('nonexistent')).rejects.toThrow(
				'Config key "nonexistent" not found for app "test-app"',
			);
		});
	});

	it('setAll rejects invalid userId format', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await expect(svc.setAll('../evil', { theme: 'dark' })).rejects.toThrow('Invalid userId');
		await expect(svc.setAll('user with spaces', { theme: 'dark' })).rejects.toThrow(
			'Invalid userId',
		);
		await expect(svc.setAll('user/slash', { theme: 'dark' })).rejects.toThrow('Invalid userId');
	});

	it('getAll returns only defaults when no user set', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		const all = await svc.getAll();
		expect(all).toEqual({
			theme: 'light',
			notify: true,
			max_items: 10,
		});
	});

	it('get returns override when key exists in both defaults and overrides', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark', notify: false, max_items: 50 });

		await requestContext.run({ userId: 'user1' }, async () => {
			expect(await svc.get<string>('theme')).toBe('dark');
			expect(await svc.get<boolean>('notify')).toBe(false);
			expect(await svc.get<number>('max_items')).toBe(50);
		});
	});

	it('concurrent setAll calls produce consistent final state', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		// Fire multiple concurrent setAll calls — last write wins
		await Promise.all([
			svc.setAll('user1', { theme: 'dark' }),
			svc.setAll('user1', { theme: 'blue' }),
			svc.setAll('user1', { theme: 'green' }),
		]);

		// The final state should be one of the three, not corrupted
		const all = await svc.getAll('user1');
		expect(['dark', 'blue', 'green']).toContain(all.theme);
	});

	it('loadOverrides returns null when no userId in context', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		// No requestContext — get should fall through to defaults
		const theme = await svc.get<string>('theme');
		expect(theme).toBe('light');

		// But unknown key should still throw (no override file to check)
		await expect(svc.get('nonexistent')).rejects.toThrow(
			'Config key "nonexistent" not found for app "test-app"',
		);
	});

	it('concurrent requestContext scopes do not leak userIds across apps', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		await svc.setAll('user1', { theme: 'dark' });
		await svc.setAll('user2', { theme: 'blue' });

		const results = await Promise.all([
			requestContext.run({ userId: 'user1' }, async () => {
				await new Promise((r) => setTimeout(r, 2));
				return svc.get<string>('theme');
			}),
			requestContext.run({ userId: 'user2' }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return svc.get<string>('theme');
			}),
		]);
		expect(results).toEqual(['dark', 'blue']);
	});

	it('getAll returns defaults only for path traversal userId', async () => {
		const svc = new AppConfigServiceImpl({
			dataDir: tempDir,
			appId: 'test-app',
			defaults,
		});

		// Write a real override for comparison
		await svc.setAll('user1', { theme: 'dark' });

		// Path traversal userId should be rejected — returns defaults only
		const all = await svc.getAll('../../etc/passwd');
		expect(all.theme).toBe('light');
		expect(all.notify).toBe(true);
	});
});
