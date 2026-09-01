# CLAUDE-SETUP.md — runbook for Claude

You are installing the **memory MCP server** on this machine. Follow this in order.
Do not skip verification steps; each one exists because it caught a real failure.

## 0. What this is

A local MCP server giving Claude persistent, searchable memory: hand-written
memories plus automatically captured conversation exchanges, over hybrid
retrieval (BM25 + dense vectors + phrase proximity). It runs on **Windows and
macOS** from identical source.

## 1. Preconditions — check, don't assume

```
node --version      # must be 20 or newer
git --version       # OPTIONAL: only for commit verification
```

If node is missing, stop and tell the user to install it from https://nodejs.org.
If git is missing, continue — the git features stay silent, nothing breaks.

## 2. Install

Unzip to a **permanent** location (not Downloads, not a temp dir — the MCP
config will point at this path forever). Then, from that directory:

- Windows: `setup.cmd`
- macOS:   `./setup.sh`

That installs dependencies, builds the index, and runs `npm run verify`.
**If verify fails, stop and report the failures.** Do not register a server that
isn't answering.

Note: `node_modules` is deliberately not shipped. `sharp` and `onnxruntime` have
per-platform native binaries, so `npm install` must fetch the right ones here.
The 33 MB embedding model **is** bundled, so no network is needed for embeddings.

## 3. If this zip includes memories

A `memories/` folder present at the top level means the user's curated memories
came with it. Do **not** try to copy them into `~/.claude/projects/<slug>/memory/`
— the project slug is derived from a directory path and will not match this
machine. Instead point the server at the folder explicitly with `MEMORY_DIR`
(step 4). A `store/` folder is captured conversation history and is already in
the right place; leave it where it is.

## 4. Register the server

Add to the `mcpServers` object in:

- Claude Desktop, Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Claude Desktop, macOS:   `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Code (both):      `~/.claude.json`

```json
"memory": {
  "command": "node",
  "args": ["<INSTALL_DIR>/index.js"],
  "env": {
    "MEMORY_DIR": "<INSTALL_DIR>/memories",
    "MEMORY_GIT_REPOS": "<REPO_ONE><DELIM><REPO_TWO>"
  }
}
```

- Use forward slashes in `args` even on Windows; it avoids JSON escaping bugs.
- **`<DELIM>` is `;` on Windows and `:` on macOS.** This matters: a Windows path
  is `C:\repos\x`, so a colon splits it at the drive letter and every git check
  silently does nothing.
- Omit `MEMORY_DIR` if there is no `memories/` folder.
- Omit `MEMORY_GIT_REPOS` if you have no local repos to verify against.

**Read the JSON back after writing it.** A malformed config makes the server
vanish with no error.

## 5. Conversation capture (recommended)

In `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node <INSTALL_DIR>/scripts/auto-ingest.js", "timeout": 900, "async": true },
        { "type": "command", "command": "node <INSTALL_DIR>/scripts/commit-memories.js", "timeout": 120, "async": true }
      ]}
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node <INSTALL_DIR>/scripts/auto-ingest.js", "timeout": 900, "async": true } ]}
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [ { "type": "command", "command": "node <INSTALL_DIR>/scripts/stamp-memory-account.js", "timeout": 60, "async": true } ]}
    ]
  }
}
```

Identical on both platforms apart from the path: the scripts read the hook's JSON
from stdin themselves, so there is no `jq`, no pipe and no shell involved.

**Merge with any existing hooks — do not replace the file.**

`commit-memories.js` gives the memory folder a git history so a bad overwrite is
recoverable. It is local-only by design and **refuses to run if a git remote is
configured while any memory file contains a plaintext credential**, because a
pushed history is permanent.

## 6. Build the index and restart

```
npm run index
```

Then **fully quit and relaunch Claude**. Tool schemas are cached at connection
time; without a restart new actions are missing and unknown arguments are
silently dropped.

## 7. Verify it actually works — through the TOOL, not the library

Every bug that shipped in this server was invisible to library-level tests. After
restarting, call it:

```
memory({action: "search", query: "<something the user actually worked on>"})
memory({action: "latest", query: "<an identifier: a SHA, file name, or flag>"})
```

Expect: `isError: false`, a `results` array, and freshness fields
(`indexBuiltAt`, `indexStale`, `serverVersion`). On a corpus with no documents
yet, `mode: "empty"` is correct and healthy, not a failure.

## 8. Usage notes worth passing to the user

- **`latest` is for state questions** ("did X finish", "what happened after Y").
  It term-filters and orders newest-first. **Query it with identifiers — SHAs,
  file names, flags, exact numbers — not prose.** Measured: `"pushed commit with
  failing test semicolon"` found nothing; `"pushed c509e0f"` found it instantly,
  in the same corpus.
- **`thread`** reads forward from a hit in sequence (`forward` / `back` — not
  `after`/`before`, which are search's date filters).
- **`verify`** checks a claim against git rather than judging its wording.
- **The last word is not current truth.** The corpus records what was *said*,
  never what happened after its newest exchange.

## 9. Troubleshooting

| symptom | cause |
|---|---|
| `embedding model unavailable` | `sharp`/`onnxruntime` install failed. Search still works, keyword-only. Re-run `npm install`. |
| Server missing in Claude | Malformed config JSON, or Claude not restarted. |
| Arguments ignored | Cached tool schema — fully quit and relaunch. |
| Results stale | `npm run index`. Responses carry `indexStale` and name changed files. |
| Git checks silent | `MEMORY_GIT_REPOS` unset, git not on PATH, or `:` used instead of `;` on Windows. |
| `npm test` fails on a new box | Expected — the full suite needs a populated corpus. Use `npm run verify`. |
