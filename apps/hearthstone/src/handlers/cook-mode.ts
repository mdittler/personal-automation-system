/**
 * Cook mode handler — Telegram orchestration for step-by-step cooking.
 *
 * Handles the /cook command, natural-language cook intents, callback
 * button navigation, and text-based navigation during active sessions.
 */

import type { CoreServices, MessageContext } from '@pas/core/types';
import {
	advanceStep,
	buildStepButtons,
	createSession,
	endSession,
	formatCompletionMessage,
	formatStepMessage,
	getSession,
	goBack,
	hasActiveSession,
	touchSession,
} from '../services/cook-session.js';
import {
	formatScaledIngredients,
	generateScalingNotes,
	parseServingsInput,
	scaleIngredients,
} from '../services/recipe-scaler.js';
import { findRecipeByTitle, loadAllRecipes, searchRecipes } from '../services/recipe-store.js';
import { formatDuration, parseStepTimer } from '../services/timer-parser.js';
import type { CookSession, Recipe } from '../types.js';
import { requireHousehold } from '../utils/household-guard.js';

// Node timer globals — not in ES2024 lib, so we declare them here.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;

/** Speak the current step text via TTS if hands-free mode is active. Fire-and-forget. */
function speakCurrentStep(services: CoreServices, session: CookSession): void {
	if (!session.ttsEnabled || !services.audio) return;
	void services.config.get('cooking_speaker_device').then((device) => {
		services.audio.speak(
			session.instructions[session.currentStep] ?? '',
			(device as string) || undefined,
		).catch(() => {});
	}).catch(() => {});
}

// ─── Pending recipe state (TTL map) ─────────────────────────────────

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingCookRecipes = new Map<
	string,
	{ recipeId: string; servings: number; expiresAt: number }
>();

function setPendingRecipe(userId: string, recipeId: string, servings: number): void {
	pendingCookRecipes.set(userId, { recipeId, servings, expiresAt: Date.now() + PENDING_TTL_MS });
	// Cap map size
	if (pendingCookRecipes.size > 100) {
		const oldest = pendingCookRecipes.keys().next().value;
		if (oldest) pendingCookRecipes.delete(oldest);
	}
}

function consumePendingRecipe(userId: string): { recipeId: string; servings: number } | undefined {
	const entry = pendingCookRecipes.get(userId);
	pendingCookRecipes.delete(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) return undefined;
	return { recipeId: entry.recipeId, servings: entry.servings };
}

export function hasPendingCookRecipe(userId: string): boolean {
	const entry = pendingCookRecipes.get(userId);
	if (!entry) return false;
	if (Date.now() > entry.expiresAt) {
		pendingCookRecipes.delete(userId);
		return false;
	}
	return true;
}

export function isCookModeActive(userId: string): boolean {
	return hasActiveSession(userId);
}

// ─── /cook command ──────────────────────────────────────────────────

export async function handleCookCommand(
	services: CoreServices,
	args: string[],
	ctx: MessageContext,
): Promise<void> {
	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) {
		await services.telegram.send(
			ctx.userId,
			'Set up a household first with /household create <name>',
		);
		return;
	}

	// Check if already cooking
	if (hasActiveSession(ctx.userId)) {
		const session = getSession(ctx.userId);
		await services.telegram.send(
			ctx.userId,
			`You're already cooking ${session?.recipeTitle ?? 'a recipe'}! Say "done" to finish, or continue with "next".`,
		);
		return;
	}

	if (args.length === 0) {
		// Show all recipes as buttons for easy selection
		const recipes = await loadAllRecipes(hh.sharedStore);
		if (recipes.length === 0) {
			await services.telegram.send(ctx.userId, 'No recipes saved yet. Save one first!');
			return;
		}
		const buttons = recipes
			.slice(0, 10)
			.map((r) => [{ text: r.title, callbackData: `app:hearthstone:ck:sel:${r.id}` }]);
		await services.telegram.sendWithButtons(
			ctx.userId,
			'Which recipe would you like to cook?',
			buttons,
		);
		return;
	}

	const query = args.join(' ');
	const recipes = await loadAllRecipes(hh.sharedStore);
	const recipe = findRecipeByTitle(recipes, query);

	if (!recipe) {
		// Search for partial matches and show as buttons
		const results = searchRecipes(recipes, { text: query, limit: 5 });
		if (results.length > 0) {
			const buttons = results.map((r) => [
				{
					text: r.recipe.title,
					callbackData: `app:hearthstone:ck:sel:${r.recipe.id}`,
				},
			]);
			await services.telegram.sendWithButtons(
				ctx.userId,
				`I couldn't find an exact match for "${query}". Did you mean one of these?`,
				buttons,
			);
		} else {
			await services.telegram.send(
				ctx.userId,
				`I couldn't find any recipes matching "${query}". Try /recipes to browse.`,
			);
		}
		return;
	}

	promptForServings(services, ctx.userId, recipe);
}

