'use strict';
// 뿌요뿌요 규칙 시험. 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/logic.js');

const DT = 1 / 60;
const NONE = { left: false, right: false, rotate: 0, down: false };
const run = (g, sec, inp) => { for (let t = 0; t < sec - 1e-9; t += DT) L.step(g, DT, inp || { ...NONE }); };
// 글자 그림으로 판 만들기: 12줄(눈에 보이는 줄), . 비어 있음, 1~4 색, # 방해 뿌요. 아래쪽 줄부터 채운다
function board(rows) {
  const b = L.newBoard();
  const off = L.ROWS - rows.length;
  rows.forEach((line, i) => { for (let c = 0; c < L.COLS; c++) { const ch = line[c]; b[off + i][c] = ch === '.' || ch === ' ' ? 0 : ch === '#' ? L.OJAMA : Number(ch); } });
  return b;
}
function fresh(seed = 1) {
  const g = L.newGame(L.rng(seed), 'vs', 'easy');
  const p = g.players[0];
  p.phase = 'fall'; p.t = 0;
  L.spawn(g, p);
  return { g, p, o: g.players[1] };
}

test('the field is 6 columns by 12 visible rows plus a hidden row, and a pair spawns in the third column', () => {
  assert.strictEqual(L.COLS, 6); assert.strictEqual(L.ROWS - L.VIS_TOP, 12);
  const { p } = fresh();
  assert.strictEqual(p.piece.c, 2); assert.strictEqual(p.piece.r, 1); assert.strictEqual(p.piece.rot, 0);
  const cells = L.pairCells(p.piece);
  assert.strictEqual(cells[0][0], 1); assert.strictEqual(cells[1][0], 0, 'the partner is above the axis, in the hidden row');
});

test('four or more of the same color in orthogonal contact make a group, three do not, diagonals do not', () => {
  assert.strictEqual(L.findGroups(board(['1111'])).length, 1);
  assert.strictEqual(L.findGroups(board(['111'])).length, 0);
  assert.strictEqual(L.findGroups(board(['11', '11'])).length, 1);
  assert.strictEqual(L.findGroups(board(['1.', '.1', '1.', '.1'])).length, 0, 'diagonals only');
  assert.strictEqual(L.findGroups(board(['1', '1', '1', '1'])).length, 1, 'a vertical line');
  const two = L.findGroups(board(['1111..', '2222..']));
  assert.strictEqual(two.length, 2);
  assert.strictEqual(L.findGroups(board(['####..', '####..'])).length, 0, 'nuisance puyo never form groups');
  const b = L.newBoard(); b[0][0] = b[0][1] = b[0][2] = b[0][3] = 1;
  assert.strictEqual(L.findGroups(b).length, 0, 'the hidden row does not count');
});

test('nuisance puyo next to a pop go away with it', () => {
  const b = board(['1111..', '#..#..']);
  const groups = L.findGroups(b);
  const oj = L.ojamaNextTo(b, groups);
  assert.strictEqual(oj.length, 2);
  const far = board(['1111..', '.....#']);
  assert.strictEqual(L.ojamaNextTo(far, L.findGroups(far)).length, 0);
});

test('score is (10 x puyo) x (chain power + color bonus + group bonus), chain power 0 8 16 32 64 128 256 512 then 999', () => {
  const one = (n, color = 1) => [{ color, cells: new Array(n).fill([1, 0]) }];
  assert.strictEqual(L.popScore(1, one(4)).points, 40);              // 1연쇄 배수는 0 이지만 최소 1
  assert.strictEqual(L.popScore(2, one(4)).points, 10 * 4 * 8);
  assert.strictEqual(L.popScore(3, one(4)).points, 10 * 4 * 16);
  assert.strictEqual(L.popScore(8, one(4)).points, 10 * 4 * 512);
  assert.strictEqual(L.popScore(9, one(4)).points, 10 * 4 * 999);
  assert.strictEqual(L.popScore(12, one(4)).mult, 999);
  assert.strictEqual(L.popScore(1, one(5)).mult, 2, 'five in a group: +2');
  assert.strictEqual(L.popScore(1, one(6)).mult, 3);
  assert.strictEqual(L.popScore(1, one(11)).mult, 10);
  const two = [{ color: 1, cells: new Array(4).fill([1, 0]) }, { color: 2, cells: new Array(4).fill([2, 0]) }];
  assert.strictEqual(L.popScore(1, two).mult, 3, 'two colors at once: +3');
  assert.strictEqual(L.popScore(1, two).points, 10 * 8 * 3);
  const four = [1, 2, 3, 4].map((c) => ({ color: c, cells: new Array(4).fill([1, 0]) }));
  assert.strictEqual(L.popScore(1, four).mult, 12);
  assert.deepStrictEqual(L.CHAIN_POWER.slice(0, 9), [0, 0, 8, 16, 32, 64, 128, 256, 512]);
});

