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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { ownStoreDir, accountLabel } from '../lib/config.js';
import { redact } from '../lib/secrets.js';
import { commitsInRange, configuredRepos } from '../lib/git-join.js';
import { localList } from '../lib/local-config.js';

const file = process.argv[2];
const WRITE = process.argv.includes('--write');
// --rewrite-only  apply an extractor change to HISTORY without creating anything new: only files
// that already exist are (re)written. A session that was never captured (a scheduled task, another
// account's chat) stays uncaptured, which is the state its own hook left it in.
const REWRITE_ONLY = process.argv.includes('--rewrite-only');
const LIMIT =(() => { const i = process.argv.indexOf('--limit'); return i === -1 ? Infinity : parseInt(process.argv[i + 1]) || Infinity; })();
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
  // Another Claude session talking to this one over the desktop's cross-session socket -- delivered
  // mid-turn like an interjection, but not the human. Found folded as one (x-b58a69af, 2026-08-29).
  if (/^\s*<cross-session-message\b/.test(t)) return true;
  if (t.startsWith('[SYSTEM NOTIFICATION')) return true;
  if (t.startsWith('Caveat: The messages below')) return true;
  if (/^<(command-name|local-command|command-message|bash-input|bash-stdout)/.test(t)) return true;
  // A turn that is mostly markup is machinery whatever its tag name is.
  const tagChars = (t.match(/<\/?[a-z][a-z0-9-]*>/gi) || []).join('').length;
  if (tagChars > t.length * 0.15) return true;
  return false;
};

// The final report of an asynchronous subagent, as the client delivers it to the parent:
// <task-notification><task-id>…</task-id>…<result>…</result></task-notification>. Only a
// notification that CARRIES a result counts; a status-only one ("completed", "started") adds nothing.
const agentResultOf = (t) => {
  if (!t || !t.includes('<task-notification>')) return null;
  // OUTER result = first <result> to LAST </result>. An agent that fanned out quotes its own
  // sub-agents' envelopes; a non-greedy match stopped at the INNER </result> and stored the inner
  // envelope as prose while the outer conclusion was lost (reviewed). Nested envelopes are stripped
  // wholesale -- their reports are the inner agent's, not this one's conclusion.
  const start = t.search(/<result>/i); const end = t.search(/<\/result>(?![\s\S]*<\/result>)/i);
  if (start === -1 || end === -1 || end <= start) return null;
  let text = t.slice(start + '<result>'.length, end)
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, '')
    .replace(/^\s*\[harness:[^\]]*\]\s*/i, '')          // the host's envelope note is not the agent's words
    // A report must not mint graph edges: [[name]] inside machine-generated text becomes plain text.
    .replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]')
    .trim();
  if (text.length < 40) return null;
  const id = (/<task-id>([^<]+)<\/task-id>/i.exec(t) || [])[1]?.trim() || null;
  return { id, text };
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

// ---- INTERJECTIONS: the message typed WHILE a turn is running ---------------------------------
//
// The desktop client does not write that message as a user turn. It writes a `queue-operation`
// (`enqueue`, then `remove` with reason `absorbed_mid_turn` -- or no reason at all before
// 2026-08-26) and hands the text to the model inside a tool result's <system-reminder>. Tool results
// carry no `text` block, so before this the words were invisible to capture twice over.
//
// MEASURED 2026-09-02 across every transcript on this machine: 211 absorbed interjections, 0 of
// which ever became a user turn; 160 were nowhere in the store, 44 survived only because a
// compaction summary happened to quote them. A further 363 human messages sit in the older,
// reason-less spelling. What was in them: "don't do this one yet", "ignore what I said about…",
// rulings, defect reports -- corrections, which is exactly what gets typed mid-turn.
//
// An interjection's reply is the REMAINDER OF THE TURN THAT ABSORBED IT, so it belongs to the
// exchange it interrupted, not to a new one. That also keeps the positional names stable: folding
// changes only the exchanges that had interjections; inserting would renumber everything after.
//
// `enqueue` is NOT the signal -- every prompt is enqueued (4,571 of them). Only a `remove` that
// still carries content marks a message that never became a turn. `delivered_to_agent` (9 seen) is
// folded too: the words were typed into THIS conversation, and although subagent transcripts DO
// exist on disk (`<session>/subagents/agent-*.jsonl`, 468 for one session alone) this pipeline
// never ingests them -- the walker reads depth 1 only -- so nothing else would hold them. If
// subagent ingestion is ever enabled, revisit this or the message will be stored in both places.
// (All 9 seen today are task-notification text and fall to isMachineTurn before the fold anyway.)
// The reason list is explicit so a future, unknown reason (a cancelled message, say) is not
// silently stored as if it had been said.
const INTERJECTION_REASONS = new Set(['absorbed_mid_turn', 'delivered_to_agent']);
const isInterjection = (j) => j.type === 'queue-operation' && j.operation === 'remove'
  && typeof j.content === 'string' && j.content.trim()
  && (j.reason === undefined || j.reason === null || INTERJECTION_REASONS.has(j.reason));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const sessionTitle = deriveTitle(readFileSync(file, 'utf8'));
