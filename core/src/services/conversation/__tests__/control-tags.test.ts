import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockCoreServices } from '../../../testing/mock-services.js';
import {
	SWITCH_MODEL_TAG_REGEX,
	processModelSwitchTags,
} from '../control-tags.js';

const TAG = '<switch-model tier="fast" provider="anthropic" model="claude-haiku-4-5-20251001"/>';
const INTENT_MSG = 'please switch the fast model to claude-haiku';

describe('processModelSwitchTags', () => {
	it('returns response unchanged when no switch-model tags present', async () => {
		const result = await processModelSwitchTags('Hello world', {
			deps: {},
		});
		expect(result.cleanedResponse).toBe('Hello world');
		expect(result.confirmations).toHaveLength(0);
	});

	it('collapses excess blank lines even when no tags present', async () => {
		const result = await processModelSwitchTags('Line 1\n\n\n\nLine 2', { deps: {} });
		expect(result.cleanedResponse).toBe('Line 1\n\nLine 2');
	});

	it('strips tags silently when systemInfo is not provided', async () => {
		const result = await processModelSwitchTags(`Text ${TAG}`, {
			userId: 'user-0',
			userMessage: INTENT_MSG,
			deps: {},
		});
		expect(result.cleanedResponse).not.toContain('<switch-model');
		expect(result.confirmations).toHaveLength(0);
	});

	it('strips tags silently when userId is missing', async () => {
		const services = createMockCoreServices();
		const result = await processModelSwitchTags(`Text ${TAG}`, {
			userMessage: INTENT_MSG,
			deps: { systemInfo: services.systemInfo },
		});
		expect(result.cleanedResponse).not.toContain('<switch-model');
		expect(result.confirmations).toHaveLength(0);
	});

	it('strips tags silently when user is not admin', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(false);
		const result = await processModelSwitchTags(`Text ${TAG}`, {
			userId: 'user-0',
			userMessage: INTENT_MSG,
			deps: { systemInfo: services.systemInfo },
		});
		expect(result.cleanedResponse).not.toContain('<switch-model');
		expect(result.confirmations).toHaveLength(0);
	});

	it('strips tags silently when user message lacks model-switch intent', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		const result = await processModelSwitchTags(`Text ${TAG}`, {
			userId: 'admin',
			userMessage: 'what is the weather today?',
			deps: { systemInfo: services.systemInfo },
		});
		expect(result.cleanedResponse).not.toContain('<switch-model');
		expect(result.confirmations).toHaveLength(0);
	});

	it('processes tag and returns success confirmation for admin with model-switch intent', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		vi.mocked(services.systemInfo!.setTierModel).mockResolvedValue({ success: true });
		const result = await processModelSwitchTags(`Response text\n${TAG}`, {
			userId: 'admin',
			userMessage: INTENT_MSG,
			deps: { systemInfo: services.systemInfo },
		});
		expect(result.cleanedResponse).not.toContain('<switch-model');
		expect(result.confirmations).toHaveLength(1);
		expect(result.confirmations[0]).toContain('✅');
		expect(result.confirmations[0]).toContain('fast');
	});

	it('returns failure confirmation when setTierModel fails', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		vi.mocked(services.systemInfo!.setTierModel).mockResolvedValue({
			success: false,
			error: 'unknown model',
		});
		const result = await processModelSwitchTags(`Response\n${TAG}`, {
			userId: 'admin',
			userMessage: INTENT_MSG,
			deps: { systemInfo: services.systemInfo },
		});
		expect(result.confirmations).toHaveLength(1);
		expect(result.confirmations[0]).toContain('❌');
		expect(result.confirmations[0]).toContain('unknown model');
	});
});

describe('SWITCH_MODEL_TAG_REGEX', () => {
	it('matches a well-formed switch-model tag', () => {
		SWITCH_MODEL_TAG_REGEX.lastIndex = 0;
		expect(SWITCH_MODEL_TAG_REGEX.test(TAG)).toBe(true);
	});
});

describe('processModelSwitchTags — multiple tags', () => {
	it('handles multiple switch tags', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		vi.mocked(services.systemInfo!.setTierModel).mockResolvedValue({ success: true });

		const response =
			'Done. <switch-model tier="fast" provider="anthropic" model="model-a"/> ' +
			'<switch-model tier="standard" provider="anthropic" model="model-b"/>';
		const result = await processModelSwitchTags(response, {
			userId: 'admin-user',
			userMessage: 'switch the fast and standard models',
			deps: { systemInfo: services.systemInfo },
		});

		expect(result.confirmations).toHaveLength(2);
		expect(services.systemInfo!.setTierModel).toHaveBeenCalledTimes(2);
	});
});

describe('processModelSwitchTags security', () => {
	it('validates parameters even when LLM echoes user switch-model tag', async () => {
		const services = createMockCoreServices();
		vi.mocked(services.systemInfo!.isUserAdmin).mockReturnValue(true);
		vi.mocked(services.systemInfo!.setTierModel).mockResolvedValue({
			success: false,
			error: 'Provider "evil" not found.',
		});

		const response =
			'Sure! <switch-model tier="fast" provider="evil" model="malicious-model"/>';
		const result = await processModelSwitchTags(response, {
			userId: 'admin-user',
			userMessage: 'switch to evil provider model',
			deps: { systemInfo: services.systemInfo },
		});

		expect(result.confirmations).toHaveLength(1);
		expect(result.confirmations[0]).toContain('Failed');
		expect(result.confirmations[0]).toContain('not found');
	});
});
