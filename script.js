/* ============================================================
   Gamut — a suite of static perception games
   Sections:
     1.  Color utilities (RGB/HSL/CMYK ↔ Lab, ΔE)
     1b. Pure scorers (shared 0–100 scoring, no DOM)
     2.  Shared engine (screens, timers, observe/respond/result)
     2b. Audio (Web Audio layer for Pitch / Tempo)
     3.  Colour mode (palette selection + slider matching)
     4.  Time mode  (estimate a duration)
     5.  Count mode (estimate a dot count)
     6.  Angle mode (reproduce a needle angle)
     6b. Pitch mode (match a tone by ear)
     6c. Tempo mode (match a metronome)
     7.  Game registry + home grid
     8.  Multiplayer (WebRTC peer-to-peer, host-authoritative star)
     9.  Actions + theme + boot
   ============================================================ */


/* ---------- 1. Color utilities ---------- */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rgbToHex({ r, g, b }) {
  const h = n => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function rgbToCss({ r, g, b }) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if      (h < 60)  [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else              [r1, g1, b1] = [c, 0, x];
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
function rgbToLab({ r, g, b }) {
  const toLin = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const R = toLin(r), G = toLin(g), B = toLin(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz)
  };
}

function deltaE76(rgb1, rgb2) {
  const l1 = rgbToLab(rgb1), l2 = rgbToLab(rgb2);
  const dL = l1.L - l2.L, da = l1.a - l2.a, db = l1.b - l2.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}


/* ---------- 1b. Pure scorers ----------
   One source of truth for every mode's 0–100 scoring, shared by the
   single-player result screens and the multiplayer engine. No DOM work. */
function scoreTime(actualSec, guessSec) {
  const delta = Math.abs(actualSec - guessSec);
  return { score: Math.max(0, Math.round(100 - 150 * (delta / actualSec))), delta };
}
function scoreCount(actual, guess) {
  const delta = Math.abs(actual - guess);
  return { score: Math.max(0, Math.round(100 - 140 * (delta / actual))), delta };
}
function scoreAngle(actual, guess) {
  let diff = Math.abs(actual - guess) % 360;
  if (diff > 180) diff = 360 - diff;
  return { score: Math.max(0, Math.round(100 - diff * (100 / 90))), diff };
}
function scoreColour(target, pick) {
  const dE = deltaE76(target, pick);
  return { score: Math.max(0, Math.round(100 - dE * 1.5)), dE };
}
function scorePitch(target, guess) {
  const off = Math.abs(1200 * Math.log2(guess / target));   // cents
  return { score: Math.max(0, Math.round(100 - off / 6)), off };
}
function scoreTempo(actual, guess) {
  const delta = Math.abs(actual - guess);
  return { score: Math.max(0, Math.round(100 - 140 * (delta / actual))), delta };
}


/* ---------- 2. Shared engine ---------- */

const $ = id => document.getElementById(id);

const state = {
  gameKey: null,
  again: null,       // fn: restart a fresh round of the current game
  submit: null,      // fn: called when "Lock in" is pressed
  secondary: null,   // fn: result screen's optional secondary button
  timers: [],        // pending setTimeout/interval ids to clear on navigation
  ring: null,        // active countdown interval
  raf: null,         // pending requestAnimationFrame for the countdown ring
  sound: null        // active audio source (tunable tone / metronome) to silence on navigation
};

function setTimer(fn, ms) {
  const id = setTimeout(fn, ms);
  state.timers.push(id);
  return id;
}

function clearTimers() {
  state.timers.forEach(id => { clearTimeout(id); clearInterval(id); });
  state.timers = [];
  if (state.ring) { clearInterval(state.ring); state.ring = null; }
  if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
  if (state.sound) { state.sound.stop(); state.sound = null; }
}

function showScreen(name) {
  ['home', 'palettes', 'observe', 'respond', 'result',
   'mp-setup', 'mp-lobby', 'mp-reveal'].forEach(n => {
    const el = $(`screen-${n}`);
    const active = n === name;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function qualitative(score) {
  if (score >= 97) return 'Perfect';
  if (score >= 85) return 'Sharp eye';
  if (score >= 65) return 'Close';
  if (score >= 40) return 'Off';
  return 'Way off';
}

/* Per-mode score history in localStorage: { [gameKey]: { best, sum, n } }. */
const STATS_KEY = 'gamut-stats';

function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || {}; }
  catch { return {}; }
}

function saveStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }
  catch { /* storage unavailable (private mode) — scores just won't persist */ }
}

function recordScore(key, score) {
  const stats = loadStats();
  const e = stats[key] || { best: 0, sum: 0, n: 0 };
  const beatable = e.n > 0 ? e.best : null;
  e.n += 1;
  e.sum += score;
  e.best = Math.max(e.best, score);
  stats[key] = e;
  saveStats(stats);
  return {
    best: e.best,
    avg: Math.round(e.sum / e.n),
    n: e.n,
    isNewBest: beatable !== null && score > beatable
  };
}

/* Visible 5-second countdown ring (Colour mode only). */
function runCountdownRing(seconds, onDone) {
  const label = $('countdownLabel');
  const progress = $('countdownProgress');
  const circumference = 2 * Math.PI * 19; // ≈ 119.38
  progress.style.strokeDasharray = circumference.toFixed(2);
  progress.style.transition = 'none';
  progress.style.strokeDashoffset = '0';

  label.textContent = seconds;
  state.raf = requestAnimationFrame(() => {
    state.raf = null;
    progress.style.transition = `stroke-dashoffset ${seconds * 1000}ms linear`;
    progress.style.strokeDashoffset = String(circumference);
  });

  // Derive the digit from wall-clock elapsed rather than counting ticks, so a
  // throttled/backgrounded tab can't desync the number from the ring sweep.
  const endAt = performance.now() + seconds * 1000;
  if (state.ring) clearInterval(state.ring);
  state.ring = setInterval(() => {
    const remaining = Math.ceil((endAt - performance.now()) / 1000);
    if (remaining <= 0) {
      clearInterval(state.ring);
      state.ring = null;
      label.textContent = '0';
      onDone();
    } else {
      label.textContent = remaining;
    }
  }, 200);
}

/* Generic "get ready → flash a stimulus → hand back the real elapsed time".
   Used by the estimation games (Time / Count / Angle). */
function runObserve({ readyMs = 1000, showMs, buildStimulus, onDone }) {
  const stage = $('observeStage');
  $('observeCountdown').hidden = true;
  stage.className = 'observe-stage';
  stage.style.backgroundColor = '';   // drop any fill left over from a Colour round
  stage.innerHTML = '<div class="observe-ready">Ready…</div>';
  showScreen('observe');

  setTimer(() => {
    stage.innerHTML = '';
    buildStimulus(stage);
    const shownAt = performance.now();
    setTimer(() => {
      const elapsed = performance.now() - shownAt;
      stage.innerHTML = '';
      onDone(elapsed);
    }, showMs);
  }, readyMs);
}

/* Generic respond screen. `build(mount)` renders the input and returns a
   getter for the current guess; `onSubmit(guess)` scores and shows results. */
function runRespond({ title, sub, build, onSubmit, submitLabel = 'Lock in' }) {
  $('respondTitle').textContent = title;
  $('respondSub').textContent = sub;
  const body = $('respondBody');
  body.className = 'respond';
  body.innerHTML = '';
  $('respondSubmit').disabled = false;   // reset; a widget may re-disable to require interaction
  const getGuess = build(body);
  $('respondSubmit').textContent = submitLabel;
  state.submit = () => onSubmit(getGuess());
  showScreen('respond');
}

/* Generic result screen. */
function showResult({ compareClass = '', compareHTML, score, label, detail = '', secondary = null }) {
  if (state.sound) { state.sound.stop(); state.sound = null; }   // stop the live guess tone
  const compare = $('resultCompare');
  compare.className = `result-compare ${compareClass}`.trim();
  compare.innerHTML = compareHTML;
  $('scoreNumber').textContent = score;
  $('resultLabel').textContent = label;
  $('resultDetail').textContent = detail;

  const record = $('resultRecord');
  if (state.gameKey) {
    const r = recordScore(state.gameKey, score);
    const plays = `${r.n} play${r.n === 1 ? '' : 's'}`;
    record.textContent = `${r.isNewBest ? 'New best! · ' : ''}Best ${r.best} · Avg ${r.avg} · ${plays}`;
    record.classList.toggle('is-best', r.isNewBest);
  } else {
    record.textContent = '';
    record.classList.remove('is-best');
  }

  const secBtn = $('resultSecondary');
  if (secondary) {
    secBtn.hidden = false;
    secBtn.textContent = secondary.label;
    state.secondary = secondary.action;
  } else {
    secBtn.hidden = true;
    state.secondary = null;
  }
  showScreen('result');
}

/* Two labelled value cards, side by side (used by Time / Count / Angle). */
function valueCard({ label, value, media }) {
  return `
    <div class="value-card">
      <span class="value-label muted">${label}</span>
      ${media || ''}
      <span class="value-number">${value}</span>
    </div>`;
}
function valueRow(a, b) {
  return `<div class="value-row">${valueCard(a)}${valueCard(b)}</div>`;
}

/* A single slider with a big live readout. When `hideUntilInput` is set the
   readout stays blank until the first drag, so it doesn't anchor the guess. */
function buildValueSlider(mount, { min, max, step, init, format, hideUntilInput = false }) {
  mount.classList.add('estimate');
  mount.innerHTML = `
    <div class="readout${hideUntilInput ? ' is-empty' : ''}">${hideUntilInput ? '—' : format(init)}</div>
    <input class="range" type="range" min="${min}" max="${max}" step="${step}" value="${init}" />`;
  const input = mount.querySelector('input');
  const readout = mount.querySelector('.readout');
  // With the readout hidden, `init` is just a starting position, not a guess —
  // block submission until the player actually moves the slider.
  const submit = $('respondSubmit');
  if (hideUntilInput) submit.disabled = true;
  input.addEventListener('input', () => {
    readout.classList.remove('is-empty');
    readout.textContent = format(Number(input.value));
    submit.disabled = false;
  });
  return () => Number(input.value);
}


/* ---------- 2b. Audio (shared by Pitch / Tempo) ----------
   One AudioContext, created/resumed inside a user gesture (the mode-card
   click), which satisfies browser autoplay policies. */
let audioCtx = null;

function getAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;                       // browser has no Web Audio
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function audioAvailable() {
  return !!(window.AudioContext || window.webkitAudioContext);
}

/* One-shot note with a click-free attack/release envelope. Returns a handle
   with .stop() so a caller can silence it early (e.g. store it in state.sound);
   most callers fire-and-forget and just let it self-stop. */
function playTone(freq, ms, { type = 'sine', gain = 0.2 } = {}) {
  const ctx = getAudio();
  if (!ctx) return null;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  // Small lookahead: schedule just ahead of the clock so a freshly-resumed
  // AudioContext isn't clipped and the attack ramp starts cleanly.
  const t0 = ctx.currentTime + 0.02;
  const dur = ms / 1000;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.015);
  g.gain.setValueAtTime(gain, t0 + Math.max(0.03, dur - 0.04));
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { osc.stop(); osc.disconnect(); g.disconnect(); } catch { /* already ended */ }
    }
  };
}

/* A held oscillator whose pitch can be swept live and whose volume can be
   toggled — used to "tune" a guess in Pitch. Returns null if audio is absent. */
function createTunableTone(freq, { type = 'sine', gain = 0.18 } = {}) {
  const ctx = getAudio();
  if (!ctx) return null;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.value = 0;                            // start silent
  osc.connect(g).connect(ctx.destination);
  osc.start();
  let stopped = false;
  return {
    setFreq(f) { if (!stopped) osc.frequency.setTargetAtTime(f, ctx.currentTime, 0.01); },
    on()  { if (!stopped) g.gain.setTargetAtTime(gain, ctx.currentTime, 0.02); },
    off() { if (!stopped) g.gain.setTargetAtTime(0, ctx.currentTime, 0.05); },
    stop() {
      if (stopped) return;
      stopped = true;
      try { osc.stop(); osc.disconnect(); g.disconnect(); } catch { /* already gone */ }
    }
  };
}

/* A repeating click at a given BPM that can be started/stopped and retimed
   live — used to preview a guessed tempo. Returns null if audio is absent. */
function createMetronome(bpm, { freq = 1000, gain = 0.25 } = {}) {
  if (!getAudio()) return null;
  let interval = 60000 / bpm;
  let timer = null;
  let running = false;
  const tick = () => playTone(freq, 55, { type: 'square', gain });
  return {
    setBpm(b) {
      interval = 60000 / b;
      if (running) { clearInterval(timer); timer = setInterval(tick, interval); }
    },
    start() { if (running) return; running = true; tick(); timer = setInterval(tick, interval); },
    stop()  { running = false; clearInterval(timer); }
  };
}


