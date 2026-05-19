import { describe, expect, it, vi } from 'vitest';
import { LateBoundAppOutboundBridge } from '../index.js';

describe('LateBoundAppOutboundBridge', () => {
	it('no-ops silently when not yet bound', async () => {
		const proxy = new LateBoundAppOutboundBridge();
		await expect(
			proxy.recordOutboundMessage({
				userId: 'u1',
				appId: 'food',
				kind: 'x',
				body: 'y',
			}),
		).resolves.toBeUndefined();
	});

	it('forwards to bound impl after bind()', async () => {
		const proxy = new LateBoundAppOutboundBridge();
		const inner = { recordOutboundMessage: vi.fn().mockResolvedValue(undefined) };
		proxy.bind(inner);
		await proxy.recordOutboundMessage({
			userId: 'u1',
			appId: 'food',
			kind: 'x',
			body: 'y',
		});
		expect(inner.recordOutboundMessage).toHaveBeenCalledOnce();
	});

	it('bind() called twice throws (caught misuse)', () => {
		const proxy = new LateBoundAppOutboundBridge();
		proxy.bind({ recordOutboundMessage: vi.fn() });
		expect(() => proxy.bind({ recordOutboundMessage: vi.fn() })).toThrow(/already bound/);
	});
});
