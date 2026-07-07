# GUI Verify Harness

A dev tool that boots the **real** PAS management GUI against seeded, realistic, multi-household data — no Telegram bot token, no LLM credentials, no network. Use it to click through the GUI as different personas, demo it, or run scripted checks (permissions matrices, data-flow assertions) against a live server.

Built during the 2026-07-07 live verification of the GUI UX Redesign, where it powered a browser walkthrough plus agent-driven permissions and data-flow sweeps (see `docs/implementation-phases.md`, "GUI UX Redesign" → live-verification note).

## Run it

```bash
pnpm exec tsx scripts/gui-verify-harness.ts
```

- Serves `http://127.0.0.1:3777/gui/login`.
- Prints the seeded credentials and expected numbers on startup, and writes them machine-readably to `scripts/.gui-verify-expected.json` (untracked runtime artifact — regenerated every run).
- For browser-preview tooling, `.claude/launch.json` has a `gui-verify` configuration pointing at the same command on port 3777.
- Ctrl-C to stop. Seeded state is rewritten on every start; delete the printed data dir for a fully clean slate (it lives under a temp/scratch path, never under `data/`).

## How it works

The harness calls the real `composeRuntime()` (`core/src/compose-runtime.ts`) with a crafted `SystemConfig` pointing at a temp data dir. `composeRuntime` constructs everything — including `registerGuiRoutes` with all optional GUI dependencies — but never starts Telegram polling, the scheduler, or provider network calls (those happen only in `bootstrap.ts`'s `main()`, which the harness skips). LLM providers are the stub fixtures from `core/src/testing/fixtures/`. So the GUI you see is wired exactly like production; only the outbound integrations are inert.

## Seeded state

| What | Details |
|---|---|
| Users | **Matthew** `1000001` / `admin-pass-1` (platform admin, household `home-main`) · **Sam** `1000002` / `member-pass-1` (member, `home-main`) · **Rival** `1000003` / `rival-pass-1` (member, `home-other` — exists to prove cross-household isolation) |
| Usage log | ~30 days of `data/system/llm-usage.md` rows across Matthew/Sam, mixed 8/9-column formats; per-row costs are scaled so **month-to-date** totals land exactly on $3.20 (Matthew) and $0.90 (Sam) regardless of the current date |
| Reports | `weekly-pantry-report` (delivered to Matthew only) and `household-changes-report` (Matthew + Sam), with history files |
| Alerts | `grocery-list-alert` (Matthew-only) and `pantry-milk-alert` (Sam), with dated alert-history entries (1/1/1/2 across four recent days) |
| Conversations | Transcript-index SQLite with 3 Matthew sessions (one titled "Lasagna night" — searchable via `?q=lasagna`), 2 Sam, 1 Rival |
| Change log | Entries across 5 days: private per-user, household-shared, space-scoped, and one `home-other` entry that must never appear for `home-main` members |
| Space | `meal-planning` (Matthew + Sam) |
| Backups | Enabled config with two backdated fake archives; "Back up now" creates a real tar archive in the temp dir |
| Data files | Household-shared food files under the **manifest-declared scopes** (`grocery/`, `recipes/`) so the alert wizard's data-source picker lists them, plus deliberately out-of-scope files (`pantry.md` at the app root) that the file index must exclude |

## Gotchas learned the hard way

- **FileIndexService only indexes files inside an app's manifest-declared data scopes.** Seed files under `grocery/`, `recipes/`, etc. (see `apps/food/manifest.yaml` → `requirements.data`) or they will exist on disk but never appear in pickers. This is correct product behavior, not a bug.
- **Login rate limiting is per-IP first.** Scripted sweeps that log in as several personas from localhost can exhaust the shared window and lock all logins for its duration — space out logins or reuse cookie jars (tracked in `docs/open-items.md`, "Per-IP login rate limiting shares one budget across a household").
- **Space membership is dual-written in production** (`RegisteredUser.sharedScopes` + `SpaceDefinition.members`). The harness seeds via `SpaceService.saveSpace` only, so the Household page's space checkboxes render unchecked even though Spaces pages show the members — a seeding artifact, documented as an Accepted Risk in `docs/open-items.md`.
- **Alert data sources require `user_id` or `space_id`** (validator constraint), so seeded alerts point at Matthew's per-user copies of the food files even though the read path supports household-shared sources (open item: "Household-shared-only alert data sources rejected by validator").
- The current calendar month matters: glance cards show **month-to-date** numbers while the charts/`llm-daily` endpoint use a **rolling 30-day window**. Both are correct; don't "fix" one to match the other.

## Extending

- **New page/feature to verify?** Add seed data in the clearly-marked numbered sections of `scripts/gui-verify-harness.ts`, and add the expected numbers to the `expected` object at the bottom so scripted checks can assert against `scripts/.gui-verify-expected.json`.
- **Scripted sweeps:** log in with `curl -c jar.txt -d 'userId=…&password=…' http://127.0.0.1:3777/gui/login`, then drive any route with `-b jar.txt`. CSRF tokens for POSTs come from the `csrf-token` meta tag / cookie on any authenticated GET.
- Keep the harness import-only from `core/src` and `core/src/testing/fixtures` — it must never be imported by production code.
