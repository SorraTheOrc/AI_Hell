# Gym ↔ game parity matrix

**`PlayScene` (`src/scenes/PlayScene.ts`) is the reference.** A gym is a
scenario harness, never a second source of truth: the same gameplay object must
run the same shipped code in a gym as it does in the game, and **the game must
never be changed to match a gym**. When a divergence is found the gym is fixed
by consuming shared code, or the divergence is recorded here with a reason.

Governing rule: [`AGENTS.md` § Game Architecture Conventions](../AGENTS.md#game-architecture-conventions)
(tracked by AH-0MUGZDTFX004RBD1); rationale in
[`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §5.1](./ENEMY_DESIGN_AND_IMPLEMENTATION.md#51-gym-parity).

| | |
|---|---|
| Sweep item | AH-0MVRMHUOG005P38A (this matrix) |
| Fix item | AH-0MVRMHWNC002H4B5 (consumes the `divergence to fix` rows) |
| Audited at commit | `1e335eb0` (2026-10-29) |
| Divergences fixed by | AH-0MVRMHWNC002H4B5 (D1–D4, all rows now `parity`) |
| Scope | every production scene under `src/scenes/gym/` (15) plus the generic base `src/scenes/gym/core/GymFormationScene.ts` |
| Automated guard | [`src/scenes/core/gymParityDocs.test.ts`](../src/scenes/core/gymParityDocs.test.ts) fails if a gym scene has no row here, or if a row loses its verdict or evidence |

## How to re-audit

The next sweep is cheap because most of the matrix is guarded mechanically.

**Guarded automatically (run `npm test`):**

- **Shared-helper / shared-method uniqueness** —
  [`src/scenes/core/CombatScene.equivalence.test.ts`](../src/scenes/core/CombatScene.equivalence.test.ts)
  (`EPIC_SHARED_HELPERS` at `:2561`, `EPIC_SHARED_METHODS` at `:2624`) fails if a
  production scene re-introduces a copy of a shared helper or template method.
  The wormhole-transit destination rule is registered at `:2615`
  (`resolveSpawnTransitTarget` → `src/scenes/core/spawnTransit.ts`).
- **Matrix coverage and classification** —
  [`src/scenes/core/gymParityDocs.test.ts`](../src/scenes/core/gymParityDocs.test.ts)
  scans `src/scenes/gym/Gym*.ts`, requires one row here per scene, requires the
  generic `GymFormationScene` row, rejects an unknown verdict, and requires
  every row's reason cell to carry a file/section reference.
- **Cross-scene parity suites** —
  [`src/scenes/gym/spawnParity.test.ts`](../src/scenes/gym/spawnParity.test.ts)
  (level-launch orbital transit `:354`, fire cadence `:496`, march block `:557`,
  and `GymBotTuning` inheritance `:690`),
  [`src/scenes/gym/levelParity.test.ts`](../src/scenes/gym/levelParity.test.ts)
  (level-scaled counts `:158`, level-resolved supply cadence `:262`, level-gym
  inheritance `:344`, documented flat formation cadence `:406`), and the
  `*.equivalence.test.ts` / `*.parity.test.ts` suites under `src/scenes/core/`
  (combat, drops, minerals, AOE, power-up and weapon leveling).
- **Capture registry** — `src/core/captureDirector.test.ts` pins
  `WATCHABLE_GYM_SCENE_KEYS`, so a gym cannot silently leave the watchable set.

**Human-reviewed on each sweep:**

1. the **enabled shipped objects** roster per row (a newly enabled object must
   be added to the row);
2. the **spawn seam** (shared core template / `spawnTransit` / in place) and
   whether the scene still consumes it;
3. every **intentional divergence** re-justification and every **divergence to
   fix** entry (observed vs expected, `file:line`, reproduction);
4. when a **new gym scene** is added: add its row here (the guard fails until
   you do) and state whether it inherits the shipped start-of-wave/combat code.

## Matrix

Verdict vocabulary: `parity`, `intentional divergence` (reason + evidence in the
last column), `divergence to fix` (detail section referenced in the last
column). No other verdict is accepted by the guard.

| Scene | Derives from | Enabled shipped objects | Spawn seam | Combat loop inherited | Verdict | Reason / evidence |
|---|---|---|---|---|---|---|
| `GymFormationScene` (generic base) | `CombatScene` (`src/scenes/gym/core/GymFormationScene.ts:502`) | every config-driven formation entity (`createEnemyFromConfig`), shared mineral layer + kill drops, opt-in power-up/weapon drop layer, shared wave timeout | `_spawnFormation` → `placeWavePortal` + `resolveSpawnTransitTarget` + `startSpawnAnimation` + single-live `WormholeController` (`:1790`, `:1848`, `:1861`) | yes — `_tickPlayer` `:1692`, `_updateAutoDefence` `:1698`, `_handleCollisions` `:1701`, `_advanceWaveTimeout` `:1726`, `applyPostMotionWrapAll` `:1671` | `parity` | Diver re-anchor + glide are applied (`:1644`, `:1662`, `:1898`). Intentional: flat `rules.powerUpSpawnInterval` cadence (`:982`, §5.1 of `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`), gym HUD/controls and demonstration mineral seeding (`:1371`), no run telemetry (game only, `src/scenes/core/runTelemetry.ts`) |
| `GymBoss` | `GymFormationScene` (`src/scenes/gym/GymBoss.ts:149`) | `Boss` (all four phases), phase minions via shared `planMinionSpawns`, shared `fireForEnemy` dispatcher | Boss in place (matches `PlayScene.spawnBoss`); minions in place through the shared transit exemption (`transit:false` `:287`) + `startSpawnAnimation` (`:295`) | yes — inherits `CombatScene`/`CombatCoreScene`; Boss advances through the shared `_advanceBoss` hook | `parity` | **D1 closed by AH-0MVRMHWNC002H4B5** — the per-phase hit pool is `scaledEncounterHp(BOSS_HIT_POINTS_PER_PHASE, playerPowerScore(...))` from the shared `src/core/difficultyScaling.ts`, resolved from the live setup-upgraded player (`src/scenes/gym/GymBoss.ts:115`); pinned by `src/scenes/gym/GymBoss.test.ts` (D1 parity). Intentional: gym-only health bar, DAMAGE and SHOOT controls (`GymBoss.ts:186`), no wave timer (same as the game's boss) |
| `GymBotTuning` | `GymLevel` (`src/scenes/gym/GymBotTuning.ts:173`) | shared bot brain/governor (`createCompetentBotBrain` `:179`, `getBotInput` `:231`), random generated levels (`generateRandomLevel` `:212`), inherited supply layer, asteroid hazard, wave clock and spawner-delivered content | inherited from `GymLevel` (`src/scenes/gym/GymLevel.ts:359`) | yes — inherited `CombatScene` loop plus the shared bot input seam | `parity` | **D2/D3 closed by AH-0MVRMHWNC002H4B5** (fixed in the inherited `GymLevel`: shared `formationReanchor` controller and shared `dynamicSpawnPlan`); pinned by `src/scenes/gym/spawnParity.test.ts` (D2, D3). Intentional: gym-only tuning panel/export and the random-level scenario, no run telemetry |
| `GymCentipede` | `GymFormationScene` (`src/scenes/gym/GymCentipede.ts:41`) | `Centipede` + shared `CentipedeChain` (`src/scenes/gym/core/centipedeFormation.ts:87`); segments never fire by entity override | inherited `_spawnFormation` (`GymFormationScene.ts:1790`) | yes — inherited `CombatScene` loop | `parity` | Chain construction matches the game's direct `new Centipede` spawn (`PlayScene.ts:2196`); classic `wrapAware:false` exclusion applied (`centipedeFormation.ts:87`). Segments never fire in the game either (`src/entities/Centipede.ts:170`) |
| `GymCurveSequencer` | `Phaser.Scene` (`src/scenes/gym/GymCurveSequencer.ts:443`) | none (curve editor UI); launches `GymLevel` with the edited curve/level (`:638`, `:646`) | n/a — no gameplay objects | n/a — not a combat scene | `intentional divergence` | Editor/sequencer UI only; consumes the shared setup seam as a documented no-op and forwards the loadout/seed to the launched `GymLevel` (setup-capable in the capture registry since AH-0MVRMI0Q7001KG4Y), and recorded as the parameterised-launch path for `GymLevel` (`docs/dev/gameplay-capture.md`) |
| `GymHangar` | `Phaser.Scene` (`src/scenes/gym/GymHangar.ts:139`) | none — renders the **shipped** hangar screen (`buildHangarScreenModel` + `renderHangarScreen`, `src/scenes/hangarWar/hangarScreen.ts`) against an injected hangar-war payload: banked salvage, ring progress, the unlock tree (cost/owned/gated) and the hull/starting-weapon/modifier deployment selector; the economy, banking and ring resolvers are pure modules under `src/core/hangarWar/` exercised by this scene | n/a — no gameplay objects | n/a — not a combat scene | `intentional divergence` | One screen code path: the gym calls the same model builder and renderer as the game's `HangarScene`, with **no handlers**, so it is read-only by construction (no purchase, banking or resolver logic in the scene). Consumes the shared setup seam as a documented no-op (no player) and uses the setup seed for its deterministic sample payload (`src/scenes/gym/GymHangar.ts:1`, `docs/dev/gameplay-capture.md`) |
| `GymFodderEnemies` | `GymFormationScene` (`src/scenes/gym/GymFodderEnemies.ts:343`) | every non-boss `EnemyConfig` via the shared factory (`:276`, `:916`), shared `fireForEnemy` dispatcher (`:246`), shared asteroid split/mineral layers, centipede option | inherited `_spawnFormation` (`GymFormationScene.ts:1790`) | yes — inherited `CombatScene` loop | `parity` | Intentional (documented): editor/tuning panel, boss excluded from the dropdown (`src/scenes/gym/GymFodderEnemies.ts:652`) and the wave timeout (`:270`), and force-field sliders set hits directly with no campaign level (`:283`, `:431`) |
| `GymLevel` | `CombatScene` (`src/scenes/gym/GymLevel.ts:509`) | wave-group enemies via the shared factory + `fireForEnemy`, march block, supply layer (minerals/drops), asteroid hazard, spawner-delivered ghosts/centipede/horde/lane traffic/orbital strikes, shared wave timeout | `spawnWave` → `resolveSpawnTransitTarget` + `startSpawnAnimation` + `WormholeController`; `shootEnabled` hand-off, march and the shared `formationReanchor` controller; dynamic content planned/released through shared `dynamicSpawnPlan` (`src/scenes/gym/GymLevel.ts:946`, `:981`) | yes — `_tickPlayer`, `_handleCollisions`, shared wrap and shared boss hooks | `parity` | **D2/D3 closed by AH-0MVRMHWNC002H4B5** — the Diver group uses the shared `FormationReanchorController` (`src/scenes/core/formationReanchor.ts`) and the per-wave dynamic content uses the shared `dynamicSpawnPlan` planners + `releaseDueSpawns`; pinned by `src/scenes/gym/spawnParity.test.ts` (D2, D3). Intentional: full-hold reward resolves without a modal pause so an autonomous bot keeps playing (`:1144`, `:1312`); mineral field seeded for the demo (`:1176`) |
| `GymMinerals` | `GymFormationScene` (`src/scenes/gym/GymMinerals.ts:89`) | `Asteroid` (+ shared `splitAsteroid` `:80`), shared mineral kill drops/hold/choice, shared per-kill Extra Life roll | inherited `_spawnFormation` (`GymFormationScene.ts:1790`) | yes — inherited `CombatScene` loop | `parity` | Asteroid construction matches the game's `new Asteroid` hazard spawn (`PlayScene.ts:4738`); intentional: asteroids-only field with 3 seeded rocks (`GymMinerals.ts:69`) and the base class's 100 demonstration minerals (`GymFormationScene.ts:1371`) |
| `GymMiniBoss` | `GymFormationScene` (`src/scenes/gym/GymMiniBoss.ts:174`) | `MiniBoss` through the shared design helper (`:156`), shared minion planner/factory/fire seam, shared `miniBossDeathSweep` | inherited `_spawnFormation` (`GymFormationScene.ts:1790`); `MiniBoss` has no spawning seam so it spawns in place, exactly as `PlayScene` spawns it (`PlayScene.ts:1618`) | yes — inherited `CombatScene`/`_advanceBoss` loop | `parity` | Intentional (documented): gym-only fixed hit pool for fast phase stepping (`MINI_BOSS_GYM_HP_PER_PHASE`, `GymMiniBoss.ts:78`), DAMAGE/EXPLODE/SHOOT controls; the shared death sweep is used for EXPLODE (`GymMiniBoss.ts:267`) |
| `GymPlayer` | `CombatScene` (`src/scenes/gym/GymPlayer.ts:152`) | `Player`, `PlayerBullet`, shared auto-fire/input/collision lifecycle; `Obstacle` (shared entity, gym-only scenario) | n/a — no enemy spawn | yes — `_tickPlayer` `:574`, `_handleCollisions` `:584`; only the destruction hooks are overridden | `intentional divergence` | Obstacle course is the documented gym-only training scenario (`GymPlayer.ts:23`; §5.1 of `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). The obstacle entity and the collision/auto-fire code are shared |
| `GymPowerUpLeveling` | `CombatScene` (`src/scenes/gym/GymPowerUpLeveling.ts:185`) | `Player` + every power-up through the shared `EffectsRegistry`/`resolvePowerUpAtLevel`, shared drop layer, minerals, `MineralHold` and hold-full choice | no enemy spawn; round-robin drop source | yes — `_tickPlayer` `:306`, shared drop/mineral/hold-full passes | `parity` | Intentional: gym-only round-robin drop source (no kills to roll) and the level/stats readout panel (`src/scenes/gym/GymPowerUpLeveling.ts:185`, `gym-powerup-level-readout`); the level curve and effects are shared, not copied |
| `GymPowerUpsCombat` | `CombatScene` (`src/scenes/gym/GymPowerUpsCombat.ts:171`) | `Scout` threat formation + shared `fireForEnemy` (`:554`), Shield/Bomb/Phase Shift/Teleport through the shared `EffectsRegistry`, shared drop layer, shared teleport/auto-defence seams | `_spawnScoutFormation` → `createEnemyFromConfig` + `resolveSpawnTransitTarget({transit:false})` + `startSpawnAnimation`/`updateSpawnEmergence` (`src/scenes/gym/GymPowerUpsCombat.ts:405`), matching the shared factory + in-place spawn presentation | yes — `_tickPlayer` `:333`, `_handleCollisions` `:361` | `parity` | **D4 closed by AH-0MVRMHWNC002H4B5** — threats are built through the shared factory (the active `scout` `EnemyConfig` reaches them) and grow from 1 px behind the shared spawn protection, in place; pinned by `src/scenes/gym/GymPowerUpsCombat.test.ts` (D4 parity). Intentional: auto-fire disabled (`:317`) so the defensive power-ups, not player fire, are the demonstration; HUD is gym-only |
| `GymPowerUpsUtility` | `CombatCoreScene` (`src/scenes/gym/GymPowerUpsUtility.ts:116`) | `Player` + Speed Boost/Extra Life/Magnet/Mineral Scoop/Mystery UFO through the shared `EffectsRegistry`, shared drop layer, `MineralHold` and mineral scoop | no enemy spawn; round-robin drop source | partial — `CombatCoreScene` only (`_tickPlayer` `:247`, input/auto-fire/drop passes); no collision pass because the scene is threat-free | `parity` | Intentional: threat-free utility gallery (no enemy objects to collide with), auto-fire disabled (`src/scenes/gym/GymPowerUpsUtility.ts:232`), gym-only round-robin source and 40 seeded minerals (`:176`). Disabling a feature is a permitted difference; no enabled object runs divergent code |
| `GymWeaponLeveling` | `CombatScene` (`src/scenes/gym/GymWeaponLeveling.ts:145`) | `Player` + every weapon through the shared `EffectsRegistry`/level resolver, shared AOE dispatch/VFX, shared drop layer, minerals and hold-full choice | no enemy spawn; round-robin drop source | yes — `_tickPlayer` `:250`, shared effect/drop/mineral passes | `parity` | Intentional: gym-only round-robin drop source and level readout; weapon behaviour lives once in the shared arsenal (`src/utils/weapons.ts`, `src/powerups/effects.ts`) |
| `GymWeapons` | `CombatScene` (`src/scenes/gym/GymWeapons.ts:200`) | `Player` + cannon/Spread/Dual/Rapid/Nova/Mortar/Arc through the shared combat core, shared AOE dispatch/VFX, shared drop layer | no enemy spawn; `TrainingTarget` fixtures only (`:171`, `:504`) | yes — `_tickPlayer` `:303`, `_handleCollisions` inherited | `intentional divergence` | AOE practice targets are the documented gym-only divergence (F6 AC5, `GymWeapons.ts:120`, `:165`; §5.1 of `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`). The AOE resolution and VFX are shared, not copied |

## Scripted-scene setup adoption (AH-0MVRMHYJR000Y9H8)

Every gym scene consumes the shared scripted-scene `setup` seam, so any gym
can be launched with a loadout, power-up levels and a determinism seed and
recorded from `examples/scenes.json`. Adoption runs through **one** shared
policy — `CombatCoreScene._adoptCaptureSetup` calls the single
`applySceneSetup` applier (`src/scenes/core/sceneSetup.ts`) and re-seeds the
scene's content RNG from `resolveSetupSeed`. The setup→state mapping is never
copied into a gym, and an absent setup is a no-op (the applier is intentionally
total), so setup-less gym behaviour is unchanged.

- **Formation family** — `GymFormationScene` and its subclasses (`GymBoss`,
  `GymCentipede`, `GymFodderEnemies`, `GymMinerals`, `GymMiniBoss`) consume
  `player`, `powerUps` and `seed`; the fire-capable ones (`GymBoss`,
  `GymFodderEnemies`, `GymMiniBoss`) also consume the scenario parameter
  `shootEnabled` (the HUD SHOOT toggle's initial state, inherited by every
  spawned entity). `GymFodderEnemies` also consumes `enemy` and the boss gyms
  consume `bossHitsRemaining`. `GymCentipede` (segments never fire) and
  `GymMinerals` (asteroids never fire) intentionally do not accept
  `shootEnabled`: their entities ignore the flag, so accepting it would
  silently drop it. Limitation: the enemy roster stays config-driven for
  formation gyms (`GymFormationScene.init`,
  `src/scenes/gym/core/GymFormationScene.ts:693`) — a formation gym has no
  roster selector, so a setup cannot change it.
- **Level family** — `GymLevel` / `GymBotTuning` consume `player`, `powerUps`,
  `seed`, `level`, `startWave` and `mineralReward`. Limitation: the full-hold
  reward resolves without a modal pause (gym-only, documented in the matrix
  above).
- **`GymPlayer`** — consumes `player`, `powerUps`, `seed` and `obstacles`
  (`false` omits the fixed gym-only obstacle course, `OBSTACLE_LAYOUT`,
  `src/scenes/gym/GymPlayer.ts:104`). The shared collision/auto-fire code is
  unchanged either way.
- **`GymWeapons`** — consumes `player`, `powerUps`, `seed` (the seed also makes
  AOE `'onRandom'` placement reproducible) and `practiceTargets` (`false` omits
  the inert AOE practice-target tripod). Limitation: the round-robin drop order
  is a fixed gym-only scenario (`src/scenes/gym/GymWeapons.ts:98`) — it is the
  gym's documented divergence, and changing it would remove the demonstration
  the gym exists for.
- **`GymPowerUpsCombat`** — consumes `player`, `powerUps`, `seed`,
  `shootEnabled` and `threatCount` (the scout threat-wave size, schema-bounded
  to 1–12). Both are composition parameters for the gym-only threats; the
  threats themselves run the shared factory/projectile seams as before.
- **`GymPowerUpsUtility`** — consumes `player`, `powerUps`, `seed` (seeds the
  demonstration mineral field) and `minerals` (the seeded field size,
  schema-bounded to 0–200). Limitation: the round-robin drop cadence stays at
  the shared shipped interval (`POWER_UP_SPAWN_INTERVAL`) — it is a supply-cadence
  parity constant, not capture framing.
- **`GymWeaponLeveling`** — consumes `player`, `powerUps`, `seed` (seeds the
  mineral field). Limitation: the round-robin drop and mineral-hold cadences
  are fixed gym-only scenarios (`src/scenes/gym/GymWeaponLeveling.ts:145`);
  they stay at the shipped cadence.
- **`GymPowerUpLeveling`** — consumes `player`, `powerUps`, `seed` (seeds the
  mineral field). Limitation: the round-robin drop and mineral-hold cadences
  are fixed gym-only scenarios (`src/scenes/gym/GymPowerUpLeveling.ts:185`);
  they stay at the shipped cadence.
- **`GymCurveSequencer`** — consumes `player`, `powerUps`, `seed` by
  **forwarding** them to the launched `GymLevel` (`_launchData`,
  `src/scenes/gym/GymCurveSequencer.ts:702`), and is no longer
  setup-incapable in the capture registry (`SCENE_SETUP_INCAPABLE_TARGETS` is
  empty). Limitation: the editor has no player and no intrinsic content RNG
  (its waves are derived deterministically from the curve), so
  `applySceneSetup` is a documented no-op there; the edited curve and launched
  level/wave are interactive editor launch parameters, not setup fields, and
  the recorded editor segment is the editor UI by design.

- **`GymHangar`** — consumes `player`, `powerUps` and `seed`. The hangar
  payload view has no player and no intrinsic content RNG, so
  `applySceneSetup` is a documented no-op there; the seed is consumed by
  `init` to generate the deterministic sample payload it renders (a
  payload injected as launch data wins). Pinned by
  `src/scenes/gym/GymHangar.test.ts`.
Adoption is pinned by `src/scenes/gym/gymSceneSetupAdoption.test.ts`: per gym,
a supplied setup's loadout/levels are live in the first observed frame, a
supplied seed reproduces the content, and no setup keeps the historical
bare-cannon loadout and `Math.random` stream.

## Divergences closed by AH-0MVRMHWNC002H4B5

Every entry below was fixed by the fix item (AH-0MVRMHWNC002H4B5), and each
corresponding matrix row verdict is now `parity`. The entries are retained as
the record of the observed vs expected behaviour, the evidence and the fix that
closed them; the regression test named in each is the guard against a relapse.

### D1 — `GymBoss`: the boss hit pool ignores the player's permanent upgrades

**State: fixed by AH-0MVRMHWNC002H4B5.** `GymBoss` now builds the boss with the
scaled pool the game resolves (shared `playerPowerScore`/`scaledEncounterHp`),
keeping the `bossHitsRemaining` preview absolute. Regression test:
`src/scenes/gym/GymBoss.test.ts` — `GymBoss — D1 parity`.

- **Observed:** `GymBoss` constructs the Boss with only `initialHp`
  (`src/scenes/gym/GymBoss.ts:122`), so every phase stays at
  `BOSS_HIT_POINTS_PER_PHASE` (50) no matter how far the ship's weapons and
  power-ups have been levelled.
- **Expected:** `PlayScene.spawnBoss` passes
  `hitPointsPerPhase: scaledEncounterHp(BOSS_HIT_POINTS_PER_PHASE, getPlayerPowerScore())`
  (`src/scenes/PlayScene.ts:2778`; `playerPowerScore` at
  `src/core/difficultyScaling.ts:43`, `scaledEncounterHp` at `:65`).
- **Impact:** the gym enables the drop layer (`GymBoss.ts:116`), so a designer
  who collects power-ups faces an easier boss than the same run would in the
  game — the tuning signal is wrong for an upgraded ship.
- **Reproduce:** boot `GymBoss`, collect weapon/power-up levels, read the
  Boss's phase hit pool (`getBoss()`); it is unchanged. Do the same in
  `PlayScene` and it scales.
- **Expected fix:** pass
  `scaledEncounterHp(BOSS_HIT_POINTS_PER_PHASE, playerPowerScore(player.getWeaponLevels(), player.getPowerUpLevels()))`
  into the Boss construction, keeping the `bossHitsRemaining` setup override
  intact, and pin it with a parity test. No balance change: the formula and
  constants stay the game's.
- **Do not "fix":** `GymMiniBoss`'s fixed pool is a documented gym-only tuning
  choice (`MINI_BOSS_GYM_HP_PER_PHASE`, `src/scenes/gym/GymMiniBoss.ts:78`) for
  fast phase stepping; it stays.

### D2 — `GymLevel` / `GymBotTuning`: Diver re-anchor and glide are not applied

**State: fixed by AH-0MVRMHWNC002H4B5.** The rule is now the shared
`FormationReanchorController` (`src/scenes/core/formationReanchor.ts`) consumed by
`PlayScene`, `GymFormationScene` and `GymLevel`, registered in
`EPIC_SHARED_HELPERS`. Regression test: `src/scenes/gym/spawnParity.test.ts` —
Diver re-anchor parity (D2).

- **Observed:** `GymLevel._moveEnemies`
  (`src/scenes/gym/GymLevel.ts:1386`–`:1463`) positions every spawned enemy from
  `startX + driftX` (or the march state) and runs the shared wrap. It never
  calls `consumeFormationReanchor()`, never re-bases the formation, and never
  runs `FormationGlide`. A Diver in a launched level therefore returns to a
  stale formation base after its dive attack and the block does not glide.
- **Expected:** `PlayScene._moveEnemies` runs the Diver re-anchor
  (`src/scenes/PlayScene.ts:2422`, diver branch `:2508`,
  `_applyFormationReanchor` `:2454`/`:2550`) and the glide (`:2528`);
  `GymFormationScene` runs the same rule (`src/scenes/gym/core/GymFormationScene.ts:1644`,
  `:1662`, `:1898`).
- **Impact:** `diver` is in the sequencer's default candidate pool
  (`src/core/difficultySequencer.ts:263`), so generated levels launched from the
  curve editor and random levels flown by `GymBotTuning` exercise the divergent
  path — a bot in the gym learns a different Diver return than the game's.
- **Reproduce:** launch a level containing a `diver` group, let a Diver finish a
  dive, and compare the block base/diver landing frame-by-frame with
  `PlayScene` under the same `dt`.
- **Expected fix:** extract the positioning + re-anchor + glide pass into a
  shared seam under `src/scenes/core/` consumed by `PlayScene`,
  `GymFormationScene` and `GymLevel`; register it in `EPIC_SHARED_HELPERS` /
  `EPIC_SHARED_METHODS`; add a cross-scene test with an identical seeded
  `diver` wave.

### D3 — `GymLevel` / `GymBotTuning`: spawner-delivered archetypes and hazards are not reproduced

**State: fixed by AH-0MVRMHWNC002H4B5.** The plan/release rule is now the shared
`src/scenes/core/dynamicSpawnPlan.ts` (`planGhostWaveSpawns`,
`planCentipedeWaveSpawn`, `planHordeWaveSpawns`,
`planLaneTrafficWaveSpawns`, `planStrikeWaveSpawns`, `releaseDueSpawns`) consumed by
`PlayScene` and `GymLevel` and registered in `EPIC_SHARED_HELPERS`. Regression
tests: `src/scenes/gym/spawnParity.test.ts` — spawner-delivered content parity
(D3), and `src/scenes/core/dynamicSpawnPlan.test.ts`.

**Orbital strikes and the planner's wave index (AH-0MVTZ6U94000KHA2).** The
strike plan is driven by the campaign-cumulative wave index
(`WaveManager.globalWaveIndex` = waves of earlier levels + the level's wave
index), which also feeds the asteroid hazard. `GymLevel` used to count only its
own session waves from 0, so a launched level above level 1 — or one started
at a later `startWave` — planned a different hazard/strike schedule than the
same level in the game. The gym now seeds `globalWaveIndex` from the launched
level and start wave exactly as the game computes it. The D3 parity suite
covers all five archetypes, including a cross-scene **orbital-strike** case that
starts both scenes on campaign level 1's fourth wave (`startWave: 4`, index 3 —
the first strike wave) rather than playing through to it.

