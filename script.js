/* ============================================================
   Gamut — static color-matching game
   Sections:
     1. Color utilities (RGB/HSL/CMYK ↔ Lab, ΔE)
     2. Color-space definitions + palette generation
     3. Game state + round flow
     4. Screen rendering + DOM wiring
     5. Theme toggle + boot
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


/* ---------- 2. Color-space definitions ---------- */

/* Each space defines:
   - display metadata (name, desc, preview gradient)
   - channels: slider definitions [{ key, label, min, max, step, init }]
   - toRgb(values): convert channel values → RGB
   - random(): produce a random target (in RGB) within the space's gamut    */
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


/* ---------- 3. Game state ---------- */

const state = {
  spaceKey: null,
  target: null,
  pickerValues: null,
  countdownTimer: null
};

function startRound(spaceKey) {
  state.spaceKey = spaceKey;
  state.target = SPACES[spaceKey].random();
  showScreen('memorize');
  runMemorizePhase();
}

function runMemorizePhase() {
  const fill = document.getElementById('memorizeFill');
  fill.style.backgroundColor = rgbToCss(state.target);

  const label = document.getElementById('countdownLabel');
  const progress = document.getElementById('countdownProgress');
  const circumference = 2 * Math.PI * 19; // ≈ 119.38
  progress.style.strokeDasharray = circumference.toFixed(2);
  progress.style.transition = 'none';
  progress.style.strokeDashoffset = '0';

  let remaining = 5;
  label.textContent = remaining;
  // kick the transition on next frame
  requestAnimationFrame(() => {
    progress.style.transition = `stroke-dashoffset ${remaining * 1000}ms linear`;
    progress.style.strokeDashoffset = String(circumference);
  });

  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      label.textContent = '0';
      enterSelectPhase();
    } else {
      label.textContent = remaining;
    }
  }, 1000);
}

function enterSelectPhase() {
  const space = SPACES[state.spaceKey];
  document.getElementById('selectSpaceName').textContent = space.name;

  // initialize channel values from each channel's init
  state.pickerValues = {};
  space.channels.forEach(ch => { state.pickerValues[ch.key] = ch.init; });

  const container = document.getElementById('pickerControls');
  container.innerHTML = '';
  space.channels.forEach(ch => {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `
      <label for="slider-${ch.key}">${ch.label}</label>
      <input id="slider-${ch.key}" type="range"
             min="${ch.min}" max="${ch.max}" step="${ch.step}" value="${ch.init}" />
      <output for="slider-${ch.key}">${ch.init}</output>
    `;
    const input = row.querySelector('input');
    const output = row.querySelector('output');
    input.dataset.channel = ch.key;
    input.addEventListener('input', () => {
      const val = Number(input.value);
      state.pickerValues[ch.key] = val;
      output.textContent = val;
      updatePickerPreview();
    });
    container.appendChild(row);
  });

  updatePickerPreview();
  showScreen('select');
}

function updatePickerPreview() {
  const space = SPACES[state.spaceKey];
  const rgb = space.toRgb(state.pickerValues);
  document.getElementById('pickerPreview').style.backgroundColor = rgbToCss(rgb);
  document.getElementById('pickerHex').textContent = rgbToHex(rgb);

  // refresh every slider's track gradient (each channel's range can depend on others)
  space.channels.forEach(ch => {
    const input = document.getElementById(`slider-${ch.key}`);
    if (input && ch.gradient) {
      input.style.setProperty('--track', ch.gradient(state.pickerValues));
    }
  });
}

function handlePick(pick) {
  const dE = deltaE76(state.target, pick);
  const score = Math.max(0, Math.round(100 - dE * 1.5));

  document.getElementById('resultTarget').style.backgroundColor = rgbToCss(state.target);
  document.getElementById('resultPick').style.backgroundColor = rgbToCss(pick);
  document.getElementById('resultTargetHex').textContent = rgbToHex(state.target);
  document.getElementById('resultPickHex').textContent = rgbToHex(pick);
  document.getElementById('scoreNumber').textContent = score;
  document.getElementById('resultDelta').textContent = dE.toFixed(1);
  document.getElementById('resultLabel').textContent = qualitative(score);
  showScreen('result');
}

function qualitative(score) {
  if (score >= 97) return 'Perfect';
  if (score >= 85) return 'Sharp eye';
  if (score >= 65) return 'Close';
  if (score >= 40) return 'Off';
  return 'Way off';
}


/* ---------- 4. Screens + rendering ---------- */

function showScreen(name) {
  ['home', 'memorize', 'select', 'result'].forEach(n => {
    const el = document.getElementById(`screen-${n}`);
    const active = n === name;
    el.classList.toggle('is-active', active);
    el.setAttribute('aria-hidden', active ? 'false' : 'true');
  });
}

function renderSpaceCards() {
  const grid = document.getElementById('spaceGrid');
  grid.innerHTML = '';
  Object.entries(SPACES).forEach(([key, space]) => {
    const card = document.createElement('button');
    card.className = 'space-card';
    card.type = 'button';
    card.innerHTML = `
      <div class="space-preview" style="background: ${space.preview}"></div>
      <div class="space-name">${space.name}</div>
      <p class="space-desc">${space.desc}</p>
    `;
    card.addEventListener('click', () => startRound(key));
    grid.appendChild(card);
  });
}

function wireActions() {
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const action = t.getAttribute('data-action');
    if (action === 'home') {
      e.preventDefault();
      clearInterval(state.countdownTimer);
      showScreen('home');
    } else if (action === 'again') {
      if (state.spaceKey) startRound(state.spaceKey);
    }
  });

  document.getElementById('pickerSubmit').addEventListener('click', () => {
    const pick = SPACES[state.spaceKey].toRgb(state.pickerValues);
    handlePick(pick);
  });
}


/* ---------- 5. Theme toggle + boot ---------- */

function initTheme() {
  const saved = localStorage.getItem('gamut-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);

  document.getElementById('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('gamut-theme', next);
  });
}

function boot() {
  initTheme();
  renderSpaceCards();
  wireActions();
  showScreen('home');
}

document.addEventListener('DOMContentLoaded', boot);
