import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RouteVerifier } from '../route-verifier.js';
import type { LLMService } from '../../../types/llm.js';
import type { TelegramService } from '../../../types/telegram.js';
import type { AppRegistry } from '../../app-registry/index.js';
import type { PendingVerificationStore } from '../pending-verification-store.js';
import type { VerificationLogger } from '../verification-logger.js';
import type { MessageContext, PhotoContext } from '../../../types/telegram.js';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockLLM(response: string): LLMService {
	return {
		complete: vi.fn().mockResolvedValue(response),
		classify: vi.fn(),
		extractStructured: vi.fn(),
		getModelForTier: vi.fn(),
	} as unknown as LLMService;
}

function createMockTelegram(): TelegramService {
	return {
		send: vi.fn(),
		sendPhoto: vi.fn(),
		sendOptions: vi.fn(),
		sendWithButtons: vi.fn().mockResolvedValue({ chatId: 1, messageId: 100 }),
		editMessage: vi.fn(),
	};
}

function createMockRegistry(): AppRegistry {
	return {
		getAll: vi.fn().mockReturnValue([
			{
				manifest: {
					app: { id: 'food', name: 'Food', description: 'Food management', version: '1.0.0', author: 'test' },
					capabilities: {
						messages: {
							intents: [
								'user wants to add items to the grocery list',
								'user wants to save a recipe',
							],
						},
					},
				},
				module: {},
				appDir: '/apps/food',
			},
			{
				manifest: {
					app: { id: 'notes', name: 'Notes', description: 'Note taking', version: '1.0.0', author: 'test' },
					capabilities: {
						messages: { intents: ['save a note', 'note this'] },
					},
				},
				module: {},
				appDir: '/apps/notes',
			},
		]),
		getApp: vi.fn(),
		getManifestCache: vi.fn(),
		getLoadedAppIds: vi.fn(),
	} as unknown as AppRegistry;
}

function createMockPendingStore(): PendingVerificationStore {
	const entries = new Map<string, ReturnType<PendingVerificationStore['resolve']>>();
	let counter = 0;

	return {
		add: vi.fn().mockImplementation((input) => {
			const id = `pending-${++counter}`;
			entries.set(id, { ...input, createdAt: new Date() });
			return id;
		}),
		get: vi.fn().mockImplementation((id: string) => entries.get(id)),
		resolve: vi.fn().mockImplementation((id: string) => {
			const entry = entries.get(id);
			entries.delete(id);
			return entry;
		}),
		size: 0,
	} as unknown as PendingVerificationStore;
}

function createMockVerificationLogger(): VerificationLogger {
	return {
		log: vi.fn().mockResolvedValue(undefined),
	} as unknown as VerificationLogger;
}

function createMockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

function createTextCtx(overrides: Partial<MessageContext> = {}): MessageContext {
	return {
		userId: 'user1',
		text: 'add milk to the grocery list',
		timestamp: new Date(),
		chatId: 42,
		messageId: 7,
		...overrides,
	};
}

function createPhotoCtx(overrides: Partial<PhotoContext> = {}): PhotoContext {
	return {
		userId: 'user1',
		photo: Buffer.from('fake'),
		caption: 'my recipe photo',
		mimeType: 'image/jpeg',
		timestamp: new Date(),
		chatId: 42,
		messageId: 8,
		...overrides,
	};
}

