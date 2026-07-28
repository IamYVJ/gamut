/* ============================================================
   config.js — deploy-time endpoints for the OPTIONAL game server.

   Loaded before net.js and script.js (classic <script>, no modules), this
   file exposes a single global `GamutConfig`. It is the ONE place that knows
   where the authoritative WebSocket server lives.

   DUAL-TRANSPORT RULE (see GAME-SERVER-PLATFORM.md): server mode is purely
   additive. If SERVER_URL is blank, or the health probe fails, the client
   silently stays on the existing peer-to-peer (PeerJS) path — nothing about
   offline/P2P play depends on this file. The "Host on server" button only
   appears after a successful GET on SERVER_HEALTH.

   Endpoints (Caddy strips the per-game path prefix, so the server itself sees
   "/", "/health" at its own root):
     SERVER_URL     WebSocket base. The TRAILING SLASH IS REQUIRED — Caddy's
                    `handle_path /gamut/*` matches the slash form; without it
                    the upgrade 404s. Must be wss:// (secure) in production.
     SERVER_HEALTH  HTTPS liveness URL. The boot probe fetches this once; ok
                    → reveal the server-host button, fail → hide it.

   To disable server mode entirely, set both to '' (empty string).
   ============================================================ */
(function (global) {
  'use strict';

  global.GamutConfig = {
    // NOTE: trailing slash is mandatory (see header). Blank string disables.
    SERVER_URL: 'wss://pi.tail360216.ts.net/gamut/',
    SERVER_HEALTH: 'https://pi.tail360216.ts.net/gamut/health',
  };
})(window);