async function promptForServings(
	services: CoreServices,
	userId: string,
	recipe: Recipe,
): Promise<void> {
	setPendingRecipe(userId, recipe.id, recipe.servings);
	await services.telegram.send(
		userId,
		`🍳 ${recipe.title}\n\nHow many servings? (Recipe serves ${recipe.servings})\nReply with a number, "double", "half", or just say "${recipe.servings}" for the original.`,
	);
}

// ─── Servings reply ─────────────────────────────────────────────────

export async function handleServingsReply(
	services: CoreServices,
	text: string,
	ctx: MessageContext,
): Promise<void> {
	const pending = consumePendingRecipe(ctx.userId);
	if (!pending) return;

	const targetServings = parseServingsInput(text, pending.servings);
	if (targetServings == null) {
		// Re-store so user can retry
		setPendingRecipe(ctx.userId, pending.recipeId, pending.servings);
		await services.telegram.send(
			ctx.userId,
			'I didn\'t understand that. Try a number like "4", "double", or "half".',
		);
		return;
	}

	const hh = await requireHousehold(services, ctx.userId);
	if (!hh) return;

	const recipes = await loadAllRecipes(hh.sharedStore);
	const recipe = recipes.find((r) => r.id === pending.recipeId);
	if (!recipe) {
		await services.telegram.send(ctx.userId, 'Recipe not found. Please try again.');
		return;
	}

	// Scale ingredients
	const scaled = scaleIngredients(recipe.ingredients, recipe.servings, targetServings);

	// Generate scaling notes for significant scaling
	const ratio = targetServings / recipe.servings;
	let scalingNotes: string | null = null;
	if (ratio > 1.5 || ratio < 0.67) {
		try {
			scalingNotes = await generateScalingNotes(services, recipe, targetServings);
		} catch {
			services.logger.warn('Failed to generate scaling notes for %s', recipe.id);
		}
	}

	// Create session
	const session = createSession(ctx.userId, recipe, targetServings, scaled, scalingNotes);

	// Send ingredients summary
	const ingredientMsg = formatScaledIngredients(
		scaled,
		targetServings,
		recipe.servings,
		scalingNotes,
	);
	await services.telegram.send(ctx.userId, ingredientMsg);

	// Check if TTS/hands-free should be offered
	const audioAvailable = services.audio != null;
	const handsFreeDefault = audioAvailable ? await services.config.get('hands_free_default') : false;

	if (audioAvailable && handsFreeDefault) {
		session.ttsEnabled = true;
		await sendFirstStep(services, session, ctx.userId);
	} else if (audioAvailable) {
		await services.telegram.sendWithButtons(
			ctx.userId,
			'🔊 Want hands-free mode? I\'ll read each step aloud on your speaker.',
			[[
				{ text: 'Yes, hands-free', callbackData: 'app:hearthstone:ck:hf:y' },
				{ text: 'No thanks', callbackData: 'app:hearthstone:ck:hf:n' },
			]],
		);
	} else {
		await sendFirstStep(services, session, ctx.userId);
	}
}

// ─── sendFirstStep helper ───────────────────────────────────────────

async function sendFirstStep(services: CoreServices, session: CookSession, userId: string): Promise<void> {
	const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
	const stepMsg = formatStepMessage(session);
	const sent = await services.telegram.sendWithButtons(userId, stepMsg, buildStepButtons(session, timer));
	session.lastMessageId = sent.messageId;
	session.lastChatId = sent.chatId;

	speakCurrentStep(services, session);
}

// ─── Timer helpers ──────────────────────────────────────────────────

function cancelSessionTimer(session: CookSession): void {
	if (session.timerHandle !== undefined) {
		clearTimeout(session.timerHandle);
		session.timerHandle = undefined;
		session.timerStepIndex = undefined;
	}
}

// ─── Callback handler ──────────────────────────────────────────────

