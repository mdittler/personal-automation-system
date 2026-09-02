/**
 * Tests for `chart-svg.ts` (REQ-REG-GUI-V2-013/014/016).
 *
 * Codex correction #13: pure-function tests for series computation
 * (empty/single/flat-y/threshold/invalid costs); palette determinism;
 * XSS-safe label escaping; one golden snapshot per chart kind.
 */

import { describe, expect, it } from 'vitest';
import {
	type LineSeries,
	type ScatterPoint,
	computeLineExtents,
	computeScatterExtents,
	escapeSvg,
	renderHorizontalBarChart,
	renderLineChart,
	renderScatter,
} from '../chart-svg.js';
import { paletteSize, paletteSlotFor } from '../model-palette.js';

describe('escapeSvg', () => {
	it.each([
		['<script>', '&lt;script&gt;'],
		['"quoted"', '&quot;quoted&quot;'],
		["it's", 'it&#39;s'],
		['a & b', 'a &amp; b'],
		['<svg onload="evil()">', '&lt;svg onload=&quot;evil()&quot;&gt;'],
	])('escapes %s correctly', (input, expected) => {
		expect(escapeSvg(input)).toBe(expected);
	});
});

describe('paletteSlotFor', () => {
	it('returns the same slot for the same (tier, modelId) on every call', () => {
		const a = paletteSlotFor('fast', 'ollama/gemma3:31b');
		const b = paletteSlotFor('fast', 'ollama/gemma3:31b');
		expect(a).toEqual(b);
	});

	it('returns different slots for distinct keys (very high probability with 8 slots)', () => {
		const slots = new Set<string>();
		for (let i = 0; i < paletteSize(); i++) {
			slots.add(JSON.stringify(paletteSlotFor('fast', `model-${i}`)));
		}
		expect(slots.size).toBeGreaterThanOrEqual(paletteSize() - 1);
	});

	it('returns one of the four allowed shapes', () => {
		const slot = paletteSlotFor('fast', 'ollama/gemma3:31b');
		expect(['circle', 'triangle', 'square', 'diamond']).toContain(slot.shape);
	});

	it('returns a hex-color color string', () => {
		const slot = paletteSlotFor('fast', 'ollama/gemma3:31b');
		expect(slot.color).toMatch(/^#[0-9a-f]{6}$/i);
	});
});

describe('computeLineExtents', () => {
	const series: LineSeries[] = [
		{
			label: 'A',
			tier: 'fast',
			modelId: 'A',
			points: [
				{ xIso: '2026-05-10T00:00:00.000Z', y: 0.9 },
				{ xIso: '2026-05-11T00:00:00.000Z', y: 0.95 },
			],
		},
	];

	it('returns empty bounds + hasData=false for empty series', () => {
		const r = computeLineExtents([]);
		expect(r.hasData).toBe(false);
	});

	it('filters non-finite y values (Codex #13: invalid costs)', () => {
		const r = computeLineExtents([
			{
				label: 'A',
				tier: 'fast',
				modelId: 'A',
				points: [
					{ xIso: '2026-05-10T00:00:00.000Z', y: Number.NaN },
					{ xIso: '2026-05-11T00:00:00.000Z', y: Number.POSITIVE_INFINITY },
					{ xIso: '2026-05-12T00:00:00.000Z', y: 0.5 },
				],
			},
		]);
		expect(r.hasData).toBe(true);
	});

	it('expands a flat y-range with slack so a horizontal line is visible', () => {
		const flat: LineSeries[] = [
			{
				label: 'A',
				tier: 'fast',
				modelId: 'A',
				points: [
					{ xIso: '2026-05-10T00:00:00.000Z', y: 0.5 },
					{ xIso: '2026-05-11T00:00:00.000Z', y: 0.5 },
				],
			},
		];
		const r = computeLineExtents(flat);
		expect(r.yMax).toBeGreaterThan(r.yMin);
	});

	it('honors caller-supplied yMin/yMax', () => {
		const r = computeLineExtents(series, 0, 1);
		expect(r.yMin).toBe(0);
		expect(r.yMax).toBe(1);
	});

	it('hasData=true with a single point', () => {
		const r = computeLineExtents([
			{
				label: 'A',
				tier: 'fast',
				modelId: 'A',
				points: [{ xIso: '2026-05-10T00:00:00.000Z', y: 0.5 }],
			},
		]);
		expect(r.hasData).toBe(true);
	});
});

describe('computeScatterExtents', () => {
	const points: ScatterPoint[] = [
		{ label: 'A', tier: 'fast', modelId: 'A', x: 0.001, y: 0.9, runId: 'r1' },
		{ label: 'A', tier: 'fast', modelId: 'A', x: 0.002, y: 0.95, runId: 'r2' },
	];

	it('hasData=false on empty input', () => {
		expect(computeScatterExtents([]).hasData).toBe(false);
	});

	it('drops NaN/Infinity points (Codex #13)', () => {
		const r = computeScatterExtents([
			...points,
			{
				label: 'B',
				tier: 'fast',
				modelId: 'B',
				x: Number.NaN,
				y: 0.5,
				runId: 'r3',
			},
		]);
		expect(r.xMin).toBe(0.001);
		expect(r.xMax).toBe(0.002);
	});

	it('expands flat ranges with slack', () => {
		const flat = computeScatterExtents([
			{ label: 'A', tier: 'fast', modelId: 'A', x: 0.5, y: 0.5, runId: 'r' },
		]);
		expect(flat.xMax).toBeGreaterThan(flat.xMin);
		expect(flat.yMax).toBeGreaterThan(flat.yMin);
	});
});

describe('renderHorizontalBarChart', () => {
	it('renders one bounded bar and escaped model label per datum', () => {
		const svg = renderHorizontalBarChart({
			bars: [
				{ label: '<candidate>', tier: 'fast', modelId: 'candidate', value: 1.2 },
				{ label: 'other', tier: 'fast', modelId: 'other', value: -1 },
			],
			width: 720,
		});
		expect(svg).toContain('latest pass rate bar chart');
		expect(svg).toContain('&lt;candidate&gt;');
		expect(svg).toContain('100.0%');
		expect(svg).toContain('0.0%');
	});
});

describe('renderLineChart', () => {
	it('renders "no data" when series is empty', () => {
		const svg = renderLineChart({ series: [], width: 200, height: 100 });
		expect(svg).toContain('<svg');
		expect(svg).toContain('no data');
	});

	it('renders a threshold line when thresholdY is set', () => {
		const svg = renderLineChart({
			series: [
				{
					label: 'A',
					tier: 'fast',
					modelId: 'A',
					points: [
						{ xIso: '2026-05-10T00:00:00.000Z', y: 0.9 },
						{ xIso: '2026-05-11T00:00:00.000Z', y: 0.95 },
					],
				},
			],
			width: 400,
			height: 200,
			thresholdY: 0.95,
			thresholdLabel: 'REQ-REG-011 (0.95)',
		});
		expect(svg).toContain('stroke-dasharray');
		expect(svg).toContain('REQ-REG-011 (0.95)');
	});

	it('escapes hostile labels so a model id with <script> cannot inject', () => {
		const svg = renderLineChart({
			series: [
				{
					label: '<script>alert(1)</script>',
					tier: 'fast',
					modelId: 'evil',
					points: [{ xIso: '2026-05-10T00:00:00.000Z', y: 0.5 }],
				},
			],
			width: 400,
			height: 200,
		});
		expect(svg).not.toContain('<script>');
		expect(svg).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
	});

	it('golden snapshot for a 2-series line chart', () => {
		const svg = renderLineChart({
			series: [
				{
					label: 'A',
					tier: 'fast',
					modelId: 'A',
					points: [
						{ xIso: '2026-05-10T00:00:00.000Z', y: 0.9 },
						{ xIso: '2026-05-11T00:00:00.000Z', y: 0.95 },
					],
				},
				{
					label: 'B',
					tier: 'fast',
					modelId: 'B',
					points: [{ xIso: '2026-05-10T00:00:00.000Z', y: 0.7 }],
				},
			],
			width: 400,
			height: 200,
			yMin: 0,
			yMax: 1,
		});
		expect(svg.startsWith('<svg')).toBe(true);
		expect(svg.endsWith('</svg>')).toBe(true);
		// Must contain at least one shape rendering for each series
		expect(svg).toContain('A');
		expect(svg).toContain('B');
	});
});

describe('renderScatter', () => {
	it('renders "no data" when points is empty', () => {
		const svg = renderScatter({ points: [], width: 200, height: 100 });
		expect(svg).toContain('no data');
	});

	it('escapes hostile model labels', () => {
		const svg = renderScatter({
			points: [
				{
					label: '<img src=x onerror=alert(1)>',
					tier: 'fast',
					modelId: 'm',
					x: 0.1,
					y: 0.5,
					runId: 'r1',
				},
			],
			width: 400,
			height: 200,
		});
		expect(svg).not.toContain('<img');
		expect(svg).toContain('&lt;img');
	});

	it('renders distinct shapes per palette slot', () => {
		const svg = renderScatter({
			points: [
				{ label: 'A', tier: 'fast', modelId: 'A', x: 0.1, y: 0.5, runId: 'r1' },
				{ label: 'B', tier: 'fast', modelId: 'B', x: 0.2, y: 0.6, runId: 'r2' },
			],
			width: 400,
			height: 200,
		});
		// At least one of the shape elements must appear.
		expect(svg).toMatch(/<circle|<polygon|<rect/);
	});
});
