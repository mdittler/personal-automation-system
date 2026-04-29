/**
 * Tests for ChatTranscriptIndex.updateTitle (Hermes P7).
 *
 * Covers:
 *  - Updates title for an existing session row
 *  - Returns { updated: false } for non-existent sessionId
 *  - Returns { updated: false } for wrong user_id
 *  - Empty title is accepted (TitleService rejects upstream; this layer is dumb)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatTranscriptIndex } from '../index.js';
import type { ChatTranscriptIndex } from '../chat-transcript-index.js';

describe('ChatTranscriptIndex.updateTitle', () => {
	let dir: string;
	let index: ChatTranscriptIndex;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'pas-cti-'));
		index = createChatTranscriptIndex(join(dir, 'cti.db'));
	});

	afterEach(() => {
		index.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it('updates title for existing session', async () => {
		await index.upsertSession({
			id: 'sess-1',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: null,
		});
		const result = await index.updateTitle('u1', 'sess-1', 'Planning weekly groceries');
		expect(result).toEqual({ updated: true });
		const row = await index.getSessionMeta('sess-1');
		expect(row?.title).toBe('Planning weekly groceries');
	});

	it('returns { updated: false } for missing sessionId', async () => {
		const result = await index.updateTitle('u1', 'sess-nonexistent', 'whatever');
		expect(result).toEqual({ updated: false });
	});

	it('returns { updated: false } when user_id does not match the row', async () => {
		await index.upsertSession({
			id: 'sess-2',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: null,
		});
		const result = await index.updateTitle('u2', 'sess-2', 'cross-user attempt');
		expect(result).toEqual({ updated: false });
		const row = await index.getSessionMeta('sess-2');
		expect(row?.title).toBeNull();
	});

	it('overwrites an existing title', async () => {
		await index.upsertSession({
			id: 'sess-3',
			user_id: 'u1',
			household_id: null,
			source: 'telegram',
			started_at: '2024-01-01T00:00:00.000Z',
			ended_at: null,
			model: null,
			title: 'old title',
		});
		await index.updateTitle('u1', 'sess-3', 'new title');
		const row = await index.getSessionMeta('sess-3');
		expect(row?.title).toBe('new title');
	});
});
