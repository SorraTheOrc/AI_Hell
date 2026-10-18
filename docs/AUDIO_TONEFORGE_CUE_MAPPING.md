# Audio cue-to-recipe mapping (ToneForge migration)

Authoritative cue catalogue for the migration of the game's SFX from the
hand-rolled procedural Web Audio in `src/audio/effects.ts` to build-time baked
ToneForge WAV assets consumed by Phaser.

- **Parent epic:** Switch game audio from procedural Web Audio to ToneForge (AH-0MUTUOB7X007PR9J)
- **Produced by:** Cue-to-recipe mapping and unused-cue audit (AH-0MUTYV7SQ005HURT)
- **ToneForge reference:** required sibling checkout `../ToneForge`, version 0.1.1, MIT licence
- **Related:** GDD §7.3 (Audio Direction), `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §7

> **Build prerequisite.** ToneForge is a **required** build dependency: the
> sibling `../ToneForge` checkout is declared under `dependencies` in
> `package.json` as `file:../ToneForge` (`.npmrc` sets `install-links=true` so
> npm packs it as a regular dependency and the lockfile stays consistent
> between npm 9 and npm 10). `npm ci` / `npm install` therefore fail when the
> sibling is absent. The pinned revision is recorded in
> `audio/toneforge/pin.json`; the Pages deploy workflow clones it at that
> revision before running `npm ci`.

This document is the input to **Author game-specific ToneForge recipes
(AH-0MUTYV8480019Z51)**, the **Deterministic WAV build pipeline
(AH-0MUTYV8FU007X7JD)** and the **Rewrite effects.ts to Phaser playback
(AH-0MUTYV92Y000WJ8Z)**.

> **Proposed slugs use an `aihell-` prefix** because the ToneForge catalogue is
> shared and currently card-game oriented; the prefix guarantees no collision
> with existing recipes and makes the game-owned set obvious. Slugs become
> ToneForge ToneGraph recipe YAML or stack/sequence preset JSON as noted.

## Method

Every exported function in `src/audio/effects.ts` was enumerated from the
source (58 exports: 46 cue functions, plus helpers, control functions and test
accessors). For each cue:

1. The original synthesis character was taken from the source constants and
   JSDoc (waveform, contour, duration, nominal volume) and cross-checked against
   GDD §7.3.
2. Production consumers were found with a call-site search across `src/`
   excluding `*.test.ts` and `src/audio/effects.ts`, e.g.
   `grep -rlE "\bplayCannonFireSound\(" src --include='*.ts'`.
3. A single disposition was assigned from exactly one of
   **`existing-recipe`**, **`new-recipe`**, or **`retired`**.

Only one cue still maps to an existing ToneForge recipe (`card-token-earn`);
the former `weapon-laser-zap` scout-fire mapping was swapped to the in-repo
`aihell-scout-fire` recipe under AC4 (AH-0MVCRR2H2007VPDU); the remainder
need game-specific recipes or stacks because the shipped catalogue is
card-game oriented. Three cues are retired.

## Disposition summary

| Disposition | Count | Notes |
|-------------|-------|-------|
| `existing-recipe` | 2 | Power-up collect chime (`card-token-earn`), volume-feedback (reuses the `aihell-player-hull-breach` recipe) |
| `new-recipe` | 38 | Game-specific cues in `effects.ts` (incl. scout fire `aihell-scout-fire` since AC4), plus the thruster hum |
| `new-recipe` (outside `effects.ts`) | 4 | `Boss.ts` inline cues using `blip()` — see the Boss.ts section |
| `retired` | 3 | `playMajorExplosionSound`, `playTankDestructionSound`, `playWeaponChangeSound` |
| control companion (in cue table) | 2 | `stopDiveSound`, `stopThrusterSound` — start/stop lifetime mapping |

> `blip`, `explosionPitchFactor`, `setSfxVolume`, `setSfxMuted`,
> `getAudioContext` and the test accessors are **not cues** and are handled in
> the control/helper section below.

> `stopThrusterSound` / `stopDiveSound` are start/stop control companions to
> their continuous cues; they are listed in the cue table because the AC names
> them, and they need a playback-lifetime mapping rather than a separate recipe.

## Cue-to-recipe mapping table

Legend — **Disp.**: `existing` = existing ToneForge recipe, `new` = author a
game-specific recipe/stack, `retired` = removed in the migration.

| Cue (`src/audio/effects.ts`) | Original character | GDD §7.3 | Production consumer(s) | Disp. | Target recipe / preset |
|------------------------------|--------------------|----------|------------------------|-------|------------------------|
| `playSpawnSound` | Rising square blip 220→880 Hz, 0.18 s, vol 0.12 | Enemy spawn (subtle hum rise) | `PlayScene`, `GymFormationScene`, `GymPowerUpsCombat`, `GymLevel` | new | `aihell-enemy-spawn` |
| `playDestructionSound` | Descending saw 440→60 Hz (× ±15 % pitch jitter), 0.28 s, vol 0.30 | Enemy destroyed (sharp pop/crack), scheduled on the next 16th-note beat accent | `PlayScene`, `CombatScene`, `GymFormationScene`, `enemyFactory`, `Asteroid`, `Scout`, `Phaser`, `Diver`, `playerDeathJuice` | new | `aihell-enemy-destruction` (multi-seed) |
| `playPlayerDestructionSound` | Layered hull breach: saw thump 120→32 Hz 0.4 s + triangle body 260→42 Hz 0.6 s + HP noise tail 0.28 s, ≤ 0.2 | Player hit / life lost, scheduled on the next 16th-note beat accent | `vfx/playerDeathJuice` | new | `aihell-player-hull-breach` (stack) |
| `playMajorExplosionSound` | Layered major blast: saw thump 150→26 + triangle body 340→38 + LP noise tail, 4-voice limiter | Wave timeout — retained but unused | **none** | **retired** | — (see Retired cues) |
| `playBulletDestructionSound` | Square tick 1400→900 Hz, 0.07 s, vol 0.12 | Player bullet destroys enemy bullet | `vfx/bulletImpact` | new | `aihell-bullet-destruction` |
| `playTankDestructionSound` | Saw 220→30 Hz, 0.45 s, vol 0.2 | Intentionally unwired | **none** (test-only) | **retired** | — (see Retired cues) |
| `playTankAdvanceCue` | Advancing saw 150→320 Hz + square sub 75→160 Hz, 0.6 s; runtime volume ×0.5 (`TANK_SCOUT_FIRE_VOLUME_SCALE`, AH-0MV74ROYR009X8U3) | Advance cue (≥ 500 ms) | `entities/Tank` | new | `aihell-tank-advance` |
| `playTankFireSound` | Heavy saw+sine cannon thump ~90→25 Hz, scheduled at cue end; runtime volume ×0.5 (`TANK_SCOUT_FIRE_VOLUME_SCALE`, AH-0MV74ROYR009X8U3) | Enemy fire / no-gap | `entities/Tank` | new | `aihell-tank-fire` |
| `playPowerUpSpawnSound` | Bright ascending blip (higher than enemy spawn) | Power-up spawn (advance) | `GymWeapons`, `GymWeaponLeveling` | new | `aihell-pickup-spawn` |
| `playPowerUpDespawnSound` | Quick descending blip, lower vol, shorter | Power-up despawn | `GymWeapons`, `GymWeaponLeveling` | new | `aihell-pickup-despawn` |
| `playPowerUpCollectSound` | Cheerful two-tone ascending chime | Power-up pickup | `dropLayer` | **existing** | `card-token-earn` |
| `playPowerUpCollectPopSound` | Saw 600→100 Hz + filtered noise transient, ≤ 0.08 s | Power-up pickup (tactile pop) | `dropLayer` | new | `aihell-pickup-pop` |
| `playWeaponChangeSound` | Distinctive whoosh ("armed with new weapon") | Weapon change | **none** (no call sites) | **retired** | — (see Retired cues) |
| `playSwarmBurstSound` | Saw buzz 120→80 Hz + sine whoosh 200→600 Hz, ~0.2 s | Swarm volley buzz | `entities/Swarm` | new | `aihell-swarm-burst` |
| `playPhaserAdvanceCue` | Rising sine 660→880 Hz, 0.6 s | Advance cue (≥ 500 ms) | `entities/Phaser` | new | `aihell-phaser-advance` |
| `playPhaserFireSound` | Triangle 1000→500 Hz, ~0.08 s, scheduled at cue end | Enemy fire / no-gap | `entities/Phaser` | new | `aihell-phaser-fire` |
| `playScoutAdvanceCue` | Rising sine, pitched above Phaser, 0.6 s; runtime volume ×0.5 (`TANK_SCOUT_FIRE_VOLUME_SCALE`, AH-0MV74ROYR009X8U3) | Advance cue (≥ 500 ms) | `entities/Scout`, `entities/OrbitalStrike` | new | `aihell-scout-advance` |
| `playScoutFireSound` | High square laser sweep, scheduled at cue end; runtime volume ×0.5 (`TANK_SCOUT_FIRE_VOLUME_SCALE`, AH-0MV74ROYR009X8U3) | Enemy fire / no-gap | `entities/Scout` | new | `aihell-scout-fire` (since AC4, AH-0MVCRR2H2007VPDU) |
| `playDiverDiveStartSound` | Rising saw 150→600 Hz + filtered noise, ~0.25 s | Dive danger cue | `entities/Diver` | new | `aihell-diver-dive-start` |
| `playDiveSound` | Bandpass noise sweep 300→900 Hz, refcounted shared ~2 s voice | Diver dive | `entities/Diver` | new | `aihell-diver-dive-loop` |
| `stopDiveSound` | Stops/releases the shared dive voice | Diver dive | `entities/Diver` | control | (companion to `aihell-diver-dive-loop`) |
| `playDiverFireSound` | Saw 280→120 Hz, 0.08 s | Enemy fire (spread burst) | `entities/Diver` | new | `aihell-diver-fire` |
| `playDiverDestructionSound` | Saw 280→40 Hz + sine undertone, 0.35 s (× pitch jitter) | Enemy destroyed (heavy), scheduled on the next 16th-note beat accent | `entities/Diver` | new | `aihell-diver-destruction` (multi-seed) |
| `playBossFireSound` | Saw 200→50 Hz + low sine undertone, ~0.2 s | Boss fire | `entities/Boss` | new | `aihell-boss-fire` |
| `playBossHitSound` | Punchy saw impact 320→60 Hz + square click + HP noise crack, ~0.16 s | Boss per-hit feedback | shared boss feedback path (wired by AH-0MUZMTTPE0074X59) | new | `aihell-boss-hit` |
| `playCannonFireSound` | Square 800→400 Hz, ~0.08 s, vol 0.15 | Player cannon fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-cannon-fire` |
| `playCannonImpactSound` | Punchy saw impact 520→90 Hz + square click + HP noise smack, ~0.13 s | Player cannon hit (when a shot connects) | shared impact seam in `CombatScene` (AH-0MV8228YW0050IXS) | new | `aihell-cannon-impact` |
| `playSpreadImpactSound` | Warm amber triangle wedge 900→150 Hz + soft noise tick, ~0.14 s | Player spread hit (when a shot connects) | shared impact seam in `CombatScene` (AH-0MV8229B9009DQGA) | new | `aihell-spread-impact` |
| `playSpreadFireSound` | Triangle 600→1200→800 Hz, ~0.12 s, vol 0.15 | Player spread fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-spread-fire` |
| `playDualFireSound` | Saw 900→300 Hz + offset sine tick, ~0.06 s | Player dual fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-dual-fire` |
| `playDualImpactSound` | Bright twin square snap 1400→600 Hz + sine echo + HP noise tick, ~0.11 s | Player dual hit (when either twin bar connects) | shared impact seam in `CombatScene` (AH-0MV8229NM009CZOA) | new | `aihell-dual-impact` |
| `playRapidImpactSound` | Tight staccato square tick 2400→1100 Hz + thin triangle shimmer + HP noise tap, ~0.06 s | Player rapid hit (when a shot connects) | shared impact seam in `CombatScene` (AH-0MV822A03006UT2P) | new | `aihell-rapid-impact` |
| `playRapidFireSound` | Triangle 500→900 Hz, ~0.05 s, vol 0.12 | Player rapid fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-rapid-fire` |
| `playNovaFireSound` | Saw 160→40 Hz + rising triangle ring 300→1800 Hz | Player Nova fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-nova-fire` |
| `playNovaImpactSound` | Bright expanding ring ping — triangle 1600→300 Hz + light HP noise shimmer, ~0.16 s | Player Nova ring connect | shared AOE VFX seam in `CombatScene` (AH-0MV822BPT002GF17) | new | `aihell-nova-impact` |
| `playMortarFireSound` | Muffled triangle 220→90 Hz + high barrel tick | Player Mortar fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-mortar-fire` |
| `playMortarImpactSound` | Sharp dry shell-impact crack — triangle 900→150 Hz + HP noise smack, ~0.12 s | Player Mortar shell lands / blast connects | shared AOE detonation seam in `CombatScene` (AH-0MV822C250051OVN) | new | `aihell-mortar-impact` |
| `playMortarDetonationSound` | Heavy saw 180→40 Hz + LP noise wash | Mortar detonation | `CombatScene` | new | `aihell-mortar-detonation` |
| `playArcFireSound` | Square 1400→500→1120 Hz + HP noise crackle | Player Arc fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-arc-fire` |
| `playArcImpactSound` | Sharp electric crack — saw 2400→900→220 Hz + fast HP noise zipper, ~0.14 s | Player Arc bolt connects / chains | shared AOE chain seam in `CombatScene` (AH-0MV822CE7004MQ14) | new | `aihell-arc-impact` |
| `playWaveLaserFireSound` | High-energy square beam crack 1200→600 Hz with a brief sustain, ~0.1 s | Player wave-laser fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` (via `playWeaponFireSound`) | new | `aihell-wave-laser-fire` |
| `playWaveLaserImpactSound` | Sharp neon snap — saw 800→200 Hz + square click + BP noise crack, ~0.12 s | Player wave-laser hit (when the beam connects) | shared impact seam in `CombatScene` (AH-0MV822ACO007CEZF) | new | `aihell-wave-laser-impact` |
| `playRicochetFireSound` | Bright springy ping — triangle 1400→500 Hz + square tick, ~0.1 s | Player ricochet fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` (via `playWeaponFireSound`) | new | `aihell-ricochet-fire` |
| `playRicochetImpactSound` | Soft high bounce tick — triangle 1800→900 Hz + HP noise smack, ~0.09 s | Player ricochet wall bounce or connect | shared impact seam in `CombatScene` (AH-0MV822AP1006W2F9) | new | `aihell-ricochet-impact` |
| `playClusterFireSound` | Low missile launch — square 300→90 Hz + swept lowpass noise whoosh + bright ignition click, ~0.16 s | Player cluster-missile fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` (via `playWeaponFireSound`) | new | `aihell-cluster-fire` |
| `playClusterImpactSound` | Heavy detonation thump — saw 260→60 Hz + lowpass noise smack, ~0.18 s | Player cluster-missile shell/warhead connect | shared impact seam in `CombatScene` (AH-0MV822B1B0048UZT) | new | `aihell-cluster-impact` |
| `playOptionsFireSound` | Bright soft two-tone twinkle — triangle 900→1600 Hz + light sine overtone, ~0.07 s | Player options pod-volley fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` (via `playWeaponFireSound`) | new | `aihell-options-fire` |
| `playOptionsImpactSound` | Soft bright aqua pop — triangle 1300→550 Hz + light HP noise tick, ~0.11 s | Player options pod-shot connect | shared impact seam in `CombatScene` (AH-0MV822BDN008IYL6) | new | `aihell-options-impact` |
| `playSpreadPickupSound` | Triangle 500→1500→800 Hz, ~0.15 s | Spread pickup | `dropLayer` | new | `aihell-pickup-spread` |
| `playDualPickupSound` | Saw 1000→500 then 1200→700 Hz, 0.06 s apart | Dual pickup | `dropLayer` | new | `aihell-pickup-dual` |
| `playRapidPickupSound` | Triangle 400→1600 Hz, 0.1 s | Rapid pickup | `dropLayer` | new | `aihell-pickup-rapid` |
| `playResetPickupSound` | Sine 900→300 Hz, ~0.2 s | Reset pickup | `dropLayer` | new | `aihell-pickup-reset` |
| `playSpeedBoostCollectSound` | Square 600→1800 Hz, 0.1 s | Speed Boost | `dropLayer` | new | `aihell-pickup-speed` |
| `playExtraLifeCollectSound` | Sine 440→880 then 660→990 Hz | Extra Life | `dropLayer` | new | `aihell-pickup-extralife` |
| `playMagnetCollectSound` | Square 180→90→180 Hz + sine undertone | Magnet | `dropLayer` | new | `aihell-pickup-magnet` |
| `playPhaseShiftSound` | Triangle chirp 320→1560 Hz + bandpass noise swing 600→3200 Hz | Phase Shift | `CombatScene` | new | `aihell-phase-shift` |
| `playVictoryFanfareSound` | Two-phrase fanfare: arpeggio C5-E5-G5-C6 + cadence + sustained chord + bass + sparkle + shimmer, ~3.3 s, ≤ 0.2 | Victory | `PlayScene` | new | `aihell-victory-fanfare` (sequence + stack) |
| `playVictoryExplosionSound` | Layered saw 110→32 Hz boom + sine sub-rumble + LP noise crackle, ~0.65 s | Victory firework burst/starburst | `endOfRunJuice.spawnVictoryFireworks` | new | `aihell-victory-explosion` |
| `playVictoryCrackSound` | Quick saw 587→140 Hz + HP noise crack, ~0.18 s | Victory firework ring | `endOfRunJuice.spawnVictoryFireworks` | new | `aihell-victory-crack` |
| `playVictoryPopSound` | Short sine 784→240 Hz pop, ~0.09 s | Victory firework implosion | `endOfRunJuice.spawnVictoryFireworks` | new | `aihell-victory-pop` |
| `playVictorySparkleSound` | Bright sine 1400→600 Hz + HP shimmer, ~0.12 s | Victory firework sparkle | `endOfRunJuice.spawnVictoryFireworks` | new | `aihell-victory-sparkle` |
| `playDefeatStingSound` | Five-note descent G4-F4-D4-B3-G3 + sinking 98→73.42 Hz drone + LP rumble tail, ~2.9 s, ≤ 0.2 | Defeat | `GameOverScene` | new | `aihell-defeat-sting` (sequence + stack) |
| `playVolumeFeedback` | Player hull-breach cue at selected gain, pitch unchanged | Settings volume feedback | `SettingsScene` | **existing** | `aihell-player-hull-breach` (gain-scaled) |
| `updateThrusterSound` | Continuous: triangle 60 Hz + sine 35 Hz + BP noise 700–1100 Hz, thrust-scaled (≤ 0.05) with an amplitude tremolo + counter-phase filter sweep on the shared beat clock's cannon cadence (2 subdivisions/beat) while thrusting; optional side profile (50% gain, both pitched oscillators one semitone up) selected when a side engine fires | Thruster hum (held thrust) | `Player`, `movementModel`, `utils/thrusterProfile` | new | `aihell-thruster-hum` (runtime shim delivery) |
| `stopThrusterSound` | Stops/releases the thruster hum nodes | Thruster hum | `Player` | control | (companion to `aihell-thruster-hum`) |

