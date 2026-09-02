import type { LLMCompletionMeta, LLMService } from '../../types/llm.js';
import { classifyStructuredOutput, formatRawPreview } from '../../utils/json-strip-fences.js';
import type { SessionTurn } from '../conversation-session/chat-session-store.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

export interface SessionSummarizerDeps {
	/**
	 * `completeWithMeta` is required alongside `complete` so the summarizer can
	 * tell a reply cut off at SUMMARY_MAX_TOKENS from a genuinely malformed one.
	 */
	llm: Pick<LLMService, 'complete' | 'completeWithMeta'>;
	logger: { warn(obj: unknown, msg?: string): void };
}

const TRANSCRIPT_MAX_CHARS = 12_000;
const SUMMARY_MAX_CHARS = 1_500;
const TURNS_TAIL = 60;
/**
 * Output budget for the summary call.
 *
 * Note the tension with SYSTEM_PROMPT, which asks for prose "under 1200
 * characters": 400 tokens is roughly 1600 characters, so a model that takes the
 * prompt at its word sits close to the cap. That is exactly the setup where a
 * cut reply gets logged as "invalid JSON" and nobody thinks to look at the
 * budget — hence the explicit truncation branch below.
 */
const SUMMARY_MAX_TOKENS = 400;

const SYSTEM_PROMPT =
	'You extract durable memory from a chat transcript. Output JSON of the form {"summary": "..."} where summary is plain prose under 1200 characters listing: stable facts about the user, expressed preferences, decisions made, and unresolved questions or follow-ups. Do NOT recap turn-by-turn. Do NOT include greetings, fillers, or chit-chat. The summary must not contain Markdown headings, code fences, HTML/XML tags, or quote characters. If there is nothing durable to record, return {"summary": null}. Output ONLY the JSON object — no fences.';

// Bidi + zero-width: U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF
const BIDI_ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

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

export function sanitizeSummaryOutput(raw: string): string | null {
	const cleaned = raw
		.replace(/`/g, '')
		.replace(/[<>]/g, '')
		.replace(BIDI_ZERO_WIDTH_RE, '')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally strips control chars from LLM output
		.replace(/[\u0000-\u001F\u007F]/g, ' ')
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
	let meta: LLMCompletionMeta;
	try {
		// completeWithMeta (not complete) so `finishReason` is visible: a reply cut
		// off at SUMMARY_MAX_TOKENS must be reported as truncation, not invalid JSON.
		meta = await deps.llm.completeWithMeta(userPrompt, {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: SUMMARY_MAX_TOKENS,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'session-summarizer: LLM call failed');
		return null;
	}
	if (signal?.aborted) return null;

	// 'parse-first': `{"summary": "..."}` is a closed single-string schema, so a
	// reply that parses is complete by construction (a cut lands inside the
	// string and fails to parse). Every branch still returns null; only the log
	// line's honesty changes.
	const outcome = classifyStructuredOutput(meta, {
		order: 'parse-first',
		maxTokens: SUMMARY_MAX_TOKENS,
	});
	if (outcome.kind === 'truncated') {
		deps.logger.warn(
			{ raw: formatRawPreview(outcome.raw) },
			`session-summarizer: LLM reply truncated at the ${SUMMARY_MAX_TOKENS}-token cap (finishReason='length') — the output is incomplete, not malformed; the prompt asks for up to ~1200 characters, which is close to this budget`,
		);
		return null;
	}
	if (outcome.kind !== 'ok') {
		deps.logger.warn({ raw: outcome.raw }, 'session-summarizer: invalid JSON');
		return null;
	}
	const parsed = outcome.value;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const summary = (parsed as { summary?: unknown }).summary;
	if (summary === null || summary === undefined) return null;
	if (typeof summary !== 'string') return null;
	return sanitizeSummaryOutput(summary);
}
