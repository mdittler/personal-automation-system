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