/* ---------- 3. Colour mode ---------- */

/* Each space defines display metadata, slider channels, a toRgb(values)
   converter, and a random() target generator within the space's gamut. */
const SPACES = {
  rgb: {
    name: 'RGB',
    desc: 'The full 24-bit spectrum.',
    preview: 'linear-gradient(90deg, #ff3b3b, #ffd23b, #3bff7a, #3bd1ff, #6a3bff, #ff3bd1)',
    channels: [
      { key: 'r', label: 'R', min: 0, max: 255, step: 1, init: 128,
        gradient: v => `linear-gradient(90deg, rgb(0,${v.g},${v.b}), rgb(255,${v.g},${v.b}))` },
      { key: 'g', label: 'G', min: 0, max: 255, step: 1, init: 128,
        gradient: v => `linear-gradient(90deg, rgb(${v.r},0,${v.b}), rgb(${v.r},255,${v.b}))` },
      { key: 'b', label: 'B', min: 0, max: 255, step: 1, init: 128,
        gradient: v => `linear-gradient(90deg, rgb(${v.r},${v.g},0), rgb(${v.r},${v.g},255))` }
    ],
    toRgb(v) { return { r: v.r, g: v.g, b: v.b }; },
    random() {
      return { r: Math.random() * 255, g: Math.random() * 255, b: Math.random() * 255 };
    }
  },
  cmyk: {
    name: 'CMYK',
    desc: 'Print-style cyan, magenta, yellow, black.',
    preview: 'linear-gradient(90deg, #00bcd4, #e91e63, #ffeb3b, #222)',
    channels: [
      { key: 'c', label: 'C', min: 0, max: 100, step: 1, init: 0,
        gradient: v => cmykGradient(0, v.m, v.y, v.k, 100, v.m, v.y, v.k) },
      { key: 'm', label: 'M', min: 0, max: 100, step: 1, init: 0,
        gradient: v => cmykGradient(v.c, 0, v.y, v.k, v.c, 100, v.y, v.k) },
      { key: 'y', label: 'Y', min: 0, max: 100, step: 1, init: 0,
        gradient: v => cmykGradient(v.c, v.m, 0, v.k, v.c, v.m, 100, v.k) },
      { key: 'k', label: 'K', min: 0, max: 100, step: 1, init: 0,
        gradient: v => cmykGradient(v.c, v.m, v.y, 0, v.c, v.m, v.y, 100) }
    ],
    toRgb(v) { return cmykToRgb(v.c, v.m, v.y, v.k); },
    random() {
      return cmykToRgb(Math.random()*100, Math.random()*100, Math.random()*100, Math.random()*60);
    }
  },
  hsl: {
    name: 'HSL',
    desc: 'Hue-focused, vivid and saturated.',
    preview: 'linear-gradient(90deg, hsl(0,80%,55%), hsl(60,80%,55%), hsl(120,80%,45%), hsl(200,80%,55%), hsl(280,80%,55%), hsl(340,80%,55%))',
    channels: [
      { key: 'h', label: 'H', min: 0, max: 360, step: 1, init: 180,
        gradient: v => hueGradient(v.s, v.l) },
      { key: 's', label: 'S', min: 0, max: 100, step: 1, init: 70,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},0%,${v.l}%), hsl(${v.h},100%,${v.l}%))` },
      { key: 'l', label: 'L', min: 0, max: 100, step: 1, init: 50,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,0%), hsl(${v.h},${v.s}%,50%), hsl(${v.h},${v.s}%,100%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(Math.random()*360, 55+Math.random()*35, 40+Math.random()*30);
    }
  },
  gray: {
    name: 'Grayscale',
    desc: 'Hard mode — only luminance varies.',
    preview: 'linear-gradient(90deg, #111, #555, #888, #bbb, #eee)',
    channels: [
      { key: 'l', label: 'L', min: 0, max: 255, step: 1, init: 128,
        gradient: () => 'linear-gradient(90deg, #000, #fff)' }
    ],
    toRgb(v) { return { r: v.l, g: v.l, b: v.l }; },
    random() {
      const x = Math.random()*230 + 12;
      return { r: x, g: x, b: x };
    }
  },
  pastel: {
    name: 'Pastels',
    desc: 'Soft, low-saturation hues.',
    preview: 'linear-gradient(90deg, #ffd6d6, #ffe9c2, #d6f5d6, #cfe7ff, #e6d6ff, #ffd6f0)',
    channels: [
      { key: 'h', label: 'H', min: 0, max: 360, step: 1, init: 180,
        gradient: v => hueGradient(v.s, v.l) },
      { key: 's', label: 'S', min: 35, max: 55, step: 1, init: 45,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},35%,${v.l}%), hsl(${v.h},55%,${v.l}%))` },
      { key: 'l', label: 'L', min: 78, max: 88, step: 1, init: 83,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,78%), hsl(${v.h},${v.s}%,88%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(Math.random()*360, 35+Math.random()*20, 78+Math.random()*10);
    }
  },
  neon: {
    name: 'Neon',
    desc: 'Electric, high-saturation hues.',
    preview: 'linear-gradient(90deg, #ff2bd6, #ff5e1a, #fff62b, #2bff7a, #2be3ff, #6a2bff)',
    channels: [
      { key: 'h', label: 'H', min: 0, max: 360, step: 1, init: 300,
        gradient: v => hueGradient(v.s, v.l) },
      { key: 's', label: 'S', min: 85, max: 100, step: 1, init: 95,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},85%,${v.l}%), hsl(${v.h},100%,${v.l}%))` },
      { key: 'l', label: 'L', min: 45, max: 65, step: 1, init: 55,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,45%), hsl(${v.h},${v.s}%,65%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(Math.random()*360, 85+Math.random()*15, 45+Math.random()*20);
    }
  },
  jewel: {
    name: 'Jewel tones',
    desc: 'Deep, rich emerald-sapphire-ruby.',
    preview: 'linear-gradient(90deg, #8b1a3a, #b8860b, #1a6b4a, #1a4a8b, #5a1a8b, #8b1a6b)',
    channels: [
      { key: 'h', label: 'H', min: 0, max: 360, step: 1, init: 240,
        gradient: v => hueGradient(v.s, v.l) },
      { key: 's', label: 'S', min: 60, max: 90, step: 1, init: 75,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},60%,${v.l}%), hsl(${v.h},90%,${v.l}%))` },
      { key: 'l', label: 'L', min: 22, max: 42, step: 1, init: 32,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,22%), hsl(${v.h},${v.s}%,42%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(Math.random()*360, 60+Math.random()*30, 22+Math.random()*20);
    }
  },
  earth: {
    name: 'Earth tones',
    desc: 'Ochre, clay, moss, terracotta.',
    preview: 'linear-gradient(90deg, #8b5a3c, #b8924a, #a89060, #6b7a3d, #4a6b3d, #8b6b4a)',
    channels: [
      { key: 'h', label: 'H', min: 15, max: 90, step: 1, init: 35,
        gradient: v => {
          const stops = [];
          for (let h = 15; h <= 90; h += 15) stops.push(`hsl(${h},${v.s}%,${v.l}%)`);
          return `linear-gradient(90deg, ${stops.join(',')})`;
        } },
      { key: 's', label: 'S', min: 20, max: 55, step: 1, init: 40,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},20%,${v.l}%), hsl(${v.h},55%,${v.l}%))` },
      { key: 'l', label: 'L', min: 28, max: 60, step: 1, init: 45,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,28%), hsl(${v.h},${v.s}%,60%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(15+Math.random()*75, 20+Math.random()*35, 28+Math.random()*32);
    }
  },
  cool: {
    name: 'Cool',
    desc: 'Blues, greens, and violets.',
    preview: 'linear-gradient(90deg, #2bb38a, #2b9bb3, #2b6bb3, #4a2bb3, #7a2bb3)',
    channels: [
      { key: 'h', label: 'H', min: 150, max: 280, step: 1, init: 210,
        gradient: v => {
          const stops = [];
          for (let h = 150; h <= 280; h += 20) stops.push(`hsl(${h},${v.s}%,${v.l}%)`);
          return `linear-gradient(90deg, ${stops.join(',')})`;
        } },
      { key: 's', label: 'S', min: 40, max: 85, step: 1, init: 65,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},40%,${v.l}%), hsl(${v.h},85%,${v.l}%))` },
      { key: 'l', label: 'L', min: 35, max: 65, step: 1, init: 50,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,35%), hsl(${v.h},${v.s}%,65%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(150+Math.random()*130, 40+Math.random()*45, 35+Math.random()*30);
    }
  },
  sepia: {
    name: 'Sepia',
    desc: 'Warm browns, like old photographs.',
    preview: 'linear-gradient(90deg, #3a2a1a, #6b4a2a, #9a7a4a, #c8a87a, #e8d5b0)',
    channels: [
      { key: 'h', label: 'H', min: 25, max: 40, step: 1, init: 32,
        gradient: v => {
          const stops = [];
          for (let h = 25; h <= 40; h += 3) stops.push(`hsl(${h},${v.s}%,${v.l}%)`);
          return `linear-gradient(90deg, ${stops.join(',')})`;
        } },
      { key: 's', label: 'S', min: 15, max: 50, step: 1, init: 35,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},15%,${v.l}%), hsl(${v.h},50%,${v.l}%))` },
      { key: 'l', label: 'L', min: 20, max: 85, step: 1, init: 50,
        gradient: v => `linear-gradient(90deg, hsl(${v.h},${v.s}%,20%), hsl(${v.h},${v.s}%,85%))` }
    ],
    toRgb(v) { return hslToRgb(v.h, v.s, v.l); },
    random() {
      return hslToRgb(25+Math.random()*15, 15+Math.random()*35, 20+Math.random()*65);
    }
  }
};

/* Helper: full 7-stop hue rainbow at given S/L. */
function hueGradient(s, l) {
  const stops = [];
  for (let h = 0; h <= 360; h += 60) stops.push(`hsl(${h},${s}%,${l}%)`);
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

/* Helper: 5-stop CMYK gradient between two endpoints (CSS can't do CMYK). */
function cmykGradient(c1, m1, y1, k1, c2, m2, y2, k2) {
  const stops = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const c = c1 + (c2 - c1) * t;
    const m = m1 + (m2 - m1) * t;
    const y = y1 + (y2 - y1) * t;
    const k = k1 + (k2 - k1) * t;
    stops.push(rgbToCss(cmykToRgb(c, m, y, k)));
  }
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

const colour = { spaceKey: null, target: null, values: null };

function startColour() {
  state.gameKey = 'colour';
  renderSpaceCards();
  showScreen('palettes');
}

function renderSpaceCards() {
  const grid = $('spaceGrid');
  grid.innerHTML = '';
  Object.entries(SPACES).forEach(([key, space]) => {
    const card = document.createElement('button');
    card.className = 'space-card';
    card.type = 'button';
    card.innerHTML = `
      <div class="space-preview" style="background: ${space.preview}"></div>
      <div class="space-name">${space.name}</div>
      <p class="space-desc">${space.desc}</p>`;
    card.addEventListener('click', () => startColourRound(key));
    grid.appendChild(card);
  });
}

function startColourRound(spaceKey) {
  colour.spaceKey = spaceKey;
  colour.target = SPACES[spaceKey].random();
  // Scores are keyed per palette — a ΔE on Grayscale isn't comparable to Neon.
  state.gameKey = `colour:${spaceKey}`;
  state.again = () => startColourRound(spaceKey);

  const stage = $('observeStage');
  stage.className = 'observe-stage observe-stage--fill';
  stage.innerHTML = '';
  stage.style.backgroundColor = rgbToCss(colour.target);
  $('observeCountdown').hidden = false;
  showScreen('observe');
  runCountdownRing(5, colourRespond);
}

function colourRespond() {
  const space = SPACES[colour.spaceKey];
  colour.values = {};
  space.channels.forEach(ch => { colour.values[ch.key] = ch.init; });

  runRespond({
    title: 'Mix the match',
    sub: `Dial in the color you saw using the ${space.name} controls.`,
    build: (mount) => {
      buildColourPicker(mount, space);
      return () => space.toRgb(colour.values);
    },
    onSubmit: (pick) => colourResult(colour.target, pick)
  });
}

function buildColourPicker(mount, space) {
  mount.classList.add('picker');
  mount.innerHTML = `
    <div class="picker-preview" id="pickerPreview" aria-live="polite">
      <span class="picker-hex" id="pickerHex">#000000</span>
    </div>
    <div class="picker-controls" id="pickerControls"></div>`;
  const controls = mount.querySelector('#pickerControls');

  space.channels.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <label for="slider-${ch.key}">${ch.label}</label>
      <input id="slider-${ch.key}" class="range" type="range"
             min="${ch.min}" max="${ch.max}" step="${ch.step}" value="${ch.init}" />
      <output for="slider-${ch.key}">${ch.init}</output>`;
    const input = row.querySelector('input');
    const output = row.querySelector('output');
    input.addEventListener('input', () => {
      const val = Number(input.value);
      colour.values[ch.key] = val;
      output.textContent = val;
      updatePickerPreview(space);
    });
    controls.appendChild(row);
  });

  updatePickerPreview(space);
}

