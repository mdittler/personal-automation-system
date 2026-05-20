#!/usr/bin/env bash
# Installs pre-push / pre-merge-commit dispatchers that run all pre-merge gates.
# Worktree-safe: `git rev-parse --git-path hooks` resolves correctly in worktrees.
set -e
HOOKS_DIR=$(git rev-parse --git-path hooks 2>/dev/null) || exit 0
mkdir -p "$HOOKS_DIR"
for hook in pre-push pre-merge-commit; do
  cat > "$HOOKS_DIR/$hook" <<'SH'
#!/usr/bin/env bash
set -e
ROOT=$(git rev-parse --show-toplevel)
bash "$ROOT/.claude/hooks/tsc-nocheck.sh" git-hook
bash "$ROOT/.claude/hooks/biome-check.sh" git-hook
SH
  chmod +x "$HOOKS_DIR/$hook"
done
echo "git hooks installed in $HOOKS_DIR"
