#!/bin/bash
# Memory MCP server - macOS/Linux setup.
# Installs dependencies for THIS machine (native binaries are per-platform, which
# is why node_modules is not shipped) and prints the config to paste into Claude.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "ERROR: Node.js is not on PATH. Install Node 20+."; exit 1; }
command -v git  >/dev/null || echo "NOTE: git is not on PATH. The server runs, but commit verification is disabled."

echo "Installing dependencies for $(uname -s)..."
npm install --omit=dev

echo
echo "Building the initial index..."
npm run index

echo
echo "Verifying the server over stdio..."
# `npm run verify` and NOT `npm test`: the full suite asserts against a populated
# corpus and cannot pass on a machine that has none yet, which is every new
# install. This checks what actually matters here.
npm run verify

cat <<EOF

==========================================================
Add this to your Claude MCP config ("mcpServers"):

  "memory": {
    "command": "node",
    "args": ["$(pwd)/index.js"]
  }

Then see INSTALL-MAC.md for the capture hooks.
==========================================================
EOF
