/**
 * Guided report wizard (Batch 3, Task 3.3).
 *
 * A 4-step htmx wizard that walks a nontechnical admin through creating a
 * report, then submits the EXACT existing `POST /gui/reports` contract
 * (reports.ts `parseFormToReport`) — the existing create/update handlers
 * remain the only writers. Wizard-created and legacy-form-created reports
 * must be indistinguishable (see report-wizard.test.ts's CONTRACT test).
 *
 * Steps: 1 What to include (sections), 2 When (schedule preset), 3 Delivery
 * + AI summary, 4 Review (describeReport sentence + contract hidden fields
 * + Save button that posts to the real `/gui/reports` route).
 *
 * `reply.viewAsync()` always wraps a template in the global page layout in
 * this codebase (see error-fragment.ts's doc comment) — a per-call bare
 * fragment isn't possible. So:
 *   - `GET /reports/new` and `GET /reports/:id/edit-wizard` render the full
 *     page (`report-wizard.eta`) with the current step's body pre-rendered
 *     as a trusted HTML string (`renderStepBody`) passed via `it.bodyHtml`.
 *   - `POST /reports/new/step` returns `renderStepBody(...)` directly as a
 *     raw HTML fragment (status 200 on success, 400 + `pas-error-card` on
 *     validation failure) — no layout — for the htmx `#wizard-body` swap.
 *
 * Every step form carries `step` + all prior fields as hidden inputs so
 * values survive validation errors without any client-side JS state (the
 * I8 fix pattern, `docs/superpowers/plans/...`: "values echoed as named
 * hidden fields").
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { ReportService } from '../../services/reports/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import { REPORT_ID_PATTERN, type ReportDefinition, type SectionType } from '../../types/report.js';
import { escapeHtml } from '../../utils/escape-html.js';
import { describeReport } from '../utils/describe-automation.js';
import { humanizeLabel } from '../utils/humanize.js';
import {
	PRESETS,
	cronToPresetId,
	hourLabel12h,
	nextRunPreview,
	presetToCron,
	weekdayLabel,
} from '../utils/schedule-presets.js';
import { slugifyForId, uniqueSlugForId } from '../utils/slugify-id.js';
import { normalizeBody } from '../utils/wizard-body.js';

export interface ReportWizardRoutesOptions {
	reportService: ReportService;
	userManager: UserManager;
	registry?: { getAll(): Array<{ manifest: { app: { id: string; name: string } } }> };
	dataDir: string;
	timezone: string;
	logger: Logger;
}

const SECTION_TYPES: Array<{ type: SectionType; blurb: string }> = [
	{ type: 'changes', blurb: 'A summary of recent activity across your apps.' },
	{ type: 'app-data', blurb: 'The contents of a specific data file.' },
	{ type: 'context', blurb: 'Saved notes matching a topic.' },
	{ type: 'custom', blurb: 'Your own freeform text.' },
];

const MAX_WIZARD_SECTIONS = 20;

function isPlatformAdmin(request: FastifyRequest): boolean {
	return !request.user || request.user.isPlatformAdmin;
}

function forbidden(reply: FastifyReply): Promise<FastifyReply> {
	return reply
		.status(403)
		.viewAsync('403', { title: '403 Forbidden — PAS' }) as unknown as Promise<FastifyReply>;
}

/**
 * Hidden `<input type="hidden">` for every entry in `values`, skipping `step`
 * (rendered separately). Defensively tolerates array values (a repeated form
 * key that reached this function despite `normalizeBody` — e.g. a future
 * caller that doesn't route through the step-POST boundary) by emitting one
 * hidden input per array element instead of throwing inside `escapeHtml`.
 */
function hiddenFields(
	values: Record<string, string | string[]>,
	exclude: Set<string> = new Set(),
): string {
	return Object.entries(values)
		.filter(([k]) => !exclude.has(k))
		.flatMap(([k, v]) => {
			const name = escapeHtml(k);
			const list = Array.isArray(v) ? v : [v];
			return list.map(
				(item) => `<input type="hidden" name="${name}" value="${escapeHtml(item)}" />`,
			);
		})
		.join('\n');
}

