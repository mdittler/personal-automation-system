/**
 * Tests for TTS/hands-free mode in the cook-mode handler.
 *
 * Covers the hands-free prompt flow, ck:hf:y / ck:hf:n callbacks,
 * TTS on step navigation, device config, and failure resilience.
 */

import { createMockCoreServices, createMockScopedStore } from '@pas/core/testing';
import type { CoreServices, MessageContext, ScopedDataStore } from '@pas/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import {
	handleCookCallback,
	handleCookCommand,
	handleCookTextAction,
	handleServingsReply,
} from '../handlers/cook-mode.js';
import { endSession, getSession, hasActiveSession } from '../services/cook-session.js';
import type { Household, Recipe } from '../types.js';

// ─── Factory helpers ────────────────────────────────────────────────

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
	return {
		id: 'rec-pasta-001',
		title: 'Pasta Carbonara',
		source: 'homemade',
		ingredients: [
			{ name: 'spaghetti', quantity: 1, unit: 'lb' },
			{ name: 'bacon', quantity: 8, unit: 'oz' },
			{ name: 'eggs', quantity: 3, unit: null },
			{ name: 'parmesan', quantity: 1, unit: 'cup' },
		],
		instructions: [
			'Cook spaghetti according to package directions.',
			'Fry bacon until crispy. Reserve fat.',
			'Mix eggs and parmesan in a bowl.',
			'Toss hot pasta with bacon, then egg mixture.',
		],
		servings: 4,
		tags: ['italian', 'pasta'],
		ratings: [],
		history: [],
		allergens: ['eggs', 'dairy'],
		status: 'confirmed',
		createdAt: '2026-03-31',
		updatedAt: '2026-03-31',
		...overrides,
	};
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
	return {
		id: 'household-001',
		name: 'Test Family',
		createdBy: 'user1',
		members: ['user1'],
		joinCode: 'ABC123',
		createdAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function makeCtx(overrides: Partial<MessageContext> = {}): MessageContext {
	return {
		userId: 'user1',
		chatId: 100,
		text: '',
		...overrides,
	};
}

function setupStoreWithRecipe(
	services: CoreServices,
	recipe: Recipe = makeRecipe(),
	household: Household = makeHousehold(),
): ScopedDataStore {
	const sharedStore = createMockScopedStore({
		read: vi.fn().mockImplementation(async (path: string) => {
			if (path === 'household.yaml') return stringify(household);
			if (path.startsWith('recipes/') && path.endsWith('.yaml')) return stringify(recipe);
			return '';
		}),
		list: vi.fn().mockResolvedValue([`recipes/${recipe.id}.yaml`]),
		exists: vi.fn().mockResolvedValue(true),
	});
	vi.mocked(services.data.forShared).mockReturnValue(sharedStore);
	return sharedStore;
}

afterEach(() => {
	for (const userId of ['user1', 'user2']) {
		if (hasActiveSession(userId)) {
			endSession(userId);
		}
	}
});

// ─── Hands-free prompt ──────────────────────────────────────────────

describe('hands-free prompt', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		// hands_free_default returns false by default
		vi.mocked(services.config.get).mockResolvedValue(false);
	});

	it('shows hands-free prompt after ingredients when audio is available', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('hands-free'),
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ callbackData: 'app:food:ck:hf:y' }),
					expect.objectContaining({ callbackData: 'app:food:ck:hf:n' }),
				]),
			]),
		);
	});

	it('skips prompt and auto-enables TTS when hands_free_default is true', async () => {
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'hands_free_default') return true;
			return undefined;
		});
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		// Should skip hands-free prompt and send first step directly
		const calls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		const promptCall = calls.find(
			([, msg]) => typeof msg === 'string' && msg.includes('hands-free'),
		);
		expect(promptCall).toBeUndefined();

		// Should have sent the first step
		const stepCall = calls.find(
			([, msg]) => typeof msg === 'string' && msg.includes('Step 1'),
		);
		expect(stepCall).toBeDefined();

		// Session TTS should be enabled
		const session = getSession('user1');
		expect(session?.ttsEnabled).toBe(true);
	});

	it('skips prompt and sends first step when audio service is unavailable', async () => {
		(services as any).audio = undefined;
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		// Should not show hands-free prompt
		const calls = vi.mocked(services.telegram.sendWithButtons).mock.calls;
		const promptCall = calls.find(
			([, msg]) => typeof msg === 'string' && msg.includes('hands-free'),
		);
		expect(promptCall).toBeUndefined();

		// Should have sent the first step directly
		const stepCall = calls.find(
			([, msg]) => typeof msg === 'string' && msg.includes('Step 1'),
		);
		expect(stepCall).toBeDefined();
	});
});

// ─── ck:hf:y and ck:hf:n callbacks ────────────────────────────────

describe('ck:hf:y — enable hands-free', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockResolvedValue(false);
	});

	it('enables TTS, edits message with confirmation, and sends first step', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		vi.mocked(services.telegram.sendWithButtons).mockClear();
		vi.mocked(services.telegram.editMessage).mockClear();

		await handleCookCallback(services, 'hf:y', 'user1', 100, 999);

		// Should edit the prompt message
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			999,
			expect.stringContaining('Hands-free mode enabled'),
			expect.any(Array),
		);

		// Should send first step
		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Step 1'),
			expect.any(Array),
		);

		// Should call audio.speak for first step
		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Cook spaghetti'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);

		// Session TTS enabled
		const session = getSession('user1');
		expect(session?.ttsEnabled).toBe(true);
	});

	it('sends no-session error when hf:y called with no active session', async () => {
		await handleCookCallback(services, 'hf:y', 'user1', 100, 999);

		expect(services.telegram.send).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('No active'),
		);
	});
});

