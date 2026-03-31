import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppManifest } from '../../../types/manifest.js';
import type { RegisteredApp } from '../../app-registry/index.js';
import { AppMetadataServiceImpl, type AppMetadataServiceOptions } from '../index.js';

/** Create a minimal manifest for testing. */
function createManifest(
	overrides: Partial<AppManifest> & { app: AppManifest['app'] },
): AppManifest {
	return {
		capabilities: {},
		requirements: {},
		...overrides,
	};
}

/** Create a registered app stub (module and appDir are irrelevant). */
function createRegisteredApp(manifest: AppManifest): RegisteredApp {
	return {
		manifest,
		module: { init: vi.fn(), handleMessage: vi.fn() },
		appDir: `/apps/${manifest.app.id}`,
	};
}

describe('AppMetadataService', () => {
	const mockRegistry = {
		getAll: vi.fn().mockReturnValue([]),
		getApp: vi.fn().mockReturnValue(undefined),
		getLoadedAppIds: vi.fn().mockReturnValue([]),
		getManifestCache: vi.fn(),
		loadAll: vi.fn(),
		shutdownAll: vi.fn(),
	};

	const mockAppToggle = {
		isEnabled: vi.fn().mockResolvedValue(true),
		setEnabled: vi.fn(),
		getOverrides: vi.fn(),
		getAllOverrides: vi.fn(),
	};

	const mockConfig = {
		users: [
			{ id: 'user1', name: 'Alice', isAdmin: true, enabledApps: ['*'], sharedScopes: [] },
			{
				id: 'user2',
				name: 'Bob',
				isAdmin: false,
				enabledApps: ['echo'],
				sharedScopes: [],
			},
		],
	};

	let svc: AppMetadataServiceImpl;

	const echoManifest = createManifest({
		app: {
			id: 'echo',
			name: 'Echo',
			version: '1.0.0',
			description: 'Echoes messages back.',
			author: 'Test',
			category: 'utility',
		},
		capabilities: {
			messages: {
				intents: ['echo', 'repeat'],
				commands: [{ name: '/echo', description: 'Echo a message', args: ['message'] }],
			},
		},
	});

	const chatbotManifest = createManifest({
		app: {
			id: 'chatbot',
			name: 'Chatbot',
			version: '1.1.0',
			description: 'AI assistant.',
			author: 'Test',
		},
		capabilities: {
			messages: {
				intents: [],
				commands: [{ name: '/ask', description: 'Ask about PAS' }],
			},
			schedules: [
				{
					id: 'cleanup',
					description: 'Clean old history',
					cron: '0 3 * * *',
					handler: 'cleanup',
					user_scope: 'all',
				},
			],
			events: { emits: [{ id: 'chatbot.responded', description: 'Chatbot sent a response' }] },
		},
	});

	const photoManifest = createManifest({
		app: {
			id: 'photos',
			name: 'Photos',
			version: '1.0.0',
			description: 'Handles photo messages.',
			author: 'Test',
		},
		capabilities: {
			messages: {
				accepts_photos: true,
				photo_intents: ['receipt', 'document'],
			},
		},
	});

	beforeEach(() => {
		vi.clearAllMocks();
		svc = new AppMetadataServiceImpl({
			registry: mockRegistry,
			appToggle: mockAppToggle,
			config: mockConfig,
		} as unknown as AppMetadataServiceOptions);
	});

	// -- Standard --

	describe('getInstalledApps', () => {
		it('returns metadata for all loaded apps', () => {
			mockRegistry.getAll.mockReturnValue([
				createRegisteredApp(echoManifest),
				createRegisteredApp(chatbotManifest),
			]);

			const apps = svc.getInstalledApps();

			expect(apps).toHaveLength(2);
			expect(apps[0].id).toBe('echo');
			expect(apps[0].name).toBe('Echo');
			expect(apps[0].description).toBe('Echoes messages back.');
			expect(apps[0].version).toBe('1.0.0');
			expect(apps[0].category).toBe('utility');
		});

		it('maps commands correctly', () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);

			const apps = svc.getInstalledApps();

			expect(apps[0].commands).toEqual([
				{ name: '/echo', description: 'Echo a message', args: ['message'] },
			]);
		});

		it('maps intents correctly', () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);

			const apps = svc.getInstalledApps();

			expect(apps[0].intents).toEqual(['echo', 'repeat']);
		});

		it('maps capability flags correctly', () => {
			mockRegistry.getAll.mockReturnValue([
				createRegisteredApp(chatbotManifest),
				createRegisteredApp(photoManifest),
			]);

			const apps = svc.getInstalledApps();

			// chatbot has schedules and events
			expect(apps[0].hasSchedules).toBe(true);
			expect(apps[0].hasEvents).toBe(true);
			expect(apps[0].acceptsPhotos).toBe(false);

			// photos app accepts photos
			expect(apps[1].hasSchedules).toBe(false);
			expect(apps[1].hasEvents).toBe(false);
			expect(apps[1].acceptsPhotos).toBe(true);
		});
	});

	describe('getAppInfo', () => {
		it('returns metadata for a known app', () => {
			mockRegistry.getApp.mockReturnValue(createRegisteredApp(echoManifest));

			const info = svc.getAppInfo('echo');

			expect(info).not.toBeNull();
			expect(info?.id).toBe('echo');
			expect(info?.name).toBe('Echo');
		});

		it('returns null for an unknown app', () => {
			mockRegistry.getApp.mockReturnValue(undefined);

			expect(svc.getAppInfo('nonexistent')).toBeNull();
		});
	});

	describe('getCommandList', () => {
		it('aggregates commands from all apps', () => {
			mockRegistry.getAll.mockReturnValue([
				createRegisteredApp(echoManifest),
				createRegisteredApp(chatbotManifest),
			]);

			const commands = svc.getCommandList();

			expect(commands).toHaveLength(2);
			expect(commands[0]).toEqual({
				command: '/echo',
				description: 'Echo a message',
				appId: 'echo',
				appName: 'Echo',
			});
			expect(commands[1]).toEqual({
				command: '/ask',
				description: 'Ask about PAS',
				appId: 'chatbot',
				appName: 'Chatbot',
			});
		});
	});

	describe('getEnabledApps', () => {
		it('returns only apps enabled for the user', async () => {
			mockRegistry.getAll.mockReturnValue([
				createRegisteredApp(echoManifest),
				createRegisteredApp(chatbotManifest),
			]);
			// echo enabled, chatbot disabled
			mockAppToggle.isEnabled
				.mockResolvedValueOnce(true) // echo
				.mockResolvedValueOnce(false); // chatbot

			const apps = await svc.getEnabledApps('user2');

			expect(apps).toHaveLength(1);
			expect(apps[0].id).toBe('echo');
		});

		it('passes correct defaultEnabledApps from config', async () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);
			mockAppToggle.isEnabled.mockResolvedValue(true);

			await svc.getEnabledApps('user2');

			expect(mockAppToggle.isEnabled).toHaveBeenCalledWith('user2', 'echo', ['echo']);
		});

		it('uses empty defaults for unknown user', async () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);
			mockAppToggle.isEnabled.mockResolvedValue(false);

			const apps = await svc.getEnabledApps('unknown-user');

			expect(mockAppToggle.isEnabled).toHaveBeenCalledWith('unknown-user', 'echo', []);
			expect(apps).toHaveLength(0);
		});
	});

	// -- Edge cases --

	describe('edge cases', () => {
		it('handles app with no commands or intents', () => {
			const minimal = createManifest({
				app: {
					id: 'minimal',
					name: 'Minimal',
					version: '0.1.0',
					description: 'Bare minimum app.',
					author: 'Test',
				},
			});
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(minimal)]);

			const apps = svc.getInstalledApps();

			expect(apps[0].commands).toEqual([]);
			expect(apps[0].intents).toEqual([]);
			expect(apps[0].hasSchedules).toBe(false);
			expect(apps[0].hasEvents).toBe(false);
			expect(apps[0].acceptsPhotos).toBe(false);
			expect(apps[0].category).toBeUndefined();
		});

		it('handles empty registry', () => {
			mockRegistry.getAll.mockReturnValue([]);

			expect(svc.getInstalledApps()).toEqual([]);
			expect(svc.getCommandList()).toEqual([]);
		});

		it('handles wildcard enabledApps for user', async () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);
			mockAppToggle.isEnabled.mockResolvedValue(true);

			await svc.getEnabledApps('user1');

			expect(mockAppToggle.isEnabled).toHaveBeenCalledWith('user1', 'echo', ['*']);
		});
	});

	// -- Security --

	describe('security', () => {
		it('does not expose module instances in AppInfo', () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);

			const apps = svc.getInstalledApps();

			// AppInfo should not have module or appDir
			expect(apps[0]).not.toHaveProperty('module');
			expect(apps[0]).not.toHaveProperty('appDir');
		});

		it('does not expose file paths in AppInfo', () => {
			mockRegistry.getApp.mockReturnValue(createRegisteredApp(echoManifest));

			const info = svc.getAppInfo('echo');

			expect(info).not.toHaveProperty('appDir');
			expect(JSON.stringify(info)).not.toContain('/apps/');
		});

		it('mutations to returned intents do not affect future calls', () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);

			const first = svc.getInstalledApps();
			first[0].intents.push('malicious-intent');

			const second = svc.getInstalledApps();
			expect(second[0].intents).toEqual(['echo', 'repeat']);
		});

		it('mutations to returned command args do not affect future calls', () => {
			mockRegistry.getAll.mockReturnValue([createRegisteredApp(echoManifest)]);

			const first = svc.getInstalledApps();
			first[0].commands[0].args?.push('extra-arg');

			const second = svc.getInstalledApps();
			expect(second[0].commands[0].args).toEqual(['message']);
		});
	});
});
