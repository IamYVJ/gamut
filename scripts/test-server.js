/* ============================================================
   scripts/test-server.js — headless harness for the authoritative server.

   Runs the ENTIRE game loop with zero network and zero dependencies: it drives
   rooms.js + session.js directly through stub "sockets" (in-memory inboxes) and
   a controllable fake clock, so the 60s auto-reveal and 20s rejoin grace can be
   exercised in microseconds. `ws` is never imported.

   It plays a full multi-client match AND asserts the Part-D security
   guarantees a hostile client must not be able to break:
     • the server RECOMPUTES scores (a spoofed score:100 is ignored);
     • names are clamped to 16 chars and stripped of control characters;
     • only the room owner can start / advance / end / close;
     • a submit from a non-participant (or wrong round) is ignored;
     • a mid-game seat + score can only be reclaimed with the same clientId;
     • per-connection flooding is rate-limited (excess frames dropped);
     • malformed / oversized / shapeless frames never throw.

   Run:  node scripts/test-server.js   (or, from server/,  npm test)
   Exit code is non-zero if any assertion fails, so CI can gate on it.
   ============================================================ */
'use strict';

var rooms = require('../server/rooms.js');
var session = require('../server/session.js');
var Engine = require('../engine.js');

/* ---------- tiny assert framework ---------- */
var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label + '  (got ' + fmt(actual) + ', want ' + fmt(expected) + ')');
}
function fmt(v) { try { return JSON.stringify(v); } catch (_) { return String(v); } }
function section(name) { console.log('\n' + name); }

/* ---------- controllable fake clock ---------- */
function makeClock() {
  var t = 0, timers = [], seq = 1;
  return {
    now: function () { return t; },
    setTimeout: function (fn, ms) { var h = { id: seq++, at: t + Math.max(0, ms), fn: fn }; timers.push(h); return h; },
    clearTimeout: function (h) { var i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    // advance virtual time, firing any timers that come due (in order)
    advance: function (ms) {
      var target = t + ms;
      timers.sort(function (a, b) { return a.at - b.at; });
      while (timers.length && timers[0].at <= target) {
        var h = timers.shift(); t = h.at; try { h.fn(); } catch (_) {}
      }
      t = target;
    }
  };
}

/* ---------- test rig: manager + sessions wired to in-memory inboxes ---------- */
function makeRig(opts) {
  opts = opts || {};
  var clock = makeClock();
  var inboxes = new Map();     // pid -> array of received messages
  function send(pid, msg) { var box = inboxes.get(pid); if (box) box.push(msg); }
  var manager = new rooms.RoomManager({
    send: send, clock: clock,
    roundTimeoutMs: opts.roundTimeoutMs,
    rejoinGraceMs: opts.rejoinGraceMs,
    idleMs: opts.idleMs
  });
  var seq = 0;
  function client(sessOpts) {
    var pid = 'p' + (++seq);
    inboxes.set(pid, []);
    var sess = new session.Session(pid, manager, send, Object.assign({ clock: clock }, sessOpts || {}));
    var box = inboxes.get(pid);
    return {
      pid: pid,
      inbox: box,
      send: function (obj) { sess.handle(JSON.stringify(obj)); },   // simulate a JSON wire frame
      raw: function (str) { sess.handle(str); },                     // raw (possibly malformed) frame
      close: function () { sess.close(); },
      all: function (t) { return box.filter(function (m) { return m.t === t; }); },
      last: function (t) { var f = box.filter(function (m) { return m.t === t; }); return f.length ? f[f.length - 1] : null; },
      count: function (t) { return box.filter(function (m) { return m.t === t; }).length; },
      clear: function () { box.length = 0; }
    };
  }
  return { clock: clock, manager: manager, client: client };
}

/* Pull the current round's params off a client's last `round` message. */
function roundParams(c) { var r = c.last('round'); return r ? r.params : null; }
/* Find a player's row in a results/players array by pid. */
function rowOf(arr, pid) { for (var i = 0; i < arr.length; i++) if (arr[i].id === pid) return arr[i]; return null; }

/* ============================================================
   1. Full happy-path match + server-recomputes-scores
   ============================================================ */
function testHappyPath() {
  section('1. Full match (create / join / round / reveal) + authoritative scoring');
  var rig = makeRig();
  var alice = rig.client();
  var bob = rig.client();

  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var welcome = alice.last('welcome');
  ok(!!welcome, 'owner receives welcome');
  ok(welcome && welcome.isOwner === true, 'creator is flagged owner');
  var code = welcome && welcome.code;
  ok(/^[0-9]{4}$/.test(code || ''), 'room code is 4 digits');

  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });
  var bw = bob.last('welcome');
  ok(bw && bw.isOwner === false, 'joiner is not owner');
  eq(bw && bw.hostName, 'Alice', 'joiner sees owner name as hostName');
  var lobby = bob.last('lobby');
  ok(lobby && lobby.players.length === 2, 'lobby shows both players');
  eq(lobby && lobby.ownerId, alice.pid, 'lobby advertises the owner id');

  // Owner starts a Tempo round (numeric mode → deterministic scoring).
  alice.send({ t: 'start', gameKey: 'tempo' });
  var params = roundParams(alice);
  ok(params && params.bpm > 0, 'round params carry a bpm');
  var bpm = params.bpm;

  // Alice guesses exactly (perfect). Bob guesses off by 20 BUT claims score:100.
  alice.send({ t: 'submit', roundNo: 1, guessValue: bpm });
  bob.send({ t: 'submit', roundNo: 1, score: 100, guessValue: bpm + 20 });

  var reveal = alice.last('reveal');
  ok(!!reveal, 'reveal broadcast once all submit');
  var aRow = reveal && rowOf(reveal.results, alice.pid);
  var bRow = reveal && rowOf(reveal.results, bob.pid);
  eq(aRow && aRow.roundScore, 100, 'exact guess scores 100');

  var bExpected = Engine.clampScore(Engine.scoreTempo(bpm, bpm + 20).score);
  eq(bRow && bRow.roundScore, bExpected, 'off guess scores the recomputed value');
  ok(bRow && bRow.roundScore !== 100, 'spoofed score:100 was IGNORED (server recomputed)');
  eq(bRow && bRow.total, bExpected, 'total accumulates the recomputed score');
}

