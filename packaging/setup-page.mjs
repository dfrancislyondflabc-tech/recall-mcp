#!/usr/bin/env node
// setup-page.mjs — generate SETUP.html for THIS machine, with the real paths filled in.
//
// Why generated and not a static page: the whole point is that the config must name
// the folder the user actually extracted to. A static page can only say
// "<your path here>", which is exactly the step people get wrong.
//
// Run by SETUP-WINDOWS.cmd / SETUP-MACOS.command using the BUNDLED node, so it also
// proves the bundled runtime executes before anything is wired into Claude.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, platform, arch } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = platform() === 'win32';
const nodeBin = join(ROOT, 'runtime', WIN ? 'node.exe' : 'node');
const entry = join(ROOT, 'index.js');
// WHICH memory folder? This page is generated on two very different machines and
// must be right on both: a friend's fresh unzip (no memories yet -> the bundled
// ./memories seed) and Daniel's own Mac (a real corpus that already lives under
// ~/.claude/projects/...). Naming the wrong one produces a page that looks correct
// and quietly points Claude at an empty folder.
let memories = process.env.MEMORY_DIR ? resolve(process.env.MEMORY_DIR) : null;
if (!memories) {
  const bundled = join(ROOT, 'memories');
  let existing = null;
  // 🟥 WINDOWS: import() of an ABSOLUTE PATH throws — it must be a file:// URL.
  // A Mac accepts the bare path, so this only ever fails on the machine the zip is FOR.
  try { ({ DEFAULT_MEMORY_DIR: existing } = await import(pathToFileURL(join(ROOT, 'lib', 'config.js')).href)); } catch {}
  // A PORTABLE bundle is self-contained by definition, and it is identified by the
  // runtime/ folder it ships. Without this test the fallback below wins on the machine
  // that BUILT the zip -- it pointed a freshly-unzipped copy at the builder's own
  // corpus, which is both wrong and a path nobody else should be reading.
  const isPortable = existsSync(join(ROOT, 'runtime'));
  const bundledHasFiles = existsSync(bundled) &&
    (await import('node:fs')).readdirSync(bundled).some((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  if (isPortable) memories = bundled;
  else if (bundledHasFiles) memories = bundled;
  else if (existing && existsSync(existing)) memories = existing;   // a dev install on this machine
  else memories = bundled;
}
if (!existsSync(memories)) mkdirSync(memories, { recursive: true });
let memoryCount = 0;
try { memoryCount = (await import('node:fs')).readdirSync(memories).filter((f) => f.endsWith('.md')).length; } catch {}

const configPath = WIN
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  : join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');

const snippet = {
  mcpServers: {
    memory: {
      command: existsSync(nodeBin) ? nodeBin : 'node',
      args: [entry],
      env: { MEMORY_DIR: memories },
    },
  },
};
const snippetJson = JSON.stringify(snippet, null, 2);

// ---- smoke test: does this machine actually run it? -------------------------
// I could not test Windows from the machine that built this zip, so the check runs
// HERE instead of being asserted there. A red badge with the real error beats a
// green claim that was never executed.
let smoke = { ok: false, detail: '', dims: 0, server: false };

// Test the SERVER'S OWN code path, not a lookalike. An earlier draft of this page
// embedded with all-MiniLM via a hand-rolled pipeline() call — which would have
// reached the network for a model this build does not even use, and proved nothing
// about the cache that actually ships. lib/embed.js reads EMBEDDING.model and
// modelCacheDir() from lib/config.js, so testing through it tests what will run.
try {
  const t0 = Date.now();
  const { embedQuery, embeddingsDisabledReason } = await import(pathToFileURL(join(ROOT, 'lib', 'embed.js')).href);
  const v = await embedQuery('hello world');
  const why = embeddingsDisabledReason();
  if (v && v.length) smoke = { ok: true, server: true, dims: v.length, detail: `${((Date.now() - t0) / 1000).toFixed(1)}s` };
  else smoke = { ok: false, server: true, dims: 0, detail: why || 'embedQuery returned nothing' };
} catch (e) {
  smoke = { ok: false, server: false, dims: 0, detail: String((e && e.message) || e).slice(0, 400) };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Add the Memory server to Claude</title>
<style>
 :root{--bg:#faf9f7;--fg:#1a1a19;--mut:#6b6b68;--line:#e3e0da;--card:#fff;--acc:#c15f3c;--ok:#2f7d52;--bad:#b3261e;--warn:#a86432}
 @media(prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#eeece7;--mut:#a3a09a;--line:#33322f;--card:#232320;--acc:#e0805c}}
 *{box-sizing:border-box}
 body{margin:0;padding:40px 20px;background:var(--bg);color:var(--fg);
      font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
 .wrap{max-width:820px;margin:0 auto}
 h1{font-size:28px;margin:0 0 6px} h2{font-size:18px;margin:34px 0 10px}
 .sub{color:var(--mut);margin:0 0 26px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:14px 0}
 pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px;
     overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;margin:0}
 .btn{background:var(--acc);color:#fff;border:0;border-radius:7px;padding:9px 16px;
      font-size:14px;font-weight:600;cursor:pointer;margin-bottom:10px}
 .btn:active{transform:translateY(1px)}
 .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:600}
 .ok{background:rgba(47,125,82,.14);color:var(--ok)} .bad{background:rgba(179,38,30,.14);color:var(--bad)}
 .warn{background:rgba(193,95,60,.16);color:var(--acc)}
 ol{padding-left:22px} li{margin:8px 0}
 code{background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:13px}
 .path{word-break:break-all;color:var(--mut);font:13px ui-monospace,Menlo,Consolas,monospace}
</style></head><body><div class="wrap">
<h1>Add the Memory server to Claude</h1>
<p class="sub">Generated on this computer — the paths below are the real ones. ${esc(platform())}/${esc(arch())}, bundled Node ${esc(process.version)}.</p>

<div class="card">
  <strong>Does it run here?</strong>
  ${smoke.ok
    ? `<span class="badge ok">YES — embeddings working (${esc(smoke.dims)} dims, ${esc(smoke.detail)})</span>
       <p class="sub" style="margin:10px 0 0">The bundled runtime and the search model both work on this machine. Nothing else to install.</p>`
    : smoke.server
      ? `<span class="badge warn">PARTLY — it runs, but smart search is off</span>
         <p class="sub" style="margin:10px 0 0">The server itself loaded, so it will work and you can wire it into Claude.
         What failed is the embedding model, so search falls back to keyword-only — it still finds things,
         it is just less good at matching meaning. Reason:</p>
         <pre>${esc(smoke.detail)}</pre>`
      : `<span class="badge bad">NO — it failed here</span>
         <p class="sub" style="margin:10px 0 0">Do not wire this into Claude yet; it would fail silently. The error was:</p>
         <pre>${esc(smoke.detail)}</pre>`}
</div>

<h2>1. Copy this</h2>
<div class="card">
  <button class="btn" onclick="copyIt()">Copy the config</button>
  <span id="done" style="color:var(--ok);font-size:14px"></span>
  <pre id="snip">${esc(snippetJson)}</pre>
</div>

<h2>2. Paste it here</h2>
<div class="card">
  <p style="margin:0 0 8px">Open this file in a text editor:</p>
  <pre>${esc(configPath)}</pre>
  <p class="sub" style="margin:10px 0 0">
    If the file already exists and has <code>mcpServers</code>, add the <code>"memory"</code>
    block inside it — do not replace the whole file, or you will remove your other servers.
    If the file does not exist, create it and paste the whole thing.
  </p>
</div>

<h2>3. Restart Claude</h2>
<div class="card">
  <p style="margin:0">Quit Claude completely and reopen it — it only reads this file at startup.
  Then ask it something like <em>“search my memory for …”</em>.</p>
</div>

<h2>Where your memories go</h2>
<div class="card">
  <p style="margin:0 0 8px">Claude will read Markdown files from this folder:</p>
  <p class="path">${esc(memories)}</p>
  <p class="sub" style="margin:8px 0 0"><strong>${esc(memoryCount)}</strong> memory file${memoryCount === 1 ? '' : 's'} in there right now.</p>
  <p class="sub" style="margin:10px 0 0">
    If you were given a separate <code>memory-*-scrubbed.zip</code>, unzip it and copy the
    <code>.md</code> files in there into the folder above. <code>MEMORY.md</code> is the index.
  </p>
</div>

<script>
function copyIt(){
  var t = document.getElementById('snip').innerText;
  navigator.clipboard.writeText(t).then(function(){
    document.getElementById('done').textContent = 'Copied';
    setTimeout(function(){document.getElementById('done').textContent='';},2200);
  }, function(){
    var r=document.createRange(); r.selectNode(document.getElementById('snip'));
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.getElementById('done').textContent = 'Press Ctrl/Cmd+C';
  });
}
</script>
</div></body></html>`;

const outPath = join(ROOT, 'SETUP.html');
writeFileSync(outPath, html);
writeFileSync(join(ROOT, 'claude-config-snippet.json'), snippetJson + '\n');
console.log('  Wrote ' + outPath);
console.log('  Smoke test: ' + (smoke.ok ? 'PASS (' + smoke.dims + ' dims, ' + smoke.detail + ')'
  : (smoke.server ? 'DEGRADED — keyword-only: ' : 'FAIL — ') + smoke.detail.slice(0, 160)));
// Exit 0 when the server loads at all: a degraded install is still installable, and a
// non-zero exit would make the .cmd print a scary line for a working setup.
process.exit(smoke.server || smoke.ok ? 0 : 1);
