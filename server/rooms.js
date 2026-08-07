/* ============================================================
   server/rooms.js — authoritative, transport-agnostic room manager.

   This is the server-side twin of script.js's host-authoritative logic
   (hostStartRound / hostReveal / hostOnJoin / hostRejoinRound …), but with
   two deliberate differences that make it a *server*, not a peer:

     1. NEUTRAL AUTHORITY. In the browser P2P star the host is also a player
        (the 'host' seat). Here the server plays nothing — every participant
        is a client connection. The room *owner* (whoever created it) is just
        a client whose extra controls (start / next / endMatch / rematch /
        close / reveal-now) travel over the wire as intents. Ownership can
        migrate if the owner drops, and is reclaimed by the original owner's
        clientId if they return.

     2. SERVER RECOMPUTES SCORES. A client's `submit` carries only its guess;
        the server recomputes the score from the round's own params via
        Engine.scoreGuess. A client-claimed score is never read, so a hostile
        peer can't inject a 100.

   Transport-agnostic on purpose: the Room never touches sockets. It emits
   outbound messages through an injected `send(pid, msg)` and reads time /
   timers through an injected `clock`. index.js wires those to `ws`; the
   headless harness wires them to in-memory inboxes and a fake clock — so the
   whole game loop is exercised with zero network and zero dependencies.

   Server → client messages reuse gamut's EXISTING shapes so the pass-2 client
   wiring can consume them unchanged (welcome / lobby / round / waiting /
   reveal / matchover / ended), with two additive fields — welcome.isOwner and
   lobby.ownerId — that the current browser ignores and pass-2 will use.
   ============================================================ */
'use strict';

/* engine.js lives at the repo root so the browser can load it as a plain
   <script> (pass-2 client wiring). From server/, that's one level up. The
   Docker build copies it alongside the server. */
var Engine = require('../engine.js');

/* Mirror script.js's MP_ROUND_TIMEOUT_MS / MP_REJOIN_GRACE_MS. */
var ROUND_TIMEOUT_MS = 60000;
var REJOIN_GRACE_MS = 20000;
/* TV spectators are passive viewers (cast a room to a screen): they receive
   every broadcast but are never seated, never scored, never own, and can't
   drive the match. Capped per-room so a room can't be flooded with watchers. */
var MAX_SPECTATORS = 8;
/* A room with nobody connected is kept this long (so a dropped table can be
   reclaimed by clientId), then garbage-collected. */
var IDLE_ROOM_MS = 15 * 60 * 1000;
var CODE_LEN = 4;

/* Injected-clock seam: real timers in production, a controllable fake in tests
   so the 60s auto-reveal and 20s rejoin grace can be exercised instantly. */
var REAL_CLOCK = {
  now: function () { return Date.now(); },
  setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
  clearTimeout: function (h) { clearTimeout(h); }
};

/* Prefer crypto for room codes; fall back to Math.random if unavailable. */
var _randomInt = null;
try { _randomInt = require('crypto').randomInt; } catch (_) { _randomInt = null; }
function randDigit() {
  if (_randomInt) { try { return _randomInt(0, 10); } catch (_) { /* fall through */ } }
  return Math.floor(Math.random() * 10);
}
function makeCode() {
  var c = '';
  for (var i = 0; i < CODE_LEN; i++) c += String(randDigit());
  return c;
}

/* ============================================================
   Room — one game table.
   ============================================================ */
function Room(code, opts) {
  opts = opts || {};
  this.code = code;
  this._send = opts.send || function () {};
  this._clock = opts.clock || REAL_CLOCK;
  this.roundTimeoutMs = opts.roundTimeoutMs > 0 ? opts.roundTimeoutMs : ROUND_TIMEOUT_MS;
  this.rejoinGraceMs = opts.rejoinGraceMs >= 0 ? opts.rejoinGraceMs : REJOIN_GRACE_MS;
  this.maxSpectators = opts.maxSpectators > 0 ? opts.maxSpectators : MAX_SPECTATORS;

  this.players = new Map();      // pid -> { id,name,clientId,total,connected,roundScore,submitted,guessValue }
  this.spectators = new Map();   // pid -> { id,clientId,name } — passive viewers, no seat/score/ownership
  this.ownerId = null;           // pid of the current owner
  this.phase = 'lobby';          // 'lobby' | 'round' | 'reveal' | 'ended'
  this.roundNo = 0;
  this.gameKey = null;
  this.spaceKey = null;
  this.params = null;
  this.roundParticipants = new Set();
  this.roundStartedAt = 0;
  this.roundTimer = null;
  this.lastReveal = null;        // catch-up payload for late joiners (reveal / matchover)
  this.lastActivityAt = this._clock.now();
  this.closed = false;
}