/* ============================================================
   2. Owner-only enforcement
   ============================================================ */
function testOwnerOnly() {
  section('2. Only the owner can drive the match');
  var rig = makeRig();
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });

  bob.clear();
  bob.send({ t: 'start', gameKey: 'angle' });     // non-owner tries to start
  ok(bob.last('denied'), 'non-owner start is denied');
  eq(bob.count('round'), 0, 'no round is broadcast on a denied start');
  var room = rig.manager.rooms.get(code);
  eq(room.phase, 'lobby', 'room stays in lobby after a denied start');

  // Owner starts; non-owner tries to reveal / end / close — all denied.
  alice.send({ t: 'start', gameKey: 'angle' });
  bob.clear();
  bob.send({ t: 'reveal' });
  bob.send({ t: 'endMatch' });
  bob.send({ t: 'close' });
  eq(bob.count('denied'), 3, 'non-owner reveal/endMatch/close all denied');
  eq(room.phase, 'round', 'room still mid-round after denied owner intents');
  ok(rig.manager.rooms.has(code), 'room not closed by a non-owner');
}

/* ============================================================
   3. Submit guards: non-participant + wrong round ignored
   ============================================================ */
function testSubmitGuards() {
  section('3. Submits from non-participants / wrong round are ignored');
  var rig = makeRig();
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });

  alice.send({ t: 'start', gameKey: 'count' });    // participants: alice, bob
  var carol = rig.client();
  carol.send({ t: 'join', code: code, name: 'Carol', clientId: 'cc' });  // joins mid-round
  var room = rig.manager.rooms.get(code);
  ok(!room.roundParticipants.has(carol.pid), 'mid-round joiner is NOT a participant');

  carol.send({ t: 'submit', roundNo: 1, guessValue: 10 });
  var cPlayer = room.players.get(carol.pid);
  eq(cPlayer.submitted, false, 'non-participant submit does not register');

  // Wrong round number from a real participant is ignored.
  bob.send({ t: 'submit', roundNo: 999, guessValue: 10 });
  eq(room.players.get(bob.pid).submitted, false, 'submit with wrong roundNo ignored');

  // Correct submit registers.
  bob.send({ t: 'submit', roundNo: 1, guessValue: 10 });
  eq(room.players.get(bob.pid).submitted, true, 'correct submit registers');
  // Round is still open because Alice (a participant) hasn't submitted.
  eq(room.phase, 'round', 'reveal waits on the remaining participant');
}

/* ============================================================
   4. Input sanitization: name clamp + control-char strip
   ============================================================ */
