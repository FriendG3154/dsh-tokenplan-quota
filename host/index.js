// Token Plan quota — Host half.
//
// Data sources (per quota-api-findings.md, t1 contract):
//   A) official `qianwen` CLI (browser-OAuth login state, NOT the sk-sp key):
//      `qianwen auth status`, `qianwen usage summary --format json`,
//      `qianwen subscription tokenplan status --format json (no --edition flag exists; individual/team nested under top level)`.
//      Detected at runtime; never assumed installed.
//   B) local estimate ledger: credits estimated from REAL model-call usage
//      already recorded in this DSH installation's session logs (read-only).
//      The plugin NEVER fires a model call to probe quota (personal-edition
//      terms forbid automated calls), and never invents numbers.
//   C) sk-sp gateway probe: the stored sk-sp key is used ONLY for read-only
//      GETs against the token-plan gateway quota paths. Per findings §2.3 no
//      such endpoint is confirmed to exist; a 401/404 here is recorded as
//      evidence, not retried on a loop.
//
// Secrets policy: the sk-sp key is read from process.env inside this module
// (Config apiKeyRef names an ENVIRONMENT VARIABLE, then the two well-known
// fallbacks). It is never returned through any route, never logged, never
// placed into a prompt or tool output. No dependency on the credentials
// service seam — see loader-findings.md §7: the fiber must depend on
// webServer only.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import z from '@deepseek-ai/schemastery';

export const name = 'tokenplan-quota';
// Minimal hard dependency (loader-findings.md §7.2): webServer is provided by
// the web-app layer; credentials/timer are NOT declared here so the fiber can
// never sit PENDING waiting for them. Polling uses plain setInterval inside
// ctx.effect cleanup; the API key comes straight from process.env.
export const inject = ['webServer'];

export const Config = z.object({
  pollIntervalSec: z.number().default(120).volatile(),
  cliTimeoutSec: z.number().default(20),
  // Name of an environment variable holding the sk-sp key (NOT a credential
  // store ref since v0.1.1 — the credentials seam is no longer injected).
  apiKeyRef: z.string().default(''),
});

// ---------------------------------------------------------------------------
// constants (from quota-api-findings.md §2/§3/§4)
// ---------------------------------------------------------------------------

const TOKEN_PLAN_BASE = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
// Candidate quota paths probed with the sk-sp key (all unverified per findings §2.3).
const GATEWAY_QUOTA_PATHS = [
  'usage/summary',
  'subscription/tokenplan/status',
  'quota',
  'credits',
];

// Tier monthly-credit constants (docs §3): Lite 20k / Essential 45k / Standard 80k / Pro 200k.
const TIER_CREDITS = { lite: 20000, essential: 45000, standard: 80000, pro: 200000 };

// B-route anchored rates, qwen3.6-plus (findings §4). Partially unverified.
const RATES_UNVERIFIED = true;
const DEFAULT_RATES = { input: 0.2 / 1000, cached: 0.02 / 1000, output: 1.2 / 1000 };
// Night window 22:00–08:00 (local) discounts, by model-id prefix match.
const NIGHT_DISCOUNTS = [
  { prefixes: ['qwen3.8-max', 'qwen3.8-flash'], factor: 0.4 },
  { prefixes: ['deepseek-v4'], factor: 0.5 },
];
const FREE_MODELS = ['decision-model-preview'];

const CLI_PKG = '@qianwenai/qianwen-cli';
const CLI_INSTALL_CMD = `npm i -g ${CLI_PKG}`;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const clampNum = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : null);

function nightFactor(modelId, atMs) {
  if (!modelId) return 1;
  const d = new Date(atMs);
  const hour = d.getHours();
  const night = hour >= 22 || hour < 8;
  if (!night) return 1;
  for (const rule of NIGHT_DISCOUNTS) {
    if (rule.prefixes.some((p) => modelId.startsWith(p))) return rule.factor;
  }
  return 1;
}

function estimateCredits(modelId, usage, atMs) {
  const input = Number(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.input_tokens) || 0;
  const output = Number(usage?.outputTokens ?? usage?.completion_tokens ?? usage?.output_tokens) || 0;
  const cached = Number(usage?.cacheReadTokens ?? usage?.prompt_tokens_details?.cached_tokens) || 0;
  if (input + output <= 0) return 0;
  if (FREE_MODELS.some((m) => modelId && modelId.includes(m))) return 0;
  // v0.2.3 fix — verified on real session logs: DSH's own spelling is EXCLUSIVE
  // (totalTokens = inputTokens + outputTokens + cacheReadTokens, so inputTokens
  // does NOT include cache). OpenAI-style prompt_tokens IS inclusive of
  // cached_tokens. Bill accordingly instead of always subtracting.
  const inclusiveSpelling = usage?.inputTokens == null && usage?.input_tokens == null && usage?.prompt_tokens != null;
  const effInput = inclusiveSpelling ? Math.max(input - cached, 0) : input;
  const cr = effInput * DEFAULT_RATES.input + cached * DEFAULT_RATES.cached + output * DEFAULT_RATES.output;
  return cr * nightFactor(modelId, atMs);
}

