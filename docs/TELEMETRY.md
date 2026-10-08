# Telemetry framework

> Status: framework landed in AH-0MUY08VJ9006BHJO (epic
> AH-0MUY089KR003F8S4). The game instrumentation — per-tick state + input and
> discrete events — landed in child 3 (AH-0MUY08VVQ007HSSH); production
> opt-in consent, the remote HTTP transport and the privacy/retention policy
> landed in child 10 (AH-0MUY08Y9P005ER7A).

The telemetry framework is a **versioned, consent-gated, pluggable pipeline**
that is a **strict no-op unless explicitly enabled**. It records reproducible
run data — a run header (seed/build), sampled per-tick state + input, and
discrete events — through one or more **sinks**. It is safe by default and
privacy-preserving: records are PII-free by design and are redacted as
defence in depth before they reach any sink.

Source: [`src/telemetry/`](../src/telemetry). Import the public surface from
`src/telemetry` (the barrel `index.ts`).

## Quick start

```ts
import {
  createTelemetryRecorder,
  resolveBuildInfo,
  resolveTelemetryConfig,
} from '../telemetry';

// Disabled unless VITE_TELEMETRY_ENABLED (and, in production, consent) is set.
const config = resolveTelemetryConfig();
const recorder = createTelemetryRecorder(config, { build: resolveBuildInfo() });

recorder.startRun({ runSeed });        // writes the run header
recorder.recordTick(state, input);     // sampled per AC4
recorder.recordEvent('enemy_killed', { archetype: 'scout' });

await recorder.flush();                // drain the buffer to the sink
```

## Enabling and disabling

Telemetry is **off by default**. Enable it with Vite environment variables
(e.g. in `.env.local`, or inline for a dev run):

```bash
# local dev: record JSONL, no consent needed
VITE_TELEMETRY_ENABLED=true npm run dev

# production: explicit opt-in is required before anything is recorded
VITE_TELEMETRY_ENABLED=true VITE_TELEMETRY_CONSENT=true npm run build
```

| Variable | Meaning | Default |
|---|---|---|
| `VITE_TELEMETRY_ENABLED` | `1`/`true`/`yes`/`on` enables telemetry | disabled |
| `VITE_TELEMETRY_CONSENT` | Consent flag; **required for production recording** | disabled |
| `VITE_TELEMETRY_SINK` | `jsonl` (local dev) or `remote` (production) | `jsonl` |
| `VITE_TELEMETRY_ENDPOINT` | Remote ingestion URL (required for the remote sink to upload) | unset |
| `VITE_TELEMETRY_SAMPLE_RATE` | Fraction of ticks to record (`0`–`1`) | `1` |
| `VITE_TELEMETRY_BUFFER_CAPACITY` | Ring-buffer capacity, in records | `512` |
| `VITE_TELEMETRY_BATCH_SIZE` | Buffer size that triggers a flush | `64` |
| `VITE_APP_VERSION` / `VITE_GIT_COMMIT` | Build metadata written to the run header | `0.0.0-dev` / `unknown` |

The consent gate works as follows (see
[`config.ts`](../src/telemetry/config.ts)):

- `enabled = false` → **no-op recorder**, nothing is buffered or written.
- dev build + `enabled` → recording without consent.
- production build + `enabled` → recording **only** when consent is given.

`createTelemetryRecorder()` is the single enforcement point: it returns a
`NoopTelemetryRecorder` unless the effective gate is open.

### Production opt-in consent (AC1/AC3)

In the shipped game the consent decision is the **player's**, not a build
flag. The persisted decision lives in `localStorage` under
`ai_hell_telemetry_consent` (see
[`telemetryConsentStore.ts`](../src/core/telemetryConsentStore.ts)), separate
from the gameplay settings so a settings reset never re-enables telemetry:

- **Default: off and undecided.** Nothing is recorded until the player opts in.
- **In-game prompt.** When the build is production + `remote` + enabled and
  the player has not yet decided, `MenuScene` opens the consent prompt
  (`TelemetryConsentScene`) once. It summarises the privacy policy, defaults
  focus to declining, and ESC also declines.
