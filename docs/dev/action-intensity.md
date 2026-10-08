# On-screen action intensity: research and decision

> **Status: decision recorded** — work item
> *Screen action intensity tracking and analysis (AH-0MUZCSJXQ004TREN)*. This
> document is the deliverable of that research/decision item: it surveys how
> games measure action/excitement, compares six candidate approaches, selects a
> **hybrid layered metric**, and specifies the scoring model, the recorded
> artefact, and its integration with the telemetry pipeline. It makes **no
> runtime changes**; the implementation is tracked by the sibling epic
> *Implement on-screen action intensity metric (recording + video join)*
> (AH-0MUZMTTYH008KVS2)
> (see [§10](#10-follow-up-implementation-epic)).

## 1. Problem & scope

AI_Hell has no recorded measure of on-screen action. Without one:

- designers cannot see where a run is boring or unreadably crowded;
- future pacing / adaptive-difficulty systems have no signal to react to;
- the gameplay-capture pipeline cannot automatically identify exciting
  moments for highlight clips (it can only probe a *whole* clip for
  non-black pixels, colour variety and inter-frame motion — a coarse,
  video-only proxy; see [§3.5](#35-physics--rendering-proxies)).

This document answers three questions:

1. **How** — what single, cheap, deterministic measure of on-screen action
   should AI_Hell record per run?
2. **What** — what is the recorded artefact (schema, sample rate, file
   location, and how it joins to captured video)?
3. **Where** — how does it integrate with the telemetry pipeline and the
   shared gym↔game core, without adding a parallel instrumentation path?

**In scope:** research, the decision, the refined scoring model, the output
format, telemetry integration, and the creation of the implementation epic.

**Out of scope (deferred to consumers):** using the metric to drive pacing /
adaptive difficulty; ML excitement prediction; automatic highlight editing.
These are separate work items that *consume* the recorded series.

## 2. What "action intensity" means

We want a scalar we can plot against time for a run, where "more is
happening on screen". Two properties distinguish a useful measure from a
naive object counter:

- **Presence** — how crowded the screen is right now (steady-state pressure).
- **Burstiness** — how spiky the change is (explosions, boss phases, deaths).

A raw "objects on screen" count captures presence but is insensitive to
moments; a pure event count captures bursts but ignores sustained crowding.
The decision below combines both.

We use **action intensity** as a deliberately neutral, game-logic term — it
is **not claimed to equal player excitement**. Player excitement is
affective and better ground-truthed with physiological signals
([§3.2](#32-player-experience--affective-modelling)); the metric is at best a
*proxy* that must be calibrated before it drives difficulty ([§9](#9-risks-limitations--calibration)).

## 3. Prior art

### 3.1 Pacing / director systems

- **Left 4 Dead AI Director (Valve, 2008)** is the canonical example. It
  computes a smoothed per-player *stress* / *intensity* from health, recent
  damage taken, whether the player is being attacked, and proximity/situational
  factors, then drives horde spawns, item placement and adaptive music with a
  **build-up / release** curve (Booth, *The AI Systems of Left 4 Dead*, GDC
  2009). The key ideas we borrow: a **scalar intensity**, an **exponential
  smoothing** over raw signals, and a separate **build-up/release** envelope.
- **Alien: Isolation (2014)** adapts the Alien's behaviour to player state
  rather than a fixed script; **Back 4 Blood** (a spiritual Left 4 Dead
  successor) and **Deep Rock Galactic** (a "director"-like wave director)
  are descendants of the same pattern.
- **Dynamic Difficulty Adjustment (DDA)** — Resident Evil 4, God Hand, the
  Mario Kart rubber-band AI — adapts challenge from performance metrics. DDA
  is the closest shipped precedent for *reacting* to intensity, and the reason
  a pacing consumer needs a stable, smoothed signal rather than per-frame
  noise.

### 3.2 Player-experience / affective modelling

- **Player Experience Modelling (PEM)** — Yannakakis & Hallam (2007; 2009)
  model satisfaction/arousal/frustration from gameplay metrics and
  physiological signals. Accurate but data-hungry and model-specific.
- **Psychophysiology of games** — Ravaja et al. (2006), Mandryk et al. (2006):
  event-locked electrodermal activity (EDA), heart rate (ECG) and muscle
  activity (EMG) as ground truth for "excitement". Excellent as *calibration*
  data, invasive at runtime — not a shipping signal.

### 3.3 Domain-specific density metrics

- **Bullet-hell / shmup design** — bullet density (bullets on screen, or
  bullets/second) is a standard quantitative difficulty axis (e.g. Touhou
  tooling). Directly analogous to the weighted object count.
- **Rhythm games** — note density (notes/second) drives the star-rating
  difficulty model in osu! and StepMania.
- **RTS / esports** — Actions Per Minute (APM), supply/unit counts as
  engagement proxies.
- **Adaptive / interactive music** — Wwise and FMOD expose an **Intensity**
  parameter that scales layered music from game state. A mature, shipped
  precedent for a single scalar "action" value driving output.

### 3.4 Video / highlight detection

- **NVIDIA ShadowPlay Highlights, Medal, Twitch Clips** — mostly use
  game-specific event hooks (kills, objectives) and/or audio-loudness and
  motion spikes. They are event/AV-driven rather than a game-logic metric.
- **Film / edit research** — action and edit intensity from shot length,
  motion vectors and audio RMS. The capture pipeline's existing probe is a
  crude cousin of this.

### 3.5 Physics / rendering proxies

- **Kinetic-energy metrics** — sum of `speed²·mass` over entities as a motion
  proxy.
- **Screen entropy / edge density** — renderer-side pixel statistics; cheap
  *from a recording*, unavailable to in-game logic. Audio loudness is the
  same story.

## 4. Alternative approaches compared

| # | Approach | What it measures | Deterministic | In-game available | Cost | Weakness |
|---|---|---|---|---|---|---|
| A | **Weighted on-screen object count** (seed proposal) | Steady crowding | Yes | Yes | O(entities) | Blind to bursts; no threat awareness |
| B | **Event-window intensity** | Discrete events in a sliding window (shots, hits, kills, explosions, pickups) | Yes | Yes | O(1) per event | Ignores steady crowding; sparse in quiet waves |
| C | **Player-stress model (AI-Director style)** | Player health, recent damage, incoming-bullet proximity, nearest-enemy distance | Yes | Yes | O(entities) | Measures *perceived pressure*, not population; tanking mutes it |
| D | **Physics / motion proxy** | Sum of entity speeds or kinetic energy + projectile count | Yes | Yes | O(entities) | Treats harmless drift and threatening movement alike |
| E | **Rendering / AV proxy** | Pixel entropy / edge density + audio loudness | No (encode-dependent) | **No** | High (render/encode) | Unavailable to in-game pacing; only usable post-hoc |
| F | **Hybrid layered metric** | Weighted count **+** event window, normalised, smoothed, with a burstiness derivative | Yes | Yes | O(entities) + O(1)/event | More to specify/tune than A — mitigated below |

All of A–D are deterministic and available to in-game logic. E is the only
one that is *not* available live, but it is the only one that is inherently
tied to what the player actually sees and hears — which is why the existing
capture pipeline uses a scaled-down version of it.

**Comparison verdict.**

- A alone is cheap and deterministic but flat: it cannot distinguish a
  steady-ish wave from a burst, and it counts a harmless drifting asteroid
  as equal to a dive-bomb.
- B alone captures the moments a highlight reel cares about but collapses
  between events (a long dense wave with few kills can read as "quiet").
- C is the best *perceived-pressure* signal but is player-relative and
  volatile; it is a strong candidate for a **second, later** signal (pacing),
  not for the canonical recording.
- D is dominated by A: motion without threat is not action.
- E is complementary (a post-hoc validation layer), not a substitute.

## 5. Decision

**Adopt approach F — a hybrid layered metric — as `actionIntensity`.**

Specifically:

1. **Layer 1 — weighted on-screen presence** (deterministic, per tick, from
   the shared core registries). This is the seed proposal, refined in
   [§6](#6-scoring-model).
2. **Layer 2 — event-window burst** over the discrete events the telemetry
   instrumentation child already records ([§3.3](#33-domain-specific-density-metrics)
   density reasoning; [§8](#8-telemetry-integration--gymgame-parity)).
3. **Aggregate** into a raw score and a normalised `intensity` in `[0, 1)`.
4. **Smooth** with an exponential moving average (EMA) to expose the
   Left-4-Dead-style trend, and expose a **`burstiness`** derivative for
   moment detection.
5. **Record** the series through the telemetry pipeline — no parallel path.

**Why not the simpler seed (A)?** Because the two headline consumers need
different things: a pacing system wants a *stable, smoothed* signal (EMA of
presence), while a highlight picker wants *peaks* (high `burstiness` /
`intensity`). F serves both from one recorded series at negligible extra
cost (O(entities) + O(1)/event).

**Why not C as the canonical metric?** The decision is that C is valuable but
belongs to a **later pacing** work item, layered *on top of* the recorded
presence+burst series. The recording should be as objective and
reproducible as possible; a player-stress scalar is better derived than
recorded as the primary artefact.

**Why not E?** It cannot drive in-game pacing and would re-introduce a
second, encode-dependent pipeline. E remains a **post-hoc calibration
check** ([§7.5](#75-joining-to-captured-video-for-highlight-selection), [§9](#9-risks-limitations--calibration)).

## 6. Scoring model

### 6.1 Object categories and weights

Weights are **dimensionless relative units**; only their ratio matters. The
seed weights are refined below. `n_c(t)` is the count of live objects in
category `c` at tick `t`.

| Category | Source registry (shared core / snapshot) | Seed | **Refined** | Rationale for the refined weight |
|---|---|---|---|---|
| Player bullets | `getPlayerBullets()` (`PlayerBullet`) | 1 | **0.5** | The ship auto-fires, so this is a near-constant baseline present in almost every sample. It carries little *marginal* information and would otherwise inflate every quiet frame; halving keeps it a mild contributor. |
| Enemy bullets | `getEnemyBullets()` (`CombatEnemyBullet`) | 1 | **1.0** | The primary readability / threat signal. Density scales with difficulty and is the shmup-analogue of bullet density ([§3.3](#33-domain-specific-density-metrics)); kept at seed weight as the reference unit. |
| Enemies | `getEnemies()` / `getAliveCount()` (`CombatEnemyEntity`) | 2 | **2.0** | Each enemy is a *persistent* threat **and** a fire source, so it is worth more than a single projectile. |
| Asteroids | enemies with archetype `asteroid` | 1 | **1.0** | Split out from "enemies" so an asteroid is not double-counted at weight 2. Mostly passive screen clutter; kept weight 1. |
| Upgrades / drops | `getDrops()` (`CombatDrop`) | 1 | **1.0** | Positive engagement moments (pickups) that are sparse and meaningful. |
| Enemy explosions | enemy destruction VFX | 2 | **2.0** | A burst of visual activity plus a reward cue. |
| Boss explosions | boss destruction / phase VFX | 5 | **5.0** | Larger, multi-frame, screen-dominating VFX. |
| Player explosions | `playerExplosions` + death juice | 20 | **20.0** | Rare and run-defining: camera shake, flash, debris and a shockwave (`PLAYER_DEATH_SEVERITY_*`). Deliberately dominant — losing a life should spike the metric. |
| Bosses | `getBoss()` (`Boss`) | 5 | **5.0** | A persistent, large presence with its own attack cadence. |

**Refinements vs. the seed:**

1. **Split bullets and asteroids out of grouped categories** (seed grouped
   "player/enemy bullets" and folded asteroids into generic objects) so each
   category has one unambiguous source and no double counting.
2. **Player bullets halved to 0.5** for the auto-fire baseline reason above.
3. **Weights become config/tunable** (defaults above) rather than hard-coded
   constants — the seed's subjective-weight risk is mitigated here.

Weights remain **subjective defaults**, chosen for ordering (impact ≫
presence) rather than calibrated precision; [§9](#9-risks-limitations--calibration)
requires calibration before the value drives difficulty. New content (mines,
new enemy types) adds a row/config entry, never a new code path.

### 6.2 Aggregation formula

Let `w_c` and `n_c(t)` be as above, and `cap_c` an optional generous
per-category cap (default `Infinity`, used to stop a pathological swarm from
drowning every other signal).

**Presence layer:**

```
P(t) = Σ_c  w_c · min( n_c(t), cap_c )
```

**Event-window layer.** Over a sliding window of width `W` (default **2.0 s**),
sum the discrete events the instrumentation child already emits, each with a
value `v_e`:

```
E(t) = Σ_{ e : t−W < t_e ≤ t }  v_e
```

Default event values (same units as the weights, tunable):

| Event | `v_e` | Rationale |
|---|---|---|
| `enemy_killed` | 2 | Matches the enemy presence weight it removes. |
| `player_hit` / `life_lost` | 20 | A life loss is the run-defining event (split for respawn vs fatal). |
| `boss_phase` | 5 | A phase transition is a scripted spike. |
| `powerup_collected` | 1 | Matches the drop presence weight it removes. |
| `wave_clear` / `level_clear` | 3 | A pacing beat (build-up → release). |
| `run_started` / `run_ended` | 0 | Bounds only, not action. |

**Combined raw score:**

```
R(t) = P(t) + k_E · E(t)
```

with `k_E` (default **1.0**) a tunable blend weight between presence and
burst.

### 6.3 Normalisation

Normalise with a **saturating hyperbola** rather than a hard clamp, so the
value is smooth, monotonic and bounded in `[0, 1)`:

```
intensity(t) = R(t) / ( R(t) + B )
```

where `B` is the **reference budget** (default **30**) — roughly the raw
score of a "busy but readable" screen. `B` is chosen so an average wave maps
to a middling intensity and only genuinely crowded/impactful moments approach
1.0.

Both the unbounded `rawScore = R(t)` and the bounded `intensity` are recorded
([§7](#7-recorded-artefact--schema)) so a consumer can choose. A consumer
that prefers a linear scale can recover `R = B·intensity/(1−intensity)`.

### 6.4 Smoothing and burstiness

The stable signal a pacing system wants is an exponential moving average; the
derivative is what a highlight picker wants.

```
S(t) = α · intensity(t) + (1 − α) · S(t−1)
α    = 1 − 2^(−Δt / h)                (Δt = 1 / sampleRateHz)
burstiness(t) = intensity(t) − S(t)   (positive ⇒ a spike above trend)
```

Default half-life `h = 0.5 s`. `S` is the "how hot is it overall" signal;
`burstiness` is the "something just happened" signal. `S(0) = intensity(0)`.

### 6.5 Sampling

- The metric is **computed every simulation tick** (O(entities) + O(1) per
  event) but **recorded at a bounded sample rate**, default **10 Hz**,
  independent of frame rate. This decouples the series size from render
  performance and matches the telemetry sampling model
  (`VITE_TELEMETRY_SAMPLE_RATE`).
- The telemetry `run_header` still carries the **run seed**, so any recorded
  sample is reproducible from the seeded run (given deterministic RNG — see
  the determinism gap in [§8.3](#83-determinism)).
- When telemetry is disabled the metric is a **strict no-op** (no allocation,
  no records) — it is computed only when a recorder is active.

### 6.6 Tuning

All knobs — weights, caps, `W`, `B`, `k_E`, `h`, sample rate — live in one
config object with the defaults above, documented at the definition site.
The values are **not** expected to be final; they are the starting point for
the calibration work in [§9](#9-risks-limitations--calibration).

## 7. Recorded artefact & schema

### 7.1 Primary record — rides the telemetry tick

The canonical recording reuses the telemetry pipeline: each sampled `tick`
record's opaque `state` object gains one field, `actionIntensity`, whose
shape is:

```jsonc
{
  "rawScore": 41.5,        // unbounded R(t)
  "intensity": 0.58,       // normalised [0,1)
  "smoothed": 0.49,        // EMA S(t)
  "burstiness": 0.09,      // intensity(t) − S(t)
  "breakdown": {           // per-category live counts n_c(t)
    "playerBullets": 4,
    "enemyBullets": 11,
    "enemies": 6,
    "asteroids": 0,
    "drops": 1,
    "enemyExplosions": 0,
    "bossExplosions": 0,
    "playerExplosions": 0,
    "bosses": 0
  }
}
```

Because this lives inside the versioned telemetry envelope, the **schema
version is already carried** by every record (`schemaVersion`, currently 1):
adding a field to `state` is a backwards-compatible payload change owned by
the instrumentation layer, not a framework schema bump. The concrete shape
above is owned by the instrumentation child
([§8](#8-telemetry-integration--gymgame-parity)).

### 7.2 Derived time-series artefact

For consumers that want the series alone (video editing, analysis), the run's
samples are serialised to a standalone **JSONL** file — one sample per line,
tolerant of partial runs and append-friendly:

```jsonc
{"schemaVersion":1,"runSeed":123456789,"sampleRateHz":10,"categories":["playerBullets","enemyBullets","enemies","asteroids","drops","enemyExplosions","bossExplosions","playerExplosions","bosses"]}
{"t":0,"tick":0,"rawScore":8.0,"intensity":0.21,"smoothed":0.21,"burstiness":0.0,"breakdown":{"playerBullets":3,"enemyBullets":0,"enemies":1,"asteroids":0,"drops":0,"enemyExplosions":0,"bossExplosions":0,"playerExplosions":0,"bosses":0}}
{"t":100,"tick":6,"rawScore":0.0,"intensity":0.31,"smoothed":0.24,"burstiness":0.07,"breakdown":{...}}
```

- **First line** is a self-describing header: `schemaVersion`, `runSeed`,
  `sampleRateHz`, and the ordered `categories` list (so a consumer can map
  the breakdown without hard-coding it).
- **Subsequent lines** are samples: `t` (ms since run start), `tick`
  (zero-based simulation tick), the four scores, and the `breakdown`.
- **Schema version** is on the header **and** on every sample line, so a
  truncated file is still self-identifying.

### 7.3 Location, format and naming

- **Format:** JSONL (primary, streaming) — optional gzip for size. A tiny
  aggregation step may also emit a JSON summary (min/max/mean, peak times)
  for quick inspection.
- **Location:** git-ignored output directory, alongside the capture output,
  e.g. `capture-output/<run-id>.action.jsonl`, where `<run-id>` matches the
  WebM basename (`capture-output/gameplay-<timestamp>.webm` →
  `gameplay-<timestamp>.action.jsonl`). Dev runs may alternatively write to
  the telemetry JSONL sink (`localStorage`) and export on demand.
- **Size bound:** at 10 Hz and ~120 B/sample, a 30-minute run is ≈ 18000
  samples ≈ 2.2 MB raw — negligible next to the WebM.

### 7.4 Run identity and clock anchor

Every artefact carries:

- `runSeed` — the per-run RNG seed, already in the telemetry run header
  (AH-0MUY08V6W001SJJN); it makes the series reproducible.
- `schemaVersion` — from the telemetry envelope.
- a run-start epoch timestamp — from the telemetry run header's
  `startedAt` (epoch ms), giving a common wall-clock anchor.
- `t` is **ms since run start**, so the series is independent of wall-clock
  drift and directly comparable across runs.

### 7.5 Joining to captured video for highlight selection

The capture pipeline (`scripts/capture-gameplay.mjs`,
[docs/dev/gameplay-capture.md](./gameplay-capture.md)) records from the
in-game demo and detects the end via the dev-gated `aihell:run-ended` signal.
The join needs a single shared clock anchor between the `t`-series and the
WebM playback timeline.

**Anchor:** record a dev-gated **`capture_started`** marker (epoch ms) at the
moment `MediaRecorder` starts — the same injection point that already hosts
the run-end listener. Then, for a WebM whose first frame is `capture_started`:

```
videoTimeMs(t)  ≈  t − ( capture_started − run_startedAt )
```

Because the first recorded sample may predate `capture_started` (warm-up), a
consumer clamps at 0. If the marker is absent (e.g. an older capture), fall
back to the telemetry `startedAt` plus the known `--warmup` value, and flag
the join as approximate.

**Highlight recipe** (for the video-editor consumer):

1. Read `<run-id>.action.jsonl` and the matching WebM.
2. Compute peak windows: contiguous samples where `burstiness ≥ θ` and/or
   `intensity ≥ I_hi`, merged within a gap of `g` seconds.
3. Map each window to `[videoTimeMs(t_start) − lead, videoTimeMs(t_end) + tail]`
   (defaults: `lead = 1.5 s`, `tail = 1.0 s`) so the clip has context.
4. Emit the list of clip ranges (and optionally cut with a full `ffmpeg` if
   present — see the capture doc's MP4 note).

Defaults: `θ = 0.15`, `I_hi = 0.7`, `g = 1.0 s`. These are starting points;
the calibration work in [§9](#9-risks-limitations--calibration) tunes them
against human-selected highlights.

## 8. Telemetry integration & gym↔game parity

### 8.1 Dependencies

| Dependency | Relationship |
|---|---|
| **AH-0MUY089KR003F8S4** — Realistic demo/attract bot framework + playtester telemetry (epic) | The parent epic; `actionIntensity` is recorded **through** its telemetry pipeline. |
| **AH-0MUY08VJ9006BHJO** — Telemetry framework: versioned schema, pluggable sinks, consent flag (child) | Provides the versioned envelope, sinks and consent gating this metric rides on. |
| **AH-0MUY08VVQ007HSSH** — Game telemetry instrumentation: per-tick state and events (child) | The canonical integration point: `actionIntensity` becomes a field of the per-tick `state` vector, and the event-window layer consumes the discrete events it records. |
| **AH-0MUY08W7Y004GATZ** — Dev recording, analysis and replay/ghost tooling | Consumer that serialises/analyses the derived time series. |
| **AH-0MUWMFF3C002WOBK** — Automated gameplay capture spike | Consumer that joins the series to captured WebM. |

**Priority confirmation:** the telemetry items
(AH-0MUY089KR003F8S4 / AH-0MUY08VJ9006BHJO / AH-0MUY08VVQ007HSSH) are
verified at **`high`** priority, satisfying the operator's requirement that
telemetry remain at least `high` (Appendix Q2 of AH-0MUZCSJXQ004TREN). No
priority change is required.

### 8.2 Integration point

1. A **pure** `computeActionIntensity(state, config)` function lives in the
   **shared core** (`src/scenes/core/`), taking a minimal structural state
   (counts + events) and returning the sample shape in
   [§7.1](#71-primary-record--rides-the-telemetry-tick).
2. The instrumentation child builds the per-tick telemetry `state` from the
   existing `BotSnapshot` builder (`src/ai/botSnapshot.ts`) — the natural
   place to add `actionIntensity`, since `BotSnapshot` already exposes
   `player`, `enemies`, `enemyBullets`, `playerBullets`, `drops`, `minerals`,
   `boss` and the seed.
3. The recorder calls the pure function once per sampled tick and folds the
   result into `state`; the derived JSONL is produced by the analysis tooling
   from the same stream (no second computation).

This **reuses, never duplicates**: one counter, one schema, one sink path.

### 8.3 Determinism

`computeActionIntensity` is a **pure function** of (a) the live entity
counts and (b) the events since the last sample, both already part of the
seeded run. Given a fully seeded run it is reproducible. Today wave/spawn RNG
is only partially seeded (see the *Determinism gaps* section of
[docs/dev/gameplay-capture.md](./gameplay-capture.md)); the metric inherits
that gap and does not widen it. It introduces **no new RNG**.

### 8.4 Gating

- The metric is a **no-op when telemetry is disabled** — it is only computed
  when a recorder is active, mirroring the framework's strict no-op contract.
- Any game→tooling signal used for the video join (`capture_started`) is
  gated behind `import.meta.env.DEV`, mirroring
  `src/core/runEndedSignal.ts` and `src/core/devScenario.ts`, so it never
  enters the shipped production bundle.
- The standalone JSONL artefact is written by **tooling**, never `src/`, so
  it cannot bloat the shipped bundle.

### 8.5 Gym↔game parity

Per the repo convention
([docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md](./../ENEMY_DESIGN_AND_IMPLEMENTATION.md)
§5.1), the counter is authored **once** in the shared core
(`src/scenes/core/`) and consumed by both `PlayScene` and the gym scenes —
never a divergent copy. The implementation epic must:

- read only shared, already-tracked registries;
- ensure the shared core exposes a single count-able registry (or per-kind
  live counters) for **enemy/boss explosion VFX**, so explosion categories are
  not double-bookkept; player explosions are already tracked in
  `CombatCoreScene.playerExplosions`;
- satisfy the duplicate-body guard in
  `src/scenes/core/CombatScene.equivalence.test.ts`.

## 9. Risks, limitations & calibration

| Risk / limitation | Mitigation |
|---|---|
| **Metric ≠ excitement.** Object count is a proxy; it can rate a busy-but-boring screen highly (and vice versa). | State this explicitly; require **calibration** against human ratings or physiological data ([§3.2](#32-player-experience--affective-modelling)) before it drives difficulty. Treat E (AV proxy) as a cross-check. |
| **Subjective weights.** The refined weights are ordered defaults, not measured. | Weights are **config-driven and tunable**; calibration updates the config. |
| **Bursty vs. steady under-weighting.** | The event-window layer + `burstiness` derivative counter this; both present and burst are recorded. |
| **Duplicate instrumentation / scope creep.** | Mandatory reuse of the telemetry pipeline; shared-core placement; parity guard. |
| **Performance / bundle impact.** | O(entities), 10 Hz sampling, no-op when disabled, tooling-only file writes, `import.meta.env.DEV` gating. |
| **Capture de-sync.** | Shared clock anchor (`run_startedAt` + dev-gated `capture_started` marker); `t` in ms since run start. |
| **Reader drift on schema change.** | `schemaVersion` on header **and** every sample; telemetry `isTelemetryRecord` guard. |

The **calibration task** (a follow-up, not this item): collect short labelled
clips (human "highlight / boring" ratings) and fit/check the weights,
`B`, `θ` and `I_hi`. Until then the metric is advisory, never a difficulty
driver.

## 10. Follow-up implementation epic

The implementation is tracked as a **sibling epic** of this research item,
**Implement on-screen action intensity metric (recording + video join)**
(**AH-0MUZMTTYH008KVS2**), linked via
`discovered-from:AH-0MUZCSJXQ004TREN`, so this decision can be recorded and
closed without waiting for implementation. The epic:

- adds the pure `computeActionIntensity` module + config to the shared core;
- wires `actionIntensity` into the telemetry per-tick `state` via the
  instrumentation child (AH-0MUY08VVQ007HSSH);
- adds the derived JSONL serialiser + the dev-gated `capture_started` marker;
- adds the highlight-selection helper for the capture pipeline;
- carries its own acceptance criteria and its dependency on the telemetry
  items above.

See AH-0MUZMTTYH008KVS2 for the epic's full acceptance criteria (created by
AH-0MUZCSJXQ004TREN AC5).

## 11. References

- Booth, M. *The AI Systems of Left 4 Dead.* GDC 2009 (Valve).
- Yannakakis, G. N., & Hallam, J. *Modeling and Augmenting Gameplay: A
  Preference Learning Approach.* 2007; *Real-time Game Adaptation for
  Optimizing Player Satisfaction.* IEEE TCIAIG, 2009.
- Ravaja, N., et al. *Phasic Emotional Reactions to Video Game Events.*
  2006. Mandryk, R., et al. *Using Psychophysiological Techniques to Measure
  User Experience.* 2006.
- osu! / StepMania beatmap difficulty (note density); Touhou / Danmakufu
  bullet-density tooling; Wwise/FMOD **Intensity** parameter; RTS APM.
- NVIDIA ShadowPlay Highlights, Medal, Twitch Clips (event/AV highlight
  detection).
- AI_Hell: [docs/dev/gameplay-capture.md](./gameplay-capture.md),
  [docs/TELEMETRY.md](../TELEMETRY.md),
  [docs/Game Design Document.md](../Game%20Design%20Document.md),
  [docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md](../ENEMY_DESIGN_AND_IMPLEMENTATION.md)
  §5.1 (gym↔game parity).
