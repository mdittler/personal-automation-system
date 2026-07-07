/**
 * Guided alert wizard (Batch 4, Task 4.3).
 *
 * Same engine as the report wizard (report-wizard.ts) — a 5-step htmx
 * wizard that walks a nontechnical admin through creating an alert, then
 * submits the EXACT existing `POST /gui/alerts` contract (alerts.ts
 * `parseFormToAlert`) — the existing create/update handlers remain the
 * only writers. Wizard-created and legacy-form-created alerts must be
 * indistinguishable (see alert-wizard.test.ts's CONTRACT test).
 *
 * Steps: 1 What to watch (data-source picker), 2 When (schedule preset or
 * event trigger), 3 Condition (rule builder / own-words fuzzy / advanced
 * raw expression), 4 What happens (actions + delivery + cooldown), 5
 * Review (describeAlert sentence + contract hidden fields + Save button
 * that posts to the real `/gui/alerts` route).
 *
 * `reply.viewAsync()` always wraps a template in the global page layout in
 * this codebase — a per-call bare fragment isn't possible. So:
 *   - `GET /alerts/new` and `GET /alerts/:id/edit-wizard` render the full
 *     page (`alert-wizard.eta`) with the current step's body pre-rendered
 *     as a trusted HTML string (`renderStepBody`) passed via `it.bodyHtml`.
 *   - `POST /alerts/new/step` returns `renderStepBody(...)` directly as a
 *     raw HTML fragment (status 200 on success, 400 + `pas-error-card` on
 *     validation failure) — no layout — for the htmx `#wizard-body` swap.
 *
 * Every step form carries `step` + all prior fields as hidden inputs so
 * values survive validation errors without any client-side JS state (the
 * I8 fix pattern, same as the report wizard).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AlertService } from '../../services/alerts/index.js';
import type { FileIndexEntry, FileIndexService } from '../../services/file-index/index.js';
import type { ReportService } from '../../services/reports/index.js';
import type { SpaceService } from '../../services/spaces/index.js';
import type { UserManager } from '../../services/user-manager/index.js';
import type { AlertAction, AlertDefinition } from '../../types/alert.js';
import { escapeHtml } from '../../utils/escape-html.js';
import { describeAlert } from '../utils/describe-automation.js';
import { humanizeLabel } from '../utils/humanize.js';
import { RULE_PATTERNS, buildExpression, parseExpression } from '../utils/rule-builder.js';
import {
	PRESETS,
	cronToPresetId,
	nextRunPreview,
	presetToCron,
} from '../utils/schedule-presets.js';

export interface AlertWizardRoutesOptions {
	alertService: AlertService;
	userManager: UserManager;
	fileIndex?: Pick<FileIndexService, 'getEntries'>;
	// Only `listSpaces` is used — the wizard is admin-only, so every space is
	// shown (no per-user membership filter like the member-facing routes).
	spaceService?: Pick<SpaceService, 'listSpaces'>;
	// Only `listReports` is used — powers the run_report action's report
	// picker (select of existing reports instead of a raw ID text input).
	reportService?: Pick<ReportService, 'listReports'>;
	dataDir: string;
	timezone: string;
	logger: Logger;
}

const MAX_WIZARD_ITEMS = 20;

function isPlatformAdmin(request: FastifyRequest): boolean {
	return !request.user || request.user.isPlatformAdmin;
}

function forbidden(reply: FastifyReply): Promise<FastifyReply> {
	return reply
		.status(403)
		.viewAsync('403', { title: '403 Forbidden — PAS' }) as unknown as Promise<FastifyReply>;
}

/** Hidden `<input type="hidden">` for every entry in `values`, skipping `exclude`. */
function hiddenFields(values: Record<string, string>, exclude: Set<string> = new Set()): string {
	return Object.entries(values)
		.filter(([k]) => !exclude.has(k))
		.map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
		.join('\n');
}

function errorCard(message: string): string {
	return `<div class="pas-error-card" role="alert"><strong>Couldn't continue.</strong><p>${escapeHtml(message)}</p></div>`;
}

/** Field names step 1's data-source cards render as VISIBLE inputs, for every card index. */
function step1DataSourceFieldNames(): Set<string> {
	const names = new Set<string>();
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		names.add(`ds_app_id_${i}`);
		names.add(`ds_scope_${i}`);
		names.add(`ds_user_id_${i}`);
		names.add(`ds_space_id_${i}`);
		names.add(`ds_path_${i}`);
	}
	return names;
}

/** Count how many `ds_app_id_{i}` fields are present in the submitted values. */
function countDataSources(values: Record<string, string>): number {
	let count = 0;
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		if (values[`ds_app_id_${i}`]) count++;
	}
	return count;
}

/**
 * The six action types the `parseFormToAlert` contract (alerts.ts) supports,
 * in picker display order. The wizard's step 4 renders exactly one action
 * (single-action scope — see module doc); the legacy Advanced editor
 * (alert-edit.eta) remains the path for multi-action alerts.
 */
const ACTION_TYPES = [
	'telegram_message',
	'run_report',
	'webhook',
	'write_data',
	'audio',
	'dispatch_message',
] as const;

