/**
 * handleSettings — pure handler for the /settings Telegram command.
 *
 * No Telegram imports. Emits { reply: string } for the caller to send.
 *
 * Sub-grammar:
 *   /settings                               → list categories
 *   /settings <category>                    → list keys in category
 *   /settings <category> <key>              → show one setting
 *   /settings <category> <key> <value...>   → set a setting
 *   /settings reset <category> <key>        → reset to default
 *   /settings confirm <phrase...>           → confirm dangerous change
 */

import type { AppLogger } from '../../types/app-module.js';
import type { AppConfigService, SystemConfig } from '../../types/config.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import { dotGet } from '../config/system-config-writer.js';
import type { SystemConfigWriter } from '../config/system-config-writer.js';
import { CATEGORY_ORDER } from '../settings/categories.js';
import type { PendingSettingsConfirmStore } from '../settings/pending-settings-confirm-store.js';
import {
	formatCategoryList,
	formatCategorySettings,
	formatDangerPrompt,
	formatDisplayValue,
	formatHelp,
	formatSingleSetting,
} from '../settings/settings-formatter.js';
import type { SettingDef, SettingsCategory } from '../settings/settings-registry.js';
import { qualifiedKey } from '../settings/settings-registry.js';
import type { SettingsRegistry } from '../settings/settings-registry.js';
import type { SettingsWriter } from '../settings/settings-writer.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface HandleSettingsDeps {
	registry: SettingsRegistry;
	writer: SettingsWriter;
	/** Returns the AppConfigService for a given appId, or undefined if not wired. */
	appConfigResolver: (appId: string) => AppConfigService | undefined;
	/** Required for system-scope reads/resets. */
	systemConfigWriter?: SystemConfigWriter;
	/** In-memory SystemConfig. Read-only from this handler's perspective. */
	systemConfig?: SystemConfig;
	pendingStore: PendingSettingsConfirmStore;
	/** Constant-time phrase match — import from settings-confirm-helpers.ts. */
	matchesDangerConfirmPhrase: (submitted: string, expected: string) => boolean;
	logger?: AppLogger;
}

