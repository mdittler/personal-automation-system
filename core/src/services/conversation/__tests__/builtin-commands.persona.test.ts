/**
 * Persona tests — /ask, /edit, /notes built-in command behaviors (Hermes P1 Chunk C).
 *
 * Exercises ConversationService.handleAsk / handleEdit / handleNotes directly
 * (not through the Router — Router dispatch is covered in conversation-builtin.test.ts).
 *
 * Strong oracle: assertions target handler-specific side effects, not just
 * telegram.send call count (feedback_weak_oracle).
 */

import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ConversationServiceDeps } from '../conversation-service.js';
import { ConversationService } from '../conversation-service.js';
import type { RouteInfo } from '../../../types/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserStore() {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
	};
}

function makeDeps(opts: {
	configOverrides?: Record<string, unknown> | null;
	llmResponse?: string;
} = {}): ConversationServiceDeps & {
	_updateOverrides: ReturnType<typeof vi.fn>;
	_telegram: { send: ReturnType<typeof vi.fn>; sendOptions: ReturnType<typeof vi.fn> };
	_llm: { complete: ReturnType<typeof vi.fn> };
	_editService: { proposeEdit: ReturnType<typeof vi.fn>; confirmEdit: ReturnType<typeof vi.fn> };
} {
	const userStore = makeUserStore();
	const updateOverrides = vi.fn().mockResolvedValue(undefined);
	const telegram = {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn(),
		sendOptions: vi.fn().mockResolvedValue('Cancel'),
		sendWithButtons: vi.fn(),
		editMessage: vi.fn(),
	};
	const complete = vi.fn().mockResolvedValue(opts.llmResponse ?? 'Here is your answer.');
	const editService = {
		proposeEdit: vi.fn().mockResolvedValue({ kind: 'error', action: 'no_match', message: 'No match' }),
		confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
	};
	const deps: ConversationServiceDeps = {
		llm: {
			complete,
			classify: vi.fn(),
			extractStructured: vi.fn(),
			getModelForTier: vi.fn().mockReturnValue('stub'),
		} as any,
		telegram: telegram as any,
		data: {
			forUser: vi.fn().mockReturnValue(userStore),
			forShared: vi.fn().mockReturnValue(userStore),
			forSpace: vi.fn().mockReturnValue(userStore),
		} as any,
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as any,
		timezone: 'UTC',
		config: {
			get: vi.fn(),
			getAll: vi.fn().mockResolvedValue({}),
			getOverrides: vi.fn().mockResolvedValue(opts.configOverrides ?? null),
			setAll: vi.fn(),
			updateOverrides,
		} as any,
		editService: editService as any,
		chatSessions: {
			peekActive: vi.fn().mockResolvedValue(undefined),
			appendExchange: vi.fn().mockResolvedValue({ sessionId: 'test-session' }),
			loadRecentTurns: vi.fn().mockResolvedValue([]),
			endActive: vi.fn().mockResolvedValue({ endedSessionId: null }),
			readSession: vi.fn().mockResolvedValue(undefined),
		} as any,
	};
	return Object.assign(deps, {
		_updateOverrides: updateOverrides,
		_telegram: telegram,
		_llm: { complete },
		_editService: editService,
	});
}

function run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, fn);
}

function commandCtx(userId: string, text: string, intent: string) {
	const route: RouteInfo = {
		source: 'command',
		appId: 'chatbot',
		intent,
		confidence: 1.0,
		verifierStatus: 'not-run',
	};
	return createTestMessageContext({ userId, text, route });
}

// ---------------------------------------------------------------------------
// /ask command
// ---------------------------------------------------------------------------

describe('/ask command', () => {
	it('bare /ask (no args) returns intro WITHOUT calling LLM', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/ask', 'ask');

		await run('alice', () => svc.handleAsk([], ctx));

		expect(deps._llm.complete).not.toHaveBeenCalled();
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining("I'm your PAS assistant"));
	});

	it('/ask with question calls LLM and sends response', async () => {
		const deps = makeDeps({ llmResponse: 'You have 3 apps installed.' });
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/ask what apps do I have?', 'ask');

		await run('alice', () => svc.handleAsk(['what', 'apps', 'do', 'I', 'have?'], ctx));

		expect(deps._llm.complete).toHaveBeenCalled();
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('apps installed'));
	});

	it('/ask and subsequent handleMessage share the same ConversationHistory (history grows)', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);

		await run('alice', async () => {
			await svc.handleAsk(['what are my apps?'], commandCtx('alice', '/ask what are my apps?', 'ask'));
			await svc.handleMessage(createTestMessageContext({ userId: 'alice', text: 'thanks' }));
		});

		// handleAsk: classifier + response = 2 llm.complete calls
		// handleMessage: response = 1 more call
		// Total: 3
		expect(deps._llm.complete).toHaveBeenCalledTimes(3);
		// Both turns should have been saved to session store
		expect(deps.chatSessions.appendExchange).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// /edit command
