#!/usr/bin/env bash
# scripts/build-public-tree.sh — stage the shareable tree, and refuse to produce a dirty one.
#
#   ./scripts/build-public-tree.sh <dest-dir>
#
# Produces a DIRECTORY, not a zip, because the destination is a fresh public repository
# whose first commit is this tree. (Zip it afterwards if you want to hand someone a file.)
#
# THE EXCLUSIONS ARE THE POINT. Everything here ships from `git archive HEAD`, so the
# tracked files ARE the release. Three kinds of thing are removed:
#
#   1. THE TEST SUITE. 5,300 lines that assert against one particular corpus — it fails
#      for anyone else, and it holds internal host addresses, a real person's email and a
#      fixture directory named after the author. Excluding it removes an entire class of exposure
#      and costs the recipient nothing they could have used. A synthetic fixture corpus
#      would let it ship one day; that is a separate project.
#   2. VENDOR DOMAIN DATA. The alias table is 1,034 product models scraped from one
#      manufacturer, for a feature that is OFF by default and has never been switched on.
#      Deleting it is measurably free: search returns byte-identical scores without it,
#      and lib/aliases.js already falls back to an empty table. The MECHANISM stays and is
#      documented as "supply your own alias-table.json".
#   3. ONE MACHINE'S PLUMBING. The author's packaging script, the CI workflows that grep
#      for a plaintext credential, and the measurement harnesses bound to their corpus.
#
# AND THEN IT CHECKS. A list of exclusions is a promise; the gate is the proof. If
# check-release-clean.mjs finds anything, the staged tree is DELETED rather than left
# lying around to be published by someone who did not read the output. A refusal that
# leaves the artefact behind is not a refusal.
set -euo pipefail

DEST="${1:-}"
[ -n "$DEST" ] || { echo "usage: $0 <dest-dir>"; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -e "$DEST" ]; then
  echo "refusing: $DEST already exists — name a fresh directory"; exit 2
fi

# Uncommitted work would silently not ship (git archive reads HEAD), and the recipient
# would get something that never existed as a commit.
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "refusing: working tree is dirty — commit first, because the tree ships from HEAD"
  git -C "$ROOT" status --short | sed 's/^/    /'
  exit 2
fi

SHA="$(git -C "$ROOT" rev-parse --short HEAD)"
echo "== staging tracked files from HEAD ($SHA)"
mkdir -p "$DEST"
git -C "$ROOT" archive HEAD | tar -x -C "$DEST"

echo "== removing what must not ship"
EXCLUDE=(
  test                              # asserts against the author's corpus; holds IPs, an address, a named fixture dir
  .github/workflows                 # both workflows grep for a live credential BY VALUE
                                    # (portable-macos.yml:103 greps for the literal, to prove
                                    # it is absent from a zip) — the file therefore CONTAINS it.
                                    # Narrowed from all of .github so ISSUE_TEMPLATE can ship;
                                    # the release gate still scans everything that remains.
  lib/alias-table.json              # one vendor's product catalogue; feature is off by default
  scripts/build-alias-table.js      # scrapes that vendor's site
  scripts/build-zip.sh              # the author's packaging, embeds their paths
  scripts/probes.json               # benchmark fixture written from real customer questions
  scripts/run-probe-calibration.js  # measurement harnesses, all bound to the author's corpus
  scripts/score-currency.js
  scripts/measure-key-facts.js
  scripts/test-probe-veto.js
  # These four read fixtures that do not ship (scripts/probes.json, test/*.json), so in a
  # public tree they are guaranteed to throw. Found by auditing the staged tree for live
  # references to excluded paths rather than by assuming the first exclusion list was right.
  scripts/measure-longdoc.js
  scripts/bench-probes.js
  scripts/measure-absence.js
  scripts/sweep-sections.js
  # Same rule, found by a vendor-term sweep of the STAGED tree rather than of the repo: both
  # hold benchmark questions written from the author's corpus, naming a real competitor.
  scripts/measure-graph-spread.js
  scripts/measure-graph-spread-v2.js
  # Four more of the same class, found by RUNNING every npm script on a fresh install rather than
  # by reading this list again. All four do an unguarded top-level readFileSync of a test/ fixture,
  # so they throw ENOENT on a public clone. eval-state was the one that mattered: it is an npm
  # script, so `npm run eval:state` died for anyone who tried it.
  scripts/eval-state.js
  scripts/measure-sku-alias.js
  scripts/measure-library-recall.js
  scripts/monitor-margins.js
  # Same class again, caught by the gate rather than by reading this list: its question set is
  # written against the author's corpus and names an internal tool. scripts/measure-index-memory.js
  # is deliberately NOT excluded — it takes an index path and asserts nothing about content.
  scripts/measure-vector-fidelity.js
)
for path in "${EXCLUDE[@]}"; do
  if [ -e "$DEST/$path" ]; then rm -rf "${DEST:?}/$path"; echo "    - $path"; fi
done

# The alias MECHANISM stays; only the vendor data goes. Say so where someone will look.
cat > "$DEST/lib/ALIAS-TABLE.md" <<'NOTE'
# Optional: lib/alias-table.json

`lib/aliases.js` can expand a query term to a family stem — useful when your corpus talks
about product or part numbers that share a prefix (`XY-673A` and `XY-873A` are both
`XY-x73A`). It is **off unless `MEMORY_SKU_ALIAS=1`**, and it looks for `lib/alias-table.json`.

