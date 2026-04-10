/**
 * Tests for the guided guest-add flow (H11.y Task 2).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	hasPendingGuestAdd,
	beginGuestAddFlow,
	handleGuestAddReply,
	handleGuestAddCallback,
	__resetGuestAddFlowForTests,
} from '../../handlers/guest-add-flow.js';

// Mock addGuest so we can assert it was called without touching the filesystem.
vi.mock('../../services/guest-profiles.js', () => ({
	addGuest: vi.fn().mockResolvedValue(undefined),
	slugifyGuestName: vi.fn((name: string) =>
		name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9\s-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, ''),
	),
}));

import { addGuest } from '../../services/guest-profiles.js';

function createMockServices() {
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue({ chatId: 12345, messageId: 1 }),
			editMessage: vi.fn().mockResolvedValue(undefined),
		},
		llm: {
			complete: vi.fn().mockResolvedValue(''),
		},
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		config: {
			get: vi.fn().mockResolvedValue(undefined),
			getAll: vi.fn().mockResolvedValue({}),
			setAll: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
		},
		timezone: 'America/New_York',
	};
}

function createMockSharedStore() {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		append: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
	};
}

const USER_ID = 'user1';
const CHAT_ID = 12345;
const MSG_ID = 1;

beforeEach(() => {
	__resetGuestAddFlowForTests();
	vi.clearAllMocks();
});

describe('guest-add-flow', () => {
	// ─── hasPendingGuestAdd ───────────────────────────────────────────────────

	describe('hasPendingGuestAdd', () => {
		it('returns false when no flow started', () => {
			expect(hasPendingGuestAdd(USER_ID)).toBe(false);
		});

		it('returns true after beginGuestAddFlow', async () => {
			const services = createMockServices();
			await beginGuestAddFlow(services as never, USER_ID);
			expect(hasPendingGuestAdd(USER_ID)).toBe(true);
		});
	});

	// ─── TTL expiration ───────────────────────────────────────────────────────

	describe('TTL expiration', () => {
		it('hasPendingGuestAdd returns false after state expires', async () => {
			const services = createMockServices();
			vi.useFakeTimers();
			await beginGuestAddFlow(services as never, USER_ID);
			vi.advanceTimersByTime(11 * 60 * 1000); // 11 min
			expect(hasPendingGuestAdd(USER_ID)).toBe(false);
			vi.useRealTimers();
		});
	});

	// ─── Happy path ───────────────────────────────────────────────────────────

	describe('happy path — name → vegetarian → peanuts → notes → save', () => {
		it('walks the full flow and calls addGuest with correct profile', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			// 1. Begin
			await beginGuestAddFlow(services as never, USER_ID);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const startMsg = services.telegram.send.mock.calls[0]![1] as string;
			expect(startMsg).toContain("What's their name?");

			vi.clearAllMocks();

			// 2. Reply with name "Sarah"
			let consumed = await handleGuestAddReply(
				services as never,
				sharedStore as never,
				USER_ID,
				'Sarah',
			);
			expect(consumed).toBe(true);
			// Diet picker sent
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const dietCall = services.telegram.sendWithButtons.mock.calls[0]!;
			const dietMsg = dietCall[1] as string;
			expect(dietMsg).toContain('Dietary restrictions');
			// Buttons contain Vegetarian
			const dietButtons = dietCall[2] as Array<Array<{ text: string; callbackData: string }>>;
			const allDietButtons = dietButtons.flat();
			expect(allDietButtons.some((b) => b.callbackData.includes('vegetarian'))).toBe(true);

			vi.clearAllMocks();

			// 3. Tap [Vegetarian] to toggle on
			consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// editMessage called — button text should include ✓ Vegetarian
			expect(services.telegram.editMessage).toHaveBeenCalledOnce();
			const editArgs = services.telegram.editMessage.mock.calls[0]!;
			const editButtons = editArgs[3] as Array<Array<{ text: string; callbackData: string }>>;
			const allEditButtons = editButtons.flat();
			const vegBtn = allEditButtons.find((b) => b.callbackData.includes('vegetarian'));
			expect(vegBtn?.text).toContain('✓');

			vi.clearAllMocks();

			// 4. Tap [Done] to advance to allergy step
			consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:done',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// Allergy picker sent
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const allergyMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(allergyMsg).toContain('Allergies');

			vi.clearAllMocks();

			// 5. Tap [Peanuts] to toggle on
			consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:allergy:peanuts',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// editMessage called — button text should include ✓ Peanuts
			expect(services.telegram.editMessage).toHaveBeenCalledOnce();
			const allergyEditArgs = services.telegram.editMessage.mock.calls[0]!;
			const allergyEditButtons = allergyEditArgs[3] as Array<Array<{ text: string; callbackData: string }>>;
			const peanutBtn = allergyEditButtons.flat().find((b) => b.callbackData.includes(':peanuts'));
			expect(peanutBtn?.text).toContain('✓');

			vi.clearAllMocks();

			// 6. Tap [Done] to advance to notes step
			consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:allergy:done',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// Notes step sent
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const notesMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(notesMsg).toContain('notes');

			vi.clearAllMocks();

			// 7. Reply with notes "brings wine"
			consumed = await handleGuestAddReply(
				services as never,
				sharedStore as never,
				USER_ID,
				'brings wine',
			);
			expect(consumed).toBe(true);
			// Confirm step sent
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const confirmMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(confirmMsg).toContain('Sarah');
			expect(confirmMsg).toContain('vegetarian');
			expect(confirmMsg).toContain('peanuts');
			expect(confirmMsg).toContain('brings wine');

			vi.clearAllMocks();

			// 8. Tap [Save]
			consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:save',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			expect(addGuest).toHaveBeenCalledOnce();
			const [, calledGuest] = (addGuest as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(calledGuest.name).toBe('Sarah');
			expect(calledGuest.slug).toBe('sarah');
			expect(calledGuest.dietaryRestrictions).toEqual(['vegetarian']);
			expect(calledGuest.allergies).toEqual(['peanuts']);
			expect(calledGuest.notes).toBe('brings wine');
			expect(calledGuest.createdAt).toBeDefined();
			// Flow should be cleared
			expect(hasPendingGuestAdd(USER_ID)).toBe(false);
		});
	});

	// ─── Toggle deselect ──────────────────────────────────────────────────────

	describe('toggle deselect', () => {
		it('tapping a selected diet option again removes it', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Alex');

			vi.clearAllMocks();

			// Select vegetarian
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);

			vi.clearAllMocks();

			// Deselect vegetarian by tapping again
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);

			// editMessage called again — ✓ should NOT be on vegetarian button
			expect(services.telegram.editMessage).toHaveBeenCalledOnce();
			const editArgs = services.telegram.editMessage.mock.calls[0]!;
			const editButtons = editArgs[3] as Array<Array<{ text: string; callbackData: string }>>;
			const vegBtn = editButtons.flat().find((b) => b.callbackData.includes('vegetarian'));
			expect(vegBtn?.text).not.toContain('✓');
		});
	});

	// ─── [None] for diet ──────────────────────────────────────────────────────

	describe('[None] for diet', () => {
		it('tapping None on diet step advances directly to allergy without Done', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Jordan');
			vi.clearAllMocks();

			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:none',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// Allergy picker should be shown, not diet picker
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const msg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(msg).toContain('Allergies');
			// No editMessage call (None doesn't update in-place)
			expect(services.telegram.editMessage).not.toHaveBeenCalled();
		});
	});

	// ─── [Type my own] for diet ──────────────────────────────────────────────

	describe('[Type my own] for diet', () => {
		it('custom diet input adds items and advances to allergy picker', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Sarah');
			vi.clearAllMocks();

			// Tap [Type my own] for diet
			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:custom',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// Flow still pending
			expect(hasPendingGuestAdd(USER_ID)).toBe(true);
			// Prompt message sent asking for custom value
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const promptMsg = services.telegram.send.mock.calls[0]![1] as string;
			expect(promptMsg).toMatch(/dietary restriction/i);

			vi.clearAllMocks();

			// Reply with custom diet values
			const replyConsumed = await handleGuestAddReply(
				services as never,
				sharedStore as never,
				USER_ID,
				'kosher, halal',
			);
			expect(replyConsumed).toBe(true);
			// Should advance to allergy step — allergy picker sent via sendWithButtons
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const allergyMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(allergyMsg).toContain('Allergies');
		});
	});

	// ─── [Type my own] for allergy ────────────────────────────────────────────

	describe('[Type my own] for allergy', () => {
		it('custom allergy input adds items and advances to notes', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Sam');
			// Diet: tap None to advance
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:none',
				CHAT_ID,
				MSG_ID,
			);
			vi.clearAllMocks();

			// Tap [Type my own] for allergy
			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:allergy:custom',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const promptMsg = services.telegram.send.mock.calls[0]![1] as string;
			expect(promptMsg).toMatch(/allergy/i);

			vi.clearAllMocks();

			// Reply "sesame, soy"
			const replyConsumed = await handleGuestAddReply(
				services as never,
				sharedStore as never,
				USER_ID,
				'sesame, soy',
			);
			expect(replyConsumed).toBe(true);
			// Should advance to notes step
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const notesMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(notesMsg).toContain('notes');

			vi.clearAllMocks();

			// Complete the flow to verify allergies stored correctly
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:notes:skip',
				CHAT_ID,
				MSG_ID,
			);
			vi.clearAllMocks();
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:save',
				CHAT_ID,
				MSG_ID,
			);

			const [, calledGuest] = (addGuest as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(calledGuest.allergies).toEqual(['sesame', 'soy']);
		});
	});

	// ─── Skip notes ───────────────────────────────────────────────────────────

	describe('skip notes', () => {
		it('tapping [Skip] goes to confirm with no notes', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Pat');
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:diet:none', CHAT_ID, MSG_ID);
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:allergy:none', CHAT_ID, MSG_ID);
			vi.clearAllMocks();

			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:notes:skip',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			// Confirm step should be shown
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const confirmMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(confirmMsg).toContain('Pat');
			// Notes line should not appear
			expect(confirmMsg).not.toContain('Notes:');
		});
	});

	// ─── Cancel ───────────────────────────────────────────────────────────────

	describe('cancel', () => {
		it('cancel callback clears state', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			expect(hasPendingGuestAdd(USER_ID)).toBe(true);
			vi.clearAllMocks();

			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:cancel',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			expect(services.telegram.send.mock.calls[0]![1]).toMatch(/cancelled/i);
			expect(hasPendingGuestAdd(USER_ID)).toBe(false);
		});

		it('confirm cancel clears state', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Alex');
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:diet:none', CHAT_ID, MSG_ID);
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:allergy:none', CHAT_ID, MSG_ID);
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:notes:skip', CHAT_ID, MSG_ID);
			vi.clearAllMocks();

			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:cancel',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			expect(hasPendingGuestAdd(USER_ID)).toBe(false);
		});
	});

	// ─── Save without diet/allergy ────────────────────────────────────────────

	describe('save with all-none selections', () => {
		it('saves guest with empty dietaryRestrictions and allergies arrays', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Casey');
			// Diet: none
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:diet:none', CHAT_ID, MSG_ID);
			// Allergy: none
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:allergy:none', CHAT_ID, MSG_ID);
			// Skip notes
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:notes:skip', CHAT_ID, MSG_ID);
			vi.clearAllMocks();

			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:save',
				CHAT_ID,
				MSG_ID,
			);

			expect(addGuest).toHaveBeenCalledOnce();
			const [, calledGuest] = (addGuest as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(calledGuest.dietaryRestrictions).toEqual([]);
			expect(calledGuest.allergies).toEqual([]);
			expect(calledGuest.notes).toBeUndefined();
		});
	});

	// ─── Sanitization ─────────────────────────────────────────────────────────

	describe('sanitization', () => {
		it('notes with HTML/backticks are sanitized via sanitizeInput', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Remy');
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:diet:none', CHAT_ID, MSG_ID);
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:allergy:none', CHAT_ID, MSG_ID);

			// Reply with notes containing triple backticks
			await handleGuestAddReply(
				services as never,
				sharedStore as never,
				USER_ID,
				'loves ```wine``` and cheese',
			);

			// Notes should have triple backticks neutralized (replaced with single `)
			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:save',
				CHAT_ID,
				MSG_ID,
			);

			const [, calledGuest] = (addGuest as ReturnType<typeof vi.fn>).mock.calls[0]!;
			// Triple backticks should be collapsed to single backtick by sanitizeInput
			expect(calledGuest.notes).not.toContain('```');
		});

		it('very long notes are truncated to 500 characters', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			await beginGuestAddFlow(services as never, USER_ID);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, 'Remy');
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:diet:none', CHAT_ID, MSG_ID);
			await handleGuestAddCallback(services as never, sharedStore as never, USER_ID, 'app:food:host:gadd:allergy:none', CHAT_ID, MSG_ID);

			const longNotes = 'a'.repeat(1000);
			await handleGuestAddReply(services as never, sharedStore as never, USER_ID, longNotes);

			await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:confirm:save',
				CHAT_ID,
				MSG_ID,
			);

			const [, calledGuest] = (addGuest as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(calledGuest.notes!.length).toBe(500);
		});
	});

	// ─── Per-user isolation ───────────────────────────────────────────────────

	describe('per-user isolation', () => {
		it('user-a and user-b maintain independent flow state', async () => {
			const servicesA = createMockServices();
			const servicesB = createMockServices();
			const sharedStore = createMockSharedStore();

			const USER_A = 'user-a';
			const USER_B = 'user-b';

			// Start flows for both users
			await beginGuestAddFlow(servicesA as never, USER_A);
			await beginGuestAddFlow(servicesB as never, USER_B);

			expect(hasPendingGuestAdd(USER_A)).toBe(true);
			expect(hasPendingGuestAdd(USER_B)).toBe(true);

			// Advance user-a to diet step by supplying a name
			await handleGuestAddReply(servicesA as never, sharedStore as never, USER_A, 'Alice');

			// user-a is now at diet step; user-b is still at name step
			expect(hasPendingGuestAdd(USER_A)).toBe(true);
			expect(hasPendingGuestAdd(USER_B)).toBe(true);

			// Advancing user-a does not affect user-b — user-b cannot accept a diet callback
			const userBDietResult = await handleGuestAddCallback(
				servicesB as never,
				sharedStore as never,
				USER_B,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);
			// user-b is on awaiting_name step, so diet callback returns false (no match)
			expect(userBDietResult).toBe(false);

			// user-a can still handle diet callbacks independently
			const userADietResult = await handleGuestAddCallback(
				servicesA as never,
				sharedStore as never,
				USER_A,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);
			expect(userADietResult).toBe(true);

			// Both flows still pending and independent
			expect(hasPendingGuestAdd(USER_A)).toBe(true);
			expect(hasPendingGuestAdd(USER_B)).toBe(true);
		});
	});

	// ─── Expired callback ─────────────────────────────────────────────────────

	describe('expired callback', () => {
		it('sends expiry message when callback arrives for expired state', async () => {
			const services = createMockServices();
			const sharedStore = createMockSharedStore();

			vi.useFakeTimers();
			await beginGuestAddFlow(services as never, USER_ID);
			vi.advanceTimersByTime(11 * 60 * 1000);
			vi.clearAllMocks();

			const consumed = await handleGuestAddCallback(
				services as never,
				sharedStore as never,
				USER_ID,
				'app:food:host:gadd:diet:vegetarian',
				CHAT_ID,
				MSG_ID,
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/expired/i);

			vi.useRealTimers();
		});
	});
});
