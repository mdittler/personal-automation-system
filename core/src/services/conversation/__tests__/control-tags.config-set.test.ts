import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import type { ManifestUserConfig } from '../../../types/manifest.js';
import {
	FLUSH_MEMORY_INSTRUCTION_BLOCK,
	MEMORY_FLUSH_INTENT_REGEX,
	NOTES_INTENT_REGEX,
	processConfigSetTags,
} from '../control-tags.js';

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
		// "please" without an action verb must NOT match (read-only requests)
		'please show me my daily notes',
		'please summarize my daily notes',
		'please show me my note log',
		'please read my note logging',
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

describe('processConfigSetTags — malformed tag sanitization', () => {
	it('strips reordered-attribute tag: value before key', async () => {
		const { config, updateOverrides } = makeConfig();
		// Regex requires key then value; reordered tag is not parsed but must still be stripped
		const response = 'OK! <config-set value="true" key="log_to_notes"/> Done.';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});
		// Not parsed (reordered), so no write
		expect(updateOverrides).not.toHaveBeenCalled();
		// But must be stripped from the response
		expect(result.cleanedResponse).not.toContain('<config-set');
	});

	it('strips tag with extra attributes', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = 'OK! <config-set key="log_to_notes" value="true" userId="bob"/> Done.';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger: makeLogger(),
		});
		// Extra-attr form is not matched by the strict regex — no write
		expect(updateOverrides).not.toHaveBeenCalled();
		// But the broad sanitizer sweeps it out
		expect(result.cleanedResponse).not.toContain('<config-set');
	});
});

describe('processConfigSetTags — write failure resilience', () => {
	it('returns cleaned response even when updateOverrides throws', async () => {
		const logger = makeLogger();
		const failingConfig: AppConfigService = {
			get: vi.fn(),
			getAll: vi.fn(),
			getOverrides: vi.fn().mockResolvedValue(null),
			setAll: vi.fn(),
			updateOverrides: vi.fn().mockRejectedValue(new Error('disk full')),
		} as unknown as AppConfigService;

		const response = 'Here you go! <config-set key="log_to_notes" value="true"/> Saved.';
		const result = await processConfigSetTags(response, {
			userId: 'user1',
			userMessage: 'turn on daily notes',
			config: failingConfig,
			manifest: [LOG_TO_NOTES_ENTRY],
			logger,
		});

		// Tag is stripped from the response regardless of write failure
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.cleanedResponse).toContain('Here you go!');
		// No confirmation emitted when write fails
		expect(result.confirmations).toHaveLength(0);
		// Write failure is logged as a warning
		expect(logger.warn).toHaveBeenCalled();
	});
});

// ─── MEMORY_FLUSH_INTENT_REGEX table-driven tests ─────────────────────────

const FLUSH_MEMORY_ENTRY: ManifestUserConfig = {
	key: 'flush_memory_on_idle_reset',
	type: 'boolean',
	default: false,
	description: 'Save session summary on idle reset',
};

describe('MEMORY_FLUSH_INTENT_REGEX — positive matches', () => {
	it.each([
		'turn on session memory please',
		'enable session memory',
		'turn off session memory',
		'stop saving session summaries',
		'disable automatic idle summaries',
		'turn off idle summary',
		'turn off the idle summaries',
		'please disable session memory',
		'start saving session summaries',
		"don't save session summaries",
	])('matches: %s', (phrase) => {
		expect(MEMORY_FLUSH_INTENT_REGEX.test(phrase)).toBe(true);
	});
});

describe('MEMORY_FLUSH_INTENT_REGEX — negative (should NOT match)', () => {
	it.each([
		'remember this for me',
		'save the recipe',
		'how much memory does this use',
		'memory usage is high',
		'save a draft',
		'save my notes',
		'enable daily notes',
		'turn on logging',
		'remind me about session next week',
		'i want to save this conversation',
		'what is session management?',
		'show me my memory entries',
	])('does NOT match: %s', (phrase) => {
		expect(MEMORY_FLUSH_INTENT_REGEX.test(phrase)).toBe(false);
	});
});

