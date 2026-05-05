/**
 * <memory-kind-set> control tag processor.
 *
 * When the LLM emits a <memory-kind-set entry="<slug>" kind="<kind>"/> tag,
 * this processor:
 *   1. Validates the kind ∈ CONTEXT_ENTRY_KINDS.
 *   2. Confirms the entry exists for this user via getForUser.
 *   3. Re-saves the entry with the new kind (same content, updated sidecar).
 *   4. Strips all <memory-kind-set ...\/> tags from the response.
 *
 * Security: the entry regex [a-z0-9][a-z0-9-]{0,99} inherently rejects
 * path traversal sequences, uppercase letters, and bidi/zero-width chars.
 *
 * REQ-CONV-KIND-001 through REQ-CONV-KIND-004 (Hermes P6 Chunk E)
 */

import type { AppLogger } from '../../../types/app-module.js';
import type { ContextEntryKind, ContextStoreService } from '../../../types/context-store.js';
import { CONTEXT_ENTRY_KINDS } from '../../../types/context-store.js';
import { CONTEXT_INTERNAL_BYPASS } from '../../context-store/index.js';
import { normalizeResponse } from '../control-tags.js';

/** Matches <memory-kind-set entry="<slug>" kind="<kind>"/> tags. */
export const MEMORY_KIND_SET_TAG_REGEX =
	/<memory-kind-set\s+entry="([a-z0-9][a-z0-9-]{0,99})"\s+kind="([a-z-]{1,40})"\s*\/>/g;

/** Broad sweeper that removes any shape of <memory-kind-set> opening/self-closing tag. */
const MEMORY_KIND_SET_ANY_REGEX = /<memory-kind-set\b[^>]*\/?>/gi;
/** Sweeper for paired closing tags (LLMs occasionally emit them). */
const MEMORY_KIND_SET_CLOSE_REGEX = /<\/memory-kind-set>/gi;

/**
 * Detects user intent to categorize/tag a memory entry by kind.
 *
 * First group: categorization verbs (categorize, tag, label, classify, mark, set kind).
 * Second group (after up to 60 non-sentence chars): memory-related nouns.
 */
export const MEMORY_KIND_INTENT_REGEX =
	/\b(?:categorize|tag|label|classify|mark|set\s+kind|set\s+the\s+kind|categorize\s+as|tag\s+as|mark\s+as)\b[^.?!]{0,60}\b(?:preference|fact|policy|convention|communication|environment|project|household|user|memory|memories|note|notes)\b/i;

/**
 * Instruction block injected into the system prompt when MEMORY_KIND_INTENT_REGEX
 * matches the user message.
 */
export const MEMORY_KIND_SET_INSTRUCTION_BLOCK = `
When the user wants to categorize a memory entry by kind, include this tag in your response (it will be removed from your visible reply after processing):
  <memory-kind-set entry="<slug>" kind="<kind>"/>
Where <slug> is the exact entry slug (lowercase, hyphens) and <kind> is one of: user-preference, communication-preference, environment-fact, project-convention, household-policy, untyped.
Only emit this tag when the user explicitly requests categorization. Do not emit it to report the current kind.`.trim();

export interface ProcessMemoryKindSetTagsOptions {
	userId: string;
	userMessage: string;
	contextStore: ContextStoreService;
	logger: AppLogger;
}

/**
 * Process <memory-kind-set> tags emitted by the LLM.
 *
 * Security guards (in order):
 * 1. Fast pre-check: return early if '<memory-kind-set' not present.
 * 2. Intent gate: if user message lacks MEMORY_KIND_INTENT_REGEX, strip tags + return.
 * 3. Per tag: validate kind ∈ CONTEXT_ENTRY_KINDS — warn + skip if invalid.
 * 4. Per tag: confirm entry exists via getForUser — warn + skip if not found.
 * 5. Re-save entry with new kind via save(..., { kind, bypass: CONTEXT_INTERNAL_BYPASS }).
 * 6. Strip all <memory-kind-set .../> tags from the response.
 */
export async function processMemoryKindSetTags(
	response: string,
	options: ProcessMemoryKindSetTagsOptions,
): Promise<{ cleanedResponse: string; confirmations: string[] }> {
	const confirmations: string[] = [];

	// Fast pre-check — case-insensitive so <MEMORY-KIND-SET .../> is also caught
	if (!/<memory-kind-set/i.test(response)) {
		return { cleanedResponse: response, confirmations };
	}

	// Intent gate — strip tags silently if user didn't ask for categorization
	if (!MEMORY_KIND_INTENT_REGEX.test(options.userMessage)) {
		const stripped = response
			.replace(MEMORY_KIND_SET_ANY_REGEX, '')
			.replace(MEMORY_KIND_SET_CLOSE_REGEX, '');
		return { cleanedResponse: normalizeResponse(stripped), confirmations };
	}

	// Collect all well-formed tag matches
	const actions: Array<{ entry: string; kind: string }> = [];
	for (const match of response.matchAll(MEMORY_KIND_SET_TAG_REGEX)) {
		const entry = match[1] ?? '';
		const kind = match[2] ?? '';
		actions.push({ entry, kind });
	}

	// Strip all <memory-kind-set ...> tags (well-formed, malformed, and closing)
	const stripped = response
		.replace(MEMORY_KIND_SET_ANY_REGEX, '')
		.replace(MEMORY_KIND_SET_CLOSE_REGEX, '');

	// Process each collected action
	for (const { entry, kind } of actions) {
		// Validate kind
		if (!(CONTEXT_ENTRY_KINDS as readonly string[]).includes(kind)) {
			options.logger.warn(
				'<memory-kind-set> rejected invalid kind "%s" for entry "%s" (userId=%s)',
				kind,
				entry,
				options.userId,
			);
			continue;
		}

		// User-only lookup via listForUser — does NOT fall back to system context.
		// Using getForUser would fall back to system context on miss, causing save() to create
		// a user-context copy of a system entry and silently change durable-memory precedence.
		let userEntries: Awaited<ReturnType<typeof options.contextStore.listForUser>>;
		try {
			userEntries = await options.contextStore.listForUser(options.userId);
		} catch (err) {
			options.logger.warn(
				'<memory-kind-set> listForUser failed for entry "%s" (userId=%s): %s',
				entry,
				options.userId,
				err,
			);
			continue;
		}

		const userEntry = userEntries.find((e) => e.key === entry);
		if (!userEntry) {
			options.logger.warn(
				'<memory-kind-set> entry "%s" not found in user context (userId=%s)',
				entry,
				options.userId,
			);
			continue;
		}

		// Re-save with updated kind
		try {
			await options.contextStore.save(options.userId, entry, userEntry.content, {
				kind: kind as ContextEntryKind,
				bypass: CONTEXT_INTERNAL_BYPASS,
			});
			confirmations.push(`Memory '${entry}' categorized as ${kind}.`);
		} catch (err) {
			options.logger.warn(
				'<memory-kind-set> failed to persist kind for "%s" (userId=%s): %s',
				entry,
				options.userId,
				err,
			);
		}
	}

	return { cleanedResponse: normalizeResponse(stripped), confirmations };
}
