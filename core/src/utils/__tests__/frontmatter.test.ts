import { describe, expect, it } from 'vitest';
import {
	buildAppTags,
	extractWikiLinks,
	generateFrontmatter,
	hasFrontmatter,
	parseFrontmatter,
	stripFrontmatter,
} from '../frontmatter.js';

describe('generateFrontmatter', () => {
	it('generates basic frontmatter block', () => {
		const result = generateFrontmatter({
			title: 'Test Note',
			date: '2026-03-19',
			type: 'daily-note',
		});
		expect(result).toBe('---\ntitle: Test Note\ndate: 2026-03-19\ntype: daily-note\n---\n');
	});

	it('omits undefined and null fields', () => {
		const result = generateFrontmatter({
			title: 'Test',
			date: undefined,
			app: undefined,
		});
		expect(result).toBe('---\ntitle: Test\n---\n');
	});

	it('handles arrays as YAML lists', () => {
		const result = generateFrontmatter({
			tags: ['pas/daily-note', 'pas/notes'],
		});
		expect(result).toBe('---\ntags:\n  - pas/daily-note\n  - pas/notes\n---\n');
	});

	it('skips empty arrays', () => {
		const result = generateFrontmatter({ tags: [] });
		expect(result).toBe('---\n---\n');
	});

	it('quotes values with special characters', () => {
		const result = generateFrontmatter({
			title: 'Alert: low-stock',
		});
		expect(result).toContain('"Alert: low-stock"');
	});

	it('quotes empty string values', () => {
		const result = generateFrontmatter({ title: '' });
		expect(result).toContain('title: ""');
	});

	it('does not quote simple values', () => {
		const result = generateFrontmatter({ source: 'pas-router' });
		expect(result).toBe('---\nsource: pas-router\n---\n');
	});

	it('handles all FrontmatterMeta fields', () => {
		const result = generateFrontmatter({
			title: 'Full Note',
			date: '2026-03-19',
			created: '2026-03-19T09:00:00',
			tags: ['tag1'],
			type: 'report',
			app: 'notes',
			user: 'user1',
			source: 'pas-notes',
		});
		expect(result).toContain('title: Full Note');
		expect(result).toContain('date: 2026-03-19');
		expect(result).toContain('type: report');
		expect(result).toContain('app: notes');
		expect(result).toContain('user: user1');
		expect(result).toContain('source: pas-notes');
		expect(result).toContain('  - tag1');
	});
});

describe('parseFrontmatter', () => {
	it('parses basic frontmatter', () => {
		const raw = '---\ntitle: Test\ndate: 2026-03-19\n---\nBody content here';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta.title).toBe('Test');
		expect(meta.date).toBe('2026-03-19');
		expect(content).toBe('Body content here');
	});

	it('parses array values', () => {
		const raw = '---\ntags:\n  - tag1\n  - tag2\n---\nBody';
		const { meta } = parseFrontmatter(raw);
		expect(meta.tags).toEqual(['tag1', 'tag2']);
	});

	it('returns empty meta and full content when no frontmatter', () => {
		const raw = 'Just some content\nNo frontmatter here';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta).toEqual({});
		expect(content).toBe(raw);
	});

	it('handles quoted values', () => {
		const raw = '---\ntitle: "Alert: test"\n---\nBody';
		const { meta } = parseFrontmatter(raw);
		expect(meta.title).toBe('Alert: test');
	});

	it('roundtrips through generate/parse', () => {
		const original = {
			title: 'Test Note',
			date: '2026-03-19',
			tags: ['pas/daily-note', 'pas/notes'],
			type: 'daily-note' as const,
			source: 'pas-notes',
		};
		const generated = generateFrontmatter(original);
		const body = '# Content\nSome text\n';
		const { meta, content } = parseFrontmatter(generated + body);

		expect(meta.title).toBe('Test Note');
		expect(meta.date).toBe('2026-03-19');
		expect(meta.tags).toEqual(['pas/daily-note', 'pas/notes']);
		expect(meta.type).toBe('daily-note');
		expect(meta.source).toBe('pas-notes');
		expect(content).toBe(body);
	});

	it('handles content with --- inside body', () => {
		const raw = '---\ntitle: Test\n---\n# Title\n\n---\n\nMore content';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta.title).toBe('Test');
		expect(content).toBe('# Title\n\n---\n\nMore content');
	});
});

