#!/usr/bin/env node
// scripts/ingest-transcript.js — a conversation becomes memories, one exchange
// at a time.
//
//   node scripts/ingest-transcript.js <transcript.jsonl> [--write] [--limit N]
//
// Dry run unless --write is passed. Writes into ownStoreDir(), never into
// Claude's directory.
//
// THE UNIT. A mailbox is searchable without anyone summarising it because each
// EMAIL is already the right size. A transcript has the same natural unit — the
// exchange — so this maps it the way lib/email-index.js maps mail:
//
//     email subject     ->  the user's message   (becomes `description`)
//     cleaned body      ->  the assistant's reply (becomes the body)
//     conversation_id   ->  the session id
//
// That is what makes auto-capture possible without a model in the loop: the
// 2.0-weighted `description` field is FILLED BY THE USER, not synthesised.
// Measured 2026-08-17: replacing all 101 hand-written descriptions with
// synthDescription() cost 2 rank-1 positions and no recall at all, and the
// user's own question is a far better description than "first heading".
//
// TOOL TRAFFIC IS DROPPED ENTIRELY, and that is a security decision, not a size
// one. scripts/measure-secret-coverage.js read 50 MB of real transcript: every
// credential it found, and every candidate that survived redaction, lived in a
// bash command or its output. None was in conversational prose. Dropping
// tool_use/tool_result removes essentially the whole credential surface instead
// of trying to filter it. redact() still runs over what remains, as a backstop.
//
// Thinking blocks are dropped too: they are drafts, and a draft that contradicts
// the reply is exactly the kind of wrong-version-next-to-right-version the
// corpus should not carry.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ownStoreDir, accountLabel } from '../lib/config.js';
import { redact } from '../lib/secrets.js';
import { commitsInRange, configuredRepos } from '../lib/git-join.js';
import { localList } from '../lib/local-config.js';

const file = process.argv[2];
const WRITE = process.argv.includes('--write');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i === -1 ? Infinity : parseInt(process.argv[i + 1]) || Infinity; })();
if (!file) { console.error('usage: ingest-transcript.js <transcript.jsonl> [--write] [--limit N]'); process.exit(2); }

// --backfill  ingest OLD transcripts without claiming them.
//
// The account stamp records WHO WAS SIGNED IN AT WRITE TIME, which is only the
// truth when capture happens during the conversation it captures — i.e. the
// hook. A bulk re-ingest of six weeks of history is not that: it stamps whoever
// happened to run it. That mistake was made and corrected here, on 2,034
// exchanges, 1,990 of which had belonged to the other account. A transcript
// carries no account field, so the honest label for a backfilled exchange is
// NONE — and unlabelled memories are returned to every account anyway.
const BACKFILL = process.argv.includes('--backfill');
// RETROACTIVE CAPTURE. "Remember what we did in the last hour" — for the case where the
// connector was off while the work happened and you only realised afterwards that it mattered.
// The transcript was on disk the whole time; nothing was lost, it simply was not ingested.
// Env as well as flag because the MCP `capture` action reaches this through auto-ingest.js.
const SINCE_MIN = (() => {
  const i = process.argv.indexOf('--since-minutes');
  const raw = i !== -1 ? process.argv[i + 1] : process.env.MEMORY_INGEST_SINCE_MINUTES;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const SINCE_MS = SINCE_MIN ? Date.now() - SINCE_MIN * 60_000 : null;
const ACCOUNT = BACKFILL ? null : accountLabel();
const MIN_REPLY_CHARS = 200;      // below this an exchange carries no retrievable fact
const DESC_WORDS = 40;

const textOf = (content, roles) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => roles.includes(b.type)).map((b) => b.text || '').join('\n').trim();
};

// A user turn that is machinery, not a person talking.
// MEASURED: the first run of this script emitted 601 exchanges from one
// transcript and 102 of them (17%) were BACKGROUND-TASK NOTIFICATIONS filed as
// if the user had asked something. They arrive in the user role, so only their
// shape gives them away. A notification as `description` is worse than useless:
// it is the 2.0-weighted field, so it actively pulls unrelated queries toward a
// document whose real content is somebody else's task id.
const isMachineTurn = (t) => {
  if (!t) return true;
  if (t.includes('<system-reminder>')) return true;
  if (t.includes('<task-notification>')) return true;
  if (t.startsWith('[SYSTEM NOTIFICATION')) return true;
  if (t.startsWith('Caveat: The messages below')) return true;
  if (/^<(command-name|local-command|command-message|bash-input|bash-stdout)/.test(t)) return true;
  // A turn that is mostly markup is machinery whatever its tag name is.
  const tagChars = (t.match(/<\/?[a-z][a-z0-9-]*>/gi) || []).join('').length;
  if (tagChars > t.length * 0.15) return true;
  return false;
};

