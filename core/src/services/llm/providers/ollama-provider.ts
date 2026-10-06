/**
 * Ollama (local LLM) provider.
 *
 * Refactored from ollama-client.ts to implement the LLMProviderClient interface.
 * Uses the official `ollama` npm package. Free local inference — no cost tracking.
 * Does NOT silently fall back to other providers on failure (URS-LLM-004).
 */

import { Ollama } from 'ollama';
import type {
	ChatFinishReason,
	ChatMessage,
	ChatOptions,
	ChatResult,
	LLMCompletionOptions,
	LLMCompletionResult,
	LLMFinishReason,
	ProviderModel,
	ToolCallRequest,
} from '../../../types/llm.js';
import {
	DEFAULT_CHAT_CONTEXT_WINDOW,
	DEFAULT_OLLAMA_KEEP_ALIVE,
	DEFAULT_OLLAMA_TIMEOUT_MS,
} from '../chat-defaults.js';
import { synthesizeToolCallId, toOllamaThink } from '../chat-messages.js';
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

/**
 * Per-model capability probe over `/api/show`, cached for the provider's
 * lifetime: a pinned tag's capabilities do not change. Failures are not
 * cached and reject, so "Ollama is down" is never reported as "no tools".
 * A server too old to report `capabilities` is treated as fully capable
 * (same permissive-unknown rule as `supportsTemperature`), with one warning.
 */
class OllamaCapabilityCache {
	private readonly cache = new Map<string, Promise<ReadonlySet<string> | null>>();
	private warnedLegacy = false;

	constructor(
		private readonly show: (model: string) => Promise<{ capabilities?: unknown }>,
		private readonly logger: { warn: (obj: object, msg: string) => void },
	) {}

	/** `null` means "the server did not say" (legacy), which callers treat as capable. */
	capabilities(model: string): Promise<ReadonlySet<string> | null> {
		let pending = this.cache.get(model);
		if (!pending) {
			pending = this.show(model).then((response) => {
				const raw = response?.capabilities;
				if (!Array.isArray(raw)) {
					if (!this.warnedLegacy) {
						this.warnedLegacy = true;
						this.logger.warn(
							{ model },
							'Ollama /api/show reported no capabilities (server too old?) — assuming tools and vision are supported',
						);
					}
					return null;
				}
				return new Set(raw.filter((c): c is string => typeof c === 'string'));
			});
			this.cache.set(model, pending);
			pending.catch(() => this.cache.delete(model));
		}
		return pending;
	}

	async has(model: string, capability: 'tools' | 'vision'): Promise<boolean> {
		const caps = await this.capabilities(model);
		return caps === null ? true : caps.has(capability);
	}
}

export class OllamaProvider extends BaseProvider {
	// `supportsVision` deliberately stays at the base default (false): it is
	// the `complete()` gate, and `doComplete`'s `generate` request sends no
	// `images`, so flipping it would silently drop photos into text-only
	// inference (R1-2). The chat path gates per model via `supportsVisionModel`
	// (design §5.2: vision becomes model-capability-driven — on chat).
	private readonly client: Ollama;
	private readonly host: string | undefined;
	private readonly capabilityCache: OllamaCapabilityCache;

	constructor(options: Omit<BaseProviderOptions, 'providerType' | 'apiKey'>) {
		super({ ...options, providerType: 'ollama', apiKey: '' });
		this.host = options.baseUrl;
		this.client = new Ollama({
			host: this.host,
			fetch: createTimeoutFetch(DEFAULT_OLLAMA_TIMEOUT_MS),
		});
		this.capabilityCache = new OllamaCapabilityCache(
			(model) => this.client.show({ model }),
			this.logger,
		);
	}

	override supportsTools(modelId: string): Promise<boolean> {
		return this.capabilityCache.has(modelId, 'tools');
	}

	override supportsVisionModel(modelId: string): Promise<boolean> {
		return this.capabilityCache.has(modelId, 'vision');
	}

