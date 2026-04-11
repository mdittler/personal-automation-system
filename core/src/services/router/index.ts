/**
 * Message router: the central dispatcher for all incoming messages.
 *
 * Classifies messages and routes them to the correct app handler.
 * Priority order (URS-RT-002):
 *   1. Explicit /command → exact match against registered commands
 *   2. Photo messages → classify type, match photo_intents
 *   3. Free text → LLM classification against all apps' intents
 *   4. Fallback → chatbot (default) or daily notes (configurable)
 */

import type { Logger } from 'pino';
import type { SystemConfig } from '../../types/config.js';
import type { LLMService } from '../../types/llm.js';
import type { MessageContext, PhotoContext, TelegramService } from '../../types/telegram.js';
import type { AppRegistry, RegisteredApp } from '../app-registry/index.js';
import type { CommandMapEntry, IntentTableEntry } from '../app-registry/manifest-cache.js';
import type { AppToggleStore } from '../app-toggle/index.js';
import type { InviteService } from '../invite/index.js';
import type { SpaceService } from '../spaces/index.js';
import type { UserManager } from '../user-manager/index.js';
import type { UserMutationService } from '../user-manager/user-mutation-service.js';
import { lookupCommand, parseCommand } from './command-parser.js';
import type { FallbackHandler } from './fallback.js';
import { IntentClassifier } from './intent-classifier.js';
import { PhotoClassifier } from './photo-classifier.js';
import type { RouteVerifier } from './route-verifier.js';

