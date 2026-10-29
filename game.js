'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 뿌요뿌요: 화면·입력·소리. 규칙(덩어리·터뜨리기·연쇄·방해 뿌요·컴퓨터)은 logic.js (LOGIC_PUYO) 에 있고,
// 여기서는 규칙이 남긴 g.events 를 보고 소리·효과·안내를 만든다.
const L = LOGIC_PUYO;
const { COLS, ROWS, VIS_TOP } = L;
const CELL = 16;
const BH = (ROWS - VIS_TOP) * CELL, BW = COLS * CELL;              // 보드 한 판 96 x 192
const W = 256, TOP = 26, CH = TOP + BH + 18;
const BX = [10, 150];                                               // 왼쪽(나) · 오른쪽(컴퓨터) 판의 x

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

function fit() {
  const controls = $('controls');
  const ctrlH = getComputedStyle(controls).display === 'none' ? 0 : controls.offsetHeight + 10;
  const scale = Math.min((innerWidth - 16) / W, (innerHeight - 16 - ctrlH) / CH);
  const cssW = Math.max(160, Math.floor(W * scale)), cssH = Math.floor(cssW * CH / W);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / CH, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', fit);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

// ---------- 소리 ----------
let audio = null;
let muted = store.get('puyoMuted') === '1';
function tone(freq, dur, type = 'square', vol = 0.04, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  } catch (_) {}
}
const melody = (notes, step, type = 'square', vol = 0.05) => notes.forEach((f, i) => { if (f) setTimeout(() => tone(f, step * 0.9 / 1000, type, vol), i * step); });
const sfx = {
  move: () => tone(300, 0.03, 'square', 0.02),
  rotate: () => tone(520, 0.05, 'triangle', 0.04, 160),
  land: () => tone(140, 0.09, 'sine', 0.06, -50),
  pop: (n) => melody([523, 587, 659, 698, 784, 880, 988, 1047, 1175, 1319].slice(Math.min(n - 1, 9), Math.min(n - 1, 9) + 3), 55, 'sine', 0.07),
  send: () => tone(300, 0.2, 'sawtooth', 0.04, 300),
  nuisance: () => { tone(110, 0.2, 'sawtooth', 0.05, -40); },
  win: () => melody([523, 659, 784, 1047, 1319], 110),
  lose: () => melody([392, 330, 262, 196], 220, 'sawtooth', 0.06),
  start: () => melody([392, 523, 659], 100),
};

// ---------- 상태 ----------
let G = null;
let mode = 'vs', levelName = 'easy';
let state = 'title';                           // title · play · paused · over
let pausedFrom = null;
let best = Number(store.get('puyoBest')) || 0;
let fxs = [];
let clock = 0;
const chainFx = [null, null];                  // 연쇄 글자 { n, t }

/* @test-hooks:start */
window.__pp = { get G() { return G; }, get state() { return state; }, L, setG(g) { G = g; }, step: (dt) => update(dt) };
/* @test-hooks:end */

// ---------- 입력 ----------
const held = new Set();
const das = { dir: 0, t: 0, rep: 0 };         // 옆으로 길게 누르면 반복
let padHeld = { left: false, right: false, down: false };
let rotQueue = 0, leftEdge = false, rightEdge = false;
const KEYS = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowDown: 'down', s: 'down', S: 'down' };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key in KEYS) { e.preventDefault(); held.add(KEYS[e.key]); return; }
  if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (!e.repeat && state === 'play') rotQueue = -1; return; }
  if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { e.preventDefault(); if (!e.repeat && state === 'play') rotQueue = 1; return; }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (state === 'paused' && !e.repeat) resume(); return; }
  if (e.key === 'p' || e.key === 'P') { if (state === 'paused') resume(); else pause(); }
  else if (e.key === 'm' || e.key === 'M') toggleMute();
});
addEventListener('keyup', (e) => { if (e.key in KEYS) held.delete(KEYS[e.key]); });

