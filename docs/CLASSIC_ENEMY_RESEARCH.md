# Classic Enemy Research Catalogue

> **Work item:** AH-0MV01EBUR003BDNK — Research catalogue and engine-constraint validation
> **Epic:** AH-0MUYAQ6YH0010G52 — Research classic enemies from the arcade games of old

This document catalogues the selected classic arcade enemy archetypes for AI_Hell,
recording their source game, original behaviour, adaptation to AI_Hell's
neon-vector no-enemy-collision arena, pipeline fit, difficulty scoring inputs,
and the gym scenes that will exercise them. It also records the candidates that
were considered but not selected, so the research pool can be revisited later.

**Cross-reference:** `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` — each child work
item (AH-0MV1*, AH-0MV2*, …) references this document as its design brief.

---

## Selection rationale

The eight archetypes below were chosen because they each map cleanly to at least
one existing engine seam (formation builder, shot-pattern enum, or factory
dispatch entry), can be tuned via the `EnemyConfig` / CSV pipeline, and provide
a diverse set of movement / attack / difficulty profiles for the campaign.
Each archetype exercises different parts of the shared core (`CombatScene`,
`GymFormationScene`, `enemyFactory`, `enemyFire`, `formations`,
`enemyShotPatterns`, `enemyDifficulty`).

---

## 1. Space Invaders — stepping march formation

**Source game:** *Space Invaders* (Taito, 1978)

**Original behaviour:** A grid of 4×11 aliens marches in unison left and right
along the top of the screen, stepping down one row after each full pass. The
entire formation moves as one rigid body; individual aliens drop bombs at random.

**AI_Hell adaptation:** A rigid rectangular formation (`rect` builder) that
drifts rightward at a configurable `driftSpeed`, then bounces off screen edges
and shifts down in rows. Individual members fire aimed shots on a staggered
cycle (`shotProbability` gates the fire roll). No enemy–enemy interaction;
each alien is a standalone entity following the `rect` formation geometry.

**Divergence from original:** The original uses a tight grid with no vertical
drift — AI_Hell replaces the rigid row-by-row step-down with continuous
rightward drift + occasional vertical repositioning at the formation base. The
no-enemy-collision rule means the "squeeze" mechanic (aliens speed up as they
are destroyed) is expressed purely as a `driftSpeed` tuning, not emergent
behaviour.

**Pipeline fit:** `EnemyConfig` / CSV row. Uses the existing
`buildRectFormationOffsets` (via `formationKind: 'rect'`) and
`aimed` shot pattern. Wired into `enemyFire.ts` via `tryFireAimedBullet`
(the Scout default path — no new entity class needed). Factory key falls back
to the Scout entity type with custom colour/sizing.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` (px/s) + `count` | Rigid body drift; destruction reduces count, so threat is proportional to remaining members. |
| Fire | `shotPattern` (`aimed`) + `fireInterval` + `shotProbability` | Staggered aimed shots; individual fire rolls controlled by `shotProbability`. |
| Health | `health` (default 1) | Single-hit; durability is low but the formation's sheer number compensates. |

**Gym scene:** `GymEnemies` — the new CSV row appears automatically in the
gym index. No new gym scene required.

---

## 2. Galaga — tractor/capture beam

**Source game:** *Galaga* (Namco, 1981)

**Original behaviour:** Enemies appear in formation rows, then individual members
break away on dramatic dive-in attacks, occasionally capturing a player ship with
a tractor beam and returning to formation (doubled as a partner).

**AI_Hell adaptation:** Formation members execute periodic dive-in attacks using
the existing `diver` formation offsets and the Diver entity's parabolic dive
state machine (`DIVING → PAUSING → FORMATION`). The "capture" behaviour is
simplified to a temporary formation lock (the diving member is excluded from
drift during its attack), not a literal player capture.

**Divergence from original:** No literal tractor beam or partner-doubling — those
would require new entity types and a player-interaction model not yet in scope.
The dive-in attack is expressed via the existing Diver attack path; the formation
geometry uses `diver` offsets (compact chevron, wide at top).

**Pipeline fit:** `EnemyConfig` / CSV row. Uses the existing
`buildDiverFormationOffsets` (`formationKind: 'diver'`) and
`spread` shot pattern (the Diver's natural attack). Wired via
`tryFireSpreadBurst` in `enemyFire.ts` — no new entity class needed.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` + `formationKind` (`diver`) | Dive-in adds positional threat beyond the drift; the `diver` formation ordinal captures this. |
| Fire | `shotPattern` (`spread`) + `burstCount` + `fireInterval` | Spread bursts on dive completion — multi-angle hazard. |
| Health | `health` (default 1) | Single-hit; the dive timing is the primary survival challenge, not durability. |

**Gym scene:** `GymEnemies` — new CSV row; the Diver attack path is already
exercised in the shared gym base.

