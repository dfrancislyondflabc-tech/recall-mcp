# Memory MCP server — macOS install

Same source as Windows; only the paths differ.

## Requirements

- **Node.js 20+**
- **git** (optional) — only for commit verification.

## 1. Install

```bash
cd ~/path/to/recall-mcp
./setup.sh
```

Installs dependencies, builds the initial index, verifies the server over MCP
stdio, prints your config. **If verification fails, stop.**

(`npm run verify`, not `npm test` — the full suite needs a populated corpus,
which a new install does not have. Run `npm test` once conversations exist.)

## 2. Register the server

`~/Library/Application Support/Claude/claude_desktop_config.json` (Desktop) and/or
`~/.claude.json` (Code), under `mcpServers`:

```json
"memory": {
  "command": "node",
  "args": ["/Users/you/path/to/recall-mcp/index.js"],
  "env": {
    "MEMORY_GIT_REPOS": "/path/to/repo-one:/path/to/repo-two"
  }
}
```

Note the `:` here — the delimiter is a colon on macOS and a semicolon on Windows.

## 3. Capture hooks (optional but recommended)

`~/.claude/settings.json` — same commands as Windows, macOS paths:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node /Users/you/path/to/recall-mcp/scripts/auto-ingest.js", "timeout": 900, "async": true },
        { "type": "command", "command": "node /Users/you/path/to/recall-mcp/scripts/commit-memories.js", "timeout": 120, "async": true }
      ]}
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node /Users/you/path/to/recall-mcp/scripts/auto-ingest.js", "timeout": 900, "async": true } ]}
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [ { "type": "command", "command": "node /Users/you/path/to/recall-mcp/scripts/stamp-memory-account.js", "timeout": 60, "async": true } ]}
    ]
  }
}
```

## 4. First index

```bash
npm run index
```

Restart Claude afterwards, and after any tool-schema change.

## Not included

Memories and captured conversations — see the note in `INSTALL-WINDOWS.md`. The
corpus is per-machine, and memory files can contain plaintext credentials.
