/* ============================================================
   server/session.js — per-connection dispatch + input hardening.

   One Session wraps one socket. It is the trust boundary: every byte here
   arrives from an untrusted client, so nothing reaches the authoritative
   RoomManager until it has been parsed, rate-limited, length-capped,
   sanitized, and bounds-checked. The Room enforces game rules and ownership;
   the Session enforces that only well-formed, non-abusive input gets that far.

   Part-D hardening implemented here (see GAME-SERVER-PLATFORM.md):
     • per-connection token-bucket rate limit (floods are dropped, not queued);
     • one-room-per-socket (a socket can create OR join exactly one room);
     • name clamp (16 chars) + control-character strip (/\p{Cc}/u);
     • clientId sanitize + length cap — reclaim is BY clientId, so a mid-game
       seat/score can only be reclaimed by someone holding that same random
       token (an attacker can't hijack a seat without it);
     • enum/bounds validation (gameKey ∈ Engine.GAME_KEYS, 4-digit code,
       finite roundNo, boolean reset);
     • the client's claimed `score` on submit is deliberately DROPPED — the
       server recomputes it (see rooms.js / Engine.scoreGuess);
     • every message is handled inside try/catch, so one malformed frame can
       never take down the connection, the room, or the process.

   Wire intents (client → server):
     create {name,clientId}                  → make a room, become owner
     join   {code,name,clientId}             → join / reconnect into a room
     spectate {code,name,clientId}           → attach a passive TV viewer
     submit {roundNo,guessValue}             → guess (score recomputed server-side)
     start  {gameKey,spaceKey}  (owner)      → begin a round
     reveal                     (owner)      → reveal now
     next                       (owner)      → back to lobby
     endMatch                   (owner)      → final standings
     rematch{reset}             (owner)      → keep/zero totals, back to lobby
     close                      (owner)      → end the room for everyone
   ============================================================ */
'use strict';

var Engine = require('../engine.js');

var NAME_MAX = 16;        // matches script.js mpSanitizeName
var CLIENTID_MAX = 64;
var CODE_LEN = 4;
var DEFAULT_MAX_MSG_CHARS = 64 * 1024;   // secondary guard; ws maxPayload is primary

var REAL_CLOCK = { now: function () { return Date.now(); } };

/* Strip control characters, trim, and clamp to the name budget. */
function sanitizeName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\p{Cc}/gu, '')
    .trim()
    .slice(0, NAME_MAX);
}
/* A stable per-device token used only to reclaim a seat. Strip control chars,
   cap length. Non-string → '' so the caller substitutes a per-socket fallback
   (which, being unique to this connection, can never reclaim another seat). */
function sanitizeClientId(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\p{Cc}/gu, '').slice(0, CLIENTID_MAX);
}
/* Room codes are digits only; mirror Net.normalizeCode. */
function normalizeCode(raw) {
  return String(raw == null ? '' : raw).replace(/\D/g, '').slice(0, CODE_LEN);
}

function Session(pid, manager, send, opts) {
  opts = opts || {};
  this.pid = pid;
  this.manager = manager;
  this._send = typeof send === 'function' ? send : function () {};
  this._clock = opts.clock || REAL_CLOCK;

  // Token bucket: capacity `bucketCap`, refilling `refillPerSec` tokens/sec.
  // Normal play spends a handful of tokens a minute; only floods hit empty.
  this.bucketCap = opts.bucketCap > 0 ? opts.bucketCap : 30;
  this.refillPerSec = opts.refillPerSec > 0 ? opts.refillPerSec : 15;
  this._tokens = this.bucketCap;
  this._bucketAt = this._clock.now();

  this.maxMsgChars = opts.maxMsgChars > 0 ? opts.maxMsgChars : DEFAULT_MAX_MSG_CHARS;
}

/* Refill by elapsed time, then try to spend one token. Returns false (drop the
   message) when the bucket is empty. */
Session.prototype._allow = function () {
  var now = this._clock.now();
  var elapsed = (now - this._bucketAt) / 1000;
  this._bucketAt = now;
  this._tokens = Math.min(this.bucketCap, this._tokens + elapsed * this.refillPerSec);
  if (this._tokens >= 1) { this._tokens -= 1; return true; }
  return false;
};

