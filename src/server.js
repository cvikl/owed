// The arena server. No framework, no database: Node's http, an in-memory ledger and session store,
// an append-only attempts log on disk. One process is enough for a hackathon demo and keeps the
// decide-and-reserve step synchronous, which is what the race test relies on.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, FACTS } from './pool.js';
import { Ledger } from './ledger.js';
import { DEFAULT_RULES } from './engine.js';
import { runTurn, labelClaims } from './loop.js';
import { TOOLS, PROMPTS, PROMPT_LABELS, promptFor, askedCents } from '../scripts/scenarios.js';
import { gate, settleFromRecord } from './owed.js';
import { MODEL } from './model.js';
import { loadToolkit, toolkitRun, toolkitInfo, toolkitVerified } from './toolkit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
const LIVE = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) && process.env.PAYPAL_MODE !== 'simulated';
const MAX_TURNS_PER_DOOR = Number(process.env.MAX_TURNS_PER_DOOR ?? 6);
const MAX_MESSAGES_PER_IP_HOUR = Number(process.env.MAX_MESSAGES_PER_IP_HOUR ?? 60);
const MAX_SESSIONS_PER_IP_HOUR = Number(process.env.MAX_SESSIONS_PER_IP_HOUR ?? 10);
const MAX_MESSAGES_PER_DAY = Number(process.env.MAX_MESSAGES_PER_DAY ?? 4000); // the whole site, so one script cannot empty the model key during judging
const DEFAULT_PROMPT = PROMPTS[process.env.DEFAULT_PROMPT] ? process.env.DEFAULT_PROMPT : 'shop';
const DISPUTES_CHECKED = LIVE && process.env.CHECK_DISPUTES === '1';
const money = (c) => ({ currency_code: 'USD', value: (c / 100).toFixed(2) });

// PayPal's own Agent Toolkit, when installed: the model gets its real tool definitions and its code runs the calls.
if (LIVE) await loadToolkit();
// The model always gets the definitions in scripts/scenarios.js (copied from the toolkit). When the toolkit is
// installed, Door 1's refund is executed by the toolkit's own code. Lookups always use our REST client.
const TK = () => toolkitInfo().installed;
const toolDefs = () => TOOLS;

// The board is public. Hide anything that looks like contact details or abuse before it is stored.
const RUDE = /\b(fuck\w*|shit\w*|cunt\w*|bitch\w*|nigg\w*|fagg?\w*|retard\w*|rape\w*|kill yourself)\b/gi;
const ruleText = (g) => g.decision.claims.map((c) => `${c.type}: ${c.verdict} (rule ${c.rule})`).join('; ');
const mask = (t) => String(t ?? '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email hidden]').replace(/https?:\/\/\S+/gi, '[link hidden]').replace(/(\+?\d[\d\s().-]{7,}\d)/g, '[number hidden]').replace(RUDE, '[hidden]');
const dayCount = new Map();
function dailyOk() { const d = new Date().toISOString().slice(0, 10); const n = dayCount.get(d) ?? 0; if (n >= MAX_MESSAGES_PER_DAY) return false; dayCount.set(d, n + 1); return true; }

fs.mkdirSync(DATA, { recursive: true });
process.env.MODEL_LOG ??= path.join(DATA, 'model-calls.jsonl');
const pool = new Pool({ dataDir: DATA, live: LIVE });
const ledger = new Ledger();
const sessions = new Map();
const attempts = [];
const ATTEMPTS_FILE = path.join(DATA, 'attempts.jsonl');
try { for (const line of fs.readFileSync(ATTEMPTS_FILE, 'utf8').split('\n')) if (line.trim()) attempts.push(JSON.parse(line)); } catch { }
const ipWindow = new Map();
const POOL_MIN = Number(process.env.POOL_MIN ?? 20);
if (LIVE) { const tick = () => pool.refill({ min: POOL_MIN, batch: 10 }).then((n) => { if (n) console.log(`pool refilled by ${n}, ${pool.available()} free`); }); setTimeout(tick, 5000); setInterval(tick, 60_000); }