describe('hasFrontmatter', () => {
	it('returns true for content with frontmatter', () => {
		expect(hasFrontmatter('---\ntitle: Test\n---\nBody')).toBe(true);
	});

	it('returns false for content without frontmatter', () => {
		expect(hasFrontmatter('# Just a heading\nBody')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(hasFrontmatter('')).toBe(false);
	});

	it('returns false for --- not at start', () => {
		expect(hasFrontmatter('text\n---\nmore')).toBe(false);
	});
});

describe('parseFrontmatter — edge cases', () => {
	it('handles \\r\\n line endings', () => {
		const raw = '---\r\ntitle: Test\r\ndate: 2026-03-19\r\n---\r\nBody content';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta.title).toBe('Test');
		expect(meta.date).toBe('2026-03-19');
		expect(content).toBe('Body content');
	});

	it('handles unclosed frontmatter (no closing ---)', () => {
		const raw = '---\ntitle: Test\nNo closing delimiter';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta).toEqual({});
		expect(content).toBe(raw);
	});

	it('handles frontmatter-only content (no body)', () => {
		const raw = '---\ntitle: Test\n---';
		const { meta, content } = parseFrontmatter(raw);
		expect(meta.title).toBe('Test');
		expect(content).toBe('');
	});

	it('handles empty frontmatter block', () => {
		const raw = '---\n---\nBody';
		const { meta, content } = parseFrontmatter(raw);
		expect(Object.keys(meta)).toHaveLength(0);
		expect(content).toBe('Body');
	});
});

describe('generateFrontmatter — edge cases', () => {
	it('quotes YAML reserved words (true/false/null/yes/no)', () => {
		const result = generateFrontmatter({ title: 'true' });
		expect(result).toContain('"true"');
	});

	it('handles values containing backslashes', () => {
		const result = generateFrontmatter({ title: 'path\\to\\file' });
		expect(result).toContain('"path\\\\to\\\\file"');
		// Verify roundtrip
		const { meta } = parseFrontmatter(`${result}body`);
		expect(meta.title).toBe('path\\to\\file');
	});

	it('handles values containing double quotes', () => {
		const result = generateFrontmatter({ title: 'say "hello"' });
		expect(result).toContain('"say \\"hello\\""');
		// Verify roundtrip
		const { meta } = parseFrontmatter(`${result}body`);
		expect(meta.title).toBe('say "hello"');
	});

	it('handles numeric values', () => {
		const result = generateFrontmatter({ count: 42 as unknown as string });
		expect(result).toContain('count: 42');
	});

	it('handles completely empty meta object', () => {
		const result = generateFrontmatter({});
		expect(result).toBe('---\n---\n');
	});
});

describe('generateFrontmatter — security', () => {
	it('quotes values that could be YAML injection', () => {
		const result = generateFrontmatter({ title: '---\ninjected: true' });
		// The value contains special chars so it should be quoted
		expect(result).not.toContain('injected: true\n');
	});

	it('quotes tag values with special characters', () => {
		const result = generateFrontmatter({ tags: ['safe-tag', 'tag: evil'] });
		expect(result).toContain('"tag: evil"');
	});
});

describe('stripFrontmatter', () => {
	it('strips frontmatter and returns body', () => {
		const raw = '---\ntitle: Test\n---\nBody content';
		expect(stripFrontmatter(raw)).toBe('Body content');
	});

	it('returns full content when no frontmatter', () => {
		const raw = 'No frontmatter here';
		expect(stripFrontmatter(raw)).toBe(raw);
	});

	it('handles empty body after frontmatter', () => {
		const raw = '---\ntitle: Test\n---\n';
		expect(stripFrontmatter(raw)).toBe('');
	});
});

describe('generateFrontmatter — cross-linking fields', () => {
	it('generates aliases as YAML list', () => {
		const result = generateFrontmatter({
			title: 'Chicken Stir Fry',
			aliases: ['stir fry chicken', 'chicken stir-fry'],
		});
		expect(result).toContain('aliases:');
		expect(result).toContain('  - stir fry chicken');
		expect(result).toContain('  - chicken stir-fry');
	});

	it('generates related as YAML list with wiki-links', () => {
		const result = generateFrontmatter({
			title: 'Meal Plan',
			related: ['[[food-tracker/recipes/chicken-stir-fry]]', '[[grocery/lists/2026-03-19]]'],
		});
		expect(result).toContain('related:');
		// Wiki-links contain special characters, should be quoted
		expect(result).toContain('[[food-tracker/recipes/chicken-stir-fry]]');
		expect(result).toContain('[[grocery/lists/2026-03-19]]');
	});

	it('roundtrips aliases through generate/parse', () => {
		const original = {
			title: 'Test',
			aliases: ['alias1', 'alias2'],
		};
		const generated = generateFrontmatter(original);
		const { meta } = parseFrontmatter(`${generated}body`);
		expect(meta.aliases).toEqual(['alias1', 'alias2']);
	});

	it('roundtrips related wiki-links through generate/parse', () => {
		const original = {
			title: 'Meal Plan',
			related: ['[[food-tracker/recipes/chicken]]', '[[grocery/lists/2026-03-19]]'],
		};
		const generated = generateFrontmatter(original);
		const { meta } = parseFrontmatter(`${generated}body`);
		expect(meta.related).toEqual([
			'[[food-tracker/recipes/chicken]]',
			'[[grocery/lists/2026-03-19]]',
		]);
	});

	it('supports Dataview-friendly custom fields', () => {
		const result = generateFrontmatter({
			title: 'Chicken Stir Fry',
			calories: 450 as unknown as string,
			protein: 35 as unknown as string,
			servings: 4 as unknown as string,
			prep_time: 20 as unknown as string,
		});
		expect(result).toContain('calories: 450');
		expect(result).toContain('protein: 35');
		expect(result).toContain('servings: 4');
		expect(result).toContain('prep_time: 20');
	});
});

