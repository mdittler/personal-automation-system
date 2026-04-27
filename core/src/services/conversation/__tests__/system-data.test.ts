/**
 * System data helpers tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices, createMockScopedStore } from '../../../testing/mock-services.js';
import type { CoreServices } from '../../../types/app-module.js';
import { buildAppAwareSystemPrompt } from '../prompt-builder.js';
import { categorizeQuestion, gatherSystemData } from '../system-data.js';

describe('categorizeQuestion', () => {
	it('detects LLM/model questions', () => {
		expect(categorizeQuestion('what model am I using?')).toContain('llm');
		expect(categorizeQuestion('what providers are configured?')).toContain('llm');
		expect(categorizeQuestion('switch the fast model')).toContain('llm');
	});

	it('detects cost questions', () => {
		expect(categorizeQuestion('how much have I spent?')).toContain('costs');
		expect(categorizeQuestion('what is the monthly cost?')).toContain('costs');
		expect(categorizeQuestion('token usage this month')).toContain('costs');
	});

	it('detects scheduling questions', () => {
		expect(categorizeQuestion('what cron jobs are running?')).toContain('scheduling');
		expect(categorizeQuestion('what is scheduled?')).toContain('scheduling');
		expect(categorizeQuestion('what automated tasks are running').has('scheduling')).toBe(true);
	});

	it('detects system questions', () => {
		expect(categorizeQuestion('what is the uptime?')).toContain('system');
		expect(categorizeQuestion('what is my rate limit?')).toContain('system');
	});

	it('returns multiple categories for broad questions', () => {
		const cats = categorizeQuestion('what model am I using and how much has it cost?');
		expect(cats).toContain('llm');
		expect(cats).toContain('costs');
	});

	it('returns empty set for unrelated questions', () => {
		expect(categorizeQuestion('what is the weather?').size).toBe(0);
	});
});

describe('gatherSystemData', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('gathers LLM data for llm category', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
			{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['llm']),
			'what model?',
			undefined,
			true,
		);
		expect(data).toContain('standard: anthropic/claude-sonnet');
		expect(data).toContain('fast: anthropic/claude-haiku');
		expect(data).toContain('Configured providers');
	});

	it('gathers cost data for costs category', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-03',
			monthlyTotal: 5.1234,
			perApp: { chatbot: 3.0, notes: 2.1234 },
			perUser: { '123456789': 5.1234 },
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['costs']),
			'how much?',
			undefined,
			true,
		);
		expect(data).toContain('$5.1234');
		expect(data).toContain('chatbot');
		expect(data).toContain('notes');
		expect(data).toContain('123456789');
	});

	it('marks the current user in per-user cost breakdown', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-03',
			monthlyTotal: 10.0,
			perApp: {},
			perUser: { '123456789': 7.0, '987654321': 3.0 },
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['costs']),
			'how much?',
			'123456789',
			true,
		);
		expect(data).toContain('123456789 (this user): $7.0000');
		expect(data).toContain('987654321: $3.0000');
		expect(data).not.toContain('987654321 (this user)');
	});

	it('gathers scheduling data', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getScheduledJobs).mockReturnValue([
			{ key: 'system:daily-diff', appId: 'system', cron: '0 2 * * *', description: 'Daily diff' },
		]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['scheduling']),
			'what jobs?',
			undefined,
			true,
		);
		expect(data).toContain('system:daily-diff');
		expect(data).toContain('0 2 * * *');
	});

	it('gathers system status data', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getSystemStatus).mockReturnValue({
			uptimeSeconds: 3661,
			appCount: 3,
			userCount: 1,
			cronJobCount: 2,
			timezone: 'America/New_York',

		});
		vi.mocked(systemInfo.getSafeguardDefaults).mockReturnValue({
			rateLimit: { maxRequests: 60, windowSeconds: 3600 },
			appMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
		});

		const data = await gatherSystemData(systemInfo, new Set(['system']), 'status', undefined, true);
		expect(data).toContain('1h');
		expect(data).toContain('Apps loaded: 3');
		expect(data).toContain('Rate limit: 60');
	});

	it('includes available models when switching', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([]);
		vi.mocked(systemInfo.getAvailableModels).mockResolvedValue([
			{ id: 'claude-sonnet-4-20250514', provider: 'anthropic', displayName: 'Sonnet' },
		]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['llm']),
			'switch the model',
			undefined,
			true,
		);
		expect(data).toContain('Available models');
		expect(data).toContain('claude-sonnet-4-20250514');
	});

	it('non-admin: excludes other users costs', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-04',
			monthlyTotal: 12.0,
			perApp: { chatbot: 12.0 },
			perUser: { user1: 9.0, user2: 3.0 },
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['costs']),
			'how much?',
			'user1',
			false,
		);
		expect(data).toContain('user1');
		expect(data).not.toContain('user2');
	});

	it('non-admin: excludes cron job details', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getScheduledJobs).mockReturnValue([
			{ key: 'system:daily-diff', appId: 'system', cron: '0 2 * * *', description: 'Daily diff' },
		]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['scheduling']),
			'what jobs?',
			'user1',
			false,
		);
		expect(data).not.toContain('system:daily-diff');
		expect(data).not.toContain('0 2 * * *');
	});

	it('non-admin: excludes safeguard config and provider details', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]);
		vi.mocked(systemInfo.getSystemStatus).mockReturnValue({
			uptimeSeconds: 3661,
			appCount: 3,
			userCount: 2,
			cronJobCount: 2,
			timezone: 'UTC',

		});
		vi.mocked(systemInfo.getSafeguardDefaults).mockReturnValue({
			rateLimit: { maxRequests: 60, windowSeconds: 3600 },
			appMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
		});

		const data = await gatherSystemData(
			systemInfo,
			new Set(['system', 'llm']),
			'status',
			'user1',
			false,
		);
		// safeguard / rate limit info must be hidden from non-admins
		expect(data).not.toContain('Rate limit');
		expect(data).not.toContain('cost cap');
		// provider list must be hidden from non-admins
		expect(data).not.toContain('Configured providers');
		// tier assignments remain visible but without provider prefix for non-admins
		expect(data).toContain('fast: claude-haiku');
		expect(data).not.toContain('fast: anthropic/claude-haiku');
	});

	it('admin: shows full system data', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]);
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-04',
			monthlyTotal: 12.0,
			perApp: { chatbot: 12.0 },
			perUser: { user1: 9.0, user2: 3.0 },
		});
		vi.mocked(systemInfo.getScheduledJobs).mockReturnValue([
			{ key: 'system:daily-diff', appId: 'system', cron: '0 2 * * *', description: 'Daily diff' },
		]);
		vi.mocked(systemInfo.getSystemStatus).mockReturnValue({
			uptimeSeconds: 7200,
			appCount: 2,
			userCount: 2,
			cronJobCount: 1,
			timezone: 'UTC',

		});
		vi.mocked(systemInfo.getSafeguardDefaults).mockReturnValue({
			rateLimit: { maxRequests: 60, windowSeconds: 3600 },
			appMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
		});

		const data = await gatherSystemData(
			systemInfo,
			new Set(['llm', 'costs', 'scheduling', 'system']),
			'everything',
			'user1',
			true,
		);
		expect(data).toContain('Configured providers');
		expect(data).toContain('user2');
		expect(data).toContain('system:daily-diff');
		expect(data).toContain('Rate limit');
	});

	it('non-admin: shows own cost total', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-04',
			monthlyTotal: 12.0,
			perApp: { chatbot: 12.0 },
			perUser: { user1: 9.0, user2: 3.0 },
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);

		const data = await gatherSystemData(systemInfo, new Set(['costs']), 'my costs', 'user1', false);
		// Total is shown to everyone
		expect(data).toContain('$12.0000');
		// Own entry shown
		expect(data).toContain('user1');
	});

	it('non-admin with undefined userId shows only total cost', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-04',
			monthlyTotal: 5.5,
			perApp: { chatbot: 5.5 },
			perUser: { user1: 5.5 },
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([]);

		const data = await gatherSystemData(
			systemInfo,
			new Set(['costs']),
			'how much does this cost?',
			undefined,
			false,
		);
		// Total is always shown
		expect(data).toContain('$5.5000');
		// Per-user line must NOT appear (no userId to match, and non-admin skips full breakdown)
		expect(data).not.toContain('user1');
	});
});

describe('categorizeQuestion edge cases', () => {
	it('returns empty set for empty string', () => {
		expect(categorizeQuestion('').size).toBe(0);
	});

	it('handles very long input without error', () => {
		const longInput = 'what is the model '.repeat(1000);
		const cats = categorizeQuestion(longInput);
		expect(cats).toContain('llm');
	});
});

describe('gatherSystemData error isolation', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	it('returns partial data when getCostSummary throws', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getCostSummary).mockImplementation(() => {
			throw new Error('cost error');
		});
		vi.mocked(systemInfo.getScheduledJobs).mockReturnValue([
			{ key: 'app:job', appId: 'app', cron: '* * * * *' },
		]);

		const data = await gatherSystemData(
			systemInfo,
			new Set<'llm' | 'costs' | 'scheduling' | 'system'>(['costs', 'scheduling']),
			'costs and jobs',
			undefined,
			true,
		);
		// Scheduling data should still be present despite cost error
		expect(data).toContain('app:job');
		expect(data).not.toContain('Monthly costs');
	});

	it('returns partial data when getScheduledJobs throws', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getScheduledJobs).mockImplementation(() => {
			throw new Error('scheduler error');
		});
		vi.mocked(systemInfo.getSystemStatus).mockReturnValue({
			uptimeSeconds: 100,
			appCount: 1,
			userCount: 1,
			cronJobCount: 0,
			timezone: 'UTC',

		});
		vi.mocked(systemInfo.getSafeguardDefaults).mockReturnValue({
			rateLimit: { maxRequests: 60, windowSeconds: 3600 },
			appMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
		});

		const data = await gatherSystemData(
			systemInfo,
			new Set<'llm' | 'costs' | 'scheduling' | 'system'>(['scheduling', 'system']),
			'jobs and status',
		);
		// System data should still be present despite scheduler error
		expect(data).toContain('System status');
		expect(data).not.toContain('cron jobs');
	});

	it('returns partial data when getSystemStatus throws', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getSystemStatus).mockImplementation(() => {
			throw new Error('status error');
		});
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([]);

		const data = await gatherSystemData(
			systemInfo,
			new Set<'llm' | 'costs' | 'scheduling' | 'system'>(['llm', 'system']),
			'model and status',
		);
		// LLM data should still be present despite status error
		expect(data).toContain('Active model tiers');
		expect(data).not.toContain('System status');
	});

	it('returns partial data when getTierAssignments throws', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockImplementation(() => {
			throw new Error('tier error');
		});
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-03',
			monthlyTotal: 1.0,
			perApp: {},
			perUser: {},
		});

		const data = await gatherSystemData(
			systemInfo,
			new Set<'llm' | 'costs' | 'scheduling' | 'system'>(['llm', 'costs']),
			'model and costs',
		);
		// Cost data should still be present despite LLM error
		expect(data).toContain('Monthly costs');
		expect(data).not.toContain('Active model tiers');
	});

	it('gathers all four categories simultaneously', async () => {
		const systemInfo = services.systemInfo;
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'standard', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]);
		vi.mocked(systemInfo.getCostSummary).mockReturnValue({
			month: '2026-03',
			monthlyTotal: 5.0,
			perApp: { chatbot: 5.0 },
			perUser: {},
		});
		vi.mocked(systemInfo.getScheduledJobs).mockReturnValue([
			{ key: 'system:diff', appId: 'system', cron: '0 2 * * *', description: 'diff' },
		]);
		vi.mocked(systemInfo.getSystemStatus).mockReturnValue({
			uptimeSeconds: 7200,
			appCount: 2,
			userCount: 1,
			cronJobCount: 1,
			timezone: 'UTC',

		});
		vi.mocked(systemInfo.getSafeguardDefaults).mockReturnValue({
			rateLimit: { maxRequests: 60, windowSeconds: 3600 },
			appMonthlyCostCap: 10,
			globalMonthlyCostCap: 50,
		});

		const data = await gatherSystemData(
			systemInfo,
			new Set<'llm' | 'costs' | 'scheduling' | 'system'>(['llm', 'costs', 'scheduling', 'system']),
			'everything',
			undefined,
			true,
		);
		expect(data).toContain('Active model tiers');
		expect(data).toContain('Monthly costs');
		expect(data).toContain('system:diff');
		expect(data).toContain('System status');
	});
});

describe('categorizeQuestion — data category', () => {
	it('detects data-related questions', () => {
		expect(categorizeQuestion('what did i eat today?')).toContain('data');
		expect(categorizeQuestion('show my notes')).toContain('data');
		expect(categorizeQuestion('what data do I have?')).toContain('data');
	});

	it('detects food/fitness data keywords', () => {
		expect(categorizeQuestion('any recipes for chicken?')).toContain('data');
		expect(categorizeQuestion('my recent workout')).toContain('data');
		expect(categorizeQuestion('what meals did I plan?')).toContain('data');
		expect(categorizeQuestion('grocery list please')).toContain('data');
	});

	it('does not false-positive on unrelated questions', () => {
		expect(categorizeQuestion('what is the weather today?').has('data')).toBe(false);
		expect(categorizeQuestion('tell me a joke').has('data')).toBe(false);
	});

	it('can combine data with other categories', () => {
		const cats = categorizeQuestion('what data files changed recently and what did it cost?');
		expect(cats).toContain('data');
		expect(cats).toContain('costs');
	});
});

describe('data category — app-aware prompt integration', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
	});

	function makeDeps() {
		return {
			llm: services.llm,
			logger: services.logger,
			appMetadata: services.appMetadata,
			appKnowledge: services.appKnowledge,
			systemInfo: services.systemInfo,
			data: services.data,
			modelJournal: services.modelJournal,
		};
	}

	it('includes daily notes listing when data category is detected', async () => {
		const store = createMockScopedStore({
			list: vi.fn().mockResolvedValue(['2026-03-17.md', '2026-03-18.md', '2026-03-19.md']),
		});
		vi.mocked(services.data.forUser).mockReturnValue(store);
		vi.mocked(services.appMetadata.getInstalledApps).mockReturnValue([
			{
				id: 'notes',
				name: 'Notes',
				description: 'Note taking',
				version: '1.0.0',
				commands: [{ name: '/note', description: 'Save a note', args: [] }],
				intents: ['save note'],
				acceptsPhotos: false,
				hasSchedules: false,
				hasEvents: false,
			},
		]);

		const prompt = await buildAppAwareSystemPrompt(
			'what data do I have?',
			'user1',
			[],
			[],
			makeDeps(),
		);
		expect(prompt).toContain('daily-notes/2026-03-19.md');
		expect(prompt).toContain('Installed apps that may have data');
		expect(prompt).toContain('Notes (notes)');
	});

	it('handles no daily notes gracefully', async () => {
		const store = createMockScopedStore({
			list: vi.fn().mockRejectedValue(new Error('ENOENT')),
		});
		vi.mocked(services.data.forUser).mockReturnValue(store);
		vi.mocked(services.appMetadata.getInstalledApps).mockReturnValue([]);

		const prompt = await buildAppAwareSystemPrompt('show my files', 'user1', [], [], makeDeps());
		// Should not crash, should produce a valid prompt
		expect(prompt).toContain('PAS');
	});

	it('includes cross-app data note in overview', async () => {
		const store = createMockScopedStore({
			list: vi.fn().mockResolvedValue([]),
		});
		vi.mocked(services.data.forUser).mockReturnValue(store);
		vi.mocked(services.appMetadata.getInstalledApps).mockReturnValue([
			{
				id: 'food',
				name: 'Food Tracker',
				description: 'Track food',
				version: '1.0.0',
				commands: [{ name: '/log', description: 'Log meal', args: [] }],
				intents: [],
				acceptsPhotos: false,
				hasSchedules: false,
				hasEvents: false,
			},
		]);

		const prompt = await buildAppAwareSystemPrompt('what did I eat?', 'user1', [], [], makeDeps());
		expect(prompt).toContain('Use natural language to query your data');
	});
});

describe('gatherSystemData state transition', () => {
	it('reflects updated tier assignments after model switch', async () => {
		const services = createMockCoreServices();
		const systemInfo = services.systemInfo;

		// Before switch
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
		]);
		vi.mocked(systemInfo.getProviders).mockReturnValue([]);

		const before = await gatherSystemData(systemInfo, new Set(['llm']), 'what model?');
		expect(before).toContain('claude-haiku-4-5-20251001');

		// After switch — selector now returns different model
		vi.mocked(systemInfo.getTierAssignments).mockReturnValue([
			{ tier: 'fast', provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
		]);

		const after = await gatherSystemData(systemInfo, new Set(['llm']), 'what model?');
		expect(after).toContain('claude-sonnet-4-20250514');
		expect(after).not.toContain('claude-haiku-4-5-20251001');
	});
});
