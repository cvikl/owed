// One chat call against any OpenAI-compatible endpoint (Nebius Token Factory in our deployment).
// Messages are kept in a small neutral shape: { role: 'user', text } | { role: 'assistant', text, toolCalls } | { role: 'tool', callId, content }.
// Every call is appended to the ledger file so the arena can show what the model was asked and what it answered.
import fs from 'node:fs';

const BASE = (process.env.OPENAI_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1').replace(/\/$/, '');
const KEY = process.env.OPENAI_API_KEY;
export const MODEL = process.env.MODEL ?? 'Qwen/Qwen3-235B-A22B-Instruct-2507';
const LOG = process.env.MODEL_LOG ?? null;

export function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text });
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.callId, content: m.content });
    else out.push({ role: 'assistant', content: m.text || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) } : {}) });
  }
  return out;
}

/** Returns { text, toolCalls: [{ id, name, input }], usage, ms }. Throws on a non-retryable error. */
export async function chat({ system, messages, tools = [], model = MODEL, maxTokens = 1024, temperature = 0, tag = '' }) {
  if (!KEY) throw new Error('OPENAI_API_KEY is not set');
  const body = {
    model, max_tokens: maxTokens, temperature, messages: toOpenAI(system, messages),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })), tool_choice: 'auto' } : {}),
  };
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      if (attempt < 4 && [429, 500, 502, 503, 529].includes(res.status)) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error(`model API ${res.status}: ${text.slice(0, 200)}`);
    }
    const j = await res.json();
    const m = j.choices?.[0]?.message ?? {};
    const toolCalls = (m.tool_calls ?? []).map((c) => { let input = {}; try { input = JSON.parse(c.function.arguments || '{}'); } catch { } return { id: c.id, name: c.function.name, input }; });
    const out = { text: m.content ?? '', toolCalls, usage: j.usage ?? null, ms: Date.now() - t0, model };
    if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), tag, model, ms: out.ms, usage: out.usage, toolCalls: toolCalls.map((c) => ({ name: c.name, input: c.input })), text: out.text.slice(0, 500) }) + '\n');
    return out;
  }
}
