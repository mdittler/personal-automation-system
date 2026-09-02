/**
 * Ollama (local LLM) provider.
 *
 * Refactored from ollama-client.ts to implement the LLMProviderClient interface.
 * Uses the official `ollama` npm package. Free local inference — no cost tracking.
 * Does NOT silently fall back to other providers on failure (URS-LLM-004).
 */

import { Ollama } from 'ollama';
import type {
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMFinishReason,
	ProviderModel,
} from '../../../types/llm.js';
import { LLMEmptyOutputError } from '../errors.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

/**
 * Map Ollama `done_reason` (newer SDKs) to the unified LLMFinishReason.
 * Older Ollama versions don't emit `done_reason`; callers fall back to comparing
 * `eval_count` against the requested `maxTokens`.
 */
function mapOllamaDoneReason(doneReason: unknown): LLMFinishReason {
	switch (doneReason) {
		case 'stop':
			return 'stop';
		case 'length':
			return 'length';
		case 'load':
			return 'other';
		default:
			return 'other';
	}
}

export class OllamaProvider extends BaseProvider {
	private readonly client: Ollama;

	constructor(options: Omit<BaseProviderOptions, 'providerType' | 'apiKey'>) {
		super({ ...options, providerType: 'ollama', apiKey: '' });

		this.client = new Ollama({
			host: options.baseUrl,
			fetch: createTimeoutFetch(120_000),
		});
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		const response = await this.client.generate({
			model,
			prompt,
			...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
			...(options?.responseFormat === 'json' ? { format: 'json' as const } : {}),
			// Unconditional, NOT a conditional spread: `think: false` has to reach
			// the wire. Thinking-capable models (qwen3.8, muse-glimmer, …) default
			// to thinking ON and spend the whole `num_predict` budget inside the
			// separate `thinking` field, returning `response: ''`. Non-thinking
			// models (gemma4) accept the flag and ignore it. See
			// LLMCompletionOptions.thinking for why the default is OFF.
			think: options?.thinking === true,
			options: {
				temperature: options?.temperature ?? 0.1,
				num_predict: options?.maxTokens,
			},
		});

		// Prefer the explicit `done_reason` from newer Ollama SDKs. When absent
		// (older versions), fall back to comparing eval_count against the
		// requested cap as a best-effort truncation heuristic. If neither
		// signal is available we return 'other' so the caller can detect "we
		// don't know" rather than silently treating it as a clean stop.
		const rawDoneReason = (response as { done_reason?: unknown }).done_reason;
		let finishReason: LLMFinishReason;
		if (typeof rawDoneReason === 'string') {
			finishReason = mapOllamaDoneReason(rawDoneReason);
		} else if (typeof options?.maxTokens === 'number' && typeof response.eval_count === 'number') {
			finishReason = response.eval_count >= options.maxTokens ? 'length' : 'stop';
		} else {
			finishReason = 'other';
		}

		const text = response.response ?? '';

		// Empty output + budget exhausted is unambiguously a failure: there is
		// nothing to return and no budget left to produce it with. Gated on the
		// finish reason rather than on a thinking block being present, so a model
		// that burns its budget without reporting `thinking` is caught too.
		//
		// Empty output + `stop` deliberately still returns '': Gemma legitimately
		// answers ambiguous prompts with an empty string, and the shadow/recall
		// classifiers already retry that case themselves.
		if (text.trim() === '' && finishReason === 'length') {
			const thinking = (response as { thinking?: unknown }).thinking;
			throw new LLMEmptyOutputError({
				provider: this.providerId,
				model,
				maxTokens: options?.maxTokens,
				...(typeof thinking === 'string' ? { thinkingChars: thinking.length } : {}),
			});
		}

		return {
			text,
			usage: {
				inputTokens: response.prompt_eval_count ?? 0,
				outputTokens: response.eval_count ?? 0,
			},
			model,
			provider: this.providerId,
			finishReason,
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		try {
			const response = await this.client.list();

			return response.models.map((model) => ({
				id: model.name,
				displayName: model.name,
				provider: this.providerId,
				providerType: this.providerType,
				pricing: null, // Ollama is free local inference
			}));
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list Ollama models',
			);
			return [];
		}
	}

	protected override getRetryOptions() {
		return {
			maxRetries: 2,
			initialDelayMs: 500,
			logger: this.logger,
		};
	}
}

/**
 * Create a fetch function with a timeout using AbortController.
 */
function createTimeoutFetch(timeoutMs: number): typeof globalThis.fetch {
	return (input, init) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		return globalThis
			.fetch(input, { ...init, signal: controller.signal })
			.finally(() => clearTimeout(timeout));
	};
}
