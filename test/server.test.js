'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../src/server');
const { randomFleet } = require('../src/game');

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d);
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next(pred = () => true) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), 2000);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    drain() { queue.length = 0; },
  };
}

const isState = (pred = () => true) => (m) => m.type === 'state' && pred(m.state);

test('partie complète à deux joueurs via WebSocket', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Bataille Navale/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/../package.json`)).status, 404);

  const a = client(port);
  const b = client(port);
  await Promise.all([a.open(), b.open()]);

  a.send({ type: 'create', name: 'Alice' });
  const joinedA = await a.next((m) => m.type === 'joined');
  assert.match(joinedA.code, /^[A-Z0-9]{5}$/);

  b.send({ type: 'join', code: joinedA.code.toLowerCase(), name: 'Bob' });
  await b.next((m) => m.type === 'joined');
  await a.next(isState((s) => s.opponent && s.opponent.name === 'Bob'));

  // Un 3e joueur est refusé.
  const c = client(port);
  await c.open();
  c.send({ type: 'join', code: joinedA.code, name: 'Eve' });
  assert.match((await c.next((m) => m.type === 'error')).message, /complète/);
  c.ws.close();

  a.send({ type: 'place', ships: randomFleet() });
  b.send({ type: 'place', ships: randomFleet() });
  const sA = (await a.next(isState((s) => s.phase === 'playing'))).state;
  await b.next(isState((s) => s.phase === 'playing'));
  // Aucune fuite : A ne connaît pas les navires de B.
  assert.deepEqual(sA.opponent.ships, []);

  // Chaque joueur tire méthodiquement jusqu'à la fin.
  const shooters = [a, b];
  const plans = [[], []];
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) { plans[0].push([x, y]); plans[1].push([x, y]); }
  let current = sA.turn === 'you' ? 0 : 1;
  let final;
  for (let guard = 0; guard < 400; guard++) {
    const shooter = shooters[current];
    const [x, y] = plans[current].shift();
    shooter.drain();
    shooter.send({ type: 'fire', x, y });
    const st = (await shooter.next(isState((s) => s.lastShot && s.lastShot.x === x && s.lastShot.y === y && s.lastShot.by === 'you'))).state;
    if (st.phase === 'over') { final = { st, current }; break; }
    if (st.turn === 'opponent') current = 1 - current;
  }
  assert.ok(final, 'la partie doit se terminer');
  assert.equal(final.st.winner, 'you');
  assert.equal(final.st.opponent.ships.length, 5);

  // Revanche.
  a.send({ type: 'rematch' });
  b.send({ type: 'rematch' });
  await a.next(isState((s) => s.phase === 'placement' && s.round === 2));

  // Chat.
  a.drain(); b.drain();
  a.send({ type: 'chat', text: 'Bien joué <b>!</b>' });
  const chat = await b.next((m) => m.type === 'chat');
  assert.equal(chat.text, 'Bien joué <b>!</b>');
  assert.equal(chat.from, 'opponent');

  a.ws.close(); b.ws.close();
  await new Promise((r) => server.close(r));
});

test('reprise de session avec le jeton après déconnexion', async () => {
  const { server } = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();

  const a = client(port);
  await a.open();
  a.send({ type: 'create', name: 'Alice' });
  const { code, token } = await a.next((m) => m.type === 'joined');
  const b = client(port);
  await b.open();
  b.send({ type: 'join', code, name: 'Bob' });
  await b.next((m) => m.type === 'joined');

  a.ws.close();
  await b.next(isState((s) => s.opponent && s.opponent.connected === false));

  const a2 = client(port);
  await a2.open();
  a2.send({ type: 'resume', code, token: 'mauvais' });
  assert.equal((await a2.next()).type, 'resume-failed');
  a2.send({ type: 'resume', code, token });
  const st = await a2.next(isState());
  assert.equal(st.state.me.name, 'Alice');
  await b.next(isState((s) => s.opponent && s.opponent.connected === true));

  a2.ws.close(); b.ws.close();
  await new Promise((r) => server.close(r));
});