describe('extractWikiLinks', () => {
	it('extracts simple wiki-links', () => {
		const content = 'See [[food-tracker/recipes/chicken]] for details.';
		expect(extractWikiLinks(content)).toEqual(['food-tracker/recipes/chicken']);
	});

	it('extracts wiki-links with display text', () => {
		const content = 'Made [[food-tracker/recipes/chicken|Chicken Stir Fry]] for dinner.';
		expect(extractWikiLinks(content)).toEqual(['food-tracker/recipes/chicken']);
	});

	it('extracts multiple wiki-links', () => {
		const content = 'See [[notes/2026-03-19]] and [[grocery/lists/week-12]] for more.';
		expect(extractWikiLinks(content)).toEqual(['notes/2026-03-19', 'grocery/lists/week-12']);
	});

	it('deduplicates repeated links', () => {
		const content = 'Check [[recipe]] and also see [[recipe]] again.';
		expect(extractWikiLinks(content)).toEqual(['recipe']);
	});

	it('returns empty array when no links present', () => {
		expect(extractWikiLinks('No links here.')).toEqual([]);
	});

	it('handles empty string', () => {
		expect(extractWikiLinks('')).toEqual([]);
	});

	it('ignores malformed links', () => {
		const content = 'Not a link: [single bracket] or [[unclosed';
		expect(extractWikiLinks(content)).toEqual([]);
	});

	it('handles links with spaces in target', () => {
		const content = '[[meal planner/weekly plan]]';
		expect(extractWikiLinks(content)).toEqual(['meal planner/weekly plan']);
	});

	it('trims whitespace from link targets', () => {
		const content = '[[  food-tracker/recipe  ]]';
		expect(extractWikiLinks(content)).toEqual(['food-tracker/recipe']);
	});

	it('handles links adjacent to each other', () => {
		const content = '[[a]][[b]][[c]]';
		expect(extractWikiLinks(content)).toEqual(['a', 'b', 'c']);
	});

	it('handles multiline content with links', () => {
		const content = 'Line 1 with [[link-a]]\nLine 2\nLine 3 with [[link-b]]';
		expect(extractWikiLinks(content)).toEqual(['link-a', 'link-b']);
	});

	it('ignores empty link targets', () => {
		const content = '[[]] and [[  ]]';
		expect(extractWikiLinks(content)).toEqual([]);
	});

	it('handles nested brackets gracefully', () => {
		// [[a[b]]] is malformed but should not crash
		const content = '[[a[b]]]';
		// The regex captures up to the first ] — extracts 'a[b' as target
		expect(() => extractWikiLinks(content)).not.toThrow();
	});
});

describe('buildAppTags', () => {
	it('builds basic tags with app ID and type', () => {
		const tags = buildAppTags('food-tracker', 'recipe');
		expect(tags).toEqual(['pas/recipe', 'pas/food-tracker']);
	});

	it('appends extra tags', () => {
		const tags = buildAppTags('food-tracker', 'recipe', ['ingredient/chicken', 'meal/dinner']);
		expect(tags).toEqual(['pas/recipe', 'pas/food-tracker', 'ingredient/chicken', 'meal/dinner']);
	});

	it('deduplicates extras that match base tags', () => {
		const tags = buildAppTags('food-tracker', 'recipe', [
			'pas/recipe', // duplicate of base
			'ingredient/chicken',
		]);
		expect(tags).toEqual(['pas/recipe', 'pas/food-tracker', 'ingredient/chicken']);
	});

	it('handles empty extras array', () => {
		const tags = buildAppTags('notes', 'daily-note', []);
		expect(tags).toEqual(['pas/daily-note', 'pas/notes']);
	});

	it('handles undefined extras', () => {
		const tags = buildAppTags('notes', 'daily-note');
		expect(tags).toEqual(['pas/daily-note', 'pas/notes']);
	});

	it('filters out empty string extras', () => {
		const tags = buildAppTags('fitness', 'workout', ['', 'exercise/cardio']);
		expect(tags).toEqual(['pas/workout', 'pas/fitness', 'exercise/cardio']);
	});

	it('preserves tag order (extras after base tags)', () => {
		const tags = buildAppTags('app', 'type', ['z-tag', 'a-tag']);
		expect(tags).toEqual(['pas/type', 'pas/app', 'z-tag', 'a-tag']);
	});

	it('handles special characters in extras', () => {
		// Tags with special chars should pass through (quoting is handled by generateFrontmatter)
		const tags = buildAppTags('app', 'type', ['tag: with-colon']);
		expect(tags).toContain('tag: with-colon');
	});
});
