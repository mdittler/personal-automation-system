# Route Verification Service Design

## Context

The PAS message router classifies free-text messages and photo captions against app intents using a fast-tier LLM. When confidence is moderate (grey zone), misroutes can occur because the classifier only sees intent strings without app descriptions or broader context. A post-classification verification step with richer context can catch these errors before the message reaches the wrong app.

The user is the authoritative voice when there's a disagreement between classifier and verifier.

## Overview

A `RouteVerifier` service that runs after the initial classifier returns a grey-zone confidence result. It makes a second LLM call (standard tier) with richer context — app names, descriptions, and all candidate intents — to confirm or challenge the classification. On disagreement, inline keyboard buttons let the user choose the correct app. The message is held until the user responds.

All grey-zone classifications are logged to a verification log for future analysis and intent tuning.

## Core Flow

1. Message arrives -> Router classifies via IntentClassifier (fast tier, unchanged)
2. Confidence in grey zone (default 0.4-0.7) -> trigger verification
3. Verifier LLM call (standard tier) with rich context -> agrees or disagrees
4. **Agrees**: route normally, log entry to verification log (for performance analysis)
5. **Disagrees**: send inline keyboard, hold message indefinitely until user responds
6. **User taps button**: dispatch to chosen app, log the full outcome

Commands (`/command`) skip verification entirely — exact matches have no ambiguity.

## Components

### RouteVerifier

**File:** `core/src/services/router/route-verifier.ts`

**Dependencies:** LLMService, AppRegistry, Logger

**Interface:**

```typescript
interface VerificationContext {
  originalText: string;                    // user message or photo caption
  classifierResult: {
    appId: string;
    intent: string;
    confidence: number;
  };
  candidateApps: Array<{
    appId: string;
    appName: string;
    appDescription: string;
    intents: string[];
  }>;
}

interface VerificationResult {
  agrees: boolean;
  suggestedAppId?: string;     // set only when disagrees
  suggestedIntent?: string;    // the verifier's pick
  reasoning?: string;          // brief LLM explanation
}
```

**Verification prompt** — richer than the classifier prompt:
- The user's original message text (sanitized)
- The classifier's pick: app name, matched intent, confidence score
- All candidate apps with name, description, and intent lists
- Instruction: "Given this message and the routing decision, does the classification seem correct? If not, which app and intent is the better fit? Respond as JSON: `{\"agrees\": true/false, \"suggestedAppId\": \"...\", \"suggestedIntent\": \"...\", \"reasoning\": \"...\"}`"

**LLM tier:** Standard (not fast) — needs better reasoning for the richer context. Uses `SystemLLMGuard` since this is an infrastructure call.

### PendingVerificationStore

**File:** `core/src/services/router/pending-verification-store.ts`

**Purpose:** In-memory store for messages awaiting user verification response.

```typescript
interface PendingMessage {
  id: string;                              // unique ID for callback routing
  ctx: MessageContext | PhotoContext;       // original message context
  isPhoto: boolean;
  classifierResult: {
    appId: string;
    intent: string;
    confidence: number;
  };
  verifierResult: VerificationResult;
  timestamp: Date;
  photoPath?: string;                      // saved photo path for reproducibility
}
```

**Storage:** In-memory `Map<string, PendingMessage>`. Transient — lost on restart. Acceptable because restarts are rare and users can resend.

**ID generation:** Short unique ID (e.g., nanoid) that fits in Telegram's 64-byte callback data limit.

### Inline Keyboard

When the verifier disagrees, the router sends an inline keyboard via `telegram.sendWithButtons()`:

```
"I'm not sure where to send this. Which app should handle it?"

[Food]  [Notes]  [Chatbot]
```

**Buttons include:**
- The classifier's pick (app name)
- The verifier's suggestion (app name)
- "Chatbot" as an escape hatch

**Callback data format:** `rv:<pendingId>:<appId>` where `rv` = route-verify prefix

The buttons remain active indefinitely — no timeout. The message is held until the user taps.

### Callback Handler

**Location:** New handler in `core/src/bootstrap.ts` callback_query:data listener, alongside existing `app:` prefix handler.

**Flow:**
1. Parse `rv:<pendingId>:<appId>` from callback data
2. Look up pending message by ID
3. Dispatch to chosen app (or chatbot fallback if appId is "chatbot")
4. Remove from pending store
5. Log outcome to verification log
6. Edit the keyboard message to show the choice was made (remove buttons, update text)

### Verification Log

**File:** `data/system/route-verification-log.md`

**Photo storage:** `data/system/route-verification/photos/<timestamp>-<userId>.jpg`

