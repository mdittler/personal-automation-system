/**
 * Health correlation handler — NL intent detection and on-demand correlation.
 *
 * isHealthCorrelationIntent: exported predicate for use in handleMessage.
 * handleHealthCorrelation: calls the correlator and formats the response.
 */

import type { CoreServices, MessageContext } from '@pas/core/types';
import { correlateHealth } from '../services/health-correlator.js';

// ─── NL intent predicate ─────────────────────────────────────────────────

// Matches explicit analytical requests about how diet/nutrition is performing.
// Deliberately narrow — only questions the correlator can answer with available
// nutrition data. Biometrics (mood, energy, sleep, performance, wellbeing) are
// excluded: they have too many external factors and no data source yet.
// A future health app will supply health:daily-metrics events to enable those.
const HEALTH_CORRELATION_PATTERNS = [
	// "how is my diet/eating/food/nutrition affecting me / my health"
	/how\s+is\s+(my\s+)?(diet|eating|food|nutrition)\s+(affect|impact)/i,
	// "how does my diet/eating/food/nutrition affect me / my health"
	/how\s+does\s+(my\s+)?(diet|eating|food|nutrition)\s+affect/i,
	// "health correlation" / "diet and health" / "food and health" / "nutrition and health"
	/(health\s+correlation|diet.*health|food.*health|nutrition.*health)/i,
	// "diet health check" — explicit request
	/\bdiet\s+health\s+check\b/i,
	// "correlate my food/diet/eating/nutrition"
	/\bcorrelate\s+(my\s+)?(diet|food|eating|nutrition)/i,
];

// Biometrics excluded from this handler — not tracked and have too many
// external factors. Deferred until a health app provides the data.
const HEALTH_BIOMETRIC_EXCLUSIONS =
	/\b(mood|energy|sleep(?:ing)?|performance|wellbeing|well-being)\b/i;

/**
 * Returns true if the message appears to be a health-correlation query.
 * Ordered after isAdherenceIntent and isNutritionViewIntent in handleMessage.
 */
export function isHealthCorrelationIntent(text: string): boolean {
	if (HEALTH_BIOMETRIC_EXCLUSIONS.test(text)) return false;
	return HEALTH_CORRELATION_PATTERNS.some(re => re.test(text));
}

// ─── Period extraction ────────────────────────────────────────────────────

/**
 * Extracts the analysis window from natural language.
 * Defaults to 14 days when no period is mentioned.
 * Capped at 90 days.
 */
export function extractPeriodDays(text: string): number {
	const lower = text.toLowerCase();
	if (/\b(last\s+)?(3\s+months?|three\s+months?|quarter)\b|90\s+days?\b/.test(lower)) return 90;
	if (/\b(last\s+)?(month|30\s+days?)\b/.test(lower)) return 30;
	if (/\b(last\s+)?(2\s+weeks?|two\s+weeks?|fortnight|14\s+days?)\b/.test(lower)) return 14;
	if (/\b(last\s+)?(week|7\s+days?)\b/.test(lower)) return 7;
	return 14;
}

// ─── On-demand handler ───────────────────────────────────────────────────

export async function handleHealthCorrelation(
	services: CoreServices,
	ctx: MessageContext,
): Promise<void> {
	const userId = ctx.userId;
	const userStore = services.data.forUser(userId);
	const sharedStore = services.data.forShared('shared');

	const periodDays = extractPeriodDays(ctx.text ?? '');
	const insights = await correlateHealth(services, userStore, sharedStore, periodDays);

	if (insights === null) {
		await services.telegram.send(
			userId,
			'Sorry, I ran into an issue generating your nutrition analysis. Please try again later.',
		);
		return;
	}

	if (insights.length === 0) {
		await services.telegram.send(
			userId,
			`I need more data before I can spot patterns. Keep logging your meals — I'll need at least 5 days of nutrition data to surface insights.`,
		);
		return;
	}

	const lines: string[] = [`Here's what your last ${periodDays} days of data suggest:`, ''];
	for (const insight of insights) {
		lines.push(`📊 **${capitalise(insight.metric)}**: ${insight.pattern}`);
		lines.push(`_${insight.disclaimer}_`);
		lines.push('');
	}

	await services.telegram.send(userId, lines.join('\n').trimEnd());
}

function capitalise(str: string): string {
	return str.charAt(0).toUpperCase() + str.slice(1);
}
