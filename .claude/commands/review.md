---
description: "Review code changes for errors, security, UX quality, and test coverage"
allowed-tools: [Read, Glob, Grep, Bash, Agent]
---

# Code Review

You are reviewing code changes in the PAS (Personal Automation System) project. Perform a thorough review covering all areas below.

## 1. Get the Diff

Run `git diff HEAD~1` (or the appropriate range if told) to see all changes. Read modified files in full for context.

## 2. Code Review Checklist

### Logical Errors & Correctness
- Off-by-one errors, wrong comparisons, missing null checks
- Incorrect async/await usage, unhandled promise rejections
- State mutations that could cause race conditions
- Backward compatibility breaks in existing APIs

### Security (OWASP + PAS-specific)
- **Prompt injection**: All user content passed to LLM prompts MUST use `sanitizeInput()` with anti-instruction framing and backtick delimiters
- **Path traversal**: File paths from user input validated against safe patterns (`SAFE_SEGMENT`, `resolve-within` checks)
- **XSS**: htmx partials use `escapeHtml()` on all dynamic content; `hx-vals` uses escaped JSON
- **Input validation**: userId, appId, spaceId validated against patterns before use
- **CSRF**: All GUI POST routes protected by double-submit cookie
- **Timing attacks**: Secret comparisons use `timingSafeEqual()`

### UX Quality (Wife-Friendly Standard)
- Dropdowns and selections instead of requiring users to type exact IDs or titles
- Natural language labels ("Send a Telegram message" not "telegram_message")
- Helpful placeholder text and examples in form fields
- Error messages that tell users what to do, not what went wrong technically
- No pasting of requirement IDs, config keys, or technical strings

### Architecture Compliance
- Apps use `CoreServices` via DI, never import banned packages directly
- LLM access through `services.llm`, not SDK imports
- Data access through `ScopedDataStore`, not raw `fs`
- Events through `EventBus`, not direct coupling

## 3. Test Coverage Review

After reviewing code, check that all new/modified functionality has tests across these categories:

| Category | What to Check |
|----------|--------------|
| **Happy path** | Normal usage, expected inputs, correct behavior |
| **Edge cases** | Empty inputs, boundary values, zero, max values, off-by-one |
| **Error handling** | Invalid inputs, thrown exceptions, malformed data |
| **Security** | Injection attempts, path traversal, unauthorized access |
| **Concurrency** | Race conditions, cooldown windows, timeout behavior |
| **State transitions** | Reset after success, re-enable after disable, idempotency |
| **Configuration** | Defaults, overrides, invalid config, missing optional values |

## 4. URS Verification

Check `docs/urs.md`:
- New requirements added for new functionality (status: Implemented)
- Test references point to actual test names in actual test files
- Traceability matrix rows added with correct std/edge counts
- Matrix totals updated
- Any bug fixes have `**Fixes:**` entries on affected requirements

## 5. Report Format

Present findings as:

### Critical Issues (must fix)
- Security vulnerabilities, data loss risks, logical errors

### Important Issues (should fix)
- Missing test categories, URS gaps, UX problems

### Minor Issues (nice to fix)
- Style, naming, minor improvements

### Positive Observations
- Good patterns worth noting