- **Settings toggle.** The same decision is always reversible in
  `SettingsScene` ("Telemetry: ON/OFF").
- **Their choice wins.** Once decided, `resolveEffectiveTelemetryConfig()`
  recomputes the recording gate from the player's decision, so an opt-out
  disables recording even in a consent-flagged build. `VITE_TELEMETRY_CONSENT`
  only applies while the player is undecided (useful for headless/operator
  runs).

```ts
import {
  resolveEffectiveTelemetryConfig,
  shouldPromptForTelemetryConsent,
} from '../telemetry';
import { loadTelemetryConsent } from '../core/telemetryConsentStore';

const consent = loadTelemetryConsent();
const config = resolveEffectiveTelemetryConfig(import.meta.env, consent);
```

## Schema reference (version 1)

Every record carries `schemaVersion` (currently `1`). Bump it on any
backwards-incompatible shape change; a reader can use
`isTelemetryRecord()` to skip records from an unknown version. Records are
JSON objects, one per line in the JSONL sink.

### `run_header` — written once per run

| Field | Type | Notes |
|---|---|---|
| `kind` | `'run_header'` | discriminator |
| `schemaVersion` | `number` | schema version |
| `runSeed` | `number` | the run's RNG seed (reproducibility) |
| `build.appVersion` | `string` | released version |
| `build.commit` | `string` | source commit, or `'unknown'` |
| `startedAt` | `number` | epoch milliseconds |

### `tick` — sampled per-tick state + input

| Field | Type | Notes |
|---|---|---|
| `kind` | `'tick'` | discriminator |
| `schemaVersion` | `number` | schema version |
| `tick` | `number` | zero-based tick counter (advances even for sampled-out ticks) |
| `state` | JSON | gameplay state; shape owned by the instrumentation layer |
| `input` | JSON | player input; shape owned by the instrumentation layer |

### `event` — discrete gameplay event

| Field | Type | Notes |
|---|---|---|
| `kind` | `'event'` | discriminator |
| `schemaVersion` | `number` | schema version |
| `tick` | `number` | tick the event occurred on |
| `event` | `string` | event name, e.g. `'enemy_killed'` |
| `payload` | JSON | event-specific payload |

`state`, `input` and `payload` are deliberately opaque: the framework defines
the envelope and guarantees the payload is JSON-safe and PII-free, while the
instrumentation layer owns the concrete shape. Payloads are copies — call
sites can never mutate buffered data.

> **Planned `state` field — `actionIntensity`.** The per-tick `state` will
> gain an `actionIntensity` object (raw score, normalised intensity, smoothed
> EMA, burstiness, and a per-category breakdown). It is a payload-only change —
> no framework schema bump — and the metric is a strict no-op when telemetry is
> disabled. The pure computation and its wiring through the instrumentation
> layer (`src/scenes/core/runTelemetry.ts`, AH-0MUY08VVQ007HSSH) are delivered
> by the implementation epic **AH-0MUZMTTYH008KVS2**; the researched model,
> scoring weights, output schema and video-join semantics are specified in
> [docs/dev/action-intensity.md](./dev/action-intensity.md)
> (AH-0MUZCSJXQ004TREN).

## Sinks

Sinks implement one interface (`TelemetrySink`), so the recorder never knows
where records go:

- **`NoopTelemetrySink`** — used whenever recording is disabled; discards
  everything.
- **`JsonlTelemetrySink`** — the local dev sink. Writes one JSON object per
  line through a pluggable `TelemetryLineWriter`; the default writer appends
  to browser `localStorage` under `ai_hell_telemetry_jsonl`, and an in-memory
  writer is available for headless runs and tests.
- **`RemoteTelemetrySink`** — the production sink. It forwards the
  recorder's batches to an HTTP transport. `createTelemetrySink()`
  auto-wires an `HttpTelemetryTransport` when `VITE_TELEMETRY_ENDPOINT` is
  configured; without an endpoint (or an injected transport) it drops and
  counts batches (it never silently pretends to send).

