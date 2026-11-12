// A small PayPal REST client for the sandbox, with the same shape as fakePaypal.js.
// Run against the PayPal sandbox on 11 Nov 2026 (npm run seed -- --test, npm run race).
// What PayPal actually does, where it differed from the reference, is noted beside each call.
const BASE = process.env.PAYPAL_BASE ?? 'https://api-m.sandbox.paypal.com';
// Sandbox only. Live PayPal moves real money and is never allowed from this code.
if (!/^https:\/\/api(-m)?\.sandbox\.paypal\.com$/.test(BASE)) throw new Error(`Refusing non-sandbox PayPal base URL: ${BASE}`);
const toValue = (cents) => (cents / 100).toFixed(2);
const toCents = (value) => Math.round(Number(value) * 100);

export class PayPalRest {
  constructor({ clientId = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET, currency = 'USD' } = {}) {
    this.clientId = clientId; this.secret = secret; this.currency = currency; this.token = null; this.expires = 0;
  }
  async #auth() {
    if (this.token && Date.now() < this.expires - 60_000) return this.token;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal auth ${res.status}`);
    const j = await res.json(); this.token = j.access_token; this.expires = Date.now() + j.expires_in * 1000; return this.token;
  }
  async #call(method, path, body, headers = {}) {
    const res = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${await this.#auth()}`, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const j = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j?.details?.[0]?.issue ?? j?.name ?? `PayPal ${res.status}`); e.code = j?.details?.[0]?.issue ?? j?.name; e.debugId = j?.debug_id; e.details = j?.details; e.status = res.status; throw e; }
    return j;
  }
  /**
   * What was captured and what has been refunded so far, in cents. The capture object alone does not
   * carry the refunded total (confirmed on the sandbox, 11 Nov 2026), so when the order id is known the
   * refunds are summed from the order's payments list, which is current.
   */
  async getCapture(id, orderId) {
    if (orderId) {
      const o = await this.getOrder(orderId);
      const pu = o.purchase_units?.[0]?.payments ?? {};
      const c = (pu.captures ?? []).find((x) => x.id === id) ?? pu.captures?.[0];
      if (!c) throw Object.assign(new Error('capture not on order'), { code: 'NO_CAPTURE' });
      const refunded = (pu.refunds ?? []).reduce((s, r) => s + (r.status === 'COMPLETED' || r.status === 'PENDING' ? toCents(r.amount.value) : 0), 0);
      return { id: c.id, amountCents: toCents(c.amount.value), refundedCents: refunded, status: c.status, refunds: (pu.refunds ?? []).map((r) => ({ id: r.id, amountCents: toCents(r.amount.value), status: r.status, createTime: r.create_time })) };
    }
    const c = await this.#call('GET', `/v2/payments/captures/${id}`);
    return { id: c.id, amountCents: toCents(c.amount.value), refundedCents: c.status === 'REFUNDED' ? toCents(c.amount.value) : 0, status: c.status };
  }
  /** Set a tracker's status (SHIPPED, DELIVERED, CANCELLED, ...). Kill test 4 showed the create call ignores status. */
  async setTrackingStatus(orderId, trackerId, status) {
    return this.#call('PATCH', `/v2/checkout/orders/${orderId}/trackers/${trackerId}`, [{ op: 'replace', path: '/status', value: status }]);
  }
  /** Refund part or all of a capture. With amountCents null PayPal refunds whatever is left, as the toolkit's call does. requestId makes a retry safe. */
  async refund(captureId, amountCents, requestId, note) {
    // note_to_payer puts Owed's reason inside PayPal's own refund record (max 255 chars); REFUND_NOTE=0 switches it off.
    const body = amountCents == null ? {} : { amount: { value: toValue(amountCents), currency_code: this.currency } };
    if (note && process.env.REFUND_NOTE !== '0') body.note_to_payer = String(note).slice(0, 255);
    const r = await this.#call('POST', `/v2/payments/captures/${captureId}/refund`, body,
      requestId ? { 'PayPal-Request-Id': requestId } : {});
    // PayPal caps a refund at what is left on the capture (sandbox, 11 Nov 2026: asked 2500 after 500, got 2000). Report what PayPal did.
    // A full refund (no amount in the request) comes back without an amount on the sandbox, so it is read back by id;
    // otherwise the board recorded $0 for a $25 refund (live, 12 Nov 2026 13:42).
    let cents = r.amount?.value ? toCents(r.amount.value) : amountCents;
    if (cents == null) { try { cents = (await this.getRefund(r.id)).amountCents; } catch { cents = null; } }
    return { id: r.id, captureId, amountCents: cents, askedCents: amountCents, status: r.status };
  }
  /** One refund as PayPal holds it, for the receipt panel. */
  async getRefund(id) {
    const r = await this.#call('GET', `/v2/payments/refunds/${id}`);
    return { id: r.id, status: r.status, amountCents: toCents(r.amount.value), currency: r.amount.currency_code, createTime: r.create_time, updateTime: r.update_time, raw: r };
  }
  /** Tracking status for an order, mapped to the engine's vocabulary, or null when PayPal holds none. */
  async getTracking(orderId) {
    const o = await this.getOrder(orderId);
    const tr = o.purchase_units?.flatMap((u) => u.shipping?.trackers ?? [])?.[0];
    if (!tr) return null;
    // The engine speaks PayPal's own tracker statuses (SHIPPED, ON_HOLD, DELIVERED, CANCELLED, LOCAL_PICKUP).
    return { status: tr.status, raw: tr.status, trackerId: tr.id, trackingNumber: tr.tracking_number ?? tr.id?.split('-').slice(1).join('-'), carrier: tr.carrier, daysSinceShipped: tr.shipment_date ? Math.floor((Date.now() - Date.parse(tr.shipment_date)) / 86400000) : 0 };
  }
  /** The order, including any shipment trackers PayPal holds for it. */
  async getOrder(orderId) { return this.#call('GET', `/v2/checkout/orders/${orderId}`); }
  /** Add tracking to an order. Kill test 4 checks what status comes back. */
  async addTracking(orderId, captureId, trackingNumber, carrier = 'OTHER', status) {
    return this.#call('POST', `/v2/checkout/orders/${orderId}/track`, { capture_id: captureId, tracking_number: trackingNumber, carrier, notify_payer: false, ...(status ? { status } : {}) });
  }
  /** Create and capture an order without a buyer click, using a sandbox test card as the payment source. Kill test 2. */
  async createPaidOrder({ amountCents, description = 'Mug', card = { number: '4111111111111111', expiry: '2030-12', name: 'Sandbox Buyer' }, requestId }) {
    const order = await this.#call('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ description, amount: { currency_code: this.currency, value: toValue(amountCents) } }],
      payment_source: { card: { number: card.number, expiry: card.expiry, name: card.name } },
    }, requestId ? { 'PayPal-Request-Id': requestId } : {});
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    if (!cap) throw Object.assign(new Error(`Order ${order.id} not captured: ${order.status}`), { code: 'NOT_CAPTURED', order });
    return { orderId: order.id, captureId: cap.id, status: cap.status, amountCents: toCents(cap.amount.value) };
  }
  /**
   * An open PayPal dispute on a capture, or null. Same call the Agent Toolkit's list_disputes makes.
   * NOT YET RUN on the sandbox: the app needs the disputes permission. Check once with
   *   node -e "import('./src/paypalRest.js').then(async m=>console.log(await new m.PayPalRest().getOpenDispute('<capture id>')))"
   */
  async getOpenDispute(captureId) {
    const j = await this.#call('GET', `/v1/customer/disputes?disputed_transaction_id=${encodeURIComponent(captureId)}`);
    if (!Array.isArray(j?.items)) throw new Error('unexpected disputes response'); // unknown is never treated as "no dispute"
    const d = j.items.find((x) => x.status && x.status !== 'RESOLVED');
    return d ? { id: d.dispute_id, status: d.status === 'RESOLVED' ? 'RESOLVED' : 'OPEN', raw: d.status } : null;
  }
  /** Generic calls for diagnostics and scripts. */
  async get(path) { return this.#call('GET', path); }
  async call(method, path, body, headers) { return this.#call(method, path, body, headers); }
}
