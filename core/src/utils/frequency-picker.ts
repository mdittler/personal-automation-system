/**
 * Frequency picker utility.
 *
 * Converts between human-friendly frequency settings and 5-field cron expressions.
 * Used by report and alert GUI forms to replace raw cron input.
 */

export type Frequency =
	| 'hourly'
	| 'daily'
	| 'weekly'
	| 'monthly'
	| 'quarterly'
	| 'yearly'
	| 'custom';

export interface FrequencyConfig {
	frequency: Frequency;
	/** Hour of the day (0-23). Used for daily, weekly, monthly, quarterly, yearly. */
	hour?: number;
	/** Minute of the hour (0-59). Default 0. */
	minute?: number;
	/** Day of week (0=Sun, 1=Mon, ..., 6=Sat). Used for weekly. */
	dayOfWeek?: number;
	/** Day of month (1-28). Used for monthly. */
	dayOfMonth?: number;
}

/** Clamp a numeric value to [min, max], falling back to def for NaN/undefined. */
function clamp(val: number | undefined, def: number, min: number, max: number): number {
	const v = val ?? def;
	return Number.isNaN(v) ? def : Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Convert a FrequencyConfig to a 5-field cron expression.
 */
export function frequencyToCron(config: FrequencyConfig): string {
	const minute = clamp(config.minute, 0, 0, 59);
	const hour = clamp(config.hour, 9, 0, 23);

	switch (config.frequency) {
		case 'hourly':
			return `${minute} * * * *`;
		case 'daily':
			return `${minute} ${hour} * * *`;
		case 'weekly':
			return `${minute} ${hour} * * ${clamp(config.dayOfWeek, 1, 0, 6)}`;
		case 'monthly':
			return `${minute} ${hour} ${clamp(config.dayOfMonth, 1, 1, 28)} * *`;
		case 'quarterly':
			return `${minute} ${hour} 1 1,4,7,10 *`;
		case 'yearly':
			return `${minute} ${hour} 1 1 *`;
		case 'custom':
			return '* * * * *';
	}
}

/**
 * Best-effort reverse mapping from a cron expression to FrequencyConfig.
 * Returns frequency='custom' for patterns that don't match known presets.
 */
export function cronToFrequency(cron: string): FrequencyConfig {
	if (!cron || typeof cron !== 'string') {
		return { frequency: 'custom' };
	}

	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) {
		return { frequency: 'custom' };
	}

	// Length already validated above
	const minutePart = parts[0] as string;
	const hourPart = parts[1] as string;
	const domPart = parts[2] as string;
	const monthPart = parts[3] as string;
	const dowPart = parts[4] as string;

	const isPlainDigits = (s: string) => /^\d+$/.test(s);

	// Hourly: N * * * *
	if (hourPart === '*' && domPart === '*' && monthPart === '*' && dowPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		if (!Number.isNaN(minute) && isPlainDigits(minutePart)) {
			return { frequency: 'hourly', minute };
		}
	}

	// Quarterly: N H 1 1,4,7,10 *
	if (domPart === '1' && monthPart === '1,4,7,10' && dowPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		const hour = Number.parseInt(hourPart, 10);
		if (
			!Number.isNaN(minute) &&
			!Number.isNaN(hour) &&
			isPlainDigits(minutePart) &&
			isPlainDigits(hourPart)
		) {
			return { frequency: 'quarterly', hour, minute };
		}
	}

	// Yearly: N H 1 1 *
	if (domPart === '1' && monthPart === '1' && dowPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		const hour = Number.parseInt(hourPart, 10);
		if (
			!Number.isNaN(minute) &&
			!Number.isNaN(hour) &&
			isPlainDigits(minutePart) &&
			isPlainDigits(hourPart)
		) {
			return { frequency: 'yearly', hour, minute };
		}
	}

	// Monthly: N H D * *
	if (monthPart === '*' && dowPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		const hour = Number.parseInt(hourPart, 10);
		const dom = Number.parseInt(domPart, 10);
		if (
			!Number.isNaN(minute) &&
			!Number.isNaN(hour) &&
			!Number.isNaN(dom) &&
			isPlainDigits(minutePart) &&
			isPlainDigits(hourPart) &&
			isPlainDigits(domPart) &&
			dom >= 1 &&
			dom <= 28
		) {
			return { frequency: 'monthly', hour, minute, dayOfMonth: dom };
		}
	}

	// Weekly: N H * * DOW
	if (domPart === '*' && monthPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		const hour = Number.parseInt(hourPart, 10);
		const dow = Number.parseInt(dowPart, 10);
		if (
			!Number.isNaN(minute) &&
			!Number.isNaN(hour) &&
			!Number.isNaN(dow) &&
			isPlainDigits(minutePart) &&
			isPlainDigits(hourPart) &&
			isPlainDigits(dowPart) &&
			dow >= 0 &&
			dow <= 6
		) {
			return { frequency: 'weekly', hour, minute, dayOfWeek: dow };
		}
	}

	// Daily: N H * * *
	if (domPart === '*' && monthPart === '*' && dowPart === '*') {
		const minute = Number.parseInt(minutePart, 10);
		const hour = Number.parseInt(hourPart, 10);
		if (
			!Number.isNaN(minute) &&
			!Number.isNaN(hour) &&
			isPlainDigits(minutePart) &&
			isPlainDigits(hourPart)
		) {
			return { frequency: 'daily', hour, minute };
		}
	}

	return { frequency: 'custom' };
}
