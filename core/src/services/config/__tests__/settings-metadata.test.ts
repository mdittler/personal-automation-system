/**
 * Tests for settings-metadata.ts — contract tests verifying that
 * SYSTEM_SETTING_DEFS, SYSTEM_KEY_RUNTIME_PATH, and the bound constants
 * are internally consistent and correctly wired into pas-yaml-schema.ts.
 *
 * REQ-SETTINGS-021: system defs shape is valid.
 */
import { describe, expect, it } from 'vitest';
import {
	IDLE_MINUTES_MAX,
	IDLE_MINUTES_MIN,
	RETENTION_DAYS_MAX,
	RETENTION_DAYS_MIN,
	SYSTEM_KEY_RUNTIME_PATH,
	SYSTEM_SETTING_DEFS,
	UPPER_BOUND_MAX,
	UPPER_BOUND_MIN,
} from '../settings-metadata.js';

// ---------------------------------------------------------------------------
// 1-to-1 coverage between SYSTEM_SETTING_DEFS and SYSTEM_KEY_RUNTIME_PATH
// ---------------------------------------------------------------------------

describe('SYSTEM_SETTING_DEFS ↔ SYSTEM_KEY_RUNTIME_PATH coverage', () => {
	it('every SYSTEM_SETTING_DEF key has an entry in SYSTEM_KEY_RUNTIME_PATH', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			expect(
				SYSTEM_KEY_RUNTIME_PATH,
				`key '${def.key}' missing from SYSTEM_KEY_RUNTIME_PATH`,
			).toHaveProperty(def.key);
		}
	});

	it('every SYSTEM_KEY_RUNTIME_PATH entry corresponds to a SYSTEM_SETTING_DEF', () => {
		const defKeys = new Set(SYSTEM_SETTING_DEFS.map((d) => d.key));
		for (const yamlKey of Object.keys(SYSTEM_KEY_RUNTIME_PATH)) {
			expect(
				defKeys.has(yamlKey),
				`runtime path key '${yamlKey}' has no matching SYSTEM_SETTING_DEF`,
			).toBe(true);
		}
	});

	it('no duplicate keys in SYSTEM_SETTING_DEFS', () => {
		const keys = SYSTEM_SETTING_DEFS.map((d) => d.key);
		expect(keys.length).toBe(new Set(keys).size);
	});
});

// ---------------------------------------------------------------------------
// SettingDef shape validity
// ---------------------------------------------------------------------------

describe('SYSTEM_SETTING_DEFS shape', () => {
	it('all defs have scope: system', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			expect(def.scope, `${def.key} should be system scope`).toBe('system');
		}
	});

	it('all defs have nlSafe: false (system keys not NL-writable)', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			expect(def.nlSafe, `${def.key} should have nlSafe=false`).toBe(false);
		}
	});

	it('dangerous defs have non-empty dangerConfirmPrompt and adminOnly: true', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			if (def.dangerous) {
				expect(
					typeof def.dangerConfirmPrompt === 'string' && def.dangerConfirmPrompt.length > 0,
					`${def.key} is dangerous but dangerConfirmPrompt is empty`,
				).toBe(true);
				expect(def.adminOnly, `${def.key} is dangerous but adminOnly is false`).toBe(true);
			}
		}
	});

	it('all numeric defs have defined min and max', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			if (def.type === 'number') {
				expect(typeof def.min === 'number', `${def.key} is numeric but has no min`).toBe(true);
				expect(typeof def.max === 'number', `${def.key} is numeric but has no max`).toBe(true);
			}
		}
	});

	it('non-hidden defs have non-empty help', () => {
		for (const def of SYSTEM_SETTING_DEFS) {
			if (!def.hidden) {
				expect(
					typeof def.help === 'string' && def.help.trim().length > 0,
					`${def.key} is not hidden but has empty help`,
				).toBe(true);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Bound constants wired into schema (contract test — REQ-SETTINGS-021)
// ---------------------------------------------------------------------------

describe('bound constants', () => {
	it('RETENTION_DAYS bounds match SettingDef.min/max', () => {
		const def = SYSTEM_SETTING_DEFS.find((d) => d.key === 'chat.sessions.retention_days')!;
		expect(def.min).toBe(RETENTION_DAYS_MIN);
		expect(def.max).toBe(RETENTION_DAYS_MAX);
	});

	it('IDLE_MINUTES bounds match SettingDef.min/max', () => {
		const def = SYSTEM_SETTING_DEFS.find((d) => d.key === 'chat.sessions.auto_reset_idle_minutes')!;
		expect(def.min).toBe(IDLE_MINUTES_MIN);
		expect(def.max).toBe(IDLE_MINUTES_MAX);
	});

	it('UPPER_BOUND constants match SettingDef.min/max', () => {
		const def = SYSTEM_SETTING_DEFS.find((d) => d.key === 'routing.verification.upper_bound')!;
		expect(def.min).toBe(UPPER_BOUND_MIN);
		expect(def.max).toBe(UPPER_BOUND_MAX);
	});
});

// ---------------------------------------------------------------------------
// Default values match schema defaults (contract)
// ---------------------------------------------------------------------------

describe('SYSTEM_SETTING_DEFS default values match config loader defaults', () => {
	it.each([
		['chat.sessions.retention_days', 90],
		['chat.sessions.auto_reset_idle_minutes', null],
		['chat.sessions.auto_prune', false],
		['routing.verification.enabled', true],
		['routing.verification.upper_bound', 0.7],
	])('%s default is %s', (key, expected) => {
		const def = SYSTEM_SETTING_DEFS.find((d) => d.key === key);
		expect(def, `no def found for key '${key}'`).toBeDefined();
		expect(def!.default).toBe(expected);
	});
});

// ---------------------------------------------------------------------------
// restartRequired flags
// ---------------------------------------------------------------------------

describe('restartRequired flags', () => {
	it.each([
		['chat.sessions.retention_days', true],
		['chat.sessions.auto_reset_idle_minutes', false],
		['chat.sessions.auto_prune', true],
		['routing.verification.enabled', true],
		['routing.verification.upper_bound', true],
	])('%s has restartRequired=%s', (key, expected) => {
		const def = SYSTEM_SETTING_DEFS.find((d) => d.key === key);
		expect(def).toBeDefined();
		expect(def!.restartRequired).toBe(expected);
	});
});
