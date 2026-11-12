// One agent loop, three ways to reach a model. The same system prompt, tools and
// customer turns go to every model, so results can be compared.
//   anthropic:<model id>   needs ANTHROPIC_API_KEY
//   openai:<model id>      needs OPENAI_API_KEY, and OPENAI_BASE_URL for any compatible provider
//   mock:gullible          no key, a stand-in that is easily fooled, for checking the harness
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 0 repeats the same answer every time. Set TEMPERATURE=0.7 when you repeat cases with RUNS, so the runs are independent.
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0);

async function post(url, headers, body, fetchFn) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if (attempt >= 4 || ![408, 429, 500, 502, 503, 529].includes(res.status)) throw new Error(`model API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await sleep(1500 * (attempt + 1));
  }
}

async function anthropicLoop({ model, system, tools, turns, exec, fetchFn, env, maxSteps }) {
  const messages = []; const usage = { in: 0, out: 0, requests: 0 }; let finalText = '';
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn });
    for (let step = 0; step < maxSteps; step++) {
      const out = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 1024, temperature: TEMPERATURE, system, tools, messages }, fetchFn);
      usage.requests++; usage.in += out.usage?.input_tokens ?? 0; usage.out += out.usage?.output_tokens ?? 0;
      messages.push({ role: 'assistant', content: out.content });
      finalText = out.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') || finalText;
      const uses = out.content.filter((b) => b.type === 'tool_use');
      if (out.stop_reason !== 'tool_use' || uses.length === 0) break;
      const results = [];
      for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await exec(u.name, u.input ?? {})) });
      messages.push({ role: 'user', content: results });
    }
  }
  return { usage, finalText };
}

async function openaiLoop({ model, system, tools, turns, exec, fetchFn, env, maxSteps }) {
  const base = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const fns = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const messages = [{ role: 'system', content: system }]; const usage = { in: 0, out: 0, requests: 0 }; let finalText = '';
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn });
    for (let step = 0; step < maxSteps; step++) {
      const out = await post(`${base}/chat/completions`, { authorization: `Bearer ${env.OPENAI_API_KEY}` }, { model, messages, tools: fns, temperature: TEMPERATURE }, fetchFn);
      usage.requests++; usage.in += out.usage?.prompt_tokens ?? 0; usage.out += out.usage?.completion_tokens ?? 0;
      const msg = out.choices[0].message; messages.push(msg);
      if (msg.content) finalText = msg.content;
      if (!msg.tool_calls?.length) break;
      for (const tc of msg.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(await exec(tc.function.name, args)) });
      }
    }
  }
  return { usage, finalText };
}

// Asks for the largest dollar figure in the message, or a full refund if there is none. Never checks anything.
async function mockLoop({ turns, exec }) {
  for (const turn of turns) {
    const nums = [...String(turn).matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    await exec('create_refund', nums.length ? { capture_id: 'CAP1', amount: { currency_code: 'USD', value: Math.max(...nums).toFixed(2) } } : { capture_id: 'CAP1' });
  }
  return { usage: { in: 0, out: 0, requests: 0 }, finalText: 'Done.' };
}

export function parseModel(spec) {
  const i = spec.indexOf(':'); if (i < 0) throw new Error(`Write models as provider:model, got "${spec}"`);
  return { provider: spec.slice(0, i), model: spec.slice(i + 1), label: spec };
}

export async function runAgent({ provider, model, system, tools, turns, exec, fetchFn = fetch, env = process.env, maxSteps = 8 }) {
  const args = { model, system, tools, turns, exec, fetchFn, env, maxSteps };
  if (provider === 'anthropic') return anthropicLoop(args);
  if (provider === 'openai') return openaiLoop(args);
  if (provider === 'mock') return mockLoop(args);
  throw new Error(`Unknown provider "${provider}". Use anthropic, openai or mock`);
}
