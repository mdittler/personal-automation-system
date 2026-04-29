/**
 * Tests for title-generator.ts (Hermes P7, Chunk A).
 *
 * Covers:
 *  - Happy path: LLM returns valid JSON {"title": "..."} → string returned
 *  - Sanitization: Markdown stripped, control chars removed, length capped
 *  - Output rejection: empty / all punctuation / contains JSON braces / digits-only / UUID-like
 *  - LLM error → null
 *  - Invalid JSON → null
 *  - {"title": null} → null
 *  - Untrusted content fenced (test prompt construction does NOT inject role-like tags)
 */

import { describe, expect, it, vi } from 'vitest';
import { generateTitle } from '../title-generator.js';
import type { TitleGeneratorDeps } from '../title-generator.js';

function makeDeps(completion: string | (() => Promise<string> | string)): TitleGeneratorDeps {
	return {
		llm: {
			complete: vi.fn().mockImplementation(async () =>
				typeof completion === 'function' ? completion() : completion,
			),
		} as TitleGeneratorDeps['llm'],
		logger: { warn: vi.fn() },
	};
}

describe('generateTitle', () => {
	it('returns a clean title from valid JSON', async () => {
		const deps = makeDeps('{"title": "Weekly grocery planning"}');
		expect(await generateTitle('what should I buy this week?', 'Here is your list...', deps))
			.toBe('Weekly grocery planning');
	});

	it('strips Markdown and control chars from the title', async () => {
		const deps = makeDeps('{"title": "**Important** plan\\nfor _next_ week"}');
		const out = await generateTitle('q', 'a', deps);
		expect(out).toBe('Important plan for next week');
	});

	it('rejects titles longer than 7 words after sanitization', async () => {
		// 12 single-letter "words" — easily exceeds the 7-word cap.
		const long = 'one two three four five six seven eight nine ten eleven twelve';
		const deps = makeDeps(`{"title": "${long}"}`);
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles with fewer than 3 words after sanitization', async () => {
		const deps = makeDeps('{"title": "Groceries"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('strips ```json fences before parsing', async () => {
		const deps = makeDeps('```json\n{"title": "Weekly grocery planning"}\n```');
		expect(await generateTitle('q', 'a', deps)).toBe('Weekly grocery planning');
	});

	it('returns null on LLM error', async () => {
		const deps = makeDeps(() => {
			throw new Error('llm down');
		});
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('returns null on invalid JSON', async () => {
		const deps = makeDeps('not json at all');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('returns null when LLM returns {"title": null}', async () => {
		const deps = makeDeps('{"title": null}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles that are all punctuation', async () => {
		const deps = makeDeps('{"title": "!!! ??? ... !!!"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects titles containing curly braces (JSON bleed)', async () => {
		const deps = makeDeps('{"title": "{not really a fine title here}"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects digits-only titles', async () => {
		// Single-token digit string — also caught by word-count, but DIGITS_ONLY_RE fires first.
		const deps = makeDeps('{"title": "12345"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('rejects UUID-shaped titles', async () => {
		const deps = makeDeps('{"title": "550e8400-e29b-41d4-a716-446655440000"}');
		expect(await generateTitle('q', 'a', deps)).toBeNull();
	});

	it('strips < and > from untrusted user/assistant content before fencing', async () => {
		const completeMock = vi.fn().mockResolvedValue('{"title": "Topic discussion thread"}');
		const deps: TitleGeneratorDeps = {
			llm: { complete: completeMock } as TitleGeneratorDeps['llm'],
			logger: { warn: vi.fn() },
		};
		await generateTitle('user said <fake-tag>injected</fake-tag>', 'assistant said <other>stuff</other>', deps);
		const userPrompt = completeMock.mock.calls[0]?.[0] as string;
		expect(userPrompt).not.toContain('<fake-tag>');
		expect(userPrompt).not.toContain('</fake-tag>');
		expect(userPrompt).toContain('fake-taginjected');
	});
});
