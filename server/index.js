/* ============================================================
   server/index.js — the ONLY networked layer: ws + http glue.

   Everything authoritative (rooms.js, session.js, engine.js) is dependency-
   free and transport-agnostic. This file is the thin shell that binds them to
   real sockets, and the only place `ws` is imported — so the whole game loop
   stays unit-testable with zero installs (see scripts/test-server.js).

   Responsibilities, all Part-D (see GAME-SERVER-PLATFORM.md):
     • HTTP  GET /health  → liveness JSON, CORS * (the client's boot probe);
     • HTTP  GET /rooms   → debug snapshot, ONLY when EXPOSE_ROOMS is set
       (a management view — never funnelled publicly);
     • WS upgrade at "/" only, with:
         – Origin allowlist (anti-CSRF, NOT authentication),
         – global MAX_CONNS cap (per-IP is unreliable behind Tailscale Funnel,
           which presents one source IP, so we cap globally),
         – ws maxPayload (64 KiB) so a client can't send a giant frame;
     • per-socket heartbeat ping/pong to reap half-open connections;
     • idle-room GC on an interval;
     • graceful SIGTERM/SIGINT shutdown (Docker stop).

   Caddy strips the per-game path prefix (`handle_path /<game>/*`), so this
   process sees "/", "/health", "/rooms" at its own root.

   Config is entirely environment-driven — no secrets in the image:
     PORT              (default 9000)
     HOST              (default 0.0.0.0)
     ALLOWED_ORIGINS   comma list; default "https://iamyvj.github.io";
                       "*" disables the check (local dev only)
     MAX_CONNS         (default 200)
     MAX_PAYLOAD       bytes (default 65536)
     EXPOSE_ROOMS      "1"/"true" to enable GET /rooms (default off)
   ============================================================ */
'use strict';

var http = require('http');
var crypto = require('crypto');
var WS = require('ws');                       // the ONLY external dependency
var WebSocketServer = WS.Server;

var rooms = require('./rooms.js');
var sessionMod = require('./session.js');

/* ---------- config ---------- */
var PORT = Number(process.env.PORT) || 9000;
var HOST = process.env.HOST || '0.0.0.0';
var MAX_CONNS = Number(process.env.MAX_CONNS) || 200;
var MAX_PAYLOAD = Number(process.env.MAX_PAYLOAD) || 64 * 1024;
var EXPOSE_ROOMS = /^(1|true|yes)$/i.test(String(process.env.EXPOSE_ROOMS || ''));
var HEARTBEAT_MS = 30000;
// Stamped by the Docker build (ARG/ENV APP_VERSION, set to the commit SHA in
// CI) and echoed in /health so a deploy is verifiable — confirms the Pi
// actually pulled the new image. "dev" for un-stamped local runs.
var APP_VERSION = process.env.APP_VERSION || 'dev';

var ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
var ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.indexOf('*') !== -1;
if (ALLOWED_ORIGINS.length === 0) ALLOWED_ORIGINS = ['https://iamyvj.github.io'];

function originAllowed(origin) {
  if (ALLOW_ALL_ORIGINS) return true;
  if (!origin) return false;                  // browsers always send Origin on a WS upgrade
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

/* ---------- transport plumbing ---------- */
var conns = new Map();                         // pid -> ws

function sendToPid(pid, msg) {
  var ws = conns.get(pid);
  if (ws && ws.readyState === WS.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch (_) { /* torn down mid-send */ }
  }
}

var manager = new rooms.RoomManager({ send: sendToPid });

/* ---------- HTTP ---------- */
var server = http.createServer(function (req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true, version: APP_VERSION, rooms: manager.rooms.size, conns: conns.size }));
    return;
  }
  if (EXPOSE_ROOMS && req.method === 'GET' && req.url === '/rooms') {
    var list = [];
    for (var e of manager.rooms) {
      var room = e[1];
      list.push({ code: room.code, phase: room.phase, roundNo: room.roundNo, players: room.players.size });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(list));
    return;
  }
  res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
  res.end('not found');
});

/* ---------- WebSocket ---------- */
var wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

// Enforce origin, path, and the connection cap BEFORE accepting the socket.
server.on('upgrade', function (req, socket, head) {
  var pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) { pathname = req.url; }
  if (pathname !== '/') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  if (!originAllowed(req.headers.origin)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
  if (conns.size >= MAX_CONNS) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, function (ws) { wss.emit('connection', ws, req); });
});

wss.on('connection', function (ws) {
  var pid = 'p-' + crypto.randomBytes(8).toString('hex');
  conns.set(pid, ws);
  var session = new sessionMod.Session(pid, manager, sendToPid);

  ws.isAlive = true;
  ws.on('pong', function () { ws.isAlive = true; });

  ws.on('message', function (data, isBinary) {
    if (isBinary) return;                      // JSON-text protocol only
    session.handle(typeof data === 'string' ? data : data.toString());
  });
  ws.on('close', function () { conns.delete(pid); session.close(); });
  ws.on('error', function () { try { ws.terminate(); } catch (_) {} });
});

/* ---------- background timers ---------- */
// Reap half-open sockets the OS never told us about.
var beat = setInterval(function () {
  wss.clients.forEach(function (ws) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, HEARTBEAT_MS);
if (beat.unref) beat.unref();

// Garbage-collect idle/closed rooms.
var sweep = setInterval(function () { try { manager.sweep(); } catch (_) {} }, 60 * 1000);
if (sweep.unref) sweep.unref();

/* ---------- lifecycle ---------- */
function shutdown() {
  clearInterval(beat);
  clearInterval(sweep);
  try { wss.close(); } catch (_) {}
  try { server.close(function () { process.exit(0); }); } catch (_) { process.exit(0); }
  setTimeout(function () { process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, function () {
  console.log('[gamut] listening on ' + HOST + ':' + PORT +
    ' (maxConns=' + MAX_CONNS + ', maxPayload=' + MAX_PAYLOAD +
    ', origins=' + (ALLOW_ALL_ORIGINS ? '*' : ALLOWED_ORIGINS.join(',')) + ')');
});

module.exports = { server: server, wss: wss, manager: manager };
