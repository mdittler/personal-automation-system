#!/usr/bin/env bash
# Phase guard: blocks writing to production TypeScript source files on main/master.
#
# Enforces the superpowers:executing-plans + worktree workflow for implementation
# phases. Prevents the "eager beaver" pattern of co-writing tests and production
# code directly on main without a plan, TDD loop, or isolated branch.
#
# Triggered by: PreToolUse on Write|Edit
# Passes through: test files, docs, config, scripts, memory, plans
# Blocks: core/src/**/*.ts and apps/**/*.ts (non-test) on main/master

INPUT=$(cat)

# Extract file_path — try python, then python3, then node
extract_path() {
  local script='import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))'
  if command -v python &>/dev/null; then
    echo "$INPUT" | python -c "$script" 2>/dev/null
  elif command -v python3 &>/dev/null; then
    echo "$INPUT" | python3 -c "$script" 2>/dev/null
  elif command -v node &>/dev/null; then
    echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d);console.log((p.tool_input||{}).file_path||'')}catch{console.log('')}})"
  else
    echo ""
  fi
}

FILE_PATH=$(extract_path) || FILE_PATH=""
[ -z "$FILE_PATH" ] && exit 0

# Normalize backslashes to forward slashes for matching
NORM_PATH="${FILE_PATH//\\/\/}"

# Only gate on TypeScript source files
[[ "$NORM_PATH" =~ \.ts$ ]] || exit 0

# Allow test files
[[ "$NORM_PATH" =~ /__tests__/ ]] && exit 0
[[ "$NORM_PATH" =~ \.test\. ]]   && exit 0
[[ "$NORM_PATH" =~ \.spec\. ]]   && exit 0

# Only gate on production source directories (match with or without leading slash)
[[ "$NORM_PATH" =~ (^|/)(core/src|apps)/ ]] || exit 0

# Check current branch
BRANCH=$(git branch --show-current 2>/dev/null || echo "")

# If branch is undetermined (detached HEAD in worktree), allow
[ -z "$BRANCH" ] && exit 0

if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then
  echo "⛔ Phase guard: cannot write production source on '$BRANCH'." >&2
  echo "" >&2
  echo "   File: $FILE_PATH" >&2
  echo "" >&2
  echo "   Invoke superpowers:executing-plans first. That skill creates a git worktree" >&2
  echo "   on a feature branch before any code is written, enforcing the TDD workflow." >&2
  echo "   See: docs/d5c-chunk-d-review-findings.md for why this guard exists." >&2
  exit 2
fi

exit 0
