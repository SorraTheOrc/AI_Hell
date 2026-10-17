# Enemy audio balance — `tf analyze` report (AC1)

Deterministic pre-change amplitude/spectral baseline for the enemy cue set, produced by the
**Balance the levels of all enemy sounds (AH-0MVAUU594007S92Q)** epic. Child item:
**Analysis report: enemy cue tf analyze metrics (AC1) (AH-0MVCRR10A001OM2K)**.

> This revision documents the **pre-change (as-committed) baseline** of the 27 enemy cue assets.
> The post-change section (§4) is populated once the recipe rebalance (AC2), scale snapping
> (AC3) and Scout-fire replacement (AC4) child items land and the enemy set is re-rendered.

## 1. Method (deterministic)

- **Tool:** ToneForge `tf analyze` (ToneForge **v0.1.0** as reported by `tf version`;
  installed package metadata `node_modules/toneforge` 0.1.2, pinned revision
  `5934fb0a0835e8b6ee8297a3a28f51e811b50b0b` in `audio/toneforge/pin.json`)
- **Invocation:** `tf analyze --input <asset>.wav --json` — one call per committed enemy asset
- **Sample rate:** 44 100 Hz, 16-bit PCM (as rendered by `npm run build-audio:render`)
- **Analysis version:** `1.0` (reported per file by the tool)
- **Metrics:** peak (linear), RMS (linear, full signal), crest factor = peak / RMS, spectral
  centroid (Hz), duration (s). Clipping/silence flags noted when non-default.
- **Set:** 20 enemy cue entries in `audio/toneforge/manifest.json` expanding to **27 committed
  assets** in `public/audio/sfx/` (multi-seed variant ranges: `aihell-enemy-destruction` ×3,
  `aihell-diver-destruction` ×3, `aihell-boss-phase-cue` ×4).
- The exact command sequence used to regenerate the raw JSON:

```bash
tf analyze --input public/audio/sfx/aihell-enemy-spawn.32101.wav --json
# … repeated for every asset in the table below (27 files) …
```

## 2. Pre-change baseline (as-committed assets)

Per-asset metrics for every committed enemy cue asset. Assets are grouped by their parent
brief's category tier (ambience / subtle / heavy) for the AC2 discussion.

| Cue (manifest entry) | Recipe / asset | Seed | Duration (s) | Peak | RMS | Crest factor | Spectral centroid (Hz) |
|---|---|---|---|---|---|---|---|
| playDiveSound | `aihell-diver-dive-loop.32191.wav` | 32191 | 2.000 | 0.0590 | 0.0137 | 4.312 | 4090.3 |
| playSpawnSound | `aihell-enemy-spawn.32101.wav` | 32101 | 0.180 | 0.1200 | 0.0680 | 1.764 | 3943.0 |
| playTankAdvanceCue | `aihell-tank-advance.32140.wav` | 32140 | 0.600 | 0.1791 | 0.0910 | 1.969 | 3367.6 |
| playScoutAdvanceCue | `aihell-scout-advance.32180.wav` | 32180 | 0.600 | 0.0800 | 0.0564 | 1.417 | 1015.3 |
| playPhaserAdvanceCue | `aihell-phaser-advance.32170.wav` | 32170 | 0.600 | 0.0800 | 0.0564 | 1.417 | 744.8 |
| playPhaserFireSound | `aihell-phaser-fire.32171.wav` | 32171 | 0.100 | 0.1189 | 0.0358 | 3.323 | 1848.0 |
| playDiverFireSound | `aihell-diver-fire.32192.wav` | 32192 | 0.100 | 0.1451 | 0.0443 | 3.279 | 3566.5 |
| playSwarmBurstSound | `aihell-swarm-burst.32160.wav` | 32160 | 0.200 | 0.1466 | 0.0376 | 3.893 | 2619.8 |
| playScoutFireSound | `weapon-laser-zap.1.wav` | 1 | 0.108 | 0.9774 | 0.2985 | 3.275 | 550.4 |
| playDiverDiveStartSound | `aihell-diver-dive-start.32190.wav` | 32190 | 0.250 | 0.1431 | 0.0688 | 2.080 | 3702.1 |
| playBulletDestructionSound | `aihell-bullet-destruction.32130.wav` | 32130 | 0.070 | 0.1200 | 0.0665 | 1.805 | 6560.1 |
| playDestructionSound | `aihell-enemy-destruction.32110.wav` | 32110 | 0.280 | 0.2896 | 0.0983 | 2.948 | 3622.7 |
| playDestructionSound | `aihell-enemy-destruction.32111.wav` | 32111 | 0.280 | 0.2896 | 0.0983 | 2.946 | 3693.4 |
| playDestructionSound | `aihell-enemy-destruction.32112.wav` | 32112 | 0.280 | 0.2899 | 0.0983 | 2.950 | 3634.8 |
| playDiverDestructionSound | `aihell-diver-destruction.32193.wav` | 32193 | 0.370 | 0.3055 | 0.0852 | 3.584 | 3205.5 |
| playDiverDestructionSound | `aihell-diver-destruction.32194.wav` | 32194 | 0.370 | 0.3062 | 0.0852 | 3.592 | 3228.0 |
| playDiverDestructionSound | `aihell-diver-destruction.32195.wav` | 32195 | 0.370 | 0.3056 | 0.0852 | 3.585 | 3119.6 |
| playBossDestructionSound | `aihell-boss-destruction.32203.wav` | 32203 | 0.600 | 0.2198 | 0.1275 | 1.724 | 2986.4 |
| playTankFireSound | `aihell-tank-fire.32141.wav` | 32141 | 0.370 | 0.4647 | 0.1209 | 3.845 | 2641.7 |
| playBossFireSound | `aihell-boss-fire.32200.wav` | 32200 | 0.220 | 0.4012 | 0.1041 | 3.854 | 2824.9 |
| playBossHitSound | `aihell-boss-hit.32208.wav` | 32208 | 0.160 | 0.4466 | 0.0954 | 4.683 | 4792.2 |
| playBossPhaseCue | `aihell-boss-phase-cue.32204.wav` | 32204 | 0.300 | 0.1000 | 0.0976 | 1.024 | 5700.8 |
| playBossPhaseCue | `aihell-boss-phase-cue.32205.wav` | 32205 | 0.300 | 0.1000 | 0.0977 | 1.024 | 5696.6 |
| playBossPhaseCue | `aihell-boss-phase-cue.32206.wav` | 32206 | 0.300 | 0.1000 | 0.0977 | 1.024 | 5698.8 |
| playBossPhaseCue | `aihell-boss-phase-cue.32207.wav` | 32207 | 0.300 | 0.1000 | 0.0977 | 1.024 | 5703.8 |
| playBossSpawnSound | `aihell-boss-spawn.32201.wav` | 32201 | 0.450 | 0.1779 | 0.0732 | 2.429 | 139.7 |
| playBossPhaseTransitionSound | `aihell-boss-phase-transition.32202.wav` | 32202 | 0.350 | 0.1200 | 0.0686 | 1.749 | 3962.4 |

