'use strict';

/**
 * Serveur HTTP (fichiers statiques) + WebSocket (temps réel) pour la bataille navale.
 * Lancement : `npm start` puis ouvrir http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room, GameError, sanitizeName } = require('./game');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sans 0/O, 1/I/L
const CODE_LENGTH = 5;
const MAX_ROOMS = 2000;
const ROOM_IDLE_MS = 30 * 60 * 1000; // partie supprimée après 30 min sans activité
const EMPTY_ROOM_MS = 5 * 60 * 1000; // ou 5 min si plus personne n'est connecté
const HEARTBEAT_MS = 25 * 1000;
const MAX_CHAT_LENGTH = 300;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function createServer() {
  /** @type {Map<string, Room>} */
  const rooms = new Map();
  /** @type {Map<string, Set<import('ws').WebSocket>>} sockets par partie */
  const sockets = new Map();

  function newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
  }

  // ---------- HTTP ----------
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Introuvable');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function socketsOf(code) {
    let set = sockets.get(code);
    if (!set) {
      set = new Set();
      sockets.set(code, set);
    }
    return set;
  }

  /** Envoie à chaque joueur connecté sa propre vue de la partie. */
  function broadcastState(room, extra = {}) {
    for (const ws of socketsOf(room.code)) {
      if (ws.playerIndex === undefined || !room.players[ws.playerIndex]) continue;
      send(ws, { type: 'state', state: room.viewFor(ws.playerIndex), ...extra });
    }
  }

  function broadcast(room, msg) {
    for (const ws of socketsOf(room.code)) send(ws, msg);
  }

  function attach(ws, room, player) {
    // Un même joueur ouvert dans deux onglets : on ferme l'ancien.
    for (const other of socketsOf(room.code)) {
      if (other !== ws && other.playerIndex === player.index) {
        other.playerIndex = undefined;
        send(other, { type: 'kicked', message: 'Partie ouverte dans un autre onglet.' });
        other.close(4000, 'replaced');
      }
    }
    ws.roomCode = room.code;
    ws.playerIndex = player.index;
    socketsOf(room.code).add(ws);
    player.connected = true;
    room.touch();
    send(ws, { type: 'joined', code: room.code, token: player.token, name: player.name });
    broadcastState(room);
  }

  function detach(ws, { leaving = false } = {}) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    socketsOf(room.code).delete(ws);
    const index = ws.playerIndex;
    ws.roomCode = undefined;
    ws.playerIndex = undefined;
    if (index === undefined) return;
    const player = room.players[index];
    if (!player) return;

    if (leaving) {
      // Abandon en pleine bataille = victoire de l'adversaire.
      room.forfeitBy(index);
      room.removePlayer(index);
      broadcast(room, { type: 'info', message: `${player.name} a quitté la partie.` });
    } else {
      player.connected = false;
    }
    broadcastState(room);
    if (room.playerCount === 0) deleteRoom(room.code);
  }

  function deleteRoom(code) {
    rooms.delete(code);
    sockets.delete(code);
  }

  const handlers = {
    create(ws, msg) {
      if (rooms.size >= MAX_ROOMS) throw new GameError('Serveur plein, réessaie plus tard.');
      if (ws.roomCode) detach(ws, { leaving: true });
      const room = new Room(newCode());
      rooms.set(room.code, room);
      const player = room.addPlayer(msg.name);
      attach(ws, room, player);
    },

    join(ws, msg) {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) throw new GameError('Aucune partie avec ce code.');
      if (ws.roomCode) detach(ws, { leaving: true });
      const existing = room.findByToken(msg.token);
      if (existing) {
        attach(ws, room, existing);
        return;
      }
      const player = room.addPlayer(msg.name);
      attach(ws, room, player);
      const opp = room.opponentOf(player.index);
      if (opp) broadcast(room, { type: 'info', message: `${player.name} a rejoint la partie !` });
    },

    resume(ws, msg) {
      const code = String(msg.code || '').trim().toUpperCase();
      const room = rooms.get(code);
      const player = room && room.findByToken(msg.token);
      if (!player) {
        send(ws, { type: 'resume-failed', code });
        return;
      }
      attach(ws, room, player);
    },

    place(ws, msg, room) {
      room.placeFleet(ws.playerIndex, msg.ships);
      broadcastState(room);
    },

    unready(ws, msg, room) {
      room.unready(ws.playerIndex);
      broadcastState(room);
    },

    fire(ws, msg, room) {
      const outcome = room.fire(ws.playerIndex, msg.x, msg.y);
      broadcastState(room, { event: 'shot' });
      return outcome;
    },

    chat(ws, msg, room) {
      const text = String(msg.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_CHAT_LENGTH);
      if (!text) return;
      const now = Date.now();
      if (ws.lastChat && now - ws.lastChat < 400) throw new GameError('Doucement, moussaillon !');
      ws.lastChat = now;
      const player = room.players[ws.playerIndex];
      for (const other of socketsOf(room.code)) {
        send(other, { type: 'chat', from: other.playerIndex === ws.playerIndex ? 'you' : 'opponent', name: player.name, text });
      }
    },

    rename(ws, msg, room) {
      const player = room.players[ws.playerIndex];
      player.name = sanitizeName(msg.name, player.name);
      broadcastState(room);
    },

    rematch(ws, msg, room) {
      const restarted = room.requestRematch(ws.playerIndex);
      broadcastState(room, restarted ? { event: 'rematch' } : {});
    },

    leave(ws) {
      detach(ws, { leaving: true });
      send(ws, { type: 'left' });
    },
  };

  const NEEDS_ROOM = new Set(['place', 'unready', 'fire', 'chat', 'rename', 'rematch']);

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { type: 'error', message: 'Message illisible.' });
      }
      if (!msg || typeof msg.type !== 'string' || !Object.hasOwn(handlers, msg.type)) {
        return send(ws, { type: 'error', message: 'Action inconnue.' });
      }
      try {
        let room;
        if (NEEDS_ROOM.has(msg.type)) {
          room = rooms.get(ws.roomCode);
          if (!room || ws.playerIndex === undefined || !room.players[ws.playerIndex]) {
            throw new GameError("Tu n'es dans aucune partie.");
          }
        }
        handlers[msg.type](ws, msg, room);
      } catch (err) {
        if (err instanceof GameError) {
          send(ws, { type: 'error', message: err.message });
        } else {
          console.error(err);
          send(ws, { type: 'error', message: 'Erreur interne du serveur.' });
        }
      }
    });

    ws.on('close', () => detach(ws));
  });

  // Détection des connexions mortes + nettoyage des parties abandonnées.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const [code, room] of rooms) {
      const anyoneConnected = room.players.some((p) => p && p.connected);
      const idle = now - room.lastActivity;
      if (idle > ROOM_IDLE_MS || (!anyoneConnected && idle > EMPTY_ROOM_MS)) {
        for (const ws of socketsOf(code)) ws.close(4001, 'expired');
        deleteRoom(code);
      }
    }
  }, HEARTBEAT_MS);
  interval.unref();

  server.on('close', () => clearInterval(interval));

  return { server, wss, rooms };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const HOST = process.env.HOST || '0.0.0.0';
  const { server } = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`⚓ Bataille navale prête sur http://localhost:${PORT}`);
  });
}

module.exports = { createServer };