function errorCard(message: string): string {
	return `<div class="pas-error-card" role="alert"><strong>Couldn't continue.</strong><p>${escapeHtml(message)}</p></div>`;
}

/** Count how many `section_type_{i}` fields are present in the submitted values. */
function countSections(values: Record<string, string>): number {
	let count = 0;
	for (let i = 0; i < MAX_WIZARD_SECTIONS; i++) {
		if (values[`section_type_${i}`]) count++;
	}
	return count;
}

/**
 * Field names for step 1's numbered section inputs (`section_type_{i}`,
 * `section_label_{i}`, and every per-section config field for every section
 * type). Step 1's cards already render these as VISIBLE inputs (checkbox,
 * text, textarea) — `hiddenFields()` must exclude them so a validation-error
 * re-render never emits a `<input type="hidden">` with the same `name` as a
 * visible field. Querystring parsing would otherwise coalesce the duplicate
 * names into an array, corrupting the submitted value the next time this
 * step's form posts (hardening item from the Batch 3 review).
 */
function step1SectionFieldNames(): Set<string> {
	const names = new Set<string>();
	for (let i = 0; i < MAX_WIZARD_SECTIONS; i++) {
		names.add(`section_type_${i}`);
		names.add(`section_label_${i}`);
		names.add(`section_lookback_${i}`);
		names.add(`section_app_filter_${i}`);
		names.add(`section_app_id_${i}`);
		names.add(`section_scope_${i}`);
		names.add(`section_space_id_${i}`);
		names.add(`section_user_id_${i}`);
		names.add(`section_path_${i}`);
		names.add(`section_key_prefix_${i}`);
		names.add(`section_text_${i}`);
	}
	return names;
}

// ---------------------------------------------------------------------------
// Step body renderers — each returns a trusted HTML string (no layout).
// ---------------------------------------------------------------------------

function renderStep1(
	values: Record<string, string>,
	apps: Array<{ id: string; name: string }>,
	csrfToken: string,
	error?: string,
): string {
	const cards = SECTION_TYPES.map(({ type, blurb }) => {
		// Wizard supports one section per type per pass-through (kept simple for
		// nontechnical users); index by type's position in SECTION_TYPES.
		const i = SECTION_TYPES.findIndex((s) => s.type === type);
		const checked = values[`section_type_${i}`] === type ? 'checked' : '';
		const label = values[`section_label_${i}`] ?? humanizeLabel(type);
		let configFields = '';
		if (type === 'changes') {
			const lookback = values[`section_lookback_${i}`] || '24';
			configFields = `<label>Look back how many hours?<input type="number" name="section_lookback_${i}" value="${escapeHtml(lookback)}" min="1" /></label>`;
		} else if (type === 'app-data') {
			const appOptions = apps
				.map(
					(a) =>
						`<option value="${escapeHtml(a.id)}" ${values[`section_app_id_${i}`] === a.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`,
				)
				.join('');
			configFields = `<label>Which app?<select name="section_app_id_${i}"><option value="">-- Select app --</option>${appOptions}</select></label>
				<label>File path<input type="text" name="section_path_${i}" value="${escapeHtml(values[`section_path_${i}`] || '')}" placeholder="daily-notes/{today}.md" /></label>`;
		} else if (type === 'context') {
			configFields = `<label>Search for<input type="text" name="section_key_prefix_${i}" value="${escapeHtml(values[`section_key_prefix_${i}`] || '')}" /></label>`;
		} else if (type === 'custom') {
			configFields = `<label>Text<textarea name="section_text_${i}" rows="3">${escapeHtml(values[`section_text_${i}`] || '')}</textarea></label>`;
		}

		return `<details class="pas-wizard-card" ${checked ? 'open' : ''}>
			<summary>
				<label style="display:inline-flex;align-items:center;gap:0.5rem;min-height:44px">
					<input type="checkbox" name="section_type_${i}" value="${type}" ${checked} />
					<strong>${escapeHtml(humanizeLabel(type))}</strong>
				</label>
				<p><small>${escapeHtml(blurb)}</small></p>
			</summary>
			<label>Label for this section<input type="text" name="section_label_${i}" value="${escapeHtml(label)}" /></label>
			${configFields}
		</details>`;
	}).join('\n');

	return `<form hx-post="/gui/reports/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/reports/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="1" />
		${hiddenFields(values, new Set(['step', '_csrf', ...step1SectionFieldNames()]))}
		<h2>What should this report include?</h2>
		${error ? errorCard(error) : ''}
		${cards}
		<button type="submit" style="min-height:44px">Next: When</button>
	</form>`;
}

