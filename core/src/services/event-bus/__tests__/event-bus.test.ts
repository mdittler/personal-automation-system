import { describe, expect, it, vi } from 'vitest';
import { EventBusServiceImpl } from '../index.js';

describe('EventBusService', () => {
	it('emits events to subscribers', async () => {
		const bus = new EventBusServiceImpl();
		const handler = vi.fn();

		bus.on('test.event', handler);
		bus.emit('test.event', { data: 'hello' });

		// Emittery is async — give it a tick
		await new Promise((r) => setTimeout(r, 10));

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith({ data: 'hello' });
	});

	it('supports multiple subscribers on same event', async () => {
		const bus = new EventBusServiceImpl();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		bus.on('multi', handler1);
		bus.on('multi', handler2);
		bus.emit('multi', 'payload');

		await new Promise((r) => setTimeout(r, 10));

		expect(handler1).toHaveBeenCalledOnce();
		expect(handler2).toHaveBeenCalledOnce();
	});

	it('unsubscribes with off()', async () => {
		const bus = new EventBusServiceImpl();
		const handler = vi.fn();

		bus.on('event', handler);
		bus.off('event', handler);
		bus.emit('event', 'data');

		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});

	it('isolates subscriber failures (URS-EVT-003)', async () => {
		const bus = new EventBusServiceImpl();

		const failingHandler = vi.fn().mockRejectedValue(new Error('handler crash'));
		const goodHandler = vi.fn();

		bus.on('event', failingHandler);
		bus.on('event', goodHandler);
		bus.emit('event', 'data');

		await new Promise((r) => setTimeout(r, 10));

		// Both handlers were called — the failure didn't prevent the good one
		expect(failingHandler).toHaveBeenCalledOnce();
		expect(goodHandler).toHaveBeenCalledOnce();
	});

	it('does not emit to unrelated event subscribers', async () => {
		const bus = new EventBusServiceImpl();
		const handler = vi.fn();

		bus.on('event-a', handler);
		bus.emit('event-b', 'data');

		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});

	it('clearAll removes all listeners', async () => {
		const bus = new EventBusServiceImpl();
		const handler = vi.fn();

		bus.on('event', handler);
		bus.clearAll();
		bus.emit('event', 'data');

		await new Promise((r) => setTimeout(r, 10));

		expect(handler).not.toHaveBeenCalled();
	});

	it('handles async handlers', async () => {
		const bus = new EventBusServiceImpl();
		const results: string[] = [];

		const asyncHandler = async (payload: unknown): Promise<void> => {
			await new Promise((r) => setTimeout(r, 5));
			results.push(payload as string);
		};

		bus.on('async', asyncHandler);
		bus.emit('async', 'value');

		await new Promise((r) => setTimeout(r, 50));

		expect(results).toEqual(['value']);
	});

	it('same handler on two events: both receive events', async () => {
		const bus = new EventBusServiceImpl();
		// Documents the intended contract (may already pass, keep as regression)
		const calls: string[] = [];
		const handler = async (data: unknown) => { calls.push(data as string); };
		bus.on('event-a', handler);
		bus.on('event-b', handler);
		bus.emit('event-a', 'a-payload');
		bus.emit('event-b', 'b-payload');
		await new Promise(r => setTimeout(r, 50));
		expect(calls).toContain('a-payload');
		expect(calls).toContain('b-payload');
	});

	it('off(eventA) does not affect eventB subscription', async () => {
		const bus = new EventBusServiceImpl();
		const calls: string[] = [];
		const handler = async (data: unknown) => { calls.push(data as string); };
		bus.on('event-a', handler);
		bus.on('event-b', handler);
		bus.off('event-a', handler);
		bus.emit('event-a', 'a-payload');
		bus.emit('event-b', 'b-payload');
		await new Promise(r => setTimeout(r, 50));
		expect(calls).toEqual(['b-payload']);
	});

	it('off() both events removes handler from both', async () => {
		const bus = new EventBusServiceImpl();
		const calls: string[] = [];
		const handler = async (data: unknown) => { calls.push(data as string); };
		bus.on('event-a', handler);
		bus.on('event-b', handler);
		bus.off('event-a', handler);
		bus.off('event-b', handler);
		bus.emit('event-a', 'a-payload');
		bus.emit('event-b', 'b-payload');
		await new Promise(r => setTimeout(r, 50));
		expect(calls).toEqual([]);
	});

	it('off() for unregistered event is a no-op', async () => {
		const bus = new EventBusServiceImpl();
		const calls: string[] = [];
		const handler = async (data: unknown) => { calls.push(data as string); };
		bus.on('event-b', handler);
		bus.off('event-a', handler); // not registered on event-a
		bus.emit('event-b', 'b-payload');
		await new Promise(r => setTimeout(r, 50));
		expect(calls).toEqual(['b-payload']);
	});
});
