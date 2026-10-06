/**
 * Build a ProviderRegistry for every provider in `config.llm`. Shared by the
 * CLI deps (`build-deps.ts`) and the per-trial worker so both dispatch
 * through identically constructed providers (REQ-REG-AGENT-002).
 */
import type { CostTracker } from '@core/services/llm/cost-tracker.js';
import { createProvider } from '@core/services/llm/providers/provider-factory.js';
import { ProviderRegistry } from '@core/services/llm/providers/provider-registry.js';
import type { SystemConfig } from '@core/types/config.js';
import type { Logger } from 'pino';

export function createProviderRegistry(
	config: SystemConfig,
	logger: Logger,
	costTracker: CostTracker,
): ProviderRegistry {
	const registry = new ProviderRegistry(logger.child({ service: 'provider-registry' }));
	for (const [id, providerConfig] of Object.entries(config.llm?.providers ?? {})) {
		const provider = createProvider(
			id,
			providerConfig,
			logger.child({ service: `provider-${id}` }),
			costTracker,
		);
		if (provider) registry.register(provider);
	}
	return registry;
}
