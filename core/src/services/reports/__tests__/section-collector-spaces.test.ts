import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextStoreService } from '../../../types/context-store.js';
import type { ChangeLog } from '../../data-store/change-log.js';
import { type CollectorDeps, collectSection } from '../section-collector.js';

const logger = pino({ level: 'silent' });
const timezone = 'America/New_York';

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), 'pas-space-collector-'));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeChangeLog(logPath: string): ChangeLog {
	return { getLogPath: () => logPath } as ChangeLog;
}

function makeContextStore(): ContextStoreService {
	return {
		get: vi.fn().mockResolvedValue(null),
		search: vi.fn().mockResolvedValue([]),
	};
}

function makeDeps(overrides: Partial<CollectorDeps> = {}): CollectorDeps {
	return {
		changeLog: makeChangeLog(join(tempDir, 'change-log.jsonl')),
		dataDir: tempDir,
		contextStore: makeContextStore(),
		timezone,
		logger,
		...overrides,
	};
}

describe('collectSection — app-data with space_id', () => {
	it('reads from space directory when space_id is set', async () => {
		// Create space data file
		const spaceDir = join(tempDir, 'spaces', 'family', 'notes');
		await mkdir(spaceDir, { recursive: true });
		await writeFile(join(spaceDir, 'list.md'), 'Groceries:\n- Milk\n- Bread');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Family Notes',
				config: {
					app_id: 'notes',
					user_id: '123',
					path: 'list.md',
					space_id: 'family',
				},
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('Groceries');
		expect(result.content).toContain('Milk');
	});

	it('reads from user directory when space_id is not set (backward compat)', async () => {
		// Create user data file
		const userDir = join(tempDir, 'users', '123', 'notes');
		await mkdir(userDir, { recursive: true });
		await writeFile(join(userDir, 'list.md'), 'My personal notes');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'User Notes',
				config: {
					app_id: 'notes',
					user_id: '123',
					path: 'list.md',
				},
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('My personal notes');
	});

	it('returns file not found for missing space data file', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Missing',
				config: {
					app_id: 'notes',
					user_id: '123',
					path: 'nonexistent.md',
					space_id: 'family',
				},
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('File not found');
	});

	it('prevents path traversal in space data paths', async () => {
		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Traversal',
				config: {
					app_id: 'notes',
					user_id: '123',
					path: '../../../etc/passwd',
					space_id: 'family',
				},
			},
			deps,
		);

		expect(result.isEmpty).toBe(true);
		expect(result.content).toContain('Invalid path');
	});

	it('supports date tokens in space data paths', async () => {
		// Create today's file in space
		const now = new Date();
		const todayStr = new Intl.DateTimeFormat('en-CA', {
			timeZone: timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		})
			.formatToParts(now)
			.reduce((acc, p) => {
				if (p.type === 'year' || p.type === 'month' || p.type === 'day') {
					return acc + (acc && p.type !== 'year' ? '-' : '') + p.value;
				}
				return acc;
			}, '');

		const spaceDir = join(tempDir, 'spaces', 'family', 'notes', 'daily-notes');
		await mkdir(spaceDir, { recursive: true });
		await writeFile(join(spaceDir, `${todayStr}.md`), 'Today in family space');

		const deps = makeDeps();
		const result = await collectSection(
			{
				type: 'app-data',
				label: 'Today',
				config: {
					app_id: 'notes',
					user_id: '123',
					path: 'daily-notes/{today}.md',
					space_id: 'family',
				},
			},
			deps,
		);

		expect(result.isEmpty).toBe(false);
		expect(result.content).toContain('Today in family space');
	});
});
