import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countAlertFiringsByDay } from '../alert-history-stats.js';

describe('countAlertFiringsByDay', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-alert-history-'));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function seedHistoryFile(alertId: string, filename: string, content = 'fired\n') {
		const dir = join(tempDir, 'system', 'alert-history', alertId);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, filename), content, 'utf-8');
	}

	// Filenames follow the real convention written by AlertService.saveToHistory
	// (core/src/services/alerts/index.ts:668-670): `${YYYY-MM-DD}_${HH-mm-ss-SSS}.md`.
	it('counts history files by day across all alert ids', async () => {
		await seedHistoryFile('alert-a', '2026-07-01_12-00-00-000.md');
		await seedHistoryFile('alert-a', '2026-07-01_18-00-00-000.md');
		await seedHistoryFile('alert-b', '2026-07-02_09-00-00-000.md');

		const counts = await countAlertFiringsByDay(tempDir, {
			sinceIso: '2026-07-01T00:00:00Z',
		});

		expect(counts).toEqual([
			{ date: '2026-07-01', count: 2 },
			{ date: '2026-07-02', count: 1 },
		]);
	});

	it('excludes files dated before sinceIso', async () => {
		await seedHistoryFile('alert-a', '2026-06-30_12-00-00-000.md');
		await seedHistoryFile('alert-a', '2026-07-01_12-00-00-000.md');

		const counts = await countAlertFiringsByDay(tempDir, {
			sinceIso: '2026-07-01T00:00:00Z',
		});

		expect(counts).toEqual([{ date: '2026-07-01', count: 1 }]);
	});

	it('ignores non-.md files', async () => {
		await seedHistoryFile('alert-a', '2026-07-01_12-00-00-000.md');
		await seedHistoryFile('alert-a', 'notes.txt');

		const counts = await countAlertFiringsByDay(tempDir, {
			sinceIso: '2026-07-01T00:00:00Z',
		});

		expect(counts).toEqual([{ date: '2026-07-01', count: 1 }]);
	});

	it('returns an empty array when the alert-history directory does not exist', async () => {
		const counts = await countAlertFiringsByDay(tempDir, {
			sinceIso: '2026-07-01T00:00:00Z',
		});
		expect(counts).toEqual([]);
	});

	it('scopes to specific alert ids when alertIds is provided', async () => {
		await seedHistoryFile('alert-a', '2026-07-01_12-00-00-000.md');
		await seedHistoryFile('alert-b', '2026-07-01_13-00-00-000.md');

		const counts = await countAlertFiringsByDay(tempDir, {
			sinceIso: '2026-07-01T00:00:00Z',
			alertIds: ['alert-a'],
		});

		expect(counts).toEqual([{ date: '2026-07-01', count: 1 }]);
	});
});
