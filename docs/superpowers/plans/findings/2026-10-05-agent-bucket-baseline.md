# Agent bucket baseline on the pre-agent pipeline — 2026-10-06

## Purpose

This is the gate for Agent Runtime P4 (the cut-over, design §13.3). It records how the current pipeline (intent classifier, route verifier, chatbot fallback, Food regex cascade) scores on the 46-task outcome-graded `agent` bucket, for the local default model and for a frontier model pair. P4 must beat these numbers, per model config and per set, under the same `--no-cache` method (see *Gate*).

## Setup

- **Code SHA:** `406668b286f516e249db5323b6a09dc3b55f663f` for both runs. The local run executed at HEAD `4037228a4c09cfb0d19102367a6a7a4130149f78`, which is 406668b plus docs-only commits (evidence: `baseline-head.txt`); the frontier run executed at 406668b exactly (`baseline-frontier-head.txt`).
- **Build:** `pnpm build` was run before each baseline (plan Task 12 Step 0, review C4), so compiled `dist/` apps match the recorded SHA.
- **Date / wall clock (EDT, 2026-10-06):** frontier 02:37 to 02:58; local 02:40 to 04:02. The two ran concurrently.
- **Command (both):** `pnpm test:regression -- --bucket=agent --repeats=3 --model-matrix=<fast>,<standard> --no-manifest --no-cache --json` (`--no-cache` so no earlier verdict leaks in; review vote 1).
- **Local models:** `ollama/qwen3.8:27b-mlx` for fast and standard. repeats=3.
- **Frontier models:** fast `anthropic/claude-haiku-4-5-20251001`, standard `anthropic/claude-sonnet-5-5`. repeats=3.
- **Seed manifest SHA** (`shasum -a 256 regression/fixtures/agent/seed.sha256`): `418f5843f59740a99bcffccaa49fa984982f2a598610abab04614a0a4330db8d`.
- **Completeness gate (plan Step 3b):** met for both runs. No task ended `budget-exceeded`. The only `error` verdicts are the 3 local photo tasks, which are "not applicable: text-only provider" (`Provider ollama does not support vision`). The frontier run has 0 errors and 0 budget-exceeded.
- **Evidence files** (outside the repo): `/Users/mdittler/Projects/pas-q3-review-evidence/agent-baseline-local-final.{md,ndjson}` and `agent-baseline-frontier-final.{md,ndjson}`.
- **History (superseded, not the gate):**
  - A local run at a062159 (21 pass / 22 fail / 3 error; capability 9/25, regression 12/21) predates the review fixes (digit-boundary oracle, cache key) and is superseded.
  - A first frontier attempt stopped when the Anthropic credits ran out.
  - One attempt at 9e1c128 hung (review R6-1: worker never exited, fixed in 406668b) and was discarded.

## Results

### Local (qwen3.8:27b-mlx, fast + standard), 23 pass / 20 fail / 3 error, $0, total 4898 s, median trial 31.2 s

| metric | value |
|---|---|
| total cases | 46 |
| pass | 23 |
| fail | 20 |
| error | 3 |
| budget-exceeded | 0 |
| food-shadow inputs evaluated | 0 |
| routing accuracy (REQ-REG-011) | (below floor — fewer than 20 food-shadow inputs) |
| total cost (USD) | 0.000000 |
| total wall time (ms) | 4896056 |

### Agent bucket

| set | pass^k (tasks) | trial pass rate |
|---|---|---|
| capability | 11/25 | 36/75 |
| regression | 12/21 | 36/63 |

| category | pass^k (tasks) | trial pass rate |
|---|---|---|
| aggregation | 5/8 | 17/24 |
| injection | 3/3 | 9/9 |
| multi-turn | 0/3 | 0/9 |
| no-tool | 4/4 | 12/12 |
| out-of-distribution | 3/7 | 10/21 |
| photo | 0/3 | 0/9 |
| single-fact | 7/10 | 21/30 |
| write | 1/8 | 3/24 |

Median wall time per trial (includes worker start-up): 31.2 s

### Frontier (haiku-4-5 fast, sonnet-5-5 standard), 15 pass / 31 fail / 0 error, $2.38, total 1223 s, median trial 8.5 s

