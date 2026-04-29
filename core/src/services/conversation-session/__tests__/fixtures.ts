/**
 * Shared test fixtures for ChatSessionStore unit tests.
 *
 * makeStoreFixture() returns a real-filesystem store (temp dir), helpers for
 * creating sessions and reading decoded transcripts, and a warnings[] array
 * capturing logger.warn calls.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { composeChatSessionStore } from '../compose.js';
import type { ChatSessionStore, ChatSessionFrontmatter, SessionTurn } from '../chat-session-store.js';
import { decode } from '../transcript-codec.js';

const FROZEN = new Date('2026-01-01T12:00:00Z');

function makeMockLogger(warnings: string[]): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn((...args: unknown[]) => {
			// Capture the message string (first or second arg depending on pino calling convention)
			const msg = args.find((a) => typeof a === 'string') as string | undefined;
			if (msg) warnings.push(msg);
		}),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

export interface StoreFixture {
	store: ChatSessionStore;
	/**
	 * Ensure an active session exists for the given userId.
	 * Mints a new session if none exists.
	 * Returns the sessionId (or undefined if something went wrong).
	 */
	ensure(opts: { userId: string }): Promise<{ sessionId: string | undefined }>;
	/** Read + decode the raw session file directly (bypasses the store). */
	readDecoded(userId: string, sessionId: string): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] }>;
	/** Overwrite the session file with garbage YAML to simulate corruption. */
	corruptSessionFile(userId: string, sessionId: string): Promise<void>;
	/** Array of all strings captured from logger.warn calls. */
	warnings: string[];
	/** Raw temp dir (for afterEach cleanup). */
	tempDir: string;
}

export async function makeStoreFixture(): Promise<StoreFixture> {
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-set-title-'));
	const warnings: string[] = [];
	const logger = makeMockLogger(warnings);

	const data = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});

	const store = composeChatSessionStore({
		data,
		logger,
		clock: () => FROZEN,
	});

	async function ensure({ userId }: { userId: string }): Promise<{ sessionId: string | undefined }> {
		const sessionKey = `agent:main:telegram:dm:${userId}`;
		const { sessionId } = await store.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: 'hello', timestamp: FROZEN.toISOString() },
			{ role: 'assistant', content: 'hi', timestamp: FROZEN.toISOString() },
		);
		return { sessionId };
	}

	async function readDecoded(
		userId: string,
		sessionId: string,
	): Promise<{ meta: ChatSessionFrontmatter; turns: SessionTurn[] }> {
		const userStore = data.forUser(userId);
		const raw = await userStore.read(`conversation/sessions/${sessionId}.md`);
		return decode(raw);
	}

	async function corruptSessionFile(userId: string, sessionId: string): Promise<void> {
		// Locate the file within the DataStore directory structure.
		// DataStoreServiceImpl writes to <dataDir>/users/<userId>/chatbot/conversation/sessions/<sessionId>.md
		const filePath = join(tempDir, 'users', userId, 'chatbot', 'conversation', 'sessions', `${sessionId}.md`);
		// Write garbage that decode() will reject as corrupt YAML
		await writeFile(filePath, '---\nnot: [valid\n yaml: {\n---\ncorrupt body\n');
	}

	return { store, ensure, readDecoded, corruptSessionFile, warnings, tempDir };
}
