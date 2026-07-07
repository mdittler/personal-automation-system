/**
 * Human-readable review sentences for reports and alerts (Batch 3 Task 3.2,
 * Batch 4 Task 4.2).
 *
 * `describeReport`/`describeAlert` deterministically assemble a plain-
 * language sentence from a definition, using the existing `describeCron`
 * helper for schedules and `humanizeLabel` for enum-ish fields (section
 * types, action types, condition types). No LLM involvement — these are
 * pure string builders. The returned string is plain text; callers
 * (templates) are responsible for escaping with `<%= %>`.
 */
import type { AlertAction, AlertDefinition } from '../../types/alert.js';
import type { ReportDefinition, ReportSection } from '../../types/report.js';
import { describeCron } from '../../utils/cron-describe.js';
import { humanizeLabel } from './humanize.js';
import { parseExpression } from './rule-builder.js';

function joinWithAnd(items: string[]): string {
	if (items.length === 0) return '';
	if (items.length === 1) return items[0] as string;
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function sectionLabels(sections: ReportSection[]): string[] {
	return sections.map((s) => s.label || humanizeLabel(s.type));
}

/** Build the human-readable review sentence for a report definition. */
export function describeReport(def: ReportDefinition): string {
	const scheduleText = def.schedule ? describeCron(def.schedule) : "a schedule that isn't set yet";
	const labels = sectionLabels(def.sections ?? []);
	const sectionsText =
		labels.length > 0 ? `a report with ${joinWithAnd(labels)}` : 'a report with no sections yet';

	const parts: string[] = [`${scheduleText}, build ${sectionsText}`];

	if (def.llm?.enabled) {
		parts.push('add an AI summary');
	}

	const deliveryCount = def.delivery?.length ?? 0;
	if (deliveryCount > 0) {
		parts.push(
			deliveryCount === 1
				? 'send it to you on Telegram'
				: `send it to ${deliveryCount} people on Telegram`,
		);
	}

	return `${joinWithAnd(parts)}.`.replace(/^./, (c) => c.toUpperCase());
}

/** Lowercase only the first character — preserves proper nouns like "Telegram". */
function lowerFirst(str: string): string {
	return str.length > 0 ? str.charAt(0).toLowerCase() + str.slice(1) : str;
}

function actionSummary(action: AlertAction): string {
	return lowerFirst(humanizeLabel(action.type));
}

/** Basename of a data-source path, without its extension (never a full path). */
function fileBasenameNoExt(path: string): string {
	const base = path.split('/').pop() ?? path;
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Plain-language phrasing for a deterministic condition expression, using the
 * rule-builder's six recognized patterns. Falls back to the raw expression
 * (prefixed with "it") for anything `parseExpression` can't map — e.g. a
 * legacy/Advanced expression that predates the rule builder.
 */
function deterministicConditionText(expression: string): string {
	const parsed = parseExpression(expression);
	if (!parsed) return `it ${expression}`;
	switch (parsed.pattern) {
		case 'is_empty':
			return "it's empty";
		case 'not_empty':
			return 'it has anything in it';
		case 'contains':
			return `it mentions "${parsed.text}"`;
		case 'not_contains':
			return `it doesn't mention "${parsed.text}"`;
		case 'more_lines':
			return `it has more than ${parsed.n} lines`;
		case 'fewer_lines':
			return `it has fewer than ${parsed.n} lines`;
	}
}

/**
 * Build the human-readable review sentence for an alert definition.
 *
 * Defensive against structurally-invalid definitions loaded from disk (a
 * malformed `alerts/*.yaml` can be missing `condition`/`actions`/`trigger`
 * entirely — the GUI still lists these with a validation-error badge, and
 * this sentence must render alongside that badge rather than throwing).
 */
export function describeAlert(def: AlertDefinition): string {
	const trigger = def.trigger ?? { type: 'scheduled' as const, schedule: def.schedule };
	const whenText =
		trigger.type === 'event'
			? 'When data changes'
			: trigger.schedule
				? describeCron(trigger.schedule)
				: "a schedule that isn't set yet";

	const condition = def.condition;
	const sourceLabels = (condition?.data_sources ?? []).map(
		(s) => `${humanizeLabel(s.app_id)} ${fileBasenameNoExt(s.path)}`,
	);
	const whatText = sourceLabels.length > 0 ? joinWithAnd(sourceLabels) : 'your data';

	const conditionText = !condition
		? "a condition that isn't set up yet"
		: condition.type === 'fuzzy'
			? `the AI judges "${condition.expression}"`
			: deterministicConditionText(condition.expression);

	const actionTexts = (def.actions ?? []).map(actionSummary);
	const actionsText =
		actionTexts.length > 0 ? joinWithAnd(actionTexts) : 'do nothing yet (no actions configured)';

	const cooldownText = def.cooldown ? ` Won't repeat within ${def.cooldown}.` : '';

	return `${whenText}, check ${whatText}; if ${conditionText}, ${actionsText}.${cooldownText}`.replace(
		/^./,
		(c) => c.toUpperCase(),
	);
}
