# gamut

A minimalist color-matching game. You're shown a random target color for five seconds, then you mix its closest match using sliders tailored to the chosen color space. Score is based on perceptual distance (CIE76 ΔE in Lab space).

The name *Gamut* refers to the full range of colors representable in a given color space — and that's exactly what you're testing yourself against.

**Play it live:** [iamyvj.github.io/gamut](https://iamyvj.github.io/gamut)

## Palettes

- **RGB** — full 24-bit spectrum, red/green/blue sliders
- **CMYK** — print-style cyan/magenta/yellow/black
- **HSL** — vivid, hue-focused
- **Grayscale** — hard mode, only luminance varies
- **Pastels** — soft, low-saturation hues
- **Neon** — electric, high-saturation
- **Jewel tones** — deep emerald, sapphire, ruby
- **Earth tones** — ochre, clay, moss, terracotta
- **Cool** — blues, greens, and violets
- **Sepia** — warm browns, like old photographs

Each palette restricts the slider ranges so you mix colors that actually belong to that family.

## How it works

1. Pick a palette from the home screen.
2. The target color fills the screen for 5 seconds — memorize it.
3. Use the sliders (whose tracks show the live color range for each channel) to mix what you remember.
4. Lock in your guess and see how close you got. ΔE is computed in Lab (sRGB → linear → XYZ D65 → Lab), then mapped to a 0–100 score: `max(0, round(100 - ΔE * 1.5))`.

## Files

```
index.html   markup + screen sections
styles.css   tokens, light/dark theme, responsive layout
script.js    color math, palette definitions, game flow
```