---

## 3. Pac-Man — ghost personalities (chase/ambush/flank/wander)

**Source game:** *Pac-Man* (Namco, 1980)

**Original behaviour:** Four ghosts each follow a distinct targeting strategy:
Blinky chases the player directly, Pinky ambushes ahead, Inky flanks using
Blinky's position, and Clyde wanders when far but chases when close.

**AI_Hell adaptation:** A small formation of 3–4 members, each with a different
movement modifier layered on the formation drift. Blinky-analogue follows the
player's live position (the `setAimTarget` seam already pushes live coords);
Pinky-analogue aims ahead of the player (snapshot + offset); Inky-analogue
tracks a midpoint between Blinky and the player; Clyde-analogue uses a distance
threshold to switch between chase and wander modes. Each ghost fires using its
own shot pattern.

**Divergence from original:** No maze or tunnel system — movement is free 2D
within the arena. The ghost personalities are expressed as movement modifiers
on the formation drift rather than pathfinding through a fixed graph.

**Pipeline fit:** New `src/entities/Ghost.ts` entity class (replaces the generic
Scout base) with a configurable personality type. Each ghost uses a different
`shotPattern` from the existing enum (e.g. Blinky: `aimed`, Pinky: `spread`,
Inky: `coordinated`, Clyde: `radial`). Factory key maps to `Ghost` in
`enemyFactory.ts`. Fire dispatch registered in `enemyFire.ts` via a new
`tryFireGhost` method that selects the pattern based on personality.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` + custom personality modifier | Each ghost adds a unique movement component on top of the base drift. |
| Fire | `shotPattern` (varies by ghost) + `burstCount` + `fireInterval` | Different patterns per ghost create varied dodging challenges. |
| Health | `health` (default 1) | Single-hit; the multi-personality approach creates a dynamic threat envelope. |

**Gym scene:** `GymEnemies` — the `Ghost` entity is wired into the factory and
fire dispatcher; the CSV row uses `formationKind: 'v'` for a loose approach
formation.

---

## 4. Centipede — segmented chain that splits on segment death

**Source game:** *Centipede* (Atari, 1981)

**Original behaviour:** A long segmented creature moves back and forth across
horizontal tracks, dropping down a row when it reaches an edge. When a segment
is destroyed, the next segment changes direction, creating a cascading
reversal.

**AI_Hell adaptation:** A chain of 5–8 connected entities where each segment
follows the one ahead at a fixed offset. Destruction of one segment triggers a
direction reversal for the remaining chain (a new `reversed` flag on the
formation drift). Segments use `single` formation offsets (they are not in a
grid — they are a line).

**Divergence from original:** No fixed horizontal tracks — the chain roams
freely in 2D. The segment-connection is expressed via the shared
`FormationGlide` helper for smooth repositioning rather than snap-to-grid.

**Pipeline fit:** New `src/entities/Centipede.ts` entity class representing a
chain of segments. Each segment is a `single`-offset entity. The factory maps
the centipede key to this entity. Fire dispatch uses a new `tryFireCentipede`
method in `enemyFire.ts` with a `radial` pattern (segments fire outward). The
`enemyDifficulty` module needs no change — the `count` factor captures the chain
length.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` + `driftSpeed` | Chain length directly affects difficulty; direction reversals add unpredictability. |
| Fire | `shotPattern` (`radial`) + `burstCount` + `fireInterval` | Each segment fires outward — a ring of bullets. |
| Health | `health` (default 1 per segment) | Multiple single-hit segments; the chain length is the key difficulty lever. |

**Gym scene:** New `GymCentipede.ts` scene (extending `GymFormationScene`) to
exercise the chain movement and direction-reversal behaviour, alongside
`GymEnemies` for the basic CSV configuration test.

---

## 5. Robotron 2084 — homing horde that swarm-steers to the player

**Source game:** *Robotron: 2084* (Williams, 1982)

**Original behaviour:** Large groups of homogeneous enemies swarm toward the
player from all directions, moving independently without formation.

**AI_Hell adaptation:** A loose cluster of 10–20 `single`-offset entities that
drift toward the player's current position in addition to the formation drift.
Each member independently adjusts its heading toward the player (the
`setAimTarget` seam provides the live coords; a new `_steerToward` movement
modifier applies a lateral acceleration).

**Divergence from original:** No multi-axis player movement — the arena is
top-down free 2D but enemies move via a combination of drift and player-
steering rather than pure free movement. No weapon variety.