function renderStep2(values: Record<string, string>, csrfToken: string, error?: string): string {
	const currentSchedule = values.schedule || '';
	const parsed = currentSchedule ? cronToPresetId(currentSchedule) : null;

	const presetCards = PRESETS.map((p) => {
		const checked = parsed?.id === p.id ? 'checked' : '';
		return `<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="schedule_preset" value="${p.id}" ${checked} />
			${escapeHtml(p.label)}
		</label>`;
	}).join('\n');

	const hour = parsed?.hour ?? 7;
	const minute = parsed?.minute ?? 0;
	const weekday = parsed?.weekday ?? 1;

	const hourOptions = Array.from(
		{ length: 24 },
		(_, h) =>
			`<option value="${h}" ${h === hour ? 'selected' : ''}>${escapeHtml(hourLabel12h(h))}</option>`,
	).join('');
	const weekdayOptions = Array.from(
		{ length: 7 },
		(_, w) =>
			`<option value="${w}" ${w === weekday ? 'selected' : ''}>${escapeHtml(weekdayLabel(w))}</option>`,
	).join('');

	return `<form hx-post="/gui/reports/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/reports/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="2" />
		${hiddenFields(values, new Set(['step', '_csrf', 'schedule']))}
		<h2>When should it run?</h2>
		${error ? errorCard(error) : ''}
		${presetCards}
		<label>Time<select name="preset_hour">${hourOptions}</select></label>
		<input type="hidden" name="preset_minute" value="${minute}" />
		<label>Day of the week (weekly only)<select name="preset_weekday">${weekdayOptions}</select></label>
		<details>
			<summary>Advanced: raw cron schedule</summary>
			<label>Cron expression<input type="text" name="schedule_advanced" value="${escapeHtml(currentSchedule)}" placeholder="0 7 * * *" /></label>
		</details>
		<button type="submit" style="min-height:44px">Next: Delivery</button>
	</form>`;
}

