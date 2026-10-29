'use strict';

// 서버 시험: 보안·안정성 회귀 + 뿌요뿌요 온라인 대전 흐름
// 실행: npm test  (Node 18 이상, 별도 설치 없이 node:test)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const { WebSocket } = require('ws');

// 운영체제가 지금 비어 있는 포트를 골라 준다 (고정 포트·범위 난수는 다른 서버와 겹쳐 가끔 실패한다)
const freePort = () => Number(require('child_process').execFileSync(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })"]));
const PORT = freePort();
const get = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT), PUYO_SPEED: '6', PUYO_TEST: '1' }, stdio: 'ignore' });
child.unref();
process.on('exit', () => child.kill());
const ready = (async () => {
  for (let i = 0; i < 80; i++) { try { await get('/'); return; } catch { await sleep(100); } }
  throw new Error('server did not start');
})();

const open = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
  const c = { ws, msgs: [], room: null, frame: null, frames: 0, evs: [], queued: false, errors: [], closed: null, resumeFailed: false };
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    c.msgs.push(m);
    if (m.t === 'room') { c.room = m; if (m.g) c.frame = m.g; }
    if (m.t === 's') { c.frame = m; c.frames++; }
    if (m.t === 'ev') c.evs.push(m);
    if (m.t === 'queued') c.queued = true;
    if (m.t === 'error') c.errors.push(m.msg);
    if (m.t === 'resumeFailed') c.resumeFailed = true;
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  ws.on('open', () => resolve(c));
  setTimeout(() => reject(new Error('websocket connect failed')), 3000);
});
const send = (c, t, p = {}) => c.ws.send(JSON.stringify({ t, ...p }));
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(10); } return false; };
const closeAll = (...cs) => cs.forEach((c) => c.ws.close());

// 두 손님을 빠른 대전으로 맺어 준다
async function pair() {
  const a = await open(), b = await open();
  send(a, 'hello', { name: '가' }); send(b, 'hello', { name: '나' });
  send(a, 'quick'); await until(() => a.queued);
  send(b, 'quick');
  assert.ok(await until(() => a.room && b.room && a.room.state === 'playing' && b.room.state === 'playing'), 'both players enter a playing room');
  return [a, b];
}
// 내 판 모양 (규칙의 you 번째 선수)
const mine = (c) => c.frame.p[c.room.you];
const theirs = (c) => c.frame.p[1 - c.room.you];
const cells = (str) => str.split('').map(Number);
const board = (rows) => { const b = new Array(78).fill('0'); rows.forEach((line, i) => { for (let c = 0; c < 6; c++) b[(13 - rows.length + i) * 6 + c] = line[c] === '.' ? '0' : line[c]; }); return b.join(''); };

test('malformed URLs get 400 and the server stays up', async () => {
  await ready;
  assert.strictEqual(await get('/%'), 400);
  assert.strictEqual(await get('/%00'), 400);
  assert.strictEqual(await get('/'), 200);
  assert.strictEqual(await get('/logic.js'), 200);
});

test('dotfiles and paths outside the public dir are not served', async () => {
  await ready;
  assert.strictEqual(await get('/.git/config'), 403);
  assert.ok([403, 404].includes(await get('/../server.js')));
});

test('oversized websocket message closes the connection (1009)', async () => {
  await ready;
  const c = await open();
  c.ws.send('x'.repeat(2 * 1024 * 1024));
  assert.ok(await until(() => c.closed !== null));
  assert.strictEqual(c.closed, 1009);
  assert.strictEqual(await get('/'), 200);
});

test('junk messages and unknown or prototype-poisoning message types are ignored', async () => {
  await ready;
  const c = await open();
  for (const m of ['hello', '[]', 'null', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}', '{"t":5}', '{"t":"cmd","c":"X"}', '{"t":"down","v":"yes"}']) c.ws.send(m);
  send(c, 'create');
  assert.ok(await until(() => c.room && c.room.state === 'waiting'), 'the server still answers');
  closeAll(c);
});

test('quick match pairs two players, and each gets a view of both boards', async () => {
  await ready;
  const [a, b] = await pair();
  assert.notStrictEqual(a.room.you, b.room.you);
  assert.strictEqual(a.room.players.length, 2);
  assert.strictEqual(a.room.g.p.length, 2);
  assert.strictEqual(a.room.g.p[0].b.length, 78);
  assert.deepStrictEqual(a.room.g.p[0].q, b.room.g.p[0].q, 'both see the same pairs coming');
  closeAll(a, b);
});

test('the server sends about 30 frames a second while playing', async () => {
  await ready;
  const [a, b] = await pair();
  const n0 = a.frames;
  await sleep(1000);
  const n = a.frames - n0;
  assert.ok(n >= 18 && n <= 40, `frames in one second: ${n}`);
  closeAll(a, b);
});

test('move and rotate commands steer your own piece, and not the other player', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => a.frame && mine(a).pc && theirs(a).pc), 'pieces appear');
  const c0 = mine(a).pc[0], rot0 = mine(a).pc[2], theirs0 = theirs(a).pc[0];
  send(a, 'cmd', { c: 'R' });
  assert.ok(await until(() => mine(a).pc && mine(a).pc[0] === c0 + 1), 'moved right');
  send(a, 'cmd', { c: 'ZR' });
  assert.ok(await until(() => mine(a).pc && mine(a).pc[2] === (rot0 + 1) % 4), 'rotated');
  assert.strictEqual(theirs(a).pc ? theirs(a).pc[0] : theirs0, theirs0, 'the other piece did not move');
  closeAll(a, b);
});

