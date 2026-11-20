'use strict';

/**
 * Logique pure de la bataille navale (aucune dépendance réseau).
 * Le serveur est seul détenteur de la vérité : la position des navires
 * adverses n'est jamais envoyée à un joueur avant qu'ils soient coulés
 * (ou à la fin de la partie).
 */

const crypto = require('crypto');

const BOARD_SIZE = 10;

const FLEET = Object.freeze([
  { id: 'carrier', name: 'Porte-avions', size: 5 },
  { id: 'battleship', name: 'Croiseur', size: 4 },
  { id: 'destroyer', name: 'Contre-torpilleur', size: 3 },
  { id: 'submarine', name: 'Sous-marin', size: 3 },
  { id: 'patrol', name: 'Torpilleur', size: 2 },
]);

const MAX_NAME_LENGTH = 20;

class GameError extends Error {}

function sanitizeName(name, fallback) {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

function isInt(n) {
  return Number.isInteger(n);
}

function inBounds(x, y) {
  return isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE;
}

function shipCells(x, y, size, dir) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push(dir === 'h' ? [x + i, y] : [x, y + i]);
  }
  return cells;
}

/**
 * Valide un placement de flotte envoyé par un client.
 * @param {Array<{id:string,x:number,y:number,dir:'h'|'v'}>} ships
 * @returns {Array} flotte normalisée (avec cellules et touches)
 */
function validateFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) {
    throw new GameError(`La flotte doit comporter exactement ${FLEET.length} navires.`);
  }
  const occupied = new Set();
  const seen = new Set();
  const fleet = [];

  for (const raw of ships) {
    if (!raw || typeof raw !== 'object') throw new GameError('Navire invalide.');
    const def = FLEET.find((s) => s.id === raw.id);
    if (!def) throw new GameError('Type de navire inconnu.');
    if (seen.has(def.id)) throw new GameError(`${def.name} placé deux fois.`);
    seen.add(def.id);

    const { x, y, dir } = raw;
    if (dir !== 'h' && dir !== 'v') throw new GameError('Orientation invalide.');
    const cells = shipCells(x, y, def.size, dir);
    for (const [cx, cy] of cells) {
      if (!inBounds(cx, cy)) throw new GameError(`${def.name} dépasse de la grille.`);
      const key = `${cx},${cy}`;
      if (occupied.has(key)) throw new GameError(`${def.name} chevauche un autre navire.`);
      occupied.add(key);
    }
    fleet.push({ ...def, x, y, dir, cells, hits: new Set() });
  }
  return fleet;
}