Add a new sink by implementing `TelemetrySink` and selecting it in
`createTelemetrySink()`; no recorder changes are needed.

### Remote transport: batching, retry and the offline path (AC2/AC4)

`HttpTelemetryTransport` (`src/telemetry/transport.ts`) uploads each batch as
one JSON `POST` (`{ schemaVersion, records }`) to the configured endpoint and
is designed to be invisible to gameplay:

- **Retry with exponential backoff + jitter** for transient failures —
  network errors, request timeouts, and retryable HTTP statuses (`408`, `425`,
  `429`, any `5xx`). A batch is retried up to `maxAttempts` (default 3) and
  then dropped, counted in `stats.dropped`.
- **Permanent `4xx` (other than the above) are not retried** — they are
  counted as rejected and dropped.
- **Offline short-circuit** — when the browser reports `navigator.onLine ===
  false` the batch is dropped immediately (`stats.skippedOffline`) instead of
  burning retries, so a missing network never affects the game.
- **Never throws** — every failure is counted and swallowed; the caller is
  the gameplay flush path.

All timing, randomness, networking and connectivity are injectable, so the
retry/backoff and offline policy is unit-tested hermetically. Inspect
`transport.stats` for `batches`, `delivered`, `dropped`, `skippedOffline`,
`rejected`, `attempts`, `retries` and `lastStatus`.

## Overhead, backpressure and sampling

Recording must never stall gameplay:

- **Bounded ring buffer.** Records go into a fixed-capacity ring buffer; when
  it is full the oldest record is overwritten and counted as dropped
  (`recorder.stats.dropped`). Memory use is constant regardless of sink
  speed.
- **Batched, serialised, asynchronous flush.** Reaching `batchSize` triggers
  a background flush. Batches are written to the sink in order, and
  `recordTick`/`recordEvent` never await a sink. Sink errors are counted
  (`stats.failedBatches`) rather than thrown into the game loop.
- **Sampling.** `VITE_TELEMETRY_SAMPLE_RATE` records a fraction of ticks
  (deterministic with an injected `random` in tests). Discrete **events are
  always recorded**, and the tick counter still advances for sampled-out
  ticks so events stay correctly aligned.

Inspect `recorder.stats` for `recorded`, `dropped`, `skipped`,
`flushedBatches`, `flushedRecords` and `failedBatches`.

## Game instrumentation (AH-0MUY08VVQ007HSSH)

The concrete `state`, `input` and event `payload` shapes the game records are
owned by [`src/scenes/core/runTelemetry.ts`](../src/scenes/core/runTelemetry.ts).
`PlayScene` wires that layer to the framework in `create()`; the recording is
**off by default**, so a normal run is a strict no-op.

### Per-tick state vector (AC1)

Each sampled tick records a compact, versioned state vector built from the
existing read-only `buildBotSnapshot()` (`src/ai/botSnapshot.ts`) plus the run
state the snapshot does not carry:

| Field | Contents |
|---|---|
| `v` | concrete state-vector version (`RUN_TELEMETRY_STATE_VERSION`) |
| `runSeed` | the per-run RNG seed — a tick is self-describing |
| `player` | `x`, `y`, `vx`, `vy`, `heading` (rad), `lives`, `invulnerable` |
| `hold` | `minerals`, `capacity` |
| `levels` | run-scoped `weapons` and `powerUps` (`{ id, level }`) |
| `enemies` | `x`, `y`, `alive`, `archetype` |
| `enemyBullets` | `x`, `y`, `vx`, `vy` |
| `drops` | `x`, `y`, `type` |
| `minerals` | `x`, `y`, `type` |
| `boss` | `x`, `y`, `alive`, `phase` (or `null`) |
| `aliveCount` | live enemy count |
| `wave` | `active`, `timeRemaining`, `timeLimit` (or `null`) |

The shape is versioned by `v` and extensible without an envelope bump — the
on-screen action-intensity epic (AH-0MUZMTTYH008KVS2) adds an
`actionIntensity` object here.

