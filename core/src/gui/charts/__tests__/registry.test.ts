import { describe, expect, it } from 'vitest';
import { CHARTS, type ChartDescriptor, SUPPORTED_TYPES, chartsForPage } from '../registry.js';

// Endpoints known to the GUI as of Batch 2. When a new metrics endpoint is
// added, add it here too (see docs/GUI_CHARTS.md).
const KNOWN_ENDPOINTS = ['/gui/api/metrics/llm-daily', '/gui/api/metrics/activity-daily'];

describe('chart registry', () => {
	it('every descriptor is complete and points at a known endpoint + supported type', () => {
		expect(CHARTS.length).toBeGreaterThan(0);
		for (const c of CHARTS) {
			expect(c.id).toMatch(/^[a-z0-9-]+$/);
			expect(c.title.length).toBeGreaterThan(0);
			expect(KNOWN_ENDPOINTS).toContain(c.endpoint);
			expect(SUPPORTED_TYPES).toContain(c.type);
			expect(c.series.length).toBeGreaterThan(0);
			for (const s of c.series) {
				expect(s.key.length).toBeGreaterThan(0);
				expect(s.label.length).toBeGreaterThan(0);
			}
		}
	});

	it('ids are unique', () => {
		const ids = CHARTS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('chartsForPage filters by page', () => {
		const home = chartsForPage('home');
		expect(home.length).toBeGreaterThan(0);
		for (const c of home) {
			expect(c.page).toBe('home');
		}

		const llm = chartsForPage('llm');
		expect(llm.length).toBeGreaterThan(0);
		for (const c of llm) {
			expect(c.page).toBe('llm');
		}
	});

	it('chartsForPage returns an empty array for a page with no charts', () => {
		// Cast is safe here — we're deliberately probing an unregistered page id.
		const none = chartsForPage('nonexistent' as ChartDescriptor['page']);
		expect(none).toEqual([]);
	});

	it('adding a descriptor is the only change needed to register a new chart', () => {
		// This test documents (and pins) the editability guarantee: CHARTS is a
		// plain exported array, so appending an entry is a one-file change.
		const before = CHARTS.length;
		const dummy: ChartDescriptor = {
			id: 'registry-editability-probe',
			page: 'home',
			title: 'Probe',
			endpoint: '/gui/api/metrics/llm-daily',
			type: 'line',
			series: [{ key: 'cost', label: 'Spend ($)' }],
		};
		CHARTS.push(dummy);
		expect(chartsForPage('home')).toContainEqual(dummy);
		CHARTS.pop();
		expect(CHARTS.length).toBe(before);
	});
});
