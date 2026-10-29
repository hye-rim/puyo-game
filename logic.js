'use strict';
// 뿌요뿌요(1992) 스타일 규칙. 화면 없이 Node 에서 시험한다 (DOM 을 쓰지 않는다).
// 판은 6칸 x 12줄(눈에 보이는 줄) + 맨 위에 보이지 않는 줄 하나(0번 줄). 칸 값: 0 비어 있음 · 1~5 색깔 · 9 방해 뿌요(오자마).
// 한 번에 두 개짜리 덩어리가 내려오고, 아래쪽 뿌요(축)를 중심으로 돌린다. 같은 색이 상하좌우로 4개 이상 이어지면 터지고, 위의 뿌요가 내려와 또 터지면 연쇄.
const LOGIC_PUYO = (() => {
const COLS = 6, ROWS = 13, VIS_TOP = 1;                      // 0번 줄은 보이지 않는다
const EMPTY = 0, OJAMA = 9, SPAWN_C = 2, SPAWN_R = 1;
const DC = [0, 1, 0, -1], DR = [-1, 0, 1, 0];                // 짝 뿌요가 축에서 위·오른쪽·아래·왼쪽에 있는 방향 (rot 0~3)
const NUISANCE_TARGET = 70, NUISANCE_MAX = 30;
// 1992 원작의 연쇄 배수표와 색깔·무리 보너스 (Puyo Nexus 의 점수 표)
const CHAIN_POWER = [0, 0, 8, 16, 32, 64, 128, 256, 512];     // 9연쇄부터는 999
const COLOR_BONUS = [0, 0, 3, 6, 12, 24];
const GROUP_BONUS = { 4: 0, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7 };
const FALL_BASE = 0.62, SOFT_DROP = 0.04, LOCK_DELAY = 0.35, POP_TIME = 0.5, SETTLE_STEP = 0.045, SPAWN_DELAY = 0.22;
const LEVELS = { easy: { color: 4, think: 0.55, mistakes: 0.35, depth: 0 }, normal: { color: 4, think: 0.32, mistakes: 0.12, depth: 1 }, hard: { color: 4, think: 0.16, mistakes: 0.02, depth: 2 } };

const rng = (seed) => {                                      // mulberry32 (시험용 고정 난수)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const emit = (g, e) => { g.events.push(e); };

// ---------- 판 다루기 (순수 함수) ----------
const newBoard = () => Array.from({ length: ROWS }, () => new Array(COLS).fill(EMPTY));
const cloneBoard = (b) => b.map((r) => r.slice());
const inCols = (c) => c >= 0 && c < COLS;

// 같은 색이 이어진 무리를 찾는다 (색깔 뿌요만, 보이지 않는 줄은 제외). size>=4 인 것만 돌려준다
function findGroups(b) {
  const seen = new Set(), groups = [];
  for (let r = VIS_TOP; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const v = b[r][c], key = r * COLS + c;
    if (v === EMPTY || v === OJAMA || seen.has(key)) continue;
    const cells = [], q = [[r, c]]; seen.add(key);
    for (let i = 0; i < q.length; i++) {
      const [rr, cc] = q[i]; cells.push([rr, cc]);
      for (let d = 0; d < 4; d++) {
        const nr = rr + DR[d], nc = cc + DC[d], k = nr * COLS + nc;
        if (nr < VIS_TOP || nr >= ROWS || !inCols(nc) || seen.has(k) || b[nr][nc] !== v) continue;
        seen.add(k); q.push([nr, nc]);
      }
    }
    if (cells.length >= 4) groups.push({ color: v, cells });
  }
  return groups;
}
// 터지는 칸 옆의 방해 뿌요도 함께 터진다
function ojamaNextTo(b, groups) {
  const out = new Set();
  for (const gr of groups) for (const [r, c] of gr.cells) for (let d = 0; d < 4; d++) {
    const nr = r + DR[d], nc = c + DC[d];
    if (nr >= VIS_TOP && nr < ROWS && inCols(nc) && b[nr][nc] === OJAMA) out.add(nr * COLS + nc);
  }
  return [...out].map((k) => [Math.floor(k / COLS), k % COLS]);
}
// 한 번 터질 때의 점수: (10 x 터진 수) x (연쇄 배수 + 색깔 보너스 + 무리 보너스), 배수 합은 1~999
function popScore(chain, groups) {
  const pc = groups.reduce((s, g) => s + g.cells.length, 0);
  const cp = chain >= CHAIN_POWER.length ? 999 : CHAIN_POWER[chain];
  const colors = new Set(groups.map((g) => g.color)).size;
  const gb = groups.reduce((s, g) => s + (g.cells.length >= 11 ? 10 : GROUP_BONUS[g.cells.length] || 0), 0);
  const mult = Math.max(1, Math.min(999, cp + COLOR_BONUS[colors] + gb));
  return { points: 10 * pc * mult, pc, mult };
}
// 위가 비면 뿌요가 내려온다. 움직인 칸이 있으면 true
function settleOnce(b) {
  let moved = false;
  for (let c = 0; c < COLS; c++) for (let r = ROWS - 2; r >= 0; r--) {
    if (b[r][c] !== EMPTY && b[r + 1][c] === EMPTY) { b[r + 1][c] = b[r][c]; b[r][c] = EMPTY; moved = true; }
  }
  return moved;
}
const settleAll = (b) => { while (settleOnce(b)) { /* 다 내려올 때까지 */ } };

// 놓은 판이 연쇄로 어떻게 되는지 (AI 와 시험용). 방해 뿌요도 터뜨린다
function simulate(board) {
  const b = cloneBoard(board);
  settleAll(b);
  let chain = 0, total = 0, nuisance = 0, left = 0, cleared = 0;
  for (;;) {
    const groups = findGroups(b);
    if (!groups.length) break;
    chain++;
    const sc = popScore(chain, groups);
    total += sc.points; cleared += sc.pc;
    const np = sc.points / NUISANCE_TARGET + left;
    const nc = Math.floor(np); left = np - nc; nuisance += nc;
    for (const gr of groups) for (const [r, c] of gr.cells) b[r][c] = EMPTY;
    for (const [r, c] of ojamaNextTo(b, groups)) b[r][c] = EMPTY;
    settleAll(b);
  }
  return { board: b, chain, score: total, nuisance, cleared };
}

// ---------- 덩어리 ----------
function fits(b, c, r, rot) {
  const pc = c + DC[rot], pr = r + DR[rot];
  if (!inCols(c) || !inCols(pc) || r < 0 || r >= ROWS || pr < 0 || pr >= ROWS) return false;
  return b[r][c] === EMPTY && b[pr][pc] === EMPTY;
}
function pairCells(p) { return [[p.r, p.c, p.a], [p.r + DR[p.rot], p.c + DC[p.rot], p.b]]; }

// ---------- 한 사람의 판 ----------
function newPlayer(rand, opts = {}) {
  const colors = opts.colors || 4;
  const p = {
    board: newBoard(), colors, rand, score: 0, level: opts.level || 1, pieces: 0, pops: 0,
    queue: [], piece: null, phase: 'spawn', t: SPAWN_DELAY, fallT: 0, lockT: 0,
    chain: 0, chainScore: 0, leftover: 0, pending: 0, sent: 0, maxChain: 0, popping: null, settleT: 0, dead: false, won: false,
    bestChain: 0, ai: null,
  };
  for (let i = 0; i < 3; i++) p.queue.push(randomPair(p));
  return p;
}
function randomPair(p) { return [1 + Math.floor(p.rand() * p.colors), 1 + Math.floor(p.rand() * p.colors)]; }

function spawn(g, p) {
  const [a, b] = p.queue.shift(); p.queue.push(randomPair(p));
  if (p.board[SPAWN_R][SPAWN_C] !== EMPTY || p.board[SPAWN_R - 1][SPAWN_C] !== EMPTY) { die(g, p); return; }
  p.piece = { c: SPAWN_C, r: SPAWN_R, rot: 0, a, b };
  p.phase = 'fall'; p.fallT = 0; p.lockT = 0;
  p.pieces++;
  emit(g, { t: 'spawn', who: p.id });
}
function die(g, p) {
  p.dead = true; p.phase = 'dead'; p.piece = null;
  emit(g, { t: 'dead', who: p.id });
  const o = g.players.find((x) => x !== p);
  if (o && !o.dead) { o.won = true; g.over = true; g.winner = o.id; emit(g, { t: 'over', winner: o.id }); }
  else if (g.mode === 'solo') { g.over = true; g.winner = -1; emit(g, { t: 'over', winner: -1 }); }
}

function movePiece(g, p, dc) {
  if (p.phase !== 'fall' || !p.piece) return false;
  const q = p.piece;
  if (!fits(p.board, q.c + dc, q.r, q.rot)) return false;
  q.c += dc; p.lockT = 0;
  emit(g, { t: 'move', who: p.id });
  return true;
}
function rotatePiece(g, p, dir) {
  if (p.phase !== 'fall' || !p.piece) return false;
  const q = p.piece, b = p.board;
  const nr = (q.rot + dir + 4) % 4;
  let ok = false;
  if (fits(b, q.c, q.r, nr)) { q.rot = nr; ok = true; }
  else {
    // 벽이나 다른 뿌요에 걸리면 반대쪽으로 한 칸 밀어 본다 (아래로 돌릴 땐 위로)
    const kc = -DC[nr], kr = -DR[nr];
    if (DC[nr] !== 0 && fits(b, q.c + kc, q.r, nr)) { q.c += kc; q.rot = nr; ok = true; }
    else if (DR[nr] > 0 && fits(b, q.c, q.r - 1, nr)) { q.r -= 1; q.rot = nr; ok = true; }
    else if (DC[nr] !== 0 && !fits(b, q.c - DC[nr], q.r, nr)) {                          // 양쪽이 다 막히면 위아래를 뒤집는다
      const flip = (q.rot + 2) % 4;
      if (fits(b, q.c, q.r, flip)) { q.rot = flip; ok = true; }
    }
    void kr;
  }
  if (ok) { p.lockT = 0; emit(g, { t: 'rotate', who: p.id }); }
  return ok;
}

// 덩어리를 판에 놓는다 → 내려앉기와 터지기로 넘어간다
function lock(g, p) {
  for (const [r, c, v] of pairCells(p.piece)) p.board[r][c] = v;
  p.piece = null;
  p.chain = 0; p.chainScore = 0;
  p.phase = 'settle'; p.settleT = 0;
  emit(g, { t: 'land', who: p.id });
}

function doPop(g, p, groups) {
  p.chain++;
  const sc = popScore(p.chain, groups);
  p.score += sc.points; p.chainScore += sc.points; p.pops += sc.pc;
  p.maxChain = Math.max(p.maxChain, p.chain);
  const np = sc.points / NUISANCE_TARGET + p.leftover;
  const nc = Math.floor(np); p.leftover = np - nc;
  const cells = groups.flatMap((gr) => gr.cells);
  const oj = ojamaNextTo(p.board, groups);
  p.popping = { cells: cells.concat(oj), t: 0, chain: p.chain };
  emit(g, { t: 'pop', who: p.id, chain: p.chain, n: sc.pc, points: sc.points, mult: sc.mult, cells: cells.slice(), colors: groups.map((x) => x.color) });
  if (nc > 0) {
    p.sent += nc;
    const o = g.players.find((x) => x !== p);
    if (o && !o.dead) o.pending += nc;                       // 원작에는 상쇄가 없어서 받은 쪽에 그대로 쌓인다
    emit(g, { t: 'send', who: p.id, n: nc });
  }
  p.phase = 'pop'; p.settleT = 0;
}

// 방해 뿌요를 위에서 떨어뜨린다 (한 번에 최대 30개, 모자란 줄은 무작위 칸)
function dropNuisance(g, p) {
  let n = Math.min(NUISANCE_MAX, p.pending);
  if (n <= 0) return false;
  p.pending -= n;
  const fullRows = Math.floor(n / COLS), extra = n % COLS;
  let row = 0;
  for (let i = 0; i < fullRows && row < 6; i++, row++) for (let c = 0; c < COLS; c++) if (p.board[row][c] === EMPTY) p.board[row][c] = OJAMA;
  if (extra && row < 6) {
    const cols = [0, 1, 2, 3, 4, 5].sort(() => p.rand() - 0.5).slice(0, extra);
    for (const c of cols) if (p.board[row][c] === EMPTY) p.board[row][c] = OJAMA;
  }
  emit(g, { t: 'nuisance', who: p.id, n });
  p.phase = 'settle'; p.settleT = 0; p.chain = 0;
  return true;
}

function updatePlayer(g, p, h, input) {
  if (p.dead || g.over) return;
  const speed = FALL_BASE * Math.pow(0.9, p.level - 1);
  switch (p.phase) {
    case 'spawn':
      p.t -= h;
      if (p.t <= 0) spawn(g, p);
      break;
    case 'fall': {
      const q = p.piece;
      if (input) {
        if (input.left) movePiece(g, p, -1);
        if (input.right) movePiece(g, p, 1);
        if (input.rotate) rotatePiece(g, p, input.rotate);
      }
      const interval = input && input.down ? SOFT_DROP : Math.max(0.1, speed);
      p.fallT += h;
      if (fits(p.board, q.c, q.r + 1, q.rot)) {
        if (p.fallT >= interval) { p.fallT = 0; q.r++; p.lockT = 0; if (input && input.down) { p.score += 1; } }
      } else {
        p.lockT += h;
        if ((input && input.down && p.lockT > 0.05) || p.lockT >= LOCK_DELAY) lock(g, p);
      }
      break;
    }
    case 'settle':
      p.settleT += h;
      while (p.settleT >= SETTLE_STEP) { p.settleT -= SETTLE_STEP; if (!settleOnce(p.board)) break; }
      if (!settleOnce(cloneBoard(p.board))) {                 // 다 내려왔다
        const groups = findGroups(p.board);
        if (groups.length) doPop(g, p, groups);
        else finishTurn(g, p);
      }
      break;
    case 'pop':
      p.settleT += h;
      if (p.settleT >= POP_TIME) {
        for (const [r, c] of p.popping.cells) p.board[r][c] = EMPTY;
        p.popping = null;
        p.phase = 'settle'; p.settleT = 0;
      }
      break;
    default: break;
  }
}

// 연쇄가 끝났다: 받은 방해 뿌요가 있으면 떨어뜨리고, 아니면 다음 덩어리
function finishTurn(g, p) {
  if (p.chain > 0) emit(g, { t: 'chainEnd', who: p.id, chain: p.chain, score: p.chainScore });
  if (p.board[SPAWN_R][SPAWN_C] !== EMPTY) { die(g, p); return; }
  if (p.pending > 0 && dropNuisance(g, p)) {
    if (p.board[SPAWN_R][SPAWN_C] !== EMPTY && !settleOnce(cloneBoard(p.board))) { /* 쌓여 있는 채로 이어서 처리 */ }
    return;
  }
  if (g.mode === 'solo') p.level = 1 + Math.floor(p.pops / 40);
  p.phase = 'spawn'; p.t = SPAWN_DELAY;
}

// ---------- 컴퓨터 ----------
function placements(p) {
  const out = [];
  const [a, b] = [p.piece ? p.piece.a : p.queue[0][0], p.piece ? p.piece.b : p.queue[0][1]];
  for (let rot = 0; rot < 4; rot++) for (let c = 0; c < COLS; c++) {
    const pc = c + DC[rot];
    if (!inCols(pc)) continue;
    // 떨어뜨려 본다: 축은 위에서 내려오다 처음 막히는 곳
    const bd = cloneBoard(p.board);
    let r = SPAWN_R;
    if (!fits(bd, c, r, rot)) continue;
    while (fits(bd, c, r + 1, rot)) r++;
    bd[r][c] = a; bd[r + DR[rot]][pc] = b;
    out.push({ c, rot, board: bd });
  }
  return out;
}
function heightOf(b, c) { for (let r = 0; r < ROWS; r++) if (b[r][c] !== EMPTY) return ROWS - r; return 0; }
function evalBoard(b, opp, lv) {
  const sim = simulate(b);
  let score = 0;
  // 터지는 것: 연쇄가 길수록 크게, 방해 뿌요를 막아야 하거나 크게 보낼 수 있을 때 더
  const danger = opp.pendingSelf >= 6;
  if (sim.chain > 0) score += sim.chain * sim.chain * 40 + sim.nuisance * 6 + (danger ? 60 : 0) + (sim.chain === 1 ? -25 : 0);
  // 같은 색이 붙어 있는 정도(곧 터질 만한 모양)
  const after = sim.board;
  for (let r = VIS_TOP; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const v = after[r][c];
    if (v === EMPTY || v === OJAMA) continue;
    if (c + 1 < COLS && after[r][c + 1] === v) score += 4 + lv.depth * 2;
    if (r + 1 < ROWS && after[r + 1][c] === v) score += 4 + lv.depth * 2;
  }
  // 높이: 가운데 열(축이 나오는 곳)이 높으면 위험
  let hmax = 0;
  for (let c = 0; c < COLS; c++) { const h = heightOf(after, c); hmax = Math.max(hmax, h); score -= h * 1.2; if (c > 0) score -= Math.abs(h - heightOf(after, c - 1)) * 1.1; }
  if (heightOf(after, SPAWN_C) >= 10) score -= 400;
  if (hmax >= 12) score -= 5000;
  return score;
}
function aiPlan(g, p) {
  const lv = g.level;
  const opts = placements(p);
  if (!opts.length) return null;
  const opp = { pendingSelf: p.pending };
  let best = null, bs = -1e9;
  for (const o of opts) { const s = evalBoard(o.board, opp, lv) + p.rand() * 2; if (s > bs) { bs = s; best = o; } }
  if (p.rand() < lv.mistakes) best = opts[Math.floor(p.rand() * opts.length)];
  return best;
}
function aiAct(g, p, h) {
  if (!p.piece || p.phase !== 'fall') { p.ai = null; return null; }
  const lv = g.level;
  if (!p.ai || p.ai.piece !== p.piece) p.ai = { piece: p.piece, plan: aiPlan(g, p), t: lv.think * 0.5 };
  const a = p.ai;
  if (!a.plan) return null;
  a.t -= h;
  if (a.t > 0) return null;
  a.t = lv.think * 0.4;
  const q = p.piece, target = a.plan;
  if (q.rot !== target.rot) return { rotate: ((target.rot - q.rot + 4) % 4) === 3 ? -1 : 1 };
  if (q.c < target.c) return { right: true };
  if (q.c > target.c) return { left: true };
  return { down: true };
}

// ---------- 게임 ----------
function newGame(rand = Math.random, mode = 'vs', level = 'normal') {
  const g = { mode, rand, events: [], players: [], over: false, winner: null, level: LEVELS[level] || LEVELS.normal, time: 0, levelName: level };
  const seed = Math.floor(rand() * 1e9);
  const pa = newPlayer(rng(seed), {}); pa.id = 0;
  g.players.push(pa);
  if (mode === 'vs') { const pb = newPlayer(rng(seed), {}); pb.id = 1; g.players.push(pb); }          // 같은 순서의 뿌요를 받는다 (원작처럼 공평하게)
  return g;
}

// input: 사람(0번)의 입력 { left, right, rotate(-1·0·1), down } — left/right/rotate 는 이번에 눌렀을 때만 true
function step(g, dt, input) {
  g.events = [];
  let left = dt;
  while (left > 1e-9 && !g.over) {
    const h = Math.min(left, 1 / 60); left -= h; g.time += h;
    updatePlayer(g, g.players[0], h, input);
    if (input) { input.left = input.right = false; input.rotate = 0; }
    if (g.players[1]) updatePlayer(g, g.players[1], h, aiAct(g, g.players[1], h) || {});
  }
}

return {
  COLS, ROWS, VIS_TOP, EMPTY, OJAMA, SPAWN_C, SPAWN_R, DC, DR, CHAIN_POWER, COLOR_BONUS, GROUP_BONUS, NUISANCE_TARGET, NUISANCE_MAX, LEVELS,
  rng, newBoard, cloneBoard, findGroups, ojamaNextTo, popScore, settleOnce, settleAll, simulate, fits, newGame, newPlayer, step, spawn, lock, movePiece, rotatePiece, doPop, dropNuisance, placements, aiPlan, pairCells,
};
})();
if (typeof module !== 'undefined') module.exports = LOGIC_PUYO;
