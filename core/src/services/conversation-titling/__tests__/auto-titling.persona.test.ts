/**
 * Persona tests — Hermes P7 Chunk A auto-titling semantic.
 *
 * Integration-style tests that wire real instances of ChatSessionStore,
 * ChatTranscriptIndex, and TitleService together with a mocked LLM to verify
 * the end-to-end auto-titling path.
 *
 * Scenarios:
 *   First exchange: runTitleAfterFirstExchange writes the LLM-generated title
 *   to ChatSessionStore (Markdown frontmatter) and ChatTranscriptIndex (SQLite).
 *
 *   skipIfTitled guard: a second call with the same session returns
 *   { updated: false } without overwriting the existing title.
 *
 * REQ-CONV-TITLE-001, REQ-CONV-TITLE-003
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { ChangeLog } from '../../data-store/change-log.js';
import { DataStoreServiceImpl } from '../../data-store/index.js';
import { CONVERSATION_DATA_SCOPES } from '../../conversation/manifest.js';
import { composeChatSessionStore } from '../../conversation-session/compose.js';
import { ChatTranscriptIndexImpl } from '../../chat-transcript-index/chat-transcript-index.js';
import { TitleService } from '../title-service.js';
import { runTitleAfterFirstExchange } from '../auto-title-hook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

// ---------------------------------------------------------------------------
// First exchange persona
// ---------------------------------------------------------------------------

describe('auto-titling persona — first exchange', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-auto-title-persona-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('runTitleAfterFirstExchange writes title to ChatSessionStore frontmatter', async () => {
		// Arrange: real filesystem store + real SQLite index (in-memory)
		const logger = makeMockLogger();

		const data = new DataStoreServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(tempDir),
		});

		const chatTranscriptIndex = new ChatTranscriptIndexImpl(':memory:');
		const chatSessions = composeChatSessionStore({ data, logger, index: chatTranscriptIndex });

		const userId = 'user-p7-persona';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		// Mint a session via appendExchange (creates the file on disk)
		const { sessionId } = await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: 'Plan my weekend trip', timestamp: new Date().toISOString() },
			{ role: 'assistant', content: 'Sure, here is a plan!', timestamp: new Date().toISOString() },
		);

		// Upsert the session into the SQLite index so updateTitle has a row to hit
		await chatTranscriptIndex.upsertSession({
			id: sessionId,
			user_id: userId,
			household_id: null,
			source: 'telegram',
			started_at: new Date().toISOString(),
			ended_at: null,
			model: null,
			title: null,
		});

		// Mock LLM that returns a valid title JSON envelope
		const mockLlm = {
			complete: vi.fn().mockResolvedValue('{"title":"Planning a Weekend Trip"}'),
		};

		const titleService = new TitleService({ chatSessions, chatTranscriptIndex, logger });

		// Act: await the inner function directly (not fire-and-forget)
		await runTitleAfterFirstExchange(
			{
				userId,
				sessionId,
				userContent: 'Plan my weekend trip',
				assistantContent: 'Sure, here is a plan!',
			},
			{ titleService, llm: mockLlm as never, logger },
		);

		// Assert: session frontmatter now has the title
		const session = await chatSessions.readSession(userId, sessionId);
		expect(session).toBeDefined();
		expect(session?.meta.title).toBe('Planning a Weekend Trip');
	});

	it('SQLite index row is also updated to the generated title', async () => {
		const logger = makeMockLogger();

		const data = new DataStoreServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(tempDir),
		});

		const chatTranscriptIndex = new ChatTranscriptIndexImpl(':memory:');
		const chatSessions = composeChatSessionStore({ data, logger, index: chatTranscriptIndex });

		const userId = 'user-p7-sqlite';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		const { sessionId } = await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: 'Budget groceries for the month', timestamp: new Date().toISOString() },
			{ role: 'assistant', content: 'Here is a budget plan.', timestamp: new Date().toISOString() },
		);

		await chatTranscriptIndex.upsertSession({
			id: sessionId,
			user_id: userId,
			household_id: null,
			source: 'telegram',
			started_at: new Date().toISOString(),
			ended_at: null,
			model: null,
			title: null,
		});

		const mockLlm = {
			complete: vi.fn().mockResolvedValue('{"title":"Monthly Grocery Budget Planning"}'),
		};

		const titleService = new TitleService({ chatSessions, chatTranscriptIndex, logger });

		await runTitleAfterFirstExchange(
			{
				userId,
				sessionId,
				userContent: 'Budget groceries for the month',
				assistantContent: 'Here is a budget plan.',
			},
			{ titleService, llm: mockLlm as never, logger },
		);

		// SQLite row should also reflect the title
		const row = await chatTranscriptIndex.getSessionMeta(sessionId);
		expect(row?.title).toBe('Monthly Grocery Budget Planning');
	});
});

// ---------------------------------------------------------------------------
// skipIfTitled guard persona
// ---------------------------------------------------------------------------

describe('auto-titling persona — skipIfTitled guard', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-auto-title-skip-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('second call with same session returns updated:false and does not overwrite existing title', async () => {
		const logger = makeMockLogger();

		const data = new DataStoreServiceImpl({
			dataDir: tempDir,
			appId: 'chatbot',
			userScopes: CONVERSATION_DATA_SCOPES,
			sharedScopes: [],
			changeLog: new ChangeLog(tempDir),
		});

		const chatTranscriptIndex = new ChatTranscriptIndexImpl(':memory:');
		const chatSessions = composeChatSessionStore({ data, logger, index: chatTranscriptIndex });

		const userId = 'user-p7-skip';
		const sessionKey = `agent:main:telegram:dm:${userId}`;

		const { sessionId } = await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: 'Organize my recipes', timestamp: new Date().toISOString() },
			{ role: 'assistant', content: 'Here is how to organize them.', timestamp: new Date().toISOString() },
		);

		await chatTranscriptIndex.upsertSession({
			id: sessionId,
			user_id: userId,
			household_id: null,
			source: 'telegram',
			started_at: new Date().toISOString(),
			ended_at: null,
			model: null,
			title: null,
		});

		const mockLlm = {
			complete: vi
				.fn()
				.mockResolvedValueOnce('{"title":"Organizing Personal Recipe Collection"}')
				.mockResolvedValueOnce('{"title":"New Title Should Not Appear"}'),
		};

		const titleService = new TitleService({ chatSessions, chatTranscriptIndex, logger });

		const hookParams = {
			userId,
			sessionId,
			userContent: 'Organize my recipes',
			assistantContent: 'Here is how to organize them.',
		};
		const hookDeps = { titleService, llm: mockLlm as never, logger };

		// First call — sets the title
		await runTitleAfterFirstExchange(hookParams, hookDeps);

		const sessionAfterFirst = await chatSessions.readSession(userId, sessionId);
		expect(sessionAfterFirst?.meta.title).toBe('Organizing Personal Recipe Collection');

		// Second call — skipIfTitled guard inside applyTitle prevents overwrite
		await runTitleAfterFirstExchange(hookParams, hookDeps);

		const sessionAfterSecond = await chatSessions.readSession(userId, sessionId);
		expect(sessionAfterSecond?.meta.title).toBe('Organizing Personal Recipe Collection');
	});
});