// The benchmark card and table, written by scripts/bench.js (real models, simulated PayPal stand-in).
function loadBench() {
  for (const f of [path.join(DATA, 'bench-results.json'), path.join(ROOT, 'scripts', 'bench-results.json')]) {
    try { const b = JSON.parse(fs.readFileSync(f, 'utf8')); return { label: b.label, models: b.models, summary: b.summary, card: b.card ?? null, paired: b.paired ?? null, commit: b.commit ?? null, prompts: b.prompts ?? ['strict'], runs: b.runs ?? 1, promptLabels: b.promptLabels ?? PROMPT_LABELS, at: b.at ?? null }; } catch { }
  }
  return null;
}

function rate(ip, kind, limit) {
  const now = Date.now(); const k = `${ip}|${kind}`;
  const arr = (ipWindow.get(k) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= limit) return false;
  arr.push(now); ipWindow.set(k, arr); return true;
}

function newSession(ip, { prompt, custom } = {}) {
  const id = crypto.randomBytes(6).toString('base64url');
  const token = crypto.randomBytes(18).toString('base64url');
  const customText = String(custom ?? '').trim().slice(0, 2000);
  const promptKind = prompt === 'custom' && customText ? 'custom' : PROMPTS[prompt] ? prompt : DEFAULT_PROMPT;
  const s = { id, token, ip, createdAt: new Date().toISOString(), turn: 0, doors: {}, promptKind, custom: promptKind === 'custom' ? customText : null };
  for (const door of [1, 2]) {
    const order = pool.take(id, door);
    s.doors[door] = { order, history: [], turns: 0, refunds: [], attempts: [], busy: false, lastRefundMs: null };
  }
  sessions.set(token, s);
  return s;
}

function publicOrder(d) {
  return { orderId: d.order.id, captureId: d.order.captureId, item: FACTS.item, orderTotalCents: FACTS.orderTotalCents, capturedCents: FACTS.capturedCents, owedCents: FACTS.owedCents, tracking: FACTS.tracking.status, refundedCents: d.refunds.reduce((s, r) => s + r.amountCents, 0), turns: d.turns, busy: d.busy, lastRefundMs: d.lastRefundMs, refunds: d.refunds.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status })) };
}

/**
 * The read tools, backed by this door's order. Both doors get the same three. The ids are pinned to the
 * session's own order whatever the model sends, so a player cannot point an agent at someone else's order.
 */
function readTools(door) {
  return {
    get_shop_order: async () => ({ order_id: door.order.id, item: FACTS.item, order_total: money(FACTS.orderTotalCents), shipping: money(FACTS.shippingCents), status: 'SHIPPED' }),
    get_order: async () => {
      const c = await pool.paypal.getCapture(door.order.captureId, pool.live ? door.order.id : undefined);
      return { id: door.order.id, status: 'COMPLETED', purchase_units: [{ payments: {
        captures: [{ id: c.id, status: c.status ?? 'COMPLETED', amount: money(c.amountCents) }],
        refunds: (c.refunds ?? door.refunds).map((r) => ({ id: r.id, status: r.status, amount: money(r.amountCents) })) } }] };
    },
    get_shipment_tracking: async () => {
      const r = await pool.records(door.order);
      return { trackers: [{ status: r.tracking.status, tracking_number: r.tracking.trackingNumber ?? door.order.trackingNumber ?? null, days_since_shipped: r.tracking.daysSinceShipped }] };
    },
  };
}

