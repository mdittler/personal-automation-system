/**
 * pas-charts.js — chart-agnostic slot renderer for GUI metric charts.
 *
 * Templates never write per-chart markup or JS. They emit one
 * `[data-pas-chart]` slot per registry descriptor (see
 * core/src/gui/charts/registry.ts), with data-* attributes carrying the
 * descriptor's fields. This script finds every slot, fetches its endpoint,
 * and instantiates a Chart.js chart. This file is NEVER edited per-chart —
 * see docs/GUI_CHARTS.md for the recipe to add/revise/remove a chart.
 *
 * Plain vanilla JS, no build step, loaded directly via <script> — but
 * written with modern syntax (const/let, arrow functions, template
 * literals) since every supported browser understands it natively.
 */
(() => {
	const PHONE_BREAKPOINT_PX = 480;

	function heightForViewport(descriptorHeight) {
		const base = descriptorHeight || 240;
		if (window.innerWidth <= PHONE_BREAKPOINT_PX) {
			return Math.min(base, 180);
		}
		return base;
	}

	function renderUnavailable(container) {
		container.innerHTML =
			'<p class="pas-chart-unavailable" role="note">Couldn’t load this chart.</p>';
	}

	function buildConfig(type, title, series, days) {
		const labels = days.map((d) => d.date);
		const palette = ['#4f8fdb', '#e0a03c', '#5cb37a', '#c25b5b', '#8a6fd1'];
		const datasets = series.map((s, i) => ({
			label: s.label,
			data: days.map((d) => (d[s.key] == null ? 0 : d[s.key])),
			borderColor: palette[i % palette.length],
			backgroundColor: palette[i % palette.length],
			fill: false,
			tension: 0.25,
		}));
		return {
			type: type,
			data: { labels: labels, datasets: datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				plugins: {
					title: { display: Boolean(title), text: title },
				},
				scales: {
					y: { beginAtZero: true },
				},
			},
		};
	}

	function initSlot(el) {
		const endpoint = el.getAttribute('data-endpoint');
		const type = el.getAttribute('data-type') || 'line';
		const title = el.getAttribute('data-title') || '';
		const height = Number.parseInt(el.getAttribute('data-height') || '', 10) || 240;
		const seriesRaw = el.getAttribute('data-series') || '[]';

		let series;
		try {
			series = JSON.parse(seriesRaw);
		} catch {
			renderUnavailable(el);
			return;
		}

		if (!endpoint || typeof window.Chart === 'undefined') {
			renderUnavailable(el);
			return;
		}

		el.style.height = `${heightForViewport(height)}px`;
		const canvas = document.createElement('canvas');
		el.appendChild(canvas);

		fetch(endpoint, { credentials: 'same-origin' })
			.then((res) => {
				if (!res.ok) throw new Error(`metrics fetch failed: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				const days = data && Array.isArray(data.days) ? data.days : [];
				const config = buildConfig(type, title, series, days);
				new window.Chart(canvas, config);
			})
			.catch(() => {
				renderUnavailable(el);
			});
	}

	function init() {
		const slots = document.querySelectorAll('[data-pas-chart]');
		for (const slot of slots) {
			initSlot(slot);
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
