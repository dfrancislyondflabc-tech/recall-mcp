# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**What "notable" means here:** anything that changes what you install, what you run, what a tool
returns, or what a file on disk looks like. Internal refactors are left out. Where a change was made
because something measurably went wrong, the number is given — this project's claims are supposed to
be checkable.

## [1.6.3] — 2026-09-04

Three features were reporting into a void. Each was verified against real data before being changed.

### Fixed

- **A memory that disappears is now written down, not just warned about.** The vanish report — the
  second net under a lost memory, catching at index time what the commit hook catches at commit time
  — emitted through `console.error`, from inside a process whose stderr the host keeps nowhere. The
  question it exists to answer ("when did those memories disappear") is asked *days* later, when any
  console is long gone. It now appends JSONL beside the index: timestamp, the names that went, and
  the document counts before and after. `MEMORY_VANISH_LOG` relocates it. Verified end to end:
  delete 3 of 16 memories, rebuild, and the sink names all three with `16 → 13`.
- **The nightly curation pass now records its queue.** It runs from a hook with `2>/dev/null` and
  stdout inherited, so every proposal and candidate it found went to a console nobody reads. Two
  sinks now: `.dream-queue.json` (what is waiting right now, overwritten each run so it cannot go
  stale, with the items themselves) and `.dream-runs.jsonl` (one row per run over time). Verified
  with a **non-empty** queue — a planted credential-bearing memory is recorded as
  `{"secret-review": 1}` while the credential itself appears **zero** times in the sink.
- **Graph-spread telemetry only records real queries now.** Measured on the live query log: of
  **2,210** rows carrying `shadowDivergence`, **2,210 came from the test suite and 0 from real
  traffic**. The measurement had never once observed a real query, so any conclusion drawn from it
  would have been a statement about the project's own tests. It now applies the same `src`-based
  filter the absence probe already used.

### Testing

The public suite grows to **48 checks** — the vanish sink is now a gated contract, mutation-tested
(with the write removed, the gate reports `rows: 0` and fails).

## [1.6.2] — 2026-09-04

Found by running the v1.6.1 release through an independent adversarial test pass. Every number below
was measured, and one proposed fix was **rejected** because measuring it showed it did nothing.

### Fixed

- **A long-running server answered from an index another process had already rebuilt.** The parsed
  index is cached for the life of the process, and the freshness check compared the *corpus* against
  that cached copy — never the cached copy against the index *file*. Measured: the on-disk index had
  been rebuilt at 13:36Z while the server was still answering from 06:51Z. The same query returned
  **0 results through the server and 2 against the index on disk**, with the response saying *"No
  document in any corpus mentions every term."* A confident absence over an answer that already
  exists is the worst thing a memory system can say. `ensureFresh` now compares the on-disk
  `builtAt` (a 4 KB header read, not a parse of a 56 MB file) and re-reads when it is newer.
- **A `memoryDir` that does not exist built an empty index and reported success.** `files indexed: 0`,
  exit 0, and — measured — **zero** occurrences of `not exist`, `missing`, `ENOENT`, `warn` or `error`
  anywhere in the output. `npm run index` now names the missing path and the setting that points at
  it, and exits non-zero. A root that exists but is empty still exits 0: that is a fresh install.
- **`corpus : [object Object]`** in the index report — the corpus root list was template-stringified,
  in the first command the README tells a new user to run.
- **`MEMORY_SNAPSHOTS_PER_FILE=0` (or negative) silently deleted every snapshot**, including the one
  just written, removing the recovery path `MEMORY-SAFETY.md` advertises. Now clamped to at least 1.
  A non-numeric value already failed open; only the numeric cases failed closed.

### Removed

- **The SKU/model family-alias layer.** Re-measured against its own frozen pre-registered set:
  **0 of 12** target questions improved, bar was ≥8. It also shipped broken — `lib/aliases.js` was in
  the release tree while its generated data file was excluded, so it read a file that was not there.
  Proved to be a no-op before removal: 46 real queries snapshotted before and after **with the clock
  frozen**, byte-identical. (Unfrozen, `recencyFactor` drifts ~1e-4 an hour and looks like a change.)

### Not changed, and why

