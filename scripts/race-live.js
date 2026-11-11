// The race test on the live PayPal sandbox. Twenty sessions ask for the same $5 at the same moment on two
// freshly captured $25 orders. Door 1 is a perfect agent: it reads PayPal's record, sees no earlier refund and
// refunds exactly $5. Door 2 routes the same ask through Owed's ledger. Live refunds, PayPal ids printed.
//   npm run race
import fs from 'node:fs';
import { PayPalRest } from '../src/paypalRest.js';
import { Ledger } from '../src/ledger.js';
import { claimsFromAmount, DEFAULT_RULES, VERDICT } from '../src/engine.js';
import { FACTS } from '../src/pool.js';

const pp = new PayPalRest();
const N = Number(process.env.N ?? 20);
const mk = async (tag) => pp.createPaidOrder({ amountCents: FACTS.capturedCents, description: 'Mug and Co, one mug', requestId: `race-${tag}-${Date.now()}` });
const A = await mk('a'); const B = await mk('b');
console.log(`Door 1 order ${A.orderId} capture ${A.captureId}; Door 2 order ${B.orderId} capture ${B.captureId}; ${N} sessions each`);

// Door 1: each session reads the capture, then refunds $5 if nothing was refunded yet.
const t1 = Date.now();
const r1 = await Promise.allSettled(Array.from({ length: N }, async (_, i) => {
  const c = await pp.getCapture(A.captureId, A.orderId);
  if (c.refundedCents > 0) return { skipped: true };
  return pp.refund(A.captureId, FACTS.owedCents, `race-d1-${A.captureId}-${i}-${Date.now()}`);
}));
const paid1 = r1.filter((x) => x.status === 'fulfilled' && x.value?.id).map((x) => x.value);
const errs1 = r1.filter((x) => x.status === 'rejected').map((x) => x.reason?.code ?? x.reason?.message);
console.log(`Door 1: ${paid1.length} refunds, $${(paid1.reduce((s, r) => s + r.amountCents, 0) / 100).toFixed(2)} paid, ${r1.filter((x) => x.status === 'fulfilled' && x.value?.skipped).length} saw an earlier refund, ${errs1.length} refused by PayPal (${[...new Set(errs1)].join(', ')}), ${Date.now() - t1} ms`);
console.log('  ids: ' + paid1.map((r) => r.id).join(' '));

// Door 2: the same twenty asks through Owed. One ledger, decide and reserve in one step.
const ledger = new Ledger();
const records = async () => ({ order: { id: B.orderId, sessionId: 'S', customerId: 'C', totalCents: FACTS.orderTotalCents, status: 'SHIPPED' }, captures: [await pp.getCapture(B.captureId, B.orderId)], tracking: { ...FACTS.tracking } });
const t2 = Date.now();
const r2 = await Promise.allSettled(Array.from({ length: N }, async (_, i) => {
  const rec = await records();
  const proposal = { requestId: `race-d2-${i}-${Date.now()}`, sessionId: 'S', orderId: B.orderId, claims: claimsFromAmount(FACTS.owedCents, rec, DEFAULT_RULES) };
  const d = ledger.decideAndReserve(proposal, rec, DEFAULT_RULES);
  const out = [];
  for (const [k, c] of d.claims.entries()) if (c.verdict === VERDICT.REFUND && c.payCents > 0) out.push(await pp.refund(B.captureId, c.payCents, `${proposal.requestId}:${k}`));
  return { decision: d.aggregate, refunds: out };
}));
const paid2 = r2.flatMap((x) => (x.status === 'fulfilled' ? x.value.refunds : []));
console.log(`Door 2: ${paid2.length} refund, $${(paid2.reduce((s, r) => s + r.amountCents, 0) / 100).toFixed(2)} paid, ${r2.filter((x) => x.status === 'fulfilled' && x.value.decision !== 'REFUNDED').length} sessions told it was already paid, ${Date.now() - t2} ms`);
console.log('  ids: ' + paid2.map((r) => r.id).join(' '));
const a = await pp.getCapture(A.captureId, A.orderId); const b = await pp.getCapture(B.captureId, B.orderId);
fs.writeFileSync(new URL('../data/race-live.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), label: 'Live PayPal sandbox', sessions: N, door1: { refunds: paid1.map((r) => r.id), paidCents: paid1.reduce((s, r) => s + r.amountCents, 0), refusedByPayPal: errs1.length, ms: Date.now() - t1 }, door2: { refunds: paid2.map((r) => r.id), paidCents: paid2.reduce((s, r) => s + r.amountCents, 0), toldAlreadyPaid: r2.filter((x) => x.status === 'fulfilled' && x.value.decision !== 'REFUNDED').length, ms: Date.now() - t2 }, owedCents: FACTS.owedCents, issueMsSamples: [], note: 'npm run race, two fresh $25 captures, twenty concurrent asks for the same $5 at each.' }, null, 1));
console.log(`PayPal read-back: Door 1 capture refunded $${(a.refundedCents / 100).toFixed(2)} of $25.00 (${a.refunds.length} refunds), Door 2 capture refunded $${(b.refundedCents / 100).toFixed(2)} of $25.00 (${b.refunds.length} refunds). Owed was $5.00. Live PayPal sandbox.`);