/** Every per-type action config field name for index `i`, across all six action types. */
function actionFieldNames(i: number): string[] {
	return [
		`action_message_${i}`,
		`action_llm_summary_${i}`,
		`action_report_id_${i}`,
		`action_webhook_url_${i}`,
		`action_webhook_include_data_${i}`,
		`action_wd_app_id_${i}`,
		`action_wd_user_id_${i}`,
		`action_wd_path_${i}`,
		`action_wd_content_${i}`,
		`action_wd_mode_${i}`,
		`action_audio_message_${i}`,
		`action_audio_device_${i}`,
		`action_dispatch_text_${i}`,
		`action_dispatch_user_id_${i}`,
	];
}

/** Field names step 4's action picker + config fields render as VISIBLE inputs, for every action index. */
function step4ActionFieldNames(): Set<string> {
	const names = new Set<string>();
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		names.add(`action_type_${i}`);
		for (const name of actionFieldNames(i)) names.add(name);
	}
	return names;
}

/**
 * Render the per-type config fields for a single action, given its type and
 * the wizard's accumulated `values` (used for echoing back prior input on a
 * validation-error re-render, and for edit-wizard prefill). `index` is the
 * action's position (always 0 for the single-action wizard scope; multi-
 * action passthrough carries indices 0..N-1 through as opaque hidden fields
 * instead of calling this renderer).
 */
function renderActionConfigFields(
	type: string,
	index: number,
	values: Record<string, string>,
	reports: Array<{ id: string; name: string }>,
): string {
	const v = (name: string) => escapeHtml(values[`${name}_${index}`] || '');

	if (type === 'run_report') {
		if (reports.length > 0) {
			const options = reports
				.map(
					(r) =>
						`<option value="${escapeHtml(r.id)}" ${values[`action_report_id_${index}`] === r.id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`,
				)
				.join('');
			return `<label>Report
				<select name="action_report_id_${index}"><option value="">-- Select report --</option>${options}</select>
			</label>`;
		}
		return `<label>Report ID<input type="text" name="action_report_id_${index}" value="${v('action_report_id')}" placeholder="weekly-digest" /></label>`;
	}

	if (type === 'webhook') {
		const includeChecked =
			values[`action_webhook_include_data_${index}`] === 'true' ? 'checked' : '';
		return `<label>Webhook URL<input type="url" name="action_webhook_url_${index}" value="${v('action_webhook_url')}" placeholder="https://n8n.example.com/webhook/..." /></label>
			<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
				<input type="checkbox" name="action_webhook_include_data_${index}" value="true" ${includeChecked} />
				Include the trigger data in the webhook payload
			</label>`;
	}

	if (type === 'write_data') {
		// Contract note: WriteDataActionConfig.mode is 'write' | 'append'
		// (alert-validator.ts rejects anything else) — alert-edit.eta's legacy
		// select uses the same two values, labeled "Replace file contents" /
		// "Add to end of file".
		const mode = values[`action_wd_mode_${index}`] || 'append';
		return `<label>Save to app (ID)<input type="text" name="action_wd_app_id_${index}" value="${v('action_wd_app_id')}" placeholder="food" /></label>
			<label>For user (ID)<input type="text" name="action_wd_user_id_${index}" value="${v('action_wd_user_id')}" /></label>
			<label>File path<input type="text" name="action_wd_path_${index}" value="${v('action_wd_path')}" placeholder="alert-log/{date}.md" /></label>
			<label>What to write<textarea name="action_wd_content_${index}" rows="2" placeholder="Alert: {alert_name} fired on {date}">${v('action_wd_content')}</textarea></label>
			<label>Write mode
				<select name="action_wd_mode_${index}">
					<option value="append" ${mode === 'append' ? 'selected' : ''}>Add to end of file</option>
					<option value="write" ${mode === 'write' ? 'selected' : ''}>Replace file contents</option>
				</select>
			</label>`;
	}

	if (type === 'audio') {
		return `<label>What to say<input type="text" name="action_audio_message_${index}" value="${v('action_audio_message')}" placeholder="Attention! {alert_name} has been triggered." /></label>
			<label>Speaker (optional)<input type="text" name="action_audio_device_${index}" value="${v('action_audio_device')}" placeholder="Leave blank for default speaker" /></label>`;
	}

	if (type === 'dispatch_message') {
		return `<label>Message to send<input type="text" name="action_dispatch_text_${index}" value="${v('action_dispatch_text')}" placeholder="/note Alert: {alert_name} fired" /></label>
			<label>Send as user (ID)<input type="text" name="action_dispatch_user_id_${index}" value="${v('action_dispatch_user_id')}" /></label>`;
	}

	// Default / telegram_message.
	const summaryChecked = values[`action_llm_summary_${index}`] === 'true' ? 'checked' : '';
	return `<label>Message
			<textarea name="action_message_${index}" rows="2" id="action-message-${index}">${v('action_message')}</textarea>
		</label>
		<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-${index}');t.value+='{data}';})()">Insert {data}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-${index}');t.value+='{summary}';})()">Insert {summary}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-${index}');t.value+='{alert_name}';})()">Insert {alert_name}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-${index}');t.value+='{date}';})()">Insert {date}</button>
		</div>
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="checkbox" name="action_llm_summary_${index}" value="true" ${summaryChecked} />
			Add an AI summary of what was found
		</label>`;
}