describe('ck:hf:n — disable hands-free', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockResolvedValue(false);
	});

	it('disables TTS, edits message, and sends first step without audio', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		vi.mocked(services.telegram.sendWithButtons).mockClear();
		vi.mocked(services.telegram.editMessage).mockClear();
		vi.mocked(services.audio.speak).mockClear();

		await handleCookCallback(services, 'hf:n', 'user1', 100, 999);

		// Should edit message
		expect(services.telegram.editMessage).toHaveBeenCalledWith(
			100,
			999,
			expect.stringContaining('Text-only'),
			expect.any(Array),
		);

		// Should send first step
		expect(services.telegram.sendWithButtons).toHaveBeenCalledWith(
			'user1',
			expect.stringContaining('Step 1'),
			expect.any(Array),
		);

		// Should NOT call audio.speak (TTS disabled)
		expect(services.audio.speak).not.toHaveBeenCalled();

		const session = getSession('user1');
		expect(session?.ttsEnabled).toBe(false);
	});
});

// ─── Device config ──────────────────────────────────────────────────

describe('device config', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'hands_free_default') return true;
			if (key === 'cooking_speaker_device') return 'Kitchen Speaker';
			return undefined;
		});
	});

	it('passes configured device name to audio.speak', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.any(String),
			'Kitchen Speaker',
		);
	});
});

// ─── TTS failure resilience ─────────────────────────────────────────

describe('TTS failure resilience', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		vi.mocked(services.config.get).mockImplementation(async (key: string) => {
			if (key === 'hands_free_default') return true;
			return undefined;
		});
		vi.mocked(services.audio.speak).mockRejectedValue(new Error('speaker not found'));
	});

	it('still shows first step even when audio.speak rejects', async () => {
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);

		// Step should still have been sent despite TTS failure
		const stepCall = vi.mocked(services.telegram.sendWithButtons).mock.calls.find(
			([, msg]) => typeof msg === 'string' && msg.includes('Step 1'),
		);
		expect(stepCall).toBeDefined();
	});
});

// ─── TTS on step navigation ─────────────────────────────────────────

describe('TTS on step navigation', () => {
	let services: CoreServices;

	beforeEach(() => {
		services = createMockCoreServices();
		// No hands_free_default — we'll manually enable TTS on the session
		vi.mocked(services.config.get).mockResolvedValue(undefined);
	});

	async function startWithTts(): Promise<void> {
		// Use no-audio path to start, then manually enable TTS
		(services as any).audio = undefined;
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		await handleServingsReply(services, '4', ctx);
		// Restore audio and enable TTS
		(services as any).audio = { speak: vi.fn().mockResolvedValue(undefined) };
		const session = getSession('user1');
		if (session) session.ttsEnabled = true;
	}

	it('calls audio.speak when navigating to next step via callback', async () => {
		await startWithTts();
		vi.mocked(services.audio.speak).mockClear();

		await handleCookCallback(services, 'n', 'user1', 100, 456);

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Fry bacon'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('calls audio.speak when going back via callback', async () => {
		await startWithTts();
		// Go forward first
		await handleCookCallback(services, 'n', 'user1', 100, 456);
		vi.mocked(services.audio.speak).mockClear();

		await handleCookCallback(services, 'b', 'user1', 100, 456);

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Cook spaghetti'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('calls audio.speak on repeat via callback', async () => {
		await startWithTts();
		vi.mocked(services.audio.speak).mockClear();

		await handleCookCallback(services, 'r', 'user1', 100, 456);

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Cook spaghetti'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('calls audio.speak when saying "next" as text', async () => {
		await startWithTts();
		vi.mocked(services.audio.speak).mockClear();

		await handleCookTextAction(services, 'next', makeCtx());

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Fry bacon'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('calls audio.speak when saying "back" as text', async () => {
		await startWithTts();
		await handleCookTextAction(services, 'next', makeCtx());
		vi.mocked(services.audio.speak).mockClear();

		await handleCookTextAction(services, 'back', makeCtx());

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Cook spaghetti'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('calls audio.speak when saying "repeat" as text', async () => {
		await startWithTts();
		vi.mocked(services.audio.speak).mockClear();

		await handleCookTextAction(services, 'repeat', makeCtx());

		expect(services.audio.speak).toHaveBeenCalledWith(
			expect.stringContaining('Cook spaghetti'),
			expect.toSatisfy((v: unknown) => v === undefined || typeof v === 'string'),
		);
	});

	it('does not call audio.speak when ttsEnabled is false', async () => {
		// Start with audio available but TTS disabled
		setupStoreWithRecipe(services);
		const ctx = makeCtx();
		await handleCookCommand(services, ['pasta', 'carbonara'], ctx);
		// hands_free_default is false (returns undefined → falsy), so we get the prompt
		// After prompt, hf:n disables TTS
		await handleServingsReply(services, '4', ctx);
		await handleCookCallback(services, 'hf:n', 'user1', 100, 999);

		vi.mocked(services.audio.speak).mockClear();

		await handleCookCallback(services, 'n', 'user1', 100, 456);

		expect(services.audio.speak).not.toHaveBeenCalled();
	});
});