### Beat-synced explosion accents (AH-0MV01HNLU008S5E3)

The non-weapon destruction booms — `playDestructionSound`,
`playDiverDestructionSound` and `playPlayerDestructionSound` — are scheduled
onto the **next 16th note** of the current tempo (`beatPeriodMs(bpm) / 4`,
187.5 ms at the default 80 BPM) instead of firing on the exact kill frame, so
kills land as a rhythmic accent against the silent player-fire grid. Several
cues inside one 16th-note window stack onto the same tick, capped at
`EXPLOSION_PER_TICK_CAP` (4) per tick so a mass kill cannot clip the mix. The
delay is the **game-time** distance to the tick (`nextTick(now) − now`), never
a wall-clock read, so a paused scene never queues audio into the future. Only
the cue is deferred — all explosion VFX stays on the death frame. Weapon cues
(Mortar detonation; Nova/Mortar/Arc fire) and `playBulletDestructionSound`
stay immediate. The quantisation is implemented once in the shared audio seam
(`setExplosionBeatClock`) and registered by the shared combat core, so the
game and every gym behave identically.

### Advance cues (≥ 500 ms) — explicitly carried forward

The parent epic AC8 requires advance cues to remain ≥ 500 ms with gap-free
cue→fire scheduling. These are the only advance cues in the palette and their
baked durations must preserve the existing 0.6 s lead:

