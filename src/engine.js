// Owed refund engine. Pure functions over integer cents. No network, no model.
// The model proposes claims. This file decides what is refunded, what goes to a
// person and what is blocked, using only PayPal's records and the shop's order record.

export const VERDICT = { REFUND: 'REFUND', REVIEW: 'REVIEW', BLOCK: 'BLOCK' };
export const CLAIM = {
  OVERCHARGE: 'OVERCHARGE',           // PayPal captured more than the order total
  DUPLICATE_CHARGE: 'DUPLICATE_CHARGE', // the same order was captured twice
  CANCELLED: 'CANCELLED',             // order cancelled before it shipped
  NOT_RECEIVED: 'NOT_RECEIVED',       // customer says it never arrived
  OTHER: 'OTHER',                     // damaged, changed mind, anything else
};

export const DEFAULT_RULES = {
  version: 1,
  maxPerRefundCents: 5000,
  maxPerCustomerDayCents: 5000,
  maxRefundsPerCustomerDay: 3,
  notDeliveredAfterDays: 14,
};

const isCents = (n) => Number.isInteger(n) && n > 0;
const OPEN_DISPUTE = ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW'];

/**
 * PayPal's Agent Toolkit refund tool takes a capture and an optional amount, and
 * no reason. If the amount is left out it refunds everything. This turns that call
 * into claims the engine can check: what the records prove, by reason, and the rest
 * as OTHER. The amount paid therefore comes from the record and never from the ask.
 */
export function claimsFromAmount(askedCents, records, rules = DEFAULT_RULES) {
  const captured = (records?.captures ?? []).reduce((s, c) => s + c.amountCents, 0);
  let left = askedCents == null ? captured : askedCents;
  if (!isCents(left)) return [];
  const owed = provable(records, rules);
  const claims = [];
  for (const type of Object.keys(owed)) {
    const amountCents = Math.min(owed[type], left);
    if (amountCents > 0) { claims.push({ type, amountCents }); left -= amountCents; }
  }
  if (left > 0) claims.push({ type: CLAIM.OTHER, amountCents: left });
  return claims;
}

/**
 * What the records prove is owed, by reason, before anything already refunded.
 * records = {
 *   order:    { id, sessionId, customerId, totalCents, status: 'PLACED'|'SHIPPED'|'CANCELLED_BEFORE_SHIP' },
 *   captures: [{ id, amountCents, refundedCents }],   // from PayPal
 *   tracking: { status, daysSinceShipped }  // from PayPal. PayPal's own statuses are
 *             SHIPPED, ON_HOLD, DELIVERED, CANCELLED and LOCAL_PICKUP
 *   dispute:  { status } | null             // from PayPal, if a dispute exists on this payment
 * }
 */
export function provable(records, rules = DEFAULT_RULES) {
  const { order, captures, tracking } = records;
  const [first, ...extra] = captures;
  const out = { OVERCHARGE: 0, DUPLICATE_CHARGE: 0, CANCELLED: 0, NOT_RECEIVED: 0 };
  if (!first) return out;
  out.OVERCHARGE = Math.max(0, first.amountCents - order.totalCents);
  out.DUPLICATE_CHARGE = extra.reduce((s, c) => s + c.amountCents, 0);
  const goods = Math.min(first.amountCents, order.totalCents);
  if (order.status === 'CANCELLED_BEFORE_SHIP' && !tracking?.status) out.CANCELLED = goods;
  // A cancelled shipment never arrived. A shipment still on its way past the shop's limit is treated the same.
  const lost = ['CANCELLED', 'LOST', 'RETURNED_TO_SENDER'].includes(tracking?.status);
  const overdue = ['SHIPPED', 'ON_HOLD', 'IN_TRANSIT'].includes(tracking?.status) && (tracking.daysSinceShipped ?? 0) > rules.notDeliveredAfterDays;
  if (order.status !== 'CANCELLED_BEFORE_SHIP' && (lost || overdue)) out.NOT_RECEIVED = goods;
  return out;
}

/**
 * Decide one proposal. `paid` is what the ledger says has already been refunded
 * or reserved for this order, by reason, and for this customer today.
 * Returns a decision with one entry per claim. Nothing is paid here.
 */
