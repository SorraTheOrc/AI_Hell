# Dev recording, analysis and replay/ghost tooling

> Landed in AH-0MUY08W7Y004GATZ (child 4 of epic AH-0MUY089KR003F8S4). The
> recording path is the telemetry framework
> ([docs/TELEMETRY.md](../TELEMETRY.md)); this document covers the **dev tools**
> built on top of it: `record`, `analyse` and `replay`.

The data loop for tuning and evaluating the bot:

```
play (human or bot)  →  JSONL recording  →  offline analysis  →  replay / ghost overlay
      npm run record        recordings/…        npm run analyse          npm run replay
```

Recording goes through the **existing telemetry framework** — no separate
recording path. A recording is the framework's `run_header` + per-tick
`state`/`input` + discrete `event` records, each tagged with `schemaVersion`.

## 1. Record a session (`npm run record`)

`scripts/record-session.mjs` starts the Vite dev server with
`VITE_TELEMETRY_ENABLED=true VITE_TELEMETRY_SINK=jsonl`, opens the game in a
real (by default **headed**) browser so a human can play, then reads the local
dev sink's `localStorage` JSONL and writes it to `recordings/`.

```bash
# Human plays; press Ctrl+C in the terminal to finish and save.
npm run record

# Deterministic seed, so a bot run can be compared on the same seed.
npm run record -- --seed 12345

# Record the in-game demo bot instead of a human (ghost target).
npm run record -- --bot --seed 12345

# Non-interactive: stop automatically at run end (human death, or bot).
npm run record -- --auto --output recordings/human.jsonl
```

| Flag | Meaning | Default |
|---|---|---|
| `--output FILE` | Output `.jsonl` path | `recordings/session-<seed-><timestamp>.jsonl` |
| `--seed N` | Force a deterministic run seed (dev builds; `?seed=N`) | random per run |
| `--bot` | Record the in-game demo bot (Watch Demo) instead of a human | human |
| `--headless` | Run headless (the default is headed, for human play) | headed |
| `--auto` | Stop as soon as the run ends (no Ctrl+C needed) | wait for Ctrl+C |
| `--max-duration MS` | Safety cap on recording length | 30 min |
| `--poll MS` | Run-end poll interval | 250 ms |
| `--json` | Print the summary as JSON | text |

On Ctrl+C the tool still exports whatever the sink has already flushed (the
recorder flushes every `batchSize` records and on scene shutdown), so an
interrupted run yields a partial but valid recording.

> **Prerequisites:** `npm install` then `npm run capture:install` (Playwright
> Chromium), the same as the capture tooling.

### Recording a same-seed human-vs-bot ghost

```bash
npm run record -- --seed 12345 --output recordings/human.jsonl   # play, Ctrl+C
npm run record -- --bot --seed 12345 --output recordings/bot.jsonl
npm run replay  -- recordings/human.jsonl --bot-file recordings/bot.jsonl --svg ghost.svg
```

## 2. Dataset format and versioning (AC4)