/** Resolve the sk-sp key without ever surfacing it upward beyond this module.
 *  v0.1.1: environment-only resolution (no ctx.credentials dependency).
 *  Config apiKeyRef names an environment variable; then the well-known keys. */
async function resolveApiKey(ctx, config) {
  const names = [];
  const own = String(config.apiKeyRef || '').trim();
  if (own) names.push(own);
  names.push('QWEN_TOKEN_PLAN_CN_API_KEY', 'TOKENPLAN_QUOTA_API_KEY');
  for (const n of names) {
    const v = process.env[n];
    if (v && v.startsWith('sk-sp')) return v;
  }
  return null;
}

/** Locate the qianwen CLI and classify how it may be spawned.
 *  v0.1.3: NEVER hand a bare .cmd/.bat to execFile on this host — Electron 44 /
 *  Node >= 24.9 reject it with spawn EINVAL (crash-2026-11-25T06-48-24-382Z-host.log),
 *  which used to take the whole host process down. We return a kind-tagged
 *  descriptor and runCli dispatches on it. */
async function findCli() {
  const candidates = [];
  if (process.platform === 'win32') {
    const npmPrefix = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm')
      : null;
    if (npmPrefix) candidates.push(path.join(npmPrefix, 'qianwen.cmd'), path.join(npmPrefix, 'qianwen'));
    candidates.push('qianwen.cmd', 'qianwen');
  } else {
    candidates.push('qianwen');
  }
  for (const c of candidates) {
    try {
      const resolved = await ctxlessWhich(c);
      if (resolved) return classifyCli(resolved);
    } catch { /* keep looking */ }
  }
  return null;
}

/** exe → spawn directly; js → spawn [nodeExe, entry]; cmd → wrap in cmd.exe /c. */
function classifyCli(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.exe')) return { kind: 'exe', path: p };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const entry = parseNpmCmdShim(p);
    const node = findNodeExe();
    if (entry && node) return { kind: 'js', node, entry };
    return { kind: 'cmd', path: p };
  }
  // Extension-less npm shim (bash wrapper) — only trustworthy on POSIX.
  if (process.platform !== 'win32') return { kind: 'exe', path: p };
  const entry = parseNpmCmdShim(p);
  const node = findNodeExe();
  return entry && node ? { kind: 'js', node, entry } : { kind: 'exe', path: p };
}

/** Extract the real JS entry from an npm-generated cmd/shim file.
 *  Typical line: "%~dp0\\node_modules\\@qianwenai\\qianwen-cli\\bin\\qianwen" %*
 *  (extension often absent — we probe .js/.mjs/.cjs). Placeholders like
 *  %~dp0 / %dp0% resolve to the shim's directory. */
function parseNpmCmdShim(shimPath) {
  let text = '';
  try { text = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const dir = path.dirname(shimPath);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/%~?dp0%?/gi, () => dir + path.sep);
    const m = line.match(/"([^"]+\.(?:js|mjs|cjs))"|(\S+\.(?:js|mjs|cjs))(?=\s|$)/i);
    if (!m) continue;
    const target = (m[1] || m[2]).replace(/\\/g, path.sep);
    try { if (fs.statSync(target).isFile()) return target; } catch { /* miss */ }
  }
  // Extension-less invocation: take quoted/backslash paths ending in bin\<name>.
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/%~?dp0%?/gi, () => dir + path.sep);
    const m = line.match(/"([^"]*node_modules[^"]*)"|([^\s"]*node_modules[^\s"]*)/i);
    if (!m) continue;
    const base = (m[1] || m[2]).replace(/\\/g, path.sep).replace(/\.cmd$|\.bat$/i, '');
    for (const ext of ['.js', '.mjs', '.cjs']) {
      try { if (fs.statSync(base + ext).isFile()) return base + ext; } catch { /* miss */ }
    }
  }
  return null;
}

let _nodeExe; // undefined = not probed yet, null = probed and absent
/** Resolve the REAL node.exe. process.execPath inside the desktop host is
 *  DeepSeek Harness.exe (Electron) — spawning that would relaunch the app,
 *  so it must never be used here. Mirrors bili's wrapper→real-exe check. */
function findNodeExe() {
  if (_nodeExe !== undefined) return _nodeExe;
  _nodeExe = null;
  const dirs = new Set();
  for (const d of (process.env.PATH || '').split(path.delimiter)) if (d) dirs.add(d);
  if (process.env.NVM_BIN) dirs.add(process.env.NVM_BIN);
  dirs.add('C:\\nvm4w\\nodejs');
  for (const dir of dirs) {
    const cand = path.join(dir, 'node.exe');
    try {
      if (!fs.statSync(cand).isFile()) continue;
    } catch { continue; }
    // Skip nvm Windows symlink shims when the real target exists elsewhere.
    try {
      const real = fs.realpathSync(cand);
      if (real && real.toLowerCase().endsWith('node.exe')) { _nodeExe = real; break; }
    } catch { /* fall through to using cand as-is below */ }
    _nodeExe = cand;
    break;
  }
  return _nodeExe;
}

