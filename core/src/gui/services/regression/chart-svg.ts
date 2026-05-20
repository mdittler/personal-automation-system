/**
 * Server-rendered inline-SVG charts for the Trends tab
 * (REQ-REG-GUI-V2-013/014/015).
 *
 * Two chart kinds:
 *   - Line chart: per-model accuracy over time. Optional horizontal threshold
 *     line (REQ-REG-011's 0.95 gate when bucket=routing).
 *   - Scatter: per-(model, run) cost vs accuracy. Color + shape per model.
 *
 * No client JS. ~200 LOC, no dependency. Accessible `<table>` fallback is
 * rendered separately by the calling partial (REQ-REG-GUI-V2-016).
 *
 * Pure functions only — Codex correction #13 splits the test surface into
 * series-math tests + palette/escaping tests + accessible-table tests +
 * one golden-SVG snapshot per chart kind for regression guard.
 */

import { escapeHtml } from '../../../utils/escape-html.js';
import { paletteSlotFor } from './model-palette.js';

export interface LineSeries {
	label: string;
	tier: string;
	modelId: string;
	/** Points sorted ascending by `xIso`. */
	points: Array<{ xIso: string; y: number }>;
}

export interface LineChartOptions {
	series: LineSeries[];
	width: number;
	height: number;
	yMin?: number;
	yMax?: number;
	thresholdY?: number;
	thresholdLabel?: string;
	xLabel?: string;
	yLabel?: string;
}

export interface ScatterPoint {
	label: string;
	tier: string;
	modelId: string;
	x: number; // typically cost USD
	y: number; // typically pass rate 0..1
	runId: string;
}

export interface ScatterChartOptions {
	points: ScatterPoint[];
	width: number;
	height: number;
	xLabel?: string;
	yLabel?: string;
}

const MARGIN = { top: 16, right: 16, bottom: 32, left: 48 };

/**
 * Alias for the shared `escapeHtml` helper. SVG `<text>` content and
 * attribute values need exactly the HTML-5 named entity set, so we delegate
 * to the canonical implementation.
 */
export const escapeSvg = escapeHtml;

// ────────────────────────────────────────────────────────── line series math

export interface LineSeriesMath {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
	hasData: boolean;
}

/**
 * Compute axis extents from a list of line series. Filters non-finite values
 * (Codex #13: invalid costs / NaN / Infinity).
 */
export function computeLineExtents(
	series: readonly LineSeries[],
	yMin?: number,
	yMax?: number,
): LineSeriesMath {
	let xMin = Number.POSITIVE_INFINITY;
	let xMax = Number.NEGATIVE_INFINITY;
	let yMinObs = Number.POSITIVE_INFINITY;
	let yMaxObs = Number.NEGATIVE_INFINITY;
	let hasData = false;
	for (const s of series) {
		for (const p of s.points) {
			const xMs = Date.parse(p.xIso);
			if (!Number.isFinite(xMs) || !Number.isFinite(p.y)) continue;
			hasData = true;
			if (xMs < xMin) xMin = xMs;
			if (xMs > xMax) xMax = xMs;
			if (p.y < yMinObs) yMinObs = p.y;
			if (p.y > yMaxObs) yMaxObs = p.y;
		}
	}
	if (!hasData) {
		return { xMin: 0, xMax: 1, yMin: yMin ?? 0, yMax: yMax ?? 1, hasData: false };
	}
	// Flat y-range gets a small slack so a horizontal line isn't drawn over the axis.
	if (yMinObs === yMaxObs) {
		yMaxObs += 0.01;
	}
	return {
		xMin,
		xMax: xMax > xMin ? xMax : xMin + 1,
		yMin: yMin ?? Math.min(0, yMinObs),
		yMax: yMax ?? Math.max(1, yMaxObs),
		hasData: true,
	};
}

// ────────────────────────────────────────────────────────── scatter math

export interface ScatterMath {
	xMin: number;
	xMax: number;
	yMin: number;
	yMax: number;
	hasData: boolean;
}

export function computeScatterExtents(points: readonly ScatterPoint[]): ScatterMath {
	let xMin = Number.POSITIVE_INFINITY;
	let xMax = Number.NEGATIVE_INFINITY;
	let yMin = Number.POSITIVE_INFINITY;
	let yMax = Number.NEGATIVE_INFINITY;
	let hasData = false;
	for (const p of points) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		hasData = true;
		if (p.x < xMin) xMin = p.x;
		if (p.x > xMax) xMax = p.x;
		if (p.y < yMin) yMin = p.y;
		if (p.y > yMax) yMax = p.y;
	}
	if (!hasData) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1, hasData: false };
	if (xMin === xMax) xMax = xMin + 0.001;
	if (yMin === yMax) yMax = yMin + 0.01;
	return { xMin, xMax, yMin, yMax, hasData: true };
}