/** Render the action-type picker (radio cards, one selectable action) + the selected type's config fields. */
function renderActionPicker(
	values: Record<string, string>,
	reports: Array<{ id: string; name: string }>,
): string {
	const selectedType = values.action_type_0 || 'telegram_message';
	const cards = ACTION_TYPES.map((type) => {
		const checked = selectedType === type ? 'checked' : '';
		return `<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="action_type_0" value="${type}" ${checked}
				hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML"
				hx-include="closest form" hx-vals='{"action_type_changed":"1"}' hx-trigger="change" />
			${escapeHtml(humanizeLabel(type))}
		</label>`;
	}).join('\n');

	return `<div class="pas-action-picker">
		${cards}
		<p><small>Need several actions? Use the Advanced editor.</small></p>
	</div>
	<div class="pas-action-fields">
		${renderActionConfigFields(selectedType, 0, values, reports)}
	</div>`;
}

interface FriendlyDataSource {
	appId: string;
	scope: FileIndexEntry['scope'];
	owner: string | null;
	path: string;
	label: string;
}

/** Friendly label for a data-source entry: app name + basename, never a raw path. */
function friendlyDataSourceLabel(entry: FileIndexEntry): string {
	const base = entry.path.split('/').pop() ?? entry.path;
	const dot = base.lastIndexOf('.');
	const nameNoExt = dot > 0 ? base.slice(0, dot) : base;
	return `${humanizeLabel(entry.appId)} ${nameNoExt}`;
}

/**
 * Derive the app-relative path (what `AlertDataSource.path` expects — a
 * path within the user's/space's app data directory, e.g. "pantry.md" or
 * "recipes/tacos.yaml") from a FileIndexEntry's data-root-relative `path`
 * (e.g. "users/matt/food/pantry.md"). Mirrors `parsePathMeta`'s offset
 * table (`entry-parser.ts`) — `FileIndexEntry` doesn't expose the offset
 * directly, so it's re-derived here from the segment count and scope.
 */
function appRelativePath(entry: FileIndexEntry): string {
	const parts = entry.path.split('/');
	let offset = 3; // users/<id>/<app>/... or spaces/<id>/<app>/... or collaborations/<id>/<app>/...
	if (parts[0] === 'households') {
		const segment2 = parts[2];
		offset = segment2 === 'shared' ? 4 : 5; // households/<hh>/shared/<app>/... vs .../users|spaces/<id>/<app>/...
	}
	return parts.slice(offset).join('/') || entry.path;
}

/**
 * Organize FileIndexService entries by scope for the data-source picker.
 * `FileIndexFilter` has no household/space-membership fields, so this
 * function filters the returned entries itself. The wizard is admin-only,
 * so admin sees all scopes (own, shared, every space) organized by
 * section — never raw paths, only friendly app + basename labels.
 */
function organizeDataSources(
	entries: FileIndexEntry[],
	spaces: Array<{ id: string; name: string }>,
): {
	own: FriendlyDataSource[];
	shared: FriendlyDataSource[];
	bySpace: Map<string, FriendlyDataSource[]>;
} {
	const own: FriendlyDataSource[] = [];
	const shared: FriendlyDataSource[] = [];
	const bySpace = new Map<string, FriendlyDataSource[]>();

	for (const entry of entries) {
		const friendly: FriendlyDataSource = {
			appId: entry.appId,
			scope: entry.scope,
			owner: entry.owner,
			path: appRelativePath(entry),
			label: friendlyDataSourceLabel(entry),
		};
		if (entry.scope === 'user') {
			own.push(friendly);
		} else if (entry.scope === 'shared') {
			shared.push(friendly);
		} else if ((entry.scope === 'space' || entry.scope === 'collaboration') && entry.owner) {
			// Collaboration-scope entries (`collaborations/<sId>/<appId>/...`) use
			// the same id space as `SpaceService.listSpaces()` ids (entry-parser.ts
			// sets `owner` to the collaboration space id), and `AlertDataSource`
			// only has a single `space_id` field with no kind discriminant — the
			// alert condition/action resolution path (AlertService, DataQuery)
			// already branches on `SpaceDefinition.kind` internally when reading
			// `space_id`. So collaboration spaces are grouped under their space
			// section exactly like household-kind spaces, rather than dropped.
			const list = bySpace.get(entry.owner) ?? [];
			list.push(friendly);
			bySpace.set(entry.owner, list);
		}
	}

	// Ensure every space appears in the map (even with zero files) so the
	// picker can render a section per space.
	for (const space of spaces) {
		if (!bySpace.has(space.id)) bySpace.set(space.id, []);
	}

	return { own, shared, bySpace };
}

// ---------------------------------------------------------------------------
// Step body renderers — each returns a trusted HTML string (no layout).
// ---------------------------------------------------------------------------

