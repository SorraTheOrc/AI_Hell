# Automated gameplay capture (dev tooling)

> **Status: spike proof-of-concept** — AH-0MUWMFF3C002WOBK.
> The deliverable is a *working* capture path plus this written
> recommendation, not a production pipeline. Productionising it, seeding all
> RNG or wiring it into CI are explicitly **out of scope** (record those as
> follow-up work items instead).

This document records how AI_Hell can produce a gameplay video **without a
human recording their screen**: one opt-in command boots the game in a real
rendering browser, starts the **in-game attract/demo mode** (the shipped bot
plays itself), and writes a playable video file locally. A `--scripted`
fallback replays the original deterministic key plan instead
(AH-0MUX496IJ0041O3V).

## TL;DR — recommended approach

**Approach A: headless Chromium (Playwright) + `canvas.captureStream(60)` +
`MediaRecorder` → WebM.**

```bash
# one-time: install JS deps + the matching browser
npm install
npm run capture:install          # playwright install chromium (~278 MiB download)

# record a complete in-game demo run (start → game over + 5 s tail) to capture-output/…
npm run capture

# bound a long run or lengthen the post-signal tail
npm run capture -- --max-duration 1800000 --tail 5000

# or use the legacy fixed-length / scripted fallbacks
npm run capture -- --duration 20000 --output clips/demo.webm
npm run capture -- --headed      # watch it drive a visible browser
npm run capture -- --scripted    # fallback: replay the fixed scripted plan

# record the dev boss scenario: jump straight to a boss with 4 hits remaining
npm run capture -- --scenario boss-four-hits

# discover every implemented dev scenario (no browser or server booted)
npm run capture -- --list-scenarios
npm run capture -- --list-scenarios --json

# record a batch of 3 clips in one process (one dev server + one browser)
npm run capture -- --count 3          # or the short alias: -n 3
npm run capture -- --count 3 --output clips/demo.webm   # clips/demo-1..3.webm

# record EVERY dev scenario in one process (one video per scenario, no demo)
npm run capture -- --all-scenarios
npm run capture -- --all-scenarios --output clips          # clips/<scenario>.webm

# compile the captured pool into a promo + showreel + highlight clips
# (needs a full ffmpeg — see Compiling a promo package below)
npm run compile:promo
```