const sessionId = basename(file, '.jsonl');

// A HUMAN NAME FOR THE CHAT. Titles are not stored on disk, but the app derives
// them from the opening prompt, so the same thing can be recovered locally.
// It is stamped ALONGSIDE the id, never instead of it: Daniel's own chat list
// shows "Outlook follow-up emails for Tawk.to..." four separate times, so a
// title identifies a chat to a reader while only the id identifies it uniquely.
function deriveTitle(raw) {
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const c = j.operation === 'enqueue' ? j.content
      : (j.message?.role === 'user' ? (typeof j.message.content === 'string' ? j.message.content
          : (j.message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')) : null);
    if (!c) continue;
    const t = String(c).replace(/\s+/g, ' ').trim();
    if (!t || t.includes('<system-reminder>') || t.startsWith('[SYSTEM NOTIFICATION') || t.startsWith('Caveat:')) continue;
    return t.split(/[.?!\n]/)[0].slice(0, 80).trim();
  }
  return null;
}
const short = sessionId.slice(0, 8);

const sessionTitle = deriveTitle(readFileSync(file, 'utf8'));
const turns = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  const role = j.message?.role;
  if (role !== 'user' && role !== 'assistant') continue;
  const t = textOf(j.message.content, ['text']);   // 'thinking' and tool blocks dropped here
  if (!t) continue;
  turns.push({ role, text: t, ts: j.timestamp || null });
}

// Pair: one user turn + everything the assistant said before the next user turn.
const exchanges = [];
for (let i = 0; i < turns.length; i++) {
  if (turns[i].role !== 'user') continue;
  if (isMachineTurn(turns[i].text)) continue;
  const reply = [];
  for (let k = i + 1; k < turns.length && turns[k].role === 'assistant'; k++) reply.push(turns[k].text);
  const body = reply.join('\n\n').trim();
  if (body.length < MIN_REPLY_CHARS) continue;
  exchanges.push({ ask: turns[i].text.trim(), body, ts: turns[i].ts });
}

// ---- --defer-last: the in-flight exchange waits for the next pass ----------------------------
//
// The pairing above makes the FINAL exchange the one with no following user turn — which mid-turn
// is the one still being written. A timed capture drops it; a hook capture must not, because at
// the end of a session no further user turn ever arrives and dropping it there would lose the last
// exchange permanently.
//
// Not a safety measure: the writer below overwrites whenever content differs, so a partial would
// self-correct anyway. It avoids re-embedding a growing exchange on every interval, and avoids a
// truncated answer being briefly searchable as though it were complete.
if (process.argv.includes('--defer-last') && exchanges.length) {
  const deferred = exchanges.pop();
  console.log(`deferring the in-flight exchange to the next pass: ${JSON.stringify(String(deferred.ask || '').slice(0, 60))}`);
}

// ---- EXTERNAL ADDRESSES ---------------------------------------------------
// Auto-capture pulls in whatever the conversation contained, and one of these
// chats answers customer email: a survey of the store found 324 distinct
// addresses, 1,470 gmail and 333 yahoo occurrences among them. Those are real
// customers, and they arrived in a searchable corpus that did not exist before.
//
// This runs in the EXTRACTOR, not in lib/secrets.js redact(). redact() is shared
// and applies at OUTPUT time to both corpora, so putting it there would strip
// addresses out of hand-written memories too -- deal-reg contacts, Daniel's own
// identity. Scope it to what auto-capture writes.
//
// The rule is shaped by what the domain is worth, not by uniform paranoia:
//   * INTERNAL (your own org's domain) and known self addresses are KEPT. They are work
//     identities, they are already all over the curated corpus, and losing them
//     would break "who handled this".
//   * FREEMAIL local parts ARE the identity and the domain carries no
//     information, so the whole address goes.
//   * CORPORATE addresses keep the DOMAIN and lose the person: alice@acme.com
//     becomes [email@<domain>]. "What did we tell Acme" still retrieves; which
//     human at Acme does not.
// EMPTY BY DEFAULT. "Which domain is us" cannot have a generic answer, and guessing
// wrong in the permissive direction would keep real addresses. Set keepEmailDomains in
// local-config.json (or MEMORY_KEEP_EMAIL_DOMAINS). Unset means nothing is treated as
// internal, i.e. more redaction, which is the safe way to be wrong.
const KEEP_DOMAINS = new Set(localList('MEMORY_KEEP_EMAIL_DOMAINS', 'keepEmailDomains').map((d) => d.toLowerCase()));
const KEEP_ADDRESSES = new Set(localList('MEMORY_KEEP_EMAILS', 'keepEmails').map((a) => a.toLowerCase()));
const FREEMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'msn.com', 'live.com', 'comcast.net', 'protonmail.com', 'proton.me', 'gmx.com']);
const _ADDR_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

