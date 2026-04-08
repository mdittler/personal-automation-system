# User Actions

Items that require manual action from the system owner. These cannot be automated by the build process.

---

## Before First Run

- [x] **Create a Telegram Bot** — @YourBotName created via BotFather
- [x] **Get an Anthropic API key** — Added to `.env`
- [ ] **Set up Cloudflare Tunnel** — Install `cloudflared` and create a tunnel pointing to the Fastify server port (default 3000). Not needed for local dev (polling mode works without a tunnel).
- [x] **Copy `.env.example` to `.env`** — Created with bot token and dev defaults. Still needs `ANTHROPIC_API_KEY`.
- [ ] **Install Docker and Docker Compose V2** — Only needed for production deployment, not local dev
- [x] **Install pnpm** — Already installed and working

## Optional Setup

- [ ] **Google Calendar API** — Create a Google Cloud project, enable Calendar API, create OAuth credentials (needed for calendar-dependent features)
- [ ] **Weather API key** — Sign up at [OpenWeatherMap](https://openweathermap.org/api) for a free API key (needed for weather-dependent features)
- [ ] **Configure Google Home speakers** — Note the device names for Chromecast casting configuration

## Per-Phase Review Points

- [x] **Phase 0** — Review scaffolding, confirm conventions match preferences
- [x] **Phase 1** — Review type definitions and manifest schema
- [x] **Phase 2** — Review data store scoping and path resolution
- [x] **Phase 3** — Review condition evaluator rule parsing format
- [x] **Phase 4** — Review LLM prompt templates and classification approach
- [x] **Phase 5** — Review router logic and app loading lifecycle
- [x] **Phase 6** — Test echo app end-to-end (386 unit/integration tests passing)
- [x] **Phase 7** — Review context store organization and audio integration
- [x] **Phase 8** — Review management GUI layout and functionality
- [x] **Phase 9** — Test full Docker deployment, verify multi-user support

## External API Setup (Optional)

- [ ] **Set API_TOKEN** — Generate a strong random token and add `API_TOKEN=<token>` to `.env`. Leave empty to disable the external API. Required for n8n integration.

## n8n Integration (Optional)

- [ ] **Install n8n** — Run n8n on the same machine as PAS. See [n8n docs](https://docs.n8n.io/hosting/).
- [ ] **Configure dispatch URL** — Add `n8n: { dispatch_url: "http://localhost:5678/webhook/pas-dispatch" }` to `config/pas.yaml`. Leave empty for internal execution (default).
- [ ] **Create n8n receiver workflow** — Import or create a workflow that receives PAS dispatch webhooks and calls the appropriate PAS API endpoints. See `docs/n8n-integration.md` for details.
- [ ] **Test dispatch** — Verify that reports/alerts fire via n8n by checking n8n execution history. PAS falls back to internal execution if n8n is unavailable.

## Multi-Provider LLM Setup (Optional)

- [ ] **Google AI API key** — Get from aistudio.google.com, add `GOOGLE_AI_API_KEY` to `.env`
- [ ] **OpenAI API key** — Get from platform.openai.com, add `OPENAI_API_KEY` to `.env`
- [ ] **Additional providers** — Add OpenAI-compatible endpoints in `config/pas.yaml` under `llm.providers`

## Multi-Provider LLM Phase Reviews

- [x] **Phase 10** — Review provider abstraction types and client implementations
- [x] **Phase 11** — Review configuration system and model discovery
- [x] **Phase 12** — Review LLM service rewrite and backward compatibility
- [x] **Phase 13** — Review safeguards (rate limits, cost caps, audit logging)
- [x] **Phase 14** — Review GUI updates for multi-provider management
- [x] **Phase 15** — Review integration, migration path, and documentation

## App Sharing Phase Reviews

- [x] **Phase 16** — Review chatbot fallback app (conversational AI as default handler)
- [x] **Phase 17** — Review app packaging standard, install CLI, static analysis, and compatibility checks
- [x] **Phase 18** — Review app developer documentation and scaffold template

## Technical Debt

- [x] **Clean up stale compiled files in `src/` directories** — Deleted 801 stale files, added `.gitignore` patterns to prevent recurrence. Lint errors dropped from 424 to 1 (pre-existing).

## Testing TODO

- [ ] **Test Google/OpenAI/Ollama providers** — Once API keys are available, add integration tests for `GoogleProvider`, `OpenAICompatibleProvider`, and `OllamaProvider` (REQ-LLM-021 in URS). Currently only `AnthropicProvider` has dedicated tests.

## App Ecosystem (Future)

- [ ] **Host an app registry** — Create a static JSON index file (GitHub Pages or personal server) listing available apps. Not needed until 10+ apps exist.
- [ ] **Define review process** — Establish community review criteria for the `reviewed` trust level. Not needed until friends are actively sharing apps.
- [x] **Credential scoping** — `SecretsService` added to CoreServices. Apps declare `requirements.external_apis` in manifest and access via `services.secrets.get(id)`. Infrastructure reads env vars from host environment.

## After Deployment

- [x] **Register your Telegram user ID** in `config/pas.yaml` — User ID configured
- [ ] **Set the webhook URL** — Configure the Telegram bot webhook to point to your Cloudflare Tunnel URL. Not needed for local dev (polling mode).
- [ ] **Pull the Ollama model** — `docker compose exec ollama ollama pull llama3.2:3b` (optional — system works without Ollama)
- [x] **Choose a GUI auth token** — Set in `.env` (change `pas-local-dev-token-change-me` to something strong for production)