- **Observed:** `spawnWave` iterates only `wave.groups`
  (`src/scenes/gym/GymLevel.ts:359`) and `_planAsteroidSpawns` plans only the
  asteroid hazard (`:977`). The per-wave spawner flags `ghosts`, `centipede`,
  `horde` and `laneTraffic` (`src/waves/Formations.ts:96`–`:122`) and the
  defences' `orbital-strike` hazard are silently ignored, so a launched
  campaign `LevelDefinition` is missing those enemies/hazards.
- **Expected:** `PlayScene` plans and releases them through shared modules:
  ghosts `planGhostSpawns` (`src/scenes/PlayScene.ts:2060`), Centipede
  `_spawnScheduledCentipede` (`:2196`), horde `planHordeSpawns` (`:2239`), lane
  traffic `planLaneTrafficSpawns` (`:2333`)/`_releaseDueLaneTrafficSpawns`
  (`:2367`), orbital strikes `planStrikeSpawns` (`:1888`)/`_spawnScheduledStrike`
  (`:1942`).
- **Impact:** the parent user story "a designer launching a campaign level wants
  a faithful preview" is only partly satisfied: wave-group content matches, the
  spawner-delivered content does not.
- **Latency note:** the current curve-editor route launches sequencer-generated
  levels, which carry only `groups`, so the gap is latent for today's UI. It
  becomes live as soon as a full campaign `LevelDefinition` is passed to
  `GymLevel` (`GymLevelData.waves`).
