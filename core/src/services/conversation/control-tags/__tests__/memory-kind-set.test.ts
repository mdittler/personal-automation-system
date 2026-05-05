/**
 * Unit tests for <memory-kind-set> control tag processor.
 *
 * REQ-CONV-KIND-001 through REQ-CONV-KIND-004 (P6 Chunk E)
 */

import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../../../../../types/app-module.js';
import type { ContextEntry, ContextStoreService } from '../../../../../types/context-store.js';
import {
	MEMORY_KIND_INTENT_REGEX,
	MEMORY_KIND_SET_TAG_REGEX,
	processMemoryKindSetTags,
} from '../memory-kind-set.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ContextEntry> = {}): ContextEntry {
	return {
		key: 'food-preferences',
		content: 'existing content',
		kind: 'untyped',
		lastUpdated: new Date(),
		...overrides,
	};
}

function makeContextStore(listForUserResult: ContextEntry[] = [makeEntry()]): ContextStoreService {
	return {
		get: vi.fn(),
		search: vi.fn(),
		searchForUser: vi.fn(),
		getForUser: vi.fn(),
		listForUser: vi.fn().mockResolvedValue(listForUserResult),
		save: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn(),
		listDurableForUser: vi.fn(),
	} as unknown as ContextStoreService;
}

function makeLogger(): AppLogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as AppLogger;
}

// ---------------------------------------------------------------------------
// MEMORY_KIND_SET_TAG_REGEX — structural validation
// ---------------------------------------------------------------------------

