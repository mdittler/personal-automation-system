import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { getActive, setActive, clearActive } from '../session-index.js';
import type { ActiveSessionEntry } from '../session-index.js';

const USER = 'matt';
const KEY = 'agent:main:telegram:dm:matt';
const KEY2 = 'agent:main:telegram:dm:nina';

let tempDir: string;

function makeStore(userId: string) {
	const svc = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});
	return svc.forUser(userId);
}

const entry1: ActiveSessionEntry = { id: 's1', started_at: '2026-04-27T15:45:00Z', model: null };
const entry2: ActiveSessionEntry = { id: 's2', started_at: '2026-04-27T16:00:00Z', model: 'claude-sonnet-4-6' };

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-session-index-'));
});
afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe('session-index', () => {
	it('returns undefined when no index file exists', async () => {
		const store = makeStore(USER);
		expect(await getActive(store, USER, KEY)).toBeUndefined();
	});

	it('round-trips a single entry via setActive + getActive', async () => {
		const store = makeStore(USER);
		await setActive(store, USER, KEY, entry1);
		expect(await getActive(store, USER, KEY)).toEqual(entry1);
	});

	it('clearActive removes entry; subsequent getActive returns undefined', async () => {
		const store = makeStore(USER);
		await setActive(store, USER, KEY, entry1);
		await clearActive(store, USER, KEY);
		expect(await getActive(store, USER, KEY)).toBeUndefined();
	});

	it('multiple keys coexist in the same file', async () => {
		const store = makeStore(USER);
		await setActive(store, USER, KEY, entry1);
		await setActive(store, USER, KEY2, entry2);
		expect(await getActive(store, USER, KEY)).toEqual(entry1);
		expect(await getActive(store, USER, KEY2)).toEqual(entry2);
	});

	it('clearActive removes only the specified key, leaving others intact', async () => {
		const store = makeStore(USER);
		await setActive(store, USER, KEY, entry1);
		await setActive(store, USER, KEY2, entry2);
		await clearActive(store, USER, KEY);
		expect(await getActive(store, USER, KEY)).toBeUndefined();
		expect(await getActive(store, USER, KEY2)).toEqual(entry2);
	});

	it('self-heals on corrupted YAML: getActive returns undefined', async () => {
		const corruptPath = join(tempDir, 'users', 'matt', 'chatbot', 'conversation', 'active-sessions.yaml');
		await mkdir(join(tempDir, 'users', 'matt', 'chatbot', 'conversation'), { recursive: true });
		await writeFile(corruptPath, 'invalid: [[[corrupt yaml');
		const store = makeStore(USER);
		expect(await getActive(store, USER, KEY)).toBeUndefined();
	});

	it('self-heals: subsequent setActive after corrupt YAML writes a clean file', async () => {
		const corruptPath = join(tempDir, 'users', 'matt', 'chatbot', 'conversation', 'active-sessions.yaml');
		await mkdir(join(tempDir, 'users', 'matt', 'chatbot', 'conversation'), { recursive: true });
		await writeFile(corruptPath, 'invalid: [[[corrupt yaml');
		const store = makeStore(USER);
		await setActive(store, USER, KEY, entry1);
		expect(await getActive(store, USER, KEY)).toEqual(entry1);
	});

	it('two simultaneous setActive under different keys leave both entries (mutex)', async () => {
		const store = makeStore(USER);
		await Promise.all([
			setActive(store, USER, KEY, entry1),
			setActive(store, USER, KEY2, entry2),
		]);
		const a = await getActive(store, USER, KEY);
		const b = await getActive(store, USER, KEY2);
		expect(a?.id).toBe('s1');
		expect(b?.id).toBe('s2');
	});

	it('two simultaneous setActive under the SAME key leaves a valid parseable value (no corruption)', async () => {
		const store = makeStore(USER);
		const entryA: ActiveSessionEntry = { id: 'session-a', started_at: '2026-04-27T15:00:00Z', model: null };
		const entryB: ActiveSessionEntry = { id: 'session-b', started_at: '2026-04-27T15:01:00Z', model: null };
		await Promise.all([
			setActive(store, USER, KEY, entryA),
			setActive(store, USER, KEY, entryB),
		]);
		const result = await getActive(store, USER, KEY);
		expect(result).not.toBeUndefined();
		expect(['session-a', 'session-b']).toContain(result?.id);
	});
});
