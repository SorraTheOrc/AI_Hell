# Enemy Design and Implementation

This document is the **authoritative guide for implementing enemy gym scenes and
enemy entities** in AI_Hell. It maps the enemy design from the Game Design
Document (GDD §4.x) to concrete implementation rules, and documents the shared
**core gym formation-scene library** so every enemy gym scene is a thin,
focused scene class instead of a copy of the same ~200-line boilerplate.

Audience: **AI agents and developers implementing AI_Hell** — especially the
E4 Phaser, E5 Swarm and Boss gym scene work items, and any future enemy.

---

## 1. Enemy catalog (GDD §4.1 / §4.3)

| ID | Name | GDD | Behaviour | Appearance | Fires (L1–3 → L4+) |
|----|------|-----|-----------|------------|---------------------|
| E1 | Scout | §4.1 | V-formation flight, subtle wiggle | Small angular chevron, neon green | none → aimed shot |
| E2 | Diver | §4.1 | Vertical dive toward player (x locked at formation slot), returns to current formation slot. The whole cluster holds its drift while a living Diver is away (`DIVING`/`PAUSING`/`RETURNING`) and resumes once every Diver has rejoined | Medium dart shape, neon yellow | none → short-burst spread (3–5) |
| E3 | Tank | §4.1 | Slow deliberate formation, long hold positions | Large hexagonal/blocky, neon | none → radial burst (10 shots) |
| E4 | Phaser | §4.1 (L5) | Fixed orbital path, predictable firing cycles | Circular ring with central core | yes — patterned, telegraphed (≥ 500 ms lead) |
| E5 | Swarm | §4.1 | Tight fast clusters, sudden direction changes | Small diamonds, groups | none → coordinated burst |
| E6 | Asteroid | §4.1 | Free-roaming straight-line drift (screen wrap), continuous rotation, splits into two smaller rocks when shot | Jagged procedural neon polygon (grey), 3 size tiers | **never fires** |
| Boss | The Central AI | §4.3 | 4 attack phases, multi-hit health (4-phase bar) | Large neon geometric structure with core | complex patterns per phase |

All enemies are **1 HP** (single bullet destroys them, except the Boss which is
multi-hit) and **never collide with each other** (GDD §2.6) — no collision
system is installed in the gym scenes.

### 1.1 Data-driven enemy pipeline (AH-0MTFP7EIC004F1MN, CSV AH-0MTZWZ9TE009CVUA)

Enemy tuning is data, not code. Each archetype is a row in the committed
`src/data/enemy-configs.csv`; at boot the config store parses/validates it into
typed `EnemyConfig` objects and the scenes/factory consume the synchronous
loaders. Retuning an enemy — or adding a new one — is a CSV edit (or a gym
**Save** / **Save As…**), with no TypeScript change required. See §8 for the
full schema, codec, config-store and Vite-plugin reference.

### 1.2 E6 Asteroid — the roaming, self-splitting rock (AH-0MU8BZ2ZM004J47F)

The Asteroid is the first **non-formation** enemy: it does not use the
formation-drift model at all. It drifts in a straight line at constant
velocity, wraps around all four screen edges (matching the player ship's
wrap), rotates continuously, and **never fires** — `shootEnabled` is a
no-op setter and the effective shot pattern is always `none`.

**Three size tiers** (`src/entities/Asteroid.ts`):

| Tier | Half-size | Speed | Rotation | Colour |
|------|-----------|-------|----------|--------|
| large | 28 px | 18 px/s (≈ Tank) | 0.5 rad/s | 0x888888 |
| medium | 18 px | 27 px/s | 0.9 rad/s | 0xaaaa88 |
| small | 12 px | 36 px/s | 1.4 rad/s | 0xccccaa |

**Splitting**: destroying a `large` asteroid spawns exactly **two** `medium`
children at its position; a `medium` spawns two `small`; a `small` destroys
cleanly with no children (the chain from one large is 1 + 2 + 4 = **7**
destroyed enemies). `getSplitChildren()` returns the child specs (tier +
position + velocity + rotation); the two children always move in directions
**different from the parent and from each other** (≥ π/3 separation).

**Wave-aware splitting**: dynamically spawned children MUST be registered with
the `WaveManager` — the scene calls `registerDynamicSpawn(n)` when spawning
children and they count toward `enemiesAlive`, so the wave neither clears
early nor stalls. See `PlayScene._splitAsteroid`.

**Scoring** (GDD §4.5): large and medium asteroids award **no** points; small
asteroids award **50** (`SCORE_VALUES.asteroid`, tier-checked in
`PlayScene._onEnemyKilled`). Collision (ramming) kills award no points, as
always.

**Wave placement — random offscreen spawner**: Asteroids are **not** a fixed
group in Level 1 Wave 1. Every regular wave plans its asteroid spawns with the
pure planner `src/waves/AsteroidSpawner.ts` (`computeSpawns`), and
`PlayScene.planAsteroidSpawns()` / `_releaseDueAsteroidSpawns()` release each
one on schedule during `tick(dt)`:

- **Offscreen origin**: a random edge (top/bottom/left/right, uniform), placed
  half-size + `ASTEROID_SPAWN_OUTWARD_MARGIN` beyond the viewport, with inward
  velocity (perpendicular to the edge, ±30° spread) at the tier's canonical
  speed. Offscreen spawns defer screen-wrap until their centre enters the
  viewport (`AsteroidConfig.enterFromOffscreen`), so they visibly drift in
  rather than teleporting to the opposite edge.
- **Count escalation**: 2 per wave, doubling when the large weight reaches the
  reset threshold (2 → 4 → 8 …).
- **Size weighting**: medium **80** (fixed); large **20 + 20 per wave**, reset
  to 20 when it reaches 2× medium (**160**), at which point the count doubles.
- **Timing**: the wave window is split into equal segments with ±5% jitter; the
  first asteroid is constrained to the first 10% of the window.
- **Registration**: each released asteroid is registered with the `WaveManager`
  via `registerDynamicSpawn(1)`, so wave-clear accounting includes it (the same
  path the split children use).

The **boss encounter spawns no asteroids**: `planAsteroidSpawns()` clears the
plan outside a regular wave and the release loop is guarded on boss state.
`PlayScene.setAsteroidSpawnerEnabled(false)` is a tuning/test seam that
suppresses the spawner entirely.

**Gym support**: the asteroid is selectable in the enemy gym (auto-discovery
via `DEFAULT_ENEMY_CONFIGS`). `GymFormationScene` gained two small seams —
optional `updatePosition(dt)` on `FormationSceneEntity` (roamer motion) and
optional `onEntityDestroyed(entity)` on `EnemyFormationConfig` (dynamic split
children) — so EXPLODE, player bullets and body-rams all cascade splits and
the wipe→respawn cycle runs only once the whole chain is cleared.

Enemy archetypes are **data, not code**. The runtime type is `EnemyConfig`
(`src/core/configTypes.ts`) — a record of formation, visual and shot tuning.
Seven **seed configs** (scout/diver/tank/phaser/swarm/boss/asteroid) live in
`src/core/configDefaults.ts` as the built-in fallbacks. Every other behaviour
— formation geometry, bullet dispatch, gym index listing — derives from the
config + small registries instead of per-enemy scene classes.

**Persistence.** Each archetype is one row in the committed CSV
`src/data/enemy-configs.csv` (the single source of truth). At boot the entry
point (`src/core/boot.ts`) awaits `loadConfigs()` before the Phaser game is
constructed, and the config store (`src/core/configStore.ts`) reads, parses and
validates it; a missing or malformed file falls back to the seed defaults
without throwing. A row that is
partly invalid coerces to defaults (malformed numbers → `0`, invalid hex →
`0x000000`, invalid enums → the default enum). For seed keys the registry
`displayName` is **authoritative**, so a stale CSV label (for example an older
"Boss") cannot shadow a rename; only `Save As…` (a new key) introduces a new
label. The available keys come from the CSV-backed registry
(`listEnemyConfigKeys()` / `loadAllEnemyConfigs()`), so a new `Save As…` row
becomes discoverable without code changes.

> **Breaking change:** `localStorage` is no longer the source of truth for
> config values. The old `ai-hell-enemy-config:<key>` / `ai-hell-ship-config`
> entries are ignored (leaderboard and settings still use `localStorage`).

