/**
 * Guided /nutrition targets set flow — H11.y Task 1.
 *
 * Walks the user through 5 steps (calories → protein → carbs → fat → fiber)
 * with quick-pick buttons. A [Custom] button lets them type a number instead.
 * Maintains an in-process state map keyed by userId with a 10-minute TTL.
 *
 * Entry: beginTargetsFlow() — invoked by nutrition.ts when `/nutrition targets set`
 *   is called with no numeric args.
 * Text replies: handleTargetsFlowReply() — invoked from index.ts handleMessage
 *   when hasPendingTargetsFlow(userId) returns true.
 * Callbacks: handleTargetsFlowCallback() — invoked from index.ts
 *   handleCallbackQuery when data starts with `app:food:nut:tgt:`.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { saveTargets } from './nutrition.js';
import { parseStrictInt } from '../utils/parse-int-strict.js';

type TargetsStep =
	| 'awaiting_calories'
	| 'awaiting_protein'
	| 'awaiting_carbs'
	| 'awaiting_fat'
	| 'awaiting_fiber'
	| 'awaiting_confirm';

interface PendingTargetsFlow {
	step: TargetsStep;
	calories?: number;
	protein?: number;
	carbs?: number;
	fat?: number;
	fiber?: number;
	awaitingCustomInput?: boolean;
	expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min
const pending = new Map<string, PendingTargetsFlow>();

function touch(userId: string, state: PendingTargetsFlow): void {
	state.expiresAt = Date.now() + PENDING_TTL_MS;
	pending.set(userId, state);
	// Time-based sweep — never evict another user's still-valid flow.
	if (pending.size > 100) {
		const now = Date.now();
		for (const [k, v] of pending) {
			if (v.expiresAt < now) pending.delete(k);
		}
	}
}

function cleanupExpired(userId: string): PendingTargetsFlow | undefined {
	const entry = pending.get(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		pending.delete(userId);
		return undefined;
	}
	return entry;
}

export function hasPendingTargetsFlow(userId: string): boolean {
	return cleanupExpired(userId) !== undefined;
}

async function sendCaloriesStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		'**Set macro targets**\n\nStep 1/5 — Daily calorie target:',
		[
			[
				{ text: '1500', callbackData: 'app:food:nut:tgt:cal:1500' },
				{ text: '1800', callbackData: 'app:food:nut:tgt:cal:1800' },
				{ text: '2000', callbackData: 'app:food:nut:tgt:cal:2000' },
				{ text: '2200', callbackData: 'app:food:nut:tgt:cal:2200' },
				{ text: '2500', callbackData: 'app:food:nut:tgt:cal:2500' },
				{ text: 'Custom', callbackData: 'app:food:nut:tgt:custom' },
			],
			[{ text: 'Cancel', callbackData: 'app:food:nut:tgt:cancel' }],
		],
	);
}

async function sendProteinStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		'Step 2/5 — Daily protein target (g):',
		[
			[
				{ text: '80', callbackData: 'app:food:nut:tgt:pro:80' },
				{ text: '120', callbackData: 'app:food:nut:tgt:pro:120' },
				{ text: '150', callbackData: 'app:food:nut:tgt:pro:150' },
				{ text: '180', callbackData: 'app:food:nut:tgt:pro:180' },
				{ text: '220', callbackData: 'app:food:nut:tgt:pro:220' },
				{ text: 'Custom', callbackData: 'app:food:nut:tgt:custom' },
			],
			[{ text: 'Cancel', callbackData: 'app:food:nut:tgt:cancel' }],
		],
	);
}

async function sendCarbsStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		'Step 3/5 — Daily carbs target (g):',
		[
			[
				{ text: '150', callbackData: 'app:food:nut:tgt:carb:150' },
				{ text: '200', callbackData: 'app:food:nut:tgt:carb:200' },
				{ text: '250', callbackData: 'app:food:nut:tgt:carb:250' },
				{ text: '300', callbackData: 'app:food:nut:tgt:carb:300' },
				{ text: '350', callbackData: 'app:food:nut:tgt:carb:350' },
				{ text: 'Custom', callbackData: 'app:food:nut:tgt:custom' },
			],
			[{ text: 'Cancel', callbackData: 'app:food:nut:tgt:cancel' }],
		],
	);
}

async function sendFatStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		'Step 4/5 — Daily fat target (g):',
		[
			[
				{ text: '50', callbackData: 'app:food:nut:tgt:fat:50' },
				{ text: '65', callbackData: 'app:food:nut:tgt:fat:65' },
				{ text: '80', callbackData: 'app:food:nut:tgt:fat:80' },
				{ text: '100', callbackData: 'app:food:nut:tgt:fat:100' },
				{ text: 'Custom', callbackData: 'app:food:nut:tgt:custom' },
			],
			[{ text: 'Cancel', callbackData: 'app:food:nut:tgt:cancel' }],
		],
	);
}

async function sendFiberStep(services: CoreServices, userId: string): Promise<void> {
	await services.telegram.sendWithButtons(
		userId,
		'Step 5/5 — Daily fiber target (g):',
		[
			[
				{ text: '20', callbackData: 'app:food:nut:tgt:fib:20' },
				{ text: '25', callbackData: 'app:food:nut:tgt:fib:25' },
				{ text: '30', callbackData: 'app:food:nut:tgt:fib:30' },
				{ text: '40', callbackData: 'app:food:nut:tgt:fib:40' },
				{ text: 'Custom', callbackData: 'app:food:nut:tgt:custom' },
				{ text: 'Skip', callbackData: 'app:food:nut:tgt:fib:skip' },
			],
			[{ text: 'Cancel', callbackData: 'app:food:nut:tgt:cancel' }],
		],
	);
}

async function sendConfirmStep(
	services: CoreServices,
	userId: string,
	state: PendingTargetsFlow,
): Promise<void> {
	const lines = [
		'**Macro targets to save:**',
		`• Calories: ${state.calories}`,
		`• Protein: ${state.protein}g`,
		`• Carbs: ${state.carbs}g`,
		`• Fat: ${state.fat}g`,
		`• Fiber: ${state.fiber ?? 0}g`,
	];
	await services.telegram.sendWithButtons(userId, lines.join('\n'), [
		[
			{ text: 'Save', callbackData: 'app:food:nut:tgt:confirm:save' },
			{ text: 'Cancel', callbackData: 'app:food:nut:tgt:confirm:cancel' },
		],
	]);
}

function fieldNameForStep(step: TargetsStep): string {
	switch (step) {
		case 'awaiting_calories': return 'calories';
		case 'awaiting_protein': return 'protein (g)';
		case 'awaiting_carbs': return 'carbs (g)';
		case 'awaiting_fat': return 'fat (g)';
		case 'awaiting_fiber': return 'fiber (g)';
		default: return 'value';
	}
}

/** Entry point from `nutrition.ts` when user types `/nutrition targets set` with no args. */
export async function beginTargetsFlow(
	services: CoreServices,
	userId: string,
): Promise<void> {
	touch(userId, { step: 'awaiting_calories', expiresAt: 0 });
	await sendCaloriesStep(services, userId);
}

