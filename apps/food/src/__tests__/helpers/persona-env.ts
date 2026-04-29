/**
 * Persona test environment for the photo memory bridge.
 *
 * Composes a real ChatSessionStore (temp filesystem) with the food app's
 * photo-summary builders and the core prompt-builder to let persona tests
 * assert what actually lands in the LLM system prompt — without calling any
 * real LLM.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Logger } from 'pino';
import { DataStoreServiceImpl } from '../../../../../core/src/services/data-store/index.js';
import { ChangeLog } from '../../../../../core/src/services/data-store/change-log.js';
import { composeChatSessionStore } from '../../../../../core/src/services/conversation-session/compose.js';
import type { ChatSessionStore } from '../../../../../core/src/services/conversation-session/chat-session-store.js';
import { CONVERSATION_DATA_SCOPES } from '../../../../../core/src/services/conversation/manifest.js';
import { buildSystemPrompt } from '../../../../../core/src/services/conversation/prompt-builder.js';
import type { PromptBuilderDeps } from '../../../../../core/src/services/conversation/prompt-builder.js';
import type { ReceiptLineItem } from '../../types.js';
import {
	buildReceiptSummary,
	buildRecipeSummary,
	buildPantrySummary,
	buildGrocerySummary,
} from '../../handlers/photo-summary.js';
import type { ParsedReceipt } from '../../services/receipt-parser.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PersonaEnv {
	userId: string;
	chatSessions: ChatSessionStore;
	uploadReceipt(data: {
		store: string;
		date: string;
		total: number;
		lineItems: ReceiptLineItem[];
	}): Promise<void>;
	uploadRecipe(data: {
		title: string;
		ingredientCount: number;
		stepCount: number;
	}): Promise<void>;
	uploadPantry(items: Array<{ name: string; quantity: string }>): Promise<void>;
	uploadGrocery(
		items: Array<{ name: string; quantity?: number; unit?: string }>,
	): Promise<void>;
	startNewSession(): Promise<void>;
	sendAskAndCaptureLLMPrompt(message: string): Promise<string>;
	teardown(): Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSilentLogger(): Logger {
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

/** Minimal PromptBuilderDeps — only LLM is required; model labels fallback to 'unknown'. */
function makePromptDeps(): PromptBuilderDeps {
	return {
		llm: {
			complete: vi.fn(),
			classify: vi.fn(),
			extractStructured: vi.fn(),
			getModelForTier: (tier: string) => `mock-${tier}`,
		} as unknown as PromptBuilderDeps['llm'],
	};
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export async function createPersonaEnv(): Promise<PersonaEnv> {
	const userId = 'persona-test-u1';
	const tempDir = await mkdtemp(join(tmpdir(), 'pas-persona-'));

	const logger = makeSilentLogger();

	const dataService = new DataStoreServiceImpl({
		dataDir: tempDir,
		appId: 'chatbot',
		userScopes: CONVERSATION_DATA_SCOPES,
		sharedScopes: [],
		changeLog: new ChangeLog(tempDir),
	});

	const chatSessions = composeChatSessionStore({ data: dataService, logger });

	const sessionKey = `agent:main:telegram:dm:${userId}`;
	const promptDeps = makePromptDeps();

	// ── Upload helpers ───────────────────────────────────────────────────────

	async function uploadReceipt(data: {
		store: string;
		date: string;
		total: number;
		lineItems: ReceiptLineItem[];
	}): Promise<void> {
		const parsed: ParsedReceipt = {
			store: data.store,
			date: data.date,
			total: data.total,
			subtotal: data.total,
			tax: null,
			lineItems: data.lineItems,
		};
		const summary = buildReceiptSummary(parsed);
		const now = new Date().toISOString();
		await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: summary.userTurn, timestamp: now },
			{ role: 'assistant', content: summary.assistantTurn, timestamp: now },
		);
	}

	async function uploadRecipe(data: {
		title: string;
		ingredientCount: number;
		stepCount: number;
	}): Promise<void> {
		const summary = buildRecipeSummary(data.title, data.ingredientCount, data.stepCount);
		const now = new Date().toISOString();
		await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: summary.userTurn, timestamp: now },
			{ role: 'assistant', content: summary.assistantTurn, timestamp: now },
		);
	}

	async function uploadPantry(
		items: Array<{ name: string; quantity: string }>,
	): Promise<void> {
		const summary = buildPantrySummary(items);
		const now = new Date().toISOString();
		await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: summary.userTurn, timestamp: now },
			{ role: 'assistant', content: summary.assistantTurn, timestamp: now },
		);
	}

	async function uploadGrocery(
		items: Array<{ name: string; quantity?: number; unit?: string }>,
	): Promise<void> {
		const summary = buildGrocerySummary(
			items.length,
			items.map((i) => ({ name: i.name, quantity: i.quantity ?? null, unit: i.unit ?? null })),
			false,
		);
		const now = new Date().toISOString();
		await chatSessions.appendExchange(
			{ userId, sessionKey },
			{ role: 'user', content: summary.userTurn, timestamp: now },
			{ role: 'assistant', content: summary.assistantTurn, timestamp: now },
		);
	}

	// ── Session control ──────────────────────────────────────────────────────

	async function startNewSession(): Promise<void> {
		await chatSessions.endActive({ userId, sessionKey }, 'newchat');
	}

	// ── Prompt capture ───────────────────────────────────────────────────────

	// `message` is accepted for test documentation (communicates the simulated question) but is not
	// passed to buildSystemPrompt — the test verifies what is in the transcript context (turns),
	// not LLM output. In production /ask would call buildAppAwareSystemPrompt with the live message;
	// here we use buildSystemPrompt to deterministically assert transcript content.
	async function sendAskAndCaptureLLMPrompt(_message: string): Promise<string> {
		const turns = await chatSessions.loadRecentTurns(
			{ userId, sessionKey },
			{ maxTurns: 20 },
		);
		return buildSystemPrompt(
			/* contextEntries */ [],
			turns,
			promptDeps,
			/* options */ {},
		);
	}

	// ── Teardown ─────────────────────────────────────────────────────────────

	async function teardown(): Promise<void> {
		await rm(tempDir, { recursive: true, force: true });
	}

	return {
		userId,
		chatSessions,
		uploadReceipt,
		uploadRecipe,
		uploadPantry,
		uploadGrocery,
		startNewSession,
		sendAskAndCaptureLLMPrompt,
		teardown,
	};
}