function renderStep1(
	values: Record<string, string>,
	dataSources: {
		own: FriendlyDataSource[];
		shared: FriendlyDataSource[];
		bySpace: Map<string, FriendlyDataSource[]>;
	},
	spaces: Array<{ id: string; name: string }>,
	csrfToken: string,
	error?: string,
): string {
	let nextIndex = 0;
	const usedIndices = new Map<string, number>(); // `${appId}::${path}` -> index

	function keyFor(appId: string, path: string): string {
		return `${appId}::${path}`;
	}

	// Recover which sources were previously checked (from prior submission's
	// hidden echo) so re-render preserves checkbox state after an error.
	const previouslySelected = new Set<string>();
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		const appId = values[`ds_app_id_${i}`];
		const path = values[`ds_path_${i}`];
		if (appId && path) previouslySelected.add(keyFor(appId, path));
	}

	function cardFor(source: FriendlyDataSource): string {
		const key = keyFor(source.appId, source.path);
		let index = usedIndices.get(key);
		if (index === undefined) {
			index = nextIndex++;
			usedIndices.set(key, index);
		}
		const checked = previouslySelected.has(key) ? 'checked' : '';
		// Collaboration-scope sources are submitted with ds_scope=space (same as
		// household-kind spaces) — parseFormToAlert's AlertDataSource contract
		// only distinguishes space_id vs user_id, with no kind discriminant.
		const scopeField =
			source.scope === 'space' || source.scope === 'collaboration'
				? `<input type="hidden" name="ds_scope_${index}" value="space" />` +
					`<input type="hidden" name="ds_space_id_${index}" value="${escapeHtml(source.owner ?? '')}" />`
				: source.scope === 'user'
					? `<input type="hidden" name="ds_scope_${index}" value="user" />` +
						`<input type="hidden" name="ds_user_id_${index}" value="${escapeHtml(source.owner ?? '')}" />`
					: `<input type="hidden" name="ds_scope_${index}" value="shared" />`;

		return `<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="checkbox" name="ds_app_id_${index}" value="${escapeHtml(source.appId)}" ${checked} />
			${escapeHtml(source.label)}
			<input type="hidden" name="ds_path_${index}" value="${escapeHtml(source.path)}" />
			${scopeField}
		</label>`;
	}

	const ownSection =
		dataSources.own.length > 0
			? `<h3>Your data</h3>${dataSources.own.map(cardFor).join('\n')}`
			: '';
	const sharedSection =
		dataSources.shared.length > 0
			? `<h3>Shared data</h3>${dataSources.shared.map(cardFor).join('\n')}`
			: '';
	const spaceSections = spaces
		.map((space) => {
			const list = dataSources.bySpace.get(space.id) ?? [];
			if (list.length === 0) return '';
			return `<h3>${escapeHtml(space.name)}</h3>${list.map(cardFor).join('\n')}`;
		})
		.join('\n');

	const noSources =
		dataSources.own.length === 0 &&
		dataSources.shared.length === 0 &&
		[...dataSources.bySpace.values()].every((l) => l.length === 0)
			? '<p class="empty-state">No data files found yet. Once an app writes some data, it will show up here.</p>'
			: '';

	// A previously-selected data source (e.g. prefilled from an existing
	// alert being edited) may no longer be present in the live file index
	// (deleted, or the index hasn't rebuilt yet). Render any such orphaned
	// selections as already-checked "currently watching" rows so editing an
	// alert never silently drops a configured data source.
	const orphanedCards: string[] = [];
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		const appId = values[`ds_app_id_${i}`];
		const path = values[`ds_path_${i}`];
		if (!appId || !path) continue;
		if (usedIndices.has(keyFor(appId, path))) continue; // already rendered by a picker section above
		const scope = (values[`ds_scope_${i}`] as FileIndexEntry['scope']) || 'user';
		orphanedCards.push(
			cardFor({
				appId,
				path,
				scope,
				owner:
					scope === 'space'
						? values[`ds_space_id_${i}`] || null
						: values[`ds_user_id_${i}`] || null,
				label: `${humanizeLabel(appId)} ${
					path
						.split('/')
						.pop()
						?.replace(/\.[^.]+$/, '') ?? path
				}`,
			}),
		);
	}
	const currentlyWatchingSection =
		orphanedCards.length > 0 ? `<h3>Currently watching</h3>${orphanedCards.join('\n')}` : '';

	return `<form hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/alerts/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="1" />
		${hiddenFields(values, new Set(['step', '_csrf', ...step1DataSourceFieldNames()]))}
		<h2>What should we watch?</h2>
		${error ? errorCard(error) : ''}
		${noSources}
		${currentlyWatchingSection}
		${ownSection}
		${sharedSection}
		${spaceSections}
		<button type="submit" style="min-height:44px">Next: When</button>
	</form>`;
}

