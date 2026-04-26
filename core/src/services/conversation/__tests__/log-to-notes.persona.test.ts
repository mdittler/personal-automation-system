/**
 * Persona tests — daily-notes opt-in and conversational toggle (Hermes P1 Chunk C).
 *
 * Exercises the full handleMessage flow through ConversationService:
 *   - Opt-in gate: system default, per-user override precedence
 *   - <config-set> LLM tag: allowlist, intent gate, coercion
 *   - LLM error fidelity: suffix only appears when note was actually written
 *   - CONFIG_SET_INSTRUCTION_BLOCK injected post-prompt-build (never inside prompt-builder)
 *
 * Strong oracle: assertions target the specific dep call or response substring —
 * never just "telegram.send was called" (feedback_weak_oracle).
 *
 * Classifier is NOT mocked separately because autoDetect defaults to OFF;
 * each handleMessage makes exactly one llm.complete call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../../context/request-context.js';
import { createTestMessageContext } from '../../../testing/test-helpers.js';
import type { ConversationServiceDeps } from '../conversation-service.js';
import { ConversationService } from '../conversation-service.js';
import { CONFIG_SET_INSTRUCTION_BLOCK } from '../control-tags.js';

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

interface MakeDepsOpts {
	configOverrides?: Record<string, unknown> | null;
	systemDefault?: boolean;
	llmResponse?: string;
}

function makeDeps(opts: MakeDepsOpts = {}): ConversationServiceDeps & {
	_userStore: ReturnType<typeof makeUserStore>;
	_updateOverrides: ReturnType<typeof vi.fn>;
	_telegram: { send: ReturnType<typeof vi.fn> };
	_llm: { complete: ReturnType<typeof vi.fn> };
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
	const complete = vi.fn().mockResolvedValue(opts.llmResponse ?? 'OK');
	const config = {
		get: vi.fn(),
		getAll: vi.fn().mockResolvedValue({}),
		getOverrides: vi.fn().mockResolvedValue(opts.configOverrides ?? null),
		setAll: vi.fn(),
		updateOverrides,
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
		config: config as any,
		chatLogToNotesDefault: opts.systemDefault ?? false,
	};
	return Object.assign(deps, {
		_userStore: userStore,
		_updateOverrides: updateOverrides,
		_telegram: telegram,
		_llm: { complete },
	});
}

function run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return requestContext.run({ userId }, fn);
}

function ctx(userId: string, text: string) {
	return createTestMessageContext({ userId, text });
}

// ---------------------------------------------------------------------------
// Opt-in gate — append behavior
// ---------------------------------------------------------------------------

describe('opt-in gate — append behavior', () => {
	it('default OFF: message NOT appended to daily notes when no override and systemDefault=false', async () => {
		const deps = makeDeps(); // systemDefault: false, no override
		const svc = new ConversationService(deps);

		await run('alice', () => svc.handleMessage(ctx('alice', 'hi there')));

		expect(deps._userStore.append).not.toHaveBeenCalled();
	});

	it('opted IN: message appended to daily notes when user override is true', async () => {
		const deps = makeDeps({ configOverrides: { log_to_notes: true } });
		const svc = new ConversationService(deps);

		await run('alice', () => svc.handleMessage(ctx('alice', 'I just had eggs for breakfast')));

		expect(deps._userStore.append).toHaveBeenCalledWith(
			expect.stringContaining('daily-notes/'),
			expect.stringContaining('I just had eggs for breakfast'),
			expect.anything(),
		);
	});

	it('system default ON, no per-user override → notes appended', async () => {
		const deps = makeDeps({ systemDefault: true, configOverrides: null });
		const svc = new ConversationService(deps);

		await run('bob', () => svc.handleMessage(ctx('bob', 'first message ever')));

		expect(deps._userStore.append).toHaveBeenCalled();
	});

	it('override OFF wins over system default ON → notes NOT appended', async () => {
		const deps = makeDeps({ systemDefault: true, configOverrides: { log_to_notes: false } });
		const svc = new ConversationService(deps);

		await run('carol', () => svc.handleMessage(ctx('carol', 'hi')));

		expect(deps._userStore.append).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Conversational toggle — <config-set> tag processing
// ---------------------------------------------------------------------------

describe('conversational toggle — <config-set> tag processing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('user "turn on daily notes please" + LLM emits tag → updateOverrides({ log_to_notes: true }), tag stripped', async () => {
		const deps = makeDeps({
			llmResponse: 'Sure! <config-set key="log_to_notes" value="true"/> Done.',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'hey can you turn on the daily notes thing')),
		);

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: true });
		const [[, sentText]] = deps._telegram.send.mock.calls as [[string, string]];
		expect(sentText).not.toContain('<config-set');
		expect(sentText).toContain('Daily notes logging turned ON');
	});

	it('bidirectional regex: "daily notes please turn on" → tag written', async () => {
		const deps = makeDeps({
			llmResponse: '<config-set key="log_to_notes" value="true"/>',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'daily notes please turn on')),
		);

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: true });
	});

	it('privacy phrasing: "please stop saving all my messages to daily notes" → updateOverrides({ log_to_notes: false })', async () => {
		const deps = makeDeps({
			llmResponse: 'No problem. <config-set key="log_to_notes" value="false"/>',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'please stop saving all my messages to daily notes')),
		);

		expect(deps._updateOverrides).toHaveBeenCalledWith('alice', { log_to_notes: false });
		const [[, sentText]] = deps._telegram.send.mock.calls as [[string, string]];
		expect(sentText).toContain('Daily notes logging turned OFF');
	});

	it('raw-overrides invariant: updateOverrides called with ONLY { log_to_notes: true } — manifest defaults not materialized', async () => {
		const deps = makeDeps({
			llmResponse: '<config-set key="log_to_notes" value="true"/>',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'turn on daily notes')),
		);

		expect(deps._updateOverrides).toHaveBeenCalledTimes(1);
		const [, arg] = deps._updateOverrides.mock.calls[0] as [string, Record<string, unknown>];
		// Must contain ONLY log_to_notes — no manifest defaults like auto_detect_pas
		expect(Object.keys(arg)).toEqual(['log_to_notes']);
		expect(arg.log_to_notes).toBe(true);
	});

	it('no-intent gate: LLM emits tag but user message lacks intent → tag stripped, no write', async () => {
		const deps = makeDeps({
			llmResponse: 'Paris is in France. <config-set key="log_to_notes" value="true"/>',
		});
		const svc = new ConversationService(deps);

		// "what's the weather?" does not match NOTES_INTENT_REGEX
		await run('alice', () =>
			svc.handleMessage(ctx('alice', "what's the weather in Paris?")),
		);

		expect(deps._updateOverrides).not.toHaveBeenCalled();
		const [[, sentText]] = deps._telegram.send.mock.calls as [[string, string]];
		expect(sentText).not.toContain('<config-set');
		expect(sentText).not.toContain('Daily notes');
	});

	it('adversarial allowlist: LLM tries to set a non-allowlisted key → NOT written, tag stripped', async () => {
		const deps = makeDeps({
			llmResponse: 'Sure. <config-set key="users[0].is_admin" value="true"/>',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'turn on daily notes')),
		);

		expect(deps._updateOverrides).not.toHaveBeenCalled();
		const calls = deps._telegram.send.mock.calls as [[string, string]][];
		const sentText = calls[0]?.[1] ?? '';
		expect(sentText).not.toContain('<config-set');
	});

	it('coerce reject: LLM emits bad value → NOT written, tag stripped', async () => {
		const deps = makeDeps({
			llmResponse: 'I will update it. <config-set key="log_to_notes" value="banana"/>',
		});
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'please turn on daily notes logging')),
		);

		expect(deps._updateOverrides).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// LLM error fidelity
// ---------------------------------------------------------------------------

describe('LLM error fidelity', () => {
	it('LLM throws, opted OUT (default) → reply does NOT mention "daily notes"', async () => {
		const deps = makeDeps();
		deps._llm.complete.mockRejectedValue(new Error('LLM down'));
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', "what's for dinner?")),
		);

		const [[, sentText]] = deps._telegram.send.mock.calls as [[string, string]];
		expect(sentText.toLowerCase()).not.toContain('daily notes');
	});

	it('LLM throws, opted IN → reply DOES mention "daily notes" (message was already saved)', async () => {
		const deps = makeDeps({ configOverrides: { log_to_notes: true } });
		deps._llm.complete.mockRejectedValue(new Error('LLM down'));
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'how many calories did I have yesterday?')),
		);

		const [[, sentText]] = deps._telegram.send.mock.calls as [[string, string]];
		expect(sentText.toLowerCase()).toContain('daily notes');
	});
});

// ---------------------------------------------------------------------------
// CONFIG_SET_INSTRUCTION_BLOCK injection
// ---------------------------------------------------------------------------

describe('CONFIG_SET_INSTRUCTION_BLOCK injection', () => {
	it('notes-intent user message → instruction injected into system prompt', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'turn on daily notes')),
		);

		const calls = deps._llm.complete.mock.calls as [[string, Record<string, unknown>]][];
		const systemPrompt = (calls[0]?.[1]?.systemPrompt ?? '') as string;
		expect(systemPrompt).toContain(CONFIG_SET_INSTRUCTION_BLOCK);
	});

	it('false-friend phrasing "take notes on this recipe" → instruction NOT injected', async () => {
		const deps = makeDeps();
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'take notes on this recipe')),
		);

		const calls = deps._llm.complete.mock.calls as [[string, Record<string, unknown>]][];
		const systemPrompt = (calls[0]?.[1]?.systemPrompt ?? '') as string;
		expect(systemPrompt).not.toContain(CONFIG_SET_INSTRUCTION_BLOCK);
	});

	it('auto_detect_pas:false (basic prompt path) still injects instruction when message has notes intent', async () => {
		const deps = makeDeps();
		// Explicitly mock getAll to return auto_detect_pas: false so basic prompt is chosen
		(deps.config as any).getAll.mockResolvedValue({ auto_detect_pas: false });
		const svc = new ConversationService(deps);

		await run('alice', () =>
			svc.handleMessage(ctx('alice', 'please turn off daily notes logging')),
		);

		const calls = deps._llm.complete.mock.calls as [[string, Record<string, unknown>]][];
		const systemPrompt = (calls[0]?.[1]?.systemPrompt ?? '') as string;
		expect(systemPrompt).toContain(CONFIG_SET_INSTRUCTION_BLOCK);
	});
});