| Advance cue | Duration constant | Fire cue scheduled at cue end |
|-------------|-------------------|-------------------------------|
| `playScoutAdvanceCue` | `SCOUT_ADVANCE_CUE_DURATION` 0.6 s | `playScoutFireSound` |
| `playPhaserAdvanceCue` | `PHASER_ADVANCE_CUE_DURATION` 0.6 s | `playPhaserFireSound` |
| `playTankAdvanceCue` | `TANK_ADVANCE_CUE_DURATION` 0.6 s | `playTankFireSound` |

### A-minor scale conformance (AC3 — AH-0MVCRR203005HKVZ)

Every pitched oscillator automation point (static frequency, `set`/ramp start,
ramp end, waypoints) in every **enemy** recipe snaps to the nearest **A natural
minor** note (`A B C D E F G`, equal temperament, A4 = 440 Hz, within 10 cents).
The multi-seed jitter ranges were converted to **scale-degree variants**: integer
`startSlot`/`endSlot` parameters map each seed onto a distinct A-minor note pair
via ToneForge's declarative override expressions (e.g. `startSlot * 220`),
preserving per-kill variation without off-scale pitches. Filtered-noise-only
cues (only `aihell-diver-dive-loop` / `playDiveSound` today) are unpitched and
conformant by nature — the guard exempts them.