function testSanitize() {
  section('4. Name is clamped to 16 chars and stripped of control characters');
  var rig = makeRig();
  var a = rig.client();
  a.send({ t: 'create', name: 'X'.repeat(50), clientId: 'ca' });
  var code = a.last('welcome').code;
  var room = rig.manager.rooms.get(code);
  var aName = room.players.get(a.pid).name;
  eq(aName.length, 16, 'over-long name clamped to 16');

  var b = rig.client();
  b.send({ t: 'join', code: code, name: 'Bo b', clientId: 'cb' });
  eq(room.players.get(b.pid).name, 'Bob', 'control characters stripped from name');

  // Empty-after-strip name falls back to a default, never blank.
  var c = rig.client();
  c.send({ t: 'join', code: code, name: ' ', clientId: 'cc' });
  ok(room.players.get(c.pid).name.length > 0, 'blank-after-strip name gets a fallback');
}

/* ============================================================
   5. Reconnect: seat + score reclaimed only with the same clientId
   ============================================================ */
function testReclaim() {
  section('5. Seat + score reclaimed by clientId (and only by clientId)');
  var rig = makeRig();
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });

  // Play one round so Bob banks a score.
  alice.send({ t: 'start', gameKey: 'tempo' });
  var bpm = roundParams(alice).bpm;
  alice.send({ t: 'submit', roundNo: 1, guessValue: bpm });
  bob.send({ t: 'submit', roundNo: 1, guessValue: bpm });     // Bob also perfect → 100
  var room = rig.manager.rooms.get(code);
  var bobTotal = room.players.get(bob.pid).total;
  ok(bobTotal === 100, 'Bob banked 100');

  // Bob drops, then returns with the SAME clientId → reclaims seat + total.
  bob.close();
  var bob2 = rig.client();
  bob2.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });
  var reclaimedTotal = room.players.get(bob2.pid).total;
  eq(reclaimedTotal, 100, 'same clientId reclaims the banked total');
  eq(room.players.size, 2, 'reclaim did not leave a ghost seat');

  // A DIFFERENT clientId gets a fresh seat with zero total.
  var mallory = rig.client();
  mallory.send({ t: 'join', code: code, name: 'Mallory', clientId: 'zz' });
  eq(room.players.get(mallory.pid).total, 0, 'different clientId cannot inherit a score');
  eq(room.players.size, 3, 'new clientId adds a new seat');
}

/* ============================================================
   6. Mid-round reclaim within the grace window
   ============================================================ */
function testMidRoundReclaim() {
  section('6. Dropping mid-round and returning within grace resumes the round');
  var rig = makeRig({ roundTimeoutMs: 60000, rejoinGraceMs: 20000 });
  var alice = rig.client(); var bob = rig.client(); var carol = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });
  carol.send({ t: 'join', code: code, name: 'Carol', clientId: 'cc' });

  alice.send({ t: 'start', gameKey: 'tempo' });   // 3 participants, none submitted yet
  var bpm = roundParams(alice).bpm;
  var room = rig.manager.rooms.get(code);

  bob.close();                                     // Bob drops before anyone submits
  eq(room.phase, 'round', 'round stays open — connected players still owe a guess');

  rig.clock.advance(5000);                         // still inside the 20s grace
  var bob2 = rig.client();
  bob2.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });
  ok(bob2.last('round'), 'returning player gets the round resent within grace');

  alice.send({ t: 'submit', roundNo: 1, guessValue: bpm });
  carol.send({ t: 'submit', roundNo: 1, guessValue: bpm });
  bob2.send({ t: 'submit', roundNo: 1, guessValue: bpm });
  var reveal = alice.last('reveal');
  ok(reveal && rowOf(reveal.results, bob2.pid), 'resumed player appears in the reveal');
}

/* ============================================================
   7. Auto-reveal on timeout (AFK player can't stall the table)
   ============================================================ */
function testTimeout() {
  section('7. Round auto-reveals on timeout; a no-show scores 0');
  var rig = makeRig({ roundTimeoutMs: 1000 });
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });

  alice.send({ t: 'start', gameKey: 'tempo' });
  var bpm = roundParams(alice).bpm;
  alice.send({ t: 'submit', roundNo: 1, guessValue: bpm });   // Bob never submits
  var room = rig.manager.rooms.get(code);
  eq(room.phase, 'round', 'round open while the timer runs');

  rig.clock.advance(1000);                          // fire the auto-reveal timer
  var reveal = alice.last('reveal');
  ok(reveal && reveal.timedOut === true, 'reveal flagged as timed out');
  var bRow = rowOf(reveal.results, bob.pid);
  eq(bRow && bRow.roundScore, 0, 'no-show scores 0');
  eq(bRow && bRow.submitted, false, 'no-show marked not-submitted');
}