describe('FLUSH_MEMORY_INSTRUCTION_BLOCK export', () => {
	it('is a non-empty string referencing flush_memory_on_idle_reset', () => {
		expect(typeof FLUSH_MEMORY_INSTRUCTION_BLOCK).toBe('string');
		expect(FLUSH_MEMORY_INSTRUCTION_BLOCK.length).toBeGreaterThan(0);
		expect(FLUSH_MEMORY_INSTRUCTION_BLOCK).toContain('flush_memory_on_idle_reset');
	});
});

// ─── processConfigSetTags for flush_memory_on_idle_reset ──────────────────

describe('processConfigSetTags — flush_memory_on_idle_reset enable', () => {
	it('persists true when MEMORY_FLUSH_INTENT_REGEX matches', async () => {
		const { config, updateOverrides } = makeConfig();
		const response =
			'Sure! <config-set key="flush_memory_on_idle_reset" value="true"/> Done.';
		const result = await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'enable session memory',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenCalledWith('alice', { flush_memory_on_idle_reset: true });
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.confirmations.some((c) => c.toLowerCase().includes('session memory'))).toBe(true);
	});

	it('strips tag and does not write when MEMORY_FLUSH_INTENT_REGEX does not match', async () => {
		const { config, updateOverrides } = makeConfig();
		const response =
			'Here you go! <config-set key="flush_memory_on_idle_reset" value="true"/>';
		const result = await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: "what's the weather like today?",
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).not.toHaveBeenCalled();
		expect(result.cleanedResponse).not.toContain('<config-set');
		expect(result.confirmations).toHaveLength(0);
	});
});

describe('processConfigSetTags — flush_memory_on_idle_reset disable + cleanup', () => {
	it('persists false and calls disableFlushAndCleanup when intent matches disable phrasing', async () => {
		const { config, updateOverrides } = makeConfig();
		const cleanup = vi.fn().mockResolvedValue(undefined);
		const response =
			'OK! <config-set key="flush_memory_on_idle_reset" value="false"/> Disabled.';
		const result = await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'turn off session memory',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
			disableFlushAndCleanup: cleanup,
		});

		expect(updateOverrides).toHaveBeenCalledWith('alice', { flush_memory_on_idle_reset: false });
		expect(cleanup).toHaveBeenCalledWith('alice');
		expect(result.cleanedResponse).not.toContain('<config-set');
	});

	it('disable confirm message mentions session memory turned off', async () => {
		const { config } = makeConfig();
		const response = '<config-set key="flush_memory_on_idle_reset" value="false"/>';
		const result = await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'turn off session memory',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
			disableFlushAndCleanup: vi.fn().mockResolvedValue(undefined),
		});

		expect(result.confirmations.some((c) => c.toLowerCase().includes('off'))).toBe(true);
	});

	it('does not call disableFlushAndCleanup when not provided', async () => {
		const { config } = makeConfig();
		// Just verify it doesn't throw when the option is absent
		const response = '<config-set key="flush_memory_on_idle_reset" value="false"/>';
		await expect(
			processConfigSetTags(response, {
				userId: 'alice',
				userMessage: 'turn off session memory',
				config,
				manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
				logger: makeLogger(),
			}),
		).resolves.toBeDefined();
	});
});

describe('processConfigSetTags — co-existence: notes intent does NOT toggle flush', () => {
	it('notes-only message does not process flush_memory_on_idle_reset tag', async () => {
		const { config, updateOverrides } = makeConfig();
		const response =
			'<config-set key="flush_memory_on_idle_reset" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'turn on daily notes',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).not.toHaveBeenCalled();
	});

	it('flush-only message does not process log_to_notes tag', async () => {
		const { config, updateOverrides } = makeConfig();
		const response = '<config-set key="log_to_notes" value="true"/>';
		await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'enable session memory',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).not.toHaveBeenCalled();
	});

	it('message matching both intents processes both tags independently', async () => {
		const { config, updateOverrides } = makeConfig();
		const response =
			'<config-set key="log_to_notes" value="true"/> <config-set key="flush_memory_on_idle_reset" value="true"/>';
		// Craft a message that matches BOTH regexes
		await processConfigSetTags(response, {
			userId: 'alice',
			userMessage: 'turn on daily notes and enable session memory',
			config,
			manifest: [LOG_TO_NOTES_ENTRY, FLUSH_MEMORY_ENTRY],
			logger: makeLogger(),
		});

		expect(updateOverrides).toHaveBeenCalledTimes(2);
	});
});