- **A long verbatim body quote can retrieve worse than a short one.** Diagnosed to the keyword
  floor, then the proposed fix was **rejected on measurement**: over 45 verbatim body sentences it
  moved nothing (rank-1 25 → 25, missing 18 → 18), and stronger settings made it worse. The floor is
  not the binding constraint. Now documented under **Known limitations** in the README, with the
  workaround, rather than silently carried.

## [1.6.1] — 2026-09-03

### Added

- **[`MEMORY-SAFETY.md`](MEMORY-SAFETY.md) — can this lose my memories?** The complete list of what
  this server writes into *your* memory folder (frontmatter stamps; new files from `import`; an
  archived copy on `import … replace`), the fact that **no code path deletes from it**, and the one
  door those writes go through:
  - a "metadata" edit whose **body** differs is refused, not written — the realistic corruption mode
    (a frontmatter-splitting bug eating content) cannot reach your disk;
  - the previous bytes are **snapshotted** to `.memory-snapshots/` first (newest 5 per file,
    `MEMORY_SNAPSHOTS_PER_FILE` to change or disable);
  - writes are **atomic**, so a crash leaves the old file or the new one, never half of either;
  - a new memory **never** overwrites an existing file; `import … replace` archives the old version
    (stamped `supersededAt`) and the writer verifies the archived copy exists before replacing.
- **`MEMORY_CURATED_READ_ONLY=1` — the server writes nothing to your memory folder at all.** It
  still indexes, searches and auto-captures into its own `store/`. Recommended for a first run
  against memories you care about: nothing in retrieval depends on the stamps it would otherwise add.
  19 checks in suite group `(a70)`, each mutation-tested (remove the guard, the test goes red).

### Changed

- **Dream supersession no longer queues work; it computes and logs (`DREAM_SUPERSESSION=shadow` is
  now the default).** Measured over its whole life: of 27 unique candidates, 6 survived
  claim-containment and **0 of those 6 were genuine** — three named memories that had already been
  corrected, three that never contained the claim. The standing rule for a judgment feature is that
  precision below 50% does not get to act. Containment itself is sound (21 of 21 rejections correct
  on inspection), so the evidence keeps accruing behind the flag; `DREAM_SUPERSESSION=on` restores
  the old behaviour.

### Fixed

- **The stale-tail pruner required only a matching *description* as evidence.** A description is the
  ask's first 40 words, and 144 files in this author's store share one with a sibling (15 of them
  described `"continue"`), so a real memory with a unique body could be deleted the moment its name
  stopped being emitted. It now requires **body identity** — a stale tail is a copy, and a matching
  description with a different body is a real memory, kept and named.
- **An agent report that quoted its own sub-agents was truncated at the inner `</result>`**, storing
  the inner envelope as prose and losing the outer conclusion. The outer report is now taken to the
  last `</result>` with nested envelopes stripped, and `[[wikilinks]]` inside a machine-written
  report are neutralised so it cannot mint graph edges.
- **The no-timestamp fallback name hashed the ask alone**, so two identical asks ("continue", twice)
  collapsed into one file and reported `wrote 2`. It now includes the turn index, and any run whose
  names are not unique **refuses and writes nothing** rather than overwriting.
- **A session holding both old and new name shapes** (a rollback, or an older copy still running) was
  ordered by name, which put a *newer* legacy file at the front of the thread and made `threadLast`
  two days stale. Such a session is now ordered by the ask timestamp.
- **The vector cache ignored `MEMORY_ROOT`**, so a released copy under `dist/capture/` would have
  re-embedded from scratch into its own cache on every release. `release-capture.sh` now smoke-checks
  the store, staging index, vector cache and local config all resolve inside the repo.
- **The migration script said "pre-checks ok" for two collision classes** and then overwrote: an
  existing new-shape file, and two sessions sharing an 8-character prefix. Both now refuse at
  pre-check with nothing touched; it also refuses a file with no usable timestamp (rather than
  inventing a name the writer would not reproduce), remaps dream state keyed by filename, and retires
  the staging index so a stale one cannot be served.
