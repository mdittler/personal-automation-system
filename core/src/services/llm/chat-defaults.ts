/**
 * Pinned defaults for the chat-with-tools path (design §5.3, §18).
 *
 * One home so the provider, the config loader, and the tests agree. Every
 * value here appears in `chat-messages.test.ts` ("chat defaults are pinned").
 */

import type { ModelRef, ThinkingLevel } from '../../types/llm.js';

/** Ollama `num_ctx` for chat. Ollama silently truncates prompts past its window, so it is always sent. */
export const DEFAULT_CHAT_CONTEXT_WINDOW = 32768;

/** Ollama `keep_alive` for chat, so the agent model stays loaded (a cold load measured ~13 s). */
export const DEFAULT_OLLAMA_KEEP_ALIVE = '30m';

/** Per-request HTTP timeout for every Ollama call (generate, chat, show). Was an inline literal in ollama-provider.ts. */
export const DEFAULT_OLLAMA_TIMEOUT_MS = 120_000;

/** Operator decision 2026-10-05 §18.1. */
export const DEFAULT_AGENT_MODEL: ModelRef = Object.freeze({
	provider: 'ollama',
	model: 'qwen3.8:27b-mlx',
});

/** Operator decision 2026-10-05 §18.3, measured in the thinking comparison. */
export const DEFAULT_AGENT_THINKING: ThinkingLevel = 'off';

export const THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze([
	'off',
	'low',
	'medium',
	'high',
]);
