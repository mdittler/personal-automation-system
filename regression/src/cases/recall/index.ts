/**
 * Recall bucket cases (REQ-REG-005 spec lines 304-333).
 *
 * 25 labelled inputs split into:
 *   - 13 shouldRecall=true (some with exact temporal anchors)
 *   - 10 shouldRecall=false (greeting / fresh topic / weather / imperative)
 *   - 2 observational (non-gating ambiguous-pronoun edges)
 *
 * Each fixture pins `today: '2026-05-11'` (a Monday) so temporal cases can
 * assert exact `on` / `before` / `after` dates without rotting as real
 * calendar time advances. The runner forwards this `today` to the recall
 * adapter, which forwards it to `classifyRecallIntent`.
 *
 * Date math derives from `core/src/services/conversation-retrieval/recall-classifier.ts`:
 *   - "yesterday" → absolute { on: '2026-05-10' }  (today - 1 day)
 *   - "last week" → window   { after: '2026-05-04', before: '2026-05-10' }
 *                  (Monday of last week through Sunday of last week)
 *   - "in March"  → window   { after: '2026-03-01', before: '2026-03-31' }
 *   - "in April"  → window   { after: '2026-04-01', before: '2026-04-30' }
 *   - "last Friday" → absolute { on: '2026-05-08' } (Mon 2026-05-11, last Fri = 3d ago)
 */

import { fileURLToPath } from 'node:url';
import type { LoadedCase, PersonaCase, PersonaInput } from '@core/types/regression.js';

const TODAY = '2026-05-11'; // Monday — fixed reference date for deterministic temporal math
const YESTERDAY = '2026-05-10';
const LAST_FRIDAY = '2026-05-08';
const LAST_WEEK_AFTER = '2026-05-04'; // prior Monday
const LAST_WEEK_BEFORE = '2026-05-10'; // prior Sunday
const MARCH_AFTER = '2026-03-01';
const MARCH_BEFORE = '2026-03-31';
const APRIL_AFTER = '2026-04-01';
const APRIL_BEFORE = '2026-04-30';

const COVERAGE = [
	'core/src/services/conversation-retrieval/recall-classifier.ts',
	'core/src/services/conversation/recall-pipeline.ts',
	'core/src/services/chat-transcript-index/index.ts',
];

function expectTrueNullAnchor() {
	return {
		schema: {
			type: 'object',
			required: ['shouldRecall', 'query', 'timeAnchor', 'reason'],
			properties: {
				shouldRecall: { const: true },
				query: { type: 'string', minLength: 1 },
				timeAnchor: { type: 'null' },
				reason: { type: 'string' },
			},
		},
	};
}

function expectTrueAbsolute(on: string) {
	return {
		schema: {
			type: 'object',
			required: ['shouldRecall', 'query', 'timeAnchor', 'reason'],
			properties: {
				shouldRecall: { const: true },
				query: { type: 'string', minLength: 1 },
				timeAnchor: {
					type: 'object',
					required: ['type', 'on'],
					properties: {
						type: { const: 'absolute' },
						on: { const: on },
					},
				},
				reason: { type: 'string' },
			},
		},
	};
}

function expectTrueWindow(after: string, before: string) {
	return {
		schema: {
			type: 'object',
			required: ['shouldRecall', 'query', 'timeAnchor', 'reason'],
			properties: {
				shouldRecall: { const: true },
				query: { type: 'string', minLength: 1 },
				timeAnchor: {
					type: 'object',
					required: ['type'],
					properties: {
						type: { const: 'window' },
						after: { const: after },
						before: { const: before },
					},
				},
				reason: { type: 'string' },
			},
		},
	};
}

function expectFalse() {
	return {
		schema: {
			type: 'object',
			required: ['shouldRecall'],
			properties: { shouldRecall: { const: false } },
		},
	};
}

interface RecallFixture {
	id: string;
	description: string;
	payload: string;
	expected: ReturnType<typeof expectTrueNullAnchor>;
	today?: string;
	observational?: boolean;
}