const pad = $('pad');
const PAD_DIRS = ['u', 'd', 'l', 'r'];
function padFrom(e) {
  const r = pad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const dead = r.width * 0.14;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  padHeld = { left: false, right: false, down: false };
  if (Math.max(Math.abs(dx), Math.abs(dy)) >= dead) {
    if (horizontal) { if (dx > 0) padHeld.right = true; else padHeld.left = true; }
    else if (dy > 0) padHeld.down = true;
  }
  const knob = pad.querySelector('b'), lim = r.width * 0.2;
  knob.style.transform = `translate(${Math.max(-lim, Math.min(lim, dx))}px, ${Math.max(-lim, Math.min(lim, dy))}px)`;
  const on = { u: false, d: padHeld.down, l: padHeld.left, r: padHeld.right };
  pad.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', !!on[PAD_DIRS[i]]));
}
const padEnd = () => { padHeld = { left: false, right: false, down: false }; pad.querySelector('b').style.transform = ''; pad.querySelectorAll('i').forEach((el) => el.classList.remove('on')); };
pad.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch (_) {} padFrom(e); });
pad.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') padFrom(e); });
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
for (const [id, dir] of [['rotL', -1], ['rotR', 1]]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (state === 'play') rotQueue = dir; b.classList.add('on'); });
  const off = () => b.classList.remove('on');
  b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off);
}

function readInput(dt) {
  const left = held.has('left') || padHeld.left, right = held.has('right') || padHeld.right, down = held.has('down') || padHeld.down;
  const dir = left && !right ? -1 : right && !left ? 1 : 0;
  const input = { left: false, right: false, down, rotate: rotQueue };
  rotQueue = 0;
  if (dir !== das.dir) { das.dir = dir; das.t = 0; das.rep = 0; if (dir) { if (dir < 0) input.left = true; else input.right = true; } }
  else if (dir) {
    das.t += dt;
    if (das.t > 0.17) { das.rep += dt; while (das.rep >= 0.055) { das.rep -= 0.055; if (dir < 0) input.left = true; else input.right = true; } }
  }
  return input;
}

// ---------- 흐름 ----------
function showOverlay(html) { const o = $('overlay'); o.innerHTML = html; o.classList.remove('hidden'); o.querySelectorAll('button').forEach((b) => { b.onclick = () => onOverlayButton(b); }); }
function hideOverlay() { $('overlay').classList.add('hidden'); }
function showMenu() {
  state = 'title';
  showOverlay(`<h1>뿌요뿌요</h1><p>같은 색 뿌요를 <b>4개 이상</b> 이어 붙여 터뜨려요!<br>연쇄로 상대에게 <b>방해 뿌요</b>를 보내요 🟢🔴</p>
    <div class="row"><button id="startBtn" data-mode="vs" data-level="easy">컴퓨터 대전 · 쉬움</button></div>
    <div class="row"><button class="sub" data-mode="vs" data-level="normal">보통</button><button class="sub" data-mode="vs" data-level="hard">어려움</button><button class="sub" data-mode="solo">혼자 연습</button></div>`);
}
function startGame(m, lv) {
  mode = m; levelName = lv || 'normal';
  G = L.newGame(Math.random, mode, levelName);
  fxs = []; chainFx[0] = chainFx[1] = null; held.clear(); das.dir = 0; rotQueue = 0;
  state = 'play';
  hideOverlay();
  sfx.start();
}
function onOverlayButton(btn) {
  if (state === 'paused') { resume(); return; }
  if (btn && btn.dataset && btn.dataset.mode) { startGame(btn.dataset.mode, btn.dataset.level); return; }
  if (btn && btn.dataset && btn.dataset.again) { startGame(mode, levelName); return; }
  showMenu();
}
function pause() {
  if (state !== 'play') return;
  pausedFrom = state; state = 'paused';
  showOverlay('<h2>일시정지</h2><p>P 키나 아래 버튼으로 계속해요</p><button id="startBtn" data-resume="1">계속하기</button>');
}
function resume() { if (state !== 'paused') return; state = pausedFrom; hideOverlay(); }
function gameOver() {
  state = 'over';
  const me = G.players[0];
  if (mode === 'solo') {
    const rec = me.score > best;
    if (rec) { best = me.score; store.set('puyoBest', String(best)); }
    sfx.lose();
    showOverlay(`<h2>GAME OVER</h2><p class="big">${me.score.toLocaleString()}점</p><p>최대 ${me.maxChain}연쇄${rec ? '<br>🏆 최고 기록!' : ''}</p><div class="row"><button id="startBtn" data-again="1">다시 하기</button><button class="sub" data-menu="1">메뉴</button></div>`);
  } else {
    const won = G.winner === 0;
    if (won) { const wins = Number(store.get('puyoWins')) || 0; store.set('puyoWins', String(wins + 1)); if (me.score > best) { best = me.score; store.set('puyoBest', String(best)); } }
    won ? sfx.win() : sfx.lose();
    showOverlay(`<h2>${won ? '🎉 승리!' : '패배…'}</h2><p class="big">${me.score.toLocaleString()}점</p><p>최대 ${me.maxChain}연쇄 · 방해 뿌요 ${me.sent}개 보냄</p><div class="row"><button id="startBtn" data-again="1">한 판 더</button><button class="sub" data-menu="1">메뉴</button></div>`);
  }
}

