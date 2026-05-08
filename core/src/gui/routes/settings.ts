/**
 * Settings page routes — /gui/settings.
 *
 * Renders every per-user setting visible to the current user, grouped by
 * category in collapsible Pico <details> accordions. System-wide and
 * dangerous settings are visible to admin users only (Chunk C).
 *
 * Non-admin users see: personal, food, notes, memory-sessions, notifications.
 * Admin users additionally see: system, dangerous.
 *
 * Only the shared settingsAppConfigResolver is used here; existing
 * routes/apps.ts and routes/config.ts keep their own private caches.
 *
 * REQ-SETTINGS-002, 003, 004, 005, 014, 015, 016, 017, 018, 019, 020
 * REQ-SETTINGS-022, 023, 025, 026, 027, 031, 034, 035, 036
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { SystemConfig } from '../../types/config.js';
import type { AppConfigService } from '../../types/config.js';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../../services/settings/categories.js';
import type { SettingDef, SettingsCategory } from '../../services/settings/settings-registry.js';
import { qualifiedKey } from '../../services/settings/settings-registry.js';
import type { SettingsRegistry } from '../../services/settings/settings-registry.js';
import type { SettingsWriter, WriteRequest } from '../../services/settings/settings-writer.js';
import type { SystemConfigWriter } from '../../services/config/system-config-writer.js';
import { requirePlatformAdmin } from '../guards/require-platform-admin.js';
import { matchesDangerConfirmPhrase } from './settings-confirm-helpers.js';
import { escapeHtml } from '../../utils/escape-html.js';

const NON_ADMIN_CATEGORIES: readonly SettingsCategory[] = [
	'personal',
	'food',
	'notes',
	'memory-sessions',
	'notifications',
];

/** Categories visible to a given user. Admin sees all; non-admin sees standard set. */
function getVisibleCategories(isAdmin: boolean): readonly SettingsCategory[] {
	if (isAdmin) return [...NON_ADMIN_CATEGORIES, 'system', 'dangerous'];
	return NON_ADMIN_CATEGORIES;
}

const PARAM_PATTERN = /^[a-zA-Z0-9_.-]+$/;

export interface SettingsRoutesOptions {
	settingsRegistry: SettingsRegistry;
	settingsWriter: SettingsWriter;
	appConfigResolver: (appId: string) => AppConfigService | undefined;
	logger: Logger;
	/** Required for system-scope reads and resets (Chunk C). */
	systemConfigWriter?: SystemConfigWriter;
	/** In-memory SystemConfig — passed by reference so reads are always live. */
	systemConfig?: SystemConfig;
}

function getVisibleDefs(registry: SettingsRegistry, isAdmin: boolean): SettingDef[] {
	const visibleCats = getVisibleCategories(isAdmin);
	return registry
		.getForUser(isAdmin)
		.filter((def) => (visibleCats as readonly string[]).includes(def.category));
}

function fieldName(appId: string, key: string): string {
	return `${appId}__${key}`;
}

function presentFieldName(appId: string, key: string): string {
	return `${appId}__${key}__present`;
}

