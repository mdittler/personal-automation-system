import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppManifest } from '../../../types/manifest.js';
import type { AppModule } from '../../../types/app-module.js';
import { AppRegistry } from '../index.js';

const logger = pino({ level: 'silent' });

function makeManifest(id: string): AppManifest {
	return {
		app: { id, name: id, version: '1.0.0', description: 'virtual', pas_core_version: '>=0.1.0' },
		capabilities: { messages: { intents: [] } },
		requirements: { services: [], data: { user_scopes: [] } },
		user_config: [],
	} as unknown as AppManifest;
}

const noopModule: AppModule = {
	init: async () => {},
	handleMessage: async () => {
		throw new Error('virtual app stub');
	},
};

describe('AppRegistry.registerVirtual', () => {
	it('exposes the virtual app via getApp(id)', () => {
		const registry = new AppRegistry({
			appsDir: '/tmp/nonexistent',
			config: { dataDir: '/tmp', users: [] } as any,
			logger,
		});
		const manifest = makeManifest('chatbot');

		registry.registerVirtual(manifest, noopModule, '<virtual:chatbot>');

		const found = registry.getApp('chatbot');
		expect(found).toBeDefined();
		expect(found?.manifest.app.id).toBe('chatbot');
		expect(found?.appDir).toBe('<virtual:chatbot>');
	});

	it('includes the virtual app in getAll()', () => {
		const registry = new AppRegistry({
			appsDir: '/tmp/nonexistent',
			config: { dataDir: '/tmp', users: [] } as any,
			logger,
		});
		registry.registerVirtual(makeManifest('chatbot'), noopModule, '<virtual:chatbot>');
		expect(registry.getAll().map((a) => a.manifest.app.id)).toContain('chatbot');
	});

	it('rejects duplicate id', () => {
		const registry = new AppRegistry({
			appsDir: '/tmp/nonexistent',
			config: { dataDir: '/tmp', users: [] } as any,
			logger,
		});
		registry.registerVirtual(makeManifest('chatbot'), noopModule, '<virtual:chatbot>');
		expect(() =>
			registry.registerVirtual(makeManifest('chatbot'), noopModule, '<virtual:chatbot>'),
		).toThrow(/duplicate/i);
	});

	it('shutdownAll() succeeds when virtual app has no shutdown method', async () => {
		const registry = new AppRegistry({
			appsDir: '/tmp/nonexistent',
			config: { dataDir: '/tmp', users: [] } as any,
			logger,
		});
		registry.registerVirtual(makeManifest('chatbot'), noopModule, '<virtual:chatbot>');
		await expect(registry.shutdownAll()).resolves.toBeUndefined();
	});
});
