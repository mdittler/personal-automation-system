/**
 * D5b-9a: First-run wizard for new users invited via /invite code.
 *
 * Triggered from redeemInviteAndRegister() after successful registration.
 * Two-step flow:
 *   1. Welcome message + capability summary.
 *   2. Daily digest preference (Yes / No inline buttons).
 *
 * Preference stored in `data/system/onboarding.yaml` keyed by userId.
 * Wizard state lives in a module-level Map with a 10-minute TTL.
 *
 * Entry:   beginFirstRunWizard(deps, userId, displayName)
 * Text:    handleFirstRunWizardReply(deps, userId, text)  — re-prompts (text not accepted)
 * Buttons: handleFirstRunWizardCallback(deps, userId, callbackData) — handles onboard:* prefix
 */

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { TelegramService } from '../../types/telegram.js';
import { readYamlFile, writeYamlFile } from '../../utils/yaml.js';

export interface FirstRunWizardDeps {
	telegram: TelegramService;
	dataDir: string;
	logger: Logger;
}

// ---- Wizard state ----

type WizardStep = 'awaiting_digest_preference';

interface WizardState {
	step: WizardStep;
	name: string;
	expiresAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min
const pending = new Map<string, WizardState>();

function cleanupExpired(userId: string): WizardState | undefined {
	const entry = pending.get(userId);
	if (!entry) return undefined;
	if (Date.now() > entry.expiresAt) {
		pending.delete(userId);
		return undefined;
	}
	return entry;
}

export function hasPendingFirstRunWizard(userId: string): boolean {
	return cleanupExpired(userId) !== undefined;
}

// ---- Onboarding persistence ----

interface OnboardingRecord {
	digestPreference: 'yes' | 'no';
	completedAt: string;
}

interface OnboardingStore {
	[userId: string]: OnboardingRecord;
}

async function savePreference(
	deps: FirstRunWizardDeps,
	userId: string,
	preference: 'yes' | 'no',
): Promise<void> {
	const filePath = join(deps.dataDir, 'system', 'onboarding.yaml');
	const existing = (await readYamlFile<OnboardingStore>(filePath)) ?? {};
	existing[userId] = {
		digestPreference: preference,
		completedAt: new Date().toISOString(),
	};
	await writeYamlFile(filePath, existing);
}

// ---- Wizard steps ----

async function sendDigestQuestion(
	deps: FirstRunWizardDeps,
	userId: string,
): Promise<void> {
	await deps.telegram.sendWithButtons(
		userId,
		'Would you like a daily digest message each morning summarizing your household activity? You can change this later.',
		[
			[
				{ text: 'Yes, send me a daily digest', callbackData: 'onboard:digest-yes' },
				{ text: 'No thanks', callbackData: 'onboard:digest-no' },
			],
		],
	);
}

// ---- Public API ----

/**
 * Begin the first-run wizard for a newly registered user.
 * Sends a welcome message followed immediately by the digest preference question.
 */
export async function beginFirstRunWizard(
	deps: FirstRunWizardDeps,
	userId: string,
	displayName: string,
): Promise<void> {
	pending.set(userId, {
		step: 'awaiting_digest_preference',
		name: displayName,
		expiresAt: Date.now() + PENDING_TTL_MS,
	});

	try {
		await deps.telegram.send(
			userId,
			`Welcome to PAS, ${displayName}! I'm your home automation assistant. You can ask me to track groceries, set reminders, manage recipes, and more.`,
		);
		await sendDigestQuestion(deps, userId);
	} catch (err) {
		deps.logger.error({ userId, err }, 'beginFirstRunWizard: failed to send welcome');
	}
}

/**
 * Handle a free-text reply when the user is in the wizard.
 * We don't accept free-text at the digest step — re-prompt with the buttons.
 */
export async function handleFirstRunWizardReply(
	deps: FirstRunWizardDeps,
	userId: string,
	_text: string,
): Promise<void> {
	const state = cleanupExpired(userId);
	if (!state) return;

	// Only one step currently: re-prompt with buttons.
	await deps.telegram.send(userId, 'Please use the buttons below to answer:');
	await sendDigestQuestion(deps, userId);
}

/**
 * Handle an inline button callback from the wizard.
 * Accepts 'onboard:digest-yes' and 'onboard:digest-no'.
 * Returns true if the callback was consumed, false otherwise.
 */
export async function handleFirstRunWizardCallback(
	deps: FirstRunWizardDeps,
	userId: string,
	callbackData: string,
): Promise<boolean> {
	if (!callbackData.startsWith('onboard:')) return false;

	const state = cleanupExpired(userId);
	if (!state) {
		// Wizard expired — silently ignore stale button press.
		return true;
	}

	if (callbackData === 'onboard:digest-yes' || callbackData === 'onboard:digest-no') {
		const preference = callbackData === 'onboard:digest-yes' ? 'yes' : 'no';
		pending.delete(userId);

		try {
			await savePreference(deps, userId, preference);
		} catch (err) {
			deps.logger.error({ userId, err }, 'handleFirstRunWizardCallback: failed to save preference');
		}

		await deps.telegram.send(
			userId,
			"You're all set. Type /help any time to see what I can do.",
		);
		return true;
	}

	// Unknown onboard: prefix — ignore.
	return true;
}

/** Test-only — clears module state between tests. */
export function __resetFirstRunWizardForTests(): void {
	pending.clear();
}
