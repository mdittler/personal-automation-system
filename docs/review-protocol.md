# Review & Execution Protocol

How every phase and fix in `docs/priority-queue.md` is planned, reviewed, executed, and merged.

Adopted 2026-10-05 by operator decision. The **roles are Code Orchestrator's engine roles**, with one operator change: code review runs on `gpt-6-luna` at **medium**. The practices also come from Code Orchestrator: every finding gets a home, a deliverables contract, mechanical proof, plateau votes, and SHA-honest verification.

## 1. Roles and models

| Step | Role | Model | Notes |
|---|---|---|---|
| Orchestration | **Conductor** | The Claude Code session | Routes between roles, writes briefs, verifies reviewer claims, records dispositions, runs verification, merges with operator OK. **Never reviews an artifact it authored.** |
| design (only when a phase needs new design) | designer | Claude **Opus**, read-only subagent (`model: opus`) | |
| plan, revise plan | planner | Claude **Fable 5.1** subagent (`model: fable`) | Writes the plan, then revises it against review findings, filling in the disposition ledger |
| plan review | plan reviewer | Codex **`gpt-6.1-sol`**, effort **medium**, read-only | Reasoning under ambiguity |
| execute | implementer | Claude **Sonnet** subagents (`model: sonnet`), one per task | Test-first |
| code review | code reviewer | Codex **`gpt-6-luna`**, effort **medium** | Conformance checking. Code Orchestrator uses `high`; the PAS operator chose `medium`. |
| revise code | reviser | Grok 4.7 via Cursor CLI, **`grok-4.7-high`**, write mode in the phase worktree | Fixes code-review findings |
| escalation (opt-in per phase, off by default) | reviser ladder | `grok-4.7-high` → Claude Opus → Claude Fable | When the reviser fails the same finding twice |
| simplify (once, after the code-review loop converges clean) | simplifier | Claude **Sonnet** subagent | Then one confirming full-scope code review |
| code-review fallback (Codex unreachable) | fallback reviewer | Claude **Opus** subagent, read-only | Only after `codex --version` fails |
| side questions | consultant | Codex `gpt-6.1-sol`, medium, read-only | |
| votes (§6) | voters | Claude Opus, Codex `gpt-6.1-sol` at **xhigh**, Grok **`grok-4.7-xhigh`** | One voice per vendor |

**Model hygiene:**
- **The reviewer's model family must differ from the implementer's and the reviser's.** Here the reviewers are OpenAI, the implementer is Anthropic, and the reviser is xAI. Warn the operator if a role override would break this.
- Grok's tier is part of the id: use `grok-4.7-high` or `grok-4.7-xhigh`. **Never use bare `grok-4.7`**, which resolves to a ~2× priced fast tier.
- Grok's context is 256K, and it costs about 2× past 200K.
- `gpt-6.1-sol` needs codex-cli ≥ 0.160.
- Validate a model id by **running** it, not from a listing.
- Verified on this machine 2026-10-05: codex-cli 0.160.0 with `gpt-6.1-sol` and `gpt-6-luna` (medium); cursor-agent 2026.10.01 with `grok-4.7-high` (it reports `Grok 4.7 256K High`).

**At the start of every session, list this roster** so a model change is noticed.

## 2. Flow and gates

```
design? → plan (Fable) → plan review (gpt-6.1-sol) ⇄ revise plan (Fable)   [≤3 iterations]
        → OPERATOR GATE: after plan revision
        → execute (Sonnet, per task) → code review (gpt-6-luna) ⇄ revise code (grok-4.7-high)   [≤5 iterations]
        → simplify (Sonnet) → confirming full-scope code review (gpt-6-luna)
        → verify → OPERATOR GATE: before merge/push → merge --no-ff → reconcile docs
```

**Loop caps:**
- The plan loop stops after 3 iterations and goes to the operator: proceed, replan, or abort.
- The code loop stops after 5 iterations and goes to the operator.

**On any step failure, stop and tell the operator.** Executors can't ask the operator directly. They report what they need to the conductor, which asks the operator and never answers on their behalf.

## 3. Plan requirements (beyond the `writing-plans` skill)

Every plan contains these sections:

