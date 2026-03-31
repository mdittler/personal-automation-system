import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendWithFrontmatter } from '../file.js';

describe('appendWithFrontmatter', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `pas-test-${randomBytes(6).toString('hex')}`);
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it('creates new file with frontmatter + content', async () => {
		const filePath = join(testDir, 'notes.md');
		const fm = '---\ntitle: Test\n---\n';
		await appendWithFrontmatter(filePath, '- Note 1\n', fm);

		const content = await readFile(filePath, 'utf-8');
		expect(content).toBe('---\ntitle: Test\n---\n- Note 1\n');
	});

	it('appends without frontmatter to existing file', async () => {
		const filePath = join(testDir, 'notes.md');
		const fm = '---\ntitle: Test\n---\n';

		// First call creates with frontmatter
		await appendWithFrontmatter(filePath, '- Note 1\n', fm);
		// Second call appends without frontmatter
		await appendWithFrontmatter(filePath, '- Note 2\n', fm);

		const content = await readFile(filePath, 'utf-8');
		expect(content).toBe('---\ntitle: Test\n---\n- Note 1\n- Note 2\n');
	});

	it('creates parent directories if needed', async () => {
		const filePath = join(testDir, 'sub', 'dir', 'notes.md');
		const fm = '---\ntitle: Test\n---\n';
		await appendWithFrontmatter(filePath, 'content\n', fm);

		const content = await readFile(filePath, 'utf-8');
		expect(content).toContain('content');
	});

	it('handles multiple sequential appends correctly', async () => {
		const filePath = join(testDir, 'log.md');
		const fm = '---\ntitle: Log\n---\n';

		await appendWithFrontmatter(filePath, 'line1\n', fm);
		await appendWithFrontmatter(filePath, 'line2\n', fm);
		await appendWithFrontmatter(filePath, 'line3\n', fm);

		const content = await readFile(filePath, 'utf-8');
		// Frontmatter appears only once
		const fmCount = (content.match(/^---$/gm) || []).length;
		expect(fmCount).toBe(2); // opening and closing ---
		expect(content).toContain('line1');
		expect(content).toContain('line2');
		expect(content).toContain('line3');
	});

	it('works with empty frontmatter string', async () => {
		const filePath = join(testDir, 'notes.md');
		await appendWithFrontmatter(filePath, 'content\n', '');

		const content = await readFile(filePath, 'utf-8');
		expect(content).toBe('content\n');
	});

	it('propagates errors other than EEXIST', async () => {
		// Try to write to a path where a directory exists with the same name
		const dirPath = join(testDir, 'subdir');
		const { mkdir } = await import('node:fs/promises');
		await mkdir(dirPath, { recursive: true });
		// Create a file inside to make it non-empty dir
		const { writeFile } = await import('node:fs/promises');
		await writeFile(join(dirPath, 'child.txt'), 'x');

		// appendWithFrontmatter to a path that IS a directory should throw EISDIR
		await expect(appendWithFrontmatter(dirPath, 'content\n', '---\n---\n')).rejects.toThrow();
	});

	it('concurrent appends do not duplicate frontmatter', async () => {
		const filePath = join(testDir, 'concurrent.md');
		const fm = '---\ntitle: Test\n---\n';

		// Race two appends — one should create, one should append
		await Promise.all([
			appendWithFrontmatter(filePath, 'A\n', fm),
			appendWithFrontmatter(filePath, 'B\n', fm),
		]);

		const content = await readFile(filePath, 'utf-8');
		const fmCount = (content.match(/^---$/gm) || []).length;
		expect(fmCount).toBe(2); // Only one frontmatter block
		expect(content).toContain('A');
		expect(content).toContain('B');
	});
});
