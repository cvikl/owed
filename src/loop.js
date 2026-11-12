// The arena's agent loop: one customer turn at a time, with the conversation kept between HTTP calls.
// The benchmark uses src/agent.js (whole conversations in one go). Both send the same prompt and tools.
import { chat } from './model.js';
import { SYSTEM, TOOLS } from '../scripts/scenarios.js';
import { CLAIMS_PROMPT, CLAIMS_TOOL, validateClaims } from './claims.js';
export { SYSTEM, TOOLS };

/** Ask the model only what the customer claimed. No money tool. Falls back to a JSON block in text. */
export async function labelClaims(customerText, { model, tag = '', orderTotalCents } = {}) {
  // The label needs the order total to follow its own rule "if no amount is given, use the order total" (live seafood game, 12 Nov 2026: 'please refund me' labelled nothing).
  const text = orderTotalCents ? `${customerText}\n\n[Order total: ${(orderTotalCents / 100).toFixed(2)} USD]` : customerText;
  const out = await chat({ system: CLAIMS_PROMPT + '\nIf no tool is available, answer with one JSON object {"claims":[...]} and nothing else.', messages: [{ role: 'user', text }], tools: [CLAIMS_TOOL], model, maxTokens: 300, tag: `${tag}:claims` });
  const call = out.toolCalls.find((c) => c.name === CLAIMS_TOOL.name);
  if (call) return validateClaims(call.input);
  const m = /\{[\s\S]*\}/.exec(out.text || ''); if (!m) return [];
  try { return validateClaims(JSON.parse(m[0])); } catch { return []; }
}

/**
 * Run one customer turn. `tools` is { name: async (input) => result }.
 * Returns { reply, steps: [{ name, input, result, ms }], messages } where messages is the history to keep.
 */
export async function runTurn({ history, userText, tools, toolDefs = TOOLS, system = SYSTEM, model, tag = '', maxSteps = 8 }) {
  const messages = [...history, { role: 'user', text: userText }];
  const steps = [];
  let reply = '';
  for (let step = 0; step < maxSteps; step++) {
    const out = await chat({ system, messages, tools: toolDefs, model, tag });
    messages.push({ role: 'assistant', text: out.text, toolCalls: out.toolCalls });
    if (!out.toolCalls.length) { reply = out.text; break; }
    if (out.text) reply = out.text;
    for (const c of out.toolCalls) {
      const t0 = Date.now();
      let result;
      try { result = await (tools[c.name] ?? (async () => ({ error: 'unknown tool' })))(c.input ?? {}); }
      catch (e) { result = { error: e.code ?? String(e.message) }; }
      steps.push({ name: c.name, input: c.input ?? {}, result, ms: Date.now() - t0 });
      messages.push({ role: 'tool', callId: c.id, content: JSON.stringify(result) });
    }
  }
  return { reply, steps, messages };
}
