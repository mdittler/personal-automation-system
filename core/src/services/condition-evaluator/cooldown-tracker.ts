/**
 * Cooldown tracker for condition rules.
 *
 * Parses cooldown strings ("48 hours", "7 days", "30 minutes"),
 * tracks last-fired timestamps, and determines if a rule can fire again.
 */

import type { RuleStatus } from '../../types/condition.js';

/**
 * Parse a cooldown string into milliseconds.
 *
 * Supported formats:
 * - "N minutes" or "N minute"
 * - "N hours" or "N hour"
 * - "N days" or "N day"
 *
 * @returns milliseconds, or 0 if the string cannot be parsed
 */
export function parseCooldown(cooldownStr: string): number {
	const match = cooldownStr.trim().match(/^(\d+)\s+(minutes?|hours?|days?)$/i);
	if (!match) return 0;

	const value = Number.parseInt(match[1] ?? '0', 10);
	const unit = (match[2] ?? '').toLowerCase();

	if (unit.startsWith('minute')) return value * 60 * 1000;
	if (unit.startsWith('hour')) return value * 60 * 60 * 1000;
	if (unit.startsWith('day')) return value * 24 * 60 * 60 * 1000;

	return 0;
}

/**
 * Check if a rule can fire, given its last-fired time and cooldown.
 *
 * @param lastFired - When the rule last fired (null if never)
 * @param cooldownMs - Cooldown duration in milliseconds
 * @param now - Current time (for testing)
 * @returns true if the rule is ready to fire
 */
export function canFire(
	lastFired: Date | null,
	cooldownMs: number,
	now: Date = new Date(),
): boolean {
	if (lastFired === null) return true;
	return now.getTime() - lastFired.getTime() >= cooldownMs;
}

/**
 * Get the cooldown remaining in milliseconds.
 *
 * @returns 0 if the rule is ready, positive ms otherwise
 */
export function getCooldownRemaining(
	lastFired: Date | null,
	cooldownMs: number,
	now: Date = new Date(),
): number {
	if (lastFired === null) return 0;

	const elapsed = now.getTime() - lastFired.getTime();
	const remaining = cooldownMs - elapsed;

	return remaining > 0 ? remaining : 0;
}

/**
 * Build a RuleStatus object for a rule.
 */
export function buildRuleStatus(
	ruleId: string,
	lastFired: Date | null,
	cooldownMs: number,
	now: Date = new Date(),
): RuleStatus {
	const remaining = getCooldownRemaining(lastFired, cooldownMs, now);

	return {
		id: ruleId,
		lastFired,
		cooldownRemaining: remaining,
		isActive: remaining === 0,
	};
}
