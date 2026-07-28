/* ============================================================
   engine.js — Gamut's PURE game logic, shared by every transport.

   This module is deliberately DOM-free and side-effect-free so the exact
   same stimulus generation and scoring can run in three places:
     • the browser (single-player + P2P host)   — loaded as a classic
       <script>, it attaches to `window.Engine`;
     • the authoritative Node server (server/*)  — loaded via `require`,
       it exports the same API on `module.exports`;
     • the headless test harness.

   DUAL-TARGET: no ES-module `export` (so it stays a valid classic browser
   script) and no `require`/DOM/`window` access at load time. The UMD-lite
   footer wires it up for whichever host loaded it.

   ── Migration note (server-first pass) ────────────────────────────────
   The shipped browser (`script.js`) still carries its own copies of these
   pure functions; this file is currently the authoritative copy used by the
   *server*. The follow-up client-wiring pass will make `script.js` consume
   `Engine` and delete its duplicates, unifying the single source of truth.
   Until then, KEEP THE FORMULAS HERE IDENTICAL TO script.js.
   ============================================================ */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node
  else root.Engine = api;                                                    // browser global
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- color utilities ---------- */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s /= 100; l /= 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r1, g1, b1;
    if      (h < 60)  { r1 = c; g1 = x; b1 = 0; }
    else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
    else              { r1 = c; g1 = 0; b1 = x; }
    return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
  }

  function cmykToRgb(c, m, y, k) {
    c /= 100; m /= 100; y /= 100; k /= 100;
    return {
      r: 255 * (1 - c) * (1 - k),
      g: 255 * (1 - m) * (1 - k),
      b: 255 * (1 - y) * (1 - k)
    };
  }

  // sRGB → linear → XYZ (D65) → Lab
  function rgbToLab(rgb) {
    var toLin = function (c) {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    var R = toLin(rgb.r), G = toLin(rgb.g), B = toLin(rgb.b);
    var x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
    var y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
    var z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
    var f = function (t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); };
    var fx = f(x), fy = f(y), fz = f(z);
    return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
  }

  function deltaE76(rgb1, rgb2) {
    var l1 = rgbToLab(rgb1), l2 = rgbToLab(rgb2);
    var dL = l1.L - l2.L, da = l1.a - l2.a, db = l1.b - l2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /* ---------- pure scorers (0–100, no DOM) ---------- */

  function scoreTime(actualSec, guessSec) {
    var delta = Math.abs(actualSec - guessSec);
    return { score: Math.max(0, Math.round(100 - 150 * (delta / actualSec))), delta: delta };
  }
  function scoreCount(actual, guess) {
    var delta = Math.abs(actual - guess);
    return { score: Math.max(0, Math.round(100 - 140 * (delta / actual))), delta: delta };
  }
  function scoreAngle(actual, guess) {
    var diff = Math.abs(actual - guess) % 360;
    if (diff > 180) diff = 360 - diff;
    return { score: Math.max(0, Math.round(100 - diff * (100 / 90))), diff: diff };
  }
  function scoreColour(target, pick) {
    var dE = deltaE76(target, pick);
    return { score: Math.max(0, Math.round(100 - dE * 1.5)), dE: dE };
  }
  function scorePitch(target, guess) {
    var off = Math.abs(1200 * Math.log2(guess / target));   // cents
    return { score: Math.max(0, Math.round(100 - off / 6)), off: off };
  }
  function scoreTempo(actual, guess) {
    var delta = Math.abs(actual - guess);
    return { score: Math.max(0, Math.round(100 - 140 * (delta / actual))), delta: delta };
  }

  /* ---------- mode constants ---------- */

  var PITCH_MIN = 220;    // A3
  var PITCH_MAX = 880;    // A5
  var TEMPO_MIN = 60;
  var TEMPO_MAX = 160;

  /* ---------- per-palette random target generators ----------
     Each returns an sRGB {r,g,b} inside that palette's gamut. These MUST match
     the SPACES[*].random() bodies in script.js so a server-generated target is
     identical to a locally-generated one. */
  var SPACE_RANDOM = {
    rgb:    function () { return { r: Math.random() * 255, g: Math.random() * 255, b: Math.random() * 255 }; },
    cmyk:   function () { return cmykToRgb(Math.random() * 100, Math.random() * 100, Math.random() * 100, Math.random() * 60); },
    hsl:    function () { return hslToRgb(Math.random() * 360, 55 + Math.random() * 35, 40 + Math.random() * 30); },
    gray:   function () { var x = Math.random() * 230 + 12; return { r: x, g: x, b: x }; },
    pastel: function () { return hslToRgb(Math.random() * 360, 35 + Math.random() * 20, 78 + Math.random() * 10); },
    neon:   function () { return hslToRgb(Math.random() * 360, 85 + Math.random() * 15, 45 + Math.random() * 20); },
    jewel:  function () { return hslToRgb(Math.random() * 360, 60 + Math.random() * 30, 22 + Math.random() * 20); },
    earth:  function () { return hslToRgb(15 + Math.random() * 75, 20 + Math.random() * 35, 28 + Math.random() * 32); },
    cool:   function () { return hslToRgb(150 + Math.random() * 130, 40 + Math.random() * 45, 35 + Math.random() * 30); },
    sepia:  function () { return hslToRgb(25 + Math.random() * 15, 15 + Math.random() * 35, 20 + Math.random() * 65); }
  };

  var SPACE_KEYS = Object.keys(SPACE_RANDOM);

  function randomDotPositions(n) {
    var positions = [];
    for (var i = 0; i < n; i++) positions.push({ x: 5 + Math.random() * 90, y: 5 + Math.random() * 90 });
    return positions;
  }

  var GAME_KEYS = ['colour', 'time', 'count', 'angle', 'pitch', 'tempo'];

  /* ---------- shared per-round stimulus generator (authoritative) ----------
     Mirrors mpGenerateParams() in script.js. The server calls this once per
     round and ships the params to every peer, so everyone gets the same
     stimulus. */
  function generateParams(gameKey, spaceKey) {
    switch (gameKey) {
      case 'colour': {
        var key = SPACE_RANDOM[spaceKey] ? spaceKey : 'rgb';
        return { target: SPACE_RANDOM[key](), spaceKey: key };
      }
      case 'time':
        return { showMs: Math.round(1600 + Math.random() * 6800), hue: Math.floor(Math.random() * 360) };
      case 'count': {
        var n = 8 + Math.floor(Math.random() * 48);
        return { n: n, positions: randomDotPositions(n) };
      }
      case 'angle':
        return { angle: Math.floor(Math.random() * 360) };
      case 'pitch':
        return { freq: PITCH_MIN * Math.pow(PITCH_MAX / PITCH_MIN, Math.random()) };
      case 'tempo':
        return { bpm: TEMPO_MIN + Math.floor(Math.random() * (TEMPO_MAX - TEMPO_MIN + 1)) };
      default:
        return {};
    }
  }

  /* Coerce a peer-supplied guess into the shape each mode expects, or null if
     malformed — so a hostile peer can't inject NaN into scoring/leaderboard.
     Mirrors mpCleanGuess() in script.js. */
  function cleanGuess(gameKey, guessValue) {
    if (gameKey === 'colour') {
      if (!guessValue || typeof guessValue !== 'object') return null;
      var chan = function (v) {
        var n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : null;
      };
      var r = chan(guessValue.r), g = chan(guessValue.g), b = chan(guessValue.b);
      if (r === null || g === null || b === null) return null;
      return { r: r, g: g, b: b };
    }
    var num = Number(guessValue);
    return Number.isFinite(num) ? num : null;
  }

  function clampScore(s) {
    var n = Math.round(Number(s));
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  }

  /* ---------- authoritative scoring ----------
     Given the round's params and a *cleaned* guess, recompute the score from
     scratch. This is the whole point of server mode: the score is derived from
     the server's own params, never trusted from the client. Returns the scorer
     result ({score, ...error}) or null if the guess/params are unusable. */
  function scoreGuess(gameKey, params, guess) {
    if (guess == null || !params) return null;
    switch (gameKey) {
      case 'colour':
        if (!params.target) return null;
        return scoreColour(params.target, guess);
      case 'time':
        if (!(params.showMs > 0)) return null;
        return scoreTime(params.showMs / 1000, Number(guess));
      case 'count':
        if (!(params.n > 0)) return null;
        return scoreCount(params.n, Number(guess));
      case 'angle':
        return scoreAngle(Number(params.angle), Number(guess));
      case 'pitch':
        if (!(params.freq > 0) || !(Number(guess) > 0)) return null;
        return scorePitch(params.freq, Number(guess));
      case 'tempo':
        if (!(params.bpm > 0)) return null;
        return scoreTempo(params.bpm, Number(guess));
      default:
        return null;
    }
  }

  return {
    clamp: clamp,
    hslToRgb: hslToRgb,
    cmykToRgb: cmykToRgb,
    rgbToLab: rgbToLab,
    deltaE76: deltaE76,
    scoreTime: scoreTime,
    scoreCount: scoreCount,
    scoreAngle: scoreAngle,
    scoreColour: scoreColour,
    scorePitch: scorePitch,
    scoreTempo: scoreTempo,
    PITCH_MIN: PITCH_MIN,
    PITCH_MAX: PITCH_MAX,
    TEMPO_MIN: TEMPO_MIN,
    TEMPO_MAX: TEMPO_MAX,
    SPACE_RANDOM: SPACE_RANDOM,
    SPACE_KEYS: SPACE_KEYS,
    GAME_KEYS: GAME_KEYS,
    randomDotPositions: randomDotPositions,
    generateParams: generateParams,
    cleanGuess: cleanGuess,
    clampScore: clampScore,
    scoreGuess: scoreGuess
  };
});