const turns = [];
let openUser = -1;                      // index in `turns` of the HUMAN user turn whose reply is running
let interjectionsUnattached = 0;        // typed before any human turn existed: nothing to attach to
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (isInterjection(j)) {
    const t = j.content.trim();
    if (isMachineTurn(t)) continue;     // a queued task notification is machinery in any envelope
    if (openUser === -1) { interjectionsUnattached++; continue; }
    (turns[openUser].interjections ||= []).push({ text: t, ts: j.timestamp || null });
    continue;
  }
  const role = j.message?.role;
  if (role !== 'user' && role !== 'assistant') continue;
  const t = textOf(j.message.content, ['text']);   // 'thinking' and tool blocks dropped here
  if (!t) continue;
  turns.push({ role, text: t, ts: j.timestamp || null });
  // A machine user turn (a task notification landing mid-reply) does not take over the open ask:
  // the human is still the one being answered, and an interjection typed after it belongs to them.
  // Measured before this: 21 interjections in one session "fell in machine turns" and were dropped.
  if (role === 'user' && !isMachineTurn(t)) openUser = turns.length - 1;
}
// If the client later materialised the same text as a real user turn, it will be captured as one;
// keeping the copy here would store the question twice. Measured over 676 transcripts: the ONLY
// real duplicate ("continue") matched a LATER human turn, not the next one, and a task notification
// sat between -- so compare against the next few HUMAN turns, skipping machine ones.
const DEDUP_LOOKAHEAD_HUMAN_TURNS = 3;
for (let i = 0; i < turns.length; i++) {
  if (!turns[i].interjections) continue;
  const later = turns.slice(i + 1).filter((t) => t.role === 'user' && !isMachineTurn(t.text))
    .slice(0, DEDUP_LOOKAHEAD_HUMAN_TURNS).map((t) => norm(t.text));
  if (!later.length) continue;
  turns[i].interjections = turns[i].interjections.filter((x) => !later.includes(norm(x.text)));
  if (!turns[i].interjections.length) delete turns[i].interjections;
}

