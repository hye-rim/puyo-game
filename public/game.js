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
let online = false, room = null, netDown = false;        // 온라인 대전: 서버가 판을 계산하고 우리는 그림만 그린다
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
let rotQueue = 0, hardQueue = false;
const KEYS = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right', ArrowDown: 'down', s: 'down', S: 'down' };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && e.target.tagName === 'INPUT') return;                 // 이름·방 코드를 쓰는 중에는 게임 키로 쓰지 않는다
  if (e.key in KEYS) { e.preventDefault(); held.add(KEYS[e.key]); return; }
  if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); if (!e.repeat && state === 'play') rotQueue = -1; return; }
  if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { e.preventDefault(); if (!e.repeat && state === 'play') rotQueue = 1; return; }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (state === 'paused' && !e.repeat) resume();
    else if (state === 'play' && e.key === ' ' && !e.repeat) hardQueue = true;               // 스페이스: 바로 떨어뜨리기
    return;
  }
  if (e.key === 'p' || e.key === 'P') { if (state === 'paused') resume(); else pause(); }
  else if (e.key === 'm' || e.key === 'M') toggleMute();
});
addEventListener('keyup', (e) => { if (e.key in KEYS) held.delete(KEYS[e.key]); });

const pad = $('pad');
let padUp = false;
const PAD_DIRS = ['u', 'd', 'l', 'r'];
function padFrom(e) {
  const r = pad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const dead = r.width * 0.14;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  padHeld = { left: false, right: false, down: false };
  let up = false;
  if (Math.max(Math.abs(dx), Math.abs(dy)) >= dead) {
    if (horizontal) { if (dx > 0) padHeld.right = true; else padHeld.left = true; }
    else if (dy > 0) padHeld.down = true;
    else up = true;
  }
  if (up && !padUp) { if (state === 'play') hardQueue = true; }                // 패드를 위로 밀면 바로 떨어뜨린다 (밀 때 한 번)
  padUp = up;
  const knob = pad.querySelector('b'), lim = r.width * 0.2;
  knob.style.transform = `translate(${Math.max(-lim, Math.min(lim, dx))}px, ${Math.max(-lim, Math.min(lim, dy))}px)`;
  const on = { u: up, d: padHeld.down, l: padHeld.left, r: padHeld.right };
  pad.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', !!on[PAD_DIRS[i]]));
}
const padEnd = () => { padUp = false; padHeld = { left: false, right: false, down: false }; pad.querySelector('b').style.transform = ''; pad.querySelectorAll('i').forEach((el) => el.classList.remove('on')); };
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
  const input = { left: false, right: false, down, rotate: rotQueue, hard: hardQueue };
  rotQueue = 0; hardQueue = false;
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
  leaveOnline();
  state = 'title';
  showOverlay(`<h1>뿌요뿌요</h1><p>같은 색 뿌요를 <b>4개 이상</b> 이어 붙여 터뜨려요!<br>연쇄로 상대에게 <b>방해 뿌요</b>를 보내요 🟢🔴</p>
    <div class="row"><button id="startBtn" data-mode="vs" data-level="easy">컴퓨터 대전 · 쉬움</button></div>
    <div class="row"><button class="sub" data-mode="vs" data-level="normal">보통</button><button class="sub" data-mode="vs" data-level="hard">어려움</button><button class="sub" data-mode="solo">혼자 연습</button></div>
    <div class="row"><button class="sub" data-act="online">🌐 온라인 대전${(() => { const r = loadJson(ONLINE_KEY); return r.w || r.l ? ` · ${r.w || 0}승 ${r.l || 0}패` : ''; })()}</button></div>`);
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
  if (btn && btn.dataset && btn.dataset.act) { onlineAct(btn); return; }
  if (state === 'paused') { resume(); return; }
  if (btn && btn.dataset && btn.dataset.mode) { startGame(btn.dataset.mode, btn.dataset.level); return; }
  if (btn && btn.dataset && btn.dataset.again) { startGame(mode, levelName); return; }
  showMenu();
}
function pause() {
  if (state !== 'play' || online) return;
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
    else if (e.t === 'land' || e.t === 'hard') { if (e.who === 0) sfx.land(); tutorialSignal(e.t === 'hard' && e.who === 0 ? 'hard' : 'land'); }
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
  if (online) { updateOnline(dt); return; }
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
  const x = mode === 'solo' ? 136 : 112, y = TOP + 6;
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
  if (cpu) { ctx.textAlign = 'right'; ctx.fillStyle = '#8ab8ff'; ctx.fillText(String(cpu.score), BX[1] + BW, 8); ctx.textAlign = 'left'; ctx.fillStyle = '#8ab8ff'; ctx.fillText(g.oppName || 'CPU', BX[1], 8); }
  else { ctx.textAlign = 'right'; ctx.fillStyle = '#ffe14a'; ctx.fillText(`LV ${me.level} · BEST ${Math.max(best, me.score)}`, 204, 8); }
  ctx.textAlign = 'center'; ctx.font = 'bold 8px sans-serif'; ctx.fillStyle = '#ffd0e8';
  ctx.fillText(`최대 ${me.maxChain}연쇄`, cpu ? 128 : 178, TOP + BH + 10);
  if (cpu && !g.oppName) { ctx.fillStyle = '#c8d8ff'; ctx.fillText(`${g.levelName === 'easy' ? '쉬움' : g.levelName === 'hard' ? '어려움' : '보통'}`, 128, TOP + 70); }
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


// ---------- 온라인 대전 ----------
const ONLINE_KEY = 'puyoOnline', SESSION_KEY = 'puyoSession', NAME_KEY = 'puyoName';
function loadJson(k) { try { return JSON.parse(store.get(k)) || {}; } catch (_) { return {}; } }
function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) { return null; } }
function saveSession(v) { try { v ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)) : sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
const myName = () => store.get(NAME_KEY) || '';
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let lastRec = '', lastPopSig = [null, null];

