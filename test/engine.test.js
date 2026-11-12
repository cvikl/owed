import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, provable, claimsFromAmount, DEFAULT_RULES, CLAIM } from '../src/engine.js';
import { Ledger } from '../src/ledger.js';

const mug = (over = {}) => ({
  order: { id: 'O1', sessionId: 'S1', customerId: 'C1', totalCents: 2000, status: 'SHIPPED' },
  captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 0 }],
  tracking: { status: 'DELIVERED', daysSinceShipped: 3 },
  ...over,
});
const ask = (claims, extra = {}) => ({ requestId: 'R1', sessionId: 'S1', orderId: 'O1', claims, ...extra });

test('honest overcharge is refunded exactly', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug());
  assert.equal(d.payCents, 500); assert.equal(d.aggregate, 'REFUNDED');
});

test('the demo message: $5 refunded, $20 goes to a person', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }, { type: CLAIM.NOT_RECEIVED, amountCents: 2000 }]), mug());
  assert.equal(d.payCents, 500); assert.equal(d.aggregate, 'PARTLY_REFUNDED');
  assert.equal(d.claims[1].verdict, 'REVIEW'); assert.match(d.claims[1].reason, /delivered/);
});

test('claiming the whole $25 as an overcharge still pays only $5', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 2500 }]), mug());
  assert.equal(d.payCents, 500);
});

test('someone else\'s order is blocked', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }], { sessionId: 'S2' }), mug());
  assert.equal(d.aggregate, 'BLOCKED'); assert.equal(d.trace.at(-1).rule, 1);
});

test('more than was captured, or a bad amount, is blocked', () => {
  assert.equal(decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 20000 }]), mug()).aggregate, 'BLOCKED');
  assert.equal(decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 4.5 }]), mug()).aggregate, 'BLOCKED');
  assert.equal(decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: -500 }]), mug()).aggregate, 'BLOCKED');
});

test('duplicate charge is refunded in full', () => {
  const r = mug({ captures: [{ id: 'CAP1', amountCents: 2000, refundedCents: 0 }, { id: 'CAP2', amountCents: 2000, refundedCents: 0 }] });
  assert.equal(provable(r).DUPLICATE_CHARGE, 2000);
  assert.equal(decide(ask([{ type: CLAIM.DUPLICATE_CHARGE, amountCents: 2000 }]), r).payCents, 2000);
});

test('cancelled before shipping is refunded, cancelled after shipping is not', () => {
  const cancelled = mug({ order: { ...mug().order, status: 'CANCELLED_BEFORE_SHIP' }, tracking: null, captures: [{ id: 'CAP1', amountCents: 2000, refundedCents: 0 }] });
  assert.equal(decide(ask([{ type: CLAIM.CANCELLED, amountCents: 2000 }]), cancelled).payCents, 2000);
  assert.equal(decide(ask([{ type: CLAIM.CANCELLED, amountCents: 2000 }]), mug()).payCents, 0);
});

test('not received is paid when PayPal tracking says lost or overdue, reviewed when in transit', () => {
  const lost = mug({ tracking: { status: 'LOST', daysSinceShipped: 9 } });
  const overdue = mug({ tracking: { status: 'IN_TRANSIT', daysSinceShipped: 30 } });
  const moving = mug({ tracking: { status: 'IN_TRANSIT', daysSinceShipped: 2 } });
  const c = [{ type: CLAIM.NOT_RECEIVED, amountCents: 2000 }];
  assert.equal(decide(ask(c), lost).payCents, 2000);
  assert.equal(decide(ask(c), overdue).claims[0].verdict, 'REVIEW');   // late is not lost, by default
  assert.equal(decide(ask(c), overdue, { ...DEFAULT_RULES, payOverdueShipments: true }).payCents, 2000);
  assert.equal(decide(ask(c), moving).claims[0].verdict, 'REVIEW');
});

test('the same claim twice in one message is paid once', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }, { type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug());
  assert.equal(d.payCents, 500); assert.equal(d.claims[1].verdict, 'BLOCK');
});

