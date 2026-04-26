/**
 * Regression: chatbot.handleCommand command-name contract.
 *
 * The router strips the leading slash before dispatch (see
 * core/src/services/router/index.ts:511). The chatbot shim therefore
 * compares against `'edit'` and `'ask'` — not `'/edit'` / `'/ask'`.
 *
 * These tests pin that convention so a future regression to slash-prefixed
 * comparisons would be caught immediately.
 */
import type { CoreServices, EditService } from '@pas/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockCoreServices,
	createMockScopedStore,
} from '../../../../core/src/testing/mock-services.js';
import { createTestMessageContext } from '../../../../core/src/testing/test-helpers.js';
import * as chatbot from '../index.js';

function makeEditService(): EditService {
	return {
		proposeEdit: vi
			.fn()
			.mockResolvedValue({ kind: 'error', action: 'no_match', message: 'no match' }),
		confirmEdit: vi.fn().mockResolvedValue({ ok: true }),
	};
}

describe('handleCommand command-name contract (no leading slash)', () => {
	let services: CoreServices;

	beforeEach(async () => {
		services = createMockCoreServices();
		// Always make a writable store available
		vi.mocked(services.data.forUser).mockReturnValue(createMockScopedStore());
		vi.mocked(services.llm.complete).mockResolvedValue('Hi.');
		await chatbot.init(services);
	});

	it("routes to /ask handler when command is 'ask' (no slash)", async () => {
		const ctx = createTestMessageContext({ text: '/ask what is pas?' });
		await chatbot.handleCommand?.('ask', ['what', 'is', 'pas?'], ctx);
		// /ask with args calls the LLM (standard tier)
		expect(services.llm.complete).toHaveBeenCalled();
	});

	it("routes to /edit handler when command is 'edit' (no slash)", async () => {
		const editService = makeEditService();
		const editServices = createMockCoreServices();
		Object.assign(editServices, { editService });
		await chatbot.init(editServices);

		const ctx = createTestMessageContext({ text: '/edit fix something' });
		await chatbot.handleCommand?.('edit', ['fix', 'something'], ctx);

		expect(editService.proposeEdit).toHaveBeenCalledWith('fix something', expect.any(String));
	});

	it("does NOT route to /ask handler when command is '/ask' (legacy slash form)", async () => {
		const ctx = createTestMessageContext({ text: '/ask what is pas?' });
		await chatbot.handleCommand?.('/ask', ['what', 'is', 'pas?'], ctx);
		// Legacy slash form must be silently ignored — no LLM call, no telegram send
		expect(services.llm.complete).not.toHaveBeenCalled();
		expect(services.telegram.send).not.toHaveBeenCalled();
	});

	it("does NOT route to /edit handler when command is '/edit' (legacy slash form)", async () => {
		const editService = makeEditService();
		const editServices = createMockCoreServices();
		Object.assign(editServices, { editService });
		await chatbot.init(editServices);

		const ctx = createTestMessageContext({ text: '/edit something' });
		await chatbot.handleCommand?.('/edit', ['something'], ctx);

		// proposeEdit must not be called for the legacy slash form
		expect(editService.proposeEdit).not.toHaveBeenCalled();
	});
});
