/* ============================================================
   net.js — WebRTC peer-to-peer transport for Gamut multiplayer.

   Architecture: HOST-AUTHORITATIVE STAR (mirrors localavalon).
     - The host creates a PeerJS peer whose id is derived from the room
       code, so a joiner can reconstruct the host's id from the code alone
       — no discovery service needed.
     - Every joiner opens one DataConnection to the host. Joiners never talk
       to each other; the host aggregates scores and broadcasts state.

   SIGNALING NOTE: PeerJS needs a public "broker" once to perform the WebRTC
   handshake. After that, game traffic is direct peer-to-peer. The default
   broker (PeerJS's free cloud) needs the internet reachable for that initial
   handshake. For fully-offline LAN play, run your own PeerServer and set
   BROKER_CONFIG (see localavalon/js/net.js for the recipe).

   Exposed as a global `Net` (classic script — no ES modules), loaded before
   script.js. window.Peer comes from the PeerJS CDN <script> in index.html.
   ============================================================ */
(function (global) {
  'use strict';

  // null → use PeerJS's default public cloud broker.
  const BROKER_CONFIG = null;

  // Namespaced so gamut room codes don't collide with other PeerJS apps on
  // the shared public broker.
  const PEER_PREFIX = 'gamut-v1-';

  const CODE_ALPHABET = '0123456789';
  const CODE_LENGTH = 4;

  function peerIdForCode(code) { return PEER_PREFIX + String(code).toUpperCase(); }

  function generateRoomCode() {
    let code = '';
    const arr = new Uint32Array(CODE_LENGTH);
    (global.crypto || crypto).getRandomValues(arr);
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length];
    return code;
  }

  function normalizeCode(raw) {
    return (raw || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
  }

  function available() { return !!global.Peer; }

  function newPeer(id) {
    const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
    return id ? new global.Peer(id, opts) : new global.Peer(opts);
  }

  // --- wire helpers: JSON over the DataConnection, guarded ---
  function trySend(conn, msg) {
    try { conn.send(JSON.stringify(msg)); } catch (_) { /* torn down */ }
  }
  function safeParse(raw) {
    if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // HOST
  // ---------------------------------------------------------------------------
  function createHost(code, handlers = {}) {
    const peer = newPeer(peerIdForCode(code));
    const connections = new Map(); // connId -> DataConnection

    peer.on('open', () => {
      handlers.onNetStatus && handlers.onNetStatus('online');
      handlers.onOpen && handlers.onOpen(code);
    });

    // Broker socket dropped (phone locked / tab backgrounded). PeerJS won't
    // auto-reconnect — reuse the same room-code id so joiners stay reachable.
    peer.on('disconnected', () => {
      handlers.onNetStatus && handlers.onNetStatus('reconnecting');
      if (!peer.destroyed) { try { peer.reconnect(); } catch (_) {} }
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        // A reconnecting peer keeps its id but opens a NEW connection. Adopt
        // the new one first, then retire any prior one for the same id.
        const prev = connections.get(conn.peer);
        connections.set(conn.peer, conn);
        if (prev && prev !== conn) { try { prev.close(); } catch (_) {} }
        handlers.onConnect && handlers.onConnect(conn.peer, conn);
      });
      conn.on('data', (raw) => {
        const msg = safeParse(raw);
        if (msg) handlers.onData && handlers.onData(conn.peer, msg);
      });
      const drop = () => {
        // Only a real disconnect if THIS connection is still current for the
        // peer — a stale replaced connection must not evict the live one.
        if (connections.get(conn.peer) === conn) {
          connections.delete(conn.peer);
          handlers.onDisconnect && handlers.onDisconnect(conn.peer);
        }
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });

    peer.on('error', (err) => handlers.onError && handlers.onError(err));

    return {
      peer,
      connections,
      sendTo(connId, msg) {
        const conn = connections.get(connId);
        if (conn && conn.open) trySend(conn, msg);
      },
      broadcast(msg) {
        for (const conn of connections.values()) {
          if (conn.open) trySend(conn, msg);
        }
      },
      reconnect() {
        if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (_) {} }
      },
      destroy() { try { peer.destroy(); } catch (_) {} },
    };
  }

  // ---------------------------------------------------------------------------
  // CLIENT
  // ---------------------------------------------------------------------------
  function joinHost(code, handlers = {}) {
    const peer = newPeer(null);
    let conn = null;

    const openConn = () => {
      conn = peer.connect(peerIdForCode(code), { reliable: true });
      conn.on('open', () => handlers.onOpen && handlers.onOpen(conn));
      conn.on('data', (raw) => {
        const msg = safeParse(raw);
        if (msg) handlers.onData && handlers.onData(msg);
      });
      conn.on('close', () => handlers.onClose && handlers.onClose());
      conn.on('error', (err) => handlers.onError && handlers.onError(err));
    };

    peer.on('open', () => {
      handlers.onNetStatus && handlers.onNetStatus('online');
      openConn();
    });
    peer.on('disconnected', () => {
      handlers.onNetStatus && handlers.onNetStatus('reconnecting');
      if (!peer.destroyed) { try { peer.reconnect(); } catch (_) {} }
    });
    peer.on('error', (err) => handlers.onError && handlers.onError(err));

    return {
      peer,
      send(msg) { if (conn && conn.open) trySend(conn, msg); },
      isOpen() { return !!(conn && conn.open); },
      reconnect() {
        if (peer.destroyed) return;
        if (peer.disconnected) { try { peer.reconnect(); } catch (_) {} return; }
        if (!conn || !conn.open) openConn();
      },
      destroy() { try { peer.destroy(); } catch (_) {} },
    };
  }

  // ---------------------------------------------------------------------------
  // SERVER (authoritative WebSocket) — OPTIONAL, additive transport.
  //
  // A thin wrapper over the native WebSocket that mirrors the joinHost() client
  // surface ({ send, isOpen, reconnect, destroy }) so script.js can drive a
  // server connection and a P2P connection through the same call sites. Every
  // endpoint comes from window.GamutConfig (see config.js); if that global is
  // absent/blank, serverConfigured() is false and callers stay on P2P.
  // ---------------------------------------------------------------------------
  function serverUrl() {
    const c = global.GamutConfig;
    return (c && typeof c.SERVER_URL === 'string') ? c.SERVER_URL.trim() : '';
  }
  function serverHealthUrl() {
    const c = global.GamutConfig;
    return (c && typeof c.SERVER_HEALTH === 'string') ? c.SERVER_HEALTH.trim() : '';
  }
  // Whether server mode is even POSSIBLE (endpoints set + WebSocket exists).
  // This is a capability check, not a liveness check — see checkServerHealth.
  function serverConfigured() {
    return !!(serverUrl() && serverHealthUrl() && global.WebSocket);
  }

  // One-shot liveness probe. Resolves true only on a real ok response from
  // /health; any error, non-ok status, or timeout resolves false (never
  // rejects) so callers can simply `if (ok) revealButton()`. AbortController
  // keeps a dead host from hanging the boot path.
  function checkServerHealth(timeoutMs) {
    const url = serverHealthUrl();
    if (!url || typeof global.fetch !== 'function') return Promise.resolve(false);
    const ms = timeoutMs > 0 ? timeoutMs : 1500;
    let timer = null;
    let ctrl = null;
    try { ctrl = new AbortController(); } catch (_) { ctrl = null; }
    const opts = { method: 'GET', mode: 'cors', cache: 'no-store' };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, ms);
    }
    return global.fetch(url, opts)
      .then(function (r) { if (timer) clearTimeout(timer); return !!(r && r.ok); })
      .catch(function () { if (timer) clearTimeout(timer); return false; });
  }

  // Open a WebSocket to the server. Returns the SAME shape as joinHost() so the
  // client engine can treat either transport polymorphically:
  //   send(msg)     JSON-encode + send when OPEN (dropped otherwise, matching
  //                 trySend's best-effort P2P semantics)
  //   isOpen()      readyState === OPEN
  //   reconnect()   dial a fresh socket if the current one is closed/closing
  //   destroy()     intentional teardown — suppresses the onClose callback so a
  //                 deliberate leave isn't mistaken for a dropped connection
  function connectServer(handlers = {}) {
    let ws = null;
    let manualClose = false;

    const open = () => {
      const url = serverUrl();
      if (!url) { handlers.onError && handlers.onError({ type: 'network' }); return; }
      try { ws = new global.WebSocket(url); }
      catch (_) { handlers.onError && handlers.onError({ type: 'network' }); return; }

      ws.onopen = () => {
        handlers.onNetStatus && handlers.onNetStatus('online');
        handlers.onOpen && handlers.onOpen();
      };
      ws.onmessage = (ev) => {
        const msg = safeParse(ev && ev.data);
        if (msg) handlers.onData && handlers.onData(msg);
      };
      ws.onclose = () => {
        if (!manualClose) handlers.onClose && handlers.onClose();
      };
      // The WebSocket error event carries no useful detail; normalise it to the
      // recoverable {type:'network'} shape net.js's helpers already understand.
      ws.onerror = () => { handlers.onError && handlers.onError({ type: 'network' }); };
    };

    open();

    return {
      get socket() { return ws; },
      send(msg) {
        if (ws && ws.readyState === 1 /* OPEN */) {
          try { ws.send(JSON.stringify(msg)); } catch (_) { /* torn down mid-send */ }
        }
      },
      isOpen() { return !!(ws && ws.readyState === 1); },
      reconnect() {
        if (manualClose) return;
        // Already connecting or open — nothing to do.
        if (ws && (ws.readyState === 0 /* CONNECTING */ || ws.readyState === 1 /* OPEN */)) return;
        open();
      },
      destroy() {
        manualClose = true;
        try { if (ws) ws.close(); } catch (_) {}
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Error helpers
  // ---------------------------------------------------------------------------
  function isRecoverableError(err) {
    const t = err && err.type;
    return t === 'network' || t === 'server-error'
        || t === 'socket-error' || t === 'socket-closed' || t === 'disconnected';
  }

  function describeError(err) {
    switch (err && err.type) {
      case 'peer-unavailable':
        return 'No game found with that code. Check it, and that the host is still hosting.';
      case 'unavailable-id':
        return 'That room code is already in use. Host again for a fresh code.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        return "Couldn't reach the connection server — check your internet / Wi-Fi.";
      case 'browser-incompatible':
        return 'This browser lacks the WebRTC features multiplayer needs.';
      default:
        return 'Connection problem: ' + ((err && err.message) || 'unknown error') + '.';
    }
  }

  global.Net = {
    PEER_PREFIX, peerIdForCode, generateRoomCode, normalizeCode,
    available, createHost, joinHost, isRecoverableError, describeError,
    // OPTIONAL server transport (additive; no-op unless config.js is set).
    serverUrl, serverHealthUrl, serverConfigured, checkServerHealth, connectServer,
  };
})(window);
