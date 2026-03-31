/**
 * Secrets service implementation.
 *
 * Provides infrastructure-mediated access to external API secrets
 * declared in an app's manifest under requirements.external_apis.
 * Apps call services.secrets.get('api-id') instead of reading process.env directly.
 */

import type { SecretsService } from '../../types/app-module.js';

export interface SecretsServiceOptions {
	/** Map from external_apis ID to resolved value (from process.env). */
	values: Map<string, string>;
}

export class SecretsServiceImpl implements SecretsService {
	private readonly values: Map<string, string>;

	constructor(options: SecretsServiceOptions) {
		// Defensive copy — callers cannot mutate internal state
		this.values = new Map(options.values);
	}

	get(id: string): string | undefined {
		return this.values.get(id);
	}

	has(id: string): boolean {
		return this.values.has(id);
	}
}