let _whichCache = null;
async function ctxlessWhich(cmd) {
  // Cheap PATH scan; avoids spawning where/which on every poll.
  if (!_whichCache) {
    _whichCache = { at: 0, hits: new Map() };
  }
  const now = Date.now();
  const cachedHit = _whichCache.hits.get(cmd);
  if (cachedHit && now - _whichCache.at < 60000) return cachedHit;
  let found = null;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + (process.platform === 'win32' ? ext.toLowerCase() : ''));
      try {
        if (fs.statSync(p).isFile()) { found = p; break; }
      } catch { /* miss */ }
    }
    if (found) break;
  }
  if (!found && path.isAbsolute(cmd)) {
    try { if (fs.statSync(cmd).isFile()) found = cmd; } catch { /* miss */ }
  }
  _whichCache.at = now;
  _whichCache.hits.set(cmd, found);
  return found;
}

function runCli(cli, args, timeoutSec) {
  // cli is the kind-tagged descriptor from findCli(). A bare .cmd/.bat must
  // never reach execFile on Electron 44 / Node >= 24.9 (spawn EINVAL → fatal).
  let file = null;
  let argv = args;
  const opts = {
    timeout: timeoutSec * 1000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  };
  try {
    if (!cli) return Promise.resolve({ ok: false, error: 'cli-not-found' });
    if (cli.kind === 'js') {
      file = cli.node;
      argv = [cli.entry, ...args];
    } else if (cli.kind === 'cmd') {
      const sysRoot = process.env.SystemRoot || 'C:\\Windows';
      file = path.join(sysRoot, 'System32', 'cmd.exe');
      argv = ['/d', '/s', '/c', cli.path, ...args];
      opts.windowsVerbatimArguments = true;
    } else {
      file = cli.path;
    }
  } catch (e) {
    return Promise.resolve({ ok: false, error: 'cli-spawn-failed:' + String(e && e.message || e).slice(0, 160) });
  }
  return new Promise((resolve) => {
    try {
      execFile(file, argv, opts, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return resolve({ ok: false, error: 'cli-missing' });
        if (err && err.code === 'EINVAL') return resolve({ ok: false, error: 'cli-spawn-rejected' });
        const out = String(stdout || '').trim();
        if (err && !out) {
          return resolve({ ok: false, error: String(stderr || err.message || 'cli-error').slice(0, 300) });
        }
        try {
          return resolve({ ok: true, data: JSON.parse(out) });
        } catch {
          return resolve({ ok: false, error: 'cli-json-parse-failed', raw: out.slice(0, 200) });
        }
      });
    } catch (e) {
      // Synchronous throw (spawn EINVAL class) — degrade, never bubble up.
      resolve({ ok: false, error: 'cli-spawn-failed:' + String(e && e.message || e).slice(0, 160) });
    }
  });
}

// ---------------------------------------------------------------------------
// source A: qianwen CLI
// ---------------------------------------------------------------------------

