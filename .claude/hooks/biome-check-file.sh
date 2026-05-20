#!/usr/bin/env bash
# PostToolUse(Write|Edit): lints the just-edited file, surfaces Biome ERRORS
# immediately as a non-blocking reminder. Warnings ignored.
INPUT=$(cat)
extract_path() {
  local s='import sys,json; d=json.load(sys.stdin); print(d.get("tool_input",{}).get("file_path",""))'
  if command -v python3 &>/dev/null; then echo "$INPUT" | python3 -c "$s" 2>/dev/null
  elif command -v python &>/dev/null; then echo "$INPUT" | python -c "$s" 2>/dev/null
  elif command -v node &>/dev/null; then echo "$INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const p=JSON.parse(d);console.log((p.tool_input||{}).file_path||'')}catch{console.log('')}})"
  else echo ""; fi
}
FILE_PATH=$(extract_path) || FILE_PATH=""
[ -z "$FILE_PATH" ] && exit 0
case "$FILE_PATH" in *.ts|*.tsx|*.js|*.jsx|*.json) ;; *) exit 0 ;; esac
[ -f "$FILE_PATH" ] || exit 0
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -n "$REPO_ROOT" ] || exit 0
cd "$REPO_ROOT" || exit 0
# Lint via a repo-relative path. An absolute path can contain a `.claude`
# segment (worktrees live under <repo>/.claude/worktrees/), which Biome's
# files.ignore matches — silently skipping the file.
REL="${FILE_PATH#"$REPO_ROOT"/}"
BIOME="$REPO_ROOT/node_modules/.bin/biome"
[ -x "$BIOME" ] || BIOME="npx biome"
OUTPUT=$($BIOME check --reporter=github "$REL" 2>&1)
ERRORS=$(grep '^::error' <<< "$OUTPUT" || true)
[ -z "$ERRORS" ] && exit 0
MSG="BIOME ERRORS in $REL — fix now (errors block git push/merge):
$ERRORS
Run: pnpm exec biome check --write '$REL'"
emit_json() {
  python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':sys.argv[1]}}))" "$MSG" 2>/dev/null && return
  python  -c "import json,sys; print(json.dumps({'hookSpecificOutput':{'hookEventName':'PostToolUse','additionalContext':sys.argv[1]}}))" "$MSG" 2>/dev/null && return
  node -e "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:process.argv[1]}}))" "$MSG" 2>/dev/null && return
}
emit_json
exit 0