const net = {
  ws: null, pulse: null, outbox: [], retry: 0,
  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${location.pathname}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw('hello', { name: myName() });
      const s = loadSession();
      if (s) this.raw('resume', s);
      for (const [t, p] of this.outbox.splice(0)) this.raw(t, p);
      clearInterval(this.pulse);
      this.pulse = setInterval(() => this.raw('pulse'), 10000);
    };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
    ws.onclose = () => {
      clearInterval(this.pulse);
      if (this.ws !== ws) return;
      this.ws = null;
      if (!online) return;
      if (room || loadSession()) {
        netDown = true; showOverlay('<h2>연결이 끊겼어요</h2><p>다시 연결하는 중…</p>');
        setTimeout(() => { if (online) this.connect(); }, Math.min(4000, 500 * 2 ** this.retry++));
      } else showOnline('서버와 연결이 끊겼어요. 다시 시도해 주세요.');
    };
  },
  send(t, p = {}) {
    if (this.ws && this.ws.readyState === 1) this.raw(t, p);
    else { this.outbox.push([t, p]); this.connect(); }
  },
  raw(t, p = {}) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t, ...p })); },
  close() {
    const ws = this.ws;
    this.ws = null; this.outbox = [];
    clearInterval(this.pulse);
    if (ws) ws.close();
  },
};

function leaveOnline() {
  if (!online) return;
  net.send('leave'); net.close();
  saveSession(null);
  online = false; room = null; netDown = false; G = null; fxs = [];
  $('resignBtn').style.display = 'none';
}

function mapPlayer(f) {
  const rows = [];
  for (let r = 0; r < L.ROWS; r++) rows.push(Array.from(f.b.slice(r * 6, r * 6 + 6), Number));
  return {
    board: rows, piece: f.pc ? { c: f.pc[0], r: f.pc[1], rot: f.pc[2], a: f.pc[3], b: f.pc[4] } : null, phase: f.ph, queue: f.q,
    score: f.sc, pending: f.pd, maxChain: f.mc, sent: f.sn, level: f.lv, chain: f.ch,
    popping: f.pop ? { cells: f.pop.map((i) => [Math.floor(i / 6), i % 6]) } : null,
  };
}
// 서버가 보낸 판 모양을 내 판(왼쪽)과 상대 판(오른쪽)으로 바꿔 놓는다
function applyFrame(frame) {
  if (!room || !frame) return;
  const you = room.you, opp = room.players.find((p) => p.color !== you);
  const mine = mapPlayer(frame.p[you]), theirs = mapPlayer(frame.p[1 - you]);
  G = { mode: 'vs', levelName: 'online', oppName: opp ? opp.name : '상대', players: [mine, theirs] };
  [mine, theirs].forEach((pl, side) => {                                    // 새로 터지기 시작하면 반짝임을 낸다
    const sig = pl.popping ? pl.popping.cells.join(',') : null;
    if (sig && sig !== lastPopSig[side]) for (const [r, c] of pl.popping.cells) fxs.push({ kind: 'spark', who: side, r, c, t: 0, life: 0.5 });
    lastPopSig[side] = sig;
  });
}