function scrubAddresses(text) {
  return String(text || '').replace(_ADDR_RE, (full, domain) => {
    const addr = full.toLowerCase();
    const dom = domain.toLowerCase();
    if (KEEP_ADDRESSES.has(addr)) return full;
    for (const keep of KEEP_DOMAINS) if (dom === keep || dom.endsWith('.' + keep)) return full;
    return FREEMAIL.has(dom) ? '[email]' : `[email@${dom}]`;
  });
}

// ── C1. THE COMMITS GO IN AT WRITE TIME ──────────────────────────────────────
// Measured: of 12 commits made during one session, that session's own text named
// 2. The work happens in tool calls; ingest captures prose. git-join can recover
// the link by joining on time -- but only at query time, only for `thread`, and
// recomputed on every call.
//
// Do the join ONCE, here, so the link lives IN the document.
//
// IT GOES IN THE BODY, NOT ONLY THE FRONTMATTER. lib/corpus.js:182 reads
// `front.metadata` and picks out named fields (type, sessionId, account, tier);
// an unrecognised `metadata.commits` is parsed and then dropped on the floor.
// Writing the commits only to frontmatter would have produced a field that no
// query could ever match -- the letter of "attach at ingest", none of the point.
// The frontmatter line is kept as well, for machine reads that already hold the doc.
//
// ONE git call spans the whole transcript and the results are bucketed in memory.
// Per-exchange calls would be N git invocations for an N-exchange transcript.
//
// A commit is attributed to the exchange it FOLLOWED, because work lands after
// the ask, never before it.
const COMMIT_TAIL_MIN = Number(process.env.MEMORY_INGEST_COMMIT_TAIL_MIN || 30);
const MAX_COMMITS_PER_EXCHANGE = 12;

async function bucketCommits(list) {
  // No MEMORY_GIT_REPOS -> no-op, and ingest stays byte-identical to before.
  if (!configuredRepos().length) return new Map();
  const idx = [];
  list.forEach((e, i) => {
    const t = e.ts ? new Date(e.ts).getTime() : NaN;
    if (Number.isFinite(t)) idx.push({ i, t });
  });
  if (!idx.length) return new Map();
  idx.sort((a, b) => a.t - b.t);
  const since = new Date(idx[0].t).toISOString();
  const until = new Date(idx[idx.length - 1].t + COMMIT_TAIL_MIN * 60000).toISOString();
  const all = await commitsInRange(since, until, { max: 2000 });
  const buckets = new Map();
  for (const c of all) {
    const at = new Date(c.at).getTime();
    if (!Number.isFinite(at)) continue;
    // the LAST exchange that had already been asked when this commit landed
    let owner = null;
    for (const e of idx) { if (e.t <= at) owner = e.i; else break; }
    if (owner === null) continue;
    if (!buckets.has(owner)) buckets.set(owner, []);
    buckets.get(owner).push(c);
  }
  return buckets;
}

const commitBuckets = await bucketCommits(exchanges);
const totalAttached = [...commitBuckets.values()].reduce((s, a) => s + a.length, 0);

const words = (s, n) => s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
const yamlSafe = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';

