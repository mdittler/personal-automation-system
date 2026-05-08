/**
 * settings-formatter.ts — Telegram output formatters for the /settings command.
 *
 * All output is intended for Telegram legacy Markdown (parse_mode: 'Markdown').
 * User-controlled strings are escaped via escapeMarkdown() to prevent injection.
 *
 * Functions exported here are consumed by handle-settings.ts (handler) and
 * re-exported via the settings index for tests.
 */

import { escapeMarkdown } from '../../utils/escape-markdown.js';
import { BOOLEAN_FALSY, BOOLEAN_TRUTHY } from '../config/coerce-user-config.js';
import { CATEGORY_LABELS, CATEGORY_ORDER } from './categories.js';
import type { PendingSettingsAction } from './pending-settings-confirm-store.js';
import type { SettingDef, SettingsCategory } from './settings-registry.js';
import { qualifiedKey } from './settings-registry.js';

// ---------------------------------------------------------------------------
// Value display helper
// ---------------------------------------------------------------------------

/**
 * Convert a raw stored value to a human-readable display string.
 * Handles all 4 SettingDef types with appropriate formatting.
 */
export function formatDisplayValue(def: SettingDef, raw: unknown): string {
	if (def.type === 'boolean') {
		if (raw === true) return 'ON';
		if (raw === false) return 'OFF';
		// Coerce string booleans from YAML manual edits (e.g. 'true', 'on', '1')
		if (typeof raw === 'string') {
			const lower = raw.toLowerCase();
			if (BOOLEAN_TRUTHY.has(lower)) return 'ON';
			if (BOOLEAN_FALSY.has(lower)) return 'OFF';
		}
		return raw == null ? 'OFF' : String(raw);
	}

	if (def.type === 'string' || def.type === 'select') {
		if (raw == null || raw === '') return '(not set)';
		return String(raw);
	}

	if (def.type === 'number') {
		if (raw == null) return '(not set)';
		return String(raw);
	}

	// Fallback for unexpected types
	if (raw == null) return '(not set)';
	return String(raw);
}

// ---------------------------------------------------------------------------
// Category list
// ---------------------------------------------------------------------------

/**
 * Render a markdown list of categories with key counts.
 *
 * @param categories    - Category names to render (ordered).
 * @param defs          - All visible SettingDef entries.
 * @param overridesByApp - Per-appId overrides for current-value display.
 */
