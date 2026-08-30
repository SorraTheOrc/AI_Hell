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
| Boss | The Central AI | §4.3 | 4 attack phases, multi-hit health (4-phase bar) | Large neon geometric structure with core | complex patterns per phase |

All enemies are **1 HP** (single bullet destroys them, except the Boss which is
multi-hit) and **never collide with each other** (GDD §2.6) — no collision
system is installed in the gym scenes.

---

## 2. Core library architecture

### 2.1 What the core library is

`src/scenes/gym/core/GymFormationScene.ts` is a generic
`Phaser.Scene` base class (type parameters `<TEntity, TBullet>`) that
encapsulates everything the first three enemy gym scenes duplicated:

- **Formation spawn** — builds offsets, creates each entity at
  `(baseX + col * spacingX, baseY + row * spacingY)`, and calls
  `add.existing()` so entities actually render (see §4.1).
- **HUD controls** — the `EXPLODE` / `SHOOT: ON/OFF` buttons, the status
  line, the bottom hint line, and the shared `← INDEX` back button.
- **Update loop** — formation drift + respawn off the left edge,
  per-entity `applyFormationPosition()`, fire-bullet collection, bullet
  advance, and off-screen bullet removal.

The generic geometry (formation offsets) lives in
`src/utils/formations.ts`:
`FormationOffset`, `buildVFormationOffsets`, `buildDiverFormationOffsets`,
`buildRectFormationOffsets`. These are pure functions — unit-test them
directly without booting a scene.

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
     ship respawn), and live enemy aim tracks it (see §7).
6. **Audio + navigation.** `playSpawnSound()` / `playDestructionSound()`
   and `addBackToIndexButton()` are handled by the base class — do not
   re-add them. Entity-specific fire sounds go in `src/audio/effects.ts`
   and are orchestrated where the shots are produced: Swarm plays a
   scene-level volley burst sound at the point of shooting (no warning
   cue); Scout uses a per-entity two-phase tell — an advance cue (≥ 500 ms
   lead) at tell start, with the fire sound scheduled to start exactly at
   the cue's end so the two flow back-to-back with no dead gap; Phaser
   uses the same two-phase tell pattern; Tank plays a scene-level
   mechanical-whine advance cue flowing with **no gap** into a heavy
   cannon-thump fire sound, one cue+thump pair per radial burst at the
   point of shooting (the whine's ≥ 500 ms duration provides the advance
   lead). Audio-character decisions are made **per-enemy at implementation
   time** and may deviate from the GDD §7.3 catalog defaults (e.g. Tank's
   heavy thump vs the generic "short zap") — see the GDD §7.3 note.

7. **Destruction sound ownership.** The base class `GymFormationScene.explodeRandom()`
   plays `playDestructionSound()` for all enemies. Entity classes should
   NOT call `playDestructionSound()` in their `playExplosion()` — doing so
   would double-play the sound. This is a design decision per GDD §7.3
   and the core-library best practices.

### 3.2 Existing scenes (reference implementations)

| Scene | Entity | Formation | Fire pattern | Audio |
|-------|--------|-----------|--------------|-------+-------|
| `GymScout` | `Scout` | V (offset columns +2/row) | aimed shot (single) | advance cue (≥ 500 ms) + fire sound scheduled at cue end (entity-level, per aimed shot, no gap between cue and fire sound) |
| `GymDiver` | `Diver` | diamond/chevron | spread burst (array) | none |
| `GymTank` | `Tank` | 3-column rectangle | radial burst (array) | mechanical-whine advance cue (≥ 500 ms) + cannon thump (scene-level, one cue+thump pair per burst, no gap between cue and thump) |
| `GymSwarm` | `Swarm` | loose 3–5 clusters (`buildSwarmClusterOffsets`) | coordinated burst (single per member) | volley burst sound (scene-level, once per volley, at point of shooting) |
| `GymBoss` | `Boss` | single entity (centred) | spread / spiral / pulse / desperation (phase-gated) | none |

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
  explode, shoot toggle, bullet advance, and off-screen removal.
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
  clamped to the game bounds; `maxSpeed` 175 px/s.
- **Auto-fire:** while the SHOOT toggle is on, the ship auto-fires
  `PlayerBullet`s toward its current heading.

### 7.2 Collisions & respawn

Resolved in the base class `GymFormationScene._handleCollisions` each tick:

1. Player bullets → enemies (hit radius 20): enemy destroyed (`alive=false`,
   1 HP) + explosion SFX; the bullet is consumed.
2. Player bullets → enemy bullets (radii 3 + 6): both consumed (mutual
   destruction — bullets pass through *aliens* per GDD §2.6, but not each
   other).
3. Enemy bullets → player hull (`SHIP_SIZE/2` = 10 + bullet 6): ship
   explosion + SFX, `getPlayerHitCount()` increments, the ship respawns at
   its spawn position with short invulnerability; **infinite lives** — the
   demonstration never ends.

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
| E2 Diver | none | none | no audio today (see §3.2 table) |
| E3 Tank | `playTankAdvanceCue()` — mechanical whine (≥ 500 ms, `TANK_ADVANCE_CUE_DURATION`) | `playTankFireSound()` — heavy cannon thump | **scene-level**, one cue+thump pair per radial burst at the point of shooting — the cue flows with **no gap** into the thump |
| E5 Swarm | none (no warning cue) | `playSwarmBurstSound()` | **scene-level** volley burst, once per volley at the point of shooting |
| Boss | none | none | no audio today (see §3.2 table) |

Orchestration rule: entity-specific fire sounds are invoked **where the shots
are produced** — the scene's `collectBullets` callback for scene-level sounds
(Swarm, Tank), or the entity's own fire/tell logic for entity-level sounds
(Scout) — never re-added in a thin scene class.

### Explode / destruction

- **Function:** `playDestructionSound()`
- **When:** during entity destruction.
- **Ownership rule (critical):** the base class `GymFormationScene` owns the
destruction sound — `explodeRandom()` and the player-bullet collision handler
call `playDestructionSound()` once per destroyed enemy. Entities must **NOT**
call `playDestructionSound()` in their own `playExplosion()` — doing so
double-plays the sound (see §3.1 checklist item 7; regression-tested in
`src/entities/Scout.test.ts`).
