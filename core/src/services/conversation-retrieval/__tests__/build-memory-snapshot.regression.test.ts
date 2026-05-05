/**
 * Regression tests for buildMemorySnapshot — Chunk D (Hermes P6).
 *
 * Verifies:
 * 1. Baseline regression: strict_durable_kinds:false + all-untyped → byte-identical to P5
 * 2. strict_durable_kinds:true + all-untyped → empty snapshot (untyped excluded)
 * 3. strict_durable_kinds:true + mixed kinds → only durable kinds included, ordering preserved
 * 4. opts.kinds override → only matching kinds regardless of config
 * 5. Budget truncation unchanged under Chunk D path
 */

import { describe, expect, it, vi } from 'vitest';
import type { ContextEntry, ContextEntryKind } from '../../../types/context-store.js';
import { CONTEXT_ENTRY_KINDS, DURABLE_KINDS } from '../../../types/context-store.js';
import { CONTEXT_INTERNAL_BYPASS } from '../../context-store/index.js';
import { requestContext } from '../../context/request-context.js';
import { ConversationRetrievalServiceImpl } from '../conversation-retrieval-service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function withUserId<T>(userId: string, fn: () => T): T {
	return requestContext.run({ userId }, fn);
}

function makeEntry(key: string, content: string, kind: ContextEntryKind = 'untyped'): ContextEntry {
	return { key, content, lastUpdated: new Date('2026-01-01'), kind };
}

/**
 * Build a minimal mock contextStore that implements listDurableForUser.
 * The `entries` returned by listDurableForUser honor the `kinds` filter
 * exactly as the real implementation would.
 */
function makeContextStore(allEntries: ContextEntry[]) {
	return {
		listForUser: vi.fn().mockResolvedValue(allEntries),
		listDurableForUser: vi.fn(
			(_userId: string, opts?: { kinds?: ContextEntryKind[]; bypass?: symbol }) => {
				const allowed = opts?.kinds ?? [...CONTEXT_ENTRY_KINDS];
				const filtered = allEntries.filter((e) => allowed.includes(e.kind));
				return Promise.resolve(filtered);
			},
		),
	};
}

// ─── Test 1: Baseline regression ─────────────────────────────────────────────

describe('buildMemorySnapshot — baseline regression (strict_durable_kinds: false, all-untyped)', () => {
	it('produces byte-identical output to P5 when all entries are untyped and strict_durable_kinds is false', async () => {
		const entries = [
			makeEntry('food-prefs', 'I prefer metric units'),
			makeEntry('communication-style', 'Terse replies'),
		];
		const contextStore = makeContextStore(entries);

		// Service with config flag explicitly OFF
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: false } } } as never,
		});

		// Compute the reference output using a P5-equivalent service
		// (no systemConfig → defaults to all-kinds via CONTEXT_ENTRY_KINDS)
		const referenceService = new ConversationRetrievalServiceImpl({
			contextStore: makeContextStore(entries) as never,
		});

		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		const reference = await withUserId('u1', () => referenceService.buildMemorySnapshot());

		// Byte-identical content
		expect(result.content).toBe(reference.content);
		expect(result.status).toBe(reference.status);
		expect(result.entryCount).toBe(reference.entryCount);
	});

	it('includes untyped entries when strict_durable_kinds is false', async () => {
		const entries = [makeEntry('notes', 'some notes', 'untyped')];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: false } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		expect(result.status).toBe('ok');
		expect(result.content).toContain('## notes');
	});

	it('calls listDurableForUser with CONTEXT_ENTRY_KINDS (all 6) when strict_durable_kinds is false', async () => {
		const entries = [makeEntry('k', 'v')];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: false } } } as never,
		});
		await withUserId('u1', () => service.buildMemorySnapshot());
		expect(contextStore.listDurableForUser).toHaveBeenCalledWith(
			'u1',
			expect.objectContaining({
				kinds: expect.arrayContaining([...CONTEXT_ENTRY_KINDS]),
				bypass: CONTEXT_INTERNAL_BYPASS,
			}),
		);
	});
});

// ─── Test 2: strict_durable_kinds:true + all-untyped ─────────────────────────