/**
 * Text-reply handler. Called from index.ts `handleMessage` when
 * `hasPendingTargetsFlow(userId)` is true. Returns true if it consumed the
 * message, false if the state was invalid and caller should fall through.
 */
export async function handleTargetsFlowReply(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	text: string,
): Promise<boolean> {
	const state = cleanupExpired(userId);
	if (!state) return false;

	// Only process text input when we're in custom-input mode.
	if (!state.awaitingCustomInput) return false;

	const raw = text.trim();
	if (raw.toLowerCase() === 'cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled.');
		return true;
	}

	const val = parseStrictInt(raw);
	if (val === null || val < 0 || val > 99999) {
		await services.telegram.send(
			userId,
			`Invalid value: '${raw}'. Must be a whole number between 0 and 99999. Try again, or reply "cancel" to abort.`,
		);
		return true;
	}

	// Store value and advance step.
	state.awaitingCustomInput = false;
	return await applyValueAndAdvance(services, userStore, userId, state, val);
}

/**
 * Callback-query handler. Called from index.ts `handleCallbackQuery` when
 * data starts with `app:food:nut:tgt:`. Returns true if it consumed the callback.
 */
export async function handleTargetsFlowCallback(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	data: string,
): Promise<boolean> {
	// Cancel at any step.
	if (data === 'app:food:nut:tgt:cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled.');
		return true;
	}

	const state = cleanupExpired(userId);
	if (!state) {
		await services.telegram.send(
			userId,
			"Your targets flow has expired. Use `/nutrition targets set` to start again.",
		);
		return true;
	}

	// Confirm step.
	if (data === 'app:food:nut:tgt:confirm:save' && state.step === 'awaiting_confirm') {
		await saveTargets(services, userStore, userId, {
			calories: state.calories ?? 0,
			protein: state.protein ?? 0,
			carbs: state.carbs ?? 0,
			fat: state.fat ?? 0,
			fiber: state.fiber ?? 0,
		});
		pending.delete(userId);
		await services.telegram.send(userId, 'Macro targets saved!');
		return true;
	}

	if (data === 'app:food:nut:tgt:confirm:cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled.');
		return true;
	}

	// Custom input — switch to text-reply mode.
	if (data === 'app:food:nut:tgt:custom') {
		state.awaitingCustomInput = true;
		touch(userId, state);
		const fieldName = fieldNameForStep(state.step);
		await services.telegram.send(
			userId,
			`Reply with your ${fieldName} target (or 'cancel'):`,
		);
		return true;
	}

	// Fiber skip — set fiber to 0 and advance to confirm.
	if (data === 'app:food:nut:tgt:fib:skip' && state.step === 'awaiting_fiber') {
		return await applyValueAndAdvance(services, userStore, userId, state, 0);
	}

	// Quick-pick values for each step.
	const calMatch = data.match(/^app:food:nut:tgt:cal:(\d+)$/);
	if (calMatch && state.step === 'awaiting_calories') {
		return await applyValueAndAdvance(services, userStore, userId, state, parseStrictInt(calMatch[1]!) ?? 0);
	}

	const proMatch = data.match(/^app:food:nut:tgt:pro:(\d+)$/);
	if (proMatch && state.step === 'awaiting_protein') {
		return await applyValueAndAdvance(services, userStore, userId, state, parseStrictInt(proMatch[1]!) ?? 0);
	}

	const carbMatch = data.match(/^app:food:nut:tgt:carb:(\d+)$/);
	if (carbMatch && state.step === 'awaiting_carbs') {
		return await applyValueAndAdvance(services, userStore, userId, state, parseStrictInt(carbMatch[1]!) ?? 0);
	}

	const fatMatch = data.match(/^app:food:nut:tgt:fat:(\d+)$/);
	if (fatMatch && state.step === 'awaiting_fat') {
		return await applyValueAndAdvance(services, userStore, userId, state, parseStrictInt(fatMatch[1]!) ?? 0);
	}

	const fibMatch = data.match(/^app:food:nut:tgt:fib:(\d+)$/);
	if (fibMatch && state.step === 'awaiting_fiber') {
		return await applyValueAndAdvance(services, userStore, userId, state, parseStrictInt(fibMatch[1]!) ?? 0);
	}

	return false;
}

