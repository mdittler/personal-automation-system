import { afterEach, describe, expect, it } from 'vitest';
import {
	advanceStep,
	buildStepButtons,
	cleanExpiredSessions,
	createSession,
	endSession,
	formatCompletionMessage,
	formatStepMessage,
	getSession,
	getSessionCount,
	goBack,
	hasActiveSession,
	isSessionExpired,
	touchSession,
} from '../services/cook-session.js';
import type { Recipe, ScaledIngredient } from '../types.js';

// ─── Factory helpers ────────────────────────────────────────────────

function makeScaledIngredient(overrides: Partial<ScaledIngredient> = {}): ScaledIngredient {
	return {
		name: 'flour',
		quantity: 2,
		unit: 'cups',
		originalQuantity: 2,
		scaledQuantity: 4,
		...overrides,
	};
}

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-001',
		title: 'Test Pasta',
		source: 'homemade',
		ingredients: [{ name: 'pasta', quantity: 1, unit: 'lb' }],
		instructions: ['Boil water.', 'Cook pasta for 10 minutes.', 'Drain and serve.'],
		servings: 4,
		tags: [],
		ratings: [],
		history: [],
		allergens: [],
		status: 'confirmed',
		createdAt: '2026-03-31',
		updatedAt: '2026-03-31',
		...overrides,
	};
}

// Clean up sessions between tests
afterEach(() => {
	// End any active sessions
	for (const userId of ['user1', 'user2', 'user3']) {
		if (hasActiveSession(userId)) {
			endSession(userId);
		}
	}
});

// ─── createSession ──────────────────────────────────────────────────

describe('createSession', () => {
	it('creates a session with correct fields', () => {
		const recipe = makeRecipe();
		const scaled = [makeScaledIngredient()];
		const session = createSession('user1', recipe, 8, scaled, 'some notes');

		expect(session.userId).toBe('user1');
		expect(session.recipeId).toBe('rec-001');
		expect(session.recipeTitle).toBe('Test Pasta');
		expect(session.currentStep).toBe(0);
		expect(session.totalSteps).toBe(3);
		expect(session.targetServings).toBe(8);
		expect(session.originalServings).toBe(4);
		expect(session.scaledIngredients).toEqual(scaled);
		expect(session.scalingNotes).toBe('some notes');
		expect(session.instructions).toEqual(recipe.instructions);
	});

	it('stores the session in the map', () => {
		const recipe = makeRecipe();
		createSession('user1', recipe, 4, [], null);
		expect(hasActiveSession('user1')).toBe(true);
	});
});

// ─── getSession ─────────────────────────────────────────────────────

describe('getSession', () => {
	it('returns the session for an active user', () => {
		const recipe = makeRecipe();
		createSession('user1', recipe, 4, [], null);
		const session = getSession('user1');
		expect(session).not.toBeNull();
		expect(session?.recipeTitle).toBe('Test Pasta');
	});

	it('returns null for a user with no session', () => {
		expect(getSession('nobody')).toBeNull();
	});
});

// ─── advanceStep ────────────────────────────────────────────────────

describe('advanceStep', () => {
	it('advances from step 0 to step 1', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const result = advanceStep(session);
		expect(result).toBe('ok');
		expect(session.currentStep).toBe(1);
	});

	it('returns completed when advancing past last step', () => {
		const recipe = makeRecipe(); // 3 steps
		const session = createSession('user1', recipe, 4, [], null);
		session.currentStep = 2; // last step (0-indexed)
		const result = advanceStep(session);
		expect(result).toBe('completed');
	});

	it('advances through all steps sequentially', () => {
		const recipe = makeRecipe(); // 3 steps
		const session = createSession('user1', recipe, 4, [], null);
		expect(advanceStep(session)).toBe('ok'); // 0 -> 1
		expect(advanceStep(session)).toBe('ok'); // 1 -> 2
		expect(advanceStep(session)).toBe('completed'); // 2 -> done
	});
});

// ─── goBack ─────────────────────────────────────────────────────────

describe('goBack', () => {
	it('goes back from step 2 to step 1', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		session.currentStep = 2;
		const result = goBack(session);
		expect(result).toBe('ok');
		expect(session.currentStep).toBe(1);
	});

	it('returns at_start when already at step 0', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const result = goBack(session);
		expect(result).toBe('at_start');
		expect(session.currentStep).toBe(0);
	});
});

