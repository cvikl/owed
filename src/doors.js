// The two doors, given the same proposal. Door 1 pays what the agent decided.
// Door 2 sends the same call through the engine and the ledger first.
import { VERDICT } from './engine.js';

/** Door 1. The agent checked the record itself, then called the refund tool. */
export async function door1(paypal, captureId, agentDecidedCents) {
  const capture = await paypal.getCapture(captureId);        // the agent looks first
  if (capture.refundedCents > 0) return { paidCents: 0, note: 'agent saw an earlier refund' };
  const r = await paypal.refund(captureId, agentDecidedCents); // then pays
  return { paidCents: r.amountCents, refundId: r.id };
}

/** Door 2. Same call, routed to Owed. */
export async function door2(paypal, ledger, proposal, loadRecords, rules) {
  const records = await loadRecords(proposal.orderId);
  const decision = ledger.decideAndReserve(proposal, records, rules); // atomic
  const refunds = [];
  try {
    for (const [i, c] of decision.claims.entries()) if (c.verdict === VERDICT.REFUND && c.payCents > 0) {
      const capture = c.type === 'DUPLICATE_CHARGE' ? records.captures[1] : records.captures[0]; // a duplicate is refunded on the second capture
      refunds.push(await paypal.refund(capture.id, c.payCents, `${proposal.requestId}:${i}`));
    }
  } catch (e) { ledger.release(proposal, decision, records); throw e; }
  return { decision, refunds, paidCents: refunds.reduce((s, r) => s + r.amountCents, 0) };
}
