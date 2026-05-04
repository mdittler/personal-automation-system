import type { LLMService } from '../../types/llm.js';
import type { SessionTurn } from '../conversation-session/chat-session-store.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

export interface SessionSummarizerDeps {
	llm: Pick<LLMService, 'complete'>;
	logger: { warn(obj: unknown, msg?: string): void };
}

const TRANSCRIPT_MAX_CHARS = 12_000;
const SUMMARY_MAX_CHARS = 1_500;
const TURNS_TAIL = 60;

const SYSTEM_PROMPT =
	'You extract durable memory from a chat transcript. Output JSON of the form {"summary": "..."} where summary is plain prose under 1200 characters listing: stable facts about the user, expressed preferences, decisions made, and unresolved questions or follow-ups. Do NOT recap turn-by-turn. Do NOT include greetings, fillers, or chit-chat. The summary must not contain Markdown headings, code fences, HTML/XML tags, or quote characters. If there is nothing durable to record, return {"summary": null}. Output ONLY the JSON object — no fences.';

// Bidi + zero-width: U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF
const BIDI_ZERO_WIDTH_RE = /[​-‏‪-‮⁦-⁩﻿]/g;

function fenceTranscript(turns: SessionTurn[]): string {
	const tail = turns.slice(-TURNS_TAIL);
	const lines = tail.map((t) => {
		const safe = sanitizeInput(t.content).replace(/[<>]/g, '');
		return `${t.role === 'user' ? 'User' : 'Assistant'}: ${safe}`;
	});
	let body = lines.join('\n');
	if (body.length > TRANSCRIPT_MAX_CHARS) body = body.slice(-TRANSCRIPT_MAX_CHARS);
	return `<conversation>\n${body}\n</conversation>`;
}

function stripFences(raw: string): string {
	return raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
}

export function sanitizeSummaryOutput(raw: string): string | null {
	const cleaned = raw
		.replace(/`/g, '')
		.replace(/[<>]/g, '')
		.replace(BIDI_ZERO_WIDTH_RE, '')
		.replace(/[\x00-\x1F\x7F]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return null;
	return cleaned.slice(0, SUMMARY_MAX_CHARS);
}

export async function summarizeSession(
	turns: SessionTurn[],
	deps: SessionSummarizerDeps,
	signal?: AbortSignal,
): Promise<string | null> {
	if (turns.length < 2) return null;
	if (signal?.aborted) return null;

	const userPrompt = fenceTranscript(turns);
	let raw: string;
	try {
		raw = await deps.llm.complete(userPrompt, {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: 400,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'session-summarizer: LLM call failed');
		return null;
	}
	if (signal?.aborted) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch {
		deps.logger.warn({ raw }, 'session-summarizer: invalid JSON');
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const summary = (parsed as { summary?: unknown }).summary;
	if (summary === null || summary === undefined) return null;
	if (typeof summary !== 'string') return null;
	return sanitizeSummaryOutput(summary);
}