/* ----- outbound helpers ----- */
Room.prototype.sendTo = function (pid, msg) { this._send(pid, msg); };
Room.prototype.broadcast = function (msg) {
  for (var pid of this.players.keys()) this._send(pid, msg);
  // Spectators mirror players for every broadcast (round / reveal / waiting /
  // lobby / matchover / ended) — that's the whole point of a TV view.
  for (var sid of this.spectators.keys()) this._send(sid, msg);
};
Room.prototype.touch = function () { this.lastActivityAt = this._clock.now(); };
Room.prototype._isOwner = function (pid) { return pid === this.ownerId; };
/* Soft, non-fatal refusal. Uses a distinct type so the (future) client can
   surface a toast without tearing down the connection the way 'error' does. */
Room.prototype._deny = function (pid, message) {
  this.sendTo(pid, { t: 'denied', message: message || 'Not allowed.' });
};

/* ----- seating (shared by create + join), with clientId reclaim ----- */
Room.prototype._seat = function (pid, name, clientId) {
  // Adopt any prior seat with the same clientId (keep its running total).
  var reclaimed = null;
  for (var entry of this.players) {
    var id = entry[0], pl = entry[1];
    if (pl.clientId === clientId) {
      reclaimed = pl;
      if (id !== pid) this.players.delete(id);
      break;
    }
  }
  var wasOwnerSeat = !!(reclaimed && reclaimed.id === this.ownerId);
  this.players.set(pid, {
    id: pid,
    name: name || (reclaimed && reclaimed.name) || 'Player',
    clientId: clientId,
    total: reclaimed ? reclaimed.total : 0,
    connected: true,
    roundScore: reclaimed ? reclaimed.roundScore : null,
    submitted: reclaimed ? reclaimed.submitted : false,
    guessValue: reclaimed ? reclaimed.guessValue : null
  });
  // A returning owner keeps ownership (unless it was migrated to someone still
  // connected in the meantime — that seat is no longer the ownerId).
  if (wasOwnerSeat) this.ownerId = pid;
  return reclaimed;
};

Room.prototype._welcome = function (pid) {
  var owner = this.players.get(this.ownerId);
  this.sendTo(pid, {
    t: 'welcome',
    playerId: pid,
    code: this.code,
    hostName: owner ? owner.name : '',
    isOwner: pid === this.ownerId
  });
};

/* Create the room: the first player becomes owner. */
Room.prototype.create = function (pid, info) {
  this._seat(pid, info.name, info.clientId);
  this.ownerId = pid;
  this.touch();
  this._welcome(pid);
  this.broadcastLobby();
};

/* Join (or reconnect into) an existing room. Mirrors hostOnJoin. */
Room.prototype.join = function (pid, info) {
  var reclaimed = this._seat(pid, info.name, info.clientId);
  this.touch();
  this._welcome(pid);
  this.broadcastLobby();
  // Catch a late joiner up to whatever's happening right now.
  if ((this.phase === 'reveal' || this.phase === 'ended') && this.lastReveal) {
    this.sendTo(pid, this.lastReveal);
    return;
  }
  if (this.phase === 'round') this._rejoinRound(pid, reclaimed);
};

/* Attach a passive TV spectator: it receives every broadcast but is never
   seated, scored, or an owner (a stray submit/owner intent from a spectator is
   harmlessly refused downstream — submit() needs a participant seat, owner
   intents need ownerId). Reclaim-by-clientId keeps a page refresh from
   double-counting the watcher. Returns {error:'spectators-full'} at the cap. */