**Pipeline fit:** New `src/entities/RobotronHorde.ts` entity class with a
`_steerToward(playerX, playerY)` movement modifier. Factory key maps to this
entity. Fire dispatch uses `tryFireNone` (the horde is a movement threat, not
a shooting one) or `coordinated` pattern if shooting is added later. CSV row
uses `formationKind: 'single'` with a high count.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` + `driftSpeed` + player-steering modifier | The swarm approach is a positional threat; high count creates a wall of bodies. |
| Fire | `shotPattern` (`none`) | Primary threat is movement, not bullets. Firing factors contribute zero. |
| Health | `health` (default 1) | Single-hit; the sheer number is the challenge. |

**Gym scene:** New `GymRobotronHorde.ts` scene to demonstrate the swarm
steering behaviour; `GymEnemies` for CSV testing.

---

## 6. Defender — patrol-then-attack raider state machine

**Source game:** *Defender* (Williams, 1981)

**Original behaviour:** Enemies fly across the screen along a patrol route, then
attack the player's base (or, in AI_Hell's case, the player directly) before
returning to patrol.

**AI_Hell adaptation:** A state machine per enemy: `PATROL → ATTACK → RETURN`.
In `PATROL` mode the enemy follows a horizontal sweep across the arena. In
`ATTACK` mode it dives toward the player's current position (using the Diver's
parabolic arc). In `RETURN` mode it repositions to a new patrol point.

**Divergence from original:** No "rescue floating humans" mechanic; the attack
target is always the player. The patrol path is a simple horizontal sweep
rather than a complex figure-eight.

**Pipeline fit:** New `src/entities/DefenderRaider.ts` entity class with a
`PatrolStateMachine` component. Factory key maps to this entity. Fire
dispatch uses `tryFireDefenderRaider` with `aimed` pattern (the raider fires
during its attack dive). Uses `formationKind: 'single'` — each raider is an
independent actor, not a formation member.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` + state-machine transition frequency | Patrol → attack → return cycle creates a rhythmic threat. |
| Fire | `shotPattern` (`aimed`) + `fireInterval` + `shotProbability` | Fires during the attack dive; the approach vector is the primary hazard. |
| Health | `health` (default 1) | Single-hit; timing is the survival challenge. |

**Gym scene:** New `GymDefender.ts` scene to exercise the patrol/attack/return
state machine; `GymEnemies` for CSV testing.

---

## 7. Missile Command — telegraphed orbital strike

**Source game:** *Missile Command* (Atari, 1981)

**Original behaviour:** Incoming missiles arc across the screen from multiple
launch points, each carrying a warhead that explodes on impact.

**AI_Hell adaptation:** A single large entity (`single` offset) that appears at
the arena edge, arcs toward a random target position using a parabolic path,
and detonates on arrival, spawning a burst of smaller "shrapnel" projectiles.
A long advance cue (`playPhaserAdvanceCue` analogue) telegraphs the strike
with a visible trajectory line.

**Divergence from original:** No player missile-launching; the enemy is purely
a telegraphed area-denial threat. The shrapnel burst is a `radial` pattern of
small bullets.

**Pipeline fit:** New `src/entities/MissileStrike.ts` entity class. Factory
key maps to this entity. Fire dispatch uses a new `tryFireMissileStrike`
method with a `radial` burst at detonation. The entity uses
`formationKind: 'single'` and `shotPattern: 'none'` for its main behaviour
(the burst is a separate event, not a per-cycle shot). CSV row uses
`burstCount` to control shrapnel spread.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` + arc timing | The arc speed and angle determine how much reaction time the player has. |
| Fire | `shotPattern` (`none`) + `burstCount` (shrapnel) | The initial strike has no bullets; the shrapnel burst is the secondary hazard. |
| Health | `health` (default 1) | Single-hit; the entity must be dodged, not destroyed. |

**Gym scene:** New `GymMissileStrike.ts` scene to exercise the telegraph,
arc, and detonation behaviour; `GymEnemies` for CSV testing.

---

## 8. Frogger — lane traffic hazard crossing the arena

**Source game:** *Frogger* (Konami, 1981)

**Original behaviour:** Frogger must cross roads and a river by timing movement
between lanes of traffic.

**AI_Hell adaptation:** A horizontal "lane" of 3–5 fast-moving entities that
cross the arena from left to right at high speed, like vehicles on a road.
The player must time passage through the gaps. No shooting — purely a movement
hazard.

**Divergence from original:** No river/lily-pad section; only the road lanes.
No jumping — movement is continuous 2D rather than discrete lane-hopping.
The lane is a thin horizontal band; entities within it have no formation
geometry — they are individually placed at equal horizontal spacing.

**Pipeline fit:** New `src/entities/LaneTraffic.ts` entity class. Factory key
maps to this entity. Fire dispatch uses `tryFireNone` — the lane traffic is
a pure movement hazard, no shooting. Uses `formationKind: 'single'` (each
traffic member is independently positioned). CSV row uses `driftSpeed` to
control lane velocity.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` + `driftSpeed` | Speed and gap density determine the timing challenge. |
| Fire | `shotPattern` (`none`) | No bullets — pure collision avoidance. |
| Health | `health` (default 1) | Single-hit; the hazard is the collision, not the durability. |

