# User Actions

Items that require manual action from the system owner. These cannot be automated.
Development open items (deferred phases, corrections, proposals) are tracked in `docs/open-items.md`.

---

## Before First Run

- [x] **Create a Telegram Bot** — @YourBotName created via BotFather
- [x] **Get an Anthropic API key** — Added to `.env`
- [ ] **Set up Cloudflare Tunnel** — Install `cloudflared` and create a tunnel pointing to the Fastify server port (default 3000). Not needed for local dev (polling mode works without a tunnel).
- [x] **Copy `.env.example` to `.env`** — Created with bot token and dev defaults.
- [ ] **Install Docker and Docker Compose V2** — Only needed for production deployment, not local dev

## Optional Setup

- [ ] **Google Calendar API** — Create a Google Cloud project, enable Calendar API, create OAuth credentials (needed for calendar-dependent features)
- [ ] **Weather API key** — Sign up at [OpenWeatherMap](https://openweathermap.org/api) for a free API key (needed for weather-dependent features)
- [ ] **Configure Google Home speakers** — Note the device names for Chromecast casting configuration
- [ ] **Set API_TOKEN** — Generate a strong random token and add `API_TOKEN=<token>` to `.env`. Leave empty to disable the external API. Required for n8n integration.

## Multi-Provider LLM Setup (Optional)

- [ ] **Google AI API key** — Get from aistudio.google.com, add `GOOGLE_AI_API_KEY` to `.env`
- [ ] **OpenAI API key** — Get from platform.openai.com, add `OPENAI_API_KEY` to `.env`
- [ ] **Additional providers** — Add OpenAI-compatible endpoints in `config/pas.yaml` under `llm.providers`

## After Deployment

- [x] **Register your Telegram user ID** in `config/pas.yaml` — User ID configured
- [x] **Choose a GUI auth token** — Set in `.env`
- [ ] **Set the webhook URL** — Configure the Telegram bot webhook to point to your Cloudflare Tunnel URL. Not needed for local dev (polling mode).
- [ ] **Pull the Ollama model** — `docker compose exec ollama ollama pull llama3.2:3b` (optional — system works without Ollama)
