#!/usr/bin/env bash
# Runs tsc --noEmit (non-incremental) before git merge.
# Catches TypeScript errors that tsc --build skips due to incremental cache hits.
#
# Used by two callers:
#   1. Claude Code PreToolUse hook (stdin = JSON tool input)
#   2. Git pre-merge-commit hook (no stdin, $1 = "git-hook")
#
# Exit codes:
#   0 = clean, proceed
#   1 = tsc errors, block (git hook convention)
#   2 = tsc errors, block (Claude Code hook convention)

# ------------------------------------------------------------------
# When called from Claude Code: filter to git merge commands only
# ------------------------------------------------------------------
if [ "$1" != "git-hook" ]; then
  INPUT=$(cat)
  COMMAND=$(echo "$INPUT" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const p=JSON.parse(d); console.log((p.tool_input||{}).command||''); }
      catch { console.log(''); }
    });
  " 2>/dev/null <<< "$INPUT" || echo "")

  # Only gate on git merge and git push commands
  [[ "$COMMAND" =~ git[[:space:]]+(merge|push) ]] || exit 0
fi

# ------------------------------------------------------------------
# Find the repo root and run tsc --noEmit in core/
# ------------------------------------------------------------------
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$REPO_ROOT" ]; then
  echo "tsc-nocheck: could not determine repo root, skipping" >&2
  exit 0
fi

CORE_DIR="$REPO_ROOT/core"
if [ ! -d "$CORE_DIR" ]; then
  echo "tsc-nocheck: core/ directory not found at $CORE_DIR, skipping" >&2
  exit 0
fi

echo "🔍 tsc --noEmit (full check, no incremental cache)..." >&2

OUTPUT=$(cd "$CORE_DIR" && npx tsc --noEmit 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo "" >&2
  echo "⛔ TypeScript errors — merge blocked." >&2
  echo "" >&2
  echo "$OUTPUT" >&2
  echo "" >&2
  echo "   Fix all errors, then re-run: cd core && npx tsc --noEmit" >&2
  # Exit 1 for git hook convention, 2 for Claude Code blocking convention
  [ "$1" = "git-hook" ] && exit 1 || exit 2
fi

echo "✅ tsc --noEmit clean." >&2
exit 0
