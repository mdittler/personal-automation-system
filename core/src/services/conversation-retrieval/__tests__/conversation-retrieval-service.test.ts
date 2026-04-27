/**
 * Tests for ConversationRetrievalServiceImpl.
 *
 * Chunk A: construction, method existence, MissingRequestContextError guards,
 *          and "not implemented" stubs.
 * Chunk C: replaces "not implemented" tests with real delegation tests now that
 *          all methods are implemented. Adds tests for each individual reader,
 *          buildContextSnapshot orchestration, and "dep not wired" error paths.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AlertDefinition } from '../../../types/alert.js';
import type { KnowledgeEntry } from '../../../types/app-knowledge.js';
import type { AppInfo } from '../../../types/app-metadata.js';
import type { ContextEntry } from '../../../types/context-store.js';
import type { DataQueryResult } from '../../../types/data-query.js';
import type { ReportDefinition } from '../../../types/report.js';
import { requestContext } from '../../context/request-context.js';
import type { InteractionEntry } from '../../interaction-context/index.js';
import {
	ConversationRetrievalServiceImpl,
	MissingRequestContextError,
} from '../conversation-retrieval-service.js';
import { METHOD_SOURCE_CATEGORIES } from '../source-policy.js';

// ─── Helper ────────────────────────────────────────────────────────────────────

/** Run fn inside a fake requestContext with a stubbed userId. */
function withUserId<T>(userId: string, fn: () => T): T {
	return requestContext.run({ userId }, fn);
}

/** Run fn inside a fake requestContext with userId + householdId (required for DataQueryService). */
function withUserAndHousehold<T>(userId: string, householdId: string, fn: () => T): T {
	return requestContext.run({ userId, householdId }, fn);
}

/** Run fn inside a requestContext without userId (simulates system context). */
function withNoUserId<T>(fn: () => T): T {
	return requestContext.run({}, fn);
}

// ─── Construction ─────────────────────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl construction', () => {
	it('constructs successfully with an empty deps object', () => {
		expect(() => new ConversationRetrievalServiceImpl({})).not.toThrow();
	});

	it('constructs successfully with all deps provided (stubs)', () => {
		const stub = {} as never;
		expect(
			() =>
				new ConversationRetrievalServiceImpl({
					dataQuery: stub,
					contextStore: stub,
					interactionContext: stub,
					appMetadata: stub,
					appKnowledge: stub,
					systemInfo: stub,
					reportService: stub,
					alertService: stub,
					logger: stub,
				}),
		).not.toThrow();
	});
});

// ─── Method existence ──────────────────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl method existence', () => {
	const service = new ConversationRetrievalServiceImpl({});

	const methods = [
		'searchData',
		'listContextEntries',
		'getRecentInteractions',
		'getEnabledApps',
		'searchAppKnowledge',
		'buildSystemDataBlock',
		'listScopedReports',
		'listScopedAlerts',
		'buildContextSnapshot',
	] as const;

	for (const method of methods) {
		it(`${method} exists and is a function`, () => {
			expect(typeof service[method]).toBe('function');
		});
	}
});

// ─── METHOD_SOURCE_CATEGORIES contract ────────────────────────────────────────

describe('ConversationRetrievalServiceImpl — METHOD_SOURCE_CATEGORIES contract', () => {
	const service = new ConversationRetrievalServiceImpl({});

	for (const methodName of Object.keys(METHOD_SOURCE_CATEGORIES)) {
		it(`${methodName} exists on the service`, () => {
			expect(typeof (service as Record<string, unknown>)[methodName]).toBe('function');
		});
	}
});