// Pair: one user turn + everything the assistant said before the next user turn.
//
// 🟥 A MACHINE TURN WITH A HUMAN INTERJECTION IS STILL DROPPED, and that is a measured trade, not an
// oversight. The first draft kept it (the notification is noise, the human words are the ask), and
// the pre-registered P1 check falsified it: 27 sessions gained a file, which means every later
// exchange in those sessions was RENUMBERED -- names are positional, so an inserted exchange shifts
// the content behind every `x-<sid>-NNNN` after it and breaks the [[prev]] chain. Twenty-seven
// interjections are the price of that stability; they are COUNTED below so the loss is visible, and
// the real cure is content-stable names, which is an architecture change and is recorded as such.
const exchanges = [];
let interjectionsInShortReplies = 0;
for (let i = 0; i < turns.length; i++) {
  if (turns[i].role !== 'user') continue;
  if (isMachineTurn(turns[i].text)) continue;
  const inter = (turns[i].interjections || []).map((x) => x.text);
  const reply = [];
  // THE REPLY RUNS UNTIL THE NEXT HUMAN TURN, not the next entry in the user role. A task
  // notification lands in the user role mid-reply; stopping at it orphaned everything the assistant
  // said afterwards -- and the notification, skipped as an ask, never picked it up. Measured over
  // 122 transcripts: 230 such cuts, 1,663 assistant turns, 912,151 chars -- 9.0% of ALL assistant
  // prose -- and the surviving document read as complete ("Waiting for it to complete." with the
  // 5,767-char conclusion in no store file).
  for (let k = i + 1; k < turns.length; k++) {
    if (turns[k].role === 'assistant') { reply.push(turns[k].text); continue; }
    if (isMachineTurn(turns[k].text)) {
      // AN AGENT'S REPORT IS PART OF THE REPLY. A subagent finishes asynchronously and its final
      // report lands on the parent's timeline as <task-notification>…<result>…</result> -- in the
      // user role, so it was dropped with every other machine turn. Measured over all 556 agents on
      // this machine: 297 (53%) report this way, 230 of those carry the FULL report, and the parent's
      // own prose then restates a median 38% of the report's identifiers (SHAs, paths, line numbers).
      // ~90% of agent conclusions were absent from the store. The <result> is the agent's words, on
      // behalf of this exchange, with the human's session id -- so it joins the reply, marked.
      const r = agentResultOf(turns[k].text);
      if (r) reply.push(`**Agent report${r.id ? ` (task ${r.id})` : ''}:**\n${r.text}`);
      continue;
    }
    break;
  }
  const body = reply.join('\n\n').trim();
  // A reply under the floor carries no retrievable fact, and that includes the interjection it
  // absorbed -- but an interjection is the one place a short reply might hide a real instruction,
  // so the loss is counted rather than silent.
  if (body.length < MIN_REPLY_CHARS) { interjectionsInShortReplies += inter.length; continue; }
  exchanges.push({ ask: turns[i].text.trim(), body, ts: turns[i].ts, turnIndex: i, interjections: inter });
}

// THE FULL COUNT, TAKEN BEFORE ANY FILTER TOUCHES `exchanges`. --defer-last below POPS the list; the
// orphan pruning at the bottom needs the real number of exchanges in this transcript, and reading
// `exchanges.length` there read the post-pop count -- so every timed run deleted each session's
// newest memory. Reviewed 2026-09-03: 119 live files would go per timed run, 35 sessions emptied;
// x-fb357616-0797 WAS deleted by the LaunchAgent before the review caught it (recreated by the next
// plain run). Nothing below this line may be used as the pruning bound except this constant.
const FULL_EXCHANGE_COUNT = exchanges.length;

// ---- CONTENT-STABLE NAMES ---------------------------------------------------------------------
//
// `x-<sid8>-<ask timestamp, compacted: 20260903T054233800Z>`. The name is a property of the
// EXCHANGE, not of its position. Names used to be positional (`x-<sid8>-NNNN`), and in one night
// that cost: a withdrawn rule inserted 20 exchanges and renumbered 715 files, leaving 19 duplicate
// memories (MEM-20/F2); a windowed run numbered from 1 and overwrote a session's first memories
// (MEM-20/F1); a bound computed from the ordinal deleted a real file (MEM-21/#1). With the name
// derived from WHEN THE ASK WAS MADE, inserting or dropping an exchange touches only that exchange.
//
// The compact form is fixed-width UTC (19 chars), so lexicographic order is time order — measured
// against all 2,782 files at migration: zero duplicate stamps within a session, zero non-monotonic
// pairs, i.e. the new order is byte-identical to the old positional order. 🟥 Never turn the suffix
// into a Number: 17 digits exceed MAX_SAFE_INTEGER and adjacent milliseconds compare equal.
//
// NO TIMESTAMP (zero files today, but the extractor keeps such exchanges by design): a hash of the
// ask text, prefixed with the day of the nearest earlier timestamped exchange so it sorts next to
// its neighbours, with `Tx` where the time would be so no reader can mistake it for an instant.
// Deterministic across re-ingests, which is what the rewrite path needs.
//
// COMPUTED HERE, before --defer-last pops the in-flight exchange: the pruner below treats "a file of
// this session whose name is not in this list" as an orphan candidate, so the list must be the FULL
// one — a first draft built it after the pop, and a timed run on a session whose in-flight ask
// repeated an earlier one ("continue", twice) would have deleted the in-flight file as a duplicate.
const stamp = (ts) => new Date(ts).toISOString().replace(/[-:.]/g, '');
// The fallback hashes the ask AND the turn index: two identical asks with no timestamp ("continue",
// twice) must not collapse into one file. Reviewed: the first version hashed the ask alone and a
// two-exchange transcript wrote "wrote 2" into ONE file, 50% loss reported as success.
const askKey = (ex) => createHash('sha256').update(`${ex.turnIndex}\n${String(ex.ask)}`).digest('hex').slice(0, 8);
const names = [];
{
  let lastDay = '00000000';
  for (const ex of exchanges) {
    if (ex.ts && Number.isFinite(new Date(ex.ts).getTime())) { const s = stamp(ex.ts); lastDay = s.slice(0, 8); names.push(`x-${short}-${s}`); }
    else names.push(`x-${short}-${lastDay}Tx${askKey(ex)}`);
  }
  // A name that is not unique is a file that would be silently overwritten. Refuse the whole run.
  if (new Set(names).size !== names.length) {
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    console.error(`REFUSING: two exchanges would share the name ${dup} (same millisecond, or same fallback key); nothing written`);
    process.exit(5);
  }
  for (const n of names) if (!/^x-[^-]+-\d{8}T(\d{9}Z|x[0-9a-f]{8})$/.test(n)) { console.error(`REFUSING: name ${n} has the wrong shape; nothing written`); process.exit(5); }
}

