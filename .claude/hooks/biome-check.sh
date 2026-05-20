#!/usr/bin/env bash
# Runs `biome check` on files changed vs origin/main; blocks on ERRORS only.
# Dual caller: 1) Claude Code PreToolUse (stdin = JSON; gates git push/merge)
#              2) git pre-push / pre-merge-commit hook ($1 = "git-hook")
# Exit: 0 clean | 1 errors (git hook) | 2 errors (Claude Code)
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
ERRORS=$(grep '^::error' <<< "$OUTPUT" || true)
if [ -n "$ERRORS" ]; then
  echo "" >&2
  echo "⛔ Biome errors in changed files — blocked." >&2
  echo "$ERRORS" >&2
  echo "   Fix: pnpm exec biome check --write --changed --since=origin/main" >&2
  [ "$1" = "git-hook" ] && exit 1 || exit 2
fi
echo "✅ Biome clean (changed files)." >&2
exit 0