The A natural minor note ladder used (equal temperament): A0 27.5, B0 30.87,
C1 32.70, D1 36.71, E1 41.20, F1 43.65, G1 49.00, A2 110, B2 123.47, D3 146.83,
E3 164.81, F3 174.61, G3 196, A3 220, B3 246.94, C4 261.63, D4 293.66, E4 329.63,
F4 369.99, G4 392, A4 440, B4 493.88, C5 523.25, D5 587.33, E5 659.26, F5 698.46,
G5 783.99, A5 880, B5 987.77, D6 1174.66, E6 1318.51. The balance guard
(`scripts/audio-balance-guard.mjs`) asserts this invariant over every enemy cue
as part of `npm run build-audio:verify` (AC5).

## New recipes to author (input to AH-0MUTYV8480019Z51)

Seed block **32100–32199** is reserved for game-specific recipes to keep them
clear of ToneForge's existing card/impact seeds. One-shots are rendered at a
single seed; cues whose original character used per-invocation jitter
(`EXPLOSION_PITCH_JITTER` ±15 %) are baked as a **3-variant seed range** so
repeated kills still vary. Under **A-minor scale conformance (AC3,
AH-0MVCRR203005HKVZ)** the multi-seed jitter ranges were re-derived as
**scale-degree variants**: each seed anchors on a distinct A-minor note pair
(start + end), so per-kill variation is preserved without off-scale pitches.