1. **`## Deliverables`** — a checkbox list of *observable* behaviours, each phrased so it can be checked against the repo. This is the plan→execution contract. Code review adjudicates every item as delivered, missing, or downgraded, and a silent narrowing is **critical**.
2. **Tasks**, written test-first.
3. **A live smoke step**: real inputs, expected output per step, and at least one negative case. A deferred smoke means the phase is not done.
4. **`## Plan review log`** — the disposition ledger (§5).
5. **`## Review findings — acceptance checklist`** — one row per finding fixed in the plan, naming the evidence that proves the fix **in code**: a test name, command plus expected output, or a code-review check. Execution ticks each row with what it observed. A finding fixed only in the plan's text is not fixed.
6. **`## Implementation notes from review`** — every non-critical finding to be fixed during execution, with its test or check line, or the place it was re-homed.

## 4. Review rounds

**Plan review** (object: the plan doc, read in place). From the repo root:

```bash
EVID="$HOME/Projects/pas-<item>-review-evidence"; mkdir -p "$EVID"
# write "$EVID/plan-brief-r<N>.md" from §4.1
codex exec -m gpt-6.1-sol -c model_reasoning_effort='"medium"' -s read-only --skip-git-repo-check \
  -o "$EVID/plan-review-r<N>.md" - < "$EVID/plan-brief-r<N>.md"
```

The Fable planner then revises the plan, addressing every finding in the ledger. The conductor verifies the reviewer's claims against the code before they are filed (§5).

**Code review** (object: the phase diff at a SHA, in a disposable detached worktree):

```bash
SHA=$(git rev-parse HEAD); WT="$HOME/Projects/pas-review-<item>-r<N>"
git worktree add --detach "$WT" "$SHA"
# write "$EVID/code-brief-r<N>.md" from §4.1
( cd "$WT" && codex exec -m gpt-6-luna -c model_reasoning_effort='"medium"' -s workspace-write --skip-git-repo-check \
    -o "$EVID/code-review-r<N>.md" - < "$EVID/code-brief-r<N>.md" )
git worktree remove --force "$WT"     # after triage
```

**Revise code** (Grok edits the *phase* worktree):

```bash
cursor-agent -p --force --model grok-4.7-high --output-format text --workspace "<phase worktree>" \
  "$(cat "$EVID/revise-brief-r<N>.md")" < /dev/null > "$EVID/revise-r<N>.txt" 2>&1
```

- The revise brief lists the open finding ids with their evidence.
- Then the conductor runs `pnpm lint` plus the affected tests, inspects the diff, and commits. The commit message lists the finding ids it closes.
- Review again with Luna.

**How to run the commands:**
- Launch with the Bash tool's `run_in_background`; a round takes about 5–15 minutes.
- **Always give `codex exec` stdin** (`- < brief` or `< /dev/null`). Without it, sessions have hung for over 2 hours; the tell is a tiny output file.
- **Never wrap a command in `timeout`/`gtimeout`**; neither exists on macOS.
- Luna gets `workspace-write` so it can run tests and mutation checks in the disposable worktree. The brief says to restore every mutation and never commit.

### 4.1 Brief template

Codex and Grok cannot load skills, so the severity rubric is inlined:

```markdown
# <Plan|Code> review brief — <item> round <N>

Object: <plan path> | <git range main...SHA, list of files>. Never commit; restore any mutation.
Approved inputs (do not argue them): <design sections, operator decisions>.

## Attacks — try each and report what happened
- <specific bypasses, hostile inputs, ordering/race scenarios, plan claims to falsify>
- (code) Mutation-test at least <K> new guards: revert the guard, run its test, confirm it fails for its own
  named reason, restore. Report only what you observed.
- (code) For each Deliverable and each acceptance-checklist row: delivered / missing / downgraded, with
  file:line or command evidence. A silent narrowing is critical.

## Prior rounds (data — do not re-litigate)
<disposition table; challenge a decline only if its stated reason is wrong>

## Severity
critical = ships a material, reachable broken behaviour, data loss, security hole, or production-contract
violation — merge-blocking; name the concrete failure. major = real defect with a named failure mode;
minor = quality / weaker test with no demonstrated defect; nit = cosmetic. NOT critical: style or
architecture preference; "a test could be stronger"; a deviation from plan that is still correct; an
operator-directed change; an already-dispositioned finding; a future problem with no reachable trigger
today; perf/ops concern with no user-visible impact. Severities do not add up.
Phase-specific direction rule: <which error direction is critical, if relevant>

## Output
Numbered findings: severity, file:line, the attack/command, observed result, CONFIRMED or SUSPECTED.
Report every finding at its honest level — non-critical ones get a home too.
Final line, exactly: CLEAN  or  FINDINGS
```

