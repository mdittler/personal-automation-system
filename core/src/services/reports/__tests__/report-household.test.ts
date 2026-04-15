/**
 * Report cross-household guard tests.
 *
 * Verifies that:
 * - Two-household delivery recipients → run() returns null (logs refusal)
 * - One recipient with null household → run() returns null
 * - Single household + app_data section targeting user in other household → null
 * - Single household + app_data section with collab space and non-member delivery recipient → null
 * - Valid single-household report → runs normally and delivers
 * - safeValidateReport attaches _validationErrors badge for cross-household recipients
 */

import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextStoreService } from '../../../types/context-store.js';
import type { LLMService } from '../../../types/llm.js';
import type { ReportDefinition } from '../../../types/report.js';
import type { SpaceDefinition } from '../../../types/spaces.js';
import type { TelegramService } from '../../../types/telegram.js';
import { AppToggleStore } from '../../app-toggle/index.js';
import { ChangeLog } from '../../data-store/change-log.js';
import { CronManager } from '../../scheduler/cron-manager.js';
import { UserManager } from '../../user-manager/index.js';
import { ReportService, type ReportServiceOptions } from '../index.js';

const logger = pino({ level: 'silent' });

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-report-hh-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeTelegram(): TelegramService {
	return {
		send: vi.fn().mockResolvedValue(undefined),
		sendPhoto: vi.fn().mockResolvedValue(undefined),
		sendOptions: vi.fn().mockResolvedValue(''),
	} as unknown as TelegramService;
}

function makeContextStore(): ContextStoreService {
	return {
		get: vi.fn().mockResolvedValue(null),
		search: vi.fn().mockResolvedValue([]),
	};
}

function makeUserManager(userIds: string[] = ['u1', 'u2']): UserManager {
	return new UserManager({
		config: {
			users: userIds.map((id) => ({
				id,
				name: `User ${id}`,
				enabledApps: ['*'],
			})),
		} as any,
		appToggle: new AppToggleStore({ dataDir: tempDir, logger }),
		logger,
	});
}

function makeHouseholdService(map: Record<string, string | null>) {
	return {
		getHouseholdForUser(userId: string): string | null {
			return userId in map ? (map[userId] ?? null) : null;
		},
	};
}

function makeSpaceService(spaces: SpaceDefinition[]) {
	return {
		getSpace(id: string): SpaceDefinition | null {
			return spaces.find((s) => s.id === id) ?? null;
		},
	};
}

function makeService(overrides: Partial<ReportServiceOptions> = {}): {
	service: ReportService;
	telegram: TelegramService;
} {
	const telegram = makeTelegram();
	const cronManager = new CronManager(logger, 'UTC', tempDir);

	const service = new ReportService({
		dataDir: tempDir,
		changeLog: new ChangeLog(tempDir),
		contextStore: makeContextStore(),
		llm: {
			complete: vi.fn().mockResolvedValue('Summary'),
			classify: vi.fn(),
			extractStructured: vi.fn(),
		} as unknown as LLMService,
		telegram,
		userManager: makeUserManager(),
		cronManager,
		timezone: 'UTC',
		logger,
		...overrides,
	});

	return { service, telegram };
}

function makeReport(overrides: Partial<ReportDefinition> = {}): ReportDefinition {
	return {
		id: 'hh-report',
		name: 'HH Report',
		enabled: true,
		schedule: '0 9 * * 1',
		delivery: ['u1'],
		sections: [
			{
				type: 'custom',
				label: 'Note',
				config: { text: 'Hello' },
			},
		],
		llm: { enabled: false },
		...overrides,
	};
}

