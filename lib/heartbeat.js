// lib/heartbeat.js — "is the memory connector switched on right now?"
//
// THE PROBLEM THIS SOLVES. Capture runs from a Claude hook, and a hook fires whether or not
// this server is enabled — it has no idea the connector exists. So turning capture on and off
// meant editing hook JSON in your Claude settings, which is a second, invisible switch that
// nobody remembers they set. Meanwhile there is already a switch everyone understands and can
// see: the connector toggle in Claude's own UI.
//
// The two can be joined, because the toggle has a physical consequence: when the connector is
// ON, Claude spawns this process; when it is OFF, it does not. A running server that leaves a
// dated mark on disk therefore IS the toggle, observable from outside by a hook that cannot
// otherwise see Claude's configuration at all.
//
// WHY A HEARTBEAT AND NOT JUST A START MARKER. A file written once at startup goes stale during
// a long session and would read as "switched off" after an hour of work. The mark is refreshed
// on a timer instead, and the timer is unref()'d so it can never be the reason this process
// stays alive.
//
// WHAT IT DELIBERATELY DOES NOT DO: prove the memory TOOL was used. Claude starts every enabled
// server at launch, so the mark says the connector is on — which is the question being asked.
// A session where the tool was never called is still a session you had memory switched on for.

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, '.runtime-cache');
export const HEARTBEAT_PATH = join(DIR, 'connector-heartbeat.json');

/** Default: a mark older than this means the connector is not on. Beats every 60s. */
export const HEARTBEAT_STALE_SEC = 300;

export function beat() {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(HEARTBEAT_PATH, JSON.stringify({
      pid: process.pid,
      lastSeen: new Date().toISOString(),
      lastSeenMs: Date.now()
    }) + '\n', 'utf8');
  } catch {
    // A heartbeat that cannot be written must never take the server down with it. The
    // consequence of failure is that capture falls back to "off", which is the safe direction.
  }
}

/** Start beating, and return a stop function. The interval never holds the process open. */
export function startHeartbeat(everyMs = 60_000) {
  beat();
  const t = setInterval(beat, everyMs);
  if (typeof t.unref === 'function') t.unref();
  return () => clearInterval(t);
}

/** Was the connector on within `staleSec`? Absent or unreadable mark = NO. */
export function connectorRecentlyOn(staleSec = HEARTBEAT_STALE_SEC) {
  try {
    const h = JSON.parse(readFileSync(HEARTBEAT_PATH, 'utf8'));
    const age = (Date.now() - Number(h.lastSeenMs)) / 1000;
    return Number.isFinite(age) && age <= staleSec ? { on: true, ageSec: Math.round(age) } : { on: false, ageSec: Math.round(age) };
  } catch {
    return { on: false, ageSec: null };
  }
}
