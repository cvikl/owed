/* The flow: a left-to-right picture of what happened to one message, drawn from the server's real answer.
   Customer -> the shop's AI -> two paths. AI alone: its refund call goes straight to PayPal, the whole amount.
   Behind Owed: the same call is a request; Owed reads the records and runs the rules; PayPal pays what the records
   prove, the rest goes to a person. Ribbons are proportional to the money (a Sankey), labels carry the numbers,
   nodes light up in the order the real steps happened. Built on the SVG in demo.html. */
(function () {
  const $ = (id) => document.getElementById(id);
  const money = (c) => '$' + (c / 100).toFixed(2);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MAXW = 30; // ribbon width for the largest amount on the stage
  let timers = [];
  const clear = () => { for (const t of timers) clearTimeout(t); timers = []; };
  const later = (ms, fn) => timers.push(setTimeout(fn, reduced ? 0 : ms));

  function ribbon(id, cents, max, col) {
    const el = $(id); if (!el) return; const w = cents > 0 ? Math.max(3, (cents / max) * MAXW) : 0;
    const was = Number(el.style.strokeWidth) || 0;
    el.style.strokeWidth = w; el.style.stroke = col; el.classList.toggle('on', cents > 0);
    if (cents > 0 && was === 0 && !reduced) { el.classList.remove('draw'); void el.getBoundingClientRect(); el.classList.add('draw'); }
    if (cents === 0) el.classList.remove('draw');
    const lab = $(id + '-l'); if (lab && !['r-pay1-l', 'r-msg1-l', 'r-msg2-l'].includes(id + '-l')) { lab.textContent = cents > 0 ? money(cents) : ''; lab.setAttribute('fill', col); lab.classList.toggle('show', cents > 0); }
  }
  function label(id, text) { const lab = $(id); if (!lab) return; lab.textContent = text; lab.classList.toggle('show', Boolean(text)); }
  /* a refund PayPal has just confirmed, before the AI has finished writing: the lane's ribbon grows the moment it happens */
  function live(door, cents, owed, captured) {
    const css = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
    const max = Math.max(captured, cents, 100);
    if (door === 1) { ribbon('r-ask1', cents, max, cents > owed ? css('--red', '#b3261e') : css('--green', '#0f6b4e')); label('r-ask1-l', 'create_refund ' + money(cents)); ribbon('r-pay1', cents, max, cents > owed ? css('--red', '#b3261e') : css('--green', '#0f6b4e')); node('f-pp1', cents > owed ? 'bad' : 'good'); note('f-pp1-n', 'PayPal confirmed ' + money(cents)); }
    else { node('f-ai2', 'done'); node('f-owed', 'done'); ribbon('r-pay2', cents, max, css('--green', '#0f6b4e')); node('f-pp2', 'good'); note('f-pp2-n', 'PayPal confirmed ' + money(cents)); }
  }
  function node(id, state) { const el = $(id); if (!el) return; el.classList.remove('active', 'done', 'bad', 'good', 'warn'); if (state) el.classList.add(state); }
  function note(id, text) { const el = $(id); if (el) el.textContent = text; }

  function reset(facts) {
    clear();
    for (const id of ['f-customer', 'f-ai1', 'f-ai2', 'f-owed', 'f-pp1', 'f-pp2', 'f-person']) node(id, null);
    for (const id of ['r-msg1', 'r-msg2', 'r-ask1', 'r-ask2', 'r-pay1', 'r-pay2', 'r-person']) ribbon(id, 0, 1, '');
    note('f-ai1-n', 'refund call straight to PayPal'); note('f-ai2-n', 'the same call becomes a request'); note('f-owed-n', 'eight rules, whole cents');
    note('f-pp1-n', ''); note('f-pp2-n', ''); note('f-person-n', '');
    note('f-msg', facts ? `owed ${money(facts.owed)} of ${money(facts.captured)} captured` : '');
  }
  function start(text, facts) {
    reset(facts); note('f-msg', text.length > 60 ? text.slice(0, 58) + '…' : text);
    node('f-customer', 'active');
    const col = getComputedStyle(document.documentElement).getPropertyValue('--line-strong').trim() || '#b8c0bb';
    later(60, () => { for (const id of ['r-msg1']) { const el = $(id); el.style.strokeWidth = 3; el.style.stroke = col; if (!reduced) { el.classList.remove('draw'); void el.getBoundingClientRect(); el.classList.add('draw'); } } label('r-msg1-l', ''); label('r-msg2-l', ''); node('f-ai1', 'active'); note('f-ai1-n', 'reading the records, talking to PayPal…'); });
  }
  /* r: { owed, captured, alone: cents paid by the AI alone, owedSide: cents paid behind Owed, asked1, asked2, steps1, steps2, ids1, ids2, person } */
  function finish(r) {
    const css = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
    const red = css('--red', '#b3261e'), green = css('--green', '#0f6b4e'), amber = css('--amber', '#8a5d00'), mute = css('--line-strong', '#b8c0bb');
    const max = Math.max(r.captured, r.alone, r.asked2 || 0, 100);
    const names = { get_shop_order: 'read the shop\'s order', get_shipment_tracking: 'read the tracker', get_order: 'read PayPal\'s payment', create_refund: 'asked for a refund', owed_settle: 'Owed settled from the record' };
    const seq = (steps) => { const seen = []; for (const s of steps || []) { const n = names[s.name]; if (n && !seen.includes(n)) seen.push(n); } return seen; };
    let t = 0; pane('before');
    // AI alone
    const s1 = seq(r.steps1); note('f-ai1-n', s1.length ? s1.join(' · ') : 'answered without a tool call');
    later(t += 400, () => { node('f-ai1', 'done'); if (r.alone > 0) { ribbon('r-ask1', r.alone, max, r.alone > r.owed ? red : green); label('r-ask1-l', 'create_refund ' + money(r.alone)); } else { label('r-ask1-l', r.asked1 > 0 ? 'refund refused by PayPal' : 'no refund call'); } });
    later(t += 600, () => { if (r.alone > 0) { ribbon('r-pay1', r.alone, max, r.alone > r.owed ? red : green); node('f-pp1', r.alone > r.owed ? 'bad' : 'good'); note('f-pp1-n', (r.alone > r.owed ? money(r.alone - r.owed) + ' more than was owed' : 'exactly what was owed') + (r.ids1?.length ? ' · ' + r.ids1[0] : '')); } else { node('f-pp1', 'warn'); note('f-pp1-n', 'nothing paid, ' + money(r.owed) + ' still owed'); } });
    // behind Owed, after the before pane has finished
    const s2 = seq(r.steps2);
    later(t += 1100, () => { pane('after'); const el = $('r-msg2'); el.style.strokeWidth = 3; el.style.stroke = mute; if (!reduced) { el.classList.remove('draw'); void el.getBoundingClientRect(); el.classList.add('draw'); } node('f-you2', 'active'); node('f-ai2', 'active'); note('f-ai2-n', s2.length ? s2.join(' · ') : 'answered without a tool call'); });
    later(t += 350, () => { node('f-you2', 'done'); node('f-ai2', 'done'); const ask = r.asked2 > 0 ? r.asked2 : r.owedSide; if (ask > 0) { ribbon('r-ask2', ask, max, mute); label('r-ask2-l', 'request ' + money(ask)); } else { label('r-ask2-l', 'no call'); } node('f-owed', 'active'); note('f-owed-n', 'checking PayPal\'s capture and refunds, the shop\'s order, the delivery record…'); });
    later(t += 600, () => { node('f-owed', 'done'); note('f-owed-n', r.rule ? r.rule.replace(/record settled: /, '') : 'eight rules, whole cents');
      if (r.owedSide > 0) { ribbon('r-pay2', r.owedSide, max, green); node('f-pp2', 'good'); note('f-pp2-n', 'exactly what the records prove' + (r.ids2?.length ? ' · ' + r.ids2[0] : '')); } else { node('f-pp2', 'warn'); note('f-pp2-n', 'nothing paid'); }
      const person = Math.max(0, (r.asked2 > 0 ? r.asked2 : 0) - r.owedSide);
      if (person > 0) { ribbon('r-person', person, max, amber); node('f-person', 'warn'); note('f-person-n', money(person) + ' the records do not prove, with the evidence'); } else { note('f-person-n', 'nothing to review'); }
    });
    later(t += 900, () => pane(null));
  }
  /* replay a recorded real run: the same picture, the real amounts and ids, no waiting */
  function pane(which, state) { for (const p of document.querySelectorAll('.pane')) { p.classList.remove('playing', 'waiting', 'played'); } const b = document.querySelector('.pane.before'), a = document.querySelector('.pane.after'); if (!b || !a) return; if (which === 'before') { b.classList.add('playing'); a.classList.add('waiting'); } else if (which === 'after') { b.classList.add('played'); a.classList.add('playing'); } }
  function play(rec) {
    const d1 = rec.doors['1'], d2 = rec.doors['2'];
    const askedOf = (d) => (d.steps || []).filter((x) => x.name === 'create_refund').reduce((t, x) => t + (Number(x.input?.amount?.value ?? x.input?.amount ?? 0) * 100 || 0), 0);
    pane('before');
    start(rec.text, { owed: rec.owed, captured: rec.captured });
    later(700, () => finish({ owed: rec.owed, captured: rec.captured, alone: d1.refunded, owedSide: d2.refunded, asked1: Math.round(askedOf(d1)), asked2: Math.round(askedOf(d2)) || (d2.claims || []).reduce((t, c) => t + c.amountCents, 0), steps1: d1.steps, steps2: d2.steps, ids1: (d1.refunds || []).map((x) => x.id), ids2: (d2.refunds || []).map((x) => x.id), rule: d2.rule }));
  }
  window.OwedFlow = { reset, start, finish, live, play };
})();