Room.prototype.spectate = function (pid, info) {
  // Drop any prior spectator seat with the same clientId (refresh dedup).
  for (var entry of this.spectators) {
    var sid = entry[0], sp = entry[1];
    if (sp.clientId === info.clientId) { if (sid !== pid) this.spectators.delete(sid); break; }
  }
  if (!this.spectators.has(pid) && this.spectators.size >= this.maxSpectators) {
    return { error: 'spectators-full' };
  }
  this.spectators.set(pid, { id: pid, clientId: info.clientId, name: info.name || 'TV' });
  this.touch();
  this._welcomeSpectator(pid);

  if (this.phase === 'lobby') {
    // A single broadcast refreshes everyone's watcher count and rosters the new TV.
    this.broadcastLobby();
  } else {
    // Mid-match: give the TV a TARGETED snapshot + catch-up so we don't push a
    // stray 'lobby'/'waiting' at the players (their client keys lobby to phase).
    this.sendTo(pid, this._lobbyPayload());
    if ((this.phase === 'reveal' || this.phase === 'ended') && this.lastReveal) {
      this.sendTo(pid, this.lastReveal);
    } else if (this.phase === 'round') {
      this.sendTo(pid, {
        t: 'round', roundNo: this.roundNo, gameKey: this.gameKey,
        spaceKey: this.spaceKey, params: this.params, limitMs: this.roundTimeoutMs
      });
      this.sendTo(pid, this._waitingPayload());
    }
  }
  return { ok: true };
};

Room.prototype._welcomeSpectator = function (pid) {
  var owner = this.players.get(this.ownerId);
  this.sendTo(pid, {
    t: 'welcome', playerId: pid, code: this.code,
    hostName: owner ? owner.name : '', isOwner: false, spectator: true
  });
};

/* A player who dropped mid-round can rejoin and still play, provided they were
   a participant, haven't already submitted, and are back within grace.
   Mirrors hostRejoinRound. */
Room.prototype._rejoinRound = function (pid, reclaimed) {
  if (!reclaimed || !this.roundParticipants.has(reclaimed.id)) return;
  this.roundParticipants.delete(reclaimed.id);      // old pid is stale now
  var pl = this.players.get(pid);
  if (!pl) return;

  if (pl.submitted) {                                // already scored — just re-seat
    this.roundParticipants.add(pid);
    this.broadcastWaiting();
    this.maybeReveal();
    return;
  }
  var withinGrace = this._clock.now() - (this.roundStartedAt || 0) <= this.rejoinGraceMs;
  if (withinGrace) {
    this.roundParticipants.add(pid);
    this.sendTo(pid, {
      t: 'round', roundNo: this.roundNo, gameKey: this.gameKey,
      spaceKey: this.spaceKey, params: this.params, limitMs: this.roundTimeoutMs
    });
    this.broadcastWaiting();
  } else {
    this.maybeReveal();                              // grace expired — don't block the reveal
  }
};

/* Record a guess. THE score is recomputed here from the round's own params —
   the client never supplies it. Mirrors hostRecordSubmit + the host's submit
   guard, but authoritative. */
Room.prototype.submit = function (pid, msg) {
  if (this.phase !== 'round') return;
  if (Number(msg.roundNo) !== this.roundNo) return;   // stale/ wrong round
  if (!this.roundParticipants.has(pid)) return;        // not in this round
  var pl = this.players.get(pid);
  if (!pl || pl.submitted) return;                     // unseated or double-submit

  var clean = Engine.cleanGuess(this.gameKey, msg.guessValue);
  var scored = Engine.scoreGuess(this.gameKey, this.params, clean);
  pl.submitted = true;
  pl.roundScore = scored ? Engine.clampScore(scored.score) : 0;
  pl.guessValue = clean;
  this.touch();
  this.broadcastWaiting();
  this.maybeReveal();
};

/* ----- owner intents ----- */