function updatePickerPreview(space) {
  const rgb = space.toRgb(colour.values);
  $('pickerPreview').style.backgroundColor = rgbToCss(rgb);
  $('pickerHex').textContent = rgbToHex(rgb);
  space.channels.forEach(ch => {
    const input = $(`slider-${ch.key}`);
    if (input && ch.gradient) {
      const track = ch.gradient(colour.values);
      if (input._track !== track) {        // skip redundant style writes
        input.style.setProperty('--track', track);
        input._track = track;
      }
    }
  });
}

function colourResult(target, pick) {
  const { score, dE } = scoreColour(target, pick);
  const compareHTML = `
    <figure class="result-swatch">
      <div class="result-color" style="background:${rgbToCss(target)}"></div>
      <figcaption><span class="muted">Target</span><span class="hex">${rgbToHex(target)}</span></figcaption>
    </figure>
    <figure class="result-swatch">
      <div class="result-color" style="background:${rgbToCss(pick)}"></div>
      <figcaption><span class="muted">Your pick</span><span class="hex">${rgbToHex(pick)}</span></figcaption>
    </figure>`;
  showResult({
    compareClass: 'result-compare--swatches',
    compareHTML,
    score,
    label: qualitative(score),
    detail: `ΔE ${dE.toFixed(1)}`,
    secondary: { label: 'Change palette', action: () => { renderSpaceCards(); showScreen('palettes'); } }
  });
}


/* ---------- 4. Time mode ---------- */

function startTime() {
  state.gameKey = 'time';
  state.again = startTime;
  const plannedMs = 1600 + Math.random() * 6800; // 1.6–8.4s

  runObserve({
    readyMs: 1100,
    showMs: plannedMs,
    buildStimulus: (stage) => {
      const hue = Math.floor(Math.random() * 360);
      const disc = document.createElement('div');
      disc.className = 'stim-disc';
      disc.style.background = `radial-gradient(circle at 35% 30%, hsl(${hue},85%,72%), hsl(${hue},70%,45%))`;
      stage.appendChild(disc);
    },
    onDone: (elapsedMs) => timeRespond(elapsedMs / 1000)
  });
}

function timeRespond(actualSec) {
  runRespond({
    title: 'How long was it shown?',
    sub: 'Drag to your best estimate, then lock it in.',
    build: (mount) => buildValueSlider(mount, {
      min: 0.5, max: 10, step: 0.1, init: 4,
      format: v => `${v.toFixed(1)}s`,
      hideUntilInput: true
    }),
    onSubmit: (guess) => timeResult(actualSec, guess)
  });
}

function timeResult(actualSec, guessSec) {
  const { score, delta } = scoreTime(actualSec, guessSec);
  const compareHTML = valueRow(
    { label: 'Shown for', value: `${actualSec.toFixed(1)}s` },
    { label: 'You guessed', value: `${guessSec.toFixed(1)}s` }
  );
  showResult({
    compareClass: 'result-compare--values',
    compareHTML,
    score,
    label: qualitative(score),
    detail: `off by ${delta.toFixed(1)}s`
  });
}


/* ---------- 5. Count mode ---------- */

/* Random dot layout as plain data, so multiplayer can generate it once on the
   host and ship the same positions to every peer (identical stimulus). */
function randomDotPositions(n) {
  const positions = [];
  for (let i = 0; i < n; i++) {
    positions.push({ x: 5 + Math.random() * 90, y: 5 + Math.random() * 90 });
  }
  return positions;
}

function buildDots(positions) {
  const box = document.createElement('div');
  box.className = 'stim-dots';
  positions.forEach(p => {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.left = `${p.x}%`;
    dot.style.top = `${p.y}%`;
    box.appendChild(dot);
  });
  return box;
}

function startCount() {
  state.gameKey = 'count';
  state.again = startCount;
  const n = 8 + Math.floor(Math.random() * 48); // 8–55
  const dots = buildDots(randomDotPositions(n));

  runObserve({
    readyMs: 1000,
    showMs: 700,
    buildStimulus: (stage) => stage.appendChild(dots),
    onDone: () => countRespond(n, dots.outerHTML)
  });
}

function countRespond(actual, dotsHTML) {
  runRespond({
    title: 'How many dots?',
    sub: 'Estimate the count you saw, then lock it in.',
    build: (mount) => buildValueSlider(mount, {
      min: 1, max: 70, step: 1, init: 20,
      format: v => String(v),
      hideUntilInput: true   // don't anchor the guess to the default
    }),
    onSubmit: (guess) => countResult(actual, guess, dotsHTML)
  });
}

function countResult(actual, guess, dotsHTML) {
  const { score, delta } = scoreCount(actual, guess);
  const compareHTML = `
    <div class="dots-replay">${dotsHTML}</div>
    ${valueRow(
      { label: 'Actual', value: String(actual) },
      { label: 'You guessed', value: String(guess) }
    )}`;
  showResult({
    compareClass: 'result-compare--values',
    compareHTML,
    score,
    label: qualitative(score),
    detail: delta === 0 ? 'exact' : `off by ${delta}`
  });
}


/* ---------- 6. Angle mode ---------- */

function dialMarkup(angle, extraClass = '') {
  return `
    <div class="dial ${extraClass}">
      <span class="dial-needle" style="transform: rotate(${angle}deg)"></span>
      <span class="dial-center"></span>
    </div>`;
}

function startAngle() {
  state.gameKey = 'angle';
  state.again = startAngle;
  const actual = Math.floor(Math.random() * 360);

  runObserve({
    readyMs: 1000,
    showMs: 900,
    buildStimulus: (stage) => {
      stage.insertAdjacentHTML('beforeend', dialMarkup(actual, 'dial--stim'));
    },
    onDone: () => angleRespond(actual)
  });
}

function angleRespond(actual) {
  runRespond({
    title: 'Which way did it point?',
    sub: 'Drag the dial to reproduce the angle, then lock it in.',
    build: (mount) => buildDial(mount, 0),
    onSubmit: (guess) => angleResult(actual, guess)
  });
}

function buildDial(mount, init) {
  mount.classList.add('dial-wrap');
  mount.innerHTML = `
    ${dialMarkup(init, 'dial--interactive')}
    <div class="readout">${Math.round(init) % 360}°</div>`;
  const dial = mount.querySelector('.dial');
  const needle = mount.querySelector('.dial-needle');
  const readout = mount.querySelector('.readout');

  // Expose the dial as a focusable ARIA slider so it works with the keyboard.
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', 'Angle in degrees');
  dial.setAttribute('aria-valuemin', '0');
  dial.setAttribute('aria-valuemax', '359');

  let angle = init;
  const setAngle = a => {
    angle = ((a % 360) + 360) % 360;
    const deg = Math.round(angle) % 360;   // 359.6 rounds to 360 → wrap back to 0
    needle.style.transform = `rotate(${angle}deg)`;
    readout.textContent = `${deg}°`;
    dial.setAttribute('aria-valuenow', deg);
    dial.setAttribute('aria-valuetext', `${deg} degrees`);
  };

  // 0° points up; degrees increase clockwise (matches CSS rotate direction).
  const pointTo = (clientX, clientY) => {
    const r = dial.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    setAngle(Math.atan2(dx, -dy) * 180 / Math.PI);
  };

  let dragging = false;
  dial.addEventListener('pointerdown', e => {
    dragging = true;
    dial.setPointerCapture(e.pointerId);
    pointTo(e.clientX, e.clientY);
  });
  dial.addEventListener('pointermove', e => { if (dragging) pointTo(e.clientX, e.clientY); });
  dial.addEventListener('pointerup', () => { dragging = false; });
  dial.addEventListener('pointercancel', () => { dragging = false; });

  // Keyboard: arrows nudge by 1° (Shift = 10°); Home/End jump to 0°/359°.
  dial.addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1;
    let handled = true;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp':   setAngle(angle + step); break;
      case 'ArrowLeft':  case 'ArrowDown': setAngle(angle - step); break;
      case 'Home': setAngle(0); break;
      case 'End':  setAngle(359); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  setAngle(init);
  return () => angle;
}

function angleResult(actual, guess) {
  const { score, diff } = scoreAngle(actual, guess);
  const compareHTML = valueRow(
    { label: 'Shown', value: `${Math.round(actual)}°`, media: dialMarkup(actual, 'dial--static dial--target') },
    { label: 'Your guess', value: `${Math.round(guess)}°`, media: dialMarkup(guess, 'dial--static dial--guess') }
  );
  showResult({
    compareClass: 'result-compare--values',
    compareHTML,
    score,
    label: qualitative(score),
    detail: `off by ${Math.round(diff)}°`
  });
}


/* ---------- 6b. Pitch mode (audio) ---------- */

const PITCH_MIN = 220;    // A3
const PITCH_MAX = 880;    // A5 — a two-octave range
const PITCH_SPAN_CENTS = Math.round(1200 * Math.log2(PITCH_MAX / PITCH_MIN)); // 2400

/* Centered "listening" indicator reused by the audio modes' observe phase. */
function audioStageMarkup(label) {
  return `
    <div class="observe-audio">
      <span class="audio-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      <p>${label}</p>
    </div>`;
}

function showAudioUnavailable() {
  const stage = $('observeStage');
  $('observeCountdown').hidden = true;
  stage.className = 'observe-stage';
  stage.style.backgroundColor = '';
  stage.innerHTML = '<div class="observe-audio"><p>Audio isn’t available in this browser.</p></div>';
  showScreen('observe');
}

function startPitch() {
  state.gameKey = 'pitch';
  state.again = startPitch;
  if (!audioAvailable()) { showAudioUnavailable(); return; }
  getAudio();   // create/resume the AudioContext inside this click gesture

  // Log-uniform target so every musical interval is equally likely.
  const target = PITCH_MIN * Math.pow(PITCH_MAX / PITCH_MIN, Math.random());

  const stage = $('observeStage');
  $('observeCountdown').hidden = true;
  stage.className = 'observe-stage observe-stage--audio';
  stage.style.backgroundColor = '';
  stage.innerHTML = audioStageMarkup('Listen…');
  showScreen('observe');

  const toneMs = 2200;
  setTimer(() => {
    const wave = stage.querySelector('.observe-audio');
    if (wave) wave.classList.add('is-playing');
    playTone(target, toneMs, { type: 'sine', gain: 0.18 });
    setTimer(() => pitchRespond(target), toneMs + 400);
  }, 550);
}

function pitchRespond(target) {
  runRespond({
    title: 'Match the pitch',
    sub: 'Drag to tune — you’ll hear your guess. Lock in when it matches what you heard.',
    build: (mount) => buildPitchSlider(mount),
    onSubmit: (guessFreq) => pitchResult(target, guessFreq)
  });
}

function buildPitchSlider(mount) {
  mount.classList.add('estimate', 'estimate--audio');
  const init = Math.round(PITCH_SPAN_CENTS / 2);
  mount.innerHTML = `
    <div class="readout is-empty">—</div>
    <input class="range" type="range" min="0" max="${PITCH_SPAN_CENTS}" step="2" value="${init}" aria-label="Pitch" />
    <button class="btn audio-btn" id="pitchHear" type="button">▶ Hear guess</button>`;
  const input = mount.querySelector('input');
  const readout = mount.querySelector('.readout');
  const hearBtn = mount.querySelector('#pitchHear');
  const submit = $('respondSubmit');
  submit.disabled = true;   // no guess until the slider moves

  const centsToFreq = c => PITCH_MIN * Math.pow(2, c / 1200);
  const tone = createTunableTone(centsToFreq(init));
  state.sound = tone;

  let offTimer = null;
  const fadeOffSoon = (ms) => { if (!tone) return; clearTimeout(offTimer); offTimer = setTimeout(() => tone.off(), ms); };

  const refresh = () => {
    const f = centsToFreq(Number(input.value));
    readout.classList.remove('is-empty');
    readout.textContent = `${Math.round(f)} Hz`;
    submit.disabled = false;
    if (tone) tone.setFreq(f);
  };

  input.addEventListener('input', refresh);
  input.addEventListener('pointerdown', () => tone && tone.on());
  input.addEventListener('pointerup', () => fadeOffSoon(350));
  input.addEventListener('keydown', () => tone && tone.on());
  input.addEventListener('keyup', () => fadeOffSoon(350));
  hearBtn.addEventListener('click', () => {
    refresh();
    if (tone) { tone.on(); fadeOffSoon(900); }
  });

  return () => centsToFreq(Number(input.value));
}

