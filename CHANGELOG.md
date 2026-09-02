# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What "notable" means here:** anything that changes what you install, what you run, what a tool
returns, or what a file on disk looks like. Internal refactors are left out. Where a change was made
because something measurably went wrong, the number is given — this project's claims are supposed to
be checkable.

## [1.3.0] — 2026-09-02

### Added

- **`latest` no longer promises recency it cannot deliver.** When files the index has not read are
  newer than the newest row it can rank, the response now says so, names those files, and stops
  claiming `results[0]` is the last word. The observed failure: the answer sat in a file written at
  17:02, the index was built at 00:24, and the response reported 25 unread files *and still* returned
  the previous day's document as the last word. Additive — every other field, including the git
  verification layer, is unchanged.

- **The indexer reports documents that vanished.** When a document present in the last index is gone
  from the corpus, it is named. Report only; the refusal guards added in 1.2.0 handle the
  catastrophic cases. `MEMORY_VANISH_REPORT=0` disables it.

- **Memories record the instruction they were written under** (`originTask`, plus `originSessionId`).
  A rule given to one session was being read by later sessions as a universal standing rule. A
  `feedback` memory that carries the field now says, on read, that a rule is not automatically
  universal. Captured from the last user instruction at write time, redacted and truncated; memories
  written earlier simply have no value, and absence is left as absence rather than guessed.

### Changed

- The bundled `commit-memories` hook stamps every missing metadata field rather than stopping at the
  first one present, so a memory written before a field existed can gain it later.

## [1.2.1] — 2026-09-02

### Removed

- **The "ordinary words" shadow instrumentation is no longer distributed.** 1.2.0 shipped
  `lib/ordinary-shadow.js` and documented two environment variables for it. That was a mistake on
  my part: it is an unproven measurement running under a pre-registration whose own reading rule
  says it earns a *proposal*, not a behaviour — so it belongs in the tree where it is being
  measured, not in everyone's install. It never changed an answer, and removing it changes none
  either.

### Changed

- **Telemetry can no longer break search.** `lib/search.js` now loads its instrumentation lazily
  and optionally: if the module is missing or fails to load, searching continues with a no-op and
  says nothing about it. This is what makes the removal above possible, and it is the right shape
  regardless — a measurement module should never be a hard dependency of the thing it measures.

## [1.2.0] — 2026-09-02

### Changed

- **Index files are about a third the size, and load roughly three times faster.** Embedding
  vectors are now stored as base64-encoded float32 rather than as JSON number arrays
  (`INDEX_FORMAT_VERSION` 1 → 2). Measured on a 2,676-document corpus: index file
  **158.8 MB → 55.7 MB**, first query after start **1291 ms → 412 ms**, peak memory while loading
  **877 MB → 435 MB**. A server that has answered a query against that corpus settles at
  **759 MB instead of 1307 MB**.

  **Your existing index keeps working and is not re-embedded.** The reader accepts both formats, so
  a version-1 index loads unchanged; it is rewritten in the new format the next time you rebuild.
  Verified bit-for-bit: 725,760 stored values compared, zero differences, zero changes to any
  search result.

  Vectors are also held as `Float32Array` in memory. This is not a precision change — the values
  were already 32-bit and merely stored in 64-bit slots. Measured across a fixed query set: every
  score identical, zero rank changes.

- **An older release refuses a version-2 index by name** instead of silently finding no vectors and
  answering from keyword search alone. If you downgrade, you will see a clear header refusal telling
  you to upgrade or rebuild — not a quietly worse server.

### Added

- **`memory({action:"get", name, brief:true})`** — returns the text and where it came from, without
  the ~25 provenance and freshness fields. Useful when you have already decided to read a memory and
  just want its content. The default response is unchanged. Truncation bookkeeping (`totalChars`,
  `returnedChars`, `truncated`, `readNote`) is always kept, so a partial read is never mistaken for a
  whole document.

- **The indexer refuses to destroy an index it was asked to refresh.** Two guards:
  a build from an empty root list is refused (a corpus whose directories are unconfigured resolves to
  nothing, and that is not an instruction to erase), and a build that finds **zero** documents where
  the existing index has some is refused with both counts named. A drop of more than half warns
  rather than refuses. `allowEmpty` / `allowShrink` override. Both fail open when they cannot tell:
  a first build, or an unreadable existing index, is never blocked.

- **Deleted memories are held back from the automatic commit.** If you use the bundled
  `commit-memories` hook, a removed `*.md` is no longer staged: it stays in `HEAD`, the removal is
  reported with the exact command to undo it, and everything else in the same turn still commits.
  `--accept-deletions` commits removals deliberately; `--status` reports what is being held.

- **`MEMORY_VEC_ENCODING`** — `base64` (default) or `array` to write the pre-1.2 shape, for handing
  an index to an older build.

### Fixed

- A document that links to itself no longer appears in its own `links`. Backlinks already excluded
  self; the two sides now agree.

## [1.1.0] — 2026-09-01

First public release.

A two-tier hybrid retrieval MCP server over a folder of markdown files: BM25F + dense embeddings +
phrase evidence, with an absence layer that reports having nothing rather than returning the best of
a bad set.

Notable behaviour, since there is no earlier entry to diff against:

- **Absence is a first-class answer.** When the distinctive words of a question appear nowhere in the
  corpus, or nothing scores, the server says so and returns the nearest documents clearly labelled as
  *not* answers.
- **`action:"latest"` for state questions** — a term filter ordered newest-first, because relevance
  ranking cannot answer "did X finish": "we are starting X" and "X is done" are equally about X.
- **Secrets are scrubbed on the way in**, with a final pattern sweep over the serialized index; the
  bundled commit hook refuses to run if a git remote exists while plaintext credentials are present.
- **Windows correctness**: UTF-8 BOMs and CRLF line endings in frontmatter and bodies are handled.
- **Every query is logged locally** for measurement (`MEMORY_QUERY_LOG`, `0` disables).

[1.3.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.3.0
[1.2.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.1
[1.2.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.1.0
