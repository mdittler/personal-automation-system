/**
 * Event bus service.
 *
 * Wraps Emittery to provide typed async event emission.
 * Subscriber failures are isolated — they don't affect the emitter
 * or other subscribers (URS-EVT-003).
 *
 * All emitted events are logged for debugging (URS-EVT-004).
 * Event subscriptions are auto-wired from manifests at startup (URS-EVT-002).
 */

import Emittery from 'emittery';
import type { Logger } from 'pino';
import type { EventBusService, EventHandler } from '../../types/events.js';

export class EventBusServiceImpl implements EventBusService {
	private readonly emitter: Emittery;
	private readonly logger: Logger | null;

	/**
	 * Maps event name → (original handler → wrapped handler).
	 * Keyed by event name first so the same handler function can be registered
	 * on multiple events without the entries colliding or overwriting each other.
	 */
	private readonly handlerMap = new Map<string, Map<EventHandler, (data: unknown) => Promise<void>>>();

	constructor(logger?: Logger) {
		this.emitter = new Emittery();
		this.logger = logger ?? null;
	}

	emit(event: string, payload: unknown): void {
		this.logger?.debug({ event, payload }, 'Event emitted');

		// Fire-and-forget: emit returns a promise but we intentionally don't await it.
		// Emittery runs handlers and catches failures internally.
		void this.emitter.emit(event, payload);
	}

	on(event: string, handler: EventHandler): void {
		// Wrap the handler to catch and log failures (URS-EVT-003)
		const wrappedHandler = async (data: unknown): Promise<void> => {
			try {
				await handler(data);
			} catch (error) {
				this.logger?.error(
					{ event, error },
					'Event handler failed (isolated, other handlers unaffected)',
				);
			}
		};

		let eventMap = this.handlerMap.get(event);
		if (!eventMap) {
			eventMap = new Map();
			this.handlerMap.set(event, eventMap);
		}
		eventMap.set(handler, wrappedHandler);
		this.emitter.on(event, wrappedHandler);
	}

	off(event: string, handler: EventHandler): void {
		const eventMap = this.handlerMap.get(event);
		if (!eventMap) return;
		const wrappedHandler = eventMap.get(handler);
		if (wrappedHandler) {
			this.emitter.off(event, wrappedHandler);
			eventMap.delete(handler);
			if (eventMap.size === 0) {
				this.handlerMap.delete(event);
			}
		}
	}

	/**
	 * Remove all listeners. Used during shutdown.
	 */
	clearAll(): void {
		this.emitter.clearListeners();
		this.handlerMap.clear();
	}
}