/**
 * Stores the value for the current step and advances to the next step,
 * sending the appropriate prompt.
 */
async function applyValueAndAdvance(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	state: PendingTargetsFlow,
	value: number,
): Promise<boolean> {
	switch (state.step) {
		case 'awaiting_calories':
			state.calories = value;
			state.step = 'awaiting_protein';
			touch(userId, state);
			await sendProteinStep(services, userId);
			return true;

		case 'awaiting_protein':
			state.protein = value;
			state.step = 'awaiting_carbs';
			touch(userId, state);
			await sendCarbsStep(services, userId);
			return true;

		case 'awaiting_carbs':
			state.carbs = value;
			state.step = 'awaiting_fat';
			touch(userId, state);
			await sendFatStep(services, userId);
			return true;

		case 'awaiting_fat':
			state.fat = value;
			state.step = 'awaiting_fiber';
			touch(userId, state);
			await sendFiberStep(services, userId);
			return true;

		case 'awaiting_fiber':
			state.fiber = value;
			state.step = 'awaiting_confirm';
			touch(userId, state);
			await sendConfirmStep(services, userId, state);
			return true;

		default:
			return false;
	}
}

/** Test-only — clears the in-process state map. */
export function __resetTargetsFlowForTests(): void {
	pending.clear();
}