Room.prototype.startRound = function (pid, msg) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can start a round.');
  var gameKey = msg && msg.gameKey;
  if (Engine.GAME_KEYS.indexOf(gameKey) === -1) return this._deny(pid, 'Unknown game.');
  var spaceKey = gameKey === 'colour'
    ? (Engine.SPACE_RANDOM[msg.spaceKey] ? msg.spaceKey : 'rgb')
    : null;

  this.roundNo += 1;
  this.gameKey = gameKey;
  this.spaceKey = spaceKey;
  this.params = Engine.generateParams(gameKey, spaceKey);
  this.phase = 'round';
  this.lastReveal = null;
  this.roundStartedAt = this._clock.now();

  this.roundParticipants = new Set();
  for (var entry of this.players) {
    var id = entry[0], pl = entry[1];
    if (pl.connected) {
      this.roundParticipants.add(id);
      pl.submitted = false; pl.roundScore = null; pl.guessValue = null;
    }
  }
  this.touch();
  this.broadcast({
    t: 'round', roundNo: this.roundNo, gameKey: gameKey,
    spaceKey: spaceKey, params: this.params, limitMs: this.roundTimeoutMs
  });
  this._armTimeout();
};

/* Owner's manual "Reveal now" (parity with the browser host button). */
Room.prototype.revealNow = function (pid) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can reveal.');
  this._reveal('manual');
};

Room.prototype.nextRound = function (pid) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can advance.');
  this._clearTimeout();
  this.phase = 'lobby';
  this.lastReveal = null;
  this.touch();
  this.broadcastLobby();
};

Room.prototype.endMatch = function (pid) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can end the match.');
  this.phase = 'ended';
  this._clearTimeout();
  var payload = { t: 'matchover', results: this._standings() };
  this.lastReveal = payload;                          // late joiners see the final board
  this.touch();
  this.broadcast(payload);
};

Room.prototype.rematch = function (pid, msg) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can rematch.');
  var reset = !!(msg && msg.reset);
  for (var pl of this.players.values()) {
    if (reset) pl.total = 0;
    pl.submitted = false; pl.roundScore = null; pl.guessValue = null;
  }
  if (reset) this.roundNo = 0;
  this._clearTimeout();
  this.phase = 'lobby';
  this.lastReveal = null;
  this.touch();
  this.broadcastLobby();
};

Room.prototype.close = function (pid) {
  if (!this._isOwner(pid)) return this._deny(pid, 'Only the room owner can close the room.');
  this._clearTimeout();
  this.broadcast({ t: 'ended' });
  this.closed = true;                                 // manager destroys it after dispatch
};

/* ----- reveal machinery ----- */

Room.prototype.maybeReveal = function () {
  if (this.phase !== 'round') return;
  for (var pid of this.roundParticipants) {
    var pl = this.players.get(pid);
    if (pl && pl.connected && !pl.submitted) return;  // still waiting on someone
  }
  this._reveal('all-in');
};

Room.prototype._reveal = function (reason) {
  if (this.phase !== 'round') return;
  this.phase = 'reveal';
  this._clearTimeout();
  var timedOut = reason === 'timeout';
  var results = [];
  for (var pid of this.roundParticipants) {
    var pl = this.players.get(pid);
    if (!pl) continue;
    var roundScore = pl.submitted ? Engine.clampScore(pl.roundScore) : 0;
    pl.total += roundScore;
    results.push({
      id: pl.id, name: pl.name, roundScore: roundScore, total: pl.total,
      submitted: pl.submitted, connected: pl.connected,
      guessValue: pl.submitted ? pl.guessValue : null
    });
  }
  results.sort(function (a, b) { return b.total - a.total || b.roundScore - a.roundScore; });
  var payload = {
    t: 'reveal', roundNo: this.roundNo, gameKey: this.gameKey,
    spaceKey: this.spaceKey, params: this.params, results: results, timedOut: timedOut
  };
  this.lastReveal = payload;
  this.touch();
  this.broadcast(payload);
};

Room.prototype._armTimeout = function () {
  this._clearTimeout();
  var self = this;
  this.roundTimer = this._clock.setTimeout(function () {
    self.roundTimer = null;
    if (self.phase === 'round') self._reveal('timeout');
  }, this.roundTimeoutMs);
};
Room.prototype._clearTimeout = function () {
  if (this.roundTimer) { this._clock.clearTimeout(this.roundTimer); this.roundTimer = null; }
};

