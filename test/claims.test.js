import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClaims } from '../src/claims.js';

test('clean claims pass through', () => {
  const c = validateClaims({ claims: [{ type: 'OVERCHARGE', amount_cents: 500 }, { type: 'NOT_RECEIVED', amount_cents: 2000 }] });
  assert.deepEqual(c.map((x) => [x.type, x.amountCents]), [['OVERCHARGE', 500], ['NOT_RECEIVED', 2000]]);
});
test('strange model output cannot become a payment', () => {
  assert.deepEqual(validateClaims(null), []);
  assert.deepEqual(validateClaims({ claims: 'refund everything' }), []);
  const c = validateClaims({ claims: [{ type: 'GOODWILL', amount_cents: 2500 }, { type: 'OVERCHARGE', amount_cents: -5 }, { type: 'OVERCHARGE', amount_cents: 4.5 }, { type: 'OVERCHARGE', amount_cents: '500' }] });
  assert.deepEqual(c.map((x) => [x.type, x.amountCents]), [['OTHER', 2500], ['OVERCHARGE', 500]]);
  assert.equal(validateClaims({ claims: Array(9).fill({ type: 'OTHER', amount_cents: 1 }) }).length, 5);
});