function renderStep2(values: Record<string, string>, csrfToken: string, error?: string): string {
	const triggerType = values.trigger_type || 'scheduled';
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

	return `<form hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/alerts/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="2" />
		${hiddenFields(values, new Set(['step', '_csrf', 'schedule', 'trigger_type', 'trigger_event_name']))}
		<h2>When should we check?</h2>
		${error ? errorCard(error) : ''}
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="trigger_type" value="scheduled" ${triggerType === 'scheduled' ? 'checked' : ''} />
			On a schedule
		</label>
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="trigger_type" value="event" ${triggerType === 'event' ? 'checked' : ''} />
			When data changes
		</label>
		<div>
			${presetCards}
			<label>Hour (0-23)<input type="number" name="preset_hour" value="${hour}" min="0" max="23" /></label>
			<label>Minute<input type="number" name="preset_minute" value="${minute}" min="0" max="59" /></label>
			<label>Day of week (0=Sun..6=Sat, weekly only)<input type="number" name="preset_weekday" value="${weekday}" min="0" max="6" /></label>
			<details>
				<summary>Advanced: raw cron schedule</summary>
				<label>Cron expression<input type="text" name="schedule_advanced" value="${escapeHtml(currentSchedule)}" placeholder="0 7 * * *" /></label>
			</details>
		</div>
		<label>Event name (advanced)<input type="text" name="trigger_event_name" value="${escapeHtml(values.trigger_event_name || '')}" placeholder="data:changed" /></label>
		<button type="submit" style="min-height:44px">Next: Condition</button>
	</form>`;
}

function renderStep3(values: Record<string, string>, csrfToken: string, error?: string): string {
	const conditionMode = values.condition_mode || 'rule';
	const rulePattern = values.rule_pattern || 'contains';

	const patternOptions = RULE_PATTERNS.map(
		(p) =>
			`<option value="${escapeHtml(p.id)}" ${rulePattern === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`,
	).join('');

	return `<form hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/alerts/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="3" />
		${hiddenFields(values, new Set(['step', '_csrf', 'condition_mode', 'rule_pattern', 'rule_text', 'rule_n', 'fuzzy_text', 'condition_advanced']))}
		<h2>What should trigger it?</h2>
		${error ? errorCard(error) : ''}
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="condition_mode" value="rule" ${conditionMode === 'rule' ? 'checked' : ''} />
			Use a simple rule
		</label>
		<div>
			<label>Rule<select name="rule_pattern">${patternOptions}</select></label>
			<label>Text to look for<input type="text" name="rule_text" value="${escapeHtml(values.rule_text || '')}" /></label>
			<label>Number of lines<input type="number" name="rule_n" value="${escapeHtml(values.rule_n || '0')}" min="0" /></label>
		</div>
		<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
			<input type="radio" name="condition_mode" value="fuzzy" ${conditionMode === 'fuzzy' ? 'checked' : ''} />
			Describe it in your own words (AI judges)
		</label>
		<div>
			<label>Question<textarea name="fuzzy_text" rows="2" placeholder="Is anything about to spoil?">${escapeHtml(values.fuzzy_text || '')}</textarea></label>
		</div>
		<details ${conditionMode === 'advanced' ? 'open' : ''}>
			<summary>Advanced: raw expression</summary>
			<label style="display:flex;align-items:center;gap:0.5rem;min-height:44px">
				<input type="radio" name="condition_mode" value="advanced" ${conditionMode === 'advanced' ? 'checked' : ''} />
				Use a raw expression
			</label>
			<label>Expression<input type="text" name="condition_advanced" value="${escapeHtml(values.condition_advanced || '')}" placeholder='line count > 5' /></label>
		</details>
		<button type="submit" style="min-height:44px">Next: What happens</button>
	</form>`;
}

/**
 * Whether `values` carries more than one action (from an edit-prefill of an
 * alert with multiple actions). The wizard's step 4 can only represent a
 * single action — see module doc and the "Lossless edit prefill" tests —
 * so when `action_type_1` is present the action picker is suppressed in
 * favor of a passthrough notice, and every action_*_N field is carried
 * through to Review unchanged via `hiddenFields`.
 */
function isMultiAction(values: Record<string, string>): boolean {
	return Boolean(values.action_type_1);
}

/** Count how many `action_type_{i}` fields are present in the submitted values. */
function countActions(values: Record<string, string>): number {
	let count = 0;
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		if (values[`action_type_${i}`]) count++;
	}
	return count;
}

function renderStep4(
	values: Record<string, string>,
	users: Array<{ id: string; name: string }>,
	reports: Array<{ id: string; name: string }>,
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

	const cooldownN = values.cooldown_n || '4';
	const cooldownUnit = values.cooldown_unit || 'hours';

	const multiAction = isMultiAction(values);
	const actionSection = multiAction
		? `<div class="pas-error-card" role="status">
				<strong>This alert has ${countActions(values)} actions.</strong>
				<p>The guided wizard can only edit a single action. Use the Advanced editor to change these — they'll be saved unchanged if you continue here.</p>
			</div>`
		: renderActionPicker(values, reports);

	// step4ActionFieldNames() covers step 4's own VISIBLE action inputs so a
	// validation-error re-render never emits a <input type="hidden"> with the
	// same name as a visible one (the Batch 3 hardening pattern). In
	// multi-action passthrough mode there is no visible action input at all —
	// every action_*_N field must survive as a hidden field instead, so it is
	// deliberately NOT excluded in that branch.
	const exclude = new Set([
		'step',
		'_csrf',
		'delivery',
		'name',
		'id',
		'description',
		'cooldown_n',
		'cooldown_unit',
		'action_type_changed',
	]);
	if (!multiAction) {
		for (const name of step4ActionFieldNames()) exclude.add(name);
	}

	return `<form hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/alerts/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="4" />
		${hiddenFields(values, exclude)}
		<h2>What should happen?</h2>
		${error ? errorCard(error) : ''}
		<label>Alert name<input type="text" name="name" value="${escapeHtml(values.name || '')}" required /></label>
		<label>Alert ID (lowercase, hyphens)<input type="text" name="id" value="${escapeHtml(values.id || '')}" pattern="[a-z][a-z0-9-]*" required /></label>
		<label>Description<input type="text" name="description" value="${escapeHtml(values.description || '')}" /></label>
		<h3>Send to</h3>
		${userChecks}
		<h3>Action</h3>
		${actionSection}
		<h3>Don't repeat this alert too often</h3>
		<label>Wait at least
			<input type="number" name="cooldown_n" value="${escapeHtml(cooldownN)}" min="0" style="width:6rem;display:inline-block" />
			<select name="cooldown_unit">
				<option value="minutes" ${cooldownUnit === 'minutes' ? 'selected' : ''}>minutes</option>
				<option value="hours" ${cooldownUnit === 'hours' ? 'selected' : ''}>hours</option>
				<option value="days" ${cooldownUnit === 'days' ? 'selected' : ''}>days</option>
			</select>
			before repeating
		</label>
		<button type="submit" style="min-height:44px">Next: Review</button>
	</form>`;
}