/** Escape Telegram MarkdownV2 special characters in user-controlled text. */
function escapeMarkdown(text: string): string {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Default confidence threshold for intent classification. */
const DEFAULT_CONFIDENCE_THRESHOLD = 0.4;

export interface RouterOptions {
	registry: AppRegistry;
	llm: LLMService;
	telegram: TelegramService;
	fallback: FallbackHandler;
	config: SystemConfig;
	logger: Logger;
	confidenceThreshold?: number;
	appToggle?: AppToggleStore;
	/** The chatbot app to dispatch to in chatbot fallback mode. */
	chatbotApp?: RegisteredApp;
	/** Fallback mode: 'chatbot' dispatches to chatbot app, 'notes' uses FallbackHandler. Default: 'chatbot'. */
	fallbackMode?: 'chatbot' | 'notes';
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
	private readonly chatbotApp?: RegisteredApp;
	private readonly fallbackMode: 'chatbot' | 'notes';
	private readonly spaceService?: SpaceService;
	private readonly userManager?: UserManager;
	private readonly routeVerifier?: RouteVerifier;
	private readonly verificationUpperBound: number;
	private readonly inviteService?: InviteService;
	private readonly userMutationService?: UserMutationService;

	private commandMap = new Map<string, CommandMapEntry>();
	private intentTable: IntentTableEntry[] = [];
	private photoIntentTable: IntentTableEntry[] = [];

	constructor(options: RouterOptions) {
		this.registry = options.registry;
		this.telegram = options.telegram;
		this.fallback = options.fallback;
		this.config = options.config;
		this.logger = options.logger;
		this.confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
		this.appToggle = options.appToggle;
		this.chatbotApp = options.chatbotApp;
		this.fallbackMode = options.fallbackMode ?? 'chatbot';
		this.spaceService = options.spaceService;
		this.userManager = options.userManager;
		this.routeVerifier = options.routeVerifier;
		this.verificationUpperBound = options.verificationUpperBound ?? 0.7;
		this.inviteService = options.inviteService;
		this.userMutationService = options.userMutationService;

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
				const result = await this.routeVerifier.verify(enrichedCtx, match);
				if (result.action === 'held') return;
				// Verifier confirmed (possibly different app) — check access before dispatch
				const verifiedAppId = (result as { action: 'route'; appId: string }).appId;
				if (!(await this.isAppEnabled(enrichedCtx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(enrichedCtx.userId, `You don't have access to the ${verifiedAppId} app.`);
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp) {
					await this.dispatchMessage(verifiedApp, enrichedCtx);
					return;
				}
			}

			const app = this.registry.getApp(match.appId);
			if (app) {
				await this.dispatchMessage(app, enrichedCtx);
				return;
			}
		}

		// 4. Fallback → chatbot or daily notes
		if (this.fallbackMode === 'chatbot' && this.chatbotApp) {
			if (!(await this.isAppEnabled(enrichedCtx.userId, 'chatbot', user.enabledApps))) {
				await this.fallback.handleUnrecognized(enrichedCtx, this.telegram);
				return;
			}
			await this.dispatchMessage(this.chatbotApp, enrichedCtx);
		} else {
			await this.fallback.handleUnrecognized(enrichedCtx, this.telegram);
		}
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

		// 3. Classify photo
		const match = await this.photoClassifier.classify(
			ctx.caption,
			this.photoIntentTable,
			this.confidenceThreshold,
		);

		if (match) {
			if (!(await this.isAppEnabled(ctx.userId, match.appId, user.enabledApps))) {
				await this.trySend(ctx.userId, `You don't have access to the ${match.appId} app.`);
				return;
			}

			// Grey-zone verification for photo messages
			if (
				this.routeVerifier &&
				match.confidence >= this.confidenceThreshold &&
				match.confidence < this.verificationUpperBound
			) {
				const result = await this.routeVerifier.verify(ctx, {
					appId: match.appId,
					intent: match.photoType,
					confidence: match.confidence,
				});
				if (result.action === 'held') return;
				const verifiedAppId = (result as { action: 'route'; appId: string }).appId;
				if (!(await this.isAppEnabled(ctx.userId, verifiedAppId, user.enabledApps))) {
					await this.trySend(ctx.userId, `You don't have access to the ${verifiedAppId} app.`);
					return;
				}
				const verifiedApp = this.registry.getApp(verifiedAppId);
				if (verifiedApp?.module.handlePhoto) {
					await this.dispatchPhoto(verifiedApp, ctx);
					return;
				}
			}

			const app = this.registry.getApp(match.appId);
			if (app?.module.handlePhoto) {
				await this.dispatchPhoto(app, ctx);
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
				await this.trySend(ctx.userId, "You're already registered\\! Type /help to get started\\.");
				return;
			}
			await this.trySend(ctx.userId, 'Welcome to PAS! Type /help to see available commands.');
			return;
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

		if (app.module.handleCommand) {
			try {
				await app.module.handleCommand(result.command.name, result.parsedArgs, ctx);
			} catch (error) {
				this.logger.error(
					{ appId: result.appId, command: result.command.name, error },
					'App command handler failed',
				);
				await this.trySend(ctx.userId, 'Something went wrong processing your command.');
			}
		} else {
			// App has no handleCommand — fall through to handleMessage
			await this.dispatchMessage(app, ctx);
		}
	}

	/** Dispatch a message to an app's handleMessage, with error isolation. */
	private async dispatchMessage(app: RegisteredApp, ctx: MessageContext): Promise<void> {
		try {
			await app.module.handleMessage(ctx);
		} catch (error) {
			this.logger.error({ appId: app.manifest.app.id, error }, 'App message handler failed');
			await this.trySend(ctx.userId, 'Something went wrong. Please try again later.');
		}
	}

	/** Dispatch a photo to an app's handlePhoto, with error isolation. */
	private async dispatchPhoto(app: RegisteredApp, ctx: PhotoContext): Promise<void> {
		try {
			await app.module.handlePhoto?.(ctx);
		} catch (error) {
			this.logger.error({ appId: app.manifest.app.id, error }, 'App photo handler failed');
			await this.trySend(ctx.userId, 'Something went wrong processing your photo.');
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

		// Group commands by app
		const appCommands = new Map<string, Array<{ name: string; description: string }>>();

		for (const [, entry] of this.commandMap) {
			if (!(await this.isAppEnabled(userId, entry.appId, enabledApps))) continue;

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

		if (appCommands.size === 0) {
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
			lines.push('You are not a member of any spaces\\.');
		} else {
			lines.push('*Your spaces:*');
			for (const space of userSpaces) {
				const marker = space.id === activeSpaceId ? ' \\(active\\)' : '';
				lines.push(`  ${escapeMarkdown(space.id)} — ${escapeMarkdown(space.name)}${marker}`);
			}
		}

		lines.push('');
		lines.push('Use `/space <id>` to enter a space, `/space off` to return to personal mode\\.');

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
			`Entered space: *${escapeMarkdown(space?.name ?? spaceId)}*\\. Your messages now go to this shared space\\.`,
		);
	}

	private async handleSpaceOff(ctx: MessageContext): Promise<void> {
		await this.spaces.setActiveSpace(ctx.userId, null);
		await this.trySend(ctx.userId, 'Back to personal mode\\.');
	}

	private async handleSpaceCreate(parts: string[], ctx: MessageContext): Promise<void> {
		if (parts.length < 2) {
			await this.trySend(ctx.userId, 'Usage: `/space create <id> <name\\.\\.\\.>`');
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
			`Space *${escapeMarkdown(name)}* created\\. Use \`/space ${escapeMarkdown(id)}\` to enter it\\.`,
		);
	}

	private async handleSpaceDelete(spaceId: string | undefined, ctx: MessageContext): Promise<void> {
		if (!spaceId) {
			await this.trySend(ctx.userId, 'Usage: `/space delete <id>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found\\.');
			return;
		}

		// Only the creator can delete
		if (space.createdBy !== ctx.userId) {
			await this.trySend(ctx.userId, 'Only the space creator can delete it\\.');
			return;
		}

		const deleted = await this.spaces.deleteSpace(spaceId);
		if (deleted) {
			await this.trySend(
				ctx.userId,
				`Space *${escapeMarkdown(space.name)}* deleted\\. Data is preserved on disk\\.`,
			);
		} else {
			await this.trySend(ctx.userId, 'Failed to delete space\\.');
		}
	}

	private async handleSpaceInvite(
		spaceId: string | undefined,
		userName: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId || !userName) {
			await this.trySend(ctx.userId, 'Usage: `/space invite <space\\-id> <username>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found\\.');
			return;
		}

		// Authorization: caller must be a member of the space
		if (!space.members.includes(ctx.userId)) {
			await this.trySend(ctx.userId, 'You must be a member of this space to invite others\\.');
			return;
		}

		// Look up user by name
		const targetUser = this.userManager
			?.getAllUsers()
			.find((u) => u.name.toLowerCase() === userName.toLowerCase());
		if (!targetUser) {
			await this.trySend(
				ctx.userId,
				`User "${escapeMarkdown(userName)}" not found\\. Check the name and try again\\.`,
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
			`${escapeMarkdown(targetUser.name)} added to *${escapeMarkdown(space.name)}*\\.`,
		);
	}

	private async handleSpaceKick(
		spaceId: string | undefined,
		userName: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId || !userName) {
			await this.trySend(ctx.userId, 'Usage: `/space kick <space\\-id> <username>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found\\.');
			return;
		}

		// Authorization: caller must be a member of the space
		if (!space.members.includes(ctx.userId)) {
			await this.trySend(ctx.userId, 'You must be a member of this space to remove others\\.');
			return;
		}

		const targetUser = this.userManager
			?.getAllUsers()
			.find((u) => u.name.toLowerCase() === userName.toLowerCase());
		if (!targetUser) {
			await this.trySend(ctx.userId, `User "${escapeMarkdown(userName)}" not found\\.`);
			return;
		}

		const errors = await this.spaces.removeMember(spaceId, targetUser.id);
		if (errors.length > 0) {
			await this.trySend(ctx.userId, errors.map((e) => escapeMarkdown(e.message)).join('\n'));
			return;
		}

		await this.trySend(
			ctx.userId,
			`${escapeMarkdown(targetUser.name)} removed from *${escapeMarkdown(space.name)}*\\.`,
		);
	}

	private async handleSpaceMembers(
		spaceId: string | undefined,
		ctx: MessageContext,
	): Promise<void> {
		if (!spaceId) {
			await this.trySend(ctx.userId, 'Usage: `/space members <space\\-id>`');
			return;
		}

		const space = this.spaces.getSpace(spaceId);
		if (!space) {
			await this.trySend(ctx.userId, 'Space not found\\.');
			return;
		}

		const lines: string[] = [`*Members of ${escapeMarkdown(space.name)}:*`];
		for (const memberId of space.members) {
			const user = this.userManager?.getUser(memberId);
			const name = user ? escapeMarkdown(user.name) : memberId;
			const creator = memberId === space.createdBy ? ' \\(creator\\)' : '';
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

		const code = await this.inviteService.createInvite(name, ctx.userId);
		await this.trySend(
			ctx.userId,
			`Invite code for *${escapeMarkdown(name)}*: \`${code}\`\n\nShare this code\\. They should send \`/start ${code}\` to the bot\\. Expires in 24 hours\\.`,
		);
	}

	/** Handle invite code redemption for unregistered users via /start <code>. */
	private async handleInviteRedemption(code: string, userId: string): Promise<void> {
		if (!this.inviteService || !this.userMutationService) return;

		const result = await this.inviteService.validateCode(code);
		if ('error' in result) {
			await this.trySend(userId, result.error);
			return;
		}

		const newUser = {
			id: userId,
			name: result.invite.name,
			isAdmin: false,
			enabledApps: ['*'] as string[],
			sharedScopes: [] as string[],
		};

		await this.userMutationService.registerUser(newUser);
		await this.inviteService.redeemCode(code, userId);
		await this.trySend(
			userId,
			`Welcome to PAS, ${escapeMarkdown(result.invite.name)}\\! Type /help to see available commands\\.`,
		);
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

	/** Try to send a message, logging errors but not throwing. */
	private async trySend(userId: string, message: string): Promise<void> {
		try {
			await this.telegram.send(userId, message);
		} catch (error) {
			this.logger.error({ userId, error }, 'Failed to send message to user');
		}
	}
}
