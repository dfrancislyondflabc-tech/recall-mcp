#!/bin/bash
# Double-click this. It works out where you put this folder, checks that the bundled
# Node actually runs here, and opens a page with the exact text to paste into Claude.
cd "$(dirname "$0")" || exit 1
echo
echo "  Setting up the Memory server for Claude..."
echo
if [ ! -f runtime/node ]; then
  echo "  ERROR: runtime/node is missing — the zip did not extract completely."
  read -n 1 -s -r -p "  Press any key to close."; exit 1
fi
chmod +x runtime/node 2>/dev/null
# macOS quarantines anything that arrived in a downloaded zip. Without this the
# bundled Node is killed on sight and the error ("cannot be opened") names Apple,
# not this folder, which sends people hunting in the wrong place.
xattr -dr com.apple.quarantine . 2>/dev/null
./runtime/node packaging/setup-page.mjs
RC=$?
echo
[ $RC -ne 0 ] && echo "  The check FAILED. SETUP.html explains what went wrong." || echo "  Ready. Opening SETUP.html..."
open SETUP.html 2>/dev/null
echo
read -n 1 -s -r -p "  Press any key to close."
echo
