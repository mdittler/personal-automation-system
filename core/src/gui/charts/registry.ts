/**
 * Declarative chart registry — the ONLY file to touch to add, revise, or
 * remove a GUI metric chart.
 *
 * ── HOW TO EDIT CHARTS ─────────────────────────────────────────────
 * Add a chart:    add one ChartDescriptor to CHARTS. Done.
 * Remove a chart: delete its entry. Done.
 * Revise a chart: edit its fields. Done.
 * New data need:  add a metrics endpoint in routes/metrics.ts first,
 *                 then reference it here and in the registry test's
 *                 KNOWN_ENDPOINTS list. Full recipe: docs/GUI_CHARTS.md
 * ───────────────────────────────────────────────────────────────────
 *
 * Templates never hand-write chart markup or client JS — they render one
 * `[data-pas-chart]` slot per descriptor (via `chartsForPage`), and
 * `public/pas-charts.js` (chart-agnostic) does the rest.
 */

export const SUPPORTED_TYPES = ['line', 'bar'] as const;

export interface ChartDescriptor {
	/** kebab-case, unique. */
	id: string;
	/** Which GUI page renders this chart. */
	page: 'home' | 'llm';
	/** Plain language, sentence case. */
	title: string;
	/** /gui/api/metrics/* — permission-scoped server-side. */
	endpoint: string;
	type: (typeof SUPPORTED_TYPES)[number];
	/** Fields of the endpoint's `days[]` rows to plot. */
	series: Array<{ key: string; label: string }>;
	/** px, default 240 (180 on phones — handled by pas-charts.js). */
	height?: number;
}

export const CHARTS: ChartDescriptor[] = [
	{
		id: 'ai-spend-daily',
		page: 'home',
		title: 'AI spend, last 30 days',
		endpoint: '/gui/api/metrics/llm-daily',
		type: 'line',
		series: [{ key: 'cost', label: 'Spend ($)' }],
	},
	{
		id: 'activity-daily',
		page: 'home',
		title: 'Messages and alerts by day',
		endpoint: '/gui/api/metrics/activity-daily',
		type: 'bar',
		series: [
			{ key: 'messages', label: 'Messages' },
			{ key: 'alertFirings', label: 'Alerts fired' },
		],
	},
	{
		id: 'ai-tokens-daily',
		page: 'llm',
		title: 'Tokens by day',
		endpoint: '/gui/api/metrics/llm-daily',
		type: 'bar',
		series: [
			{ key: 'inputTokens', label: 'Input' },
			{ key: 'outputTokens', label: 'Output' },
		],
	},
];

export function chartsForPage(page: ChartDescriptor['page']): ChartDescriptor[] {
	return CHARTS.filter((c) => c.page === page);
}
