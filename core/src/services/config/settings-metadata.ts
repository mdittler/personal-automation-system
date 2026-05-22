/**
 * Shared metadata for system-scope settings.
 *
 * Single source of truth for:
 *   - SYSTEM_SETTING_DEFS: SettingDef entries with appId: 'system'
 *   - SYSTEM_KEY_RUNTIME_PATH: maps unqualified YAML key → dot-path through SystemConfig
 *   - Bound constants imported by both this file and pas-yaml-schema.ts so
 *     Zod and SettingDef bounds are always in sync.
 */
import type { SettingDef } from '../settings/settings-registry.js';
import { DEFAULT_ALWAYS_VERIFY_INTENTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Shared bound constants (imported by pas-yaml-schema.ts)
// ---------------------------------------------------------------------------

export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 3650;

export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 525_600;

export const UPPER_BOUND_MIN = 0;
export const UPPER_BOUND_MAX = 1;

// ---------------------------------------------------------------------------
// Runtime path table
// ---------------------------------------------------------------------------

/**
 * Maps each unqualified YAML key (e.g. 'chat.sessions.retention_days') to
 * the dot-notation path through the in-memory SystemConfig object.
 *
 * Most chat.sessions.* fields use snake_case in both YAML and SystemConfig.
 * routing.verification.upper_bound is an exception: camelCase in SystemConfig.
 */
export const SYSTEM_KEY_RUNTIME_PATH: Readonly<Record<string, string>> = {
	'chat.sessions.retention_days': 'chat.sessions.retention_days',
	'chat.sessions.auto_reset_idle_minutes': 'chat.sessions.auto_reset_idle_minutes',
	'chat.sessions.auto_prune': 'chat.sessions.auto_prune',
	'routing.verification.enabled': 'routing.verification.enabled',
	'routing.verification.upper_bound': 'routing.verification.upperBound',
	'routing.verification.always_verify_intents': 'routing.verification.alwaysVerifyIntents',
};

// ---------------------------------------------------------------------------
// System setting definitions
// ---------------------------------------------------------------------------

/**
 * Setting definitions for all system-scope keys. Registered with appId: 'system'
 * by buildSettingsRegistry. Do NOT include appId here — it is injected at
 * registration time.
 */
export const SYSTEM_SETTING_DEFS: ReadonlyArray<Omit<SettingDef, 'appId'>> = [
	{
		key: 'chat.sessions.retention_days',
		category: 'memory-sessions',
		label: 'Keep ended sessions for',
		help: 'How many days to keep ended chat session transcripts before they are eligible for pruning.',
		type: 'number',
		default: 90,
		min: RETENTION_DAYS_MIN,
		max: RETENTION_DAYS_MAX,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	},
	{
		key: 'chat.sessions.auto_reset_idle_minutes',
		category: 'memory-sessions',
		label: 'Auto-reset idle sessions after',
		help: 'Minutes of inactivity before a session is automatically ended. Leave blank to disable.',
		type: 'number',
		default: null,
		min: IDLE_MINUTES_MIN,
		max: IDLE_MINUTES_MAX,
		adminOnly: false,
		dangerous: false,
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: false,
	},
	{
		key: 'chat.sessions.auto_prune',
		category: 'dangerous',
		label: 'Auto-prune expired transcripts',
		help: 'When enabled, expired session transcripts are permanently deleted at startup.',
		type: 'boolean',
		default: false,
		adminOnly: true,
		dangerous: true,
		dangerConfirmPrompt: 'permanently delete expired transcripts',
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	},
	{
		key: 'routing.verification.enabled',
		category: 'system',
		label: 'Route verification',
		help: 'Enable secondary LLM verification pass for grey-zone intent classifications.',
		type: 'boolean',
		default: true,
		adminOnly: true,
		dangerous: false,
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	},
	{
		key: 'routing.verification.upper_bound',
		category: 'system',
		label: 'Verification upper bound',
		help: 'Confidence threshold above which route verification is skipped (0–1). Higher values verify more messages.',
		type: 'number',
		default: 0.7,
		min: UPPER_BOUND_MIN,
		max: UPPER_BOUND_MAX,
		adminOnly: true,
		dangerous: false,
		hidden: false,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	},
	{
		// hidden because the current GUI widget set (boolean/number/string/select)
		// does not render arrays. The def exists so the writer's runtime-path
		// allowlist and resetToSchemaDefault wiring stay uniform with the other
		// system keys; operators edit this via pas.yaml directly.
		key: 'routing.verification.always_verify_intents',
		category: 'system',
		label: 'Always-verify intents',
		help: 'Intent description strings that must always go through route verification, even when classifier confidence is above the upper bound. Edit via pas.yaml.',
		type: 'string',
		default: [...DEFAULT_ALWAYS_VERIFY_INTENTS],
		adminOnly: true,
		dangerous: false,
		hidden: true,
		scope: 'system',
		nlSafe: false,
		restartRequired: true,
	},
];
