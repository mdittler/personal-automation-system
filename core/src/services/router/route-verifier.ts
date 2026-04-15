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

import { join } from 'node:path';
import type { Logger } from 'pino';
import type { LLMService } from '../../types/llm.js';
import type { MessageContext, PhotoContext, SentMessage } from '../../types/telegram.js';
import type { TelegramService } from '../../types/telegram.js';
import type { AppRegistry } from '../app-registry/index.js';
import { buildVerificationPrompt } from '../llm/prompt-templates.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import type { PendingEntry, PendingVerificationStore } from './pending-verification-store.js';
import type { VerificationLogger } from './verification-logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VerifyAction =
	| {
			action: 'route';
			appId: string;
			intent: string;
			confidence: number;
			/** 'agreed' when the verifier confirmed the classifier's pick; 'degraded' when
			 *  the verifier LLM failed, returned unparseable output, hallucinated an appId,
			 *  or failed to send inline buttons — non-strict mode falls back to classifier. */
			verifierStatus: 'agreed' | 'degraded';
	  }
	| { action: 'held' }
	| { action: 'fallback' };

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

/** Parse the verifier LLM's JSON response. Returns undefined if unparseable. */
function parseVerifierResponse(raw: string): VerifierResponse | undefined {
	const stripped = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '')
		.trim();
	try {
		const parsed: unknown = JSON.parse(stripped);
		if (typeof parsed !== 'object' || parsed === null) return undefined;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.agrees !== 'boolean') return undefined;
		return {
			agrees: obj.agrees,
			suggestedAppId: typeof obj.suggestedAppId === 'string' ? obj.suggestedAppId : undefined,
			suggestedIntent: typeof obj.suggestedIntent === 'string' ? obj.suggestedIntent : undefined,
			reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
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
	private readonly photoDir?: string;

	/** Tracks real sent message IDs by pendingId (since we add to pendingStore before sending). */
	private readonly sentMessages = new Map<string, SentMessage>();

	constructor(options: RouteVerifierOptions) {
		this.llm = options.llm;
		this.telegram = options.telegram;
		this.registry = options.registry;
		this.pendingStore = options.pendingStore;
		this.verificationLogger = options.verificationLogger;
		this.logger = options.logger;
		this.photoDir = options.photoDir;
	}

	/**
	 * Verify a classifier routing decision with a second LLM call.
	 *
	 * Returns `{ action: 'route', appId }` to proceed immediately, or
	 * `{ action: 'held' }` if the message is waiting for user input.
	 *
	 * @param recentInteractions - Optional context string from InteractionContextService.
	 *   Injected into the verification prompt to help the LLM make a better decision.
	 * @param strict - If true, LLM failure or unparseable output returns `{ action: 'fallback' }`
	 *   instead of `{ action: 'route' }`. Used by context-promotion to prevent degraded
	 *   verifier decisions from silently dispatching sub-threshold messages.
	 */
	async verify(
		ctx: MessageContext | PhotoContext,
		classifierResult: { appId: string; intent: string; confidence: number },
		photoPath?: string,
		enabledApps?: string[],
		recentInteractions?: string,
		strict?: boolean,
	): Promise<VerifyAction> {
		const isPhoto = 'photo' in ctx;
		const messageText = isPhoto
			? ((ctx as PhotoContext).caption ?? '')
			: (ctx as MessageContext).text;

		let resolvedPhotoPath = photoPath;
		if (isPhoto) {
			resolvedPhotoPath = await this.savePhoto(ctx as PhotoContext);
		}

		const allApps = this.registry.getAll();

		// Filter to user-enabled apps only (prevents LLM from suggesting inaccessible apps)
		const accessibleApps = enabledApps
			? allApps.filter((app) => {
					const id = app.manifest.app.id;
					return enabledApps.includes('*') || enabledApps.includes(id);
				})
			: allApps;

		// Skip verification when there's 0–1 candidate apps (no alternatives to verify against)
		if (accessibleApps.length <= 1) {
			this.logger.debug(
				'RouteVerifier: skipping verification — 1 or fewer accessible apps',
			);
			// Return the single accessible app's ID, not the classifier's pick (which may not be accessible)
			const fallbackId =
				accessibleApps.length === 1
					? accessibleApps[0]!.manifest.app.id
					: classifierResult.appId;
			return {
				action: 'route',
				appId: fallbackId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'agreed',
			};
		}

		const candidateApps = accessibleApps.map((app) => ({
			appId: app.manifest.app.id,
			appName: app.manifest.app.name,
			appDescription: app.manifest.app.description,
			intents: app.manifest.capabilities?.messages?.intents ?? [],
		}));

		const classifierApp = accessibleApps.find((a) => a.manifest.app.id === classifierResult.appId);
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
			recentInteractions,
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
			// In strict mode, LLM failure must not produce a route — return fallback so the
			// caller (context-promotion) can safely defer to chatbot instead of dispatching
			// a sub-threshold message based on a degraded verifier decision.
			if (strict) return { action: 'fallback' };
			return {
				action: 'route',
				appId: classifierResult.appId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'degraded',
			};
		}

		if (verifierResponse === undefined) {
			if (strict) return { action: 'fallback' };
			return {
				action: 'route',
				appId: classifierResult.appId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'degraded',
			};
		}

		if (verifierResponse.agrees) {
			this.logEntry({
				ctx,
				messageText,
				isPhoto,
				photoPath: resolvedPhotoPath,
				classifierResult,
				verifierAgrees: true,
				outcome: 'auto',
				routedTo: classifierResult.appId,
			});
			return {
				action: 'route',
				appId: classifierResult.appId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'agreed',
			};
		}

		// Verifier disagrees — validate suggested appId exists in registry
		const rawSuggestedId = verifierResponse.suggestedAppId ?? 'chatbot';
		const suggestedApp = accessibleApps.find((a) => a.manifest.app.id === rawSuggestedId);

		// If the LLM hallucinated an appId that doesn't exist, fall back to classifier's pick
		if (!suggestedApp && rawSuggestedId !== 'chatbot') {
			this.logger.warn(
				{ suggestedAppId: rawSuggestedId },
				'RouteVerifier: LLM suggested non-existent app — falling back to classifier',
			);
			return {
				action: 'route',
				appId: classifierResult.appId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'degraded',
			};
		}

		const suggestedAppId = rawSuggestedId;
		const suggestedAppName = suggestedApp?.manifest.app.name ?? suggestedAppId;

		// Add with placeholder sent IDs to get pendingId for callback data
		const pendingId = this.pendingStore.add({
			ctx,
			isPhoto,
			classifierResult,
			verifierSuggestedAppId: suggestedAppId,
			verifierSuggestedIntent: verifierResponse.suggestedIntent,
			sentMessageId: 0,
			sentChatId: 0,
			photoPath: resolvedPhotoPath,
		});

		// Build deduplicated button list — classifier pick + verifier suggestion (no chatbot)
		const buttonEntries = new Map<string, string>(); // appId → display name
		buttonEntries.set(classifierResult.appId, classifierAppName);
		if (suggestedAppId !== classifierResult.appId && suggestedAppId !== 'chatbot') {
			buttonEntries.set(suggestedAppId, suggestedAppName);
		}

		const buttons = [
			[...buttonEntries.entries()].map(([appId, name]) => ({
				text: name,
				callbackData: `rv:${pendingId}:${appId}`,
			})),
		];

		const suffix =
			buttonEntries.size > 1
				? ` or *${escapeMarkdown(suggestedAppName)}*?`
				: `? Tap to confirm or I'll keep waiting.`;
		const promptText = `I'm not sure which app should handle your message. Did you mean *${escapeMarkdown(classifierAppName)}*${suffix}`;

		let sent: SentMessage;
		try {
			sent = await this.telegram.sendWithButtons(ctx.userId, promptText, buttons);
		} catch (err) {
			this.logger.error({ err }, 'RouteVerifier: failed to send inline buttons');
			this.pendingStore.resolve(pendingId);
			return {
				action: 'route',
				appId: classifierResult.appId,
				intent: classifierResult.intent,
				confidence: classifierResult.confidence,
				verifierStatus: 'degraded',
			};
		}

		// Track the real sent IDs for use in resolveCallback
		this.sentMessages.set(pendingId, sent);

		this.logEntry({
			ctx,
			messageText,
			isPhoto,
			photoPath: resolvedPhotoPath,
			classifierResult,
			verifierAgrees: false,
			verifierSuggestedAppId: suggestedAppId,
			verifierSuggestedIntent: verifierResponse.suggestedIntent,
			outcome: 'pending',
			routedTo: 'pending',
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

	private async savePhoto(ctx: PhotoContext): Promise<string | undefined> {
		if (!this.photoDir) return undefined;
		try {
			const { ensureDir } = await import('../../utils/file.js');
			const { writeFile } = await import('node:fs/promises');
			await ensureDir(this.photoDir);
			const timestamp = new Date()
				.toISOString()
				.replace(/[:.]/g, '')
				.replace('T', '-')
				.slice(0, 15);
			const ext = ctx.mimeType.split('/')[1] ?? 'jpg';
			const filename = `${timestamp}-${ctx.userId}.${ext}`;
			const fullPath = join(this.photoDir, filename);
			await writeFile(fullPath, ctx.photo);
			// Return relative path for log references
			return `route-verification/photos/${filename}`;
		} catch (error) {
			this.logger.error({ error }, 'Failed to save photo for verification log');
			return undefined;
		}
	}

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
		outcome: 'auto' | 'user override' | 'pending';
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