| Proposed slug | Source cue | Character to reproduce | Seed(s) |
|---------------|------------|------------------------|---------|
| `aihell-enemy-spawn` | `playSpawnSound` | Rising square blip 220→880 Hz, 0.18 s | 32101 |
| `aihell-enemy-destruction` | `playDestructionSound` | Descending saw 440→60 Hz, 0.28 s — scale-degree variants: starts A3/A4/E5 → A1 (AC3) | 32113, 32128, 32144 |
| `aihell-player-hull-breach` | `playPlayerDestructionSound` | Layered thump + body + HP noise tail (stack of three primitives) | 32120 |
| `aihell-bullet-destruction` | `playBulletDestructionSound` | Square tick 1400→900 Hz, 0.07 s | 32130 |
| `aihell-tank-advance` | `playTankAdvanceCue` | Saw 150→320 + square sub 75→160 Hz, 0.6 s | 32140 |
| `aihell-tank-fire` | `playTankFireSound` | Saw+sine thump ~90→25 Hz | 32141 |
| `aihell-pickup-spawn` | `playPowerUpSpawnSound` | Bright ascending blip | 32150 |
| `aihell-pickup-despawn` | `playPowerUpDespawnSound` | Short descending blip | 32151 |
| `aihell-pickup-pop` | `playPowerUpCollectPopSound` | Saw 600→100 Hz + filtered noise, ≤ 0.08 s | 32152 |
| `aihell-swarm-burst` | `playSwarmBurstSound` | Saw buzz + sine whoosh, ~0.2 s | 32160 |
| `aihell-phaser-advance` | `playPhaserAdvanceCue` | Rising sine 660→880 Hz, 0.6 s | 32170 |
| `aihell-phaser-fire` | `playPhaserFireSound` | Triangle 1000→500 Hz, ~0.08 s | 32171 |
| `aihell-scout-advance` | `playScoutAdvanceCue` | Rising sine above the Phaser tell, 0.6 s | 32180 |
| `aihell-scout-fire` | `playScoutFireSound` | High square laser sweep (square, E5→A4), 0.108 s — AC4 swap (AH-0MVCRR2H2007VPDU) | 32181 |
| `aihell-diver-dive-start` | `playDiverDiveStartSound` | Rising saw 150→600 Hz + noise, ~0.25 s | 32190 |
| `aihell-diver-dive-loop` | `playDiveSound` | Bandpass noise sweep 300→900 Hz, loopable ~2 s | 32191 |
| `aihell-diver-fire` | `playDiverFireSound` | Saw 280→120 Hz, 0.08 s | 32192 |
| `aihell-diver-destruction` | `playDiverDestructionSound` | Saw 280→40 Hz + sine undertone, 0.35 s — scale-degree variants: starts E3/B3/E4 → E2, undertone E2→G0 (AC3) | 32173, 32176, 32197 |
| `aihell-boss-fire` | `playBossFireSound` | Saw 200→50 Hz + low sine undertone | 32200 |
| `aihell-boss-hit` | `playBossHitSound` | Punchy saw impact 320→60 Hz + square click + HP noise crack, ~0.16 s | 32208 |
| `aihell-cannon-fire` | `playCannonFireSound` | Square 800→400 Hz, ~0.08 s | 32210 |
| `aihell-cannon-impact` | `playCannonImpactSound` | Punchy saw impact 520→90 Hz + square click + HP smack, ~0.13 s | 32209 |
| `aihell-spread-impact` | `playSpreadImpactSound` | Warm amber triangle wedge 900→150 Hz + soft noise tick, ~0.14 s | 32218 |
| `aihell-spread-fire` | `playSpreadFireSound` | Triangle 600→1200→800 Hz, ~0.12 s | 32211 |
| `aihell-dual-fire` | `playDualFireSound` | Saw 900→300 Hz + sine tick | 32212 |
| `aihell-dual-impact` | `playDualImpactSound` | Bright twin square snap 1400→600 Hz + sine echo + HP tick, ~0.11 s | 32265 |
| `aihell-rapid-impact` | `playRapidImpactSound` | Tight staccato square tick 2400→1100 Hz + triangle shimmer + HP tap, ~0.06 s | 32266 |
| `aihell-rapid-fire` | `playRapidFireSound` | Triangle 500→900 Hz, ~0.05 s | 32213 |
| `aihell-nova-fire` | `playNovaFireSound` | Saw 160→40 Hz + rising triangle ring | 32214 |
| `aihell-nova-impact` | `playNovaImpactSound` | Bright expanding ring ping 1600→300 Hz + HP noise shimmer | 32273 |
| `aihell-mortar-fire` | `playMortarFireSound` | Triangle 220→90 Hz + barrel tick | 32215 |
| `aihell-mortar-impact` | `playMortarImpactSound` | Sharp shell-impact crack 900→150 Hz + HP noise smack | 32274 |
| `aihell-mortar-detonation` | `playMortarDetonationSound` | Saw 180→40 Hz + LP noise wash | 32216 |
| `aihell-arc-fire` | `playArcFireSound` | Square 1400→500→1120 Hz + HP noise crackle | 32217 |
| `aihell-arc-impact` | `playArcImpactSound` | Sharp electric crack 2400→900→220 Hz + fast HP noise zipper | 32275 |
| `aihell-wave-laser-fire` | `playWaveLaserFireSound` | High-energy square beam crack 1200→600 Hz, brief sustain, ~0.1 s | 32219 |
| `aihell-wave-laser-impact` | `playWaveLaserImpactSound` | Sharp neon snap 800→200 Hz + square click + BP noise crack, ~0.12 s | 32231 |
| `aihell-ricochet-fire` | `playRicochetFireSound` | Bright springy ping 1400→500 Hz + square tick, ~0.1 s | 32267 |
| `aihell-ricochet-impact` | `playRicochetImpactSound` | Soft high bounce tick 1800→900 Hz + HP noise smack, ~0.09 s | 32268 |
| `aihell-cluster-fire` | `playClusterFireSound` | Low missile launch 300→90 Hz + swept noise whoosh + ignition click, ~0.16 s | 32269 |
| `aihell-cluster-impact` | `playClusterImpactSound` | Heavy detonation thump 260→60 Hz + lowpass noise smack, ~0.18 s | 32270 |
| `aihell-options-fire` | `playOptionsFireSound` | Bright soft two-tone twinkle 900→1600 Hz + light sine overtone, ~0.07 s | 32271 |
| `aihell-options-impact` | `playOptionsImpactSound` | Soft bright aqua pop 1300→550 Hz + light HP noise tick, ~0.11 s | 32272 |
| `aihell-pickup-spread` | `playSpreadPickupSound` | Triangle 500→1500→800 Hz, ~0.15 s | 32220 |
| `aihell-pickup-dual` | `playDualPickupSound` | Two saw drops 1000→500 / 1200→700 Hz | 32221 |
| `aihell-pickup-rapid` | `playRapidPickupSound` | Triangle 400→1600 Hz, 0.1 s | 32222 |
| `aihell-pickup-reset` | `playResetPickupSound` | Sine 900→300 Hz, ~0.2 s | 32223 |
| `aihell-pickup-speed` | `playSpeedBoostCollectSound` | Square 600→1800 Hz, 0.1 s | 32224 |
| `aihell-pickup-extralife` | `playExtraLifeCollectSound` | Two warm sine chimes 440→880 / 660→990 Hz | 32225 |
| `aihell-pickup-magnet` | `playMagnetCollectSound` | Square 180→90→180 Hz + sine undertone | 32226 |
| `aihell-phase-shift` | `playPhaseShiftSound` | Triangle chirp + bandpass noise swing | 32230 |
| `aihell-victory-fanfare` | `playVictoryFanfareSound` | Two-phrase fanfare (sequence of arpeggio + cadence + chord + bass + sparkle + shimmer) | 32240 |
| `aihell-victory-explosion` | `playVictoryExplosionSound` | Layered saw/sub boom + LP noise crackle | 32250–32254 |
| `aihell-victory-crack` | `playVictoryCrackSound` | Quick saw + HP crack transient | 32255–32257 |
| `aihell-victory-pop` | `playVictoryPopSound` | Short sine pop | 32258–32260 |
| `aihell-victory-sparkle` | `playVictorySparkleSound` | Bright sine + HP shimmer | 32261–32263 |
| `aihell-countdown-tick` | `playCountdownTickSound` | Bright square blip 1046→784 Hz (C6→G5), ~0.12 s — one beat of the 3-2-1 restart countdown (AH-0MV55OA93008OUL1) | 32264 |
| `aihell-defeat-sting` | `playDefeatStingSound` | Descending five-note line + sinking drone + LP tail | 32241 |
| `aihell-thruster-hum` | `updateThrusterSound` | Continuous triangle 60 Hz + sine 35 Hz + BP noise 700–1100 Hz (runtime shim delivery, not baked); side profile halves the gain and shifts both pitched oscillators up one semitone when a side engine fires | — |