Session.prototype._parse = function (raw) {
  if (typeof raw !== 'string') {
    if (raw && typeof raw.toString === 'function') raw = raw.toString();
    else return null;
  }
  if (raw.length > this.maxMsgChars) return null;
  var msg;
  try { msg = JSON.parse(raw); } catch (_) { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
  return msg;
};

/* Entry point: index.js calls this for every inbound frame. */
Session.prototype.handle = function (raw) {
  try {
    if (!this._allow()) return;           // rate-limited: silently drop
    var msg = this._parse(raw);
    if (!msg) return;                     // unparseable / oversized / shapeless
    this._route(msg);
  } catch (_) {
    // A single bad frame must never crash the connection or the server.
    this._denied('Server error handling that message.');
  }
};

Session.prototype._route = function (msg) {
  switch (msg.t) {
    case 'create':   return this._create(msg);
    case 'join':     return this._join(msg);
    case 'spectate': return this._spectate(msg);
    case 'submit':   return this._submit(msg);
    case 'start':    return this._start(msg);
    case 'reveal':   return this._owner('revealNow', undefined);
    case 'next':     return this._owner('nextRound', undefined);
    case 'endMatch': return this._owner('endMatch', undefined);
    case 'rematch':  return this._owner('rematch', { reset: !!msg.reset });
    case 'close':    return this._owner('close', undefined);
    default:         return;              // unknown type: ignore
  }
};

Session.prototype._create = function (msg) {
  if (this.manager.roomOf(this.pid)) { this._denied('You are already in a room.'); return; }
  var info = { name: sanitizeName(msg.name), clientId: this._clientId(msg.clientId) };
  var res = this.manager.createRoom(this.pid, info);
  if (res && res.error) this._rejected(this._errText(res.error));
};

Session.prototype._join = function (msg) {
  if (this.manager.roomOf(this.pid)) { this._denied('You are already in a room.'); return; }
  var code = normalizeCode(msg.code);
  if (code.length !== CODE_LEN) { this._rejected('Enter the 4-digit room code.'); return; }
  var info = { name: sanitizeName(msg.name), clientId: this._clientId(msg.clientId) };
  var res = this.manager.joinRoom(this.pid, code, info);
  if (res && res.error) this._rejected(this._errText(res.error));
};

Session.prototype._spectate = function (msg) {
  if (this.manager.roomOf(this.pid)) { this._denied('You are already in a room.'); return; }
  var code = normalizeCode(msg.code);
  if (code.length !== CODE_LEN) { this._rejected('Enter the 4-digit room code.'); return; }
  var info = { name: sanitizeName(msg.name), clientId: this._clientId(msg.clientId) };
  var res = this.manager.spectateRoom(this.pid, code, info);
  if (res && res.error) this._rejected(this._errText(res.error));
};

Session.prototype._submit = function (msg) {
  if (!this.manager.roomOf(this.pid)) return;         // not in a room: ignore
  var roundNo = Number(msg.roundNo);
  if (!Number.isFinite(roundNo)) return;
  // guessValue is forwarded raw and cleaned by Engine.cleanGuess in the Room.
  // msg.score is intentionally NOT forwarded — the server recomputes.
  this.manager.dispatch(this.pid, 'submit', { roundNo: roundNo, guessValue: msg.guessValue });
};

Session.prototype._start = function (msg) {
  var gameKey = typeof msg.gameKey === 'string' ? msg.gameKey : '';
  if (Engine.GAME_KEYS.indexOf(gameKey) === -1) { this._denied('Unknown game.'); return; }
  var spaceKey = (gameKey === 'colour' && typeof msg.spaceKey === 'string') ? msg.spaceKey : null;
  this._owner('startRound', { gameKey: gameKey, spaceKey: spaceKey });
};

/* Route an owner intent. Ownership itself is enforced in the Room (single
   source of truth for ownerId); here we only gate on being in a room. */
Session.prototype._owner = function (method, arg) {
  if (!this.manager.roomOf(this.pid)) return;
  this.manager.dispatch(this.pid, method, arg);
};

/* Socket closed. */
Session.prototype.close = function () {
  try { this.manager.drop(this.pid); } catch (_) { /* already gone */ }
};

/* A real clientId if supplied; otherwise a per-connection fallback that is
   unique to this socket and therefore cannot reclaim any other seat. */
Session.prototype._clientId = function (raw) {
  return sanitizeClientId(raw) || ('sess-' + this.pid);
};

Session.prototype._denied = function (message) { this._send(this.pid, { t: 'denied', message: message }); };
Session.prototype._rejected = function (message) { this._send(this.pid, { t: 'rejected', message: message }); };

Session.prototype._errText = function (code) {
  switch (code) {
    case 'already-in-room': return 'You are already in a room.';
    case 'server-full':     return 'The server is full — try again shortly.';
    case 'no-code':         return "Couldn't allocate a room code — try again.";
    case 'no-room':         return 'No game found with that code. Check it and that the host is still hosting.';
    case 'spectators-full': return 'This room already has the maximum number of TV viewers.';
    default:                return 'Could not complete that request.';
  }
};

module.exports = {
  Session: Session,
  sanitizeName: sanitizeName,
  sanitizeClientId: sanitizeClientId,
  normalizeCode: normalizeCode,
  NAME_MAX: NAME_MAX,
  CLIENTID_MAX: CLIENTID_MAX
};
