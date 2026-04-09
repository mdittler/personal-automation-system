/**
 * Guided /nutrition meals add flow — H11.w Task 10b.
 *
 * Walks the user through label → kind → ingredients → notes → LLM macro
 * estimate → save as QuickMealTemplate. Maintains an in-process state map
 * keyed by userId with a 10-minute TTL.
 *
 * Entry: beginQuickMealAdd() — invoked by the /nutrition meals add command.
 * Text replies: handleQuickMealAddReply() — invoked from index.ts handleMessage
 *   when hasPendingQuickMealAdd(userId) returns true.
 * Callbacks: handleQuickMealAddCallback() — invoked from index.ts
 *   handleCallbackQuery when data starts with `app:food:nut:meals:add:`.
 */

import type { CoreServices, ScopedDataStore } from '@pas/core/types';
import { estimateMacros } from '../services/macro-estimator.js';
import { saveQuickMeal, slugifyLabel } from '../services/quick-meals-store.js';
import type { QuickMealTemplate } from '../types.js';

type AddStep =
	| 'awaiting_label'
	| 'awaiting_kind'
	| 'awaiting_ingredients'
	| 'awaiting_notes'
	| 'awaiting_confirm';

interface PendingAdd {
	step: AddStep;
	label?: string;
	kind?: 'home' | 'restaurant' | 'other';
	ingredients?: string[];
	notes?: string;
	estimate?: {
		calories: number;
		protein: number;
		carbs: number;
		fat: number;
		fiber: number;
		confidence: number;
		model: string;
		reasoning?: string;
	};
	expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min — guided flow is longer than leftover add
const pending = new Map<string, PendingAdd>();

function touch(userId: string, state: PendingAdd): void {
	state.expiresAt = Date.now() + PENDING_TTL_MS;
	pending.set(userId, state);
	// Size guard — drop oldest if >100 concurrent flows (mirrors leftover-add)
	if (pending.size > 100) {
		const oldest = pending.keys().next().value;
		if (oldest && oldest !== userId) pending.delete(oldest);
	}
}

function cleanupExpired(userId: string): PendingAdd | undefined {
	const entry = pending.get(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		pending.delete(userId);
		return undefined;
	}
	return entry;
}

export function hasPendingQuickMealAdd(userId: string): boolean {
	return cleanupExpired(userId) !== undefined;
}

/** Entry point from `nutrition.ts` when user types `/nutrition meals add`. */
export async function beginQuickMealAdd(
	services: CoreServices,
	userId: string,
): Promise<void> {
	touch(userId, { step: 'awaiting_label', expiresAt: 0 });
	await services.telegram.send(
		userId,
		'**New quick-meal**\n\nStep 1/4 — what do you want to call this meal?\n' +
			'(e.g. "Chipotle chicken bowl", "Overnight oats")',
	);
}

/**
 * Text-reply handler. Called from index.ts `handleMessage` when
 * `hasPendingQuickMealAdd(userId)` is true. Returns true if it consumed the
 * message, false if the state was invalid and caller should fall through.
 */
export async function handleQuickMealAddReply(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	text: string,
): Promise<boolean> {
	const state = cleanupExpired(userId);
	if (!state) return false;

	if (state.step === 'awaiting_label') {
		const label = text.trim();
		if (label.toLowerCase() === 'cancel') {
			pending.delete(userId);
			await services.telegram.send(userId, 'Cancelled.');
			return true;
		}
		if (!label || label.length > 100) {
			await services.telegram.send(
				userId,
				'Label must be 1-100 characters. Try again, or reply "cancel" to abort.',
			);
			return true;
		}
		state.label = label;
		state.step = 'awaiting_kind';
		touch(userId, state);
		await services.telegram.sendWithButtons(
			userId,
			'Step 2/4 — what kind of meal is this?',
			[
				[
					{ text: 'Home cooking', callbackData: 'app:food:nut:meals:add:kind:home' },
					{ text: 'Restaurant', callbackData: 'app:food:nut:meals:add:kind:restaurant' },
					{ text: 'Other', callbackData: 'app:food:nut:meals:add:kind:other' },
				],
			],
		);
		return true;
	}

	if (state.step === 'awaiting_ingredients') {
		if (text.trim().toLowerCase() === 'cancel') {
			pending.delete(userId);
			await services.telegram.send(userId, 'Cancelled.');
			return true;
		}
		const ingredients = text
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && l.length < 200);
		if (ingredients.length === 0) {
			await services.telegram.send(
				userId,
				'At least one ingredient required. One per line. (Or reply "cancel".)',
			);
			return true;
		}
		state.ingredients = ingredients;
		state.step = 'awaiting_notes';
		touch(userId, state);
		await services.telegram.send(
			userId,
			'Step 4/4 — any notes? (Reply "skip" for none, or "cancel" to abort.)',
		);
		return true;
	}