export async function handleCookCallback(
	services: CoreServices,
	action: string,
	userId: string,
	chatId: number,
	messageId: number,
): Promise<void> {
	// Recipe selection from search results (before session exists)
	if (action.startsWith('sel:')) {
		const recipeId = action.slice(4);
		const hh = await requireHousehold(services, userId);
		if (!hh) return;
		const recipes = await loadAllRecipes(hh.sharedStore);
		const recipe = recipes.find((r) => r.id === recipeId);
		if (!recipe) {
			await services.telegram.editMessage(chatId, messageId, 'Recipe not found.');
			return;
		}
		await services.telegram.editMessage(chatId, messageId, `Selected: ${recipe.title}`);
		await promptForServings(services, userId, recipe);
		return;
	}

	if (action === 'hf:y' || action === 'hf:n') {
		const session = getSession(userId);
		if (!session) {
			await services.telegram.send(userId, 'No active cook session. Start one with /cook.');
			return;
		}
		session.ttsEnabled = action === 'hf:y';
		const choice = action === 'hf:y' ? '🔊 Hands-free mode enabled!' : 'Text-only mode.';
		await services.telegram.editMessage(chatId, messageId, choice, []);
		await sendFirstStep(services, session, userId);
		return;
	}

	const session = getSession(userId);
	if (!session) {
		await services.telegram.send(userId, 'No active cook session. Start one with /cook.');
		return;
	}

	touchSession(session);

	switch (action) {
		case 'n': {
			cancelSessionTimer(session);
			const result = advanceStep(session);
			if (result === 'completed') {
				await services.telegram.editMessage(
					chatId,
					messageId,
					`${formatStepMessage(session)}\n\n✅ That was the last step!`,
					[],
				);
				await services.telegram.send(userId, formatCompletionMessage(session));
				endSession(userId);
			} else {
				const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
				await services.telegram.editMessage(
					chatId,
					messageId,
					formatStepMessage(session),
					buildStepButtons(session, timer),
				);
				speakCurrentStep(services, session);
			}
			break;
		}
		case 'b': {
			cancelSessionTimer(session);
			const result = goBack(session);
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			if (result === 'at_start') {
				await services.telegram.editMessage(
					chatId,
					messageId,
					`You're already on the first step.\n\n${formatStepMessage(session)}`,
					buildStepButtons(session, timer),
				);
			} else {
				await services.telegram.editMessage(
					chatId,
					messageId,
					formatStepMessage(session),
					buildStepButtons(session, timer),
				);
			}
			speakCurrentStep(services, session);
			break;
		}
		case 'r': {
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			await services.telegram.editMessage(
				chatId,
				messageId,
				formatStepMessage(session),
				buildStepButtons(session, timer),
			);
			speakCurrentStep(services, session);
			break;
		}
		case 'd': {
			cancelSessionTimer(session);
			const recipeTitle = session.recipeTitle; // save before endSession destroys it
			await services.telegram.editMessage(
				chatId,
				messageId,
				`Finished cooking ${recipeTitle}. All done!`,
				[],
			);
			endSession(userId);
			// H6: Ask about leftovers
			await services.telegram.sendWithButtons(
				userId,
				`Any leftovers from ${recipeTitle}?`,
				[[
					{ text: 'Yes, log leftovers', callbackData: 'app:hearthstone:lo:post-meal:yes' },
					{ text: 'No leftovers', callbackData: 'app:hearthstone:lo:post-meal:no' },
				]],
			);
			break;
		}
		case 't': {
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			if (!timer) break;
			cancelSessionTimer(session);
			const durationMs = timer.durationMinutes * 60 * 1000;
			session.timerStepIndex = session.currentStep;
			session.timerHandle = setTimeout(() => {
				const activeSession = getSession(userId);
				if (!activeSession) return;
				const firedStepIndex = activeSession.timerStepIndex ?? activeSession.currentStep;
				activeSession.timerHandle = undefined;
				activeSession.timerStepIndex = undefined;
				const stepNum = firedStepIndex + 1;
				const stepText = activeSession.instructions[firedStepIndex] ?? '';
				const brief = stepText.length > 80 ? stepText.slice(0, 77) + '...' : stepText;
				const msg = `⏰ Timer done! Step ${stepNum}: ${brief}\n\nReady for the next step?`;
				void services.telegram.sendWithButtons(userId, msg, [
					[{ text: 'Next >', callbackData: 'app:hearthstone:ck:n' }],
				]);
				if (activeSession.ttsEnabled && services.audio) {
					const speakText = `Timer done! Step ${stepNum}: ${brief}`;
					void services.config.get('cooking_speaker_device').then((device) => {
						services.audio.speak(speakText, (device as string) || undefined).catch(() => {});
					}).catch(() => {});
				}
			}, durationMs) as ReturnType<typeof setTimeout>;
			await services.telegram.editMessage(
				chatId,
				messageId,
				`${formatStepMessage(session)}\n\n⏱ Timer set for ${formatDuration(timer.durationMinutes)}`,
				buildStepButtons(session, timer),
			);
			break;
		}
		case 'tc': {
			cancelSessionTimer(session);
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			await services.telegram.editMessage(
				chatId,
				messageId,
				formatStepMessage(session),
				buildStepButtons(session, timer),
			);
			break;
		}
	}
}

