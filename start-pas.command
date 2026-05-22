#!/bin/bash
# Personal Automation System — double-clickable launcher for macOS.
# This is the Mac equivalent of start-pas.bat (.bat is Windows-only).
# Double-click in Finder to launch; it opens in Terminal and runs `pnpm dev`.

cd "$(dirname "$0")" || exit 1

# Finder launches .command files in a login shell, but make pnpm/node
# discoverable explicitly in case the login profile doesn't export them.
export PATH="$HOME/.npm-global/bin:/usr/local/bin:$PATH"

echo "Starting Personal Automation System..."
pnpm dev

# Keep the Terminal window open after exit (equivalent of the .bat's `pause`).
echo
echo "PAS has stopped. Press any key to close this window."
read -n 1 -s
