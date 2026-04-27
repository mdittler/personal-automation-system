/**
 * Tests for chooseSources() — pure function for default source selection.
 *
 * Chunk C: covers all selectivity logic in source-selection.ts.
 */

import { describe, expect, it } from 'vitest';
import type { ContextSnapshotOptions } from '../conversation-retrieval-service.js';
import { type AllowedSourceCategory, DENIED_SOURCES } from '../source-policy.js';
import { chooseSources } from '../source-selection.js';

function makeOpts(overrides: Partial<ContextSnapshotOptions> = {}): ContextSnapshotOptions {
	return {
		question: 'hello',
		mode: 'free-text',
		dataQueryCandidate: false,
		recentFilePaths: [],
		isAdmin: false,
		...overrides,
	};
}

describe('chooseSources — baseline (free-text, no keywords)', () => {
	it('always includes context-store, interaction-context, app-metadata', () => {
		const selected = chooseSources(makeOpts());
		expect(selected.has('context-store')).toBe(true);
		expect(selected.has('interaction-context')).toBe(true);
		expect(selected.has('app-metadata')).toBe(true);
	});

	it('does not include data-query categories when dataQueryCandidate is false', () => {
		const selected = chooseSources(makeOpts({ question: 'hello' }));
		expect(selected.has('user-app-data')).toBe(false);
		expect(selected.has('household-shared-data')).toBe(false);
		expect(selected.has('space-data')).toBe(false);
		expect(selected.has('collaboration-data')).toBe(false);
	});

	it('does not include reports or alerts for plain free-text without keywords', () => {
		const selected = chooseSources(makeOpts({ question: 'what time is it?' }));
		expect(selected.has('reports')).toBe(false);
		expect(selected.has('alerts')).toBe(false);
	});

	it('returns same set on identical inputs (pure function)', () => {
		const opts = makeOpts({ question: 'hello' });
		const s1 = chooseSources(opts);
		const s2 = chooseSources(opts);
		expect([...s1].sort()).toEqual([...s2].sort());
	});
});

describe('chooseSources — system/how-to keywords add app-knowledge and system-info', () => {
	it('"cost" keyword adds system-info', () => {
		const selected = chooseSources(makeOpts({ question: 'how much did it cost?' }));
		expect(selected.has('system-info')).toBe(true);
	});

	it('"how do i" adds app-knowledge', () => {
		const selected = chooseSources(makeOpts({ question: 'how do i add a recipe?' }));
		expect(selected.has('app-knowledge')).toBe(true);
	});

	it('"how to" adds app-knowledge', () => {
		const selected = chooseSources(makeOpts({ question: 'how to set up alerts' }));
		expect(selected.has('app-knowledge')).toBe(true);
	});

	it('"scheduled" keyword adds reports + alerts', () => {
		const selected = chooseSources(makeOpts({ question: 'show my scheduled jobs' }));
		expect(selected.has('reports')).toBe(true);
		expect(selected.has('alerts')).toBe(true);
		expect(selected.has('system-info')).toBe(true);
	});

	it('"report" in question adds reports + alerts', () => {
		const selected = chooseSources(makeOpts({ question: 'what reports do I have?' }));
		expect(selected.has('reports')).toBe(true);
		expect(selected.has('alerts')).toBe(true);
	});

	it('"alert" in question adds reports + alerts', () => {
		const selected = chooseSources(makeOpts({ question: 'what alerts are configured?' }));
		expect(selected.has('reports')).toBe(true);
		expect(selected.has('alerts')).toBe(true);
	});
});

describe('chooseSources — dataQueryCandidate flag', () => {
	it('dataQueryCandidate: true adds all four data-query categories', () => {
		const selected = chooseSources(makeOpts({ dataQueryCandidate: true }));
		expect(selected.has('user-app-data')).toBe(true);
		expect(selected.has('household-shared-data')).toBe(true);
		expect(selected.has('space-data')).toBe(true);
		expect(selected.has('collaboration-data')).toBe(true);
	});

	it('dataQueryCandidate: false prevents data-query even with data keywords', () => {
		const selected = chooseSources(
			makeOpts({ question: 'show my grocery list', dataQueryCandidate: false }),
		);
		expect(selected.has('user-app-data')).toBe(false);
		expect(selected.has('household-shared-data')).toBe(false);
	});
});

describe('chooseSources — ask mode widens baseline', () => {
	it('ask mode always includes app-knowledge', () => {
		const selected = chooseSources(makeOpts({ mode: 'ask', question: 'hello' }));
		expect(selected.has('app-knowledge')).toBe(true);
	});

	it('ask mode always includes system-info', () => {
		const selected = chooseSources(makeOpts({ mode: 'ask', question: 'hello' }));
		expect(selected.has('system-info')).toBe(true);
	});

	it('ask mode always includes reports and alerts', () => {
		const selected = chooseSources(makeOpts({ mode: 'ask', question: 'hello' }));
		expect(selected.has('reports')).toBe(true);
		expect(selected.has('alerts')).toBe(true);
	});

	it('ask mode with dataQueryCandidate: false still excludes data-query categories', () => {
		const selected = chooseSources(makeOpts({ mode: 'ask', dataQueryCandidate: false }));
		expect(selected.has('user-app-data')).toBe(false);
	});
});

describe('chooseSources — include overrides', () => {
	it('force-off removes a normally-selected category', () => {
		const selected = chooseSources(makeOpts({ include: { 'context-store': false } }));
		expect(selected.has('context-store')).toBe(false);
	});

	it('force-on adds a normally-unselected category', () => {
		const selected = chooseSources(makeOpts({ include: { reports: true } }));
		expect(selected.has('reports')).toBe(true);
	});

	it('empty include object is a no-op', () => {
		const withEmpty = chooseSources(makeOpts({ include: {} }));
		const withoutInclude = chooseSources(makeOpts());
		expect([...withEmpty].sort()).toEqual([...withoutInclude].sort());
	});

	it('multiple overrides applied simultaneously', () => {
		const selected = chooseSources(
			makeOpts({
				include: {
					'context-store': false,
					reports: true,
				},
			}),
		);
		expect(selected.has('context-store')).toBe(false);
		expect(selected.has('reports')).toBe(true);
	});
});

describe('chooseSources — safety: result never includes a DeniedSourceCategory value', () => {
	it('plain free-text result contains no denied categories', () => {
		const selected = chooseSources(makeOpts());
		for (const denied of DENIED_SOURCES) {
			expect(selected.has(denied as unknown as AllowedSourceCategory)).toBe(false);
		}
	});

	it('ask mode result contains no denied categories', () => {
		const selected = chooseSources(makeOpts({ mode: 'ask' }));
		for (const denied of DENIED_SOURCES) {
			expect(selected.has(denied as unknown as AllowedSourceCategory)).toBe(false);
		}
	});

	it('dataQueryCandidate result contains no denied categories', () => {
		const selected = chooseSources(makeOpts({ dataQueryCandidate: true }));
		for (const denied of DENIED_SOURCES) {
			expect(selected.has(denied as unknown as AllowedSourceCategory)).toBe(false);
		}
	});
});