function pitchResult(target, guess) {
  const { score, off } = scorePitch(target, guess);   // off = cents
  const compareHTML = valueRow(
    { label: 'Target', value: `${Math.round(target)} Hz`,
      media: `<button class="btn audio-btn" data-tone="${target.toFixed(2)}" type="button">▶ Play</button>` },
    { label: 'Your guess', value: `${Math.round(guess)} Hz`,
      media: `<button class="btn audio-btn" data-tone="${guess.toFixed(2)}" type="button">▶ Play</button>` }
  );
  showResult({
    compareClass: 'result-compare--values',
    compareHTML,
    score,
    label: qualitative(score),
    detail: off < 1 ? 'spot on' : `off by ${Math.round(off)} cents`
  });
  // A/B replay buttons. Track the tone in state.sound so it's silenced when the
  // user navigates away (clearTimers) or replays the other one — no 0.9s bleed.
  $('resultCompare').querySelectorAll('[data-tone]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.sound) state.sound.stop();
      state.sound = playTone(Number(btn.dataset.tone), 900, { type: 'sine', gain: 0.18 });
    });
  });
}


/* ---------- 6c. Tempo mode (audio) ---------- */

const TEMPO_MIN = 60;
const TEMPO_MAX = 160;
const TEMPO_CLICK = 1000;   // click pitch in Hz

/* Restart a one-shot CSS pulse on the wave for each observed beat. */
function flashBeat(el) {
  if (!el) return;
  el.classList.remove('beat');
  void el.offsetWidth;        // force reflow so the animation replays
  el.classList.add('beat');
}

/* Play `count` metronome clicks at `bpm`, tracked so navigation cancels them. */
function playBeats(bpm, count) {
  const beatMs = 60000 / bpm;
  for (let i = 0; i < count; i++) {
    setTimer(() => playTone(TEMPO_CLICK, 55, { type: 'square', gain: 0.25 }), i * beatMs);
  }
}

function startTempo() {
  state.gameKey = 'tempo';
  state.again = startTempo;
  if (!audioAvailable()) { showAudioUnavailable(); return; }
  getAudio();   // create/resume the AudioContext inside this click gesture

  const bpm = TEMPO_MIN + Math.floor(Math.random() * (TEMPO_MAX - TEMPO_MIN + 1));

  const stage = $('observeStage');
  $('observeCountdown').hidden = true;
  stage.className = 'observe-stage observe-stage--audio';
  stage.style.backgroundColor = '';
  stage.innerHTML = audioStageMarkup('Feel the beat…');
  showScreen('observe');

  const wave = stage.querySelector('.audio-wave');
  const beatMs = 60000 / bpm;
  const beats = 6;
  const lead = 550;
  for (let i = 0; i < beats; i++) {
    setTimer(() => { playTone(TEMPO_CLICK, 55, { type: 'square', gain: 0.25 }); flashBeat(wave); }, lead + i * beatMs);
  }
  setTimer(() => tempoRespond(bpm), lead + (beats - 1) * beatMs + 750);
}

function tempoRespond(actualBpm) {
  runRespond({
    title: 'Match the tempo',
    sub: 'Start the metronome and drag until it feels like the beat you heard.',
    build: (mount) => buildTempoSlider(mount),
    onSubmit: (bpm) => tempoResult(actualBpm, bpm)
  });
}

function buildTempoSlider(mount) {
  mount.classList.add('estimate', 'estimate--audio');
  const init = Math.round((TEMPO_MIN + TEMPO_MAX) / 2);
  mount.innerHTML = `
    <div class="readout is-empty">—</div>
    <input class="range" type="range" min="${TEMPO_MIN}" max="${TEMPO_MAX}" step="1" value="${init}" aria-label="Tempo in BPM" />
    <button class="btn audio-btn" id="tempoToggle" type="button">▶ Start metronome</button>`;
  const input = mount.querySelector('input');
  const readout = mount.querySelector('.readout');
  const toggle = mount.querySelector('#tempoToggle');
  const submit = $('respondSubmit');
  submit.disabled = true;   // no guess until the slider moves

  const metro = createMetronome(init);
  state.sound = metro;
  let playing = false;

  const refresh = () => {
    const b = Number(input.value);
    readout.classList.remove('is-empty');
    readout.textContent = `${b} BPM`;
    submit.disabled = false;
    if (metro) metro.setBpm(b);
  };

  input.addEventListener('input', refresh);
  toggle.addEventListener('click', () => {
    if (!metro) return;
    playing = !playing;
    if (playing) { metro.start(); toggle.textContent = '⏸ Stop metronome'; }
    else         { metro.stop();  toggle.textContent = '▶ Start metronome'; }
  });

  return () => Number(input.value);
}

function tempoResult(actual, guess) {
  const { score, delta } = scoreTempo(actual, guess);
  const compareHTML = valueRow(
    { label: 'Actual', value: `${actual} BPM`,
      media: `<button class="btn audio-btn" data-bpm="${actual}" type="button">▶ Hear</button>` },
    { label: 'Your guess', value: `${guess} BPM`,
      media: `<button class="btn audio-btn" data-bpm="${guess}" type="button">▶ Hear</button>` }
  );
  showResult({
    compareClass: 'result-compare--values',
    compareHTML,
    score,
    label: qualitative(score),
    detail: delta === 0 ? 'exact' : `off by ${delta} BPM`
  });
  $('resultCompare').querySelectorAll('[data-bpm]').forEach(btn => {
    btn.addEventListener('click', () => playBeats(Number(btn.dataset.bpm), 4));
  });
}


/* ---------- 7. Game registry + home ---------- */

const GAMES = {
  colour: {
    name: 'Colour',
    desc: 'Memorize a color, then mix its closest match.',
    preview: 'linear-gradient(90deg, #ff3b3b, #ffd23b, #3bff7a, #3bd1ff, #6a3bff, #ff3bd1)',
    start: startColour
  },
  time: {
    name: 'Time',
    desc: 'A shape lingers for a while — guess how long.',
    preview: 'conic-gradient(from -90deg, #4d8dff, #b25cff, #ff5b3a, #ffb84d, #4dd0a8, #4d8dff)',
    start: startTime
  },
  count: {
    name: 'Count',
    desc: 'A cluster of dots flashes — estimate how many.',
    preview: 'radial-gradient(circle, #ffffff 1.6px, transparent 2.2px) 0 0 / 17px 17px, linear-gradient(135deg, #6a3bff, #3bd1ff)',
    start: startCount
  },
  angle: {
    name: 'Angle',
    desc: 'A needle points somewhere — reproduce the angle.',
    preview: 'conic-gradient(#ff5b3a 0 25%, #ffb84d 25% 50%, #4dd0a8 50% 75%, #4d8dff 75% 100%)',
    start: startAngle
  },
  pitch: {
    name: 'Pitch',
    desc: 'A tone plays — retune a slider to match it by ear.',
    preview: 'linear-gradient(90deg, #1a3a6b, #4d8dff, #b25cff, #ff5b8a)',
    start: startPitch
  },
  tempo: {
    name: 'Tempo',
    desc: 'A beat plays — match its tempo on a metronome.',
    preview: 'repeating-linear-gradient(90deg, #ffb84d 0 10px, transparent 10px 46px), linear-gradient(135deg, #4d2b8f, #2b1a5e)',
    start: startTempo
  }
};

/* Roll up stored stats for a home card into { best, avg, n }. Colour is split
   into `colour:<palette>` buckets, so combine them (plus any legacy flat
   `colour` entry) — best = max across palettes, avg = pooled mean. */
function aggregateStat(stats, key) {
  let best = 0, sum = 0, n = 0;
  if (key === 'colour') {
    Object.entries(stats).forEach(([k, e]) => {
      if (k === 'colour' || k.startsWith('colour:')) { best = Math.max(best, e.best); sum += e.sum; n += e.n; }
    });
  } else {
    const e = stats[key];
    if (e) { best = e.best; sum = e.sum; n = e.n; }
  }
  return n > 0 ? { best, avg: Math.round(sum / n), n } : null;
}

function renderModeCards() {
  const grid = $('modeGrid');
  const stats = loadStats();
  grid.innerHTML = '';
  Object.entries(GAMES).forEach(([key, game]) => {
    const stat = aggregateStat(stats, key);
    const best = stat ? `<span class="mode-best">★ Best ${stat.best}</span>` : '';
    const statsLine = stat
      ? `<p class="mode-stats">Avg ${stat.avg} · ${stat.n} play${stat.n === 1 ? '' : 's'}</p>`
      : '';
    const card = document.createElement('button');
    card.className = 'mode-card';
    card.type = 'button';
    card.innerHTML = `
      <div class="mode-preview" style="background: ${game.preview}"></div>
      <div class="mode-head">
        <span class="mode-name">${game.name}</span>
        ${best}
      </div>
      <p class="mode-desc">${game.desc}</p>
      ${statsLine}`;
    card.addEventListener('click', () => game.start());
    grid.appendChild(card);
  });

  // The "Reset scores" control only makes sense once something is stored.
  $('homeFoot').hidden = Object.keys(stats).length === 0;
}


/* ---------- 8. Multiplayer (peer-to-peer) ----------
   Host-authoritative star over WebRTC (see net.js). The host owns the truth:
   it picks the mode, generates one shared stimulus, aggregates scores, and
   broadcasts state. Joiners only render what the host tells them and send back
   their guesses. Everyone — host included — plays the same synchronized round,
   then a running leaderboard totals scores until the host ends the match.

   Wire protocol (JSON over the DataConnection):
     client → host : join{name,clientId}, submit{roundNo,score,guessValue}
     host → client : welcome{playerId,code,hostName}, lobby{code,players,phase},
                      round{roundNo,gameKey,spaceKey,params,limitMs},
                      waiting{roundNo,players}, reveal{...results},
                      matchover{results}, ended
   A round auto-reveals after limitMs so an AFK player can't stall; a dropped
   player can rejoin and still play within a grace window. At match end the host
   picks a rematch (keep/reset scores) or closes the room.
   Multiplayer never touches localStorage stats — it never calls showResult. */

const MP_NAME_KEY = 'gamut-mp-name';
const MP_CLIENT_KEY = 'gamut-mp-clientId';

/* A round auto-reveals after this long so one AFK player can't stall everyone
   (the host still has a manual "Reveal now"). A player who drops mid-round can
   rejoin and still play, as long as they're back within the grace window. */
const MP_ROUND_TIMEOUT_MS = 60000;
const MP_REJOIN_GRACE_MS = 20000;

const mp = {
  active: false,
  role: null,            // 'host' | 'client'
  code: null,
  name: '',
  net: null,
  meId: null,            // 'host' for the host; assigned connId for a client
  roundNo: 0,
  gameKey: null,
  spaceKey: null,
  params: null,
  phase: 'idle',         // 'idle' | 'lobby' | 'round' | 'reveal'
  submitted: false,
  inWaiting: false,
  revealShown: false,
  players: new Map(),    // id -> { id,name,clientId,total,connected,roundScore,submitted,guessValue }
  roundParticipants: new Set(),
  board: [],             // client's copy of the lobby/leaderboard players
  waiting: [],           // client's copy of the per-round submit statuses
  lastReveal: null,      // host: last reveal payload (for late joiners)
  lastWaiting: null,     // host: last waiting snapshot
  pickedGame: null,
  pickedSpace: null,
  roundStartedAt: 0,     // host: epoch ms the current round opened (rejoin grace)
  roundEndsAt: 0,        // epoch ms the round auto-reveals (for the countdown)
  roundTimer: null,      // host: setTimeout handle for the auto-reveal
  roundClock: null       // any peer: setInterval handle updating the countdown pill
};

/* ----- small helpers ----- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function clampScore(s) {
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/* Create/resume the AudioContext inside a user gesture (Host / Join / Start)
   so a later network-triggered tone (Pitch / Tempo) is allowed to play. */
function primeAudio() { try { getAudio(); } catch { /* audio absent — modes degrade */ } }

function mpLoadName() { try { return localStorage.getItem(MP_NAME_KEY) || ''; } catch { return ''; } }
function mpSaveName(name) { try { localStorage.setItem(MP_NAME_KEY, name); } catch { /* ignore */ } }
function mpSanitizeName(raw) { return String(raw == null ? '' : raw).trim().slice(0, 16); }
function mpReadName() { return mpSanitizeName($('mpName').value); }

/* A stable per-browser id so a dropped peer can reclaim its seat + score. */
function mpClientId() {
  try {
    let id = localStorage.getItem(MP_CLIENT_KEY);
    if (!id) {
      id = 'c-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem(MP_CLIENT_KEY, id);
    }
    return id;
  } catch {
    return 'c-' + Math.random().toString(36).slice(2, 10);
  }
}