/** Génère un placement aléatoire valide (utile pour les tests et le client). */
function randomFleet(rng = Math.random) {
  for (;;) {
    const occupied = new Set();
    const ships = [];
    let ok = true;
    for (const def of FLEET) {
      let placed = false;
      for (let attempt = 0; attempt < 200 && !placed; attempt++) {
        const dir = rng() < 0.5 ? 'h' : 'v';
        const maxX = dir === 'h' ? BOARD_SIZE - def.size : BOARD_SIZE - 1;
        const maxY = dir === 'v' ? BOARD_SIZE - def.size : BOARD_SIZE - 1;
        const x = Math.floor(rng() * (maxX + 1));
        const y = Math.floor(rng() * (maxY + 1));
        const cells = shipCells(x, y, def.size, dir);
        if (cells.some(([cx, cy]) => occupied.has(`${cx},${cy}`))) continue;
        cells.forEach(([cx, cy]) => occupied.add(`${cx},${cy}`));
        ships.push({ id: def.id, x, y, dir });
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return ships;
  }
}

function publicShip(ship) {
  return {
    id: ship.id,
    name: ship.name,
    size: ship.size,
    x: ship.x,
    y: ship.y,
    dir: ship.dir,
    cells: ship.cells,
    sunk: ship.hits.size === ship.size,
  };
}

function isSunk(ship) {
  return ship.hits.size === ship.size;
}

class Room {
  constructor(code) {
    this.code = code;
    /** @type {Array<Player|null>} deux emplacements */
    this.players = [null, null];
    this.phase = 'placement'; // placement | playing | over
    this.turn = 0;
    this.winner = null;
    this.forfeit = false;
    this.lastShot = null;
    this.round = 1;
    this.startingPlayer = null;
    this.rematch = [false, false];
    this.lastActivity = Date.now();
  }

  touch() {
    this.lastActivity = Date.now();
  }

  get playerCount() {
    return this.players.filter(Boolean).length;
  }

  isFull() {
    return this.playerCount === 2;
  }

  addPlayer(name) {
    const index = this.players.findIndex((p) => p === null);
    if (index === -1) throw new GameError('Cette partie est déjà complète.');
    // Un nouvel adversaire remplace celui qui est parti : on repart à zéro.
    if (this.phase === 'over') this.reset();
    if (this.phase !== 'placement') throw new GameError('Cette partie a déjà commencé.');
    const player = {
      index,
      token: crypto.randomBytes(18).toString('base64url'),
      name: sanitizeName(name, `Capitaine ${index + 1}`),
      connected: true,
      fleet: null,
      shots: new Map(), // tirs effectués par ce joueur : "x,y" -> 'hit' | 'miss'
    };
    this.players[index] = player;
    this.touch();
    return player;
  }

  findByToken(token) {
    if (typeof token !== 'string') return null;
    return this.players.find((p) => p && p.token === token) || null;
  }

  removePlayer(index) {
    this.players[index] = null;
    this.rematch = [false, false];
    this.touch();
  }

  opponentOf(index) {
    return this.players[1 - index];
  }

  placeFleet(index, ships) {
    const player = this.players[index];
    if (!player) throw new GameError('Joueur inconnu.');
    if (this.phase !== 'placement') throw new GameError('Le placement est terminé.');
    player.fleet = validateFleet(ships);
    this.touch();
    this.maybeStart();
  }

  unready(index) {
    const player = this.players[index];
    if (!player || this.phase !== 'placement') return;
    player.fleet = null;
    this.touch();
  }

  maybeStart() {
    if (this.phase !== 'placement') return false;
    if (!this.isFull() || !this.players.every((p) => p.fleet)) return false;
    this.phase = 'playing';
    if (this.startingPlayer === null) {
      this.startingPlayer = crypto.randomInt(2);
    } else {
      // Revanche : on alterne le joueur qui commence.
      this.startingPlayer = 1 - this.startingPlayer;
    }
    this.turn = this.startingPlayer;
    this.lastShot = null;
    return true;
  }

  fire(index, x, y) {
    if (this.phase !== 'playing') throw new GameError("La bataille n'a pas commencé.");
    if (this.turn !== index) throw new GameError("Ce n'est pas ton tour.");
    if (!inBounds(x, y)) throw new GameError('Tir hors de la grille.');

    const shooter = this.players[index];
    const target = this.opponentOf(index);
    const key = `${x},${y}`;
    if (shooter.shots.has(key)) throw new GameError('Tu as déjà tiré sur cette case.');

    const ship = target.fleet.find((s) => s.cells.some(([cx, cy]) => cx === x && cy === y));
    let result = 'miss';
    if (ship) {
      ship.hits.add(key);
      result = isSunk(ship) ? 'sunk' : 'hit';
    }
    shooter.shots.set(key, ship ? 'hit' : 'miss');

    const gameOver = target.fleet.every(isSunk);
    this.lastShot = { by: index, x, y, result, ship: result === 'sunk' ? ship.name : null };

    if (gameOver) {
      this.phase = 'over';
      this.winner = index;
    } else if (result === 'miss') {
      // Règle classique : on rejoue tant qu'on touche, on passe la main à l'eau.
      this.turn = 1 - index;
    }
    this.touch();
    return { result, ship: ship ? publicShip(ship) : null, gameOver };
  }

  forfeitBy(index) {
    if (this.phase !== 'playing') return false;
    this.phase = 'over';
    this.winner = 1 - index;
    this.forfeit = true;
    this.touch();
    return true;
  }

  requestRematch(index) {
    if (this.phase !== 'over') throw new GameError("La partie n'est pas terminée.");
    if (!this.isFull()) throw new GameError("Ton adversaire a quitté la partie.");
    this.rematch[index] = true;
    if (this.rematch.every(Boolean)) {
      this.reset();
      return true;
    }
    this.touch();
    return false;
  }

  reset() {
    this.phase = 'placement';
    this.winner = null;
    this.forfeit = false;
    this.lastShot = null;
    this.rematch = [false, false];
    this.round += 1;
    for (const p of this.players) {
      if (!p) continue;
      p.fleet = null;
      p.shots = new Map();
    }
    this.touch();
  }

  /** Vue de la partie du point de vue d'un joueur (sans fuite d'information). */
  viewFor(index) {
    const me = this.players[index];
    const opp = this.opponentOf(index);
    const rel = (i) => (i === null || i === undefined ? null : i === index ? 'you' : 'opponent');

    const shotsList = (player) =>
      player ? [...player.shots].map(([k, v]) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y, hit: v === 'hit' };
      }) : [];

    const reveal = this.phase === 'over';
    let oppShips = null;
    if (opp && opp.fleet) {
      oppShips = opp.fleet.filter((s) => reveal || isSunk(s)).map(publicShip);
    }

    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      turn: this.phase === 'playing' ? rel(this.turn) : null,
      winner: rel(this.winner),
      forfeit: this.forfeit,
      lastShot: this.lastShot ? { ...this.lastShot, by: rel(this.lastShot.by) } : null,
      fleet: FLEET,
      boardSize: BOARD_SIZE,
      me: {
        name: me.name,
        ready: Boolean(me.fleet),
        ships: me.fleet ? me.fleet.map(publicShip) : null,
        shots: shotsList(me),
        rematch: this.rematch[index],
      },
      opponent: opp
        ? {
            name: opp.name,
            connected: opp.connected,
            ready: Boolean(opp.fleet),
            // Tirs que l'adversaire a effectués sur MA grille.
            shots: shotsList(opp),
            // Navires adverses visibles (coulés, ou tous en fin de partie).
            ships: oppShips,
            sunkCount: opp.fleet ? opp.fleet.filter(isSunk).length : 0,
            rematch: this.rematch[1 - index],
          }
        : null,
    };
  }
}

module.exports = {
  BOARD_SIZE,
  FLEET,
  GameError,
  Room,
  randomFleet,
  sanitizeName,
  validateFleet,
};