// ────────────────────────────────────────────────────────── line rendering

export function renderLineChart(opts: LineChartOptions): string {
	const ext = computeLineExtents(opts.series, opts.yMin, opts.yMax);
	const innerW = opts.width - MARGIN.left - MARGIN.right;
	const innerH = opts.height - MARGIN.top - MARGIN.bottom;

	function sx(xMs: number): number {
		return MARGIN.left + ((xMs - ext.xMin) / (ext.xMax - ext.xMin)) * innerW;
	}
	function sy(y: number): number {
		return MARGIN.top + innerH - ((y - ext.yMin) / (ext.yMax - ext.yMin)) * innerH;
	}

	const lines: string[] = [];
	lines.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}" role="img" aria-label="line chart">`,
	);
	// Title for accessibility
	lines.push(`<title>${escapeSvg(opts.yLabel || 'accuracy')} over time</title>`);

	// Axes
	lines.push(
		`<line x1="${MARGIN.left}" y1="${MARGIN.top + innerH}" x2="${MARGIN.left + innerW}" y2="${MARGIN.top + innerH}" stroke="#94a3b8" />`,
	);
	lines.push(
		`<line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + innerH}" stroke="#94a3b8" />`,
	);

	// Y axis labels at min / max
	lines.push(
		`<text x="${MARGIN.left - 6}" y="${MARGIN.top + 4}" text-anchor="end" font-size="10" fill="#475569">${escapeSvg(ext.yMax.toFixed(2))}</text>`,
	);
	lines.push(
		`<text x="${MARGIN.left - 6}" y="${MARGIN.top + innerH}" text-anchor="end" font-size="10" fill="#475569">${escapeSvg(ext.yMin.toFixed(2))}</text>`,
	);
	if (opts.yLabel) {
		lines.push(
			`<text x="${MARGIN.left - 30}" y="${MARGIN.top + innerH / 2}" font-size="10" fill="#475569" transform="rotate(-90 ${MARGIN.left - 30} ${MARGIN.top + innerH / 2})">${escapeSvg(opts.yLabel)}</text>`,
		);
	}
	if (opts.xLabel) {
		lines.push(
			`<text x="${MARGIN.left + innerW / 2}" y="${opts.height - 6}" text-anchor="middle" font-size="10" fill="#475569">${escapeSvg(opts.xLabel)}</text>`,
		);
	}

	// Threshold line
	if (opts.thresholdY !== undefined && Number.isFinite(opts.thresholdY)) {
		const ty = sy(opts.thresholdY);
		lines.push(
			`<line x1="${MARGIN.left}" y1="${ty}" x2="${MARGIN.left + innerW}" y2="${ty}" stroke="#ef4444" stroke-dasharray="4 4" />`,
		);
		const label = opts.thresholdLabel ?? `${opts.thresholdY}`;
		lines.push(
			`<text x="${MARGIN.left + innerW - 4}" y="${ty - 4}" text-anchor="end" font-size="10" fill="#ef4444">${escapeSvg(label)}</text>`,
		);
	}

	// Series
	if (ext.hasData) {
		for (const s of opts.series) {
			const slot = paletteSlotFor(s.tier, s.modelId);
			const points = s.points
				.map((p) => ({ xMs: Date.parse(p.xIso), y: p.y }))
				.filter((p) => Number.isFinite(p.xMs) && Number.isFinite(p.y))
				.sort((a, b) => a.xMs - b.xMs);
			if (points.length === 0) continue;
			const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${sx(p.xMs)} ${sy(p.y)}`).join(' ');
			lines.push(
				`<path d="${d}" stroke="${escapeSvg(slot.color)}" stroke-width="1.5" fill="none" />`,
			);
			for (const p of points) {
				lines.push(renderShape(slot, sx(p.xMs), sy(p.y)));
			}
		}
		// Legend
		let lx = MARGIN.left + 4;
		const ly = MARGIN.top + 4;
		for (const s of opts.series) {
			if (s.points.length === 0) continue;
			const slot = paletteSlotFor(s.tier, s.modelId);
			lines.push(`<circle cx="${lx}" cy="${ly}" r="3" fill="${escapeSvg(slot.color)}" />`);
			const label = `${s.label}`;
			lines.push(
				`<text x="${lx + 8}" y="${ly + 3}" font-size="10" fill="#1e293b">${escapeSvg(label)}</text>`,
			);
			lx += 8 + label.length * 5.5 + 12;
		}
	} else {
		lines.push(
			`<text x="${opts.width / 2}" y="${opts.height / 2}" text-anchor="middle" font-size="12" fill="#94a3b8">no data</text>`,
		);
	}

	lines.push('</svg>');
	return lines.join('');
}

// ────────────────────────────────────────────────────────── scatter rendering

export function renderScatter(opts: ScatterChartOptions): string {
	const ext = computeScatterExtents(opts.points);
	const innerW = opts.width - MARGIN.left - MARGIN.right;
	const innerH = opts.height - MARGIN.top - MARGIN.bottom;

	function sx(x: number): number {
		return MARGIN.left + ((x - ext.xMin) / (ext.xMax - ext.xMin)) * innerW;
	}
	function sy(y: number): number {
		return MARGIN.top + innerH - ((y - ext.yMin) / (ext.yMax - ext.yMin)) * innerH;
	}

	const lines: string[] = [];
	lines.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${opts.width} ${opts.height}" role="img" aria-label="scatter plot">`,
	);
	lines.push(
		`<title>${escapeSvg(opts.yLabel || 'accuracy')} vs ${escapeSvg(opts.xLabel || 'cost')}</title>`,
	);

	lines.push(
		`<line x1="${MARGIN.left}" y1="${MARGIN.top + innerH}" x2="${MARGIN.left + innerW}" y2="${MARGIN.top + innerH}" stroke="#94a3b8" />`,
	);
	lines.push(
		`<line x1="${MARGIN.left}" y1="${MARGIN.top}" x2="${MARGIN.left}" y2="${MARGIN.top + innerH}" stroke="#94a3b8" />`,
	);
	if (opts.yLabel) {
		lines.push(
			`<text x="${MARGIN.left - 30}" y="${MARGIN.top + innerH / 2}" font-size="10" fill="#475569" transform="rotate(-90 ${MARGIN.left - 30} ${MARGIN.top + innerH / 2})">${escapeSvg(opts.yLabel)}</text>`,
		);
	}
	if (opts.xLabel) {
		lines.push(
			`<text x="${MARGIN.left + innerW / 2}" y="${opts.height - 6}" text-anchor="middle" font-size="10" fill="#475569">${escapeSvg(opts.xLabel)}</text>`,
		);
	}

	if (ext.hasData) {
		// Dedupe legend entries by composing a stable key but store the parsed
		// triple so we don't have to re-split. Model IDs like
		// `ollama/gemma3:31b` contain colons, so splitting `${tier}:${modelId}:
		// ${label}` would misalign.
		const seen = new Map<string, { tier: string; modelId: string; label: string }>();
		for (const p of opts.points) {
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
			const slot = paletteSlotFor(p.tier, p.modelId);
			lines.push(renderShape(slot, sx(p.x), sy(p.y)));
			const key = `${p.tier} ${p.modelId} ${p.label}`;
			if (!seen.has(key)) seen.set(key, { tier: p.tier, modelId: p.modelId, label: p.label });
		}
		let lx = MARGIN.left + 4;
		const ly = MARGIN.top + 4;
		for (const { tier, modelId, label } of seen.values()) {
			const slot = paletteSlotFor(tier, modelId);
			lines.push(renderShape(slot, lx, ly));
			lines.push(
				`<text x="${lx + 8}" y="${ly + 3}" font-size="10" fill="#1e293b">${escapeSvg(label)}</text>`,
			);
			lx += 8 + label.length * 5.5 + 12;
		}
	} else {
		lines.push(
			`<text x="${opts.width / 2}" y="${opts.height / 2}" text-anchor="middle" font-size="12" fill="#94a3b8">no data</text>`,
		);
	}

	lines.push('</svg>');
	return lines.join('');
}

function renderShape(slot: ReturnType<typeof paletteSlotFor>, x: number, y: number): string {
	const c = escapeSvg(slot.color);
	switch (slot.shape) {
		case 'circle':
			return `<circle cx="${x}" cy="${y}" r="4" fill="${c}" />`;
		case 'triangle':
			return `<polygon points="${x},${y - 4} ${x - 4},${y + 4} ${x + 4},${y + 4}" fill="${c}" />`;
		case 'square':
			return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" fill="${c}" />`;
		case 'diamond':
			return `<polygon points="${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}" fill="${c}" />`;
	}
}