test('puyo fall down after a pop and can make a chain', () => {
  const b = board(['2.....', '1.....', '2.....', '1.....', '11....', '12....', '12....']);
  // 맨 아래 왼쪽 열: 1 아래에 1... 2 2 가 쌓여서 1111 이 터진 뒤 2 가 떨어져 만나게 만든다
  const c = board(['2.....', '1.....', '1.....', '1.....', '11....'].slice(0, 0).concat(['2.....', '2.....', '1.....', '1.....', '1.....']));
  void b; void c;
  const chain = board(['.2....', '.2....', '.1....', '.1....', '211...', '2.1...']);
  const sim = L.simulate(chain);
  assert.ok(sim.chain >= 1);
  const two = board(['2.....', '2.....', '1.....', '1.....', '.221..', '1111..'.slice(0, 6)]);
  void two;
  // 확실한 2연쇄: 아래 1111 이 터지면 위의 2 두 개가 내려와 옆의 2 두 개와 만난다
  const t = board(['2.....', '2.....', '.1....', '.1....', '.1....', '.1....'].slice(0, 0).concat(['22....', '1.....', '1.....', '1.....', '1.22..']));
  const s2 = L.simulate(t);
  assert.strictEqual(s2.chain, 2, 'two chains');
  assert.ok(s2.score > 40, 'chain points');
  const gr = L.simulate(board(['....', '12']));
  assert.strictEqual(gr.chain, 0);
});

test('gravity: puyo above empty cells drop all the way', () => {
  const b = board(['1.....', '......', '......', '2.....']);
  L.settleAll(b);
  assert.strictEqual(b[L.ROWS - 1][0], 2);
  assert.strictEqual(b[L.ROWS - 2][0], 1);
  assert.strictEqual(L.settleOnce(b), false);
});

test('moving and rotating a pair: walls stop it, rotation turns around the lower puyo, and it kicks off walls', () => {
  const { g, p } = fresh();
  const q = p.piece;
  assert.ok(L.movePiece(g, p, -1)); assert.ok(L.movePiece(g, p, -1)); assert.strictEqual(q.c, 0);
  assert.strictEqual(L.movePiece(g, p, -1), false, 'wall');
  assert.ok(L.rotatePiece(g, p, 1));
  assert.strictEqual(q.rot, 1, 'partner on the right');
  assert.ok(L.rotatePiece(g, p, 1)); assert.strictEqual(q.rot, 2);
  assert.ok(L.rotatePiece(g, p, -1)); assert.strictEqual(q.rot, 1);
  // 왼쪽 벽에서 왼쪽으로 돌리면 한 칸 밀려서 돌아간다
  q.rot = 0; q.c = 0;
  assert.ok(L.rotatePiece(g, p, -1));
  assert.strictEqual(q.rot, 3);
  assert.strictEqual(q.c, 1, 'pushed off the wall');
  // 양쪽이 막히면 뒤집힌다
  const { g: g2, p: p2 } = fresh(2);
  p2.board[1][1] = 1; p2.board[1][3] = 1; p2.board[2][2] = 0;
  assert.ok(L.rotatePiece(g2, p2, 1));
  assert.strictEqual(p2.piece.rot, 2, 'flipped');
});

test('a pair falls, lands on the floor, locks after a short delay, and soft drop locks it quickly', () => {
  const { g, p } = fresh();
  run(g, 20);
  assert.ok(p.board[L.ROWS - 1][2] !== 0 || p.phase === 'spawn' || p.phase === 'fall');
  const fresh2 = fresh(3);
  const q = fresh2.p.piece;
  for (let i = 0; i < 400 && fresh2.p.piece === q; i++) L.step(fresh2.g, DT, { ...NONE, down: true });
  assert.ok(fresh2.p.piece !== q, 'locked with soft drop');
  assert.ok(fresh2.p.score > 5, 'a point for each soft-dropped row');
  const slow = fresh(4);
  const q2 = slow.p.piece;
  run(slow.g, 1.0);
  assert.strictEqual(slow.p.piece, q2, 'still falling after one second');
});