// ─── Promise returns ──────────────────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl — every method returns a Promise', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData returns a Promise (rejected)', () => {
		const result = withUserId('user1', () => service.searchData({ question: 'test' }));
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listContextEntries returns a Promise', () => {
		const result = withUserId('user1', () => service.listContextEntries());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('getRecentInteractions returns a Promise', () => {
		const result = withUserId('user1', () => service.getRecentInteractions());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('getEnabledApps returns a Promise', () => {
		const result = withUserId('user1', () => service.getEnabledApps());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('searchAppKnowledge returns a Promise', () => {
		const result = withUserId('user1', () => service.searchAppKnowledge('test'));
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('buildSystemDataBlock returns a Promise', () => {
		const result = withUserId('user1', () =>
			service.buildSystemDataBlock({ question: 'test' }),
		);
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listScopedReports returns a Promise', () => {
		const result = withUserId('user1', () => service.listScopedReports());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('listScopedAlerts returns a Promise', () => {
		const result = withUserId('user1', () => service.listScopedAlerts());
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});

	it('buildContextSnapshot returns a Promise', () => {
		const result = withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'test',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(result).toBeInstanceOf(Promise);
		return result.catch(() => {});
	});
});

// ─── MissingRequestContextError ───────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl — MissingRequestContextError outside context', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.searchData({ question: 'test' }))).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('listContextEntries throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.listContextEntries())).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('getRecentInteractions throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.getRecentInteractions())).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('getEnabledApps throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.getEnabledApps())).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('searchAppKnowledge throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.searchAppKnowledge('test'))).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('buildSystemDataBlock throws MissingRequestContextError when no userId in context', async () => {
		await expect(
			withNoUserId(() => service.buildSystemDataBlock({ question: 'test' })),
		).rejects.toThrow(MissingRequestContextError);
	});

	it('listScopedReports throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.listScopedReports())).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('listScopedAlerts throws MissingRequestContextError when no userId in context', async () => {
		await expect(withNoUserId(() => service.listScopedAlerts())).rejects.toThrow(
			MissingRequestContextError,
		);
	});

	it('buildContextSnapshot throws MissingRequestContextError when no userId in context', async () => {
		await expect(
			withNoUserId(() =>
				service.buildContextSnapshot({
					question: 'test',
					mode: 'free-text',
					dataQueryCandidate: false,
					recentFilePaths: [],
				}),
			),
		).rejects.toThrow(MissingRequestContextError);
	});
});

// ─── "Dep not wired" error paths ──────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl — throws when dep not wired', () => {
	const service = new ConversationRetrievalServiceImpl({});

	it('searchData throws when dataQuery not wired', async () => {
		await expect(
			withUserId('user1', () => service.searchData({ question: 'test' })),
		).rejects.toThrow(/DataQueryService not wired/i);
	});

	it('listContextEntries throws when contextStore not wired', async () => {
		await expect(withUserId('user1', () => service.listContextEntries())).rejects.toThrow(
			/ContextStoreService not wired/i,
		);
	});

	it('getRecentInteractions throws when interactionContext not wired', async () => {
		await expect(withUserId('user1', () => service.getRecentInteractions())).rejects.toThrow(
			/InteractionContextService not wired/i,
		);
	});

	it('getEnabledApps throws when appMetadata not wired', async () => {
		await expect(withUserId('user1', () => service.getEnabledApps())).rejects.toThrow(
			/AppMetadataService not wired/i,
		);
	});

	it('searchAppKnowledge throws when appKnowledge not wired', async () => {
		await expect(withUserId('user1', () => service.searchAppKnowledge('test'))).rejects.toThrow(
			/AppKnowledgeBaseService not wired/i,
		);
	});

	it('buildSystemDataBlock throws when systemInfo not wired', async () => {
		await expect(
			withUserId('user1', () => service.buildSystemDataBlock({ question: 'test' })),
		).rejects.toThrow(/SystemInfoService not wired/i);
	});

	it('listScopedReports throws when reportService not wired', async () => {
		await expect(withUserId('user1', () => service.listScopedReports())).rejects.toThrow(
			/ReportService not wired/i,
		);
	});

	it('listScopedAlerts throws when alertService not wired', async () => {
		await expect(withUserId('user1', () => service.listScopedAlerts())).rejects.toThrow(
			/AlertService not wired/i,
		);
	});
});

// ─── Per-method delegation tests ──────────────────────────────────────────────