- **Reproduce:** `scene.start('GymLevel', { waves: LEVELS[6].waves })` (level 7)
  — the `centipede` wave spawns no chain; level 8 — no lane traffic or horde;
  level 9 — no orbital strikes.
- **Expected fix:** extract the per-wave dynamic-spawn plan/release orchestration
  (`ghosts`, `centipede`, `horde`, `laneTraffic`, `orbital-strike`) into shared
  seams under `src/scenes/core/` consumed by both scenes, and pin it with a
  cross-scene test. If the producer decides those scenarios must stay
  game-only, reclassify this row as `intentional divergence` with the reason
  recorded and no behaviour change.

### D4 — `GymPowerUpsCombat`: the scout threat wave bypasses the enemy factory and spawn presentation

**State: fixed by AH-0MVRMHWNC002H4B5.** The scout formation is built through
`createEnemyFromConfig` and runs the shared in-place spawn presentation. Regression
test: `src/scenes/gym/GymPowerUpsCombat.test.ts` — D4 parity.

- **Observed:** `_spawnScoutFormation`
  (`src/scenes/gym/GymPowerUpsCombat.ts:390`) builds each threat with
  `new Scout(...)` (`:393`). Consequences:
  1. the active `scout` `EnemyConfig` (`src/data/enemy-configs.csv`,
  `loadEnemyConfig('scout')`) is ignored — size, colours, bullet geometry,
  `fireInterval`, `shotProbability`, `health`, `forceFieldHits`, `wrapAware`
  and the injected `rng` never reach the entity; and
  2. the shared spawn presentation is skipped — the scout is fully formed on
  spawn, is not `setSpawning`, and gets no spawn-protection window.
