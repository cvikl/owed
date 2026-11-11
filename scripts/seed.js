// Seed the order pool on the PayPal sandbox, and the kill tests that prove each PayPal surface works.
//   npm run seed -- --test          one order: create, capture, refund $5, read back, add tracking, read back
//   npm run seed -- --count 20      add 20 paid $25 orders to data/pool.json (each with tracking marked delivered)
// Sandbox only: src/paypalRest.js refuses any other base URL.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PayPalRest } from '../src/paypalRest.js';
import { FACTS } from '../src/pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const FILE = path.join(DATA, 'pool.json');
const args = process.argv.slice(2);
const TEST = args.includes('--test');
const COUNT = Number(args[args.indexOf('--count') + 1] || 0) || (TEST ? 1 : 10);
const pp = new PayPalRest();
const t = () => new Date().toISOString().slice(11, 19);

async function seedOne(i) {
  const t0 = Date.now();
  const o = await pp.createPaidOrder({ amountCents: FACTS.capturedCents, description: 'Mug and Co, one mug', requestId: `seed-${Date.now()}-${i}` });
  const tracking = `OWED${Date.now().toString(36).toUpperCase()}${i}`;
  let trackingAdded = false;
  try { await pp.addTracking(o.orderId, o.captureId, tracking, 'OTHER'); trackingAdded = true; } catch (e) { console.log(`${t()}   tracking not added: ${e.message}`); }
  console.log(`${t()} order ${o.orderId} capture ${o.captureId} ${o.status} $${o.amountCents / 100} in ${Date.now() - t0} ms${trackingAdded ? `, tracking ${tracking} SHIPPED` : ''}`);
  return { orderId: o.orderId, captureId: o.captureId, capturedCents: o.amountCents, trackingNumber: trackingAdded ? tracking : null, createdAt: new Date().toISOString() };
}

if (TEST) {
  console.log(`${t()} kill test 2 to 4 on ${process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com'}`);
  const o = await seedOne(0);
  const cap = await pp.getCapture(o.captureId, o.orderId);
  console.log(`${t()} read back capture: ${JSON.stringify(cap)}`);
  const r0 = Date.now();
  const r = await pp.refund(o.captureId, FACTS.owedCents, `test-${Date.now()}`);
  console.log(`${t()} refund ${r.id} ${r.status} $${r.amountCents / 100} issued in ${Date.now() - r0} ms`);
  const rr = await pp.getRefund(r.id);
  console.log(`${t()} read back refund: ${rr.id} ${rr.status} ${rr.amountCents} ${rr.currency} ${rr.createTime}`);
  const cap2 = await pp.getCapture(o.captureId, o.orderId);
  console.log(`${t()} capture after refund: refunded ${cap2.refundedCents} of ${cap2.amountCents}`);
  const tr = await pp.getTracking(o.orderId);
  console.log(`${t()} tracking read back: ${JSON.stringify(tr)}`);
  try { await pp.refund(o.captureId, 2500, `test-over-${Date.now()}`); console.log(`${t()} WARNING over-refund was accepted`); }
  catch (e) { console.log(`${t()} over-refund refused by PayPal: ${e.code ?? e.message}`); }
  process.exit(0);
}

fs.mkdirSync(DATA, { recursive: true });
let pool = []; try { pool = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { }
for (let i = 0; i < COUNT; i++) {
  try { pool.push(await seedOne(i)); fs.writeFileSync(FILE, JSON.stringify(pool, null, 1)); }
  catch (e) { console.log(`${t()} failed: ${e.message} ${e.debugId ?? ''}`); }
}
console.log(`${t()} pool now ${pool.length} orders, ${pool.filter((o) => !o.sessionId).length} free`);
