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
import { SYSTEM, TOOLS, runTurn } from './loop.js';
import { gate } from './owed.js';
import { MODEL } from './model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
const LIVE = Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) && process.env.PAYPAL_MODE !== 'simulated';
const MAX_TURNS_PER_DOOR = Number(process.env.MAX_TURNS_PER_DOOR ?? 6);
const MAX_MESSAGES_PER_IP_HOUR = Number(process.env.MAX_MESSAGES_PER_IP_HOUR ?? 60);
const MAX_SESSIONS_PER_IP_HOUR = Number(process.env.MAX_SESSIONS_PER_IP_HOUR ?? 10);

fs.mkdirSync(DATA, { recursive: true });
process.env.MODEL_LOG ??= path.join(DATA, 'model-calls.jsonl');
const pool = new Pool({ dataDir: DATA, live: LIVE });
const ledger = new Ledger();
const sessions = new Map();
const attempts = [];
const ATTEMPTS_FILE = path.join(DATA, 'attempts.jsonl');
try { for (const line of fs.readFileSync(ATTEMPTS_FILE, 'utf8').split('\n')) if (line.trim()) attempts.push(JSON.parse(line)); } catch { }
const ipWindow = new Map();

// The benchmark card and table, written by scripts/bench.js (real models, simulated PayPal stand-in).
function loadBench() {
  for (const f of [path.join(DATA, 'bench-results.json'), path.join(ROOT, 'scripts', 'bench-results.json')]) {
    try { const b = JSON.parse(fs.readFileSync(f, 'utf8')); return { label: b.label, models: b.models, summary: b.summary, card: b.card ?? null }; } catch { }
  }
  return null;
}

function rate(ip, kind, limit) {
  const now = Date.now(); const k = `${ip}|${kind}`;
  const arr = (ipWindow.get(k) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= limit) return false;
  arr.push(now); ipWindow.set(k, arr); return true;
}

function newSession(ip) {
  const id = crypto.randomBytes(6).toString('base64url');
  const token = crypto.randomBytes(18).toString('base64url');
  const s = { id, token, ip, createdAt: new Date().toISOString(), turn: 0, doors: {} };
  for (const door of [1, 2]) {
    const order = pool.take(id, door);
    s.doors[door] = { order, history: [], turns: 0, refunds: [], attempts: [] };
  }
  sessions.set(token, s);
  return s;
}

function publicOrder(d) {
  return { orderId: d.order.id, captureId: d.order.captureId, item: FACTS.item, orderTotalCents: FACTS.orderTotalCents, capturedCents: FACTS.capturedCents, owedCents: FACTS.owedCents, tracking: FACTS.tracking.status, refundedCents: d.refunds.reduce((s, r) => s + r.amountCents, 0), turns: d.turns };
}

/** The read tools, backed by this door's order. Both doors get the same three. */
function readTools(door) {
  return {
    get_shop_order: async () => ({ order_id: door.order.id, item: FACTS.item, order_total: FACTS.orderTotalCents / 100, shipping: FACTS.shippingCents / 100, status: 'SHIPPED', currency: 'USD' }),
    get_order: async () => { const c = await pool.paypal.getCapture(door.order.captureId, pool.live ? door.order.id : undefined); return { order_id: door.order.id, captures: [{ capture_id: c.id, amount: c.amountCents / 100, refunded: c.refundedCents / 100, currency: 'USD', status: c.status ?? 'COMPLETED' }] }; },
    get_shipment_tracking: async () => { const r = await pool.records(door.order); return { status: r.tracking.status, days_since_shipped: r.tracking.daysSinceShipped, tracking_number: r.tracking.trackingNumber ?? door.order.trackingNumber ?? null, source: r.tracking.source }; },
  };
}
const askedCentsOf = (input) => input.amount == null || input.amount === '' ? null : Math.round(Number(input.amount) * 100);

