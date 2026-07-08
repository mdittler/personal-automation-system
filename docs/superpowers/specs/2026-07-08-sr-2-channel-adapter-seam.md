# SR-2 — Channel Adapter Seam — Design

**Date:** 2026-07-08
**Status:** Proposed (design pass — the hard gate before T5.notes; no code in this phase).
Fable-authored + Codex-reviewed (high effort) + Fable-revised 2026-07-08. The Codex
review found 1 Critical (the inbound union missed the live core-owned callback
namespaces `rv:`/`onboard:`/`sc:` and left `answerCallbackQuery` ack underspecified —
reworked to a normalized `button-callback` event + core `CallbackNamespaceRouter` +
explicit `acknowledgeCallback`), 3 Major (the `MessengerService` stub dropped the legacy
`sendWithButtons`/`editMessage` compat shapes → Stage 0 would break; persistent buttons
lacked an app-ownership/namespace contract; the InteractionBroker was keyed on `userId`
only, not the full conversation scope), and 1 Minor (a blast-radius count that included
`apps/**/dist/**`), all resolved.
**Design/interface-stub only — implementation is a future PAS phase.**
**Author:** Fable 5 (strategic-design pass)
**Source analyses:** `docs/superpowers/plans/2026-07-07-fable-strategic-review.md` §SR-2
(issues `CHA-1..CHA-4`, open questions) and the SR-2 entries in `docs/open-items.md`
(Confirmed Phases + Master Execution Order gate 3) and `docs/implementation-phases.md`
("SR-2 — Channel Abstraction Seam").
**Companion interface stub:** `docs/superpowers/specs/channel-adapter.interface.ts`
(a labeled PROPOSAL — declarations only, never compiled into core).
**Companion design (coherence):** `docs/superpowers/specs/2026-07-07-sr-1-app-isolation-trust-model.md`
(SR-1 — the capability-vocabulary approach this design's descriptor follows, and §8 Q7,
which this design answers in §10).

> **Epistemic markers.** Every claim below is tagged. **[grounded]** = read directly
> from the current code (file path cited). **[inference]** = a design conclusion drawn
> from grounded facts; not yet verified against a running build. **[decision]** = an
> opinionated call this design makes for the implementing phases to accept, amend, or
> reject. Nothing here is wired into production; the interface stub is a **proposal**,
> not a live `core/src/types/` file.

---

## 1. Problem and the gate this unblocks

PAS's messaging substrate *is* Telegram; other channels cannot be added without forking
core **[grounded — strategic review §SR-2 CHA-1..CHA-3]**:

- Every app's public surface names Telegram types: `handleMessage(ctx: MessageContext)`,
  `handlePhoto(ctx: PhotoContext)`, `handleCallbackQuery(data, ctx: CallbackContext)`
  (`core/src/types/app-module.ts:67-91`), where `MessageContext` carries Telegram-native
  `chatId: number` / `messageId: number` (`core/src/types/telegram.ts:88-91`), and
  `CoreServices.telegram: TelegramService` is a first-class named dependency
  (`app-module.ts:122`) **[grounded, CHA-1]**. The blast radius is real: 453
  `.telegram.` member accesses across the three apps (echo/food/notes), 53
  `sendWithButtons` call-site tokens, and **9** source files importing the context
  types (grep scope: `apps/{echo,food,notes}/src/**/*.ts`, excluding `*test*` and the
  compiled `apps/**/dist/**` `.d.ts` output — an earlier "16" wrongly counted `dist`)
  **[grounded — repo grep, 2026-07-08]**.
- Rich-message capabilities are Telegram-shaped: inline keyboards
  (`sendWithButtons`, `sendOptions`), 64-byte `callbackData`
  (`telegram.ts:133`), photo `Buffer`s, message editing. Nothing expresses what a
  channel can or cannot do **[grounded, CHA-2]**.
- Telegram constants are baked into shared send paths: the 4000-char split budget
  (`reply-buffer.ts:33` `DEFAULT_MAX_LENGTH = 4000`), the 3800-char conversation split
  (`telegram-format.ts:23` `splitTelegramMessage(text, maxLength = 3800)`), a third
  independent 4000 in `alert-executor.ts:39` (`MAX_TELEGRAM_LENGTH`), a fourth in
  `report-formatter.ts:65`, and the legacy-Markdown escape set
  (`utils/escape-markdown.ts:9`) **[grounded, CHA-3]**.