function showMpSetup() { showScreen('mp-setup'); }
function showMpLobby() { showScreen('mp-lobby'); }
function mpGoHome() { renderModeCards(); showScreen('home'); }

function mpSetNetStatus(status, detail) {
  const el = $('mpNetStatus');
  if (!el) return;
  const text = {
    connecting: 'Connecting…', online: 'Connected',
    reconnecting: 'Reconnecting…', error: detail || 'Connection problem'
  };
  const cls = {
    connecting: ' is-warn', online: ' is-online',
    reconnecting: ' is-warn', error: ' is-error'
  };
  el.textContent = text[status] || '';
  el.className = 'mp-net-status' + (cls[status] || '');
}

function mpSetupError(msg) {
  const el = $('mpSetupError');
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ''; el.hidden = true; }
}

/* Show/clear the "you've been invited to room N" banner and, when invited,
   de-emphasize Host so Join reads as the obvious next step. */
function mpSetInvite(code) {
  const hint = $('mpInviteHint');
  if (hint) {
    if (code) { hint.textContent = `You're invited to room ${code} — enter your name and Join.`; hint.hidden = false; }
    else { hint.textContent = ''; hint.hidden = true; }
  }
  const host = $('mpHostBtn');
  if (host) host.classList.toggle('is-muted', !!code);
}

/* Brief self-dismissing toast for events that pull a player out of a room
   (e.g. the host closed it) so the jump back home isn't silent. */
let mpToastTimer = null;
function mpToast(msg) {
  let el = $('mpToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpToast';
    el.className = 'mp-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // reflow so the transition replays if a toast is already up
  void el.offsetWidth;
  el.classList.add('is-shown');
  if (mpToastTimer) clearTimeout(mpToastTimer);
  mpToastTimer = setTimeout(() => { el.classList.remove('is-shown'); mpToastTimer = null; }, 3600);
}

/* The invite link deep-links friends straight to the join screen with the
   room code prefilled (see boot()). */
function mpShareLink() {
  const base = location.origin + location.pathname;
  return mp.code ? `${base}?room=${mp.code}` : base;
}

function mpCopy(text, btnId = 'mpCopyCode') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => mpFlashCopy(btnId), () => mpCopyFallback(text, btnId));
  } else {
    mpCopyFallback(text, btnId);
  }
}
/* Non-secure origins (raw http://192.168.x.x LAN) have no async clipboard;
   fall back to a hidden textarea + execCommand, and if even that fails,
   select the visible code so the user can copy it manually. */
function mpCopyFallback(text, btnId = 'mpCopyCode') {
  let copied = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
    document.body.removeChild(ta);
  } catch { copied = false; }
  if (copied) { mpFlashCopy(btnId); return; }
  // Last resort: highlight the on-screen code so the user can copy by hand.
  const disp = $('mpCodeDisplay');
  if (disp && window.getSelection) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(disp);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
function mpFlashCopy(btnId = 'mpCopyCode') {
  const btn = $(btnId);
  if (!btn) return;
  const prev = btn.textContent;
  btn.textContent = 'Copied!';
  setTimeout(() => { btn.textContent = prev; }, 1400);
}

/* ----- round countdown / auto-reveal ----- */

/* Floating countdown pill, created lazily and reused across rounds. */
function mpRoundClockEl() {
  let el = $('mpRoundClock');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpRoundClock';
    el.className = 'mp-round-clock';
    el.setAttribute('aria-live', 'off');
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

/* An off-screen live region so screen-reader users get the one "10 seconds
   left" cue without hearing the pill tick every second. */
let mpAnnounced10 = false;
function mpAnnounceEl() {
  let el = $('mpAnnounce');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mpAnnounce';
    el.className = 'sr-only';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  return el;
}
function mpAnnounce(msg) {
  const el = mpAnnounceEl();
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 30);   // clear→set so it re-announces
}

function mpRoundClockSecs() {
  return Math.max(0, Math.ceil((mp.roundEndsAt - Date.now()) / 1000));
}

function mpRenderRoundClock() {
  const el = mpRoundClockEl();
  const secs = mpRoundClockSecs();
  el.textContent = `⏱ ${secs}s`;
  el.classList.toggle('is-urgent', secs <= 10);
}

/* Interval body: repaint the pill, announce the 10s mark once, and — since a
   backgrounded host's setTimeout can be throttled — enforce the deadline here
   too as a backstop so the auto-reveal still fires. */
function mpRoundTick() {
  mpRenderRoundClock();
  const secs = mpRoundClockSecs();
  if (!mpAnnounced10 && secs <= 10 && secs > 0) {
    mpAnnounced10 = true;
    mpAnnounce(`${secs} seconds left to lock in.`);
  }
  if (mp.role === 'host' && mp.phase === 'round' && Date.now() >= mp.roundEndsAt) {
    hostReveal('timeout');
  }
}

/* Every peer shows the countdown; the host also arms the authoritative
   auto-reveal so one AFK player can't stall the reveal for everyone. */
function mpStartRoundClock(limitMs) {
  mpStopRoundClock();
  const limit = Number(limitMs) > 0 ? Number(limitMs) : MP_ROUND_TIMEOUT_MS;
  mp.roundEndsAt = Date.now() + limit;
  mpAnnounced10 = false;
  mpRoundClockEl().hidden = false;
  mpRenderRoundClock();
  mp.roundClock = setInterval(mpRoundTick, 500);
  if (mp.role === 'host') {
    mp.roundTimer = setTimeout(() => { if (mp.phase === 'round') hostReveal('timeout'); }, limit);
  }
}

function mpStopRoundClock() {
  if (mp.roundClock) { clearInterval(mp.roundClock); mp.roundClock = null; }
  if (mp.roundTimer) { clearTimeout(mp.roundTimer); mp.roundTimer = null; }
  const el = $('mpRoundClock');
  if (el) el.hidden = true;
}

/* A short cue (blip + vibrate) so a player idling on the reveal screen notices
   the next round's observe phase sliding in. Audio may be suspended and vibrate
   is a no-op on desktop/iOS, so when the tab is hidden we also flash the title
   and favicon — the one signal that actually reaches a backgrounded player. */
function mpNewRoundCue() {
  try { if (navigator.vibrate) navigator.vibrate([40, 30, 40]); } catch { /* unsupported */ }
  if (audioAvailable()) {
    const ctx = getAudio();
    if (ctx && ctx.state === 'running') playTone(880, 110, { type: 'triangle', gain: 0.09 });
  }
  mpFlashTitle('▶ Your turn — gamut');
}

let mpTitleTimer = null;
let mpTitleBase = null;
const MP_ALERT_FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#e5484d"/></svg>');