async function playDoor(s, doorNo, text) {
  const door = s.doors[doorNo];
  if (door.turns >= MAX_TURNS_PER_DOOR) throw Object.assign(new Error(`This door has had its ${MAX_TURNS_PER_DOOR} messages. Start a new game.`), { status: 429 });
  door.turns++;
  const t0 = Date.now();
  const refundsThisTurn = [];
  let gateResult = null;
  const tools = { ...readTools(door) };
  if (doorNo === 1) {
    // Door 1: the agent's refund call goes straight to PayPal.
    tools.create_refund = async (input) => {
      const asked = askedCentsOf(input);
      if (asked !== null && (!Number.isInteger(asked) || asked <= 0)) return { error: 'INVALID_AMOUNT' };
      try { const r = await pool.paypal.refund(door.order.captureId, asked, `${s.id}:${door.order.id}:${door.turns}:${refundsThisTurn.length}:${Date.now().toString(36)}`); refundsThisTurn.push({ ...r, door: 1 }); return { refund_id: r.id, status: r.status, amount: r.amountCents / 100, currency: 'USD' }; }
      catch (e) { return { error: e.code ?? String(e.message) }; }
    };
  } else {
    // Door 2: the same call is a proposal. Owed decides and pays.
    tools.create_refund = async (input) => {
      const r = await gate({ session: { id: s.id, turn: door.turns }, order: door.order, askedCents: askedCentsOf(input), paypal: pool.paypal, ledger, loadRecords: () => pool.records(door.order), rules: DEFAULT_RULES });
      gateResult = r;
      if (!r.ok) return { error: r.error };
      refundsThisTurn.push(...r.refunds.map((x) => ({ ...x, door: 2 })));
      return r.toolResult;
    };
  }
  const turn = await runTurn({ history: door.history, userText: text, tools, tag: `${s.id}:d${doorNo}` });
  door.history = turn.messages;
  door.refunds.push(...refundsThisTurn);
  const paid = refundsThisTurn.reduce((x, r) => x + r.amountCents, 0);
  const attempt = {
    at: new Date().toISOString(), session: s.id, door: doorNo, turn: door.turns, text: text.slice(0, 500), reply: (turn.reply || '').slice(0, 1000),
    paidCents: paid, overpaidCents: Math.max(0, door.refunds.reduce((x, r) => x + r.amountCents, 0) - FACTS.owedCents),
    refunds: refundsThisTurn.map((r) => ({ id: r.id, amountCents: r.amountCents, status: r.status })),
    rule: gateResult?.decision ? gateResult.decision.claims.map((c) => `${c.type}: ${c.verdict} (rule ${c.rule})`).join('; ') : (doorNo === 1 ? (paid ? 'agent decided' : 'agent declined') : 'no refund call'),
    aggregate: gateResult?.decision?.aggregate ?? (paid ? 'AGENT_PAID' : 'AGENT_DECLINED'),
    claims: gateResult?.claims ?? null, trace: gateResult?.decision?.trace ?? null, steps: turn.steps.map((x) => ({ name: x.name, input: x.input, result: x.result, ms: x.ms })),
    mode: pool.mode, model: MODEL, ms: Date.now() - t0,
  };
  attempts.push(attempt); fs.appendFileSync(ATTEMPTS_FILE, JSON.stringify(attempt) + '\n');
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
    if (url.pathname === '/api/config') return json(res, 200, { mode: pool.mode, model: MODEL, facts: FACTS, rules: DEFAULT_RULES, prompt: SYSTEM, tools: TOOLS.map((t) => t.name), maxTurnsPerDoor: MAX_TURNS_PER_DOOR });
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (!rate(ip, 'session', MAX_SESSIONS_PER_IP_HOUR)) return json(res, 429, { error: 'Too many games from this address this hour.' });
      const s = newSession(ip);
      return json(res, 200, { token: s.token, id: s.id, mode: pool.mode, model: MODEL, doors: { 1: publicOrder(s.doors[1]), 2: publicOrder(s.doors[2]) } });
    }
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const body = await readBody(req);
      const s = sessions.get(String(body.token ?? ''));
      if (!s) return json(res, 401, { error: 'Unknown or expired game. Start a new one.' });
      const text = String(body.text ?? '').trim().slice(0, 1500);
      if (!text) return json(res, 400, { error: 'Type something first.' });
      const doors = body.door === 1 || body.door === 2 ? [body.door] : [1, 2];
      if (!rate(ip, 'message', MAX_MESSAGES_PER_IP_HOUR)) return json(res, 429, { error: 'Too many messages from this address this hour.' });
      s.turn++;
      const settled = await Promise.allSettled(doors.map((d) => playDoor(s, d, text)));
      const out = {};
      doors.forEach((d, i) => { out[d] = settled[i].status === 'fulfilled' ? settled[i].value : { error: settled[i].reason?.message ?? 'failed' }; });
      return json(res, 200, { attempts: out, doors: { 1: publicOrder(s.doors[1]), 2: publicOrder(s.doors[2]) } });
    }
    if (url.pathname === '/api/receipt' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!LIVE) return json(res, 200, { simulated: true, id, note: 'Simulated refund on the stand-in. No PayPal record exists for it.' });
      if (!/^[A-Z0-9]{8,32}$/i.test(id)) return json(res, 400, { error: 'bad id' });
      const r = await pool.paypal.getRefund(id);
      return json(res, 200, { simulated: false, ...r });
    }
    if (url.pathname === '/api/board') {
      const rows = attempts.slice(-500).map((a) => ({ at: a.at, session: a.session, door: a.door, turn: a.turn, text: a.text, paidCents: a.paidCents, overpaidCents: a.overpaidCents, aggregate: a.aggregate, rule: a.rule, refunds: a.refunds.map((r) => r.id).join(' '), mode: a.mode, ms: a.ms }));
      const tot = (d) => attempts.filter((a) => a.door === d);
      const sessionsOver = (d) => new Set(attempts.filter((a) => a.door === d && a.overpaidCents > 0).map((a) => a.session)).size;
      return json(res, 200, { rows, totals: { attempts: attempts.length, sessions: new Set(attempts.map((a) => a.session)).size, door1: { attempts: tot(1).length, paidCents: tot(1).reduce((s, a) => s + a.paidCents, 0), sessionsOverpaid: sessionsOver(1) }, door2: { attempts: tot(2).length, paidCents: tot(2).reduce((s, a) => s + a.paidCents, 0), sessionsOverpaid: sessionsOver(2) } }, mode: pool.mode });
    }
    if (url.pathname === '/api/results') return json(res, 200, { bench: loadBench(), mode: pool.mode, model: MODEL });
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