async function fetchViaCli(ctx, config) {
  let cli = null;
  try {
    cli = await findCli();
  } catch (e) {
    return { available: false, reason: 'cli-lookup-failed', detail: String(e && e.message || e).slice(0, 160) };
  }
  if (!cli) {
    return { available: false, reason: 'cli-not-installed', installCommand: CLI_INSTALL_CMD };
  }
  const timeout = clampNum(config.cliTimeoutSec, 5, 120) ?? 20;
  const auth = await runCli(cli, ['auth', 'status'], timeout);
  if (!auth.ok || !auth.data?.authenticated) {
    return {
      available: false,
      reason: 'cli-not-logged-in',
      detail: auth.ok ? 'authenticated=false' : (auth.error || ''),
      installCommand: CLI_INSTALL_CMD,
    };
  }
  const [usage, sub] = await Promise.all([
    runCli(cli, ['usage', 'summary', '--format', 'json'], timeout),
    // v0.1.4: NO --edition flag — qianwen CLI v1.10.0 rejects it
    // (`{"error":{"code":"UNKNOWN_OPTION","message":"unknown option '--edition'"}}`),
    // which made the status call always fail and left the panel fields empty.
    // Without the flag the payload is nested under data.individual.
    runCli(cli, ['subscription', 'tokenplan', 'status', '--format', 'json'], timeout),
  ]);
  const snap = {};
  if (usage.ok) {
    const tp = usage.data?.token_plan;
    if (tp && tp.subscribed) {
      snap.planName = tp.planName ?? 'Token Plan';
      snap.status = tp.status ?? null;
      snap.totalCredits = typeof tp.totalCredits === 'number' ? tp.totalCredits : null;
      snap.remainingCredits = typeof tp.remainingCredits === 'number' ? tp.remainingCredits : null;
      snap.usedPct = typeof tp.usedPct === 'number' ? tp.usedPct : null;
      snap.resetAt = tp.resetDate ?? null;
    } else if (tp) {
      snap.notSubscribed = true;
    }
  }
  if (sub.ok && sub.data) {
    // v0.1.4: real shape is { individual: {...}, team: {...} } — unwrap whichever
    // edition is actually subscribed (prefer individual).
    const d = (sub.data.individual || sub.data.team)
      ? ((sub.data.individual && sub.data.individual.status === 'active') ? sub.data.individual : (sub.data.team || sub.data.individual))
      : sub.data;
    // v0.1.4: usage.summary's token_plan.subscribed=false is WRONG for the
    // individual edition (CLI quirk — it only reflects team/legacy plans). The
    // status command is authoritative: if an edition is active, clear the flag.
    if (d.status === 'not_subscribed') snap.notSubscribed = true;
    else if (d.status === 'active' && snap.notSubscribed) delete snap.notSubscribed;
    if (Array.isArray(d.tiers) && d.tiers.length) {
      snap.tiers = d.tiers.map((t) => ({
        tier: t.tier ?? null,
        windowType: t.windowType ?? null,
        usedPct: typeof t.usedPct === 'number' ? t.usedPct : null,
        remainingPct: typeof t.remainingPct === 'number' ? t.remainingPct : null,
        resetAt: t.resetAt ?? null,
      }));
      const top = d.tiers[0];
      if (top) {
        if (snap.remainingCredits == null && top.remainingPct != null && snap.totalCredits) {
          snap.remainingCredits = Math.round(snap.totalCredits * top.remainingPct / 100);
        }
        if (!snap.resetAt && top.resetAt) snap.resetAt = top.resetAt;
        if (!snap.tierLabel) snap.tierLabel = top.tier ?? null;
      }
    }
    // v0.1.4: monthlyCredits is an OBJECT in this CLI version:
    // { total: 45000, usedPct: 12.455..., resetTime: "2026-12-25T00:00:00.000+08:00" }.
    // Keep accepting a plain number for forward/backward compat.
    const mc = d.monthlyCredits;
    if (typeof mc === 'number' && snap.totalCredits == null) snap.totalCredits = mc;
    if (mc && typeof mc === 'object') {
      if (typeof mc.total === 'number' && snap.totalCredits == null) snap.totalCredits = mc.total;
      if (typeof mc.usedPct === 'number' && snap.usedPct == null) snap.usedPct = Math.round(mc.usedPct * 10) / 10;
      if (!snap.resetAt && mc.resetTime) snap.resetAt = mc.resetTime;
      if (snap.remainingCredits == null && typeof mc.total === 'number' && typeof mc.usedPct === 'number') {
        snap.remainingCredits = Math.max(Math.round(mc.total * (100 - mc.usedPct) / 100), 0);
      }
    }
    // v0.1.4: tier label fallback — type "token_plan_individual_essential" / name "Essential".
    if (!snap.tierLabel) snap.tierLabel = d.name ?? (typeof d.type === 'string' ? d.type.replace(/^token_plan_(individual|team)_?/, '') : null);
    if (Array.isArray(d.harnessAllowances) && d.harnessAllowances.length) {
      snap.harnessAllowances = d.harnessAllowances.map((a) => ({
        toolName: a.toolName ?? null,
        totalQuota: a.totalQuota ?? null,
        remainingQuota: a.remainingQuota ?? null,
        quotaUnit: a.quotaUnit ?? null,
        endAt: a.endAt ?? null,
      }));
    }
    // v0.1.4: period object carries start/end/remainingDays (end = subscription end,
    // NOT the Credits reset time — reset comes from monthlyCredits.resetTime above).
    const endAt = d.endAt ?? d.period?.end ?? null;
    if (endAt) snap.subscriptionEndAt = endAt;
    if (d.period && typeof d.period.remainingDays === 'number') snap.remainingDays = d.period.remainingDays;
  }
  snap.source = 'cli';
  snap.fetchedAt = new Date().toISOString();
  snap.usageOk = usage.ok;
  snap.subOk = sub.ok;
  if (!usage.ok && !sub.ok) {
    return { available: false, reason: 'cli-commands-failed', detail: `${usage.error || ''} ${sub.error || ''}`.trim().slice(0, 200) };
  }
  return { available: true, snapshot: snap };
}

// ---------------------------------------------------------------------------
// source B: local estimate ledger (reads existing session logs, zero new calls)
// ---------------------------------------------------------------------------

function sessionLogDirs() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const roots = [path.join(home, 'sessions')];
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir) roots.push(path.join(profileDir, 'sessions'));
  return roots.filter((r) => { try { return fs.statSync(r).isDirectory(); } catch { return false; } });
}

