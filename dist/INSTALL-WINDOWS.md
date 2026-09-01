# Memory MCP server — Windows install

Runs on Windows and macOS from the same source. Native binaries (`onnxruntime`,
`sharp`) are per-platform, which is why `node_modules` is **not** in the zip —
`npm install` fetches the right ones for this machine.

## Requirements

- **Node.js 20+** — https://nodejs.org
- **git** (optional) — only for commit verification. Without it the server runs
  fine and the git checks simply stay silent.

## 1. Install

Unzip somewhere permanent (e.g. `C:\Tools\recall-mcp`), then double-click
`setup.cmd`, or from a terminal:

```
cd C:\Tools\recall-mcp
setup.cmd
```

It installs dependencies, builds the initial index, verifies the server over
MCP stdio, and prints your config. **If verification fails, stop** — don't
register a server that isn't answering.

(It runs `npm run verify`, not `npm test`. The full suite asserts against a
populated corpus, so it cannot pass on a machine that has none yet — which is
every new install. Run `npm test` later, once conversations have been captured.)

## 2. Register the server

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Claude Desktop) and/or
`%USERPROFILE%\.claude.json` (Claude Code), under `mcpServers`:

```json
"memory": {
  "command": "node",
  "args": ["C:/Tools/recall-mcp/index.js"],
  "env": {
    "MEMORY_GIT_REPOS": "C:\\path\\to\\repo-one;C:\\path\\to\\repo-two"
  }
}
```

**Note the `;`** — path lists use the platform delimiter, which is a semicolon on
Windows. A colon would split `C:\...` at the drive letter. `MEMORY_GIT_REPOS` is
optional; leave it out and commit verification stays off.

Forward slashes in `args` are fine and avoid JSON escaping headaches.

## 3. Turn on conversation capture (optional but recommended)

Without hooks the server still answers queries; it just won't ingest new
conversations automatically. Add to `%USERPROFILE%\.claude\settings.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node C:/Tools/recall-mcp/scripts/auto-ingest.js", "timeout": 900, "async": true },
        { "type": "command", "command": "node C:/Tools/recall-mcp/scripts/commit-memories.js", "timeout": 120, "async": true }
      ]}
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node C:/Tools/recall-mcp/scripts/auto-ingest.js", "timeout": 900, "async": true } ]}
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [ { "type": "command", "command": "node C:/Tools/recall-mcp/scripts/stamp-memory-account.js", "timeout": 60, "async": true } ]}
    ]
  }
}
```

These commands are **identical on Windows and macOS** apart from the path: the
scripts read the hook's JSON from stdin themselves, so there is no `jq`, no pipe
and no shell involved.

## 4. Build the first index

```
npm run index
```

Then restart Claude. **Restart after any change to the server's tool schema** —
Claude caches MCP tool definitions at connection time and silently drops
arguments it doesn't know about.

## What is NOT in this zip

**Your memories and captured conversations.** The corpus is machine-specific and
this Windows box will build its own from its own Claude sessions. It is also a
deliberate safety choice: memory files can contain credentials in plaintext, and
copying them between machines spreads that.

If you do want to bring memories across, copy the `.md` files into
`%USERPROFILE%\.claude\projects\<project>\memory\` yourself — after checking
what's in them.

## Troubleshooting

| symptom | cause |
|---|---|
| `embedding model unavailable` | `sharp`/`onnxruntime` didn't install. Search still works, keyword-only. Re-run `npm install`. |
| Server missing from Claude | Bad JSON in the config, or Claude wasn't restarted. |
| Tool args ignored | Cached schema — fully quit and relaunch Claude. |
| Everything found is stale | Run `npm run index`. Responses carry `indexStale` and name the changed files. |
| Git checks silent | `MEMORY_GIT_REPOS` unset, git not on PATH, or a colon used instead of `;`. |