	protected override async doChat(
		messages: ChatMessage[],
		options?: ChatOptions,
	): Promise<ChatResult> {
		const model = this.resolveModel(options);
		// The ollama SDK has no per-request signal; `Ollama.abort()` only covers
		// streamed requests. A per-call client whose fetch follows our signal is
		// the smallest honest way to make cancellation reach the wire.
		const client = options?.signal
			? new Ollama({
					host: this.host,
					fetch: createTimeoutFetch(DEFAULT_OLLAMA_TIMEOUT_MS, options.signal),
				})
			: this.client;

		const response = await client.chat({
			model,
			messages: messages.map(toOllamaMessage),
			stream: false,
			...(options?.tools?.length
				? {
						tools: options.tools.map((t) => ({
							type: 'function',
							// The SDK types `parameters` as a narrow JSON-Schema shape; our
							// `inputSchema: object` is the same thing, so cast rather than copy.
							function: {
								name: t.name,
								description: t.description,
								parameters: t.inputSchema as never,
							},
						})),
					}
				: {}),
			// Unconditional: `think: false` must reach the wire (see
			// LLMCompletionOptions.thinking). Levels map to Ollama's own strings.
			think: toOllamaThink(options?.thinking),
			keep_alive: options?.keepAlive ?? DEFAULT_OLLAMA_KEEP_ALIVE,
			options: {
				// Always explicit: Ollama silently truncates past its window (design §5.3).
				num_ctx: options?.contextWindow ?? DEFAULT_CHAT_CONTEXT_WINDOW,
				...(options?.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
				// No default temperature on chat: the Modelfile carries the card's
				// sampling defaults (qwen3.8 non-thinking: 0.7 / top_p 0.8).
				...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
			},
		});

		const msg = response.message;
		const toolCalls = toToolCallRequests(msg.tool_calls);
		const usage = {
			inputTokens: response.prompt_eval_count ?? 0,
			outputTokens: response.eval_count ?? 0,
		};
		const rawDoneReason = (response as { done_reason?: unknown }).done_reason;
		const baseReason: ChatFinishReason =
			typeof rawDoneReason === 'string' ? mapOllamaDoneReason(rawDoneReason) : 'other';
		const finishReason: ChatFinishReason = toolCalls.length > 0 ? 'tool_calls' : baseReason;
		const content = msg.content ?? '';

		if (content.trim() === '' && toolCalls.length === 0 && finishReason === 'length') {
			throw new LLMEmptyOutputError({
				provider: this.providerId,
				model,
				maxTokens: options?.maxTokens,
				...(typeof msg.thinking === 'string' ? { thinkingChars: msg.thinking.length } : {}),
				usage,
			});
		}

		return {
			message: {
				role: 'assistant',
				content,
				...(toolCalls.length > 0 ? { toolCalls } : {}),
				...(typeof msg.thinking === 'string' && msg.thinking.length > 0
					? { thinking: msg.thinking }
					: {}),
			},
			finishReason,
			usage,
			model,
			provider: this.providerId,
		};
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

/** Ollama `Message` shape (the SDK type is loose; we build it explicitly). */
interface OllamaWireMessage {
	role: string;
	content: string;
	images?: string[];
	thinking?: string;
	tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
	tool_name?: string;
}

function toOllamaMessage(m: ChatMessage): OllamaWireMessage {
	switch (m.role) {
		case 'tool':
			return { role: 'tool', content: m.content, ...(m.toolName ? { tool_name: m.toolName } : {}) };
		case 'assistant':
			return {
				role: 'assistant',
				content: m.content,
				...(m.thinking ? { thinking: m.thinking } : {}),
				...(m.toolCalls?.length
					? {
							tool_calls: m.toolCalls.map((c) => ({
								function: { name: c.name, arguments: asArgumentObject(c.arguments) },
							})),
						}
					: {}),
			};
		default:
			return {
				role: m.role,
				content: m.content,
				...(m.images?.length ? { images: m.images.map((img) => img.data.toString('base64')) } : {}),
			};
	}
}

/** Ollama requires an object for replayed arguments; anything else (a raw string P2 rejected) is sent as `{}`. */
function asArgumentObject(args: unknown): Record<string, unknown> {
	return typeof args === 'object' && args !== null && !Array.isArray(args)
		? (args as Record<string, unknown>)
		: {};
}

function toToolCallRequests(raw: unknown): ToolCallRequest[] {
	if (!Array.isArray(raw)) return [];
	const out: ToolCallRequest[] = [];
	for (const item of raw) {
		const fn = (item as { function?: { name?: unknown; arguments?: unknown } })?.function;
		if (!fn || typeof fn.name !== 'string') continue;
		const providedId = (item as { id?: unknown }).id;
		out.push({
			id: typeof providedId === 'string' && providedId ? providedId : synthesizeToolCallId(),
			name: fn.name,
			arguments: parseArguments(fn.arguments),
		});
	}
	return out;
}

/** Objects pass through; JSON strings are parsed; anything else is returned raw for P2's validator to reject. */
function parseArguments(args: unknown): unknown {
	if (typeof args !== 'string') return args;
	try {
		return JSON.parse(args);
	} catch {
		return args;
	}
}

/**
 * Create a fetch with a timeout, optionally also following a caller's
 * AbortSignal (Node 22's `AbortSignal.any`).
 */
function createTimeoutFetch(timeoutMs: number, outer?: AbortSignal): typeof globalThis.fetch {
	return (input, init) => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		const signal = outer ? AbortSignal.any([controller.signal, outer]) : controller.signal;
		return globalThis.fetch(input, { ...init, signal }).finally(() => clearTimeout(timeout));
	};
}
