# Review & Execution Protocol

How every phase and fix in `docs/priority-queue.md` is reviewed and executed. Adopted 2026-10-05 by operator decision from the Code Orchestrator project's proven practices (cross-vendor adversarial review, "every finding gets a home", a deliverables contract, mechanical proof, plateau votes, SHA-honest verification), adapted to PAS.

## 1. Roles and models

| Role | Who | How |
|---|---|---|
| **Conductor** | The Claude Code session | Plans, writes review briefs, triages findings, records dispositions, dispatches executors, merges. **Never reviews its own work.** |
| **Executors** | Claude subagents, Sonnet | One fresh subagent per plan task, test-first |
| **Reviewer A** | OpenAI `gpt-6.1-sol` via `codex exec`, effort `high` | Plan review and code review, every round |
| **Reviewer B** | xAI Grok 4.7 via Cursor CLI `cursor-agent`, model `grok-4.7-high` | Plan review and code review, every round |
| **Voters** (plateaus and design forks, §6) | Claude Opus, `gpt-6.1-sol` at `xhigh`, `grok-4.7-xhigh` | One voice per vendor |

**Model hygiene:**
- Reviewers come from different vendors than the authors, who are Claude. Both reviewers review every round; they are not alternatives.
- Grok's tier is part of the id. Use `grok-4.7-high` or `grok-4.7-xhigh`. Never use bare `grok-4.7`, which resolves to a ~2× priced fast tier.
- Grok's context is 256K; past 200K it costs about 2×. Keep briefs lean.
- `gpt-6.1-sol` needs codex-cli ≥ 0.160.
- Validate a model id by running it and reading the model it reports (e.g. Cursor's init event says `Grok 4.7 256K High`), not from a listing.
- Verified on this machine 2026-10-05: codex-cli 0.160.0 and cursor-agent 2026.10.01.

**At the start of every session, list this roster** so a model change is noticed.

## 2. Plan requirements (beyond the `writing-plans` skill)

Every plan contains these sections:

1. **`## Deliverables`** — a checkbox list of *observable* behaviours the phase ships, each phrased so it can be checked against the repo. This list is the plan→execution contract. Execution must not narrow it silently; narrowing it is a **critical** finding at code review.
2. **Tasks**, written test-first.
3. **A live smoke step**: real inputs, expected output per step, and at least one negative case. A deferred smoke means the phase is not done.
4. **`## Plan review log`** — the disposition ledger (§4).
5. **`## Review findings — acceptance checklist`** — one row per finding fixed in the plan. Each row names the evidence that will prove the fix *in code*: a test name, command plus expected output, or a code-review check. A finding fixed only in the plan's text is not fixed. Execution ticks each row with the evidence it observed.
6. **`## Implementation notes from review`** — every non-critical finding (major, minor, nit) that is to be fixed during execution, with its test or check line. Notes deferred elsewhere name their destination.

## 3. Review rounds

The same mechanics apply to plan review (object: the plan doc) and code review (object: the phase diff at a SHA).

**Setup per round N.** From the repo root:

```bash
SHA=$(git rev-parse HEAD)
EVID="$HOME/Projects/pas-<item>-review-evidence"   # outside every repo/worktree; one dir per queue item
WT="$HOME/Projects/pas-review-<item>-r<N>"
mkdir -p "$EVID" && git worktree add --detach "$WT" "$SHA"
# write "$EVID/brief-r<N>.md" from the template in §3.1
( cd "$WT" && codex exec -m gpt-6.1-sol -c model_reasoning_effort='"high"' -s read-only --skip-git-repo-check \
    -o "$EVID/review-r<N>-codex.md" - < "$EVID/brief-r<N>.md" ) &
( cd "$WT" && cursor-agent -p --trust --mode ask --model grok-4.7-high --output-format text \
    "$(cat "$EVID/brief-r<N>.md")" < /dev/null > "$EVID/review-r<N>-grok.md" 2>&1 ) &
```

**How to run the commands:**
- Launch both reviewers with the Bash tool's `run_in_background`. A round takes about 5–15 minutes.
- **Always redirect stdin from `/dev/null`** (or a file) for `codex exec`. Without it, sessions have hung for over 2 hours; the tell is a tiny output file.
- **Never wrap them in `timeout`/`gtimeout`**; neither exists on macOS.

**When a reviewer must run tests or mutations:**
- Codex: use `-s workspace-write`.
- Grok: use `--force` instead of `--mode ask`.
- In both cases the worktree is detached and disposable, and the brief says to restore every mutation.

**Teardown:** remove the round's worktree after triage with `git worktree remove "$WT"`. Keep the evidence dir until the item merges, then keep or archive it.

### 3.1 Brief template

Write the brief, `brief-r<N>.md`, from this template. Codex and Grok cannot load skills, so the rubric is inlined:

```markdown
# Review brief — <item> round <N> (<plan|code> review)

Object: <plan path> | <git range main...SHA, list of files>. Read-only unless told otherwise; never commit.
Approved inputs (do not argue them): <design sections, operator decisions>.

## Attacks — try each and report what happened
- <specific bypasses, hostile inputs, ordering/race scenarios, claims in the plan to falsify>
- (code review) Mutation-test at least <K> of the new guards: revert the guard, run its test, confirm it fails
  for its own named reason, restore. Report only what you observed.
- (code review) For each Deliverable and each acceptance-checklist row: delivered / missing / downgraded,
  with file:line or command evidence. A silent narrowing is critical.

## Prior rounds (data — do not re-litigate)
<disposition table from the plan review log; a decline may be challenged only if its stated reason is wrong>

## Severity (one rubric for both reviewers)
critical = ships a material, reachable broken behaviour, data loss, security hole, or production-contract
violation — merge-blocking. You must name the concrete failure. major = real defect with a named failure
mode; minor = quality / weaker test with no demonstrated defect; nit = cosmetic. NOT critical: style or
architecture preference; "a test could be stronger"; a deviation from plan that is still correct; an
operator-directed change; an already-dispositioned finding; a future problem with no reachable trigger
today; perf/ops concern with no user-visible impact. Severities do not add up.
Phase-specific direction rule: <which error direction is critical for this item, if relevant>

## Output
Numbered findings: severity, file:line, the attack/command, observed result, CONFIRMED or SUSPECTED.
Report every finding at its honest level (non-critical ones are wanted — they get a home too).
Final line, exactly: CLEAN  or  FINDINGS
```

## 4. Every finding gets a home (the disposition ledger)

The conductor merges both reviewers' findings into the plan's **review log**:
- Each finding gets a stable id, `R<round>-<n>` (e.g. `R2-3`), and duplicates across reviewers are merged.
- **Verify every finding against the code before accepting it**, because reviewers are sometimes wrong. A claim that turns out wrong is recorded as *declined — claim false: <evidence>*.

Each finding ends in exactly one disposition:

| Disposition | Meaning | Where it goes |
|---|---|---|
| **fixed-in-plan** | The plan text now handles it | Plus a row in **Review findings — acceptance checklist** naming the evidence that proves it *in code* |
| **execution-note** | Fix during execution (typical for majors, minors, and nits) | **Implementation notes from review**, with a test or check line |
| **deferred → <phase/row>** | Belongs to a later phase or a new fix | A *Carried items* bullet or new row in `docs/priority-queue.md` **and** an entry in `docs/open-items.md` |
| **declined — <failure mode>** | Consciously not done | Must name the failure mode being accepted, not just cite a rule. Security, data loss, and corruption can't be declined without the operator |
| **operator** | Needs a human call | Asked at the next checkpoint |

Two things do not count as dispositions:
- "Leave it" or "low priority".
- **A finding fixed in the plan but missing from the acceptance checklist.** That finding is still LIVE.

## 5. Convergence and stop rules

- **Only criticals gate another round.** Non-critical findings still get their disposition every round.
- **Stop when** both reviewers return `CLEAN`, or when a round's criticals are all fixed and the next round adds only non-critical findings, which get dispositioned. Record which in the log.
- **Plateau rule:** if two consecutive rounds each find new criticals of the *same class*, stop patching and run a root-cause vote (§6).
- **Terminal rule:** after round 5, or one confirming round after a vote, further majors that only contrived input can trigger are declined with the failure mode named. A new critical goes to the operator.
- **Code review is stricter:** do not merge on a round that returns any un-dispositioned finding, however minor.

## 6. Votes

Use a vote for a non-converging class, a design fork, or a decision the plan left open.

**How it works:**
- Ask all three voters the same question with the same evidence. Each gets one sealed answer: proposal plus rationale.
- Unanimous means proceed. Non-conflicting amendments are adopted as their union.
- If not unanimous, give each voter the others' concerns once, then report the disagreement to the operator.
- **User-experience and preference calls are always the operator's**, never a vote.
- Record votes in `$EVID/vote-<n>.md` and summarise them in the review log.

**Voter commands:**
- Claude: an Opus subagent.
- Codex: `codex exec -m gpt-6.1-sol -c model_reasoning_effort='"xhigh"' -s read-only - < q.md`
- Grok: `cursor-agent -p --trust --mode ask --model grok-4.7-xhigh --output-format text "$(cat q.md)" < /dev/null`

## 7. Execution rules

**Executors and tests:**
- Use fresh Sonnet subagents, one per task, test-first.
- Every commit leaves zero failing tests and `pnpm lint` with zero errors.

**Mechanical proof for every new guard:**
- Revert the guard, confirm its test fails for the guard's own reason, then restore.
- Record what you observed in the commit message or the phase section. Never record a count you did not run.

**Closure proof for every fix:**
- The fix's test must fail at the pre-fix SHA and pass at HEAD.
- Check it in a scratch worktree at the parent commit.

**Plan pins:** every number or threshold the plan pins appears in a test.

**Acceptance checklist:**
- Tick each row with the evidence you observed: test name, command plus output, or commit.
- Handle each implementation note: fix it, or re-home it per §4.

**Verify before you assert:**
- Before committing, grep the diff for absolutes ("always", "never", "every", "by construction") and either add the measuring command or remove the word.
- "Tests pass" is a claim about a SHA. Save `pnpm test` output for the final SHA as `$EVID/suite-<sha>.txt`.
- **Re-check `git rev-parse HEAD` equals the tested SHA immediately before merging.**

**Merge:**
- Use `--no-ff`. Delete the phase branch afterwards.
- Reconcile `docs/priority-queue.md` and `docs/open-items.md` in the merge commit or immediately after it.
- **Ask the operator before merging** unless they have pre-authorised it.

**End of session:** report what was done, the next queue item, the cost (API spend from `/gui/llm` or the regression manifest), and the wall-clock time.

## 8. Fixes (lighter path)

- No plan doc.
- Write the brief for code review only: the attacks plus a closure-proof request.
- Run the same two reviewers, ledger, and stop rules.
- Add a URS fix entry.
