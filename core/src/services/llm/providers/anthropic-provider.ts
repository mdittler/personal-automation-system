/**
 * Anthropic (Claude) provider.
 *
 * Refactored from claude-client.ts to implement the LLMProviderClient interface.
 * Uses the official @anthropic-ai/sdk for completions and model listing.
 */

import Anthropic, { APIUserAbortError } from '@anthropic-ai/sdk';
import type {
	ChatFinishReason,
	ChatMessage,
	ChatOptions,
	ChatResult,
	ChatToolSpec,
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMFinishReason,
	ProviderModel,
	ToolCallRequest,
} from '../../../types/llm.js';
import { ChatMessageShapeError, toAbortError } from '../chat-messages.js';
import { supportsTemperature } from '../model-capabilities.js';
import { getModelPricing } from '../model-pricing.js';
import { BaseProvider, type BaseProviderOptions } from './base-provider.js';

/**
 * Map Anthropic stop_reason to the unified LLMFinishReason.
 * Unknown / missing values → 'other'.
 */
function mapAnthropicStopReason(stopReason: unknown): LLMFinishReason {
	switch (stopReason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'max_tokens':
			return 'length';
		case 'tool_use':
			return 'other';
		default:
			return 'other';
	}
}

/** Chat stop reasons: the SDK also emits 'refusal' and 'pause_turn', which the completion mapper never sees. */
function mapAnthropicChatStopReason(stopReason: unknown): ChatFinishReason {
	switch (stopReason) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'max_tokens':
			return 'length';
		case 'refusal':
			return 'error';
		default:
			return 'other';
	}
}

/** Tools in the order given (P2 makes that order deterministic, §7). No `cache_control` in P1 (R1-1). */
function toAnthropicTools(tools: readonly ChatToolSpec[]): Anthropic.Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
	}));
}

type AnthropicUserBlock =
	| Anthropic.TextBlockParam
	| Anthropic.ImageBlockParam
	| Anthropic.ToolResultBlockParam;

