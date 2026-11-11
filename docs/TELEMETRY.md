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
| `VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES` | Cap on the CDP message any dev telemetry upload (a streamed part or the run-end final part) may produce (UTF-8 bytes; positive integer, clamped to 16 MiB) | `8388608` (8 MiB) |
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

## Dev-mode auto-upload and automatic evaluation (dev builds only)

> Landed in **Dev-mode telemetry upload to dev server with automatic evaluation**
> (AH-0MVBHRLY8004BGDN; docs slice AH-0MVBMRR4R004UOLH), extended by the
> **streaming part protocol** that bounds the loss of an interrupted run
> (AH-0MVJUAADW0033QBD, children AH-0MW6NFRQR0062D90 /
> AH-0MW6NI6BW003RJWH / AH-0MW6NJ3VU0038JHZ; docs slice AH-0MW6NNRJ0009FRTO).
> **Dev-only:** none of this exists in a production build, `vite preview`,
> `vite build` output or a static host — the upload endpoint is registered with
> `apply: 'serve'` only and the bundle-hygiene gate forbids the endpoint (and
> the part-protocol markers) in `dist/`.

A stock `npm run dev` — no `VITE_TELEMETRY_*` variables — **collects** the run's
telemetry into an **in-memory, per-run buffer** and **streams** it to the dev
server that served the page while the run is in progress, one part per flushed
batch. At run end a final part completes the run: the server stores it as a
recording under `recordings/session-<timestamp>.jsonl` and runs the existing
human evaluation on it automatically. A run that never reaches its final part
(a page reload, a renderer crash) leaves only its staged part file, described
under *Crashed runs* below — so an interrupted session loses at most the
batches the server had not confirmed yet. The buffer is **left intact**
throughout (and after the run, until the next run starts) and exposed to the
Node tooling through the dev-gated `window.__aiHellTelemetry` accessor, so
`npm run record`, `npm run capture` and `npm run verify-dev-telemetry` read
exactly the run the page just recorded.