/* ----- disconnect + owner migration ----- */

Room.prototype.disconnect = function (pid) {
  if (this.spectators.has(pid)) {       // a TV left — no seat/score to retain
    this.spectators.delete(pid);
    this.touch();
    if (this.phase === 'lobby') this.broadcastLobby();   // refresh the watcher count
    return;
  }
  var pl = this.players.get(pid);
  if (!pl) return;
  pl.connected = false;                 // keep the seat so a reconnect can reclaim it
  this.touch();
  if (pid === this.ownerId) this._migrateOwner();
  this.broadcastLobby();
  // Losing a player we were still waiting on can unblock the reveal.
  if (this.phase === 'round') { this.broadcastWaiting(); this.maybeReveal(); }
};

/* Owner dropped: hand ownership to the longest-seated still-connected player
   so the table isn't frozen. If nobody's connected, ownership stays pinned to
   the departed seat and is restored via _seat() if the original owner returns.*/
Room.prototype._migrateOwner = function () {
  for (var entry of this.players) {
    var id = entry[0], pl = entry[1];
    if (pl.connected && id !== this.ownerId) { this.ownerId = id; return; }
  }
};

/* ----- broadcasts + snapshots ----- */

/* Snapshot builders — shared by the broadcasts and by a spectator's targeted
   catch-up (so a mid-round watcher gets the current roster/board without a
   broadcast that would disturb the players). `spectators` is an additive field
   the pass-2 client ignores; the TV view uses it for a watcher count. */
Room.prototype._lobbyPayload = function () {
  var players = [];
  for (var pl of this.players.values()) {
    players.push({ id: pl.id, name: pl.name, total: pl.total, connected: pl.connected });
  }
  return { t: 'lobby', code: this.code, players: players, phase: this.phase, ownerId: this.ownerId, spectators: this.spectators.size };
};
Room.prototype._waitingPayload = function () {
  var players = [];
  for (var pid of this.roundParticipants) {
    var pl = this.players.get(pid);
    if (pl) players.push({ id: pl.id, name: pl.name, submitted: pl.submitted, connected: pl.connected });
  }
  return { t: 'waiting', roundNo: this.roundNo, players: players };
};

Room.prototype.broadcastLobby = function () { this.broadcast(this._lobbyPayload()); };
Room.prototype.broadcastWaiting = function () { this.broadcast(this._waitingPayload()); };

Room.prototype._standings = function () {
  var results = [];
  for (var pl of this.players.values()) {
    results.push({ id: pl.id, name: pl.name, total: pl.total, connected: pl.connected });
  }
  results.sort(function (a, b) { return b.total - a.total; });
  return results;
};

Room.prototype.hasConnected = function () {
  for (var pl of this.players.values()) if (pl.connected) return true;
  // A room being cast to a TV is still "in use" even with every player gone —
  // keep it out of the idle sweep so it isn't GC'd out from under the viewers.
  // Spectators are dropped on disconnect, so this frees up once the last TV
  // leaves; a silently-dead TV socket is reaped by index.js's heartbeat first.
  return this.spectators.size > 0;
};

/* ============================================================
   RoomManager — room lifecycle + pid↔room routing + idle GC.
   ============================================================ */
function RoomManager(opts) {
  opts = opts || {};
  this._send = opts.send || function () {};
  this._clock = opts.clock || REAL_CLOCK;
  this._roomOpts = {
    send: this._send,
    clock: this._clock,
    roundTimeoutMs: opts.roundTimeoutMs,
    rejoinGraceMs: opts.rejoinGraceMs,
    maxSpectators: opts.maxSpectators
  };
  this.rooms = new Map();     // code -> Room
  this.pidRoom = new Map();   // pid  -> code (one room per connection)
  this.idleMs = opts.idleMs > 0 ? opts.idleMs : IDLE_ROOM_MS;
  this.maxRooms = opts.maxRooms > 0 ? opts.maxRooms : 500;
}

