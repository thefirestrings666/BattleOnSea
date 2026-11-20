'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room, FLEET, validateFleet, randomFleet, GameError } = require('../src/game');

const FIXED = [
  { id: 'carrier', x: 0, y: 0, dir: 'h' },
  { id: 'battleship', x: 0, y: 2, dir: 'h' },
  { id: 'destroyer', x: 0, y: 4, dir: 'h' },
  { id: 'submarine', x: 0, y: 6, dir: 'h' },
  { id: 'patrol', x: 0, y: 8, dir: 'h' },
];
const allCells = (ships) => validateFleet(ships).flatMap((s) => s.cells);

test('validateFleet accepte une flotte valide', () => {
  assert.equal(validateFleet(FIXED).length, FLEET.length);
});

test('validateFleet refuse chevauchement, débordement, doublons', () => {
  const overlap = FIXED.map((s) => (s.id === 'patrol' ? { ...s, y: 0 } : s));
  assert.throws(() => validateFleet(overlap), GameError);
  const out = FIXED.map((s) => (s.id === 'carrier' ? { ...s, x: 6 } : s));
  assert.throws(() => validateFleet(out), GameError);
  const dup = [...FIXED.slice(0, 4), { ...FIXED[0], y: 9 }];
  assert.throws(() => validateFleet(dup), GameError);
  assert.throws(() => validateFleet(FIXED.slice(0, 4)), GameError);
  assert.throws(() => validateFleet(FIXED.map((s) => ({ ...s, dir: 'x' }))), GameError);
  assert.throws(() => validateFleet(FIXED.map((s) => ({ ...s, x: 0.5 }))), GameError);
});

test('randomFleet produit toujours une flotte valide', () => {
  for (let i = 0; i < 200; i++) validateFleet(randomFleet());
});

function startedRoom() {
  const room = new Room('TEST1');
  room.addPlayer('Alice');
  room.addPlayer('Bob');
  room.placeFleet(0, FIXED);
  room.placeFleet(1, FIXED);
  return room;
}

test('la partie démarre quand les deux flottes sont placées', () => {
  const room = new Room('TEST1');
  room.addPlayer('Alice');
  room.placeFleet(0, FIXED);
  assert.equal(room.phase, 'placement');
  room.addPlayer('Bob');
  room.placeFleet(1, FIXED);
  assert.equal(room.phase, 'playing');
  assert.ok(room.turn === 0 || room.turn === 1);
  assert.throws(() => room.addPlayer('Eve'), GameError);
});

test('tirs : à l\'eau passe la main, touché rejoue, pas de double tir', () => {
  const room = startedRoom();
  const a = room.turn;
  const b = 1 - a;
  assert.throws(() => room.fire(b, 0, 0), /pas ton tour/);
  assert.equal(room.fire(a, 0, 0).result, 'hit');
  assert.equal(room.turn, a);
  assert.throws(() => room.fire(a, 0, 0), /déjà tiré/);
  assert.equal(room.fire(a, 9, 9).result, 'miss');
  assert.equal(room.turn, b);
  assert.throws(() => room.fire(b, 10, 0), GameError);
});

test('coulé, victoire, et vue sans fuite d\'information', () => {
  const room = startedRoom();
  const a = room.turn;
  const b = 1 - a;
  // Avant tout tir, B ne voit aucun navire de A.
  assert.deepEqual(room.viewFor(b).opponent.ships, []);
  assert.equal(room.fire(a, 0, 8).result, 'hit');
  const sunk = room.fire(a, 1, 8);
  assert.equal(sunk.result, 'sunk');
  assert.equal(room.lastShot.ship, 'Torpilleur');
  const view = room.viewFor(a);
  assert.equal(view.opponent.ships.length, 1);
  assert.equal(view.opponent.ships[0].id, 'patrol');

  const targets = allCells(FIXED).filter(([x, y]) => y !== 8);
  let last;
  for (const [x, y] of targets) last = room.fire(a, x, y);
  assert.equal(last.gameOver, true);
  assert.equal(room.phase, 'over');
  assert.equal(room.viewFor(a).winner, 'you');
  assert.equal(room.viewFor(b).winner, 'opponent');
  assert.equal(room.viewFor(b).opponent.ships.length, FLEET.length); // révélé en fin de partie
});

test('revanche : réinitialise et alterne le premier joueur', () => {
  const room = startedRoom();
  const first = room.turn;
  room.forfeitBy(0);
  assert.equal(room.winner, 1);
  assert.equal(room.requestRematch(0), false);
  assert.equal(room.requestRematch(1), true);
  assert.equal(room.phase, 'placement');
  assert.equal(room.round, 2);
  room.placeFleet(0, FIXED);
  room.placeFleet(1, FIXED);
  assert.equal(room.turn, 1 - first);
  assert.equal(room.players[0].shots.size, 0);
});

test('un nouveau joueur peut remplacer un adversaire parti', () => {
  const room = startedRoom();
  room.forfeitBy(1);
  room.removePlayer(1);
  const p = room.addPlayer('Charlie');
  assert.equal(p.index, 1);
  assert.equal(room.phase, 'placement');
  assert.equal(room.players[0].fleet, null);
});
