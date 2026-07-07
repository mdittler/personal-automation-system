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

function actionSummary(action: AlertAction): string {
	const label = humanizeLabel(action.type).toLowerCase();
	return label;
}

/** Build the human-readable review sentence for an alert definition. */
export function describeAlert(def: AlertDefinition): string {
	const trigger = def.trigger ?? { type: 'scheduled', schedule: def.schedule };
	const whenText =
		trigger.type === 'event'
			? 'When data changes'
			: trigger.schedule
				? describeCron(trigger.schedule)
				: "a schedule that isn't set yet";

	const sourceLabels = (def.condition.data_sources ?? []).map(
		(s) => `${humanizeLabel(s.app_id)} ${s.path.split('/').pop()}`,
	);
	const whatText = sourceLabels.length > 0 ? joinWithAnd(sourceLabels) : 'your data';

	const conditionText =
		def.condition.type === 'fuzzy'
			? `the AI judges "${def.condition.expression}"`
			: `it ${def.condition.expression}`;

	const actionTexts = (def.actions ?? []).map(actionSummary);
	const actionsText =
		actionTexts.length > 0 ? joinWithAnd(actionTexts) : 'do nothing yet (no actions configured)';

	const cooldownText = def.cooldown ? ` Won't repeat within ${def.cooldown}.` : '';

	return `${whenText}, check ${whatText}; if ${conditionText}, ${actionsText}.${cooldownText}`.replace(
		/^./,
		(c) => c.toUpperCase(),
	);
}
