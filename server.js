'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
// 규칙은 브라우저와 같은 코드를 쓴다. 판 계산은 서버가 하고, 손님은 입력(옮기기·돌리기·내리기)만 보낸다
const L = require('./public/logic.js');
const rand = () => crypto.randomInt(1 << 30) / (1 << 30);

// ---------- Config ----------
const PORT = process.env.PORT || 3028;
const SPEED = Number(process.env.PUYO_SPEED) || 1;          // 떨어지는 속도 배율. 시험에서만 키운다
const TEST_HOOKS = process.env.PUYO_TEST === '1';            // 시험용: 판을 직접 꾸미는 메시지를 받는다 (운영에서는 켜지지 않는다)
const TICK_MS = 1000 / 60;      // 서버가 판을 계산하는 간격 (한 번에 1/60초)
const SEND_EVERY = 2;           // 계산 두 번에 한 번(초당 30번) 판 모양을 보낸다
const GRACE_MS = 30000;         // 대국 중 연결이 끊겨도 이 시간 안에 돌아오면 이어서 한다 (그동안 두 사람 모두 멈춘다)
// 프록시가 WebSocket ping 을 대신 받아버리는 환경이 있어, 클라이언트가 보내는 pulse 로 살아있는지 본다
const HEARTBEAT_MS = 25000;
const SILENCE_TIMEOUT_MS = 90000;
const MSG_RATE = 90;            // 한 손님이 1초에 보낼 수 있는 메시지 수 (넘으면 무시)
const QUEUE_MAX = 6;            // 처리를 기다리는 옮기기·돌리기 입력의 최대 개수
// 헷갈리는 글자(0/O, 1/I)는 빼서 코드를 불러주기 쉽게 한다
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ---------- Static file server ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
// 주소 해석·파일 경로 검사: 잘못된 % 표기나 널 문자는 null, 점으로 시작하는 파일과 폴더 밖 경로는 내보내지 않는다
function safeDecode(s) {
  try {
    const d = decodeURIComponent(s);
    return d.includes('\0') ? null : d;
  } catch { return null; }
}
function isServable(filePath, baseDir) {
  const inside = filePath === baseDir || filePath.startsWith(baseDir + path.sep);
  return inside && !filePath.slice(baseDir.length).split(path.sep).some((seg) => seg.startsWith('.'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = safeDecode(req.url.split('?')[0]);
  if (reqPath === null) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad request'); return; }
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!isServable(filePath, PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// 메시지 크기 제한: 기본값(100MB)이면 큰 메시지 하나로 서버 메모리를 먹일 수 있다. 이 게임의 메시지는 모두 이보다 훨씬 작다
const wss = new WebSocketServer({ server, maxPayload: 1024 });

// ---------- 방 코드 무차별 대입 방지 ----------
const JOIN_FAIL_MAX = 8, JOIN_WINDOW_MS = 60000, JOIN_BLOCK_MS = 60000;
const joinFails = new Map();   // 주소 -> { n, since, until }
const clientIp = (req) => String((req && req.headers['x-forwarded-for']) || (req && req.socket.remoteAddress) || '').split(',')[0].trim();
function joinBlocked(ip) {
  const f = joinFails.get(ip);
  return !!f && f.until > Date.now();
}
function noteJoinFail(ip) {
  const now = Date.now();
  let f = joinFails.get(ip);
  if (!f || now - f.since > JOIN_WINDOW_MS) f = { n: 0, since: now, until: 0 };
  f.n++;
  if (f.n >= JOIN_FAIL_MAX) { f.until = now + JOIN_BLOCK_MS; f.n = 0; f.since = now; }
  joinFails.set(ip, f);
  if (joinFails.size > 2000) for (const [k, v] of joinFails) if (v.until < now && now - v.since > JOIN_WINDOW_MS) joinFails.delete(k);
}

// ---------- State ----------
const rooms = new Map();     // code -> room
const clients = new Map();   // ws -> client
let queue = null;            // 빠른 대전을 기다리는 client 하나
let nextId = 1;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ t: type, ...payload }));
}