describe('ConversationRetrievalServiceImpl — searchData', () => {
	const mockResult: DataQueryResult = { files: [], empty: true };
	const mockDataQuery = {
		query: vi.fn().mockResolvedValue(mockResult),
	};

	it('delegates to dataQuery.query with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({ dataQuery: mockDataQuery });
		await withUserAndHousehold('user1', 'hh1', () => service.searchData({ question: 'test question' }));
		expect(mockDataQuery.query).toHaveBeenCalledWith('test question', 'user1', undefined);
	});

	it('returns the dataQuery result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({ dataQuery: mockDataQuery });
		const result = await withUserAndHousehold('user1', 'hh1', () =>
			service.searchData({ question: 'q' }),
		);
		expect(result).toBe(mockResult);
	});

	it('passes recentFilePaths as options when provided', async () => {
		const service = new ConversationRetrievalServiceImpl({ dataQuery: mockDataQuery });
		await withUserAndHousehold('user1', 'hh1', () =>
			service.searchData({ question: 'q', recentFilePaths: ['data/users/user1/food/r.md'] }),
		);
		expect(mockDataQuery.query).toHaveBeenCalledWith('q', 'user1', {
			recentFilePaths: ['data/users/user1/food/r.md'],
		});
	});

	it('does not pass options when recentFilePaths is empty', async () => {
		const service = new ConversationRetrievalServiceImpl({ dataQuery: mockDataQuery });
		await withUserAndHousehold('user1', 'hh1', () =>
			service.searchData({ question: 'q', recentFilePaths: [] }),
		);
		expect(mockDataQuery.query).toHaveBeenCalledWith('q', 'user1', undefined);
	});
});

describe('ConversationRetrievalServiceImpl — listContextEntries', () => {
	const mockEntries: ContextEntry[] = [
		{ key: 'food-prefs', content: 'I like pasta', lastUpdated: new Date() },
	];
	const mockContextStore = {
		listForUser: vi.fn().mockResolvedValue(mockEntries),
	};

	it('delegates to contextStore.listForUser with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({
			contextStore: mockContextStore as never,
		});
		await withUserId('user1', () => service.listContextEntries());
		expect(mockContextStore.listForUser).toHaveBeenCalledWith('user1');
	});

	it('returns contextStore result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({
			contextStore: mockContextStore as never,
		});
		const result = await withUserId('user1', () => service.listContextEntries());
		expect(result).toBe(mockEntries);
	});
});

describe('ConversationRetrievalServiceImpl — getRecentInteractions', () => {
	const mockEntries: InteractionEntry[] = [
		{ appId: 'food', action: 'capture-receipt', timestamp: Date.now() },
	];
	const mockInteractionContext = {
		getRecent: vi.fn().mockReturnValue(mockEntries),
	};

	it('delegates to interactionContext.getRecent with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({
			interactionContext: mockInteractionContext as never,
		});
		await withUserId('user1', () => service.getRecentInteractions());
		expect(mockInteractionContext.getRecent).toHaveBeenCalledWith('user1');
	});

	it('returns interactionContext result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({
			interactionContext: mockInteractionContext as never,
		});
		const result = await withUserId('user1', () => service.getRecentInteractions());
		expect(result).toBe(mockEntries);
	});
});

describe('ConversationRetrievalServiceImpl — getEnabledApps', () => {
	const mockApps: AppInfo[] = [
		{
			id: 'food',
			name: 'Food',
			description: 'Food management',
			version: '1.0.0',
			commands: [],
			intents: [],
			hasSchedules: false,
			hasEvents: false,
			acceptsPhotos: false,
		},
	];
	const mockAppMetadata = {
		getEnabledApps: vi.fn().mockResolvedValue(mockApps),
	};

	it('delegates to appMetadata.getEnabledApps with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({ appMetadata: mockAppMetadata as never });
		await withUserId('user1', () => service.getEnabledApps());
		expect(mockAppMetadata.getEnabledApps).toHaveBeenCalledWith('user1');
	});

	it('returns appMetadata result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({ appMetadata: mockAppMetadata as never });
		const result = await withUserId('user1', () => service.getEnabledApps());
		expect(result).toBe(mockApps);
	});
});

describe('ConversationRetrievalServiceImpl — searchAppKnowledge', () => {
	const mockEntries: KnowledgeEntry[] = [
		{ appId: 'food', source: 'help.md', content: 'Use /recipe to search recipes.' },
	];
	const mockAppKnowledge = {
		search: vi.fn().mockResolvedValue(mockEntries),
	};

	it('delegates to appKnowledge.search with query and userId', async () => {
		const service = new ConversationRetrievalServiceImpl({
			appKnowledge: mockAppKnowledge as never,
		});
		await withUserId('user1', () => service.searchAppKnowledge('how do I add a recipe?'));
		expect(mockAppKnowledge.search).toHaveBeenCalledWith('how do I add a recipe?', 'user1');
	});

	it('returns appKnowledge result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({
			appKnowledge: mockAppKnowledge as never,
		});
		const result = await withUserId('user1', () => service.searchAppKnowledge('q'));
		expect(result).toBe(mockEntries);
	});
});

