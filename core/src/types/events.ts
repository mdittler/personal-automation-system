/**
 * Event bus types.
 *
 * The event bus is an in-process pub/sub system for decoupled
 * inter-app communication. Events are fire-and-forget.
 * Subscriptions are auto-wired from manifests at startup.
 */

/** Callback signature for event handlers. */
export type EventHandler = (payload: unknown) => void | Promise<void>;

/** Event bus service provided to apps via CoreServices. */
export interface EventBusService {
	/** Emit an event. Fire-and-forget — subscriber failures don't affect emitter. */
	emit(event: string, payload: unknown): void;

	/** Subscribe to an event. */
	on(event: string, handler: EventHandler): void;

	/** Unsubscribe from an event. */
	off(event: string, handler: EventHandler): void;
}
