import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { ChangeLog } from '../change-log.js';
import { DataStoreServiceImpl } from '../index.js';

describe('CONVERSATION_DATA_SCOPES contract with DataStoreServiceImpl', () => {
	let tempDir: string;
	let dataDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-conv-scope-'));
		dataDir = join(tempDir, 'data');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('accepts history.json and daily-notes/<date>.md; rejects traversal', async () => {
		const svc = new DataStoreServiceImpl({
			dataDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(dataDir),
		});
		const store = svc.forUser('user-1');

		await expect(store.write('history.json', '{"messages":[]}')).resolves.toBeUndefined();
		await expect(store.read('history.json')).resolves.toBe('{"messages":[]}');
		await expect(store.write('daily-notes/2026-01-02.md', 'note')).resolves.toBeUndefined();
		await expect(store.read('daily-notes/2026-01-02.md')).resolves.toBe('note');
		await expect(store.write('../food/recipes/secret.md', 'nope')).rejects.toThrow();
		await expect(store.write('../../system/config.yaml', 'nope')).rejects.toThrow();
	});

	it('accepts conversation/ paths for session transcripts and index', async () => {
		const svc = new DataStoreServiceImpl({
			dataDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(dataDir),
		});
		const store = svc.forUser('user-1');

		await expect(
			store.write('conversation/active-sessions.yaml', 'sessions: {}'),
		).resolves.toBeUndefined();
		await expect(store.read('conversation/active-sessions.yaml')).resolves.toBe('sessions: {}');
		await expect(
			store.write('conversation/sessions/20260427_154500_a1b2c3d4.md', '---\nid: test\n---'),
		).resolves.toBeUndefined();
	});
});
