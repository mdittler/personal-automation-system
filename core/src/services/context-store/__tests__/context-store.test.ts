import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextStoreServiceImpl, extractKeywords, slugifyKey } from '../index.js';

function createMockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as Logger;
}

describe('ContextStoreServiceImpl', () => {
	let tempDir: string;
	let contextDir: string;
	let store: ContextStoreServiceImpl;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pas-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		contextDir = join(tempDir, 'system', 'context');
		await mkdir(contextDir, { recursive: true });
		store = new ContextStoreServiceImpl({ dataDir: tempDir, logger: createMockLogger() });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	describe('get', () => {
		it('should return content for an existing key', async () => {
			await writeFile(
				join(contextDir, 'food-preferences.md'),
				'# Food Preferences\n- Likes pasta\n',
			);

			const result = await store.get('food-preferences');

			expect(result).toBe('# Food Preferences\n- Likes pasta\n');
		});

		it('should return null for a missing key', async () => {
			const result = await store.get('nonexistent');

			expect(result).toBeNull();
		});

		it('should reject path traversal attempts', async () => {
			const result = await store.get('../../etc/passwd');

			expect(result).toBeNull();
		});

		it('should return null when context directory does not exist', async () => {
			const emptyStore = new ContextStoreServiceImpl({
				dataDir: join(tempDir, 'missing'),
				logger: createMockLogger(),
			});

			const result = await emptyStore.get('anything');

			expect(result).toBeNull();
		});
	});

	describe('search', () => {
		it('should find entries matching the query (case-insensitive)', async () => {
			await writeFile(join(contextDir, 'food.md'), '# Food\nLikes pasta and pizza\n');
			await writeFile(join(contextDir, 'fitness.md'), '# Fitness\nRuns 5k daily\n');

			const results = await store.search('pasta');

			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('food');
			expect(results[0]?.content).toContain('pasta');
			expect(results[0]?.lastUpdated).toBeInstanceOf(Date);
		});

		it('should find multiple matching entries', async () => {
			await writeFile(join(contextDir, 'morning.md'), 'Likes coffee in the morning\n');
			await writeFile(join(contextDir, 'evening.md'), 'Prefers tea, no coffee at night\n');
			await writeFile(join(contextDir, 'fitness.md'), 'No caffeine before workout\n');

			const results = await store.search('coffee');

			expect(results).toHaveLength(2);
			const keys = results.map((r) => r.key).sort();
			expect(keys).toEqual(['evening', 'morning']);
		});

		it('should be case-insensitive', async () => {
			await writeFile(join(contextDir, 'prefs.md'), 'Prefers DARK chocolate\n');

			const results = await store.search('dark');

			expect(results).toHaveLength(1);
		});

		it('should return empty array when no matches', async () => {
			await writeFile(join(contextDir, 'food.md'), 'Likes pasta\n');

			const results = await store.search('sushi');

			expect(results).toHaveLength(0);
		});

		it('should return empty array when context directory does not exist', async () => {
			const emptyStore = new ContextStoreServiceImpl({
				dataDir: join(tempDir, 'missing'),
				logger: createMockLogger(),
			});

			const results = await emptyStore.search('anything');

			expect(results).toHaveLength(0);
		});

		it('should return empty array when directory exists but has no .md files', async () => {
			// contextDir exists (created in beforeEach) but contains no files
			const results = await store.search('anything');
			expect(results).toHaveLength(0);
		});

		it('should skip non-markdown files', async () => {
			await writeFile(join(contextDir, 'notes.txt'), 'Contains pasta recipe\n');
			await writeFile(join(contextDir, 'food.md'), 'Likes pasta\n');

			const results = await store.search('pasta');

			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('food');
		});
	});

	describe('searchForUser', () => {
		it('searches user context and system context', async () => {
			// System context
			await writeFile(join(contextDir, 'system-pref.md'), 'Household prefers metric\n');
			// User context
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'personal.md'), 'Prefers dark mode\n');

			const results = await store.searchForUser('prefers', 'user1');

			expect(results).toHaveLength(2);
			const keys = results.map((r) => r.key).sort();
			expect(keys).toEqual(['personal', 'system-pref']);
		});

		it('deduplicates by key — user wins over system', async () => {
			await writeFile(join(contextDir, 'prefs.md'), 'System: likes imperial\n');
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'prefs.md'), 'User: likes metric\n');

			const results = await store.searchForUser('likes', 'user1');

			expect(results).toHaveLength(1);
			expect(results[0]?.content).toContain('metric');
		});

		it('returns empty for invalid userId', async () => {
			const results = await store.searchForUser('test', '../evil');
			expect(results).toHaveLength(0);
		});

		it('returns system results when user has no context', async () => {
			await writeFile(join(contextDir, 'info.md'), 'Some info\n');

			const results = await store.searchForUser('info', 'newuser');

			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('info');
		});
	});

	describe('getForUser', () => {
		it('returns user entry when it exists', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'prefs.md'), 'User prefs\n');

			const result = await store.getForUser('prefs', 'user1');
			expect(result).toBe('User prefs\n');
		});

		it('falls back to system entry', async () => {
			await writeFile(join(contextDir, 'shared.md'), 'System shared\n');

			const result = await store.getForUser('shared', 'user1');
			expect(result).toBe('System shared\n');
		});

		it('returns null when key not found anywhere', async () => {
			const result = await store.getForUser('missing', 'user1');
			expect(result).toBeNull();
		});
	});

	describe('listForUser', () => {
		it('lists all entries for a user', async () => {
			const userCtxDir = join(tempDir, 'users', 'user1', 'context');
			await mkdir(userCtxDir, { recursive: true });
			await writeFile(join(userCtxDir, 'a.md'), 'Entry A\n');
			await writeFile(join(userCtxDir, 'b.md'), 'Entry B\n');

			const results = await store.listForUser('user1');

			expect(results).toHaveLength(2);
			const keys = results.map((r) => r.key).sort();
			expect(keys).toEqual(['a', 'b']);
		});

		it('returns empty when user has no context dir', async () => {
			const results = await store.listForUser('nouser');
			expect(results).toHaveLength(0);
		});

		it('returns empty for invalid userId', async () => {
			const results = await store.listForUser('../../etc');
			expect(results).toHaveLength(0);
		});
	});

	describe('save', () => {
		it('creates a new entry', async () => {
			await store.save('user1', 'prefs', '- Likes metric\n');

			const content = await readFile(
				join(tempDir, 'users', 'user1', 'context', 'prefs.md'),
				'utf-8',
			);
			expect(content).toBe('- Likes metric\n');
		});

		it('overwrites an existing entry', async () => {
			await store.save('user1', 'prefs', 'Old content');
			await store.save('user1', 'prefs', 'New content');

			const content = await readFile(
				join(tempDir, 'users', 'user1', 'context', 'prefs.md'),
				'utf-8',
			);
			expect(content).toBe('New content');
		});

		it('rejects invalid userId', async () => {
			await expect(store.save('../evil', 'key', 'content')).rejects.toThrow('Invalid userId');
		});

		it('accepts natural language names and slugifies them', async () => {
			await store.save('user1', 'Food Preferences', '- Likes pasta\n');

			const content = await readFile(
				join(tempDir, 'users', 'user1', 'context', 'food-preferences.md'),
				'utf-8',
			);
			expect(content).toBe('- Likes pasta\n');
		});

		it('rejects names that slugify to empty string', async () => {
			await expect(store.save('user1', '!!!', 'content')).rejects.toThrow('Invalid name');
		});

		it('creates context directory if it does not exist', async () => {
			await store.save('newuser', 'prefs', 'content');

			const dir = join(tempDir, 'users', 'newuser', 'context');
			await expect(access(dir)).resolves.toBeUndefined();
		});
	});

	describe('remove', () => {
		it('deletes an existing entry', async () => {
			await store.save('user1', 'prefs', 'content');
			await store.remove('user1', 'prefs');

			const result = await store.getForUser('prefs', 'user1');
			expect(result).toBeNull();
		});

		it('does nothing for a missing entry', async () => {
			await expect(store.remove('user1', 'nonexistent')).resolves.toBeUndefined();
		});

		it('rejects invalid userId', async () => {
			await expect(store.remove('../evil', 'key')).rejects.toThrow('Invalid userId');
		});

		it('removes entry using natural language name', async () => {
			await store.save('user1', 'Food Preferences', 'content');
			await store.remove('user1', 'Food Preferences');

			const result = await store.getForUser('food-preferences', 'user1');
			expect(result).toBeNull();
		});

		it('rejects names that slugify to empty string', async () => {
			await expect(store.remove('user1', '!!!')).rejects.toThrow('Invalid name');
		});
	});

	describe('keyword search (word-level matching)', () => {
		it('should match full sentence queries on individual words', async () => {
			await writeFile(join(contextDir, 'prefs.md'), 'My favorite color is blue\n');

			const results = await store.search("What's my favorite color?");

			expect(results).toHaveLength(1);
			expect(results[0]?.content).toContain('blue');
		});

		it('should match on filename/key when content has no matching words', async () => {
			await writeFile(join(contextDir, 'food-preferences.md'), 'I enjoy healthy meals\n');

			const results = await store.search('What are my food preferences?');

			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('food-preferences');
		});

		it('should return empty when query is only stop words', async () => {
			await writeFile(join(contextDir, 'prefs.md'), 'Likes pasta\n');

			const results = await store.search('what is the');

			expect(results).toHaveLength(0);
		});

		it('should rank entries by number of matching words', async () => {
			await writeFile(join(contextDir, 'general.md'), 'Likes food\n');
			await writeFile(join(contextDir, 'specific.md'), 'Likes healthy food and cooking\n');

			const results = await store.search('healthy food cooking');

			expect(results.length).toBeGreaterThanOrEqual(2);
			// 'specific' has 3 matches (healthy, food, cooking), 'general' has 1 (food)
			expect(results[0]?.key).toBe('specific');
		});

		it('should return empty for empty query', async () => {
			await writeFile(join(contextDir, 'prefs.md'), 'content\n');
			const results = await store.search('');
			expect(results).toHaveLength(0);
		});

		it('should still work with single-word queries (backward compat)', async () => {
			await writeFile(join(contextDir, 'food.md'), 'Likes pasta and pizza\n');

			const results = await store.search('pasta');

			expect(results).toHaveLength(1);
			expect(results[0]?.key).toBe('food');
		});

		it('should match real-world context entries via filename keywords', async () => {
			await writeFile(join(contextDir, 'units-of-measure-preferences.md'), 'I prefer Celsius\n');
			await writeFile(
				join(contextDir, 'food-preferences.md'),
				'I enjoy healthy food usually, but will splurge on occasion.\n',
			);

			// "temperature" matches filename "units-of-measure-preferences" via content "Celsius"? No.
			// But "units" or "measure" or "preferences" would match the filename.
			const tempResults = await store.search('What are my unit preferences?');
			expect(tempResults.length).toBeGreaterThanOrEqual(1);
			expect(tempResults.some((r) => r.key === 'units-of-measure-preferences')).toBe(true);

			// "food" matches both filename "food-preferences" and content "food"
			const foodResults = await store.search('Tell me about my food preferences');
			expect(foodResults.length).toBeGreaterThanOrEqual(1);
			expect(foodResults.some((r) => r.key === 'food-preferences')).toBe(true);
		});

		it('should not match when query words are semantically related but not present', async () => {
			await writeFile(join(contextDir, 'food-preferences.md'), 'I enjoy healthy food usually\n');

			// "eat" and "dinner" don't appear in content or filename — no match
			const results = await store.search('What should I eat for dinner?');
			expect(results).toHaveLength(0);
		});
	});

	describe('slugifyKey', () => {
		it('converts spaces to hyphens and lowercases', () => {
			expect(slugifyKey('Food Preferences')).toBe('food-preferences');
		});

		it('strips special characters', () => {
			expect(slugifyKey("My Doctor's Notes!")).toBe('my-doctor-s-notes');
		});

		it('collapses multiple hyphens', () => {
			expect(slugifyKey('a - - b')).toBe('a-b');
		});

		it('trims leading/trailing hyphens', () => {
			expect(slugifyKey('--hello--')).toBe('hello');
		});

		it('handles already-valid slugs', () => {
			expect(slugifyKey('food-preferences')).toBe('food-preferences');
		});

		it('returns empty for all-special-chars input', () => {
			expect(slugifyKey('!!!')).toBe('');
		});

		it('truncates to 100 characters', () => {
			const long = 'a'.repeat(200);
			expect(slugifyKey(long).length).toBeLessThanOrEqual(100);
		});
	});
});

describe('extractKeywords', () => {
	it('extracts meaningful words from a sentence', () => {
		const result = extractKeywords("What's my favorite color?");
		expect(result).toEqual(['favorite', 'color']);
	});

	it('filters out stop words', () => {
		const result = extractKeywords('what is the best way to do this');
		expect(result).toEqual(['best', 'way']);
	});

	it('returns empty for only stop words', () => {
		const result = extractKeywords('what is the');
		expect(result).toEqual([]);
	});

	it('filters single-character tokens', () => {
		const result = extractKeywords('I a b cd efg');
		expect(result).toEqual(['cd', 'efg']);
	});

	it('is case-insensitive', () => {
		const result = extractKeywords('HELLO World');
		expect(result).toEqual(['hello', 'world']);
	});

	it('strips punctuation', () => {
		const result = extractKeywords('food? cooking! temperature.');
		expect(result).toEqual(['food', 'cooking', 'temperature']);
	});

	it('returns empty for empty string', () => {
		expect(extractKeywords('')).toEqual([]);
	});
});
