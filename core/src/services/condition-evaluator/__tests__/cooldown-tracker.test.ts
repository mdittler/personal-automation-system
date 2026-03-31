import { describe, expect, it } from 'vitest';
import {
	buildRuleStatus,
	canFire,
	getCooldownRemaining,
	parseCooldown,
} from '../cooldown-tracker.js';

describe('parseCooldown', () => {
	it('parses minutes', () => {
		expect(parseCooldown('30 minutes')).toBe(30 * 60 * 1000);
		expect(parseCooldown('1 minute')).toBe(60 * 1000);
	});

	it('parses hours', () => {
		expect(parseCooldown('24 hours')).toBe(24 * 60 * 60 * 1000);
		expect(parseCooldown('1 hour')).toBe(60 * 60 * 1000);
	});

	it('parses days', () => {
		expect(parseCooldown('7 days')).toBe(7 * 24 * 60 * 60 * 1000);
		expect(parseCooldown('1 day')).toBe(24 * 60 * 60 * 1000);
	});

	it('returns 0 for unrecognized formats', () => {
		expect(parseCooldown('forever')).toBe(0);
		expect(parseCooldown('')).toBe(0);
		expect(parseCooldown('5 weeks')).toBe(0);
	});
});

describe('canFire', () => {
	it('returns true when lastFired is null (never fired)', () => {
		expect(canFire(null, 86400000)).toBe(true);
	});

	it('returns false when within cooldown', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-27T11:00:00Z'); // 1 hour ago
		const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

		expect(canFire(lastFired, cooldownMs, now)).toBe(false);
	});

	it('returns true when cooldown has expired', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-27T09:00:00Z'); // 3 hours ago
		const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

		expect(canFire(lastFired, cooldownMs, now)).toBe(true);
	});

	it('returns true when cooldown exactly matches elapsed time', () => {
		const now = new Date('2026-02-27T14:00:00Z');
		const lastFired = new Date('2026-02-27T12:00:00Z'); // exactly 2 hours ago
		const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

		expect(canFire(lastFired, cooldownMs, now)).toBe(true);
	});
});

describe('getCooldownRemaining', () => {
	it('returns 0 when lastFired is null', () => {
		expect(getCooldownRemaining(null, 86400000)).toBe(0);
	});

	it('returns remaining ms when in cooldown', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-27T11:00:00Z'); // 1 hour ago
		const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

		expect(getCooldownRemaining(lastFired, cooldownMs, now)).toBe(60 * 60 * 1000); // 1 hour remaining
	});

	it('returns 0 when cooldown has expired', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-27T09:00:00Z'); // 3 hours ago
		const cooldownMs = 2 * 60 * 60 * 1000; // 2 hours

		expect(getCooldownRemaining(lastFired, cooldownMs, now)).toBe(0);
	});
});

describe('buildRuleStatus', () => {
	it('builds active status for never-fired rule', () => {
		const status = buildRuleStatus('rule-1', null, 86400000);

		expect(status.id).toBe('rule-1');
		expect(status.lastFired).toBeNull();
		expect(status.cooldownRemaining).toBe(0);
		expect(status.isActive).toBe(true);
	});

	it('builds inactive status for rule in cooldown', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-27T11:00:00Z');
		const cooldownMs = 2 * 60 * 60 * 1000;

		const status = buildRuleStatus('rule-2', lastFired, cooldownMs, now);

		expect(status.id).toBe('rule-2');
		expect(status.lastFired).toBe(lastFired);
		expect(status.cooldownRemaining).toBe(60 * 60 * 1000);
		expect(status.isActive).toBe(false);
	});

	it('builds active status for rule with expired cooldown', () => {
		const now = new Date('2026-02-27T12:00:00Z');
		const lastFired = new Date('2026-02-26T12:00:00Z'); // 24 hours ago
		const cooldownMs = 12 * 60 * 60 * 1000; // 12 hour cooldown

		const status = buildRuleStatus('rule-3', lastFired, cooldownMs, now);

		expect(status.isActive).toBe(true);
		expect(status.cooldownRemaining).toBe(0);
	});
});
