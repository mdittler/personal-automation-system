/**
 * Claude API (remote LLM) client.
 *
 * Uses the official @anthropic-ai/sdk for complex reasoning tasks.
 * Every call is logged via the cost tracker (URS-LLM-005).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { LLMCompletionOptions } from '../../types/llm.js';
import type { CostTracker } from './cost-tracker.js';
import { withRetry } from './retry.js';

export interface ClaudeClientOptions {
	/** Anthropic API key. */
	apiKey: string;
	/** Default Claude model. */
	model: string;
	/** Logger instance. */
	logger: Logger;
	/** Cost tracker for usage logging. */
	costTracker: CostTracker;
	/** App ID for cost attribution. */
	appId?: string;
}

export class ClaudeClient {
	private readonly client: Anthropic;
	private readonly defaultModel: string;
	private readonly logger: Logger;
	private readonly costTracker: CostTracker;
	private readonly appId?: string;

	constructor(options: ClaudeClientOptions) {
		if (!options.apiKey) {
			throw new Error('Claude API key is required but was empty');
		}
		this.client = new Anthropic({
			apiKey: options.apiKey,
			timeout: 120_000, // 2 minute timeout
		});
		this.defaultModel = options.model;
		this.logger = options.logger;
		this.costTracker = options.costTracker;
		this.appId = options.appId;
	}

	/**
	 * Generate a text completion using Claude.
	 *
	 * Logs token usage and estimated cost via the cost tracker.
	 */
	async complete(prompt: string, options?: LLMCompletionOptions): Promise<string> {
		const model = options?.claudeModel ?? this.defaultModel;

		return withRetry(
			async () => {
				const response = await this.client.messages.create({
					model,
					max_tokens: options?.maxTokens ?? 1024,
					messages: [{ role: 'user', content: prompt }],
					temperature: options?.temperature,
				});

				// Extract text from response
				const text = response.content
					.filter((block): block is Anthropic.TextBlock => block.type === 'text')
					.map((block) => block.text)
					.join('');

				// Log usage
				await this.costTracker.record({
					model,
					inputTokens: response.usage.input_tokens,
					outputTokens: response.usage.output_tokens,
					appId: this.appId,
				});

				return text;
			},
			{
				maxRetries: 2,
				initialDelayMs: 1000,
				logger: this.logger,
			},
		);
	}
}