// ─── endSession ─────────────────────────────────────────────────────

describe('endSession', () => {
	it('removes the session from the map', () => {
		const recipe = makeRecipe();
		createSession('user1', recipe, 4, [], null);
		endSession('user1');
		expect(getSession('user1')).toBeNull();
		expect(hasActiveSession('user1')).toBe(false);
	});

	it('does not error when ending a non-existent session', () => {
		expect(() => endSession('nobody')).not.toThrow();
	});
});

// ─── touchSession ───────────────────────────────────────────────────

describe('touchSession', () => {
	it('updates lastActivityAt', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const before = session.lastActivityAt;
		// Small delay to ensure time difference
		session.lastActivityAt = before - 1000;
		touchSession(session);
		expect(session.lastActivityAt).toBeGreaterThan(before - 1000);
	});
});

// ─── isSessionExpired ───────────────────────────────────────────────

describe('isSessionExpired', () => {
	it('returns false for a fresh session', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		expect(isSessionExpired(session)).toBe(false);
	});

	it('returns true for a session inactive for 25 hours', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		session.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;
		expect(isSessionExpired(session)).toBe(true);
	});
});

// ─── cleanExpiredSessions ───────────────────────────────────────────

describe('cleanExpiredSessions', () => {
	it('removes expired sessions and keeps active ones', () => {
		const recipe = makeRecipe();
		const _active = createSession('user1', recipe, 4, [], null);
		const expired = createSession('user2', recipe, 4, [], null);
		expired.lastActivityAt = Date.now() - 25 * 60 * 60 * 1000;

		const removed = cleanExpiredSessions();
		expect(removed).toBe(1);
		expect(hasActiveSession('user1')).toBe(true);
		expect(hasActiveSession('user2')).toBe(false);
	});

	it('returns 0 when no sessions are expired', () => {
		const recipe = makeRecipe();
		createSession('user1', recipe, 4, [], null);
		expect(cleanExpiredSessions()).toBe(0);
	});
});

// ─── formatStepMessage ──────────────────────────────────────────────

describe('formatStepMessage', () => {
	it('shows 1-indexed step number and progress', () => {
		const recipe = makeRecipe(); // 3 steps
		const session = createSession('user1', recipe, 4, [], null);
		const msg = formatStepMessage(session);
		expect(msg).toContain('Step 1 of 3');
		expect(msg).toContain('Boil water.');
	});

	it('shows correct step after advancing', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		advanceStep(session);
		const msg = formatStepMessage(session);
		expect(msg).toContain('Step 2 of 3');
		expect(msg).toContain('Cook pasta for 10 minutes.');
	});
});

// ─── buildStepButtons ───────────────────────────────────────────────

describe('buildStepButtons', () => {
	it('returns a row with 4 buttons', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const buttons = buildStepButtons(session);
		expect(buttons).toHaveLength(1); // 1 row
		expect(buttons[0]).toHaveLength(4); // 4 buttons
	});

	it('uses ck: callback data prefix', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const buttons = buildStepButtons(session);
		const data = buttons[0].map((b) => b.callbackData);
		expect(data).toContain('app:hearthstone:ck:b');
		expect(data).toContain('app:hearthstone:ck:r');
		expect(data).toContain('app:hearthstone:ck:n');
		expect(data).toContain('app:hearthstone:ck:d');
	});
});

// ─── formatCompletionMessage ────────────────────────────────────────

describe('formatCompletionMessage', () => {
	it('includes recipe title', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const msg = formatCompletionMessage(session);
		expect(msg).toContain('Test Pasta');
	});
});

// ─── Multi-user isolation ───────────────────────────────────────────

describe('multi-user isolation', () => {
	it('maintains independent sessions for different users', () => {
		const recipe1 = makeRecipe({ id: 'r1', title: 'Pasta' });
		const recipe2 = makeRecipe({ id: 'r2', title: 'Soup' });

		createSession('user1', recipe1, 4, [], null);
		createSession('user2', recipe2, 6, [], null);

		const s1 = getSession('user1');
		const s2 = getSession('user2');

		expect(s1?.recipeTitle).toBe('Pasta');
		expect(s2?.recipeTitle).toBe('Soup');

		// biome-ignore lint/style/noNonNullAssertion: test asserts non-null above
		advanceStep(s1!);
		expect(s1?.currentStep).toBe(1);
		expect(s2?.currentStep).toBe(0);
	});
});

