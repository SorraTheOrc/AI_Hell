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
| E2 | Diver | §4.1 | Vertical dive toward player (x locked at formation slot), returns to current formation slot | Medium dart shape, neon yellow | none → short-burst spread (3–5) |
| E3 | Tank | §4.1 | Slow deliberate formation, long hold positions | Large hexagonal/blocky, neon | none → radial burst (10 shots) |
| E4 | Phaser | §4.1 (L5) | Fixed orbital path, predictable firing cycles | Circular ring with central core | yes — patterned, telegraphed (≥ 500 ms lead) |
| E5 | Swarm | §4.1 | Tight fast clusters, sudden direction changes | Small diamonds, groups | none → coordinated burst |
| E6 | Asteroid | §4.1 | Free-roaming straight-line drift (screen wrap), continuous rotation, splits into two smaller rocks when shot | Jagged procedural neon polygon (grey), 3 size tiers | **never fires** |
| Boss | The Central AI | §4.3 | 4 attack phases, multi-hit health (4-phase bar) | Large neon geometric structure with core | complex patterns per phase |

All enemies are **1 HP** (single bullet destroys them, except the Boss which is
multi-hit) and **never collide with each other** (GDD §2.6) — no collision
system is installed in the gym scenes.

### 1.1 Data-driven enemy pipeline (AH-0MTFP7EIC004F1MN)

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

**Wave placement**: an asteroid group (`formationKind: 'single'`, count 1)
joins Level 1 Wave 1 in `src/waves/Formations.ts` alongside the Scout
V-formation. The asteroid config defaults to the large tier; smaller tiers
appear only as split children.

**Gym support**: the asteroid is selectable in the enemy gym (auto-discovery
via `DEFAULT_ENEMY_CONFIGS`). `GymFormationScene` gained two small seams —
optional `updatePosition(dt)` on `FormationSceneEntity` (roamer motion) and
optional `onEntityDestroyed(entity)` on `EnemyFormationConfig` (dynamic split
children) — so EXPLODE, player bullets and body-rams all cascade splits and
the wipe→respawn cycle runs only once the whole chain is cleared.

Enemy archetypes are **data, not code**. The runtime type is `EnemyConfig`
(`src/core/enemyConfig.ts`) — a JSON-serializable record of formation,
visual and shot tuning. Six **seed configs** (scout/diver/tank/phaser/swarm/boss)
mirror the former hard-coded constants and are the built-in defaults. Every
other behaviour — formation geometry, bullet dispatch, gym index listing —
derives from the config + small registries instead of per-enemy scene
classes.

**Persistence.** Each enemy has its own localStorage entry under the
namespace `ai-hell-enemy-config:<key>` (`ENEMY_CONFIG_STORAGE_PREFIX`).
Corrupt or missing storage falls back to seed defaults without throwing;
partial saves are merged over defaults so unknown forward-compatible fields
are preserved. The set of available keys is the union of the seed registry
and any stored suffixes (`listEnemyConfigKeys()` / `loadAllEnemyConfigs()`),
so a new `Save As…` entry becomes discoverable without code changes.

**Gym surface.** `GymEnemies` (`src/scenes/gym/GymEnemies.ts`,
key `GymEnemies`) is the **single reusable gym scene**. It is parameterized
by `{ enemyKey }` via `init()` → `loadEnemyConfig(enemyKey)` and derives
formation/bullet behaviour from the loaded config. The gym index (`GymIndex`)
enumerates enemy configs — one clickable row per config (label
`displayName`) that boots `GymEnemies` with that `enemyKey` — rather than
hard-coded per-enemy scenes. The `boss` config row appears in the
**ENEMIES** column labelled **"Boss Swarm"** (it is a plain single-enemy
archetype, not the multi-phase Central AI). The dedicated `GymBoss` scene is
surfaced as the **"Boss"** row in that same ENEMIES column and boots
`GymBoss` directly; it is excluded from the plain scene list (left column) so
the real boss is not duplicated as a bare scene (AH-0MUAYB28C004KK7X). Legacy
`GymScout`/`GymDiver`/… scenes have been
retired; their formation/bullet assertions now live in `GymEnemies.test.ts`
keyed by `enemyKey`.

