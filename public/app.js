/* Bataille navale — client navigateur (vanilla JS, aucune dépendance). */
(() => {
  'use strict';

  const SIZE = 10;
  const COLS = 'ABCDEFGHIJ';
  const FLEET = [
    { id: 'carrier', name: 'Porte-avions', size: 5 },
    { id: 'battleship', name: 'Croiseur', size: 4 },
    { id: 'destroyer', name: 'Contre-torpilleur', size: 3 },
    { id: 'submarine', name: 'Sous-marin', size: 3 },
    { id: 'patrol', name: 'Torpilleur', size: 2 },
  ];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ---------- Stockage local (tolérant aux navigateurs qui le bloquent) ----------
  const store = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignoré */ }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch { /* ignoré */ }
    },
  };

  // ---------- État client ----------
  let ws = null;
  let wsReady = false;
  let reconnectDelay = 500;
  let state = null; // dernière vue envoyée par le serveur
  let session = store.get('bn-session'); // { code, token }
  let pendingAction = null; // action à envoyer dès que le socket est ouvert
  let overlayDismissed = false;
  let overlayDelayed = false; // laisse voir le dernier tir avant l'écran de fin
  let lastShotKey = null;

  const placement = {
    ships: [], // { id, x, y, dir }
    selected: FLEET[0].id,
    dir: 'h',
    hover: null, // [x, y]
  };

  // ---------- Sons (Web Audio, synthétisés) ----------
  const sound = (() => {
    let ctx = null;
    let muted = store.get('bn-muted', false);
    const ensure = () => {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    function noise(duration, { freq = 800, q = 1, gain = 0.6, type = 'lowpass', decay = duration } = {}) {
      const c = ensure();
      if (!c || muted) return;
      const len = Math.floor(c.sampleRate * duration);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buf;
      const filter = c.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(gain, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + decay);
      src.connect(filter).connect(g).connect(c.destination);
      src.start();
    }
    function tone(freq, duration, { type = 'sine', gain = 0.15, delay = 0, slide } = {}) {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime + delay;
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + duration);
      const g = c.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      o.connect(g).connect(c.destination);
      o.start(t);
      o.stop(t + duration);
    }
    return {
      unlock: ensure,
      get muted() { return muted; },
      toggle() { muted = !muted; store.set('bn-muted', muted); return muted; },
      miss() { noise(0.6, { freq: 1400, q: 0.7, gain: 0.35, type: 'bandpass' }); },
      hit() { noise(0.7, { freq: 500, gain: 0.9 }); tone(110, 0.5, { type: 'triangle', gain: 0.35, slide: 40 }); },
      sunk() {
        noise(1.4, { freq: 300, gain: 1 });
        tone(90, 1.2, { type: 'sawtooth', gain: 0.18, slide: 30 });
        tone(660, 0.18, { gain: 0.1, delay: 0.25 });
        tone(880, 0.3, { gain: 0.1, delay: 0.4 });
      },
      turn() { tone(740, 0.12, { gain: 0.08 }); tone(990, 0.18, { gain: 0.08, delay: 0.1 }); },
      win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.35, { type: 'triangle', gain: 0.14, delay: i * 0.14 })); },
      lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.45, { type: 'triangle', gain: 0.12, delay: i * 0.2 })); },
      join() { tone(600, 0.12, { gain: 0.08 }); tone(800, 0.12, { gain: 0.08, delay: 0.12 }); },
    };
  })();

  // ---------- Réseau ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.addEventListener('open', () => {
      wsReady = true;
      reconnectDelay = 500;
      setConnHint('');
      if (pendingAction) {
        send(pendingAction);
        pendingAction = null;
      } else if (session) {
        send({ type: 'resume', code: session.code, token: session.token });
      }
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });

    ws.addEventListener('close', (ev) => {
      wsReady = false;
      if (ev.code === 4000) {
        // Remplacé par un autre onglet : on ne se reconnecte pas.
        setStatus('Partie ouverte dans un autre onglet.', 'warn');
        return;
      }
      if (state) setStatus('Connexion perdue… reconnexion en cours', 'warn');
      setConnHint('Connexion au serveur…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    });
  }

  function send(msg) {
    if (wsReady && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Pour créer/rejoindre : envoie maintenant ou dès que la connexion est prête. */
  function sendOrQueue(msg) {
    if (!send(msg)) {
      pendingAction = msg;
      setConnHint('Connexion au serveur…');
    }
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'joined':
        session = { code: msg.code, token: msg.token };
        store.set('bn-session', session);
        setUrlCode(msg.code);
        showScreen('game');
        break;
      case 'resume-failed':
        if (session && session.code === msg.code) {
          session = null;
          store.del('bn-session');
        }
        state = null;
        showScreen('home');
        if (msg.code) $('#code-input').value = msg.code;
        $('#home-error').textContent = 'Ta partie précédente a expiré.';
        setUrlCode(null);
        break;
      case 'state':
        onState(msg.state, msg.event);
        break;
      case 'chat':
        addChat(msg);
        if (msg.from === 'opponent') sound.turn();
        break;
      case 'info':
        addSys(msg.message);
        toast(msg.message);
        if (/rejoint/.test(msg.message)) sound.join();
        break;
      case 'error':
        if ($('#home').classList.contains('hidden')) toast(msg.message, 'err');
        else $('#home-error').textContent = msg.message;
        if (/Aucune partie|complète|commencé/.test(msg.message)) {
          setUrlCode(null);
        }
        break;
      case 'left':
        session = null;
        state = null;
        store.del('bn-session');
        setUrlCode(null);
        showScreen('home');
        break;
      case 'kicked':
        toast(msg.message, 'err');
        break;
      default:
        break;
    }
  }

  // ---------- Écrans ----------
  function showScreen(name) {
    $('#home').classList.toggle('hidden', name !== 'home');
    $('#game').classList.toggle('hidden', name !== 'game');
    if (name === 'home') {
      $('#overlay').classList.add('hidden');
      document.title = 'Bataille Navale';
    }
  }

  function urlCode() {
    const p = new URLSearchParams(location.search).get('partie');
    return p ? p.trim().toUpperCase() : null;
  }

  function setUrlCode(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('partie', code);
    else url.searchParams.delete('partie');
    history.replaceState(null, '', url);
  }

  function inviteLink() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('partie', state ? state.code : session.code);
    return url.toString();
  }

  function playerName() {
    const name = $('#name-input').value.trim();
    store.set('bn-name', name);
    return name;
  }

  function setConnHint(text) {
    $('#conn-home').textContent = text;
  }

  // ---------- Grilles ----------
  function buildBoard(container, { onClick, onHover, onLeave, onContext }) {
    container.innerHTML = '';
    const cells = [];
    container.appendChild(el('div', 'label'));
    for (let x = 0; x < SIZE; x++) container.appendChild(el('div', 'label', COLS[x]));
    for (let y = 0; y < SIZE; y++) {
      container.appendChild(el('div', 'label', String(y + 1)));
      cells[y] = [];
      for (let x = 0; x < SIZE; x++) {
        const c = el('button', 'cell');
        c.type = 'button';
        c.dataset.x = x;
        c.dataset.y = y;
        c.setAttribute('aria-label', `${COLS[x]}${y + 1}`);
        if (onClick) c.addEventListener('click', () => onClick(x, y));
        if (onHover) c.addEventListener('pointerenter', () => onHover(x, y));
        if (onContext) c.addEventListener('contextmenu', (e) => { e.preventDefault(); onContext(x, y); });
        cells[y][x] = c;
        container.appendChild(c);
      }
    }
    if (onLeave) container.addEventListener('pointerleave', onLeave);
    return cells;
  }

  const myCells = buildBoard($('#my-board'), {
    onClick: onMyBoardClick,
    onHover: (x, y) => { placement.hover = [x, y]; if (isPlacing()) renderMyBoard(); },
    onLeave: () => { placement.hover = null; if (isPlacing()) renderMyBoard(); },
    onContext: () => { if (isPlacing()) rotate(); },
  });

  const enemyCells = buildBoard($('#enemy-board'), { onClick: onEnemyClick });

  function clearCell(c) {
    c.className = 'cell';
  }

  function cellsOf(ship) {
    const def = FLEET.find((f) => f.id === ship.id);
    const out = [];
    for (let i = 0; i < def.size; i++) out.push(ship.dir === 'h' ? [ship.x + i, ship.y] : [ship.x, ship.y + i]);
    return out;
  }

  function paintShip(cells, ship, extra = []) {
    const list = ship.cells || cellsOf(ship);
    list.forEach(([x, y], i) => {
      const c = cells[y][x];
      c.classList.add('ship', ship.dir, ...extra);
      if (i === 0) c.classList.add('start');
      if (i === list.length - 1) c.classList.add('end');
    });
  }

  function isPlacing() {
    return state && state.phase === 'placement' && !state.me.ready;
  }

  function canPlace(id, x, y, dir, ignoreId = id) {
    const def = FLEET.find((f) => f.id === id);
    const cells = cellsOf({ id, x, y, dir });
    if (cells.some(([cx, cy]) => cx < 0 || cy < 0 || cx >= SIZE || cy >= SIZE)) return false;
    const occupied = new Set();
    placement.ships.filter((s) => s.id !== ignoreId).forEach((s) => cellsOf(s).forEach(([cx, cy]) => occupied.add(`${cx},${cy}`)));
    return def && !cells.some(([cx, cy]) => occupied.has(`${cx},${cy}`));
  }

  function shipAt(x, y) {
    return placement.ships.find((s) => cellsOf(s).some(([cx, cy]) => cx === x && cy === y));
  }

  function onMyBoardClick(x, y) {
    sound.unlock();
    if (!isPlacing()) return;
    const sel = placement.selected;
    if (sel && canPlace(sel, x, y, placement.dir)) {
      placement.ships = placement.ships.filter((s) => s.id !== sel);
      placement.ships.push({ id: sel, x, y, dir: placement.dir });
      const next = FLEET.find((f) => !placement.ships.some((s) => s.id === f.id));
      placement.selected = next ? next.id : null;
    } else {
      const existing = shipAt(x, y);
      if (existing) {
        // Reprendre un navire déjà posé pour le déplacer.
        placement.selected = existing.id;
        placement.dir = existing.dir;
      } else if (sel) {
        toast('Impossible de placer ce navire ici.', 'err');
      }
    }
    saveDraft();
    renderPlacement();
  }

  function rotate() {
    placement.dir = placement.dir === 'h' ? 'v' : 'h';
    renderPlacement();
  }

  function randomPlacement() {
    for (;;) {
      placement.ships = [];
      let ok = true;
      for (const def of FLEET) {
        let placed = false;
        for (let i = 0; i < 300 && !placed; i++) {
          const dir = Math.random() < 0.5 ? 'h' : 'v';
          const x = Math.floor(Math.random() * (dir === 'h' ? SIZE - def.size + 1 : SIZE));
          const y = Math.floor(Math.random() * (dir === 'v' ? SIZE - def.size + 1 : SIZE));
          if (canPlace(def.id, x, y, dir)) {
            placement.ships.push({ id: def.id, x, y, dir });
            placed = true;
          }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) break;
    }
    placement.selected = null;
    saveDraft();
    renderPlacement();
  }

  function saveDraft() {
    if (state) store.set('bn-draft', { code: state.code, round: state.round, ships: placement.ships });
  }

  function loadDraft() {
    const d = store.get('bn-draft');
    if (d && state && d.code === state.code && d.round === state.round && Array.isArray(d.ships)) {
      placement.ships = d.ships.filter((s) => FLEET.some((f) => f.id === s.id));
      const next = FLEET.find((f) => !placement.ships.some((s) => s.id === f.id));
      placement.selected = next ? next.id : null;
    } else {
      placement.ships = [];
      placement.selected = FLEET[0].id;
    }
  }

  function renderMyBoard() {
    myCells.flat().forEach(clearCell);
    $('#my-board').classList.toggle('placing', isPlacing());

    if (isPlacing()) {
      placement.ships.forEach((s) => paintShip(myCells, s, s.id === placement.selected ? ['picked'] : []));
      if (placement.selected && placement.hover) {
        const [hx, hy] = placement.hover;
        const ok = canPlace(placement.selected, hx, hy, placement.dir);
        cellsOf({ id: placement.selected, x: hx, y: hy, dir: placement.dir }).forEach(([x, y]) => {
          if (x < SIZE && y < SIZE) myCells[y][x].classList.add(ok ? 'preview-ok' : 'preview-bad');
        });
      }
      return;
    }

    if (state.me.ships) {
      state.me.ships.forEach((s) => paintShip(myCells, s, s.sunk ? ['sunk'] : []));
    }
    const incoming = state.opponent ? state.opponent.shots : [];
    incoming.forEach(({ x, y, hit }) => myCells[y][x].classList.add(hit ? 'hit' : 'miss'));
    markLast(myCells, 'opponent');
  }

  function renderEnemyBoard() {
    enemyCells.flat().forEach(clearCell);
    const myTurn = state.phase === 'playing' && state.turn === 'you';
    $('#enemy-board').classList.toggle('active', myTurn);

    const shot = new Set();
    state.me.shots.forEach(({ x, y }) => shot.add(`${x},${y}`));
    if (state.opponent && state.opponent.ships) {
      state.opponent.ships.forEach((s) => paintShip(enemyCells, s, ['enemy-ship', s.sunk ? 'sunk' : 'revealed']));
    }
    state.me.shots.forEach(({ x, y, hit }) => enemyCells[y][x].classList.add(hit ? 'hit' : 'miss'));
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const c = enemyCells[y][x];
        const free = !shot.has(`${x},${y}`);
        c.classList.toggle('free', free);
        c.disabled = !(myTurn && free);
      }
    }
    markLast(enemyCells, 'you');
  }

  function markLast(cells, by) {
    const ls = state.lastShot;
    if (ls && ls.by === by && `${state.round}:${ls.by}:${ls.x},${ls.y}` === lastShotKey) {
      cells[ls.y][ls.x].classList.add('last');
    }
  }

  function onEnemyClick(x, y) {
    sound.unlock();
    if (!state || state.phase !== 'playing' || state.turn !== 'you') return;
    if (state.me.shots.some((s) => s.x === x && s.y === y)) return;
    send({ type: 'fire', x, y });
  }

  // ---------- Panneaux ----------
  function renderPlacement() {
    const picker = $('#ship-picker');
    picker.innerHTML = '';
    FLEET.forEach((def) => {
      const li = el('li');
      const b = el('button', 'btn');
      b.type = 'button';
      const placed = placement.ships.some((s) => s.id === def.id);
      b.classList.toggle('placed', placed && placement.selected !== def.id);
      b.classList.toggle('selected', placement.selected === def.id);
      b.appendChild(el('span', '', `${def.name}${placed ? ' ✓' : ''}`));
      const shape = el('span', 'shape');
      for (let i = 0; i < def.size; i++) shape.appendChild(el('i'));
      b.appendChild(shape);
      b.addEventListener('click', () => {
        placement.selected = placement.selected === def.id ? null : def.id;
        renderPlacement();
      });
      li.appendChild(b);
      picker.appendChild(li);
    });
    $('#dir-label').textContent = placement.dir === 'h' ? '(horizontal)' : '(vertical)';
    $('#ready-btn').disabled = placement.ships.length !== FLEET.length;
    if (state) renderMyBoard();
  }

  function renderFleetStatus(ul, ships, sunkIds) {
    ul.innerHTML = '';
    FLEET.forEach((def) => {
      const li = el('li');
      if (sunkIds.has(def.id)) li.classList.add('sunk');
      li.appendChild(el('span', '', def.name));
      const pips = el('span', 'pips');
      for (let i = 0; i < def.size; i++) pips.appendChild(el('i'));
      li.appendChild(pips);
      ul.appendChild(li);
    });
  }

  function setStatus(text, cls = '') {
    const s = $('#status');
    s.textContent = text;
    s.className = `status ${cls}`;
  }

  function renderStatus() {
    const opp = state.opponent;
    const oppName = opp ? opp.name : 'ton adversaire';
    if (!wsReady) return setStatus('Connexion perdue… reconnexion en cours', 'warn');

    if (state.phase === 'placement') {
      if (!opp) {
        return setStatus(`En attente d'un adversaire… Envoie-lui le code ${state.code} ou le lien 🔗`, 'wait');
      }
      if (!state.me.ready) {
        return setStatus(opp.ready ? `${oppName} est prêt ! Place ta flotte.` : 'Place ta flotte et prépare-toi au combat.', '');
      }
      return setStatus(`Flotte en position. En attente de ${oppName}…`, 'wait');
    }
    if (state.phase === 'playing') {
      if (opp && !opp.connected) return setStatus(`${oppName} s'est déconnecté… en attente de son retour`, 'warn');
      return state.turn === 'you'
        ? setStatus('🎯 À toi de tirer ! Choisis une case sur la grille ennemie.', 'turn')
        : setStatus(`${oppName} vise ta flotte…`, 'wait');
    }
    if (state.phase === 'over') {
      return state.winner === 'you'
        ? setStatus(state.forfeit ? `🏆 Victoire par abandon de ${oppName} !` : '🏆 Victoire ! Toute la flotte ennemie est au fond.', 'win')
        : setStatus(`💀 Défaite… ${oppName} a coulé ta flotte.`, 'lose');
    }
  }

  function renderHeader() {
    $('#room-code').textContent = state.code;
    $('#me-name').textContent = `${state.me.name} (toi)`;
    const opp = state.opponent;
    const dot = $('#opp-name .dot');
    dot.className = `dot ${opp ? (opp.connected ? 'on' : 'off') : ''}`;
    $('#opp-name .label').textContent = opp ? opp.name : 'en attente…';
    $('#sound-btn').textContent = sound.muted ? '🔇' : '🔊';
  }

  function renderOverlay() {
    const over = state.phase === 'over';
    $('#overlay').classList.toggle('hidden', !over || overlayDismissed || overlayDelayed);
    if (!over) return;
    const win = state.winner === 'you';
    $('#overlay-emoji').textContent = win ? '🏆' : '⚓';
    $('#overlay-title').textContent = win ? 'Victoire !' : 'Défaite…';
    const oppName = state.opponent ? state.opponent.name : 'Ton adversaire';
    const shots = state.me.shots.length;
    const hits = state.me.shots.filter((s) => s.hit).length;
    const acc = shots ? Math.round((hits / shots) * 100) : 0;
    $('#overlay-text').textContent = win
      ? (state.forfeit ? `${oppName} a abandonné le combat.` : `Flotte ennemie anéantie en ${shots} tirs (${acc}% de précision).`)
      : `${oppName} a coulé toute ta flotte. Tu as touché ${hits} fois en ${shots} tirs (${acc}%).`;

    const rb = $('#rematch-btn');
    rb.disabled = !state.opponent || state.me.rematch;
    let rs = '';
    if (!state.opponent) rs = "Ton adversaire est parti. Partage le code pour qu'un autre joueur te rejoigne.";
    else if (state.me.rematch) rs = `En attente de la réponse de ${oppName}…`;
    else if (state.opponent.rematch) rs = `${oppName} veut une revanche !`;
    $('#rematch-status').textContent = rs;
  }

  function render(prev) {
    const placing = isPlacing();
    const placementPhase = state.phase === 'placement';
    $('#placement-panel').classList.toggle('hidden', !placing);
    $('#enemy-wrap').classList.toggle('hidden', placementPhase);
    $('#unready-btn').classList.toggle('hidden', !(placementPhase && state.me.ready));
    $('.arena').classList.toggle('playing', !placementPhase);

    renderHeader();
    renderStatus();
    if (placing) renderPlacement();
    else renderMyBoard();
    if (!placementPhase) renderEnemyBoard();

    const mySunk = new Set((state.me.ships || []).filter((s) => s.sunk).map((s) => s.id));
    const enemySunk = new Set(((state.opponent && state.opponent.ships) || []).filter((s) => s.sunk).map((s) => s.id));
    $('#my-fleet').classList.toggle('hidden', placementPhase);
    renderFleetStatus($('#my-fleet'), state.me.ships, mySunk);
    renderFleetStatus($('#enemy-fleet'), null, enemySunk);

    renderOverlay();

    const myTurn = state.phase === 'playing' && state.turn === 'you';
    document.title = myTurn ? '🎯 À toi ! — Bataille Navale' : `Partie ${state.code} — Bataille Navale`;
    if (prev && !prev.opponent && state.opponent) sound.join();
  }

  function onState(next, event) {
    const prev = state;
    state = next;

    if (!prev || prev.code !== next.code || prev.round !== next.round) {
      overlayDismissed = false;
      loadDraft();
      if (prev && prev.code === next.code && next.round !== prev.round) {
        addSys('Nouvelle manche ! Replace ta flotte.');
        toast('⚔️ Revanche ! Replace ta flotte.');
      }
    }
    if (prev && prev.phase === 'placement' && next.phase === 'playing') {
      addSys('La bataille commence !');
      toast(next.turn === 'you' ? '🎯 Tu commences !' : `${next.opponent.name} commence.`);
      if (next.turn === 'you') sound.turn();
    }

    if (prev && prev.phase === 'playing' && next.phase === 'over') {
      overlayDelayed = true;
      setTimeout(() => { overlayDelayed = false; if (state) renderOverlay(); }, 1300);
    }

    if (event === 'shot' && next.lastShot) {
      const ls = next.lastShot;
      lastShotKey = `${next.round}:${ls.by}:${ls.x},${ls.y}`;
      announceShot(ls, next);
    }

    render(prev);
    lastShotKey = null; // l'animation du dernier tir n'est jouée qu'une fois

    if (prev && prev.phase === 'playing' && next.phase === 'over') {
      setTimeout(() => (next.winner === 'you' ? sound.win() : sound.lose()), 700);
    }
  }

  function announceShot(ls, s) {
    const coord = `${COLS[ls.x]}${ls.y + 1}`;
    const mine = ls.by === 'you';
    const who = mine ? 'Tu tires' : `${s.opponent ? s.opponent.name : "L'adversaire"} tire`;
    if (ls.result === 'miss') {
      sound.miss();
      toast(`${who} en ${coord} : à l'eau 💦`);
      if (!mine && s.phase === 'playing') setTimeout(sound.turn, 450);
    } else if (ls.result === 'hit') {
      sound.hit();
      toast(`${who} en ${coord} : touché ! 🔥`, 'hit');
    } else {
      sound.sunk();
      toast(mine ? `💥 Coulé ! ${ls.ship} ennemi envoyé par le fond !` : `💥 Ton ${ls.ship} a été coulé !`, 'sunk');
      addSys(mine ? `Tu as coulé le ${ls.ship} ennemi.` : `${s.opponent ? s.opponent.name : "L'adversaire"} a coulé ton ${ls.ship}.`);
    }
    if (navigator.vibrate && !mine && ls.result !== 'miss') navigator.vibrate(ls.result === 'sunk' ? [80, 60, 160] : 60);
  }

  // ---------- Chat & notifications ----------
  function addChat({ from, name, text }) {
    const log = $('#chat-log');
    const m = el('div', `msg ${from}`);
    m.appendChild(el('b', '', from === 'you' ? 'Toi' : name));
    m.appendChild(document.createTextNode(text));
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
  }

  function addSys(text) {
    const log = $('#chat-log');
    log.appendChild(el('div', 'sys', text));
    log.scrollTop = log.scrollHeight;
  }

  function toast(text, cls = '') {
    const t = el('div', `toast ${cls}`, text);
    const box = $('#toasts');
    box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 350); }, 2600);
  }

  // ---------- Événements UI ----------
  $('#name-input').value = store.get('bn-name', '') || '';

  $('#create-btn').addEventListener('click', () => {
    sound.unlock();
    $('#home-error').textContent = '';
    sendOrQueue({ type: 'create', name: playerName() });
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sound.unlock();
    $('#home-error').textContent = '';
    const code = $('#code-input').value.trim().toUpperCase();
    if (code.length < 5) {
      $('#home-error').textContent = 'Entre le code à 5 caractères de la partie.';
      return;
    }
    sendOrQueue({ type: 'join', code, name: playerName(), token: session && session.code === code ? session.token : undefined });
  });

  $('#code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('#copy-btn').addEventListener('click', async () => {
    const link = inviteLink();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ title: 'Bataille Navale', text: 'Viens m’affronter à la bataille navale !', url: link });
        return;
      } catch { /* annulé : on retombe sur la copie */ }
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Lien copié ! Envoie-le à ton adversaire 📨');
    } catch {
      window.prompt('Copie ce lien et envoie-le à ton adversaire :', link);
    }
  });

  $('#sound-btn').addEventListener('click', () => {
    const muted = sound.toggle();
    $('#sound-btn').textContent = muted ? '🔇' : '🔊';
    if (!muted) sound.turn();
  });

  $('#leave-btn').addEventListener('click', () => {
    if (state && state.phase === 'playing' && !confirm('Quitter la partie ? Tu perdras par abandon.')) return;
    if (!send({ type: 'leave' })) onMessage({ type: 'left' });
  });

  $('#rotate-btn').addEventListener('click', rotate);
  $('#random-btn').addEventListener('click', randomPlacement);
  $('#clear-btn').addEventListener('click', () => {
    placement.ships = [];
    placement.selected = FLEET[0].id;
    saveDraft();
    renderPlacement();
  });
  $('#ready-btn').addEventListener('click', () => {
    if (placement.ships.length !== FLEET.length) return;
    send({ type: 'place', ships: placement.ships });
  });
  $('#unready-btn').addEventListener('click', () => {
    if (state && state.me.ships) {
      placement.ships = state.me.ships.map(({ id, x, y, dir }) => ({ id, x, y, dir }));
      placement.selected = null;
    }
    send({ type: 'unready' });
  });

  $('#rematch-btn').addEventListener('click', () => send({ type: 'rematch' }));
  $('#view-btn').addEventListener('click', () => {
    overlayDismissed = true;
    $('#overlay').classList.add('hidden');
  });
  $('#status').addEventListener('click', () => {
    if (state && state.phase === 'over') {
      overlayDismissed = false;
      renderOverlay();
    }
  });
  $('#home-btn').addEventListener('click', () => {
    if (!send({ type: 'leave' })) onMessage({ type: 'left' });
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (send({ type: 'chat', text })) input.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.key === 'r' || e.key === 'R') && isPlacing()) rotate();
    if (e.key === 'Escape' && isPlacing()) { placement.selected = null; renderPlacement(); }
  });

  // ---------- Démarrage ----------
  const code = urlCode();
  if (code) {
    $('#code-input').value = code;
    if (session && session.code !== code) {
      // Lien vers une autre partie que la dernière : on rejoindra celle du lien.
      session = null;
      store.del('bn-session');
    }
    if (!session) {
      const savedName = store.get('bn-name', '') || '';
      if (savedName) {
        pendingAction = { type: 'join', code, name: savedName };
      } else {
        // Invité sans nom enregistré : on lui laisse choisir son nom d'abord.
        $('.tagline').textContent = `Tu es invité à la partie ${code} ! Choisis ton nom de capitaine puis clique sur « Rejoindre ».`;
        $('#name-input').focus();
      }
    }
  }
  if (session || pendingAction) setConnHint('Connexion à la partie…');
  connect();
})();
