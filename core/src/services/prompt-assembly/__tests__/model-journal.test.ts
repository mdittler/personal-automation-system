import { describe, expect, it, vi } from 'vitest';
import {
	JOURNAL_TAG_REGEX,
	MAX_JOURNAL_CHARS,
	appendJournalPromptSection,
	extractJournalEntries,
	writeJournalEntries,
} from '../model-journal.js';
import type { JournalLogger } from '../model-journal.js';

function makeLogger(): JournalLogger {
	return { warn: vi.fn() };
}

function makeJournal(content = '') {
	return {
		read: vi.fn().mockResolvedValue(content),
		append: vi.fn().mockResolvedValue(undefined),
		listArchives: vi.fn().mockResolvedValue([]),
		readArchive: vi.fn().mockResolvedValue(''),
		listModels: vi.fn().mockResolvedValue([]),
	};
}

describe('JOURNAL_TAG_REGEX', () => {
	it('has global flag for multi-match replace', () => {
		expect(JOURNAL_TAG_REGEX.flags).toContain('g');
	});

	it('matches single-line content between tags', () => {
		// Reset lastIndex for repeated use
		JOURNAL_TAG_REGEX.lastIndex = 0;
		const match = JOURNAL_TAG_REGEX.exec('<model-journal>hello</model-journal>');
		expect(match).not.toBeNull();
		expect(match![1]).toBe('hello');
	});
});

describe('extractJournalEntries', () => {
	it('returns unchanged response and empty entries when no tags', () => {
		const result = extractJournalEntries('no tags here');
		expect(result.cleanedResponse).toBe('no tags here');
		expect(result.entries).toEqual([]);
	});

	it('extracts a single entry and removes the tag', () => {
		const result = extractJournalEntries('before<model-journal>note</model-journal>after');
		expect(result.entries).toEqual(['note']);
		expect(result.cleanedResponse).toBe('beforeafter');
	});

	it('extracts multiple entries', () => {
		const input = '<model-journal>first</model-journal> mid <model-journal>second</model-journal>';
		const result = extractJournalEntries(input);
		expect(result.entries).toEqual(['first', 'second']);
		expect(result.cleanedResponse).toBe('mid');
	});

	it('trims whitespace from entries', () => {
		const result = extractJournalEntries('<model-journal>  spaced  </model-journal>');
		expect(result.entries).toEqual(['spaced']);
	});

	it('ignores empty tags (empty trimmed content)', () => {
		const result = extractJournalEntries('text<model-journal>   </model-journal>more');
		expect(result.entries).toEqual([]);
		expect(result.cleanedResponse).toBe('textmore');
	});

	it('collapses excess blank lines left by tag removal', () => {
		const input = 'line1\n\n\n\n<model-journal>note</model-journal>\n\n\n\nline2';
		const result = extractJournalEntries(input);
		// 4+4 newlines around the tag collapse to at most 2 after /\n{3,}/g → '\n\n'
		expect(result.cleanedResponse).toBe('line1\n\nline2');
	});

	it('handles multiline journal content', () => {
		const input = '<model-journal>\nline1\nline2\n</model-journal>';
		const result = extractJournalEntries(input);
		expect(result.entries).toEqual(['line1\nline2']);
	});

	it('preserves unclosed tags (no match, no extraction)', () => {
		const input = '<model-journal>no closing tag';
		const result = extractJournalEntries(input);
		expect(result.entries).toEqual([]);
		expect(result.cleanedResponse).toBe('<model-journal>no closing tag');
	});
});

describe('writeJournalEntries', () => {
	it('is a no-op when entries array is empty', async () => {
		const journal = makeJournal();
		const logger = makeLogger();
		await writeJournalEntries(journal, 'slug', [], logger);
		expect(journal.append).not.toHaveBeenCalled();
	});

	it('is a no-op when modelJournal is undefined', async () => {
		const logger = makeLogger();
		await writeJournalEntries(undefined, 'slug', ['entry'], logger);
		// no error thrown
	});

	it('is a no-op when modelSlug is empty string', async () => {
		const journal = makeJournal();
		const logger = makeLogger();
		await writeJournalEntries(journal, '', ['entry'], logger);
		expect(journal.append).not.toHaveBeenCalled();
	});

	it('calls append for each entry and logs warn on per-entry failure', async () => {
		const journal = makeJournal();
		const logger = makeLogger();
		const err = new Error('disk full');
		journal.append.mockRejectedValueOnce(err).mockResolvedValue(undefined);
		await writeJournalEntries(journal, 'slug', ['fail-entry', 'ok-entry'], logger);
		expect(journal.append).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to write model journal entry: %s',
			err,
		);
	});
});

describe('appendJournalPromptSection', () => {
	it('is a no-op when modelJournal is undefined', async () => {
		const parts: string[] = [];
		await appendJournalPromptSection(parts, undefined, 'slug', makeLogger());
		expect(parts).toHaveLength(0);
	});

	it('is a no-op when modelSlug is undefined', async () => {
		const parts: string[] = [];
		await appendJournalPromptSection(parts, makeJournal(), undefined, makeLogger());
		expect(parts).toHaveLength(0);
	});

	it('appends instruction block when journal is empty', async () => {
		const parts: string[] = [];
		const journal = makeJournal('');
		await appendJournalPromptSection(parts, journal, 'test-slug', makeLogger());
		const joined = parts.join('\n');
		expect(joined).toContain('data/model-journal/test-slug.md');
		expect(joined).toContain('<model-journal>your content here</model-journal>');
		expect(joined).toContain('The tag and its content will be removed before the user sees your response.');
		// No journal content section when empty
		expect(joined).not.toContain('Your current journal');
	});

	it('appends instruction + fenced content when journal is non-empty', async () => {
		const parts: string[] = [];
		const journal = makeJournal('prior note');
		await appendJournalPromptSection(parts, journal, 'test-slug', makeLogger());
		const joined = parts.join('\n');
		expect(joined).toContain('Your current journal');
		expect(joined).toContain('prior note');
		expect(joined).toContain('```');
	});

	it('truncates journal content at MAX_JOURNAL_CHARS via sanitizeInput', async () => {
		const longContent = 'x'.repeat(MAX_JOURNAL_CHARS + 100);
		const parts: string[] = [];
		const journal = makeJournal(longContent);
		await appendJournalPromptSection(parts, journal, 'slug', makeLogger());
		const journalSection = parts.find((p) => p.length > MAX_JOURNAL_CHARS);
		expect(journalSection).toBeUndefined();
	});

	it('logs warn and still includes instruction block on read error', async () => {
		const journal = makeJournal();
		const err = new Error('read error');
		journal.read.mockRejectedValueOnce(err);
		const logger = makeLogger();
		const parts: string[] = [];
		await appendJournalPromptSection(parts, journal, 'slug', logger);
		expect(logger.warn).toHaveBeenCalledWith(
			'Failed to read model journal for prompt: %s',
			err,
		);
		// Instruction block is still present
		expect(parts.join('\n')).toContain('<model-journal>your content here</model-journal>');
	});
});