function iterSessionFiles(limit) {
  const files = [];
  for (const root of sessionLogDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    const stamped = [];
    for (const e of entries) {
      const p = path.join(root, e);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && /\.(jsonl|ndjson|log|json)(\.zst|\.zstd)?$/i.test(e)) stamped.push({ p, m: st.mtimeMs });
        else if (st.isDirectory()) {
          // Two on-disk shapes occur: sessions/<file> AND the real desktop
          // layout sessions/<workspace-slug>/<session-id>/session.v4.jsonl[.zstd]
          // (v0.2.3 fix: the third level was never descended, so the ledger
          // silently saw zero files).
          for (const f2 of fs.readdirSync(p)) {
            const p2 = path.join(p, f2);
            try {
              const s2 = fs.statSync(p2);
              if (s2.isFile() && /\.(jsonl|ndjson|log|json)(\.zst|\.zstd)?$/i.test(f2)) stamped.push({ p: p2, m: s2.mtimeMs });
              else if (s2.isDirectory()) {
                for (const f3 of fs.readdirSync(p2)) {
                  const p3 = path.join(p2, f3);
                  try {
                    const s3 = fs.statSync(p3);
                    if (s3.isFile() && /\.(jsonl|ndjson|log|json)(\.zst|\.zstd)?$/i.test(f3)) stamped.push({ p: p3, m: s3.mtimeMs });
                  } catch { /* skip */ }
                }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    }
    stamped.sort((a, b) => b.m - a.m);
    files.push(...stamped);
    if (files.length > limit) break;
  }
  return files.slice(0, limit);
}

/** Session logs are session.v4.jsonl[.zstd] under sessions/<workspace-slug>/
 *  <session-id>/. The .zstd container is a CONCATENATION of small zstd frames
 *  (one per appended batch) — Node's zstdDecompressSync stops after the first
 *  frame, so every reader here must loop over frames explicitly. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompressZstdFrames(buf) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = buf.indexOf(ZSTD_MAGIC, i);
    if (s < 0) break;
    let e = buf.indexOf(ZSTD_MAGIC, s + 4);
    if (e < 0) e = buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { /* partial tail frame */ }
    i = e === buf.length ? buf.length : e;
  }
  return Buffer.concat(out);
}

/** Extract usage records from one session log file. Verified on-disk shape:
 *  line events {"type":"assistant/message","seq":N,"time":ms,"data":{...},
 *  "usage":{"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens",
 *  "totalTokens"}} and model id at data.message.source.model. Defensive scan
 *  also accepts prompt_tokens/input_tokens spellings anywhere in the event. */
async function extractUsageFromFile(file, sinceMs) {
  const records = [];
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > 16 * 1024 * 1024) return records; // skip huge files in v1
    const raw = fs.readFileSync(file);
    text = (/\.(zst|zstd)$/i.test(file) ? decompressZstdFrames(raw) : raw).toString('utf8');
  } catch { return records; }
  for (const line of text.split('\n')) {
    if (!line || !line.includes('sage')) continue; // cheap prefilter
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    collectUsage(obj, records, sinceMs);
  }
  return records;
}

function collectUsage(root, records, sinceMs) {
  // v0.2.3: carry the parent event. Real desktop logs put usage at
  // data.usage while time/model live on the PARENT event (type/time/seq) —
  // without the parent we lost both and stamped every record with Date.now(),
  // which made the whole month look like "today".
  const stack = [[root, null]];
  while (stack.length) {
    const [cur, parent] = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) { for (const v of cur) stack.push([v, parent]); continue; }
    const u = cur.usage;
    if (u && typeof u === 'object' && (u.inputTokens != null || u.prompt_tokens != null || u.input_tokens != null)) {
      const ts = cur.time ?? parent?.time ?? cur.timestamp ?? parent?.timestamp ?? cur.created_at ?? cur.ts;
      const ms = typeof ts === 'number' ? ts : (typeof ts === 'string' ? Date.parse(ts) : NaN);
      if (!Number.isFinite(ms)) continue; // unattributable → drop, never fake
      if (ms >= sinceMs) {
        const model = cur.message?.source?.model
          ?? cur.data?.message?.source?.model
          ?? parent?.data?.message?.source?.model
          ?? parent?.message?.source?.model
          ?? cur.model ?? cur.model_id ?? cur.data?.model ?? parent?.model ?? null;
        records.push({ usage: u, model, at: ms });
      }
      continue; // do not descend into a usage object itself
    }
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === 'object') stack.push([v, cur]);
    }
  }
}