- A `<cross-session-message>` from another Claude session was folded in as if the human had typed it
  (3 files in this author's store, since rewritten).

## [1.6.0] — 2026-09-03

### Changed — on-disk format

- **Exchange names are content-stable.** `x-<sid8>-NNNN` (the exchange's *position* in the
  transcript) becomes `x-<sid8>-<ask timestamp, compacted>` — e.g. `x-fb357616-20260903T054233800Z`.
  Position was the root of every store defect found this week: a withdrawn extractor rule inserted 20
  exchanges and renumbered 715 files, leaving 19 duplicate memories; a windowed capture numbered from 1
  and overwrote a session's first two; a deletion bound computed from the ordinal removed a real
  memory. A name derived from *when the ask was made* cannot do any of those: inserting or dropping
  an exchange touches only that exchange, and a filtered run links to the same predecessor a full run
  would. The compact form is fixed-width UTC, so byte order is time order — measured over all 2,782
  files before migrating: zero duplicate stamps within a session and zero reorders. (An exchange with
  no timestamp — none exist today — gets `<day>Tx<8-hex hash of the ask>`, deterministic and visibly
  not an instant.) The `thread` reader sorts the suffix as a **string**; parsing it as a number would
  silently equate adjacent milliseconds. `scripts/migrate-stable-names.mjs` performs the one-time
  migration (dry-run by default; `--apply` rewrites `name:` and `Previous:`, renames, remaps dream
  state, and verifies count / name==basename / no dangling links / nothing old-shaped left).
- **Stale-tail pruning is now a set difference.** A file of the session whose name the extractor no
  longer yields *and* whose description duplicates one it does yield is removed on a plain full run;
  anything else is kept and named. The name set is taken before `--defer-last` pops the in-flight
  exchange (a first draft did not, and an in-flight ask that repeated an earlier one — "continue",
  twice — would have been deleted as its duplicate on a timed run). `MEMORY_PRUNE_ORPHANS=0` turns it
  off.

### Added

- **A subagent's final report joins the exchange it worked for.** An asynchronous agent's result
  arrives on the parent's timeline as `<task-notification>…<result>…</result>` — in the user role, so
  it was dropped with every other machine turn. Measured over all 556 agents on this machine: 297
  report this way, and the parent's own prose then restates a median 38% of the report's identifiers
  (SHAs, paths, line numbers); ~90% of agent conclusions were absent from the store. The `<result>`
  now appends to the reply as `**Agent report (task <id>):**`, with the human's session id as
  provenance. (Full ingestion of subagent transcripts is deliberately *not* done: 556 files, 239 MB,
  a third of whose retrieval keys are dead scratch paths or coordinator relays, and their filenames
  collapse to 16 buckets under the current session prefix — that is a separate corpus, not a walker
  flag.)
- **Capture runs from a released copy, not the working tree.** `npm run release:capture` copies
  `scripts/` + `lib/` at a committed, suite-green state to `dist/capture/` (stamped with the sha;
  refuses a dirty tree without `--force`), and `npm run install:capture-hooks` points the Claude Code
  hooks and the LaunchAgent at it with `MEMORY_ROOT=<repo>` so the copy keeps using the repo's store,
  indexes and config. Why: this week an uncommitted, untested extractor edit went live on the
  LaunchAgent's next 5-minute tick and deleted a real memory file from the gitignored store.
  `MEMORY_ROOT` is honoured by `lib/config.js`, `lib/local-config.js` and `lib/heartbeat.js`.
- **`npm run audit:store`** (`lib/store-audit.js`): per session with a transcript on disk, re-runs the
  extractor into scratch and reports `missing` (expected for live sessions), `orphan`,
  `duplicate-body`, `order` (name order ≠ ask-time order) and `dangling-prev`. Gated on fixtures in the
  suite (group a69), advisory on the live store.
- **Extractor fuzz** (group a68): random interleavings of human asks, assistant prose, tool traffic,
  thinking, task notifications and mid-turn messages; six invariants an oracle computes independently
  of the extractor (count, order, no lost reply text, every interjection kept, no tool/thinking text
  stored, idempotent, `--defer-last` drops exactly the in-flight exchange). 40 cases per seed; two
  historical defects each make it fail.
- **`npm run soak:concurrency`**: N simultaneous hook+timed pairs on one transcript (default 50);
  asserts one winner per pair, index docs == store files after every pair, no lock left, every
  process logged.
- **auto-ingest arms its log before importing anything** and writes a `started` line, so a crash
  during startup or a SIGTERM mid-run leaves a trace (a `started` with no terminal line is the
  signature). Previously an import failure exited with nothing written.

## [1.5.1] — 2026-09-03

### Fixed

- **A message you type while the assistant is still working is now captured.** The desktop client
  does not record it as a user turn: it writes a `queue-operation` (`remove`, reason
  `absorbed_mid_turn`; before 2026-08-26 the same event carried no reason) and hands the text to the
  model inside a tool result — which capture deliberately ignores. Measured across 122 sessions on
  the author's machine: **574** such messages, **0** ever became a user turn, **160** of the recent
  ones were nowhere in the store and 44 more survived only because a compaction summary happened to
  quote them. What was in them: "don't do this one yet", "ignore what I said about…", rulings,
  defect reports — corrections, which is what gets typed mid-turn.

  The message is folded into the exchange it interrupted, because that exchange's reply is what
  answered it: `**Asked:** …` followed by one `> **Added mid-reply:** …` block-quote per message
  *inside the ask paragraph* (every continuation line quoted, so a typed `# heading` cannot become
  one, and so `dream`'s correction detector — which reads everything after the ask paragraph as the
  assistant's words — never scores the user's "I got wrong" as the assistant's), with an
  `interjections: N` frontmatter count. Redaction and address scrubbing apply as to any ask. Folding
  rather than inserting keeps the positional names stable. A message the client later wrote as a
  real turn (within the next three human turns) is stored once, not twice; a `remove` with an
  unknown reason is not stored at all. Interjections that fall in a reply under the 200-char floor
  are **counted and printed**, not silently dropped. 141 of the 146 substantive lost messages are
  now first-hand retrievable.

- **A task notification landing mid-reply no longer severs the reply.** The reply scan stopped at
  the first non-assistant entry, and a `<task-notification>` arrives in the user role — so
  everything the assistant said after it attached to nothing, while the stored document read as
  complete ("Waiting for it to complete." with the 5,767-character conclusion in no file). Measured
  over the same 122 sessions: **230 cuts, 1,663 assistant turns, 912,151 characters — 9.0% of all
  assistant prose.** The reply now runs to the next *human* turn; a notification does not take over
  the open ask (so an interjection typed after one attaches to the human), and does not release an
  in-flight exchange under `--defer-last`. Old-vs-new over every transcript: store grows from
  16.72 MB to 17.83 MB. Six exchanges that had been cut below the floor now qualify, which
  renumbers four sessions once (no external `[[x-…]]` reference points into them).

- **`capture` with `sinceMinutes` no longer overwrites a session's first memories.** The name was
  built from a count of *emitted* exchanges, so a windowed run numbered the two recent exchanges
  0001 and 0002 and wrote them over the two oldest — two destroyed, two duplicated, the `Previous`
  chain crossed. Names now come from the exchange's position in the whole transcript, whatever
  filter is applied. Not observed in production; reproduced and fixed from review.

- **A rewrite keeps the account stamp — and every metadata line another writer added.** `account:`
  records who was signed in at capture; `secret: true` (exclusion), `tier:` (demotion) and
  `modified:` (fact-time) record deliberate decisions. Re-applying an extractor change to history is
  not a capture, so all of those now survive a rewrite verbatim. Without this, re-ingesting the
  affected sessions would have relabelled 182 files to whoever ran it and silently re-indexed any
  memory that had been excluded.

- **Capture bookkeeping, from a read-only adversarial review of the pipeline:**
  - the debounce stamp recorded the transcript size *after* the run, so anything appended during a
    run was marked captured and the next runs said "transcript unchanged" — the size is now read
    before the extractor runs, and no stamp is written after a failure;
  - the lock was check-then-write and released unconditionally (20 simultaneous hook+timed pairs:
    both ran 8 times, index one document short of the store 6 times while both log lines said
    "captured") — creation is now the test (`wx`), and only the holder releases;
  - auto-ingest decided "anything new?" by file *count*, so a rewrite of existing exchanges left the
    index describing the old text — it now refreshes on any write and logs `rewritten: N`;
  - every run-log line now names its `session`.

### Added

- `scripts/ingest-transcript.js --rewrite-only` — apply an extractor change to history without
  creating exchanges for sessions that were never captured. Never deletes.
- **Stale-tail pruning, narrowly.** Positional names mean an extractor rule that inserts an exchange
  renumbers every later file, and when that rule is withdrawn the tail beyond the new count is a set
  of duplicate memories — indexed and indistinguishable (this happened: 19 of them, from a rule
  withdrawn the same night). A plain full run now removes a file beyond the session's exchange count
  **only if its description duplicates a lower-numbered file of the same session**; anything else
  beyond the count is kept and named on stderr. This is the only code in the project that deletes a
  memory file, and it does not run under `--rewrite-only`, `--limit`, `--since-minutes`, or when the
  transcript yields no exchanges. Its first version bounded on the count *after* `--defer-last` had
  popped the in-flight exchange and would have deleted each session's newest memory on every timed
  run; review caught it after one real file had gone (recreated by the next plain run).
- A store slot whose `sessionId` belongs to a different session (an 8-character prefix collision) is
  refused and named, never overwritten.

### Corrected

- The 1.5.0 entry below cited "ten exchanges in one second, then a 283-minute gap" as the evidence
  for timed capture. That reading was wrong (see the box under 1.5.0). The interjection scenario
  given for the `--defer-last` fix was also wrong in this client: the message never enters the
  exchange list, so it cannot get stuck behind anything — it vanishes, which is the defect above.

## [1.5.0] — 2026-09-02

### Added

- **Capture no longer waits for a turn to end.** The capture hook fires on `Stop`, so its unit is a
  *turn* — an assistant's whole run of work between two of your messages. Measured in one real
  session: ten exchanges written in the same second, then a **283-minute gap** with nothing
  captured.

  > **Correction (1.5.1):** that measurement was misread. The burst was the first-ever ingest of a
  > session that had run uncaptured for five days, and the gap fell between two user messages — no
  > exchange existed to capture. The feature is still justified, on different grounds: a per-turn
  > hook can never reach a session that is resumed and closed without it firing; walking every
  > recently-touched transcript can. Left in place rather than rewritten, because a changelog that
  > quietly edits its own evidence is not one you can check. The data was never missing — the transcript is written continuously, verified live at
  17,222,315 → 17,233,511 bytes in 28 seconds while capture sat 2.0 minutes behind. Only the
  trigger waited.

  `npm run capture` (`scripts/timed-capture.mjs`) can now be scheduled. It walks **every**
  transcript touched inside a window, not just the most recent — running two conversations at once
  otherwise captures one and silently starves the other. It adds no state: the existing debounce
  and lock make it safe to run at any frequency.

  Timed runs are **provisional** and defer the in-flight exchange; hook runs are **final** and keep
  everything. That asymmetry is the whole design — dropping the last exchange on the hook would
  lose the final exchange of every session. A deferred exchange, once captured, is byte-identical
  to what a hook-only run would have produced.

- **Every capture run leaves one line in `.ingest-runs.jsonl`** — when, what triggered it, how many
  exchanges, whether the index refreshed, and *why* it did nothing when it did nothing. Everything
  previously went to stderr, which a hook host discards; that is exactly why "was the index stale
  because capture never ran, or ran and skipped?" was unanswerable. Rolls at a cap.

### Fixed

- A test asserted `found === true` against a `git grep` with a 1500 ms timeout, which returns
  *unknown* under load — measured at 152 ms when run alone, and it failed and passed on consecutive
  runs with no code change. The production timeout and its never-report-absent-on-timeout behaviour
  are unchanged; only the test's budget moved.

## [1.4.2] — 2026-09-02

### Security

- **A third import door is closed.** A zip whose `conversations.json` is a *symlink* was read
  before the guarded file walker ever ran, so it imported that file's contents as conversations —
  title and all — from anywhere on the machine. 1.4.1 fixed the walker; this fixes the door that
  bypasses it. The boundary check is now **one shared helper** used by every path, because a rule
  enforced in two places is a coincidence and this was the third place it was needed.

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

[1.5.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.5.0
[1.4.2]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.4.2
[1.4.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.4.1
[1.4.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.4.0
[1.3.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.3.1
[1.3.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.3.0
[1.2.1]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.1
[1.2.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.2.0
[1.1.0]: https://github.com/dfrancislyondflabc-tech/recall-mcp/releases/tag/v1.1.0
