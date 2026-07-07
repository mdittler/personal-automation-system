/**
 * Schedule presets utility (Batch 3, Task 3.1).
 *
 * Maps a small set of plain-language schedule presets to real cron
 * expressions and back, and renders a human "next run" preview using the
 * existing cron-describe helpers (never reimplemented).
 */
import { describe, expect, it } from 'vitest';
import { getNextRun } from '../../../utils/cron-describe.js';
import { PRESETS, cronToPresetId, nextRunPreview, presetToCron } from '../schedule-presets.js';

describe('schedule-presets', () => {
	it('maps every preset to a valid cron accepted by getNextRun', () => {
		for (const p of PRESETS) {
			const cron = presetToCron(p.id, { hour: 7, minute: 0, weekday: 1 });
			expect(getNextRun(cron, 'America/New_York')).not.toBeNull();
		}
	});

	it('round-trips: cronToPresetId(presetToCron(x)) === x for parameterized presets', () => {
		const cases: Array<{ id: string; hour: number; minute: number; weekday?: number }> = [
			{ id: 'daily', hour: 7, minute: 0 },
			{ id: 'daily', hour: 23, minute: 45 },
			{ id: 'weekly', hour: 9, minute: 30, weekday: 3 },
			{ id: 'weekly', hour: 0, minute: 0, weekday: 0 },
			{ id: 'hourly', hour: 0, minute: 0 },
			{ id: 'weekdays', hour: 8, minute: 15 },
		];
		for (const c of cases) {
			const cron = presetToCron(c.id, c);
			const parsed = cronToPresetId(cron);
			expect(parsed).not.toBeNull();
			expect(parsed?.id).toBe(c.id);
			if (c.id !== 'hourly') {
				expect(parsed?.hour).toBe(c.hour);
				expect(parsed?.minute).toBe(c.minute);
			}
			if (c.id === 'weekly') {
				expect(parsed?.weekday).toBe(c.weekday);
			}
		}
	});

	it('returns null presetId for a cron that matches no preset (custom)', () => {
		expect(cronToPresetId('*/7 3 * * 2')).toBeNull();
	});

	it('nextRunPreview renders a human sentence', () => {
		expect(nextRunPreview('0 7 * * *', 'America/New_York')).toMatch(/^Next run: /);
	});

	it('nextRunPreview handles an invalid cron gracefully', () => {
		expect(nextRunPreview('not a cron', 'America/New_York')).toBe("That schedule isn't valid yet.");
	});

	it('PRESETS has exactly the four documented ids', () => {
		expect(PRESETS.map((p) => p.id)).toEqual(['daily', 'weekly', 'hourly', 'weekdays']);
	});
});