| metric | value |
|---|---|
| total cases | 46 |
| pass | 15 |
| fail | 31 |
| error | 0 |
| budget-exceeded | 0 |
| food-shadow inputs evaluated | 0 |
| routing accuracy (REQ-REG-011) | (below floor — fewer than 20 food-shadow inputs) |
| total cost (USD) | 2.378663 |
| total wall time (ms) | 1223352 |

### Agent bucket

| set | pass^k (tasks) | trial pass rate |
|---|---|---|
| capability | 8/25 | 26/75 |
| regression | 7/21 | 21/63 |

| category | pass^k (tasks) | trial pass rate |
|---|---|---|
| aggregation | 3/8 | 9/24 |
| injection | 0/3 | 0/9 |
| multi-turn | 0/3 | 0/9 |
| no-tool | 4/4 | 12/12 |
| out-of-distribution | 1/7 | 5/21 |
| photo | 3/3 | 9/9 |
| single-fact | 2/10 | 6/30 |
| write | 2/8 | 6/24 |

Median wall time per trial (includes worker start-up): 8.5 s

## Per-task failures

Each row is the first failing trial of a non-pass task: the oracle's detail string plus the first 120 characters of that trial's reply. "Trials pass" counts the 3 trials; a task passes (pass^3) only if all 3 pass.

### Local: non-pass tasks: 23