Because the run lives only in the page's memory, **how the recorder is stopped
decides whether the recording survives** — see
[*Stopping a `npm run record` session*](#stopping-a-npm-run-record-session-ctrlc-saves-a-browser-close-salvages-a-partial)
below: Ctrl+C in the terminal saves; closing the browser window does not.

**Telemetry never uses `localStorage`** (AH-0MVIRYGD1000JVY3). The buffer lives
in the page's memory, so a long run can neither exhaust the origin's storage
quota nor make unrelated writes throw: before this, the per-tick JSONL sink
(~64 KB/s of play) filled the ~5 MiB quota after ~1.4 minutes, after which every
`localStorage.setItem` — including saving Settings — threw
`QuotaExceededError` and the change silently reverted. Two consequences worth
knowing:

- `startRun()` resets the buffer, so each uploaded recording contains **only
  that run's** records (no cross-run duplication in `recordings/session-*.jsonl`).
- A single run of any length is captured in full — there is no quota-based
truncation, and nothing accumulates across runs.

### The setting (on by default)

Settings → **Share with dev server: ON/OFF** (the `shareTelemetryDev` field of
the `ai_hell_settings` store, default **on**, `src/core/settingsStore.ts`). The
row exists only in a dev build. When the setting is **off** the dev game neither
collects nor uploads telemetry: the sink stays untouched and no upload request
is made. The stored `shareTelemetryDev` value is inert outside a dev build.

### The single dev gate

Every dev-telemetry decision — collection and upload — routes through
[`src/telemetry/devMode.ts`](../src/telemetry/devMode.ts): `isDevTelemetryBuild`
(the only dev-flag decision point), `isDevTelemetryCollectionEnabled` and
`isDevTelemetryUploadEnabled` (upload is a strict subset of collection). Vite
statically replaces `import.meta.env.DEV`, so in a production build the
predicates compile to `false` and Rollup drops the dev uploader and its endpoint
from the shipped bundle. `src/telemetry/devModeEnforcement.test.ts` fails the
suite if any production module re-implements the decision, and
`npm run check-bundle` fails if `/api/telemetry/upload` reaches `dist/`.

### Streaming upload during the run (the part protocol)

Delivery no longer waits for run end. Every flushed batch is streamed to
`POST /api/telemetry/upload` (same-origin, `application/x-ndjson`) **during**
the run, and run end sends one final part that completes it
([`src/telemetry/devStream.ts`](../src/telemetry/devStream.ts),
[`src/telemetry/devStreamProtocol.ts`](../src/telemetry/devStreamProtocol.ts)).

- **One part per flushed batch.** The dev JSONL sink exposes a post-flush
  observer (`onFlush` in [`src/telemetry/sinks.ts`](../src/telemetry/sinks.ts));
  the dev-only streamer sends each flushed batch as one part. The sink's buffer
  is **never cleared mid-run** — only the upload watermark advances.
- **Run key.** Each run has a deterministic, run-scoped key,
  `<startedAt>-<runSeed>`, derived from the run header at `startRun()`, so one
  run's parts can never be merged into another run.
- **Cumulative offset.** A part carries the number of records the client
  believes the server has already confirmed (`x-telemetry-offset`) and only the
  records beyond it. The server is authoritative: it appends only records
  beyond its own stored count, so a retried part whose `2xx` was lost is
  deduplicated instead of appended twice, and a part whose offset is beyond the
  stored count is refused as a **gap** (`409` plus the server's count) so the
  client re-syncs and re-sends.
- **Serialised, in order.** Parts are chained one at a time, so records can
  never interleave out of order and a slow server cannot build a request storm.
- **Wire shape.** The framing is carried in headers, or the equivalent query
  parameters: `x-telemetry-part: 1` (or `?part=1`) marks the request as a part,
  `x-telemetry-run-key` (`?runKey=`) carries the run key, `x-telemetry-offset`
  (`?offset=`) the cumulative offset and `x-telemetry-final: 1` (`?final=1`) the
  run's last part. A request **without** the marker keeps the pre-streaming
  whole-file contract byte-for-byte (one body = one recording, one
  evaluation), which is why the existing CLI tooling and the
  production-preview test are unaffected.
- **Run end.** `flushAndUploadDevTelemetry()` flushes the recorder once more,
  then sends the final part (`final: true`). The server stores the run as one
  collision-safe `recordings/session-<timestamp>.jsonl` and enqueues **exactly
  one** evaluation. A repeated final part for an already-finalised run is
  answered idempotently — the same confirmed count, nothing stored and nothing
  evaluated again (a lost `2xx` therefore cannot double-count or double-evaluate
  a run).
- **Fire-and-forget.** Failures are caught and reported through the optional
  error seam, never thrown — a part or a run-end upload can never block or
  crash the run.

When no streamer is installed (a production build, or the dev-only dynamic
import failed) the pre-streaming whole-file uploader in
[`src/telemetry/devUpload.ts`](../src/telemetry/devUpload.ts) is used unchanged.

The streamer is reached only through `loadDevTelemetryStreamer()`
([`src/telemetry/devMode.ts`](../src/telemetry/devMode.ts)), whose literal dev
check Vite folds to `false` in a production build, so the streamer, the part
protocol and its markers are dead-code-eliminated (AC6). The opt-out setting
(`Share with dev server: OFF`) stops collection entirely, so a run with the
setting off produces **zero** part uploads.

#### Loss bound on an interrupted run

A page reload or renderer crash mid-run loses **no more than the records the
dev server has not confirmed** (AC1):

| What is lost | At the defaults |
|---|---|
| the part in flight when the page died | ≤ 64 records (one batch, ~1.3 s of play) |
| the ring buffer's not-yet-flushed tail | < 64 records |
| worst case | ≈ 127 records / ~2.5 s |
| typical case | ≤ 64 records / ~1.3 s |

Everything the dev server already confirmed is recoverable from it after the
reload, so a long session is not lost. The bound scales with
`VITE_TELEMETRY_SAMPLE_RATE` and the recorder's batch size: at full sampling
and ~50.8 ticks/s a 64-record batch is about 1.26 s of play.

#### Offline and retry behaviour

- **A failed part never advances the watermark.** The unconfirmed records stay
  in the (never-cleared) in-memory buffer, so the next part re-reads them from
  the last confirmed offset.
- **Mid-run failures back off, they do not retry-storm.** A failed part opens a
  short, exponentially backing-off window (base 250 ms, doubling, capped at
  2 s); every flush inside that window is coalesced into it, and the first flush
  after it re-sends the pending range. An unreachable dev server is therefore
  retried at most once per window instead of on every batch.
- **A gap is not an outage.** A `409` carries the server's authoritative count;
  the client adopts it and re-sends immediately from there, without paying a
  backoff delay.
- **Run end degrades to the old single upload.** No further flush will ever
  come, so the final part carries the entire unconfirmed tail as one request and
  is retried a bounded number of times (`DEFAULT_PART_MAX_ATTEMPTS` = 4, with
  the same backoff) before the failure is reported. A dev-server outage during a
  run therefore degrades to today's single run-end upload rather than losing the
  run.
- **The 8 MiB cap still applies.** Each mid-run part is at most one batch (tens
  of KB). The run-end tail after an outage goes through the same
  `checkDevUploadSize()` check and is skipped with the actionable line described
  under *Upload message cap* below when it is over the cap.

#### Upload message cap (8 MiB, `VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES`)

No telemetry upload — a mid-run part or the run-end final part — may produce a
CDP message above a cap,
`DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES` = **8 MiB**
(`src/telemetry/devUpload.ts`), applied in the page *before* `fetch`. An
over-cap body is skipped with one actionable line (`[telemetry] run-end
upload skipped: …`) instead of being delivered. The body itself is untouched:
the run stays in memory and `npm run record` / `npm run capture` still read it
through `window.__aiHellTelemetry`.

The cap is metered on the **message**, not on the raw telemetry: the CDP
message embeds the body as the escaped `request.postData` JSON string, so
escaping inflates it (measured **2.4×** on real runs — a 4.0 MiB telemetry body
produced a 9.7 MiB message). `devUploadMessageBytes()` computes
`JSON.stringify(body)` plus a small envelope allowance, so an 8 MiB cap really
means "no single page→node message above 8 MiB" and the effective body
allowance is roughly 3 MiB of NDJSON. Raise or lower it with
`VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES` (any value is clamped to the 16 MiB
server bound, so a cap that could overflow the pipe is unreachable).

Why client-side, and why bounded at all (AH-0MVNVGP55002G0KH, diagnosed in
AH-0MVNT25JI004OVKQ): Playwright's pipe transport concatenates its pending
buffers into one string, and V8 caps a string at 512 MiB
(`ERR_STRING_TOO_LONG`) — a long enough run ended with the capture process
dying mid-recording. The server's own bound (`DEFAULT_MAX_UPLOAD_BYTES`,
16 MiB, `413` — see *Server-side receipt and storage* below) cannot prevent
this: the overflow happens when the request is sent, before any response
exists. Turns of practical scale: with streaming, each mid-run part is a single
batch and cannot approach the cap; a run whose whole 4.0 MiB telemetry body is
buffered for one run-end final part (e.g. after an outage) is skipped (its
4.0 MiB body would need a 9.7 MiB message) while a normal demo run's 0.67 MiB
body still finalises (~1.7 MiB message).

### Server-side receipt and storage

The dev-only Vite plugin
[`vite/plugins/telemetryUploadPlugin.ts`](../vite/plugins/telemetryUploadPlugin.ts)
registers the endpoint with `apply: 'serve'`, mirroring `configCsvPlugin`:

- **Validation** — the body is checked against the recording reader
  (`scripts/recording.mjs`, `parseRecording`): at least one schema-valid record
  with a supported `schemaVersion` and known record kind. Malformed bodies are
  rejected with `400` **before** anything is written.
- **Size** — bodies over 16 MiB are rejected with `413` (declared
  `Content-Length` or discovered while streaming). Uploads are additionally
  capped client-side at an 8 MiB CDP message by default (see *Upload message
  cap* above), so this bound is the outer limit, not the operative one.
- **Storage (whole-file)** — a valid body without the part marker is written
  verbatim as a collision-safe `recordings/session-<timestamp>.jsonl` (never
  overwriting an existing file).
- **Storage (streamed parts)** — a request carrying the explicit part marker is
  staged under `recordings/parts/<runKey>.jsonl`, deliberately **off** the
  `session-*.jsonl` glob so a mid-run session can never be mistaken for a
  completed recording by `recordings()` helpers or
  `npm run verify-dev-telemetry`. Each part appends only the records beyond its
  claimed offset, a gap is refused with `409` and the server's authoritative
  count, and the final part stores the staged records under the same
  collision-safe `session-<timestamp>.jsonl` name and enqueues one evaluation
  (see *Streaming upload during the run* above). A part that claims the marker
  but cannot be read is answered `4xx`, never silently degraded to a whole-file
  upload.

### Automatic evaluation

After a valid store the plugin enqueues the existing human evaluation

```bash
node scripts/evaluate.mjs --human <recordings/session-...jsonl> \
  --out eval-output/uploaded/<session-stamp>
```

as a detached child process, **serialised** (one at a time), so the HTTP
response returns immediately and a burst of uploads cannot spawn unbounded
processes. Progress and a completion summary are logged to the dev-server
console as `[telemetry-evaluation] …` and appended to
`eval-output/uploaded/<session-stamp>/evaluation.log`. The output directory
receives the same artifacts as `npm run record` / `npm run evaluate -- --human`:
`human-balance-report.json` plus its companions (`comparison.json`, `ghost.svg`).

### Crashed runs: `recordings/parts/<runKey>.jsonl`

A run that never sends its final part — a page reload, a renderer crash, a
closed tab — leaves **only** its staged part file:

```
recordings/parts/<startedAt>-<runSeed>.jsonl
```

That file is the run's partial, and it is **valid NDJSON**: every record the
dev server had confirmed, in order, one schema-valid telemetry record per line.
It is **not** a `session-*.jsonl` recording and it is **not auto-evaluated** —
evaluation is triggered by finalisation only, so a crashed run never produces
an `eval-output/uploaded/` directory on its own and never pollutes the
`session-*.jsonl` glob the CLI tooling matches. It is still usable by hand:

```bash
# human-readable summary of the recovered partial
npm run telemetry:inspect -- recordings/parts/<runKey>.jsonl

# evaluate it exactly like a completed recording
node scripts/evaluate.mjs --human recordings/parts/<runKey>.jsonl \
  --out eval-output/parts/<runKey>
```

Re-sending the same run's final part finalises it (the staged file is renamed
and evaluated once). Deleting a stale partial is a manual cleanup: there is no
janitor by design — partial retention/cleanup is recorded as discovered work,
not implemented here.

