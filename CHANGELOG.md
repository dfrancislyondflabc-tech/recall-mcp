# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What "notable" means here:** anything that changes what you install, what you run, what a tool
returns, or what a file on disk looks like. Internal refactors are left out. Where a change was made
because something measurably went wrong, the number is given — this project's claims are supposed to
be checkable.

## [1.4.1] — 2026-09-02

Four more defects, all found by an agent given only this repository and told to break it.

### Security

- **`import` no longer reads files off your machine.** `unzip` restores stored symlinks, and the
  import walker followed them — so a zip containing `notes.md -> /etc/hosts` imported the host's
  `/etc/hosts` as a searchable memory, and one pointing at `~/.ssh/config` or `~/.aws/credentials`
  would import those. The recorded provenance named the temp extraction directory, so nothing in
  the corpus showed the content came from outside the archive. Folder imports had the same hole.
  Both now refuse a symlink that resolves outside the source, and **say which files were refused**.
  Contents *inside* the archive are unaffected.

- **`metadata: secret: true` now binds immediately in `search`.** Marking a memory secret excluded
  it from the corpus at load time, but search answers from the index — so until the next rebuild
  the flag did nothing there: `get` refused the memory while `search` still returned its name, its
  description and a body snippet. The check now runs at output time, on the returned rows only, and
  the response says when something was withheld.

### Fixed

- **One unreadable file no longer takes the whole memory offline.** A `chmod 000` file — or a file
  deleted between listing and reading, on a folder the design expects you to edit while the server
  runs — threw out of the corpus load. Every query then answered "no index — run `npm run index`",
  advice that could not help because the rebuild threw the same error, and asking for a healthy
  memory returned an error naming a *different* file. Bad files are now skipped and named with
  their reason, and the rest of the corpus keeps serving.

- **A wrong-length vector in an index is refused instead of silently hiding documents.** The
  base64 path validated the dimension; the plain-array path did not. A short array made `cosine`
  return `NaN`, and `NaN` loses every comparison — so affected documents did not rank low, they
  **disappeared** from results while the response still said `confidence: "high"`.

## [1.4.0] — 2026-09-02

A security audit — 37 probes across path traversal, injection, SSRF, secret handling and resource
limits. Twenty categories were clean. Three were not.

### Security

- **A symlink inside your corpus can no longer read outside it.** Planting `passwd.md ->
  /etc/passwd` in the corpus directory got `/etc/passwd` indexed, searchable, and returned in full.
  The effective boundary was not your corpus directory but *everything reachable from it* — and the
  contents end up in an index on disk and in a model's context. Paths are now resolved with
  `realpath` and anything landing outside the root is refused. **A symlink that stays inside your
  corpus still works**, since that is a legitimate way to organise notes.

- **AWS access keys and private keys are now redacted.** The pattern for prefixed API keys required
  a `-` or `_` after the prefix — correct for `sk-…` and `ghp_…`, wrong for AWS, whose key ids are
  `AKIA` followed immediately by 16 characters. So an AWS key pasted into a memory was indexed in
  plaintext, written to the index file, and returned to the caller. Same for
  `-----BEGIN … PRIVATE KEY-----`. Both were already caught by the bundled commit hook, so the two
  lists had drifted apart. Deliberately narrow: IAM *identifiers* (`AIDA…`, `AROA…`), public keys
  and certificates are **not** redacted, because over-redaction corrupts documentation.

- **The tool now states that what it returns is content, not instruction.** A memory whose body
  reads "ignore all previous instructions…" is returned verbatim — refusing to show a memory for
  containing imperative text would be worse — but nothing said it was retrieved data. This corpus
  is written by an assistant and read by an assistant, so text that lands in it comes back later
  carrying authority it never earned.

### Clean, and worth stating

Path traversal via `get` (7 shapes), scope and library-category path injection (5), `section:`
traversal and out-of-range offsets, names containing NUL or newlines, the write side, SSRF from
URLs in corpus text, and shell metacharacters in corpus content reaching the git join — **all
refused already**. No token or handshake was added: this server has no network listener at all
(stdio only), so a token would guard a door that does not exist.

## [1.3.1] — 2026-09-02

Everything here was found by two reviewers who knew nothing about this project — one told to break
it, one told to follow the README as a newcomer. Both found things the author could not see.

### Fixed

- **`latest` no longer returns nothing on a fresh install.** It defaults to the `staging` corpus,
  which is populated by the capture hook — so a new user who did exactly what the README says
  (point `MEMORY_DIR` at a folder of notes) got `results: []` plus advice to run an index command
  that could not help them. It now falls back to `curated` when staging is absent or empty, and
  **says so** in a `scopeFallback` field rather than switching silently. An explicit scope is
  always obeyed, including an explicitly empty one.

- **`latest` no longer reports substring matches as if they were mentions.** The substring filter
  is deliberate — it is what lets a commit SHA or `v111` find the document that cites it. Reporting
  the count without saying so was not: asked about a Rust rewrite that never happened, it returned
  `totalMentions: 509` with results dated today, one carrying a git-verified commit, under
  *"results[0] is the last thing said about this"* — and every match was the word **trust**. The
  response now carries `termFrequenciesWholeWord` beside `termFrequencies` and leads with a warning
  when a term matches in no document as a separate word. Filtering and ordering are unchanged.

### Documentation

Corrected in the README and CONTRIBUTING: broken backticks and a link to a section that does not
exist; corpus statistics that read as properties of *your* corpus; **an example memory file, which
1,174 lines never showed**; "twelve actions" vs thirteen; a duplicated environment row; two
commands that do not exist in the distribution; the claim that a demote/promote round trip is
"byte-for-byte reversible" (it is not, for a file that had no frontmatter); and twelve `test/…`
paths that read as instructions to open files this distribution deliberately excludes.

Also newly documented: **the absence verdict is less reliable on a small corpus**, which is the
day-one condition. Measured at 5 of 20 answerable questions refused on a 122-file corpus, and 3 of
4 on a 13-file one. It fails safe — the right document is in `bestWeak` — but on a young corpus
read `bestWeak` before believing a refusal.

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
  **158.8 MB → 55.7 MB**, time to **parse the index** **1291 ms → 412 ms**, peak memory while
  loading **877 MB → 435 MB**. A server that has answered a query against that corpus settles at
  **759 MB instead of 1307 MB**.

  *(Corrected after 1.3.0: this line first said "first query after start", which is not what was
  measured — a first query also pays model load, about 250–350 ms, which this change does not
  touch. The parse figure is the honest one.)*

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

[1.4.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.4.1
[1.4.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.4.0
[1.3.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.3.1
[1.3.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.3.0
[1.2.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.1
[1.2.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.1.0
