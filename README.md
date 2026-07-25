# gamut

A suite of minimalist **perception games**. Each one shows you something briefly, then asks you to reproduce it from memory — and scores how close you got.

The name *Gamut* refers to the full range you're testing yourself against: the full range of colors, of durations, of quantities, of angles, of pitches, of tempos.

**Play it live:** [iamyvj.github.io/gamut](https://iamyvj.github.io/gamut)

## Modes

- **Colour** — memorize a target color for five seconds, then mix its closest match using sliders tailored to the chosen palette. Score is perceptual distance (CIE76 ΔE in Lab space).
- **Time** — a shape lingers on screen for a random duration; estimate how long it was shown.
- **Count** — a cluster of dots flashes briefly; estimate how many there were.
- **Angle** — a needle points somewhere for a moment; reproduce the angle on a dial.
- **Pitch** — a pure tone plays for a couple of seconds; retune a slider (with live playback) to match the frequency by ear.
- **Tempo** — a metronome beat plays at a random BPM; match it with a slider that drives a live metronome preview.

## Colour palettes

The Colour mode offers ten palettes, each restricting the slider ranges so you mix colors that belong to that family:

RGB · CMYK · HSL · Grayscale · Pastels · Neon · Jewel tones · Earth tones · Cool · Sepia

## How it works

1. Pick a mode from the home screen (and, for Colour, a palette).
2. Observe the stimulus while it's shown.
3. Reproduce it — sliders for Colour/Time/Count/Pitch/Tempo, a draggable dial for Angle. (Pitch and Tempo play sound as you drag, so you can match by ear.)
4. Lock in your guess and see how close you got, scored 0–100.

## Multiplayer

**Play with friends →** on the home screen starts a shared game. One person hosts a room and gets a four-digit code; everyone else joins with the code or a shareable invite link (`?room=CODE`, which deep-links straight to the join screen). The host picks a mode (and palette) each round, and *everyone sees the same stimulus at the same time* — the same target color, the same dot layout, the same tone. After you lock in, a leaderboard reveals every player's guess, score, and per-mode error (ΔE, "off by 0.3s", cents, …) to match the single-player result screen; cumulative totals carry across rounds.

Each round runs on a countdown that auto-reveals when it expires, so one AFK player can't stall everyone (the host also has a manual "Reveal now"). The countdown shows as a floating timer that turns red in the final ten seconds and is announced to screen readers. A player who drops mid-round can rejoin and still play, as long as they're back within a short grace window — and if they'd already locked in before dropping, they land back on the waiting board rather than being stranded. A subtle cue (blip + vibration) marks each new round for players idling on the leaderboard, and a backgrounded tab flashes its title and favicon so you notice from another window. When the host ends the match, they choose a rematch — keeping the running scores or resetting them — or close the room (which drops everyone home with a notice).

It runs peer-to-peer over **WebRTC** ([PeerJS](https://peerjs.com/)) in a host-authoritative star: the host owns the truth (it generates the stimulus, aggregates scores, and broadcasts state) and joiners only render what the host sends. There's no game server — a public broker is used once for the initial handshake, then traffic is direct between peers. For fully-offline LAN play you can run your own broker; see the note at the top of `net.js`. Multiplayer keeps its own running leaderboard and never touches your single-player best/average stats.

Scoring per mode:
- **Colour** — ΔE in Lab (sRGB → linear → XYZ D65 → Lab), mapped as `max(0, round(100 - ΔE * 1.5))`.
- **Time / Count** — relative error against the true value.
- **Angle** — circular difference in degrees (0° off = 100, 90° off = 0).
- **Pitch** — pitch error in cents: `max(0, round(100 - |cents| / 6))` (a half-octave off = 0).
- **Tempo** — relative BPM error: `max(0, round(100 - 140 * (Δbpm / actual)))`.

## Architecture

Everything is data-driven from two registries in `script.js`:

- `GAMES` defines the modes shown on the home screen.
- `SPACES` defines the Colour palettes.

A small shared engine (`runObserve` → `runRespond` → `showResult`) drives every mode's show-then-guess flow, so adding a new game or palette means adding one entry — the screens, sliders, and gradients generate themselves.

The audio modes (Pitch / Tempo) run their own listening phase in place of `runObserve` and share a tiny Web Audio layer (`playTone`, `createTunableTone`, `createMetronome`) built on a single `AudioContext` that's created inside the mode-card click so it satisfies browser autoplay rules.

Scoring lives in six pure functions (`scoreColour`, `scoreTime`, …) with no DOM work, so the single-player result screens and the multiplayer engine share one source of truth. Multiplayer (`net.js` + section 8 of `script.js`) reuses the same observe/respond builders: the host generates one set of stimulus *parameters*, ships them to every peer, and each peer replays them locally through the ordinary engine before reporting its score back.

## Files

```
index.html   markup + screen sections (home, palettes, observe, respond, result, multiplayer)
styles.css   tokens, light/dark theme, responsive layout
net.js       WebRTC peer-to-peer transport (PeerJS host/join, room codes)
script.js    color math, scorers, game engine, mode definitions, game flow, multiplayer engine
```