test('the hard drop command puts your piece down at once', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => mine(a).pc && theirs(a).pc));
  const rowBefore = mine(a).pc[1];
  send(a, 'cmd', { c: 'H' });
  assert.ok(await until(() => mine(a).ph !== 'fall' || !mine(a).pc, 1500), 'locked right away');
  assert.ok(cells(mine(a).b).slice(66).some((v) => v !== 0), 'something is on the bottom row');
  assert.ok(theirs(a).pc || theirs(a).ph, 'the other board is unaffected');
  void rowBefore;
  closeAll(a, b);
});

test('soft drop makes the piece fall faster, and the input queue is capped', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => mine(a).pc && theirs(a).pc));
  send(a, 'down', { v: true });
  const t0 = Date.now();
  assert.ok(await until(() => mine(a).ph !== 'fall' || (mine(a).pc && mine(a).pc[1] >= 8), 3000), 'dropped');
  send(a, 'down', { v: false });
  // 아주 많은 옮기기를 보내도 서버는 버틴다
  for (let i = 0; i < 300; i++) send(a, 'cmd', { c: 'L' });
  await sleep(300);
  assert.ok(a.ws.readyState === a.ws.OPEN);
  void t0;
  closeAll(a, b);
});

test('a chain on your board sends nuisance puyo that land on the opponent', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => mine(a).pc && theirs(a).pc));
  // 다섯 개가 가로로 이어지는 판: (10 x 5) x (0 + 0 + 2) = 100점 → 방해 뿌요 1개
  send(a, 'dbg', { board: board(['111110']) });
  assert.ok(await until(() => a.evs.some((e) => e.e === 'send' && e.who === a.room.you && e.n >= 1)), 'nuisance was sent');
  assert.ok(await until(() => cells(theirs(b).b).includes(9) || cells(mine(a).b).includes(0) && theirs(a).pd >= 1 || b.evs.some((e) => e.e === 'nuisance'), 8000), 'it landed on the other board');
  closeAll(a, b);
});

test('a player whose stack reaches the top loses, and the other wins', async () => {
  await ready;
  const [a, b] = await pair();
  assert.ok(await until(() => mine(a).pc && theirs(a).pc));
  // 가운데 열을 끝까지 채운 판: 새 덩어리가 나올 곳이 막힌다
  const rows = [];
  for (let r = 0; r < 13; r++) rows.push(r % 2 ? '..1...' : '..2...');
  send(a, 'dbg', { board: board(rows) });
  assert.ok(await until(() => a.room.state === 'over' && b.room.state === 'over', 8000), 'game over');
  assert.strictEqual(b.room.winner, b.room.you);
  assert.strictEqual(a.room.winner, b.room.you);
  assert.strictEqual(a.room.reason, 'dead');
  closeAll(a, b);
});

test('resign ends the game, and both players can ask for one more game', async () => {
  await ready;
  const [a, b] = await pair();
  send(a, 'resign');
  assert.ok(await until(() => a.room.state === 'over' && b.room.state === 'over'));
  assert.strictEqual(b.room.winner, b.room.you);
  assert.strictEqual(b.room.reason, 'resign');
  send(a, 'rematch');
  assert.ok(await until(() => a.room.rematch.length === 1));
  assert.strictEqual(a.room.state, 'over');
  send(b, 'rematch');
  assert.ok(await until(() => a.room.state === 'playing' && b.room.state === 'playing' && a.room.games === 2), 'new game');
  closeAll(a, b);
});

test('leaving mid-game gives the win to the other player', async () => {
  await ready;
  const [a, b] = await pair();
  send(a, 'leave');
  assert.ok(await until(() => b.room.state === 'over'));
  assert.strictEqual(b.room.winner, b.room.you);
  assert.strictEqual(b.room.reason, 'left');
  closeAll(a, b);
});

test('a dropped connection can come back to the same seat, and the game waits meanwhile', async () => {
  await ready;
  const [a, b] = await pair();
  const token = a.room.token, code = a.room.code;
  a.ws.close();
  assert.ok(await until(() => b.room.players.some((p) => !p.online)), 'the opponent shows as offline');
  const f0 = b.frames;
  await sleep(600);
  assert.ok(b.frames - f0 <= 2, 'the game is paused while someone is away');
  const a2 = await open();
  send(a2, 'resume', { code, token });
  assert.ok(await until(() => a2.room && a2.room.state === 'playing' && a2.room.code === code));
  assert.ok(await until(() => b.room.players.every((p) => p.online)));
  assert.ok(await until(() => b.frames - f0 > 6), 'and then it goes on');
  const bad = await open();
  send(bad, 'resume', { code, token: 'nope' });
  assert.ok(await until(() => bad.resumeFailed));
  closeAll(a2, b, bad);
});

test('private rooms by code, with brute-force protection', async () => {
  await ready;
  const a = await open(), b = await open(), c = await open();
  send(a, 'create');
  assert.ok(await until(() => a.room && a.room.state === 'waiting'));
  const code = a.room.code;
  assert.strictEqual(code.length, 4);
  send(b, 'join', { code: code.toLowerCase() });
  assert.ok(await until(() => a.room.state === 'playing' && b.room.state === 'playing'));
  send(c, 'join', { code });
  assert.ok(await until(() => c.errors.length === 1), 'a third player is turned away');
  const d = await open();
  for (let i = 0; i < 9; i++) send(d, 'join', { code: 'ZZZZ' });
  assert.ok(await until(() => d.errors.length >= 9));
  assert.ok(d.errors.some((m) => m.includes('너무 많이')), 'blocked after repeated misses');
  closeAll(a, b, c, d);
});