---

## 2. Core library architecture

### 2.1 What the core library is

`src/scenes/gym/core/GymFormationScene.ts` is a generic base class that
**extends the shared `src/scenes/core/CombatScene.ts` abstract combat
core** (type parameters `<TEntity, TBullet>`) and encapsulates everything
the first three enemy gym scenes duplicated:

- **Shared combat/lifecycle core** — inherited from `CombatScene`
  (AH-0MUD8E015004C4JO), the same base `PlayScene` extends. It defines the
  eight combat/lifecycle template methods exactly once
  (`_handleCollisions`, `_hitPlayer`, `_autoFire`, `_collectDrop`,
  `_spawnPlayerExplosion`, `_clearEnemyBullets`, `_handleTeleport`,
  `_readPlayerInput`) and dispatches to overridable hooks. The gym supplies
  its participant accessors (`getEnemyEntities()` → `entities`,
  `getEnemyBullets()`/`setEnemyBullets()` → `bullets`) and its hooks
  (`canTeleport()` → `powerUpsEnabled`, `getEnemyBulletRadius()` →
  `config.bulletHitRadius`, `onEnemyDestroyed()` →
  `config.onEntityDestroyed`, teleport-radius hooks); the game supplies its
  own. Bullet-vs-bullet impact feedback is likewise hosted once in the
  shared path. The shipped game and the gyms therefore cannot diverge on
  collision, auto-fire, drops, teleport or player-hit behaviour.

- **Formation spawn** — builds offsets, creates each entity at
  `(baseX + col * spacingX, baseY + row * spacingY)`, and calls
  `add.existing()` so entities actually render (see §4.1).
- **HUD controls** — the `EXPLODE` / `SHOOT: ON/OFF` buttons, the status
  line, the bottom hint line, and the shared `← INDEX` back button.
- **Update loop** — formation drift + respawn off the left edge,
  per-entity `applyFormationPosition()`, fire-bullet collection, bullet
  advance with four-edge wrap, and lifetime-based bullet expiry.
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
  collectBullets: (scout, now) => {
    const bullet = scout.tryFireAimedBullet(now);
    return bullet ? [bullet] : [];
  },
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
| `collectBullets` | Called per entity per frame; returns any bullets that entity fired (empty array if none). |
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
     array (whichever fits — the scene config normalises it to an array),
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
  `GymPowerUpsUtility` and `GymWeapons` implement the same scheme-aware routing in
  their own `_readInput` methods.

  > **Data-driven successor:** the per-scene wiring described in this §7
  > is complemented by the Enemy Config pipeline (AH-0MTFP7EIC004F1MN):
  > enemy tuning also lives in JSON (`EnemyConfig` under
  > `ai-hell-enemy-config:<key>`) and is exercised through the single
  > `GymEnemies` scene (see §1.1 / §8). The per-scene `player` seam itself
  > is unchanged — `GymEnemies` reuses it.
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
  Dives are x-locked at the formation slot.
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

---

## 8. EnemyConfig reference & adding a new enemy

### 8.1 EnemyConfig shape (`src/core/enemyConfig.ts`)

| Field | Type | Purpose |
|-------|------|---------|
| `key` | `string` | Stable slug (lowercase/numbers/hyphens, ≤40 chars). localStorage suffix. Validated by `isValidEnemyKey` / `sanitizeEnemyKey`. |
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
| `[extra]` | `unknown` | Open passthrough — future axes without breaking JSON. |