/** Render a single setting row as an HTML string (used by Reset endpoint and GET fallback). */
export function buildSettingRowHtml(
	def: SettingDef,
	currentValue: unknown,
	opts?: { errorMsg?: string; rawValue?: string },
): string {
	const fname = fieldName(def.appId, def.key);
	const safeLabel = escapeHtml(def.label);
	const safeHelp = escapeHtml(def.help);
	const safeAppId = escapeHtml(def.appId);
	const safeKey = escapeHtml(def.key);
	const errorMsg = opts?.errorMsg;
	const rawValue = opts?.rawValue;

	let widget = '';

	if (def.type === 'boolean') {
		const checked = Boolean(currentValue) ? 'checked' : '';
		const safePname = escapeHtml(presentFieldName(def.appId, def.key));
		const safeFname = escapeHtml(fname);
		widget = `<label>
      <input type="hidden" name="${safePname}" value="1" />
      <input type="checkbox" name="${safeFname}" ${checked} />
      ${safeLabel}
    </label>`;
	} else if (def.type === 'number') {
		const val = escapeHtml(rawValue ?? String(currentValue ?? ''));
		widget = `<input type="number" name="${escapeHtml(fname)}" value="${val}" />`;
	} else if (def.type === 'select') {
		const options = (def.options ?? [])
			.map((opt) => {
				const safeOpt = escapeHtml(opt);
				const selected = String(currentValue) === opt ? ' selected' : '';
				return `<option value="${safeOpt}"${selected}>${safeOpt}</option>`;
			})
			.join('');
		widget = `<select name="${escapeHtml(fname)}">${options}</select>`;
	} else {
		const val = escapeHtml(rawValue ?? String(currentValue ?? ''));
		widget = `<input type="text" name="${escapeHtml(fname)}" value="${val}" />`;
	}

	const errorHtml = errorMsg
		? `<small class="setting-error" style="color:var(--pico-del-color)">${escapeHtml(errorMsg)}</small>`
		: '';

	const restartBadge = def.restartRequired
		? `<small class="restart-badge" style="color:var(--pico-color-amber-500,#f59e0b);font-size:0.75rem;display:block;margin-top:0.25rem">&#9888; Restart required to take effect</small>`
		: '';

	const labelHtml =
		def.type !== 'boolean'
			? `<label for="sf-${escapeHtml(fname)}">${safeLabel}</label>`
			: '';

	// Dangerous rows: per-row Save (confirm flow) + Reset (confirm flow).
	// Standard rows: shared form Reset button.
	let actionsHtml: string;
	if (def.dangerous) {
		actionsHtml = `<button
    type="button"
    class="outline"
    style="font-size:0.8rem;padding:0.2rem 0.5rem"
    hx-get="/gui/settings/${safeAppId}/${safeKey}/confirm?action=set"
    hx-include="closest .setting-row"
    hx-target="#confirm-dialog"
  >Save&#8230;</button>
  <button
    type="button"
    class="outline secondary"
    style="font-size:0.8rem;padding:0.2rem 0.5rem"
    hx-get="/gui/settings/${safeAppId}/${safeKey}/confirm?action=reset"
    hx-target="#confirm-dialog"
  >Reset&#8230;</button>`;
	} else {
		actionsHtml = `<button
    type="button"
    class="outline secondary"
    style="font-size:0.8rem;padding:0.2rem 0.5rem"
    hx-post="/gui/settings/${safeAppId}/${safeKey}/reset"
    hx-target="closest .setting-row"
    hx-swap="outerHTML"
  >Reset</button>`;
	}

	return `<div class="setting-row${def.dangerous ? ' dangerous-row' : ''}" data-app="${safeAppId}" data-key="${safeKey}">
  <div class="setting-label">
    ${labelHtml}
    <small class="setting-help">${safeHelp}</small>
    ${restartBadge}
    ${errorHtml}
  </div>
  <div class="setting-widget">
    ${widget}
  </div>
  <div class="setting-actions">
    ${actionsHtml}
  </div>
</div>`;
}

async function readCurrentValues(
	visibleDefs: SettingDef[],
	userId: string,
	appConfigResolver: (appId: string) => AppConfigService | undefined,
	systemConfigWriter?: SystemConfigWriter,
	systemConfig?: SystemConfig,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const def of visibleDefs) {
		const qk = qualifiedKey(def.appId, def.key);
		if (def.scope === 'system') {
			if (systemConfigWriter && systemConfig) {
				try {
					out[qk] = systemConfigWriter.read(def.key, systemConfig);
				} catch {
					// Key not in allowlist — use default
				}
			}
			continue;
		}
		const cfg = appConfigResolver(def.appId);
		if (!cfg) continue;
		try {
			const all = await cfg.getAll(userId);
			out[qk] = all[def.key];
		} catch {
			// Leave missing — widget will show empty
		}
	}
	return out;
}