### 2.1 Pre-change spread (the problem statement)

The parent brief's headline figures are reproduced over the 26 non-outlier cues (every enemy
cue except the existing-recipe Scout fire shot, which is called out separately below; the
brief's "26-cue set" counts the pre-change asset files excluding `weapon-laser-zap.1.wav` —
27 committed enemy WAVs total, per §1):

- **Peak spread ≈ 7.9×** — min peak **0.059** (`aihell-diver-dive-loop.32191.wav`), max peak
  **0.465** (`aihell-tank-fire.32141.wav`)
- **RMS spread ≈ 9.3×** — min RMS **0.014** (`aihell-diver-dive-loop.32191.wav`), max RMS
  **0.128** (`aihell-boss-destruction.32203.wav`)

Including the Scout fire outlier the full 27-asset spread is ≈ **16.6× peak** and
≈ **21.8× RMS** — the outlier dominates the set's dynamic range.

### 2.2 Scout fire — the near-clipping outlier (AC4 target)

| Asset | Peak | RMS | Crest factor | Duration (s) |
|---|---|---|---|---|
| `weapon-laser-zap.1.wav` | **0.977** (near-clipping) | **0.298** | 3.27 | 0.108 |

- Peak **0.977** approaches the digital ceiling (1.0) — headroom ≈ 0.2 dB; the asset is the
  single worst offender and is ~2.3× louder (RMS) than the next loudest enemy cue
  (`aihell-boss-destruction.32203.wav`, RMS 0.128) and ~3.5× the median non-outlier RMS
  (0.085).
- Runtime `TANK_SCOUT_FIRE_VOLUME_SCALE` (0.5×) mitigates playback level but does not fix the
  baked asset's headroom; AC4 replaces it with an in-repo balanced recipe.
- `tf analyze` reports `clipping: false` (the peak is < 1.0) but the margin is negligible; after
  the 0.5× runtime scale the effective peak ≈ 0.49.

## 3. Amplitude tiers (AC2 targets, from the parent brief)

| Tier | Category RMS target | Cues |
|---|---|---|
| Ambience | ≤ 0.02 | `aihell-diver-dive-loop` (`playDiveSound`) |
| Subtle one-shots | 0.055 (±1.5 dB) | spawn, tank/scout/phaser advance, phaser fire, diver fire, swarm-burst, Scout fire (post-AC4), dive-start, bullet-destruction |
| Heavy one-shots | 0.090 (±1.5 dB) | enemy/diver/boss destruction, tank fire, boss fire/hit/phase-cue/spawn, boss-phase-transition |

All peaks must be ≤ **0.50** (AC2), and the multi-seed variant ranges (`enemy-destruction`,
`diver-destruction`) must stay within < 0.5 dB of each other.

## 4. Post-change values (revision — pending AC2/AC3/AC4)

- **Revision note:** this section is **pending**. It will be filled in, in the **same format as §2**
  (per-asset table: cue / asset / seed / duration / peak / RMS / crest factor / spectral centroid)
  with the revision marked, once the AC2 (amplitude tiers), AC3 (A-minor scale snapping) and
  AC4 (Scout fire replacement) implementation children land and `npm run build-audio:render`
  regenerates the enemy set. The pre-change spread figures in §2.1 and §2.2 are the comparison
  baseline; the post-change revision must re-quote both so the delta is auditable.

_No post-change values yet — the rebalance commits have not landed at the time of writing._

## 5. Reproducibility

- The raw per-file JSON produced by `tf analyze` (27 files) is byte-deterministic for a given
  committed asset set; re-running the §1 invocation against the same WAVs reproduces the table
  exactly.
- Checksum set: `public/audio/sfx/checksums.json` (see Deterministic WAV build pipeline,
  AH-0MUTYV8FU007X7JD).
