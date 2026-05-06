import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../types/app-module.js';
import { processConfigSetTags } from '../control-tags.js';
import { SettingsRegistry } from '../../settings/settings-registry.js';
import { SettingsWriter } from '../../settings/settings-writer.js';
import type { AppConfigService } from '../../../types/config.js';

function makeRegistry(): SettingsRegistry {
	const reg = new SettingsRegistry();
	reg.register({
		key: 'log_to_notes', appId: 'chatbot', category: 'personal',
		label: 'Daily notes', help: 'Save every chat message to your daily notes file.', type: 'boolean', default: false,
		adminOnly: false, dangerous: false, hidden: false, scope: 'per-user',
		nlSafe: true, nlIntentRegex: /\bdaily[-\s]?notes?\b/i,
	});
	reg.register({
		key: 'seasonal_nudges', appId: 'food', category: 'food',
		label: 'Seasonal nudges', help: 'Show seasonal suggestions.', type: 'boolean', default: true,
		adminOnly: false, dangerous: false, hidden: false, scope: 'per-user',
		nlSafe: true, nlIntentRegex: /\bseasonal\b/i,
	});
	reg.register({
		key: 'rogue', appId: 'system', category: 'system',
		label: 'rogue', help: 'Rogue mode.', type: 'boolean', default: false,
		adminOnly: true, dangerous: false, hidden: false, scope: 'system',
		nlSafe: true, nlIntentRegex: /\brogue\b/i,
	});
	reg.register({
		key: 'guest_profiles_info', appId: 'food', category: 'food',
		label: 'Guests', help: 'Guest profiles.', type: 'string', default: '',
		adminOnly: false, dangerous: false, hidden: true, scope: 'per-user',
		nlSafe: false,
	});
	return reg;
}

function makeAppConfig(): AppConfigService {
	return {
		updateOverrides: vi.fn().mockResolvedValue(undefined),
		getOverrides: vi.fn().mockResolvedValue({}),
		getAll: vi.fn(),
		setAll: vi.fn(),
		get: vi.fn(),
	} as unknown as AppConfigService;
}

function makeWriter(
	reg: SettingsRegistry,
	chatbotCfg: AppConfigService,
	foodCfg: AppConfigService,
): SettingsWriter {
	return new SettingsWriter({
		registry: reg,
		appConfigResolver: (id) => (id === 'chatbot' ? chatbotCfg : id === 'food' ? foodCfg : undefined),
		manifestResolver: (id) => {
			if (id === 'chatbot') return [{ key: 'log_to_notes', type: 'boolean', default: false, description: 'd' }];
			if (id === 'food') return [
				{ key: 'seasonal_nudges', type: 'boolean', default: true, description: 'd' },
				{ key: 'guest_profiles_info', type: 'string', default: '', description: 'd' },
			];
			return [];
		},
		logger: makeLogger(),
	});
}

function makeLogger(): AppLogger {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};
}

describe('processConfigSetTags — registry-derived allowlist (REQ-SETTINGS-007)', () => {
	it('legacy bare key "log_to_notes" routes to chatbot AppConfigService', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		const result = await processConfigSetTags(
			'OK turning on. <config-set key="log_to_notes" value="true"/>',
			{
				userId: 'u1',
				userMessage: 'please turn on daily notes',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(chatbotCfg.updateOverrides).toHaveBeenCalledWith('u1', { log_to_notes: true });
		expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.confirmations.length).toBeGreaterThan(0);
	});

	it('qualified key "food.seasonal_nudges" routes to food AppConfigService', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		await processConfigSetTags(
			'OK. <config-set key="food.seasonal_nudges" value="false"/>',
			{
				userId: 'u1',
				userMessage: 'turn off seasonal nudges',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(foodCfg.updateOverrides).toHaveBeenCalledWith('u1', { seasonal_nudges: false });
		expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
	});

	it('rejects hidden key even if nlSafe were true', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		await processConfigSetTags(
			'<config-set key="food.guest_profiles_info" value="x"/>',
			{
				userId: 'u1',
				userMessage: 'set guest profiles',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
	});

	it('rejects when intent regex does not match user message (per-key gate)', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		await processConfigSetTags(
			'<config-set key="food.seasonal_nudges" value="false"/>',
			{
				userId: 'u1',
				userMessage: 'what is the weather',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
	});

	it('rejects admin-only keys', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		await processConfigSetTags(
			'<config-set key="system.rogue" value="true"/>',
			{
				userId: 'u1',
				userMessage: 'enable rogue mode',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
		expect(foodCfg.updateOverrides).not.toHaveBeenCalled();
	});

	it('strips both well-formed and malformed config-set tags', async () => {
		const reg = makeRegistry();
		const writer = makeWriter(reg, makeAppConfig(), makeAppConfig());
		const r = await processConfigSetTags(
			'before <config-set key="x" value="y"/> middle <config-set garbage> end',
			{
				userId: 'u1',
				userMessage: 'foo',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(r.cleanedResponse).not.toContain('config-set');
	});

	it('qualified key with generic label shows "Setting X updated." confirmation', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		const result = await processConfigSetTags(
			'<config-set key="food.seasonal_nudges" value="false"/>',
			{
				userId: 'u1',
				userMessage: 'turn off seasonal nudges',
				logger: makeLogger(),
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(result.confirmations.some((c) => c.includes('Seasonal nudges'))).toBe(true);
	});

	it('key not in registry is rejected with warn', async () => {
		const reg = makeRegistry();
		const chatbotCfg = makeAppConfig();
		const foodCfg = makeAppConfig();
		const logger = makeLogger();
		const writer = makeWriter(reg, chatbotCfg, foodCfg);
		await processConfigSetTags(
			'<config-set key="chatbot.nonexistent_key" value="true"/>',
			{
				userId: 'u1',
				userMessage: 'turn on nonexistent',
				logger,
				settingsRegistry: reg,
				settingsWriter: writer,
			},
		);
		expect(chatbotCfg.updateOverrides).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});
});