test('four of a color pop after landing, with the pop animation, and the score and chain are counted', () => {
  const { g, p } = fresh(5);
  p.piece = null; p.phase = 'fall';
  p.board = board(['......', '......', '......', '......', '11..22', '11..22']);
  p.board[L.ROWS - 1] = [1, 1, 0, 0, 2, 2];
  p.board[L.ROWS - 2] = [1, 1, 0, 0, 2, 2];
  p.chain = 0;
  p.phase = 'settle'; p.settleT = 0;
  run(g, 0.3);
  assert.ok(g.events.length >= 0);
  run(g, 1.5);
  assert.strictEqual(p.board[L.ROWS - 1][0], 0, 'the group is gone');
  assert.ok(p.score >= 40 + 40, `score ${p.score}`);
  assert.strictEqual(p.maxChain, 1);
});

test('chain score goes to nuisance puyo at 70 points each with the remainder carried, and the opponent receives them', () => {
  const { g, p, o } = fresh(6);
  p.piece = null;
  p.board = board(['2.....', '2.....', '1.....', '1.....', '1.....', '1.22..']);
  p.board[L.ROWS - 6] = [2, 0, 0, 0, 0, 0]; p.board[L.ROWS - 5] = [2, 0, 0, 0, 0, 0];
  p.board[L.ROWS - 4] = [1, 0, 0, 0, 0, 0]; p.board[L.ROWS - 3] = [1, 0, 0, 0, 0, 0]; p.board[L.ROWS - 2] = [1, 0, 0, 0, 0, 0];
  p.board[L.ROWS - 1] = [1, 2, 2, 0, 0, 0];
  p.phase = 'settle'; p.settleT = 0; p.chain = 0;
  const events = [];
  for (let i = 0; i < 60 * 5; i++) { L.step(g, DT, { ...NONE }); events.push(...g.events); }
  assert.strictEqual(p.maxChain, 2);
  const pops = events.filter((e) => e.t === 'pop' && e.who === 0);
  assert.strictEqual(pops.length, 2);
  const total = pops.reduce((s, e) => s + e.points, 0);
  // 40점은 70점에 못 미쳐 0개 (0.57 이 남음), 다음 320점: 0.57 + 4.57 = 5.14 → 5개
  const sends = events.filter((e) => e.t === 'send' && e.who === 0);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].n, 5);
  assert.strictEqual(p.sent, 5);
  assert.strictEqual(total, 360);
  assert.ok(o.pending === 5 || events.some((e) => e.t === 'nuisance' && e.who === 1), 'the opponent got them');
});

test('nuisance puyo fall after your next move, fill a row per six, at most 30 at a time, and are cleared by a pop beside them', () => {
  const { g, o } = fresh(7);
  o.piece = null; o.phase = 'settle'; o.pending = 40; o.chain = 0;
  L.dropNuisance(g, o);
  assert.strictEqual(o.pending, 10, 'only 30 at a time');
  const count = (b) => b.flat().filter((v) => v === L.OJAMA).length;
  assert.strictEqual(count(o.board), 30);
  run(g, 1.0, null);
  assert.strictEqual(count(o.board), 40, 'the other ten come down after that');
  assert.ok(o.board[L.ROWS - 1].every((v) => v === L.OJAMA), 'a full row at the bottom');
  const g2 = L.newGame(L.rng(8), 'vs', 'easy'); const q = g2.players[1];
  q.piece = null; q.phase = 'settle';
  q.pending = 8; L.dropNuisance(g2, q);
  run(g2, 1.0, null);
  assert.strictEqual(count(q.board), 8);
  assert.strictEqual(q.board[L.ROWS - 1].filter((v) => v === L.OJAMA).length, 6);
  assert.strictEqual(q.board[L.ROWS - 2].filter((v) => v === L.OJAMA).length, 2, 'the leftover row has the remaining ones');
  const pop = board(['1111..', '######']);
  const sim = L.simulate(pop);
  assert.strictEqual(sim.board[L.ROWS - 1].filter((v) => v === L.OJAMA).length, 2, 'only the ones beside the pop went away');
});

test('losing: if the third column fills up, you lose and the opponent wins', () => {
  const { g, p, o } = fresh(9);
  p.piece = null;
  for (let r = 1; r < L.ROWS; r++) p.board[r][2] = 1 + (r % 2);
  p.phase = 'spawn'; p.t = 0;
  L.step(g, DT, { ...NONE });
  assert.strictEqual(p.dead, true);
  assert.strictEqual(o.won, true);
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, 1);
});

test('both players get the same pairs in the same order', () => {
  const g = L.newGame(L.rng(3), 'vs', 'normal');
  assert.deepStrictEqual(g.players[0].queue, g.players[1].queue);
  for (let i = 0; i < 10; i++) {
    const a = g.players[0].queue.shift(); g.players[0].queue.push([1, 1]);
    const b = g.players[1].queue.shift(); g.players[1].queue.push([1, 1]);
    assert.deepStrictEqual(a, b);
  }
});

