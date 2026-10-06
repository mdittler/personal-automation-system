---
name: pas-llm-architecture
description: PAS LLM architecture — providers, tiers, security boundary, banned imports, guards, cost tracking, model selection. Invoke when touching LLM provider code, request routing, or anything that talks to a model backend.
---

# PAS LLM Architecture

Use this when adding/changing LLM providers, modifying tier routing, plumbing LLM options through the stack, touching cost tracking, or working on model selection.

## Multi-provider

- **Anthropic** (native SDK)
- **Google Gemini** (native SDK)
- **OpenAI-compatible** — covers OpenAI, Groq, Together, Mistral, vLLM, and any endpoint that exposes `/v1/chat/completions` + `/v1/models`
- **Ollama** (optional, local)
- **llama.cpp** (optional, local) — `LlamaCppProvider extends OpenAICompatibleProvider`, talks to `llama-server` over OpenAI-compatible endpoints, no API key required, free local inference

## Tier-based routing

Apps request `fast`, `standard`, or `reasoning` tier. Infrastructure maps the tier to a provider+model via `ModelSelector`. Apps never request a specific provider directly.

## Chat with tools (Agent Runtime P1)

- `LLMService.chat(messages, options)` is the messages+tools API; `complete()` stays for single-shot uses. Both guards wrap it.
- Providers implement `doChat()`; `BaseProvider.chatWithUsage()` owns validation, capability/vision gates, retry (never on abort), temperature self-heal, and cost recording. Google has no chat.
- Capability gating is per model: `llm.supportsTools(ref)` / `llm.supportsVision(ref)`. Ollama probes `/api/show` (cached); openai-compatible/llama-cpp read `supports_tools`; Anthropic is always capable. Tools on an incapable model throw `LLMToolsUnsupportedError` before any inference call. Vision on chat is per model; `complete()` keeps the provider-wide `supportsVision` gate (Ollama: false).
- Ollama chat always sends `num_ctx` (32768 default) and `keep_alive` (30m default), and `think: false` unless asked. Chat sends no default temperature (the Modelfile's card defaults apply) — unlike `complete()`. OpenAI-compatible requests send `max_completion_tokens` for o-series / gpt-5 ids and `max_tokens` otherwise (`openAIOutputLimitField`).
- `ChatOptions.signal` reaches every SDK call and ends the wait on a pending capability probe. A failed call that the provider billed is still charged (`LLMEmptyOutputError.usage`).
- No Anthropic prompt caching yet: `cache_control` waits for cache-aware pricing (P2). `ChatUsage.cacheCreationTokens` / `cacheReadTokens` are carried separately and are not billed.
- Settings: `agent.model` (default `ollama/qwen3.8:27b-mlx`), `agent.vision_model` (paid; default the Claude reasoning/standard tier), `agent.thinking` (default `off`), `agent.context_window`, `agent.keep_alive` — `core/src/services/llm/chat-defaults.ts` is the single home for the defaults.

## Security boundary — banned imports

Apps must NOT import LLM SDKs directly. The static analyzer rejects installs that import any of:

- `@anthropic-ai/sdk`
- `openai`
- `@google/genai`
- `ollama`

All LLM access goes through `CoreServices.llm`. The facade hides which provider is in play and applies guards consistently.

## Per-app safeguards

- `LLMGuard` enforces per-app rate limits + monthly cost caps
- `SystemLLMGuard` covers infrastructure calls (classifiers, summarizers)
- `HouseholdLLMLimiter` adds the household dimension on top

## Per-user cost tracking

`AsyncLocalStorage` propagates `userId` (and `householdId`) transparently through every dispatch point. The 8-column usage log captures attribution end-to-end without callers having to plumb identity manually.

## Local providers are free

`isLocalProvider(providerType)` in `core/src/services/llm/model-pricing.ts` returns `true` for Ollama and llama.cpp. The four pricing sites (`hasPricing`, `estimateCallCost`, `compose-runtime.ts` `guardPriceLookup`, `/gui/llm` model list) all consult this helper so local inference is always billed at $0/token.

## Runtime model switching

- `ModelSelector` persists tier→model assignments to YAML, changeable via the GUI
- `ModelCatalog` fetches available models per provider with a 1-hour cache
- Ollama is optional — when `OLLAMA_URL` is empty, fast-tier classification falls back to Claude

## When llama.cpp is configured

llama.cpp shares Ollama's "free local inference" treatment but does not provide model management. Operators must place GGUF files manually and start `llama-server -m <gguf> --port 8080` themselves. The OpenAI-compatible endpoint handles chat templating server-side via the GGUF's embedded template (or `-mt <template>`).