describe('MEMORY_KIND_SET_TAG_REGEX', () => {
	it('matches a valid tag with entry and kind attributes', () => {
		const tag = '<memory-kind-set entry="food-preferences" kind="user-preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(1);
		expect(matches[0]![1]).toBe('food-preferences');
		expect(matches[0]![2]).toBe('user-preference');
	});

	it('rejects path traversal in entry attribute', () => {
		// The pattern [a-z0-9][a-z0-9-]{0,99} cannot match ../
		const tag = '<memory-kind-set entry="../../../etc/passwd" kind="user-preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(0);
	});

	it('rejects bidi/zero-width characters in entry attribute', () => {
		// U+202E (RTL override) embedded in entry name
		const tag = '<memory-kind-set entry="food‮preferences" kind="user-preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(0);
	});

	it('rejects uppercase letters in entry (lowercase only)', () => {
		const tag = '<memory-kind-set entry="FoodPreferences" kind="user-preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(0);
	});

	it('rejects entry starting with a hyphen', () => {
		const tag = '<memory-kind-set entry="-food" kind="user-preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(0);
	});

	it('accepts entry with numbers and hyphens', () => {
		const tag = '<memory-kind-set entry="item-123-abc" kind="project-convention"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(1);
	});

	it('rejects kind with uppercase letters', () => {
		const tag = '<memory-kind-set entry="food" kind="User-Preference"/>';
		const matches = [...tag.matchAll(MEMORY_KIND_SET_TAG_REGEX)];
		expect(matches).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// MEMORY_KIND_INTENT_REGEX — intent detection
// ---------------------------------------------------------------------------

describe('MEMORY_KIND_INTENT_REGEX', () => {
	it('matches "categorize as preference"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('can you categorize that as a preference')).toBe(true);
	});

	it('matches "tag this memory as a fact"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('please tag this memory as a fact')).toBe(true);
	});

	it('matches "label my notes as project-convention"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('label my notes as project-convention')).toBe(true);
	});

	it('matches "set kind for this memory entry"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('set the kind for this memory entry')).toBe(true);
	});

	it('matches "mark as household policy"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('mark this as household policy')).toBe(true);
	});

	it('does not match generic "remember this" (no categorization intent)', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('remember this for later')).toBe(false);
	});

	it('does not match "what kind of memory is this"', () => {
		expect(MEMORY_KIND_INTENT_REGEX.test('what kind of memory is this')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — happy path
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — happy path', () => {
	it('valid kind + matching entry → updates kind, returns confirmation, strips tag', async () => {
		const contextStore = makeContextStore([
			makeEntry({ key: 'food-preferences', content: 'my food preferences content' }),
		]);
		const logger = makeLogger();

		const response =
			'Sure! <memory-kind-set entry="food-preferences" kind="user-preference"/> Done.';
		const userMessage = 'categorize my food preferences as a user preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.cleanedResponse).toContain('Done.');
		expect(result.confirmations).toHaveLength(1);
		expect(result.confirmations[0]).toContain('food-preferences');
		expect(result.confirmations[0]).toContain('user-preference');

		expect(contextStore.listForUser).toHaveBeenCalledWith('user1');
		expect(contextStore.save).toHaveBeenCalledWith(
			'user1',
			'food-preferences',
			'my food preferences content',
			expect.objectContaining({ kind: 'user-preference' }),
		);
	});

	it('all 6 valid kinds are accepted', async () => {
		const kinds = [
			'user-preference',
			'communication-preference',
			'environment-fact',
			'project-convention',
			'household-policy',
			'untyped',
		] as const;

		for (const kind of kinds) {
			const contextStore = makeContextStore([makeEntry({ key: 'test-entry', content: 'content' })]);
			const logger = makeLogger();
			const response = `<memory-kind-set entry="test-entry" kind="${kind}"/>`;
			const userMessage = 'categorize test-entry as a memory';

			const result = await processMemoryKindSetTags(response, {
				userId: 'user1',
				userMessage,
				contextStore,
				logger,
			});

			expect(result.confirmations).toHaveLength(1);
			expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		}
	});

	it('multiple tags in one response → each processed independently', async () => {
		const contextStore = makeContextStore([
			makeEntry({ key: 'entry-a', content: 'entry content' }),
			makeEntry({ key: 'entry-b', content: 'entry content' }),
		]);
		const logger = makeLogger();

		const response =
			'<memory-kind-set entry="entry-a" kind="user-preference"/> and ' +
			'<memory-kind-set entry="entry-b" kind="household-policy"/> both done.';
		const userMessage = 'categorize these memories as preferences and policies';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.confirmations).toHaveLength(2);
		expect(contextStore.save).toHaveBeenCalledTimes(2);
	});

	it('tag stripped from response but surrounding prose preserved', async () => {
		const contextStore = makeContextStore([makeEntry({ key: 'my-note', content: 'content' })]);
		const logger = makeLogger();

		const response =
			'I have updated the kind for this entry. <memory-kind-set entry="my-note" kind="untyped"/> Let me know if you need anything else.';
		const userMessage = 'mark my-note as untyped memory';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).toContain('I have updated the kind');
		expect(result.cleanedResponse).toContain('Let me know if you need anything else.');
		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — non-existent entry
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — non-existent entry', () => {
	it('entry not found → skipped + warning logged, no confirmation, tag stripped', async () => {
		const contextStore = makeContextStore([]); // empty — entry not in user context
		const logger = makeLogger();

		const response = '<memory-kind-set entry="nonexistent-entry" kind="user-preference"/> Done.';
		const userMessage = 'categorize nonexistent-entry as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.save).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — invalid kind value
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — invalid kind', () => {
	it('invalid kind value → skipped + warning logged, tag stripped, no confirmation', async () => {
		const contextStore = makeContextStore([
			makeEntry({ key: 'food-preferences', content: 'content' }),
		]);
		const logger = makeLogger();

		const response = '<memory-kind-set entry="food-preferences" kind="nonsense"/> Done.';
		const userMessage = 'categorize food-preferences as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.save).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — intent gate
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — intent gate', () => {
	it('user message lacks intent → tags stripped without applying, no confirmation', async () => {
		const contextStore = makeContextStore([makeEntry()]);
		const logger = makeLogger();

		const response = '<memory-kind-set entry="food-preferences" kind="user-preference"/> Done.';
		const userMessage = 'what is the weather today'; // no categorization intent

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.save).not.toHaveBeenCalled();
		// No warn needed for intent gate miss — it's expected behavior
	});

	it('response with no memory-kind-set tag → returned immediately without contextStore calls', async () => {
		const contextStore = makeContextStore([makeEntry()]);
		const logger = makeLogger();

		const response = 'Just a normal response without any tags.';
		const userMessage = 'categorize my food memories';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).toBe(response);
		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.getForUser).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — security
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — security / regex rejection', () => {
	it('path traversal entry "../../../etc/passwd" → regex does not match, tag stripped', async () => {
		const contextStore = makeContextStore([makeEntry()]);
		const logger = makeLogger();

		const response = '<memory-kind-set entry="../../../etc/passwd" kind="user-preference"/> Done.';
		const userMessage = 'categorize this entry as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		// The regex won't match because "../" doesn't match [a-z0-9][a-z0-9-]{0,99}
		// The fallback strip removes any remaining malformed tags
		expect(result.cleanedResponse).not.toContain('entry="../../../etc/passwd"');
		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.save).not.toHaveBeenCalled();
	});

	it('bidi RTL override in entry "food‮preferences" → regex does not match', async () => {
		const contextStore = makeContextStore([makeEntry()]);
		const logger = makeLogger();

		const response = `<memory-kind-set entry="food‮preferences" kind="user-preference"/> Done.`;
		const userMessage = 'categorize this memory as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.confirmations).toHaveLength(0);
		expect(contextStore.save).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// processMemoryKindSetTags — coexistence with <config-set>
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — coexistence with <config-set>', () => {
	it('response containing BOTH config-set and memory-kind-set → memory-kind-set processed, config-set preserved in output', async () => {
		const contextStore = makeContextStore([
			makeEntry({ key: 'food-preferences', content: 'content' }),
		]);
		const logger = makeLogger();

		// Simulate a response with both tags; processMemoryKindSetTags only touches <memory-kind-set>
		const response =
			'Updated settings. <config-set key="log_to_notes" value="true"/> ' +
			'<memory-kind-set entry="food-preferences" kind="user-preference"/> Done.';
		const userMessage = 'categorize food preferences as user preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		// memory-kind-set should be stripped
		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		// config-set should still be present (it's not this processor's job)
		expect(result.cleanedResponse).toContain('<config-set');
		// kind update was applied
		expect(result.confirmations).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// P2-6: system-only entry must NOT be copied into user context
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — system entry not copied to user (P2-6)', () => {
	it('system-only entry absent from listForUser → skipped + warning, no user context copy created', async () => {
		// listForUser returns only user-owned entries.
		// If the entry exists ONLY in system context, listForUser returns [] for that key.
		const contextStore = makeContextStore([]); // empty user context
		const logger = makeLogger();

		const response = '<memory-kind-set entry="system-only-entry" kind="user-preference"/> Done.';
		const userMessage = 'categorize system-only-entry as a user preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		// Tag stripped
		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		// No save call — entry not found in user context
		expect(contextStore.save).not.toHaveBeenCalled();
		// Warning logged
		expect(logger.warn).toHaveBeenCalled();
		// No confirmation
		expect(result.confirmations).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// P3-9: uppercase and closing tags
// ---------------------------------------------------------------------------

describe('processMemoryKindSetTags — case-insensitive tag detection (P3-9)', () => {
	it('uppercase <MEMORY-KIND-SET .../> tag → stripped from response', async () => {
		const contextStore = makeContextStore([]);
		const logger = makeLogger();

		// Uppercase tag — regex won't structurally match but sweep should remove it
		const response = '<MEMORY-KIND-SET entry="food-preferences" kind="user-preference"/> Done.';
		const userMessage = 'categorize food as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<MEMORY-KIND-SET');
		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
	});

	it('paired closing </memory-kind-set> tag alongside opening tag → both stripped', async () => {
		const contextStore = makeContextStore([
			makeEntry({ key: 'food-preferences', content: 'content' }),
		]);
		const logger = makeLogger();

		// LLM sometimes emits paired tags instead of self-closing form
		const response =
			'Before. <memory-kind-set entry="food-preferences" kind="user-preference">extra</memory-kind-set> After.';
		const userMessage = 'categorize food preferences as user preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toContain('<memory-kind-set');
		expect(result.cleanedResponse).not.toContain('</memory-kind-set>');
		expect(result.cleanedResponse).toContain('Before.');
		expect(result.cleanedResponse).toContain('After.');
	});

	it('mixed-case <Memory-Kind-Set .../> → stripped (case-insensitive sweep)', async () => {
		const contextStore = makeContextStore([]);
		const logger = makeLogger();

		const response = '<Memory-Kind-Set entry="food" kind="user-preference"/> Done.';
		const userMessage = 'categorize this as a preference';

		const result = await processMemoryKindSetTags(response, {
			userId: 'user1',
			userMessage,
			contextStore,
			logger,
		});

		expect(result.cleanedResponse).not.toMatch(/<[Mm]emory-[Kk]ind-[Ss]et/);
	});
});