describe('buildMemorySnapshot — strict_durable_kinds: true, all-untyped entries', () => {
	it('returns status:empty when all entries are untyped and strict_durable_kinds is true', async () => {
		const entries = [
			makeEntry('random-note', 'some text', 'untyped'),
			makeEntry('another-note', 'more text', 'untyped'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		expect(result.status).toBe('empty');
		expect(result.content).toBe('');
		expect(result.entryCount).toBe(0);
	});

	it('calls listDurableForUser with DURABLE_KINDS (5, no untyped) when strict_durable_kinds is true', async () => {
		const entries = [makeEntry('k', 'v', 'untyped')];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		await withUserId('u1', () => service.buildMemorySnapshot());
		expect(contextStore.listDurableForUser).toHaveBeenCalledWith(
			'u1',
			expect.objectContaining({
				kinds: expect.arrayContaining([...DURABLE_KINDS]),
				bypass: CONTEXT_INTERNAL_BYPASS,
			}),
		);
		// Must NOT include 'untyped' in the kinds array
		// biome-ignore lint/style/noNonNullAssertion: mock.calls[0] is validated by expect above
		const callArgs = contextStore.listDurableForUser.mock.calls[0]![1] as {
			kinds: ContextEntryKind[];
		};
		expect(callArgs.kinds).not.toContain('untyped');
	});
});

// ─── Test 3: strict_durable_kinds:true + mixed kinds ─────────────────────────

describe('buildMemorySnapshot — strict_durable_kinds: true, mixed entry kinds', () => {
	it('includes only durable-kind entries, excludes untyped', async () => {
		const entries = [
			makeEntry('diet', 'vegetarian', 'user-preference'),
			makeEntry('raw-note', 'unrelated note', 'untyped'),
			makeEntry('timezone', 'Europe/Berlin', 'environment-fact'),
			makeEntry('greeting', 'be brief', 'communication-preference'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		expect(result.status).toBe('ok');
		expect(result.content).toContain('## diet');
		expect(result.content).toContain('## timezone');
		expect(result.content).toContain('## greeting');
		expect(result.content).not.toContain('## raw-note');
		expect(result.entryCount).toBe(3);
	});

	it('alphabetical ordering preserved among durable entries', async () => {
		const entries = [
			makeEntry('zebra-pref', 'z value', 'user-preference'),
			makeEntry('alpha-fact', 'a value', 'environment-fact'),
			makeEntry('middle-policy', 'm value', 'household-policy'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		const alphaIdx = result.content.indexOf('## alpha-fact');
		const middleIdx = result.content.indexOf('## middle-policy');
		const zebraIdx = result.content.indexOf('## zebra-pref');
		expect(alphaIdx).toBeLessThan(middleIdx);
		expect(middleIdx).toBeLessThan(zebraIdx);
	});

	it('pinned key still appears first even under strict_durable_kinds', async () => {
		const bigContent = 'x'.repeat(900);
		const entries = [
			makeEntry('aaa-pref', bigContent, 'user-preference'),
			makeEntry('bbb-fact', bigContent, 'environment-fact'),
			makeEntry('recent-session-summary', 'prev session summary', 'user-preference'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		const pinnedIdx = result.content.indexOf('## recent-session-summary');
		const aaaIdx = result.content.indexOf('## aaa-pref');
		expect(pinnedIdx).toBeGreaterThanOrEqual(0);
		expect(pinnedIdx).toBeLessThan(aaaIdx);
	});
});

// ─── Test 4: opts.kinds override ─────────────────────────────────────────────

describe('buildMemorySnapshot — opts.kinds override', () => {
	it('opts.kinds: [user-preference] returns only user-preference entries, ignoring config', async () => {
		const entries = [
			makeEntry('food-pref', 'I like spicy food', 'user-preference'),
			makeEntry('env-fact', 'London timezone', 'environment-fact'),
			makeEntry('untyped-note', 'random note', 'untyped'),
		];
		const contextStore = makeContextStore(entries);
		// config says strict, but opts.kinds overrides
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () =>
			service.buildMemorySnapshot({ kinds: ['user-preference'] }),
		);
		expect(result.status).toBe('ok');
		expect(result.content).toContain('## food-pref');
		expect(result.content).not.toContain('## env-fact');
		expect(result.content).not.toContain('## untyped-note');
		expect(result.entryCount).toBe(1);
	});

	it('opts.kinds: all CONTEXT_ENTRY_KINDS overrides strict config, includes untyped', async () => {
		const entries = [
			makeEntry('pref', 'value', 'user-preference'),
			makeEntry('note', 'untyped content', 'untyped'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () =>
			service.buildMemorySnapshot({ kinds: [...CONTEXT_ENTRY_KINDS] }),
		);
		expect(result.content).toContain('## pref');
		expect(result.content).toContain('## note');
		expect(result.entryCount).toBe(2);
	});

	it('opts.kinds passed through to listDurableForUser', async () => {
		const entries = [makeEntry('k', 'v', 'user-preference')];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
		});
		await withUserId('u1', () =>
			service.buildMemorySnapshot({ kinds: ['user-preference', 'environment-fact'] }),
		);
		// biome-ignore lint/style/noNonNullAssertion: mock.calls[0] is validated by the await above
		const callArgs = contextStore.listDurableForUser.mock.calls[0]![1] as {
			kinds: ContextEntryKind[];
			bypass: symbol;
		};
		expect(callArgs.kinds).toEqual(['user-preference', 'environment-fact']);
		expect(callArgs.bypass).toBe(CONTEXT_INTERNAL_BYPASS);
	});
});

// ─── Test 5: Budget truncation unchanged ─────────────────────────────────────

describe('buildMemorySnapshot — budget truncation unchanged under Chunk D path', () => {
	it('truncates at 4000 chars and sets status:ok with truncation marker', async () => {
		const longContent = 'x'.repeat(3000);
		// Both are durable kinds to survive strict filter
		const entries = [
			makeEntry('aaa', longContent, 'user-preference'),
			makeEntry('bbb', longContent, 'environment-fact'),
		];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: true } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		expect(result.status).toBe('ok');
		expect(result.content).toContain('... (snapshot truncated at session start)');
		expect(result.content.length).toBeLessThanOrEqual(4000);
		expect(result.entryCount).toBe(1);
	});

	it('partial first entry included when it alone exceeds budget', async () => {
		const hugeContent = 'x'.repeat(5000);
		const entries = [makeEntry('giant', hugeContent, 'user-preference')];
		const contextStore = makeContextStore(entries);
		const service = new ConversationRetrievalServiceImpl({
			contextStore: contextStore as never,
			systemConfig: { chat: { memory: { strict_durable_kinds: false } } } as never,
		});
		const result = await withUserId('u1', () => service.buildMemorySnapshot());
		expect(result.status).toBe('ok');
		expect(result.content).toContain('... (snapshot truncated at session start)');
		expect(result.content.length).toBeLessThanOrEqual(4000);
		expect(result.content.startsWith('## giant')).toBe(true);
		expect(result.entryCount).toBe(1);
	});
});
