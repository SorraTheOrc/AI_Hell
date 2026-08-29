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
     from the base class).
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
   - the `← INDEX` button exists.
6. **Audio + navigation.** `playSpawnSound()` / `playDestructionSound()`
   and `addBackToIndexButton()` are handled by the base class — do not
   re-add them. Entity-specific fire sounds go in `src/audio/effects.ts`
   and are orchestrated by the scene (volley-level burst sound for Swarm
   at the point of shooting) — no per-entity advance cue is used.

7. **Destruction sound ownership.** The base class `GymFormationScene.explodeRandom()`
   plays `playDestructionSound()` for all enemies. Entity classes should
   NOT call `playDestructionSound()` in their `playExplosion()` — doing so
   would double-play the sound. This is a design decision per GDD §7.3
   and the core-library best practices.

### 3.2 Existing scenes (reference implementations)

| Scene | Entity | Formation | Fire pattern | Audio |
|-------|--------|-----------|--------------|-------+-------|
| `GymScout` | `Scout` | V (offset columns +2/row) | aimed shot (single) | none |
| `GymDiver` | `Diver` | diamond/chevron | spread burst (array) | none |
| `GymTank` | `Tank` | 3-column rectangle | radial burst (array) | none |
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
  `GymTank.test.ts`, `GymSwarm.test.ts`) — behaviour-preserving tests that
  must pass unchanged after a refactor; they are the regression net for the
  scene rewrites. `GymSwarm.test.ts` additionally asserts cluster drift
  bounds and the pass-through (no-collision) invariant (GDD §2.6).
- **Browser smoke test** — run `npm run dev`, open the gym index, and
  confirm formations render with the correct neon colours (headless tests
  cannot see pixels; this is a manual step).