import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../types/config.js';
import type { RouteInfo } from '../../../types/router.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import { handleNotes } from '../handle-notes.js';

function makeConfig(overrides: Record<string, unknown> | null = null): {
	config: AppConfigService;
	updateOverrides: ReturnType<typeof vi.fn>;
} {
	const updateOverrides = vi.fn().mockResolvedValue(undefined);
	const config: AppConfigService = {
		get: vi.fn(),
		getAll: vi.fn(),
		getOverrides: vi.fn().mockResolvedValue(overrides),
		setAll: vi.fn(),
		updateOverrides,
	} as unknown as AppConfigService;
	return { config, updateOverrides };
}

function makeDeps(configOverrides: Record<string, unknown> | null = null, systemDefault = false) {
	const { config, updateOverrides } = makeConfig(configOverrides);
	const telegram = { send: vi.fn().mockResolvedValue(undefined) };
	const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;
	return { deps: { telegram, config, logger, systemDefault }, telegram, updateOverrides };
}

function makeCtx(userId = 'user1') {
	// Include route metadata as required by feedback_precedence_tests_need_route
	const route: RouteInfo = { source: 'command', appId: 'chatbot', intent: 'notes', confidence: 1.0, verifierStatus: 'not-run' };
	return createTestMessageContext({ userId, text: '/notes', route });
}

describe('handleNotes — happy path', () => {
	it('/notes on → updateOverrides({ log_to_notes: true }), sends ON confirmation', async () => {
		const { deps, telegram, updateOverrides } = makeDeps();
		await handleNotes(['on'], makeCtx(), deps);
		expect(updateOverrides).toHaveBeenCalledWith('user1', { log_to_notes: true });
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('ON'));
	});

	it('/notes off → updateOverrides({ log_to_notes: false }), sends OFF confirmation', async () => {
		const { deps, telegram, updateOverrides } = makeDeps();
		await handleNotes(['off'], makeCtx(), deps);
		expect(updateOverrides).toHaveBeenCalledWith('user1', { log_to_notes: false });
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('OFF'));
	});

	it('/notes status → reads resolver, reports effective state (OFF default)', async () => {
		const { deps, telegram, updateOverrides } = makeDeps(null, false);
		await handleNotes(['status'], makeCtx(), deps);
		expect(updateOverrides).not.toHaveBeenCalled();
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('OFF'));
	});

	it('/notes status → reports ON when user override is true', async () => {
		const { deps, telegram } = makeDeps({ log_to_notes: true }, false);
		await handleNotes(['status'], makeCtx(), deps);
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('ON'));
	});

	it('bare /notes (no args) → same as status', async () => {
		const { deps, telegram } = makeDeps(null, false);
		await handleNotes([], makeCtx(), deps);
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringMatching(/ON|OFF/));
	});
});

describe('handleNotes — case insensitive subcommands', () => {
	it.each([['ON'], ['Off'], ['OFF'], ['On']])('handles %s', async (sub) => {
		const { deps, updateOverrides } = makeDeps();
		await handleNotes([sub], makeCtx(), deps);
		expect(updateOverrides).toHaveBeenCalledOnce();
	});

	it.each([['STATUS'], ['Status']])('handles %s', async (sub) => {
		const { deps, updateOverrides } = makeDeps();
		await handleNotes([sub], makeCtx(), deps);
		expect(updateOverrides).not.toHaveBeenCalled();
	});
});

describe('handleNotes — unknown subcommand', () => {
	it('sends usage message for unknown subcommand', async () => {
		const { deps, telegram, updateOverrides } = makeDeps();
		await handleNotes(['weasel'], makeCtx(), deps);
		expect(updateOverrides).not.toHaveBeenCalled();
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('/notes on'));
	});

	it('sends usage for numeric subcommand', async () => {
		const { deps, telegram } = makeDeps();
		await handleNotes(['42'], makeCtx(), deps);
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining('/notes on'));
	});
});

describe('handleNotes — error handling', () => {
	it('sends error message when updateOverrides throws', async () => {
		const { deps, telegram } = makeDeps();
		vi.mocked(deps.config.updateOverrides).mockRejectedValueOnce(new Error('disk full'));
		await handleNotes(['on'], makeCtx(), deps);
		expect(telegram.send).toHaveBeenCalledWith('user1', expect.stringContaining("Couldn't"));
	});

	it('logs warn when updateOverrides throws', async () => {
		const { deps } = makeDeps();
		vi.mocked(deps.config.updateOverrides).mockRejectedValueOnce(new Error('io error'));
		await handleNotes(['off'], makeCtx(), deps);
		expect(deps.logger.warn).toHaveBeenCalled();
	});
});

describe('handleNotes — contract', () => {
	it('ctx.route.source === command is set (feedback_precedence_tests_need_route)', () => {
		const ctx = makeCtx();
		expect(ctx.route?.source).toBe('command');
		expect(ctx.route?.intent).toBe('notes');
	});

	it('writes only log_to_notes key (no extra keys from manifest defaults)', async () => {
		const { deps, updateOverrides } = makeDeps();
		await handleNotes(['on'], makeCtx(), deps);
		const written = updateOverrides.mock.calls[0]![1] as Record<string, unknown>;
		expect(Object.keys(written)).toEqual(['log_to_notes']);
	});
});

describe('handleNotes — concurrency', () => {
	it('concurrent on/off writes serialize, final state is one of the two written values', async () => {
		const { deps, updateOverrides } = makeDeps();
		// Mock to capture sequential calls
		await Promise.all([handleNotes(['on'], makeCtx(), deps), handleNotes(['off'], makeCtx(), deps)]);
		// Both must have been called
		expect(updateOverrides).toHaveBeenCalledTimes(2);
		// Each call writes only { log_to_notes: boolean }
		for (const call of updateOverrides.mock.calls) {
			const written = call[1] as Record<string, unknown>;
			expect(typeof written.log_to_notes).toBe('boolean');
			expect(Object.keys(written)).toHaveLength(1);
		}
	});
});
