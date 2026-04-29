import type { LLMService } from '../../types/llm.js';
import { sanitizeInput } from '../prompt-assembly/sanitization.js';

export interface TitleGeneratorDeps {
	llm: Pick<LLMService, 'complete'>;
	// Narrow logger shape — match the pattern used in recall-classifier.ts.
	// AppLogger lives at `../../types/app-module.js` if a wider type is ever needed.
	logger: { warn(obj: unknown, msg?: string): void };
}

const TITLE_MAX_LEN = 80;
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
		.replace(/[`#*_>]/g, '')
		.replace(/[\r\n\t]+/g, ' ')
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

// Some fast-tier models wrap JSON in ```json fences despite instructions; strip them
// before JSON.parse. Mirrors the pattern in recall-classifier.ts.
function stripFences(raw: string): string {
	return raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
}

export async function generateTitle(
	userContent: string,
	assistantContent: string,
	deps: TitleGeneratorDeps,
): Promise<string | null> {
	const userPrompt = fenceUntrusted(userContent, assistantContent);
	let raw: string;
	try {
		raw = await deps.llm.complete(userPrompt, {
			tier: 'fast',
			systemPrompt: SYSTEM_PROMPT,
			maxTokens: 60,
			temperature: 0,
		});
	} catch (err) {
		deps.logger.warn({ err }, 'title-generator: LLM call failed');
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripFences(raw));
	} catch {
		deps.logger.warn({ raw }, 'title-generator: LLM returned invalid JSON');
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const title = (parsed as { title?: unknown }).title;
	if (title === null || title === undefined) return null;
	if (typeof title !== 'string') return null;
	return sanitizeOutput(title);
}
