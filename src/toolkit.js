// PayPal's own Agent Toolkit, when it is installed (npm install @paypal/agent-toolkit).
// With it, Door 1's create_refund is executed by the toolkit's own code (handleToolCall). Nothing else
// changes: the model is always given the definitions in scripts/scenarios.js, which are copied from the
// toolkit, and lookups always use our REST client. /api/config says whether the toolkit is installed
// and whether a refund has been confirmed through it since the server started.
//
// NOT YET RUN. Written against @paypal/agent-toolkit 1.11.0 (openai entry point: getTools, handleToolCall).
// First check after installing:  node -e "import('./src/toolkit.js').then(async m=>console.log(await m.loadToolkit()))"
const WANT = ['get_order', 'get_shipment_tracking', 'create_refund'];
let tk = null; let info = { installed: false, version: null, reason: 'not loaded' };

export async function loadToolkit({ clientId = process.env.PAYPAL_CLIENT_ID, clientSecret = process.env.PAYPAL_CLIENT_SECRET } = {}) {
  if (process.env.USE_TOOLKIT === '0') { info = { installed: false, version: null, reason: 'switched off with USE_TOOLKIT=0' }; return info; }
  if (!clientId || !clientSecret) { info = { installed: false, version: null, reason: 'no PayPal keys' }; return info; }
  try {
    const m = await import('@paypal/agent-toolkit/openai');
    const Toolkit = m.PayPalAgentToolkit ?? m.default;
    tk = new Toolkit({ clientId, clientSecret, configuration: {
      actions: { payments: { createRefund: true } },
      context: { sandbox: true }, // sandbox only, always
    } });
    let version = null;
    try { const { createRequire } = await import('node:module'); version = createRequire(import.meta.url)('@paypal/agent-toolkit/package.json').version; } catch { }
    info = { installed: true, verified: false, package: '@paypal/agent-toolkit', version, reason: null };
  } catch (e) { tk = null; info = { installed: false, version: null, reason: String(e.message).slice(0, 120) }; }
  return info;
}
export const toolkitInfo = () => info;
/** Called after the first refund that PayPal confirmed through the toolkit. Until then the page does not claim it. */
export const toolkitVerified = () => { info = { ...info, verified: true }; };

/** The toolkit's own definitions for the three PayPal tools, in the neutral shape model.js sends. */
export function toolkitToolDefs() {
  if (!tk) return null;
  const defs = tk.getTools().filter((t) => WANT.includes(t.function.name)).map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  return defs.length === WANT.length ? defs : null;
}

/** Run one toolkit tool exactly as an agent's call would. Returns the parsed result. */
export async function toolkitRun(name, args) {
  if (!tk) throw new Error('toolkit not loaded');
  const out = await tk.handleToolCall({ id: `owed-${Date.now().toString(36)}`, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } });
  let content = out?.content;
  if (typeof content === 'string') { try { content = JSON.parse(content); } catch { content = { text: content }; } }
  return content ?? {};
}
