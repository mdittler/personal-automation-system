/**
 * Message router: the central dispatcher for all incoming messages.
 *
 * Classifies messages and routes them to the correct app handler.
 * Priority order (URS-RT-002):
 *   1. Explicit /command → exact match against registered commands
 *   2. Photo messages → classify type, match photo_intents
 *   3. Free text → LLM classification against all apps' intents
 *   4. Fallback → ConversationService when wired, else FallbackHandler (per-user disable via AppToggleStore preserved)
 */

import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { getCurrentHouseholdId, requestContext } from '../../services/context/request-context.js';
import type { ChatSessionStore } from '../conversation-session/chat-session-store.js';
import { buildSessionKey } from '../conversation-session/session-key.js';
import type { SystemConfig } from '../../types/config.js';
import type { LLMService } from '../../types/llm.js';
import type {
	MessageContext,
	PhotoContext,
	RouteInfo,
	RouteSource,
	RouteVerifierStatus,
	TelegramService,
} from '../../types/telegram.js';
import { escapeMarkdown } from '../../utils/escape-markdown.js';
import type { AppRegistry, RegisteredApp } from '../app-registry/index.js';
import type { CommandMapEntry, IntentTableEntry } from '../app-registry/manifest-cache.js';
import type { AppToggleStore } from '../app-toggle/index.js';
import type { ConversationService } from '../conversation/conversation-service.js';
import {
	createPendingEntry,
	type PendingSessionControlStore,
	SC_NO,
	SC_YES,
} from '../conversation/pending-session-control-store.js';
import {
	detectSessionControl,
	type SessionControlClassifierDeps,
	type SessionControlResult,
} from '../conversation/session-control-classifier.js';
import type { HouseholdService } from '../household/index.js';
import type { InteractionContextService } from '../interaction-context/index.js';
import type { InviteService } from '../invite/index.js';
import { redeemInviteAndRegister } from '../invite/redeem-and-register.js';
import type { MessageRateTracker } from '../metrics/message-rate-tracker.js';
import {
	handleFirstRunWizardReply,
	hasPendingFirstRunWizard,
} from '../onboarding/first-run-wizard.js';
import type { SpaceService } from '../spaces/index.js';
import type { UserManager } from '../user-manager/index.js';
import type { UserMutationService } from '../user-manager/user-mutation-service.js';
import { lookupCommand, parseCommand } from './command-parser.js';
import type { FallbackHandler } from './fallback.js';
import { IntentClassifier } from './intent-classifier.js';
import { PhotoClassifier } from './photo-classifier.js';
import type { RouteVerifier, VerifyAction } from './route-verifier.js';

/** Default confidence threshold for intent classification. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Route info factory helpers
// ---------------------------------------------------------------------------
// Centralising construction prevents copy-paste drift across the 7+ dispatch
// branches. Each factory encodes exactly one routing shape.

/** RouteInfo for a successfully matched /command. */
function routeForCommand(appId: string, commandName: string): RouteInfo {
	return {
		appId,
		intent: commandName,
		confidence: 1.0,
		source: 'command',
		verifierStatus: 'not-run',
	};
}

/** RouteInfo for the ConversationService fallback branch. */
function routeForFallback(): RouteInfo {
	return {
		appId: 'chatbot',
		intent: 'chatbot',
		confidence: 0,
		source: 'fallback',
		verifierStatus: 'not-run',
	};
}

/**
 * RouteInfo built from a classifier match (intent or photo-intent), with the
 * verifierStatus supplied by the caller (skipped / not-run / agreed / degraded).
 */
function routeFromClassifier(
	appId: string,
	intent: string,
	confidence: number,
	source: RouteSource,
	verifierStatus: RouteVerifierStatus,
): RouteInfo {
	return { appId, intent, confidence, source, verifierStatus };
}

/** RouteInfo derived from a `VerifyAction.route` result (carries intent, confidence, verifierStatus). */
function routeFromVerifyAction(
	result: Extract<VerifyAction, { action: 'route' }>,
	source: RouteSource,
): RouteInfo {
	return {
		appId: result.appId,
		intent: result.intent,
		confidence: result.confidence,
		source,
		verifierStatus: result.verifierStatus,
	};
}

/**
 * RouteInfo for the user-override (rv: callback) re-dispatch path.
 *
 * Exported so bootstrap.ts can import it for use in the `rv:` callback handler,
 * and so the same logic can be unit-tested without a full bootstrap integration.
 *
 * Intent selection:
 *  - If the user chose the app the classifier originally suggested, carry through
 *    the classifier's intent (most specific).
 *  - If they chose the verifier's suggestion, use verifierSuggestedIntent when
 *    available. Fall back to the chosen appId as a coarser-but-honest label.
 */
export function buildUserOverrideRouteInfo(
	classifierResult: { appId: string; intent: string },
	chosenAppId: string,
	verifierSuggestedIntent?: string,
): RouteInfo {
	const intent =
		chosenAppId === classifierResult.appId
			? classifierResult.intent
			: (verifierSuggestedIntent ?? chosenAppId);
	return {
		appId: chosenAppId,
		intent,
		confidence: 1.0,
		source: 'user-override',
		verifierStatus: 'user-override',
	};
}