function renderStep5(values: Record<string, string>, csrfToken: string, timezone: string): string {
	const def = buildAlertDefinitionFromWizardValues(values);
	const sentence = describeAlert(def);

	return `<div>
		<h2>Review</h2>
		<p class="pas-describe-sentence">${escapeHtml(sentence)}</p>
		${values.schedule && values.trigger_type !== 'event' ? `<p><small>${escapeHtml(nextRunPreview(values.schedule, timezone))}</small></p>` : ''}
		<form method="post" action="/gui/alerts">
			<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
			<input type="hidden" name="step" value="5" />
			${hiddenFields(values, new Set(['step', '_csrf']))}
			<input type="hidden" name="enabled" value="true" />
			<button type="submit" style="min-height:44px">Save alert</button>
		</form>
	</div>`;
}

/** Build an AlertDefinition from the wizard's accumulated hidden-field values, for the review sentence. */
function buildAlertDefinitionFromWizardValues(values: Record<string, string>): AlertDefinition {
	const dataSources: AlertDefinition['condition']['data_sources'] = [];
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		const appId = values[`ds_app_id_${i}`];
		if (!appId) continue;
		const scope = values[`ds_scope_${i}`];
		if (scope === 'space') {
			dataSources.push({
				app_id: appId,
				space_id: values[`ds_space_id_${i}`] || '',
				path: values[`ds_path_${i}`] || '',
			});
		} else {
			dataSources.push({
				app_id: appId,
				user_id: values[`ds_user_id_${i}`] || '',
				path: values[`ds_path_${i}`] || '',
			});
		}
	}

	const actions: AlertAction[] = [];
	for (let i = 0; i < MAX_WIZARD_ITEMS; i++) {
		const type = values[`action_type_${i}`];
		if (!type) continue;
		if (type === 'telegram_message') {
			actions.push({
				type: 'telegram_message',
				config: { message: values[`action_message_${i}`] || '' },
			});
		}
	}

	const delivery = (values.delivery || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	const triggerType = values.trigger_type === 'event' ? 'event' : 'scheduled';

	return {
		id: values.id || '',
		name: values.name || '',
		description: values.description || undefined,
		enabled: true,
		schedule: values.schedule || '',
		trigger:
			triggerType === 'event'
				? { type: 'event', event_name: values.trigger_event_name || '' }
				: { type: 'scheduled', schedule: values.schedule || '' },
		condition: {
			type: (values.condition_type as 'deterministic' | 'fuzzy') || 'deterministic',
			expression: values.condition_expression || '',
			data_sources: dataSources,
		},
		actions,
		delivery,
		cooldown: values.cooldown || '',
	};
}

