import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import { NOTES_INTENT_REGEX, processConfigSetTags } from '../control-tags.js';

const LOG_TO_NOTES_ENTRY: ManifestUserConfig = {
	key: 'log_to_notes',
	type: 'boolean',
	default: false,
	description: 'Log to notes',
};

function makeConfig(): { config: AppConfigService; updateOverrides: ReturnType<typeof vi.fn> } {
	const updateOverrides = vi.fn().mockResolvedValue(undefined);
	const config: AppConfigService = {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(null),
		setAll: vi.fn(),
		updateOverrides,
	} as unknown as AppConfigService;
	return { config, updateOverrides };
}

function makeLogger() {
	return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
}

// ─── NOTES_INTENT_REGEX table-driven tests ────────────────────────────────

describe('NOTES_INTENT_REGEX — positive matches', () => {
	it.each([
		'turn on daily notes',
		'please turn on daily notes',
		'enable daily notes',
		'disable daily notes',
		'start daily notes',
		'stop saving everything',
		"don't log this to daily notes",
		'do not enable note logging',
		'please stop saving all my messages to daily notes',
		'daily notes please turn on',
		'daily notes off please',
		'turn on note logging',
		'enable note log',
		'stop logging my messages',
		'turn off daily notes logging',
	])('matches: %s', (phrase) => {
		expect(NOTES_INTENT_REGEX.test(phrase)).toBe(true);
	});
});

describe('NOTES_INTENT_REGEX — negative (should NOT match)', () => {
	it.each([
		'take notes on this recipe',
		'what are my notes from yesterday?',
		'I want to remember this',
		'show me my daily schedule',
		'add a note about groceries',
		'can you note that down?',
		"what's in my grocery list?",
		'remind me to buy milk',
		'tell me about my food notes',
	])('does NOT match: %s', (phrase) => {
		expect(NOTES_INTENT_REGEX.test(phrase)).toBe(false);
	});
});

// ─── processConfigSetTags ─────────────────────────────────────────────────

describe('processConfigSetTags — happy path', () => {
	it('processes turn-on intent: writes true, strips tag, appends confirmation', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = 'Sure! <config-set key="log_to_notes" value="true"/> Done.';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenCalledWith('user1', { log_to_notes: true });
		// Must NOT contain any manifest default keys
		expect(Object.keys(updateOverrides.mock.calls[0]![1])).toEqual(['log_to_notes']);
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.confirmations).toContain('Daily notes logging turned ON.');
	});

	it('processes turn-off intent: writes false, strips tag', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = 'OK! <config-set key="log_to_notes" value="false"/> Disabled.';
		await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'please stop saving all my messages to daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).toHaveBeenCalledWith('user1', { log_to_notes: false });
	});

	it('bidirectional phrasing: "daily notes please turn on" also fires', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = '<config-set key="log_to_notes" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'daily notes please turn on',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});
		expect(updateOverrides).toHaveBeenCalledOnce();
	});
});

describe('processConfigSetTags — security: allowlist', () => {
	it('rejects key not in allowlist, logs warn, no write', async () => {
		const { config, updateOverrides } = makeConfig();
		const logger = makeLogger();
		const response = '<config-set key="users[0].is_admin" value="true"/>';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger,
		});

		expect(updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(logger.warn).toHaveBeenCalled();
	});

	it('cross-user impossible: userId always comes from options, never the tag', async () => {
		const { config, updateOverrides } = makeConfig();
		// The tag has no userId field — we always write to options.userId
		const response = '<config-set key="log_to_notes" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});
		expect(updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: true });
		// Not 'bob', not any userId derived from the tag content
		expect(updateOverrides).not.toHaveBeenCalledWith('bob', expect.anything());
	});
});

describe('processConfigSetTags — security: intent gate', () => {
	it('strips all tags when user message has no notes intent, no write', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = 'Here you go! <config-set key="log_to_notes" value="true"/>';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: "what's the weather like today?",
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.confirmations).toHaveLength(0);
	});

	it('intent gate reads options.userMessage, not history or assistant text', async () => {
		const { config, updateOverrides } = makeConfig();
		// User message has no intent; assistant text contains intent phrasing (should not matter)
		const response = 'Turn on daily notes! <config-set key="log_to_notes" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'what time is it?',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});
		expect(updateOverrides).not.toHaveBeenCalled();
	});
});

describe('processConfigSetTags — coercion failure', () => {
	it('rejects bad value, no write, tag stripped', async () => {
		const { config, updateOverrides } = makeConfig();
		const logger = makeLogger();
		const response = '<config-set key="log_to_notes" value="banana"/>';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger,
		});

		expect(updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe('processConfigSetTags — mixed allowed/disallowed tags', () => {
	it('only processes allowed+coerce-ok tags; strips others', async () => {
		const { config, updateOverrides } = makeConfig();
		const response =
			'<config-set key="users[0].is_admin" value="true"/> <config-set key="log_to_notes" value="true"/>';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		// Only the allowed key should have been written
		expect(updateOverrides).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenCalledWith('user1', { log_to_notes: true });
		expect(result.cleanedResponse).not.toContain('<config-set');
	});
});

describe('processConfigSetTags — raw-overrides invariant', () => {
	it('updateOverrides call contains exactly one key (no manifest defaults)', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = '<config-set key="log_to_notes" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).toHaveBeenCalledOnce();
		const writtenPartial = updateOverrides.mock.calls[0]![1] as Record<string, unknown>;
		// Exactly one key — manifest defaults not materialised
		expect(Object.keys(writtenPartial)).toHaveLength(1);
		expect(writtenPartial).toHaveProperty('log_to_notes', true);
	});
});

describe('processConfigSetTags — no tags', () => {
	it('returns response unchanged when no config-set tags present', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = 'Just a normal response.';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).toBe(response);
		expect(result.confirmations).toHaveLength(0);
	});
});