**Gym scene:** New `GymLaneTraffic.ts` scene to demonstrate the lane crossing
hazard; `GymEnemies` for CSV testing.

---

## Considered but not selected

The following candidates were reviewed as part of the research pool but do not
fit AI_Hell's current engine constraints or top-down free-2D arena well enough
to warrant a child work item in this research round.

| Candidate | Deferral reason |
|-----------|-----------------|
| **Joust** | Momentum-based flight with aerial ramming requires a thrust-propulsion model (like the player ship) and a collision system between enemy bodies — AI_Hell has no enemy–enemy collision (GDD §2.6), so the core Joust mechanic (overtaking and ramming mid-flight) cannot be expressed. |
| **Dig Dug** | Burrowing and terrain modification are not expressible in the flat, terrain-less arena; creating traversable hazards would require a new tile/map layer that is out of scope for the enemy roster. |
| **Q\*bert** | Diagonal-hopping on a fixed isometric pyramid is incompatible with the free 2D arena — the hopping pattern is too tightly coupled to a discrete grid that does not exist in AI_Hell. |
| **Star Castle** | Concentric rotating ring shields with a fragile core require a layered defence geometry (shield segments that can be independently targeted) that has no existing formation builder and would need a new entity type and complex targeting logic. |

---

## Registry mapping summary

| Archetype | Formation builder | Shot pattern | Entity class | Fire method | Gym scene(s) |
|-----------|-------------------|--------------|--------------|-------------|--------------|
| Space Invaders | `buildRectFormationOffsets` (`rect`) | `aimed` | Scout (reused, custom config) | `tryFireAimedBullet` (default) | `GymEnemies` |
| Galaga | `buildDiverFormationOffsets` (`diver`) | `spread` | Diver (reused, custom config) | `tryFireSpreadBurst` | `GymEnemies` |
| Pac-Man Ghosts | `buildVFormationOffsets` (`v`) | varied (`aimed`/`spread`/`coordinated`/`radial`) | `Ghost.ts` (new) | `tryFireGhost` (new) | `GymEnemies` |
| Centipede | `buildSingleOffset` (`single`) | `radial` | `Centipede.ts` (new) | `tryFireCentipede` (new) | `GymCentipede`, `GymEnemies` |
| Robotron Horde | `buildSingleOffset` (`single`) | `none` (or `coordinated` later) | `RobotronHorde.ts` (new) | `tryFireNone` | `GymRobotronHorde`, `GymEnemies` |
| Defender Raider | `buildSingleOffset` (`single`) | `aimed` | `DefenderRaider.ts` (new) | `tryFireDefenderRaider` (new) | `GymDefender`, `GymEnemies` |
| Missile Strike | `buildSingleOffset` (`single`) | `none` (burst on detonation) | `MissileStrike.ts` (new) | `tryFireMissileStrike` (new) | `GymMissileStrike`, `GymEnemies` |
| Lane Traffic | `buildSingleOffset` (`single`) | `none` | `LaneTraffic.ts` (new) | `tryFireNone` | `GymLaneTraffic`, `GymEnemies` |

**Existing seams used without modification:** `buildRectFormationOffsets`,
`buildDiverFormationOffsets`, `buildSingleOffset`, `buildVFormationOffsets`,
`aimed`, `spread`, `radial`, `coordinated`, `none`, `tryFireAimedBullet`
(default), `tryFireSpreadBurst`, `tryFireNone`.

**New seams to be created (per child work item):** `Ghost.ts` +
`tryFireGhost`, `Centipede.ts` + `tryFireCentipede` + `GymCentipede`,
`RobotronHorde.ts` + `tryFireNone` explicit + `GymRobotronHorde`,
`DefenderRaider.ts` + `tryFireDefenderRaider` + `GymDefender`,
`MissileStrike.ts` + `tryFireMissileStrike` + `GymMissileStrike`,
`LaneTraffic.ts` + `tryFireNone` explicit + `GymLaneTraffic`.

---

## Child work items

Each selected archetype has its own child work item that implements the full
lifecycle (code + tests + gym parity + docs). All children reference this
document as their design brief.

| Archetype | Child work item |
|-----------|-----------------|
| Space Invaders | AH-0MV1* (to be created) |
| Galaga | AH-0MV2* (to be created) |
| Pac-Man Ghosts | AH-0MV3* (to be created) |
| Centipede | AH-0MV4* (to be created) |
| Robotron Horde | AH-0MV5* (to be created) |
| Defender | AH-0MV6* (to be created) |
| Missile Command | AH-0MV7* (to be created) |
| Frogger | AH-0MV8* (to be created) |

---

*Document created as part of AH-0MV01EBUR003BDNK. Cross-linked from
`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` (updated in this work item).*
