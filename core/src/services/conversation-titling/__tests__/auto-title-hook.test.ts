/**
 * Tests for auto-title-hook (Hermes P7, Chunk A).
 *
 * Covers:
 *  - Calls generateTitle then titleService.applyTitle with skipIfTitled: true
 *  - Title null → applyTitle is NOT called
 *  - generateTitle throws → does not throw or call applyTitle
 *  - applyTitle throws → does not throw (orchestrator swallows)
 */

import { describe, expect, it, vi } from 'vitest';
import { runTitleAfterFirstExchange } from '../auto-title-hook.js';
import type { TitleService } from '../title-service.js';
import type { LLMService } from '../../llm/index.js';

vi.mock('../title-generator.js', () => ({
	generateTitle: vi.fn(),
}));

import { generateTitle as mockGenerateTitle } from '../title-generator.js';

function makeDeps() {
	const applyTitle = vi.fn().mockResolvedValue({ updated: true, title: 'A title' });
	const warn = vi.fn();
	return {
		titleService: { applyTitle } as unknown as TitleService,
		llm: { complete: vi.fn() } as unknown as LLMService,
		logger: { warn },
		applyTitle,
		warn,
	};
}

describe('runTitleAfterFirstExchange', () => {
	it('generates title and applies with skipIfTitled: true', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('Planning groceries');
		const deps = makeDeps();
		await runTitleAfterFirstExchange(
			{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
			deps,
		);
		expect(deps.applyTitle).toHaveBeenCalledWith('u1', 'sess-1', 'Planning groceries', { skipIfTitled: true });
	});

	it('does nothing when generateTitle returns null', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const deps = makeDeps();
		await runTitleAfterFirstExchange(
			{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
			deps,
		);
		expect(deps.applyTitle).not.toHaveBeenCalled();
	});

	it('swallows generateTitle errors', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
		const deps = makeDeps();
		await expect(
			runTitleAfterFirstExchange(
				{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
				deps,
			),
		).resolves.toBeUndefined();
		expect(deps.warn).toHaveBeenCalled();
	});

	it('swallows applyTitle errors', async () => {
		(mockGenerateTitle as ReturnType<typeof vi.fn>).mockResolvedValue('A title');
		const deps = makeDeps();
		deps.applyTitle.mockRejectedValue(new Error('boom'));
		await expect(
			runTitleAfterFirstExchange(
				{ userId: 'u1', sessionId: 'sess-1', userContent: 'q', assistantContent: 'a' },
				deps,
			),
		).resolves.toBeUndefined();
		expect(deps.warn).toHaveBeenCalled();
	});
});
