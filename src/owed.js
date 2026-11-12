// Owed, the gateway at Door 2. The agent's create_refund call (PayPal's toolkit shape: capture, optional
// amount, currency) arrives here as a proposal. Code turns the asked amount into claims by what the records
// prove, the engine decides in integer cents, the ledger reserves, and only then does code call PayPal.
import { claimsFromAmount, provable, VERDICT, DEFAULT_RULES } from './engine.js';

/**
 * The whole Door 2 path for one proposal. Returns what the agent is told, plus the full trace for the board.
 * paypal: { getCapture, refund }. loadRecords() -> records. ledger: Ledger.
 */
export async function gate({ session, order, askedCents, paypal, ledger, loadRecords, rules = DEFAULT_RULES, onRefund }) {
  const t0 = Date.now();
  const records = await loadRecords();
  const claims = claimsFromAmount(askedCents, records, rules);
  if (claims.length === 0) return { ok: false, error: 'INVALID_AMOUNT', records, claims, ms: Date.now() - t0 };
  const requestId = `${session.id}:${order.id}:${session.turn}:${Date.now().toString(36)}`;
  const proposal = { requestId, sessionId: session.id, orderId: order.id, claims };
  const decision = ledger.decideAndReserve(proposal, records, rules);
  const refunds = [];
  try {
    for (const [i, c] of decision.claims.entries()) {
      if (c.verdict !== VERDICT.REFUND || c.payCents <= 0) continue;
      const capture = c.type === 'DUPLICATE_CHARGE' ? records.captures[1] : records.captures[0];
      const r = await paypal.refund(capture.id, c.payCents, `${requestId}:${i}`);
      refunds.push({ ...r, type: c.type });
      onRefund?.({ ...r, type: c.type }, Date.now() - t0); // the page shows the money the moment PayPal confirms it
    }
  } catch (e) {
    ledger.release(proposal, decision, records);
    return { ok: false, error: e.code ?? String(e.message), decision, claims, records, ms: Date.now() - t0 };
  }
  const paid = refunds.reduce((s, r) => s + r.amountCents, 0);
  const review = decision.claims.filter((c) => c.verdict === VERDICT.REVIEW);
  const blocked = decision.claims.filter((c) => c.verdict === VERDICT.BLOCK);
  // What the agent is told. It writes the reply from this; it cannot change the amount.
  const toolResult = {
    status: decision.aggregate,
    refunded: paid / 100,
    refund_ids: refunds.map((r) => r.id),
    already_refunded_on_this_order: Math.max(0, records.captures.reduce((s, c) => s + (c.refundedCents ?? 0), 0)) / 100,
    sent_to_a_person: review.reduce((s, c) => s + c.amountCents, 0) / 100,
    reasons: decision.claims.map((c) => `${c.type}: ${c.verdict}. ${c.reason}`),
    note: 'Owed decided this from PayPal\'s records and the shop\'s order record. Tell the customer exactly what was refunded and what a person will review.',
  };
  return { ok: true, toolResult, decision, claims, records, refunds, paidCents: paid, review, blocked, ms: Date.now() - t0 };
}

/**
 * The record settles. When the agent ends its turn without proposing a refund, Owed asks the model only
 * what the customer claimed (no money tool), and if they asked for money the engine pays what the record
 * proves. The promise is what you are owed, not what the agent could be talked into or out of.
 * labelClaims(customerText) -> validated claims (see claims.js); the caller supplies the model call.
 */
export async function settleFromRecord({ session, order, customerText, labelClaims, paypal, ledger, loadRecords, rules = DEFAULT_RULES, onRefund }) {
  const claims = await labelClaims(customerText);
  if (!claims.length) return { ok: false, skipped: true, reason: 'no claim for money', claims };
  const askedCents = claims.reduce((s, c) => s + c.amountCents, 0);
  const r = await gate({ session, order, askedCents, paypal, ledger, loadRecords, rules, onRefund });
  return { ...r, fromRecord: true, labelled: claims };
}