### Per-tick input (AC2)

The tick's `input` is the control input the shared player step **actually
applied** (`player.getInput()`), tagged with its control scheme:
`{ scheme: 'asteroids', forward, turnLeft, turnRight }` or
`{ scheme: 'fourDirectional', up, down, left, right }`. It is recorded for the
shipped/demo bot and for human play alike, because both flow through the one
shared input seam.

### Discrete events (AC3)

Events are tagged with `RUN_TELEMETRY_EVENT_VERSION` and the tick they occurred
on:

| Event | Recorded when | Payload |
|---|---|---|
| `run_start` | run begins | `{ seed }` |
| `run_end` | run ends (win or lose) | `{ won, score }` |
| `player_hit` | a hit costs a life | `{ lives }` |
| `player_hit_absorbed` | a shield absorbs a hit | `{}` |
| `player_death` | the ship runs out of lives | `{}` |
| `enemy_killed` | an enemy/asteroid is destroyed | `{ archetype, x, y }` |
| `pickup` | a power-up/weapon is collected | `{ kind, id }` |
| `mineral_collected` | a mineral enters the hold | `{ total }` |
| `hold_full` | the hold-full choice opens | `{ options }` |
| `choice_selected` | the choice is resolved | `{ index, id }` |
| `wave_start` | a wave starts | `{ level, waveNumber, waveCount }` |
| `wave_cleared` | a wave is cleared | `{ level, waveNumber }` |
| `level_cleared` | a level is cleared | `{ level }` |
| `boss_triggered` | the campaign triggers the boss | `{}` |
| `boss_spawn` | the boss spawns | `{}` |
| `boss_phase` | a boss phase is depleted | `{ phase }` |
| `boss_defeated` | the boss is destroyed | `{}` |

The framework still writes a `run_header` (seed + build) once per run.

### Enabling it for the game

Enable recording exactly as for the framework (`VITE_TELEMETRY_ENABLED=true`;
production also needs `VITE_TELEMETRY_CONSENT=true`). While disabled,
`PlayScene` performs only one boolean check per tick and records nothing.
Records are flushed on scene shutdown so the run tail (`run_end`) reaches the
sink.

### Opting a shared-core / gym scene in (AC4)

Any scene that can satisfy `buildBotSnapshot()` can opt in without new
plumbing — build the same state/input values and call the wrapper:

```ts
import { buildBotSnapshot } from '../ai/botSnapshot';
import { buildRunTelemetryState, RunTelemetry, serialiseTelemetryInput } from './core/runTelemetry';

const telemetry = new RunTelemetry(recorder); // no-op unless recorder.enabled
telemetry.startRun(runSeed);
// once per tick:
telemetry.recordTick(
  buildRunTelemetryState(buildBotSnapshot(scene), extras),
  serialiseTelemetryInput(scene.getPlayer()?.getInput() ?? null),
);
// at lifecycle points:
telemetry.enemyKilled(archetype, x, y);
telemetry.runEnd(won, score);
```

## Data policy — no PII, no secrets

- **By design**, the schema records positional/numeric gameplay state and
  input only. It does **not** include account identifiers, real names, email
  addresses, IP addresses, locations or free-text chat.
- **Defence in depth**, every payload is passed through
  `sanitiseTelemetryValue()` at the recorder boundary:
  - keys matching PII/secret patterns (`email`, `token`, `password`,
    `apiKey`, `authorization`, `cookie`, `username`, `address`, …) are
    replaced with `[redacted]`;
  - email-like substrings inside string values are replaced with
    `[redacted:email]`;
  - values JSON cannot represent (functions, `undefined`, non-finite numbers,
    class instances, cycles) become safe placeholders.
- **Never** add a field that carries a personal identifier to the game state
  or event payloads. If a future feature genuinely needs such data, it must
  be handled by the production consent flow (AH-0MUY08Y9P005ER7A) and
  documented here first.

## Privacy, retention and how playtester data is used (AC3/AC7)