function onNet(m) {
  if (m.t === 'queued') showQueued();
  else if (m.t === 'room') applyRoom(m);
  else if (m.t === 's') applyFrame(m);
  else if (m.t === 'ev') onServerEvent(m);
  else if (m.t === 'error') { room = null; saveSession(null); showOnline(m.msg); }
  else if (m.t === 'resumeFailed') {
    saveSession(null);
    if (room) { room = null; showOnline('대국이 끝나서 이어갈 수 없어요.'); }
  }
}
function onServerEvent(m) {
  if (!room) return;
  const side = m.who === room.you ? 0 : 1;
  if (m.e === 'pop') { if (side === 0) sfx.pop(m.chain); if (m.chain >= 2) chainFx[side] = { n: m.chain, t: 0 }; }
  else if (m.e === 'send') { if (side === 0) sfx.send(); }
  else if (m.e === 'nuisance') { if (side === 0) sfx.nuisance(); }
  else if (m.e === 'land') { if (side === 0) sfx.land(); }
}

function applyRoom(r) {
  const fresh = !room || room.code !== r.code || room.games !== r.games;
  room = r; netDown = false;
  saveSession({ code: r.code, token: r.token });
  if (fresh) { fxs = []; chainFx[0] = chainFx[1] = null; lastPopSig = [null, null]; held.clear(); das.dir = 0; rotQueue = 0; sentDown = false; }
  if (r.state === 'waiting') { state = 'title'; showWaiting(); return; }
  applyFrame(r.g);
  if (r.state === 'playing') {
    state = 'play';
    if (fresh) sfx.start();
    hideOverlay();
    $('resignBtn').style.display = '';
    if (r.players.some((p) => !p.online)) showOverlay('<h2>상대 연결이 끊겼어요</h2><p>잠깐 기다려요 (30초)</p>');
  } else if (r.state === 'over') {
    state = 'over';
    $('resignBtn').style.display = 'none';
    afterOver();
  }
}
function afterOver() {
  const r = room;
  const key = `${r.code}:${r.games}:${r.reason}:${r.winner}`;
  const won = r.winner === r.you;
  if (lastRec !== key) {
    lastRec = key;
    const rec = loadJson(ONLINE_KEY);
    if (won) { rec.w = (rec.w || 0) + 1; sfx.win(); } else { rec.l = (rec.l || 0) + 1; sfx.lose(); }
    store.set(ONLINE_KEY, JSON.stringify(rec));
  }
  showResult();
}
function showResult() {
  const r = room;
  const won = r.winner === r.you;
  const why = { dead: won ? '상대 판이 가득 찼어요' : '내 판이 가득 찼어요', resign: won ? '상대가 기권했어요' : '기권했어요', left: won ? '상대가 나갔어요' : '연결이 끊겨 패배했어요' }[r.reason] || '';
  const rec = loadJson(ONLINE_KEY);
  const opp = r.players.find((p) => p.color !== r.you);
  const iVoted = r.rematch.includes(r.you), theyVoted = opp && r.rematch.includes(opp.color);
  const st = r.stats ? r.stats[r.you] : null;
  let again;
  if (!opp) again = '<p>상대가 방을 나갔어요</p>';
  else if (iVoted) again = '<p>상대를 기다리는 중…</p>';
  else again = `${theyVoted ? '<p>상대가 한 판 더 하고 싶어해요!</p>' : ''}<button data-act="rematch">한 판 더</button>`;
  showOverlay(`
    <h2>${won ? '🎉 승리!' : '😵 패배'}</h2>
    ${why ? `<p>${esc(why)}</p>` : ''}
    ${st ? `<p class="big">${st.score.toLocaleString()}점</p><p>최대 ${st.maxChain}연쇄 · 방해 뿌요 ${st.sent}개 보냄</p>` : ''}
    <span class="tag">온라인 ${rec.w || 0}승 ${rec.l || 0}패</span>
    <div class="col">${again}<div class="row"><button class="sub" data-act="view">판 보기</button><button class="sub" data-act="leave">나가기</button></div></div>`);
}