**Format:** Markdown with YAML frontmatter (Obsidian-compatible), append-only:

```markdown
---
title: Route Verification Log
type: system-log
---

## 2026-04-08 14:32:05

- **Message**: "I want to add chicken to the list"
- **Type**: text
- **User**: 12345
- **Classifier**: food (confidence: 0.55, intent: "user wants to add items to the grocery list")
- **Verifier**: food (agrees)
- **Outcome**: routed to food (auto)

## 2026-04-08 15:10:22

- **Message**: "save this for later"
- **Type**: photo
- **Photo**: [2026-04-08-151022-12345.jpg](route-verification/photos/2026-04-08-151022-12345.jpg)
- **User**: 12345
- **Classifier**: notes (confidence: 0.45, intent: "save a note")
- **Verifier**: food (disagrees, intent: "photo of a recipe to save")
- **User choice**: food
- **Outcome**: routed to food (user override)
```

**Fields per entry:**
- Timestamp, user ID, message text (or caption for photos)
- Message type (text/photo), relative photo path if applicable
- Classifier result: app, confidence, matched intent
- Verifier result: agrees/disagrees, suggested app + intent if different
- User choice (only when verifier disagreed)
- Final outcome: `auto` (verifier agreed) or `user override` (user picked)

## Integration Points

### Router Changes (`core/src/services/router/index.ts`)

- `RouterOptions` gains: `routeVerifier?: RouteVerifier`, `pendingStore?: PendingVerificationStore`, `verificationUpperBound?: number`
- After `intentClassifier.classify()` returns a match with confidence in the grey zone (>= threshold AND < upper bound), call `routeVerifier.verify()`
- If verifier agrees: dispatch normally
- If verifier disagrees: send inline buttons, store in pending store, return (do not dispatch)
- Same pattern added to `routePhoto()` for photo messages with captions in the grey zone

### Bootstrap Changes (`core/src/bootstrap.ts`)

- Create `RouteVerifier` and `PendingVerificationStore` instances
- Inject into Router constructor
- Add `rv:` prefix handler in `callback_query:data` listener
- Create `VerificationLogger` for log writes

### Configuration (`config/pas.yaml`)

```yaml
routing:
  verification:
    enabled: true
    upper_bound: 0.7
```

- `enabled`: toggle verification on/off without removing code
- `upper_bound`: confidence above this skips verification (high-confidence routes)
- Lower bound is implicitly the existing `confidenceThreshold` (default 0.4) — messages below that go to fallback anyway, so no separate config needed

### SystemConfig Type Changes (`core/src/types/config.ts`)

Add routing verification config to SystemConfig type.

## Files to Create

| File | Purpose |
|------|---------|
| `core/src/services/router/route-verifier.ts` | RouteVerifier service |
| `core/src/services/router/pending-verification-store.ts` | In-memory pending message store |
| `core/src/services/router/verification-logger.ts` | Verification log writer |
| `core/src/services/router/__tests__/route-verifier.test.ts` | RouteVerifier unit tests |
| `core/src/services/router/__tests__/pending-verification-store.test.ts` | PendingVerificationStore unit tests |
| `core/src/services/router/__tests__/verification-logger.test.ts` | VerificationLogger unit tests |
| `core/src/services/router/__tests__/router-verification.test.ts` | Router integration tests for verification flow |

## Files to Modify

| File | Change |
|------|--------|
| `core/src/services/router/index.ts` | Grey-zone check, verifier call, hold logic, photo verification |
| `core/src/services/llm/prompt-templates.ts` | Add `buildVerificationPrompt()` |
| `core/src/bootstrap.ts` | Wire RouteVerifier, PendingVerificationStore, `rv:` callback handler |
| `core/src/types/config.ts` | Add verification config to SystemConfig |
| `core/src/services/config/index.ts` | Parse verification config from pas.yaml |
| `config/pas.yaml` | Add routing.verification section |

## Verification Plan

1. **Unit tests**: RouteVerifier with mocked LLM — test prompt construction, response parsing (agrees, disagrees, malformed response)
2. **Unit tests**: PendingVerificationStore — add, retrieve, remove, retrieve-missing
3. **Unit tests**: VerificationLogger — log entry formatting, photo path references
4. **Integration tests**: Router with verification enabled — grey-zone triggers verifier, high-confidence skips, verifier agrees dispatches, verifier disagrees holds
5. **Integration tests**: Callback handling — user taps button, message dispatched, pending removed, log written
6. **Manual test**: Send ambiguous messages via Telegram, verify inline buttons appear, tap buttons, check verification log