- **Expected:** the game spawns every archetype through
  `createEnemyFromConfig` + `startSpawnAnimation`
  (`src/scenes/PlayScene.ts:1696`, `:1712`; factory `src/entities/enemyFactory.ts:209`).
  The analogous in-place gym fixture `GymBoss._spawnBossMinions` already does
  this through the shared transit exemption (`src/scenes/gym/GymBoss.ts:270`–`:300`).
- **Impact:** the gym's threat behaves differently from the tuned archetype and
  from the game: a `health: 2` or `shotProbability` tuning edit applies in the
  game but not here, and threats become hittable/firing a frame before the
  game's would.
- **Reproduce:** boot `GymPowerUpsCombat` and read `getEnemyEntities()[0]` —
  full-size and not spawning on the first tick; set `scout.health = 2` in the
  config store and the gym scout still dies in one hit, while a `PlayScene`
  scout does not.
- **Expected fix:** build the formation through `createEnemyFromConfig`, then
  run `resolveSpawnTransitTarget({transit:false})` + `startSpawnAnimation` for
  each scout (or spawn through the shared formation seam), setting
  `shootEnabled` from the gym toggle as now; pin it with a cross-scene test.

## Spawn divergences closed by AH-0MVRMHSKH0066J9B

The three start-of-wave divergences reported with this sweep's parent are
**fixed-by-sibling** and are not open rows here. Each is pinned by
`src/scenes/gym/spawnParity.test.ts` (red-before recorded on
AH-0MVRMHJZS001Z6CX, flipped green by the fix):