// ---- --defer-last: the in-flight exchange waits for the next pass ----------------------------
//
// A timed capture drops the exchange still being written; a hook capture must not, because at the
// end of a session no further user turn ever arrives and dropping it there would lose the last
// exchange permanently.
//
// Not a safety measure: the writer below overwrites whenever content differs, so a partial would
// self-correct anyway. It avoids re-embedding a growing exchange on every interval, and avoids a
// truncated answer being briefly searchable as though it were complete.
//
// 🟥 THE LAST EXCHANGE IS NOT ALWAYS THE IN-FLIGHT ONE. This block used to assume it was, and the
// assumption fails in exactly the case the timer was built for. When Daniel interjects during a
// long turn, his new message has no reply yet, so `body.length < MIN_REPLY_CHARS` skips it and it
// never becomes an exchange at all — leaving the FINAL entry in `exchanges` a COMPLETE one, which
// was then dropped as though it were in flight. Measured end-to-end: appending a user turn left the
// store at 4 files; only appending an assistant reply as well moved it to 5. So a timed run could
// never shorten the lag for an interjection, which is the whole scenario it targets.
//
// Decide it from the transcript instead: an exchange is in flight only when NO later user turn
// exists. `turns` already excludes tool results (they carry no 'text' block, so textOf returns
// empty), so a later entry there is a genuine user message and proves the reply has ended.
//
// 🟥 CORRECTION (2026-09-02, the night after). The paragraph above was written believing the desktop
// client records an interjection as a user turn. It does not -- see INTERJECTIONS above; the message
// is a queue-operation and is now folded into the exchange it interrupted, so it never appears in
// `turns` and never ends a reply here. The rule below still holds, and is still needed, for the two
// cases that DO put a later user turn in the transcript: a resumed session, and a client that writes
// the interjection as a turn. What it does not do is what MEM-18 said it did.
if (process.argv.includes('--defer-last') && exchanges.length) {
  const last = exchanges[exchanges.length - 1];
  // A HUMAN turn ends a reply. A task notification in the user role does not -- the reply goes on
  // past it (see the pairing loop), so counting it here would release a half-written answer.
  const stillWriting = !turns.slice(last.turnIndex + 1).some((t) => t.role === 'user' && !isMachineTurn(t.text));
  if (stillWriting) {
    exchanges.pop();
    console.log(`deferring the in-flight exchange to the next pass: ${JSON.stringify(String(last.ask || '').slice(0, 60))}`);
  } else {
    console.log(`final exchange is complete (a later user turn follows it); capturing it now`);
  }
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

// ---- CONTENT-STABLE NAMES ---------------------------------------------------------------------
//
// `x-<sid8>-<ask timestamp, compacted: 20260903T054233800Z>`. The name is a property of the
// EXCHANGE, not of its position. Names used to be positional (`x-<sid8>-NNNN`), and in one night
// that cost: a withdrawn rule inserted 20 exchanges and renumbered 715 files, leaving 19 duplicate
// memories (MEM-20/F2); a windowed run numbered from 1 and overwrote a session's first memories
// (MEM-20/F1); a bound computed from the ordinal deleted a real file (MEM-21/#1). With the name
// derived from WHEN THE ASK WAS MADE, inserting or dropping an exchange touches only that exchange.
//
// The compact form is fixed-width UTC (19 chars), so lexicographic order is time order — measured
// against all 2,782 files at migration: zero duplicate stamps within a session, zero non-monotonic
// pairs, i.e. the new order is byte-identical to the old positional order. 🟥 Never turn the suffix
// into a Number: 17 digits exceed MAX_SAFE_INTEGER and adjacent milliseconds compare equal.
//
// NO TIMESTAMP (zero files today, but the extractor keeps such exchanges by design): a hash of the
// ask text, prefixed with the day of the nearest earlier timestamped exchange so it sorts next to
// its neighbours, with `Tx` where the time would be so no reader can mistake it for an instant.
// Deterministic across re-ingests, which is what the rewrite path needs.
// (`names` is computed above, BEFORE --defer-last pops the in-flight exchange, so the pruner's
//  "what a full run emits" set is complete; see FULL_EXCHANGE_COUNT.)

const out = [];
for (let idx = 0; idx < exchanges.length; idx++) {
  const ex = exchanges[idx];
  if (out.length >= LIMIT) break;
  // Older than the requested window: skip. An exchange with no timestamp is KEPT, because
  // dropping it would silently lose work whose only fault is a missing field.
  if (SINCE_MS !== null && ex.ts && new Date(ex.ts).getTime() < SINCE_MS) continue;
  // Names are qualified by SESSION. lib/corpus.js warns on duplicate names
  // because get()/backlinks address by name and the loser is unreachable; an
  // extractor is precisely the thing that would collide without this.
  const name = names[idx];
  const desc = scrubAddresses(redact(words(ex.ask, DESC_WORDS)).text);
  const body = scrubAddresses(redact(ex.body).text);
  // The predecessor is the REAL previous exchange in the transcript, whatever filter this run is
  // applying — a windowed run must link to the same neighbour a full run would, or the two paths
  // write different bytes and the link skips exchanges.
  const prev = idx > 0 ? names[idx - 1] : null;
  const inter = (ex.interjections || []).map((t) => scrubAddresses(redact(t).text));

  // The document is a FUNCTION OF WHAT THE EXISTING FILE ALREADY CARRIES: the writer below passes
  // the account stamp it must keep, and every metadata line some OTHER writer added (`secret: true`
  // from the exclusion mechanism, `tier:` from a demotion, `modified:` from a fact-time stamp). A
  // rewrite is not a capture; rebuilding the frontmatter from this fixed list alone would have
  // silently undone all of those the next time the extractor ran -- re-indexing a memory that had
  // been deliberately excluded. Keys this extractor owns are always regenerated; the rest ride along.
  const mdFor = (account, extraMeta = []) => {
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
      account ? `  account: ${account}` : null,
      `  sessionId: ${sessionId}`,
      sessionTitle ? `  sessionTitle: ${yamlSafe(sessionTitle)}` : null,
      ex.ts ? `  ts: ${ex.ts}` : null,
      inter.length ? `  interjections: ${inter.length}` : null,
      (() => {
        const c = commitBuckets.get(exchanges.indexOf(ex)) || [];
        return c.length ? `  commits: ${c.slice(0, MAX_COMMITS_PER_EXCHANGE).map((x) => x.sha).join(' ')}` : null;
      })(),
      ...extraMeta,
      '---',
      ''
    // .filter(Boolean) also removes the trailing '' that used to provide the blank
    // line after the closing ---, which glued the body onto the delimiter and made
    // the parser swallow the "**Asked:**" line entirely. Terminate explicitly
    // instead of relying on an entry that a filter can delete.
    ].filter(Boolean).join('\n') + '\n\n';

    const ask = scrubAddresses(redact(ex.ask).text);
    // One block-quote per interjection, in the order typed, INSIDE THE ASK PARAGRAPH (single
    // newlines, no blank line before the reply). Two consumers depend on that shape:
    //   * scripts/dream.js `assistantHalf()` takes everything after the first blank line following
    //     **Asked:** as the assistant's words. A first draft put the interjections in their own
    //     paragraph, and a user's "two things I got wrong" was scored as MY correction -- the exact
    //     false positive that function exists to prevent.
    //   * a multi-line interjection used to carry the marker on its first line only, so a reader
    //     could not tell where the user's words stopped, and a typed "# heading" became a real
    //     heading in `get outline`. Every continuation line now carries the quote prefix.
    const added = inter.map((t) => '\n> **Added mid-reply:** ' + t.split('\n').map((l) => l.trimEnd()).join('\n> ')).join('');
    const cmts = (commitBuckets.get(exchanges.indexOf(ex)) || []).slice(0, MAX_COMMITS_PER_EXCHANGE);
    const commitBlock = cmts.length
      ? '\n**Commits during this exchange:**\n'
        + cmts.map((c) => `- \`${c.sha}\` (${c.repo}) ${scrubAddresses(redact(c.subject || '').text)}`).join('\n')
        + '\n'
      : '';
    return `${fm}**Asked:** ${ask}${added}\n\n${body}\n${commitBlock}${prev ? `\nPrevious: [[${prev}]]\n` : ''}`;
  };
  out.push({ name, file: `${name}.md`, mdFor, md: mdFor(ACCOUNT), descLen: desc.length, bodyLen: body.length, interjections: inter.length });
}