export interface RouterOptions {
	registry: AppRegistry;
	llm: LLMService;
	telegram: TelegramService;
	fallback: FallbackHandler;
	config: SystemConfig;
	logger: Logger;
	confidenceThreshold?: number;
	appToggle?: AppToggleStore;
	/**
	 * ConversationService for free-text fallback. The router calls this directly
	 * via `dispatchConversation()` for unmatched messages.
	 */
	conversationService?: ConversationService;
	/** Space service for /space command + active space injection. */
	spaceService?: SpaceService;
	/** User manager for /space invite by name. */
	userManager?: UserManager;
	/** Route verifier for grey-zone confidence disambiguation. */
	routeVerifier?: RouteVerifier;
	/** Confidence upper bound for verification (default: 0.7). */
	verificationUpperBound?: number;
	/** Invite service for /invite command and /start code redemption. */
	inviteService?: InviteService;
	/** User mutation service for registering users via invite codes. */
	userMutationService?: UserMutationService;
	/** Interaction context service for context-aware low-confidence promotion. */
	interactionContext?: InteractionContextService;
	/** Optional — when present, householdId is derived and injected into request context for each dispatch. */
	householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	/** Optional — when present, records a message hit per routeMessage call for ops metrics. */
	messageRateTracker?: MessageRateTracker;
	/** Optional — when present, binds requestContext.sessionId via peekActive before every conversation dispatch. */
	chatSessions?: ChatSessionStore;
	/**
	 * Optional — when present, enables the NL /newchat hook for free-text messages.
	 * Both sessionControlClassifier and pendingSessionControl must be provided together.
	 */
	sessionControlClassifier?: typeof detectSessionControl;
	/** Optional — in-memory TTL store for grey-zone session-reset confirmations. */
	pendingSessionControl?: PendingSessionControlStore;
}

export class Router {
	private readonly registry: AppRegistry;
	private readonly telegram: TelegramService;
	private readonly fallback: FallbackHandler;
	private readonly config: SystemConfig;
	private readonly logger: Logger;
	private readonly confidenceThreshold: number;
	private readonly intentClassifier: IntentClassifier;
	private readonly photoClassifier: PhotoClassifier;
	private readonly appToggle?: AppToggleStore;
	private readonly conversationService?: ConversationService;
	private readonly spaceService?: SpaceService;
	private readonly userManager?: UserManager;
	private readonly routeVerifier?: RouteVerifier;
	private readonly verificationUpperBound: number;
	private readonly inviteService?: InviteService;
	private readonly userMutationService?: UserMutationService;
	private readonly interactionContext?: InteractionContextService;
	private readonly householdService?: Pick<HouseholdService, 'getHouseholdForUser'>;
	private readonly llm: LLMService;
	private readonly messageRateTracker?: MessageRateTracker;
	private readonly chatSessions?: ChatSessionStore;
	private readonly sessionControlClassifier?: typeof detectSessionControl;
	private readonly pendingSessionControl?: PendingSessionControlStore;

	private commandMap = new Map<string, CommandMapEntry>();
	private intentTable: IntentTableEntry[] = [];
	private photoIntentTable: IntentTableEntry[] = [];

	constructor(options: RouterOptions) {
		this.registry = options.registry;
		this.telegram = options.telegram;
		this.fallback = options.fallback;
		this.config = options.config;
		this.logger = options.logger;
		this.llm = options.llm;
		this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
		this.appToggle = options.appToggle;
		this.conversationService = options.conversationService;
		this.spaceService = options.spaceService;
		this.userManager = options.userManager;
		this.routeVerifier = options.routeVerifier;
		this.verificationUpperBound = options.verificationUpperBound ?? 0.7;
		this.inviteService = options.inviteService;
		this.userMutationService = options.userMutationService;
		this.interactionContext = options.interactionContext;
		this.householdService = options.householdService;
		this.messageRateTracker = options.messageRateTracker;
		this.chatSessions = options.chatSessions;
		this.sessionControlClassifier = options.sessionControlClassifier;
		this.pendingSessionControl = options.pendingSessionControl;

		this.intentClassifier = new IntentClassifier({
			llm: options.llm,
			logger: options.logger,
		});
		this.photoClassifier = new PhotoClassifier({
			llm: options.llm,
			logger: options.logger,
		});
	}

	/** Build routing tables from the registry's manifest cache. */
	buildRoutingTables(): void {
		const cache = this.registry.getManifestCache();
		this.commandMap = cache.buildCommandMap();
		this.intentTable = cache.buildIntentTable();
		this.photoIntentTable = cache.buildPhotoIntentTable();

		this.logger.info(
			{
				commands: this.commandMap.size,
				intents: this.intentTable.length,
				photoIntents: this.photoIntentTable.length,
			},
			'Routing tables built',
		);
	}

