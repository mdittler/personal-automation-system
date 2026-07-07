/**
 * Schedule presets for the report/alert wizards (Batch 3, Task 3.1).
 *
 * Nontechnical users pick a plain-language preset ("Every day at…") rather
 * than typing a raw cron expression. `presetToCron`/`cronToPresetId` map
 * between the preset + its parameters and the real 5-field cron string that
 * the existing report/alert POST contracts expect (`schedule` field,
 * unchanged). `nextRunPreview` reuses the existing `cron-describe` helpers —
 * never reimplemented.
 */
import { describeCron, formatRelativeTime, getNextRun } from '../../utils/cron-describe.js';

export interface SchedulePreset {
	id: string;
	label: string;
	needsTime?: boolean;
	needsWeekday?: boolean;
}

/** The four presets offered by the wizard's "When" step. Order is display order. */
export const PRESETS: SchedulePreset[] = [
	{ id: 'daily', label: 'Every day at…', needsTime: true },
	{ id: 'weekly', label: 'Weekly on…', needsTime: true, needsWeekday: true },
	{ id: 'hourly', label: 'Every hour' },
	{ id: 'weekdays', label: 'Weekday mornings', needsTime: true },
];

const PRESET_IDS = new Set(PRESETS.map((p) => p.id));

export interface PresetOpts {
	hour?: number;
	minute?: number;
	weekday?: number;
}

/** Build a 5-field cron expression for the given preset + parameters. */
export function presetToCron(id: string, opts: PresetOpts): string {
	const hour = opts.hour ?? 0;
	const minute = opts.minute ?? 0;
	const weekday = opts.weekday ?? 0;

	switch (id) {
		case 'daily':
			return `${minute} ${hour} * * *`;
		case 'weekly':
			return `${minute} ${hour} * * ${weekday}`;
		case 'hourly':
			return '0 * * * *';
		case 'weekdays':
			return `${minute} ${hour} * * 1-5`;
		default:
			throw new Error(`Unknown schedule preset: ${id}`);
	}
}

export interface ParsedPreset {
	id: string;
	hour?: number;
	minute?: number;
	weekday?: number;
}

const DAILY_RE = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const WEEKLY_RE = /^(\d{1,2}) (\d{1,2}) \* \* (\d)$/;
const HOURLY_RE = /^0 \* \* \* \*$/;
const WEEKDAYS_RE = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/;

/**
 * Recognize a cron expression as one of the four presets, returning its id +
 * parameters. Returns null for anything else — the wizard renders those as
 * "Advanced"/custom with the raw expression prefilled.
 */
export function cronToPresetId(cron: string): ParsedPreset | null {
	const trimmed = cron.trim();

	let m = trimmed.match(WEEKLY_RE);
	if (m) {
		return { id: 'weekly', minute: Number(m[1]), hour: Number(m[2]), weekday: Number(m[3]) };
	}

	m = trimmed.match(WEEKDAYS_RE);
	if (m) {
		return { id: 'weekdays', minute: Number(m[1]), hour: Number(m[2]) };
	}

	if (HOURLY_RE.test(trimmed)) {
		return { id: 'hourly' };
	}

	m = trimmed.match(DAILY_RE);
	if (m) {
		return { id: 'daily', minute: Number(m[1]), hour: Number(m[2]) };
	}

	return null;
}

/** Render a human "Next run: …" sentence, or a friendly message for an invalid cron. */
export function nextRunPreview(cron: string, tz: string): string {
	const next = getNextRun(cron, tz);
	if (!next) return "That schedule isn't valid yet.";
	return `Next run: ${formatRelativeTime(next)} (${describeCron(cron)})`;
}

/** Exported for callers that need to check a value is a known preset id. */
export function isKnownPresetId(id: string): boolean {
	return PRESET_IDS.has(id);
}

/**
 * 12h clock label for an on-the-hour time (e.g. hour=7 -> "7:00 AM",
 * hour=13 -> "1:00 PM"). Used by the report/alert wizards' step-2 time
 * `<select>` (C6 fix — replaces the programmer-speak "Hour (0-23)" numeric
 * input with a plain-language dropdown; the submitted VALUE stays the same
 * 0-23 integer the presetToCron contract already expects).
 */
export function hourLabel12h(hour: number): string {
	const period = hour < 12 ? 'AM' : 'PM';
	const displayHour = hour % 12 === 0 ? 12 : hour % 12;
	return `${displayHour}:00 ${period}`;
}

/** Full weekday name for a `preset_weekday` value (0=Sunday..6=Saturday). */
const WEEKDAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
];

export function weekdayLabel(weekday: number): string {
	return WEEKDAY_NAMES[weekday] ?? '';
}
