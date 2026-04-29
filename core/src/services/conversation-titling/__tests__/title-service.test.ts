/**
 * Tests for TitleService.applyTitle.
 *
 * Covers:
 *  - Happy path: setTitle + updateTitle both succeed
 *  - setTitle returns updated:false → updateTitle is NOT called
 *  - updateTitle returns updated:false → warning logged, no throw
 *  - setTitle throws → caught, logged, no throw
 *  - updateTitle throws → caught, logged, no throw
 *  - Logging responsibility lives in TitleService (not in updateTitle impl)
 */

import { describe, expect, it, vi } from 'vitest';
import { TitleService } from '../title-service.js';
import type { ChatSessionStore } from '../../conversation-session/index.js';
import type { ChatTranscriptIndex } from '../../chat-transcript-index/chat-transcript-index.js';

function makeDeps() {
	// updateTitle on ChatTranscriptIndex is async (returns Promise); setTitle is also async.
	const setTitle = vi.fn().mockResolvedValue({ updated: true });
	const updateTitle = vi.fn().mockResolvedValue({ updated: true });
	const warn = vi.fn();
	const chatSessions = { setTitle } as unknown as ChatSessionStore;
	const chatTranscriptIndex = { updateTitle } as unknown as ChatTranscriptIndex;
	const logger = { warn };
	return { setTitle, updateTitle, warn, chatSessions, chatTranscriptIndex, logger };
}

describe('TitleService.applyTitle', () => {
	it('calls setTitle and then updateTitle on success and returns {updated:true,title}', async () => {
		const { chatSessions, chatTranscriptIndex, logger, setTitle, updateTitle } = makeDeps();
		const svc = new TitleService({ chatSessions, chatTranscriptIndex, logger });
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(setTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title', undefined);
		expect(updateTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title');
		expect(result).toEqual({ updated: true, title: 'My title' });
	});

	it('passes opts.skipIfTitled through to setTitle', async () => {
		const { chatSessions, chatTranscriptIndex, logger, setTitle } = makeDeps();
		const svc = new TitleService({ chatSessions, chatTranscriptIndex, logger });
		await svc.applyTitle('u1', 'sess-1', 'My title', { skipIfTitled: true });
		expect(setTitle).toHaveBeenCalledWith('u1', 'sess-1', 'My title', { skipIfTitled: true });
	});

	it('returns {updated:false} when setTitle returns updated:false (no updateTitle call)', async () => {
		const deps = makeDeps();
		deps.setTitle.mockResolvedValue({ updated: false });
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.updateTitle).not.toHaveBeenCalled();
		expect(result).toEqual({ updated: false });
	});

	it('logs warn when updateTitle returns updated:false but still returns updated:true', async () => {
		const deps = makeDeps();
		deps.updateTitle.mockResolvedValue({ updated: false });
		const svc = new TitleService(deps);
		// Markdown is the canonical source — Markdown succeeded, so applyTitle reports success.
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: true, title: 'My title' });
	});

	it('catches setTitle error, logs, returns {updated:false}', async () => {
		const deps = makeDeps();
		deps.setTitle.mockRejectedValue(new Error('disk full'));
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: false });
	});

	it('catches updateTitle error, logs, returns {updated:true,title} (Markdown is canonical)', async () => {
		const deps = makeDeps();
		deps.updateTitle.mockRejectedValue(new Error('db locked'));
		const svc = new TitleService(deps);
		const result = await svc.applyTitle('u1', 'sess-1', 'My title');
		expect(deps.warn).toHaveBeenCalled();
		expect(result).toEqual({ updated: true, title: 'My title' });
	});
});