async function fetchViaEstimate(ctx, config) {
  const sinceMs = monthStartMs();
  let total = 0;
  let calls = 0;
  for (const { p } of iterSessionFiles(120)) {
    for (const rec of await extractUsageFromFile(p, sinceMs)) {
      const cr = estimateCredits(rec.model, rec.usage, rec.at);
      if (cr > 0) { total += cr; calls += 1; }
    }
  }
  if (calls === 0) {
    return { available: false, reason: 'no-usage-data', since: new Date(sinceMs).toISOString() };
  }
  return {
    available: true,
    snapshot: {
      source: 'estimate',
      fetchedAt: new Date().toISOString(),
      estimatedUsedCredits: Math.round(total * 100) / 100,
      measuredCalls: calls,
      ratesUnverified: RATES_UNVERIFIED,
      windowSince: new Date(sinceMs).toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// v0.2.3 today token ledger (老大 m01525): count today's tokens from the SAME
// local session logs the estimate route reads, and convert to Credits with the
// anchored per-call rates (night discount included via estimateCredits).
// Honest scope: only model calls made through THIS DSH host are logged; calls
// from other clients (IDE, scripts) are not counted.
// ---------------------------------------------------------------------------

function todayStartMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }

async function todayTokenLedger() {
  const t0 = todayStartMs();
  let calls = 0, input = 0, output = 0, cached = 0, credits = 0;
  const perModel = new Map();
  for (const { p, m } of iterSessionFiles(200)) {
    if (m < t0) continue; // file untouched today → cannot contain today's records (cheap mtime skip)
    for (const rec of await extractUsageFromFile(p, t0)) {
      if (rec.at < t0) continue;
      const i = Number(rec.usage?.inputTokens ?? rec.usage?.prompt_tokens ?? rec.usage?.input_tokens) || 0;
      const o = Number(rec.usage?.outputTokens ?? rec.usage?.completion_tokens ?? rec.usage?.output_tokens) || 0;
      const c = Number(rec.usage?.cacheReadTokens ?? rec.usage?.prompt_tokens_details?.cached_tokens) || 0;
      const cr = estimateCredits(rec.model, rec.usage, rec.at);
      calls += 1; input += i; output += o; cached += c; credits += cr;
      const key = rec.model || '(unknown)';
      const e = perModel.get(key) || { model: key, tokens: 0, credits: 0 };
      e.tokens += i + o; e.credits += cr; perModel.set(key, e);
    }
  }
  return {
    calls,
    inputTokens: input, outputTokens: output, cachedTokens: cached,
    totalTokens: input + output,
    credits: Math.round(credits * 100) / 100,
    perModel: [...perModel.values()].sort((a, b) => b.credits - a.credits).slice(0, 6)
      .map((e) => ({ model: e.model, tokens: e.tokens, credits: Math.round(e.credits * 100) / 100 })),
    since: new Date(t0).toISOString(),
  };
}

function monthStartMs() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// ---------------------------------------------------------------------------
// source C: sk-sp gateway probe (read-only, single-shot per refresh)
// ---------------------------------------------------------------------------

async function probeGateway(ctx, config) {
  const key = await resolveApiKey(ctx, config);
  if (!key) return { attempted: false, reason: 'no-sk-sp-key' };
  const results = [];
  for (const p of GATEWAY_QUOTA_PATHS) {
    const url = `${TOKEN_PLAN_BASE}/${p}`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      let bodyKind = 'empty';
      let quotaLike = null;
      if (res.status === 200) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const j = await res.json().catch(() => null);
          if (j && typeof j === 'object') {
            bodyKind = 'json';
            // Only accept shapes that clearly carry credits/quota fields.
            if (j.remainingCredits != null || j.totalCredits != null || j.credits != null || j.quota != null) {
              quotaLike = j;
            }
          }
        }
      } else {
        bodyKind = `http-${res.status}`;
      }
      results.push({ path: p, status: res.status, bodyKind, quotaLike });
      if (quotaLike) break;
    } catch (e) {
      results.push({ path: p, status: 0, bodyKind: 'error', error: String(e && e.message || e).slice(0, 120) });
    }
  }
  const hit = results.find((r) => r.quotaLike);
  if (hit) {
    const j = hit.quotaLike;
    return {
      attempted: true,
      available: true,
      snapshot: {
        source: 'gateway',
        endpoint: hit.path,
        fetchedAt: new Date().toISOString(),
        planName: j.plan_name ?? j.planName ?? 'Token Plan',
        totalCredits: numOrNull(j.totalCredits ?? j.total_credits ?? j.credits?.total),
        remainingCredits: numOrNull(j.remainingCredits ?? j.remaining_credits ?? j.credits?.remaining ?? j.remaining),
        usedPct: numOrNull(j.usedPct ?? j.used_pct),
        resetAt: j.resetDate ?? j.resetAt ?? j.reset_date ?? null,
        tierLabel: j.tier ?? j.planTier ?? null,
      },
    };
  }
  return { attempted: true, available: false, reason: 'no-quota-endpoint', probes: results.map((r) => ({ path: r.path, status: r.status, kind: r.bodyKind })) };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null));

// ---------------------------------------------------------------------------
// cache + polling
// ---------------------------------------------------------------------------

function createCache() {
  return {
    snapshot: null,       // last good combined snapshot object
    lastAttemptAt: null,
    lastError: null,      // {at, message} sanitized
    gateway: { probed: false, result: null },
    cliStatus: 'unknown', // ok | unavailable:<reason> | unknown
    refreshing: null,     // in-flight promise
    dailyBaseline: null,  // {date:'YYYY-MM-DD', remaining, since} — first-seen remaining of the local day (v0.2.0, in-memory only)
    todayLedger: null,    // v0.2.3: today's local token ledger {calls,totalTokens,credits,perModel,...}
  };
}

const localDateStr = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// v0.2.0 "今日使用": the CLI gives no per-day Credits for the individual plan
// (usage summary token_plan stays {subscribed:false}; usage logs is empty), so
// we diff the monthly-cumulative remainingCredits against the day's first
// observed value. Honest caveats: baseline is in-memory (a host restart mid-day
// rebaselines from that moment) and a monthly reset / top-up raises remaining,
// which we detect and rebaseline.
function updateDailyBaseline(cache) {
  const rem = cache.snapshot && cache.snapshot.remainingCredits;
  if (typeof rem !== 'number') return;
  const today = localDateStr();
  const b = cache.dailyBaseline;
  if (!b || b.date !== today || rem > b.remaining) {
    cache.dailyBaseline = { date: today, remaining: rem, since: new Date().toISOString() };
  }
}

