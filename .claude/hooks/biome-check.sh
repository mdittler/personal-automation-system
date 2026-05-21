#!/usr/bin/env bash
# Runs `biome check` on files changed vs origin/main. Blocks on lint ERRORS
# and on Biome tooling failures (fail closed). Warnings never block.
# Dual caller: 1) Claude Code PreToolUse (stdin = JSON; gates git push/merge)
#              2) git pre-push / pre-merge-commit hook ($1 = "git-hook")
# Exit: 0 clean | 1 blocked (git hook) | 2 blocked (Claude Code)
if [ "$1" != "git-hook" ]; then
  INPUT=$(cat)
  COMMAND=$(node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const p=JSON.parse(d); console.log((p.tool_input||{}).command||''); }
      catch { console.log(''); }
    });" 2>/dev/null <<< "$INPUT" || echo "")
  [[ "$COMMAND" =~ git[[:space:]]+(merge|push) ]] || exit 0
fi
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$REPO_ROOT" ] && { echo "biome-check: no repo root, skipping" >&2; exit 0; }
cd "$REPO_ROOT" || exit 0
BIOME="$REPO_ROOT/node_modules/.bin/biome"
[ -x "$BIOME" ] || BIOME="npx biome"
OUTPUT=$($BIOME check --changed --since=origin/main --reporter=github 2>&1)
RC=$?
[ "$1" = "git-hook" ] && BLOCKED=1 || BLOCKED=2
ERRORS=$(grep '^::error' <<< "$OUTPUT" || true)
if [ -n "$ERRORS" ]; then
  echo "" >&2
  echo "⛔ Biome errors in changed files — blocked." >&2
  echo "$ERRORS" >&2
  echo "   Fix: pnpm exec biome check --write --changed --since=origin/main" >&2
  exit "$BLOCKED"
fi
# Fail closed: a non-zero exit with no ::error means Biome itself failed
# (bad config, crash, missing binary) — never silently pass. The one benign
# non-zero case is "No files were processed" (nothing in scope to lint).
if [ "$RC" -ne 0 ] && ! grep -q 'No files were processed' <<< "$OUTPUT"; then
  echo "" >&2
  echo "⛔ Biome tooling failure (exit $RC, no lint errors) — blocked." >&2
  echo "$OUTPUT" >&2
  exit "$BLOCKED"
fi
echo "✅ Biome clean (changed files)." >&2
exit 0