### Verifying the flow

1. `npm run dev` (no env vars) and play a run to completion.
2. While playing, `recordings/parts/<runKey>.jsonl` grows one batch at a time
   and the page issues `POST /api/telemetry/upload` part requests (all `200`).
3. At run end the part file disappears and a new `recordings/session-*.jsonl`
   appears; the console logs `[telemetry-evaluation] evaluation started …` then
   `… finished …`.
4. `eval-output/uploaded/<session-stamp>/human-balance-report.json` and
   `evaluation.log` appear — exactly one evaluation per run.
5. Turn the setting off and play again: **no** new recording file, **no** part
   file and **no** upload request.
5. `npm run build` passes and ships no upload endpoint; `vite preview` returns
   the SPA fallback (never the upload JSON) for `POST /api/telemetry/upload`.

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

> #### `state.actionIntensity` — per-tick action-intensity metric (AH-0MUZQEDW9002KHRN)
>
> When telemetry is enabled the `state` object includes an `actionIntensity`
> field (§7.1 of [the decision doc](./dev/action-intensity.md), wired by
> AH-0MUZQEDW9002KHRN):
>
> ```jsonc
> {
>   "actionIntensity": {
>     "rawScore": 41.5,        // unbounded R(t) = P(t) + k_E · E(t)
>     "intensity": 0.58,       // normalised [0,1) via R/(R+B)
>     "smoothed": 0.49,        // exponential moving average S(t)
>     "burstiness": 0.09,      // intensity(t) − S(t)
>     "breakdown": {           // per-category live counts n_c(t)
>       "playerBullets": 4,
>       "enemyBullets": 11,
>       "enemies": 6,
>       "asteroids": 0,
>       "drops": 1,
>       "enemyExplosions": 0,
>       "bossExplosions": 0,
>       "playerExplosions": 0,
>       "bosses": 0
>     }
>   }
> }
> ```
>
> - **`rawScore`** — the unbounded combined raw score `R(t)`.
> - **`intensity`** — normalised score in `[0, 1)` (`R/(R+B)`).
> - **`smoothed`** — the exponential moving average of `intensity`.
> - **`burstiness`** — `intensity − smoothed`; positive values indicate a
>   spike above the trend, negative a dip.
> - **`breakdown`** — the per-category live counts `n_c(t)` that contributed to
>   the score.
>
> This is a **payload-only change** (no framework schema bump) and is a strict
> no-op when telemetry is disabled: `RunTelemetry.recordTick` returns before
> computing anything, so there is no sample and no record. When enabled,
> `recordTick` derives the per-category counts from the tick state's own
> registries (the `BotSnapshot` collections), feeds the discrete events
> observed since the run started through the sliding event window (§6.2), and
> samples the combined score at the configured rate (§6.5) before the recorder
> sees the tick. The pure computation and the event-window accumulator live in
> [`src/scenes/core/actionIntensity.ts`](../src/scenes/core/actionIntensity.ts)
> and are owned by the epic **AH-0MUZMTTYH008KVS2**.