function buildSnapshot(cache, config) {
  const s = cache.snapshot;
  if (!s) return null;
  const out = { ...s };
  out.pollIntervalSec = clampNum(config.pollIntervalSec, 30, 3600) ?? 120;  out.nextRefreshAt = cache.lastAttemptAt
    ? new Date(Date.parse(cache.lastAttemptAt) + out.pollIntervalSec * 1000).toISOString()
    : null;
  // tier constant fallback for display math when CLI gave total but not tier label
  if (out.totalCredits && !out.tierLabel) {
    for (const [tier, credits] of Object.entries(TIER_CREDITS)) {
      if (out.totalCredits === credits) { out.tierLabel = tier; break; }
    }
  }
  // v0.2.0 today-usage: diff against the day's first observed remainingCredits.
  const b = cache.dailyBaseline;
  if (b && b.date === localDateStr() && typeof out.remainingCredits === 'number') {
    out.usedTodayCredits = Math.max(0, Math.round(b.remaining - out.remainingCredits));
    out.todaySince = b.since;
  } else {
    out.usedTodayCredits = null;
  }
  // v0.2.3: today's local token ledger + Credits conversion (see todayTokenLedger).
  out.todayTokens = cache.todayLedger && cache.todayLedger.calls > 0 ? cache.todayLedger : null;
  return out;
}

async function safeRefresh(ctx, config, { force = false } = {}) {
  // Every timer callback goes through here. An uncaught rejection inside an
  // interval used to take the whole desktop host down (spawn EINVAL crash log);
  // refresh() itself must never be able to bubble out of a timer context.
  try {
    return await refresh(ctx, config, { force });
  } catch (e) {
    const cache = ctx._tpqCache;
    if (cache) {
      cache.lastError = { at: new Date().toISOString(), reason: 'refresh-crashed', detail: String(e && e.message || e).slice(0, 200) };
    }
    try { ctx.logger?.warn?.('[tokenplan-quota] refresh guarded: ' + String(e && e.message || e).slice(0, 160)); } catch { /* logger optional */ }
    return { available: false, reason: 'refresh-crashed' };
  }
}

async function refresh(ctx, config, { force = false } = {}) {
  const cache = ctx._tpqCache;
  if (cache.refreshing && !force) return cache.refreshing;
  const job = (async () => {
    cache.lastAttemptAt = new Date().toISOString();
    try {
      // Priority: gateway (if previously proven) > CLI > estimate.
      let got = null;
      if (cache.gateway.probed && cache.gateway.available) {
        got = await probeGateway(ctx, config);
        if (!got.available) cache.gateway = { probed: true, available: false, result: got };
      }
      if (!got?.available) {
        // Belt and braces for the crash path (v0.1.3): even though runCli/
        // fetchViaCli are individually guarded, no source call may ever throw
        // out of the polling job — that is what killed the host process.
        const cli = await Promise.resolve(fetchViaCli(ctx, config)).catch((e) => ({
          available: false, reason: 'cli-spawn-failed', detail: String(e && e.message || e).slice(0, 160),
        }));
        cache.cliStatus = cli.available ? 'ok' : `unavailable:${cli.reason}`;
        if (cli.available) {
          got = cli;
        } else {
          const est = await Promise.resolve(fetchViaEstimate(ctx, config)).catch((e) => ({
            available: false, reason: 'estimate-failed', detail: String(e && e.message || e).slice(0, 160),
          }));
          if (est.available) {
            got = { available: true, snapshot: { ...est.snapshot, cliHint: cli.reason, installCommand: cli.installCommand || CLI_INSTALL_CMD } };
          } else {
            got = { available: false, reason: cli.reason, detail: cli.detail || '', estimate: est.available ? null : est.reason };
          }
        }
      }
      if (got.available) {
        cache.snapshot = got.snapshot;
        cache.lastError = null;
        updateDailyBaseline(cache);
        // v0.2.3: token ledger is source-independent (reads local logs only),
        // so it updates on every successful refresh even when CLI is primary.
        cache.todayLedger = await Promise.resolve(todayTokenLedger())
          .catch(() => cache.todayLedger);
      } else {
        cache.lastError = { at: cache.lastAttemptAt, reason: got.reason || 'unknown', detail: String(got.detail || '').slice(0, 200) };
      }
      return got;
    } finally {
      cache.refreshing = null;
    }
  })();
  cache.refreshing = job;
  return job;
}

