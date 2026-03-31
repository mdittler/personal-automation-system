import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectChanges } from '../collector.js';

describe('collectChanges', () => {
	let tempDir: string;
	let logPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'pas-collector-'));
		logPath = join(tempDir, 'change-log.jsonl');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('should parse and filter entries by date', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-08T10:00:00.000Z',
				operation: 'write',
				path: 'old.md',
				appId: 'echo',
				userId: 'user1',
			}),
			JSON.stringify({
				timestamp: '2026-03-09T14:00:00.000Z',
				operation: 'write',
				path: 'new.md',
				appId: 'echo',
				userId: 'user1',
			}),
			JSON.stringify({
				timestamp: '2026-03-09T15:00:00.000Z',
				operation: 'append',
				path: 'log.md',
				appId: 'echo',
				userId: 'user2',
			}),
		];
		await writeFile(logPath, `${lines.join('\n')}\n`);

		const since = new Date('2026-03-09T00:00:00.000Z');
		const result = await collectChanges(logPath, since);

		expect(result.entries).toHaveLength(2);
		expect(result.date).toBe('2026-03-09');
	});

	it('should group entries by app and user', async () => {
		const lines = [
			JSON.stringify({
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'a.md',
				appId: 'echo',
				userId: 'user1',
			}),
			JSON.stringify({
				timestamp: '2026-03-09T11:00:00.000Z',
				operation: 'append',
				path: 'b.md',
				appId: 'echo',
				userId: 'user1',
			}),
			JSON.stringify({
				timestamp: '2026-03-09T12:00:00.000Z',
				operation: 'write',
				path: 'c.md',
				appId: 'weather',
				userId: 'user2',
			}),
		];
		await writeFile(logPath, `${lines.join('\n')}\n`);

		const since = new Date('2026-03-09T00:00:00.000Z');
		const result = await collectChanges(logPath, since);

		expect(result.byApp.echo?.user1).toHaveLength(2);
		expect(result.byApp.weather?.user2).toHaveLength(1);
	});

	it('should handle missing log file gracefully', async () => {
		const result = await collectChanges(join(tempDir, 'missing.jsonl'), new Date());

		expect(result.entries).toHaveLength(0);
		expect(result.byApp).toEqual({});
	});

	it('should handle empty log file', async () => {
		await writeFile(logPath, '');

		const result = await collectChanges(logPath, new Date('2026-01-01'));

		expect(result.entries).toHaveLength(0);
	});

	it('should include entries exactly at the since boundary', async () => {
		const boundary = '2026-03-09T00:00:00.000Z';
		const lines = [
			JSON.stringify({
				timestamp: boundary,
				operation: 'write',
				path: 'exact.md',
				appId: 'echo',
				userId: 'user1',
			}),
			JSON.stringify({
				timestamp: '2026-03-08T23:59:59.999Z',
				operation: 'write',
				path: 'before.md',
				appId: 'echo',
				userId: 'user1',
			}),
		];
		await writeFile(logPath, `${lines.join('\n')}\n`);

		const since = new Date(boundary);
		const result = await collectChanges(logPath, since);

		// entry.timestamp < sinceISO filters out entries before since;
		// exact match is NOT less than since, so it's included
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.path).toBe('exact.md');
	});

	it('should skip malformed JSONL lines', async () => {
		const lines = [
			'not valid json',
			JSON.stringify({
				timestamp: '2026-03-09T10:00:00.000Z',
				operation: 'write',
				path: 'valid.md',
				appId: 'echo',
				userId: 'user1',
			}),
			'{broken',
		];
		await writeFile(logPath, `${lines.join('\n')}\n`);

		const since = new Date('2026-03-09T00:00:00.000Z');
		const result = await collectChanges(logPath, since);

		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.path).toBe('valid.md');
	});
});