## Sinks

Sinks implement one interface (`TelemetrySink`), so the recorder never knows
where records go:

- **`NoopTelemetrySink`** — used whenever recording is disabled; discards
  everything.
- **`JsonlTelemetrySink`** — the local dev sink. Writes one JSON object per
  line through a pluggable `TelemetryLineWriter`; the default writer is an
  **in-memory buffer** (`createMemoryLineWriter()`), reset when `startRun()`
  begins a new run. It never touches browser storage: the streamed parts, the
  run-end final part and the dev CLI tooling all read the buffer directly
  (`recorder.readBuffer()` / `window.__aiHellTelemetry.read()`), and it is
  never cleared mid-run. The optional `onFlush` observer sees each batch's
  delta right after it is appended, which is how the dev streamer observes
  flushed batches without consuming them. The accessor is only installed in a
  dev build (AH-0MVIRYGD1000JVY3).
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
`actionIntensity` object as described in the schema reference above.

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
- **Offline / local dev.** Nothing is ever uploaded to the production
  ingestion endpoint from local development or offline play: a dev build's
  telemetry goes only to the **local dev server** (its own
  `POST /api/telemetry/upload`, streamed during the run), and the remote
  transport drops batches when offline or when no endpoint is configured.

## Inspecting downloaded telemetry (AC5)