### New recipes outside `effects.ts` (Boss.ts surface)

`src/entities/Boss.ts` defines four additional cue functions inline using the
exported `blip()` helper. They are outside the child's stated file scope but
they are part of the same audio surface and must be migrated by the rewrite to
avoid a partially migrated palette. Discovered during this audit.

| Inline function (`src/entities/Boss.ts`) | Character | Proposed slug | Seed |
|------------------------------------------|-----------|---------------|------|
| `playBossSpawnSound` | Sine 80→220 Hz, 0.45 s | `aihell-boss-spawn` | 32201 |
| `playBossPhaseTransitionSound` | Square 220→880 Hz, 0.35 s | `aihell-boss-phase-transition` | 32202 |
| `playBossDestructionSound` | Saw 180→20 Hz, 0.6 s | `aihell-boss-destruction` | 32203 |
| `playBossPhaseCue(phase)` | Per-phase square rise — scale-degree variants: phases rise A3/A4/E5/A5 → A5 (AC3) | `aihell-boss-phase-cue` | 32242, 32227, 32207, 32204 |

## Retired cues

| Cue | Justification | Consumer-analysis evidence |
|-----|---------------|----------------------------|
| `playMajorExplosionSound` | The wave-timeout detonation was retired (AH-0MUNS3ZQ1002DJ9S): survivors now carry over and `detonateWaveTimeoutSurvivors` is a no-op. GDD §7.3 marks it "retained but unused by the timeout path". No gameplay path should produce it. | `grep -rlE "\bplayMajorExplosionSound\(" src --include='*.ts' \| grep -v '\.test\.ts'` → **no matches**. References exist only in `*.test.ts` files and `src/scenes/core/waveTimeout.ts` comments. |
| `playTankDestructionSound` | Tank destruction reuses the shared `playDestructionSound()` owned by `GymFormationScene`; the JSDoc marks it "Intentionally UNWIRED (dead code)". Wiring it would double-play destruction audio. | `grep -rlE "\bplayTankDestructionSound\(" src --include='*.ts' \| grep -v '\.test\.ts'` → **no matches** (test-only: `src/audio/effects.test.ts`). |
| `playWeaponChangeSound` | Weapon replacement already emits the per-type pickup activation cue and the generic collection pop; no production or test consumer references this cue. | `grep -rlE "\bplayWeaponChangeSound\(" src --include='*.ts'` → **no matches** in production **or** tests. |

