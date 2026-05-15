---
name: pas-app-system
description: PAS app system — manifests, distribution, install-time trust model, message routing priority, route verification. Invoke when working with app manifests, the installer, the router, or app-to-core boundaries.
---

# PAS App System

Use this when changing manifest schema, the app installer, the router dispatch order, or the trust model between apps and core.

## Manifests

Apps declare themselves via `manifest.yaml`, validated against `core/src/schemas/app-manifest.schema.json`. The manifest declares:

- **Identity** — id, name, version
- **Capabilities** — intents, commands, photos, schedules, rules, events
- **Requirements** — services the app needs (`llm`, `data`, etc.)
- **User config** — per-user settings exposed in the GUI

## Distribution

Apps are standalone git repos. `pas install <git-url>`:

1. Clones the repo to a staging area
2. Validates the manifest
3. Scans the source for banned imports (LLM SDKs — see the `pas-llm-architecture` skill)
4. Checks `pas_core_version` compatibility
5. Moves the app into `apps/<id>/` and links it into the workspace

## Trust model

- **Install-time static analysis** catches accidental violations of the LLM SDK ban and other policy rules
- **No runtime sandbox** — this is documented honestly. PAS is local-first and trusts the operator to not install hostile apps
- **DI enforcement** — services not declared in the manifest's `requirements` are `undefined` at runtime; apps cannot reach for capabilities they didn't ask for
- **Scoped data** — `DataStore.forUser` / `forSpace` paths are namespace-prefixed, preventing path traversal between apps or users

## Message routing priority

The router dispatches in this order. Each step has an "escape" path that lets the next step run if it fires.

1. **`/command` exact match** — built-in router commands (e.g. `/newchat`, `/recall`, `/refreshmemory`) and app-declared `command` handlers
2. **Photo classification** — when the message contains a photo, classify which photo handler should receive it
3. **Free-text LLM classification** — apps that declare `intents` get an LLM classifier that maps the message to one of their intents (with a `"none"` escape that allows step 4)
4. **Chatbot fallback** — full conversational AI handles whatever none of the above claimed

## Route verification

Enabled by default. Grey-zone classifications (confidence in `0.4–0.7`) trigger a second LLM call (standard tier) that re-evaluates against descriptions of all candidate apps. On disagreement between the original classifier and the verifier, the user picks the correct app via inline Telegram buttons. Disable with `routing.verification.enabled: false` in `pas.yaml`.

## Shadow classifier (food app)

The food app's shadow classifier is a long-running A/B framework, not a routing primitive. Production flip from regex-primary to shadow-primary is gated on REQ-REG-011 routing accuracy ≥ 0.95 in the regression suite, with `pnpm analyze-shadow-log` providing supplementary live-traffic signal.