export function decide(proposal, records, rules = DEFAULT_RULES, paid = {}) {
  const trace = [];
  const claims = [];
  const block = (rule, reason) => ({
    rulesVersion: rules.version, requestId: proposal.requestId, trace: [...trace, { rule, result: 'BLOCK', reason }],
    claims: (proposal.claims ?? []).map((c) => ({ ...c, verdict: VERDICT.BLOCK, payCents: 0, rule, reason })),
    payCents: 0, aggregate: 'BLOCKED',
  });

  // 1 Identity
  if (!records?.order || records.order.id !== proposal.orderId || records.order.sessionId !== proposal.sessionId) {
    return block(1, 'Order does not exist or is not bound to this session');
  }
  trace.push({ rule: 1, result: 'PASS' });

  // An open PayPal dispute on the same payment. Refunding now could pay the customer twice.
  if (OPEN_DISPUTE.includes(records.dispute?.status)) {
    const reason = 'A PayPal dispute is open on this payment. A person decides';
    return {
      rulesVersion: rules.version, requestId: proposal.requestId, trace: [...trace, { rule: 5, result: 'REVIEW', reason }],
      claims: (proposal.claims ?? []).map((c) => ({ ...c, verdict: VERDICT.REVIEW, payCents: 0, rule: 5, reason })),
      payCents: 0, aggregate: 'REVIEW',
    };
  }

  // 2 Amount
  if (!Array.isArray(proposal.claims) || proposal.claims.length === 0 || !proposal.claims.every((c) => isCents(c.amountCents))) {
    return block(2, 'Every claim needs a whole number of cents above zero');
  }
  const captured = records.captures.reduce((s, c) => s + c.amountCents, 0);
  const refundedAtPayPal = records.captures.reduce((s, c) => s + (c.refundedCents ?? 0), 0);
  const paidForOrder = Math.max(refundedAtPayPal, paid.orderCents ?? 0);
  const remaining = captured - paidForOrder;
  const asked = proposal.claims.reduce((s, c) => s + c.amountCents, 0);
  if (asked > captured) return block(2, 'Asked for more than PayPal captured');
  trace.push({ rule: 2, result: 'PASS' });

  const owed = provable(records, rules);
  const paidByReason = { ...(paid.byReason ?? {}) }; // running total, so two claims of one kind in one message cannot both be paid
  let pay = 0;
  let dayCents = paid.customerDayCents ?? 0;
  let dayCount = paid.customerDayCount ?? 0;

  for (const c of proposal.claims) {
    const add = (verdict, payCents, rule, reason) => claims.push({ ...c, verdict, payCents, rule, reason });

    // 8 Everything else
    if (!(c.type in owed)) { add(VERDICT.REVIEW, 0, 8, 'The records cannot settle this. A person decides'); continue; }

    // 3 Owed by the record, and 4 Claim against the record
    const rule = c.type === CLAIM.NOT_RECEIVED ? 4 : 3;
    const stillOwed = Math.max(0, owed[c.type] - (paidByReason[c.type] ?? 0));
    if (stillOwed === 0) {
      const why = c.type === CLAIM.NOT_RECEIVED && records.tracking?.status === 'DELIVERED'
        ? 'PayPal tracking says delivered'
        : (paidByReason[c.type] ?? 0) > 0 ? 'Already refunded' : 'The records do not show this';
      // 5 Duplicates: a second ask for money already paid is blocked, not reviewed
      if ((paidByReason[c.type] ?? 0) > 0) add(VERDICT.BLOCK, 0, 5, why); else add(VERDICT.REVIEW, 0, rule, why);
      continue;
    }
    const amount = Math.min(c.amountCents, stillOwed, remaining - pay);
    if (amount <= 0) { add(VERDICT.BLOCK, 0, 2, 'Nothing left on the capture'); continue; }

    // 6 Limits
    if (amount > rules.maxPerRefundCents) { add(VERDICT.REVIEW, 0, 6, 'Above the limit for one refund'); continue; }
    // 7 Velocity and daily cap
    if (dayCount + 1 > rules.maxRefundsPerCustomerDay || dayCents + amount > rules.maxPerCustomerDayCents) {
      add(VERDICT.REVIEW, 0, 7, 'Over the daily cap for this customer'); continue;
    }
    pay += amount; dayCents += amount; dayCount += 1;
    paidByReason[c.type] = (paidByReason[c.type] ?? 0) + amount;
    add(VERDICT.REFUND, amount, rule, c.amountCents > amount ? 'Refunded what the records show. The rest is not owed' : 'Owed by the record');
  }
  for (const r of [3, 4, 5, 6, 7, 8]) trace.push({ rule: r, result: claims.some((c) => c.rule === r) ? claims.filter((c) => c.rule === r).map((c) => c.verdict).join(',') : 'PASS' });

  const any = (v) => claims.some((c) => c.verdict === v);
  const aggregate = pay > 0 && (any(VERDICT.REVIEW) || any(VERDICT.BLOCK)) ? 'PARTLY_REFUNDED'
    : pay > 0 ? 'REFUNDED' : any(VERDICT.REVIEW) ? 'REVIEW' : 'BLOCKED';
  return { rulesVersion: rules.version, requestId: proposal.requestId, trace, claims, payCents: pay, aggregate };
}