console.log(`transcript : ${file}`);
console.log(`turns      : ${turns.length}   exchanges kept: ${exchanges.length}   emitted: ${out.length}`);
console.log(`skipped    : replies under ${MIN_REPLY_CHARS} chars, machine turns, tool traffic, thinking blocks`);
console.log(`interjected: ${out.reduce((s, o) => s + o.interjections, 0)} mid-turn message(s) folded into ${out.filter((o) => o.interjections).length} exchange(s)`
  + (interjectionsUnattached ? `; ${interjectionsUnattached} typed before any human turn and NOT kept` : '')
  + (interjectionsInShortReplies ? `; ${interjectionsInShortReplies} fell in replies under ${MIN_REPLY_CHARS} chars and were NOT kept` : ''));
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
// THE ACCOUNT STAMP SURVIVES A REWRITE. It records who was signed in when the exchange was
// CAPTURED; a later rewrite (an extractor change re-applied to history) is not a capture. Measured
// before this existed: 5 of the 14 sessions touched by the interjection fix carry the other
// account's stamp -- 182 files that a plain re-ingest would have silently flipped to whoever ran it.
// A file with NO stamp keeps having none, for the same reason.
const headOf = (raw) => raw.slice(0, raw.indexOf('\n---', 4) + 1 || 4000);
const stampOf = (raw) => {
  const m = /^  account: (.+)$/m.exec(headOf(raw));
  return m ? m[1].trim() : null;
};
// Metadata lines this extractor does NOT own, carried across a rewrite verbatim (see mdFor).
const OWN_META = new Set(['type', 'account', 'sessionId', 'sessionTitle', 'ts', 'interjections', 'commits']);
const extraMetaOf = (raw) => {
  const lines = headOf(raw).split('\n');
  const start = lines.findIndex((l) => /^metadata\s*:/.test(l));
  if (start === -1) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!/^  \S/.test(l)) break;                          // end of the metadata block
    const key = (/^  ([^:]+):/.exec(l) || [])[1];
    if (key && !OWN_META.has(key.trim())) out.push(l);
  }
  return out;
};
const sessionOf = (raw) => (/^  sessionId: (\S+)$/m.exec(raw.slice(0, raw.indexOf('\n---', 4) + 1 || 4000)) || [])[1] || null;
let wrote = 0, unchanged = 0, skippedNew = 0, foreign = 0;
for (const o of out) {
  const p = join(dir, o.file);
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : null;
  if (existing === null && REWRITE_ONLY) { skippedNew++; continue; }
  // The 8-char prefix is 32 bits. No collision among 111 sessions today; when one happens the loser
  // must not be silently overwritten by the winner. Refuse and say so.
  if (existing !== null) {
    const owner = sessionOf(existing);
    if (owner && owner !== sessionId) { foreign++; console.error(`REFUSED ${o.file}: held by session ${owner}, not ${sessionId} (prefix collision)`); continue; }
  }
  const md = existing === null ? o.md : o.mdFor(stampOf(existing), extraMetaOf(existing));
  if (existing === md) { unchanged++; continue; }
  writeFileSync(p, md, 'utf8');
  wrote++;
}
// ORPHANS. Names are positional, so when an earlier run emitted MORE exchanges than this transcript
// now yields, the files beyond the current count are a stale tail: each holds a copy of an exchange
// that now lives under a lower number. Measured live 2026-09-03: a withdrawn extractor rule inserted
// 20 exchanges into one session, was withdrawn, and left 19 duplicate memories at 0796-0814 --
// indexed, retrievable, and indistinguishable from real ones.
//
// THIS IS THE ONLY CODE IN THE PROJECT THAT DELETES A MEMORY FILE, in a directory git does not
// track, so it needs more than arithmetic:
//   * the bound is FULL_EXCHANGE_COUNT, taken before --defer-last pops the list (the first version
//     used the post-pop length and deleted a real exchange on the very next timed run);
//   * only a PLAIN full run prunes -- not --rewrite-only (whose contract is "touch nothing new"),
//     not --limit, not --since-minutes;
//   * a candidate must be POSITIVE EVIDENCE of a stale tail: its description must match a
//     lower-numbered file of this same session. A file beyond the count that matches nothing is
//     reported, not deleted -- it may be an exchange an older rule saw and this one does not.
// With content-stable names the question is no longer "beyond which ordinal" but a SET DIFFERENCE:
// this session's files whose name a full run would NOT emit. That set is empty in the steady state
// and non-empty exactly when an exchange stopped existing under the current rules -- or was written
// under a rule since withdrawn. The bound is the FULL name set (taken before --defer-last pops), so a
// deferred exchange's existing file is never a candidate. MEMORY_PRUNE_ORPHANS=0 turns it off.
let removed = 0, unexplained = 0;
const PRUNE = WRITE && !REWRITE_ONLY && LIMIT === Infinity && SINCE_MS === null && FULL_EXCHANGE_COUNT > 0
  && process.env.MEMORY_PRUNE_ORPHANS !== '0';
