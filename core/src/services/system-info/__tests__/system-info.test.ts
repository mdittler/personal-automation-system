import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { LLMSafeguardsConfig } from '../../../types/config.js';
import type { LLMProviderClient } from '../../../types/llm.js';
import type { AppRegistry } from '../../app-registry/index.js';
import type { CostTracker } from '../../llm/cost-tracker.js';
import type { ModelCatalog } from '../../llm/model-catalog.js';
import type { ModelSelector } from '../../llm/model-selector.js';
import type { ProviderRegistry } from '../../llm/providers/provider-registry.js';
import type { CronManager } from '../../scheduler/cron-manager.js';
import type { UserManager } from '../../user-manager/index.js';
import { SystemInfoServiceImpl } from '../index.js';

function createMockDeps(overrides?: Record<string, unknown>) {
	const modelSelector = {
		getStandardRef: vi
			.fn()
			.mockReturnValue({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
		getFastRef: vi
			.fn()
			.mockReturnValue({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }),
		getReasoningRef: vi.fn().mockReturnValue(undefined),
		setStandardRef: vi.fn().mockResolvedValue(undefined),
		setFastRef: vi.fn().mockResolvedValue(undefined),
		setReasoningRef: vi.fn().mockResolvedValue(undefined),
	} as unknown as ModelSelector;

	const providerRegistry = {
		getAll: vi
			.fn()
			.mockReturnValue([
				{ providerId: 'anthropic', providerType: 'anthropic' } as LLMProviderClient,
			]),
		getProviderIds: vi.fn().mockReturnValue(['anthropic']),
		has: vi.fn().mockImplementation((id: string) => id === 'anthropic'),
	} as unknown as ProviderRegistry;

	const modelCatalog = {
		getModels: vi.fn().mockResolvedValue([
			{ id: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4', provider: 'anthropic' },
			{ id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', provider: 'anthropic' },
		]),
	} as unknown as ModelCatalog;

	const costTracker = {
		getMonthlyTotalCost: vi.fn().mockReturnValue(5.1234),
		getMonthlyAppCosts: vi.fn().mockReturnValue(
			new Map([
				['chatbot', 3.0],
				['notes', 2.1234],
			]),
		),
		getMonthlyUserCosts: vi.fn().mockReturnValue(new Map([['123456789', 5.1234]])),
	} as unknown as CostTracker;

	const cronManager = {
		getJobDetails: vi.fn().mockReturnValue([
			{
				key: 'system:daily-diff',
				job: { appId: 'system', cron: '0 2 * * *', description: 'Daily diff report' },
			},
		]),
		getRegisteredJobs: vi.fn().mockReturnValue(['system:daily-diff']),
	} as unknown as CronManager;

	const userManager = {
		getAllUsers: vi.fn().mockReturnValue([{ id: '123', name: 'Admin' }]),
	} as unknown as UserManager;

	const appRegistry = {
		getLoadedAppIds: vi.fn().mockReturnValue(['echo', 'chatbot']),
	} as unknown as AppRegistry;

	const safeguards: LLMSafeguardsConfig = {
		defaultRateLimit: { maxRequests: 60, windowSeconds: 3600 },
		defaultMonthlyCostCap: 10.0,
		globalMonthlyCostCap: 50.0,
	};

	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	};

	return {
		modelSelector,
		providerRegistry,
		modelCatalog,
		costTracker,
		cronManager,
		userManager,
		appRegistry,
		safeguards,
		timezone: 'America/New_York',
		fallbackMode: 'chatbot',
		logger: logger as unknown as Logger,
		...overrides,
	};
}

describe('SystemInfoServiceImpl', () => {
	describe('getTierAssignments', () => {
		it('returns standard and fast tiers', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const tiers = svc.getTierAssignments();
			expect(tiers).toHaveLength(2);
			expect(tiers[0]).toEqual({
				tier: 'standard',
				provider: 'anthropic',
				model: 'claude-sonnet-4-20250514',
			});
			expect(tiers[1]).toEqual({
				tier: 'fast',
				provider: 'anthropic',
				model: 'claude-haiku-4-5-20251001',
			});
		});

		it('includes reasoning tier when configured', () => {
			const deps = createMockDeps();
			(deps.modelSelector.getReasoningRef as ReturnType<typeof vi.fn>).mockReturnValue({
				provider: 'anthropic',
				model: 'claude-opus-4-20250514',
			});
			const svc = new SystemInfoServiceImpl(deps);
			const tiers = svc.getTierAssignments();
			expect(tiers).toHaveLength(3);
			expect(tiers[2].tier).toBe('reasoning');
		});
	});

	describe('getProviders', () => {
		it('returns provider info from registry', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const providers = svc.getProviders();
			expect(providers).toHaveLength(1);
			expect(providers[0]).toEqual({ id: 'anthropic', type: 'anthropic' });
		});

		it('returns empty array when no providers registered', () => {
			const deps = createMockDeps();
			(deps.providerRegistry.getAll as ReturnType<typeof vi.fn>).mockReturnValue([]);
			const svc = new SystemInfoServiceImpl(deps);
			expect(svc.getProviders()).toEqual([]);
		});
	});

	describe('getAvailableModels', () => {
		it('returns models from catalog', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const models = await svc.getAvailableModels();
			expect(models).toHaveLength(2);
			expect(models[0]).toEqual({
				id: 'claude-sonnet-4-20250514',
				provider: 'anthropic',
				displayName: 'Claude Sonnet 4',
			});
		});

		it('returns empty array on catalog failure', async () => {
			const deps = createMockDeps();
			(deps.modelCatalog.getModels as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('API error'),
			);
			const svc = new SystemInfoServiceImpl(deps);
			const models = await svc.getAvailableModels();
			expect(models).toEqual([]);
		});
	});

	describe('getModelPricing', () => {
		it('returns pricing for known model', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			// claude-sonnet-4-20250514 is in the pricing table
			const pricing = svc.getModelPricing('claude-sonnet-4-20250514');
			expect(pricing).not.toBeNull();
			expect(pricing?.modelId).toBe('claude-sonnet-4-20250514');
			expect(pricing?.inputPerMillion).toBeGreaterThan(0);
			expect(pricing?.outputPerMillion).toBeGreaterThan(0);
		});

		it('returns null for unknown model', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const pricing = svc.getModelPricing('unknown-model-xyz');
			expect(pricing).toBeNull();
		});
	});

	describe('getCostSummary', () => {
		it('returns monthly costs from cost tracker', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const summary = svc.getCostSummary();
			expect(summary.monthlyTotal).toBe(5.1234);
			expect(summary.perApp).toEqual({ chatbot: 3.0, notes: 2.1234 });
			expect(summary.perUser).toEqual({ '123456789': 5.1234 });
			expect(summary.month).toMatch(/^\d{4}-\d{2}$/);
		});

		it('handles empty cost data', () => {
			const deps = createMockDeps();
			(deps.costTracker.getMonthlyTotalCost as ReturnType<typeof vi.fn>).mockReturnValue(0);
			(deps.costTracker.getMonthlyAppCosts as ReturnType<typeof vi.fn>).mockReturnValue(new Map());
			(deps.costTracker.getMonthlyUserCosts as ReturnType<typeof vi.fn>).mockReturnValue(new Map());
			const svc = new SystemInfoServiceImpl(deps);
			const summary = svc.getCostSummary();
			expect(summary.monthlyTotal).toBe(0);
			expect(summary.perApp).toEqual({});
			expect(summary.perUser).toEqual({});
		});
	});

	describe('getScheduledJobs', () => {
		it('returns job details from cron manager', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const jobs = svc.getScheduledJobs();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toEqual({
				key: 'system:daily-diff',
				appId: 'system',
				cron: '0 2 * * *',
				description: 'Daily diff report',
			});
		});

		it('returns empty array when no jobs', () => {
			const deps = createMockDeps();
			(deps.cronManager.getJobDetails as ReturnType<typeof vi.fn>).mockReturnValue([]);
			const svc = new SystemInfoServiceImpl(deps);
			expect(svc.getScheduledJobs()).toEqual([]);
		});
	});

	describe('getSystemStatus', () => {
		it('returns system status', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const status = svc.getSystemStatus();
			expect(status.appCount).toBe(2);
			expect(status.userCount).toBe(1);
			expect(status.cronJobCount).toBe(1);
			expect(status.timezone).toBe('America/New_York');
			expect(status.fallbackMode).toBe('chatbot');
			expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
		});
	});

	describe('getSafeguardDefaults', () => {
		it('returns safeguard config', () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const defaults = svc.getSafeguardDefaults();
			expect(defaults).toEqual({
				rateLimit: { maxRequests: 60, windowSeconds: 3600 },
				appMonthlyCostCap: 10.0,
				globalMonthlyCostCap: 50.0,
			});
		});
	});

	describe('setTierModel', () => {
		it('switches standard tier model', async () => {
			const deps = createMockDeps();
			const svc = new SystemInfoServiceImpl(deps);
			const result = await svc.setTierModel('standard', 'anthropic', 'claude-opus-4-20250514');
			expect(result).toEqual({ success: true });
			expect(deps.modelSelector.setStandardRef).toHaveBeenCalledWith({
				provider: 'anthropic',
				model: 'claude-opus-4-20250514',
			});
		});

		it('switches fast tier model', async () => {
			const deps = createMockDeps();
			const svc = new SystemInfoServiceImpl(deps);
			const result = await svc.setTierModel('fast', 'anthropic', 'claude-haiku-4-5-20251001');
			expect(result).toEqual({ success: true });
			expect(deps.modelSelector.setFastRef).toHaveBeenCalledWith({
				provider: 'anthropic',
				model: 'claude-haiku-4-5-20251001',
			});
		});

		it('switches reasoning tier model', async () => {
			const deps = createMockDeps();
			const svc = new SystemInfoServiceImpl(deps);
			const result = await svc.setTierModel('reasoning', 'anthropic', 'claude-opus-4-20250514');
			expect(result).toEqual({ success: true });
			expect(deps.modelSelector.setReasoningRef).toHaveBeenCalled();
		});

		it('rejects invalid tier', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const result = await svc.setTierModel('invalid', 'anthropic', 'some-model');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid tier');
		});

		it('rejects non-existent provider', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const result = await svc.setTierModel('fast', 'openai', 'gpt-4o');
			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
			expect(result.error).toContain('anthropic'); // lists available
		});

		it('rejects invalid model ID pattern', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const result = await svc.setTierModel('fast', 'anthropic', 'model with spaces');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid model ID');
		});

		it('rejects empty model ID', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const result = await svc.setTierModel('fast', 'anthropic', '');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid model ID');
		});

		it('rejects model ID with path traversal', async () => {
			const svc = new SystemInfoServiceImpl(createMockDeps());
			const result = await svc.setTierModel('fast', 'anthropic', '../../../etc/passwd');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid model ID');
		});

		it('handles selector save failure', async () => {
			const deps = createMockDeps();
			(deps.modelSelector.setStandardRef as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Write failed'),
			);
			const svc = new SystemInfoServiceImpl(deps);
			const result = await svc.setTierModel('standard', 'anthropic', 'some-model');
			expect(result.success).toBe(false);
			expect(result.error).toContain('Write failed');
		});
	});

	describe('isUserAdmin', () => {
		it('returns true for admin user', () => {
			const deps = createMockDeps();
			(deps.userManager.getUser as ReturnType<typeof vi.fn>) = vi
				.fn()
				.mockReturnValue({ id: '123', name: 'Admin', isAdmin: true });
			const svc = new SystemInfoServiceImpl(deps);
			expect(svc.isUserAdmin('123')).toBe(true);
		});

		it('returns false for non-admin user', () => {
			const deps = createMockDeps();
			(deps.userManager.getUser as ReturnType<typeof vi.fn>) = vi
				.fn()
				.mockReturnValue({ id: '456', name: 'Regular', isAdmin: false });
			const svc = new SystemInfoServiceImpl(deps);
			expect(svc.isUserAdmin('456')).toBe(false);
		});

		it('returns false for unknown userId', () => {
			const deps = createMockDeps();
			(deps.userManager.getUser as ReturnType<typeof vi.fn>) = vi
				.fn()
				.mockReturnValue(undefined);
			const svc = new SystemInfoServiceImpl(deps);
			expect(svc.isUserAdmin('nonexistent')).toBe(false);
		});
	});
});
