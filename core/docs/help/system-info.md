# System Information & Introspection

PAS provides full system introspection through the `/ask` command. You can ask about models, costs, pricing, scheduling, and system status.

## Models & Tiers

PAS uses a tier-based model system:
- **Fast tier** — used for routing, classification, and quick tasks (e.g., Claude Haiku)
- **Standard tier** — used for conversation, summarization, and complex reasoning (e.g., Claude Sonnet)
- **Reasoning tier** — optional, for tasks requiring deep reasoning (e.g., Claude Opus)

Each tier maps to a specific provider and model. You can ask what model each tier is using, or switch models.

Example questions:
- "What model is being used?"
- "What's the fast model?"
- "What providers are configured?"

## Model Switching

You can change which model a tier uses by asking the chatbot:
- "Switch the fast model to claude-haiku-4-5-20251001"
- "Change the standard model to claude-sonnet-4-20250514"

The change takes effect immediately and persists across restarts.

## Costs & Usage

PAS tracks LLM API usage and costs per app. You can ask about:
- Monthly spending total and per-app breakdown
- Cost per token for any model
- Rate limits and cost caps

Example questions:
- "How much have I spent this month?"
- "What's the cost per token for Claude Sonnet?"
- "What's my cost cap?"

## Alerts

PAS supports conditional alerts — scheduled checks against data files that trigger notifications when conditions are met. Alerts can use deterministic conditions (empty, contains, line count) or fuzzy/LLM-interpreted conditions. Actions include sending Telegram messages and running reports. Alerts have cooldown periods to prevent excessive firing.

## Scheduling

PAS runs cron jobs defined in app manifests and alert/report schedules. You can ask about registered jobs, their schedules, and descriptions.

Example questions:
- "What scheduled jobs are running?"
- "What cron jobs are registered?"

## System Status

You can ask about general system health:
- System uptime
- Number of loaded apps and registered users
- Configured timezone
- Fallback mode (chatbot or notes)
- LLM safeguard defaults (rate limits, cost caps)

Example questions:
- "What's the system uptime?"
- "How many apps are loaded?"
- "What are the rate limit defaults?"

## Providers

PAS supports multiple LLM providers:
- **Anthropic** — Claude models (native SDK)
- **Google** — Gemini models (native SDK)
- **OpenAI-compatible** — OpenAI, Groq, Together, Mistral, vLLM
- **Ollama** — local models (optional)

You can ask which providers are configured and what models are available from each.
