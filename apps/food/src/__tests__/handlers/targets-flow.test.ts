/**
 * Tests for the guided targets-set flow (H11.y Task 1).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
	hasPendingTargetsFlow,
	beginTargetsFlow,
	handleTargetsFlowReply,
	handleTargetsFlowCallback,
	__resetTargetsFlowForTests,
} from '../../handlers/targets-flow.js';

// Mock saveTargets from nutrition.ts so we can assert it was called.
vi.mock('../../handlers/nutrition.js', () => ({
	saveTargets: vi.fn().mockResolvedValue(undefined),
}));

import { saveTargets } from '../../handlers/nutrition.js';

function createMockServices() {
	const userStore = {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
	};
	return {
		telegram: {
			send: vi.fn().mockResolvedValue(undefined),
			sendWithButtons: vi.fn().mockResolvedValue(undefined),
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
		data: {
			forUser: vi.fn().mockReturnValue(userStore),
		},
		timezone: 'America/New_York',
	};
}

function createMockUserStore() {
	return {
		read: vi.fn().mockResolvedValue(null),
		write: vi.fn().mockResolvedValue(undefined),
		list: vi.fn().mockResolvedValue([]),
		exists: vi.fn().mockResolvedValue(false),
	};
}

const USER_ID = 'user1';

beforeEach(() => {
	__resetTargetsFlowForTests();
	vi.clearAllMocks();
});

describe('targets-flow', () => {
	// ─── hasPendingTargetsFlow ────────────────────────────────────────────────

	describe('hasPendingTargetsFlow', () => {
		it('returns false when no flow started', () => {
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
		});

		it('returns true after beginTargetsFlow', async () => {
			const services = createMockServices();
			await beginTargetsFlow(services as never, USER_ID);
			expect(hasPendingTargetsFlow(USER_ID)).toBe(true);
		});
	});

	// ─── TTL expiration ───────────────────────────────────────────────────────

	describe('TTL expiration', () => {
		it('hasPendingTargetsFlow returns false after state expires', async () => {
			const services = createMockServices();
			await beginTargetsFlow(services as never, USER_ID);
			// Manually expire by manipulating the Map via __reset and re-seeding
			// with an already-expired expiresAt. Since we can't access the private
			// map directly, we test via handleTargetsFlowCallback with a mock.
			// The cleanest way is to use vi.useFakeTimers.
			vi.useFakeTimers();
			vi.advanceTimersByTime(11 * 60 * 1000); // 11 min
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
			vi.useRealTimers();
		});
	});

	// ─── Happy path (full button flow) ───────────────────────────────────────

	describe('happy path — all quick-pick buttons', () => {
		it('walks through all 5 steps and saves on confirm', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			// Step 1: Begin
			await beginTargetsFlow(services as never, USER_ID);
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const firstMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(firstMsg).toContain('Step 1/5');

			vi.clearAllMocks();

			// Step 1: Pick calories 2000
			let consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:cal:2000',
			);
			expect(consumed).toBe(true);
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const step2Msg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(step2Msg).toContain('Step 2/5');

			vi.clearAllMocks();

			// Step 2: Pick protein 150
			consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:pro:150',
			);
			expect(consumed).toBe(true);
			const step3Msg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(step3Msg).toContain('Step 3/5');

			vi.clearAllMocks();

			// Step 3: Pick carbs 250
			consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:carb:250',
			);
			expect(consumed).toBe(true);
			const step4Msg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(step4Msg).toContain('Step 4/5');

			vi.clearAllMocks();

			// Step 4: Pick fat 80
			consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:fat:80',
			);
			expect(consumed).toBe(true);
			const step5Msg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(step5Msg).toContain('Step 5/5');

			vi.clearAllMocks();

			// Step 5: Pick fiber 30
			consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:fib:30',
			);
			expect(consumed).toBe(true);
			// Should show confirm screen
			const confirmCall = services.telegram.sendWithButtons.mock.calls[0]!;
			const confirmMsg = confirmCall[1] as string;
			expect(confirmMsg).toContain('Calories: 2000');
			expect(confirmMsg).toContain('Protein: 150g');
			expect(confirmMsg).toContain('Carbs: 250g');
			expect(confirmMsg).toContain('Fat: 80g');
			expect(confirmMsg).toContain('Fiber: 30g');
			// Check Save/Cancel buttons
			const confirmButtons = confirmCall[2] as Array<Array<{ text: string; callbackData: string }>>;
			expect(confirmButtons[0]![0]!.callbackData).toBe('app:food:nut:tgt:confirm:save');
			expect(confirmButtons[0]![1]!.callbackData).toBe('app:food:nut:tgt:confirm:cancel');

			vi.clearAllMocks();

			// Confirm: Save
			consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:confirm:save',
			);
			expect(consumed).toBe(true);
			expect(saveTargets).toHaveBeenCalledOnce();
			const [, , calledUserId, calledTargets] = (saveTargets as ReturnType<typeof vi.fn>).mock.calls[0]!;
			expect(calledUserId).toBe(USER_ID);
			expect(calledTargets).toEqual({
				calories: 2000,
				protein: 150,
				carbs: 250,
				fat: 80,
				fiber: 30,
			});
			// Flow should be cleared
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
		});
	});

	// ─── Custom input path ────────────────────────────────────────────────────

	describe('custom input path', () => {
		it('Custom on calories switches to text-reply mode and advances on valid reply', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			vi.clearAllMocks();

			// Tap [Custom] on calories step
			await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:custom',
			);
			// Should prompt for typed input
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const promptMsg = services.telegram.send.mock.calls[0]![1] as string;
			expect(promptMsg).toMatch(/calories/i);

			vi.clearAllMocks();

			// Reply with "2150"
			const consumed = await handleTargetsFlowReply(
				services as never,
				userStore as never,
				USER_ID,
				'2150',
			);
			expect(consumed).toBe(true);
			// Should have advanced to protein step
			expect(services.telegram.sendWithButtons).toHaveBeenCalledOnce();
			const proteinMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(proteinMsg).toContain('Step 2/5');
		});
	});

	// ─── Invalid custom input ─────────────────────────────────────────────────

	describe('invalid custom input', () => {
		it('sends error and stays on same step for non-numeric input', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			// Enter custom mode
			await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:custom',
			);
			vi.clearAllMocks();

			// Reply with "abc"
			const consumed = await handleTargetsFlowReply(
				services as never,
				userStore as never,
				USER_ID,
				'abc',
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const errMsg = services.telegram.send.mock.calls[0]![1] as string;
			expect(errMsg).toMatch(/invalid/i);
			// State still pending on calories step
			expect(hasPendingTargetsFlow(USER_ID)).toBe(true);
			// sendWithButtons NOT called (didn't advance)
			expect(services.telegram.sendWithButtons).not.toHaveBeenCalled();
		});

		it('ignores text reply when NOT in awaitingCustomInput mode', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			vi.clearAllMocks();

			// Send text without tapping Custom first
			const consumed = await handleTargetsFlowReply(
				services as never,
				userStore as never,
				USER_ID,
				'2000',
			);
			expect(consumed).toBe(false);
		});
	});

	// ─── Skip fiber ───────────────────────────────────────────────────────────

	describe('skip fiber', () => {
		it('Skip on fiber sets fiber to 0 and advances to confirm', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);

			// Walk through cal → pro → carb → fat
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:cal:2000');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:pro:150');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:carb:250');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:fat:80');
			vi.clearAllMocks();

			// Skip fiber
			const consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:fib:skip',
			);
			expect(consumed).toBe(true);
			// Confirm screen should show Fiber: 0g
			const confirmMsg = services.telegram.sendWithButtons.mock.calls[0]![1] as string;
			expect(confirmMsg).toContain('Fiber: 0g');
		});
	});

	// ─── Cancel ───────────────────────────────────────────────────────────────

	describe('cancel', () => {
		it('cancel callback clears state and sends Cancelled', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			expect(hasPendingTargetsFlow(USER_ID)).toBe(true);
			vi.clearAllMocks();

			const consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:cancel',
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			expect(services.telegram.send.mock.calls[0]![1]).toMatch(/cancelled/i);
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
		});

		it('confirm cancel clears state', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			// Walk to confirm
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:cal:2000');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:pro:150');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:carb:250');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:fat:80');
			await handleTargetsFlowCallback(services as never, userStore as never, USER_ID, 'app:food:nut:tgt:fib:30');
			vi.clearAllMocks();

			const consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:confirm:cancel',
			);
			expect(consumed).toBe(true);
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
		});
	});

	// ─── Cancel text reply while in custom mode ───────────────────────────────

	describe('cancel text reply', () => {
		it('reply "cancel" in custom mode clears state', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:custom',
			);
			vi.clearAllMocks();

			const consumed = await handleTargetsFlowReply(
				services as never,
				userStore as never,
				USER_ID,
				'cancel',
			);
			expect(consumed).toBe(true);
			expect(hasPendingTargetsFlow(USER_ID)).toBe(false);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			expect(services.telegram.send.mock.calls[0]![1]).toMatch(/cancelled/i);
		});
	});

	// ─── Expired callback ─────────────────────────────────────────────────────

	describe('expired callback', () => {
		it('sends expiry message when callback arrives for expired state', async () => {
			const services = createMockServices();
			const userStore = createMockUserStore();

			await beginTargetsFlow(services as never, USER_ID);
			vi.useFakeTimers();
			vi.advanceTimersByTime(11 * 60 * 1000);

			const consumed = await handleTargetsFlowCallback(
				services as never,
				userStore as never,
				USER_ID,
				'app:food:nut:tgt:cal:2000',
			);
			expect(consumed).toBe(true);
			expect(services.telegram.send).toHaveBeenCalledOnce();
			const msg = services.telegram.send.mock.calls[0]![1] as string;
			expect(msg).toMatch(/expired/i);

			vi.useRealTimers();
		});
	});
});
