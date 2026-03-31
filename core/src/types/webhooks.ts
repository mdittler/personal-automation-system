/**
 * Webhook types for outbound event delivery.
 *
 * Webhooks allow PAS to notify external services (e.g., n8n) when
 * events occur — alerts fire, reports complete, data changes.
 */

/** A configured outbound webhook destination. */
export interface WebhookDefinition {
	/** Unique ID for this webhook. */
	id: string;
	/** Target URL to POST to. */
	url: string;
	/** List of event names to listen for. */
	events: string[];
	/** Optional HMAC-SHA256 secret for payload signing. */
	secret?: string;
}

/** Payload sent to webhook URLs. */
export interface WebhookPayload {
	/** Event name that triggered this delivery. */
	event: string;
	/** ISO 8601 timestamp of the event. */
	timestamp: string;
	/** Event-specific data (IDs and metadata only, no file contents). */
	data: Record<string, unknown>;
}

/** Result of a single webhook delivery attempt. */
export interface WebhookDeliveryResult {
	webhookId: string;
	url: string;
	success: boolean;
	statusCode?: number;
	error?: string;
}