function makeCode() {
  for (let k = 0; k < 50; k++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

const makeToken = () => crypto.randomBytes(18).toString('base64url');   // 자리를 되찾는 열쇠: 예측할 수 없는 난수로

function sanitizeName(raw) {
  const name = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 10);
  return name || `손님${Math.floor(100 + Math.random() * 900)}`;
}

// ---------- Rooms ----------
function newInbox() { return { moves: [], rots: [], down: false, hard: false }; }

function createRoom(isPrivate) {
  const room = {
    code: makeCode(),
    isPrivate,
    seats: [],               // { client, name, color, token, online, graceTimer, inbox } — color 는 규칙의 0번·1번 선수 (먼저 앉은 쪽이 0번)
    game: null,
    state: 'waiting',        // waiting | playing | over
    winner: -1,              // 0 · 1
    reason: '',              // dead | resign | left
    loop: null,
    lastTick: 0, acc: 0, n: 0,
    rematch: new Set(),
    games: 0,
  };
  rooms.set(room.code, room);
  return room;
}

function seatOf(room, client) {
  return room.seats.find((s) => s.client === client);
}

// 한 선수의 판 모양: 화면이 이걸 받아 그린다 (보이는 줄 12줄만 보내고, 판은 숫자 한 글자씩의 문자열)
function frameOf(p) {
  return {
    b: p.board.map((r) => r.join('')).join(''),
    pc: p.piece && p.phase === 'fall' ? [p.piece.c, p.piece.r, p.piece.rot, p.piece.a, p.piece.b] : null,
    ph: p.phase,
    q: p.queue.slice(0, 2),
    sc: p.score,
    pd: p.pending,
    mc: p.maxChain,
    sn: p.sent,
    lv: p.level,
    pop: p.popping ? p.popping.cells.map(([r, c]) => r * 6 + c) : null,
    ch: p.chain,
  };
}
function gameFrame(room) {
  const g = room.game;
  return g ? { p: g.players.map(frameOf) } : null;
}

function snapshot(room, seat) {
  return {
    code: room.code,
    isPrivate: room.isPrivate,
    token: seat.token,
    you: seat.color,                       // 규칙의 0번·1번 선수. 화면은 내 판을 왼쪽에 그린다
    players: room.seats.map((s) => ({ name: s.name, color: s.color, online: s.online })),
    games: room.games,
    state: room.state,
    winner: room.winner,
    reason: room.reason,
    rematch: [...room.rematch],
    g: gameFrame(room),
    stats: room.game ? room.game.players.map((p) => ({ score: p.score, maxChain: p.maxChain, sent: p.sent })) : null,
  };
}

function pushRoom(room) {
  for (const s of room.seats) if (s.online) send(s.client.ws, 'room', snapshot(room, s));
}

function broadcast(room, type, payload) {
  for (const s of room.seats) if (s.online) send(s.client.ws, type, payload);
}

function sitDown(room, client) {
  const seat = { client, name: client.name, color: room.seats.length, token: makeToken(), online: true, graceTimer: null, inbox: newInbox() };
  room.seats.push(seat);
  client.roomCode = room.code;
  if (room.seats.length === 2) startGame(room);
  else pushRoom(room);
}

function startGame(room) {
  // 두 선수는 같은 순서의 뿌요를 받는다 (같은 씨앗). 화면은 늘 내 판이 왼쪽
  room.game = L.newGame(rand, 'pvp', 'normal', { speedMul: SPEED });
  for (const s of room.seats) s.inbox = newInbox();
  room.state = 'playing';
  room.winner = -1;
  room.reason = '';
  room.rematch.clear();
  room.games++;
  room.lastTick = Date.now();
  room.acc = 0;
  room.n = 0;
  clearInterval(room.loop);
  room.loop = setInterval(() => tick(room), TICK_MS);
  pushRoom(room);
}

// 한 칸 계산에 쓸 입력: 쌓여 있는 옮기기와 돌리기를 하나씩 꺼내 준다
function inputOf(seat) {
  const ib = seat.inbox;
  const m = ib.moves.shift(), r = ib.rots.shift();
  const hard = ib.hard; ib.hard = false;
  return { left: m === -1, right: m === 1, rotate: r || 0, down: ib.down, hard };
}

// 실제로 흐른 시간만큼 1/60초 단위로 계산한다 (너무 오래 멈췄다 와도 한 번에 따라잡는 양은 제한). 누가 연결이 끊겨 있으면 둘 다 멈춘다
function tick(room) {
  const now = Date.now();
  const paused = room.seats.some((s) => !s.online);
  room.acc = paused ? 0 : Math.min(0.25, room.acc + (now - room.lastTick) / 1000);
  room.lastTick = now;
  const g = room.game;
  const seats = [room.seats.find((s) => s.color === 0), room.seats.find((s) => s.color === 1)];
  let guard = 0;
  while (room.acc >= 1 / 60 && !g.over && guard++ < 20) {
    room.acc -= 1 / 60;
    L.step(g, 1 / 60, [inputOf(seats[0]), inputOf(seats[1])]);
    for (const e of g.events) {
      if (e.t === 'pop') broadcast(room, 'ev', { e: 'pop', who: e.who, chain: e.chain, n: e.n, points: e.points });
      else if (e.t === 'send') broadcast(room, 'ev', { e: 'send', who: e.who, n: e.n });
      else if (e.t === 'nuisance') broadcast(room, 'ev', { e: 'nuisance', who: e.who, n: e.n });
      else if (e.t === 'land' || e.t === 'hard') broadcast(room, 'ev', { e: 'land', who: e.who });
    }
  }
  if (g.over) return endGame(room, g.winner, 'dead');
  if (!paused && ++room.n % SEND_EVERY === 0) broadcast(room, 's', gameFrame(room));
}

function endGame(room, winner, reason) {
  if (room.state !== 'playing') return;
  clearInterval(room.loop);
  room.state = 'over';
  room.winner = winner;
  room.reason = reason;
  pushRoom(room);
}

function closeRoom(room) {
  clearInterval(room.loop);
  for (const s of room.seats) {
    clearTimeout(s.graceTimer);
    if (s.client) s.client.roomCode = null;
  }
  rooms.delete(room.code);
}

// 자리에서 완전히 일어난다 (나가기, 또는 끊긴 뒤 돌아오지 않음)
function vacate(room, seat) {
  clearTimeout(seat.graceTimer);
  if (room.state === 'playing') endGame(room, 1 - seat.color, 'left');
  room.seats = room.seats.filter((s) => s !== seat);
  if (seat.client) seat.client.roomCode = null;
  if (!room.seats.length || room.state === 'waiting') { closeRoom(room); return; }
  // 남은 사람은 결과창에 머문다. 상대가 없으니 한 판 더는 할 수 없다.
  room.rematch.clear();
  pushRoom(room);
}

function dropFromQueue(client) {
  if (queue === client) queue = null;
}

// ---------- Handlers ----------
const handlers = {
  hello(client, msg) {
    client.name = sanitizeName(msg.name);
  },

  quick(client) {
    if (client.roomCode) return;
    if (queue && queue !== client && queue.ws.readyState === queue.ws.OPEN) {
      const other = queue;
      queue = null;
      const room = createRoom(false);
      sitDown(room, other);
      sitDown(room, client);
    } else {
      queue = client;
      send(client.ws, 'queued');
    }
  },

  create(client) {
    if (client.roomCode) return;
    dropFromQueue(client);
    sitDown(createRoom(true), client);
  },

  join(client, msg) {
    if (client.roomCode) return;
    dropFromQueue(client);
    if (joinBlocked(client.ip)) return send(client.ws, 'error', { msg: '방 코드를 너무 많이 틀렸어요. 1분 뒤에 다시 해 주세요.' });
    const room = rooms.get(String(msg.code || '').trim().toUpperCase());
    if (!room) { noteJoinFail(client.ip); return send(client.ws, 'error', { msg: '그런 방이 없어요. 코드를 확인해 주세요.' }); }
    if (room.seats.length >= 2) return send(client.ws, 'error', { msg: '이미 두 사람이 하고 있는 방이에요.' });
    sitDown(room, client);
  },

  // 새로고침·네트워크 끊김 뒤 같은 자리로 돌아온다
  resume(client, msg) {
    const room = rooms.get(String(msg.code || ''));
    const seat = room && room.seats.find((s) => s.token === msg.token);
    if (!seat) return send(client.ws, 'resumeFailed');
    if (seat.client && seat.client !== client && seat.client.ws.readyState === seat.client.ws.OPEN) {
      seat.client.roomCode = null;
      send(seat.client.ws, 'error', { msg: '다른 창에서 이 대국에 다시 들어왔어요.' });
    }
    clearTimeout(seat.graceTimer);
    seat.client = client;
    seat.online = true;
    seat.inbox = newInbox();
    client.name = seat.name;
    client.roomCode = room.code;
    if (room.state === 'playing') { room.lastTick = Date.now(); room.acc = 0; }
    pushRoom(room);
  },

  cancel(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'waiting') vacate(room, seat);
  },

  // 옮기기·돌리기·바로 떨어뜨리기: { c: 'L' | 'R' | 'ZL' | 'ZR' | 'H' } 한 번에 하나. 쌓이는 개수는 제한한다
  cmd(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'playing') return;
    const ib = seat.inbox;
    if (msg.c === 'L' || msg.c === 'R') { if (ib.moves.length < QUEUE_MAX) ib.moves.push(msg.c === 'L' ? -1 : 1); }
    else if (msg.c === 'ZL' || msg.c === 'ZR') { if (ib.rots.length < QUEUE_MAX) ib.rots.push(msg.c === 'ZL' ? -1 : 1); }
    else if (msg.c === 'H') ib.hard = true;
  },

  // 아래 버튼을 누르고 있는지: { v: true | false }
  down(client, msg) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'playing') return;
    seat.inbox.down = msg.v === true;
  },

  resign(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat && room.state === 'playing') endGame(room, 1 - seat.color, 'resign');
  },

  rematch(client) {
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'over' || room.seats.length < 2) return;
    room.rematch.add(seat.color);
    if (room.rematch.size === 2) startGame(room);
    else pushRoom(room);
  },

  leave(client) {
    dropFromQueue(client);
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (seat) vacate(room, seat);
  },

  pulse() {},

  // 시험용: 한 선수의 판을 글자 그림으로 꾸미고 터뜨리기부터 시작하게 한다 (PUYO_TEST=1 일 때만)
  dbg(client, msg) {
    if (!TEST_HOOKS) return;
    const room = rooms.get(client.roomCode);
    const seat = room && seatOf(room, client);
    if (!seat || room.state !== 'playing' || typeof msg.board !== 'string' || msg.board.length !== 6 * L.ROWS) return;
    const p = room.game.players[seat.color];
    p.board = L.newBoard();
    for (let i = 0; i < msg.board.length; i++) p.board[Math.floor(i / 6)][i % 6] = Number(msg.board[i]) || 0;
    p.piece = null; p.phase = 'settle'; p.settleT = 0; p.chain = 0;
  },
};

