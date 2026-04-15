# LLM Enhancement Opportunities Plan

## Summary

PAS already has a strong LLM substrate: provider abstraction, model tiers, cost and rate guards, route verification, DataQuery, `/edit`, vision-assisted parsing, meal planning, summaries, and several Food intelligence flows. The main remaining gap is uneven application of that intelligence. Core routing can already classify app and intent, but that route metadata is not carried into app handlers, so some apps still reconstruct intent with ordered regexes, keyword gates, and local heuristics.

The goal of this plan is not to replace every parser with an LLM. It is to use fast, structured LLM calls where human language is ambiguous, then keep deterministic code for exact protocols, storage boundaries, and validation.

## Highest-Value Opportunities

### 1. Pass Route Metadata Into App Handlers

The core `IntentClassifier` already returns `appId`, `intent`, and `confidence`, and route verification can further validate the selected destination. That information should be preserved on message/photo context when app handlers are invoked.

Expected benefits:

- Reuse an LLM decision the system has already paid for.
- Reduce duplicate app-level regex routing.
- Make app handlers more consistent with manifest-declared intents.
- Give downstream handlers confidence and provenance for routing decisions.

Recommended shape:

- Add optional route metadata to handler context, such as app id, intent id, confidence, verifier status, and source.
- Let app handlers prefer high-confidence route metadata.
- Keep current local predicates as fallback while the new path is shadowed and tested.

### 2. Replace Food's Internal Regex Router With A Fast Structured Classifier

The Food app has a long ordered predicate chain for grocery, pantry, freezer, leftovers, waste, price, nutrition, calendar, receipt, meal planning, hosting, and other flows. This makes behavior sensitive to ordering and phrasing, especially as new food capabilities are added.

A fast-tier structured classifier should return an action, confidence, and extracted entities. Commands, callback payloads, pending flows, and exact validators should still run deterministically before this classifier.

Recommended output shape:

```json
{
  "action": "add_grocery_item",
  "confidence": 0.91,
  "entities": {
    "items": ["milk"],
    "quantity": "1 gallon",
    "store": null
  }
}
```

Expected benefits:

- Better handling of paraphrases and multi-intent messages.
- Less brittleness from regex ordering.
- Easier addition of new Food actions.
- Cleaner analytics for intent misses and low-confidence messages.

### 3. Use LLMs For Ambiguous Extraction, Not Just Classification

Many current flows are good candidates for hybrid extraction. Keep deterministic parsing for obvious structured inputs, but call a fast structured extractor when the text is messy, conversational, or incomplete.

Good candidates:

- Grocery item names, quantities, package sizes, store hints, and categories.
- Pantry/freezer additions and removals with natural phrasing.
- Leftover descriptions, age, container notes, and intended use.
- Waste logging with reason, amount, and avoidability.
- Price and receipt line items where OCR or text is uncertain.
- Nutrition logs where serving size, meal period, or item identity is ambiguous.

Expected benefits:

- Fewer "I did not understand" paths.
- Better correction flows when users speak naturally.
- Cleaner downstream data without requiring command-like phrasing.

### 4. Remove Keyword Gates Around DataQuery

DataQuery is already an LLM-backed natural-language data access layer, but some entry points still use keyword overlap or small keyword lists before allowing a query to reach it. That can miss synonyms, pronouns, entity aliases, and context-dependent follow-ups.

Recommended approach:

- Replace keyword gates with a fast structured query planner.
- Return target app, data type, entity hints, date range, and confidence.
- Use deterministic index narrowing after planning.
- Use the LLM only for file selection or answer synthesis when deterministic narrowing is insufficient.

Expected benefits:

- Better support for questions like "what did we pay there last time?" or "show the stuff from Costco."
- Less dependence on hand-maintained synonym lists.
- More consistent access to app data through Telegram.

### 5. Replace Chatbot System-Data Keyword Categorization

The chatbot still uses keyword categories to decide which system data should be gathered for user questions. That can under-include relevant context or over-include noisy context.

Recommended approach:

- Add a fast structured selector for system-data categories.
- Have it choose among model, cost, scheduler, app registry, route, data-query, and user/space context.
- Keep deterministic safety limits on what data can be included.

Expected benefits:

- Better answers with smaller prompts.
- Lower chance of missing the relevant operational context.
- Easier future expansion as more system observability is added.

### 6. Improve Knowledge And Context Retrieval

AppKnowledge and ContextStore searches still rely heavily on keyword matching and first-N style selection. These are reasonable baselines, but they can miss semantically relevant matches when the wording differs.

Recommended approach:

- Use deterministic filtering to produce a small candidate set.
- Add a fast LLM selector or reranker over those candidates.
- Prefer structured outputs that explain which records were selected and why.

Expected benefits:

- More useful app help and system answers.
- Better follow-up continuity.
- Less prompt bloat from irrelevant context.

