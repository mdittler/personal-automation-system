import { describe, expect, it, vi } from 'vitest';
import { handleBudgetCommand, isBudgetViewIntent } from '../handlers/budget.js';
import type { CoreServices } from '@pas/core/types';

function createMockStore(overrides: Record<string, unknown> = {}) {
	return {
		read: vi.fn().mockResolvedValue(''),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		list: vi.fn().mockResolvedValue([]),
		archive: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function createMockServices(): CoreServices {
	return {
		llm: { complete: vi.fn().mockResolvedValue('[]') },
		telegram: { send: vi.fn().mockResolvedValue(undefined), sendWithButtons: vi.fn().mockResolvedValue(undefined) },
		data: { forShared: vi.fn().mockReturnValue(createMockStore()) },
		config: { get: vi.fn().mockResolvedValue(null) },
		logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
		timezone: 'America/New_York',
	} as unknown as CoreServices;
}

describe('budget-handler', () => {
	describe('isBudgetViewIntent', () => {
		it('detects "how much did we spend on food"', () => { expect(isBudgetViewIntent('how much did we spend on food')).toBe(true); });
		it('detects "food budget"', () => { expect(isBudgetViewIntent('food budget')).toBe(true); });
		it('detects "what did we spend this week"', () => { expect(isBudgetViewIntent('what did we spend this week')).toBe(true); });
		it('detects "show food costs"', () => { expect(isBudgetViewIntent('show food costs')).toBe(true); });
		it('rejects "add eggs to grocery list"', () => { expect(isBudgetViewIntent('add eggs to grocery list')).toBe(false); });
		it('rejects unrelated messages with food keywords', () => {
			expect(isBudgetViewIntent('make me a meal plan for this week')).toBe(false);
			expect(isBudgetViewIntent('what food should I buy')).toBe(false);
		});
		it('rejects price update messages', () => {
			expect(isBudgetViewIntent('eggs are $3.50 at costco')).toBe(false);
		});
	});

	describe('handleBudgetCommand', () => {
		it('shows weekly report by default', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, [], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
			const [, msg] = vi.mocked(svc.telegram.send).mock.calls[0]!;
			expect(
				(msg as string).includes('Food Budget') || (msg as string).includes('No active meal plan'),
			).toBe(true);
		});
		it('shows monthly report for "month" arg', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, ['month'], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
		});
		it('shows yearly report for "year" arg', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, ['year'], 'user1', store as never);
			expect(svc.telegram.send).toHaveBeenCalledOnce();
		});
		it('handles no data gracefully', async () => {
			const svc = createMockServices();
			const store = createMockStore();
			await handleBudgetCommand(svc, [], 'user1', store as never);
			const [, msg] = vi.mocked(svc.telegram.send).mock.calls[0]!;
			expect(typeof msg).toBe('string');
		});
		it('handles /foodbudget with invalid subcommand gracefully', async () => {
			const svc = createMockServices();
			const store = createMockStore({ read: vi.fn().mockResolvedValue(null) });
			await handleBudgetCommand(svc, ['invalid'], 'user1', store as never);
			// Should fall through to weekly default since 'invalid' !== 'month' or 'year'
			expect(svc.telegram.send).toHaveBeenCalled();
		});
	});
});
