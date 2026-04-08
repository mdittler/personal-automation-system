/**
 * RouteVerifier — coordinates LLM-based route verification for grey-zone messages.
 *
 * When the classifier confidence is below threshold, this service calls a second
 * LLM to verify or dispute the routing decision. If disputed, it holds the message
 * and presents the user with inline buttons to choose the correct app.
 *
 * Implementation note on pending ID / sent message ID ordering:
 *   We need the pendingId before sending (it goes in the callback data), but we
 *   don't know the sent messageId until after sending. We add to pendingStore with
 *   placeholder IDs (0, 0), then track the real sent IDs in a local Map<pendingId,
 *   SentMessage> so resolveCallback can call editMessage correctly.
 */

import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import type { MessageContext, PhotoContext, SentMessage } from '../../types/telegram.js';
import type { TelegramService } from '../../types/telegram.js';
import type { AppRegistry } from '../app-registry/index.js';
import type { PendingVerificationStore, PendingEntry } from './pending-verification-store.js';
import type { VerificationLogger } from './verification-logger.js';
import { buildVerificationPrompt } from '../llm/prompt-templates.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VerifyAction = { action: 'route'; appId: string } | { action: 'held' };

export interface RouteVerifierOptions {
	llm: LLMService;
	telegram: TelegramService;
	registry: AppRegistry;
	pendingStore: PendingVerificationStore;
	verificationLogger: VerificationLogger;
	logger: Logger;
	/** Reserved for photo saving (Task 9). Not used yet. */
	photoDir?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface VerifierResponse {
	agrees: boolean;
	suggestedAppId?: string;
	suggestedIntent?: string;
	reasoning?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape special MarkdownV2 characters for Telegram. */
function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Parse the verifier LLM's JSON response. Returns undefined if unparseable. */
function parseVerifierResponse(raw: string): VerifierResponse | undefined {
	const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
	try {
		const parsed: unknown = JSON.parse(stripped);
		if (typeof parsed !== 'object' || parsed === null) return undefined;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj['agrees'] !== 'boolean') return undefined;
		return {
			agrees: obj['agrees'] as boolean,
			suggestedAppId: typeof obj['suggestedAppId'] === 'string' ? obj['suggestedAppId'] : undefined,
			suggestedIntent: typeof obj['suggestedIntent'] === 'string' ? obj['suggestedIntent'] : undefined,
			reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'] : undefined,
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// RouteVerifier
// ---------------------------------------------------------------------------

export class RouteVerifier {
	private readonly llm: LLMService;
	private readonly telegram: TelegramService;
	private readonly registry: AppRegistry;
	private readonly pendingStore: PendingVerificationStore;
	private readonly verificationLogger: VerificationLogger;
	private readonly logger: Logger;

	/** Tracks real sent message IDs by pendingId (since we add to pendingStore before sending). */
	private readonly sentMessages = new Map<string, SentMessage>();

	constructor(options: RouteVerifierOptions) {
		this.llm = options.llm;
		this.telegram = options.telegram;
		this.registry = options.registry;
		this.pendingStore = options.pendingStore;
		this.verificationLogger = options.verificationLogger;
		this.logger = options.logger;
	}

	/**
	 * Verify a classifier routing decision with a second LLM call.
	 *
	 * Returns `{ action: 'route', appId }` to proceed immediately, or
	 * `{ action: 'held' }` if the message is waiting for user input.
	 */
	async verify(
		ctx: MessageContext | PhotoContext,
		classifierResult: { appId: string; intent: string; confidence: number },
		photoPath?: string,
	): Promise<VerifyAction> {
		const isPhoto = 'photo' in ctx;
		const messageText = isPhoto ? ((ctx as PhotoContext).caption ?? '') : (ctx as MessageContext).text;

		const allApps = this.registry.getAll();
		const candidateApps = allApps.map((app) => ({
			appId: app.manifest.app.id,
			appName: app.manifest.app.name,
			appDescription: app.manifest.app.description,
			intents: app.manifest.capabilities?.messages?.intents ?? [],
		}));

		const classifierApp = allApps.find((a) => a.manifest.app.id === classifierResult.appId);
		const classifierAppName = classifierApp?.manifest.app.name ?? classifierResult.appId;

		const prompt = buildVerificationPrompt({
			originalText: messageText,
			classifierResult: {
				appId: classifierResult.appId,
				appName: classifierAppName,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
			},
			candidateApps,
		});

		// Call verifier LLM — degrade gracefully on any failure
		let verifierResponse: VerifierResponse | undefined;
		try {
			const raw = await this.llm.complete(prompt, { tier: 'standard', temperature: 0.1 });
			verifierResponse = parseVerifierResponse(raw);
			if (verifierResponse === undefined) {
				this.logger.warn({ raw }, 'RouteVerifier: unparseable LLM response — degrading gracefully');
			}
		} catch (err) {
			this.logger.warn({ err }, 'RouteVerifier: LLM call failed — degrading gracefully');
			return { action: 'route', appId: classifierResult.appId };
		}

		if (verifierResponse === undefined) {
			return { action: 'route', appId: classifierResult.appId };
		}

		if (verifierResponse.agrees) {
			this.logEntry({
				ctx,
				messageText,
				isPhoto,
				photoPath,
				classifierResult,
				verifierAgrees: true,
				outcome: 'auto',
				routedTo: classifierResult.appId,
			});
			return { action: 'route', appId: classifierResult.appId };
		}

		// Verifier disagrees — present inline buttons to the user
		const suggestedAppId = verifierResponse.suggestedAppId ?? 'chatbot';
		const suggestedApp = allApps.find((a) => a.manifest.app.id === suggestedAppId);
		const suggestedAppName = suggestedApp?.manifest.app.name ?? suggestedAppId;

		// Add with placeholder sent IDs to get pendingId for callback data
		const pendingId = this.pendingStore.add({
			ctx,
			isPhoto,
			classifierResult,
			verifierSuggestedAppId: suggestedAppId,
			sentMessageId: 0,
			sentChatId: 0,
			photoPath,
		});

		const buttons = [
			[
				{ text: classifierAppName, callbackData: `rv:${pendingId}:${classifierResult.appId}` },
				{ text: suggestedAppName, callbackData: `rv:${pendingId}:${suggestedAppId}` },
				{ text: 'Chatbot', callbackData: `rv:${pendingId}:chatbot` },
			],
		];

		const promptText = "I'm not sure where to send this. Which app should handle it?";

		let sent: SentMessage;
		try {
			sent = await this.telegram.sendWithButtons(ctx.userId, promptText, buttons);
		} catch (err) {
			this.logger.error({ err }, 'RouteVerifier: failed to send inline buttons');
			this.pendingStore.resolve(pendingId);
			return { action: 'route', appId: classifierResult.appId };
		}

		// Track the real sent IDs for use in resolveCallback
		this.sentMessages.set(pendingId, sent);

		this.logEntry({
			ctx,
			messageText,
			isPhoto,
			photoPath,
			classifierResult,
			verifierAgrees: false,
			verifierSuggestedAppId: suggestedAppId,
			verifierSuggestedIntent: verifierResponse.suggestedIntent,
			outcome: 'auto',
			routedTo: classifierResult.appId,
		});

		return { action: 'held' };
	}

	/**
	 * Resolve a pending verification entry after the user clicks an inline button.
	 *
	 * Returns `{ entry, chosenAppId }` or undefined if the pending ID is unknown.
	 */
	async resolveCallback(
		pendingId: string,
		chosenAppId: string,
	): Promise<{ entry: PendingEntry; chosenAppId: string } | undefined> {
		const entry = this.pendingStore.resolve(pendingId);
		if (entry === undefined) {
			this.logger.warn({ pendingId }, 'RouteVerifier.resolveCallback: unknown pending ID');
			return undefined;
		}

		// Use real sent IDs from local map, fall back to entry values (both 0 if never set)
		const sent = this.sentMessages.get(pendingId);
		this.sentMessages.delete(pendingId);
		const sentChatId = sent?.chatId ?? entry.sentChatId;
		const sentMessageId = sent?.messageId ?? entry.sentMessageId;

		const allApps = this.registry.getAll();
		const chosenApp = allApps.find((a) => a.manifest.app.id === chosenAppId);
		const chosenAppName = chosenApp?.manifest.app.name ?? chosenAppId;

		// Edit the button message to show the confirmation
		const confirmationText = `Routed to *${escapeMarkdown(chosenAppName)}*`;
		try {
			await this.telegram.editMessage(sentChatId, sentMessageId, confirmationText, []);
		} catch (err) {
			this.logger.warn({ err, pendingId }, 'RouteVerifier.resolveCallback: failed to edit message');
		}

		// Log the user override
		const isPhoto = entry.isPhoto;
		const messageText = isPhoto
			? ((entry.ctx as PhotoContext).caption ?? '')
			: (entry.ctx as MessageContext).text;

		this.logEntry({
			ctx: entry.ctx,
			messageText,
			isPhoto,
			photoPath: entry.photoPath,
			classifierResult: entry.classifierResult,
			verifierAgrees: false,
			verifierSuggestedAppId: entry.verifierSuggestedAppId,
			userChoice: chosenAppId,
			outcome: 'user override',
			routedTo: chosenAppId,
		});

		return { entry, chosenAppId };
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private logEntry(params: {
		ctx: MessageContext | PhotoContext;
		messageText: string;
		isPhoto: boolean;
		photoPath?: string;
		classifierResult: { appId: string; intent: string; confidence: number };
		verifierAgrees: boolean;
		verifierSuggestedAppId?: string;
		verifierSuggestedIntent?: string;
		userChoice?: string;
		outcome: 'auto' | 'user override';
		routedTo: string;
	}): void {
		this.verificationLogger
			.log({
				timestamp: new Date(),
				userId: params.ctx.userId,
				messageText: params.messageText,
				messageType: params.isPhoto ? 'photo' : 'text',
				photoPath: params.photoPath,
				classifierAppId: params.classifierResult.appId,
				classifierConfidence: params.classifierResult.confidence,
				classifierIntent: params.classifierResult.intent,
				verifierAgrees: params.verifierAgrees,
				verifierSuggestedAppId: params.verifierSuggestedAppId,
				verifierSuggestedIntent: params.verifierSuggestedIntent,
				userChoice: params.userChoice,
				outcome: params.outcome,
				routedTo: params.routedTo,
			})
			.catch((err: unknown) => {
				this.logger.warn({ err }, 'RouteVerifier: failed to write verification log');
			});
	}
}