function mpSetAlertFavicon(on) {
  try {
    let link = $('mpFavicon');
    if (!on) { if (link) link.remove(); return; }
    if (!link) {
      link = document.createElement('link');
      link.id = 'mpFavicon';
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = MP_ALERT_FAVICON;
  } catch { /* ignore */ }
}

/* Blink the tab title + favicon until the player returns to the tab. */
function mpFlashTitle(msg) {
  if (!document.hidden || mpTitleTimer) return;
  mpTitleBase = document.title;
  let on = false;
  const stop = () => {
    if (!mpTitleTimer) return;
    clearInterval(mpTitleTimer);
    mpTitleTimer = null;
    if (mpTitleBase != null) document.title = mpTitleBase;
    mpSetAlertFavicon(false);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('focus', stop);
  };
  const onVis = () => { if (!document.hidden) stop(); };
  mpTitleTimer = setInterval(() => {
    on = !on;
    document.title = on ? msg : mpTitleBase;
    mpSetAlertFavicon(on);
  }, 900);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', stop);
}

/* Tear everything down: kill the peer, cancel timers, wipe state. */
function mpTeardown() {
  clearTimers();
  mpStopRoundClock();
  if (mp.net) { try { mp.net.destroy(); } catch { /* already gone */ } }
  mp.net = null;
  mp.active = false;
  mp.role = null;
  mp.code = null;
  mp.name = '';
  mp.meId = null;
  mp.roundNo = 0;
  mp.gameKey = null;
  mp.spaceKey = null;
  mp.params = null;
  mp.phase = 'idle';
  mp.submitted = false;
  mp.inWaiting = false;
  mp.revealShown = false;
  mp.players = new Map();
  mp.roundParticipants = new Set();
  mp.board = [];
  mp.waiting = [];
  mp.lastReveal = null;
  mp.lastWaiting = null;
  mp.pickedGame = null;
  mp.pickedSpace = null;
  mp.roundStartedAt = 0;
  mp.roundEndsAt = 0;
}

function mpLeave() {
  if (mp.role === 'host' && mp.net) { try { mp.net.broadcast({ t: 'ended' }); } catch { /* ignore */ } }
  mpTeardown();
  mpGoHome();
}

/* ----- shared per-round stimulus generator (host authoritative) ----- */

function mpGenerateParams(gameKey, spaceKey) {
  switch (gameKey) {
    case 'colour': {
      const key = spaceKey || 'rgb';
      return { target: SPACES[key].random(), spaceKey: key };
    }
    case 'time':
      return { showMs: Math.round(1600 + Math.random() * 6800), hue: Math.floor(Math.random() * 360) };
    case 'count': {
      const n = 8 + Math.floor(Math.random() * 48);
      return { n, positions: randomDotPositions(n) };
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

/* Coerce a client-supplied guess into the shape each mode's reveal expects.
   Returns null (rendered as "—") if it's malformed, so a bad peer can't
   inject #NaNNaNNaN / NaN into the leaderboard. */
function mpCleanGuess(gameKey, guessValue) {
  if (gameKey === 'colour') {
    if (!guessValue || typeof guessValue !== 'object') return null;
    const chan = (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) ? Math.max(0, Math.min(255, n)) : null;
    };
    const r = chan(guessValue.r), g = chan(guessValue.g), b = chan(guessValue.b);
    if (r === null || g === null || b === null) return null;
    return { r, g, b };
  }
  const n = Number(guessValue);
  return Number.isFinite(n) ? n : null;
}

/* ----- HOST ----- */

function mpBecomeHost() {
  const name = mpReadName();
  if (!name) { mpSetupError('Enter a name first.'); return; }
  if (!Net.available()) { mpSetupError('Multiplayer needs WebRTC, which this browser lacks.'); return; }
  mpSaveName(name);
  primeAudio();
  mpTeardown();

  mp.active = true;
  mp.role = 'host';
  mp.name = name;
  mp.meId = 'host';
  mp.code = Net.generateRoomCode();
  mp.phase = 'lobby';
  mp.players.set('host', {
    id: 'host', name, clientId: 'host', total: 0,
    connected: true, roundScore: null, submitted: false, guessValue: null
  });

  mp.net = Net.createHost(mp.code, {
    onNetStatus: (s) => mpSetNetStatus(s),
    onConnect: () => { /* wait for the join message before seating them */ },
    onDisconnect: (connId) => hostOnDisconnect(connId),
    onData: (connId, msg) => hostOnData(connId, msg),
    onError: (err) => hostOnError(err)
  });
  mpSetNetStatus('connecting');

  $('mpLobbySub').textContent = 'Share the code so friends can join.';
  showMpLobby();
  renderMpLobby();
}

/* Broker/peer error while hosting. Recoverable errors (network blips) just
   flag "reconnecting" — PeerJS retries. Fatal errors (broker unreachable,
   code taken) drop the user back to setup with a clear message. */
function hostOnError(err) {
  if (Net.isRecoverableError(err)) {
    mpSetNetStatus('reconnecting');
    return;
  }
  mpTeardown();
  mpSetupError(Net.describeError(err));
  showMpSetup();
}

function hostOnData(connId, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    hostOnJoin(connId, msg);
  } else if (msg.t === 'submit') {
    if (mp.phase !== 'round' || msg.roundNo !== mp.roundNo) return;
    if (!mp.roundParticipants.has(connId)) return;   // mid-round joiner isn't in this round
    const player = mp.players.get(connId);
    if (!player || player.submitted) return;
    hostRecordSubmit(connId, msg.score, mpCleanGuess(mp.gameKey, msg.guessValue));
    hostBroadcastWaiting();
    hostMaybeReveal();
  }
}

function hostOnJoin(connId, msg) {
  const name = mpSanitizeName(msg.name);
  const clientId = typeof msg.clientId === 'string' ? msg.clientId : connId;

  // Reconnect: adopt any prior seat with the same clientId (keep its total).
  let reclaimed = null;
  for (const [id, pl] of mp.players) {
    if (id !== 'host' && pl.clientId === clientId) {
      reclaimed = pl;
      if (id !== connId) mp.players.delete(id);
      break;
    }
  }
  mp.players.set(connId, {
    id: connId,
    name: name || (reclaimed && reclaimed.name) || 'Player',
    clientId,
    total: reclaimed ? reclaimed.total : 0,
    connected: true,
    roundScore: reclaimed ? reclaimed.roundScore : null,
    submitted: reclaimed ? reclaimed.submitted : false,
    guessValue: reclaimed ? reclaimed.guessValue : null
  });

  mp.net.sendTo(connId, {
    t: 'welcome', playerId: connId, code: mp.code, hostName: mp.players.get('host').name
  });
  hostBroadcastLobby();
  renderMpLobby();

  // Catch a late joiner up to whatever's happening right now.
  if ((mp.phase === 'reveal' || mp.phase === 'ended') && mp.lastReveal) {
    mp.net.sendTo(connId, mp.lastReveal);
    return;
  }
  if (mp.phase === 'round') hostRejoinRound(connId, reclaimed);
}

/* A player who dropped mid-round can rejoin and still play, as long as they
   were a participant, haven't already submitted, and are back within the
   grace window. Otherwise they wait for the next round. */
function hostRejoinRound(connId, reclaimed) {
  if (!reclaimed || !mp.roundParticipants.has(reclaimed.id)) return;
  mp.roundParticipants.delete(reclaimed.id);        // old connId is stale now
  const pl = mp.players.get(connId);
  if (!pl) return;

  if (pl.submitted) {                                // already scored — just re-seat them
    mp.roundParticipants.add(connId);
    hostBroadcastWaiting();   // fresh snapshot carries the new connId to everyone
    hostMaybeReveal();
    return;
  }

  const withinGrace = Date.now() - (mp.roundStartedAt || 0) <= MP_REJOIN_GRACE_MS;
  if (withinGrace) {
    mp.roundParticipants.add(connId);
    mp.net.sendTo(connId, {
      t: 'round', roundNo: mp.roundNo, gameKey: mp.gameKey,
      spaceKey: mp.spaceKey, params: mp.params, limitMs: MP_ROUND_TIMEOUT_MS
    });
    hostBroadcastWaiting();
  } else {
    hostMaybeReveal();                               // grace expired — don't block the reveal
  }
}

function hostOnDisconnect(connId) {
  const pl = mp.players.get(connId);
  if (!pl) return;
  pl.connected = false;                 // keep the seat so a reconnect can reclaim it
  hostBroadcastLobby();
  renderMpLobby();
  // Losing a player we were still waiting on can unblock the reveal.
  if (mp.phase === 'round') { hostBroadcastWaiting(); hostMaybeReveal(); }
}

function hostRecordSubmit(id, score, guessValue) {
  const pl = mp.players.get(id);
  if (!pl || pl.submitted) return;
  pl.submitted = true;
  pl.roundScore = clampScore(score);
  pl.guessValue = guessValue;
}

function hostMaybeReveal() {
  if (mp.phase !== 'round') return;
  for (const id of mp.roundParticipants) {
    const pl = mp.players.get(id);
    if (pl && pl.connected && !pl.submitted) return;   // still waiting on someone
  }
  hostReveal();
}

function hostReveal(reason) {
  if (mp.phase !== 'round') return;
  mp.phase = 'reveal';
  const timedOut = reason === 'timeout';
  const results = [];
  for (const id of mp.roundParticipants) {
    const pl = mp.players.get(id);
    if (!pl) continue;
    const roundScore = pl.submitted ? clampScore(pl.roundScore) : 0;
    pl.total += roundScore;
    results.push({
      id: pl.id, name: pl.name, roundScore, total: pl.total,
      submitted: pl.submitted, connected: pl.connected,
      guessValue: pl.submitted ? pl.guessValue : null
    });
  }
  results.sort((a, b) => b.total - a.total || b.roundScore - a.roundScore);

  const payload = {
    t: 'reveal', roundNo: mp.roundNo, gameKey: mp.gameKey,
    spaceKey: mp.spaceKey, params: mp.params, results, timedOut
  };
  mp.lastReveal = payload;
  mp.net.broadcast(payload);
  showMpReveal(payload);
}

function hostStartRound(gameKey, spaceKey) {
  if (!gameKey) return;
  mp.roundNo += 1;
  mp.gameKey = gameKey;
  mp.spaceKey = gameKey === 'colour' ? (spaceKey || 'rgb') : null;
  mp.params = mpGenerateParams(gameKey, mp.spaceKey);
  mp.phase = 'round';
  mp.lastReveal = null;
  mp.roundStartedAt = Date.now();

  mp.roundParticipants = new Set();
  for (const [id, pl] of mp.players) {
    if (pl.connected) {
      mp.roundParticipants.add(id);
      pl.submitted = false;
      pl.roundScore = null;
      pl.guessValue = null;
    }
  }

  const round = {
    t: 'round', roundNo: mp.roundNo, gameKey, spaceKey: mp.spaceKey,
    params: mp.params, limitMs: MP_ROUND_TIMEOUT_MS
  };
  mp.net.broadcast(round);
  mpPlayRound(round);
}

function hostNextRound() {
  mp.phase = 'lobby';
  mp.lastReveal = null;
  showMpLobby();
  hostBroadcastLobby();
  renderMpLobby();
}

/* End the match → show final standings with a rematch choice, rather than
   closing outright. The room stays open until the host picks. */
function hostEndMatch() {
  mp.phase = 'ended';
  mpStopRoundClock();
  const results = hostStandings();
  const payload = { t: 'matchover', results };
  mp.lastReveal = payload;                       // late joiners see the final board
  if (mp.net) { try { mp.net.broadcast(payload); } catch { /* ignore */ } }
  showMpMatchOver(payload);
}

function hostStandings() {
  const results = [];
  for (const pl of mp.players.values()) {
    results.push({ id: pl.id, name: pl.name, total: pl.total, connected: pl.connected });
  }
  results.sort((a, b) => b.total - a.total);
  return results;
}

/* Rematch with the same room + players. reset=true zeroes the running totals
   and the round counter; reset=false keeps them (a fresh set of rounds). */
function hostRematch(reset) {
  for (const pl of mp.players.values()) {
    if (reset) pl.total = 0;
    pl.submitted = false;
    pl.roundScore = null;
    pl.guessValue = null;
  }
  if (reset) mp.roundNo = 0;
  mp.phase = 'lobby';
  mp.lastReveal = null;
  showMpLobby();
  hostBroadcastLobby();
  renderMpLobby();
}

function hostCloseRoom() {
  if (mp.net) { try { mp.net.broadcast({ t: 'ended' }); } catch { /* ignore */ } }
  mpTeardown();
  mpGoHome();
}

function hostBroadcastLobby() {
  const players = [];
  for (const pl of mp.players.values()) {
    players.push({ id: pl.id, name: pl.name, total: pl.total, connected: pl.connected });
  }
  mp.net.broadcast({ t: 'lobby', code: mp.code, players, phase: mp.phase });
}

function hostBroadcastWaiting() {
  const players = [];
  for (const id of mp.roundParticipants) {
    const pl = mp.players.get(id);
    if (pl) players.push({ id: pl.id, name: pl.name, submitted: pl.submitted, connected: pl.connected });
  }
  const msg = { t: 'waiting', roundNo: mp.roundNo, players };
  mp.lastWaiting = msg;
  mp.net.broadcast(msg);
  if (mp.role === 'host' && mp.inWaiting && mp.phase === 'round') mpRenderWaitingBoard(players);
}

/* ----- CLIENT ----- */

function mpJoin() {
  const name = mpReadName();
  const code = Net.normalizeCode($('mpCode').value);
  if (!name) { mpSetupError('Enter a name first.'); return; }
  if (code.length !== 4) { mpSetupError('Enter the 4-digit room code.'); return; }
  if (!Net.available()) { mpSetupError('Multiplayer needs WebRTC, which this browser lacks.'); return; }
  mpSaveName(name);
  primeAudio();
  mpTeardown();

  mp.active = true;
  mp.role = 'client';
  mp.name = name;
  mp.code = code;
  mp.phase = 'lobby';

  mp.net = Net.joinHost(code, {
    onNetStatus: (s) => mpSetNetStatus(s),
    onOpen: () => mp.net.send({ t: 'join', name: mp.name, clientId: mpClientId() }),
    onData: (msg) => clientOnData(msg),
    onClose: () => mpSetNetStatus('reconnecting'),
    onError: (err) => mpClientError(err)
  });

  mpSetNetStatus('connecting');
  $('mpCodeDisplay').textContent = code;
  $('mpLobbySub').textContent = 'Connecting…';
  $('mpPlayers').innerHTML = '<p class="muted">Connecting to the host…</p>';
  $('mpHostControls').hidden = true;
  $('mpLobbyWait').hidden = false;
  showMpLobby();
}

function clientOnData(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      mp.meId = msg.playerId;
      break;
    case 'lobby':
      mp.board = msg.players || [];
      mp.phase = 'lobby';
      $('mpLobbySub').textContent = 'Waiting for the host to start…';
      showMpLobby();
      renderMpLobby();
      break;
    case 'waiting':
      mp.waiting = msg.players || [];
      if (mp.inWaiting) {
        mpRenderWaitingBoard(mp.waiting);
      } else if (mp.phase !== 'reveal') {
        // Reconnected after we'd already locked in: the host still counts us
        // as submitted, but we came back on the lobby screen. Re-enter waiting.
        const meRow = mp.waiting.find(p => p.id === mp.meId);
        if (meRow && meRow.submitted) {
          mp.roundNo = msg.roundNo;
          mp.phase = 'round';
          mp.submitted = true;
          mpShowWaiting();
        }
      }
      break;
    case 'round':
      mpNewRoundCue();
      mpPlayRound(msg);
      break;
    case 'reveal':
      showMpReveal(msg);
      break;
    case 'matchover':
      showMpMatchOver(msg);
      break;
    case 'ended':
      mpTeardown();
      mpGoHome();
      mpToast('The host closed the room.');
      break;
    case 'rejected':
    case 'error':
      mpTeardown();
      mpSetupError(msg.message || 'The host closed the room.');
      showMpSetup();
      break;
  }
}

function mpClientError(err) {
  if (Net.isRecoverableError(err)) { mpSetNetStatus('reconnecting'); return; }
  mpTeardown();
  mpSetupError(Net.describeError(err));
  showMpSetup();
}

/* ----- shared round playback (host + clients run the same code) ----- */

function mpPlayRound(round) {
  mp.roundNo = round.roundNo;
  mp.gameKey = round.gameKey;
  mp.spaceKey = round.spaceKey || null;
  mp.params = round.params || {};
  mp.phase = 'round';
  mp.submitted = false;
  mp.inWaiting = false;
  mp.revealShown = false;
  state.gameKey = null;          // MP never records to localStorage
  clearTimers();

  const play = {
    colour: mpPlayColour, time: mpPlayTime, count: mpPlayCount,
    angle: mpPlayAngle, pitch: mpPlayPitch, tempo: mpPlayTempo
  }[round.gameKey];
  if (play) play(mp.params);
  // The Time round is a duration-estimation game — a visible ticking countdown
  // would hand players the very thing they're judging, so it runs without the
  // round clock. (The host can still use "Reveal now" to move an AFK table on.)
  if (round.gameKey !== 'time') mpStartRoundClock(round.limitMs);
}

/* Wrap runRespond so submitting scores locally and reports to the host. */
function mpRespond({ title, sub, build, scoreGuess }) {
  runRespond({
    title, sub, build,
    onSubmit: (guess) => {
      const { score, guessValue } = scoreGuess(guess);
      mpSubmit(score, guessValue);
    }
  });
}

function mpPlayColour(p) {
  const space = SPACES[p.spaceKey] || SPACES.rgb;
  const target = p.target;
  const stage = $('observeStage');
  stage.className = 'observe-stage observe-stage--fill';
  stage.innerHTML = '';
  stage.style.backgroundColor = rgbToCss(target);
  $('observeCountdown').hidden = false;
  showScreen('observe');
  runCountdownRing(5, () => {
    colour.spaceKey = p.spaceKey;
    colour.target = target;
    colour.values = {};
    space.channels.forEach(ch => { colour.values[ch.key] = ch.init; });
    mpRespond({
      title: 'Mix the match',
      sub: `Dial in the color you saw using the ${space.name} controls.`,
      build: (mount) => { buildColourPicker(mount, space); return () => space.toRgb(colour.values); },
      scoreGuess: (pick) => ({ score: scoreColour(target, pick).score, guessValue: pick })
    });
  });
}

function mpPlayTime(p) {
  const actualSec = p.showMs / 1000;
  runObserve({
    readyMs: 1100,
    showMs: p.showMs,
    buildStimulus: (stage) => {
      const disc = document.createElement('div');
      disc.className = 'stim-disc';
      disc.style.background = `radial-gradient(circle at 35% 30%, hsl(${p.hue},85%,72%), hsl(${p.hue},70%,45%))`;
      stage.appendChild(disc);
    },
    // Score against the planned duration, not measured elapsed, so every peer
    // is judged against the same truth.
    onDone: () => mpRespond({
      title: 'How long was it shown?',
      sub: 'Drag to your best estimate, then lock it in.',
      build: (mount) => buildValueSlider(mount, {
        min: 0.5, max: 10, step: 0.1, init: 4, format: v => `${v.toFixed(1)}s`, hideUntilInput: true
      }),
      scoreGuess: (guess) => ({ score: scoreTime(actualSec, guess).score, guessValue: guess })
    })
  });
}

function mpPlayCount(p) {
  const dots = buildDots(p.positions || []);
  runObserve({
    readyMs: 1000,
    showMs: 700,
    buildStimulus: (stage) => stage.appendChild(dots),
    onDone: () => mpRespond({
      title: 'How many dots?',
      sub: 'Estimate the count you saw, then lock it in.',
      build: (mount) => buildValueSlider(mount, {
        min: 1, max: 70, step: 1, init: 20, format: v => String(v), hideUntilInput: true
      }),
      scoreGuess: (guess) => ({ score: scoreCount(p.n, guess).score, guessValue: guess })
    })
  });
}

function mpPlayAngle(p) {
  runObserve({
    readyMs: 1000,
    showMs: 900,
    buildStimulus: (stage) => stage.insertAdjacentHTML('beforeend', dialMarkup(p.angle, 'dial--stim')),
    onDone: () => mpRespond({
      title: 'Which way did it point?',
      sub: 'Drag the dial to reproduce the angle, then lock it in.',
      build: (mount) => buildDial(mount, 0),
      scoreGuess: (guess) => ({ score: scoreAngle(p.angle, guess).score, guessValue: guess })
    })
  });
}

/* Audio observe phase for multiplayer. A network-triggered round can arrive
   while the AudioContext is suspended (browsers require a fresh gesture after
   idle), and resume() outside a gesture won't help — so if it's suspended we
   show a "tap to enable sound" button and only schedule the tones once the
   user taps. Otherwise the round would play in silence. */
function mpAudioObserve({ label, sequence }) {
  const stage = $('observeStage');
  $('observeCountdown').hidden = true;
  stage.className = 'observe-stage observe-stage--audio';
  stage.style.backgroundColor = '';
  showScreen('observe');

  const run = () => {
    stage.innerHTML = audioStageMarkup(label);
    sequence(stage);
  };

  if (audioAvailable()) {
    const ctx = getAudio();
    if (ctx && ctx.state === 'suspended') {
      stage.innerHTML =
        '<div class="observe-audio">' +
        '<button class="btn btn--primary" id="mpAudioUnlock">▶ Tap to enable sound</button>' +
        '<p class="muted">The round is ready — tap to hear it.</p>' +
        '</div>';
      const btn = $('mpAudioUnlock');
      if (btn) btn.addEventListener('click', () => {
        try {
          const r = ctx.resume();
          if (r && r.then) { r.then(run, run); return; }
        } catch { /* ignore */ }
        run();
      }, { once: true });
      return;
    }
  }
  run();
}

function mpPlayPitch(p) {
  const target = p.freq;
  const toneMs = 2200;
  mpAudioObserve({
    label: 'Listen…',
    sequence: (stage) => {
      setTimer(() => {
        const wave = stage.querySelector('.observe-audio');
        if (wave) wave.classList.add('is-playing');
        playTone(target, toneMs, { type: 'sine', gain: 0.18 });
        setTimer(() => mpRespond({
          title: 'Match the pitch',
          sub: 'Drag to tune — you’ll hear your guess. Lock in when it matches what you heard.',
          build: (mount) => buildPitchSlider(mount),
          scoreGuess: (guess) => ({ score: scorePitch(target, guess).score, guessValue: guess })
        }), toneMs + 400);
      }, 550);
    }
  });
}

function mpPlayTempo(p) {
  const bpm = p.bpm;
  const beatMs = 60000 / bpm;
  const beats = 6;
  const lead = 550;
  mpAudioObserve({
    label: 'Feel the beat…',
    sequence: (stage) => {
      const wave = stage.querySelector('.audio-wave');
      for (let i = 0; i < beats; i++) {
        setTimer(() => { playTone(TEMPO_CLICK, 55, { type: 'square', gain: 0.25 }); flashBeat(wave); }, lead + i * beatMs);
      }
      setTimer(() => mpRespond({
        title: 'Match the tempo',
        sub: 'Start the metronome and drag until it feels like the beat you heard.',
        build: (mount) => buildTempoSlider(mount),
        scoreGuess: (guess) => ({ score: scoreTempo(bpm, guess).score, guessValue: guess })
      }), lead + (beats - 1) * beatMs + 750);
    }
  });
}

/* ----- submit / waiting / reveal ----- */

function mpSubmit(score, guessValue) {
  if (mp.submitted) return;
  mp.submitted = true;
  if (state.sound) { state.sound.stop(); state.sound = null; }
  if (mp.role === 'host') {
    hostRecordSubmit('host', score, guessValue);
    hostBroadcastWaiting();
    hostMaybeReveal();
    if (mp.phase === 'round') mpShowWaiting();   // reveal may already have fired
  } else {
    mp.net.send({ t: 'submit', roundNo: mp.roundNo, score: clampScore(score), guessValue });
    mpShowWaiting();
  }
}

function mpShowWaiting() {
  mp.inWaiting = true;
  $('mpRevealTitle').textContent = 'Locked in';
  $('mpRevealSub').textContent = 'Waiting for the others to submit…';
  $('mpRevealCompare').innerHTML = '';
  const players = mp.role === 'host'
    ? (mp.lastWaiting ? mp.lastWaiting.players : [])
    : (mp.waiting || []);
  mpRenderWaitingBoard(players);

  const wrap = $('mpRevealActions');
  wrap.innerHTML = '';
  if (mp.role === 'host') {
    const reveal = document.createElement('button');
    reveal.className = 'btn';
    reveal.textContent = 'Reveal now';
    reveal.addEventListener('click', () => { if (mp.phase === 'round') hostReveal(); });
    wrap.appendChild(reveal);
  }
  showScreen('mp-reveal');
}

function mpRenderWaitingBoard(players) {
  const board = $('mpBoard');
  if (!players || !players.length) { board.innerHTML = ''; return; }
  board.innerHTML = players.map(p => {
    const isMe = p.id === mp.meId;
    const status = !p.connected ? '<span class="mp-wait-x">offline</span>'
      : p.submitted ? '<span class="mp-wait-ok">✓ locked in</span>'
      : '<span class="mp-wait-dot">waiting…</span>';
    return `
      <div class="mp-row mp-row--wait${isMe ? ' is-me' : ''}${p.connected ? '' : ' is-offline'}">
        <span class="mp-row-name">${escapeHtml(p.name)}${isMe ? ' <span class="mp-you">you</span>' : ''}</span>
        <span class="mp-row-status">${status}</span>
      </div>`;
  }).join('');
}

function showMpReveal(payload) {
  clearTimers();
  mpStopRoundClock();
  mp.phase = 'reveal';
  mp.revealShown = true;
  mp.inWaiting = false;
  mp.gameKey = payload.gameKey;
  mp.spaceKey = payload.spaceKey || null;
  mp.params = payload.params || {};

  const game = GAMES[payload.gameKey];
  $('mpRevealTitle').textContent = `Round ${payload.roundNo}${game ? ' · ' + game.name : ''}`;
  const results = payload.results || [];
  const me = results.find(r => r.id === mp.meId);
  const base = me
    ? (me.submitted ? `You scored ${me.roundScore} this round.` : 'You sat this one out.')
    : 'Round results';
  $('mpRevealSub').textContent = payload.timedOut ? `⏱ Time's up — ${base}` : base;

  $('mpRevealCompare').innerHTML = mpCompareHTML(payload);
  renderMpBoard(results);
  renderMpRevealActions();
  mpWireReplayButtons();
  showScreen('mp-reveal');
}

/* Reveal comparison: the round's actual value alongside *your* guess, mirroring
   the single-player result screen. Your guess comes from your own row in the
   results; if you didn't submit, only the actual is shown. */
function mpCompareHTML(payload) {
  const p = payload.params || {};
  const me = (payload.results || []).find(r => r.id === mp.meId);
  const g = (me && me.submitted) ? me.guessValue : null;
  const has = g != null;

  switch (payload.gameKey) {
    case 'colour': {
      const swatch = (label, rgb) => `
        <figure class="result-swatch">
          <div class="result-color" style="background:${rgbToCss(rgb)}"></div>
          <figcaption><span class="muted">${label}</span><span class="hex">${rgbToHex(rgb)}</span></figcaption>
        </figure>`;
      const target = swatch('Target', p.target);
      return has ? `<div class="mp-swatch-pair">${target}${swatch('Your pick', g)}</div>` : target;
    }
    case 'time': {
      const actual = { label: 'Shown for', value: `${(p.showMs / 1000).toFixed(1)}s` };
      return has ? valueRow(actual, { label: 'You guessed', value: `${Number(g).toFixed(1)}s` })
                 : valueCard(actual);
    }
    case 'count': {
      const dots = `<div class="dots-replay">${buildDots(p.positions || []).outerHTML}</div>`;
      const actual = { label: 'Actual', value: String(p.n) };
      return dots + (has ? valueRow(actual, { label: 'You guessed', value: String(g) })
                         : valueCard(actual));
    }
    case 'angle': {
      const actual = { label: 'Shown', value: `${Math.round(p.angle)}°`,
        media: dialMarkup(p.angle, 'dial--static dial--target') };
      return has ? valueRow(actual, { label: 'Your guess', value: `${Math.round(g)}°`,
                     media: dialMarkup(g, 'dial--static dial--guess') })
                 : valueCard(actual);
    }
    case 'pitch': {
      const actual = { label: 'Target', value: `${Math.round(p.freq)} Hz`,
        media: `<button class="btn audio-btn" data-tone="${p.freq.toFixed(2)}" type="button">▶ Play</button>` };
      return has ? valueRow(actual, { label: 'Your guess', value: `${Math.round(g)} Hz`,
                     media: `<button class="btn audio-btn" data-tone="${Number(g).toFixed(2)}" type="button">▶ Play</button>` })
                 : valueCard(actual);
    }
    case 'tempo': {
      const actual = { label: 'Actual', value: `${p.bpm} BPM`,
        media: `<button class="btn audio-btn" data-bpm="${p.bpm}" type="button">▶ Hear</button>` };
      return has ? valueRow(actual, { label: 'Your guess', value: `${g} BPM`,
                     media: `<button class="btn audio-btn" data-bpm="${g}" type="button">▶ Hear</button>` })
                 : valueCard(actual);
    }
    default:
      return '';
  }
}

/* Compact rendering of a player's own guess, for the leaderboard row. */
function mpAnswerLabel(guessValue) {
  if (guessValue == null) return '';
  let txt = '';
  switch (mp.gameKey) {
    case 'colour': txt = rgbToHex(guessValue); break;
    case 'time':   txt = `${Number(guessValue).toFixed(1)}s`; break;
    case 'count':  txt = String(guessValue); break;
    case 'angle':  txt = `${Math.round(guessValue)}°`; break;
    case 'pitch':  txt = `${Math.round(guessValue)} Hz`; break;
    case 'tempo':  txt = `${guessValue} BPM`; break;
    default: return '';
  }
  return ` <span class="mp-answer">${escapeHtml(txt)}</span>`;
}

/* Per-mode error for a guess, matching the single-player result detail
   (ΔE, "off by 0.3s", cents, …). Recomputed on each peer from the shared
   params, so it needs nothing extra on the wire. */
function mpErrorLabel(guessValue) {
  if (guessValue == null) return '';
  const p = mp.params || {};
  let txt = '';
  switch (mp.gameKey) {
    case 'colour':
      if (!p.target) return '';
      txt = `ΔE ${scoreColour(p.target, guessValue).dE.toFixed(1)}`;
      break;
    case 'time': {
      const d = scoreTime(p.showMs / 1000, Number(guessValue)).delta;
      txt = `off by ${d.toFixed(1)}s`;
      break;
    }
    case 'count': {
      const d = scoreCount(p.n, Number(guessValue)).delta;
      txt = d === 0 ? 'exact' : `off by ${d}`;
      break;
    }
    case 'angle': {
      const d = scoreAngle(p.angle, Number(guessValue)).diff;
      txt = `off by ${Math.round(d)}°`;
      break;
    }
    case 'pitch': {
      const o = scorePitch(p.freq, Number(guessValue)).off;
      txt = o < 1 ? 'spot on' : `off by ${Math.round(o)} cents`;
      break;
    }
    case 'tempo': {
      const d = scoreTempo(p.bpm, Number(guessValue)).delta;
      txt = d === 0 ? 'exact' : `off by ${d} BPM`;
      break;
    }
    default: return '';
  }
  return ` <span class="mp-guess-error">${escapeHtml(txt)}</span>`;
}

function renderMpBoard(results) {
  const board = $('mpBoard');
  if (!results.length) { board.innerHTML = ''; return; }
  const rows = results.map((r, i) => {
    const isMe = r.id === mp.meId;
    const rank = ['🥇', '🥈', '🥉'][i] || String(i + 1);
    const round = r.submitted ? `+${r.roundScore}` : '—';
    const answer = r.submitted ? mpAnswerLabel(r.guessValue) : '';
    const error = r.submitted ? mpErrorLabel(r.guessValue) : '';
    // Guess + per-mode error live on their own line under the name so they
    // can't crush or clip the name column on narrow screens.
    const guess = (answer || error) ? `<span class="mp-row-guess">${answer}${error}</span>` : '';
    return `
      <div class="mp-row${isMe ? ' is-me' : ''}${r.connected ? '' : ' is-offline'}">
        <span class="mp-rank">${rank}</span>
        <span class="mp-row-name">
          <span class="mp-row-who">${escapeHtml(r.name)}${isMe ? ' <span class="mp-you">you</span>' : ''}</span>
          ${guess}
        </span>
        <span class="mp-row-round">${round}</span>
        <span class="mp-row-total">${r.total}</span>
      </div>`;
  }).join('');
  board.innerHTML = `
    <div class="mp-row mp-row--head">
      <span class="mp-rank">#</span>
      <span class="mp-row-name">Player</span>
      <span class="mp-row-round">Round</span>
      <span class="mp-row-total">Total</span>
    </div>${rows}`;
}

function renderMpRevealActions() {
  const wrap = $('mpRevealActions');
  wrap.innerHTML = '';
  if (mp.role === 'host') {
    const next = document.createElement('button');
    next.className = 'btn btn--primary';
    next.textContent = 'Next round';
    next.addEventListener('click', hostNextRound);
    const end = document.createElement('button');
    end.className = 'btn';
    end.textContent = 'End match';
    end.addEventListener('click', hostEndMatch);
    wrap.append(next, end);
  } else {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Waiting for the host to start the next round…';
    wrap.appendChild(note);
  }
}

/* ----- match over / rematch ----- */

function showMpMatchOver(payload) {
  clearTimers();
  mpStopRoundClock();
  mp.phase = 'ended';
  mp.inWaiting = false;
  mp.revealShown = false;
  const results = payload.results || [];
  const top = results[0];
  $('mpRevealTitle').textContent = 'Final standings';
  $('mpRevealSub').textContent = top
    ? `${escapeHtml(top.name)} wins with ${top.total}.`
    : 'Match over.';
  $('mpRevealCompare').innerHTML = '';
  renderMpFinalBoard(results);
  renderMpMatchOverActions();
  showScreen('mp-reveal');
}

function renderMpFinalBoard(results) {
  const board = $('mpBoard');
  if (!results.length) { board.innerHTML = ''; return; }
  const rows = results.map((r, i) => {
    const isMe = r.id === mp.meId;
    const rank = ['🥇', '🥈', '🥉'][i] || String(i + 1);
    return `
      <div class="mp-row mp-row--final${isMe ? ' is-me' : ''}${r.connected ? '' : ' is-offline'}">
        <span class="mp-rank">${rank}</span>
        <span class="mp-row-name">${escapeHtml(r.name)}${isMe ? ' <span class="mp-you">you</span>' : ''}</span>
        <span class="mp-row-total">${r.total}</span>
      </div>`;
  }).join('');
  board.innerHTML = `
    <div class="mp-row mp-row--final mp-row--head">
      <span class="mp-rank">#</span>
      <span class="mp-row-name">Player</span>
      <span class="mp-row-total">Total</span>
    </div>${rows}`;
}

function renderMpMatchOverActions() {
  const wrap = $('mpRevealActions');
  wrap.innerHTML = '';
  if (mp.role === 'host') {
    const keep = document.createElement('button');
    keep.className = 'btn btn--primary';
    keep.textContent = 'Rematch — keep scores';
    keep.addEventListener('click', () => hostRematch(false));
    const reset = document.createElement('button');
    reset.className = 'btn';
    reset.textContent = 'Rematch — reset scores';
    reset.addEventListener('click', () => hostRematch(true));
    const close = document.createElement('button');
    close.className = 'btn';
    close.textContent = 'Close room';
    close.addEventListener('click', hostCloseRoom);
    wrap.append(keep, reset, close);
  } else {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Match over — waiting to see if the host starts a rematch…';
    wrap.appendChild(note);
  }
}

function mpWireReplayButtons() {
  const compare = $('mpRevealCompare');
  compare.querySelectorAll('[data-tone]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.sound) state.sound.stop();
      state.sound = playTone(Number(btn.dataset.tone), 900, { type: 'sine', gain: 0.18 });
    });
  });
  compare.querySelectorAll('[data-bpm]').forEach(btn => {
    btn.addEventListener('click', () => playBeats(Number(btn.dataset.bpm), 4));
  });
}