## 5. Every finding gets a home (the disposition ledger)

**Filing findings:**
- Each finding gets a stable id, `R<round>-<n>`.
- **The conductor verifies every finding against the code before filing it.** A false claim is recorded as *declined — claim false: <evidence>*.
- The ledger lives in the plan's review log for plan rounds, and in the phase's `docs/implementation-phases.md` section for code rounds.

Each finding ends in exactly one disposition:

| Disposition | Meaning | Where it goes |
|---|---|---|
| **fixed-in-plan** | The plan text handles it | Plus a row in **Review findings — acceptance checklist** naming the evidence that proves it in code |
| **fixed-in-code** | Code round: the reviser or conductor fixed it | Commit sha plus the test that proves it (closure proof, §7) |
| **execution-note** | Fix during execution (typical for majors, minors, and nits) | **Implementation notes from review**, with a test or check line |
| **deferred → <phase/row>** | Belongs to a later phase or a new fix | A *Carried items* bullet or row in `docs/priority-queue.md` **and** an entry in `docs/open-items.md` |
| **declined — <failure mode>** | Consciously not done | Must name the failure mode being accepted. Security, data loss, and corruption can't be declined without the operator |
| **operator** | Needs a human call | Asked at the next gate |

These don't count as dispositions:
- "Leave it" or "low priority".
- **A fixed-in-plan finding with no acceptance-checklist row.** That finding stays LIVE.

## 6. Convergence, stop rules, votes

**When to stop or escalate:**
- **Only criticals gate another iteration.** Non-critical findings still get their disposition every round.
- **Stop when** the reviewer returns `CLEAN`, or when the criticals are fixed and the next round adds only non-critical findings, which get dispositioned. Record which in the log.
- **Plateau rule:** if two consecutive rounds find new criticals of the *same class*, stop patching and run a root-cause vote.
- **Terminal rule:** at a loop cap, or one confirming round after a vote, majors that only contrived input could trigger are declined with the failure mode named. New criticals go to the operator.
- **Code review is stricter:** never merge on a round that leaves any finding undispositioned, however minor.

**Votes** — for a non-converging class, a design fork, or a decision the plan left open:
- Ask all three voters the same question with the same evidence. Each gives one sealed answer: proposal plus rationale.
- Unanimous means proceed. Non-conflicting amendments are adopted as their union.
- If not unanimous, give each voter the others' concerns once, then report the disagreement to the operator.
- **User-experience and preference calls are always the operator's.**
- Record each vote in `$EVID/vote-<n>.md`.
- Commands:
  - Claude: an Opus subagent.
  - Codex: `codex exec -m gpt-6.1-sol -c model_reasoning_effort='"xhigh"' -s read-only - < q.md`
  - Grok: `cursor-agent -p --trust --mode ask --model grok-4.7-xhigh --output-format text "$(cat q.md)" < /dev/null`

## 7. Execution rules

**Commits:** every commit leaves zero failing tests and `pnpm lint` with zero errors.

**Mechanical proof for every new guard:**
- Revert it, confirm its test fails for the guard's own reason, then restore.
- Record what you observed. Never record a count you did not run.

**Closure proof for every fix:**
- The fix's test must fail at the pre-fix SHA and pass at HEAD.
- Check it in a scratch worktree at the parent commit.

**Plan pins:** every number or threshold the plan pins appears in a test.

**Acceptance checklist:**
- Tick each row with the evidence you observed.
- Handle every implementation note: fix it, or re-home it per §5.

**Verify before you assert:**
- Grep the diff for absolutes ("always", "never", "every", "by construction") and either add the measuring command or remove the word.
- "Tests pass" is a claim about a SHA. Save the final SHA's output as `$EVID/suite-<sha>.txt`.
- **Re-check `git rev-parse HEAD` equals the tested SHA immediately before merging.**

**Merge:**
- Use `--no-ff`. Delete the phase branch afterwards.
- Reconcile `docs/priority-queue.md` and `docs/open-items.md` in or immediately after the merge commit.
- Merge only after the operator gate.

**End of session:** report what was done, the next queue item, the cost (API spend), and the wall-clock time.

## 8. Fixes (lighter path)

- No plan doc and no plan review.
- The Sonnet implementer writes a failing test, then the minimal fix, with closure proof.
- Run Luna code review ⇄ Grok revise, under the same ledger, caps, and gates.
- Add a URS fix entry.
