import { describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import type { ConversationTurn } from '../../conversation-history/index.js';
import { buildAppAwareSystemPrompt, buildSystemPrompt } from '../prompt-builder.js';

function makeDeps(overrides?: object) {
	const services = createMockCoreServices();
	return {
		llm: services.llm,
		logger: services.logger,
		...overrides,
	};
}

describe('buildSystemPrompt', () => {
	it('returns a non-empty string containing model identity text', async () => {
		const deps = makeDeps();
		vi.mocked(deps.llm.getModelForTier).mockReturnValue('anthropic/claude-sonnet');
		const result = await buildSystemPrompt([], [], deps);
		expect(typeof result).toBe('string');
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('anthropic/claude-sonnet');
	});

	it('includes context entries in the prompt', async () => {
		const deps = makeDeps();
		const result = await buildSystemPrompt(['Entry A', 'Entry B'], [], deps);
		expect(result).toContain('Entry A');
		expect(result).toContain('Entry B');
	});

	it('includes conversation turns in the prompt', async () => {
		const deps = makeDeps();
		const turns: ConversationTurn[] = [
			{ role: 'user', content: 'hello there', timestamp: '2026-01-01T00:00:00Z' },
			{ role: 'assistant', content: 'hi back', timestamp: '2026-01-01T00:00:01Z' },
		];
		const result = await buildSystemPrompt([], turns, deps);
		expect(result).toContain('hello there');
		expect(result).toContain('hi back');
	});

	it('includes user context when provided', async () => {
		const deps = makeDeps();
		const result = await buildSystemPrompt([], [], deps, undefined, 'custom user context');
		expect(result).toContain('custom user context');
	});
});

describe('buildAppAwareSystemPrompt', () => {
	it('contains PAS-related framing', async () => {
		const deps = makeDeps();
		const result = await buildAppAwareSystemPrompt('what apps do I have?', 'user-0', [], [], deps);
		expect(result).toContain('PAS');
	});

	it('includes data context when provided', async () => {
		const deps = makeDeps();
		const result = await buildAppAwareSystemPrompt(
			'show my notes',
			'user-0',
			[],
			[],
			deps,
			undefined,
			undefined,
			'relevant file content here',
		);
		expect(result).toContain('relevant file content here');
	});

	it('suppresses LLM pricing sections when data context present and no AI keywords in question', async () => {
		const deps = makeDeps();
		vi.mocked(deps.llm.getModelForTier).mockReturnValue('anthropic/claude-sonnet');
		// Provide a systemInfo that would normally emit llm/costs sections
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(false);
		const depsWithSys = { ...deps, systemInfo: services.systemInfo };

		const result = await buildAppAwareSystemPrompt(
			'show my grocery list',
			'user-0',
			[],
			[],
			depsWithSys,
			undefined,
			undefined,
			'grocery list content',
		);
		// The S4 guard should not add model-switch instruction for a non-AI question
		expect(result).not.toContain('switch-model tier=');
	});

	it('includes context store entries when provided', async () => {
		const deps = makeDeps();
		const result = await buildAppAwareSystemPrompt(
			'what is my preference?',
			'user-0',
			['preference: dark mode'],
			[],
			deps,
		);
		expect(result).toContain('preference: dark mode');
	});

	it('includes user context when provided', async () => {
		const deps = makeDeps();
		const result = await buildAppAwareSystemPrompt(
			'hello',
			'user-0',
			[],
			[],
			deps,
			undefined,
			'user has premium plan',
		);
		expect(result).toContain('user has premium plan');
	});
});