/* ----- lobby rendering ----- */

function hostPlayerSnapshot() {
  const arr = [];
  for (const pl of mp.players.values()) {
    arr.push({ id: pl.id, name: pl.name, total: pl.total, connected: pl.connected });
  }
  return arr;
}

function renderMpLobby() {
  $('mpCodeDisplay').textContent = mp.code || '----';
  renderMpPlayerList(mp.role === 'host' ? hostPlayerSnapshot() : mp.board);
  if (mp.role === 'host') {
    $('mpHostControls').hidden = false;
    $('mpLobbyWait').hidden = true;
    renderMpHostMode();
  } else {
    $('mpHostControls').hidden = true;
    $('mpLobbyWait').hidden = false;
  }
}

function renderMpPlayerList(players) {
  const wrap = $('mpPlayers');
  if (!players || !players.length) { wrap.innerHTML = '<p class="muted">No one here yet.</p>'; return; }
  wrap.innerHTML = players.map(p => {
    const isMe = p.id === mp.meId;
    const isHost = p.id === 'host';
    const badges = `${isHost ? '<span class="mp-badge">host</span>' : ''}${isMe ? '<span class="mp-badge mp-badge--you">you</span>' : ''}`;
    const total = typeof p.total === 'number' ? `<span class="mp-player-total">${p.total}</span>` : '';
    return `
      <div class="mp-player${p.connected ? '' : ' is-offline'}">
        <span class="mp-player-name">${escapeHtml(p.name)} ${badges}</span>
        ${total}
      </div>`;
  }).join('');
}

