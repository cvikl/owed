// The race no prompt can pass. Twenty sessions ask for the same $5 at once.
// Door 1 here is a perfect agent: it checks the record and asks for exactly $5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakePayPal } from '../src/fakePaypal.js';
import { Ledger } from '../src/ledger.js';
import { door1, door2 } from '../src/doors.js';
import { CLAIM, DEFAULT_RULES } from '../src/engine.js';

test('twenty at once: a perfect agent overpays, Owed pays once', async () => {
  const p1 = new FakePayPal(); p1.seedCapture('CAP1', 2500);
  const r1 = await Promise.allSettled(Array.from({ length: 20 }, () => door1(p1, 'CAP1', 500)));
  const door1Paid = p1.totalRefunded();

  const p2 = new FakePayPal(); p2.seedCapture('CAP2', 2500);
  const ledger = new Ledger();
  const load = async () => ({
    order: { id: 'O2', sessionId: 'S1', customerId: 'C1', totalCents: 2000, status: 'SHIPPED' },
    captures: [await p2.getCapture('CAP2')], tracking: { status: 'DELIVERED', daysSinceShipped: 3 },
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    door2(p2, ledger, { requestId: `R${i}`, sessionId: 'S1', orderId: 'O2', claims: [{ type: CLAIM.OVERCHARGE, amountCents: 500 }] }, load, DEFAULT_RULES)));
  const door2Paid = p2.totalRefunded();

  console.log(`  simulated: door 1 paid $${door1Paid / 100}, door 2 paid $${door2Paid / 100}, owed $5`);
  assert.ok(r1.length === 20);
  assert.ok(door1Paid > 500, 'door 1 should overpay under a race');
  assert.equal(door2Paid, 500);
});
