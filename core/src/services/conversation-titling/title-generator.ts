import type { LLMCompletionMeta, LLMService } from '../../types/llm.js';
import { classifyStructuredOutput, formatRawPreview } from '../../utils/json-strip-fences.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

export interface TitleGeneratorDeps {
	/**
	 * `completeWithMeta` is required alongside `complete` so the generator can
	 * tell a reply cut off at TITLE_MAX_TOKENS from a genuinely malformed one.
	 */
	llm: Pick<LLMService, 'complete' | 'completeWithMeta'>;
	// Narrow logger shape — match the pattern used in recall-classifier.ts.
	// AppLogger lives at `../../types/app-module.js` if a wider type is ever needed.
	logger: { warn(obj: unknown, msg?: string): void };
}

const TITLE_MAX_LEN = 80;
/**
 * Output budget for the title call. Tight on purpose — the answer is
 * `{"title": "three to seven words"}`. Tight budgets are exactly where a cut
 * reply gets misreported as invalid JSON, so the truncation branch below names
 * this number instead of blaming the model.
 */
const TITLE_MAX_TOKENS = 60;
const TITLE_MIN_WORDS = 3;
const TITLE_MAX_WORDS = 7;

// Note: the JSON output itself uses double quotes for the {"title": "..."} envelope,
// so we instruct the model not to put quote characters INSIDE the title value.
const SYSTEM_PROMPT = `You generate short titles for conversations. Read the user message and assistant reply, then return JSON of the form {"title": "..."} with a 3-7 word title in plain words. The title value must not contain any quote characters (no ' or " inside the title). No Markdown, no proper nouns unless central, present tense, no pronouns. If you cannot summarize, return {"title": null}. Output ONLY the JSON object — no Markdown fences.`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS_ONLY_RE = /^\d+$/;

function fenceUntrusted(userContent: string, assistantContent: string): string {
	const stripTags = (s: string): string => sanitizeInput(s).replace(/[<>]/g, '');
	return `<conversation>\nUser: ${stripTags(userContent)}\nAssistant: ${stripTags(assistantContent)}\n</conversation>`;
}

function sanitizeOutput(raw: string): string | null {
	const cleaned = raw
		.replace(/[`#*_>\[\]()!]/g, '')
		.replace(/[\r\n\t]+/g, ' ')
		// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char sanitization
		.replace(/[\x00-\x1F\x7F]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length === 0) return null;
	if (/^[\p{P}\s]+$/u.test(cleaned)) return null;
	if (cleaned.includes('{') || cleaned.includes('}')) return null;
	if (DIGITS_ONLY_RE.test(cleaned)) return null;
	if (UUID_RE.test(cleaned)) return null;
	const truncated = cleaned.slice(0, TITLE_MAX_LEN);
	// Enforce 3–7 word target post-truncation. A 1–2 word "title" is usually a fragment;
	// >7 is a runaway sentence. Reject so the caller falls back to the fire-and-forget no-op.
	const wordCount = truncated.split(/\s+/).filter(Boolean).length;
	if (wordCount < TITLE_MIN_WORDS || wordCount > TITLE_MAX_WORDS) return null;
	return truncated;
}

export async function generateTitle(
	userContent: string,
	assistantContent: string,
	deps: TitleGeneratorDeps,
): Promise<string | null> {
	const userPrompt = fenceUntrusted(userContent, assistantContent);
	let meta: LLMCompletionMeta;
	try {
		// completeWithMeta (not complete) so `finishReason` is visible: a reply cut
		// off at TITLE_MAX_TOKENS must be reported as truncation, not invalid JSON.
		meta = await deps.llm.completeWithMeta(userPrompt, {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: TITLE_MAX_TOKENS,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'title-generator: LLM call failed');
		return null;
	}

	// 'parse-first': `{"title": "..."}` is a closed single-string schema, so a
	// reply that parses is complete by construction (a cut lands inside the
	// string and fails to parse). The finish reason only decides WHICH failure to
	// report. Every branch still returns null — titling is fire-and-forget — the
	// only thing that changes is the honesty of the log line.
	const outcome = classifyStructuredOutput(meta, {
		order: 'parse-first',
		maxTokens: TITLE_MAX_TOKENS,
	});
	if (outcome.kind === 'truncated') {
		deps.logger.warn(
			{ raw: formatRawPreview(outcome.raw) },
			`title-generator: LLM reply truncated at the ${TITLE_MAX_TOKENS}-token cap (finishReason='length') — the output is incomplete, not malformed; raise the cap rather than blaming the model`,
		);
		return null;
	}
	if (outcome.kind !== 'ok') {
		deps.logger.warn({ raw: outcome.raw }, 'title-generator: LLM returned invalid JSON');
		return null;
	}
	const parsed = outcome.value;
	if (typeof parsed !== 'object' || parsed === null) return null;
	const title = (parsed as { title?: unknown }).title;
	if (title === null || title === undefined) return null;
	if (typeof title !== 'string') return null;
	return sanitizeOutput(title);
}