function showOnline(error = '') {
  leaveOnline();
  online = true; state = 'title'; G = null; mode = 'vs';
  showOverlay(`
    <h2>🌐 온라인 대전</h2>
    <input id="nameInput" maxlength="10" placeholder="내 이름 (최대 10자)" value="${esc(myName())}" autocomplete="off">
    <div class="col">
      <button data-act="quick">⚡ 빠른 대전</button>
      <button class="sub" data-act="create">방 만들기</button>
      <div class="row"><input id="codeInput" maxlength="4" placeholder="방 코드" autocomplete="off" autocapitalize="characters" style="width:110px"><button class="sub" data-act="join">들어가기</button></div>
    </div>
    <span class="error">${esc(error)}</span>
    <button class="sub" data-act="home">← 처음으로</button>`);
}
function showQueued() {
  showOverlay(`<h2>상대를 찾는 중…</h2><p>누군가 빠른 대전을 누르면 바로 시작해요</p><button class="sub" data-act="cancel">취소</button>`);
}
const inviteUrl = () => `${location.origin}${location.pathname}?room=${room.code}`;
function showWaiting() {
  showOverlay(`
    <h2>친구를 기다리는 중…</h2>
    <p>방 코드</p>
    <div class="code">${esc(room.code)}</div>
    <p>친구가 <b>온라인 대전 → 들어가기</b>에<br>이 코드를 넣으면 시작해요</p>
    <button data-act="copy">🔗 초대 링크 복사</button>
    <button class="sub" data-act="cancel">취소</button>`);
}
function saveName() {
  const input = $('nameInput');
  if (!input) return;
  const name = input.value.trim().slice(0, 10);
  store.set(NAME_KEY, name);
  net.send('hello', { name });
}
function confirmResign() {
  showOverlay(`<h2>기권할까요?</h2><p>이번 판은 패배로 기록돼요</p><div class="row"><button data-act="close">계속하기</button><button class="sub" data-act="resign">🏳 기권</button></div>`);
}

function onlineAct(btn) {
  const act = btn.dataset.act;
  btn.blur && btn.blur();
  if (act === 'online') showOnline();
  else if (act === 'quick') { saveName(); net.send('quick'); }
  else if (act === 'create') { saveName(); net.send('create'); }
  else if (act === 'join') { saveName(); const code = $('codeInput') ? $('codeInput').value.trim() : ''; if (code) net.send('join', { code }); }
  else if (act === 'cancel') { net.send('cancel'); showOnline(); }
  else if (act === 'home') showMenu();
  else if (act === 'rematch') net.send('rematch');
  else if (act === 'view') hideOverlay();
  else if (act === 'leave') showMenu();
  else if (act === 'copy') { try { navigator.clipboard.writeText(inviteUrl()); btn.textContent = '✔ 복사했어요'; } catch (_) { btn.textContent = inviteUrl(); } }
  else if (act === 'resign') { net.send('resign'); hideOverlay(); }
  else if (act === 'close') hideOverlay();
}
$('resignBtn').onclick = (e) => { e.currentTarget.blur(); if (online && room && room.state === 'playing') confirmResign(); };
$('overlay').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') { const b = $('overlay').querySelector('[data-act="join"]'); if (b) b.click(); }
  if (e.target.id === 'nameInput') { const b = $('overlay').querySelector('[data-act="quick"]'); if (b) b.click(); }
  e.stopPropagation();
});

// 서버에 보내는 입력: 한 번 누를 때마다 한 번(길게 누르면 반복), 아래는 누르고 있는지만
let sentDown = false;
function updateOnline(dt) {
  if (state !== 'play' || !room || room.state !== 'playing' || netDown) return;
  const input = readInput(dt);
  if (input.left) { net.send('cmd', { c: 'L' }); sfx.move(); tutorialSignal('move'); }
  if (input.right) { net.send('cmd', { c: 'R' }); sfx.move(); tutorialSignal('move'); }
  if (input.rotate) { net.send('cmd', { c: input.rotate < 0 ? 'ZL' : 'ZR' }); sfx.rotate(); }
  if (input.hard) { net.send('cmd', { c: 'H' }); sfx.land(); }
  if (input.down !== sentDown) { sentDown = input.down; net.send('down', { v: sentDown }); }
  for (const f of fxs) f.t += dt;
  fxs = fxs.filter((f) => f.t < f.life);
  for (let i = 0; i < 2; i++) if (chainFx[i]) { chainFx[i].t += dt; if (chainFx[i].t > 1.4) chainFx[i] = null; }
}

// ---------- 시작 ----------
const invite = new URLSearchParams(location.search).get('room');
if (invite) { try { window.history.replaceState(null, '', location.pathname); } catch (_) {} }
if (loadSession()) {
  online = true;
  showOverlay('<h2>대국으로 돌아가는 중…</h2>');
  net.connect();
  const wait = setInterval(() => { if (room || !loadSession()) { clearInterval(wait); if (!room) { invite ? (showOnline(), net.send('join', { code: invite.toUpperCase() })) : showOnline(); } } }, 100);
} else if (invite) { showOnline(); net.send('join', { code: invite.toUpperCase() }); }

fit();
requestAnimationFrame(frame);