const RECALL_FIXTURES: RecallFixture[] = [
	// ─── shouldRecall=true, no temporal anchor (5 cases) ──────────
	{
		id: 'recall-true-pronoun-leak',
		description: 'pronoun reference to prior topic — no temporal anchor',
		payload: 'what did we say about the leak earlier?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-pronoun-decision',
		description: 'recall a decision — meaningful query required (Codex C5)',
		payload: 'can you remind me what we decided?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-history-search',
		description: 'explicit history search',
		payload: 'search our history for talks about plumbing',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-previous-session',
		description: 'explicit reference to a prior session',
		payload: 'in our previous chat I mentioned a contractor — what was their name?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-discussed-before',
		description: 'discussed-before phrasing',
		payload: 'did we ever discuss the property tax appeal before?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	// ─── shouldRecall=true with exact temporal anchor (8 cases) ──
	{
		id: 'recall-true-yesterday',
		description: 'yesterday → absolute anchor 2026-05-10',
		payload: 'what did we talk about yesterday?',
		expected: expectTrueAbsolute(YESTERDAY),
		today: TODAY,
	},
	{
		id: 'recall-true-last-friday',
		description: 'last Friday → absolute anchor 2026-05-08 (findLastWeekday)',
		payload: 'remind me what we said last Friday',
		expected: expectTrueAbsolute(LAST_FRIDAY),
		today: TODAY,
	},
	{
		id: 'recall-true-last-week',
		description: 'last week → window {2026-05-04, 2026-05-10}',
		payload: 'what did we discuss last week about the budget?',
		expected: expectTrueWindow(LAST_WEEK_AFTER, LAST_WEEK_BEFORE),
		today: TODAY,
	},
	{
		id: 'recall-true-in-march',
		description: 'in March → window {2026-03-01, 2026-03-31}',
		payload: 'look up our conversation from March about recipes',
		expected: expectTrueWindow(MARCH_AFTER, MARCH_BEFORE),
		today: TODAY,
	},
	{
		id: 'recall-true-in-april',
		description: 'in April → window {2026-04-01, 2026-04-30}',
		payload: 'we talked in April about a vacation — find that conversation',
		expected: expectTrueWindow(APRIL_AFTER, APRIL_BEFORE),
		today: TODAY,
	},
	{
		id: 'recall-true-look-back',
		description: 'look-back imperative — no anchor',
		payload: 'look back at what I said about the dishwasher',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-remember-our-chat',
		description: 'remember our chat — no anchor',
		payload: 'remember our chat about taxes? what was the conclusion?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	{
		id: 'recall-true-last-time-decided',
		description: 'last time + meaningful query (Codex C5 — production rejects null query)',
		payload: 'what did we decide last time about the contractor quote?',
		expected: expectTrueNullAnchor(),
		today: TODAY,
	},
	// ─── shouldRecall=false (10 cases) ────────────────────────────
	{
		id: 'recall-false-greeting',
		description: 'pure greeting',
		payload: 'hey how is it going today',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-thanks',
		description: 'thanks',
		payload: 'thanks that worked perfectly',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-fresh-recipe',
		description: 'fresh-topic recipe ask',
		payload: 'what is a good risotto recipe for tonight',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-weather',
		description: 'weather query',
		payload: 'is it going to rain tomorrow afternoon',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-imperative-add',
		description: 'imperative without time reference',
		payload: 'add eggs and milk to the grocery list please',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-imperative-remove',
		description: 'imperative removal',
		payload: 'remove butter from the grocery list',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-explain-concept',
		description: 'explain a concept',
		payload: 'explain how the n8n dispatch works for routine alerts',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-list-pantry',
		description: 'inventory query',
		payload: 'what is in the pantry right now',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-meal-plan',
		description: 'fresh meal-plan request',
		payload: 'plan three dinners for this week using what we have',
		expected: expectFalse(),
		today: TODAY,
	},
	{
		id: 'recall-false-yes',
		description: 'short confirmation',
		payload: 'yes please go ahead',
		expected: expectFalse(),
		today: TODAY,
	},
	// ─── observational (2 cases — non-gating, Codex C4) ──────────
	{
		id: 'recall-observ-it-was-so-good',
		description: 'genuinely ambiguous bare-pronoun — observational, never gates',
		payload: 'it was so good last time',
		expected: expectTrueNullAnchor(), // shape only — observational ignores verdict
		today: TODAY,
		observational: true,
	},
	{
		id: 'recall-observ-that-was-helpful',
		description: 'genuinely ambiguous bare-pronoun — observational, never gates',
		payload: 'that was helpful',
		expected: expectFalse(), // shape only — observational ignores verdict
		today: TODAY,
		observational: true,
	},
];

export function buildCases(): LoadedCase[] {
	const filePath = fileURLToPath(import.meta.url);
	return RECALL_FIXTURES.map((fx): LoadedCase => {
		const input: PersonaInput & { today?: string; observational?: boolean } = {
			payload: fx.payload,
			expected: fx.expected,
		};
		if (fx.today !== undefined) input.today = fx.today;
		if (fx.observational) input.observational = true;
		const c: PersonaCase = {
			id: fx.id,
			description: fx.description,
			bucket: 'recall',
			coverage: COVERAGE,
			inputs: [input],
			oracle: 'structural',
			budgetUsd: 0.02,
		};
		return { case: c, filePath };
	});
}