test('damaged or changed mind goes to a person', () => {
  const d = decide(ask([{ type: CLAIM.OTHER, amountCents: 2000 }]), mug());
  assert.equal(d.aggregate, 'REVIEW'); assert.equal(d.claims[0].rule, 8);
});

test('limits and the daily cap send the claim to a person', () => {
  const big = mug({ order: { ...mug().order, totalCents: 1000 }, captures: [{ id: 'CAP1', amountCents: 9000, refundedCents: 0 }] });
  assert.equal(decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 8000 }]), big).claims[0].rule, 6);
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug(), DEFAULT_RULES, { customerDayCents: 4800, customerDayCount: 1 });
  assert.equal(d.claims[0].rule, 7); assert.equal(d.payCents, 0);
});

test('asking twice pays once, and the same request id pays nothing new', () => {
  const ledger = new Ledger();
  const first = ledger.decideAndReserve(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug(), DEFAULT_RULES, '2026-11-11');
  const again = ledger.decideAndReserve(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }], { requestId: 'R2' }), mug(), DEFAULT_RULES, '2026-11-11');
  const replay = ledger.decideAndReserve(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug(), DEFAULT_RULES, '2026-11-11');
  assert.equal(first.payCents, 500); assert.equal(again.payCents, 0); assert.equal(again.claims[0].rule, 5);
  assert.equal(replay.payCents, 0); assert.equal(replay.replay, true);
});

test('never pays more than the records show, whatever is asked', () => {
  const types = Object.values(CLAIM); let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 0; i < 2000; i++) {
    const r = mug({ tracking: { status: ['DELIVERED', 'IN_TRANSIT', 'LOST', null][rnd(4)], daysSinceShipped: rnd(40) } });
    const claims = Array.from({ length: 1 + rnd(3) }, () => ({ type: types[rnd(types.length)], amountCents: 1 + rnd(2500) }));
    const d = decide(ask(claims), r);
    const p = provable(r); const most = p.OVERCHARGE + p.DUPLICATE_CHARGE + p.CANCELLED + p.NOT_RECEIVED;
    assert.ok(d.payCents <= most, `paid ${d.payCents} but records show ${most}`);
    assert.ok(d.payCents <= 2500);
  }
});

test('PayPal tracking statuses: a cancelled shipment is paid, and age alone is not proof unless the shop switches that on', () => {
  const c = [{ type: CLAIM.NOT_RECEIVED, amountCents: 2000 }];
  assert.equal(decide(ask(c), mug({ tracking: { status: 'CANCELLED', daysSinceShipped: 5 } })).payCents, 2000);
  assert.equal(decide(ask(c), mug({ tracking: { status: 'SHIPPED', daysSinceShipped: 30 } })).payCents, 0);
  assert.equal(decide(ask(c), mug({ tracking: { status: 'SHIPPED', daysSinceShipped: 30 } }), { ...DEFAULT_RULES, payOverdueShipments: true }).payCents, 2000);
  assert.equal(decide(ask(c), mug({ tracking: { status: 'SHIPPED', daysSinceShipped: 3 } })).payCents, 0);
});

test('an open PayPal dispute sends everything to a person, so nobody is paid twice', () => {
  const d = decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug({ dispute: { status: 'OPEN' } }));
  assert.equal(d.payCents, 0); assert.equal(d.aggregate, 'REVIEW');
  assert.equal(decide(ask([{ type: CLAIM.OVERCHARGE, amountCents: 500 }]), mug({ dispute: { status: 'RESOLVED' } })).payCents, 500);
});

test('the toolkit call has only an amount: the record decides what is paid', () => {
  const pay = (asked, r = mug()) => decide(ask(claimsFromAmount(asked, r)), r).payCents;
  assert.equal(pay(500), 500);     // honest
  assert.equal(pay(2500), 500);    // asked for everything
  assert.equal(pay(null), 500);    // amount left out, which PayPal treats as a full refund
  assert.equal(pay(100), 100);     // asked for less than owed
  assert.equal(pay(0), 0); assert.equal(pay(-5), 0); assert.equal(pay(12.5), 0);
  const nothingOwed = mug({ captures: [{ id: 'CAP1', amountCents: 2000, refundedCents: 0 }] });
  assert.equal(pay(2000, nothingOwed), 0);
});