`scripts/inspect-telemetry.mjs` reads a JSONL recording (the file written by
`npm run record` / `npm run capture`, or a downloaded/exported production
batch) and prints a
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
reaction latency, engagement distances), which is delivered by the sibling dev
recording/analysis tooling (AH-0MUY08W7Y004GATZ): `npm run record`,
`npm run analyse` and `npm run replay` — see
[docs/dev/recording-and-replay.md](./dev/recording-and-replay.md). The
inspector is the quick, dependency-free first look at any recording, and its
summary shape is the stable interface the analysis tool builds on.

### Stopping a `npm run record` session (Ctrl+C saves; a browser close salvages a partial)

`npm run record` reads the run from the page's in-memory buffer (above), so the
stop procedure decides whether anything is kept (AH-0MVVH57LL00038WQ):

- **Ctrl+C in the recorder's terminal** finishes and saves: the whole run is
  written to `<output>` (`recordings/session-<seed-><timestamp>.jsonl` by
default), `balance-stats.json` beside it, exit code `0`.
- **Closing the browser window** (or a page crash) does **not** save a completed
  recording. While recording, the CLI increments the page buffer to
  `<output>.partial.jsonl` every `--checkpoint-ms` (default 15 000 ms; `0`
  disables), appending only the records the buffer gained since its previous
  read, so an interrupted session keeps the partial capture up to the last
  checkpoint: a readable NDJSON file, named in one actionable line, with the
  un-checkpointed tail (at most one interval) lost, **no** `balance-stats.json`
  and exit code `1`. A salvage is collision-safe — it never overwrites an
  existing recording or an earlier salvage.
