/**
 * Outbound webhook service.
 *
 * Subscribes to EventBus events and delivers JSON payloads to configured URLs.
 * Uses HMAC-SHA256 signing when a secret is configured per webhook.
 * Fire-and-forget with rate limiting per URL.
 */

import { createHmac } from 'node:crypto';
import type { Logger } from 'pino';
import type { EventBusService, EventHandler } from '../../types/events.js';
import type {
	WebhookDefinition,
	WebhookDeliveryResult,
	WebhookPayload,
} from '../../types/webhooks.js';

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_DELIVERIES_PER_MINUTE = 10;
const URL_SCHEME_PATTERN = /^https?:\/\//;

export interface WebhookServiceOptions {
	webhooks: WebhookDefinition[];
	eventBus: EventBusService;
	logger: Logger;
}

export class WebhookService {
	private readonly webhooks: WebhookDefinition[];
	private readonly eventBus: EventBusService;
	private readonly logger: Logger;
	private readonly handlers = new Map<string, EventHandler>();

	/** Per-URL delivery timestamps for rate limiting. */
	private readonly deliveryLog = new Map<string, number[]>();

	constructor(options: WebhookServiceOptions) {
		this.eventBus = options.eventBus;
		this.logger = options.logger;
		this.webhooks = options.webhooks.filter((wh) => this.validateWebhook(wh));
	}

	/**
	 * Subscribe to EventBus for all configured webhook events.
	 */
	init(): void {
		// Collect unique event names across all webhooks
		const eventMap = new Map<string, WebhookDefinition[]>();
		for (const wh of this.webhooks) {
			for (const event of wh.events) {
				const existing = eventMap.get(event) ?? [];
				existing.push(wh);
				eventMap.set(event, existing);
			}
		}

		// Subscribe once per event, deliver to all matching webhooks
		for (const [event, targets] of eventMap) {
			const handler: EventHandler = (payload) => {
				void this.deliverToAll(event, payload, targets);
			};
			this.handlers.set(event, handler);
			this.eventBus.on(event, handler);
		}

		this.logger.info(
			{ webhookCount: this.webhooks.length, eventCount: eventMap.size },
			'Webhook service initialized',
		);
	}

	/**
	 * Unsubscribe from all events. Called during shutdown.
	 */
	dispose(): void {
		for (const [event, handler] of this.handlers) {
			this.eventBus.off(event, handler);
		}
		this.handlers.clear();
		this.deliveryLog.clear();
	}

	/**
	 * Deliver a payload to all matching webhooks for an event.
	 */
	private async deliverToAll(
		event: string,
		rawData: unknown,
		targets: WebhookDefinition[],
	): Promise<void> {
		// Ensure data is always an object — EventBus payloads can be any type
		const data: Record<string, unknown> =
			rawData !== null && typeof rawData === 'object' && !Array.isArray(rawData)
				? (rawData as Record<string, unknown>)
				: { value: rawData ?? null };

		const payload: WebhookPayload = {
			event,
			timestamp: new Date().toISOString(),
			data,
		};

		const results = await Promise.allSettled(targets.map((wh) => this.deliver(wh, payload)));

		for (const result of results) {
			if (result.status === 'rejected') {
				this.logger.error({ event, error: String(result.reason) }, 'Webhook delivery error');
			}
		}
	}

	/**
	 * Deliver a single payload to a webhook URL.
	 */
	private async deliver(
		webhook: WebhookDefinition,
		payload: WebhookPayload,
	): Promise<WebhookDeliveryResult> {
		// Rate limit check — record before fetch to prevent bursts
		if (!this.isWithinRateLimit(webhook.url)) {
			this.logger.warn({ webhookId: webhook.id, url: webhook.url }, 'Webhook rate limited');
			return {
				webhookId: webhook.id,
				url: webhook.url,
				success: false,
				error: 'Rate limited',
			};
		}
		this.recordDelivery(webhook.url);

		const body = JSON.stringify(payload);
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		// HMAC signing
		if (webhook.secret) {
			const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
			headers['X-PAS-Signature'] = `sha256=${signature}`;
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

		try {
			const response = await fetch(webhook.url, {
				method: 'POST',
				headers,
				body,
				signal: controller.signal,
			});

			const success = response.ok;
			if (!success) {
				this.logger.warn(
					{ webhookId: webhook.id, statusCode: response.status },
					'Webhook delivery got non-2xx response',
				);
			}

			return {
				webhookId: webhook.id,
				url: webhook.url,
				success,
				statusCode: response.status,
			};
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.logger.error(
				{ webhookId: webhook.id, url: webhook.url, error },
				'Webhook delivery failed',
			);
			return {
				webhookId: webhook.id,
				url: webhook.url,
				success: false,
				error,
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * Check if a URL is within the per-URL rate limit.
	 */
	private isWithinRateLimit(url: string): boolean {
		const now = Date.now();
		const windowMs = 60_000;
		const log = this.deliveryLog.get(url) ?? [];

		// Prune old entries
		const recent = log.filter((ts) => now - ts < windowMs);
		this.deliveryLog.set(url, recent);

		return recent.length < MAX_DELIVERIES_PER_MINUTE;
	}

	/**
	 * Record a delivery timestamp for rate limiting.
	 */
	private recordDelivery(url: string): void {
		const log = this.deliveryLog.get(url) ?? [];
		log.push(Date.now());
		this.deliveryLog.set(url, log);
	}

	/**
	 * Validate a webhook definition at construction time.
	 */
	private validateWebhook(wh: WebhookDefinition): boolean {
		if (!wh.id || !wh.url || !wh.events?.length) {
			this.logger.warn({ webhookId: wh.id }, 'Webhook missing required fields, skipping');
			return false;
		}

		if (!URL_SCHEME_PATTERN.test(wh.url)) {
			this.logger.warn(
				{ webhookId: wh.id, url: wh.url },
				'Webhook URL must use http:// or https://, skipping',
			);
			return false;
		}

		return true;
	}
}