// ---------------------------------------------------------------------------

describe('/edit command', () => {
	it('/edit without editService → graceful "not available" error, no crash', async () => {
		const deps = makeDeps();
		const depsNoEdit = { ...deps, editService: undefined };
		const svc = new ConversationService(depsNoEdit);
		const ctx = commandCtx('alice', '/edit fix typo in groceries', 'edit');

		await run('alice', () => svc.handleEdit(['fix', 'typo', 'in', 'groceries'], ctx));

		expect(deps._telegram.send).toHaveBeenCalledWith('alice', 'Edit service is not available.');
	});

	it('/edit with editService calls proposeEdit with joined description', async () => {
		const proposal = {
			kind: 'proposal' as const,
			proposalId: 'p-1',
			filePath: 'users/alice/food/prices/costco.md',
			absolutePath: '/data/users/alice/food/prices/costco.md',
			appId: 'food',
			userId: 'alice',
			description: 'fix orange price',
			scope: 'user' as const,
			beforeContent: '- Orange: $5.99',
			afterContent: '- Orange: $4.99',
			beforeHash: 'abc',
			diff: '--- a/costco.md\n+++ b/costco.md\n@@ -1 +1 @@\n-Orange: $5.99\n+Orange: $4.99',
			expiresAt: new Date(Date.now() + 5 * 60 * 1000),
		};
		const deps = makeDeps();
		deps._editService.proposeEdit.mockResolvedValue(proposal);
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/edit fix orange price', 'edit');

		await run('alice', () => svc.handleEdit(['fix', 'orange', 'price'], ctx));

		// Strong oracle: proposeEdit was called with the joined description
		expect(deps._editService.proposeEdit).toHaveBeenCalledWith('fix orange price', 'alice');
		// Confirm/Cancel presented to user
		expect(deps._telegram.sendOptions).toHaveBeenCalledWith(
			'alice',
			expect.stringContaining('Edit preview'),
			['Confirm', 'Cancel'],
		);
	});
});

// ---------------------------------------------------------------------------
// /notes command
// ---------------------------------------------------------------------------

describe('/notes command', () => {
	it('/notes status → reports current state (OFF by default)', async () => {
		const deps = makeDeps({ configOverrides: null }); // no override, system default false
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes status', 'notes');

		await run('alice', () => svc.handleNotes(['status'], ctx));

		expect(deps._updateOverrides).not.toHaveBeenCalled();
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('OFF'));
	});

	it('/notes on → updateOverrides({ log_to_notes: true }), sends ON confirmation', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes on', 'notes');

		await run('alice', () => svc.handleNotes(['on'], ctx));

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: true });
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('ON'));
	});

	it('/notes off → updateOverrides({ log_to_notes: false }), sends OFF confirmation', async () => {
		const deps = makeDeps({ configOverrides: { log_to_notes: true } });
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes off', 'notes');

		await run('alice', () => svc.handleNotes(['off'], ctx));

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: false });
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('OFF'));
	});

	it('/notes status → reports ON when user has override true', async () => {
		const deps = makeDeps({ configOverrides: { log_to_notes: true } });
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes status', 'notes');

		await run('alice', () => svc.handleNotes(['status'], ctx));

		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('ON'));
	});

	it('/notes with unknown subcommand → usage message, no write', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes weasel', 'notes');

		await run('alice', () => svc.handleNotes(['weasel'], ctx));

		expect(deps._updateOverrides).not.toHaveBeenCalled();
		expect(deps._telegram.send).toHaveBeenCalledWith('alice', expect.stringContaining('Usage'));
	});

	it('/notes ON (uppercase) → case-insensitive → updateOverrides called', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);
		const ctx = commandCtx('alice', '/notes ON', 'notes');

		await run('alice', () => svc.handleNotes(['ON'], ctx));

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: true });
	});
});