/** Build the confirm modal HTML for a dangerous action. Not wrapped in layout. */
function buildConfirmModalHtml(opts: {
	def: SettingDef;
	appId: string;
	key: string;
	action: 'set' | 'reset';
	proposedValue: string;
	coercionError: string;
	csrfToken: string;
	error: string;
}): string {
	const { def, appId, key, action, proposedValue, coercionError, csrfToken, error } = opts;
	const safeAppId = escapeHtml(appId);
	const safeKey = escapeHtml(key);
	const safeLabel = escapeHtml(def.label);
	const safePrompt = escapeHtml(def.dangerConfirmPrompt ?? 'confirm');
	const safeValue = escapeHtml(proposedValue);
	const safeError = error ? escapeHtml(error) : '';
	const safeCoercionError = coercionError ? escapeHtml(coercionError) : '';
	const safeCsrf = escapeHtml(csrfToken);

	const actionBody =
		action === 'set'
			? `<p>Proposed new value: <code>${safeValue}</code></p>
      ${safeCoercionError ? `<p><small style="color:var(--pico-del-color)">Invalid value: ${safeCoercionError}</small></p>` : ''}
      <input type="hidden" name="value" value="${safeValue}" />`
			: `<p>Action: <strong>reset to default</strong></p>`;

	const errorHtml = safeError
		? `<small style="color:var(--pico-del-color)">${safeError}</small>`
		: '';

	return `<dialog open>
  <article>
    <header><strong>${safeLabel}</strong></header>
    <p><em>This is a dangerous setting. To confirm, type the exact phrase below:</em></p>
    <blockquote>${safePrompt}</blockquote>
    ${actionBody}
    <form hx-post="/gui/settings/${safeAppId}/${safeKey}/confirm" hx-target="#confirm-dialog" hx-swap="innerHTML">
      <input type="hidden" name="_csrf" value="${safeCsrf}" />
      <input type="hidden" name="action" value="${escapeHtml(action)}" />
      <input type="text" name="phrase" autocomplete="off" autofocus placeholder="Type the phrase above to confirm" />
      ${errorHtml}
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
        <button type="submit" class="contrast">Confirm</button>
        <button type="button" onclick="this.closest('dialog').close();this.closest('dialog').innerHTML=''">Cancel</button>
      </div>
    </form>
  </article>
</dialog>`;
}

function groupByCategory(visibleDefs: SettingDef[]): Record<string, SettingDef[]> {
	const out: Record<string, SettingDef[]> = {};
	for (const def of visibleDefs) {
		const list = out[def.category] ?? [];
		list.push(def);
		out[def.category] = list;
	}
	return out;
}

