# Runtime generation evaluation (ToneForge Runtime-ready)

- **Work item:** Evaluate switching to runtime generation when ToneForge is Runtime-ready (AH-0MUTVQDH2008DEF6)
- **Parent epic:** Switch game audio from procedural Web Audio to ToneForge (AH-0MUTUOB7X007PR9J)
- **External prerequisite:** Make ToneForge Runtime-aware (browser-compatible playback) (TF-0MUUB39EL000YCT0) — **completed**
- **Related:** `docs/AUDIO_TONEFORGE_CUE_MAPPING.md`, `audio/toneforge/pin.json`, `src/audio/effects.ts`, `src/audio/thrusterShim.ts`
- **Nature:** Evaluative — no production code change is made by this item.

## 1. ToneForge runtime capability (AC1)

ToneForge is now **Runtime-aware**. From `../ToneForge` (pinned at
`5934fb0a0835e8b6ee8297a3a28f51e811b50b0b`, see `audio/toneforge/pin.json`)
and `docs/browser-usage.md`:

- The **Runtime engine**, **recipe registry** and **offline renderer** run
  unchanged in a browser using the **native Web Audio API**; no polyfill.
- `src/audio/web-audio.ts` is the single cross-platform entry point:
  `OfflineAudioContext`, `AudioContext`, `getAudioContext()`,
  `getOfflineAudioContextCtor()` and `isNodeRuntime()`. The Node-only
  `node-web-audio-api` is an **optional dependency**, loaded lazily only under
  `isNodeRuntime()` — browser bundlers never include it (and the ToneForge
  web build is Vite-based, proving browser-safety).
- `createRuntime(options)` (`src/runtime/runtime.ts`) is a deterministic,
  seeded playback engine: it ties together a **state machine**, a **context**
  (environment dimensions) and a **sequencer**, producing a scheduled event
  timeline (`inspect()`, `log()`, `simulateActive()`, `onEvent()`). It is an
  event/sequence scheduler, not a continuous synthesis graph.
- Recipes render through `OfflineAudioContext` in both runtimes, so a
  browser can resolve a recipe and produce an `AudioBuffer` at runtime, then
  play it through `getAudioContext()`.

**Conclusion:** browser-side runtime generation of ToneForge recipes is
technically viable. The remaining question is whether the game's *dynamic*
cues benefit (next sections).

## 2. Dynamic cues in the game today

| Cue | Why it is dynamic | Current delivery |
|-----|-------------------|------------------|
| Thruster hum (`updateThrusterSound`/`stopThrusterSound`) | Continuous, pitch/gain-coupled to `getEngineSoundLevel` every frame | **Runtime shim** (`src/audio/thrusterShim.ts`) — a shared Web Audio voice (triangle + sine + band-passed noise), gain ≤ 0.075 |
| Enemy / Diver destruction (`playDestructionSound`, `playDiverDestructionSound`) | Per-invocation pitch jitter (±15 %) so repeated kills differ | **Baked** — a 3-seed variant range (`aihell-enemy-destruction` 32110–32112, `aihell-diver-destruction` 32193–32195), one chosen at random per play |
| Diver dive loop (`playDiveSound`) | Continuous ~2 s whoosh | **Baked** (`aihell-diver-dive-loop.32191.wav`) |

All other cues are one-shots and already served correctly by baked assets.

## 3. Baked vs runtime comparison (AC2)

| Dimension | Baked (current) + Web Audio shim | Runtime generation (ToneForge Runtime) |
|-----------|----------------------------------|----------------------------------------|
| **Continuous, parameter-coupled cues** (thruster hum) | Natural fit: one persistent voice whose gain/pitch follows `getEngineSoundLevel` frame-by-frame | Poor fit: the Runtime emits discrete scheduled events; a thrust-coupled continuous voice still needs a hand-written audio-node graph, i.e. the same shim |
| **Per-play variation** (jitter) | 3 baked variants; variation is coarse but audible | Unlimited unique variants from a seed derived from game RNG |
| **Determinism** | Strong: build-time seeds + checksums; gameplay RNG cannot drift audio | Weaker unless the game seeds the runtime from its own deterministic RNG; offline rendering per event reintroduces timing variance |
| **Latency / CPU** | Zero synthesis at play time (buffer playback) | Per-event offline render is CPU-heavy; needs pre-render/caching or an unacceptable first-play delay. A burst of kills would contend for the audio thread |
| **Bundle / dependency surface** | None beyond Phaser; ToneForge stays build-time only | Requires importing the ToneForge runtime + renderer into the browser entry graph (new runtime dependency ~ tens of KB, plus recipe data), all subject to the bundle-hygiene guard |
| **Authoring loop** | Recipe → `npm run build-audio` → committed WAV, reviewed and reproducible | Recipe edits become code-shipped data; less explicit review of the exact rendered result |
| **Failure modes** | Missing/ corrupt asset is caught at build time by checksums | Runtime render can fail in the browser (decode/CPU), needing a baked fallback anyway |
| **Complexity** | Low — thin manifest-driven playback (`src/audio/effects.ts`) | High — resolve → render → buffer → schedule → cache → dispose, plus volume/mute routing onto the shared master gain |

## 4. Viability and migration path (AC3)

Runtime generation is viable for ToneForge in the browser, but **the game's
current dynamic cues do not justify it**:

- **Thruster hum** is the only truly continuous, parameter-coupled cue. The
  Runtime's event/sequence model does not remove the need for a bespoke
  continuous voice, so switching would not simplify anything — it would add a
  second audio subsystem alongside the shim.
- **Jittered one-shots** get an audible-but-marginal benefit (3 variants →
  many) at the cost of per-kill browser rendering CPU/latency and extra
  non-determinism. Three seed variants already satisfy the "repeated kills
  sound different" requirement from the cue mapping.

### If runtime generation is adopted later (migration path)

1. Add ToneForge as a **pinned, tree-shakeable** runtime dependency (the pin
   infrastructure exists: `audio/toneforge/pin.json`,
   AH-0MUTYVA2C000SNPO) and keep the bundle-hygiene check green.
2. Import the browser-safe entry points from `toneforge/audio/web-audio` and
   `toneforge/runtime`; resolve a recipe for the cue.
3. Render the recipe to an `AudioBuffer` (OfflineAudioContext), ideally warm a
   small per-cue cache on scene start to avoid first-play latency; fall back
   to the baked asset when rendering is unavailable.
4. Schedule playback on the **shared** `AudioContext` through the existing
   master SFX gain so volume/mute keep working.
5. Seed any variation from the game's own deterministic RNG (not
   `Math.random`) to preserve replay determinism.
6. Keep baked assets for every one-shot as the offline/fallback path.

## 5. Recommendation (AC4/AC5)

**Do not switch the current dynamic cues to runtime generation.** Keep the
shipped model:

- baked WAV assets for all one-shots (including 3-seed jitter variants), and
- the lightweight Web Audio **runtime shim** for the continuous thrust-coupled
  hum (the epic's single allowed runtime-synthesised exception).

Revisit ToneForge Runtime generation only if a future feature needs
**many context/state-driven, procedurally varied cues** (e.g. adaptive music
or environment-driven sequences), where the Runtime's state/context/sequencer
model actually pays off. At that point follow the migration path in §4.

This is recorded as a comment on this work item (AC5). No code changes are
required.
