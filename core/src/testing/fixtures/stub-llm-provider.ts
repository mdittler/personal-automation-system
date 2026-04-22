/**
 * Stub LLM provider for integration and load tests.
 *
 * Returns deterministic responses without hitting real APIs.
 * Classification prompts are answered instantly; completions apply
 * a pareto-distributed delay to simulate realistic latency.
 */

import type { Logger } from 'pino';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	ProviderModel,
} from '../../types/llm.js';
import type { CostTracker } from '../../services/llm/cost-tracker.js';
import { BaseProvider } from '../../services/llm/providers/base-provider.js';
import { ProviderRegistry } from '../../services/llm/providers/provider-registry.js';

export interface StubProviderOptions {
	/** Fixed category to return for classification prompts. Defaults to 'chatbot'. */
	classificationCategory?: string;
	/** Fixed text to return for completion prompts. Defaults to 'stubbed response'. */
	completionText?: string;
	/** p50 latency for completions in ms. Default: 80. */
	p50Ms?: number;
	/** p95 latency for completions in ms. Default: 400. */
	p95Ms?: number;
	/** Cap latency in ms. Default: 5000. */
	capMs?: number;
}

/** Pattern to detect classification prompts. */
const CLASSIFY_RE = /category|classify|return json/i;

/**
 * Sample from a Pareto distribution capped at capMs.
 * This gives a p50 ≈ p50Ms and long p95/p99 tail similar to real API calls.
 */
function paretoSample(p50Ms: number, p95Ms: number, capMs: number): number {
	// Fit Pareto(xm, alpha) to p50 and p95 constraints
	// P(X > x) = (xm/x)^alpha
	// P(X > p50) = 0.5 → xm/p50 = 0.5^(1/alpha)
	// P(X > p95) = 0.05 → xm/p95 = 0.05^(1/alpha)
	// Dividing: p50/p95 = (0.5/0.05)^(1/alpha) = 10^(1/alpha)
	// alpha = log(10) / log(p95/p50)
	const alpha = Math.log(10) / Math.log(p95Ms / p50Ms);
	const xm = p50Ms / Math.pow(0.5, 1 / alpha);

	// Inverse CDF: x = xm / U^(1/alpha)
	const u = Math.random();
	const sample = xm / Math.pow(u, 1 / alpha);
	return Math.min(sample, capMs);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StubProvider extends BaseProvider {
	private readonly classificationCategory: string;
	private readonly completionText: string;
	private readonly p50Ms: number;
	private readonly p95Ms: number;
	private readonly capMs: number;

	constructor(
		costTracker: CostTracker,
		logger: Logger,
		opts: StubProviderOptions = {},
	) {
		super({
			providerId: 'stub',
			providerType: 'openai-compatible',
			apiKey: '',
			defaultModel: 'stub-model',
			logger,
			costTracker,
		});
		this.classificationCategory = opts.classificationCategory ?? 'chatbot';
		this.completionText = opts.completionText ?? 'stubbed response';
		this.p50Ms = opts.p50Ms ?? 80;
		this.p95Ms = opts.p95Ms ?? 400;
		this.capMs = opts.capMs ?? 5000;
	}

	async listModels(): Promise<ProviderModel[]> {
		return [
			{
				id: 'stub-model',
				displayName: 'Stub Model',
				provider: this.providerId,
				providerType: this.providerType,
				pricing: null,
			},
		];
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const isClassification = CLASSIFY_RE.test(prompt);
		let text: string;

		if (isClassification) {
			text = JSON.stringify({
				category: this.classificationCategory,
				confidence: 0.9,
			});
		} else {
			const ms = paretoSample(this.p50Ms, this.p95Ms, this.capMs);
			await delay(ms);
			text = this.completionText;
		}

		const model = options?.modelRef?.model ?? options?.claudeModel ?? this.defaultModel;

		return {
			text,
			usage: {
				inputTokens: Math.ceil(prompt.length / 4),
				outputTokens: Math.ceil(text.length / 4),
			},
			model,
			provider: this.providerId,
		};
	}

	/** Override retry options — stub never fails, no need for retries. */
	protected override getRetryOptions() {
		return { maxRetries: 0, initialDelayMs: 0, logger: this.logger };
	}

	/**
	 * Rewire the cost tracker post-construction.
	 * Used by the load-test harness after composeRuntime() returns the real CostTracker.
	 */
	setCostTracker(ct: CostTracker): void {
		// BaseProvider.costTracker is protected readonly; this method on the
		// subclass is the single sanctioned escape hatch for test rewiring.
		(this as unknown as { costTracker: CostTracker }).costTracker = ct;
	}
}

/**
 * Create a ProviderRegistry pre-loaded with a single StubProvider.
 */
export function createStubProviderRegistry(
	costTracker: CostTracker,
	logger: Logger,
	opts?: StubProviderOptions,
): ProviderRegistry {
	const registry = new ProviderRegistry(logger);
	registry.register(new StubProvider(costTracker, logger, opts));
	return registry;
}
