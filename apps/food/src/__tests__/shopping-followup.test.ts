import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import type { CoreServices } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cancelShoppingFollowup,
	FOLLOWUP_DELAY_MS,
	handleShopFollowupClearCallback,
	handleShopFollowupKeepCallback,
	handleShoppingFollowupJob,
	scheduleShoppingFollowup,
} from '../handlers/shopping-followup.js';

// ─── Factory helpers ──────────────────────────────────────────────────────────

function makeHouseholdYaml(members = ['u1']): string {
	return `id: hh-1\nname: Test Family\ncreatedBy: u1\nmembers:\n${members.map((m) => `  - ${m}`).join('\n')}\njoinCode: ABC123\ncreatedAt: "2026-01-01"`;
}

function makeGroceryListYaml(items: Array<{ name: string; purchased: boolean }>): string {
	const itemLines = items
		.map(
			(i) =>
				`  - name: ${i.name}\n    quantity: null\n    unit: null\n    department: Other\n    recipeIds: []\n    purchased: ${i.purchased}\n    addedBy: u1`,
		)
		.join('\n');
	return `id: list-1\nitems:\n${itemLines}\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"`;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

describe('shopping-followup handler', () => {
	let services: CoreServices;
	let sharedStore: ReturnType<typeof createMockScopedStore>;

	beforeEach(() => {
		vi.useFakeTimers();
		cancelShoppingFollowup(); // reset module state
		sharedStore = createMockScopedStore();
		services = createMockCoreServices();
		vi.mocked(services.data.forShared).mockReturnValue(sharedStore as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ─── scheduleShoppingFollowup ─────────────────────────────────────

	describe('scheduleShoppingFollowup', () => {
		it('logs info when scheduling', () => {
			scheduleShoppingFollowup(services, 'u1', 3);
			expect(vi.mocked(services.logger.info)).toHaveBeenCalledWith(
				expect.stringContaining('u1'),
			);
		});

		it('stores pending data for the follow-up job', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(makeGroceryListYaml([{ name: 'Milk', purchased: false }]));
			});

			scheduleShoppingFollowup(services, 'u1', 1);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalledOnce();
		});

		it('does not fire before the delay elapses', async () => {
			scheduleShoppingFollowup(services, 'u1', 2);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS - 1);
			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();
		});
	});

	// ─── cancelShoppingFollowup ───────────────────────────────────────

	describe('cancelShoppingFollowup', () => {
		it('prevents the timer from firing', async () => {
			sharedStore.read.mockResolvedValue(makeGroceryListYaml([{ name: 'Milk', purchased: false }]));

			scheduleShoppingFollowup(services, 'u1', 1);
			cancelShoppingFollowup();
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();
		});

		it('is safe to call when nothing is scheduled', () => {
			expect(() => cancelShoppingFollowup()).not.toThrow();
		});
	});

	// ─── Re-scheduling cancels previous timer ─────────────────────────

	describe('re-scheduling', () => {
		it('cancels the previous timer and starts a fresh one', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(makeGroceryListYaml([{ name: 'Eggs', purchased: false }]));
			});

			// Schedule once, advance partway
			scheduleShoppingFollowup(services, 'u1', 2);
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // 30 min

			// Re-schedule — previous timer should be cancelled
			scheduleShoppingFollowup(services, 'u1', 2);

			// Advance to what would have been the original fire time
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // another 30 min

			// Should NOT have fired yet (new timer is still 30 min away)
			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();

			// Now advance to new timer fire time
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000); // remaining 30 min

			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalledOnce();
		});
	});

	// ─── handleShoppingFollowupJob ────────────────────────────────────

	describe('handleShoppingFollowupJob', () => {
		it('does nothing when no pending data', async () => {
			await handleShoppingFollowupJob(services);
			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();
		});

		it('sends follow-up message when unpurchased items remain', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(
					makeGroceryListYaml([
						{ name: 'Milk', purchased: false },
						{ name: 'Butter', purchased: true },
					]),
				);
			});

			scheduleShoppingFollowup(services, 'u1', 1);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			expect(vi.mocked(services.telegram.sendWithButtons)).toHaveBeenCalledOnce();
			const [userId, message, buttons] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
			expect(userId).toBe('u1');
			expect(message).toContain('Milk');
			expect(message).toContain('Done shopping?');
			expect(buttons).toEqual(
				expect.arrayContaining([
					expect.arrayContaining([
						expect.objectContaining({ callbackData: 'app:food:shop-followup:clear' }),
						expect.objectContaining({ callbackData: 'app:food:shop-followup:keep' }),
					]),
				]),
			);
		});

		it('does nothing when all items are purchased', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(makeGroceryListYaml([{ name: 'Milk', purchased: true }]));
			});

			scheduleShoppingFollowup(services, 'u1', 0);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();
		});

		it('does nothing when no household exists', async () => {
			sharedStore.read.mockResolvedValue('');

			scheduleShoppingFollowup(services, 'u1', 1);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			expect(vi.mocked(services.telegram.sendWithButtons)).not.toHaveBeenCalled();
		});

		it('shows max 10 items and adds "...and X more"', async () => {
			const items = Array.from({ length: 12 }, (_, i) => ({
				name: `Item${i + 1}`,
				purchased: false,
			}));

			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(makeGroceryListYaml(items));
			});

			scheduleShoppingFollowup(services, 'u1', 12);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
			expect(message).toContain('...and 2 more');
		});

		it('does not show "...and X more" when 10 or fewer items', async () => {
			const items = Array.from({ length: 5 }, (_, i) => ({
				name: `Item${i + 1}`,
				purchased: false,
			}));

			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(makeGroceryListYaml(items));
			});

			scheduleShoppingFollowup(services, 'u1', 5);
			await vi.advanceTimersByTimeAsync(FOLLOWUP_DELAY_MS);

			const [, message] = vi.mocked(services.telegram.sendWithButtons).mock.calls[0];
			expect(message).not.toContain('more');
		});
	});

	// ─── handleShopFollowupClearCallback ─────────────────────────────

	describe('handleShopFollowupClearCallback', () => {
		it('archives remaining items and saves empty list', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(
					makeGroceryListYaml([
						{ name: 'Bread', purchased: false },
						{ name: 'Cheese', purchased: true },
					]),
				);
			});

			await handleShopFollowupClearCallback(services, 'u1', 100, 200);

			// Should write history archive + save empty list
			expect(vi.mocked(sharedStore.write)).toHaveBeenCalledWith(
				expect.stringContaining('grocery/history'),
				expect.any(String),
			);
			expect(vi.mocked(sharedStore.write)).toHaveBeenCalledWith(
				'grocery/active.yaml',
				expect.any(String),
			);
		});

		it('edits the message with cleared count', async () => {
			sharedStore.read.mockImplementation((path: string) => {
				if (path === 'household.yaml') return Promise.resolve(makeHouseholdYaml());
				return Promise.resolve(
					makeGroceryListYaml([
						{ name: 'Bread', purchased: false },
						{ name: 'Eggs', purchased: false },
					]),
				);
			});

			await handleShopFollowupClearCallback(services, 'u1', 100, 200);

			expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('2'),
			);
			const [, , msg] = vi.mocked(services.telegram.editMessage).mock.calls[0];
			expect(msg).toContain('Grocery list is now empty');
		});

		it('edits message even when grocery list is missing', async () => {
			sharedStore.read.mockResolvedValue('');

			await handleShopFollowupClearCallback(services, 'u1', 100, 200);

			expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
				100,
				200,
				expect.any(String),
			);
		});
	});

	// ─── handleShopFollowupKeepCallback ──────────────────────────────

	describe('handleShopFollowupKeepCallback', () => {
		it('edits the message to confirm items are kept', async () => {
			await handleShopFollowupKeepCallback(services, 'u1', 100, 200);

			expect(vi.mocked(services.telegram.editMessage)).toHaveBeenCalledWith(
				100,
				200,
				expect.stringContaining('Keep'),
			);
		});

		it('does not touch the grocery list', async () => {
			await handleShopFollowupKeepCallback(services, 'u1', 100, 200);

			expect(vi.mocked(sharedStore.write)).not.toHaveBeenCalled();
			expect(vi.mocked(sharedStore.read)).not.toHaveBeenCalled();
		});
	});
});