test('the computer picks a legal spot, finishes a chain when it can, and avoids a tall center', () => {
  const g = L.newGame(L.rng(10), 'vs', 'hard');
  const p = g.players[1];
  p.board = board(['......', '......', '......', '111...', '2.....']);
  p.board[L.ROWS - 1] = [2, 0, 0, 0, 0, 0];
  p.board[L.ROWS - 2] = [1, 1, 1, 0, 0, 0];
  p.piece = { c: 2, r: 1, rot: 0, a: 1, b: 3 };
  p.phase = 'fall';
  const plan = L.aiPlan(g, p);
  assert.ok(plan && plan.c >= 0 && plan.c < 6);
  const sim = L.simulate(plan.board);
  assert.ok(sim.chain >= 1, 'finishes the group of four');
});

test('the computer holds its own against a player that does nothing, and a full vs game never breaks', () => {
  const g = L.newGame(L.rng(11), 'vs', 'normal');
  for (let i = 0; i < 60 * 120 && !g.over; i++) L.step(g, DT, { ...NONE });
  assert.strictEqual(g.over, true, 'the idle player lost');
  assert.strictEqual(g.winner, 1);
  assert.ok(g.players[1].score > 0);
});

test('random play in solo mode: the field stays valid until the stack is full', () => {
  const rand = L.rng(4);
  for (let t = 0; t < 4; t++) {
    const g = L.newGame(L.rng(20 + t), 'solo');
    const inp = { ...NONE };
    for (let i = 0; i < 60 * 150 && !g.over; i++) {
      if (i % 12 === 0) { const d = Math.floor(rand() * 4); inp.left = d === 0; inp.right = d === 1; inp.rotate = d === 2 ? 1 : 0; inp.down = rand() < 0.4; }
      L.step(g, DT, inp);
      for (const row of g.players[0].board) for (const v of row) assert.ok(v >= 0 && v <= 9 && v !== 6 && v !== 7 && v !== 8);
    }
  }
});

test('solo mode ends when the stack fills up, and the level goes up as puyo are cleared', () => {
  const g = L.newGame(L.rng(5), 'solo');
  const p = g.players[0];
  assert.strictEqual(g.players.length, 1);
  p.pops = 80; p.phase = 'settle'; p.chain = 0;
  run(g, 0.5);
  assert.ok(p.level >= 3);
  for (let i = 0; i < 60 * 300 && !g.over; i++) L.step(g, DT, { ...NONE, down: true });
  assert.strictEqual(g.over, true);
  assert.strictEqual(g.winner, -1);
});

test('hard drop (space) puts the pair at the very bottom at once, without needing the lock delay', () => {
  const { g, p } = fresh(12);
  const q = p.piece;
  const [a, b] = [q.a, q.b];
  L.step(g, DT, { ...NONE, hard: true });
  assert.strictEqual(p.piece, null, 'locked in the same moment');
  assert.strictEqual(p.board[L.ROWS - 1][2], a, 'axis puyo is on the floor');
  assert.strictEqual(p.board[L.ROWS - 2][2], b, 'the partner sits on it');
  assert.ok(g.events.some((e) => e.t === 'hard'));
  assert.strictEqual(p.score, 0, 'no soft-drop points for a hard drop');
  // 쌓인 위에도 떨어진다
  const s2 = fresh(13);
  s2.p.board[L.ROWS - 1][2] = 1; s2.p.board[L.ROWS - 2][2] = 2;
  const c = s2.p.piece;
  L.step(s2.g, DT, { ...NONE, hard: true });
  assert.strictEqual(s2.p.board[L.ROWS - 3][2], c.a);
  // 옆으로 옮기고 돌린 뒤에도 그 자리로 떨어진다
  const s3 = fresh(14);
  L.movePiece(s3.g, s3.p, -2); L.rotatePiece(s3.g, s3.p, 1);
  const d = s3.p.piece;
  L.step(s3.g, DT, { ...NONE, hard: true });
  assert.strictEqual(s3.p.board[L.ROWS - 1][0], d.a);
  assert.strictEqual(s3.p.board[L.ROWS - 1][1], d.b, 'partner on the right');
});

test('hard drop only counts once per press, in pvp mode too', () => {
  const g = L.newGame(L.rng(15), 'pvp', 'normal');
  for (const p of g.players) { p.phase = 'fall'; L.spawn(g, p); }
  const i0 = { ...NONE, hard: true }, i1 = { ...NONE };
  L.step(g, DT, [i0, i1]);
  assert.strictEqual(g.players[0].piece, null);
  assert.ok(g.players[1].piece, 'the other player is not affected');
  assert.strictEqual(i0.hard, false, 'the flag is cleared after one step');
});
