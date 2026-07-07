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
		} else if (entry.scope === 'space' && entry.owner) {
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
		const scopeField =
			source.scope === 'space'
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

function renderStep4(
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

	const cooldownN = values.cooldown_n || '4';
	const cooldownUnit = values.cooldown_unit || 'hours';

	return `<form hx-post="/gui/alerts/new/step" hx-target="#wizard-body" hx-swap="innerHTML" method="post" action="/gui/alerts/new/step">
		<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}" />
		<input type="hidden" name="step" value="4" />
		${hiddenFields(values, new Set(['step', '_csrf', 'delivery', 'name', 'id', 'description', 'action_type_0', 'action_message_0', 'cooldown_n', 'cooldown_unit']))}
		<h2>What should happen?</h2>
		${error ? errorCard(error) : ''}
		<label>Alert name<input type="text" name="name" value="${escapeHtml(values.name || '')}" required /></label>
		<label>Alert ID (lowercase, hyphens)<input type="text" name="id" value="${escapeHtml(values.id || '')}" pattern="[a-z][a-z0-9-]*" required /></label>
		<label>Description<input type="text" name="description" value="${escapeHtml(values.description || '')}" /></label>
		<h3>Send to</h3>
		${userChecks}
		<h3>Action</h3>
		<input type="hidden" name="action_type_0" value="telegram_message" />
		<label>Message
			<textarea name="action_message_0" rows="2" id="action-message-0">${escapeHtml(values.action_message_0 || '')}</textarea>
		</label>
		<div style="display:flex;gap:0.5rem;flex-wrap:wrap">
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-0');t.value+='{data}';})()">Insert {data}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-0');t.value+='{summary}';})()">Insert {summary}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-0');t.value+='{alert_name}';})()">Insert {alert_name}</button>
			<button type="button" class="outline" onclick="(function(){var t=document.getElementById('action-message-0');t.value+='{date}';})()">Insert {date}</button>
		</div>
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
	const { userManager, fileIndex, spaceService, timezone } = options;

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
			(alert.actions ?? []).forEach((action, i) => {
				values[`action_type_${i}`] = action.type;
				if (action.type === 'telegram_message') {
					values[`action_message_${i}`] = (action.config as { message?: string }).message ?? '';
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
				return reply.type('text/html').send(renderStep4(next, getUsers(), csrfToken));
			}

			if (step === 4) {
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