	if (state.step === 'awaiting_notes') {
		const raw = text.trim();
		if (raw.toLowerCase() === 'cancel') {
			pending.delete(userId);
			await services.telegram.send(userId, 'Cancelled.');
			return true;
		}
		state.notes = raw.toLowerCase() === 'skip' ? undefined : raw;

		// Run the LLM estimate
		await services.telegram.send(userId, 'Estimating macros…');
		const result = await estimateMacros(
			{
				label: state.label!,
				ingredients: state.ingredients!,
				kind: state.kind!,
				notes: state.notes,
			},
			services.llm,
		);

		if (!result.ok) {
			pending.delete(userId);
			await services.telegram.send(
				userId,
				"Couldn't estimate macros: " +
					result.error +
					'. Try `/nutrition meals add` again.',
			);
			return true;
		}

		state.estimate = {
			calories: result.macros.calories ?? 0,
			protein: result.macros.protein ?? 0,
			carbs: result.macros.carbs ?? 0,
			fat: result.macros.fat ?? 0,
			fiber: result.macros.fiber ?? 0,
			confidence: result.confidence,
			model: result.model,
			reasoning: result.reasoning,
		};
		state.step = 'awaiting_confirm';
		touch(userId, state);

		// TODO(H11.w task 16): USDA cross-check branch goes here — if apiKey present
		// and crossCheckIngredients returns non-null, present [Use LLM / Use USDA /
		// Average / Cancel] buttons instead of the simple [Save / Cancel] pair below.

		const e = state.estimate;
		const lines = [
			`**${state.label}**`,
			`Estimated macros (confidence ${Math.round(e.confidence * 100)}%):`,
			`• ${e.calories} cal`,
			`• ${e.protein}g protein, ${e.carbs}g carbs, ${e.fat}g fat, ${e.fiber}g fiber`,
		];
		if (e.reasoning) lines.push(`_${e.reasoning}_`);
		await services.telegram.sendWithButtons(userId, lines.join('\n'), [
			[
				{ text: 'Save', callbackData: 'app:food:nut:meals:add:confirm:save' },
				{ text: 'Cancel', callbackData: 'app:food:nut:meals:add:confirm:cancel' },
			],
		]);
		return true;
	}

	// Any other state = unexpected text while waiting for a button — ignore
	return false;
}

/**
 * Callback-query handler. Called from index.ts `handleCallbackQuery` when
 * data starts with `app:food:nut:meals:add:`. Returns true if it consumed
 * the callback.
 */
export async function handleQuickMealAddCallback(
	services: CoreServices,
	userStore: ScopedDataStore,
	userId: string,
	data: string,
): Promise<boolean> {
	const state = cleanupExpired(userId);
	if (!state) {
		await services.telegram.send(
			userId,
			'Your quick-meal flow has expired. Start over with `/nutrition meals add`.',
		);
		return true;
	}

	// Kind pick: app:food:nut:meals:add:kind:<home|restaurant|other>
	const kindMatch = data.match(/^app:food:nut:meals:add:kind:(home|restaurant|other)$/);
	if (kindMatch && state.step === 'awaiting_kind') {
		state.kind = kindMatch[1] as 'home' | 'restaurant' | 'other';
		state.step = 'awaiting_ingredients';
		touch(userId, state);
		await services.telegram.send(
			userId,
			'Step 3/4 — list the ingredients, one per line.\n' +
				'(e.g.\n  brown rice\n  chicken\n  guac\n  salsa)',
		);
		return true;
	}

	if (
		data === 'app:food:nut:meals:add:confirm:save' &&
		state.step === 'awaiting_confirm' &&
		state.estimate
	) {
		const id = slugifyLabel(state.label!);
		const now = new Date().toISOString();
		const template: QuickMealTemplate = {
			id,
			userId,
			label: state.label!,
			kind: state.kind!,
			ingredients: state.ingredients!,
			notes: state.notes,
			estimatedMacros: {
				calories: state.estimate.calories,
				protein: state.estimate.protein,
				carbs: state.estimate.carbs,
				fat: state.estimate.fat,
				fiber: state.estimate.fiber,
			},
			confidence: state.estimate.confidence,
			llmModel: state.estimate.model,
			usageCount: 0,
			createdAt: now,
			updatedAt: now,
		};
		await saveQuickMeal(userStore, template);
		pending.delete(userId);
		await services.telegram.send(
			userId,
			`Saved quick-meal: **${state.label}** (${state.estimate.calories} cal)`,
		);
		return true;
	}

	if (data === 'app:food:nut:meals:add:confirm:cancel') {
		pending.delete(userId);
		await services.telegram.send(userId, 'Cancelled — not saved.');
		return true;
	}

	return false;
}

/** Test-only — clears the in-process state map. Used by vitest tests. */
export function __resetQuickMealFlowForTests(): void {
	pending.clear();
}