function handleEvents() {
  for (const e of G.events) {
    if (e.t === 'move') { if (e.who === 0) { sfx.move(); tutorialSignal('move'); } }
    else if (e.t === 'rotate') { if (e.who === 0) { sfx.rotate(); tutorialSignal('rotate'); } }
    else if (e.t === 'land') { if (e.who === 0) sfx.land(); }
    else if (e.t === 'pop') {
      if (e.who === 0) { sfx.pop(e.chain); tutorialSignal('pop'); if (e.chain >= 2) tutorialSignal('chain'); }
      if (e.chain >= 2) chainFx[e.who] = { n: e.chain, t: 0 };
      for (const [r, c] of e.cells) fxs.push({ kind: 'spark', who: e.who, r, c, t: 0, life: 0.5 });
    }
    else if (e.t === 'send') { if (e.who === 0) { sfx.send(); tutorialSignal('send'); } }
    else if (e.t === 'nuisance') { if (e.who === 0) sfx.nuisance(); }
    else if (e.t === 'over') gameOver();
  }
}

function update(dt) {
  clock += dt;
  if (state !== 'play' || !G) return;
  L.step(G, dt, readInput(dt));
  handleEvents();
  for (const f of fxs) f.t += dt;
  fxs = fxs.filter((f) => f.t < f.life);
  for (const c of chainFx) if (c) c.t += dt;
  for (let i = 0; i < 2; i++) if (chainFx[i] && chainFx[i].t > 1.4) chainFx[i] = null;
}