async function playDoor(s, doorNo, text, share = false) {
  const door = s.doors[doorNo];
  if (door.turns >= MAX_TURNS_PER_DOOR) throw Object.assign(new Error(`This door has had its ${MAX_TURNS_PER_DOOR} messages. Start a new game.`), { status: 429 });
  door.turns++; door.busy = true; door.lastRefundMs = null;
  const t0 = Date.now();
  const refundsThisTurn = [];
  // Every refund is recorded the moment PayPal confirms it, so the page can show it before the agent has finished writing.
  const onRefund = (r) => { const x = { ...r, door: doorNo }; refundsThisTurn.push(x); door.refunds.push(x); door.lastRefundMs ??= Date.now() - t0; };
  let gateResult = null;
  const tools = { ...readTools(door) };
  if (doorNo === 1) {
    // Door 1: the agent's refund call goes straight to PayPal, through PayPal's own toolkit when it is installed.
    tools.create_refund = async (input) => {
      const asked = askedCents(input);
      if (asked !== null && !(asked > 0)) return { error: 'INVALID_AMOUNT' };
      try {
        if (TK()) {
          const out = await toolkitRun('create_refund', { ...input, capture_id: door.order.captureId });
          if (!out?.id) return out; // PayPal's own error, passed back to the agent as the toolkit returns it
          toolkitVerified();
          const seen = await pool.paypal.getRefund(out.id).catch(() => null);
          onRefund({ id: out.id, captureId: door.order.captureId, amountCents: seen?.amountCents ?? asked ?? FACTS.capturedCents, askedCents: asked, status: seen?.status ?? out.status });
          return out;
        }
        const r = await pool.paypal.refund(door.order.captureId, asked, `${s.id}:${door.order.id}:${door.turns}:${refundsThisTurn.length}:${Date.now().toString(36)}`);
        onRefund(r);
        return { id: r.id, status: r.status, amount: money(r.amountCents) };
      } catch (e) { return { error: e.code ?? String(e.message) }; }
    };
  } else {
    // Door 2: the same call is a proposal. Owed decides and pays.
    tools.create_refund = async (input) => {
      const asked = askedCents(input);
      const r = await gate({ session: { id: s.id, turn: door.turns }, order: door.order, askedCents: asked, paypal: pool.paypal, ledger, loadRecords: () => pool.records(door.order), rules: DEFAULT_RULES, onRefund });
      gateResult = r;
      if (!r.ok) return { error: r.error };
      return r.toolResult;
    };
  }
  let turn;
  try { turn = await runTurn({ history: door.history, userText: text, tools, toolDefs: toolDefs(), system: promptFor(s.promptKind, door.order.id, s.custom), tag: `${s.id}:d${doorNo}` }); }
  catch (e) { door.busy = false; throw e; }
  door.history = turn.messages;
  let settled = null;
  if (doorNo === 2 && !turn.steps.some((x) => x.name === 'create_refund')) {
    // The agent did not propose. The record still settles what it proves, if the customer asked for money.
    settled = await settleFromRecord({ session: { id: s.id, turn: door.turns }, order: door.order, customerText: text, labelClaims: (t) => labelClaims(t, { tag: `${s.id}:d2` }), paypal: pool.paypal, ledger, loadRecords: () => pool.records(door.order), rules: DEFAULT_RULES, onRefund }).catch((e) => ({ ok: false, error: e.message }));
    if (settled?.ok) {
      gateResult = settled;
      const paidNow = settled.paidCents;
      const note = paidNow > 0 ? `Owed settled from the record: ${(paidNow / 100).toFixed(2)} USD refunded through PayPal (${settled.refunds.map((r) => r.id).join(', ')}).` : 'Owed checked the record: nothing provable is owed beyond what was already paid; the rest goes to a person.';
      turn.reply = `${note}\n\n${turn.reply || ''}`.trim();
      turn.steps.push({ name: 'owed_settle', input: { labelled: settled.labelled }, result: settled.toolResult, ms: settled.ms });
    }
  }
  door.busy = false;
  const paid = refundsThisTurn.reduce((x, r) => x + r.amountCents, 0);
  const totalAtDoor = door.refunds.reduce((x, r) => x + r.amountCents, 0);
  const attempt = {
    at: new Date().toISOString(), session: s.id, door: doorNo, turn: door.turns, shared: Boolean(share), text: mask(text).slice(0, 500), reply: (turn.reply || '').slice(0, 1000), prompt: s.promptKind,
    paidCents: paid, overpaidCents: Math.max(0, totalAtDoor - FACTS.owedCents), withheldCents: Math.max(0, FACTS.owedCents - totalAtDoor), firstRefundMs: door.lastRefundMs,
    refunds: refundsThisTurn.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status })),
    rule: gateResult?.decision ? (gateResult.fromRecord ? 'record settled: ' : '') + ruleText(gateResult) : (doorNo === 1 ? (paid ? 'agent decided' : 'agent declined') : 'no refund call, nothing claimed'),
    aggregate: gateResult?.decision?.aggregate ?? (paid ? 'AGENT_PAID' : 'AGENT_DECLINED'),
    claims: gateResult?.claims ?? null, trace: gateResult?.decision?.trace ?? null, steps: turn.steps.map((x) => ({ name: x.name, input: x.input, result: x.result, ms: x.ms })),
    mode: pool.mode, model: MODEL, ms: Date.now() - t0,
  };
  // What is kept and shown publicly carries the customer's words only when they ticked the box. The player still gets their own reply back.
  const kept = share ? attempt : { ...attempt, text: '', reply: '' };
  attempts.push(kept); fs.appendFileSync(ATTEMPTS_FILE, JSON.stringify(kept) + '\n');
  door.attempts.push(attempt);
  return attempt;
}

