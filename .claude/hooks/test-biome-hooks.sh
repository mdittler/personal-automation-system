#!/usr/bin/env bash
# Smoke tests for the Biome enforcement hooks (biome-check.sh, biome-check-file.sh).
# Run: bash .claude/hooks/test-biome-hooks.sh   (or: pnpm test:hooks)
# Exit 0 if all pass, 1 if any fails.
#
# Part A drives every decision branch with a fake `biome` binary (deterministic).
# Part B runs the real Biome on a temp fixture (catches integration bugs, e.g.
# absolute paths that Biome's .claude ignore would silently skip).
set -u
HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# ---------------------------------------------------------------- Part A ----
echo "Part A — decision logic (fake biome binary)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
git -C "$TMP" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
mkdir -p "$TMP/node_modules/.bin" "$TMP/.claude/hooks"
cp "$HOOKS_DIR/biome-check.sh" "$HOOKS_DIR/biome-check-file.sh" "$TMP/.claude/hooks/"
cat > "$TMP/node_modules/.bin/biome" <<'FAKE'
#!/usr/bin/env bash
# Fake biome — behavior selected by $FAKE_MODE, ignores all arguments.
case "${FAKE_MODE:-}" in
  clean)   exit 0 ;;
  error)   echo '::error title=lint/correctness/x,file=f.ts::boom'; exit 1 ;;
  warning) echo '::warning title=lint/style/y,file=f.ts::meh'; exit 0 ;;
  tooling) echo 'internalError/fs: simulated biome crash' >&2; exit 2 ;;
  nofiles) echo '× No files were processed in the specified paths.'; exit 1 ;;
  *)       exit 0 ;;
esac
FAKE
chmod +x "$TMP/node_modules/.bin/biome"
echo "export const v = 1;" > "$TMP/f.ts"

# biome-check.sh (git-hook mode): 0 = pass, 1 = blocked
bc() { (cd "$TMP" && FAKE_MODE="$1" bash .claude/hooks/biome-check.sh git-hook) >/dev/null 2>&1; echo $?; }
[ "$(bc clean)"   = 0 ] && ok "biome-check.sh: clean -> pass"               || bad "biome-check.sh: clean"
[ "$(bc error)"   = 1 ] && ok "biome-check.sh: error -> blocked"            || bad "biome-check.sh: error"
[ "$(bc warning)" = 0 ] && ok "biome-check.sh: warning-only -> pass"        || bad "biome-check.sh: warning-only"
[ "$(bc tooling)" = 1 ] && ok "biome-check.sh: tooling failure -> blocked"  || bad "biome-check.sh: tooling failure"
[ "$(bc nofiles)" = 0 ] && ok "biome-check.sh: no-files -> pass (benign)"   || bad "biome-check.sh: no-files"

# biome-check.sh (Claude PreToolUse mode): only git push/merge is gated
pc() { (cd "$TMP" && FAKE_MODE=clean bash .claude/hooks/biome-check.sh) <<< "$1" >/dev/null 2>&1; echo $?; }
[ "$(pc '{"tool_input":{"command":"ls -la"}}')" = 0 ]      && ok "biome-check.sh: non-git command -> skipped"   || bad "biome-check.sh: non-git command"
[ "$(pc '{"tool_input":{"command":"git push origin"}}')" = 0 ] && ok "biome-check.sh: git push (clean) -> pass" || bad "biome-check.sh: git push"
[ "$(pc 'not json at all')" = 0 ]                          && ok "biome-check.sh: malformed JSON -> no crash"  || bad "biome-check.sh: malformed JSON"

# biome-check-file.sh: emits JSON additionalContext on errors/tooling-failure, silent otherwise
bcf() { (cd "$TMP" && FAKE_MODE="$1" bash .claude/hooks/biome-check-file.sh) <<< "{\"tool_input\":{\"file_path\":\"$TMP/f.ts\"}}" 2>/dev/null; }
out=$(bcf clean);   [ -z "$out" ]                                && ok "biome-check-file.sh: clean -> silent"   || bad "biome-check-file.sh: clean"
out=$(bcf error);   grep -q '::error' <<< "$out" && grep -q additionalContext <<< "$out" && ok "biome-check-file.sh: error -> JSON reminder" || bad "biome-check-file.sh: error"
out=$(bcf warning); [ -z "$out" ]                                && ok "biome-check-file.sh: warning-only -> silent" || bad "biome-check-file.sh: warning-only"
out=$(bcf tooling); grep -q 'could not check' <<< "$out"         && ok "biome-check-file.sh: tooling failure -> JSON reminder" || bad "biome-check-file.sh: tooling failure"
out=$(bcf nofiles); [ -z "$out" ]                                && ok "biome-check-file.sh: no-files -> silent (benign)" || bad "biome-check-file.sh: no-files"
out=$( (cd "$TMP" && bash .claude/hooks/biome-check-file.sh) <<< 'not json' 2>/dev/null )
[ -z "$out" ]                                                    && ok "biome-check-file.sh: malformed JSON -> no crash" || bad "biome-check-file.sh: malformed JSON"

# ---------------------------------------------------------------- Part B ----
echo "Part B — real Biome integration"
REPO_ROOT=$(cd "$HOOKS_DIR/../.." && git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$REPO_ROOT" ] && [ -x "$REPO_ROOT/node_modules/.bin/biome" ]; then
  ERRF="$REPO_ROOT/core/src/__biome_hook_smoke__.ts"
  printf "import { readFile } from 'node:fs';\nexport const v = 1;\n" > "$ERRF"
  out=$( (cd "$REPO_ROOT" && bash "$HOOKS_DIR/biome-check-file.sh") <<< "{\"tool_input\":{\"file_path\":\"$ERRF\"}}" 2>/dev/null )
  grep -q 'noUnusedImports' <<< "$out" && ok "real biome: error file -> reminder surfaces" || bad "real biome: error file (got: ${out:0:80})"
  printf "export const v = 1;\n" > "$ERRF"
  out=$( (cd "$REPO_ROOT" && bash "$HOOKS_DIR/biome-check-file.sh") <<< "{\"tool_input\":{\"file_path\":\"$ERRF\"}}" 2>/dev/null )
  [ -z "$out" ] && ok "real biome: clean file -> silent" || bad "real biome: clean file"
  rm -f "$ERRF"
else
  echo "  SKIP: real Biome binary not found at \$REPO_ROOT/node_modules/.bin/biome"
fi

echo "----"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