// ---------- 그리기 ----------
const COLORS = { 1: ['#ff5a4a', '#b82a20'], 2: ['#4ad84a', '#208a20'], 3: ['#4a8aff', '#2050b8'], 4: ['#ffd82a', '#b8960a'], 5: ['#c05aff', '#7a2ab8'] };
function drawPuyo(x, y, v, nb, popping, big = 1) {
  const cx = x + CELL / 2, cy = y + CELL / 2;
  if (v === L.OJAMA) {
    ctx.fillStyle = popping ? '#fff' : 'rgba(230,230,245,.9)'; ctx.beginPath(); ctx.arc(cx, cy, 7 * big, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(160,160,190,.8)'; ctx.beginPath(); ctx.arc(cx + 1.5, cy + 2, 4.6 * big, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(cx - 4, cy - 4, 3, 2);
    return;
  }
  const [a, b] = COLORS[v];
  ctx.fillStyle = popping ? '#fff' : a;
  ctx.beginPath(); ctx.arc(cx, cy, 7.2 * big, 0, 7); ctx.fill();
  if (nb) {                                                                    // 같은 색과 이어진 쪽을 붙인다
    ctx.fillStyle = popping ? '#fff' : a;
    if (nb.r) ctx.fillRect(cx, cy - 6, CELL, 12);
    if (nb.l) ctx.fillRect(cx - CELL, cy - 6, CELL, 12);
    if (nb.d) ctx.fillRect(cx - 6, cy, 12, CELL);
    if (nb.u) ctx.fillRect(cx - 6, cy - CELL, 12, CELL);
  }
  if (!popping) {
    ctx.fillStyle = b; ctx.beginPath(); ctx.arc(cx + 1.4, cy + 2.2, 4.8, 0, 7); ctx.fill();
    ctx.fillStyle = a; ctx.beginPath(); ctx.arc(cx, cy, 4.2, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx - 2.4, cy - 1.2, 1.9, 0, 7); ctx.arc(cx + 2.4, cy - 1.2, 1.9, 0, 7); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillRect(cx - 2.6, cy - 1.4, 1.3, 1.6); ctx.fillRect(cx + 2.1, cy - 1.4, 1.3, 1.6);
  }
}
function neighborsOf(b, r, c) {
  const v = b[r][c];
  return { l: c > 0 && b[r][c - 1] === v, r: c < COLS - 1 && b[r][c + 1] === v, u: r - 1 >= VIS_TOP && b[r - 1][c] === v, d: r + 1 < ROWS && b[r + 1][c] === v };
}
function drawBoard(p, who) {
  const x0 = BX[who], y0 = TOP;
  ctx.fillStyle = 'rgba(20,10,50,.92)'; ctx.fillRect(x0 - 2, y0 - 2, BW + 4, BH + 4);
  ctx.strokeStyle = who === 0 ? '#ff8ab8' : '#8ab8ff'; ctx.lineWidth = 1.5; ctx.strokeRect(x0 - 2.5, y0 - 2.5, BW + 5, BH + 5);
  const popping = p.popping ? new Set(p.popping.cells.map(([r, c]) => r * COLS + c)) : null;
  const blink = Math.floor(clock * 14) % 2 === 0;
  for (let r = VIS_TOP; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const v = p.board[r][c];
    if (v === 0) continue;
    const pop = popping && popping.has(r * COLS + c) && blink;
    drawPuyo(x0 + c * CELL, y0 + (r - VIS_TOP) * CELL, v, v === L.OJAMA ? null : neighborsOf(p.board, r, c), pop);
  }
  // 내려오는 덩어리
  if (p.piece && p.phase === 'fall') {
    const cells = L.pairCells(p.piece);
    const nb = [{}, {}];
    const [ax, bx] = [cells[0], cells[1]];
    if (ax[2] === bx[2]) { const dc = bx[1] - ax[1], dr = bx[0] - ax[0]; nb[0] = { r: dc === 1, l: dc === -1, d: dr === 1, u: dr === -1 }; nb[1] = { r: dc === -1, l: dc === 1, d: dr === -1, u: dr === 1 }; }
    cells.forEach(([r, c, v], i) => { if (r >= VIS_TOP) drawPuyo(x0 + c * CELL, y0 + (r - VIS_TOP) * CELL, v, nb[i]); });
    // 떨어질 자리 표시
    let rr = p.piece.r; while (L.fits(p.board, p.piece.c, rr + 1, p.piece.rot)) rr++;
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1;
    for (const [r, c] of [[rr, p.piece.c], [rr + L.DR[p.piece.rot], p.piece.c + L.DC[p.piece.rot]]]) if (r >= VIS_TOP) ctx.strokeRect(x0 + c * CELL + 2.5, y0 + (r - VIS_TOP) * CELL + 2.5, CELL - 5, CELL - 5);
  }
  // 질 수 있는 자리 (빨간 X)
  const rx = x0 + L.SPAWN_C * CELL + CELL / 2, ry = y0 + (L.SPAWN_R - VIS_TOP) * CELL + CELL / 2;
  ctx.strokeStyle = 'rgba(255,60,60,.8)'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(rx - 4, ry - 4); ctx.lineTo(rx + 4, ry + 4); ctx.moveTo(rx + 4, ry - 4); ctx.lineTo(rx - 4, ry + 4); ctx.stroke();
  // 반짝임
  for (const f of fxs) {
    if (f.who !== who) continue;
    const k = f.t / f.life, x = x0 + f.c * CELL + CELL / 2, y = y0 + (f.r - VIS_TOP) * CELL + CELL / 2;
    ctx.fillStyle = `rgba(255,255,255,${1 - k})`; ctx.beginPath(); ctx.arc(x, y, 3 + k * 9, 0, 7); ctx.fill();
  }
  // 연쇄 글자
  const cf = chainFx[who];
  if (cf) {
    ctx.font = `bold ${14 + Math.min(8, cf.n)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(255,${230 - cf.n * 16},60,${Math.max(0, 1 - cf.t / 1.4)})`; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
    const y = y0 + BH * 0.35 - cf.t * 12; ctx.strokeText(`${cf.n}연쇄!`, x0 + BW / 2, y); ctx.fillText(`${cf.n}연쇄!`, x0 + BW / 2, y);
  }
  // 받을 방해 뿌요
  const n = p.pending;
  if (n > 0) {
    let rest = n, x = x0, y = y0 - 11;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const [size, unit] of [[30, 6], [6, 4.8], [1, 3]]) {
      while (rest >= size && x < x0 + BW - 6) {
        ctx.fillStyle = 'rgba(230,230,245,.95)'; ctx.beginPath(); ctx.arc(x + unit + 1, y, unit, 0, 7); ctx.fill();
        x += unit * 2 + 2; rest -= size;
      }
    }
  }
}
function drawNext(g) {
  const p = g.players[0];
  const x = mode === 'solo' ? 118 : 112, y = TOP + 6;
  ctx.fillStyle = '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('NEXT', x + 14, y - 8);
  for (let i = 0; i < 2; i++) {
    const [a, b] = p.queue[i];
    const same = a === b;
    const sc = i === 0 ? 1 : 0.8;
    ctx.save(); ctx.translate(x + 14 - CELL / 2 * sc, y + 8 + i * 42 * sc); ctx.scale(sc, sc);
    drawPuyo(0, 0, b, same ? { d: true } : null, false);
    drawPuyo(0, CELL, a, same ? { u: true } : null, false);
    ctx.restore();
  }
}
function drawHud(g) {
  ctx.textBaseline = 'middle'; ctx.font = 'bold 9px sans-serif';
  const me = g.players[0], cpu = g.players[1];
  ctx.textAlign = 'left'; ctx.fillStyle = '#ff8ab8'; ctx.fillText('SCORE', BX[0], 8); ctx.fillStyle = '#fff'; ctx.fillText(String(me.score), BX[0] + 36, 8);
  if (cpu) { ctx.textAlign = 'right'; ctx.fillStyle = '#8ab8ff'; ctx.fillText(String(cpu.score), BX[1] + BW, 8); ctx.textAlign = 'left'; ctx.fillStyle = '#8ab8ff'; ctx.fillText('CPU', BX[1], 8); }
  else { ctx.textAlign = 'right'; ctx.fillStyle = '#ffe14a'; ctx.fillText(`LV ${me.level} · BEST ${Math.max(best, me.score)}`, 246, 8); }
  ctx.textAlign = 'center'; ctx.font = 'bold 8px sans-serif'; ctx.fillStyle = '#ffd0e8';
  ctx.fillText(`최대 ${me.maxChain}연쇄`, cpu ? 128 : 178, TOP + BH + 10);
  if (cpu) { ctx.fillStyle = '#c8d8ff'; ctx.fillText(`${g.levelName === 'easy' ? '쉬움' : g.levelName === 'hard' ? '어려움' : '보통'}`, 128, TOP + 70); }
}
function draw() {
  ctx.fillStyle = '#1a1030'; ctx.fillRect(0, 0, W, CH);
  if (!G) return;
  // 배경 무늬
  ctx.fillStyle = 'rgba(255,255,255,.03)';
  for (let i = 0; i < 12; i++) ctx.fillRect((i * 37 + (clock * 8) % 37) % W, 0, 8, CH);
  if (mode === 'solo') {
    BX[0] = 28;
    drawBoard(G.players[0], 0);
  } else { BX[0] = 10; drawBoard(G.players[0], 0); drawBoard(G.players[1], 1); }
  drawNext(G);
  drawHud(G);
}

let last = 0;
function frame(ts) {
  const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
  last = ts;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

function toggleMute() {
  muted = !muted;
  store.set('puyoMuted', muted ? '1' : '0');
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
}
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('pauseBtn').onclick = (e) => { e.currentTarget.blur(); state === 'paused' ? resume() : pause(); };
document.querySelectorAll('#overlay button').forEach((b) => { b.onclick = () => onOverlayButton(b); });
$('muteBtn').textContent = muted ? '🔇' : '🔊';
$('overlay').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.menu) showMenu(); });

fit();
requestAnimationFrame(frame);
