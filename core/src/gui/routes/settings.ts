/**
 * Settings page routes — /gui/settings.
 *
 * Renders every per-user setting visible to the current user, grouped by
 * category in collapsible Pico <details> accordions. System-wide and
 * dangerous settings are excluded (deferred to Chunk C).
 *
 * Only the shared settingsAppConfigResolver is used here; existing
 * routes/apps.ts and routes/config.ts keep their own private caches.
 *
 * REQ-SETTINGS-002, 003, 004, 005, 014, 015, 016, 017, 018, 019, 020
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfigService } from '../../types/config.js';
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../../services/settings/categories.js';
import type { SettingDef, SettingsCategory } from '../../services/settings/settings-registry.js';
import { qualifiedKey } from '../../services/settings/settings-registry.js';
import type { SettingsRegistry } from '../../services/settings/settings-registry.js';
import type { SettingsWriter, WriteRequest } from '../../services/settings/settings-writer.js';
import { escapeHtml } from './llm-usage.js';

const VISIBLE_CATEGORIES: readonly SettingsCategory[] = [
	'personal',
	'food',
	'notes',
	'memory-sessions',
	'notifications',
];

const PARAM_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface SettingsRoutesOptions {
	settingsRegistry: SettingsRegistry;
	settingsWriter: SettingsWriter;
	appConfigResolver: (appId: string) => AppConfigService | undefined;
	logger: Logger;
}

function getVisibleDefs(registry: SettingsRegistry): SettingDef[] {
	return registry
		.getAll()
		.filter(
			(def) =>
				!def.hidden &&
				!def.adminOnly &&
				def.scope === 'per-user' &&
				(VISIBLE_CATEGORIES as readonly string[]).includes(def.category),
		);
}

function fieldName(appId: string, key: string): string {
	return `${appId}__${key}`;
}

function presentFieldName(appId: string, key: string): string {
	return `${appId}__${key}__present`;
}

/** Render a single setting row as an HTML string (used by Reset endpoint). */
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

	const labelHtml =
		def.type !== 'boolean'
			? `<label for="sf-${escapeHtml(fname)}">${safeLabel}</label>`
			: '';

	return `<div class="setting-row" data-app="${safeAppId}" data-key="${safeKey}">
  <div class="setting-label">
    ${labelHtml}
    <small class="setting-help">${safeHelp}</small>
    ${errorHtml}
  </div>
  <div class="setting-widget">
    ${widget}
  </div>
  <div class="setting-actions">
    <button
      type="button"
      class="outline secondary"
      style="font-size:0.8rem;padding:0.2rem 0.5rem"
      hx-post="/gui/settings/${safeAppId}/${safeKey}/reset"
      hx-target="closest .setting-row"
      hx-swap="outerHTML"
    >Reset</button>
  </div>
</div>`;
}

async function readCurrentValues(
	visibleDefs: SettingDef[],
	userId: string,
	appConfigResolver: (appId: string) => AppConfigService | undefined,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	for (const def of visibleDefs) {
		const cfg = appConfigResolver(def.appId);
		if (!cfg) continue;
		try {
			const all = await cfg.getAll(userId);
			out[qualifiedKey(def.appId, def.key)] = all[def.key];
		} catch {
			// Leave missing — widget will show empty
		}
	}
	return out;
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
	const { settingsRegistry, settingsWriter, appConfigResolver, logger } = options;

	// -------------------------------------------------------------------------
	// GET /settings — render full accordion page
	// -------------------------------------------------------------------------
	server.get('/settings', async (request: FastifyRequest, reply: FastifyReply) => {
		const user = request.user;
		if (!user) return reply.redirect('/gui/login');

		const userId = user.userId;
		const visibleDefs = getVisibleDefs(settingsRegistry);
		const currentValues = await readCurrentValues(visibleDefs, userId, appConfigResolver);
		const byCategory = groupByCategory(visibleDefs);

		const savedParam = (request.query as Record<string, string>).saved;
		const failedParam = (request.query as Record<string, string>).failed;

		return reply.viewAsync('settings', {
			title: 'Settings — PAS',
			activePage: 'settings',
			byCategory,
			currentValues,
			categoryOrder: CATEGORY_ORDER,
			categoryLabels: CATEGORY_LABELS,
			saved: savedParam === '1',
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
		const body = (request.body ?? {}) as Record<string, string>;
		const visibleDefs = getVisibleDefs(settingsRegistry);

		// Read current effective values for diffing
		const currentEffective = await readCurrentValues(visibleDefs, userId, appConfigResolver);

		// Build batch items — iterate registry defs (NOT posted fields)
		const items: WriteRequest[] = [];
		for (const def of visibleDefs) {
			const fname = fieldName(def.appId, def.key);
			const pname = presentFieldName(def.appId, def.key);
			let rawValue: string;

			if (def.type === 'boolean') {
				if (!(pname in body)) continue; // field not submitted — skip
				rawValue = fname in body ? 'true' : 'false';
			} else {
				if (!(fname in body)) continue; // field not submitted — skip
				rawValue = body[fname] ?? '';
			}

			// Validate + coerce to diff against current effective value
			const validateResult = settingsWriter.validate({
				userId,
				appId: def.appId,
				key: def.key,
				rawValue,
				source: 'admin-confirmed',
			});

			// Skip no-ops (same coerced value as current effective)
			if (validateResult.ok) {
				const current = currentEffective[qualifiedKey(def.appId, def.key)];
				if (JSON.stringify(validateResult.coerced) === JSON.stringify(current)) continue;
			}

			items.push({ userId, appId: def.appId, key: def.key, rawValue: rawValue, source: 'admin-confirmed' });
		}

		// Validation-atomic phase (pure, no I/O)
		const errors: Record<string, string> = {};
		const rawValues: Record<string, string> = {};
		for (const item of items) {
			const result = settingsWriter.validate({
				userId: item.userId,
				appId: item.appId,
				key: item.key,
				rawValue: item.rawValue,
				source: 'admin-confirmed',
			});
			if (!result.ok) {
				const qk = qualifiedKey(item.appId, item.key);
				errors[qk] = result.reason;
				rawValues[qk] = item.rawValue;
			}
		}

		if (Object.keys(errors).length > 0) {
			const currentValues = await readCurrentValues(visibleDefs, userId, appConfigResolver);
			const byCategory = groupByCategory(visibleDefs);
			return reply.status(400).viewAsync('settings', {
				title: 'Settings — PAS',
				activePage: 'settings',
				byCategory,
				currentValues,
				categoryOrder: CATEGORY_ORDER,
				categoryLabels: CATEGORY_LABELS,
				saved: false,
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
				`/gui/settings?saved=1&failed=${encodeURIComponent(failedApps.join(','))}`,
			);
		}

		return reply.redirect('/gui/settings?saved=1');
	});

	// -------------------------------------------------------------------------
	// POST /settings/:appId/:key/reset — per-row reset to manifest default
	// -------------------------------------------------------------------------
	server.post(
		'/settings/:appId/:key/reset',
		async (request: FastifyRequest, reply: FastifyReply) => {
			const user = request.user;
			if (!user) return reply.redirect('/gui/login');

			const { appId, key } = request.params as { appId: string; key: string };

			if (!PARAM_PATTERN.test(appId) || !PARAM_PATTERN.test(key)) {
				return reply.status(404).send('Not found');
			}

			const def = settingsRegistry.getByAppKey(appId, key);
			if (!def) return reply.status(404).send('Not found');

			if (
				def.hidden ||
				def.adminOnly ||
				def.scope !== 'per-user' ||
				def.category === 'system' ||
				def.category === 'dangerous'
			) {
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
}