test('an old order in the pool cannot turn "refund everything" into $25', () => {
  const stale = mug({ tracking: { status: 'SHIPPED', daysSinceShipped: 40 } });
  assert.equal(decide(ask(claimsFromAmount(2500, stale)), stale).payCents, 500);
});

test('after a lost ledger, a refund already visible in PayPal is not paid again', () => {
  const after = mug({ captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 500 }] });
  const d = new Ledger().decideAndReserve(ask(claimsFromAmount(500, after), { requestId: 'after-restart' }), after, DEFAULT_RULES, '2026-11-12');
  assert.equal(d.payCents, 0); assert.equal(d.claims[0].rule, 5);
  const partly = mug({ captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 200 }] });
  assert.equal(decide(ask(claimsFromAmount(500, partly)), partly).payCents, 300);
});

test('a dispute check that failed sends everything to a person', () => {
  const records = { order: { id: 'O1', sessionId: 'S', customerId: 'C', totalCents: 2000, status: 'SHIPPED' }, captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 0 }], tracking: { status: 'SHIPPED', daysSinceShipped: 2 }, dispute: { status: 'UNAVAILABLE' } };
  const d = decide({ requestId: 'r1', sessionId: 'S', orderId: 'O1', claims: [{ type: 'OVERCHARGE', amountCents: 500 }] }, records, { paidByReason: {}, paidTodayCents: 0, refundsLastHour: 0 }, DEFAULT_RULES);
  assert.equal(d.payCents, 0); assert.equal(d.aggregate, 'REVIEW'); assert.match(d.trace.at(-1).reason, /could not be checked/);
});

test('an old order still gets a proven overcharge back; age alone only stops a "not received" claim', () => {
  const records = { order: { id: 'O1', sessionId: 'S', customerId: 'C', totalCents: 2000, status: 'SHIPPED' }, captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 0 }], tracking: { status: 'SHIPPED', daysSinceShipped: 90 }, dispute: null };
  const st = { paidByReason: {}, paidTodayCents: 0, refundsLastHour: 0 };
  const over = decide({ requestId: 'r1', sessionId: 'S', orderId: 'O1', claims: [{ type: 'OVERCHARGE', amountCents: 500 }] }, records, st, DEFAULT_RULES);
  assert.equal(over.payCents, 500);
  const lost = decide({ requestId: 'r2', sessionId: 'S', orderId: 'O1', claims: [{ type: 'NOT_RECEIVED', amountCents: 2000 }] }, records, st, DEFAULT_RULES);
  assert.equal(lost.payCents, 0); assert.equal(lost.aggregate, 'REVIEW');
});
test('dispute lookup: open goes to a person, confirmed none continues, unknown goes to a person', () => {
  const base = { order: { id: 'O1', sessionId: 'S', customerId: 'C', totalCents: 2000, status: 'SHIPPED' }, captures: [{ id: 'CAP1', amountCents: 2500, refundedCents: 0 }], tracking: { status: 'SHIPPED', daysSinceShipped: 2 } };
  const ask = { requestId: 'r1', sessionId: 'S', orderId: 'O1', claims: [{ type: 'OVERCHARGE', amountCents: 500 }] }; const st = () => ({ paidByReason: {}, paidTodayCents: 0, refundsLastHour: 0 });
  assert.equal(decide(ask, { ...base, dispute: { status: 'OPEN' } }, st(), DEFAULT_RULES).aggregate, 'REVIEW');
  assert.equal(decide(ask, { ...base, dispute: null }, st(), DEFAULT_RULES).payCents, 500);
  assert.equal(decide(ask, { ...base, dispute: { status: 'UNAVAILABLE' } }, st(), DEFAULT_RULES).payCents, 0);
});