### 7. Make Photo Caption Routing Confidence-Based

Food photo handling uses caption regexes before vision classification to save cost. That is useful, but it can preempt better image-aware classification when the caption is ambiguous.

Recommended approach:

- Use caption-only routing when confidence is high.
- Combine caption plus image classification when confidence is low or conflicting.
- Log caption/vision disagreements for later tuning.

Expected benefits:

- Preserve cost savings for obvious captions.
- Improve receipt, pantry, meal, and nutrition photo handling.
- Create feedback data for routing improvements.

## Deterministic Boundaries

Regexes, parsers, and explicit validators should remain the default for exact formats and protocol-like inputs. These are not LLM opportunities unless the user-facing language is ambiguous.

Keep deterministic handling for:

- IDs, slugs, path segments, and archive names.
- Callback payloads and Telegram command syntax.
- Model IDs, app IDs, job IDs, and config keys.
- Date tokens when an exact parser is required.
- Cron-like schedules and timers.
- Exact numeric validation, units normalization, and bounds checks.
- YAML, JSON, Markdown frontmatter, and file-format parsing.
- Schema validation and type guards for LLM outputs.
- Path containment, realpath checks, and security decisions.
- Markdown cleanup or escaping that enforces Telegram formatting constraints.

The guiding rule: LLMs should interpret human intent and ambiguous text; deterministic code should enforce contracts.

## Agentic AI Opportunities

### Routing-Learning Agent

Periodically review route verification logs, fallback help responses, user corrections, and low-confidence messages. Produce proposed intent examples, prompt changes, classifier tests, or manifest updates for human review.

### Data Steward Agent

Inspect indexed app data for missing frontmatter, stale entity keys, inconsistent canonical names, corrupt sidecars, or records that cannot be read or corrected through Telegram. Propose safe `/edit` changes instead of silently mutating data.

### Receipt And OCR QA Agent

Review receipt and OCR outputs against known stores, price history, product categories, and plausible item names. Flag suspicious extractions, ask for correction when confidence is low, and learn store-specific cleanup patterns.

### Household Planning Agent

Combine meal plans, pantry/freezer/leftovers, prices, cultural calendar, ratings, waste logs, nutrition targets, and household preferences into proactive weekly suggestions. This should be advisory by default and should ask before changing plans or lists.

### Ops Agent

Summarize failed jobs, LLM cost anomalies, slow workflows, rate-limit pressure, route-verification disagreements, and recurring fallback messages into an admin digest. Include suggested fixes and links to relevant logs or files.

### App Onboarding And Review Agent

When an app is installed or enabled for a space, inspect its manifest, docs, commands, data stores, and scheduled jobs. Generate a capability summary, suggested setup questions, recommended automations, and data access gaps.

## Recommended Implementation Order

1. Add optional routing metadata to `MessageContext` and photo context, and pass verifier-confirmed intent and confidence through router dispatch.
2. Update Food handlers to prefer high-confidence routed intent metadata while keeping existing regex predicates as fallback.
3. Add a Food fast-tier structured classifier in shadow mode and log disagreements with the existing router.
4. Add structured extractors for messy Food text inputs, beginning with grocery, pantry/freezer, leftovers, waste, prices, and nutrition.
5. Replace chatbot system-data keyword categorization with a fast structured selector.
6. Replace AppKnowledge and ContextStore keyword-only selection with deterministic candidate generation plus fast LLM reranking.
7. Replace DataQuery keyword gates with a fast structured query planner.
8. Make photo caption routing confidence-based and log caption/vision disagreements.
9. Add agentic loops only after routing, extraction, and retrieval foundations have useful logs and stable structured outputs.

## Acceptance Criteria

- Existing commands, callback flows, pending flows, and exact validators continue to behave deterministically.
- App handlers receive optional route metadata without breaking existing app interfaces.
- Food natural-language tests cover paraphrases, action collisions, low-confidence fallbacks, and multi-entity messages.
- Shadow-mode logs show agreement and disagreement between the regex router and fast structured classifier before any switch-over.
- DataQuery tests include synonym, alias, context-follow-up, and no-keyword-overlap queries.
- System-data selection tests confirm smaller prompts still include the needed operational context.
- Knowledge/context retrieval tests cover semantically similar wording that does not share keywords.
- Photo routing tests cover caption-only, vision-only, and caption/vision disagreement cases.
- Cost and rate-limit tests confirm fast-tier calls are attributed to the correct app/user and degrade safely.
- Agentic features propose, summarize, or notify by default; they do not silently mutate user data.

## Assumptions

- "Fast LLM" means the configured fast tier, low token caps, low temperature, structured outputs, and graceful fallback.
- The objective is higher usefulness and lower maintenance burden, not replacing every regex.
- Local-first storage, privacy, cost controls, and explicit confirmation for risky edits remain core constraints.
- Implementation should proceed incrementally, with shadow mode and logs before behavior changes.