A recording is newline-delimited JSON. Each line is one schema-versioned
telemetry record (see the [schema reference](../TELEMETRY.md#schema-reference-version-1)):

```jsonl
{"kind":"run_header","schemaVersion":1,"runSeed":12345,"build":{...},"startedAt":...}
{"kind":"tick","schemaVersion":1,"tick":0,"state":{...},"input":{...}}
{"kind":"event","schemaVersion":1,"tick":42,"event":"enemy_killed","payload":{...}}
```

Two version numbers matter to the tools:

| Version | Where | Meaning |
|---|---|---|
| `schemaVersion` | every record | Envelope format; the tools interpret `1` (`SUPPORTED_TELEMETRY_SCHEMA_VERSIONS`) |
| `RECORDING_DATASET_VERSION` | `scripts/recording.mjs` | The tooling's **interpretation** (which record kinds it groups into runs). Bump on a re-interpretation, not a payload change |
| `v` (state / event) | inside `state` / `event.payload` | Concrete payload shape (`RUN_TELEMETRY_STATE_VERSION` / `RUN_TELEMETRY_EVENT_VERSION` in `src/scenes/core/runTelemetry.ts`) |

Parsing is tolerant: blank, corrupt and unsupported lines are skipped and
counted (`skippedLines`, `unsupportedLines`) rather than aborting, so a file
written by a newer engine can still be inspected. A new `run_header` starts a
new run; ticks/events are attributed to the most recent header.

## 3. Analyse a recording (`npm run analyse`)

`scripts/analyse-recording.mjs` prints an offline report over one run. The
statistics are pure and browser-free (`scripts/recording-analysis.mjs`).

```bash
npm run analyse -- recordings/human.jsonl
npm run analyse -- recordings/human.jsonl --json          # machine-readable
npm run analyse -- recordings/human.jsonl --seed 12345    # pick a run by seed
npm run analyse -- recordings/human.jsonl --output report.txt
```

Metrics (AC2):

| Metric | Meaning |
|---|---|
| **Key-hold duration histogram** | Per channel (`fourDirectional:right`, `asteroids:forward`, …) and overall: distribution of contiguous hold durations |
| **Input-change cadence** | Number of input changes, changes/second, mean/median interval and a gap histogram |
| **Reaction latency proxy** | Time from an incoming threat (an enemy bullet entering 140 px) to the player's next input change |
| **Target-choice stats** | How often the player's velocity is most aligned with a mineral, a power-up or an enemy |
| **Engagement distances** | Distance to the enemy at a kill, to a drop at a pickup, and to a mineral at a collection |
| **Dodge outcomes** | Threat windows rated as dodged vs hit (a hit event occurred during the window) |
| **Survival / minerals per minute** | Run duration, survived/won/score, total minerals, minerals/min |

These are **proxies** derived from sampled state + input + events, not exact
physics measurements; the definitions are documented on the result fields and
intended as directional tuning signals.

## 4. Replay and the ghost overlay (`npm run replay`)

`scripts/replay-recording.mjs` steps a recording deterministically and, when a
second run on the **same seed** is supplied, overlays human vs bot input and
position (AC3).

```bash
npm run replay -- recordings/human.jsonl --list                # list runs
npm run replay -- recordings/human.jsonl --tick 240            # inspect one frame
npm run replay -- recordings/human.jsonl --verbose             # every frame
npm run replay -- recordings/human.jsonl --bot-file recordings/bot.jsonl --svg ghost.svg
npm run replay -- recordings/human.jsonl --bot-seed 12345 --json
```

> A recording file may contain one or more runs. `--seed`/`--run` select the
> human run; `--bot-file` (or `--bot-seed`/`--bot-run` within the same file)
> selects the bot run. When two runs in one file share a seed, the bot
> selection skips the already-selected human run, so `--seed N --bot-seed N`
> compares them rather than collapsing onto one.

The deterministic replay primitive is
[`createRecordingStepper`](../scripts/recording.mjs): it walks the recorded
ticks in order and derives elapsed time from the tick number and an injected
tick duration, so the same recording always steps identically (no wall clock).

The ghost overlay (`buildGhostOverlay`) pairs the human and bot frames by tick
number over the intersection of the two runs and reports, per tick:

- human vs bot **input** (equality + overall match rate);
- human vs bot **position** (delta, mean and max).

`--svg FILE` renders a standalone SVG trajectory plot (human path in cyan, bot
path in magenta) with no browser or game instance, and `--json` dumps the
aligned frames. The overlay **requires the same seed** and throws otherwise —
comparing two different seeded runs is meaningless.

> Full same-seed simulation (driving the shipped bot through the game for
> metrics and side-by-side clips) is the sibling evaluation harness
> (AH-0MUY08XLD009K4W4); this tool is the deterministic data/replay layer it
> builds on.

## 5. Testing

| File | Covers |
|---|---|
| [`scripts/recording.test.ts`](../../scripts/recording.test.ts) | JSONL parsing/grouping, input model, deterministic stepper, ghost overlay, SVG renderer |
| [`scripts/recording-analysis.test.ts`](../../scripts/recording-analysis.test.ts) | Every statistics metric with exact expected values |
| [`src/core/devScenario.test.ts`](../../src/core/devScenario.test.ts) | The dev-gated `?seed=N` override |

Run them with:

```bash
npx vitest run scripts/recording.test.ts scripts/recording-analysis.test.ts src/core/devScenario.test.ts
```
