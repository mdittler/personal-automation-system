---
name: pas-security-posture
description: PAS security patterns and posture. Invoke when touching auth, cookies, LLM prompts, templates, file paths, or API endpoints.
---

# PAS Security Posture

Use this as a checklist when making changes in any of these areas: auth/sessions, cookie handling, LLM prompt construction, Eta templates or htmx partials, file path handling, API endpoints, or app install.

## Auth & Sessions
- Per-user password login with `sessionVersion` invalidation — stale sessions rejected on next request
- Cookie shape: `{userId, sessionVersion, issuedAt}`, signed, 24h sliding session
- Legacy `GUI_AUTH_TOKEN` accepted **only** when exactly one `isAdmin` user exists
- Per-userId login rate limiter (5/15min) + per-IP limiter. Telegram (20/60s), API (100/60s)
- `timingSafeEqual` for all secret comparisons

## Cookie Security
- `pas_auth` and `pas_csrf` cookies: `secure: true` in production (`NODE_ENV=production` or `GUI_SECURE_COOKIES=true`)
- Auth guard reissues cookies with current policy on every request (upgrades pre-hardening cookies)
- Apply secure flag to: login `setCookie`, logout `clearCookie`, invalid-auth `clearCookie`, CSRF `setCookie`

## CSRF
- Double-submit cookie pattern on all GUI POSTs
- CSRF validation runs in `preHandler` hook (not `onRequest`)
- Add CSRF tokens to every new form — it's easy to miss on new routes

## LLM Prompt Injection
- `sanitizeInput()` + backtick neutralization + anti-instruction framing on all user-content-to-LLM surfaces
- Sanitize before injecting into system prompts, data context, and classifier inputs
- Model IDs never go in LLM prompts

## XSS (Templates & htmx)
- Eta `<%= %>` auto-escapes — safe for template variables
- htmx partials returned via handler: use `escapeHtml()` manually
- `hx-vals` attributes: double quotes with HTML-escaped JSON
- Inline `onclick` with untrusted data is **banned** — use `data-*` attributes + delegated listener in `layout.eta`
- `safeJsonForScript()` for inline `<script>` JSON embeds
- File picker `target` query param: validate against `^[A-Za-z0-9_-]+$`

## Path Traversal
- `SAFE_SEGMENT` validation on all path segments before use
- `resolve-within` checks on all file operations
- userId/appId/spaceId: pattern-validate before use (`^[a-zA-Z0-9_-]+$`)
- `realpath` containment checks in EditService and DataQueryService

## API Keys
- Per-user API keys: scrypt-hashed secret in `data/system/api-keys.yaml` (mode 0600)
- Token format: `pas_<keyId>_<secret>` — server-side only, never in LLM prompts
- Per-user scope enforcement, `lastUsedAt` debounced 60s, `expiresAt`/`revokedAt` checked at verify time

## App Install
- Static analysis for banned LLM SDK imports (`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`)
- Symlink detection, manifest size limits, reserved ID protection
- `trustProxy` configurable via `TRUST_PROXY=true`