// ---------- Connections ----------
function onDisconnect(client) {
  dropFromQueue(client);
  const room = rooms.get(client.roomCode);
  const seat = room && seatOf(room, client);
  if (!seat) return;
  if (room.state !== 'playing') { vacate(room, seat); return; }
  // 대국 중이면 잠깐 기다려 준다 (그동안 판은 멈춘다)
  seat.online = false;
  seat.client = null;
  seat.graceTimer = setTimeout(() => vacate(room, seat), GRACE_MS);
  pushRoom(room);
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, HEARTBEAT_MS);

const silenceSweep = setInterval(() => {
  const now = Date.now();
  for (const [ws, client] of clients) {
    if (now - client.lastSeen > SILENCE_TIMEOUT_MS) ws.terminate();
  }
}, 5000);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(silenceSweep); });

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});   // 크기 제한 초과 같은 연결 오류는 그 손님의 연결만 끊고, 처리하지 않으면 서버 전체가 죽는다
  const client = { id: nextId++, ws, ip: clientIp(req), name: sanitizeName(''), roomCode: null, lastSeen: Date.now(), rateAt: Date.now(), rateN: 0 };
  clients.set(ws, client);

  ws.on('message', (raw) => {
    const now = Date.now();
    client.lastSeen = now;
    if (now - client.rateAt > 1000) { client.rateAt = now; client.rateN = 0; }
    if (++client.rateN > MSG_RATE) return;                    // 너무 빠르게 보내는 메시지는 버린다
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const handler = msg && typeof msg.t === 'string' && Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (handler) handler(client, msg);
  });

  ws.on('close', () => {
    onDisconnect(client);
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`뿌요뿌요 서버 실행 중 → http://localhost:${PORT}`);
});