describe('ConversationRetrievalServiceImpl — buildSystemDataBlock', () => {
	function makeSystemInfo(isAdmin: boolean) {
		return {
			getTierAssignments: vi
				.fn()
				.mockReturnValue([{ tier: 'fast', provider: 'anthropic', model: 'claude-haiku-4' }]),
			getProviders: vi.fn().mockReturnValue([{ id: 'anthropic', type: 'anthropic' }]),
			getAvailableModels: vi.fn().mockResolvedValue([]),
			getModelPricing: vi
				.fn()
				.mockReturnValue({ modelId: 'm', inputPerMillion: 1, outputPerMillion: 3 }),
			getCostSummary: vi.fn().mockReturnValue({
				month: '2026-04',
				monthlyTotal: 0.5,
				perApp: { chatbot: 0.5 },
				perUser: { user1: 0.5, admin1: 0.0 },
			}),
			getScheduledJobs: vi
				.fn()
				.mockReturnValue([{ key: 'daily-diff', appId: 'chatbot', cron: '0 9 * * *' }]),
			getSystemStatus: vi.fn().mockReturnValue({
				uptimeSeconds: 3600,
				appCount: 3,
				userCount: isAdmin ? 2 : undefined,
				cronJobCount: 1,
				timezone: 'UTC',
			}),
			getSafeguardDefaults: vi.fn().mockReturnValue({
				rateLimit: { maxRequests: 20, windowSeconds: 60 },
				appMonthlyCostCap: 5,
				globalMonthlyCostCap: 50,
			}),
			isUserAdmin: vi.fn().mockReturnValue(isAdmin),
		};
	}

	it('admin user: system question returns non-empty block', async () => {
		const systemInfo = makeSystemInfo(true);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });
		const result = await withUserId('admin1', () =>
			service.buildSystemDataBlock({ question: 'what is the system status?' }),
		);
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain('System status');
	});

	it('non-admin user: basic system info visible without admin sections', async () => {
		const systemInfo = makeSystemInfo(false);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });
		const result = await withUserId('user1', () =>
			service.buildSystemDataBlock({ question: 'what is the system status?' }),
		);
		// Non-admin sees system status section
		expect(result).toContain('System status');
		// Non-admin does NOT see per-user breakdown header or safeguard config
		expect(result).not.toContain('LLM safeguard defaults');
	});

	it('empty question returns empty string', async () => {
		const systemInfo = makeSystemInfo(false);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });
		const result = await withUserId('user1', () =>
			service.buildSystemDataBlock({ question: '' }),
		);
		expect(result).toBe('');
	});

	it('admin-only cost breakdown absent in non-admin output', async () => {
		const systemInfo = makeSystemInfo(false);
		const service = new ConversationRetrievalServiceImpl({ systemInfo: systemInfo as never });
		const result = await withUserId('user1', () =>
			service.buildSystemDataBlock({ question: 'how much has the system spent?' }),
		);
		// Non-admin doesn't see per-app breakdown header
		expect(result).not.toContain('Per app:');
		// Non-admin doesn't see per-user table (other users)
		expect(result).not.toContain('admin1');
	});
});

describe('ConversationRetrievalServiceImpl — listScopedReports', () => {
	const mockReports: ReportDefinition[] = [
		{
			id: 'r1',
			name: 'Daily',
			enabled: true,
			schedule: '0 9 * * 1',
			delivery: ['user1'],
			sections: [],
			llm: { enabled: false },
		},
	];
	const mockReportService = {
		listForUser: vi.fn().mockResolvedValue(mockReports),
	};

	it('delegates to reportService.listForUser with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({ reportService: mockReportService });
		await withUserId('user1', () => service.listScopedReports());
		expect(mockReportService.listForUser).toHaveBeenCalledWith('user1');
	});

	it('returns reportService result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({ reportService: mockReportService });
		const result = await withUserId('user1', () => service.listScopedReports());
		expect(result).toBe(mockReports);
	});
});

