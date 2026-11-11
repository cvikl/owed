// The arena's agent loop: one customer turn at a time, with the conversation kept between HTTP calls.
// The benchmark uses src/agent.js (whole conversations in one go). Both send the same prompt and tools.
import { chat } from './model.js';
import { SYSTEM, TOOLS } from '../scripts/scenarios.js';
export { SYSTEM, TOOLS };

/**
 * Run one customer turn. `tools` is { name: async (input) => result }.
 * Returns { reply, steps: [{ name, input, result, ms }], messages } where messages is the history to keep.
 */
export async function runTurn({ history, userText, tools, system = SYSTEM, model, tag = '', maxSteps = 8 }) {
  const messages = [...history, { role: 'user', text: userText }];
  const steps = [];
  let reply = '';
  for (let step = 0; step < maxSteps; step++) {
    const out = await chat({ system, messages, tools: TOOLS, model, tag });
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