Removing these three cues also lets the rewrite delete the `MAJOR_EXPLOSION_*`
constants, the `majorExplosionVoices` limiter state and the `TankDestruction`
synthesis branch, shrinking the dead-code surface.

## Control API and helpers (not cues — no recipe)

| Export | Disposition in migration |
|--------|--------------------------|
| `setSfxVolume(value)` | Retained. In baked form it routes to the shared Phaser sound manager's master SFX volume (parent AC5). |
| `setSfxMuted(on)` | Retained. Routes to the shared Phaser sound manager mute (parent AC5). |
| `getAudioContext()` | Retained as the single shared-context accessor; must continue to resolve to exactly one `AudioContext` under Phaser (parent AC6). |
| `blip(freqStart, freqEnd, duration, type, volume)` | Retired synthesis helper: replaced by recipe-backed WAV playback. Its remaining caller (`Boss.ts`) is migrated to dedicated Boss recipes (above). |
| `explosionPitchFactor()` / `EXPLOSION_PITCH_JITTER` | Retired as a runtime function; the ±15 % pitch variation is approximated at build time by the **3-variant scale-degree seed ranges** for `aihell-enemy-destruction` and `aihell-diver-destruction` (each seed anchors on a distinct A-minor note pair — AC3, AH-0MVCRR203005HKVZ). |
| `_get*ForTests()` / `_reset*ForTests()` accessors | Retained and re-pointed at the new playback layer so the contract tests (parent child AH-0MUTYV8RJ009MWKJ) can still assert the single-context and no-op invariants. |
| Exported `*_HZ` / `*_VOLUME` / `*_DURATION` constants | Retained as the reference character for recipe authoring and for the audible-character audition on AH-0MUTYV8480019Z51; they are no longer runtime synthesis parameters. |

## Coverage check against the parent epic's acceptance criteria

| Parent AC | Mapping coverage |
|-----------|------------------|
| AC2 Cue-to-recipe mapping | This document: every `effects.ts` cue + the `Boss.ts` surface has exactly one disposition. |
| AC3 Recipes in ToneForge | "New recipes to author" lists 37 game slugs + the 4 Boss slugs; two existing recipes reused. |
| AC4 Audible character preserved | "Original character" and "Character to reproduce" columns feed the audition on AH-0MUTYV8480019Z51. |
| AC5 Global volume/mute | `setSfxVolume`/`setSfxMuted` + `playVolumeFeedback` retained (reuses `aihell-player-hull-breach`). |
| AC6 Single shared context | `getAudioContext` retained as the single accessor. |
| AC7 No-op when unavailable | No-op contract re-asserted by the contract tests over the new playback layer. |
| AC8 Advance cues ≥ 500 ms | The three 0.6 s advance cues are enumerated and flagged above. |
| AC9–AC11 Build/pinning/bundle | Out of scope for this audit; owned by the build-pipeline, pin/hygiene children. |

## Open questions

None. Every cue has a disposition; no cue is left undecided.