No table ships, because a table is domain data and yours will not be ours. If the file is
absent the loader falls back to an empty table and retrieval is unchanged — verified: the
same query returns the same document at the same score with and without it.

To supply your own:

```json
{ "modelToFamilies": { "xy-673a": ["xy-x73a"] }, "families": { "xy-x73a": ["xy-673a", "xy-873a"] } }
```

Keys are lowercased. A model must never alias to another model — only to a stem — or a
query for one product will retrieve a different one.
NOTE
echo "    + lib/ALIAS-TABLE.md (the mechanism stays, the data does not)"

# Document the per-machine file that is deliberately absent.
cat > "$DEST/local-config.example.json" <<'NOTE'
{
  "_comment": "Copy to local-config.json (gitignored) and edit. Every value is optional; environment variables override it.",
  "memoryDir": "/absolute/path/to/your/memories",
  "libraryDir": "/absolute/path/to/your/reference/library",
  "keepEmailDomains": ["your-org.example"],
  "keepEmails": ["you@example.com"]
}
NOTE
echo "    + local-config.example.json"

# WHICH COMMIT THIS TREE WAS CUT FROM. Without .git the server reports @unknown-sha, and
# the one check that catches a stale running process — comparing serverVersion against the
# code you are reading — cannot be performed at all. That check exists because a config
# change was once verified in a fresh process and reported as live while the running server
# still had the old build. A tarball install should not lose it.
cat > "$DEST/.build-stamp.json" <<STAMP
{
  "sha": "$(git -C "$ROOT" rev-parse HEAD)",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "builtBy": "scripts/build-public-tree.sh",
  "_comment": "Read by lib/version.js ONLY when there is no .git. A clone reports its live HEAD instead."
}
STAMP
echo "    + .build-stamp.json ($(git -C "$ROOT" rev-parse --short HEAD))"

# NO SCRIPT MAY POINT AT A FILE THAT IS NOT HERE. `npm test` ran the suite, which does not
# ship — a stranger's first instinct would have been an immediate error. Every script whose
# target was removed is dropped, and `test` is repointed at verify-stdio, which is the
# self-contained smoke test and passes on any machine.
node -e '
const fs=require("fs"), p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const dir=require("path").dirname(process.argv[1]);
const dropped=[];
for (const [k,v] of Object.entries(p.scripts||{})) {
  for (const m of String(v).matchAll(/(?:scripts|test|packaging|ci-helpers)\/[A-Za-z0-9._-]+/g)) {
    if (!fs.existsSync(require("path").join(dir,m[0]))) { delete p.scripts[k]; dropped.push(k+" -> "+m[0]); break; }
  }
}
p.scripts.test = "node scripts/verify-stdio.js";
fs.writeFileSync(process.argv[1], JSON.stringify(p,null,2)+"\n");
for (const d of dropped) console.log("    - npm run "+d+" (target not shipped)");
console.log("    ~ npm test -> node scripts/verify-stdio.js");
' "$DEST/package.json"

# ONE MACHINE'S DENYLIST IS NOT A POLICY. secrets-exclude.json is two things at once: the
# PATTERNS, which are a genuine contribution and should ship, and `excludeFiles`/`sectionScrub`,
# which name this machine's memory files and headings. Publishing those does not just leak a
# filename, it publishes WHERE the author keeps a credential. The patterns stay; the personal
# lists are emptied HERE rather than in the repo, so the private machine keeps the protection it
# actually relies on. Found by a vendor-term sweep of the staged tree, not by the gate — the gate
# checks for known terms, and a filename nobody hashed is invisible to it.
node -e '
const fs=require("fs"), p=process.argv[1], c=JSON.parse(fs.readFileSync(p,"utf8"));
const had=(c.excludeFiles||[]).length + Object.keys(c.sectionScrub||{}).length;
c.excludeFiles=[]; c.sectionScrub={};
c._comment=(c._comment?c._comment+" ":"")+
  "excludeFiles and sectionScrub ship EMPTY: they are per-machine. excludeFiles takes memory "+
  "FILENAMES that must never be indexed; sectionScrub maps a filename to headings to strip. "+
  "This file is public, so name files by path, not by what they contain.";
fs.writeFileSync(p, JSON.stringify(c,null,2)+"\n");
console.log("    ~ secrets-exclude.json: emptied "+had+" per-machine entr(ies), kept "+(c.patterns||[]).length+" patterns");
' "$DEST/secrets-exclude.json"

# ASK THE TREE, DO NOT RE-READ THE LIST. This class has now bitten twice, and both times the
# exclusion list was inspected and both times the miss survived. scripts/audit-read-paths.mjs
# resolves every literal path the shipped code reads against the staged tree.
echo "== audit: does anything here read a file that did not ship?"
if ! node "$ROOT/scripts/audit-read-paths.mjs" "$DEST"; then
  echo; echo "REFUSED — staged tree deleted so it cannot be published."; rm -rf "${DEST:?}"; exit 4
fi

echo "== gate: does this tree name anyone?"
if ! node "$ROOT/scripts/check-release-clean.mjs" "$DEST"; then
  echo
  echo "REFUSED — staged tree deleted so it cannot be published by accident."
  rm -rf "${DEST:?}"
  exit 3
fi

FILES="$(find "$DEST" -type f | wc -l | tr -d ' ')"
echo
echo "OK — $FILES files staged at $DEST (from $SHA)"
echo "Next: add a LICENSE, then 'git init && git add -A && git commit' in that directory."
echo "Do NOT push it to the private remote — this is a fresh-history tree by design."