if (PRUNE) {
  // THE EVIDENCE IS BODY IDENTITY, NOT THE DESCRIPTION. A first version accepted a matching
  // description (the first 40 words of the ask) as proof of a stale copy. Reviewed: 144 live files in
  // 23 sessions share a description with a sibling -- "continue" x15, "Dom reloaded" x8 -- so any of
  // them would have been deleted on sight the moment its name stopped being emitted, unique body and
  // all. A stale tail is a COPY: same body under an old name. Same description, different body, is a
  // real memory and goes down the KEPT path.
  const bodyHashOf = (raw) => {
    const i = raw.indexOf('\n---', 4);
    const body = (i === -1 ? raw : raw.slice(i + 4)).replace(/\nPrevious: \[\[[^\]]+\]\]\n?$/, '').trim();
    return createHash('sha256').update(body).digest('hex');
  };
  const emitted = new Set(names.map((n) => `${n}.md`));
  const ownBodies = new Set();     // body hashes of this session's REAL (emitted) files
  for (const f of emitted) { if (existsSync(join(dir, f))) ownBodies.add(bodyHashOf(readFileSync(join(dir, f), 'utf8'))); }
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`x-${short}-`) || !f.endsWith('.md') || emitted.has(f)) continue;
    const raw = readFileSync(join(dir, f), 'utf8');
    if (sessionOf(raw) !== sessionId) continue;
    if (ownBodies.has(bodyHashOf(raw))) { unlinkSync(join(dir, f)); removed++; }
    else { unexplained++; console.error(`KEPT ${f}: not an exchange this transcript yields, and its body matches none of the ${emitted.size} it does; not deleted`); }
  }
}
console.log(`\nwrote ${wrote}, unchanged ${unchanged}${REWRITE_ONLY ? `, not created ${skippedNew} (--rewrite-only)` : ''}`
  + `${foreign ? `, refused ${foreign} (prefix collision)` : ''}`
  + `${removed ? `, removed ${removed} duplicate orphan(s) (not among the ${FULL_EXCHANGE_COUNT} exchanges)` : ''}`
  + `${unexplained ? `, kept ${unexplained} unexplained file(s) not among the ${FULL_EXCHANGE_COUNT} exchanges` : ''}, into ${dir}`);
console.log(`store now holds ${readdirSync(dir).filter((f) => f.endsWith('.md')).length} files`);