describe('ConversationRetrievalServiceImpl — listScopedAlerts', () => {
	const mockAlerts: AlertDefinition[] = [
		{
			id: 'a1',
			name: 'Low Stock',
			enabled: true,
			schedule: '0 * * * *',
			condition: { type: 'keyword', file_path: 'f', keyword: 'low' } as never,
			actions: [],
			delivery: ['user1'],
			cooldown: '1 hour',
		},
	];
	const mockAlertService = {
		listForUser: vi.fn().mockResolvedValue(mockAlerts),
	};

	it('delegates to alertService.listForUser with userId from requestContext', async () => {
		const service = new ConversationRetrievalServiceImpl({ alertService: mockAlertService });
		await withUserId('user1', () => service.listScopedAlerts());
		expect(mockAlertService.listForUser).toHaveBeenCalledWith('user1');
	});

	it('returns alertService result unchanged', async () => {
		const service = new ConversationRetrievalServiceImpl({ alertService: mockAlertService });
		const result = await withUserId('user1', () => service.listScopedAlerts());
		expect(result).toBe(mockAlerts);
	});
});

// ─── buildContextSnapshot orchestration ──────────────────────────────────────

describe('ConversationRetrievalServiceImpl — buildContextSnapshot', () => {
	function makeFullDeps() {
		return {
			dataQuery: { query: vi.fn().mockResolvedValue({ files: [], empty: true }) },
			contextStore: { listForUser: vi.fn().mockResolvedValue([]) },
			interactionContext: { getRecent: vi.fn().mockReturnValue([]) },
			appMetadata: { getEnabledApps: vi.fn().mockResolvedValue([]) },
			appKnowledge: { search: vi.fn().mockResolvedValue([]) },
			systemInfo: {
				getTierAssignments: vi.fn().mockReturnValue([]),
				getProviders: vi.fn().mockReturnValue([]),
				getAvailableModels: vi.fn().mockResolvedValue([]),
				getModelPricing: vi.fn().mockReturnValue(null),
				getCostSummary: vi
					.fn()
					.mockReturnValue({ month: '2026-04', monthlyTotal: 0, perApp: {}, perUser: {} }),
				getScheduledJobs: vi.fn().mockReturnValue([]),
				getSystemStatus: vi.fn().mockReturnValue({
					uptimeSeconds: 0,
					appCount: 0,
					userCount: 0,
					cronJobCount: 0,
					timezone: 'UTC',
				}),
				getSafeguardDefaults: vi.fn().mockReturnValue({
					rateLimit: { maxRequests: 20, windowSeconds: 60 },
					appMonthlyCostCap: 5,
					globalMonthlyCostCap: 50,
				}),
				isUserAdmin: vi.fn().mockReturnValue(false),
			},
			reportService: { listForUser: vi.fn().mockResolvedValue([]) },
			alertService: { listForUser: vi.fn().mockResolvedValue([]) },
		};
	}

	it('free-text with no keywords: only 3 cheap readers called', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		const snapshot = await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(snapshot.failures).toEqual([]);
		expect(deps.contextStore.listForUser).toHaveBeenCalledWith('user1');
		expect(deps.interactionContext.getRecent).toHaveBeenCalledWith('user1');
		expect(deps.appMetadata.getEnabledApps).toHaveBeenCalledWith('user1');
		// DataQuery, reports, alerts not called for plain free-text
		expect(deps.dataQuery.query).not.toHaveBeenCalled();
		expect(deps.reportService.listForUser).not.toHaveBeenCalled();
		expect(deps.alertService.listForUser).not.toHaveBeenCalled();
	});

	it('dataQueryCandidate: true causes DataQueryService to be called', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserAndHousehold('user1', 'hh1', () =>
			service.buildContextSnapshot({
				question: 'what are my recent groceries?',
				mode: 'free-text',
				dataQueryCandidate: true,
				recentFilePaths: [],
			}),
		);
		expect(deps.dataQuery.query).toHaveBeenCalledTimes(1);
		expect(deps.dataQuery.query).toHaveBeenCalledWith(
			'what are my recent groceries?',
			'user1',
			undefined,
		);
	});

	it('recentFilePaths forwarded to DataQueryService', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserAndHousehold('user1', 'hh1', () =>
			service.buildContextSnapshot({
				question: 'show me my data',
				mode: 'free-text',
				dataQueryCandidate: true,
				recentFilePaths: ['data/users/user1/food/r.md'],
			}),
		);
		expect(deps.dataQuery.query).toHaveBeenCalledWith('show me my data', 'user1', {
			recentFilePaths: ['data/users/user1/food/r.md'],
		});
	});

	it('missing householdId with dataQueryCandidate: true pushes data-query categories to failures', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		// withUserId sets userId but NOT householdId — fail-closed guard triggers
		const snapshot = await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'show my recipes',
				mode: 'free-text',
				dataQueryCandidate: true,
				recentFilePaths: [],
			}),
		);
		expect(deps.dataQuery.query).not.toHaveBeenCalled();
		const dataQueryFails = snapshot.failures.filter((f) =>
			['user-app-data', 'household-shared-data', 'space-data', 'collaboration-data'].includes(f),
		);
		expect(dataQueryFails.length).toBeGreaterThan(0);
	});

	it('ask mode always includes app-knowledge and system-info, but not reports/alerts for plain questions', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'ask',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(deps.appKnowledge.search).toHaveBeenCalled();
		// reports/alerts NOT added by ask mode alone — requires scheduling keyword or explicit mention
		expect(deps.reportService.listForUser).not.toHaveBeenCalled();
		expect(deps.alertService.listForUser).not.toHaveBeenCalled();
		// In ask mode, system-info is selected even for questions without system keywords.
		// buildSystemDataBlock IS called, but gatherSystemData returns '' for 'hello'
		// (no matching categories), so getSystemStatus is never invoked.
		expect(deps.systemInfo.getSystemStatus).not.toHaveBeenCalled(); // no system keywords → no system category
	});

	it('one category throws: failures includes that category; others still present', async () => {
		const deps = makeFullDeps();
		deps.contextStore.listForUser.mockRejectedValue(new Error('DB error'));
		const service = new ConversationRetrievalServiceImpl(deps as never);
		const snapshot = await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(snapshot.failures).toContain('context-store');
		// Other readers still populated (returned empty arrays)
		expect(snapshot.interactionContext).toBeDefined();
		expect(snapshot.enabledApps).toBeDefined();
	});

	it('include override force-off removes a normally-selected category', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
				include: { 'context-store': false },
			}),
		);
		// context-store deselected — listForUser not called
		expect(deps.contextStore.listForUser).not.toHaveBeenCalled();
	});

	it('include override force-on adds a normally-unselected category', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
				include: { reports: true },
			}),
		);
		expect(deps.reportService.listForUser).toHaveBeenCalled();
	});

	it('does not call DataQueryService when dataQueryCandidate is false even with data keywords in question', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'show my grocery list',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(deps.dataQuery.query).not.toHaveBeenCalled();
	});

	it('snapshot always has a failures array (even on full success)', async () => {
		const deps = makeFullDeps();
		const service = new ConversationRetrievalServiceImpl(deps as never);
		const snapshot = await withUserId('user1', () =>
			service.buildContextSnapshot({
				question: 'hello',
				mode: 'free-text',
				dataQueryCandidate: false,
				recentFilePaths: [],
			}),
		);
		expect(Array.isArray(snapshot.failures)).toBe(true);
	});

	it('two parallel calls for different users do not cross-contaminate', async () => {
		const deps1 = makeFullDeps();
		const deps2 = makeFullDeps();

		// User1's context store returns specific data
		const user1Entries: ContextEntry[] = [
			{ key: 'u1-key', content: 'user1 content', lastUpdated: new Date() },
		];
		const user2Entries: ContextEntry[] = [
			{ key: 'u2-key', content: 'user2 content', lastUpdated: new Date() },
		];
		deps1.contextStore.listForUser.mockResolvedValue(user1Entries);
		deps2.contextStore.listForUser.mockResolvedValue(user2Entries);

		const service1 = new ConversationRetrievalServiceImpl(deps1 as never);
		const service2 = new ConversationRetrievalServiceImpl(deps2 as never);

		const [snap1, snap2] = await Promise.all([
			requestContext.run({ userId: 'user1' }, () =>
				service1.buildContextSnapshot({
					question: 'hello',
					mode: 'free-text',
					dataQueryCandidate: false,
					recentFilePaths: [],
				}),
			),
			requestContext.run({ userId: 'user2' }, () =>
				service2.buildContextSnapshot({
					question: 'hello',
					mode: 'free-text',
					dataQueryCandidate: false,
					recentFilePaths: [],
				}),
			),
		]);

		// Each user's snapshot has the correct entries (not mixed)
		expect(snap1.contextStore?.[0]?.key).toBe('u1-key');
		expect(snap2.contextStore?.[0]?.key).toBe('u2-key');
		// Ensure they didn't receive each other's data
		expect(snap1.contextStore).not.toStrictEqual(user2Entries);
		expect(snap2.contextStore).not.toStrictEqual(user1Entries);
	});
});
