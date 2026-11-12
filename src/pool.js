// The order pool. Every player session gets two paid orders with the same facts and separate captures,
// one per door. Live mode hands out captures that scripts/seed.js created on the PayPal sandbox and
// wrote to data/pool.json. Simulated mode makes them up on the stand-in and says so.
import fs from 'node:fs';
import path from 'node:path';
import { FakePayPal } from './fakePaypal.js';
import { PayPalRest } from './paypalRest.js';

export const FACTS = { itemCents: 2000, shippingCents: 0, orderTotalCents: 2000, capturedCents: 2500, owedCents: 500, item: 'Mug', shop: 'Mugs and Co', tracking: { status: 'SHIPPED', daysSinceShipped: 0 } };
// The second order (12 Nov 2026): a chilled seafood box whose delivery the courier cancelled. PayPal's tracker cannot be
// created or changed as CANCELLED on the sandbox (checked 12 Nov 10:50), so the cancellation is the shop's own shipping
// record and the page says so. PayPal still holds the capture and makes the refund.
export const KINDS = {
  mug: FACTS,
  seafood: { itemCents: 6000, shippingCents: 0, orderTotalCents: 6000, capturedCents: 6000, owedCents: 6000, item: 'Chilled seafood box', shop: 'Fresh Catch Co', tracking: { status: 'CANCELLED', daysSinceShipped: 2, source: 'shop record' } },
};
export const factsFor = (kind) => KINDS[kind] ?? FACTS;
// PayPal's order tracker on the sandbox accepts SHIPPED on creation and refuses a status change through the v2 PATCH and the v1 shipping API (403 on this app, 11 Nov 2026). So the scenario is what PayPal really holds: shipped, nothing says lost.

export class Pool {
  constructor({ dataDir, live }) {
    this.dataDir = dataDir; this.live = live; this.file = path.join(dataDir, 'pool.json');
    this.paypal = live ? new PayPalRest() : new FakePayPal({ latencyMs: 40 });
    this.items = live ? this.#read() : [];
    this.counter = 0;
  }
  #read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; } }
  #write() { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.items, null, 1)); }
  get mode() { return this.live ? 'live' : 'simulated'; }
  /** Keep at least `min` free orders on the sandbox, seeding by card with no buyer click. Runs in the background on the live server. */
  async refill({ min = 20, batch = 10, kind = 'mug' } = {}) {
    if (!this.live || this.refilling) return 0;
    if (this.available(kind) >= min) return 0;
    const f = factsFor(kind);
    this.refilling = true; let made = 0;
    try {
      for (let i = 0; i < batch; i++) {
        const o = await this.paypal.createPaidOrder({ amountCents: f.capturedCents, description: `${f.shop}, ${f.item.toLowerCase()}`, requestId: `refill-${kind}-${Date.now()}-${i}` });
        const trackingNumber = `OWED${Date.now().toString(36).toUpperCase()}${i}`;
        let tracked = false;
        // The seafood order carries no PayPal tracker: its cancelled status is the shop's shipping record.
        if (kind === 'mug') { try { await this.paypal.addTracking(o.orderId, o.captureId, trackingNumber, 'OTHER'); tracked = true; } catch { } }
        this.items.push({ orderId: o.orderId, captureId: o.captureId, kind, capturedCents: o.amountCents, trackingNumber: tracked ? trackingNumber : null, createdAt: new Date().toISOString() });
        this.#write(); made++;
      }
    } catch (e) { console.error('refill failed:', e.message, e.debugId ?? ''); }
    finally { this.refilling = false; }
    return made;
  }
  available(kind = 'mug') { return this.live ? this.items.filter((o) => !o.sessionId && (o.kind ?? 'mug') === kind).length : Infinity; }
  /** Take one paid order for a session and a door. */
  take(sessionId, door, kind = 'mug') {
    const f = factsFor(kind);
    if (this.live) {
      const o = this.items.find((x) => !x.sessionId && (x.kind ?? 'mug') === kind);
      if (!o) throw Object.assign(new Error('The order pool is empty. Please try again in a few minutes.'), { code: 'POOL_EMPTY' });
      o.sessionId = sessionId; o.door = door; o.takenAt = new Date().toISOString(); this.#write();
      return { id: o.orderId, captureId: o.captureId, kind, sessionId, customerId: `C-${sessionId}`, totalCents: f.orderTotalCents, status: 'SHIPPED', buyer: o.buyer ?? null, trackingNumber: o.trackingNumber ?? null };
    }
    const n = ++this.counter;
    const captureId = `SIM-CAP-${n}`;
    this.paypal.seedCapture(captureId, f.capturedCents);
    return { id: `SIM-ORD-${n}`, captureId, kind, sessionId, customerId: `C-${sessionId}`, totalCents: f.orderTotalCents, status: 'SHIPPED', buyer: null, trackingNumber: null };
  }
  /** Records the engine decides on. PayPal's capture is read live; tracking comes from PayPal when the seed added it. */
  async records(order) {
    const capture = await this.paypal.getCapture(order.captureId, this.live ? order.id : undefined);
    let tracking = { ...factsFor(order.kind).tracking, source: 'shop record' };
    if (this.live && order.trackingNumber) {
      try { const t = await this.paypal.getTracking(order.id); if (t) tracking = { ...t, source: 'paypal' }; } catch { /* keep the shop record */ }
    }
    // An open PayPal dispute sends everything to a person. Only checked when CHECK_DISPUTES=1, once the call is confirmed on your sandbox app.
    let dispute = null;
    if (this.live && process.env.CHECK_DISPUTES === '1') { try { dispute = await this.paypal.getOpenDispute(order.captureId); } catch { dispute = { status: 'UNAVAILABLE' }; } } // a failed check never counts as "no dispute"
    return { order: { id: order.id, sessionId: order.sessionId, customerId: order.customerId, totalCents: order.totalCents, status: order.status }, captures: [capture], tracking, dispute };
  }
}
