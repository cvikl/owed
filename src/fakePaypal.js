// A stand-in for PayPal with the same rule that matters here: a capture cannot be
// refunded for more than was captured. Replace with the real client. Results from
// this file are simulated and must be labelled as simulated.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class FakePayPal {
  constructor({ latencyMs = 5 } = {}) { this.captures = new Map(); this.refunds = []; this.byRequest = new Map(); this.latencyMs = latencyMs; }
  seedCapture(id, amountCents) { this.captures.set(id, { id, amountCents, refundedCents: 0 }); }
  async getCapture(id) { await wait(this.latencyMs); return { ...this.captures.get(id) }; }
  async refund(captureId, amountCents, requestId) {
    await wait(this.latencyMs);
    if (requestId && this.byRequest.has(requestId)) return this.byRequest.get(requestId); // idempotent
    const c = this.captures.get(captureId);
    if (c && amountCents == null) amountCents = c.amountCents - c.refundedCents; // no amount means refund everything, as PayPal does
    if (!c || !(amountCents > 0) || c.refundedCents + amountCents > c.amountCents) { const e = new Error('REFUND_AMOUNT_EXCEEDED'); e.code = 'REFUND_AMOUNT_EXCEEDED'; throw e; }
    c.refundedCents += amountCents;
    const r = { id: `SIM-${this.refunds.length + 1}`, captureId, amountCents, status: 'COMPLETED' };
    this.refunds.push(r); if (requestId) this.byRequest.set(requestId, r);
    return r;
  }
  totalRefunded() { return this.refunds.reduce((s, r) => s + r.amountCents, 0); }
}
