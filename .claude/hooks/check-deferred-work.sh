#!/usr/bin/env bash
# Deferred-work tracker: reminds Claude to update docs/open-items.md when
# a spec, plan, or findings doc is written that contains deferred-work language.
#
# Triggered by: PostToolUse on Write|Edit
# Acts on:     docs/superpowers/specs/, docs/superpowers/plans/, docs/*-findings*.md
# Ignores:     docs/open-items.md (the destination itself)

INPUT=$(cat)

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

# Only act on spec/plan/findings docs
[[ "$NORM_PATH" =~ docs/superpowers/(specs|plans)/ ]] || \
  [[ "$NORM_PATH" =~ docs/.*-findings.*\.md$ ]] || exit 0

# Never remind when editing open-items.md itself
[[ "$NORM_PATH" =~ open-items\.md$ ]] && exit 0

# Check the file for deferred-work language (-E; -P not available on all platforms)
if grep -qiE '(deferred|out of scope|follow-?up|not yet implemented|future phase|next phase|TODO|to be done|to be added|backlog)' "$FILE_PATH" 2>/dev/null; then
  MSG="DEFERRED-WORK NOTICE: \"$NORM_PATH\" contains deferred-work language. Before finishing, check whether any out-of-scope or explicitly postponed items need an entry in docs/open-items.md under the appropriate section (Confirmed Phases, Deferred Infrastructure Work, Unfinished Corrections, Food App Enhancements, Proposals, or Accepted Risks)."

  emit_json() {
    python -c "import json,sys; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': sys.argv[1]}}))" "$MSG" 2>/dev/null && return
    python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PostToolUse', 'additionalContext': sys.argv[1]}}))" "$MSG" 2>/dev/null && return
    node -e "const m=process.argv[1];console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:m}}))" "$MSG" 2>/dev/null && return
  }

  emit_json
fi

exit 0