/* ============================================================
   8. Per-connection rate limiting
   ============================================================ */
function testRateLimit() {
  section('8. Flooding a connection is rate-limited');
  // Tiny bucket, no refill (clock is frozen) → exactly `bucketCap` frames pass.
  var rig = makeRig();
  var flooder = rig.client({ bucketCap: 3, refillPerSec: 1 });
  for (var i = 0; i < 12; i++) flooder.send({ t: 'join', code: 'zz', name: 'x', clientId: 'cf' });
  // A short bad code yields a 'rejected' per PROCESSED frame; drops produce nothing.
  eq(flooder.count('rejected'), 3, 'only bucketCap frames were processed, the rest dropped');
}

/* ============================================================
   9. Malformed / oversized / shapeless frames never throw
   ============================================================ */
function testRobustness() {
  section('9. Hostile/garbage frames are absorbed without throwing');
  var rig = makeRig();
  var c = rig.client({ maxMsgChars: 100 });
  var threw = false;
  try {
    c.raw('not-json{{{');
    c.raw('null');
    c.raw('[1,2,3]');
    c.raw(JSON.stringify({ noType: true }));
    c.raw(JSON.stringify({ t: 12345 }));
    c.raw(JSON.stringify({ t: 'x'.repeat(500) }));     // oversized (> maxMsgChars)
    c.raw(JSON.stringify({ t: 'submit', roundNo: NaN, guessValue: {} }));  // not in a room
  } catch (_) { threw = true; }
  ok(!threw, 'no frame threw');
  eq(rig.manager.rooms.size, 0, 'no garbage frame created a room');
}

/* ============================================================
   10. endMatch standings + close teardown
   ============================================================ */
function testEndAndClose() {
  section('10. endMatch produces sorted standings; close tears the room down');
  var rig = makeRig();
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });

  // One round where Bob wins.
  alice.send({ t: 'start', gameKey: 'tempo' });
  var bpm = roundParams(alice).bpm;
  alice.send({ t: 'submit', roundNo: 1, guessValue: bpm + 40 });   // worse
  bob.send({ t: 'submit', roundNo: 1, guessValue: bpm });          // perfect
  alice.send({ t: 'next' });

  alice.send({ t: 'endMatch' });
  var over = alice.last('matchover');
  ok(!!over, 'matchover broadcast');
  ok(over && over.results[0].id === bob.pid, 'standings sorted by total (winner first)');

  alice.send({ t: 'close' });
  ok(bob.last('ended'), 'everyone is told the room ended');
  eq(rig.manager.rooms.size, 0, 'closing destroys the room');
}

/* ============================================================
   11. Owner migration when the owner drops
   ============================================================ */
function testOwnerMigration() {
  section('11. Ownership migrates if the owner drops, and returns to them by clientId');
  var rig = makeRig();
  var alice = rig.client(); var bob = rig.client();
  alice.send({ t: 'create', name: 'Alice', clientId: 'ca' });
  var code = alice.last('welcome').code;
  bob.send({ t: 'join', code: code, name: 'Bob', clientId: 'cb' });
  var room = rig.manager.rooms.get(code);

  alice.close();                                   // owner drops
  eq(room.ownerId, bob.pid, 'ownership migrates to the remaining player');
  bob.clear();
  bob.send({ t: 'start', gameKey: 'tempo' });      // new owner can now drive
  ok(bob.last('round'), 'migrated owner can start a round');

  // Original owner returns with same clientId; Bob keeps ownership (already live).
  var alice2 = rig.client();
  alice2.send({ t: 'join', code: code, name: 'Alice', clientId: 'ca' });
  eq(room.ownerId, bob.pid, 'a live migrated owner is not displaced by the returnee');
}

/* ---------- run all ---------- */
function run() {
  console.log('gamut server — headless authoritative-logic tests');
  testHappyPath();
  testOwnerOnly();
  testSubmitGuards();
  testSanitize();
  testReclaim();
  testMidRoundReclaim();
  testTimeout();
  testRateLimit();
  testRobustness();
  testEndAndClose();
  testOwnerMigration();

  console.log('\n----------------------------------------');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed > 0) { console.log('RESULT: FAIL'); process.exit(1); }
  console.log('RESULT: PASS');
}

run();