**Gym surface.** `GymEnemies` (`src/scenes/gym/GymEnemies.ts`,
key `GymEnemies`) is the **single reusable gym scene**. It is parameterized
by `{ enemyKey }` via `init()` → `loadEnemyConfig(enemyKey)` and derives
formation/bullet behaviour from the loaded config. The gym index (`GymIndex`)
enumerates enemy configs — one clickable row per config (label
`displayName`) that boots `GymEnemies` with that `enemyKey` — rather than
hard-coded per-enemy scenes. The index renders three columns — plain scenes,
**ENEMIES** (non-boss configs) and **Bosses** — and both boss rows live in
the right-hand **Bosses** column: the `boss` config row labelled
**"Boss Swarm"** (it is a plain single-enemy archetype, not the multi-phase
Central AI) routed to `GymEnemies`, and the dedicated `GymBoss` scene
labelled **"Boss"** that boots `GymBoss` directly. `GymBoss` is excluded
from the plain scene list (left column) so the real boss is not duplicated
as a bare scene (AH-0MUAYB28C004KK7X, AH-0MTV8OV9V002D8B7). Legacy
`GymScout`/`GymDiver`/… scenes have been
retired; their formation/bullet assertions now live in `GymEnemies.test.ts`
keyed by `enemyKey`.

---

## 2. Core library architecture

### 2.1 What the core library is

`src/scenes/gym/core/GymFormationScene.ts` is a generic base class that
**extends the shared `src/scenes/core/CombatScene.ts` abstract combat
core** (which itself extends the narrower `src/scenes/core/CombatCoreScene.ts`;
type parameters `<TEntity, TBullet>`) and encapsulates everything
the first three enemy gym scenes duplicated:

- **Shared combat/lifecycle core** — inherited from `CombatScene` /
  `CombatCoreScene` (AH-0MUD8E015004C4JO; standalone-gym consolidation
  AH-0MUDCT7EU0061OSZ). The eight combat/lifecycle template methods
  (`_handleCollisions`, `_hitPlayer`, `_autoFire`, `_collectDrop`,
  `_spawnPlayerExplosion`, `_clearEnemyBullets`, `_handleTeleport`,
  `_readPlayerInput`) are defined exactly once across all production scenes —
  the input/auto-fire/drop-collection group in `CombatCoreScene`, the
  combat-only collision/hit/teleport group in `CombatScene` — and dispatch to
  overridable hooks. The gym supplies
  its participant accessors (`getEnemyEntities()` → `entities`,
  `getEnemyBullets()`/`setEnemyBullets()` → `bullets`) and its hooks
  (`canTeleport()` → `powerUpsEnabled || hasTeleport()`, `getEnemyBulletRadius()` →
  `config.bulletHitRadius`, `onEnemyDestroyed()` →
  `config.onEntityDestroyed`, teleport-radius hooks); the game supplies its
  own. Bullet-vs-bullet impact feedback is likewise hosted once in the
  shared path. The shipped game and the gyms therefore cannot diverge on
  collision, auto-fire, drops, teleport or player-hit behaviour.

  **Shared P3/P6 hit-gating (**AH-0MUHM66ES0027QQV**).** The shield/phase
  hit-gating hooks are part of the shared core and are **not** per-scene
  overrides: `CombatScene` provides the registry-backed defaults
  `isPlayerPhased()` → `getEffectsRegistry().isPhased` and
  `tryAbsorbPlayerHit()` → `getEffectsRegistry().tryAbsorbShield()` (consume
  **one** shield, run the `onShieldAbsorbed()` cue seam, start the shared
  post-hit invulnerability window, return `true`). `CombatCoreScene` keeps
  its safe non-combat `false` defaults for threat-free direct subclasses
  (`GymWeapons`, `GymPowerUpsUtility`). Every `CombatScene` subclass
  inherits the gating exactly once — `PlayScene`, `GymPowerUpsCombat`, and
  `GymFormationScene` (`GymEnemies`/`GymBoss`/`GymMinerals`) — so collecting
  P3 Shield or P6 Phase Shift behaves identically in the shipped game and
  the enemy gym. **No scene should re-implement these hooks**; a scene may
  add a per-type cue only through the `onShieldAbsorbed()` seam. The P3
  shield-bubble and P6 phase-ghost player visuals live once in
  `src/scenes/core/CombatEffectVisuals.ts` and are used by all three scenes
  (see §7.2).

  **Hold-full rewards in the mineral gym (**AH-0MUHMXWGC0058BO4**).**
  `GymMinerals` has no field power-up drops, so its rewards come from the
  hold-full choice overlay. Because the choice can grant P7 Teleport, the
  S / ↓ teleport keys are bound whenever a player exists and the shared
  `_handleTeleport()` runs every tick — independent of `powerUpsEnabled` —
  so a stored P7 use is consumable; `canTeleport()` accepts a stored use in
  addition to the opt-in drop layer. The effects registry ticks (and the
  HUD refreshes) every frame in all formation gyms, so a P6 granted on
  teleport arrival expires normally. The overlay renders the caller's
  stored options, so the displayed label is the option applied.

- **Formation spawn** — builds offsets, creates each entity at
  `(baseX + col * spacingX, baseY + row * spacingY)`, and calls
  `add.existing()` so entities actually render (see §4.1).
- **HUD controls** — the `EXPLODE` / `SHOOT: ON/OFF` buttons, the status
  line, the bottom hint line, and the shared `← INDEX` back button. The
  in-canvas controls and right-aligned status line sit in the **bottom-right**
  (the hint line stays centred) so they never collide with the bottom-left
  anchored gym editor panels (AH-0MUAYB7O4009LWBF).
- **Update loop** — formation drift + respawn off the left edge,
  per-entity `applyFormationPosition()`, fire-bullet collection, bullet
  advance with four-edge wrap, and lifetime-based bullet expiry.
- **Shared projectile lifecycle** (AH-0MUII3CF00024EDM, gap 3) — the
  enemy-bullet advance + four-edge wrap + lifetime expiry above is owned
  once by `src/scenes/core/bulletLifecycle.ts` (`advanceWrappingBullets`),
  and player-bullet advancement (`advancePlayerBullets`, delegating to
  `advanceAndCull`) is shared too. Consumed by `PlayScene`,
  `GymFormationScene`, `GymWeapons` and `GymPowerUpsCombat` so the
  semantics cannot drift; bullets are never culled off-screen — they wrap
  across the seam and expire only by lifetime (AH-0MU960UTE001PTV0). The
  single definition and the cross-scene equivalence are pinned by
  `src/scenes/core/CombatScene.equivalence.test.ts`.
- **Shared enemy-fire dispatch** (AH-0MUII3BBW000XZ46, gap 2) — the
  archetype-key → `tryFire*` mapping lives once in
  `src/entities/enemyFire.ts`: `fireForEnemy(entity, enemyKey, now)` reads a
  single `ENEMY_FIRE_METHODS` table and normalises a `null`/single/array
  result to a bullet array. `PlayScene`, `GymEnemies` and
  `GymPowerUpsCombat` all route through it, so a new archetype is wired by
  one table entry and every scene fires it with the same cadence. The helper
  takes the scene clock as an explicit `now` argument — never a frame-count
  accumulator — so the combat gym's fire timing matches the game's. The
  single definition is pinned by
  `src/scenes/core/CombatScene.equivalence.test.ts` and the
  dispatch/fallback behaviour by `src/entities/enemyFire.test.ts`.
- **Wipe → 3 s countdown → respawn** (AH-0MTFXKA5Q003LBH5) — when every
  enemy is killed (`aliveCount === 0`, i.e. `alive === false` after
  `destroySelf()` — mid-explosion counts), the base scene starts a
  visible 3-second centred countdown (`Respawning in 3…2…1…`, driven by
  `tick(dt)` wall-clock seconds), clears enemy bullets, recreates the
  full formation at `config.startX/startY` with the original
  `count/spacing` geometry, resets `formationBaseX/Y`, hides the
  countdown, and plays `playSpawnSound()`. `shootEnabled` carries over;
  player bullets persist. The countdown is torn down on scene
  `SHUTDOWN` so a restart never leaks. Test seams:
  `isRespawnCountdownActive()`, `getRespawnCountdownRemaining()`,
  `getRespawnCountdownText()`. Core-library owned — every formation gym
  (`GymEnemies` for every `enemyKey`) inherits it with no per-scene code.
