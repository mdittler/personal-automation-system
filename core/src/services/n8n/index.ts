/**
 * n8n dispatch service.
 *
 * When configured, dispatches execution to n8n via webhook instead of
 * running reports/alerts/daily-diff internally. Falls back to internal
 * execution when the webhook call fails.
 *
 * Payload format:
 *   { type: "report"|"alert"|"daily_diff", id: string, action: string }
 *
 * n8n receives this, then calls PAS API endpoints to do the actual work.
 */

import type { Logger } from 'pino';

const DISPATCH_TIMEOUT_MS = 10_000;
const URL_SCHEME_PATTERN = /^https?:\/\//;

export interface N8nDispatchPayload {
	type: 'report' | 'alert' | 'daily_diff';
	id: string;
	action: string;
}

export interface N8nDispatcher {
	/** Whether dispatch is configured (dispatchUrl is non-empty). */
	readonly enabled: boolean;

	/**
	 * Dispatch execution to n8n.
	 * @returns true if n8n acknowledged (2xx response), false if delivery failed
	 */
	dispatch(payload: N8nDispatchPayload): Promise<boolean>;
}

export interface N8nDispatcherOptions {
	dispatchUrl: string;
	logger: Logger;
}

export class N8nDispatcherImpl implements N8nDispatcher {
	private readonly dispatchUrl: string;
	readonly enabled: boolean;
	private readonly logger: Logger;

	constructor(options: N8nDispatcherOptions) {
		this.dispatchUrl = options.dispatchUrl;
		this.logger = options.logger;

		if (options.dispatchUrl && !URL_SCHEME_PATTERN.test(options.dispatchUrl)) {
			this.logger.warn(
				{ url: options.dispatchUrl },
				'n8n dispatch_url must use http:// or https:// — dispatch disabled',
			);
			this.enabled = false;
		} else {
			this.enabled = !!options.dispatchUrl;
		}
	}

	async dispatch(payload: N8nDispatchPayload): Promise<boolean> {
		if (!this.enabled) {
			return false;
		}

		const body = JSON.stringify(payload);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

		try {
			const response = await fetch(this.dispatchUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body,
				signal: controller.signal,
			});

			if (response.ok) {
				this.logger.info(
					{ type: payload.type, id: payload.id, action: payload.action },
					'n8n dispatch successful',
				);
				return true;
			}

			this.logger.warn(
				{ type: payload.type, id: payload.id, statusCode: response.status },
				'n8n dispatch got non-2xx response — falling back to internal execution',
			);
			return false;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			this.logger.warn(
				{ type: payload.type, id: payload.id, error },
				'n8n dispatch failed — falling back to internal execution',
			);
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}
}