export function formatCategoryList(
	categories: readonly SettingsCategory[],
	defs: SettingDef[],
	_overridesByApp: Map<string, Record<string, unknown>>,
): string {
	const lines: string[] = ['*Settings categories:*', ''];

	for (const cat of categories) {
		const count = defs.filter((d) => d.category === cat).length;
		if (count === 0) continue;
		lines.push(`  /settings ${cat}  (${count} setting${count === 1 ? '' : 's'})`);
	}

	lines.push('');
	lines.push('Type `/settings <category>` to list settings in a category.');
	lines.push('Type `/settings <category> <key>` to show a single setting.');
	lines.push('Type `/settings <category> <key> <value>` to change a setting.');
	lines.push('Type `/settings reset <category> <key>` to reset to default.');

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Category detail
// ---------------------------------------------------------------------------

/**
 * List all keys in one category with current values.
 */
export function formatCategorySettings(
	category: SettingsCategory,
	defs: SettingDef[],
	overridesByApp: Map<string, Record<string, unknown>>,
): string {
	const label = CATEGORY_LABELS[category] ?? category;
	const catDefs = defs.filter((d) => d.category === category);
	if (catDefs.length === 0) {
		return `No settings found in *${escapeMarkdown(label)}*.`;
	}

	const lines: string[] = [`*${escapeMarkdown(label)} settings:*`, ''];

	for (const def of catDefs) {
		const overrides = overridesByApp.get(def.appId) ?? {};
		const rawValue = Object.prototype.hasOwnProperty.call(overrides, def.key)
			? overrides[def.key]
			: def.default;
		const display = formatDisplayValue(def, rawValue);
		const qid = qualifiedKey(def.appId, def.key);
		lines.push(
			`  *${escapeMarkdown(def.label)}* (\`${escapeMarkdown(qid)}\`): ${escapeMarkdown(display)}`,
		);
	}

	lines.push('');
	lines.push(`Type \`/settings ${category} <key> <value>\` to change a setting.`);
	lines.push(`Type \`/settings reset ${category} <key>\` to reset to default.`);

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Single setting detail
// ---------------------------------------------------------------------------

/**
 * Full detail block for a single setting: label, qualified key, scope, type,
 * current value, default, min/max if present, restartRequired badge, help text.
 */
export function formatSingleSetting(def: SettingDef, currentValue: unknown): string {
	const qid = qualifiedKey(def.appId, def.key);
	const displayCurrent = formatDisplayValue(def, currentValue);
	const displayDefault = formatDisplayValue(def, def.default);

	const lines: string[] = [
		`*${escapeMarkdown(def.label)}*`,
		`Key: \`${escapeMarkdown(qid)}\``,
		`Scope: ${escapeMarkdown(def.scope)}`,
		`Type: ${escapeMarkdown(def.type)}`,
	];

	if (def.type === 'select' && def.options) {
		lines.push(`Options: ${def.options.map((o) => `\`${escapeMarkdown(o)}\``).join(', ')}`);
	}

	if (def.type === 'number') {
		const parts: string[] = [];
		if (def.min !== undefined) parts.push(`min: ${def.min}`);
		if (def.max !== undefined) parts.push(`max: ${def.max}`);
		if (parts.length > 0) lines.push(`Range: ${parts.join(', ')}`);
	}

	lines.push(`Current: ${escapeMarkdown(displayCurrent)}`);
	lines.push(`Default: ${escapeMarkdown(displayDefault)}`);

	if (def.restartRequired) {
		lines.push('⚠️ Restart required for changes to take effect.');
	}

	if (def.help) {
		lines.push('');
		lines.push(escapeMarkdown(def.help));
	}

	if (def.helpDetail) {
		lines.push('');
		lines.push(escapeMarkdown(def.helpDetail));
	}

	lines.push('');
	lines.push(
		`To change: \`/settings ${escapeMarkdown(def.category)} ${escapeMarkdown(def.key)} <value>\``,
	);
	lines.push(
		`To reset: \`/settings reset ${escapeMarkdown(def.category)} ${escapeMarkdown(def.key)}\``,
	);

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Danger confirm prompt
// ---------------------------------------------------------------------------

/**
 * Warning message asking the user to confirm a dangerous operation.
 * The user must type the exact phrase to proceed.
 */
export function formatDangerPrompt(
	def: SettingDef,
	rawValue: string | undefined,
	action: PendingSettingsAction,
): string {
	const qid = qualifiedKey(def.appId, def.key);
	const lines: string[] = [
		'⚠️ *Dangerous setting change*',
		'',
		`Setting: \`${escapeMarkdown(qid)}\``,
	];

	if (action === 'set' && rawValue !== undefined) {
		lines.push(`New value: ${escapeMarkdown(rawValue)}`);
	} else if (action === 'reset') {
		lines.push('Action: reset to default');
	}

	const phrase = def.dangerConfirmPrompt ?? '';
	lines.push('');
	lines.push('To confirm, type:');
	lines.push(`\`/settings confirm ${escapeMarkdown(phrase)}\``);
	lines.push('');
	lines.push('This confirmation expires in 60 seconds.');

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

/**
 * Short help showing the /settings sub-grammar.
 */
export function formatHelp(): string {
	return [
		'*Settings command help:*',
		'',
		'`/settings` — list all categories',
		'`/settings <category>` — list settings in category',
		'`/settings <category> <key>` — show setting detail',
		'`/settings <category> <key> <value>` — change a setting',
		'`/settings reset <category> <key>` — reset to default',
		'`/settings confirm <phrase>` — confirm a dangerous change',
		'',
		`Categories: ${CATEGORY_ORDER.map((c) => `\`${c}\``).join(', ')}`,
	].join('\n');
}