// ---------------------------------------------------------------------------
// HTTP routes (same-origin, consumed by client panel and agent tool)
// ---------------------------------------------------------------------------

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function publicState(ctx, config) {
  const cache = ctx._tpqCache;
  return {
    snapshot: buildSnapshot(cache, config),
    lastAttemptAt: cache.lastAttemptAt,
    lastError: cache.lastError,
    cliStatus: cache.cliStatus,
    gatewayProbed: cache.gateway.probed ? cache.gateway : null,
    refreshing: !!cache.refreshing,
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// settings persistence via configEditor (entry config restarts the plugin on
// non-volatile fields; pollIntervalSec is volatile so it applies in place)
// ---------------------------------------------------------------------------

async function patchConfig(ctx, fields) {
  // configEditor is a profile-context service; it may be absent in some modes.
  // Soft-get so a missing editor degrades to in-memory-only changes instead of
  // throwing inside a route handler (loader-findings.md §7.3).
  const editor = ctx.get('configEditor');
  if (!editor || !ctx.fiber?.entry) return false;
  try {
    await editor.edit(ctx.fiber.entry, (current) => ({ ...(current || {}), ...fields }));
    return true;
  } catch (e) {
    ctx.logger?.warn?.('[tokenplan-quota] config persist failed (in-memory only): ' + String(e && e.message || e).slice(0, 160));
    return false;
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  ctx._tpqCache = createCache();
  // Activation breadcrumb (loader-findings.md §7.4): the desktop host has no
  // log sink channel for plugin info lines, but a visible route/401 test plus
  // this line cover both worlds.
  try { ctx.logger?.info?.('[tokenplan-quota] host fiber activated'); } catch { /* logger optional */ }

  // First refresh shortly after boot, then interval polling. All timer bodies
  // are guarded (v0.1.3): a throw here previously killed the host process.
  ctx.effect(() => {
    const start = setTimeout(() => { void safeRefresh(ctx, config); }, 3000);
    return () => clearTimeout(start);
  });

  // v0.1.1: plain setInterval with effect cleanup — no ctx.timer dependency.
  ctx.effect(() => {
    const sec = clampNum(config.pollIntervalSec, 30, 3600) ?? 120;
    const t = setInterval(() => { void safeRefresh(ctx, config); }, sec * 1000);
    return () => clearInterval(t);
  });

  // One-shot gateway probe (findings say these paths are unverified; probe once
  // per host lifetime, record the outcome, do not hammer the gateway).
  ctx.effect(() => {
    const t = setTimeout(async () => {
      try {
        const cache = ctx._tpqCache;
        if (cache.gateway.probed) return;
        const r = await probeGateway(ctx, config);
        cache.gateway = { probed: true, available: !!r.available, result: r };
        if (r.available) { cache.snapshot = r.snapshot; cache.lastError = null; updateDailyBaseline(cache); }
      } catch (e) {
        try { ctx.logger?.warn?.('[tokenplan-quota] gateway probe guarded: ' + String(e && e.message || e).slice(0, 160)); } catch { /* logger optional */ }
      }
    }, 6000);
    return () => clearTimeout(t);
  });

  // HTTP surface for the client panel. v0.1.1: apply() already declares
  // inject: ['webServer'], so webServer is a guaranteed dependency — use it
  // directly (the old ctx.inject(['webServer'], cb) form was harmless but
  // implied optionality that masked activation failures).
  const routes = [
    { path: '/api/tokenplan/state', handle: async (req, res) => json(res, 200, publicState(ctx, config)) },
    { path: '/api/tokenplan/refresh', handle: async (req, res) => {
      const r = await safeRefresh(ctx, config, { force: true });
      json(res, r.available ? 200 : 502, { ...publicState(ctx, config), lastResult: r.available ? 'ok' : (r.reason || 'failed') });
    } },
    { path: '/api/tokenplan/settings', handle: async (req, res) => {
      const body = await readBody(req);
      const fields = {};
      const pi = clampNum(body.pollIntervalSec, 30, 3600);
      if (pi != null) fields.pollIntervalSec = pi;
      let persisted = false;
      if (Object.keys(fields).length) persisted = await patchConfig(ctx, fields);
      json(res, 200, { ...publicState(ctx, config), persisted });
    } },
    { path: '/api/tokenplan/key-status', handle: async (req, res) => {
      const key = await resolveApiKey(ctx, config);
      json(res, 200, { present: !!key, hint: key ? `sk-sp-…${key.slice(-4)}` : null });
    } },
  ];
  for (const r of routes) {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: r.path,
      handler: async (req, res) => {
        try {
          if (r.path.endsWith('/settings') && req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' });
          await r.handle(req, res);
        } catch (e) {
          json(res, 500, { error: String(e && e.message || e).slice(0, 200) });
        }
      },
    });
    ctx.effect(() => dispose);
  }

  // Agent-visible read tool sharing the exact same implementation.
  // Soft-get 'tools' (same style as configEditor above): dsh-base provides it,
  // but a nested ctx.inject would make our fiber wait on it and re-introduce
  // the PENDING failure mode we just removed (review F3).
  const tools = ctx.get('tools');
  if (tools) {
    const dispose = tools.register({
      name: 'tokenplan_quota_status',
      description: 'Read the cached Qianwen Token Plan Credits snapshot (remaining credits, tier, reset time, data source). Refreshes the cache once if it is stale. Never triggers any model call.',
      parameters: {
        type: 'object',
        properties: {
          refresh: { type: 'boolean', description: 'Force a refresh before reading. Default false.' },
        },
      },
      // Host tool contract (cordis ^4.1) requires an output descriptor; shape mirrors dsh-qwen-mcp.
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        if (args?.refresh) await safeRefresh(ctx, config, { force: true });
        else if (!ctx._tpqCache.snapshot) await safeRefresh(ctx, config, { force: true });
        const state = publicState(ctx, config);
        const s = state.snapshot;
        if (!s) {
          return {
            available: false,
            message: 'No quota data yet. ' + (state.lastError?.reason || ctx._tpqCache.cliStatus || 'pending'),
            cliInstall: CLI_INSTALL_CMD,
            lastError: state.lastError,
          };
        }
        return { available: true, snapshot: s };
      },
    });
    ctx.effect(() => dispose);
  }
}