- **Nothing checkpointed** (the browser closes during startup or before the
  first checkpoint, or the buffer is unreachable): one actionable line names the
  output path that was not written and the Ctrl+C procedure, and the exit code
  is `1`. The recorder's rescue boundary covers the whole session — including
  page setup — so a browser close during startup takes this path rather than
  printing a raw Playwright target-closed message (AH-0MWB6OG5T007BYXP).

`--auto` must be passed **after `--`** (`npm run record -- --auto`): a bare
`npm run record --auto` is consumed by npm, so the recorder waits for Ctrl+C
instead of stopping at run end. The full flag table, including `--checkpoint-ms`,
is in [docs/dev/recording-and-replay.md](./dev/recording-and-replay.md).

### Human balance statistics (`npm run record`)

`npm run record` (dev mode only) writes a `balance-stats.json` **next to** the
`.jsonl` recording: the versioned human `BalanceReport` (`kind: 'balance'`,
`policy: 'human'`) produced by the shared pure helper `extractHumanBalanceStats`
([`src/ai/eval/humanStats.ts`](../src/ai/eval/humanStats.ts)). The helper
splits the recording's `run_header` / `tick` / `event` stream into per-run
`BalanceRunStats` and one `BalanceAggregate`, **reusing** the
automated-balancing framework's `extractBalanceStats` / `aggregateBalanceStats`
— the same schema and code path a bot batch uses, so the human report is
directly comparable to a bot report. See
[docs/BALANCING.md](./BALANCING.md#human-play-statistics-policy-human).

Collection exists **only** in the dev tooling (`scripts/record-session.mjs` and
`scripts/evaluate.mjs --human`, AH-0MV7WVEWL005XEMN AC3); it changes no
production telemetry/consent configuration and adds no production call site.
The artifact is PII-free: it holds only schema fields (numeric statistics,
seeds, archetype/upgrade keys and record hashes).

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
| [`runTelemetry.test.ts`](../src/scenes/core/runTelemetry.test.ts) | concrete state/event serialisation, version/seed tagging, no-op, actionIntensity field wiring |
| [`PlaySceneTelemetry.test.ts`](../src/scenes/PlaySceneTelemetry.test.ts) | end-to-end PlayScene recording: state + applied input, run/wave/kill/pickup/choice/run-end events, off = zero records |
| [`TelemetryConsentScene.test.ts`](../src/scenes/TelemetryConsentScene.test.ts) | consent prompt: privacy copy, safe default, grant/deny/ESC persistence |
| [`telemetryConsentStore.test.ts`](../src/core/telemetryConsentStore.test.ts) | consent persistence, corrupt/absent fallback |
| [`inspect-telemetry.test.ts`](../scripts/inspect-telemetry.test.ts) | JSONL parsing, summary and formatting |

Run them with `npx vitest run src/telemetry` (the per-file project split
automatically sends the pure `node`-env suites to `unit` and the scene-booting
suites to `integration`), or run the audit-accepted full suite with
`npm --silent test` / `/skill:test --type full`.
