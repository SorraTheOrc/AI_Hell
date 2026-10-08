# Telemetry framework

> Status: framework landed in AH-0MUY08VJ9006BHJO (epic
> AH-0MUY089KR003F8S4). Wiring the game to record per-tick state is child 3
> (AH-0MUY08VVQ007HSSH); production opt-in and the remote transport are child
> 10 (AH-0MUY08Y9P005ER7A).

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
| `VITE_TELEMETRY_SINK` | `jsonl` (local dev) or `remote` (production stub) | `jsonl` |
| `VITE_TELEMETRY_SAMPLE_RATE` | Fraction of ticks to record (`0`–`1`) | `1` |
| `VITE_TELEMETRY_BUFFER_CAPACITY` | Ring-buffer capacity, in records | `512` |
| `VITE_TELEMETRY_BATCH_SIZE` | Buffer size that triggers a flush | `64` |
| `VITE_APP_VERSION` / `VITE_GIT_COMMIT` | Build metadata written to the run header | `0.0.0-dev` / `unknown` |

The consent gate works as follows (see
[`config.ts`](../src/telemetry/config.ts)):

- `enabled = false` → **no-op recorder**, nothing is buffered or written.
- dev build + `enabled` → recording without consent.
- production build + `enabled` → recording **only** when `VITE_TELEMETRY_CONSENT`
  is also set.

`createTelemetryRecorder()` is the single enforcement point: it returns a
`NoopTelemetryRecorder` unless the effective gate is open.

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

## Sinks

Sinks implement one interface (`TelemetrySink`), so the recorder never knows
where records go:

- **`NoopTelemetrySink`** — used whenever recording is disabled; discards
  everything.
- **`JsonlTelemetrySink`** — the local dev sink. Writes one JSON object per
  line through a pluggable `TelemetryLineWriter`; the default writer appends
  to browser `localStorage` under `ai_hell_telemetry_jsonl`, and an in-memory
  writer is available for headless runs and tests.
- **`RemoteTelemetrySink`** — the production **stub**. It forwards batches to
  an injected transport; until the production child wires one, it drops and
  counts batches (it never silently pretends to send).

Add a new sink by implementing `TelemetrySink` and selecting it in
`createTelemetrySink()`; no recorder changes are needed.

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

## Testing

The framework is covered by hermetic unit tests under
[`src/telemetry/`](../src/telemetry):

| File | Covers |
|---|---|
| `schema.test.ts` | `isTelemetryRecord` runtime guard and schema version |
| `redact.test.ts` | PII/secret redaction and JSON safety |
| `config.test.ts` | disabled-by-default, consent gate, env parsing |
| `sinks.test.ts` | no-op sink, JSONL round-trip, remote stub |
| `recorder.test.ts` | run header/schema version, batching, ring buffer, sampling, redaction |

Run them with `npx vitest run src/telemetry` (or the full suite via
`/skill:test`).