function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 20_000) { reject(Object.assign(new Error('Message too long'), { status: 413 })); req.destroy(); } }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } }); }); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '').trim();
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, mode: pool.mode, model: MODEL, poolAvailable: pool.available() === Infinity ? 'unlimited' : pool.available(), attempts: attempts.length });
    if (url.pathname === '/api/config') return json(res, 200, { mode: pool.mode, model: MODEL, facts: FACTS, rules: DEFAULT_RULES, prompts: PROMPTS, promptLabels: PROMPT_LABELS, defaultPrompt: DEFAULT_PROMPT, prompt: PROMPTS[DEFAULT_PROMPT], tools: toolDefs().map((t) => t.name), toolkit: toolkitInfo(), disputesChecked: DISPUTES_CHECKED, maxTurnsPerDoor: MAX_TURNS_PER_DOOR });
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (!rate(ip, 'session', MAX_SESSIONS_PER_IP_HOUR)) return json(res, 429, { error: 'Too many games from this address this hour.' });
      const sb = await readBody(req).catch(() => ({}));
      const s = newSession(ip, { prompt: sb.prompt, custom: sb.custom });
      return json(res, 200, { token: s.token, id: s.id, mode: pool.mode, model: MODEL, prompt: s.promptKind, doors: { 1: publicOrder(s.doors[1]), 2: publicOrder(s.doors[2]) } });
    }
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = await readBody(req);
      const s = sessions.get(String(body.token ?? ''));
      if (!s) return json(res, 401, { error: 'Unknown or expired game. Start a new one.' });
      const text = String(body.text ?? '').trim().slice(0, 1500);
      if (!text) return json(res, 400, { error: 'Type something first.' });
      const doors = body.door === 1 || body.door === 2 ? [body.door] : [1, 2];
      if (!rate(ip, 'message', MAX_MESSAGES_PER_IP_HOUR)) return json(res, 429, { error: 'Too many messages from this address this hour.' });
      if (!dailyOk()) return json(res, 429, { error: 'The arena has reached its limit for today so the bill stays small. It opens again at midnight UTC. The board below shows every attempt so far.' });
      s.turn++;
      const settled = await Promise.allSettled(doors.map((d) => playDoor(s, d, text, body.share === true)));
      const out = {};
      doors.forEach((d, i) => { out[d] = settled[i].status === 'fulfilled' ? settled[i].value : { error: settled[i].reason?.message ?? 'failed' }; });
      return json(res, 200, { attempts: out, doors: { 1: publicOrder(s.doors[1]), 2: publicOrder(s.doors[2]) } });
    }
    if (url.pathname === '/api/live' && req.method === 'GET') { // polled while a message is in flight, so a refund shows the moment PayPal confirms it
      const s = sessions.get(url.searchParams.get('token') ?? '');
      if (!s) return json(res, 404, { error: 'not found' });
      return json(res, 200, { doors: { 1: publicOrder(s.doors[1]), 2: publicOrder(s.doors[2]) } });
    }
    if (url.pathname === '/api/receipt' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!LIVE) return json(res, 200, { simulated: true, id, note: 'Simulated refund on the stand-in. No PayPal record exists for it.' });
      if (!/^[A-Z0-9]{8,32}$/i.test(id)) return json(res, 400, { error: 'bad id' });
      const r = await pool.paypal.getRefund(id);
      return json(res, 200, { simulated: false, ...r });
    }
    if (url.pathname === '/api/board') {
      const rows = attempts.slice(-500).map((a) => ({ at: a.at, session: a.session, door: a.door, turn: a.turn, shared: Boolean(a.shared), text: a.shared ? mask(a.text) : '', prompt: a.prompt ?? 'strict', paidCents: a.paidCents, overpaidCents: a.overpaidCents, withheldCents: a.withheldCents ?? null, aggregate: a.aggregate, rule: a.rule, reply: a.shared ? mask(a.reply ?? '').slice(0, 600) : '', trace: a.trace ?? null, refunds: a.refunds.map((r) => r.id).join(' '), mode: a.mode, ms: a.ms, firstRefundMs: a.firstRefundMs ?? null }));
      // The last attempt of each game at each door tells how that game ended there.
      const last = new Map(); for (const a of attempts) last.set(`${a.session}|${a.door}`, a);
      const ends = (d) => [...last.values()].filter((a) => a.door === d);
      const med = (xs) => { const v = xs.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
      const door = (d) => ({ attempts: attempts.filter((a) => a.door === d).length, paidCents: attempts.filter((a) => a.door === d).reduce((s, a) => s + a.paidCents, 0),
        sessionsOverpaid: ends(d).filter((a) => a.overpaidCents > 0).length, overpaidCents: ends(d).reduce((s, a) => s + a.overpaidCents, 0),
        sessionsWithheld: ends(d).filter((a) => (a.withheldCents ?? 0) > 0).length, sessionsExact: ends(d).filter((a) => a.overpaidCents === 0 && (a.withheldCents ?? 1) === 0).length,
        medianRefundMs: med(attempts.filter((a) => a.door === d).map((a) => a.firstRefundMs)) });
      return json(res, 200, { rows, totals: { attempts: attempts.length, sessions: new Set(attempts.map((a) => a.session)).size, door1: door(1), door2: door(2) }, mode: pool.mode });
    }
    if (url.pathname === '/api/results') { let race = null; for (const f of [path.join(DATA, 'race-live.json'), path.join(ROOT, 'data', 'race-live.json')]) { try { race = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { } } return json(res, 200, { bench: loadBench(), race, mode: pool.mode, model: MODEL }); }
    if (url.pathname === '/api/attempt') {
      const s = sessions.get(url.searchParams.get('token') ?? ''); const n = Number(url.searchParams.get('turn')); const d = Number(url.searchParams.get('door'));
      const a = s?.doors[d]?.attempts.find((x) => x.turn === n); return a ? json(res, 200, a) : json(res, 404, { error: 'not found' });
    }
    // static
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(WEB, p);
    if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); return fs.createReadStream(file).pipe(res);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, e.status ?? 500, { error: e.message ?? 'error' });
  }
});

server.listen(PORT, () => console.log(`Owed arena on :${PORT}, PayPal ${pool.mode}, model ${MODEL}, pool ${pool.available() === Infinity ? 'unlimited' : pool.available()}`));
