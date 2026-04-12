/**
 * Cook session manager — in-memory state machine for step-by-step cooking.
 *
 * Sessions are keyed by userId (one active session per user).
 * Not persisted across restarts (acceptable for MVP).
 */

import type { InlineButton } from '@pas/core/types';
import type { CookSession, Recipe, ScaledIngredient } from '../types.js';
import type { ParsedTimer } from './timer-parser.js';
import { formatDuration } from './timer-parser.js';
import { escapeMarkdown } from '../utils/escape-markdown.js';

// Node timer globals — not in ES2024 lib, so we declare them here.
declare function clearTimeout(id: unknown): void;

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const activeSessions = new Map<string, CookSession>();

// ─── Session lifecycle ──────────────────────────────────────────────

export function createSession(
	userId: string,
	recipe: Recipe,
	targetServings: number,
	scaledIngredients: ScaledIngredient[],
	scalingNotes: string | null,
): CookSession {
	const session: CookSession = {
		userId,
		recipeId: recipe.id,
		recipeTitle: recipe.title,
		currentStep: 0,
		totalSteps: recipe.instructions.length,
		targetServings,
		originalServings: recipe.servings,
		scaledIngredients,
		scalingNotes,
		instructions: recipe.instructions,
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		lastMessageId: null,
		lastChatId: null,
	};
	activeSessions.set(userId, session);
	return session;
}

export function getSession(userId: string): CookSession | null {
	return activeSessions.get(userId) ?? null;
}

export function hasActiveSession(userId: string): boolean {
	return activeSessions.has(userId);
}

export function endSession(userId: string): void {
	const session = activeSessions.get(userId);
	if (session?.timerHandle !== undefined) {
		clearTimeout(session.timerHandle);
	}
	activeSessions.delete(userId);
}

export function getSessionCount(): number {
	return activeSessions.size;
}

// ─── Navigation ─────────────────────────────────────────────────────

export function advanceStep(session: CookSession): 'ok' | 'completed' {
	if (session.currentStep >= session.totalSteps - 1) {
		return 'completed';
	}
	session.currentStep++;
	session.lastActivityAt = Date.now();
	return 'ok';
}

export function goBack(session: CookSession): 'ok' | 'at_start' {
	if (session.currentStep <= 0) {
		return 'at_start';
	}
	session.currentStep--;
	session.lastActivityAt = Date.now();
	return 'ok';
}

// ─── Activity & expiry ──────────────────────────────────────────────

export function touchSession(session: CookSession): void {
	session.lastActivityAt = Date.now();
}

export function isSessionExpired(session: CookSession): boolean {
	return Date.now() - session.lastActivityAt > EXPIRY_MS;
}

export function cleanExpiredSessions(): number {
	let removed = 0;
	for (const [userId, session] of activeSessions) {
		if (isSessionExpired(session)) {
			activeSessions.delete(userId);
			removed++;
		}
	}
	return removed;
}

// ─── Formatting ─────────────────────────────────────────────────────

export function formatStepMessage(session: CookSession): string {
	const stepNum = session.currentStep + 1; // 1-indexed for display
	const instruction = session.instructions[session.currentStep];
	return `Step ${stepNum} of ${session.totalSteps}\n\n${escapeMarkdown(instruction)}`;
}

export function buildStepButtons(session: CookSession, timer?: ParsedTimer | null): InlineButton[][] {
	const navRow: InlineButton[] = [
		{ text: '< Back', callbackData: 'app:food:ck:b' },
		{ text: 'Repeat', callbackData: 'app:food:ck:r' },
		{ text: 'Next >', callbackData: 'app:food:ck:n' },
		{ text: 'Done ✓', callbackData: 'app:food:ck:d' },
	];

	const rows: InlineButton[][] = [navRow];

	if (timer) {
		const hasActiveTimerOnThisStep =
			session.timerHandle !== undefined && session.timerStepIndex === session.currentStep;

		if (hasActiveTimerOnThisStep) {
			rows.push([
				{ text: '⏱ Cancel Timer', callbackData: 'app:food:ck:tc' },
			]);
		} else {
			rows.push([
				{
					text: `⏱ Set Timer (${formatDuration(timer.durationMinutes)})`,
					callbackData: 'app:food:ck:t',
				},
			]);
		}
	}

	return rows;
}

export function formatCompletionMessage(session: CookSession): string {
	return `✅ All done with ${escapeMarkdown(session.recipeTitle)}! Hope it turned out great.\n\nThe nightly rating prompt will ask you how it was, or you can mark it cooked from /mealplan.`;
}