const out = [];
let n = 0;
for (const ex of exchanges) {
  if (n >= LIMIT) break;
  // Older than the requested window: skip. An exchange with no timestamp is KEPT, because
  // dropping it would silently lose work whose only fault is a missing field.
  if (SINCE_MS !== null && ex.ts && new Date(ex.ts).getTime() < SINCE_MS) continue;
  const seq = String(++n).padStart(4, '0');
  // Names are qualified by SESSION. lib/corpus.js warns on duplicate names
  // because get()/backlinks address by name and the loser is unreachable; an
  // extractor is precisely the thing that would collide without this.
  const name = `x-${short}-${seq}`;
  const desc = scrubAddresses(redact(words(ex.ask, DESC_WORDS)).text);
  const body = scrubAddresses(redact(ex.body).text);
  const prev = n > 1 ? `x-${short}-${String(n - 1).padStart(4, '0')}` : null;

  const fm = [
    '---',
    `name: ${name}`,
    `description: ${yamlSafe(desc)}`,
    'metadata:',
    '  type: exchange',
    // WHO CAPTURED THIS. Stamped at write time from the signed-in account, so
    // every exchange from here on is attributable even though the corpus itself
    // is shared by every account on the machine. Memories written before this
    // stay unlabelled, and the account filter never drops unlabelled.
    ACCOUNT ? `  account: ${ACCOUNT}` : null,
    `  sessionId: ${sessionId}`,
    sessionTitle ? `  sessionTitle: ${yamlSafe(sessionTitle)}` : null,
    ex.ts ? `  ts: ${ex.ts}` : null,
    (() => {
      const c = commitBuckets.get(exchanges.indexOf(ex)) || [];
      return c.length ? `  commits: ${c.slice(0, MAX_COMMITS_PER_EXCHANGE).map((x) => x.sha).join(' ')}` : null;
    })(),
    '---',
    ''
  // .filter(Boolean) also removes the trailing '' that used to provide the blank
  // line after the closing ---, which glued the body onto the delimiter and made
  // the parser swallow the "**Asked:**" line entirely. Terminate explicitly
  // instead of relying on an entry that a filter can delete.
  ].filter(Boolean).join('\n') + '\n\n';

  const ask = scrubAddresses(redact(ex.ask).text);
  const cmts = (commitBuckets.get(exchanges.indexOf(ex)) || []).slice(0, MAX_COMMITS_PER_EXCHANGE);
  const commitBlock = cmts.length
    ? '\n**Commits during this exchange:**\n'
      + cmts.map((c) => `- \`${c.sha}\` (${c.repo}) ${scrubAddresses(redact(c.subject || '').text)}`).join('\n')
      + '\n'
    : '';
  const md = `${fm}**Asked:** ${ask}\n\n${body}\n${commitBlock}${prev ? `\nPrevious: [[${prev}]]\n` : ''}`;
  out.push({ name, file: `${name}.md`, md, descLen: desc.length, bodyLen: body.length });
}

console.log(`transcript : ${file}`);
console.log(`turns      : ${turns.length}   exchanges kept: ${exchanges.length}   emitted: ${out.length}`);
console.log(`skipped    : replies under ${MIN_REPLY_CHARS} chars, machine turns, tool traffic, thinking blocks`);
console.log(`commits    : ${totalAttached} attached across ${commitBuckets.size} exchange(s)`
  + (configuredRepos().length ? ` from ${configuredRepos().length} repo(s)` : '  (MEMORY_GIT_REPOS unset -- join disabled)'));
if (out.length) {
  const avg = Math.round(out.reduce((s, o) => s + o.bodyLen, 0) / out.length);
  console.log(`avg body   : ${avg} chars  (an email passage is ~350 words; the tier is comparable)`);
  console.log(`\nfirst 3 descriptions (these become the 2.0-weighted field):`);
  for (const o of out.slice(0, 3)) console.log(`  ${o.name}  ${JSON.stringify(o.md.match(/description: "(.*)"/)?.[1]?.slice(0, 76) || '')}`);
}

if (!WRITE) { console.log('\nDRY RUN — pass --write to emit into the own store.'); process.exit(0); }

const dir = ownStoreDir();
if (!dir) { console.error('own store disabled (MEMORY_OWN_STORE=0)'); process.exit(1); }
mkdirSync(dir, { recursive: true });
let wrote = 0, unchanged = 0;
for (const o of out) {
  const p = join(dir, o.file);
  if (existsSync(p) && readFileSync(p, 'utf8') === o.md) { unchanged++; continue; }
  writeFileSync(p, o.md, 'utf8');
  wrote++;
}
console.log(`\nwrote ${wrote}, unchanged ${unchanged}, into ${dir}`);
console.log(`store now holds ${readdirSync(dir).filter((f) => f.endsWith('.md')).length} files`);