This was proven end to end on 2026-10-06: a 12 s clip recorded at
**960×540, WebM/VP9 + Opus, ~2.4 MiB**, decoded back and probed at
**~1.5 % non-black pixels, ~590 distinct colours, non-zero inter-frame
motion**, with **zero page errors**. The clip also carries the **game's own
SFX** (audio peak ≈ 0.44, RMS ≈ 0.08), decoded and verified in-page — see
[Audio capture](#audio-capture).

## Exact tooling & versions

| Component | Version / notes |
|---|---|
| Playwright (npm) | `1.55.1` (devDependency; chosen to match the browser already cached on the host — any 1.55.x works) |
| Chromium | `140.0.7339.186` (Playwright build **v1193**) |
| Renderer | `Phaser.AUTO` → **WebGL**, via headless Chromium's software (SwiftShader) backend |
| Encoder | browser-native `MediaRecorder`, preferring `video/webm;codecs=vp9,opus` (falls back to VP8+Opus, then plain WebM) |
| Audio | the game's own SFX, tapped from its single shared `AudioContext` and encoded as **Opus 48 kHz stereo** |
| Output | `.webm` (VP9 + Opus), **960×540 @ 60 fps** capture of the game canvas, plus **`<stem>.action.jsonl`** (per-run action-intensity series) and **`<stem>.capture.json`** (§7.5 video-join anchor) alongside each WebM (AH-0MVDV4DMY001Z7CU) |

## What the command does (pipeline)

`scripts/capture-gameplay.mjs` orchestrates the whole thing:

1. Starts the **Vite dev server programmatically** (`createServer` from the
   `vite` package) with `server.open: false`, so no browser window is opened
   by the usual `npm run dev` config.
2. Launches **headless Chromium** through Playwright with
   `--enable-unsafe-swiftshader` (required for software WebGL in headless
   mode) and `--no-sandbox`.
3. Installs the **page-side Web Audio tap** with `page.addInitScript`, before
   any game script runs, so the wrapper is in place when the game first
   connects its master gain to `context.destination` (see
   [Audio capture](#audio-capture)).
4. Loads the game and waits for the real `#game-container canvas` at
   `960×540`.
5. Starts a run through the **normal menu input path**: by default it presses
   **Tab** then **Enter** to activate the **Watch Demo** control (`Play Game`
   is focused by default, so Tab moves focus to Watch Demo), which starts
   `PlayScene` in demo mode; with `--scripted` it presses **Enter** to
   activate the focused **Play Game** control instead. Either gesture resumes
   the shared `AudioContext`. Waits `--warmup` ms for `PlayScene` to settle,
   then waits (bounded) for the tap to expose an audio track.
6. Calls `canvas.captureStream(60)`, muxes the canvas video tracks with the
   tapped audio tracks and starts a `MediaRecorder` **inside the page** with
   the resolved VP9+Opus mime.
7. Records the run. The default **demo** path installs a run-end listener
   **before the game boots** (`page.addInitScript`), waits for the dev-gated
   `aihell:run-ended` signal and keeps recording for `--tail` ms after it,
   bounded by `--max-duration` ms — a whole run, win or lose, instead of a
   fixed clip (see [Full-run capture](#full-run-capture-default)). With
   `--scripted` the deterministic bot plan (below) is replayed as **real
   Playwright `keyboard.down`/`keyboard.up` events** (trusted input, not
   synthesised DOM events); `--duration` keeps the legacy fixed-length clip.
8. Stops the recorder, decodes the produced WebM back through a `<video>`
   element and probes several sampled frames for **resolution, duration,
   non-black fraction, colour variety and frame-to-frame motion**, then
   decodes the audio with `decodeAudioData` for **peak and RMS**.
9. Streams the encoded chunks to Node over an `exposeFunction` binding and
   writes them to the output file.
10. Before the game boots, opts the page **into telemetry**
    (`VITE_TELEMETRY_ENABLED=true`, `VITE_TELEMETRY_SINK=jsonl` — the same
    flags `scripts/record-session.mjs` uses) so the run's per-tick
    `state.actionIntensity` metric lands in the page's dev JSONL sink. After
    each clip it reads the sink back via `page.evaluate`, and writes the
    **action-intensity series** (`<stem>.action.jsonl`) and the **§7.5
    video-join anchor** (`<stem>.capture.json`) next to the WebM
    (AH-0MVDV4DMY001Z7CU). See [Action-intensity export](#action-intensity-export).

## Action-intensity export

Every clip exports two artefacts alongside the WebM (basename-matched, e.g.
`gameplay-2026-10-18T10-00-00-000Z.webm` →
`gameplay-2026-10-18T10-00-00-000Z.action.jsonl` + `…capture.json`):

- **`<stem>.action.jsonl`** — the standalone action-intensity series in the
  canonical format (`docs/dev/action-intensity.md` §7.2–§7.3), built by the
  pure helpers in `scripts/capture-series.mjs` from the recorded telemetry
  ticks: a self-describing header (`schemaVersion`, `runSeed`,
  `sampleRateHz`, `categories`) plus one line per recorded action-intensity
  sample (`t` = real ms since run start, from each tick's own `recordedAt`
  clock — see §7.2; `tick`, the four scores, the breakdown). It is
  **byte-for-byte compatible** with
  `src/scenes/core/actionIntensitySerialiser.ts` (the parity is asserted by
  `scripts/capture-gameplay.test.ts`) — no format is forked.
- **`<stem>.capture.json`** — the §7.5 join anchor:
  `{ schemaVersion, kind: 'capture-join-anchor', captureStartedAtEpochMs,
  runStartedAtEpochMs, offsetMs, approximate }`. `offsetMs =
  capture_started − run_startedAt` is the exact constant a consumer
  subtracts from series `t` to get WebM timeline time
  (`videoTimeMs(t) = t − offsetMs`, clamped at 0). When either epoch is
  missing (an older clip, telemetry off) the anchor flags itself
  `approximate` and the consumer falls back to the documented `--warmup`
  heuristic (§7.5).

The export is **additive and tolerant**: it cannot fail a clip (a failed
write degrades to `seriesOutput: null`/`anchorOutput: null` on the result),
and a telemetry-less or interrupted run writes a valid **header-only**
series (AC3). The dev JSONL sink keeps the run in an **in-memory, per-run
buffer** (`startRun()` resets it), which the dev-gated
`window.__aiHellTelemetry.read()` accessor exposes to the capture script
(AH-0MVIRYGD1000JVY3). Telemetry never uses `localStorage`, so a long busy
run is captured in full — there is no storage-quota truncation, and the
previous prefix-only series for long runs can no longer occur. The accessor
is installed only in a dev build, so a production bundle has no telemetry
page global at all.

## Pool inventory

`npm run list:pool` prints an inventory of the captured source pool
(AH-0MVDV4SYG008X8TY): which runs are usable and which gameplay features
(weapons, pickups, enemies, boss) each one actually shows. It is the
evidence that the pool covers the editorial categories before compiling —
the same `EDITORIAL_CONFIG` feature mapping the promo compiler uses, so the
inventory cannot drift from the coverage manifest.

A run is **retained** only when all three artefacts exist:
`<run>.webm` + `<run>.action.jsonl` + `<run>.capture.json`. A WebM without
its series/anchor (e.g. footage captured before the export landed) is
**excluded and reported**, never silently counted as usable material. A
header-only series is a valid partial run, but evidences no features.

```bash
# human-readable inventory of capture-output/
npm run list:pool

# machine-readable manifest, kept next to the footage
npm run list:pool -- --json > capture-output/pool-inventory.json

# scan a different directory, or limit to explicit run ids
npm run list:pool -- --dir clips
npm run list:pool -- --runs boss-2026-10-19T16-25-05-656Z
```

Features are recognised from the series breakdown (`playerBullets` →
weapons, `drops` → pickups, `enemies` → enemies, `bosses` → boss) and each
is reported with its sample count and first/last series time. The manifest
also lists `missingFeatures`, so a gap is visible instead of being inferred.
The lister is pure apart from a thin `node:fs` scan, and is unit-tested
hermetically (`scripts/list-capture-pool.test.ts`) without footage, ffmpeg
or a browser.

## Compiling a promo package (`npm run compile:promo`)

`npm run compile:promo` turns the captured pool into shareable material —
a short promo, a longer showreel and individual highlight clips — by
trimming, reordering, concatenating and muxing the source WebMs with
`ffmpeg` (AH-0MVDV50Z20071RF4; the driver itself is
AH-0MVDV4PNZ004ZWOZ). Nothing is hand-edited: the edit plan, the cut
selection and the manifests all come from the recorded
`.action.jsonl` series, so the package is reproducible from the pool.

```bash
# one-off: install a full ffmpeg (VP9 + Opus) — see Prerequisites below
npm run compile:promo                     # plan + compile + validate

# plan only (no ffmpeg required at all): writes the edit plan JSON to stdout
node scripts/compile-promo.mjs | less

# limit the pool to specific runs, or choose the output directory
npm run capture -- --count 5              # ... capture more peaks first
node scripts/compile-promo.mjs --runs gameplay-2026-10-23T12-28-08-402Z-3,boss-2026-10-19T16-25-05-656Z
node scripts/compile-promo.mjs --compile --out capture-output/compile-promo.plan.json --out-dir capture-output

# everything the tool accepts, with the prerequisites restated
node scripts/compile-promo.mjs --help
```

### Prerequisites

The compiler itself is pure Node (no dependencies beyond the repo) unless
`--compile` is passed. `--compile` needs a **full `ffmpeg` install** — one
with the **VP9 encoder (`libvpx-vp9`)** and the **Opus encoder
(`libopus`)** — plus `ffprobe`, both on `PATH`:

```bash
sudo apt-get install ffmpeg        # Debian/Ubuntu
brew install ffmpeg                # macOS (Homebrew)
# static builds: https://johnvansickle.com/ffmpeg/
```

`FFMPEG_BIN` / `FFPROBE_BIN` override the resolved binaries (e.g. a static
build in `~/.local/bin`). Playwright's bundled minimal ffmpeg is **not**
sufficient (VP8-only, no VP9/Opus encoder).

Detection is explicit and fails fast with an actionable message rather than
an `ENOENT` stack: a missing `ffmpeg`/`ffprobe` exits non-zero and prints the
install hints above plus `npm run compile:promo`. The output directory must
already exist — a missing `--out-dir` is reported as such (with a `mkdir -p`
suggestion) before any encoding starts.

### Progress and output streams

A full package is a few minutes of VP9 encoding, so `--compile` reports its
progress on **stderr** — one `compile:` line for the plan summary, one per
deliverable with its cut count and source, and one per deliverable when its
encode finishes (`ok` or `FAIL` with the reason) — and only then prints the
final validation summary on **stdout**:

```text
compile: plan ready: 13 promo cuts, 34 showreel cuts, 5 highlight clips → capture-output/compile-promo.plan.json
compile: compiling 7 deliverables with /home/you/.local/bin/ffmpeg (26 sources)
compile: [1/7] promo: 13 cuts → capture-output/promo.webm
compile: [1/7] promo: ok — 57.9s
compile: [2/7] showreel: 34 cuts → capture-output/showreel.webm
...
compile: verifying promo pace and deliverable sizing
Compiled deliverables — all validated OK:
...
```

Long silence between those lines is expected while `ffmpeg` encodes (a
57 s promo is ~13 re-encoded cuts at 960×540/60 fps); watch stderr to
confirm the run is progressing. stdout stays the machine-readable summary,
so piping the command still yields only the report of record.

### Inputs

Per retained run under `capture-output/` (see
[Action-intensity export](#action-intensity-export)):

| Input | Required | Role |
|---|---|---|
| `<run>.webm` | yes | Source footage (960×540, VP9 + Opus, the game's own SFX). |
| `<run>.action.jsonl` | yes | Recorded action-intensity series — drives the cut selection (§7.5 of [docs/dev/action-intensity.md](./action-intensity.md)). |
| `<run>.capture.json` | no | Join anchor mapping series time to video time. Without it (or when flagged `approximate`) the mapping falls back to raw series time and the cut is approximate. |

Runs missing the WebM or the series are excluded from the pool, and a missing
**source** is a clear error (`missing source webm/series`); `npm run list:pool`
lists what is usable before compiling (see [Pool inventory](#pool-inventory)).

### Outputs

Written into `--out-dir` (default `capture-output/`, gitignored — the
deliverables are **never committed**):

| File | Target | Notes |
|---|---|---|
| `promo.webm` | 45–60 s | Hook-first: opens on the strongest peak, jump-cuts across peaks. |
| `showreel.webm` | > 2 min | Every surviving peak cut, in source-time order. |
| `highlight-01.webm` … | 5 clips | One short clip per top-ranked peak. |
| `compile-promo.plan.json` | — | The edit plan: the **selection manifest** and the **coverage manifest**. |
| `compile-promo-report.json` | — | Per-deliverable validation, pace verification and target sizing. |

All deliverables are encoded at the game's **native 960×540**, 60 fps,
VP9 (`-crf 32`) + Opus 96 kb/s stereo, so they match what the game renders
and keep the game's own SFX.

### Manifests

`compile-promo.plan.json` is the **selection manifest** plus the
**coverage manifest**:

```json
{
  "promo": [
    {
      "runId": "gameplay-2026-10-23T12-28-08-402Z-3",
      "webm": "capture-output/gameplay-2026-10-23T12-28-08-402Z-3.webm",
      "series": "capture-output/gameplay-2026-10-23T12-28-08-402Z-3.action.jsonl",
      "videoInMs": 203017,
      "videoOutMs": 205695,
      "intensity": 0.852,
      "burstiness": 0.0356,
      "features": ["weapons", "enemies"]
    }
  ],
  "coverage": [
    {
      "feature": "pickups",
      "clips": [
        { "runId": "gameplay-2026-10-23T12-52-04-638Z-5", "videoInMs": 5150, "videoOutMs": 7839 }
      ]
    }
  ],
  "uncoveredFeatures": []
}
```

| Field | Meaning |
|---|---|
| `promo` / `showreel` / `highlights` | The ordered cuts per deliverable. Each carries the **source** (`runId`, `webm`, `series`), the **mapped video timestamps** (`videoInMs`/`videoOutMs` in the source WebM timeline, already clamped to the source duration), the **motivating recorded values** (`intensity`, `burstiness`) and the `features` visible in that cut. |
| `coverage` | The coverage manifest: for each editorial feature (`weapons`, `pickups`, `enemies`, `boss`) the source clip(s) and timestamp ranges that show it. |
| `uncoveredFeatures` | Features with **no** footage in the pool — a visible gap, never silently omitted. |

Which feature is visible in a cut is decided from the series `breakdown`
(`playerBullets` → weapons, `drops` → pickups, `enemies` → enemies,
`bosses` → boss), the same mapping the pool inventory uses.

`compile-promo-report.json` records the compiled result:

| Field | Meaning |
|---|---|
| `deliverables[]` | One entry per output: `name`, `output`, `ok`, `issues`, `probe` (codec, width/height, duration, audio codec/channels), `brightness`, `segments` (the same cut records as the plan, so the coverage claim can be checked **against the delivered clip**), `measuredMeanIntensity`. |
| `pace` | The promo's pace verdict: `ok`, `issues`, `band` and `measured` (`openingNonBlackRatio`, `nonBlackRatio`, `meanIntensity`). Band and calibration: [docs/dev/action-intensity.md §7.6](./action-intensity.md#76-pace-reference-band-for-the-compiled-promo). |
| `targets` | The deliverable sizing verdict: measured promo/showreel lengths and highlight count against the targets, with per-target issues. |
| `errors` | Every blocking issue, so a failed run is diagnosable from the report alone. |

### Validation

Every output is validated before the run is reported as successful
(`npm run compile:promo` exits non-zero if anything fails):

- **decodable** — `ffprobe` returns usable streams;
- **correct resolution** — 960×540 video;
- **audio present** — an Opus track (the game's SFX);
- **non-trivial pixels** — sampled luma (`signalstats` `YAVG`) shows the frame
  is not blank, using the calibrated screen-render floor documented in
  [docs/dev/action-intensity.md §7.6](./action-intensity.md#76-pace-reference-band-for-the-compiled-promo);
- **pace** — the promo opens with action (first 5 s) and its cuts are
  peak-sourced (mean recorded intensity), against the same documented band;
- **target sizing** — the delivered promo/showreel lengths and highlight
  count meet the targets above, so a thin pool fails loudly instead of
  shipping a 5 s showreel.

The per-cut intensities and features are printed in the report, and the
summary line names the measured duration, resolution, audio, cut count, mean
intensity, pace verdict and target verdict — so a package can be reviewed
without opening the manifests.

### Practical notes

- **Capture peaks, not just footage.** Only runs whose series contains §7.5
  peaks contribute cuts; a full demo run is **minutes** of wall clock and
  yields a handful of peak windows, so a 2-minute showreel needs a pool of
  many runs. `npm run list:pool` shows which runs carry peaks before a long
  compile.
- **Wall clock.** Encoding is the slow step (VP9 at 60 fps): a 13-cut promo
  plus a 34-cut showreel and 5 clips takes roughly **10 minutes** on the
  reference host.
- **Deliverables are gitignored.** `capture-output/` never enters the
  repository; only the scripts, tests and documentation are committed.
  Keep the produced files wherever you want to publish them.

## Dev scenarios (`--scenario`)

A real run reaches the Central AI boss only after all five levels, and the
boss then needs **200 hits** (4 phases × 50) to destroy — so neither the
recorder nor a human reviewer can practically observe the victory celebration
(AH-0MUWZ5HCV0034H44 producer-audit follow-up). A **dev scenario** is an
additive, dev-only shortcut that drops the run straight into a short,
deterministic encounter:

```bash
# dev builds only: Play Game loads /?scenario=boss-four-hits, jumps to the
# boss with 4 hits remaining and freezes the run until the recorder releases it
npm run capture -- --scenario boss-four-hits

# dev builds only: /?scenario=defeat clears the wave and ends the run in
# defeat on release, so the defeat end-of-run signal + tail can be verified
npm run capture -- --scenario defeat
```

The scenario is selected by the `scenario` URL query parameter, parsed by the
pure `src/core/devScenario.ts` resolver. The capture only appends the query to
the game URL it loads (`captureUrl`) — it never reaches into Phaser internals.
Supported values:

| `scenario` | Effect |
|---|---|
| `boss-four-hits` | Jump to the boss with **4** hits remaining (the recorded demo). |
| `boss` | The same jump, with the hits tunable via `&bossHits=N` (e.g. `?scenario=boss&bossHits=12`). |
| `defeat` | Clear the wave and end the run in **defeat** on release (the defeat-path demo for full-run capture verification). |

### Listing the implemented scenarios

`--list-scenarios` prints every implemented scenario — the `--scenario` value
plus its one-line effect — straight from the **shared registry**
(`scripts/capture-scenarios.mjs`, the same single source the game resolver
reads), so the CLI list can never drift from what the game accepts. The
listing path is **pure**: it exits **0** and boots neither Vite nor Chromium,
making it the cheap way to discover scenarios before a capture run
(AH-0MV6JGELV001FAX1).

```bash
# human-readable, one line per scenario (value — effect)
npm run capture -- --list-scenarios

# machine-readable array [ { "name": ..., "effect": ... } ]
npm run capture -- --list-scenarios --json
```

When `--list-scenarios` is passed, every other flag is ignored: all other
options describe a capture run, and the listing returns instead without
starting one.

The boss scenario clears the opening wave, spawns the boss in its final phase
with no minions and its attacks disabled, and places the ship to the boss's
left facing it, so the auto-fire lands without input. The defeat scenario
clears the opening wave and drains the ship's remaining lives through the
normal fatal-loss path once released. Both are then **frozen** so recording
starts before the deliberately short run ends; once the recorder is live the
capture releases it through the page-side scenario handle
(`window.__aiHellScenario.resume()`), so no keystroke is simulated and the
release is deterministic.

Everything is gated behind `import.meta.env.DEV`: a production build ignores
the query parameter (`resolveDevScenario` is never consulted), so the shipped
bundle and normal runs are unchanged.

## Full-run capture (default)

`npm run capture` records a **complete run**, not a fixed clip
(AH-0MUX2K8U7000GFNU). From the demo's start (Play Game / Watch Demo) through
_every level the run spans_ to the first game over, the recorder keeps
running, then continues for a **`--tail`** (default **5000 ms**) after the run
ends so the victory/defeat screen is visible, and stops.

### End-of-run signal

Because the run length varies (unseeded wave/spawn RNG), capture cannot assume
a duration — it detects the end from a small, additive, **dev-gated**
page-side signal emitted by `PlayScene._finishRun`
(AH-0MUXZ4BXK001QCEK, `src/core/runEndedSignal.ts`):

- a `CustomEvent` on `window` named **`aihell:run-ended`** whose `detail` is
  `{ won, score }`; and
- **`window.__aiHellRunState = { ended: true, won, score }`** as a race
  fallback.

Both fire for **victory and defeat**. The capture installs its listener with
`page.addInitScript` before the game boots (so a short run cannot end before
it is listening) and also polls the `window.__aiHellRunState` flag, so an
early end is still detected. The payload shape is owned by the pure
`buildRunEndedDetail` / `decodeRunEndedDetail` helpers in
`scripts/capture-run-lifecycle.mjs`, shared by the game emitter and the
capture decoder. The signal is gated by `import.meta.env.DEV`, so the shipped
bundle stays inert (`npm run check-bundle` still passes).

### Tail, cap and exit code

- **`--tail <ms>`** — how long to keep recording after the signal (default
  `5000`). Recording stops one tail after the signal, clamped to the cap.
- **`--max-duration <ms>`** — safety cap (default `1800000` = 30 min). If a
  run never signals, the recorder stops at the cap and the command **reports
  it and exits non-zero** — a capped clip is never presented as a complete
  run. The `--json` payload carries `fullRun`, `complete`, `capHit`,
  `runOutcome` (`{ won, score }` or `null`) and `runLengthMs`.
- **Backwards compatibility:** `--duration` and `--scripted` keep the legacy
  fixed-length behaviour; only the default demo path is a full run.

The stop/cap decision is the pure `evaluateRunStop` / `waitForRunEnd` pair in
`scripts/capture-run-lifecycle.mjs`, unit-tested with a fake clock and a
stubbed signal source.

### Bot-tuning configuration (`--bot-config`)

The recorded demo flies whatever bot-tuning configuration the recording page
sees. The Bot Tuning gym persists that configuration to `localStorage`
(`ai-hell-bot-tuning`), and `PlayScene` demo mode reads it when the demo
starts (AH-0MV6MFDYG001E6PL). The capture tool launches a **fresh** browser
with an empty profile, so it cannot see a designer's saved configuration by
itself — pass the gym's **Export** output to seed it:

```bash
# In the Bot Tuning gym: tune, tweak, then click Export → bot-tuning.json
npm run capture -- --bot-config bot-tuning.json
```

`--bot-config <file>` installs a page-side `addInitScript` (the same pre-boot
pattern as the run-end listener) that writes the exported store state into
`localStorage` before the game boots, so the demo reads it and flies the saved
tuning. The file is the exact JSON the gym's Export button produces
(`{ version, current, configs }`). A missing, unreadable, or malformed file
fails fast with an actionable message **before** the server or browser
launches.

**Without `--bot-config` the fresh browser flies the bundled baseline**, not
factory defaults: the Git-tracked `src/data/bot-tuning.json` ships with every
build (via `src/core/bundledConfig.ts`) and the store seeds from it when
`localStorage` is empty (AH-0MV9GZD2C005IIU3). So a plain
`npm run capture` in a fresh Chromium records the tuned demo — exactly what a
distributed build (e.g. GitHub Pages) shows. Passing `--bot-config` still
overrides the baseline for a specific clip. Precedence everywhere is
`localStorage` → bundled baseline.

The pure `installBotTuningConfig` / `loadBotTuningConfigFile` helpers live in
`scripts/capture-gameplay.mjs` and are unit-tested in
`scripts/capture-gameplay.test.ts` (no browser needed).

#### Which bot values ship (and verifying they are used)

The bundled `src/data/bot-tuning.json` is the **single source of the shipped
baseline**, so the *values it contains* are exactly what a fresh browser or a
distributed build (e.g. the GitHub Pages alpha) flies. The refresh workflow is
**tune in the gym → Export → overwrite `src/data/bot-tuning.json` → commit**
(see [BOT_FRAMEWORK.md §12](../BOT_FRAMEWORK.md#12-tuning-the-bot-live-the-bot-tuning-gym)).
The file is byte-equivalent to the gym's Export output, so it is safe to
overwrite it wholesale with an Export download.

Because the committed file originally equalled the built-in factory `Default`,
an un-wired build looked identical to a wired one — a test that compares the
demo against the committed file cannot, by itself, prove the file was used. Two
guards close that hole:

- `src/core/botTuningStore.test.ts` (`AC1 — a DISTINCTIVE bundled baseline is
  served verbatim`) mocks the bundle with non-default values and asserts the
  store returns *those* values — not the built-in fallback.
- `src/scenes/demoBaselineDiscriminating.test.ts` boots the shipped demo against
  a non-default mocked bundle and asserts the live governor receives it, so the
  whole bundle → store → `PlayScene` chain is exercised, not just the store.

A build only picks up a changed baseline when it is **built**; the GitHub Pages
alpha is cut from release tags (`.github/workflows/deploy-pages.yml`), so a
baseline committed to `dev` reaches the alpha at the next `dev` → `main`
release, not before.

### Demo game-over dwell

For the captured tail to show the outcome, the demo/attract mode holds on the
game-over screen before returning to the menu (AH-0MUXZ4CAE008QRFZ). On game
over the demo starts the shared `GameOverScene` with `{ demo: true }`, which
renders VICTORY/DEFEAT + the final score without leaderboard qualification or
initials and auto-returns to the menu after **`DEMO_GAME_OVER_DWELL_MS`**
(single-source, **>= the capture tail**). Normal (non-demo) play is unchanged,
and a demo run is **non-scoring**. The dwell is resolved by the pure
`resolveDemoGameOverDwellMs` / `shouldDemoReturnToMenu` helpers.

### Cost of long runs

A full victory run is far longer than the original 15 s spike clip: it spans
every level and the boss, so expect **minutes** of wall clock, a
correspondingly larger WebM file, and a non-deterministic length (the game is
not yet fully deterministic). A **defeat** run is typically much shorter. The
`--max-duration` cap and the heartbeat bound and surface the cost; there is
no frame-exact reproducibility yet (see
[Determinism gaps](#determinism-gaps)).

## Batch capture (`--count` / `-n`)

`--count <n>` (alias `-n`) records **`n` clips in a single process**
(AH-0MUYTK941005E2M4). The Vite dev server and the headless Chromium browser
are booted **once** and reused for every iteration; each iteration gets a
**fresh page** (the audio tap and run-end listener are re-installed), so there
is no per-clip boot cost and no game state leaks between clips.

```bash
# record 3 clips in one process (one server + one browser)
npm run capture -- --count 3
npm run capture -- -n 3

# every existing flag applies to each iteration
npm run capture -- --count 5 --scripted --duration 20000
```

### Output naming

`--count` makes the output paths deterministic:

| Invocation | Output files |
|---|---|
| *(no `--count`)* | `capture-output/gameplay-<ISO-timestamp>.webm` (unchanged) |
| `--count 1` | same as above |
| `--count 3` | `capture-output/gameplay-<ISO-timestamp>-1.webm`, `…-2.webm`, `…-3.webm` |
| `--count 3 --output clips/demo.webm` | `clips/demo-1.webm`, `clips/demo-2.webm`, `clips/demo-3.webm` |

- With `--count > 1` and no `--output`, every clip appends a **1-based
  iteration index** to one batch timestamp, so a tight loop can never collide
  on the same millisecond.
- With `--output <file>`, the index is inserted **before the extension**
  (`demo.webm` -> `demo-1.webm`); a path with no extension gains a `-<n>`
  suffix (`demo` -> `demo-1`).
- `--count 1` (and omitting `--count`) is byte-for-byte the historical
  single-clip path — no index suffix — so existing invocations are unchanged.

Naming is resolved by the pure `resolveOutputPaths` helper and covered by unit
tests in `scripts/capture-gameplay.test.ts`.

### Validation

`--count` accepts a **positive integer** only. A non-positive or non-numeric
value (`0`, `-2`, `abc`, `1.5`) fails fast with a clear message and a
**non-zero exit code**, before any capture starts:

```
Invalid --count value: "0" (expected a positive integer)
```

### Continue-on-failure and exit codes

A failure in one iteration does **not** abort the batch: the remaining
iterations still run so partial results are captured. The summary names every
failing iteration and the process exits **non-zero**:

- a batch where **all clips are ok** exits `0`;
- **any failed iteration** (it threw, produced a trivial clip, or a full run
  hit the `--max-duration` cap without a signal) exits `1`, and the batch
  report lists each `FAIL` iteration with its reason.

The batch report and the `--json` aggregate both carry a per-iteration
`ok`/`error` status, so automation can attribute a failure to an iteration.

### `--json` shape

`--json` is unchanged for a single clip (no regression). A `--count > 1` run
emits an aggregate object:

```json
{
  "count": 3,
  "succeeded": 2,
  "failed": 1,
  "iterations": [
    { "index": 1, "output": "…/gameplay-…-1.webm", "ok": true, "exitCode": 0, "nonTrivial": true },
    { "index": 2, "output": "…/gameplay-…-2.webm", "ok": false, "error": "no supported WebM MediaRecorder codec" },
    { "index": 3, "output": "…/gameplay-…-3.webm", "ok": true, "exitCode": 0, "nonTrivial": true }
  ]
}
```

Each `iterations[]` entry carries the 1-based `index`, the absolute `output`
path and an `ok` flag; a failed iteration adds `error` and omits the clip
fields. `succeeded`/`failed` tally the batch.

## Batch scenarios (`--all-scenarios`)

`--all-scenarios` records **one video per registered dev scenario** in a
single process (AH-0MV6JGQFK007MXGX). It reuses the exact batch machinery
above — one Vite dev server and one headless Chromium browser booted once,
a fresh page per item, per-item failure isolation, an aggregate summary and a
non-zero exit code. Per the producer decision, the default no-scenario demo
run is deliberately **not** included: only the shared registry
(`scripts/capture-scenarios.mjs`) is expanded, so the set cannot drift from
what `--list-scenarios` shows.

```bash
# one video per registered scenario (boss, boss-four-hits, defeat) in one process
npm run capture -- --all-scenarios

# write into a directory: <dir>/<scenario>.webm
npm run capture -- --all-scenarios --output clips

# N videos of EVERY scenario in one process (N x all)
npm run capture -- --count 3 --all-scenarios
```

### Combining with `--count` (N x all)

`--count n` combines with `--all-scenarios` to record **n clips of every
registered scenario** in a single process (producer decision Q3=b,
AH-0MV6JGQSA0054CYY): `--count 3 --all-scenarios` yields `3 x all` clips —
one batch of N-video-per-scenario evidence. The standalone `--count n`
behaviour (with or without `--scenario`) is unchanged.

Ordering across the combined batch is **scenario-major**: all `n` repeats of
the first registered scenario, then all `n` of the second, and so on — the
per-scenario iteration index resets at each scenario (`boss-1, boss-2, …,
boss-four-hits-1, …`). The plan positions (`#1 … #(n × scenarios)`) run
across the whole batch, and every iteration is attributable by scenario and
iteration in the batch report and `--json` aggregate.

### Output naming

`--output` is treated as a **directory** for a batch (producer decision Q2):

| Invocation | Output files |
|---|---|
| `--all-scenarios` | `capture-output/<scenario>-<ISO-timestamp>.webm` (one timestamp per batch) |
| `--all-scenarios --output clips` | `clips/<scenario>.webm` |
| `--count 3 --all-scenarios` | `capture-output/<scenario>-<ISO-timestamp>-1.webm`, `…-2.webm`, `…-3.webm` (per scenario) |
| `--count 3 --all-scenarios --output clips` | `clips/<scenario>-1.webm`, `clips/<scenario>-2.webm`, `clips/<scenario>-3.webm` (per scenario) |

With `--count > 1` every name carries a **per-scenario 1-based iteration
suffix**, so `n` repeats of one scenario can never collide; `--count 1` (and
omitting `--count`) is byte-for-byte the plain `--all-scenarios` naming.
Names are **deterministic and collision-free** within a batch, and an existing
file is **never silently overwritten**: if a target name is already in use —
by an earlier item in the plan or on disk — a `-<n>` suffix is inserted
before the extension (`boss.webm` → `boss-2.webm`), resolved by the pure
`uniquifyOutputPath` helper. The batch report and `--json` aggregate name the
scenario per item (`#1 [boss] ok …`), so results are attributable without
parsing paths.

### Validation and exit codes

- `--all-scenarios` takes no value and cannot be combined with `--scenario`
  (it already selects every scenario).
- `--count` keeps its positive-integer-only validation (`0`, missing or
  non-numeric values fail fast) whether or not `--all-scenarios` is present.
- The aggregate summary prints every item and the process exits **non-zero**
  if any scenario failed or hit the `--max-duration` cap; a single-scenario
  failure does not abort the remaining scenarios (AC6).

## Progress output & dependency preflight

A capture spends ~20 s producing no output (Vite + browser startup, warm-up,
recording, decode), which is easy to mistake for a hang. The command therefore
writes **milestone lines and a recording heartbeat to stderr** while reserving
stdout for the final report / `--json` payload
(AH-0MUWTNPY8003GGAA):

```
[capture] Starting Vite dev server…
[capture] Launching headless Chromium…
[capture] Loading http://127.0.0.1:46321/…
[capture] Starting in-game demo (Watch Demo)…
[capture] Recording the full run (tail 5.0s, cap 1800.0s)…
Recording [------------------------]   0%  2.0s/1800.0s  ETA 1798.0s
Recording [#-----------------------]   4%  65.0s/1800.0s  ETA 1735.0s
[capture] Encoding and probing the clip…
```

The full-run heartbeat reports **elapsed against the `--max-duration` cap**,
not against an assumed run length (the run length is not known in advance).

On a TTY the heartbeat overwrites itself in place; when redirected (logs, CI)
each heartbeat is a separate line. `--json` suppresses the human report and
prints only the JSON payload on stdout.

If the `playwright` devDependency or its Chromium binary is missing, the
command fails fast with the fix instead of a raw module-resolution stack:

```
playwright is required for automated gameplay capture but is not available.
Run: npm install && npm run capture:install
```

## The automated player (the bot)

**Default: the shipped in-game demo.** Since AH-0MUX496IJ0041O3V the capture
records the game's own **attract/demo mode** — the survival-first bot in
`src/ai/` plays a real run (seeking power-ups/minerals, dodging fire) with no
external input. The capture only starts the demo (Tab → Enter on **Watch
Demo**) and records it. `resolveCaptureMode` / `captureStartKeys` in
`scripts/capture-gameplay.mjs` select this path (default) versus the scripted
fallback. This is the higher-quality clip and exercises the same code that
ships.

**Fallback: the scripted sweep plan.** `scripts/capture-bot.mjs` owns the
legacy player, retained behind `--scripted`. It deliberately does **not**
reach into Phaser internals — it is a fixed, wall-clock-relative key plan:

- The ship **auto-fires**, so steering is the whole job.
- `BASE_SWEEP_PATTERN` is a deterministic left↔right sweep with small
  vertical bobs; `buildScriptedPlan(durationMs)` repeats it (truncating the
  final step) until the requested clip length is covered.
- Each step becomes a real `ArrowLeft` / `ArrowRight` / `ArrowUp` /
  `ArrowDown` hold via Playwright.

It drives **`PlayScene`, level 1, wave 1** (6 Scouts in a `v` formation)
straight from **Play Game** — nothing else needs to be navigated. This is the
`--scripted` fallback path; the default demo mode instead runs the shipped
`src/ai/` bot through the `Watch Demo` control.

The plan builder and the clip-verification predicate are pure functions,
unit-tested in `scripts/capture-gameplay.test.ts` (no browser
required). The browser/encode path itself is **not** unit-tested: the vitest
suite stubs the canvas (`src/test/setup.ts`), so there is nothing real to
record — it is exercised by `npm run capture` instead.

## Output & how "non-trivial" is verified

Output is a standard WebM file in `capture-output/` (git-ignored) by default.
`npm run capture` prints a report and exits **non-zero** if the clip is
trivial, so it can gate a future job:

```
AI_Hell automated gameplay capture
=================================
Output:     …/capture-output/gameplay-….webm
Size:       3561.3 KiB
Resolution: 960x540 @ 12799 ms
Renderer:   WebKit WebGL
Non-black:  1.29% of pixels
Colours:    564 distinct (16-level buckets)
Motion:     0.0033 mean frame delta
Audio:      1 track(s), peak 0.4447, rms 0.0775
Non-trivial: yes
```

The probe (`isNonTrivialClip`) rejects an **empty** recording, a clip with **no
decodable frames**, an essentially **black** frame, a frame with **too few
colours**, and **static** frames. AI_Hell is intentionally dark (neon sprites
on black), so the thresholds are deliberately loose — "actual gameplay/VFX,
not black or static" — rather than requiring a bright image.

The clip verdict is now the **combination** of the video probe and the audio
probe (see [Audio capture](#audio-capture)): a clip with no audio track, or
with decoded audio at/below the silence floor, fails and the command exits
non-zero — so `npm run capture` can no longer silently emit a silent clip.

For a `--count` **batch**, the report lists one line per iteration and the
command exits non-zero if any iteration failed; the naming, validation,
continue-on-failure and `--json` rules are documented in the **Batch capture**
section above.

## Rejected alternatives

### B. CDP screencast / per-frame capture

Playwright's built-in `recordVideo` (CDP `Page.startScreencast`, muxed by
Playwright's bundled ffmpeg) or `canvas.toDataURL()` per frame piped to
ffmpeg.

**Rejected because:** the screencast captures the **browser viewport**, not
the canvas, at a browser-driven cadence, so it can drop/duplicate frames under
load and may include letterboxing; and its encode path depends on Playwright's
**minimal ffmpeg build**, which (verified) ships only `libvpx` **VP8** and no
VP9/H.264 decoder — a dead end for any in-house transcoding, frame extraction
or inspection. Approach A instead yields a WebM blob we fully control and can
decode/probe in-page.

### C. In-engine snapshot loop

A dev-only mode calling `Phaser game.renderer.snapshot()` on a fixed tick,
writing frames and encoding externally.

**Rejected because:** snapshotting is synchronous and stalls the game loop;
it needs in-engine dev hooks (touching `src/`, against the spike's "opt-in,
no shipped-bundle impact" constraint); it captures only what the renderer
draws (no live composited canvas / any overlay); and audio would still need a
separate path. Strictly more code than A for no gain here.

### D. Deterministic replay

Drive `src/test/gameHarness.ts` with a recorded/seeded input sequence, render
headless and encode.

**Rejected for this spike because:** the game is **not deterministic yet** —
wave/spawn timing still draws from wall-clock and `Math.random()` (see below)
and there is no input-recording/replay format. Best long-term
reproducibility, but it would require seeding all RNG *and* building a replay
format — both explicitly out of scope. Revisit once determinism lands.

## Known limits

### Headless WebGL reliability

`Phaser.AUTO` resolves to **WebGL** in headless Chromium via the software
(SwiftShader) backend, and it renders correctly — but it is CPU-rendered, so
it is slower than a GPU and emits a deprecation warning unless
`--enable-unsafe-swiftshader` is passed (the script passes it). If a future
browser/config loses WebGL, force the renderer explicitly
(`type: Phaser.CANVAS`) or fall back to approach C. Treat headless WebGL as
"works, but verify after Playwright/Chromium upgrades".

### Audio capture

The captured clip carries the game's **own SFX**, synchronised with the
recorded gameplay — no separately generated bed and no external mux
(AH-0MUWTNPYJ0031FQE).

**How the tap works (approach A1 — page-side, no `src/` change).** The game
owns exactly one `AudioContext`: `installGameAudio` pins it to Phaser's sound
manager at boot and every SFX routes through a single master `GainNode`
connected to `context.destination` (`src/audio/sfxPlayback.ts`,
`src/audio/effects.ts`). Before the page's first script runs, the capture
installs a wrapper via Playwright's `page.addInitScript` that intercepts
`AudioNode.prototype.connect`: whenever a node is connected to
`context.destination`, the same source is **also** connected to a
`MediaStreamAudioDestinationNode` created lazily on that same context. The
recorder stream is then the canvas video tracks plus the capture
destination's audio tracks:

```js
new MediaStream([
  ...canvas.captureStream(60).getVideoTracks(),
  ...captureDest.stream.getAudioTracks(),
]);
```

Only connections to `context.destination` are mirrored, so the tap cannot
feed back into itself, and a node that bridges several inputs is still
tapped once per context. The wrapper mirrors the original `connect` return
value and never throws — a tap failure must not break the game's own audio.

Because the tap is injected page-side, `src/` and the shipped Vite bundle are
untouched (`npm run check-bundle` still passes). The recorder mime is chosen
by `resolveCaptureMimeType`: **`video/webm;codecs=vp9,opus`**, then
`video/webm;codecs=vp8,opus`, then plain `video/webm`; when no game audio is
available it falls back to the matching video-only list so the container
never advertises an Opus track it will not contain.

**Why it works under the browser autoplay policy.** Browsers block an
`AudioContext` from starting until a user gesture. The capture's Enter
keypress (which activates **Play Game**) is a real, trusted gesture, and
`MenuScene`'s handler calls `resumeAudioContext(this.sound)` — the same path
a human player uses. The capture waits (bounded, 3 s) for the shared context
to report `running` before recording; if audio never becomes available it
records video-only and reports the track as absent rather than failing.

**No system audio device needed.** Headless Chromium is CPU-rendered and has
no sound card, but `MediaStreamAudioDestinationNode` renders the Web Audio
graph into the media stream regardless of any hardware output device, so the
tap works in CI exactly as it does locally.

**How audio is verified (no auditioning).** After the recorder stops, the
in-page probe decodes the produced WebM/Opus blob with
`AudioContext.decodeAudioData`, samples every channel and reports
`audioTrackCount`, `audioPeak` and `audioRms`. The pure `evaluateAudioTrack`
helper turns those into a verdict against documented floors
(`AUDIO_SILENCE_PEAK_FLOOR = 0.005`, `AUDIO_SILENCE_RMS_FLOOR = 0.0005`);
AI_Hell's early levels are sparse, so a low but non-zero **peak** is the
primary gate. `combineClipVerdict` then requires **both** the video and the
audio verdict to pass, and the report and `--json` payload expose the result.
If decoding is unsupported or the blob cannot be decoded, the failure is
reported explicitly (`audioDecodeError` / an `Audio:` report note) and the
clip fails rather than silently passing. A clip with no audio track, or with
decoded audio at/below the floor, exits non-zero.

### Determinism gaps

Only the VFX RNG is seeded (`src/vfx/explosionParticles.ts`,
`src/vfx/playerDeathJuice.ts`). Wave/spawn/timing randomness still uses
wall-clock and `Math.random()`, so **two captures of the same scripted input
are not frame-identical**. Identified unseeded sources:
`src/waves/WaveManager.ts`, `src/entities/Swarm.ts`, `src/entities/Boss.ts`,
`src/entities/Scout.ts`, `src/entities/Mineral.ts` and
`src/entities/Asteroid.ts`. The clip is still valuable (the bot input is
identical run to run); full reproducibility needs the seeding work tracked
separately.

### No MP4 output (ffmpeg)

Capture writes **WebM only**. Playwright's bundled ffmpeg is a minimal build
(VP8 only, no VP9/H.264 encoder), so it cannot transcode VP9 or extract
frames, and the capture path never invokes a system ffmpeg. The **audio tap**
deliberately needs no full `ffmpeg`: the game's Opus track is muxed in-browser
by `MediaRecorder`.

A full `ffmpeg` is required only by the **promo compiler**
(`npm run compile:promo`, see
[Compiling a promo package](#compiling-a-promo-package-npm-run-compilepromo)),
which is a post-processing step over already-captured WebMs — it never
changes the capture path. If an MP4 is ever needed, transcode the compiled
WebM the same way (`ffmpeg -i promo.webm -c:v libx264 promo.mp4`).

### Rejected fallback: offline WAV + external mux

The alternative — reuse the offline WAV pipeline (`npm run build-audio`,
`scripts/build-audio.mjs`) and mux the WAV with the captured WebM using a full
`ffmpeg` — is **not** used. It is a separately generated bed, not the game's
own SFX, so it cannot be synchronised with in-game events (against
AH-0MUWTNPYJ0031FQE AC1), and it needs a full `ffmpeg` install that the
Playwright bundle does not provide. The shipped path requires **no full
`ffmpeg`**; retain this only as a documented fallback if the in-page Web
Audio tap ever proves impossible.

### Estimated CI cost

Measured on the reference host (2026-10-06):

- **Browser download (one-time):** `playwright install chromium` fetches
  **~174 MiB** (full Chromium) **+ ~104 MiB** (headless shell) ≈ **278 MiB**;
  ~**915 MiB** on disk for both. `playwright install --only-shell chromium`
  avoids the full build where only headless capture is needed.
- **Encode/wall time:** a 12 s **video + Opus audio** clip completes in
  **~19 s** wall clock (≈ 1.6× realtime), peak RSS ≈ **660 MB**; the
  video-only spike measured ~18 s / ~500 MB, so the audio tap and Opus encode
  are close to run-to-run variation on this host. The Opus track adds only
  ~0.1–0.2 MiB to the file (reference 12 s clip: **2.35 MiB**).
- **No audio device:** the tap renders `MediaStreamAudioDestinationNode`
  without any system sound card, so headless CI needs no audio hardware.
- **Node dependency:** the `playwright` npm package (~a few MB; browsers are
  a separate download).

Recommendation: run capture as an **opt-in local/CI job**, never as part of
the audit-accepted test suite (`npm --silent test`, i.e. `/skill:test --type
full`) or `npm run build`.

### Additive / opt-in guarantee

- The capture code lives entirely under `scripts/` and is **never imported by
  `src/`**, so it cannot enter the shipped Vite bundle.
- `playwright` is a **devDependency**; browser binaries are downloaded by an
  explicit command.
- `capture-output/` is git-ignored.
- `npm --silent test` (the `unit` + `integration` full suite) and
  `npm run build` are unchanged and still pass.

## Files

| File | Purpose |
|---|---|
| `scripts/capture-gameplay.mjs` | Orchestrator: Vite server, headless Chromium, record, drive bot, probe, write WebM; progress + preflight |
| `scripts/capture-bot.mjs` | Deterministic bot plan + `isNonTrivialClip` / `evaluateAudioTrack` / `combineClipVerdict` predicates + the page-side `AudioNode.connect` tap (pure, testable) |
| `scripts/capture-bot.d.mts` | Types for the plain-JS bot module |
| `scripts/capture-gameplay.d.mts` | Types for the capture orchestrator's pure arg/mode helpers |
| `scripts/capture-progress.mjs` | Pure duration / ETA / progress-bar + audio-summary formatting + setup hint |
| `scripts/capture-progress.d.mts` | Types for the progress module |
| `scripts/capture-run-lifecycle.mjs` | Pure run-lifecycle contracts: signal encode/decode, tail/cap arithmetic, the `waitForRunEnd` loop, run summary and demo dwell |
| `scripts/capture-run-lifecycle.d.mts` | Types for the run-lifecycle module |
| `scripts/capture-series.mjs` | Pure §7.2 series serialiser + §7.5 join-anchor builder + telemetry extraction (shared with the action-intensity export) |
| `scripts/capture-series.d.mts` | Types for the series/anchor module |
| `scripts/compile-promo.mjs` | Promo compiler + ffmpeg driver: edit plan from the recorded series, cut cadence, deliverable sizing, manifests, output validation and pace verification |
| `scripts/compile-promo.d.mts` | Types for the promo compiler |
| `scripts/compile-promo.test.ts` | Hermetic tests for the plan/selection/cadence/validation logic (no ffmpeg, no browser) |
| `scripts/compile-promo.e2e.test.ts` | Gated end-to-end smoke test that compiles synthetic footage with real `ffmpeg`/`ffprobe` (skipped when absent) |
| `scripts/list-capture-pool.mjs` | Capture-pool inventory: retains WebM + series + anchor triples, reports excluded runs and per-run feature evidence |
| `scripts/list-capture-pool.d.mts` | Types for the pool inventory lister |
| `scripts/list-capture-pool.test.ts` | Hermetic tests for the inventory builder, collector and CLI |
| `scripts/capture-gameplay.test.ts` | Hermetic unit tests for the plan builder, probe/audio-verdict predicates, audio tap and progress helpers |
| `src/core/devScenario.ts` | Dev-gated scenario resolver + page-side release handle consumed by `--scenario` (pure, testable; no-op in production) |
| `package.json` | `capture` / `capture:install` / `list:pool` / `compile:promo` scripts; `playwright` devDependency |
| `.gitignore` | ignores `capture-output/` |