export function registerSettingsRoutes(
	server: FastifyInstance,
	options: SettingsRoutesOptions,
): void {
	const { settingsRegistry, settingsWriter, appConfigResolver, logger, systemConfigWriter, systemConfig } = options;

	// -------------------------------------------------------------------------
	// GET /settings — render full accordion page
	// -------------------------------------------------------------------------
	server.get('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const userId = user.userId;
		const isAdmin = user.isPlatformAdmin;
		const visibleDefs = getVisibleDefs(settingsRegistry, isAdmin);
		const currentValues = await readCurrentValues(
			visibleDefs, userId, appConfigResolver, systemConfigWriter, systemConfig,
		);
		const byCategory = groupByCategory(visibleDefs);

		const savedParam = (request.query as Record<string, string>).saved;
		const partialParam = (request.query as Record<string, string>).partial;
		const failedParam = (request.query as Record<string, string>).failed;

		return reply.viewAsync('settings', {
			title: 'Settings — PAS',
			activePage: 'settings',
			byCategory,
			currentValues,
			categoryOrder: CATEGORY_ORDER,
			categoryLabels: CATEGORY_LABELS,
			visibleCategories: getVisibleCategories(isAdmin),
			isAdmin,
			saved: savedParam === '1',
			partial: partialParam === '1',
			failed: failedParam
				? failedParam
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean)
				: [],
			errors: {} as Record<string, string>,
			rawValues: {} as Record<string, string>,
		});
	});

	// -------------------------------------------------------------------------
	// POST /settings — save flow (validate-atomic + per-app-atomic persist)
	// -------------------------------------------------------------------------
	server.post('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const userId = user.userId;
		const isAdmin = user.isPlatformAdmin;
		const body = (request.body ?? {}) as Record<string, string>;
		const visibleDefs = getVisibleDefs(settingsRegistry, isAdmin);

		// Read current effective values for diffing
		const currentEffective = await readCurrentValues(
			visibleDefs, userId, appConfigResolver, systemConfigWriter, systemConfig,
		);

		// Build batch items — iterate registry defs (NOT posted fields)
		const items: WriteRequest[] = [];
		for (const def of visibleDefs) {
			const fname = fieldName(def.appId, def.key);
			const pname = presentFieldName(def.appId, def.key);

			const inBody = def.type === 'boolean' ? (pname in body) : (fname in body);

			// REQ-SETTINGS-035: dangerous keys must use the confirm flow.
			// Return 400 if a dangerous field appears in the body (tamper guard).
			if (def.dangerous) {
				if (inBody) {
					return reply.status(400).send(
						'Dangerous settings require the confirm flow. Direct POST rejected.',
					);
				}
				continue;
			}

			let rawValue: string;

			if (def.type === 'boolean') {
				if (!inBody) continue; // field not submitted — skip
				rawValue = fname in body ? 'true' : 'false';
			} else {
				if (!inBody) continue; // field not submitted — skip
				rawValue = body[fname] ?? '';
			}

			// Validate + coerce to diff against current effective value
			const validateResult = settingsWriter.validate({
				userId,
				appId: def.appId,
				key: def.key,
				rawValue,
				source: 'gui',
			});

			// Skip no-ops (same coerced value as current effective)
			if (validateResult.ok) {
				const current = currentEffective[qualifiedKey(def.appId, def.key)];
				if (JSON.stringify(validateResult.coerced) === JSON.stringify(current)) continue;
			}

			items.push({ userId, appId: def.appId, key: def.key, rawValue, source: 'gui' });
		}

		// Validation-atomic phase (pure, no I/O)
		const errors: Record<string, string> = {};
		const rawValues: Record<string, string> = {};
		for (const item of items) {
			const qk = qualifiedKey(item.appId, item.key);
			rawValues[qk] = item.rawValue;
			const result = settingsWriter.validate({
				userId: item.userId,
				appId: item.appId,
				key: item.key,
				rawValue: item.rawValue,
				source: 'gui',
			});
			if (!result.ok) {
				errors[qk] = result.reason;
			}
		}

		if (Object.keys(errors).length > 0) {
			const byCategory = groupByCategory(visibleDefs);
			return reply.status(400).viewAsync('settings', {
				title: 'Settings — PAS',
				activePage: 'settings',
				byCategory,
				currentValues: currentEffective,
				categoryOrder: CATEGORY_ORDER,
				categoryLabels: CATEGORY_LABELS,
				visibleCategories: getVisibleCategories(isAdmin),
				isAdmin,
				saved: false,
				partial: false,
				failed: [],
				errors,
				rawValues,
			});
		}

		if (items.length === 0) {
			return reply.redirect('/gui/settings?saved=1');
		}

		// Batch persist (per-app atomic, cross-app best-effort)
		const result = await settingsWriter.writeBatch(items);

		const failedApps = [...result.perApp.entries()]
			.filter(([, r]) => !r.ok)
			.map(([appId]) => appId);

		if (failedApps.length > 0) {
			return reply.redirect(
				`/gui/settings?partial=1&failed=${encodeURIComponent(failedApps.join(','))}`,
			);
		}

		return reply.redirect('/gui/settings?saved=1');
	});

	// -------------------------------------------------------------------------
	// POST /settings/:appId/:key/reset — per-row reset to default
	// -------------------------------------------------------------------------
	server.post(
		'/settings/:appId/:key/reset',
		async (request: FastifyRequest, reply: FastifyReply) => {
			const user = request.user;
			if (!user) return reply.redirect('/gui/login');

			const { appId, key } = request.params as { appId: string; key: string };
			const isAdmin = user.isPlatformAdmin;

			if (!PARAM_PATTERN.test(appId) || !PARAM_PATTERN.test(key)) {
				return reply.status(404).send('Not found');
			}

			const def = settingsRegistry.getByAppKey(appId, key);
			if (!def || def.hidden) return reply.status(404).send('Not found');

			// REQ-SETTINGS-034: dangerous resets require confirm flow.
			if (def.dangerous) {
				return reply.status(403).send('Dangerous settings require the confirm flow');
			}

			// System-scope resets require admin.
			if (def.scope === 'system') {
				if (!isAdmin) return reply.status(403).send('Forbidden');

				const writer = systemConfigWriter;
				const config = systemConfig;
				if (!writer || !config) {
					logger.warn({ appId, key, userId: user.userId }, 'settings reset: no SystemConfigWriter');
					return reply.status(500).send('Internal error');
				}

				let prevValue: unknown = def.default;
				try { prevValue = writer.read(key, config); } catch { /* use def.default */ }

				const resetValue = await writer.resetToSchemaDefault(key, config);

				await settingsWriter.runHooksForKey(qualifiedKey(appId, key), {
					userId: user.userId, appId, key, prevValue, newValue: resetValue,
				});

				return reply.type('text/html').send(buildSettingRowHtml(def, resetValue));
			}

			// Per-user non-dangerous: adminOnly requires admin.
			if (def.adminOnly && !isAdmin) {
				return reply.status(403).send('Forbidden');
			}

			const cfg = appConfigResolver(appId);
			if (!cfg) {
				logger.warn({ appId, key, userId: user.userId }, 'settings reset: no AppConfigService');
				return reply.status(500).send('Internal error');
			}

			// Capture prevValue before removal (for hook ctx)
			let prevValue: unknown = def.default;
			try {
				const all = await cfg.getAll(user.userId);
				prevValue = all[key];
			} catch {
				/* use manifest default */
			}

			await cfg.removeOverride(user.userId, key);

			// Fire registered hooks (e.g. flush_memory_on_idle_reset cleanup)
			await settingsWriter.runHooksForKey(qualifiedKey(appId, key), {
				userId: user.userId,
				appId,
				key,
				prevValue,
				newValue: def.default,
			});

			// Read post-reset effective value
			let resetValue: unknown = def.default;
			try {
				const all = await cfg.getAll(user.userId);
				resetValue = all[key];
			} catch {
				/* use manifest default */
			}

			return reply.type('text/html').send(buildSettingRowHtml(def, resetValue));
		},
	);

	// -------------------------------------------------------------------------
	// GET /settings/:appId/:key/confirm — render confirm modal for dangerous keys
	// REQ-SETTINGS-026, 027
	// -------------------------------------------------------------------------
	server.get(
		'/settings/:appId/:key/confirm',
		{ preHandler: [requirePlatformAdmin] },
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { appId, key } = request.params as { appId: string; key: string };
			const query = request.query as Record<string, string>;

			if (!PARAM_PATTERN.test(appId) || !PARAM_PATTERN.test(key)) {
				return reply.status(404).send('Not found');
			}

			const def = settingsRegistry.getByAppKey(appId, key);
			if (!def) return reply.status(404).send('Not found');

			if (!def.dangerous) {
				return reply.status(400).send('Confirm flow only applies to dangerous settings');
			}

			const action = query['action'] === 'reset' ? 'reset' : 'set';

			// Extract proposed value for 'set' action.
			// Value can come from ?value= directly or from the field included via hx-include.
			let proposedValue = '';
			if (action === 'set') {
				const fieldKey = fieldName(appId, key);
				const presentKey = presentFieldName(appId, key);
				if (query['value'] !== undefined) {
					proposedValue = query['value'];
				} else if (def.type === 'boolean') {
					// hx-include: checkbox present=1 + checkbox checked=on
					proposedValue = fieldKey in query ? 'true' : (presentKey in query ? 'false' : '');
				} else {
					proposedValue = query[fieldKey] ?? '';
				}
			}

			// Validate the proposed value coerces correctly (pre-validation for user feedback).
			let coercionError = '';
			if (action === 'set' && proposedValue !== '') {
				const result = settingsWriter.validate({
					userId: request.user!.userId,
					appId, key, rawValue: proposedValue, source: 'admin-confirmed',
				});
				if (!result.ok) coercionError = result.reason;
			}

			return reply.type('text/html').send(buildConfirmModalHtml({
				def,
				appId,
				key,
				action,
				proposedValue,
				coercionError,
				csrfToken: (request as unknown as { csrfToken?: string }).csrfToken ?? '',
				error: '',
			}));
		},
	);

	// -------------------------------------------------------------------------
	// POST /settings/:appId/:key/confirm — execute confirmed dangerous action
	// REQ-SETTINGS-026, 027, 034
	// -------------------------------------------------------------------------
	server.post(
		'/settings/:appId/:key/confirm',
		{ preHandler: [requirePlatformAdmin] },
		async (request: FastifyRequest, reply: FastifyReply) => {
			const { appId, key } = request.params as { appId: string; key: string };
			const body = (request.body ?? {}) as Record<string, string>;

			if (!PARAM_PATTERN.test(appId) || !PARAM_PATTERN.test(key)) {
				return reply.status(404).send('Not found');
			}

			const def = settingsRegistry.getByAppKey(appId, key);
			if (!def) return reply.status(404).send('Not found');

			if (!def.dangerous) {
				return reply.status(400).send('Confirm flow only applies to dangerous settings');
			}

			const action = body['action'] === 'reset' ? 'reset' : 'set';
			const phrase = body['phrase'] ?? '';
			const expectedPhrase = def.dangerConfirmPrompt ?? 'confirm';

			// REQ-SETTINGS-027: timing-safe phrase match.
			if (!matchesDangerConfirmPhrase(phrase, expectedPhrase)) {
				return reply.status(403).type('text/html').send(buildConfirmModalHtml({
					def,
					appId,
					key,
					action,
					proposedValue: body['value'] ?? '',
					coercionError: '',
					csrfToken: (request as unknown as { csrfToken?: string }).csrfToken ?? '',
					error: 'Phrase did not match. Try again.',
				}));
			}

			const userId = request.user!.userId;

			if (action === 'set') {
				const rawValue = body['value'] ?? '';
				// Server-side re-validation (REQ-SETTINGS-027: re-validate at POST time).
				const result = await settingsWriter.write({
					userId, appId, key, rawValue, source: 'admin-confirmed',
				});
				if (!result.ok) {
					return reply.status(400).send(`Write failed: ${result.reason}`);
				}
			} else {
				// action === 'reset'
				let prevValue: unknown = def.default;
				if (def.scope === 'system') {
					if (!systemConfigWriter || !systemConfig) {
						logger.warn({ appId, key, userId }, 'confirm reset: no SystemConfigWriter');
						return reply.status(500).send('Internal error');
					}
					try { prevValue = systemConfigWriter.read(key, systemConfig); } catch { /* use default */ }
					const resetValue = await systemConfigWriter.resetToSchemaDefault(key, systemConfig);
					await settingsWriter.runHooksForKey(qualifiedKey(appId, key), {
						userId, appId, key, prevValue, newValue: resetValue,
					});
					return reply.redirect('/gui/settings?saved=1');
				} else {
					const cfg = appConfigResolver(appId);
					if (!cfg) {
						logger.warn({ appId, key, userId }, 'confirm reset: no AppConfigService');
						return reply.status(500).send('Internal error');
					}
					try {
						const all = await cfg.getAll(userId);
						prevValue = all[key];
					} catch { /* use default */ }
					await cfg.removeOverride(userId, key);
					await settingsWriter.runHooksForKey(qualifiedKey(appId, key), {
						userId, appId, key, prevValue, newValue: def.default,
					});
				}
			}

			return reply.redirect('/gui/settings?saved=1');
		},
	);
}