- **Timing (CHA-4):** T5 (#12–17 in the Master Execution Order) rewrites every app's
  handler surface anyway. The order is confirmed as **hard gate 3**: *"SR-2 interface
  before T5.notes (#12) so each T5 app slice migrates once"* (`docs/open-items.md:18`;
  Track B sequence `…#11 T4 → SR-2 interface → #12–17 T5.*`, `docs/open-items.md:27`)
  **[grounded]**. Landing the seam after T5 means touching all apps twice — the same
  "built once or built twice" class as SR-1.

**Scope of this pass.** Design + interface stub only. No TypeScript in `core/src/`, no
edits to live types or manifests, no worktree. The implementing phase builds
`TelegramChannelAdapter` as the **only** implementation with **byte-identical behavior,
verified by the existing suite** (the SR-2 scope's own acceptance criterion,
`docs/implementation-phases.md:3892`). Non-goals, restated from the confirmed phase
entry: **no second channel, no GUI-chat channel, no change to Telegram-id-based GUI
identity** **[grounded]**.

---

## 2. The layer model — where the seam actually cuts

**[grounded]** The current outbound stack, top to bottom:

```
app code
  └─ CoreServices.telegram          (manifest-gated injection, compose-runtime.ts:825)
      └─ ContextAwareTelegramService (context-aware.ts — routes send() through
      │                               requestContext.replyBuffer when one is active)
      └─ BufferingTelegramProxy      (reply-buffer.ts — multi-intent buffering; rich
      │                               sends flush first; editMessage bypasses)
      └─ TelegramServiceImpl         (services/telegram/index.ts — grammY calls,
                                      parse_mode, sendOptions pending-map, timeouts)
```

**[decision] The seam is TWO interfaces, not one.** The single biggest design risk in
"a `ChannelAdapter` interface" is conflating what *apps* call with what *channels*
implement. They have different change pressures:

1. **`MessengerService` (northbound, app-facing).** The ergonomic surface apps program
   against — today's `TelegramService` shape, kept signature-compatible during
   migration (§9). Implemented **once, in core**, generically over any adapter. All
   policy layers (context-aware routing, buffering, SR-1's reply-scoping wrapper) wrap
   *this* surface.
2. **`ChannelAdapter` (southbound, transport-facing).** The minimal contract a
   Discord/Matrix/web contributor implements: `send` / `sendRich` / `edit` plus a
   static `ChannelDescriptor` and an inbound event stream. Everything channel-generic —
   option-prompt correlation, buffering, splitting, per-user fan-out — stays **out** of
   the adapter, so a new channel is a leaf, not a fork.

**[inference]** This split is what makes "Telegram becomes the reference implementation
rather than the substrate" true: `TelegramServiceImpl` today mixes transport (grammY
calls) with channel-generic interaction state (the `pending` options map,
`index.ts:34`). The seam moves the transport into `TelegramChannelAdapter` and the
interaction state into a core `InteractionBroker` (§7); the ergonomic method family
survives unchanged above both.

The target stack:

```
app code
  └─ CoreServices.telegram / .messenger   (same instance, dual-keyed — §9)
      └─ [SR-1 Tier A reply-scoping wrapper — future, wraps here]
      └─ ContextAwareMessengerService      (rename only; logic unchanged)
      └─ BufferingMessengerProxy           (channel-GENERIC; policy-parameterized — §6)
      └─ MessengerCore                     (generic: userId→delivery resolution,
      │                                     InteractionBroker, split/escape via policy)
      └─ ChannelAdapter                    (leaf transport; Telegram = grammY)
```

---

## 3. The `ChannelAdapter` interface (send-side contract)

**[decision]** The adapter surface (full declarations in the companion stub):

```ts
interface ChannelAdapter {
	readonly descriptor: ChannelDescriptor;              // static — §4
	send(recipient: NativeRecipientId, text: OutboundText): Promise<void>;
	sendRich(recipient: NativeRecipientId, payload: RichPayload): Promise<ChannelMessageRef>;
	edit(ref: ChannelMessageRef, patch: EditPatch): Promise<void>;
}
```

- **`NativeRecipientId`** is a branded string — the channel's own addressee handle. For
  Telegram it is the stringified numeric user id (`String(ctx.from.id)`), which is
  **also** the PAS user id today (`message-adapter.ts:16-19` **[grounded]**). The
  generic layer owns the `userId → { adapter, recipient }` resolution point
  (`resolveDelivery`); in SR-2 that resolution is the identity function onto the single
  Telegram adapter **[decision]** — multi-channel user bindings are explicitly deferred
  (§12 Q2, per the non-goal on Telegram-id GUI identity).
- **`send`** carries pre-rendered text whose length is already within
  `descriptor.maxMessageLength` — splitting is the generic layer's job (§6), never the
  adapter's. `OutboundText` carries the text plus a `markup` application flag (§8),
  because Telegram applies `parse_mode: 'Markdown'` on plain sends (`index.ts:44-46`)
  but **not** on photo captions or option prompts (`index.ts:56-58, 81-83`;
  `handle-edit.ts:62` "plain text — sendOptions does not render Markdown")
  **[grounded]** — a byte-identical trap if the flag were global.
- **`sendRich`** takes a discriminated union rather than one method per rich kind
  **[decision]**:

  ```ts
  type RichPayload =
  	| { kind: 'photo'; data: Uint8Array; caption?: string }
  	| { kind: 'buttons'; text: OutboundText; buttons: ButtonSpec[][] }
  	| { kind: 'prompt'; text: string; choices: PromptChoice[]; token: InteractionToken };
  ```

  Rationale: an adapter author implements **one** method with an exhaustive `switch`,
  and the compiler (`never` check) forces every new payload kind to be either handled
  or explicitly refused per the descriptor — versus three-and-growing optional methods
  whose absence is only discovered at runtime. The three kinds are exactly the rich
  sends the buffering proxy already special-cases as a family
  (`reply-buffer.ts:5-7` "Rich sends (`sendPhoto`/`sendWithButtons`/`sendOptions`)
  implicitly flush") **[grounded]** — the union codifies an existing seam.
  `sendRich` always returns a `ChannelMessageRef` (Telegram: `{chatId, messageId}` ≙
  today's `SentMessage`, `telegram.ts:137-140`); `sendPhoto`'s current `void` return is
  preserved at the `MessengerService` layer, and the ref for `prompt` is consumed
  internally by the broker (§7).
- **`edit`** replaces `editMessage(chatId, messageId, …)` with a ref-addressed patch.
  Contract obligations lifted from the current implementation **[grounded]**: the
  adapter MUST map the channel's "nothing changed" rejection to success (Telegram's
  `message is not modified` swallow, `index.ts:150-152`), and `edit` is
  order-independent — it must never route through any send buffer
  (REQ-ROUTE-019b; `reply-buffer.ts:74-84`, `context-aware.ts:46-55`).
- **Errors [decision]:** an adapter asked to do something its descriptor says it cannot
  (`sendRich({kind:'buttons'})` on a no-buttons channel that the generic layer failed
  to degrade) throws a typed `ChannelCapabilityError` — fail-loud, mirroring the
  orchestrator's hostile-input stance. Transport failures propagate as-is (today's
  behavior: log + rethrow, `index.ts:47-50`).
- **Inbound** is part of the adapter contract but not of the send-side trio: the
  adapter converts native updates into `InboundEvent`s (§5) and hands them to a core
  sink (`ChannelInboundSink`). Telegram's grammY middleware + webhook plumbing
  (`compose-runtime.ts` section 11, `bootstrap.ts` dispatch sites) becomes the
  adapter's private wiring **[inference]**.

---

## 4. Capability descriptor — the static-vs-runtime crux

**[decision] Everything in the SR-2 descriptor is STATIC. No runtime negotiation
machinery ships in this phase.**

The test applied to every candidate field: *is its value a protocol constant of the
channel, or does it vary per conversation/workspace at runtime?* Every constant
Telegram actually needs today is in the first class **[grounded]**:

| Field | Telegram value | Grounded in |
|---|---|---|
| `id` | `'telegram'` | — |
| `markup` | `'telegram-markdown'` (legacy dialect) | `parse_mode: 'Markdown'`, `index.ts:45`; escape set `escape-markdown.ts:9` |
| `maxMessageLength` | `4000` (the enforced outbound budget; hard cap 4096 with headroom "for Markdown escapes and trailing whitespace") | `reply-buffer.ts:26-33` |
| `supportsButtons` | `true` | `sendWithButtons`, `index.ts:100` |
| `buttonDataLimitBytes` | `64` | `telegram.ts:133` "max 64 bytes (Telegram limit)" |
| `interaction` | `'native-buttons'` | `sendOptions` inline keyboard, `index.ts:70-97` |
| `supportsPhoto` | `true` | `sendPhoto`, `index.ts:54` |
| `supportsEdit` | `true` | `editMessage`, `index.ts:126` |

None of these vary at runtime for Telegram — they are Bot API constants. The cases
that *would* need runtime negotiation (a Discord guild's thread features, a Matrix
room's encryption, a Slack workspace's plan limits) belong to channels PAS has
deliberately not built (non-goal: "no second channel") **[inference]**. Building a
negotiation protocol now would be speculative machinery with zero grounded consumers —
exactly the kind of unexercised code path the byte-identical acceptance criterion
cannot verify.

**The additive escape valve [decision]:** when a second channel genuinely needs
per-conversation capabilities, the extension is an *optional* adapter method
(`describeRecipient?(recipient): Promise<Partial<ChannelDescriptor>>`) overlaying the
static descriptor. Adding an optional method later is non-breaking for the Telegram
adapter and for every descriptor consumer (which must already handle the static
baseline). This design **names** that path and deliberately does **not** declare it in
the stub — an optional method nobody implements or calls is dead contract surface that
a reviewer must nonetheless reason about.

**Vocabulary coherence with SR-1 [decision]:** descriptor fields are *facts about a
channel*, so they are plain readonly fields — they are **not** SR-1 capabilities
(*permissions an app requests*). The two vocabularies meet in one place: SR-1's
`messaging:*` capability tokens gate *who may call* the messenger; the descriptor
gates *what the channel can render*. Keeping them disjoint avoids the dual-surface
drift SR-1 §2.1 exists to prevent — no descriptor field is ever spelled as a manifest
capability token, and vice versa.

---

## 5. Channel-neutral `InboundMessage` and the escape hatch

**[decision]** The adapter→core envelope (the type the *router* consumes; app-facing
contexts derive from it, §9):

```ts
interface InboundMessage {
	channel: { id: ChannelId; native: unknown };  // the escape hatch
	userId: string;            // PAS user id (post identity-resolution; == native id today)
	conversationId: string;    // neutral conversation key (Telegram: String(chatId))
	messageRef: ChannelMessageRef;
	timestamp: Date;
	content: InboundContent;
}

type InboundContent =
	| { kind: 'text'; text: string }
	| { kind: 'photo'; data: Uint8Array; caption?: string; mimeType: string }
	// A NORMALIZED button/component tap — adapter emits the raw payload; core classifies.
	| { kind: 'button-callback'; rawData: string; ackId: CallbackAckId };
```

**[decision — Codex Critical, corrected] The adapter does NOT classify callback
namespaces; it emits one normalized `button-callback` event and CORE classifies.** The
first draft's union (`choice` for `opt:` + `app-callback` for `app:`) was *falsely
grounded*: it enumerated only two of the **five** live callback namespaces on the wire
today **[grounded]** —

| Namespace | Meaning | Owner | Grounded in |
|---|---|---|---|
| `rv:<id>:<appId>` | route-verifier disambiguation tap | core | `route-verifier.ts:301`; routed `compose-runtime.ts:1450` |
| `onboard:<...>` | first-run-wizard digest opt-in | core | `first-run-wizard.ts:113,183` |
| `sc:yes\|sc:no:<id>` | session-control new-chat confirm | core | `router/index.ts:1892` |
| `app:<appId>:<data>` | app-owned persistent button | app | `compose-runtime.ts:1566` |
| `opt:<nonce>:<i>` | ephemeral broker prompt answer | core (broker) | `telegram/index.ts:70-97` |

A union of `choice`+`app-callback` has **no way to carry `rv:`/`onboard:`/`sc:`** except
by bypassing the adapter or smuggling them through `channel.native` — which breaks the
seam at exactly the callback path. The corrected model:

- The adapter emits `{ kind: 'button-callback', rawData, ackId }` — the **raw** callback
  payload string, verbatim, plus a native ack handle. The adapter stays
  **namespace-agnostic** (a Discord adapter emits the same shape from a component
  interaction).
- Core owns a **`CallbackNamespaceRouter`** that `classify`s `rawData` by registered
  prefix in a **fixed total precedence order** (`rv:` → `onboard:` → `sc:` → `app:` →
  `opt:` → `unhandled`), producing a `CallbackClassification` the existing handlers
  consume: the `app` case parses `appId`+app-portion data and dispatches
  `handleCallbackQuery`; the `prompt` (`opt:`) case parses token+choice and calls the
  InteractionBroker; `rv:`/`onboard:`/`sc:` route to their core handlers. **This is
  where PAS callback semantics live — a new core namespace registers here and every
  channel gains it for free; a new channel needs zero namespace knowledge.**
  **[decision]**
- **Callback acknowledgement is explicit, not leaked through `native`
  [decision — Codex Critical]:** the event carries an opaque `ackId` (Telegram: the
  `callback_query.id`), and `ChannelAdapter.acknowledgeCallback(ackId, { text? })` is a
  first-class method. Core preserves today's contract exactly: auto-ack once in a
  `finally` unless a handler already answered with custom toast text
  (`compose-runtime.ts:1439-1462,1605-1607` — `answeredCallback` + the disabled-app
  `answerCallbackQuery({ text })`) **[grounded]**. `answerCallbackQuery` no longer
  appears in `channel.native`.
- **What the escape hatch carries now [decision]:** with the ack handle promoted to
  `ackId`, `channel.native` for Telegram narrows to
  `{ chatId: number; messageId: number }` — the reply-targeting fields today's contexts
  consume (`MessageContext.chatId/messageId`, `telegram.ts:88-91`; `CallbackContext`,
  `telegram.ts:143-147`) **[grounded]**. Rule unchanged: the escape hatch is for **core
  plumbing and the compat alias only**; an *app* reading `channel.native` is a migration
  smell the T6b gate flags (§9). It is typed `unknown`, not a generic parameter —
  consumers narrow through a per-channel guard, keeping hostile-input discipline at the
  boundary.
- **`mimeType`** stays: Telegram always converts photos to JPEG
  (`message-adapter.ts:78`) **[grounded]**, other channels won't.
- **Router metadata (`route`, `sessionKey`, `spaceId`, …) is NOT in `InboundMessage`**
  **[decision]**: those fields are stamped by the router *after* the adapter hands the
  message over (`telegram.ts:92-103` documents them as router-populated). The neutral
  envelope is what the adapter can honestly produce; enrichment stays a router concern.

---

## 6. Splitting `BufferingTelegramProxy`: generic proxy + Telegram policy object

**[grounded]** `BufferingTelegramProxy` (`reply-buffer.ts`) is already 90%
channel-generic: per-user segment buffers, clear-before-send double-emit protection
(REQ-ROUTE-021, `reply-buffer.ts:88-90`), rich-send flush-first, edit bypass
(REQ-ROUTE-019b), and `packSegments` — which takes `maxLength` as a parameter and has
no Telegram knowledge at all (`reply-buffer.ts:108-134`). The Telegram-ness is two
constants (`DEFAULT_MAX_LENGTH = 4000`, `SEGMENT_SEPARATOR = '\n\n'`) and the identity
of `inner`.

**[decision] The seam: the proxy owns WHEN, the policy owns HOW.**

- **`BufferingMessengerProxy` (channel-generic, mechanical rename + parameterization):**
  owns the *ordering* semantics — what buffers, what flushes first, what bypasses, and
  the cleared-before-send guarantee. These are REQ-ROUTE-017/018/019/019b/020/021
  behaviors and are channel-independent claims about message *ordering*, not message
  *shape*. Constructor takes `{ inner: MessengerService; policy: ChannelSendPolicy }`.
- **`ChannelSendPolicy` (per-channel, Telegram is the first):** owns the *rendering*
  rules —

  ```ts
  interface ChannelSendPolicy {
  	readonly descriptor: ChannelDescriptor;
  	readonly segmentSeparator: string;                    // telegram: '\n\n'
  	pack(segments: readonly string[]): string[];          // packSegments @ maxMessageLength
  	split(text: string): string[];                        // splitTelegramMessage semantics
  	escapeInterpolated(text: string): string;             // escapeMarkdown
  	degradeMarkup(text: string): string;                  // stripMarkdown (parse-fail fallback)
  }
  ```

  `TelegramSendPolicy` composes the existing pure functions unchanged: `packSegments`
  (default impl is fine for any channel — it is exported and unit-tested), the
  paragraph→line→hard split of `splitTelegramMessage` (`telegram-format.ts:23-58`),
  `escapeMarkdown` (`escape-markdown.ts`), and `stripMarkdown` + the send-retry
  fallback of `sendSplitResponse` (`telegram-format.ts:79-98`) **[grounded]**.
- **Two split budgets exist today** — 4000 in the buffer, 3800 in
  `splitTelegramMessage` **[grounded]**. Byte-identical means the policy carries
  **both** (`pack` at 4000, `split` at 3800) in the implementing phase; unifying them
  is a behavior change deferred to a follow-up (§12 Q5). Do not "clean this up" inside
  SR-2 — it would silently change message boundaries and break the byte-identical
  verifier **[decision]**.
- **Constant-consolidation inventory** for the implementing phase: `reply-buffer.ts:33`,
  `telegram-format.ts:23`, `alert-executor.ts:36-39` (`MAX_DATA_LENGTH`,
  `MAX_TELEGRAM_LENGTH`), `report-formatter.ts:65` — all become reads of
  `policy.descriptor.maxMessageLength` / `policy.split` **[grounded inventory,
  decision]**. `api/routes/messages.ts:19` and `api/routes/telegram.ts:15` (4096
  request-validation caps) are HTTP-API input limits, not channel rendering — leave
  them **[decision]**.
- The recursion invariant survives the rename **[grounded → decision]**: the proxy's
  `inner` MUST be the real (unwrapped) service (`reply-buffer.ts:11-15` Codex Round 1
  #3); the generic design keeps the same two-handle composition in `compose-runtime`.

---

## 7. THE hard question, answered: does promise-returning `sendOptions` generalize?

**[grounded — what the pattern actually is]** `sendOptions(userId, prompt, options)`
returns `Promise<string>`: it sends an inline keyboard whose buttons carry
`opt:<nonce>:<i>`, parks a resolver in a `pending` map keyed by nonce, rejects after a
5-minute timeout, verifies the tapping user matches the asking user, and resolves with
the selected option's text on callback (`index.ts:70-97, 162-199`).

**[decision] Yes, it generalizes — because it was never a channel primitive.** Decompose
it and the channel-specific part almost vanishes:

1. **Correlation state** (nonce mint, pending map, single-shot resolve, 5-min timeout,
   scope-match check) — pure interaction bookkeeping with zero Telegram content. This
   moves into a core **`InteractionBroker`**, generic across channels. (Evidence it is
   misplaced today: it lives in `TelegramServiceImpl` yet never touches grammY state.)
2. **Prompt rendering** — the only channel-specific part. The broker asks the adapter
   to render `{kind:'prompt', choices, token}`; the Telegram adapter renders an inline
   keyboard with token-encoded callback data (today's wire format, unchanged).
3. **Answer ingestion** — the adapter emits the normalized `button-callback` event; core's
   `CallbackNamespaceRouter` classifies the `opt:` prefix to the `prompt` case
   (token+choiceId) and calls `broker.resolveChoice(inbound, token, choiceId)`, which
   resolves the parked promise **only if the full scope matches** (below).

**[decision — Codex Major, corrected] Prompts are keyed by the FULL conversation scope,
not `userId` alone.** The first draft's broker took `promptChoice(userId, …)` and
`resolveChoice(token, choiceId, fromUserId)`. Today that is safe *because the Telegram
adapter is 1:1 user↔chat*, but the moment a second channel or a group/workspace
conversation exists, a reply from the **same user in a different conversation** could
satisfy the wrong parked prompt. The corrected API keys every prompt by a
**`PromptScope { channelId, conversationId, userId }`** plus the token: `promptChoice`
captures the scope; `resolveChoice(inbound, token, choiceId)` consumes the full
`InboundMessage` and binds only when `channelId + conversationId + userId + token` all
match (else log-and-ignore, today's tolerance). The numbered-reply interceptor is armed
against the **same `PromptScope`**, so a numbered reply from another conversation cannot
answer it either.

**Degradation for channels without inline buttons [decision]:** the descriptor's
`interaction` field is a **three-value mode, not a boolean** — that is the answer to
the strategic review's "async-interaction capability flag" framing:

- `'native-buttons'` (Telegram): render natively; answers arrive as choice events.
- `'numbered-reply'` (SMS/plain channels): the **generic layer** — not the adapter, not
  the app — renders the prompt as a numbered list via plain `send` and registers a
  transient reply-interceptor with the broker, **scoped to the same `PromptScope`**: the
  *next* inbound text matching that channel+conversation+user that parses as a valid
  choice number (or exact label match) resolves the promise; anything else falls through
  to normal routing and the prompt stays pending until timeout. The app still just
  `await`s a string.
- `'none'` (one-way channels): `promptChoice` rejects immediately with
  `ChannelCapabilityError`. **[inference]** This is honest, not a cop-out: a channel
  that cannot receive *any* user input cannot answer a question by definition — no
  flag or fallback changes that, and apps already handle `sendOptions` rejection
  (timeout) today (`handle-edit.ts:96` treats timeout/throw as cancel **[grounded]**).

So the app-visible contract — *"await a choice, get a string or a rejection"* — is
channel-universal; only the rendering degrades. **No app code changes to stay
portable**, which is the property that makes T5 migration cheap.

**The sharper half of the question is `sendWithButtons`, and it does NOT get automatic
degradation [decision].** `sendOptions` is an *ephemeral, single-shot, core-owned*
interaction; `sendWithButtons` creates *persistent, app-owned* interactive messages —
food's voting keyboards live for days, carry app-defined `callbackData`, and are
re-edited over time (53 call-site tokens in apps **[grounded]**). On a no-buttons
channel there is no honest automatic mapping: a numbered-reply interceptor cannot stay
armed for days without hijacking normal routing, and `callbackData` semantics are the
app's, not core's. Therefore: `supportsButtons` is the descriptor field apps (or their
core-side feature gates) consult; calling `sendButtons` on a `supportsButtons: false`
channel throws `ChannelCapabilityError` — **fail-explicit, never silent text-dump**.
The two patterns get different contracts because they *are* different patterns; the
strategic review's single open question was hiding two questions, and collapsing them
into one flag would have produced a lie on one side or the other.

**[decision — Codex Major] Persistent buttons carry an app-ownership contract: the
messenger is APP-SCOPED and stamps the `app:<appId>:` namespace, and the byte limit is
on the ENCODED payload.** Today apps hand-write the full `app:<appId>:...` prefix into
`callbackData` themselves (`guest-add-flow.ts:92`, `food/src/index.ts:1425`,
`cook-mode.ts:123` **[grounded]**) — so if neutral apps stop writing Telegram prefixes,
the inbound `app`-namespace classification (§5) has no `appId` to route on. The
contract that closes this:

- **`CoreServices.messenger`/`.telegram` is a per-app instance** bound to the app's id
  (core already injects per-app-filtered service objects, `compose-runtime.ts:825`
  **[grounded]**). The neutral `sendButtons` stamps `app:<thisAppId>:` onto each
  `ButtonSpec.data` automatically; the app writes only its own raw portion. On the
  inbound side the `CallbackNamespaceRouter` parses the same prefix back to `appId` +
  app-portion — the identity that was implicit in hand-written strings is now
  core-owned and channel-portable.
- **The 64-byte `buttonDataLimitBytes` is validated on the FINAL ENCODED bytes** —
  after core prepends `app:<appId>:` (or the broker's `opt:<nonce>:` for prompts), not
  on the app's raw data. An app's usable budget is `64 − len(prefix)`. This matches
  reality: today apps burn the prefix out of their own 64 budget (`callbackData` "max
  64 bytes", `telegram.ts:133` **[grounded]**); moving the stamp into core just moves
  where the accounting happens, and core must reject an over-budget *encoded* string
  loudly rather than let Telegram 400 at send time.
- **Stage-0 compat is byte-identical:** the legacy `sendWithButtons(userId, text,
  InlineButton[][])` passes `callbackData` through **verbatim** (apps keep writing full
  `app:...` strings), so no existing app or live keyboard changes. Prefix-stamping is a
  property of the **neutral** `sendButtons` that apps opt into per T5 slice (§9).

Timeout stays broker-owned and channel-independent (`OPTIONS_TIMEOUT_MS`,
`index.ts:15`), overridable per call — grounded need: handle-edit's confirm flow
already documents the timeout as part of its contract **[grounded]**.

---

## 8. The authoring-markup decision (CHA-3's second half)

**[grounded]** App- and core-authored message text is written in Telegram legacy
Markdown today: `*bold*`, `_italic_`, backticks, `[links](url)` — with
`escapeMarkdown` escaping exactly that dialect's control set (`escape-markdown.ts:4-9`)
and `parse_mode: 'Markdown'` applied on `send`/`sendWithButtons`/`editMessage` but
**not** on photo captions or `sendOptions` prompts (`index.ts`, §3).

**[decision]** The neutral contract freezes the **authoring dialect** as exactly this
existing subset — call it *PAS message markup* — rather than introducing a portable
AST or a new neutral syntax. Each channel's `ChannelSendPolicy` translates authoring
markup → native rendering; for Telegram that translation is the **identity function**
(which is what makes byte-identical achievable at zero risk). A future Discord policy
transforms (`*b*` → `**b**`); a plain channel applies `degradeMarkup`. Rationale: all
existing app text is already written in this dialect; re-authoring hundreds of strings
or building an AST renderer is exactly the second-channel work SR-2's non-goals
exclude. The cost — the "neutral" dialect is Telegram-flavored — is acknowledged and
accepted; it is a *rendering input format*, and only policies ever interpret it.
`OutboundText` carries `markup: 'authored' | 'plain'` so the per-call-site parse-mode
asymmetry (§3) is explicit in the type instead of implicit in which method you called.

---

## 9. `MessageContext` compat alias — migration story vs. the T5 slices

**[decision]** Three stages, aligned to the Master Execution Order (SR-2 interface →
T5.notes → T5.food.* → T6a → T6b):

**Stage 0 — SR-2 implementing phase (zero app edits, suite byte-identical).**
- New neutral types land in `core/src/types/channel.ts` (per the stub).
- `MessageContext` / `PhotoContext` / `CallbackContext` are **redefined in place** to
  add one optional field — `channel?: { id: ChannelId; native: unknown }` — populated
  by the Telegram adapter's context construction. Every existing field keeps its exact
  name, type, and optionality, so all 9 app source files and every test compile and
  behave unchanged **[grounded field inventory: `telegram.ts:81-147`]**.
  `chatId`/`messageId` become doc-annotated `@deprecated — read via channel.native /
  messageRef` but remain populated.
- `TelegramService` becomes an alias for the app-facing `MessengerService`, which
  **carries today's legacy methods with their EXACT signatures — including
  `sendWithButtons(userId, text, InlineButton[][]): Promise<SentMessage>` and
  `editMessage(chatId, messageId, text, buttons?): Promise<void>` (`telegram.ts:150-172`)
  — alongside** the neutral additions (`sendButtons` returning `ChannelMessageRef`,
  `edit(ref, …)`). This is a Codex-review correction: an earlier stub declared only the
  neutral methods, which would have broken every existing `sendWithButtons`/`editMessage`
  caller and test on day one; the companion stub now declares both surfaces (with legacy
  `InlineButton`/`SentMessage` types reproduced verbatim). The legacy numeric
  `editMessage` is implemented by wrapping `(chatId, messageId)` into a Telegram-native
  ref — one core-side shim, no caller changes **[decision]**.
- `CoreServices` gains `messenger` as a **dual key to the same instance** as
  `telegram` (`compose-runtime.ts:825` injects one object either way). The manifest
  `requirements.services` enum is **not** touched in SR-2 — renaming the manifest
  token is SR-1/T2a's capability-surface migration (SR-1 §2.1), and doing it here
  would create the exact dual-surface drift SR-1 forbids **[decision — coherence]**.

**Stage 1 — each T5.x slice (per-app, already touching every handler).** The slice
moves that app's handlers to the neutral context/service names, replaces
`chatId`/`messageId` reads with `messageRef`, and switches `services.telegram` →
`services.messenger`. Because each T5 slice already rewrites the app's intent surface
into tools, the channel migration rides along at near-zero marginal cost — this is
CHA-4's entire point and the reason for hard gate 3 **[grounded]**.

**Stage 2 — T6b cleanup (the enforcement gate).** A build-failing check (mirroring the
existing doc-coverage gate pattern) asserts no `apps/**` file references the deprecated
fields, the `telegram` service key, or `channel.native`; the compat alias narrows to
core-internal use or is deleted. Until Stage 2 runs, the alias is a **supported**
surface, not a tolerated one — no app is ever broken mid-track **[decision]**.

**Fallback (accepted in open-items):** if T5 starts before SR-2's implementing phase is
planned, Stage 0+1 fold into T6b — worse (double-touch) but explicitly sanctioned
(`docs/open-items.md:18`) **[grounded]**.

---

## 10. Coherence with SR-1 (and the answer to SR-1 §8 Q7)

- **Layering order [decision]:** SR-1's Tier A reply-scoped messenger wraps the
  app-facing `MessengerService` (the northbound surface), **above** the
  context-aware/buffering proxies and far above `ChannelAdapter`. Capability
  enforcement (who may send, to whom) is SR-1's; rendering capability (what the channel
  can show) is SR-2's. The stack diagram in §2 fixes the wrap point so the two
  implementing phases don't fight over it.
- **SR-1 §8 Q7 asked whether Tier C's CoreServices-RPC boundary should reuse the
  ChannelAdapter seam. Answer: NO — they are orthogonal, by direction and by trust.**
  `ChannelAdapter` is a *southbound, core-internal* seam between trusted core layers
  (core ↔ transport); the Tier C RPC boundary is a *northbound, trust-crossing* seam
  (untrusted app ↔ core). Reusing one for the other would couple a hostile boundary to
  a friendly one. What SR-2 *does* contribute to Tier C: the app-facing
  `MessengerService` surface stays small, promise-based, and free of channel-native
  types (post-Stage-1 apps hold `ChannelMessageRef`s as opaque values, not raw
  `chatId` numbers) — which is precisely the property that makes it cheap to express
  as RPC later. Design the surfaces aware of each other; do not merge them
  **[decision]**.
- **Vocabulary fit:** descriptor fields are channel facts, SR-1 capabilities are app
  permissions; disjoint by construction (§4). If a future channel needs a
  permission-shaped concept (e.g. an app allowed to use a specific channel), it is
  spelled as an SR-1 manifest capability (`messaging:channel:<id>` or similar), never
  as a descriptor field **[decision]**.

---

## 11. Byte-identical traps (implementing-phase checklist)

The acceptance criterion is "byte-identical behavior, existing suite is the verifier."
These are the places a well-meaning refactor would silently change bytes
**[grounded inventory]**:

1. **Parse-mode asymmetry:** `send`/`sendWithButtons`/`editMessage` use
   `parse_mode: 'Markdown'`; `sendPhoto` captions and `sendOptions` prompts are plain
   (`index.ts:44, 56, 81, 116, 146`). Carried by `OutboundText.markup` + payload-kind
   rendering rules (§3, §8).
2. **`message is not modified` swallow** on edit (`index.ts:150-152`) — adapter
   contract obligation, must be tested at the adapter boundary.
3. **Buffer clear-before-send** (REQ-ROUTE-021, `reply-buffer.ts:88-90`) and
   **edit-bypasses-buffer** (REQ-ROUTE-019b) — proxy semantics, unchanged by the
   rename.
4. **One-button-per-row layout** in `sendOptions` (`index.ts:74-78`) vs. caller-shaped
   rows in `sendWithButtons` — the prompt payload must preserve the one-per-row
   rendering.
5. **Scope verification + invalid-index tolerance** in option callbacks
   (`index.ts:180-192`) — moves to the broker verbatim (same-user check widened to the
   full `PromptScope`, §7), including the log-and-ignore (never throw) posture.
6. **Two split budgets** (4000 pack vs. 3800 split, §6) — carried as-is, not unified.
7. **ALL FIVE callback wire prefixes** — `rv:` (`route-verifier.ts:301`), `onboard:`
   (`first-run-wizard.ts:113`), `sc:` (`router/index.ts:1892`), `app:`
   (`compose-runtime.ts:1566`), `opt:` (`index.ts:71-75`) — the Telegram adapter emits
   them as raw `button-callback.rawData` and core's `CallbackNamespaceRouter` classifies
   them in fixed precedence (§5), preserved exactly (live keyboards in users' chats
   predate the refactor and must keep resolving). A missing namespace = a dead button.
7b. **Callback ack**: auto-ack once in `finally` unless a handler answered with toast
   text (`compose-runtime.ts:1439-1462,1605-1607`) — becomes
   `adapter.acknowledgeCallback(ackId, {text?})`, same one-ack-per-tap semantics,
   best-effort swallow.
8. **Markdown-parse-failure fallback**: split-chunk send retries as stripped plain text
   (`telegram-format.ts:86-96`) — becomes `policy.degradeMarkup` + generic retry,
   same trigger, same output.
9. **5-minute options timeout** and rejection message (`index.ts:14-15, 90-93`);
   `cleanup()` rejection on shutdown (`index.ts:201-208`).

---

## 12. Open questions for the implementing phase

1. **Inbound sink wiring vs. `compose-runtime` section 11.** The design splits today's
   callback-query handler (~`compose-runtime.ts:1439-1608`): transport (grammY update →
   `button-callback` event + `ackId`) moves into the Telegram adapter, while namespace
   classification, app-toggle checks, `requestContext.run` scoping, and the
   auto-ack-in-`finally` bookkeeping stay **core-side** in the `CallbackNamespaceRouter`
   + handlers. The `rv:`/`onboard:`/`sc:` handlers currently inlined in that function
   (and in `router`/`onboarding` modules) must be registered as core namespace handlers
   without behavior change. Exactly where the sink handoff sits and how `answeredCallback`
   maps to a single `acknowledgeCallback` call needs a line-level plan against the real
   function body before coding.
2. **`resolveDelivery` beyond identity.** SR-2 hardcodes userId→Telegram. When a second
   channel exists, per-user channel *bindings* (and per-message reply-to-origin
   routing) become an identity-model question adjacent to the GUI-identity non-goal.
   Park it; name the single resolution point so it has one home.
3. **Numbered-reply interceptor precedence.** For `'numbered-reply'` channels the
   broker must see inbound text *before* the router classifies it. The interception
   point (router pre-hook vs. adapter-side) is unexercisable until a second channel
   exists — specify the contract (broker consulted first; non-matching text falls
   through) but defer the wiring. Risk: this is the one §7 claim the byte-identical
   suite cannot verify.
4. **Photo payloads as `Uint8Array` vs. `Buffer`.** The stub uses `Uint8Array` (Buffer
   extends it) to keep the contract Node-agnostic; SR-1 §4.2 separately wants
   large binaries passed as AttachmentStore *references* across the Tier C boundary.
   Decide in the implementing phase whether `RichPayload.photo` should carry
   `data | attachmentRef` union from day one or add the ref member when T2b lands.
5. **Unifying the 4000/3800 split budgets** (§6) — a deliberate post-SR-2 behavior
   change with its own (small) phase or a rider on T6b, verified by updating the
   affected snapshot expectations knowingly.
6. **Does `ChannelSendPolicy.pack` subsume `split`?** `packSegments` and
   `splitTelegramMessage` overlap (~80%) but differ in boundary preference and budgets
   **[grounded]**. Byte-identical says keep both behaviors; the implementing phase
   should decide whether they are two methods of one policy (this design's default) or
   whether `split` becomes `pack([text])` after Q5 lands.
7. **`sendOptions` prompt markup.** Today prompts render plain (§3). Should the neutral
   `prompt` payload ever allow authored markup (Telegram would support it via
   parse_mode)? Default: no — byte-identical first; revisit only with a concrete need.
8. **URS registration.** Proposed area `REQ-CHANNEL-*` (per the confirmed phase entry);
   the implementing phase registers requirements for: descriptor truthfulness, the
   ephemeral-vs-persistent interaction contracts (§7), escape-hatch usage rules (§5),
   the **`CallbackNamespaceRouter` precedence + total coverage of all five namespaces**
   and the **`acknowledgeCallback` one-ack-per-tap** contract (§5), the
   **`PromptScope` binding** (§7), the **app-scoped prefix-stamp + encoded-byte-limit**
   (§7), and the byte-identical checklist (§11) as testable requirements.
9. **`CallbackNamespaceRouter` registry vs. app-toggle interplay.** Today the `app:`
   path re-checks `appToggle.isEnabled` before dispatch and the disabled case emits a
   custom-text ack (`compose-runtime.ts:1450-1462`). Decide whether that gate lives in
   the `app`-namespace handler (recommended — keeps the router pure classification) or
   in the router itself, and how a disabled-app tap's toast ack is expressed through
   `acknowledgeCallback`.

---

## 13. Deferred-work note

Per CLAUDE.md's deferred-work rule, the work this design *specifies but does not
implement* — the neutral types + `TelegramChannelAdapter` + `InteractionBroker` +
`CallbackNamespaceRouter` + policy/proxy split (SR-2's implementing phase), the Stage 1
per-app migrations (ride T5.x), the Stage 2 enforcement gate + alias removal (T6b), and
open questions Q1–Q9 —
is tracked under the existing SR-2 entries in `docs/open-items.md` (Confirmed Phases +
Master Execution Order) and `docs/implementation-phases.md` ("SR-2 — Channel
Abstraction Seam"). This design pass adds no *new* deferred item beyond those entries;
it answers the open question they carried (the `sendOptions` await-tap generalization,
§7) and fixes the interface so T5.notes can gate on it.