RoomManager.prototype.roomOf = function (pid) {
  var code = this.pidRoom.get(pid);
  return code ? this.rooms.get(code) || null : null;
};

RoomManager.prototype._genCode = function () {
  for (var i = 0; i < 50; i++) {
    var c = makeCode();
    if (!this.rooms.has(c)) return c;
  }
  return null;
};

RoomManager.prototype.createRoom = function (pid, info) {
  if (this.pidRoom.has(pid)) return { error: 'already-in-room' };
  if (this.rooms.size >= this.maxRooms) return { error: 'server-full' };
  var code = this._genCode();
  if (!code) return { error: 'no-code' };
  var room = new Room(code, this._roomOpts);
  this.rooms.set(code, room);
  this.pidRoom.set(pid, code);
  room.create(pid, info);
  if (room.closed) this._destroy(code);
  return { code: code, room: room };
};

RoomManager.prototype.joinRoom = function (pid, code, info) {
  if (this.pidRoom.has(pid)) return { error: 'already-in-room' };
  var room = this.rooms.get(code);
  if (!room || room.closed) return { error: 'no-room' };
  this.pidRoom.set(pid, code);
  room.join(pid, info);
  return { code: code, room: room };
};

/* Attach a passive TV spectator to an existing room. Binds the pid only on
   success, so a full room (spectators-full) leaves the connection unbound and
   free to retry. Spectating never creates a room. */
RoomManager.prototype.spectateRoom = function (pid, code, info) {
  if (this.pidRoom.has(pid)) return { error: 'already-in-room' };
  var room = this.rooms.get(code);
  if (!room || room.closed) return { error: 'no-room' };
  var res = room.spectate(pid, info);
  if (res && res.error) return res;      // e.g. spectators-full — do NOT bind
  this.pidRoom.set(pid, code);
  return { code: code, room: room };
};

/* Route a per-player intent (submit / owner controls) to that pid's room. */
RoomManager.prototype.dispatch = function (pid, method, arg) {
  var room = this.roomOf(pid);
  if (!room) return { error: 'no-room' };
  if (typeof room[method] !== 'function' || method.charAt(0) === '_') return { error: 'bad-method' };
  room[method](pid, arg);
  if (room.closed) this._destroy(room.code);
  return { ok: true };
};

/* A socket closed: mark the seat disconnected (retained for clientId reclaim)
   and unbind the pid. The seat itself lingers until reclaimed or GC'd. */
RoomManager.prototype.drop = function (pid) {
  var room = this.roomOf(pid);
  this.pidRoom.delete(pid);
  if (!room) return;
  room.disconnect(pid);
  if (room.closed) this._destroy(room.code);
};

RoomManager.prototype._destroy = function (code) {
  var room = this.rooms.get(code);
  if (!room) return;
  room._clearTimeout();
  for (var pid of room.players.keys()) {
    if (this.pidRoom.get(pid) === code) this.pidRoom.delete(pid);
  }
  for (var sid of room.spectators.keys()) {
    if (this.pidRoom.get(sid) === code) this.pidRoom.delete(sid);
  }
  this.rooms.delete(code);
};

/* Reap closed rooms and rooms idle past idleMs with nobody connected. Call on
   an interval in production; call with an explicit `now` in tests. */
RoomManager.prototype.sweep = function (now) {
  var t = now == null ? this._clock.now() : now;
  var reaped = [];
  for (var entry of this.rooms) {
    var code = entry[0], room = entry[1];
    var idle = t - room.lastActivityAt;
    if (room.closed || (idle > this.idleMs && !room.hasConnected())) {
      this._destroy(code);
      reaped.push(code);
    }
  }
  return reaped;
};

module.exports = {
  Room: Room,
  RoomManager: RoomManager,
  makeCode: makeCode,
  ROUND_TIMEOUT_MS: ROUND_TIMEOUT_MS,
  REJOIN_GRACE_MS: REJOIN_GRACE_MS,
  IDLE_ROOM_MS: IDLE_ROOM_MS,
  MAX_SPECTATORS: MAX_SPECTATORS
};