function renderStep3(
	values: Record<string, string>,
	users: Array<{ id: string; name: string }>,
	csrfToken: string,
	error?: string,
): string {
	const selectedDelivery = (values.delivery || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const userChecks = users
		.map(
			(u) =>
				`<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px"><input type="checkbox" name="delivery_user" value="${escapeHtml(u.id)}" ${selectedDelivery.includes(u.id) ? 'checked' : ''} /> ${escapeHtml(u.name)}</label>`,
		)
		.join('\n');

	const llmEnabled = values.llm_enabled === 'true';

	return `<form hx-post="/gui/reports/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/reports/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="3" />
		${hiddenFields(values, new Set(['step', '_csrf', 'delivery', 'llm_enabled', 'name', 'id']))}
		<h2>Who gets it, and should AI summarize it?</h2>
		${error ? errorCard(error) : ''}
		<label>Report name<input type="text" name="name" value="${escapeHtml(values.name || '')}" required /></label>
		<details>
			<summary>Custom ID (optional)</summary>
			<label>Leave blank to generate one automatically from the name<input type="text" name="id" value="${escapeHtml(values.id || '')}" pattern="[a-z][a-z0-9-]*" /></label>
		</details>
		<h3>Send to</h3>
		${userChecks}
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="checkbox" name="llm_enabled" value="true" ${llmEnabled ? 'checked' : ''} />
			Add an AI summary
		</label>
		<details ${llmEnabled ? 'open' : ''}>
			<summary>Advanced AI options</summary>
			<label>Custom prompt<textarea name="llm_prompt" rows="2">${escapeHtml(values.llm_prompt || '')}</textarea></label>
			<label>Tier
				<select name="llm_tier">
					<option value="fast" ${values.llm_tier === 'fast' ? 'selected' : ''}>Fast</option>
					<option value="standard" ${!values.llm_tier || values.llm_tier === 'standard' ? 'selected' : ''}>Standard</option>
					<option value="reasoning" ${values.llm_tier === 'reasoning' ? 'selected' : ''}>Reasoning</option>
				</select>
			</label>
		</details>
		<button type="submit" style="min-height:44px">Next: Review</button>
	</form>`;
}

function renderStep4(values: Record<string, string>, csrfToken: string, timezone: string): string {
	const def = buildReportDefinitionFromWizardValues(values);
	const sentence = describeReport(def);

	return `<div>
		<h2>Review</h2>
		<p class="pas-describe-sentence">${escapeHtml(sentence)}</p>
		${values.schedule ? `<p><small>${escapeHtml(nextRunPreview(values.schedule, timezone))}</small></p>` : ''}
		<form method="post" action="/gui/reports">
			<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
			<input type="hidden" name="step" value="4" />
			${hiddenFields(values, new Set(['step', '_csrf']))}
			<input type="hidden" name="enabled" value="true" />
			<input type="hidden" name="from" value="wizard" />
			<button type="submit" style="min-height:44px">Save report</button>
		</form>
	</div>`;
}

/** Build a ReportDefinition from the wizard's accumulated hidden-field values, for the review sentence. */
function buildReportDefinitionFromWizardValues(values: Record<string, string>): ReportDefinition {
	const sections: ReportDefinition['sections'] = [];
	for (let i = 0; i < MAX_WIZARD_SECTIONS; i++) {
		const type = values[`section_type_${i}`] as SectionType | undefined;
		if (!type) continue;
		sections.push({
			type,
			label: values[`section_label_${i}`] || humanizeLabel(type),
			config: {} as ReportDefinition['sections'][number]['config'],
		});
	}
	const delivery = (values.delivery || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return {
		id: values.id || '',
		name: values.name || '',
		enabled: true,
		schedule: values.schedule || '',
		delivery,
		sections,
		llm: { enabled: values.llm_enabled === 'true' },
	};
}

export function registerReportWizardRoutes(
	server: FastifyInstance,
	options: ReportWizardRoutesOptions,
): void {
	const { userManager, registry, timezone } = options;

	function getUsers() {
		return userManager.getAllUsers().map((u) => ({ id: u.id, name: u.name }));
	}
	function getApps() {
		return registry
			? registry.getAll().map((a) => ({ id: a.manifest.app.id, name: a.manifest.app.name }))
			: [];
	}

	function getCsrfToken(request: FastifyRequest): string {
		return ((request as unknown as Record<string, unknown>).csrfToken as string | undefined) ?? '';
	}

	// --- Wizard entry (create) ---
	server.get('/reports/new', async (request: FastifyRequest, reply: FastifyReply) => {
		if (!isPlatformAdmin(request)) return forbidden(reply);

		const csrfToken = getCsrfToken(request);
		const bodyHtml = renderStep1({}, getApps(), csrfToken);
		return reply.viewAsync('report-wizard', {
			title: 'Set up a report — PAS',
			activePage: 'reports',
			bodyHtml,
		});
	});

	// --- Wizard entry (edit — prefill from an existing definition) ---
	server.get(
		'/reports/:id/edit-wizard',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			if (!isPlatformAdmin(request)) return forbidden(reply);

			const report = await options.reportService.getReport(request.params.id);
			if (!report) {
				return reply.code(404).send('Report not found');
			}

			const values: Record<string, string> = {
				id: report.id,
				name: report.name,
				schedule: report.schedule,
				delivery: (report.delivery ?? []).join(', '),
				llm_enabled: report.llm?.enabled ? 'true' : 'false',
				llm_prompt: report.llm?.prompt ?? '',
				llm_tier: report.llm?.tier ?? 'standard',
			};
			(report.sections ?? []).forEach((section, i) => {
				values[`section_type_${i}`] = section.type;
				values[`section_label_${i}`] = section.label;
				const config = section.config as Record<string, unknown>;
				if (section.type === 'changes') {
					values[`section_lookback_${i}`] = String(config.lookback_hours ?? 24);
				} else if (section.type === 'app-data') {
					values[`section_app_id_${i}`] = String(config.app_id ?? '');
					values[`section_path_${i}`] = String(config.path ?? '');
				} else if (section.type === 'context') {
					values[`section_key_prefix_${i}`] = String(config.key_prefix ?? '');
				} else if (section.type === 'custom') {
					values[`section_text_${i}`] = String(config.text ?? '');
				}
			});

			const csrfToken = getCsrfToken(request);
			const bodyHtml = renderStep1(values, getApps(), csrfToken);
			return reply.viewAsync('report-wizard', {
				title: `Edit ${report.name} — PAS`,
				activePage: 'reports',
				bodyHtml,
			});
		},
	);

	// --- Step advance ---
	server.post(
		'/reports/new/step',
		async (request: FastifyRequest<{ Body: Record<string, string> }>, reply: FastifyReply) => {
			if (!isPlatformAdmin(request)) {
				return reply
					.status(403)
					.type('text/html')
					.send(errorCard('Only an administrator can set up reports.'));
			}

			const body = request.body ?? {};
			const step = Number.parseInt(body.step || '1', 10);
			const csrfToken = getCsrfToken(request);

			if (step === 1) {
				const sectionCount = countSections(body);
				if (sectionCount === 0) {
					return reply
						.status(400)
						.type('text/html')
						.send(renderStep1(body, getApps(), csrfToken, 'Pick at least one thing to include.'));
				}
				const next = { ...body, step: '2' };
				return reply.type('text/html').send(renderStep2(next, csrfToken));
			}

			if (step === 2) {
				const advanced = (body.schedule_advanced || '').trim();
				const presetId = body.schedule_preset;
				let schedule = '';
				if (advanced) {
					schedule = advanced;
				} else if (presetId) {
					schedule = presetToCron(presetId, {
						hour: Number.parseInt(body.preset_hour || '0', 10),
						minute: Number.parseInt(body.preset_minute || '0', 10),
						weekday: Number.parseInt(body.preset_weekday || '0', 10),
					});
				}
				if (!schedule) {
					return reply
						.status(400)
						.type('text/html')
						.send(renderStep2(body, csrfToken, 'Pick when this report should run.'));
				}
				const next = { ...body, step: '3', schedule };
				return reply.type('text/html').send(renderStep3(next, getUsers(), csrfToken));
			}

			if (step === 3) {
				const { body: normalized, delivery } = normalizeBody(body);
				if (!normalized.name) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep3(
								{ ...normalized, delivery: delivery.join(', ') },
								getUsers(),
								csrfToken,
								'Give this report a name.',
							),
						);
				}
				const rawId = (normalized.id || '').trim();
				if (rawId && !REPORT_ID_PATTERN.test(rawId)) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep3(
								{ ...normalized, delivery: delivery.join(', ') },
								getUsers(),
								csrfToken,
								'The custom ID must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.',
							),
						);
				}
				if (delivery.length === 0) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep3(
								{ ...normalized, delivery: delivery.join(', ') },
								getUsers(),
								csrfToken,
								'Choose at least one person to send it to.',
							),
						);
				}
				const id =
					rawId ||
					(await uniqueSlugForId(slugifyForId(normalized.name), (candidate) =>
						options.reportService.getReport(candidate),
					));
				const next = { ...normalized, step: '4', delivery: delivery.join(', '), id };
				return reply.type('text/html').send(renderStep4(next, csrfToken, timezone));
			}

			return reply
				.status(400)
				.type('text/html')
				.send(errorCard('Something went wrong with the wizard. Start again.'));
		},
	);
}