- **Shared restart/teardown lifecycle** (AH-0MUII3FYN0072QRT, gap 10) — the
  per-run reset/teardown lives once in `CombatCoreScene.resetRunState()` /
  `teardownRunState()`. `create()` calls `resetRunState()`, which clears the
  active `EffectsRegistry` through the polymorphic `getEffectsRegistry()`
  accessor — so a gym that owns its own registry (every gym) is cleared by
  the same code as the shipped game — plus the shared bullet/effect/animation
  registries; `SHUTDOWN` calls `teardownRunState()`, which destroys those
  registries and resets the effects registry. `CombatScene` overrides both to
  add invulnerability, hit-count, teleport-key and bullet-impact state;
  `GymFormationScene`, `GymWeapons`, `GymPowerUpsCombat` and
  `GymPowerUpsUtility` override them to add their own object families
  (enemies, drops, minerals, player, HUD) and call `super` first. `GymPlayer`
  (a bare `Phaser.Scene`) resets its ship/input in the same create/SHUTDOWN
  pair. A stop/restart of any instance therefore starts with a clean registry
  and no leaked display objects, and the behaviour is pinned by the
  restart/teardown parity tests in `GymFormationScene.test.ts` and each gym's
  test file.

The generic geometry (formation offsets) lives in
`src/utils/formations.ts`:
`FormationOffset`, `buildVFormationOffsets`, `buildDiverFormationOffsets`,
`buildRectFormationOffsets`. These are pure functions — unit-test them
directly without booting a scene.

**Formation & shot registries** (see §2.4): formation kinds map to builder
functions (`FORMATION_BUILDERS` / `getFormationBuilder(kind)` with a safe
`buildVFormationOffsets` fallback for unknown kinds), and shot patterns are
validated by `src/utils/enemyShotPatterns.ts` (`VALID ShotPattern` set,
`sanitizeShotPattern` → `'none'`). Together they keep `EnemyConfig` small
and `GymEnemies` free of per-type branches.

### 2.2 Configuration contract

A concrete scene supplies an `EnemyFormationConfig<TEntity, TBullet>`:

```ts
const SCOUT_CONFIG: EnemyFormationConfig<Scout, ScoutBullet> = {
  sceneKey: 'GymScout',           // Phaser scene key == class name
  buildOffsets: buildVFormationOffsets, // (count) => FormationOffset[]
  count: SCOUT_FORMATION_COUNT,   // enemies in the formation
  spacingX: SCOUT_FORMATION_SPACING_X,
  spacingY: SCOUT_FORMATION_SPACING_Y,
  driftSpeed: SCOUT_FORMATION_DRIFT_SPEED,
  startX: SCOUT_FORMATION_START_X,
  startY: SCOUT_FORMATION_START_Y,
  player: PLAYER_SPAWN,        // spawn the Player ship here (see §7)
  statusLabel: 'scouts',          // status line: "SCORE: n/a — scouts: 6"
  hintText: 'E1 Scout gym — V-formation demo',
  createEntity: (scene, x, y, formationOffset) =>
    new Scout(scene, { x, y, formationOffset }),
  collectBullets: (scout, now) => fireForEnemy<ScoutBullet>(scout, 'scout', now),
};
```

| Field | Purpose |
|-------|---------|
| `sceneKey` | Phaser scene key — must equal the class name (`GymScout`). |
| `buildOffsets` | Formation geometry; reuse the builders in `src/utils/formations.ts`. |
| `count` / `spacingX` / `spacingY` / `driftSpeed` / `startX` / `startY` | Formation tuning constants — export them from the scene for tests. |
| `statusLabel` | Lowercase plural noun shown in the status line. |
| `hintText` | Bottom hint line. |
| `createEntity` | Factory for one enemy at an absolute position + its formation offset. |
| `collectBullets` | Called per entity per frame; returns any bullets that entity fired (empty array if none). Configs normally delegate to the shared `fireForEnemy(entity, enemyKey, now)` dispatcher (see §2.1) rather than mapping `tryFire*` names themselves. |
| `player` | *Optional* player spawn position `{x, y}` — when present the scene spawns the keyboard-controlled Player ship there with live combat interaction (see §7). |

### 2.3 Entity & bullet contracts

Entities must satisfy `FormationSceneEntity` (extend
`Phaser.GameObjects.Container` — this is what makes `add.existing` work):

```ts
interface FormationSceneEntity extends Phaser.GameObjects.GameObject {
  readonly alive: boolean;
  shootEnabled: boolean;
  readonly offset: FormationOffset;
  destroySelf(): void;
  applyFormationPosition(baseX, baseY, dt, spacingX, spacingY): void;
  /** Optional live-aim seam: update the fire/dive target to the player's
   *  current position. The base scene pushes this each frame (see §7). */
  setAimTarget?(x: number, y: number): void;
}
```

Bullets must satisfy `FormationSceneBullet`:

```ts
interface FormationSceneBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx: number;
  vy: number;
}
```

See `src/entities/Scout.ts`, `src/entities/Diver.ts`, `src/entities/Tank.ts`
for reference implementations (the base class drives them).

---

## 3. Best practice: adding a new enemy gym scene

### 3.1 New-scene checklist

1. **Entity first.** Create `src/entities/<Name>.ts` with:
   - a `Container`-based class satisfying `FormationSceneEntity`,
   - a `tryFire…(now)` method returning `null`, a single bullet, or an
     array (whichever fits — the shared `fireForEnemy` dispatcher
     normalises it to an array),
   - `export`ed tuning constants and bullet types,
   - the shared `FormationOffset` type (import from `../utils/formations`).
2. **Formation geometry.** Reuse an existing builder from
   `src/utils/formations.ts`, or add a new pure builder there **with its own
   unit tests** (`src/utils/formations.test.ts`).
3. **Thin scene.** Create `src/scenes/gym/Gym<Name>.ts`:
   - `export class Gym<Name> extends GymFormationScene<Entity, Bullet>` —
     **no copied boilerplate**; only the config, constants, and thin
     type-preserving accessors (e.g. `get formationScouts()`).
   - Keep exporting the formation constants — tests import them.
   - Add test accessors matching this project's convention
     (`formation<Name>s`, `aliveCount`, `shootingEnabled`,
     `activeBullets`, `formationX`, `formationY` — the latter five come
     from the base class). Player accessors also come from the base
     (`getPlayer`, `getCursors`, `getPlayerHitCount`,
     `isPlayerInvulnerable`, `toggleShooting`).
4. **Discovery.** Put the scene at `src/scenes/gym/Gym<Name>.ts` — the gym
   index auto-discovers it (no registry edit). Put any shared/helper code in
   a **subfolder** (`src/scenes/gym/core/`, or `src/utils/` for pure
   helpers) so it is never listed as a scene entry.
5. **Tests.** Write `src/scenes/gym/Gym<Name>.test.ts` (auto-excluded from
   the index). Assert at minimum:
   - spawn count + display-list membership (every entity visible),
   - formation geometry (offset slots),
   - drift over time,
   - EXPLODE destroys one random alive enemy, no-op at zero,
   - SHOOT toggles off→on→off and gates new bullets,
   - the `← INDEX` button exists,
   - the player spawns at the scene's `player` config position, responds
     to the cursor keys, fights (player bullet ↔ enemy / enemy bullet →
     ship respawn), and live enemy aim tracks it (see §7),
   - wipe → 3 s countdown → respawn is automatic and needs **no
     per-scene code** — it is core-library owned (see §2.5); observe it
     via `isRespawnCountdownActive()` / `getRespawnCountdownRemaining()`.
