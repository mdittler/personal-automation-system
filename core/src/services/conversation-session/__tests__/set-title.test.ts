/**
 * Tests for ChatSessionStore.setTitle (Hermes P7).
 *
 * Covers all edge cases from spec table:
 *  - Missing session file → { updated: false } + warn
 *  - Corrupt YAML frontmatter → { updated: false } + warn
 *  - skipIfTitled: true with non-null existing title → { updated: false }
 *  - Empty / whitespace-only title → { updated: false }
 *  - Title > 80 chars → truncate
 *  - Title with newlines / control chars → strip
 *  - Normal write preserves all other frontmatter and turns (decoded comparison)
 */

import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { makeStoreFixture } from './fixtures.js';

describe('ChatSessionStore.setTitle', () => {
	const fixtures: Array<{ tempDir: string }> = [];

	afterEach(async () => {
		for (const f of fixtures.splice(0)) {
			await rm(f.tempDir, { recursive: true, force: true });
		}
	});

	async function fixture() {
		const f = await makeStoreFixture();
		fixtures.push(f);
		return f;
	}

	it('returns { updated: false } when session file is missing', async () => {
		const { store, warnings } = await fixture();
		const result = await store.setTitle('u1', '20260101_120000_aaaaaaaa', 'Some title');
		expect(result).toEqual({ updated: false });
		expect(warnings.some((w) => /missing|not found/i.test(w))).toBe(true);
	});

	it('writes title to existing session and preserves all other fields', async () => {
		const { store, ensure, readDecoded } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const before = await readDecoded('u1', sessionId!);

		const result = await store.setTitle('u1', sessionId!, 'Weekly grocery planning');
		expect(result).toEqual({ updated: true, title: 'Weekly grocery planning' });

		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('Weekly grocery planning');
		// Semantic preservation — every other decoded field unchanged.
		expect(after.meta.id).toBe(before.meta.id);
		expect(after.meta.user_id).toBe(before.meta.user_id);
		expect(after.meta.household_id).toBe(before.meta.household_id);
		expect(after.meta.source).toBe(before.meta.source);
		expect(after.meta.model).toBe(before.meta.model);
		expect(after.meta.started_at).toBe(before.meta.started_at);
		expect(after.meta.ended_at).toBe(before.meta.ended_at);
		expect(after.turns).toEqual(before.turns);
	});

	it('skipIfTitled: true is a no-op when title is already non-null', async () => {
		const { store, ensure } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await store.setTitle('u1', sessionId!, 'Manual title');

		const result = await store.setTitle('u1', sessionId!, 'Auto title', { skipIfTitled: true });
		expect(result).toEqual({ updated: false });
	});

	it('skipIfTitled: true writes when title is null', async () => {
		const { store, ensure } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const result = await store.setTitle('u1', sessionId!, 'Auto title', { skipIfTitled: true });
		expect(result).toEqual({ updated: true, title: 'Auto title' });
	});

	it('rejects empty title', async () => {
		const { store, ensure } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		expect(await store.setTitle('u1', sessionId!, '')).toEqual({ updated: false });
		expect(await store.setTitle('u1', sessionId!, '   ')).toEqual({ updated: false });
		expect(await store.setTitle('u1', sessionId!, '\n\t')).toEqual({ updated: false });
	});

	it('truncates title longer than 80 chars', async () => {
		const { store, ensure, readDecoded } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		const long = 'a'.repeat(120);
		await store.setTitle('u1', sessionId!, long);
		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('a'.repeat(80));
	});

	it('strips newlines and control characters', async () => {
		const { store, ensure, readDecoded } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await store.setTitle('u1', sessionId!, 'Line1\nLine2 trailing');
		const after = await readDecoded('u1', sessionId!);
		expect(after.meta.title).toBe('Line1 Line2 trailing');
		expect(after.meta.title).not.toContain('\n');
	});

	it('returns { updated: false } and warns on corrupt frontmatter', async () => {
		const { store, ensure, corruptSessionFile, warnings } = await fixture();
		const { sessionId } = await ensure({ userId: 'u1' });
		await corruptSessionFile('u1', sessionId!);
		const result = await store.setTitle('u1', sessionId!, 'doomed');
		expect(result).toEqual({ updated: false });
		expect(warnings.some((w) => /corrupt/i.test(w))).toBe(true);
	});

	it('returns { updated: false } silently for malformed session id', async () => {
		const { store } = await fixture();
		const result = await store.setTitle('u1', '../traversal', 'title');
		expect(result).toEqual({ updated: false });
	});
});