const classifierResult = { appId: 'food', intent: 'user wants to add items to the grocery list', confidence: 0.6 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RouteVerifier', () => {
	let telegram: TelegramService;
	let registry: AppRegistry;
	let pendingStore: PendingVerificationStore;
	let verificationLogger: VerificationLogger;
	let logger: Logger;

	beforeEach(() => {
		telegram = createMockTelegram();
		registry = createMockRegistry();
		pendingStore = createMockPendingStore();
		verificationLogger = createMockVerificationLogger();
		logger = createMockLogger();
	});

	function buildVerifier(llm: LLMService): RouteVerifier {
		return new RouteVerifier({ llm, telegram, registry, pendingStore, verificationLogger, logger });
	}

	// -------------------------------------------------------------------------
	// verify() — agrees
	// -------------------------------------------------------------------------

	it('returns route action when verifier agrees', async () => {
		const llm = createMockLLM('{"agrees": true}');
		const verifier = buildVerifier(llm);
		const ctx = createTextCtx();

		const result = await verifier.verify(ctx, classifierResult);

		expect(result).toEqual({ action: 'route', appId: 'food' });
	});

	it('does not send buttons when verifier agrees', async () => {
		const llm = createMockLLM('{"agrees": true}');
		const verifier = buildVerifier(llm);

		await verifier.verify(createTextCtx(), classifierResult);

		expect(telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// verify() — disagrees
	// -------------------------------------------------------------------------

	it('returns held action and sends buttons when verifier disagrees', async () => {
		const llm = createMockLLM(
			'{"agrees": false, "suggestedAppId": "notes", "suggestedIntent": "save a note", "reasoning": "looks like a note"}',
		);
		const verifier = buildVerifier(llm);
		const ctx = createTextCtx();

		const result = await verifier.verify(ctx, classifierResult);

		expect(result).toEqual({ action: 'held' });
		expect(telegram.sendWithButtons).toHaveBeenCalledOnce();
	});

	it('sends correct button labels when verifier disagrees', async () => {
		const llm = createMockLLM(
			'{"agrees": false, "suggestedAppId": "notes", "suggestedIntent": "save a note"}',
		);
		const verifier = buildVerifier(llm);

		await verifier.verify(createTextCtx(), classifierResult);

		const [, , buttons] = (telegram.sendWithButtons as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			string,
			{ text: string; callbackData: string }[][],
		];
		const row = buttons[0]!;
		expect(row[0]!.text).toBe('Food');
		expect(row[1]!.text).toBe('Notes');
		expect(row[2]!.text).toBe('Chatbot');
	});

	it('stores pending entry when message is held', async () => {
		const llm = createMockLLM(
			'{"agrees": false, "suggestedAppId": "notes"}',
		);
		const verifier = buildVerifier(llm);

		await verifier.verify(createTextCtx(), classifierResult);

		// pendingStore.add should have been called once
		expect(pendingStore.add).toHaveBeenCalledOnce();

		// The callback data in the buttons should contain the pendingId from add()
		const [, , buttons] = (telegram.sendWithButtons as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			string,
			{ text: string; callbackData: string }[][],
		];
		const row = buttons[0]!;
		// All three callback data strings should start with 'rv:<pendingId>:'
		for (const btn of row) {
			expect(btn.callbackData).toMatch(/^rv:pending-\d+:/);
		}
		// Each button should have a different app ID suffix
		expect(row[0]!.callbackData).toMatch(/:food$/);
		expect(row[1]!.callbackData).toMatch(/:notes$/);
		expect(row[2]!.callbackData).toMatch(/:chatbot$/);
	});

	it('uses standard tier for the verification LLM call', async () => {
		const llm = createMockLLM('{"agrees": true}');
		const verifier = buildVerifier(llm);

		await verifier.verify(createTextCtx(), classifierResult);

		expect(llm.complete).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ tier: 'standard' }),
		);
	});

	// -------------------------------------------------------------------------
	// verify() — graceful degradation
	// -------------------------------------------------------------------------

	it('degrades gracefully when LLM call fails', async () => {
		const llm: LLMService = {
			complete: vi.fn().mockRejectedValue(new Error('network error')),
			classify: vi.fn(),
			extractStructured: vi.fn(),
			getModelForTier: vi.fn(),
		} as unknown as LLMService;
		const verifier = buildVerifier(llm);

		const result = await verifier.verify(createTextCtx(), classifierResult);

		expect(result).toEqual({ action: 'route', appId: 'food' });
		expect(telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('degrades gracefully when LLM returns unparseable response', async () => {
		const llm = createMockLLM('this is not json at all!!!');
		const verifier = buildVerifier(llm);

		const result = await verifier.verify(createTextCtx(), classifierResult);

		expect(result).toEqual({ action: 'route', appId: 'food' });
		expect(telegram.sendWithButtons).not.toHaveBeenCalled();
	});

	it('degrades gracefully when LLM response is valid JSON but missing agrees field', async () => {
		const llm = createMockLLM('{"something": "else"}');
		const verifier = buildVerifier(llm);

		const result = await verifier.verify(createTextCtx(), classifierResult);

		expect(result).toEqual({ action: 'route', appId: 'food' });
	});

	// -------------------------------------------------------------------------
	// verify() — photo context
	// -------------------------------------------------------------------------

	it('handles photo context correctly — uses caption as message text', async () => {
		const llm = createMockLLM('{"agrees": true}');
		const verifier = buildVerifier(llm);
		const ctx = createPhotoCtx({ caption: 'recipe photo caption' });

		const result = await verifier.verify(ctx, classifierResult);

		expect(result).toEqual({ action: 'route', appId: 'food' });
		// The prompt passed to LLM should contain the caption text
		const promptArg = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
		expect(promptArg).toContain('recipe photo caption');
	});

	// -------------------------------------------------------------------------
	// resolveCallback()
	// -------------------------------------------------------------------------

	it('resolveCallback resolves pending entry and edits message', async () => {
		const llm = createMockLLM('{"agrees": false, "suggestedAppId": "notes"}');
		const verifier = buildVerifier(llm);

		// Trigger a held message to store a pending entry
		await verifier.verify(createTextCtx(), classifierResult);

		// Get the pendingId from the add() call
		const pendingId = (pendingStore.add as ReturnType<typeof vi.fn>).mock.results[0]!.value as string;

		const result = await verifier.resolveCallback(pendingId, 'notes');

		expect(result).toBeDefined();
		expect(result!.chosenAppId).toBe('notes');
		expect(result!.entry).toBeDefined();
		expect(result!.entry.classifierResult.appId).toBe('food');

		// Should edit the button message
		expect(telegram.editMessage).toHaveBeenCalledOnce();
		const [chatId, messageId, text] = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls[0] as [
			number,
			number,
			string,
		];
		expect(chatId).toBe(1); // from sendWithButtons mock return value
		expect(messageId).toBe(100);
		expect(text).toContain('Notes'); // app name in confirmation
	});

	// -------------------------------------------------------------------------
	// photo saving
	// -------------------------------------------------------------------------

	describe('photo saving', () => {
		let photoTmpDir: string;

		beforeEach(async () => {
			photoTmpDir = await mkdtemp(`${tmpdir()}/route-verifier-photo-`);
		});

		afterEach(() => {
			rmSync(photoTmpDir, { recursive: true, force: true });
		});

		it('saves photo to photoDir when verifier disagrees and message is held', async () => {
			const llm = createMockLLM(
				'{"agrees": false, "suggestedAppId": "notes"}',
			);
			const verifier = new RouteVerifier({
				llm,
				telegram,
				registry,
				pendingStore,
				verificationLogger,
				logger,
				photoDir: photoTmpDir,
			});

			const ctx: PhotoContext = {
				userId: '123',
				photo: Buffer.from('fake-jpeg-data'),
				caption: 'save this for later',
				mimeType: 'image/jpeg',
				timestamp: new Date(),
				chatId: 1,
				messageId: 1,
			};

			const result = await verifier.verify(ctx, classifierResult);

			expect(result).toEqual({ action: 'held' });

			// A file should have been written to photoTmpDir
			const files = readdirSync(photoTmpDir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^.*-123\.jpeg$/);
			expect(existsSync(`${photoTmpDir}/${files[0]!}`)).toBe(true);
		});

		it('saves photo to photoDir when verifier agrees', async () => {
			const llm = createMockLLM('{"agrees": true}');
			const verifier = new RouteVerifier({
				llm,
				telegram,
				registry,
				pendingStore,
				verificationLogger,
				logger,
				photoDir: photoTmpDir,
			});

			const ctx: PhotoContext = {
				userId: '456',
				photo: Buffer.from('fake-jpeg-data'),
				caption: 'agreed photo',
				mimeType: 'image/jpeg',
				timestamp: new Date(),
				chatId: 1,
				messageId: 2,
			};

			await verifier.verify(ctx, classifierResult);

			const files = readdirSync(photoTmpDir);
			expect(files).toHaveLength(1);
			expect(files[0]).toMatch(/^.*-456\.jpeg$/);
		});

		it('does not save photo when photoDir is not configured', async () => {
			const llm = createMockLLM('{"agrees": false, "suggestedAppId": "notes"}');
			// buildVerifier does not pass photoDir
			const verifier = buildVerifier(llm);

			const ctx: PhotoContext = {
				userId: '123',
				photo: Buffer.from('fake-jpeg-data'),
				caption: 'no save',
				mimeType: 'image/jpeg',
				timestamp: new Date(),
				chatId: 1,
				messageId: 3,
			};

			// Should not throw, photo path in log should be undefined
			const result = await verifier.verify(ctx, classifierResult);
			expect(result).toEqual({ action: 'held' });

			// pendingStore.add should have been called with photoPath undefined
			const addArg = (pendingStore.add as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
			expect(addArg['photoPath']).toBeUndefined();
		});

		it('includes saved photo path in the pending entry', async () => {
			const llm = createMockLLM('{"agrees": false, "suggestedAppId": "notes"}');
			const verifier = new RouteVerifier({
				llm,
				telegram,
				registry,
				pendingStore,
				verificationLogger,
				logger,
				photoDir: photoTmpDir,
			});

			const ctx: PhotoContext = {
				userId: '789',
				photo: Buffer.from('fake-jpeg-data'),
				caption: 'photo with path',
				mimeType: 'image/jpeg',
				timestamp: new Date(),
				chatId: 1,
				messageId: 4,
			};

			await verifier.verify(ctx, classifierResult);

			const addArg = (pendingStore.add as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
			expect(typeof addArg['photoPath']).toBe('string');
			expect(addArg['photoPath']).toMatch(/^route-verification\/photos\/.*-789\.jpeg$/);
		});
	});

	it('resolveCallback returns undefined for unknown pending ID', async () => {
		const llm = createMockLLM('{"agrees": true}');
		const verifier = buildVerifier(llm);

		const result = await verifier.resolveCallback('nonexistent-id', 'food');

		expect(result).toBeUndefined();
		expect(logger.warn).toHaveBeenCalled();
	});

	it('resolveCallback logs the user override to verificationLogger', async () => {
		const llm = createMockLLM('{"agrees": false, "suggestedAppId": "notes"}');
		const verifier = buildVerifier(llm);

		await verifier.verify(createTextCtx(), classifierResult);
		const pendingId = (pendingStore.add as ReturnType<typeof vi.fn>).mock.results[0]!.value as string;

		// Clear calls from verify() itself
		(verificationLogger.log as ReturnType<typeof vi.fn>).mockClear();

		await verifier.resolveCallback(pendingId, 'notes');

		// Allow the fire-and-forget log promise to resolve
		await new Promise((r) => setTimeout(r, 0));

		expect(verificationLogger.log).toHaveBeenCalledOnce();
		const logArg = (verificationLogger.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
		expect(logArg['outcome']).toBe('user override');
		expect(logArg['userChoice']).toBe('notes');
		expect(logArg['routedTo']).toBe('notes');
	});
});