function renderMpHostMode() {
  const grid = $('mpModeGrid');
  if (!grid.dataset.built) {
    grid.innerHTML = '';
    Object.entries(GAMES).forEach(([key, game]) => {
      const card = document.createElement('button');
      card.className = 'mp-mode-card';
      card.type = 'button';
      card.dataset.key = key;
      card.innerHTML = `<span class="mp-mode-name">${game.name}</span><span class="mp-mode-desc">${game.desc}</span>`;
      card.addEventListener('click', () => mpPickMode(key));
      grid.appendChild(card);
    });
    grid.dataset.built = '1';
  }
  grid.querySelectorAll('.mp-mode-card').forEach(c => {
    c.classList.toggle('is-selected', c.dataset.key === mp.pickedGame);
  });
  const isColour = mp.pickedGame === 'colour';
  $('mpPaletteWrap').hidden = !isColour;
  if (isColour) renderMpPaletteGrid();
  $('mpStartBtn').disabled = !(mp.pickedGame && (!isColour || mp.pickedSpace));
}

function mpPickMode(key) {
  mp.pickedGame = key;
  if (key !== 'colour') mp.pickedSpace = null;
  else if (!mp.pickedSpace) mp.pickedSpace = 'rgb';
  renderMpHostMode();
}

function renderMpPaletteGrid() {
  const grid = $('mpPaletteGrid');
  if (!grid.dataset.built) {
    grid.innerHTML = '';
    Object.entries(SPACES).forEach(([key, space]) => {
      const chip = document.createElement('button');
      chip.className = 'mp-palette-chip';
      chip.type = 'button';
      chip.dataset.key = key;
      chip.innerHTML = `<span class="mp-palette-swatch" style="background:${space.preview}"></span>${space.name}`;
      chip.addEventListener('click', () => { mp.pickedSpace = key; renderMpHostMode(); });
      grid.appendChild(chip);
    });
    grid.dataset.built = '1';
  }
  grid.querySelectorAll('.mp-palette-chip').forEach(c => {
    c.classList.toggle('is-selected', c.dataset.key === mp.pickedSpace);
  });
}

function wireMpActions() {
  $('playFriends').addEventListener('click', () => {
    mpSetupError('');
    mpSetInvite('');
    $('mpName').value = mpLoadName();
    $('mpCode').value = '';
    showMpSetup();
    $('mpName').focus();
  });
  $('mpHostBtn').addEventListener('click', mpBecomeHost);
  $('mpJoinBtn').addEventListener('click', mpJoin);
  $('mpCode').addEventListener('input', (e) => { e.target.value = Net.normalizeCode(e.target.value); });
  $('mpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('mpCode').focus(); } });
  $('mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); mpJoin(); } });
  $('mpCopyCode').addEventListener('click', () => { if (mp.code) mpCopy(mp.code, 'mpCopyCode'); });
  $('mpCopyLink').addEventListener('click', () => { if (mp.code) mpCopy(mpShareLink(), 'mpCopyLink'); });
  $('mpStartBtn').addEventListener('click', () => {
    if (mp.role !== 'host' || !mp.pickedGame) return;
    primeAudio();
    hostStartRound(mp.pickedGame, mp.pickedSpace);
  });
}


/* ---------- 9. Actions + theme + boot ---------- */

function wireActions() {
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.getAttribute('data-action');
    if (action === 'home') {
      e.preventDefault();
      if (mp.active) mpTeardown();   // leave any room before bailing to the grid
      clearTimers();
      renderModeCards();   // refresh best-score badges
      showScreen('home');
    } else if (action === 'again') {
      clearTimers();
      if (state.again) state.again();
    } else if (action === 'mp-leave') {
      e.preventDefault();
      mpLeave();
    }
  });

  $('respondSubmit').addEventListener('click', () => { if (state.submit) state.submit(); });
  $('resultSecondary').addEventListener('click', () => { if (state.secondary) state.secondary(); });

  // Reset scores — a two-step inline confirm (no blocking dialog). First click
  // arms it; a second within 3s clears; otherwise it disarms itself.
  const resetBtn = $('resetStats');
  let armed = false, armTimer = null;
  const disarm = () => {
    armed = false;
    clearTimeout(armTimer);
    resetBtn.textContent = 'Reset scores';
    resetBtn.classList.remove('is-armed');
  };
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.textContent = 'Click again to clear';
      resetBtn.classList.add('is-armed');
      armTimer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    saveStats({});
    renderModeCards();   // hides the footer + drops every badge
  });

  // Esc bails out: leave a room if in multiplayer, else drop to the mode grid
  // from any round screen (observe / respond / result).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (mp.active) { mpLeave(); return; }
    const inRound = $('screen-observe').classList.contains('is-active')
                 || $('screen-respond').classList.contains('is-active')
                 || $('screen-result').classList.contains('is-active');
    if (inRound) {
      clearTimers();
      renderModeCards();
      showScreen('home');
    }
  });
}

function initTheme() {
  const saved = localStorage.getItem('gamut-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);

  $('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('gamut-theme', next);
  });
}

/* An invite link (?room=CODE) deep-links straight to the join screen with the
   code prefilled. We consume the param and clean the URL so a later refresh or
   self-host doesn't drag the user back into join mode. */
function mpConsumeInviteParam() {
  let raw = '';
  try { raw = new URLSearchParams(location.search).get('room') || ''; } catch { return; }
  if (!raw) return;
  try { history.replaceState(null, '', location.origin + location.pathname); } catch { /* ignore */ }
  if (!Net || !Net.available()) return;
  const code = Net.normalizeCode(raw);
  if (code.length !== 4) return;
  mpSetupError('');
  mpSetInvite(code);
  $('mpName').value = mpLoadName();
  $('mpCode').value = code;
  showMpSetup();
  const name = $('mpName');
  if (name.value) $('mpJoinBtn').focus(); else name.focus();
}

function boot() {
  initTheme();
  renderModeCards();
  wireActions();
  wireMpActions();
  showScreen('home');
  mpConsumeInviteParam();
}

document.addEventListener('DOMContentLoaded', boot);