| Divergence | State | Evidence |
|---|---|---|
| Orbital transit (Phasers spawn in a line then snap) | fixed-by-sibling | `GymLevel.spawnWave` passes the spawned entity to `resolveSpawnTransitTarget`, so the live `formationSlot()` is authoritative (`src/scenes/gym/GymLevel.ts:445`); test `src/scenes/gym/spawnParity.test.ts:354` |
| `shootEnabled` hand-off | fixed-by-sibling | the wave's rule is copied onto every spawned entity (`src/scenes/gym/GymLevel.ts:408`); test `src/scenes/gym/spawnParity.test.ts:496` |
| March block | fixed-by-sibling | shared `createMarchState`/`advanceMarch` drive the block (`src/scenes/gym/GymLevel.ts:920`, `:1405`, `:1447`); test `src/scenes/gym/spawnParity.test.ts:557`, `GymBotTuning` inheritance `:690` |

The destination rule itself is defined once in
[`src/scenes/core/spawnTransit.ts`](../src/scenes/core/spawnTransit.ts) and
registered in `EPIC_SHARED_HELPERS`
(`src/scenes/core/CombatScene.equivalence.test.ts:2615`), so a fourth copy fails
the duplicate-body guard.

## Intentional divergences (re-justified, not to be "fixed")