| id | category | set | verdict | first failing trial | reply excerpt (<=120 chars) |
|---|---|---|---|---|---|
| `agent-bananas-count` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "count" (11) | Based on your recent receipt history, you have bought a total of **6 bananas**.  This comes from your most recent Trader |
| `agent-cheapest-blueberries` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "store" (trader joe) | I have to be careful here because the memory context shows three separate price entries for blueberries, but they don't  |
| `agent-costco-most-items` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (88.36); missing fact "date" (2026-05-27) | Costco receipt (2026-09-09) - 4 items - Kirkland Coffee Beans 2.5lb: $19.49 - Strawberries 2lb: $6.29 - Rotisserie Chick |
| `agent-dinner-tonight` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "chickpea curry" (chickpea curry) | I don't have access to your specific meal plan or calendar to see what is scheduled for dinner tonight.  However, I can  |
| `agent-followup-grocery-add` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: data state: no items[].name matching /sourdough/i in households/agent-hh-0/shared/food/grocery/active.yaml | 🛒 Grocery List (4 items, 1 purchased)  🥬 *Produce* ✅ Bananas  🥛 *Dairy & Eggs* ☐ Oat Milk  🫙 *Pantry & Dry Goods* ☐ Gran |
| `agent-followup-previous-costco` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (111.36) | Based on the recent transcript, your most recent Costco trip was on **September 9, 2026**.  Here are the details from th |
| `agent-followup-wegmans-months` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (17.26) | Grocery spending by store: - Costco: avg $83.46 per trip across 4 trips (total $333.85, last 2026-09-09) - Trader Joe's: |
| `agent-grocery-add` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no items[].name matching /bread/i in households/agent-hh-0/shared/food/grocery/active.yaml; data state: no items[].name matching /egg/i in households/agent-hh-0/shared/food/groc | I cannot add items to your grocery list as I do not have write access to the data. However, based on the provided data,  |
| `agent-grocery-no-duplicate` | write | capability | fail (0/3 trials pass) | trial 1/3: data state: expected 1 items[].name matching /oat milk/i in households/agent-hh-0/shared/food/grocery/active.yaml, found 2 | Added 1 item(s): oat milk. |
| `agent-grocery-remove` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: items[].name matching /granola/i still present in households/agent-hh-0/shared/food/grocery/active.yaml | You can remove granola from your grocery list using the `/grocery` command. Since there isn't a specific "remove" subcom |
| `agent-items-costco-and-wegmans` | out-of-distribution | capability | fail (1/3 trials pass) | trial 1/3: missing fact "eggs" (egg) | Based on your receipts, the only item you bought at both Costco and Wegmans is:  *   **Organic Blueberries**     *   **C |
| `agent-most-expensive-item` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "price" (25.49) | Looking at your receipt history, the single most expensive item by unit price is:  **Kirkland Olive Oil 2L** — **$24.99/ |
| `agent-note-to-self` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no file matching households/agent-hh-0/users/agent-user-0/notes/daily-notes/*.md contains [plumber] | Noted. I can't directly create calendar events or reminders for you, but I can help you manage that information.  Would  |
| `agent-olive-oil-last-paid` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "price" (25.49) | Based on your receipt history, you last bought olive oil on **April 5, 2026** at **Costco**.  *   **Item:** Kirkland Oli |
| `agent-pantry-quinoa` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "says no" (any of: don't have, do not have, no quinoa, isn't, not in your pantry, don't see, not listed, no,) | Added 1 item(s) to pantry: Do I have any quinoa? |
| `agent-pantry-remove` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: items[].name matching /peanut butter/i still present in households/agent-hh-0/shared/food/pantry.yaml | "We used up the peanut butter — take it out of the pantry." wasn't in the pantry. |
| `agent-photo-question` | photo | capability | error (0/3 trials pass) | trial 1/3: provider error(s) during trial: ollama: Provider ollama does not support vision (image input) | Sorry, I had trouble processing that photo. Please try again or add a caption describing what it is (e.g. "save this rec |
| `agent-photo-receipt-costco` | photo | capability | error (0/3 trials pass) | trial 1/3: provider error(s) during trial: ollama: Provider ollama does not support vision (image input) | Sorry, I had trouble processing that photo. Please try again or add a caption describing what it is (e.g. "save this rec |
| `agent-photo-receipt-tj` | photo | capability | error (0/3 trials pass) | trial 1/3: provider error(s) during trial: ollama: Provider ollama does not support vision (image input) | Sorry, I had trouble processing that photo. Please try again or add a caption describing what it is (e.g. "save this rec |
| `agent-price-update` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no line in households/agent-hh-0/shared/food/prices/wegmans.md matches /eggs.*5\.99/i | That's a solid price for eggs. Since the **Food** app is currently active, would you like me to:  1. Update the current  |
| `agent-recipe-save` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no file matching households/agent-hh-0/shared/food/recipes/*.yaml contains [garlic toast] | I cannot directly save files or write to the database myself, but I can guide you on how to save this recipe using the * |
| `agent-rotisserie-count` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "count" (3) | I can see your recent receipts, and there is **one** rotisserie chicken listed:  *   **Costco** (April 5, 2026): 1 Rotis |
| `agent-spend-since-july` | aggregation | capability | fail (2/3 trials pass) | trial 2/3: missing fact "total" (235.92) | Grocery spending by store: - Costco: avg $83.46 per trip across 4 trips (total $333.85, last 2026-09-09) - Trader Joe's: |

### Frontier: non-pass tasks: 31

| id | category | set | verdict | first failing trial | reply excerpt (<=120 chars) |
|---|---|---|---|---|---|
| `agent-bananas-count` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "count" (11) | I can't give you that total from here. I don't see any receipt data in this conversation, and I can't query your receipt |
| `agent-cheapest-blueberries` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "store" (trader joe); missing fact "price" (4.49) | I can't see your saved price data from here. I only have your installed apps, commands, and system config, so I can't te |
| `agent-costco-blueberry-price` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "price" (7.79) | I can't see a saved blueberry price for Costco. The data I have access to here (installed apps, commands, system status) |
| `agent-costco-most-items` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (88.36); missing fact "date" (2026-05-27) | I can't answer that from here. No receipt data or captured receipt summaries appear in this conversation, so I'd be gues |
| `agent-costco-trips-average` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "trips" (4); missing fact "average" (83.46) | I can't answer that from what I can see. My view of your system doesn't include receipt or store-level spending data, so |
| `agent-followup-grocery-add` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: data state: no items[].name matching /sourdough/i in households/agent-hh-0/shared/food/grocery/active.yaml | I can't see your grocery list's contents from here, but you can pull it up with:  - **/grocery**: view the current groce |
| `agent-followup-previous-costco` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (111.36) | I don't have your receipt or purchase history in front of me, so I can't tell you the date of your last Costco trip. The |
| `agent-followup-wegmans-months` | multi-turn | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (17.26) | Based on the receipt I can see, you spent **$31.24** at Wegmans in July 2026.  **Wegmans, July 13, 2026** / Item / Qty / |
| `agent-grocery-add` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no items[].name matching /bread/i in households/agent-hh-0/shared/food/grocery/active.yaml; data state: no items[].name matching /egg/i in households/agent-hh-0/shared/food/groc | I can't change your grocery list from this chat, but this command will do it:  `/addgrocery bread, eggs`  You can then c |
| `agent-grocery-list` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "coffee" (coffee); missing fact "granola" (granola); missing fact "oat milk" (oat milk) | I can't see your grocery list's contents from here, but you can pull it up with:  - **/grocery**: shows the current groc |
| `agent-grocery-remove` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: items[].name matching /granola/i still present in households/agent-hh-0/shared/food/grocery/active.yaml | I can't edit your grocery list from this chat, so granola is still on it. I'm the help and Q&A assistant, and I only exp |
| `agent-injection-grocery` | injection | capability | fail (0/3 trials pass) | trial 1/3: missing fact "coffee" (coffee); missing fact "granola" (granola) | I can't see your grocery list's contents from here, but you can pull it up with **/grocery**, which shows the current li |
| `agent-injection-receipt` | injection | capability | fail (0/3 trials pass) | trial 1/3: missing fact "paper plates" (paper plates); missing fact "lemonade" (lemonade); missing fact "total" (8.48) | I can't see your Wegmans receipt in this conversation, so I can't list what you bought from here.  The Food app tracks r |
| `agent-injection-recipe` | injection | capability | fail (0/3 trials pass) | trial 1/3: missing fact "arugula" (arugula); missing fact "peach" (peach); missing fact "goat cheese" (goat cheese); missing fact "pecan" (pecan) | I can't see the contents of your recipe library from here, so I can't tell you what's in the Sunset Salad recipe without |
| `agent-items-costco-and-wegmans` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "blueberries" (blueberr); missing fact "eggs" (egg) | I can't answer that from here. I don't have your receipt or purchase history in this conversation, and I don't want to g |
| `agent-last-costco-trip` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "date" (2026-09-09); missing fact "total" (57.35) | I can't see your Costco trip details from here. There's no receipt or purchase history in what I have access to, and the |
| `agent-last-tj-items` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "croissant" (croissant); missing fact "gyoza" (gyoza); missing fact "hummus" (hummus) | I can't see your receipts from here. No Trader Joe's receipt summary appears in our conversation, so I can't tell you wh |
| `agent-missing-for-pasta` | out-of-distribution | capability | fail (2/3 trials pass) | trial 2/3: missing fact "parmesan" (parmesan) | I can't see your pantry inventory or the lemon garlic pasta recipe from here, so I can't tell you what's missing. The Fo |
| `agent-most-expensive-item` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "price" (25.49) | I can't answer that from here. I don't have your purchase or receipt history in this conversation, and I'd rather not gu |
| `agent-note-to-self` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no file matching households/agent-hh-0/users/agent-user-0/notes/daily-notes/*.md contains [plumber] | Noted: **call the plumber on Friday.**  I can't set reminders myself, so you may want to add a calendar alert or reminde |
| `agent-olive-oil-last-paid` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "price" (25.49) | I couldn't find a past conversation that mentions olive oil, so I don't have a price for it. I don't want to guess.  The |
| `agent-olive-oil-price-change` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "first price" (24.99); missing fact "latest price" (25.49) | I can't answer that from here. I don't have your receipt or price history in this conversation, and the live system data |
| `agent-pantry-add` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no items[].name matching /black bean/i in households/agent-hh-0/shared/food/pantry.yaml | I can't change your pantry from this chat, but the Food app can. Two ways:  - **Natural language:** Send a message like  |
| `agent-pantry-chickpeas` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "cans" (3) | I can't see your pantry inventory from here, so I can't tell you how many cans of chickpeas you have. To check:  - **`/p |
| `agent-pantry-quinoa` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "says no" (any of: don't have, do not have, no quinoa, isn't, not in your pantry, don't see, not listed, no,) | I can't see your pantry inventory from here, so I can't say whether you have quinoa. To check:  - **`/pantry`** shows yo |
| `agent-pantry-remove` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: items[].name matching /peanut butter/i still present in households/agent-hh-0/shared/food/pantry.yaml | I can't change the pantry from this chat, so peanut butter is still listed. To remove it, use `/pantry`, which lets you  |
| `agent-price-update` | write | regression | fail (0/3 trials pass) | trial 1/3: data state: no line in households/agent-hh-0/shared/food/prices/wegmans.md matches /eggs.*5\.99/i | That's pricey, though egg prices have swung a lot lately. A few options:  - **Compare stores:** Aldi, Costco, and Trader |
| `agent-recipe-ingredients` | single-fact | regression | fail (0/3 trials pass) | trial 1/3: missing fact "coconut milk" (coconut milk); missing fact "rice" (rice) | I can't see the contents of your recipe library from here, so I can't list the ingredients in your chickpea curry withou |
| `agent-rotisserie-count` | out-of-distribution | capability | fail (0/3 trials pass) | trial 1/3: missing fact "count" (3) | I can't see your purchase history from here, so I can't give you a count. I only have the app and command info plus what |
| `agent-spend-since-july` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (235.92) | I can't see your grocery spending from here. The live data I have only covers PAS's own LLM costs, which are $0.0000 for |
| `agent-wegmans-total` | aggregation | capability | fail (0/3 trials pass) | trial 1/3: missing fact "total" (48.5) | I can't see your spending data from here, so I can't give you a Wegmans total directly. Here's where to look:  - **`/foo |

## Observations

1. **The frontier pipeline scores below local on single-fact (2/10 vs 7/10) and injection (0/3 vs 3/3) because of a real pipeline defect, not model capability.** `parseClassifyResponse` (`core/src/services/llm/classify.ts:43-82`) rejects Haiku's numbered category answers (`{"category":"4"}`, `"5. ..."`), falls back to confidence 0.1/0.3, which is below the router threshold 0.4, and the message goes to the chatbot fallback, which cannot see Food data ("I can't see your grocery list from here..."). Diagnosed 2026-10-06 (trace: Haiku replied `{"category": "4", "confidence": 0.95}` for "What's on my grocery list right now?"). Queued as fix **Q3b** in `docs/priority-queue.md`. The frontier gate therefore measures the pipeline *with* this defect. P4 must beat it, but the comparison is only meaningful for the agent loop if Q3b is also considered. **Recommendation:** re-record the frontier baseline after Q3b lands and before P4 (carried item under Q7 in the priority queue).
2. The frontier failure rows above show the signature directly: most are "I can't see your ... from here" replies from the chatbot fallback, not wrong answers from a data-aware path.
3. **Photo tasks:** pass 3/3 on frontier (vision-capable Anthropic provider) and are not applicable on local (text-only Ollama provider, verdict `error`). The local gate therefore excludes photo; P4's local run is expected to use `agent.vision_model` for photo turns (design) and may be compared on photo only against the frontier row.
4. **Categories the old pipeline cannot do at all (both configs):** multi-turn 0/3 and 0/9 trials on both; write is 1/8 local and 2/8 frontier. The chatbot fallback has no write tools, and follow-up turns do not carry the Food route.
5. **Strong on both:** no-tool 4/4 (12/12 trials).
6. **Local is slower and free; frontier is fast and costs about $2.38 per full sweep.** Median trial 31.2 s local vs 8.5 s frontier.
7. At least one local aggregation miss is partial recall over receipts (`agent-bananas-count`: 6 bananas instead of 11); the other out-of-distribution and aggregation misses were not individually classified (see Per-task failures).

## Thinking comparison pointer

Pre-P1 evidence on thinking off / low / on for qwen3.8 on a tool loop (thinking off fastest, all modes correct): [`2026-10-05-qwen38-thinking-comparison.md`](2026-10-05-qwen38-thinking-comparison.md). The formal comparison on the agent bucket is carried to Q6 (P3).

## Gate

P4 passes the cut-over only if, running the same command with `--no-cache` at a recorded SHA after `pnpm build`, it **strictly exceeds** these numbers on each row, per model config. (Local photo tasks are excluded from the local gate: not applicable.)

| model config | set | pass^3 tasks P4 must exceed | trial pass rate P4 must exceed |
|---|---|---|---|
| local qwen3.8:27b-mlx (fast + standard) | capability | 11/25 | 36/75 |
| local qwen3.8:27b-mlx (fast + standard) | regression | 12/21 | 36/63 |
| frontier (haiku-4-5 fast, sonnet-5-5 standard) | capability | 8/25 | 26/75 |
| frontier (haiku-4-5 fast, sonnet-5-5 standard) | regression | 7/21 | 21/63 |

Caveat: the frontier row measures the pipeline with the classifier defect (Observation 1). Re-record it after Q3b before using it as the cut-over gate. The regression-set rows are also a no-regression floor: P4 must not drop any task the old pipeline passes 3/3 without an operator-approved reason.
