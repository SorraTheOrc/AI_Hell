# Audio cue-to-recipe mapping (ToneForge migration)

Authoritative cue catalogue for the migration of the game's SFX from the
hand-rolled procedural Web Audio in `src/audio/effects.ts` to build-time baked
ToneForge WAV assets consumed by Phaser.

- **Parent epic:** Switch game audio from procedural Web Audio to ToneForge (AH-0MUTUOB7X007PR9J)
- **Produced by:** Cue-to-recipe mapping and unused-cue audit (AH-0MUTYV7SQ005HURT)
- **ToneForge reference:** sibling checkout `../ToneForge`, version 0.1.1, MIT licence
- **Related:** GDD §7.3 (Audio Direction), `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §7

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

Only two cues map to existing ToneForge recipes (`weapon-laser-zap`,
`card-token-earn`); the remainder need game-specific recipes or stacks because
the shipped catalogue is card-game oriented. Three cues are retired.

## Disposition summary

| Disposition | Count | Notes |
|-------------|-------|-------|
| `existing-recipe` | 3 | Scout fire (`weapon-laser-zap`), power-up collect chime (`card-token-earn`), volume-feedback (reuses the `aihell-player-hull-breach` recipe) |
| `new-recipe` | 37 | Game-specific cues in `effects.ts`, including the thruster hum |
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
| `playDestructionSound` | Descending saw 440→60 Hz (× ±15 % pitch jitter), 0.28 s, vol 0.30 | Enemy destroyed (sharp pop/crack) | `PlayScene`, `CombatScene`, `GymFormationScene`, `enemyFactory`, `Asteroid`, `Scout`, `Phaser`, `Diver`, `playerDeathJuice` | new | `aihell-enemy-destruction` (multi-seed) |
| `playPlayerDestructionSound` | Layered hull breach: saw thump 120→32 Hz 0.4 s + triangle body 260→42 Hz 0.6 s + HP noise tail 0.28 s, ≤ 0.2 | Player hit / life lost | `vfx/playerDeathJuice` | new | `aihell-player-hull-breach` (stack) |
| `playMajorExplosionSound` | Layered major blast: saw thump 150→26 + triangle body 340→38 + LP noise tail, 4-voice limiter | Wave timeout — retained but unused | **none** | **retired** | — (see Retired cues) |
| `playBulletDestructionSound` | Square tick 1400→900 Hz, 0.07 s, vol 0.12 | Player bullet destroys enemy bullet | `vfx/bulletImpact` | new | `aihell-bullet-destruction` |
| `playTankDestructionSound` | Saw 220→30 Hz, 0.45 s, vol 0.2 | Intentionally unwired | **none** (test-only) | **retired** | — (see Retired cues) |
| `playTankAdvanceCue` | Advancing saw 150→320 Hz + square sub 75→160 Hz, 0.6 s | Advance cue (≥ 500 ms) | `entities/Tank` | new | `aihell-tank-advance` |
| `playTankFireSound` | Heavy saw+sine cannon thump ~90→25 Hz, scheduled at cue end | Enemy fire / no-gap | `entities/Tank` | new | `aihell-tank-fire` |
| `playPowerUpSpawnSound` | Bright ascending blip (higher than enemy spawn) | Power-up spawn (advance) | `GymWeapons`, `GymWeaponLeveling` | new | `aihell-pickup-spawn` |
| `playPowerUpDespawnSound` | Quick descending blip, lower vol, shorter | Power-up despawn | `GymWeapons`, `GymWeaponLeveling` | new | `aihell-pickup-despawn` |
| `playPowerUpCollectSound` | Cheerful two-tone ascending chime | Power-up pickup | `dropLayer` | **existing** | `card-token-earn` |
| `playPowerUpCollectPopSound` | Saw 600→100 Hz + filtered noise transient, ≤ 0.08 s | Power-up pickup (tactile pop) | `dropLayer` | new | `aihell-pickup-pop` |
| `playWeaponChangeSound` | Distinctive whoosh ("armed with new weapon") | Weapon change | **none** (no call sites) | **retired** | — (see Retired cues) |
| `playSwarmBurstSound` | Saw buzz 120→80 Hz + sine whoosh 200→600 Hz, ~0.2 s | Swarm volley buzz | `entities/Swarm` | new | `aihell-swarm-burst` |
| `playPhaserAdvanceCue` | Rising sine 660→880 Hz, 0.6 s | Advance cue (≥ 500 ms) | `entities/Phaser` | new | `aihell-phaser-advance` |
| `playPhaserFireSound` | Triangle 1000→500 Hz, ~0.08 s, scheduled at cue end | Enemy fire / no-gap | `entities/Phaser` | new | `aihell-phaser-fire` |
| `playScoutAdvanceCue` | Rising sine, pitched above Phaser, 0.6 s | Advance cue (≥ 500 ms) | `entities/Scout` | new | `aihell-scout-advance` |
| `playScoutFireSound` | High square laser sweep, scheduled at cue end | Enemy fire / no-gap | `entities/Scout` | **existing** | `weapon-laser-zap` |
| `playDiverDiveStartSound` | Rising saw 150→600 Hz + filtered noise, ~0.25 s | Dive danger cue | `entities/Diver` | new | `aihell-diver-dive-start` |
| `playDiveSound` | Bandpass noise sweep 300→900 Hz, refcounted shared ~2 s voice | Diver dive | `entities/Diver` | new | `aihell-diver-dive-loop` |
| `stopDiveSound` | Stops/releases the shared dive voice | Diver dive | `entities/Diver` | control | (companion to `aihell-diver-dive-loop`) |
| `playDiverFireSound` | Saw 280→120 Hz, 0.08 s | Enemy fire (spread burst) | `entities/Diver` | new | `aihell-diver-fire` |
| `playDiverDestructionSound` | Saw 280→40 Hz + sine undertone, 0.35 s (× pitch jitter) | Enemy destroyed (heavy) | `entities/Diver` | new | `aihell-diver-destruction` (multi-seed) |
| `playBossFireSound` | Saw 200→50 Hz + low sine undertone, ~0.2 s | Boss fire | `entities/Boss` | new | `aihell-boss-fire` |
| `playCannonFireSound` | Square 800→400 Hz, ~0.08 s, vol 0.15 | Player cannon fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-cannon-fire` |
| `playSpreadFireSound` | Triangle 600→1200→800 Hz, ~0.12 s, vol 0.15 | Player spread fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-spread-fire` |
| `playDualFireSound` | Saw 900→300 Hz + offset sine tick, ~0.06 s | Player dual fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-dual-fire` |
| `playRapidFireSound` | Triangle 500→900 Hz, ~0.05 s, vol 0.12 | Player rapid fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-rapid-fire` |
| `playNovaFireSound` | Saw 160→40 Hz + rising triangle ring 300→1800 Hz | Player Nova fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-nova-fire` |
| `playMortarFireSound` | Muffled triangle 220→90 Hz + high barrel tick | Player Mortar fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-mortar-fire` |
| `playMortarDetonationSound` | Heavy saw 180→40 Hz + LP noise wash | Mortar detonation | `CombatScene` | new | `aihell-mortar-detonation` |
| `playArcFireSound` | Square 1400→500→1120 Hz + HP noise crackle | Player Arc fire | `PlayScene`, `GymWeapons`, `GymWeaponLeveling` | new | `aihell-arc-fire` |
| `playSpreadPickupSound` | Triangle 500→1500→800 Hz, ~0.15 s | Spread pickup | `dropLayer` | new | `aihell-pickup-spread` |
| `playDualPickupSound` | Saw 1000→500 then 1200→700 Hz, 0.06 s apart | Dual pickup | `dropLayer` | new | `aihell-pickup-dual` |
| `playRapidPickupSound` | Triangle 400→1600 Hz, 0.1 s | Rapid pickup | `dropLayer` | new | `aihell-pickup-rapid` |
| `playResetPickupSound` | Sine 900→300 Hz, ~0.2 s | Reset pickup | `dropLayer` | new | `aihell-pickup-reset` |
| `playSpeedBoostCollectSound` | Square 600→1800 Hz, 0.1 s | P5 Speed Boost | `dropLayer` | new | `aihell-pickup-speed` |
| `playExtraLifeCollectSound` | Sine 440→880 then 660→990 Hz | P8 Extra Life | `dropLayer` | new | `aihell-pickup-extralife` |
| `playMagnetCollectSound` | Square 180→90→180 Hz + sine undertone | P9 Magnet | `dropLayer` | new | `aihell-pickup-magnet` |
| `playPhaseShiftSound` | Triangle chirp 320→1560 Hz + bandpass noise swing 600→3200 Hz | P6 Phase Shift | `CombatScene` | new | `aihell-phase-shift` |
| `playVictoryFanfareSound` | Two-phrase fanfare: arpeggio C5-E5-G5-C6 + cadence + sustained chord + bass + sparkle + shimmer, ~3.3 s, ≤ 0.2 | Victory | `PlayScene` | new | `aihell-victory-fanfare` (sequence + stack) |
| `playDefeatStingSound` | Five-note descent G4-F4-D4-B3-G3 + sinking 98→73.42 Hz drone + LP rumble tail, ~2.9 s, ≤ 0.2 | Defeat | `GameOverScene` | new | `aihell-defeat-sting` (sequence + stack) |
| `playVolumeFeedback` | Player hull-breach cue at selected gain, pitch unchanged | Settings volume feedback | `SettingsScene` | **existing** | `aihell-player-hull-breach` (gain-scaled) |
| `updateThrusterSound` | Continuous: triangle 60 Hz + sine 35 Hz + BP noise 700–1100 Hz, thrust-scaled, ≤ 0.075 | Thruster hum (held thrust) | `Player`, `movementModel` | new | `aihell-thruster-hum` (runtime shim delivery) |
| `stopThrusterSound` | Stops/releases the thruster hum nodes | Thruster hum | `Player` | control | (companion to `aihell-thruster-hum`) |

### Advance cues (≥ 500 ms) — explicitly carried forward

The parent epic AC8 requires advance cues to remain ≥ 500 ms with gap-free
cue→fire scheduling. These are the only advance cues in the palette and their
baked durations must preserve the existing 0.6 s lead:

| Advance cue | Duration constant | Fire cue scheduled at cue end |
|-------------|-------------------|-------------------------------|
| `playScoutAdvanceCue` | `SCOUT_ADVANCE_CUE_DURATION` 0.6 s | `playScoutFireSound` |
| `playPhaserAdvanceCue` | `PHASER_ADVANCE_CUE_DURATION` 0.6 s | `playPhaserFireSound` |
| `playTankAdvanceCue` | `TANK_ADVANCE_CUE_DURATION` 0.6 s | `playTankFireSound` |

## New recipes to author (input to AH-0MUTYV8480019Z51)

Seed block **32100–32199** is reserved for game-specific recipes to keep them
clear of ToneForge's existing card/impact seeds. One-shots are rendered at a
single seed; cues whose original character used per-invocation jitter
(`EXPLOSION_PITCH_JITTER` ±15 %) are baked as a **3-variant seed range** so
repeated kills still vary.

| Proposed slug | Source cue | Character to reproduce | Seed(s) |
|---------------|------------|------------------------|---------|
| `aihell-enemy-spawn` | `playSpawnSound` | Rising square blip 220→880 Hz, 0.18 s | 32101 |
| `aihell-enemy-destruction` | `playDestructionSound` | Descending saw 440→60 Hz, 0.28 s | 32110–32112 |
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
| `aihell-diver-dive-start` | `playDiverDiveStartSound` | Rising saw 150→600 Hz + noise, ~0.25 s | 32190 |
| `aihell-diver-dive-loop` | `playDiveSound` | Bandpass noise sweep 300→900 Hz, loopable ~2 s | 32191 |
| `aihell-diver-fire` | `playDiverFireSound` | Saw 280→120 Hz, 0.08 s | 32192 |
| `aihell-diver-destruction` | `playDiverDestructionSound` | Saw 280→40 Hz + sine undertone, 0.35 s | 32193–32195 |
| `aihell-boss-fire` | `playBossFireSound` | Saw 200→50 Hz + low sine undertone | 32200 |
| `aihell-cannon-fire` | `playCannonFireSound` | Square 800→400 Hz, ~0.08 s | 32210 |
| `aihell-spread-fire` | `playSpreadFireSound` | Triangle 600→1200→800 Hz, ~0.12 s | 32211 |
| `aihell-dual-fire` | `playDualFireSound` | Saw 900→300 Hz + sine tick | 32212 |
| `aihell-rapid-fire` | `playRapidFireSound` | Triangle 500→900 Hz, ~0.05 s | 32213 |
| `aihell-nova-fire` | `playNovaFireSound` | Saw 160→40 Hz + rising triangle ring | 32214 |
| `aihell-mortar-fire` | `playMortarFireSound` | Triangle 220→90 Hz + barrel tick | 32215 |
| `aihell-mortar-detonation` | `playMortarDetonationSound` | Saw 180→40 Hz + LP noise wash | 32216 |
| `aihell-arc-fire` | `playArcFireSound` | Square 1400→500→1120 Hz + HP noise crackle | 32217 |
| `aihell-pickup-spread` | `playSpreadPickupSound` | Triangle 500→1500→800 Hz, ~0.15 s | 32220 |
| `aihell-pickup-dual` | `playDualPickupSound` | Two saw drops 1000→500 / 1200→700 Hz | 32221 |
| `aihell-pickup-rapid` | `playRapidPickupSound` | Triangle 400→1600 Hz, 0.1 s | 32222 |
| `aihell-pickup-reset` | `playResetPickupSound` | Sine 900→300 Hz, ~0.2 s | 32223 |
| `aihell-pickup-speed` | `playSpeedBoostCollectSound` | Square 600→1800 Hz, 0.1 s | 32224 |
| `aihell-pickup-extralife` | `playExtraLifeCollectSound` | Two warm sine chimes 440→880 / 660→990 Hz | 32225 |
| `aihell-pickup-magnet` | `playMagnetCollectSound` | Square 180→90→180 Hz + sine undertone | 32226 |
| `aihell-phase-shift` | `playPhaseShiftSound` | Triangle chirp + bandpass noise swing | 32230 |
| `aihell-victory-fanfare` | `playVictoryFanfareSound` | Two-phrase fanfare (sequence of arpeggio + cadence + chord + bass + sparkle + shimmer) | 32240 |
| `aihell-defeat-sting` | `playDefeatStingSound` | Descending five-note line + sinking drone + LP tail | 32241 |
| `aihell-thruster-hum` | `updateThrusterSound` | Continuous triangle 60 Hz + sine 35 Hz + BP noise 700–1100 Hz (runtime shim delivery, not baked) | 32250 |

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
| `playBossPhaseCue(phase)` | Per-phase square rise (4 variants) | `aihell-boss-phase-cue` | 32204–32207 |

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
| `explosionPitchFactor()` / `EXPLOSION_PITCH_JITTER` | Retired as a runtime function; the ±15 % pitch variation is approximated at build time by the 3-variant seed ranges for `aihell-enemy-destruction` and `aihell-diver-destruction`. |
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