Seed defaults live in `DEFAULT_ENEMY_CONFIGS` (scout/diver/tank/phaser/swarm/boss);
`DEFAULT_ENEMY_KEYS` is the seed key set. `createEnemyFromConfig()` in
`src/entities/enemyFactory.ts` maps a config to its entity class (unknown keys
fall back to Scout; Swarm's `clusterIndex` is `row / SWARM_CLUSTER_ROW_STRIDE`).

### 8.2 Storage keys

- Per-enemy localStorage key: `ai-hell-enemy-config:<slug>` (`ENEMY_CONFIG_STORAGE_PREFIX`).
- Namespaced separately from `ai-hell-ship-config` (ship tuning).
- Helpers: `loadEnemyConfig(key)` (fallback without throw), `saveEnemyConfig(cfg)`,
  `deleteEnemyConfig(key)`, `listEnemyConfigKeys()`, `loadAllEnemyConfigs()`.

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
dispatches by `cfg.key` (Scout/Diver/…) so per-enemy quirks stay behind the
seam.

The **editor panel** (`src/scenes/gym/GymEnemies.ts`, plain-DOM under
`#game-container`, id `enemy-gym-panel`) mirrors `GymPlayer`: sliders for
`count/spacingX/spacingY/driftSpeed/startX/startY/size/bulletSize/fireInterval/shotProbability/bulletSpeed/burstCount`,
colour pickers for `color/bulletColor`, selects for `formationKind`/`shotPattern`,
plus **Save** (overwrite active key) and **Save As…** (sanitize → validate →
duplicate check via `listEnemyConfigKeys()`, displayName = raw input).
Live `input`/`change` events patch `config.buildOffsets/spacing/drift/start/count`
and best-effort mutate entity `_*` fields. Panel is removed on scene
`SHUTDOWN`; stale panels are cleared on rebuild for test isolation.
Queryable DOM ids: `enemy-gym-panel`, `enemy-gym-save`,
`enemy-gym-save-as`, `enemy-gym-save-as-input`, `enemy-gym-save-status`,
`data-config` / `data-config-value` on controls.

The gym index discovers enemies via `src/utils/enemyGymDiscovery.ts`
(`discoverEnemyGymEntries()` → `{ key: 'GymEnemies:<slug>', label,
 enemyKey }[]`, sorted by label) and routes each config row to
`scene.start('GymEnemies', { enemyKey })`. The ENEMIES column also carries a
dedicated **"Boss"** row (scene key `GymBoss`) that boots the multi-phase
`GymBoss` scene directly; the plain `boss` config archetype is labelled
**"Boss Swarm"**. Bare `GymEnemies` is excluded from the plain scene list, and
`GymBoss` is likewise excluded there (it appears only as the "Boss" ENEMIES
row) so the real boss is not duplicated (AH-0MUAYB28C004KK7X). Save As
enemies appear on next index load without code changes.

### 8.6 Adding a new enemy (convention)

1. **Tune in the gym.** Run `npm run dev`, open the **Gym Index → any
   Enemies entry** (e.g. Scout). Use the **Enemies panel** sliders/selects/
   colour pickers to dial in movement, formation and shot feel — changes
   live-apply without reload.
2. **Save As…** Enter a new name (e.g. `My New Enemy`) and click **Save
   As…**. The name is slugified (`my-new-enemy`), validated
   (`isValidEnemyKey`, ≤40 chars, hyphen slug, unique), and stored as
   `ai-hell-enemy-config:my-new-enemy` with that displayName.
3. **Appears in the index.** Reload / return to the gym index — the new
   entry appears under the **ENEMIES** section without editing
   `GymIndex.ts`.
4. **Code archetype (when a truly new entity is needed).** If the enemy
   needs new movement/shot code beyond the existing registries: add a new
   entity in `src/entities/<Name>.ts` with the same seam (`size? color? …`),
   a builder in `src/utils/formations.ts` or a shot pattern in
   `src/utils/enemyShotPatterns.ts` with tests, wire it in
   `src/entities/enemyFactory.ts`, and add a seed entry to
   `DEFAULT_ENEMY_CONFIGS` in `src/core/enemyConfig.ts`.
5. **Storage hygiene.** `npm test` clears `localStorage` between suites;
   the gym panel removes itself on `SHUTDOWN`. Corrupt storage for a key
   falls back to that key's seed/defaults — the index skips only when
   `loadAllEnemyConfigs()` itself cannot run.

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
