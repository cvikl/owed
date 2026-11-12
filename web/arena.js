/* The Owed arena: a small canvas game around the real refund calls.
   Left, the shop's vault. Two gates in the middle: the AI alone (an open gate) and Owed (a keeper with a shield).
   Right, the player. An attack flies as a speech bubble to the gates; the gates think; then coins fly out of the
   vault along both lanes. Coins beyond what is owed pass the open gate and score for the player; at Owed's gate they
   hit the shield, bounce back into the vault, and the keeper flashes BLOCKED. Fixed-timestep loop, draw never mutates
   state, every amount comes from the server's answer (a real PayPal sandbox refund per coin lane). */
(function () {
  const W = 1100, H = 440;
  const LANES = { alone: 128, owed: 318 };
  const VAULT = { x: 110, y: 225 }, GATE_X = 560, PLAYER = { x: 985, y: 225 };
  const pal = () => ({ ink: v('--ink', '#101614'), ink2: v('--ink-2', '#3b4441'), mute: v('--mute', '#67716d'), line: v('--line-strong', '#b8c0bb'), green: v('--green', '#0f6b4e'), bright: v('--green-bright', '#5ee0a4'), red: v('--red', '#b3261e'), amber: v('--amber', '#8a5d00'), paper: '#ffffff', wash: v('--wash', '#f4f5f3'), block: v('--block', '#0b3d2e') });
  const v = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const money = (c) => '$' + (c / 100).toFixed(2);

  const S = { canvas: null, ctx: null, level: 'mug', phase: 'idle', t: 0, bubble: null, coins: [], parts: [], texts: [], shake: 0, keeper: { squash: 0, flash: 0, blocked: 0 }, robot: { bob: 0, leak: 0 }, vault: { shake: 0, label: '' }, think: 0, owed: 0, last: performance.now(), acc: 0, facts: { mug: { owed: 500, captured: 2500 }, seafood: { owed: 6000, captured: 6000 } }, result: null, hooks: {} };

  function init(canvas, hooks) {
    S.canvas = canvas; S.ctx = canvas.getContext('2d'); S.hooks = hooks || {};
    canvas.width = W; canvas.height = H;
    requestAnimationFrame(loop);
  }
  function setLevel(kind) { S.level = kind; S.phase = 'idle'; S.coins = []; S.texts = []; S.result = null; }
  function setFacts(f) { S.facts = f; }
  function attack(kind, text) {
    S.level = kind; S.phase = 'send'; S.t = 0; S.coins = []; S.result = null;
    S.bubble = { x: PLAYER.x - 60, y: PLAYER.y - 70, tx: GATE_X + 20, ty: 70, text: text.length > 46 ? text.slice(0, 44) + '…' : text, p: 0 };
  }
  function think() { S.phase = 'think'; S.t = 0; }
  /* alone, owedSide: cents actually refunded on each lane; owed: cents the record proves; from the server's answer */
  function payout(kind, r) {
    S.level = kind; S.phase = 'payout'; S.t = 0; S.result = r; S.owed = r.owed;
    const mk = (lane, cents, over) => { const n = Math.max(0, Math.min(40, Math.round(cents / 100))); for (let i = 0; i < n; i++) S.coins.push({ lane, x: VAULT.x + 40, y: LANES[lane] + (Math.random() - 0.5) * 14, vx: 260 + Math.random() * 90, vy: 0, delay: i * 0.07, over: over(i), state: 'fly', r: 7 + Math.random() * 2 }); };
    mk('alone', r.alone, (i) => (i + 1) * 100 > r.owed);
    // Owed's lane: the coins the record proves pass; any coin the AI asked for beyond that is drawn, hits the shield and goes back
    const asked = Math.max(r.owedSide, Math.min(r.askedOwed ?? r.owedSide, r.captured ?? r.owedSide));
    mk('owed', Math.max(r.owedSide, asked), (i) => (i + 1) * 100 > r.owedSide);
    S.vault.shake = 0.4; S.vault.label = '';
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - S.last) / 1000); S.last = now; S.acc += dt;
    const step = 1 / 120; while (S.acc >= step) { update(step); S.acc -= step; }
    draw(); requestAnimationFrame(loop);
  }
  function update(dt) {
    S.t += dt; S.shake = Math.max(0, S.shake - dt * 3); S.keeper.squash = Math.max(0, S.keeper.squash - dt * 4); S.keeper.flash = Math.max(0, S.keeper.flash - dt * 2); S.vault.shake = Math.max(0, S.vault.shake - dt * 2); S.robot.bob += dt;
    if (S.phase === 'send' && S.bubble) { S.bubble.p = Math.min(1, S.bubble.p + dt * 1.4); if (S.bubble.p >= 1) { S.phase = 'think'; S.t = 0; } }
    if (S.phase === 'think') S.think += dt;
    for (const c of S.coins) {
      if (c.delay > 0) { c.delay -= dt; continue; }
      if (c.state === 'fly') {
        c.x += c.vx * dt;
        if (c.lane === 'owed' && c.over && c.x >= GATE_X - 26) { c.state = 'back'; c.vx = -(220 + Math.random() * 120); c.vy = -(120 + Math.random() * 160); S.keeper.squash = 1; S.keeper.flash = 1; S.keeper.blocked++; S.shake = Math.min(1, S.shake + 0.35); burst(GATE_X - 26, LANES.owed, pal().bright, 10); if (S.keeper.blocked % 4 === 1) S.texts.push({ x: GATE_X, y: LANES.owed - 60, text: 'BLOCKED', col: pal().green, t: 0, big: true }); }
        else if (c.x >= PLAYER.x - 40) { c.state = 'done'; burst(PLAYER.x - 40, c.y, c.over ? pal().red : pal().green, 5); if (c.over) S.texts.push({ x: PLAYER.x - 40, y: c.y - 10, text: '+$1', col: pal().red, t: 0 }); }
      } else if (c.state === 'back') { c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 500 * dt; if (c.x <= VAULT.x + 40) { c.state = 'done'; S.vault.shake = 0.3; } }
    }
    for (const p of S.parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt; p.t += dt; }
    S.parts = S.parts.filter((p) => p.t < 0.8);
    for (const tx of S.texts) tx.t += dt; S.texts = S.texts.filter((tx) => tx.t < 1.4);
    if (S.phase === 'payout' && S.coins.length && S.coins.every((c) => c.state === 'done')) { S.phase = 'done'; S.t = 0; const r = S.result; const got = Math.max(0, r.alone - r.owed); S.texts.push({ x: PLAYER.x - 40, y: PLAYER.y - 90, text: got > 0 ? '+' + money(got) + ' not owed' : 'nothing extra', col: got > 0 ? pal().red : pal().mute, t: 0, big: true }); }
  }
  function burst(x, y, col, n) { for (let i = 0; i < n; i++) S.parts.push({ x, y, vx: (Math.random() - 0.5) * 320, vy: -80 - Math.random() * 220, t: 0, col, r: 2 + Math.random() * 3 }); }

  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
  function draw() {
    const ctx = S.ctx, P = pal(); ctx.clearRect(0, 0, W, H);
    ctx.save(); if (S.shake > 0 && !reduced) ctx.translate((Math.random() - 0.5) * 8 * S.shake, (Math.random() - 0.5) * 8 * S.shake);
    // ground and lanes
    ctx.fillStyle = P.wash; rr(ctx, 0, 0, W, H, 0); ctx.fill();
    for (const [name, y] of Object.entries(LANES)) { ctx.strokeStyle = P.line; ctx.setLineDash([6, 8]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(VAULT.x + 50, y); ctx.lineTo(PLAYER.x - 50, y); ctx.stroke(); ctx.setLineDash([]); }
    ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = P.mute;
    ctx.fillText('AI ALONE', GATE_X, LANES.alone - 78); ctx.fillText('AI BEHIND OWED', GATE_X, LANES.owed - 78);
    drawVault(ctx, P); drawRobot(ctx, P); drawKeeper(ctx, P); drawPlayer(ctx, P);
    for (const c of S.coins) if (c.delay <= 0 && c.state !== 'done') { ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.fillStyle = c.over ? P.red : P.green; ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 2; ctx.stroke(); }
    for (const p of S.parts) { ctx.globalAlpha = 1 - p.t / 0.8; ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = 1;
    for (const tx of S.texts) { ctx.globalAlpha = 1 - tx.t / 1.4; ctx.fillStyle = tx.col; ctx.font = (tx.big ? '800 22px' : '700 13px') + ' system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(tx.text, tx.x, tx.y - tx.t * 40); } ctx.globalAlpha = 1;
    if (S.bubble && (S.phase === 'send' || S.phase === 'think')) { const b = S.bubble, e = 1 - Math.pow(1 - b.p, 3), x = b.x + (b.tx - b.x) * e, y = b.y + (b.ty - b.y) * e; ctx.font = '500 13px system-ui, sans-serif'; const w = Math.min(420, ctx.measureText(b.text).width + 24); ctx.fillStyle = P.paper; ctx.strokeStyle = P.line; rr(ctx, x - w / 2, y - 16, w, 32, 10); ctx.fill(); ctx.stroke(); ctx.fillStyle = P.ink; ctx.textAlign = 'center'; ctx.fillText(b.text, x, y + 5); }
    if (S.phase === 'think') { const d = '.'.repeat(1 + Math.floor(S.t * 2) % 3); ctx.fillStyle = P.mute; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('both AIs are reading the message and talking to PayPal' + d, GATE_X, H - 18); }
    if (S.phase === 'idle') { ctx.fillStyle = P.mute; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Pick a level, write your attack, press Attack. Coins beyond what is owed are your score.', GATE_X, H - 18); }
    ctx.restore();
  }
  function drawVault(ctx, P) {
    const s = S.vault.shake > 0 && !reduced ? (Math.random() - 0.5) * 6 * S.vault.shake : 0;
    ctx.save(); ctx.translate(VAULT.x + s, VAULT.y);
    ctx.fillStyle = P.block; rr(ctx, -50, -70, 100, 140, 14); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.08)'; rr(ctx, -40, -60, 80, 120, 10); ctx.fill();
    ctx.strokeStyle = P.bright; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, -6, 22, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0, -6, 6, 0, Math.PI * 2); ctx.fillStyle = P.bright; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '700 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.font = '700 11px system-ui, sans-serif'; ctx.fillText("SHOP'S", 0, 34); ctx.fillText('PAYPAL', 0, 48); ctx.fillText('BALANCE', 0, 62);
    ctx.fillStyle = P.mute; ctx.font = '600 12px system-ui, sans-serif'; const f = S.facts[S.level] || {}; ctx.fillText('captured ' + money(f.captured || 0), 0, 94); ctx.fillStyle = P.green; ctx.fillText('owed ' + money(f.owed || 0), 0, 112);
    ctx.restore();
  }
  function drawRobot(ctx, P) {
    const y = LANES.alone + Math.sin(S.robot.bob * 3) * 3;
    ctx.save(); ctx.translate(GATE_X, y);
    ctx.strokeStyle = P.line; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-70, -56); ctx.lineTo(-70, 56); ctx.moveTo(70, -56); ctx.lineTo(70, 56); ctx.stroke();
    ctx.fillStyle = P.paper; ctx.strokeStyle = P.line; ctx.lineWidth = 2; rr(ctx, -28, -34, 56, 50, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = S.phase === 'think' ? P.amber : P.ink2; ctx.beginPath(); ctx.arc(-11, -12, 5, 0, Math.PI * 2); ctx.arc(11, -12, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = P.ink2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-10, 6); ctx.lineTo(10, 6); ctx.stroke();
    ctx.fillStyle = P.mute; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('open gate: its refund call goes straight to PayPal', 0, 40);
    ctx.restore();
  }
  function drawKeeper(ctx, P) {
    const sq = S.keeper.squash, y = LANES.owed;
    ctx.save(); ctx.translate(GATE_X, y); ctx.scale(1 + sq * 0.18, 1 - sq * 0.18);
    ctx.strokeStyle = P.line; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-70, -56); ctx.lineTo(-70, 56); ctx.moveTo(70, -56); ctx.lineTo(70, 56); ctx.stroke();
    const fl = S.keeper.flash;
    ctx.fillStyle = fl > 0 ? `rgba(94,224,164,${0.35 + 0.5 * fl})` : P.green; rr(ctx, -34, -46, 68, 92, 20); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-14, -2); ctx.lineTo(-4, 8); ctx.lineTo(16, -14); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '800 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('OWED', 0, 30);
    ctx.restore();
    ctx.fillStyle = P.mute; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('pays what the records prove · blocked ' + S.keeper.blocked + ' coins so far', GATE_X, y + 70);
  }
  function drawPlayer(ctx, P) {
    ctx.save(); ctx.translate(PLAYER.x, PLAYER.y);
    ctx.fillStyle = P.paper; ctx.strokeStyle = P.line; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, -40, 22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    rr(ctx, -30, -12, 60, 60, 16); ctx.fill(); ctx.stroke();
    ctx.fillStyle = P.ink2; ctx.beginPath(); ctx.arc(-7, -44, 3, 0, Math.PI * 2); ctx.arc(7, -44, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = P.mute; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('you, the customer', 0, 68);
    ctx.restore();
  }
  window.OwedArena = { init, setLevel, setFacts, attack, think, payout };
})();