export interface HandleSettingsArgs {
	/** Tokenized args (split on whitespace, leading/trailing stripped). */
	args: string[];
	/** Everything after '/settings ' (from parseCommand.rawArgs). */
	rawArgs: string;
	userId: string;
	householdId?: string;
	isAdmin: boolean;
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function handleSettings(
	input: HandleSettingsArgs,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { args } = input;

	// No args → list categories
	if (args.length === 0) {
		return listCategories(input, deps);
	}

	const firstArg = (args[0] ?? '').toLowerCase();

	if (firstArg === 'confirm') {
		return confirmFlow(input, deps);
	}

	if (firstArg === 'reset') {
		return resetFlow(input, deps);
	}

	// Category flow
	return categoryFlow(input, deps);
}

// ---------------------------------------------------------------------------
// List categories
// ---------------------------------------------------------------------------

async function listCategories(
	input: HandleSettingsArgs,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { isAdmin } = input;
	const visible = deps.registry.getForUser(isAdmin);

	// We pass empty overridesByApp — we only need counts here, not values.
	const presentCategories = CATEGORY_ORDER.filter((cat) => visible.some((d) => d.category === cat));

	const reply = formatCategoryList(presentCategories, visible, new Map());
	return { reply };
}

// ---------------------------------------------------------------------------
// Category flow dispatch
// ---------------------------------------------------------------------------

async function categoryFlow(
	input: HandleSettingsArgs,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { args, isAdmin } = input;

	const category = (args[0] ?? '').toLowerCase() as SettingsCategory;

	// Validate category
	const validCategory = CATEGORY_ORDER.includes(category);
	if (!validCategory) {
		const visible = deps.registry.getForUser(isAdmin);
		const presentCategories = CATEGORY_ORDER.filter((cat) =>
			visible.some((d) => d.category === cat),
		);
		const catList = presentCategories.map((c) => `\`${c}\``).join(', ');
		return {
			reply: `Unknown category \`${escapeMarkdown(category)}\`\\. Available: ${catList}\n\n${formatHelp()}`,
		};
	}

	if (args.length === 1) {
		// List keys in category
		return listCategoryKeys(input, category, deps);
	}

	const key = args[1] ?? '';

	if (args.length === 2) {
		// Show one setting
		return showSetting(input, category, key, deps);
	}

	// Set flow: 3+ args
	return setFlow(input, category, key, deps);
}

// ---------------------------------------------------------------------------
// List keys in category
// ---------------------------------------------------------------------------

async function listCategoryKeys(
	input: HandleSettingsArgs,
	category: SettingsCategory,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { userId, isAdmin } = input;
	const visible = deps.registry.getForUser(isAdmin).filter((d) => d.category === category);

	if (visible.length === 0) {
		return { reply: `No settings found in \`${escapeMarkdown(category)}\`.` };
	}

	// Fetch per-app overrides for value display
	const overridesByApp = await fetchOverrides(userId, visible, deps);

	const reply = formatCategorySettings(category, visible, overridesByApp);
	return { reply };
}

// ---------------------------------------------------------------------------
// Show single setting
// ---------------------------------------------------------------------------

async function showSetting(
	input: HandleSettingsArgs,
	category: SettingsCategory,
	key: string,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { userId, isAdmin } = input;

	const resolveResult = resolveDef(category, key, isAdmin, deps.registry);
	if (resolveResult.type !== 'ok') {
		return { reply: resolveResult.message };
	}
	const def = resolveResult.def;

	const currentValue = await readCurrentValue(def, userId, deps);
	const reply = formatSingleSetting(def, currentValue);
	return { reply };
}

// ---------------------------------------------------------------------------
// Set flow
// ---------------------------------------------------------------------------

async function setFlow(
	input: HandleSettingsArgs,
	category: SettingsCategory,
	key: string,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { rawArgs, userId, isAdmin } = input;

	// Recover full value from rawArgs: everything after second whitespace boundary.
	// rawArgs = "<category> <key> <value...>" (no leading '/settings ')
	const rawValue = extractValueTail(rawArgs, 2);

	const resolveResult = resolveDef(category, key, isAdmin, deps.registry);
	if (resolveResult.type !== 'ok') {
		return { reply: resolveResult.message };
	}
	const def = resolveResult.def;

	if (def.dangerous) {
		// Admin-only enforcement (dangerous implies adminOnly by registry invariant).
		if (!isAdmin) {
			return { reply: unknownSettingReply() };
		}

		// Validate first — if invalid, do not create pending entry.
		const validation = deps.writer.validate({
			source: 'admin-confirmed',
			userId,
			appId: def.appId,
			key: def.key,
			rawValue,
		});
		if (!validation.ok) {
			return { reply: `Invalid value: ${escapeMarkdown(validation.reason)}` };
		}

		// Create pending entry.
		deps.pendingStore.attach(userId, {
			userId,
			qualifiedKey: qualifiedKey(def.appId, def.key),
			action: 'set',
			rawValue,
			expectedPhrase: def.dangerConfirmPrompt ?? '',
		});

		const reply = formatDangerPrompt(def, rawValue, 'set');
		return { reply };
	}

	// Non-dangerous set
	const validation = deps.writer.validate({
		source: 'gui',
		userId,
		appId: def.appId,
		key: def.key,
		rawValue,
	});
	if (!validation.ok) {
		return { reply: `Invalid value: ${escapeMarkdown(validation.reason)}` };
	}

	const result = await deps.writer.write({
		source: 'gui',
		userId,
		appId: def.appId,
		key: def.key,
		rawValue,
	});

	if (!result.ok) {
		deps.logger?.warn(
			'handleSettings.setFlow: write failed qid=%s userId=%s reason=%s',
			qualifiedKey(def.appId, def.key),
			userId,
			result.reason,
		);
		return { reply: 'Failed to save setting. Please try again.' };
	}

	const displayVal = formatDisplayValue(def, result.coerced);
	const qid = qualifiedKey(def.appId, def.key);
	let reply = `✓ Saved: \`${escapeMarkdown(qid)}\` = ${escapeMarkdown(displayVal)}`;
	if (def.restartRequired) {
		reply += '\n\n⚠️ Restart required for this change to take effect.';
	}
	return { reply };
}

// ---------------------------------------------------------------------------
// Reset flow
// ---------------------------------------------------------------------------

async function resetFlow(
	input: HandleSettingsArgs,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { args, userId, isAdmin } = input;

	// Expected: args[0]='reset', args[1]=category, args[2]=key
	if (args.length !== 3) {
		return { reply: formatHelp() };
	}

	const category = (args[1] ?? '').toLowerCase() as SettingsCategory;
	const key = args[2] ?? '';

	const resolveResult = resolveDef(category, key, isAdmin, deps.registry);
	if (resolveResult.type !== 'ok') {
		return { reply: resolveResult.message };
	}
	const def = resolveResult.def;

	if (def.dangerous) {
		if (!isAdmin) {
			return { reply: unknownSettingReply() };
		}

		// Create pending entry for dangerous reset.
		deps.pendingStore.attach(userId, {
			userId,
			qualifiedKey: qualifiedKey(def.appId, def.key),
			action: 'reset',
			rawValue: undefined,
			expectedPhrase: def.dangerConfirmPrompt ?? '',
		});

		const reply = formatDangerPrompt(def, undefined, 'reset');
		return { reply };
	}

	// Non-dangerous reset
	return executeReset(def, userId, deps);
}

// ---------------------------------------------------------------------------
// Confirm flow
// ---------------------------------------------------------------------------

async function confirmFlow(
	input: HandleSettingsArgs,
	deps: HandleSettingsDeps,
): Promise<{ reply: string }> {
	const { rawArgs, userId, isAdmin } = input;

	// Extract phrase: everything after 'confirm '
	const phrase = rawArgs.startsWith('confirm ')
		? rawArgs.slice('confirm '.length).trim()
		: rawArgs.trim() === 'confirm'
			? ''
			: rawArgs.trim();

	// Peek (non-consuming) first.
	const entry = deps.pendingStore.peek(userId);
	if (!entry) {
		return { reply: 'No pending change to confirm.' };
	}

	// Re-resolve def.
	const { appId, key: defKey } = parseQualifiedKey(entry.qualifiedKey);
	const def = deps.registry.getByAppKey(appId, defKey);

	// Guard: def missing or hidden → consume and respond generically.
	if (!def || def.hidden) {
		deps.pendingStore.remove(userId);
		return { reply: 'No pending change to confirm.' };
	}

	// Guard: adminOnly downgrade before confirm → consume.
	if (def.adminOnly && !isAdmin) {
		deps.pendingStore.remove(userId);
		return { reply: 'No pending change to confirm.' };
	}

	// Guard: def no longer dangerous → consume + explain (no write).
	if (!def.dangerous) {
		deps.pendingStore.remove(userId);
		return {
			reply: 'Pending change is no longer dangerous; please re-issue without confirm.',
		};
	}

	// Phrase comparison.
	const matches = deps.matchesDangerConfirmPhrase(phrase, entry.expectedPhrase);
	if (!matches) {
		deps.logger?.warn(
			'handleSettings.confirmFlow: phrase mismatch userId=%s qid=%s',
			userId,
			entry.qualifiedKey,
		);
		return { reply: 'Phrase did not match. Try again or wait for it to expire.' };
	}

	// Consume the entry (remove from store).
	const consumed = deps.pendingStore.get(userId);
	if (!consumed) {
		// Edge case: expired between peek and get (TTL race).
		return { reply: 'Pending change expired. Please re-issue the command.' };
	}

	if (consumed.action === 'set') {
		// Revalidate.
		const validation = deps.writer.validate({
			source: 'admin-confirmed',
			userId,
			appId,
			key: defKey,
			rawValue: consumed.rawValue ?? '',
		});
		if (!validation.ok) {
			return { reply: `Validation failed: ${escapeMarkdown(validation.reason)}` };
		}

		const result = await deps.writer.write({
			source: 'admin-confirmed',
			userId,
			appId,
			key: defKey,
			rawValue: consumed.rawValue ?? '',
		});

		if (!result.ok) {
			deps.logger?.warn(
				'handleSettings.confirmFlow: write failed qid=%s userId=%s reason=%s',
				entry.qualifiedKey,
				userId,
				result.reason,
			);
			return { reply: 'Failed to save setting. Please try again.' };
		}

		const displayVal = formatDisplayValue(def, result.coerced);
		const qid = entry.qualifiedKey;
		return {
			reply: `✓ Confirmed and saved: \`${escapeMarkdown(qid)}\` = ${escapeMarkdown(displayVal)}`,
		};
	}

	// action === 'reset'
	return executeReset(def, userId, deps, { confirmedQid: entry.qualifiedKey });
}

// ---------------------------------------------------------------------------
// Shared reset executor
// ---------------------------------------------------------------------------

async function executeReset(
	def: SettingDef,
	userId: string,
	deps: HandleSettingsDeps,
	opts?: { confirmedQid?: string },
): Promise<{ reply: string }> {
	const qid = opts?.confirmedQid ?? qualifiedKey(def.appId, def.key);

	if (def.scope === 'system') {
		const writer = deps.systemConfigWriter;
		const config = deps.systemConfig;
		if (!writer || !config) {
			return { reply: 'System config writer not available.' };
		}

		let prevValue: unknown = def.default;
		try {
			prevValue = writer.read(def.key, config);
		} catch {
			// Non-fatal
		}

		let effectiveDefault: unknown;
		try {
			effectiveDefault = await writer.resetToSchemaDefault(def.key, config);
		} catch (err) {
			deps.logger?.warn(
				'handleSettings.executeReset: system reset failed key=%s userId=%s err=%s',
				def.key,
				userId,
				err instanceof Error ? err.message : String(err),
			);
			return { reply: 'Failed to reset setting. Please try again.' };
		}

		await deps.writer.runHooksForKey(qid, {
			userId,
			appId: def.appId,
			key: def.key,
			prevValue,
			newValue: effectiveDefault,
		});

		const displayVal = formatDisplayValue(def, effectiveDefault);
		const prefix = opts?.confirmedQid ? '✓ Confirmed. ' : '';
		return {
			reply: `${prefix}\`${escapeMarkdown(qid)}\` reset to ${escapeMarkdown(displayVal)}`,
		};
	}

	// Per-user reset
	const cfg = deps.appConfigResolver(def.appId);
	if (!cfg) {
		return { reply: 'Unable to access settings for this app.' };
	}

	let prevValue: unknown = def.default;
	try {
		const overrides = await cfg.getOverrides(userId);
		if (overrides && Object.prototype.hasOwnProperty.call(overrides, def.key)) {
			prevValue = overrides[def.key];
		}
	} catch {
		// Non-fatal
	}

	try {
		await cfg.removeOverride(userId, def.key);
	} catch (err) {
		deps.logger?.warn(
			'handleSettings.executeReset: removeOverride failed appId=%s key=%s userId=%s err=%s',
			def.appId,
			def.key,
			userId,
			err instanceof Error ? err.message : String(err),
		);
		return { reply: 'Failed to reset setting. Please try again.' };
	}

	await deps.writer.runHooksForKey(qid, {
		userId,
		appId: def.appId,
		key: def.key,
		prevValue,
		newValue: def.default,
	});

	const effectiveVal = readEffectiveDefault(def, deps);
	const displayVal = formatDisplayValue(def, effectiveVal);
	const prefix = opts?.confirmedQid ? '✓ Confirmed. ' : '';
	return {
		reply: `${prefix}\`${escapeMarkdown(qid)}\` reset to ${escapeMarkdown(displayVal)}`,
	};
}

// ---------------------------------------------------------------------------
// def resolver
// ---------------------------------------------------------------------------

type DefResolveResult = { type: 'ok'; def: SettingDef } | { type: 'error'; message: string };

function resolveDef(
	category: SettingsCategory,
	keyOrQualified: string,
	isAdmin: boolean,
	registry: SettingsRegistry,
): DefResolveResult {
	let def: SettingDef | undefined;

	if (keyOrQualified.includes('.')) {
		// May be a qualified key ("food.default_store" or "system.chat.sessions.retention_days")
		// or an unqualified system key that contains dots ("chat.sessions.retention_days").
		//
		// Resolution order:
		// 1. Try split-at-first-dot as appId.key (covers most qualified keys).
		// 2. If that fails, scan all defs for an exact key match (covers system keys used unqualified).
		const dotIdx = keyOrQualified.indexOf('.');
		const appId = keyOrQualified.slice(0, dotIdx);
		const key = keyOrQualified.slice(dotIdx + 1);
		def = registry.getByAppKey(appId, key);

		if (!def) {
			// Fallback: treat the whole string as an unqualified key (system key path).
			const exactMatches = registry
				.getForUser(isAdmin)
				.filter((d) => d.key === keyOrQualified && d.category === category);
			if (exactMatches.length === 1) {
				def = exactMatches[0];
			} else if (exactMatches.length > 1) {
				const qids = exactMatches
					.map((d) => `\`${escapeMarkdown(qualifiedKey(d.appId, d.key))}\``)
					.join(', ');
				return {
					type: 'error',
					message: `Multiple apps define key \`${escapeMarkdown(keyOrQualified)}\` in this category. Qualify with appId.key: ${qids}`,
				};
			}
		}

		if (def && def.category !== category) {
			return {
				type: 'error',
				message: `Setting \`${escapeMarkdown(keyOrQualified)}\` is in category \`${escapeMarkdown(def.category)}\`, not \`${escapeMarkdown(category)}\`.`,
			};
		}
	} else {
		// Unqualified key (no dots) — scan for matches in the given category.
		const matches = registry
			.getForUser(isAdmin)
			.filter((d) => d.key === keyOrQualified && d.category === category);

		if (matches.length === 0) {
			def = undefined;
		} else if (matches.length === 1) {
			def = matches[0];
		} else {
			// Multiple apps define this key in this category.
			const qids = matches
				.map((d) => `\`${escapeMarkdown(qualifiedKey(d.appId, d.key))}\``)
				.join(', ');
			return {
				type: 'error',
				message: `Multiple apps define key \`${escapeMarkdown(keyOrQualified)}\` in this category. Qualify with appId.key: ${qids}`,
			};
		}
	}

	if (!def) {
		return {
			type: 'error',
			message: `Unknown setting \`${escapeMarkdown(keyOrQualified)}\` in category \`${escapeMarkdown(category)}\`. Type \`/settings ${escapeMarkdown(category)}\` to list available settings.`,
		};
	}

	// Hidden settings appear as unknown to everyone (defence-in-depth).
	if (def.hidden) {
		return { type: 'error', message: unknownSettingReply() };
	}

	// adminOnly settings appear as unknown to non-admins.
	if (def.adminOnly && !isAdmin) {
		return { type: 'error', message: unknownSettingReply() };
	}

	// Per-household scope: not settable via /settings (no multi-user boundary crossing).
	if (def.scope === 'per-household') {
		return {
			type: 'error',
			message: `Setting \`${escapeMarkdown(qualifiedKey(def.appId, def.key))}\` is household-scoped and cannot be changed per-user via this command.`,
		};
	}

	return { type: 'ok', def };
}

// ---------------------------------------------------------------------------
// Read current value for display
// ---------------------------------------------------------------------------

async function readCurrentValue(
	def: SettingDef,
	userId: string,
	deps: HandleSettingsDeps,
): Promise<unknown> {
	if (def.scope === 'system') {
		if (deps.systemConfigWriter && deps.systemConfig) {
			try {
				return deps.systemConfigWriter.read(def.key, deps.systemConfig);
			} catch {
				// Key not in allowlist — fall through to default
			}
		}
		return def.default;
	}

	// Per-user
	const cfg = deps.appConfigResolver(def.appId);
	if (!cfg) {
		deps.logger?.warn(
			'handleSettings.readCurrentValue: no AppConfigService for appId=%s (userId=%s) — using default',
			def.appId,
			userId,
		);
		return readEffectiveDefault(def, deps);
	}

	try {
		const overrides = await cfg.getOverrides(userId);
		if (overrides && Object.prototype.hasOwnProperty.call(overrides, def.key)) {
			return overrides[def.key];
		}
	} catch (err) {
		deps.logger?.warn(
			'handleSettings.readCurrentValue: getOverrides failed appId=%s userId=%s err=%s — using default',
			def.appId,
			userId,
			err instanceof Error ? err.message : String(err),
		);
	}

	return readEffectiveDefault(def, deps);
}

/**
 * Effective default: for per-user defs with systemConfigBackingKey, read the
 * system config value as the fallback (same logic as SettingsReader).
 */
function readEffectiveDefault(def: SettingDef, deps: HandleSettingsDeps): unknown {
	if (def.scope === 'per-user' && def.systemConfigBackingKey && deps.systemConfig) {
		const systemValue = dotGet(
			deps.systemConfig as unknown as Record<string, unknown>,
			def.systemConfigBackingKey,
		);
		if (systemValue !== undefined) return systemValue;
	}
	return def.default;
}

// ---------------------------------------------------------------------------
// Fetch overrides for a batch of defs
// ---------------------------------------------------------------------------

async function fetchOverrides(
	userId: string,
	defs: SettingDef[],
	deps: HandleSettingsDeps,
): Promise<Map<string, Record<string, unknown>>> {
	const appIds = [...new Set(defs.map((d) => d.appId))];
	const entries = await Promise.all(
		appIds.map(async (appId) => {
			if (appId === 'system') {
				// Build fake overrides from SystemConfigWriter.
				const result: Record<string, unknown> = {};
				if (deps.systemConfigWriter && deps.systemConfig) {
					for (const def of defs.filter((d) => d.appId === 'system')) {
						try {
							result[def.key] = deps.systemConfigWriter.read(def.key, deps.systemConfig);
						} catch {
							// Non-fatal
						}
					}
				}
				return [appId, result] as const;
			}

			const cfg = deps.appConfigResolver(appId);
			if (!cfg) return [appId, {}] as const;

			try {
				const overrides = await cfg.getOverrides(userId);
				return [appId, overrides ?? {}] as const;
			} catch {
				return [appId, {}] as const;
			}
		}),
	);
	return new Map(entries);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function unknownSettingReply(): string {
	return 'Unknown setting.';
}

/**
 * Parse a qualified key into { appId, key }.
 * For system keys like "system.chat.sessions.retention_days", appId='system', key='chat.sessions.retention_days'.
 */
function parseQualifiedKey(qid: string): { appId: string; key: string } {
	const dotIdx = qid.indexOf('.');
	if (dotIdx === -1) return { appId: qid, key: '' };
	return { appId: qid.slice(0, dotIdx), key: qid.slice(dotIdx + 1) };
}

/**
 * Extract the value portion from rawArgs by skipping `skipCount` whitespace-delimited tokens.
 * Strips a single outer pair of double quotes if present.
 *
 * E.g. rawArgs = "food default_store Whole Foods Market", skipCount = 2
 *      → "Whole Foods Market"
 *
 * E.g. rawArgs = 'food default_store "Whole Foods Market"', skipCount = 2
 *      → "Whole Foods Market"
 */
function extractValueTail(rawArgs: string, skipCount: number): string {
	let remaining = rawArgs.trim();
	for (let i = 0; i < skipCount; i++) {
		const spaceIdx = remaining.search(/\s/);
		if (spaceIdx === -1) return '';
		remaining = remaining.slice(spaceIdx).trimStart();
	}
	// Strip a single outer pair of double quotes.
	if (remaining.startsWith('"') && remaining.endsWith('"') && remaining.length >= 2) {
		remaining = remaining.slice(1, -1);
	}
	return remaining;
}
