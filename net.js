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
  };
})(window);