describe('ReportService — cross-household delivery guard', () => {
	it('refuses when delivery recipients span two households', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-b' });
		const { service, telegram } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1', 'u2'] });
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).toBeNull();
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('refuses when a delivery recipient has no household assigned', async () => {
		const householdService = makeHouseholdService({ u1: null });
		const { service, telegram } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1'] });
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).toBeNull();
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('single-household recipients → runs normally and delivers', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-a' });
		const { service, telegram } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1', 'u2'] });
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).not.toBeNull();
		expect(telegram.send).toHaveBeenCalledTimes(2); // one per recipient
	});

	it('refuses when app_data section user_id belongs to a different household', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-b' });
		const { service, telegram } = makeService({ householdService });

		const report = makeReport({
			delivery: ['u1'], // hh-a
			sections: [
				{
					type: 'app-data',
					label: 'Data',
					config: {
						app_id: 'food',
						user_id: 'u2', // hh-b — mismatch
						path: 'items.md',
					},
				},
			],
		});
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).toBeNull();
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('refuses when app_data section uses a household space from a different household', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a' });
		const spaceService = makeSpaceService([
			{
				id: 'family-space',
				name: 'Family',
				description: '',
				members: ['u1'],
				createdBy: 'u1',
				createdAt: '2026-01-01T00:00:00Z',
				kind: 'household',
				householdId: 'hh-b', // different household
			},
		]);
		const { service, telegram } = makeService({ householdService, spaceService });

		const report = makeReport({
			delivery: ['u1'],
			sections: [
				{
					type: 'app-data',
					label: 'Space Data',
					config: {
						app_id: 'food',
						space_id: 'family-space',
						path: 'items.md',
					},
				},
			],
		});
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).toBeNull();
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('refuses when collab space has delivery recipient who is not a member', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-a' });
		const spaceService = makeSpaceService([
			{
				id: 'book-club',
				name: 'Book Club',
				description: '',
				members: ['u1'], // u2 is NOT a member
				createdBy: 'u1',
				createdAt: '2026-01-01T00:00:00Z',
				kind: 'collaboration',
			},
		]);
		const { service, telegram } = makeService({ householdService, spaceService });

		const report = makeReport({
			delivery: ['u1', 'u2'],
			sections: [
				{
					type: 'app-data',
					label: 'Club Data',
					config: {
						app_id: 'notes',
						space_id: 'book-club',
						path: 'reading.md',
					},
				},
			],
		});
		await service.saveReport(report);

		const result = await service.run('hh-report');

		expect(result).toBeNull();
		expect(telegram.send).not.toHaveBeenCalled();
	});

	it('allows collab space when all delivery recipients are members', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-a' });
		const spaceService = makeSpaceService([
			{
				id: 'book-club',
				name: 'Book Club',
				description: '',
				members: ['u1', 'u2'], // both are members
				createdBy: 'u1',
				createdAt: '2026-01-01T00:00:00Z',
				kind: 'collaboration',
			},
		]);
		const { service, telegram } = makeService({ householdService, spaceService });

		const report = makeReport({
			delivery: ['u1', 'u2'],
			sections: [
				{
					type: 'app-data',
					label: 'Club Data',
					config: {
						app_id: 'notes',
						space_id: 'book-club',
						path: 'reading.md', // file won't exist, section will be empty but that's OK
					},
				},
			],
		});
		await service.saveReport(report);

		const result = await service.run('hh-report');

		// Should not be null — pre-flight passes (file just won't exist so section is empty)
		expect(result).not.toBeNull();
	});
});

describe('safeValidateReport — load-time cross-household warning', () => {
	it('attaches _validationErrors badge when recipients span multiple households', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-b' });
		const { service } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1', 'u2'] });
		await service.saveReport(report);

		const loaded = await service.getReport('hh-report');
		expect(loaded?._validationErrors).toBeDefined();
		expect(loaded?._validationErrors?.some((e) => e.field === 'delivery')).toBe(true);
	});

	it('attaches _validationErrors badge when a recipient has no household', async () => {
		const householdService = makeHouseholdService({ u1: null });
		const { service } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1'] });
		await service.saveReport(report);

		const loaded = await service.getReport('hh-report');
		expect(loaded?._validationErrors).toBeDefined();
		expect(loaded?._validationErrors?.some((e) => e.field === 'delivery')).toBe(true);
	});

	it('does NOT add _validationErrors when all recipients share a household', async () => {
		const householdService = makeHouseholdService({ u1: 'hh-a', u2: 'hh-a' });
		const { service } = makeService({ householdService });

		const report = makeReport({ delivery: ['u1', 'u2'] });
		await service.saveReport(report);

		const loaded = await service.getReport('hh-report');
		// No delivery errors (may still be undefined if no other errors)
		const deliveryErrors = loaded?._validationErrors?.filter((e) => e.field === 'delivery') ?? [];
		expect(deliveryErrors).toHaveLength(0);
	});
});