// ─── Text action interceptor ───────────────────────────────────────

const COOK_TEXT_ACTIONS: Record<string, 'next' | 'back' | 'repeat' | 'done'> = {
	next: 'next',
	n: 'next',
	back: 'back',
	previous: 'back',
	prev: 'back',
	repeat: 'repeat',
	again: 'repeat',
	done: 'done',
	finished: 'done',
	exit: 'done',
	stop: 'done',
	quit: 'done',
};

export async function handleCookTextAction(
	services: CoreServices,
	text: string,
	ctx: MessageContext,
): Promise<boolean> {
	if (!hasActiveSession(ctx.userId)) return false;

	const action = COOK_TEXT_ACTIONS[text.toLowerCase().trim()];
	if (!action) return false;

	const session = getSession(ctx.userId);
	if (!session) return false;
	touchSession(session);

	switch (action) {
		case 'next': {
			cancelSessionTimer(session);
			const result = advanceStep(session);
			if (result === 'completed') {
				// Edit old button message to remove buttons
				if (session.lastChatId != null && session.lastMessageId != null) {
					await services.telegram.editMessage(
						session.lastChatId,
						session.lastMessageId,
						`${formatStepMessage(session)}\n\n✅ That was the last step!`,
						[],
					);
				}
				await services.telegram.send(ctx.userId, formatCompletionMessage(session));
				endSession(ctx.userId);
			} else {
				const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
				await services.telegram.sendWithButtons(
					ctx.userId,
					formatStepMessage(session),
					buildStepButtons(session, timer),
				);
				speakCurrentStep(services, session);
			}
			break;
		}
		case 'back': {
			cancelSessionTimer(session);
			const result = goBack(session);
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			const prefix = result === 'at_start' ? "You're already on the first step.\n\n" : '';
			await services.telegram.sendWithButtons(
				ctx.userId,
				`${prefix}${formatStepMessage(session)}`,
				buildStepButtons(session, timer),
			);
			speakCurrentStep(services, session);
			break;
		}
		case 'repeat': {
			const timer = parseStepTimer(session.instructions[session.currentStep] ?? '');
			await services.telegram.sendWithButtons(
				ctx.userId,
				formatStepMessage(session),
				buildStepButtons(session, timer),
			);
			speakCurrentStep(services, session);
			break;
		}
		case 'done': {
			cancelSessionTimer(session);
			const recipeTitle = session.recipeTitle;
			await services.telegram.send(
				ctx.userId,
				`Finished cooking ${recipeTitle}. All done!`,
			);
			endSession(ctx.userId);
			// H6: Ask about leftovers
			await services.telegram.sendWithButtons(
				ctx.userId,
				`Any leftovers from ${recipeTitle}?`,
				[[
					{ text: 'Yes, log leftovers', callbackData: 'app:hearthstone:lo:post-meal:yes' },
					{ text: 'No leftovers', callbackData: 'app:hearthstone:lo:post-meal:no' },
				]],
			);
			break;
		}
	}

	return true;
}

// ─── Natural language cook intent ───────────────────────────────────

export async function handleCookIntent(
	services: CoreServices,
	text: string,
	ctx: MessageContext,
): Promise<void> {
	// Extract recipe name from NL text
	const match =
		text.match(
			/(?:start|begin|let'?s|i\s+want\s+to|can\s+we|ready\s+to)\s+(?:cook(?:ing)?|mak(?:e|ing)|prepar(?:e|ing))\s+(?:the\s+)?(.+)/i,
		) ?? text.match(/(?:cook|prepare)\s+(?:the\s+|my\s+|our\s+|a\s+)?(.+)/i);

	const recipeName = match?.[1]?.trim();
	if (!recipeName) {
		await services.telegram.send(
			ctx.userId,
			'Which recipe would you like to cook? Try /cook <recipe name>',
		);
		return;
	}

	await handleCookCommand(services, recipeName.split(/\s+/), ctx);
}