/**
 * Leading system messages → `system` block array (no cache breakpoint in P1).
 * Tool results fold into one user message whose first blocks are
 * `tool_result`; a user text that follows the same step joins that message
 * (Anthropic requires every `tool_use` to be answered by `tool_result` blocks
 * at the start of the very next message; it merges consecutive same-role
 * messages itself, so folding is a tidiness choice, not a legality one).
 * Text blocks are emitted only for non-empty text: the API rejects an empty
 * text block (R1-3), so a captionless photo is image blocks alone.
 *
 * Exported for its own test. `validateChatMessages` already rejects every
 * shape this function throws on (P2-6: an empty system message, a
 * system-only history, an assistant turn with neither text nor tool calls);
 * the throws here are defence in depth so no direct caller can emit an empty
 * system text block, `messages: []`, or `content: []`.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): {
	system: Anthropic.TextBlockParam[];
	messages: Anthropic.MessageParam[];
} {
	const system: Anthropic.TextBlockParam[] = [];
	let i = 0;
	while (i < messages.length && messages[i]?.role === 'system') {
		const text = (messages[i] as ChatMessage).content;
		if (text.trim().length === 0) {
			throw new ChatMessageShapeError(`system message ${i} has no text`);
		}
		system.push({ type: 'text', text });
		i++;
	}
	if (i === messages.length) {
		throw new ChatMessageShapeError('at least one non-system message is required');
	}

	const out: Anthropic.MessageParam[] = [];
	const appendUserBlocks = (blocks: AnthropicUserBlock[], toolResult: boolean) => {
		const last = out[out.length - 1];
		if (last?.role === 'user' && Array.isArray(last.content)) {
			if (toolResult && last.content.some((b) => (b as { type: string }).type !== 'tool_result')) {
				throw new ChatMessageShapeError(
					'tool results must directly follow the assistant tool calls',
				);
			}
			(last.content as AnthropicUserBlock[]).push(...blocks);
			return;
		}
		out.push({ role: 'user', content: blocks });
	};

	for (; i < messages.length; i++) {
		const m = messages[i] as ChatMessage;
		switch (m.role) {
			case 'system':
				throw new ChatMessageShapeError(`system messages must come first (message ${i})`);
			case 'tool':
				appendUserBlocks(
					[
						{
							type: 'tool_result',
							tool_use_id: m.toolCallId ?? '',
							...(m.content.length > 0 ? { content: m.content } : {}),
							...(m.isError ? { is_error: true } : {}),
						},
					],
					true,
				);
				break;
			case 'user': {
				const blocks: AnthropicUserBlock[] = (m.images ?? []).map((img) => ({
					type: 'image' as const,
					source: {
						type: 'base64' as const,
						media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
						data: img.data.toString('base64'),
					},
				}));
				// Empty text block → 400 (R1-3). validateChatMessages already rejects a
				// user turn with neither text nor images, so `blocks` is never empty here.
				if (m.content.trim().length > 0) blocks.push({ type: 'text', text: m.content });
				appendUserBlocks(blocks, false);
				break;
			}
			case 'assistant': {
				const blocks: Anthropic.ContentBlockParam[] = [];
				if (m.content.trim().length > 0) blocks.push({ type: 'text', text: m.content });
				for (const call of m.toolCalls ?? []) {
					blocks.push({
						type: 'tool_use',
						id: call.id,
						name: call.name,
						input:
							typeof call.arguments === 'object' &&
							call.arguments !== null &&
							!Array.isArray(call.arguments)
								? call.arguments
								: {},
					});
				}
				if (blocks.length === 0) {
					// The API rejects `content: []` (P2-6).
					throw new ChatMessageShapeError(`assistant message ${i} has neither text nor tool calls`);
				}
				out.push({ role: 'assistant', content: blocks });
				break;
			}
		}
	}
	return { system, messages: out };
}

export class AnthropicProvider extends BaseProvider {
	override readonly supportsVision = true;
	private readonly client: Anthropic;

	constructor(options: Omit<BaseProviderOptions, 'providerType'>) {
		super({ ...options, providerType: 'anthropic' });

		if (!options.apiKey) {
			throw new Error('Anthropic API key is required but was empty');
		}

		this.client = new Anthropic({
			apiKey: options.apiKey,
			timeout: 120_000, // 2 minute timeout
			...(this.sdkMaxRetries !== undefined ? { maxRetries: this.sdkMaxRetries } : {}),
		});
	}

	override async supportsTools(_modelId: string): Promise<boolean> {
		return true; // every current Claude model (design §5.2)
	}

	protected override async doChat(
		messages: ChatMessage[],
		options?: ChatOptions,
	): Promise<ChatResult> {
		const model = this.resolveModel(options);
		const { system, messages: wire } = toAnthropicMessages(messages);
		const tools = options?.tools?.length ? toAnthropicTools(options.tools) : undefined;

		const response = await this.client.messages
			.create(
				{
					model,
					max_tokens: options?.maxTokens ?? 1024,
					messages: wire,
					...(system.length > 0 ? { system } : {}),
					...(supportsTemperature(model) && options?.temperature !== undefined
						? { temperature: options.temperature }
						: {}),
					...(tools
						? {
								tools,
								tool_choice: {
									type: 'auto' as const,
									...(options?.parallelToolCalls === false
										? { disable_parallel_tool_use: true }
										: {}),
								},
							}
						: {}),
				},
				options?.signal ? { signal: options.signal } : undefined,
			)
			.catch((err: unknown) => {
				// P2-4: the SDK's APIUserAbortError is named 'Error'; normalize it here.
				if (err instanceof APIUserAbortError) throw toAbortError(options?.signal, err);
				throw err;
			});

		const text = response.content
			.filter((block): block is Anthropic.TextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('');
		const toolCalls: ToolCallRequest[] = response.content
			.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
			.map((block) => ({ id: block.id, name: block.name, arguments: block.input }));
		const finishReason: ChatFinishReason =
			toolCalls.length > 0 ? 'tool_calls' : mapAnthropicChatStopReason(response.stop_reason);
		const cacheCreation = response.usage.cache_creation_input_tokens ?? 0;
		const cacheRead = response.usage.cache_read_input_tokens ?? 0;
		if (cacheCreation > 0 || cacheRead > 0) {
			// P1 sends no `cache_control`, so this cannot happen today. If it does,
			// say so loudly rather than mis-bill: CostTracker has one input rate,
			// and cache writes cost 1.25× / reads 0.1× of it (R1-1). P2 adds
			// cache-aware pricing before enabling caching.
			this.logger.warn(
				{ model, cacheCreationTokens: cacheCreation, cacheReadTokens: cacheRead },
				'Anthropic reported cache tokens on a request that sent no cache_control; cache tokens are carried on usage but not billed (no cache-aware pricing yet — see open-items "Agent Runtime deferrals" item 9)',
			);
		}

		return {
			message: { role: 'assistant', content: text, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
			finishReason,
			usage: {
				// Uncached prompt tokens only — the figure CostTracker prices at the
				// input rate. Cache counts are reported beside it, never folded in.
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
				...(cacheCreation > 0 ? { cacheCreationTokens: cacheCreation } : {}),
				...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
			},
			model,
			provider: this.providerId,
		};
	}

	protected async doComplete(
		prompt: string,
		options?: LLMCompletionOptions,
	): Promise<LLMCompletionResult> {
		const model = this.resolveModel(options);

		// Build multimodal content when images are provided
		let content: string | Anthropic.MessageCreateParams['messages'][0]['content'] = prompt;
		if (options?.images?.length) {
			const blocks: Anthropic.ContentBlockParam[] = [];
			for (const img of options.images) {
				blocks.push({
					type: 'image',
					source: {
						type: 'base64',
						media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
						data: img.data.toString('base64'),
					},
				});
			}
			blocks.push({ type: 'text', text: prompt });
			content = blocks;
		}

		const response = await this.client.messages.create({
			model,
			max_tokens: options?.maxTokens ?? 1024,
			messages: [{ role: 'user', content }],
			...(supportsTemperature(model) ? { temperature: options?.temperature } : {}),
			...(options?.systemPrompt ? { system: options.systemPrompt } : {}),
		});

		const text = response.content
			.filter((block): block is Anthropic.TextBlock => block.type === 'text')
			.map((block) => block.text)
			.join('');

		return {
			text,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
			},
			model,
			provider: this.providerId,
			finishReason: mapAnthropicStopReason(response.stop_reason),
		};
	}

	async listModels(): Promise<ProviderModel[]> {
		try {
			const models: ProviderModel[] = [];
			const response = await this.client.models.list({ limit: 100 });

			for await (const model of response) {
				const pricing = getModelPricing(model.id);
				models.push({
					id: model.id,
					displayName: model.display_name ?? model.id,
					provider: this.providerId,
					providerType: this.providerType,
					pricing: pricing ? { input: pricing.input, output: pricing.output } : null,
				});
			}

			return models;
		} catch (err) {
			this.logger.warn(
				{ error: err instanceof Error ? err.message : String(err) },
				'Failed to list Anthropic models',
			);
			return [];
		}
	}
}
