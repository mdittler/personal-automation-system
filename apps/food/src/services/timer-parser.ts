/**
 * Timer parser — extracts cooking durations from recipe step text.
 *
 * Pure functions, no side effects. Used by cook-mode to detect
 * when a step has timing info and offer a "Set Timer" button.
 */

export interface ParsedTimer {
	durationMinutes: number;
	originalText: string; // matched fragment for display
}

// Unit multipliers (to minutes)
const UNIT_MAP: Record<string, number> = {
	sec: 1 / 60,
	secs: 1 / 60,
	second: 1 / 60,
	seconds: 1 / 60,
	min: 1,
	mins: 1,
	minute: 1,
	minutes: 1,
	hr: 60,
	hrs: 60,
	hour: 60,
	hours: 60,
};

// Match compound: "1 hour 30 minutes", "1 hour and 15 minutes"
const COMPOUND_RE =
	/(\d+)\s*(hours?|hrs?)\s*(?:and\s*)?(\d+)\s*(minutes?|mins?|seconds?|secs?)/i;

// Match range: "5-7 minutes", "10 to 15 min"
const RANGE_RE =
	/(\d+)\s*(?:-|to)\s*(\d+)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i;

// Match simple: "25 minutes", "1 hour", "30 sec"
const SIMPLE_RE = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i;

// Match approximate prefix: "about 20 minutes"
const APPROX_RE =
	/(?:about|approximately|around|roughly)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|seconds?|secs?)/i;

function unitToMinutes(value: number, unit: string): number {
	const key = unit.toLowerCase();
	return value * (UNIT_MAP[key] ?? 1);
}

/** Returns null if no timing detected in the step text. */
export function parseStepTimer(stepText: string): ParsedTimer | null {
	if (!stepText) return null;

	// Try compound first (most specific)
	let match = COMPOUND_RE.exec(stepText);
	if (match) {
		const hourVal = Number.parseInt(match[1]!, 10);
		const subVal = Number.parseInt(match[3]!, 10);
		const hourMinutes = unitToMinutes(hourVal, match[2]!);
		const subMinutes = unitToMinutes(subVal, match[4]!);
		return {
			durationMinutes: hourMinutes + subMinutes,
			originalText: match[0],
		};
	}

	// Try range (before simple, since range contains simple-looking numbers)
	match = RANGE_RE.exec(stepText);
	if (match) {
		const low = Number.parseFloat(match[1]!);
		const high = Number.parseFloat(match[2]!);
		const unit = match[3]!;
		const midpoint = (low + high) / 2;
		return {
			durationMinutes: unitToMinutes(midpoint, unit),
			originalText: match[0],
		};
	}

	// Try approximate
	match = APPROX_RE.exec(stepText);
	if (match) {
		const value = Number.parseFloat(match[1]!);
		const unit = match[2]!;
		return {
			durationMinutes: unitToMinutes(value, unit),
			originalText: match[0],
		};
	}

	// Try simple
	match = SIMPLE_RE.exec(stepText);
	if (match) {
		const value = Number.parseFloat(match[1]!);
		const unit = match[2]!;
		return {
			durationMinutes: unitToMinutes(value, unit),
			originalText: match[0],
		};
	}

	return null;
}

/** Format duration for display: "25 min", "1 hr 30 min", "30 sec" */
export function formatDuration(minutes: number): string {
	if (minutes < 1) {
		const secs = Math.round(minutes * 60);
		return `${secs} sec`;
	}

	const wholeMinutes = Math.floor(minutes);
	const remainingSeconds = Math.round((minutes - wholeMinutes) * 60);

	if (wholeMinutes >= 60) {
		const hours = Math.floor(wholeMinutes / 60);
		const mins = wholeMinutes % 60;
		if (mins === 0) return `${hours} hr`;
		return `${hours} hr ${mins} min`;
	}

	if (remainingSeconds > 0) {
		return `${wholeMinutes} min ${remainingSeconds} sec`;
	}

	return `${wholeMinutes} min`;
}