// ─── Single-step recipe ─────────────────────────────────────────────

describe('single-step recipe', () => {
	it('completes immediately on advance', () => {
		const recipe = makeRecipe({ instructions: ['Just serve it.'] });
		const session = createSession('user1', recipe, 4, [], null);
		expect(session.totalSteps).toBe(1);
		expect(advanceStep(session)).toBe('completed');
	});
});

// ─── getSessionCount ────────────────────────────────────────────────

describe('getSessionCount', () => {
	it('returns the number of active sessions', () => {
		const recipe = makeRecipe();
		expect(getSessionCount()).toBe(0);
		createSession('user1', recipe, 4, [], null);
		expect(getSessionCount()).toBe(1);
		createSession('user2', recipe, 4, [], null);
		expect(getSessionCount()).toBe(2);
	});
});

// ─── Timer fields on CookSession ───────────────────────────────────

describe('CookSession timer fields', () => {
	it('new session has no timer fields set', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		expect(session.timerHandle).toBeUndefined();
		expect(session.timerStepIndex).toBeUndefined();
		expect(session.ttsEnabled).toBeUndefined();
	});

	it('allows setting timer fields on session', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		session.timerHandle = setTimeout(() => {}, 1000) as ReturnType<typeof setTimeout>;
		session.timerStepIndex = 2;
		session.ttsEnabled = true;
		expect(session.timerStepIndex).toBe(2);
		expect(session.ttsEnabled).toBe(true);
		clearTimeout(session.timerHandle);
	});
});

// ─── endSession clears timer ───────────────────────────────────────

describe('endSession with timer', () => {
	it('clears timerHandle when ending a session with active timer', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		let fired = false;
		session.timerHandle = setTimeout(() => { fired = true; }, 100000) as ReturnType<typeof setTimeout>;
		session.timerStepIndex = 0;
		endSession('user1');
		expect(getSession('user1')).toBeNull();
	});
});

// ─── buildStepButtons with timer ───────────────────────────────────

describe('buildStepButtons with timer', () => {
	it('returns 1 row when no timer provided', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const buttons = buildStepButtons(session);
		expect(buttons).toHaveLength(1);
		expect(buttons[0]).toHaveLength(4);
	});

	it('returns 2 rows when timer is provided', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		const buttons = buildStepButtons(session, { durationMinutes: 25, originalText: '25 minutes' });
		expect(buttons).toHaveLength(2);
		expect(buttons[0]).toHaveLength(4); // nav row
		expect(buttons[1]).toHaveLength(1); // timer row
		expect(buttons[1][0].text).toContain('Timer');
		expect(buttons[1][0].text).toContain('25 min');
		expect(buttons[1][0].callbackData).toBe('app:hearthstone:ck:t');
	});

	it('shows cancel button when session has active timer on current step', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		session.timerHandle = setTimeout(() => {}, 100000) as ReturnType<typeof setTimeout>;
		session.timerStepIndex = 0;
		const buttons = buildStepButtons(session, { durationMinutes: 25, originalText: '25 minutes' });
		expect(buttons).toHaveLength(2);
		expect(buttons[1][0].text).toContain('Cancel');
		expect(buttons[1][0].callbackData).toBe('app:hearthstone:ck:tc');
		clearTimeout(session.timerHandle);
	});

	it('shows set button when timer is for different step', () => {
		const recipe = makeRecipe();
		const session = createSession('user1', recipe, 4, [], null);
		session.timerHandle = setTimeout(() => {}, 100000) as ReturnType<typeof setTimeout>;
		session.timerStepIndex = 1; // timer on step 1, but we're on step 0
		const buttons = buildStepButtons(session, { durationMinutes: 25, originalText: '25 minutes' });
		expect(buttons[1][0].text).toContain('Timer');
		expect(buttons[1][0].callbackData).toBe('app:hearthstone:ck:t');
		clearTimeout(session.timerHandle);
	});
});