| # | Divergence | Scene(s) | Reason and where it is recorded |
|---|---|---|---|
| 1 | Obstacle course | `GymPlayer` | Gym-only thruster-navigation training; the game has no static hazards. Recorded in `src/scenes/gym/GymPlayer.ts:23` and `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §5.1 ("the Player gym's obstacle course") |
| 2 | AOE practice targets | `GymWeapons` | Inert static `TrainingTarget`s exist only so the shared Nova/Mortar/Arc resolution and VFX are visible in a threat-free gallery; the AOE code itself is shared. Recorded in `src/scenes/gym/GymWeapons.ts:120`, `:165` and §5.1 |
| 3 | Flat supply cadence in `GymFormationScene`-derived gyms | `GymFormationScene` + all subclasses | No campaign-level input, so the scene-specific flat `rules.powerUpSpawnInterval` source stays; `GymLevel`/`GymBotTuning` adopt the level curves. Recorded in `src/scenes/gym/core/GymFormationScene.ts:982`, `src/scenes/gym/GymLevel.ts:58`, §5.1 and [`docs/BALANCING.md`](./BALANCING.md) |
| 4 | Gym-only HUDs, controls, tuning panels and demonstration supply sources | all gyms | HUD lead lines, DAMAGE/EXPLODE/SHOOT/INDEX controls, DOM tuning panels, fixed mini-boss pool, seeded mineral fields and round-robin drop sources exist to make a scenario legible and deterministic; none of them replace a gameplay object's code. Recorded per scene (e.g. `GymBoss.ts:186`, `GymMiniBoss.ts:78`, `GymFodderEnemies.ts:204`, `GymPowerUpLeveling.ts:88`) |
| 5 | Absence of run telemetry | all gyms | Telemetry is a shipped-run concern only (`src/scenes/core/runTelemetry.ts`, used by `PlayScene.ts:838`); a gym has no run to report |
| 6 | Curve-editor scene is not a combat scene | `GymCurveSequencer` | The editor launches `GymLevel` instead of duplicating combat; recorded in `src/scenes/gym/GymCurveSequencer.ts:1` and `scripts/capture-scenes.mjs:407` |
| 7 | Auto-fire disabled in threat-free/demonstration gyms | `GymPowerUpsCombat`, `GymPowerUpsUtility` | Disabling a player capability is a permitted difference (a disabled feature, never a divergent copy); the defensive power-ups are the demonstration. Recorded at `GymPowerUpsCombat.ts:317` and `GymPowerUpsUtility.ts:232` |
| 8 | Force-field sliders set hits directly in `GymFodderEnemies` | `GymFodderEnemies` | A formation gym has no campaign level, so the level curve cannot be evaluated; the game and `GymLevel` always use the shared curve. Recorded in `src/scenes/gym/GymFodderEnemies.ts:283`, `:431` |
| 9 | Hangar-war payload view is not a combat scene | `GymHangar` | The gym renders the shipped hangar screen (`src/scenes/hangarWar/hangarScreen.ts`) against an injected hangar-war payload, read-only; economy, banking, defence and frontier resolution are pure modules under `src/core/hangarWar/`, so there is no gameplay object to demonstrate and no divergent copy. Recorded in `src/scenes/gym/GymHangar.ts:1` and `scripts/capture-scenes.mjs` |

## Maintenance contract

- A row's **verdict** must be exactly one of `parity`,
  `intentional divergence` or `divergence to fix`; the guard enforces it.
- Every row's **reason / evidence** cell must name a file or document section;
  the guard enforces a reference.
- A new production `Gym*.ts` scene under `src/scenes/gym/` without a row fails
  `src/scenes/core/gymParityDocs.test.ts`, so this matrix cannot rot.
- Fixes never adapt `PlayScene` to a gym. A divergence is closed by making the
  gym consume shared code (and registering any new seam in the duplicate-body
  guard).