6. **Audio + navigation.** `playSpawnSound()` / `playDestructionSound()`
   and `addBackToIndexButton()` are handled by the base class — do not
   re-add them. Entity-specific fire sounds go in `src/audio/effects.ts`
   and are orchestrated where the shots are produced: Swarm plays a
   single buzzing volley burst sound (`playSwarmBurstSound()`) from its
   entity-level `tryFireBurstBullet()` (no warning cue); Scout uses a
   per-entity two-phase tell — an advance cue (≥ 500 ms
   lead) at tell start, with the fire sound scheduled to start exactly at
   the cue's end so the two flow back-to-back with no dead gap; Phaser
   uses the same two-phase tell pattern (`playPhaserAdvanceCue()` +
   `playPhaserFireSound()`, scheduled at the cue's end); Tank plays an
   entity-level `playTankAdvanceCue()` mechanical-whine flowing with
   **no gap** into a heavy `playTankFireSound()` cannon thump, one
   cue+thump pair per radial burst inside `tryFireRadialBurst()` (the
   whine's ≥ 500 ms duration provides the advance
   lead); the Boss keeps its per-phase telegraph cue (`playBossPhaseCue()`)
   and plays `playBossFireSound()` once per attack volley; Diver plays
   `playDiverFireSound()` (short low/nasal crack)
   exactly once per spread burst from its entity-level `tryFireSpreadBurst()`
   (no advance cue — the fire sound alone is the tell).
   Audio-character decisions are made **per-enemy at implementation
   time** and may deviate from the GDD §7.3 catalog defaults (e.g. Tank's
   heavy thump vs the generic "short zap") — see the GDD §7.3 note.

7. **Destruction sound ownership.** The base class `GymFormationScene.explodeRandom()`
   plays `playDestructionSound()` for all enemies, unless the entity opts
   into a distinct sound via the optional `playDestructionAudio?()` seam on
   `FormationSceneEntity` — the base scene prefers the hook and falls back
   to the shared sound when it is absent (Diver implements the hook to play
   `playDiverDestructionSound()`). Entity classes should NOT call
   `playDestructionSound()` in their `playExplosion()` — doing so would
   double-play the sound. This is a design decision per GDD §7.3
   and the core-library best practices.

### 2.5 Wipe → countdown → respawn lifecycle (AH-0MTFXKA5Q003LBH5)

- **Signal:** `aliveCount === 0` — every `FormationSceneEntity.alive ===
  false` (1 HP enemies, `destroySelf()`). Explosion VFX still playing
  counts as killed.
- **Countdown:** 3 s wall-clock (`tick(dt)`), visible centred text
  (`GAME_WIDTH/2, GAME_HEIGHT/2`, depth 100): `Respawning in 3…` → `2…`
  → `1…` → `Respawning…` (expiry). Observable via
  `isRespawnCountdownActive()` / `getRespawnCountdownRemaining()` /
  `getRespawnCountdownText()` (text overlay, hidden when inactive and
  reusable across wipes). Starts on the tick *after* the wipe is
  observed; races with drift respawn (`_respawnX()`) are orthogonal —
  wipe/respawn resets `formationBaseX/Y` to `startX/Y`.
- **Respawn:** clears enemy bullets only (player bullets persist),
  destroys old entities, recreates the formation via
  `config.buildOffsets(count)` + `config.createEntity()` at
  `startX/startY`-derived positions, restores `shootEnabled` across the
  respawn, refreshes `statusText`, hides the countdown, and calls
  `playSpawnSound()`. Fully repeatable — the next wipe starts a fresh
  countdown.
- **Scope:** core-library owned in `GymFormationScene`; inherited by
  every formation gym (including `GymEnemies` for every `enemyKey`).
  `GymBoss` (multi-phase) is out of scope.
- **Tear-down:** `SHUTDOWN` cancels the countdown and hides the overlay
  so a scene restart never double-fires or leaks.

### 3.2 Existing scenes (reference implementations)

| Scene | Entity | Formation | Fire pattern | Audio |
|-------|--------|-----------|--------------|-------+-------|
| `GymScout` | `Scout` | V (offset columns +2/row) | aimed shot (single) | advance cue (≥ 500 ms) + fire sound scheduled at cue end (entity-level, per aimed shot, no gap between cue and fire sound) |
| `GymDiver` | `Diver` | diamond/chevron | spread burst (array) | `playDiverFireSound()` once per spread burst (entity-level, no advance cue); dive-phase sounds — `playDiverDiveStartSound()` once at the FORMATION→DIVING transition plus a refcounted shared sustained dive voice (`playDiveSound()`/`stopDiveSound()`, ~2 s, stopped at DIVING→RETURNING / destroy); distinct `playDiverDestructionSound()` via the optional `playDestructionAudio?()` seam (once per destruction) |
| `GymTank` | `Tank` | 3-column rectangle | radial burst (array) | mechanical-whine advance cue (≥ 500 ms) + cannon thump (entity-level, one cue+thump pair per burst inside `tryFireRadialBurst()`, no gap between cue and thump) |
| `GymSwarm` | `Swarm` | loose 3–5 clusters (`buildSwarmClusterOffsets`) | coordinated burst (single per member) | volley burst sound (`playSwarmBurstSound()`, entity-level, once per volley, no advance cue) |
| `GymBoss` | `Boss` | single entity (centred) | spread / spiral / pulse / desperation (phase-gated) | per-phase telegraph cue (`playBossPhaseCue()`) at telegraph start + `playBossFireSound()` once per volley (entity-level) |

---

## 4. Known gotchas (browser rendering & conventions)

### 4.1 `add.existing()` — containers are not auto-added

`Phaser.GameObjects.Container` is **not** added to the display list by the
scene automatically. Without `add.existing()`, enemies are invisible in a
real browser while headless tests stay green. The core base class always
calls `this.add.existing(entity)` in its spawn loop — never skip it in a
custom spawn.

### 4.2 `lineStyle()` must come **after** `clear()` in `_drawBody()`

Phaser `Graphics` is command-buffered: `clear()` wipes any styles queued
before it and re-applies the default white 1 px stroke. Entity body drawing
must call `lineStyle()`/`fillStyle()` **after** `clear()`, otherwise the
body renders with the default style (near-invisible white outlines in a
browser — no console error, headless tests stay green). This is regression
tested in `src/entities/Scout.test.ts`.

The failure mode is not limited to an invisible body. Phaser's WebGL
renderer keeps the current stroke tint in a **module-global**
(`strokeTint` in `GraphicsWebGLRenderer.js`), not per Graphics object: a
`strokePath()` with no `LINE_STYLE` queued before it reuses whatever the
previously rendered Graphics left behind. A body with its style wiped by
`clear()` therefore *inherits an unrelated colour* that changes whenever
another Graphics redraws (e.g. the player's per-frame thrust flames), and
because only the **first-rendered** body has no preceding sibling to set a
sane tint, the "wrong" colour appears to move to the next entity as the
first is destroyed. `Tank` hit this variant (AH-0MTVYBL2L0085G6G): its
outer hexagon had no `lineStyle()` after `clear()`, so the first alive tank
changed colour with thrust input and on destruction. Body colour must be
owned by the entity; add a regression test whenever an entity gains a new
`_drawBody()` (Scout, Diver, Swarm and Tank each have one).

### 4.3 Test accessor convention

Scene tests drive the public scene API (`formationScouts`, `aliveCount`,
…). Keep the accessors on the concrete scene class (thin wrappers over the
base's `formationEntities`) so tests never reach into privates.

### 4.4 Keep the scene thin

If a new enemy needs movement that does not fit
`applyFormationPosition()` / the configuration contract (e.g. E4 orbital
paths, E5 clusters, Boss phases), extend the entity's
`applyFormationPosition` or add periodic per-frame hooks **in the entity**,
not by copying the scene boilerplate. If the base class genuinely needs a
new seam, that belongs in `src/scenes/gym/core/GymFormationScene.ts` (plus
its tests) — see §5.

---

## 5. Extending the core library

When a new enemy needs the base scene to behave differently:

1. Add the smallest seam that serves the need (a config field, an optional
   callback, or a protected method).
2. Update `src/scenes/gym/core/GymFormationScene.test.ts` with a stub
   entity — the stub drives the new behaviour.
3. Keep the configuration contract backward compatible (new fields
   optional or defaulted) so existing scenes need no changes.
4. Update this document's checklist if the convention changes.

---

## 6. Testing strategy

- **Pure geometry** (`src/utils/formations.test.ts`) — no scene boot
  needed; assert offset counts and symmetry.
- **Base class** (`src/scenes/gym/core/GymFormationScene.test.ts`) — a stub
  `Container` entity + stub bullets exercise spawn, HUD, drift/respawn,
  explode, shoot toggle, bullet advance with four-edge wrap, and
  lifetime-based expiry.
- **Per-scene** (`src/scenes/gym/GymScout.test.ts`, `GymDiver.test.ts`,
  `GymTank.test.ts`, `GymPhaser.test.ts`, `GymSwarm.test.ts`) —
  behaviour-preserving tests that must pass unchanged after a refactor;
  they are the regression net for the scene rewrites and each also
  asserts the player-in-the-gym convention (spawn, keyboard, live aim,
  combat, respawn — see §7). `GymSwarm.test.ts` additionally asserts
  cluster drift bounds and the pass-through (no-collision) invariant
  (GDD §2.6).
- **Browser smoke test** — run `npm run dev`, open the gym index, and
  confirm formations render with the correct neon colours (headless tests
  cannot see pixels; this is a manual step).

---

## 7. Player in the enemy gym — live combat convention

Every enemy gym scene now includes the **real, keyboard-controlled Player
ship** (`src/entities/Player.ts`) with live combat interaction, so enemy
behaviour is demonstrated against an actual target and the scenes double as
combat testbeds.

### 7.1 Spawn & input

- **Config seam:** a scene opts in by setting `player: {x, y}` in its
  `EnemyFormationConfig` (an optional, backward-compatible extension —
  scenes without it spawn no ship, e.g. the future Boss gym until built).
  All five enemy gyms use `PLAYER_SPAWN` from `src/core/constants.ts`
  (`{x: 920, y: 30}` — top-right, so auto-fire heads right across the
  screen away from the formations).
- **Input:** the base scene binds the cursor keys (arrows) AND `W/A/S/D`,
  clamped to the game bounds; `maxSpeed` 175 px/s. The bound keys are
  routed through the player's **saved control scheme** — keyed off
  `player.getScheme()` inside the shared
  `CombatScene._readPlayerInput` (inherited by `GymFormationScene`), which
  dispatches to `FourDirectionalInputHandler` (default) or
  `AsteroidsInputHandler` (both in `src/utils/movementModel.ts`):
  - **4-directional scheme (default):** arrows and `W/A/S/D` move the ship
    up / down / left / right as before.
  - **Asteroids scheme:** `W`/Arrow Up thrust the ship **forward** (in its
    current facing direction), `A`/Arrow Left turn it **left**, and
    `S`/Arrow Right turn it **right** (3 rad/s) — never 4-directional.
  `GymPowerUpsUtility` and `GymWeapons` inherit the same scheme-aware routing
  from `CombatCoreScene._readPlayerInput` (their former private `_readInput`
  copies were removed in AH-0MUDCT7EU0061OSZ); the standalone `GymPlayer`
  tuning scene routes its keys the same way.

  > **Data-driven successor:** the per-scene wiring described in this §7
  > is complemented by the Enemy Config pipeline (AH-0MTFP7EIC004F1MN,
  > CSV AH-0MTZWZ9TE009CVUA): enemy tuning also lives in
  > `src/data/enemy-configs.csv` (`EnemyConfig`) and is exercised through
  > the single `GymEnemies` scene (see §1.1 / §8). The per-scene `player`
  > seam itself is unchanged — `GymEnemies` reuses it.
- **Auto-fire:** while the SHOOT toggle is on, the ship auto-fires
  `PlayerBullet`s toward its current heading.

### 7.2 Collisions & respawn

Resolved in the shared `CombatScene._handleCollisions` (inherited by
`GymFormationScene`; the same path `PlayScene` uses) each tick:

1. Player bullets → enemies (hit radius 20): enemy destroyed (`alive=false`,
   1 HP) + explosion SFX; the bullet is consumed.
2. Player bullets → enemy bullets (radii 3 + 6): both consumed (mutual
   destruction — bullets pass through *aliens* per GDD §2.6, but not each
   other). The shared `onBulletVsBulletImpact` hook then plays the dedicated
   `playBulletDestructionSound()` cue and spawns the small impact flash
   (`src/vfx/bulletImpact.ts`).
3. Enemy bullets → player hull (`SHIP_SIZE/2` = 10 + bullet 6): ship
   explosion + SFX, `getPlayerHitCount()` increments, the ship respawns
   **in-place** at its current position and orientation (velocity zeroed) with
   a scale-pulse VFX (ship expands to 150% then contracts back to 100%),
   followed by a short invulnerability window; **infinite lives** — the
   demonstration never ends.

> **Initial spawn unchanged:** the player still spawns centre screen
> (`PLAYER_SPAWN = { x: 480, y: 270 }`) at scene start; only the *post-hit
> respawn* is in-place. Supersedes the respawn clause of AH-0MTVYBCUW008BEQT
> AC4 ("the respawn position matches the initial spawn position").

**Power-up hit-gating (P3 Shield / P6 Phase Shift).** The P3/P6 gating is
inherited from the shared `CombatScene`, not re-implemented in the gym:

- **P6 Phase Shift** — `CombatScene.isPlayerPhased()` returns
  `getEffectsRegistry().isPhased`; while active, `_handleCollisions()` skips
  both the enemy-bullet-vs-player and player-body-vs-enemy passes, so the
  ship passes through bullets and bodies for the 3 s effect window (no
  `getPlayerHitCount()` increment, no respawn).
- **P3 Shield** — `CombatScene.tryAbsorbPlayerHit()` consumes exactly one
  shield (`tryAbsorbShield()`), runs the `onShieldAbsorbed()` cue seam (the
  play scene plays `playDestructionSound()`; the gym stays silent), starts
  the shared post-hit invulnerability window and reports the hit absorbed,
  so an absorbed hit costs no life; the following hit lands normally.
- **Visuals** — `GymFormationScene` draws the same P3 shield bubble
  (colour `0x3399ff`, line width 2, radius `SHIP_SIZE * 1.6`, fill alpha
  `0.12`) and P6 phase ghost (alpha `0.45`, blink-aware) as `PlayScene` and
  `GymPowerUpsCombat`, through the shared `CombatEffectVisuals` helper. Test
  seams: `isShieldBubbleVisible()`, `isPhaseGhostActive()`.

`GymFormationScene`-based scenes therefore record **and** apply P3/P6
identically to the other combat scenes — a regression is guarded by the
enemy-gym phase/shield tests and the cross-scene equivalence tests.

### 7.3 Live aim tracking

The base scene pushes the player's live position into every alive enemy each
frame (`entity.setAimTarget?.(player.x, player.y)` — an optional seam,
forward-compatible with entities that have no target concept) **before**
collecting bullets, so that frame's shots use the current position:

- **Scout / Swarm** — retarget `target`/burst aim continuously; bullets arc
  toward the player's live position at fire time.
- **Phaser** — rotates its 8-spoke radial pattern so one spoke points at the
  live player; telegraph rules (two-phase tell ≥ 600 ms advance cue, then
  the volley) are unchanged.
- **Diver** — **snapshots the target at dive start** (recorded seam
  decision): a mid-dive aim change does not alter the in-flight dive arc.
  Dives are x-locked at the formation slot. While a Diver is away from the
  formation (`DIVING`/`PAUSING`/`RETURNING`) the cluster's drift is held —
  see §7.6.
- **Tank** — deliberately **direction-agnostic**: its 10-spoke radial burst
  is untouched (no aim seam).

### 7.4 Testing the convention

Per-scene test files carry a `player in the gym (epic per-scene AC1-AC4)`
block:

1. **spawn** — player is a `Player` at the scene's `player` config position
   and the formation is undisturbed;
2. **keyboard** — hold a cursor key across `tick(dt)` calls and assert
   displacement (deterministic — no real waits);
3. **aim/combat** — fire gates are advanced by mutating `scene.time.now`
   between `tick()` calls (enemy fire/tell gates read the clock), then
   assert: aimed bullets track the live position, a parked
   `spawnPlayerBullet(x, y, 0, 0)` destroys an enemy, and the volley hits
   the ship (`getPlayerHitCount() > 0`) with respawn + invulnerability;
4. **regression** — EXPLODE/SHOOT toggling and formation drift still work
   with the player present.

Deterministic combat loops stop on the first `getPlayerHitCount()` increment
(a hit-count guard) so post-hit invulnerability can be asserted.

### 7.5 Boss gym

The Boss gym work item (`AH-0MT99QBDW001O7PE`) is **out of scope** for this
convention and will follow it when built: spawn the player via the same
`player` config seam and reuse the live-combat collision/respawn machinery.

### 7.6 Formation hold while a Diver is away (AH-0MUAYB957002EMYV)

A Diver leaves the formation for the whole `DIVING → PAUSING → RETURNING`
attack window, and the cluster must not keep drifting out from under it.
The Diver reports this through the optional `requiresFormationHold?()` seam
(on `FormationSceneEntity` and the shared `EnemyEntity` type alongside
`DestructionAudioSeam`):

- `Diver.requiresFormationHold()` returns `this.alive && this._state !==
  DiverState.FORMATION` — true for `DIVING`/`PAUSING`/`RETURNING`, false in
  `FORMATION`, and false once destroyed.
- Both independent drift implementations consult the seam each frame and hold
  the cluster's base while any **living** holder exists:
  - `GymFormationScene.tick()` freezes `formationBaseX` and suppresses the
    right-edge wrap/respawn.
  - `PlayScene._moveEnemies()` freezes `driftX` and leaves `driftDir`
    untouched, so ping-pong direction is preserved across the hold.
- Destroyed entities are ignored by both gates, so a Diver killed mid-dive
  cannot freeze the cluster forever.
- Every entity's `applyFormationPosition` still runs each frame with the
  unchanged base, so a returning Diver glides onto the slot evaluated live
  from the (now stationary) base, and normal drift resumes on the first
  frame after the last Diver re-enters `FORMATION`.
- Non-Diver entities omit the seam and are unaffected.

---

## 8. EnemyConfig reference & adding a new enemy

### 8.1 EnemyConfig shape (`src/core/enemyConfig.ts`)

| Field | Type | Purpose |
|-------|------|---------|
| `key` | `string` | Stable slug (lowercase/numbers/hyphens, ≤40 chars) and CSV row identity. Validated by `isValidEnemyKey` / `sanitizeEnemyKey`. |
| `displayName` | `string` | Human label shown in the index and `GymEnemies` hint. |
| `formationKind` | `EnemyFormationKind` | `'v' \| 'diver' \| 'rect' \| 'swarm' \| 'orbital' \| 'single'` — selects the builder in `src/utils/formations.ts`. |
| `count` | `number` | Formation size. |
| `spacingX` / `spacingY` | `number` | Slot spacing (px). |
| `driftSpeed` | `number` | Rightward drift (px/s). |
| `startX` / `startY` | `number` | Base position (px). |
| `size` | `number` | Body radius/half-size (px). |
| `color` | `number` | Body colour `0xRRGGBB`. |
| `bulletColor` / `bulletSize` | `number` | Bullet colour / radius. |
| `shotPattern` | `EnemyShotPattern` | `'none' \| 'aimed' \| 'spread' \| 'radial' \| 'orbital' \| 'coordinated'` — validated in `src/utils/enemyShotPatterns.ts`. |
| `fireInterval` | `number` | ms between volleys. |
| `shotProbability` | `number` | Fraction `0.0`–`1.0` chance an individual enemy fires per shot cycle; rolled once at the fire decision point, a failed roll consumes the cycle (no bullet, no tell). Seed default `1.0` everywhere except the Swarm (`0.25`). |
| `bulletSpeed` | `number` | px/s. |
| `burstCount` | `number` | Burst / radial spoke count. |
| `[extra]` | `unknown` | Open passthrough — future axes without breaking JSON. **Not representable in a flat CSV row and dropped for CSV-sourced configs** (documented limitation). |

Types live in `src/core/configTypes.ts`; seed fallbacks in
`src/core/configDefaults.ts` (`DEFAULT_ENEMY_CONFIGS` scout/diver/tank/phaser/
swarm/boss/asteroid, `DEFAULT_ENEMY_KEYS`). `createEnemyFromConfig()` in
`src/entities/enemyFactory.ts` maps a config to its entity class (unknown keys
fall back to Scout; Swarm's `clusterIndex` is `row / SWARM_CLUSTER_ROW_STRIDE`).

### 8.2 CSV files, codec & config store

The CSV files are the **single source of truth** for enemy and ship tuning:

- `src/data/enemy-configs.csv` — one row per enemy archetype.
- `src/data/ship-config.csv` — the single player-ship row.
- `enemy-configs.csv` starts with a `#` comment header listing every column,
  the enum values and how to add an entry. The header is optional and is **not**
  rewritten by the dev save path, so `ship-config.csv` is currently headerless.
  Colours are `0xRRGGBB`; `formationKind` and
  `shotPattern` are the plain enum strings; numeric columns are plain numbers.

Supporting modules:

- `src/core/csv.ts` — hand-rolled RFC 4180 parser/serialiser plus typed
  coercion and validation. `parseCsvRows(csv)` → `Record<string, string>[]`
  (skips `#` comments/blank rows, strips a leading BOM);
  `coerceEnemyConfig` / `coerceShipConfig` convert strings to typed fields
  (missing → default, malformed → `0` / `0x000000`); `validateEnemyConfig` /
  `validateShipConfig` return `{ ok, errors }`; `serializeEnemyConfigs` /
  `serializeShipConfigs` round-trip back. `ENEMY_COLUMN_ORDER` /
  `SHIP_COLUMN_ORDER` are the stable exported column orders.
- `src/core/configStore.ts` — in-memory registry. `loadConfigs()` (async,
  awaited by `src/core/boot.ts` before the game/scenes are constructed) fetches
  both CSVs through the dev plugin (or reads the bundled CSV in production),
  parses/validates them and populates the registry;
  a failed fetch falls back to `DEFAULT_ENEMY_CONFIGS` / `DEFAULT_CONFIG`
  without throwing. `loadEnemyConfig` / `loadShipConfig` / `listEnemyConfigKeys`
  / `loadAllEnemyConfigs` are synchronous reads of the registry.
- `vite/plugins/configCsvPlugin.ts` — dev-only Vite middleware. `GET
  /api/csv/src/data/<file>.csv` returns the file; `PUT` upserts the supplied
  row(s) after validation and writes atomically (temp file + rename).
  `?mode=append` rejects a duplicate key with **409**. Registered in
  `vite.config.ts`; `apply: 'serve'` keeps it out of production builds.
- `src/core/bundledConfig.ts` — the build-time `?raw` CSV imports used by the
  production read-only path.

Public loader helpers (unchanged signatures): `loadEnemyConfig(key)`
(fallback without throw), `saveEnemyConfig(cfg)` (async, returns
`{ ok, reason? }`), `listEnemyConfigKeys()`, `loadAllEnemyConfigs()`. There is
**no `deleteEnemyConfig`** any more — remove a row by editing the CSV.

### 8.3 FormationKind & shot-pattern registries

- `src/utils/formations.ts`: `buildOrbitalPhaseOffsets`, `buildSingleOffset`,
  `EnemyFormationKind`, `FORMATION_BUILDERS`, `getFormationBuilder(kind)` (unknown → `buildVFormationOffsets`).
- `src/utils/enemyShotPatterns.ts`: `VALID_SHOT_PATTERNS`, `sanitizeShotPattern` (unknown → `'none'`), `isValidShotPattern`.

### 8.4 Entity seam

`Scout`/`Diver`/`Tank`/`Phaser`/`Swarm`/`Boss` (`src/entities/*.ts`) accept an
optional seam config (`size? color? bulletColor? bulletSize? bulletSpeed?
fireInterval? burstCount? shotProbability? rng?`) and store `private readonly
_*` fields derived as `config.xxx ?? CONST` so hard-coded constants remain the
default and old tests stay green. Getters (`effectiveSize`, `effectiveColor`, …)
are used by the entity's own drawing/fire paths.

**Shot probability gate:** each entity stores `_shotProbability`
(`config.shotProbability ?? 1.0`) and an injectable `_rng`
(`config.rng ?? Math.random`). When the fire interval elapses the entity rolls
`this._rng() < this._shotProbability` at the *decision point*: on success it
continues the existing fire path; on failure it consumes the cycle
(`_lastFireTime/_lastBurstTime = now`) and produces no bullet. For the tell
entities (Scout/Phaser) the roll happens *before* a tell is scheduled, so a
skipped cycle never plays an advance cue with no shot; Diver/Tank/Swarm gate at
their interval check; the Boss gates in `_shouldFire` *after* its telegraph
guard (never while a telegraph is scheduled).

### 8.5 Gym surface — GymEnemies + editor panel

`GymEnemies` is the only enemy gym scene. `init({ enemyKey })` loads the
config and calls `getFormationBuilder(cfg.formationKind)` to build
`EnemyFormationConfig` via `enemyConfigToFormationConfig`. `collectBullets`
delegates to the shared `fireForEnemy(entity, cfg.key, now)` dispatcher
(`src/entities/enemyFire.ts`, §2.1), so per-enemy quirks stay behind the
seam and a new archetype is wired once, in the dispatcher table.

**Panel anchoring (AH-0MUAYB7O4009LWBF).** Every plain-DOM gym panel
(`#gym-config-panel` in `GymPlayer`, `#enemy-gym-panel` here and
`#boss-gym-panel` in `GymBoss`) carries the shared `gym-panel` class and is
anchored **bottom-left** (`position: fixed; bottom: 8px; left: 8px`) with a
viewport-relative `max-height: calc(100vh - 120px)` and `overflow-y: auto`.
This keeps the panel clear of the top-left Phaser HUD (lives, power-ups,
weapons, minerals) and caps a tall panel (e.g. the ~21-row enemy editor) so it
scrolls internally instead of extending above the viewport. The in-canvas
`EXPLODE`/`SHOOT`/`DAMAGE` controls and the right-aligned status line moved to
the **bottom-right** in the same change so both the panel and the controls stay
usable. The stylesheet contract is regression-tested in `src/style.test.ts`
(computed styles for each panel id) plus per-scene class/coordinate assertions.

**Collapsible panels (AH-0MUDYFMUX007Q0W3).** Every gym panel is made
collapsible by the shared `makeCollapsible({ panel, title })` helper in
`src/utils/gymPanel.ts`: it wraps the panel's existing children in
`.gym-panel-body` and prepends a `.gym-panel-header` containing a native
`<button class="gym-panel-toggle">`. The button carries `aria-expanded` and
`aria-controls` pointing at the body, and activating it flips the panel's
`data-collapsed` attribute; `src/style.css` hides `.gym-panel-body` when
`data-collapsed="true"`, so a collapsed panel shrinks to its header only. The
header/toggle stay visible, keeping the control discoverable and keyboard
activatable. Panels start **expanded** (`data-collapsed="false"`); the state
is per-scene and deliberately not persisted. Toggle titles are `Ship Config`
(`GymPlayer`), `AI Config` (`GymEnemies`) and `Boss Config` (`GymBoss`). The
helper is unit-tested in `src/utils/gymPanel.test.ts`, the collapsed CSS
contract in `src/style.test.ts`, and the per-scene toggle in each scene's test
file.

The **editor panel** (`src/scenes/gym/GymEnemies.ts`, plain-DOM under
`#game-container`, id `enemy-gym-panel`) mirrors `GymPlayer`: sliders for
`count/spacingX/spacingY/driftSpeed/startX/startY/size/bulletSize/fireInterval/shotProbability/bulletSpeed/burstCount`,
colour pickers for `color/bulletColor`, selects for `formationKind`/`shotPattern`,
plus **Save** (overwrite active row in `src/data/enemy-configs.csv` via the dev
plugin) and **Save As…** (sanitize → validate → duplicate check via
`listEnemyConfigKeys()`, displayName = raw input; appends a new CSV row).
Both flows are async: the panel shows `Saving…`, then `Saved`/`Saved as <key>`
or a red **`Save failed — …`** status (`enemy-gym-save-status`). In production
builds writes are unavailable and the status reports it. After a successful
write the scene re-reads the config from the store.
Live `input`/`change` events patch `config.buildOffsets/spacing/drift/start/count`
and best-effort mutate entity `_*` fields. Panel is removed on scene
`SHUTDOWN`; stale panels are cleared on rebuild for test isolation.
Queryable DOM ids: `enemy-gym-panel`, `enemy-gym-save`,
`enemy-gym-save-as`, `enemy-gym-save-as-input`, `enemy-gym-save-status`,
`data-config` / `data-config-value` on controls. The panel also shows a
**live difficulty readout** (id `enemy-gym-difficulty`) that recomputes the
0–100 archetype score on every control change — see §9.

The gym index discovers enemies via `src/utils/enemyGymDiscovery.ts`
(`discoverEnemyGymEntries()` → `{ key: 'GymEnemies:<slug>', label,
 enemyKey }[]`, sorted by label) and routes each non-boss config row to
`scene.start('GymEnemies', { enemyKey })`. The gym index lays out three
columns: plain scenes (left), **ENEMIES** (non-boss configs) and **Bosses**
(right). Both boss rows sit in the **Bosses** column — the plain `boss`
config archetype labelled **"Boss Swarm"** (routed to `GymEnemies`) and the
dedicated **"Boss"** row (scene key `GymBoss`) that boots the multi-phase
`GymBoss` scene directly. Bare `GymEnemies` is excluded from the plain scene
list, and `GymBoss` is likewise excluded there so the real boss is not
duplicated (AH-0MUAYB28C004KK7X, AH-0MTV8OV9V002D8B7). Save As
enemies appear on next index load without code changes.

### 8.6 Adding a new enemy (convention)

1. **Tune in the gym.** Run `npm run dev`, open the **Gym Index → any
   Enemies entry** (e.g. Scout). Use the **Enemies panel** sliders/selects/
   colour pickers to dial in movement, formation and shot feel — changes
   live-apply without reload.
2. **Save As…** Enter a new name (e.g. `My New Enemy`) and click **Save
   As…**. The name is slugified (`my-new-enemy`), validated
   (`isValidEnemyKey`, ≤40 chars, hyphen slug, unique), and a new row with
   that displayName is appended to `src/data/enemy-configs.csv`.
3. **Appears in the index.** Reload / return to the gym index — the new
   entry appears under the **ENEMIES** section without editing
   `GymIndex.ts` (the CSV is re-read after the write).
4. **Code archetype (when a truly new entity is needed).** If the enemy
   needs new movement/shot code beyond the existing registries: add a new
   entity in `src/entities/<Name>.ts` with the same seam (`size? color? …`),
   a builder in `src/utils/formations.ts` or a shot pattern in
   `src/utils/enemyShotPatterns.ts` with tests, add its archetype key →
   `tryFire*` method to `ENEMY_FIRE_METHODS` in
   `src/entities/enemyFire.ts` (the single fire-dispatch seam), wire it in
   `src/entities/enemyFactory.ts`, and add a seed fallback to
   `DEFAULT_ENEMY_CONFIGS` in `src/core/configDefaults.ts`.
5. **CSV hygiene.** The committed CSV is the source of truth; a missing or
   malformed file (or a failed dev fetch) falls back to the seed defaults
   without throwing, and `npm test` resets the registry between suites. The
   dev plugin validates every write before touching the file and writes
   atomically, so an interrupted write cannot corrupt the committed CSV.

## 9. Enemy difficulty scoring (AH-0MTZWZ7MC002B01K)

A pure, deterministic, **absolute** 0–100 difficulty index for enemies,
waves and levels. It exists so level authoring is *measured* rather than
guessed: a designer can compare two archetypes, a reviewer can audit the
campaign ordering, and a regression test pins the intended progression.

- **Module:** `src/core/enemyDifficulty.ts` (no Phaser, no browser globals;
  runs under Vitest/happy-dom).
- **Unit tests:** `src/core/enemyDifficulty.test.ts` (monotonicity per axis,
  `shotPattern === 'none'` independence, Asteroid split chain, wave mix).
- **Calibration test:** `src/waves/enemyDifficulty.campaign.test.ts` (pins the
  non-decreasing ordering of the five built-in `LEVELS`).

### 9.1 The three functions

| Function | Scores | Returns |
|----------|--------|---------|
| `enemyDifficulty(config)` | one `EnemyConfig` archetype | `{ score, breakdown, factors }` |
| `waveDifficulty(wave)` | one `WaveDefinition` (count-sensitive total threat) | `{ score, breakdown, factors }` |
| `levelDifficulty(waves)` | a level (ordered waves) | `{ score, breakdown, factors }` |

The score is **absolute** (Producer decision Q3): it depends only on enemy
properties — never on player HP, lives, weapons or power-ups. Same input ⇒
same output; no game instance is required. Scores are fractional (0–100);
rounding is a presentation concern only.

### 9.2 Factors, weights and ranges

Each factor is clamped to its range and linearly normalised to 0–100, then the
weighted mean is taken (`WEIGHT_SUM` normalisation keeps the total 0–100). All
constants live in `FACTOR_WEIGHTS` / `FACTOR_RANGES` in the module.

| Factor | Weight | Range | Notes |
|--------|-------:|-------|-------|
| `count` | 25 | 1–200 | Enemies in the formation (ceiling = gym slider max). |
| `driftSpeed` | 8 | 0–200 px/s | Formation movement speed. |
| `shotPattern` | 15 | ordinal 0–5 | Dodging difficulty: none 0, aimed 1, coordinated 2, spread 3, radial 4, orbital 5. |
| `fireInterval` | 12 | 100–5000 ms | **Inverted** (fire rate) — a shorter interval scores higher. |
| `shotProbability` | 5 | 0–1 | Chance an enemy fires per cycle. |
| `bulletSpeed` | 5 | 40–600 px/s | Bullet velocity. |
| `burstCount` | 12 | 1–24 | Bullets per volley / radial spokes. |
| `formationKind` | 8 | ordinal 0–5 | Positional threat: single 0, v 1, diver 2, rect 3, swarm 4, orbital 5. |
| `asteroidSplit` | 10 | 1–7 | Split-chain entity count; one large Asteroid = 7 destroyed enemies (GDD §4.1 E6). |

**Firing factors contribute zero** when `shotPattern === 'none'` (e.g. the
Asteroid) or when `waveDifficulty` scores a wave with `shootEnabled: false`
(GDD §2.4 — Levels 1–3).

### 9.3 Composition

- **Wave** (count-sensitive total threat):

  `totalThreat = Σ enemyScore × count`, then
  `score = 100 × totalThreat / (totalThreat + 900)`.

  The saturating (diminishing-returns) curve is strictly increasing in total
  threat, so the score rises with group count, enemy count and mix, while a
  wave of many weak enemies does not swamp a wave of few strong ones. The
  Asteroid split chain is represented by the `asteroidSplit` factor, so counts
  are used verbatim (no double counting).

- **Level** (content quality): the **enemy-count-weighted mean** of the
  per-enemy difficulty across every group in every wave. Weighting by count
  means the level score reflects the *average threat of the content*, which
  is what makes the campaign progression meaningful: Level 5
  (**Predictable Death**) is uniformly high-threat even though it has
  *fewer* enemies than earlier levels. Total wave threat remains available
  from `waveDifficulty`.

- **Breakdowns:** every function returns `breakdown` (weighted per-factor
  contributions for enemies; per-group or per-wave scores for waves/levels)
  and `factors` (raw normalised values and derived counts) so any score can
  be explained.

### 9.4 Recomputed campaign table (GDD §3.2)

Scores computed from the real `LEVELS` in `src/waves/Formations.ts`. The
ordering is **non-decreasing** and enforced by
`src/waves/enemyDifficulty.campaign.test.ts` (AC4):

| Level | Theme | Difficulty (0–100) |
|-------|-------|-------------------:|
| 1 | Entry | 7.17 |
| 2 | Descent | 12.70 |
| 3 | The Core | 14.28 |
| 4 | Firestorm | 23.14 |
| 5 | Predictable Death | 31.92 |

Per-archetype scores for the seed enemies (with firing where the archetype
fires): Scout 14.03, Diver 23.18, Tank 29.09, Phaser 31.85, Swarm 20.17,
Boss Swarm 22.50, Asteroid 10.00 (split chain only — it never fires).

> **Tuning guidance.** The weights are subjective by nature; the index is a
> relative, monotonic ordering, not an absolute truth. Tests pin *ordering*
> and *monotonicity*, not the magic numbers. Any weight change must be
> re-checked against both the per-axis monotonicity tests and the campaign
> calibration test.

### 9.5 Where it surfaces

- **Enemy Gym editor panel:** the live `enemy-gym-difficulty` readout shows the
  edited archetype's score and updates on every slider/select/colour change
  (`GymEnemies._updateDifficulty`).
- **Library:** `enemyDifficulty` / `waveDifficulty` / `levelDifficulty` are
  importable for scripts, docs tables and future tooling.

### 9.6 Out of scope

A runtime **auto-sequencer** that picks enemies to hit a target difficulty
curve is explicitly deferred (Producer Q4) and tracked separately as
`AH-0MUDIWETP003XC3X` (`discovered-from` AH-0MTZWZ7MC002B01K). This module is
the design-time primitive such work would build on.

## Audio Best Practices

All enemy audio functions live in
[`src/audio/effects.ts`](../src/audio/effects.ts) — the **single source of
truth**; never inline an audio call anywhere else. The audio event catalog and
default sound characters are defined in
[GDD §7.3](Game%20Design%20Document.md); per-enemy audio characters are decided
**at implementation time** and may deviate from the catalog defaults (see §3.1
checklist item 6). Scope rules matter — base-class-owned sounds are played
**once by the base scene** and must never be re-played by entities.

### Spawn

- **Function:** `playSpawnSound()`
- **When:** during entity creation, from the base class spawn loop.
- **Scope:** the base class `GymFormationScene` owns spawn sound — the spawn
  loop calls `playSpawnSound()` once when the formation is created (see §3.1
  checklist item 5). Entity constructors must **not** call it.

### Shoot / fire (per enemy type)

| Enemy | Advance cue | Fire sound | Scope & timing |
|-------|-------------|------------|----------------|
| E1 Scout | `playScoutAdvanceCue()` — at tell start, ≥ 500 ms lead | `playScoutFireSound()` — at the shot | **entity-level** two-phase tell, per aimed shot |
| E2 Diver | none (no advance cue — fire sound alone is the tell); `playDiverDiveStartSound()` — rising whoosh/crack once at the FORMATION→DIVING transition (the dive danger cue) | `playDiverFireSound()` — short low/nasal crack; `playDiveSound()`/`stopDiveSound()` — refcounted shared sustained dive whoosh for the ~2 s dive (stopped at DIVING→RETURNING, `destroySelf()`, and `destroy()`) | **entity-level**, fire exactly once per spread burst inside `tryFireSpreadBurst()`; dive-start cue once per dive in `_startDive()` |
| E3 Tank | `playTankAdvanceCue()` — mechanical whine (≥ 500 ms, `TANK_ADVANCE_CUE_DURATION`) | `playTankFireSound()` — heavy cannon thump | **entity-level**, one cue+thump pair per radial burst inside `tryFireRadialBurst()` — the cue flows with **no gap** into the thump |
| E4 Phaser | `playPhaserAdvanceCue()` — rising sine 660→880 Hz (replaces the old inline `_playAdvanceCue()`, `PHASER_ADVANCE_CUE_DURATION`) | `playPhaserFireSound()` — short sharp blip, scheduled at the cue's end | **entity-level**, one advance cue + fire sound pair at tell start inside `applyFormationPosition()` (matching the Scout no-gap pattern) — no audio on the firing branch (no double-play) |
| E5 Swarm | none (no warning cue) | `playSwarmBurstSound()` | **entity-level** volley burst, once per volley inside `tryFireBurstBullet()` |
| Boss | `playBossPhaseCue()` — per-phase telegraph tone (retained) | `playBossFireSound()` — deep resonant boom (in `src/audio/effects.ts`) | **entity-level**, once per volley in each attack method (`tryFireSpreadBullets`, `tryFireSpiralBullets`, `tryFirePulseBullets`, `tryFireDesperationBullets`) |

Orchestration rule: entity-specific fire sounds are invoked **where the shots
are produced** — the entity's own fire/tell logic (Tank's `tryFireRadialBurst`,
Swarm's `tryFireBurstBullet`, Phaser's tell, the Boss's attack methods, the
Scout's two-phase tell) — never re-added in a thin scene class.

### Explode / destruction

- **Function:** `playDestructionSound()` (shared) — or an entity-specific
  sound via the optional `playDestructionAudio?()` seam on
  `FormationSceneEntity` (e.g. `playDiverDestructionSound()`).
- **When:** during entity destruction.
- **Ownership rule (critical):** the base class `GymFormationScene` owns the
destruction sound — `explodeRandom()` and the player-bullet collision handler
call the entity's `playDestructionAudio?.()` when present, otherwise falling
back to `playDestructionSound()`, once per destroyed enemy. Entities must
**NOT** call a destruction sound in their own `playExplosion()` — doing so
double-plays the sound (see §3.1 checklist item 7; regression-tested in
`src/entities/Scout.test.ts` and `src/scenes/gym/GymDiver.test.ts`).