	/**
	 * Route a text message to the appropriate app handler.
	 * This is the main entry point from the bot middleware.
	 */
	async routeMessage(ctx: MessageContext): Promise<void> {
		this.messageRateTracker?.recordMessage(getCurrentHouseholdId());

		// Parse command once for use throughout the method
		const parsed = parseCommand(ctx.text);

		// Handle /start <code> for unregistered users (invite redemption)
		if (
			parsed?.command === '/start' &&
			parsed.rawArgs.trim() &&
			this.inviteService &&
			this.userMutationService
		) {
			if (!this.findUser(ctx.userId)) {
				await this.handleInviteRedemption(parsed.rawArgs.trim(), ctx.userId);
				return;
			}
		}

		// 1. Check user authorization
		const user = this.findUser(ctx.userId);
		if (!user) {
			this.logger.warn({ userId: ctx.userId }, 'Message from unregistered user');
			await this.trySend(ctx.userId, 'You are not authorized to use this bot.');
			return;
		}

		// D5b-9a: First-run wizard intercept — only for free text.
		// Commands (/help, /start, etc.) pass through so the user isn't locked out.
		if (!parsed && hasPendingFirstRunWizard(ctx.userId)) {
			await handleFirstRunWizardReply(
				{ telegram: this.telegram, dataDir: this.config.dataDir, logger: this.logger },
				ctx.userId,
				ctx.text,
			);
			return;
		}

		// 2. Check for /command
		if (parsed) {
			// Handle built-in /space command before active space injection
			if (parsed.command === '/space') {
				await this.handleSpaceCommand(parsed.rawArgs, ctx);
				return;
			}
			// Handle built-in /invite command
			if (parsed.command === '/invite') {
				await this.handleInviteCommand(parsed.rawArgs, ctx);
				return;
			}
			// Inject active space context for all other commands
			const enrichedCtx = this.enrichWithActiveSpace(ctx);
			await this.handleCommand(parsed, enrichedCtx, user.enabledApps);
			return;
		}

		// Inject active space context for free text
		const enrichedCtx = this.enrichWithActiveSpace(ctx);

		// 3a. NL /newchat hook — runs before intent classification (opt-in: both deps required)
		if (this.sessionControlClassifier && this.pendingSessionControl) {
			const intercepted = await this.handleSessionControlHook(enrichedCtx);
			if (intercepted) return;
		}

		// 3. Free text → intent classification
		const match = await this.intentClassifier.classify(
			enrichedCtx.text,
			this.intentTable,
			this.confidenceThreshold,
		);

		if (match) {
			if (!(await this.isAppEnabled(enrichedCtx.userId, match.appId, user.enabledApps))) {
				await this.trySend(enrichedCtx.userId, `You don't have access to the ${match.appId} app.`);
				return;
			}

			// Grey-zone verification: if confidence is moderate and verifier is configured
			if (
				this.routeVerifier &&
				match.confidence >= this.confidenceThreshold &&
				match.confidence < this.verificationUpperBound
			) {
				// Resolve effective app list (raw enabledApps + appToggle overrides)
				const resolvedApps = await this.resolveEnabledApps(enrichedCtx.userId, user.enabledApps);
				const result = await this.routeVerifier.verify(enrichedCtx, match, undefined, resolvedApps);
				if (result.action === 'held') return;
				if (result.action !== 'route') return;
				// Verifier confirmed (possibly different app) — check access before dispatch
				const verifiedAppId = result.appId;
				if (!(await this.isAppEnabled(enrichedCtx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(
						enrichedCtx.userId,
						`You don't have access to the ${verifiedAppId} app.`,
					);
					return;
				}
				// When verifier picks 'chatbot' and conversationService is wired, prefer it (rule #2).
				if (verifiedAppId === 'chatbot' && this.conversationService) {
					await this.dispatchConversation(enrichedCtx, routeFromVerifyAction(result, 'intent'));
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp) {
					await this.dispatchMessage(
						verifiedApp,
						enrichedCtx,
						routeFromVerifyAction(result, 'intent'),
					);
					return;
				}
			}

			const app = this.registry.getApp(match.appId);
			if (app) {
				await this.dispatchMessage(
					app,
					enrichedCtx,
					routeFromClassifier(
						match.appId,
						match.intent,
						match.confidence,
						'intent',
						this.routeVerifier ? 'skipped' : 'not-run',
					),
				);
				return;
			}
		} else if (this.interactionContext && this.routeVerifier) {
			// 3b. Context-aware promotion: classify() returned null (below threshold).
			// Check recent interaction context — if recent activity matches a low-confidence
			// result, promote to the verifier. Safety invariant: NEVER direct-route here.
			await this.tryContextPromotion(enrichedCtx, user.enabledApps);
			return;
		}

		// 4. Fallback → ConversationService (preferred), legacy chatbot app, or daily notes
		await this.sendToFallback(enrichedCtx, user.enabledApps);
	}

	/**
	 * Route a photo message to the appropriate app handler.
	 */
	async routePhoto(ctx: PhotoContext): Promise<void> {
		// 1. Check user authorization
		const user = this.findUser(ctx.userId);
		if (!user) {
			this.logger.warn({ userId: ctx.userId }, 'Photo from unregistered user');
			await this.trySend(ctx.userId, 'You are not authorized to use this bot.');
			return;
		}

		// 2. Check if any apps accept photos
		const photoAppIds = this.registry.getManifestCache().getPhotoAppIds();
		if (photoAppIds.length === 0) {
			await this.trySend(ctx.userId, 'No apps are configured to handle photos.');
			return;
		}

		const enrichedCtx = this.enrichPhotoWithActiveSpace(ctx);

		// 3. Classify photo
		const match = await this.photoClassifier.classify(
			enrichedCtx.caption,
			this.photoIntentTable,
			this.confidenceThreshold,
		);

		if (match) {
			if (!(await this.isAppEnabled(enrichedCtx.userId, match.appId, user.enabledApps))) {
				await this.trySend(enrichedCtx.userId, `You don't have access to the ${match.appId} app.`);
				return;
			}

			// Grey-zone verification for photo messages
			if (
				this.routeVerifier &&
				match.confidence >= this.confidenceThreshold &&
				match.confidence < this.verificationUpperBound
			) {
				// Resolve effective app list (raw enabledApps + appToggle overrides)
				const resolvedApps = await this.resolveEnabledApps(enrichedCtx.userId, user.enabledApps);
				const result = await this.routeVerifier.verify(
					enrichedCtx,
					{
						appId: match.appId,
						intent: match.photoType,
						confidence: match.confidence,
					},
					undefined,
					resolvedApps,
				);
				if (result.action === 'held') return;
				if (result.action !== 'route') return;
				const verifiedAppId = result.appId;
				if (!(await this.isAppEnabled(enrichedCtx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(
						enrichedCtx.userId,
						`You don't have access to the ${verifiedAppId} app.`,
					);
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp?.module.handlePhoto) {
					await this.dispatchPhoto(
						verifiedApp,
						enrichedCtx,
						routeFromVerifyAction(result, 'photo-intent'),
					);
					return;
				}
			}

			const app = this.registry.getApp(match.appId);
			if (app?.module.handlePhoto) {
				await this.dispatchPhoto(
					app,
					enrichedCtx,
					routeFromClassifier(
						match.appId,
						match.photoType,
						match.confidence,
						'photo-intent',
						this.routeVerifier ? 'skipped' : 'not-run',
					),
				);
				return;
			}
		}

		// 4. Fallback — acknowledge photo saved
		await this.trySend(ctx.userId, "I couldn't determine what to do with this photo.");
	}

	/** Handle a parsed /command. */
	private async handleCommand(
		parsed: ReturnType<typeof parseCommand> & {},
		ctx: MessageContext,
		enabledApps: string[],
	): Promise<void> {
		// Built-in /help command
		if (parsed.command === '/help') {
			await this.sendHelp(ctx.userId, enabledApps);
			return;
		}

		// Built-in /start command (Telegram sends this when a user first opens the bot)
		if (parsed.command === '/start') {
			if (parsed.rawArgs.trim() && this.inviteService) {
				await this.trySend(ctx.userId, "You're already registered! Type /help to get started.");
				return;
			}
			await this.trySend(ctx.userId, 'Welcome to PAS! Type /help to see available commands.');
			return;
		}

		// Built-in conversation commands — short-circuit before lookupCommand so they
		// work even if the chatbot app has no /ask, /edit, /notes, /newchat, or /reset in its manifest.
		if (this.conversationService) {
			if (parsed.command === '/ask') {
				await this.dispatchConversationCommand('ask', parsed.args, ctx);
				return;
			}
			if (parsed.command === '/edit') {
				await this.dispatchConversationCommand('edit', parsed.args, ctx);
				return;
			}
			if (parsed.command === '/notes') {
				await this.dispatchConversationCommand('notes', parsed.args, ctx);
				return;
			}
			if (parsed.command === '/newchat' || parsed.command === '/reset') {
				await this.dispatchConversationCommand('newchat', parsed.args, ctx);
				return;
			}
			if (parsed.command === '/title') {
				await this.dispatchConversationCommand('title', parsed.args, ctx);
				return;
			}
		}

		const result = lookupCommand(parsed, this.commandMap);
		if (!result) {
			await this.trySend(
				ctx.userId,
				`Unknown command: ${escapeMarkdown(parsed.command)}. Type /help for available commands.`,
			);
			return;
		}

		if (!(await this.isAppEnabled(ctx.userId, result.appId, enabledApps))) {
			await this.trySend(ctx.userId, `You don't have access to the ${result.appId} app.`);
			return;
		}

		const app = this.registry.getApp(result.appId);
		if (!app) {
			this.logger.error({ appId: result.appId }, 'Command maps to non-loaded app');
			await this.trySend(ctx.userId, 'Something went wrong. Please try again later.');
			return;
		}

		const commandName = result.command.name.replace(/^\//, '');
		const commandRoute = routeForCommand(result.appId, commandName);

		if (app.module.handleCommand) {
			try {
				await app.module.handleCommand(commandName, result.parsedArgs, {
					...ctx,
					route: commandRoute,
				});
			} catch (error) {
				this.logger.error(
					{ appId: result.appId, command: result.command.name, error },
					'App command handler failed',
				);
				await this.trySend(ctx.userId, 'Something went wrong processing your command.');
			}
		} else {
			// App has no handleCommand — fall through to handleMessage
			await this.dispatchMessage(app, ctx, commandRoute);
		}
	}

	/**
	 * Dispatch a message to an app's handleMessage, with error isolation.
	 *
	 * `route` is a required parameter — omitting it is a compile error, which prevents
	 * accidentally dispatching without route metadata attached to the handler context.
	 * The helper spreads route onto ctx internally so callers never forget the spread.
	 *
	 * Re-establishes the request context with householdId so that household boundary
	 * enforcement downstream can read the correct householdId even when the outer
	 * bootstrap context was established before householdService was available.
	 */
	async dispatchMessage(app: RegisteredApp, ctx: MessageContext, route: RouteInfo): Promise<void> {
		const householdId = this.householdService?.getHouseholdForUser(ctx.userId) ?? undefined;
		try {
			await requestContext.run({ userId: ctx.userId, householdId }, () =>
				app.module.handleMessage({ ...ctx, route }),
			);
		} catch (error) {
			this.logger.error({ appId: app.manifest.app.id, error }, 'App message handler failed');
			await this.trySend(ctx.userId, 'Something went wrong. Please try again later.');
		}
	}

	/**
	 * Dispatch a photo to an app's handlePhoto, with error isolation.
	 *
	 * `route` is a required parameter for the same reason as dispatchMessage.
	 *
	 * Re-establishes the request context with householdId for the same reason as dispatchMessage.
	 */
	async dispatchPhoto(app: RegisteredApp, ctx: PhotoContext, route: RouteInfo): Promise<void> {
		const householdId = this.householdService?.getHouseholdForUser(ctx.userId) ?? undefined;
		try {
			await requestContext.run({ userId: ctx.userId, householdId }, () =>
				app.module.handlePhoto?.({ ...ctx, route }),
			);
		} catch (error) {
			this.logger.error({ appId: app.manifest.app.id, error }, 'App photo handler failed');
			await this.trySend(ctx.userId, 'Something went wrong processing your photo.');
		}
	}

	/**
	 * Resolve the session key and active session id for a user's conversation dispatch.
	 * Returns undefined for both if chatSessions is not wired.
	 */
	private async resolveSession(
		userId: string,
	): Promise<{ sessionKey: string; sessionId: string | undefined }> {
		const sessionKey = buildSessionKey({ agent: 'main', channel: 'telegram', scope: 'dm', chatId: userId });
		const sessionId = await this.chatSessions?.peekActive({ userId, sessionKey });
		return { sessionKey, sessionId };
	}

	/**
	 * Dispatch a free-text message to ConversationService, with the same request-context
	 * + error-isolation guarantees as dispatchMessage. Used for the chatbot fallback path
	 * (free-text and rv:chatbot route-verifier callback). Public so compose-runtime can
	 * call it directly for the rv:chatbot path with full error isolation.
	 */
	async dispatchConversation(ctx: MessageContext, route: RouteInfo): Promise<void> {
		if (!this.conversationService) {
			throw new Error('dispatchConversation called without conversationService');
		}
		const householdId = this.householdService?.getHouseholdForUser(ctx.userId) ?? undefined;
		const { sessionKey, sessionId } = await this.resolveSession(ctx.userId);
		const enrichedCtx: MessageContext = { ...ctx, route, sessionKey, sessionId };
		try {
			await requestContext.run({ userId: ctx.userId, householdId, sessionId }, () =>
				this.conversationService!.handleMessage(enrichedCtx),
			);
		} catch (error) {
			this.logger.error({ error }, 'ConversationService handler failed');
			await this.trySend(ctx.userId, 'Something went wrong. Please try again later.');
		}
	}

	/**
	 * Dispatch a built-in conversation command (/ask, /edit, /notes) to
	 * ConversationService. Mirrors dispatchConversation in structure: establishes
	 * requestContext, attaches route metadata, isolates errors.
	 *
	 * These commands bypass AppToggleStore — a user who disabled the chatbot app
	 * can still use /ask, /edit, and /notes explicitly (by design; see plan).
	 */
	private async dispatchConversationCommand(
		name: 'ask' | 'edit' | 'newchat' | 'title' | 'notes',
		args: string[],
		ctx: MessageContext,
	): Promise<void> {
		if (!this.conversationService) return;
		const householdId = this.householdService?.getHouseholdForUser(ctx.userId) ?? undefined;
		const { sessionKey, sessionId } = await this.resolveSession(ctx.userId);
		const route = routeForCommand('chatbot', name);
		const enrichedCtx: MessageContext = { ...ctx, route, sessionKey, sessionId };
		try {
			await requestContext.run({ userId: ctx.userId, householdId, sessionId }, async () => {
				if (name === 'ask') await this.conversationService!.handleAsk(args, enrichedCtx);
				else if (name === 'edit') await this.conversationService!.handleEdit(args, enrichedCtx);
				else if (name === 'newchat') await this.conversationService!.handleNewChat(args, enrichedCtx);
				else if (name === 'title') await this.conversationService!.handleTitle(args, enrichedCtx);
				else await this.conversationService!.handleNotes(args, enrichedCtx);
			});
		} catch (error) {
			this.logger.error({ command: name, error }, 'ConversationService command handler failed');
			await this.trySend(ctx.userId, 'Something went wrong. Please try again later.');
		}
	}

	/** Generate and send the /help message. */
	private async sendHelp(userId: string, enabledApps: string[]): Promise<void> {
		const lines: string[] = ['*Available Commands*\n'];

		// Built-in /space command
		if (this.spaceService) {
			lines.push('*Spaces*');
			lines.push('  /space — Show current mode and your spaces');
			lines.push('  /space <id> — Enter a shared space');
			lines.push('  /space off — Return to personal mode');
			lines.push('  /space create <id> <name> — Create a new space');
			lines.push('');
		}

		// Admin-only invite command
		if (this.inviteService) {
			const caller = this.findUser(userId);
			if (caller?.isAdmin) {
				lines.push('*Admin*');
				lines.push('  /invite <name> — Generate an invite code for a new user');
				lines.push('');
			}
		}

		// Built-in conversation commands (always listed when ConversationService is wired;
		// they bypass AppToggleStore so they appear regardless of chatbot toggle state).
		if (this.conversationService) {
			lines.push('*Conversation*');
			lines.push('  /ask <question> — Ask about apps, costs, or system status');
			lines.push('  /edit <description> — Propose an LLM-assisted file edit');
			lines.push('  /notes [on|off|status] — Toggle daily-notes logging for your messages');
			lines.push('  /newchat — Start a new conversation \\(alias: /reset\\)');
			lines.push('  /title [title] — Show or set the current session title');
			lines.push('');
		}

		// Group commands by app. Filter out the chatbot's own /ask, /edit, /notes, /newchat, /reset
		// entries if conversationService is wired (they're now built-ins, not app commands).
		const BUILTIN_COMMAND_NAMES = new Set(['/ask', '/edit', '/notes', '/newchat', '/reset', '/title']);
		const appCommands = new Map<string, Array<{ name: string; description: string }>>();

		for (const [, entry] of this.commandMap) {
			if (!(await this.isAppEnabled(userId, entry.appId, enabledApps))) continue;
			// Skip chatbot-manifest entries for commands that are now Router built-ins
			if (
				this.conversationService &&
				entry.appId === 'chatbot' &&
				BUILTIN_COMMAND_NAMES.has(entry.command.name)
			)
				continue;

			const app = this.registry.getApp(entry.appId);
			if (!app) continue;

			const appName = app.manifest.app.name;
			if (!appCommands.has(appName)) appCommands.set(appName, []);
			appCommands.get(appName)?.push({
				name: entry.command.name,
				description: entry.command.description,
			});
		}

		for (const [appName, commands] of appCommands) {
			lines.push(`*${escapeMarkdown(appName)}*`);
			for (const cmd of commands) {
				lines.push(`  ${escapeMarkdown(cmd.name)} — ${escapeMarkdown(cmd.description)}`);
			}
			lines.push('');
		}

		if (
			appCommands.size === 0 &&
			!this.conversationService &&
			!this.spaceService &&
			!this.inviteService
		) {
			lines.push('No commands available.');
		}

		await this.trySend(userId, lines.join('\n'));
	}

	/** Get the space service — guaranteed non-null when called from handleSpaceCommand. */
	private get spaces(): SpaceService {
		return this.spaceService as SpaceService;
	}

	/** Enrich message context with active space info if the user is in a space. */
	private enrichWithActiveSpace(ctx: MessageContext): MessageContext {
		if (!this.spaceService) return ctx;

		const activeSpaceId = this.spaceService.getActiveSpace(ctx.userId);
		if (!activeSpaceId) return ctx;

		const space = this.spaceService.getSpace(activeSpaceId);
		if (!space) return ctx;

		return { ...ctx, spaceId: activeSpaceId, spaceName: space.name };
	}

	/** Enrich photo context with active space info if the user is in space mode. */
	private enrichPhotoWithActiveSpace(ctx: PhotoContext): PhotoContext {
		if (!this.spaceService) return ctx;

		const activeSpaceId = this.spaceService.getActiveSpace(ctx.userId);
		if (!activeSpaceId) return ctx;

		const space = this.spaceService.getSpace(activeSpaceId);
		if (!space) return ctx;

		return { ...ctx, spaceId: activeSpaceId, spaceName: space.name };
	}

	/** Handle the built-in /space command and subcommands. */
	private async handleSpaceCommand(args: string, ctx: MessageContext): Promise<void> {
		if (!this.spaceService) {
			await this.trySend(ctx.userId, 'Spaces are not configured.');
			return;
		}

		const parts = args.trim().split(/\s+/);
		const subcommand = parts[0]?.toLowerCase() ?? '';

		switch (subcommand) {
			case '':
				await this.handleSpaceStatus(ctx);
				break;
			case 'off':
				await this.handleSpaceOff(ctx);
				break;
			case 'create':
				await this.handleSpaceCreate(parts.slice(1), ctx);
				break;
			case 'delete':
				await this.handleSpaceDelete(parts[1], ctx);
				break;
			case 'invite':
				await this.handleSpaceInvite(parts[1], parts[2], ctx);
				break;
			case 'kick':
				await this.handleSpaceKick(parts[1], parts[2], ctx);
				break;
			case 'members':
				await this.handleSpaceMembers(parts[1], ctx);
				break;
			default:
				// Treat as space ID — enter space mode
				await this.handleSpaceEnter(subcommand, ctx);
				break;
		}
	}

	private async handleSpaceStatus(ctx: MessageContext): Promise<void> {
		const activeSpaceId = this.spaces.getActiveSpace(ctx.userId);
		const userSpaces = this.spaces.getSpacesForUser(ctx.userId);

		const lines: string[] = [];
		if (activeSpaceId) {
			const space = this.spaces.getSpace(activeSpaceId);
			lines.push(`Currently in: *${escapeMarkdown(space?.name ?? activeSpaceId)}*`);
		} else {
			lines.push('Currently in: *Personal mode*');
		}

		lines.push('');
		if (userSpaces.length === 0) {
			lines.push('You are not a member of any spaces.');
		} else {
			lines.push('*Your spaces:*');
			for (const space of userSpaces) {
				const marker = space.id === activeSpaceId ? ' (active)' : '';
				lines.push(`  ${escapeMarkdown(space.id)} — ${escapeMarkdown(space.name)}${marker}`);
			}
		}

		lines.push('');
		lines.push('Use `/space <id>` to enter a space, `/space off` to return to personal mode.');

		await this.trySend(ctx.userId, lines.join('\n'));
	}

	private async handleSpaceEnter(spaceId: string, ctx: MessageContext): Promise<void> {
		const errors = await this.spaces.setActiveSpace(ctx.userId, spaceId);
		if (errors.length > 0) {
			await this.trySend(ctx.userId, errors.map((e) => e.message).join('\n'));
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		await this.trySend(
			ctx.userId,
			`Entered space: *${escapeMarkdown(space?.name ?? spaceId)}*. Your messages now go to this shared space.`,
		);
	}

	private async handleSpaceOff(ctx: MessageContext): Promise<void> {
		await this.spaces.setActiveSpace(ctx.userId, null);
		await this.trySend(ctx.userId, 'Back to personal mode.');
	}

	private async handleSpaceCreate(parts: string[], ctx: MessageContext): Promise<void> {
		if (parts.length < 2) {
			await this.trySend(ctx.userId, 'Usage: `/space create <id> <name...>`');
			return;
		}

		const id = parts[0] as string;
		const name = parts.slice(1).join(' ');

		const errors = await this.spaces.saveSpace({
			id,
			name,
			description: '',
			members: [ctx.userId],
			createdBy: ctx.userId,
			createdAt: new Date().toISOString(),
			kind: 'household',
		});

		if (errors.length > 0) {
			await this.trySend(
				ctx.userId,
				errors.map((e) => `${escapeMarkdown(e.field)}: ${escapeMarkdown(e.message)}`).join('\n'),
			);
			return;
		}

		await this.trySend(
			ctx.userId,
			`Space *${escapeMarkdown(name)}* created. Use \`/space ${escapeMarkdown(id)}\` to enter it.`,
		);
	}

	private async handleSpaceDelete(spaceId: string | undefined, ctx: MessageContext): Promise<void> {
		if (!spaceId) {
			await this.trySend(ctx.userId, 'Usage: `/space delete <id>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found.');
			return;
		}

		// Only the creator can delete
		if (space.createdBy !== ctx.userId) {
			await this.trySend(ctx.userId, 'Only the space creator can delete it.');
			return;
		}

		const deleted = await this.spaces.deleteSpace(spaceId);
		if (deleted) {
			await this.trySend(
				ctx.userId,
				`Space *${escapeMarkdown(space.name)}* deleted. Data is preserved on disk.`,
			);
		} else {
			await this.trySend(ctx.userId, 'Failed to delete space.');
		}
	}

	private async handleSpaceInvite(
		spaceId: string | undefined,
		userName: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId || !userName) {
			await this.trySend(ctx.userId, 'Usage: `/space invite <space-id> <username>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found.');
			return;
		}

		// Authorization: caller must be a member of the space
		if (!space.members.includes(ctx.userId)) {
			await this.trySend(ctx.userId, 'You must be a member of this space to invite others.');
			return;
		}

		// Look up user by name
		const targetUser = this.userManager
			?.getAllUsers()
			.find((u) => u.name.toLowerCase() === userName.toLowerCase());
		if (!targetUser) {
			await this.trySend(
				ctx.userId,
				`User "${escapeMarkdown(userName)}" not found. Check the name and try again.`,
			);
			return;
		}

		const errors = await this.spaces.addMember(spaceId, targetUser.id);
		if (errors.length > 0) {
			await this.trySend(ctx.userId, errors.map((e) => escapeMarkdown(e.message)).join('\n'));
			return;
		}

		await this.trySend(
			ctx.userId,
			`${escapeMarkdown(targetUser.name)} added to *${escapeMarkdown(space.name)}*.`,
		);
	}

	private async handleSpaceKick(
		spaceId: string | undefined,
		userName: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId || !userName) {
			await this.trySend(ctx.userId, 'Usage: `/space kick <space-id> <username>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found.');
			return;
		}

		// Authorization: caller must be a member of the space
		if (!space.members.includes(ctx.userId)) {
			await this.trySend(ctx.userId, 'You must be a member of this space to remove others.');
			return;
		}

		const targetUser = this.userManager
			?.getAllUsers()
			.find((u) => u.name.toLowerCase() === userName.toLowerCase());
		if (!targetUser) {
			await this.trySend(ctx.userId, `User "${escapeMarkdown(userName)}" not found.`);
			return;
		}

		const errors = await this.spaces.removeMember(spaceId, targetUser.id);
		if (errors.length > 0) {
			await this.trySend(ctx.userId, errors.map((e) => escapeMarkdown(e.message)).join('\n'));
			return;
		}

		await this.trySend(
			ctx.userId,
			`${escapeMarkdown(targetUser.name)} removed from *${escapeMarkdown(space.name)}*.`,
		);
	}

	private async handleSpaceMembers(
		spaceId: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId) {
			await this.trySend(ctx.userId, 'Usage: `/space members <space-id>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found.');
			return;
		}

		const lines: string[] = [`*Members of ${escapeMarkdown(space.name)}:*`];
		for (const memberId of space.members) {
			const user = this.userManager?.getUser(memberId);
			const name = user ? escapeMarkdown(user.name) : memberId;
			const creator = memberId === space.createdBy ? ' (creator)' : '';
			lines.push(`  ${name}${creator}`);
		}

		await this.trySend(ctx.userId, lines.join('\n'));
	}

	/** Handle the built-in /invite command. */
	private async handleInviteCommand(args: string, ctx: MessageContext): Promise<void> {
		if (!this.inviteService) {
			await this.trySend(ctx.userId, 'Invite system is not configured.');
			return;
		}

		const user = this.findUser(ctx.userId);
		if (!user?.isAdmin) {
			await this.trySend(ctx.userId, 'Only admins can create invites.');
			return;
		}

		const name = args.trim();
		if (!name) {
			await this.trySend(ctx.userId, 'Usage: `/invite <name>`');
			return;
		}

		const householdId = this.householdService?.getHouseholdForUser(ctx.userId) ?? 'default';
		const code = await this.inviteService.createInvite(name, ctx.userId, {
			householdId,
			role: 'member',
			initialSpaces: [],
		});
		await this.trySend(
			ctx.userId,
			`Invite code for *${escapeMarkdown(name)}*: \`${code}\`\n\nShare this code. They should send \`/start ${code}\` to the bot. Expires in 24 hours.`,
		);
	}

	/** Handle invite code redemption for unregistered users via /start <code>. */
	private async handleInviteRedemption(code: string, userId: string): Promise<void> {
		if (!this.inviteService || !this.userMutationService) return;

		const outcome = await redeemInviteAndRegister(
			{
				inviteService: this.inviteService,
				userMutationService: this.userMutationService,
				telegram: this.telegram,
				logger: this.logger,
				dataDir: this.config.dataDir,
			},
			code,
			userId,
		);

		if (!outcome.success) {
			await this.trySend(userId, outcome.error);
		}
	}

	/** Find a registered user by Telegram user ID. */
	private findUser(userId: string) {
		return (
			this.config.users.find((u) => u.id === userId) ?? this.userManager?.getUser(userId) ?? null
		);
	}

	/** Check if an app is enabled for a user, considering toggle overrides. */
	private async isAppEnabled(
		userId: string,
		appId: string,
		enabledApps: string[],
	): Promise<boolean> {
		if (this.appToggle) {
			return this.appToggle.isEnabled(userId, appId, enabledApps);
		}
		return enabledApps.includes('*') || enabledApps.includes(appId);
	}

	/**
	 * Resolve the effective list of enabled app IDs for a user, accounting for
	 * appToggle overrides on top of the raw enabledApps config value.
	 *
	 * If enabledApps is ['*'], starts from all registered app IDs and removes
	 * any explicitly toggled off. Otherwise filters the explicit list.
	 */
	private async resolveEnabledApps(userId: string, enabledApps: string[]): Promise<string[]> {
		if (!this.appToggle) return enabledApps;
		const overrides = await this.appToggle.getOverrides(userId);
		if (Object.keys(overrides).length === 0) return enabledApps;

		if (enabledApps.includes('*')) {
			// All apps enabled by default — exclude explicitly toggled-off apps
			const allAppIds = this.registry.getAll().map((a) => a.manifest.app.id);
			return allAppIds.filter((id) => overrides[id] !== false);
		}

		// Explicit list — exclude overridden-off entries
		return enabledApps.filter((id) => overrides[id] !== false);
	}

	/**
	 * Context-aware promotion: try to elevate a below-threshold classification to the
	 * verifier when recent interaction context matches the low-confidence result.
	 *
	 * Safety invariant: low-confidence results NEVER direct-route. They can only proceed
	 * through the verifier. If the verifier is absent, context is empty, or the appIds
	 * don't match, we fall through to chatbot.
	 *
	 * Called only when classify() returned null AND both interactionContext AND routeVerifier
	 * are configured.
	 */
	private async tryContextPromotion(ctx: MessageContext, enabledApps: string[]): Promise<void> {
		// Guard: both services must be present (caller ensures this, but be explicit)
		if (!this.interactionContext || !this.routeVerifier) {
			await this.sendToFallback(ctx, enabledApps);
			return;
		}

		try {
			// Get recent interaction context for this user
			const recentEntries = this.interactionContext.getRecent(ctx.userId);
			if (recentEntries.length === 0) {
				await this.sendToFallback(ctx, enabledApps);
				return;
			}

			// Get low-confidence result (no threshold gate)
			const lowMatch = await this.intentClassifier.classifyWithLowConfidence(
				ctx.text,
				this.intentTable,
			);
			if (!lowMatch) {
				await this.sendToFallback(ctx, enabledApps);
				return;
			}

			// Check if any recent context entry matches the low-confidence appId
			const contextMatch = recentEntries.some((e) => e.appId === lowMatch.appId);
			if (!contextMatch) {
				await this.sendToFallback(ctx, enabledApps);
				return;
			}

			// Build a human-readable recent interactions string for the verifier prompt.
			// Strip newlines and control characters from app-supplied fields to prevent
			// prompt injection via entityType or other user-controlled values.
			const sanitizeEntryField = (v: string): string => {
				// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char sanitization
				return v.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
			};
			const recentInteractions = recentEntries
				.map(
					(e) =>
						`app=${sanitizeEntryField(e.appId)} action=${sanitizeEntryField(e.action)}${e.entityType ? ` entity=${sanitizeEntryField(e.entityType)}` : ''}`,
				)
				.join('; ');

			// Resolve effective app list
			const resolvedApps = await this.resolveEnabledApps(ctx.userId, enabledApps);

			// Enter verifier flow with the low-confidence result.
			// strict=true: LLM failure inside the verifier returns { action: 'fallback' }
			// instead of { action: 'route' }, preventing silent dispatch of sub-threshold messages.
			const result = await this.routeVerifier.verify(
				ctx,
				lowMatch,
				undefined,
				resolvedApps,
				recentInteractions,
				true, // strict mode — degraded verifier must not produce a route
			);

			if (result.action === 'held') {
				// Message is held waiting for user button press — just return
				return;
			}

			if (result.action === 'fallback') {
				// Verifier degraded (LLM failure / unparseable) in strict mode → chatbot
				await this.sendToFallback(ctx, enabledApps);
				return;
			}

			if (result.action === 'route' && result.appId === lowMatch.appId) {
				// Verifier confirmed the low-confidence appId — check access and dispatch
				if (!(await this.isAppEnabled(ctx.userId, result.appId, enabledApps))) {
					await this.trySend(ctx.userId, `You don't have access to the ${result.appId} app.`);
					return;
				}
				const app = this.registry.getApp(result.appId);
				if (app) {
					await this.dispatchMessage(app, ctx, routeFromVerifyAction(result, 'context-promotion'));
					return;
				}
			}

			// Verifier suggested a different app or returned an unexpected result → fall through
			await this.sendToFallback(ctx, enabledApps);
		} catch (error) {
			// Any exception → safe fallback (never crash)
			this.logger.warn({ error }, 'Context-aware promotion failed — falling back to chatbot');
			await this.sendToFallback(ctx, enabledApps);
		}
	}

	/**
	 * NL /newchat hook — detect session-control intent in free-text messages.
	 *
	 * Returns true if the message was intercepted (caller should return early).
	 * Returns false if the message should continue normal routing.
	 *
	 * High-confidence (>= 0.7) or prefilter match → immediately start new chat.
	 * Grey-zone (>= 0.4 && < 0.7) → store pending entry + send inline keyboard.
	 * Low confidence (< 0.4) or intent !== 'new_session' → no intercept.
	 */
	private async handleSessionControlHook(ctx: MessageContext): Promise<boolean> {
		if (!this.sessionControlClassifier || !this.pendingSessionControl) return false;

		const deps: SessionControlClassifierDeps = {
			llm: this.llm,
			logger: this.logger,
		};

		let result: SessionControlResult;
		try {
			result = await this.sessionControlClassifier(ctx.text, deps);
		} catch (err) {
			this.logger.warn({ err }, 'session-control classifier threw — skipping hook');
			return false;
		}

		if (result.intent !== 'new_session') return false;

		const isHighConfidence = result.confidence >= this.verificationUpperBound || result.source === 'prefilter';
		const isGreyZone = result.confidence >= this.confidenceThreshold && result.confidence < this.verificationUpperBound;

		if (isHighConfidence) {
			// Start new session immediately — handleNewChat confirms internally (Fix 5a)
			await this.dispatchConversationCommand('newchat', [], ctx);
			return true;
		}

		if (isGreyZone) {
			// Generate a nonce so stale inline-keyboard buttons cannot consume a newer entry.
			const entryId = randomBytes(4).toString('hex');
			const entry = createPendingEntry(ctx.userId, ctx.text, {
				clock: Date.now,
				id: entryId,
			});
			this.pendingSessionControl.attach(ctx.userId, entry);
			try {
				await this.telegram.sendWithButtons(
					ctx.userId,
					'Start a new chat session? Your current conversation will be cleared.',
					[
						[
							{ text: '✓ Yes, start fresh', callbackData: `${SC_YES}:${entryId}` },
							{ text: '✗ No, keep chatting', callbackData: `${SC_NO}:${entryId}` },
						],
					],
				);
			} catch (err) {
				this.logger.warn({ err }, 'session-control: sendWithButtons failed, falling back to normal routing');
				this.pendingSessionControl.remove(ctx.userId);
				return false;
			}
			return true;
		}

		// Low confidence — let message fall through to normal routing
		return false;
	}

	/**
	 * Send message to the configured fallback handler. Extracted to avoid code
	 * duplication between routeMessage and tryContextPromotion.
	 */
	private async sendToFallback(ctx: MessageContext, enabledApps: string[]): Promise<void> {
		if (!this.conversationService) {
			await this.fallback.handleUnrecognized(ctx, this.telegram);
			return;
		}
		if (!(await this.isAppEnabled(ctx.userId, 'chatbot', enabledApps))) {
			await this.fallback.handleUnrecognized(ctx, this.telegram);
			return;
		}
		await this.dispatchConversation(ctx, routeForFallback());
	}

	/** Try to send a message, logging errors but not throwing. */
	private async trySend(userId: string, message: string): Promise<void> {
		try {
			await this.telegram.send(userId, message);
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send message to user');
		}
	}
}