This is the policy shown on the consent screen (in shortened form) and
linked from the release notes.

- **What is collected.** A run header (RNG seed, build version/commit, start
  time) plus sampled per-tick state and input, and discrete gameplay events
  (see the schema above). It is gameplay telemetry only — never personal
  data.
- **Why.** Solely to tune and improve the game and the demo/attract bot
  (reaction times, engagement distances, dodge outcomes, survival and
  minerals-per-minute). It is **not** sold, shared for advertising, or used
  to profile individuals.
- **Storage.** Batches are uploaded over HTTPS to the endpoint configured in
  `VITE_TELEMETRY_ENDPOINT` and stored in the operator's ingestion store.
  There is no per-player identifier in any record, so records are not
  attributable to an individual.
- **Retention.** Uploaded batches are retained for a bounded period
  (currently **90 days**) and then deleted. Aggregated, non-identifying
  metrics may be kept longer. Retention is enforced by the ingestion store,
  not the client.
- **Control.** Telemetry is off by default and only runs after an explicit
  opt-in. The player can revoke it at any time in Settings; revocation stops
  all further collection immediately. `clearTelemetryConsent()` resets the
  decision so the player is asked again.
- **Offline / local dev.** Local development and offline play never upload:
  the dev sink writes to `localStorage`, and the remote transport drops
  batches when offline or when no endpoint is configured.

## Inspecting downloaded telemetry (AC5)

`scripts/inspect-telemetry.mjs` reads a JSONL recording (the local dev sink's
`localStorage` value, or a downloaded/exported production batch) and prints a
summary: record counts by kind, schema version, run seeds, build ids, the tick
range and the event histogram. Unknown/corrupt lines are skipped rather than
crashing the reader.

```bash
# human-readable
node scripts/inspect-telemetry.mjs recording.jsonl

# machine-readable (adds `skippedLines`)
node scripts/inspect-telemetry.mjs recording.jsonl --json

# or from stdin
cat recording.jsonl | node scripts/inspect-telemetry.mjs
```

It intentionally does not repackage the deeper offline analysis (histograms,
reaction latency, engagement distances) which is delivered by the sibling dev
recording/analysis tooling (AH-0MUY08W7Y004GATZ); the inspector is the quick,
dependency-free first look at any recording, and its summary shape is the
stable interface the analysis tool can build on.

## Testing

The framework is covered by hermetic unit tests under
[`src/telemetry/`](../src/telemetry):

| File | Covers |
|---|---|
| `schema.test.ts` | `isTelemetryRecord` runtime guard and schema version |
| `redact.test.ts` | PII/secret redaction and JSON safety |
| `config.test.ts` | disabled-by-default, consent gate, env/endpoint parsing, `applyUserConsent` |
| `consent.test.ts` | prompt predicate and effective (player) consent policy |
| `sinks.test.ts` | no-op sink, JSONL round-trip, remote sink + transport auto-wiring |
| `transport.test.ts` | HTTP envelope, batching, retry/backoff, permanent failures, offline drop |
| `recorder.test.ts` | run header/schema version, batching, ring buffer, sampling, redaction |
| [`runTelemetry.test.ts`](../src/scenes/core/runTelemetry.test.ts) | concrete state/event serialisation, version/seed tagging, no-op |
| [`PlaySceneTelemetry.test.ts`](../src/scenes/PlaySceneTelemetry.test.ts) | end-to-end PlayScene recording: state + applied input, run/wave/kill/pickup/choice/run-end events, off = zero records |
| [`TelemetryConsentScene.test.ts`](../src/scenes/TelemetryConsentScene.test.ts) | consent prompt: privacy copy, safe default, grant/deny/ESC persistence |
| [`telemetryConsentStore.test.ts`](../src/core/telemetryConsentStore.test.ts) | consent persistence, corrupt/absent fallback |
| [`inspect-telemetry.test.ts`](../scripts/inspect-telemetry.test.ts) | JSONL parsing, summary and formatting |

Run them with `npx vitest run src/telemetry` (or the full suite via
`/skill:test`).