export function registerAlertWizardRoutes(
	server: FastifyInstance,
	options: AlertWizardRoutesOptions,
): void {
	const { userManager, fileIndex, spaceService, reportService, timezone } = options;

	function getUsers() {
		return userManager.getAllUsers().map((u) => ({ id: u.id, name: u.name }));
	}

	function getSpaces(): Array<{ id: string; name: string }> {
		return spaceService?.listSpaces().map((s) => ({ id: s.id, name: s.name })) ?? [];
	}

	function getDataSources() {
		const entries = fileIndex?.getEntries() ?? [];
		return organizeDataSources(entries, getSpaces());
	}

	async function getReports(): Promise<Array<{ id: string; name: string }>> {
		if (!reportService) return [];
		const reports = await reportService.listReports();
		return reports.map((r) => ({ id: r.id, name: r.name }));
	}

	function getCsrfToken(request: FastifyRequest): string {
		return ((request as unknown as Record<string, unknown>).csrfToken as string | undefined) ?? '';
	}

	// --- Wizard entry (create) ---
	server.get('/alerts/new', async (request: FastifyRequest, reply: FastifyReply) => {
		if (!isPlatformAdmin(request)) return forbidden(reply);

		const csrfToken = getCsrfToken(request);
		const bodyHtml = renderStep1({}, getDataSources(), getSpaces(), csrfToken);
		return reply.viewAsync('alert-wizard', {
			title: 'Set up an alert — PAS',
			activePage: 'alerts',
			bodyHtml,
		});
	});

	// --- Wizard entry (edit — prefill from an existing definition) ---
	server.get(
		'/alerts/:id/edit-wizard',
		async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
			if (!isPlatformAdmin(request)) return forbidden(reply);

			const alert = await options.alertService.getAlert(request.params.id);
			if (!alert) {
				return reply.code(404).send('Alert not found');
			}

			const values: Record<string, string> = {
				id: alert.id,
				name: alert.name,
				description: alert.description ?? '',
				schedule: alert.trigger?.schedule ?? alert.schedule ?? '',
				trigger_type: alert.trigger?.type ?? 'scheduled',
				trigger_event_name: alert.trigger?.event_name ?? '',
				delivery: (alert.delivery ?? []).join(', '),
				cooldown: alert.cooldown ?? '',
			};
			(alert.condition?.data_sources ?? []).forEach((source, i) => {
				values[`ds_app_id_${i}`] = source.app_id;
				values[`ds_path_${i}`] = source.path;
				if (source.space_id) {
					values[`ds_scope_${i}`] = 'space';
					values[`ds_space_id_${i}`] = source.space_id;
				} else {
					values[`ds_scope_${i}`] = 'user';
					values[`ds_user_id_${i}`] = source.user_id ?? '';
				}
			});
			values.condition_type = alert.condition?.type ?? 'deterministic';
			values.condition_expression = alert.condition?.expression ?? '';
			if (values.condition_type === 'fuzzy') {
				values.condition_mode = 'fuzzy';
				values.fuzzy_text = values.condition_expression;
			} else {
				const parsed = parseExpression(values.condition_expression);
				if (parsed) {
					values.condition_mode = 'rule';
					values.rule_pattern = parsed.pattern;
					if (parsed.pattern === 'contains' || parsed.pattern === 'not_contains') {
						values.rule_text = parsed.text;
					} else if (parsed.pattern === 'more_lines' || parsed.pattern === 'fewer_lines') {
						values.rule_n = String(parsed.n);
					}
				} else {
					values.condition_mode = 'advanced';
					values.condition_advanced = values.condition_expression;
				}
			}
			// Critical 2 fix: copy action_type_i AND every per-type config field for
			// EVERY action (not just telegram_message on index 0) — previously
			// only telegram_message's `message` was copied, so editing an alert
			// whose first action was webhook/write_data/run_report/audio/
			// dispatch_message silently converted it to an empty telegram action
			// on save. When there is more than one action, the wizard cannot
			// represent them (single-action scope) — all actions are still
			// copied here so they survive as an opaque lossless passthrough
			// (renderStep4 detects `action_type_1` and suppresses the picker).
			(alert.actions ?? []).forEach((action, i) => {
				values[`action_type_${i}`] = action.type;
				const config = action.config as unknown as Record<string, unknown>;
				if (action.type === 'telegram_message') {
					values[`action_message_${i}`] = String(config.message ?? '');
					const llmSummary = config.llm_summary as { enabled?: boolean } | undefined;
					if (llmSummary?.enabled) values[`action_llm_summary_${i}`] = 'true';
				} else if (action.type === 'run_report') {
					values[`action_report_id_${i}`] = String(config.report_id ?? '');
				} else if (action.type === 'webhook') {
					values[`action_webhook_url_${i}`] = String(config.url ?? '');
					if (config.include_data) values[`action_webhook_include_data_${i}`] = 'true';
				} else if (action.type === 'write_data') {
					values[`action_wd_app_id_${i}`] = String(config.app_id ?? '');
					values[`action_wd_user_id_${i}`] = String(config.user_id ?? '');
					values[`action_wd_path_${i}`] = String(config.path ?? '');
					values[`action_wd_content_${i}`] = String(config.content ?? '');
					values[`action_wd_mode_${i}`] = String(config.mode ?? 'append');
				} else if (action.type === 'audio') {
					values[`action_audio_message_${i}`] = String(config.message ?? '');
					if (config.device) values[`action_audio_device_${i}`] = String(config.device);
				} else if (action.type === 'dispatch_message') {
					values[`action_dispatch_text_${i}`] = String(config.text ?? '');
					values[`action_dispatch_user_id_${i}`] = String(config.user_id ?? '');
				}
			});

			const csrfToken = getCsrfToken(request);
			const bodyHtml = renderStep1(values, getDataSources(), getSpaces(), csrfToken);
			return reply.viewAsync('alert-wizard', {
				title: `Edit ${alert.name} — PAS`,
				activePage: 'alerts',
				bodyHtml,
			});
		},
	);

	// --- Step advance ---
	server.post(
		'/alerts/new/step',
		async (request: FastifyRequest<{ Body: Record<string, string> }>, reply: FastifyReply) => {
			if (!isPlatformAdmin(request)) {
				return reply
					.status(403)
					.type('text/html')
					.send(errorCard('Only an administrator can set up alerts.'));
			}

			const body = request.body ?? {};
			const step = Number.parseInt(body.step || '1', 10);
			const csrfToken = getCsrfToken(request);

			if (step === 1) {
				const count = countDataSources(body);
				if (count === 0) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep1(
								body,
								getDataSources(),
								getSpaces(),
								csrfToken,
								'Pick at least one thing to watch.',
							),
						);
				}
				const next = { ...body, step: '2' };
				return reply.type('text/html').send(renderStep2(next, csrfToken));
			}

			if (step === 2) {
				const triggerType = body.trigger_type === 'event' ? 'event' : 'scheduled';
				if (triggerType === 'event') {
					if (!(body.trigger_event_name || '').trim()) {
						return reply
							.status(400)
							.type('text/html')
							.send(renderStep2(body, csrfToken, 'Enter the event name to watch for.'));
					}
					const next = { ...body, step: '3', trigger_type: 'event' };
					return reply.type('text/html').send(renderStep3(next, csrfToken));
				}

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
						.send(renderStep2(body, csrfToken, 'Pick when this alert should run.'));
				}
				const next = { ...body, step: '3', schedule, trigger_type: 'scheduled' };
				return reply.type('text/html').send(renderStep3(next, csrfToken));
			}

			if (step === 3) {
				const mode = body.condition_mode || 'rule';
				let conditionType: 'deterministic' | 'fuzzy' = 'deterministic';
				let expression = '';

				if (mode === 'fuzzy') {
					conditionType = 'fuzzy';
					expression = (body.fuzzy_text || '').trim();
					if (!expression) {
						return reply
							.status(400)
							.type('text/html')
							.send(renderStep3(body, csrfToken, 'Describe what should trigger this alert.'));
					}
				} else if (mode === 'advanced') {
					expression = (body.condition_advanced || '').trim();
					if (!expression) {
						return reply
							.status(400)
							.type('text/html')
							.send(renderStep3(body, csrfToken, 'Enter the raw condition expression.'));
					}
				} else {
					const pattern = body.rule_pattern || 'contains';
					try {
						if (pattern === 'is_empty') {
							expression = buildExpression({ pattern: 'is_empty' });
						} else if (pattern === 'not_empty') {
							expression = buildExpression({ pattern: 'not_empty' });
						} else if (pattern === 'contains') {
							expression = buildExpression({ pattern: 'contains', text: body.rule_text || '' });
						} else if (pattern === 'not_contains') {
							expression = buildExpression({
								pattern: 'not_contains',
								text: body.rule_text || '',
							});
						} else if (pattern === 'more_lines') {
							expression = buildExpression({
								pattern: 'more_lines',
								n: Number.parseInt(body.rule_n || '0', 10),
							});
						} else if (pattern === 'fewer_lines') {
							expression = buildExpression({
								pattern: 'fewer_lines',
								n: Number.parseInt(body.rule_n || '0', 10),
							});
						} else {
							throw new Error('Unknown rule pattern.');
						}
					} catch (err) {
						const message = err instanceof Error ? err.message : 'That rule is not valid.';
						return reply
							.status(400)
							.type('text/html')
							.send(renderStep3(body, csrfToken, message));
					}
				}

				const next = {
					...body,
					step: '4',
					condition_type: conditionType,
					condition_expression: expression,
				};
				return reply
					.type('text/html')
					.send(renderStep4(next, getUsers(), await getReports(), csrfToken));
			}

			if (step === 4) {
				// Changing the action-type radio re-POSTs step 4 to re-render with
				// that type's config fields — no validation, just a re-render (the
				// htmx hx-vals marker on the radio; see renderActionPicker).
				if (body.action_type_changed) {
					const { action_type_changed, ...rest } = body;
					return reply
						.type('text/html')
						.send(renderStep4(rest, getUsers(), await getReports(), csrfToken));
				}

				const deliveryUsers = ([] as string[]).concat(
					(body as unknown as { delivery_user?: string | string[] }).delivery_user ?? [],
				);
				const delivery = deliveryUsers.filter(Boolean);
				if (!body.name || !body.id) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep4(
								{ ...body, delivery: delivery.join(', ') },
								getUsers(),
								await getReports(),
								csrfToken,
								'Give this alert a name and an ID.',
							),
						);
				}
				if (delivery.length === 0) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep4(
								{ ...body, delivery: delivery.join(', ') },
								getUsers(),
								await getReports(),
								csrfToken,
								'Choose at least one person to send it to.',
							),
						);
				}
				const cooldownN = Number.parseInt(body.cooldown_n || '0', 10);
				const cooldownUnit = body.cooldown_unit || 'hours';
				if (!Number.isFinite(cooldownN) || cooldownN <= 0) {
					return reply
						.status(400)
						.type('text/html')
						.send(
							renderStep4(
								{ ...body, delivery: delivery.join(', ') },
								getUsers(),
								await getReports(),
								csrfToken,
								'Enter how long to wait before repeating this alert.',
							),
						);
				}
				const cooldown = `${cooldownN} ${cooldownUnit}`;
				const next = { ...body, step: '5', delivery: delivery.join(', '), cooldown };
				return reply.type('text/html').send(renderStep5(next, csrfToken, timezone));
			}

			return reply
				.status(400)
				.type('text/html')
				.send(errorCard('Something went wrong with the wizard. Start again.'));
		},
	);
}
