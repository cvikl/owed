// Runs only when @paypal/agent-toolkit is installed. Checks that the tool definitions we give the model
// really are the toolkit's: same names, same top-level parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../scripts/scenarios.js';

let Toolkit = null; try { Toolkit = (await import('@paypal/agent-toolkit/openai')).PayPalAgentToolkit; } catch { }
test('our tool definitions match the installed PayPal Agent Toolkit', { skip: Toolkit ? false : 'toolkit not installed' }, () => {
  const tk = new Toolkit({ clientId: 'x', clientSecret: 'y', configuration: { actions: { payments: { createRefund: true }, orders: { get: true }, shipment: { get: true } }, context: { sandbox: true } } });
  const theirs = Object.fromEntries(tk.getTools().map((t) => [t.function.name, Object.keys(t.function.parameters.properties ?? {}).sort()]));
  for (const name of ['get_order', 'get_shipment_tracking', 'create_refund']) {
    assert.ok(theirs[name], `${name} is a toolkit tool`);
    assert.deepEqual(Object.keys(TOOLS.find((t) => t.name === name).input_schema.properties).sort(), theirs[name], name);
  }
});
