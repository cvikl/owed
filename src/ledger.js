// The ledger makes decide-and-reserve one atomic step.
// In Node this function is synchronous, so no other request can run between the
// read and the write. In Postgres do the same inside one transaction:
//   BEGIN; SELECT ... FROM orders WHERE id = $1 FOR UPDATE; (decide) INSERT reservation; COMMIT;
import { decide, VERDICT } from './engine.js';

export class Ledger {
  constructor() { this.orders = new Map(); this.days = new Map(); this.requests = new Map(); }

  #order(id) { if (!this.orders.has(id)) this.orders.set(id, { orderCents: 0, byReason: {} }); return this.orders.get(id); }
  #day(customerId, day) { const k = `${customerId}|${day}`; if (!this.days.has(k)) this.days.set(k, { cents: 0, count: 0 }); return this.days.get(k); }

  /** Decide and reserve in one synchronous step. Same requestId returns the first decision and pays nothing new. */
  decideAndReserve(proposal, records, rules, day = new Date().toISOString().slice(0, 10)) {
    if (this.requests.has(proposal.requestId)) return { ...this.requests.get(proposal.requestId), replay: true, payCents: 0 };
    const o = this.#order(proposal.orderId);
    const d = this.#day(records?.order?.customerId ?? proposal.sessionId, day);
    const decision = decide(proposal, records, rules, { orderCents: o.orderCents, byReason: o.byReason, customerDayCents: d.cents, customerDayCount: d.count });
    for (const c of decision.claims) if (c.verdict === VERDICT.REFUND) {
      o.orderCents += c.payCents; o.byReason[c.type] = (o.byReason[c.type] ?? 0) + c.payCents;
      d.cents += c.payCents; d.count += 1;
    }
    this.requests.set(proposal.requestId, decision);
    return decision;
  }

  /** Give a reservation back if PayPal refused the refund. */
  release(proposal, decision, records, day = new Date().toISOString().slice(0, 10)) {
    const o = this.#order(proposal.orderId);
    const d = this.#day(records?.order?.customerId ?? proposal.sessionId, day);
    for (const c of decision.claims) if (c.verdict === VERDICT.REFUND) {
      o.orderCents -= c.payCents; o.byReason[c.type] -= c.payCents; d.cents -= c.payCents; d.count -= 1;
    }
    this.requests.delete(proposal.requestId);
  }
}
