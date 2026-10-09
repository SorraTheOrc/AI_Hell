# Classic Enemy Research Catalogue

> **Work item:** AH-0MV01EBUR003BDNK — Research catalogue and engine-constraint validation
> **Epic:** AH-0MUYAQ6YH0010G52 — Research classic enemies from the arcade games of old

This document catalogues the selected classic arcade enemy archetypes for AI_Hell,
recording their source game, original behaviour, adaptation to AI_Hell's
neon-vector no-enemy-collision arena, pipeline fit, difficulty scoring inputs,
and the gym scenes that will exercise them. It also records the candidates that
were considered but not selected, so the research pool can be revisited later.

**Cross-reference:** `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` — each child work
item references this document as its design brief.

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

**AI_Hell adaptation:** A rigid rectangular block of invaders that steps
sideways by a configured horizontal `marchStep`, reverses at the arena edge,
and drops one configured vertical `marchDrop` row on every reversal — the
classic marching cadence. The step cadence scales up as the block thins
(`marchSpeedMultiplier = initialCount / aliveCount`), so destroying members
speeds the march. Individual members fire aimed shots on a staggered cycle
(`shotProbability` gates the fire roll); the level's fire rule gates all fire
(Levels 1–3 never fire). No enemy–enemy interaction; each alien is a
standalone entity positioned from the shared march base.

**Divergence from original:** The original's step-down is a *screen-row* grid;
AI_Hell expresses the same behaviour as a per-reversal vertical drop of the
formation base (`marchDrop`), which reads identically in the top-down arena.
The no-enemy-collision rule means the block never squeezes against the wall —
it reverses at a computed arena bound instead.

**Pipeline fit:** `EnemyConfig` / CSV row. Uses a **new formation kind
`march`** (`buildMarchFormationOffsets`, an 11-column rectangular grid) and the
existing `aimed` shot pattern. The movement is a shared pure policy
(`src/scenes/core/marchFormation.ts`) consumed by both `PlayScene` and
`GymFormationScene`, so the gym and game cannot diverge. Wired into
`enemyFire.ts` via `tryFireAimedBullet` (no new entity class needed — the
Scout body is reused). Factory key falls back to the Scout entity type with
custom colour/sizing. Two neutral tuning axes, `marchStep` and `marchDrop`, are
added to the config/CSV pipeline.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `formationKind` (`march`) + `driftSpeed` (px/s) + `marchStep` + `marchDrop` + `count` | Rigid block; `driftSpeed` sets the full-strength cadence, destruction reduces the alive count so the block speeds up. |
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

## 3. Pac-Man — ghost personality pursuers

**Source game:** *Pac-Man* (Namco, 1980)

**Original behaviour:** Four ghosts each follow a distinct targeting strategy:
Blinky chases the player directly, Pinky ambushes ahead, Inky flanks using a
pivot, and Clyde wanders. A shared scatter/chase timer alternates every ghost
between a corner retreat and its pursuit target.

**AI_Hell adaptation:** Four fast, low-HP **non-firing** pursuers (`chase`,
`ambush`, `flank`, `wander`) enter from the arena edges as a wave-accounted
group. Each steers toward a personality-specific target resolved by the
shared, pure `src/scenes/core/ghostSteering.ts` policy, which also owns the
scatter/chase timer (a pure function of elapsed time). Aim leads use the
player's live velocity; scatter targets are fixed arena corners. `chase`
targets the player directly, `ambush` targets ahead of the player's velocity,
`flank` offsets the ambush pivot perpendicular to the player's heading, and
`wander` roams a slowly rotating point near itself. The same shared code runs
in the game and in the `GymEnemies` gym. Body contact is the
threat (GDD §2.4) and is resolved by the existing enemy-body collision rule.

**Divergence from original:** No maze or tunnel system — movement is free 2D
within the arena, clamped to the viewport. There is no literal "ghost house";
the pursuers enter from the edges. Ambush/flank lead by a tuned number of
seconds rather than a tile count.

**Pipeline fit:** `EnemyConfig` / CSV rows — **one row per personality**
(`ghost-chase`, `ghost-ambush`, `ghost-flank`, `ghost-wander`), all
`formationKind: 'single'` and `shotPattern: 'none'`. The new
`src/entities/Ghost.ts` carries the personality (derived from the key) and the
shared steering; `src/entities/enemyFactory.ts` maps the four keys to `Ghost`;
`src/entities/enemyFire.ts` maps them explicitly to `tryFireNone` so they can
never fall back to the aimed shot. A new pure planner
`src/waves/GhostSpawner.ts` computes the four-personality group, and
`PlayScene` registers every released ghost with the `WaveManager`
(`registerDynamicSpawn`) so the wave neither clears early nor stalls (the same
invariant as the Harvester/Asteroid spawners). The spawner is gated by a
per-wave `ghosts: true` opt-in so it can be introduced into campaign data
without changing existing waves.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` + pursuit speed (shared `GHOST_PURSUIT_SPEED`) | The threat is the pursuit envelope, not formation drift (`driftSpeed` is neutral/0). Four bodies converging from different edges. |
| Fire | `shotPattern` (`none`) | Never fires at any level; the firing factors (`fireInterval`, `shotProbability`, `bulletSpeed`, `bulletLifetime`, `burstCount`) contribute zero. |
| Health | `health` (1) | Single-hit; survival depends on reading the personalities, not durability. |

**Gym scene:** `GymEnemies` — each personality row appears automatically in the
gym index, and the shared `Ghost` / `ghostSteering` code runs in both the gym
and the game (enforced by `src/scenes/core/CombatScene.equivalence.test.ts`).
No new gym scene is required.

---

## 4. Centipede — segmented chain that splits on segment death

**Source game:** *Centipede* (Atari, 1981)

**Original behaviour:** A long segmented creature moves back and forth across
horizontal tracks, dropping down a row when it reaches an edge. When a segment
is destroyed, the next segment changes direction, creating a cascading
reversal.

**AI_Hell adaptation:** A linked chain of segments. The lead weaves
laterally (reversing at the left/right arena bounds) while descending at a
fixed rate, wrapping back to the top at the bottom edge; every following
segment trails the one ahead at a fixed arc-length, so the chain reads as a
continuous snake through every reversal. Destroying a **middle** segment
splits the chain into **two independent sub-chains** (the segments ahead and
behind), each with its own lead and path; destroying the **lead** or the
**tail** simply shortens the remaining chain. The chain speeds up
monotonically as segments are destroyed. Segments **never fire** — the
weaving linked body is the threat, resolved by the existing enemy-body
collision rule. The weave/descent movement is the whole threat, and each
segment has `health` 1 (single-hit) — the chain length is the difficulty
lever.

**Divergence from original:** No fixed horizontal tracks or mushroom field —
the chain roams freely in the 2D arena and wraps at the bottom rather than
stepping down a row. The original's "destroyed segment reverses the chain"
is expressed as a clean split into two independent sub-chains (the work-item
adaptation), which reads as the same cascading disruption without a
per-segment direction flag. The dedicated `GymCentipede` gym scene exercises
the same shared chain code for gym-to-game parity.

**Pipeline fit:** **Not** expressible as an `EnemyConfig`/CSV formation row —
a linked chain is a coordinated group, not an independent formation slot. It
is delivered by a dedicated `src/entities/Centipede.ts` entity (one segment)
plus the pure shared model `src/scenes/core/centipedeChain.ts` (weave,
descent, edge handling, split, speed-up) and the pure planner
`src/waves/CentipedeSpawner.ts` (one chain per opted-in wave). The factory
`EnemyEntity` union includes `Centipede`; `enemyFire.ts` maps the
`centipede` key to an explicit `tryFireNone` so it can never fall back to the
aimed shot. `PlayScene` registers **every** spawned segment with the
`WaveManager` (the Harvester/Ghost invariant; unlike the Asteroid), gated
behind a per-wave `centipede: true` opt-in so existing wave data is
unchanged. The `enemyDifficulty` module needs no change — the `count` factor
captures the chain length.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` (segments) + `driftSpeed` + `formationKind` (`single`) | Chain length is the primary lever; the weave/reversal adds unpredictability. |
| Fire | `shotPattern` (`none`) | Never fires at any level; the firing factors contribute zero. |
| Health | `health` (default 1 per segment) | Multiple single-hit segments; the chain length is the key durability lever. |

**Gym scene:** New `GymCentipede.ts` scene (extending `GymFormationScene`)
that builds the same `CentipedeChain`/`Centipede` code the game runs, so it
exercises the weave, descent, split and no-fire behaviour for gym-to-game
parity.

---

## 5. Robotron 2084 — homing horde that swarm-steers to the player

**Source game:** *Robotron: 2084* (Williams, 1982)

**Original behaviour:** Large groups of homogeneous enemies swarm toward the
player from all directions, moving independently without formation.

**AI_Hell adaptation:** A dense pack of small, fast, **non-firing** grunts
that pour in from all four arena edges in timed groups and continuously home
on the live player. The defining top-down adaptation is **bounded steering**:
a grunt does not snap its velocity at the player — it turns its forward
heading toward the player at a capped turn rate and always travels forward at
its homing speed, so the swarm is readable and dodgeable while still feeling
relentless. Grunts pass through each other and every other enemy (GDD §2.6 —
no enemy–enemy collision) and each has `health` 1 (single-hit); the swarm of
bodies, resolved by the existing enemy-body contact rule, is the whole threat.
The same shared `Grunt`/`gruntSteering` code is exercised by the existing
`GymEnemies` gym scene with a live player (gym↔game parity); its CSV row uses
the existing `buildSwarmClusterOffsets` (`swarm`) formation builder and the
existing `none` shot pattern.

**Divergence from original:** No multi-axis player-movement restriction — the
arena is top-down free 2D and the horde homes through bounded steering rather
than instant velocity assignment. No weapon variety: grunts never fire at any
level.

**Pipeline fit:** Partly an `EnemyConfig`/CSV row and partly a new entity. The
horde size, group size, spawn cadence and homing speed are data-driven CSV
columns (`count`, `hordeGroupSize`, `hordeSpawnInterval`, `driftSpeed`), while
movement lives in the pure shared policy
`src/scenes/core/gruntSteering.ts` and the `src/entities/Grunt.ts` entity.
The horde is delivered by the pure `src/waves/HordeSpawner.ts` planner — a
dynamic, wave-accounted spawner in the Harvester/Ghost/Centipede mould rather
than a static formation — gated behind a per-wave `horde: true` opt-in so
existing wave data is unchanged. The factory `EnemyEntity` union includes
`Grunt`; `enemyFire.ts` maps the `grunt` key to an explicit `tryFireNone` so
it can never fall back to the aimed shot. The `enemyDifficulty` module needs
no change — the `count` factor captures the horde size.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` (horde size) + `driftSpeed` (homing speed) + `formationKind` (`swarm`) | The swarm approach is a positional threat; high count creates a wall of bodies. |
| Fire | `shotPattern` (`none`) | Never fires at any level; the firing factors contribute zero. |
| Health | `health` (default 1) | Single-hit; the sheer number is the challenge. |

**Gym scene:** The existing `GymEnemies` scene (with a live player) exercises
the shared `Grunt`/`gruntSteering` homing and density, so the game and the gym
run the same code (gym↔game parity).

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

**Pipeline fit:** New `src/entities/Raider.ts` entity class backed by the
pure shared state machine `src/scenes/core/raiderPatrol.ts`. Factory key maps
to this entity. Fire dispatch reuses the Scout's `tryFireAimedBullet` seam
with the `aimed` pattern (the raider fires only during its committed attack
run and only when the level fire rule enables firing). Uses
`formationKind: 'single'` — each raider is an independent actor, not a
formation member. `driftSpeed` is the patrol speed; the raider-specific
`attackSpeed` and `commitRange` columns tune the attack run and the commit
proximity.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `driftSpeed` + state-machine transition frequency | Patrol → attack → return cycle creates a rhythmic threat. |
| Fire | `shotPattern` (`aimed`) + `fireInterval` + `shotProbability` | Fires during the attack dive; the approach vector is the primary hazard. |
| Health | `health` (default 1) | Single-hit; timing is the survival challenge. |

**Gym scene:** The existing `GymEnemies` scene (with a live player) runs the
same shared `Raider`/`raiderPatrol` code, so the game and the gym cannot
diverge (gym↔game parity). No new gym scene is required.

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

**Gym scene:** The existing `GymEnemies` scene exercises the telegraph, fall,
and detonation behaviour with a live player (gym↔game parity); `GymLevel`
may additionally exercise it in a wave context.

**Delivered (AH-0MV01ENX00055CG1):** The shipped vertical slice is the
`orbital-strike` CSV row (`formationKind: 'single'`, `shotPattern: 'none'`)
backed by `src/entities/OrbitalStrike.ts` and the pure planner
`src/waves/StrikeSpawner.ts` (modelled on `AsteroidSpawner`). It diverges from
the original research sketch in three implementation details, all recorded
here: the entity is named `OrbitalStrike` (not `MissileStrike`); it is
**non-firing** — it has no `tryFireMissileStrike` seam and is mapped to
`tryFireNone` in `src/entities/enemyFire.ts`, because the radial burst is a
**detonation event** hoisted into the shared enemy-bullet path by the scene,
not a per-cycle shot; and it falls straight down from off-screen to the
telegraphed impact point rather than following a parabolic arc. It is a
**non-blocking world hazard** (not registered with the `WaveManager`,
matching the asteroid accounting), so a wave can neither stall nor clear early
on it. No dedicated `GymMissileStrike` scene is needed: the shared entity code
is exercised by the existing `GymEnemies` scene, enforced by
`src/scenes/core/CombatScene.equivalence.test.ts`.

---

## 8. Frogger — lane traffic hazard crossing the arena

**Source game:** *Frogger* (Konami, 1981)

**Original behaviour:** Frogger must cross roads and a river by timing movement
between lanes of traffic.

**AI_Hell adaptation:** One to three horizontal "lanes" of 3–5 fast-moving
entities that cross the arena at constant speed, wrapping at the edges, like
vehicles on a road. The members never shoot and never home; a combination of
timing and shooting clears a path. The player may weave through the gaps or
destroy individual members (1 HP). Lane traffic is a non-blocking world
hazard (the Asteroid accounting): it never gates wave completion.

**Divergence from original:** No river/lily-pad section; only the road lanes.
No jumping — movement is continuous 2D rather than discrete lane-hopping.
Unlike the original (where traffic is indestructible), the hazards are
destructible so they fit the "enemies are the bullets" design and the
asteroid/obstacle model.

**Pipeline fit:** New `src/entities/LaneTraffic.ts` entity class plus the pure
`src/waves/LaneTrafficSpawner.ts` planner. Factory key maps to this entity.
Fire dispatch uses `tryFireNone` — the lane traffic is a pure movement hazard,
no shooting. Uses `formationKind: 'rect'` so the shared `GymEnemies` scene
displays the lane as a row of `count` members (the game's spawner places the
same count per lane; a `single` row would show only one member). CSV row uses
`driftSpeed` for the lane velocity, `spacingX` for the within-lane gap and the
new neutral `laneCount`/`laneSpacing` columns for the lane count and vertical
gap.

**Difficulty scoring inputs:**

| Factor | Type | Notes |
|--------|------|-------|
| Movement | `count` + `driftSpeed` | Speed and gap density determine the timing challenge. |
| Fire | `shotPattern` (`none`) | No bullets — pure collision avoidance. |
| Health | `health` (default 1) | Single-hit; the hazard is the collision, not the durability. |

**Gym scene:** The existing `GymEnemies` scene (with a live player) runs the
same shared `LaneTraffic` entity's `updatePosition` seam, so the game and the
gym cannot diverge (gym↔game parity). No new gym scene is required.

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
| Space Invaders | `buildMarchFormationOffsets` (`march`, new) | `aimed` | Scout (reused, custom config) | `tryFireAimedBullet` | `GymEnemies` |
| Galaga | `buildDiverFormationOffsets` (`diver`) | `spread` | Diver (reused, custom config) | `tryFireSpreadBurst` | `GymEnemies` |
| Pac-Man Ghosts | `buildSingleOffset` (`single`) | `none` | `Ghost.ts` (new) | `tryFireNone` | `GymEnemies` |
| Centipede | `buildSingleOffset` (`single`) | `radial` | `Centipede.ts` (new) | `tryFireCentipede` (new) | `GymCentipede`, `GymEnemies` |
| Robotron Horde | `buildSwarmClusterOffsets` (`swarm`) | `none` | `Grunt.ts` (new) + `gruntSteering.ts` + `HordeSpawner.ts` | `tryFireNone` | `GymEnemies` |
| Defender Raider | `buildSingleOffset` (`single`) | `aimed` | `Raider.ts` (new) + `raiderPatrol.ts` (new, shared) | `tryFireAimedBullet` (reused) | `GymEnemies` |
| Missile Strike | `buildSingleOffset` (`single`) | `none` (burst on detonation) | `MissileStrike.ts` (new) | `tryFireMissileStrike` (new) | `GymMissileStrike`, `GymEnemies` |
| Lane Traffic | `buildRectFormationOffsets` (`rect`) | `none` | `LaneTraffic.ts` (new) + `LaneTrafficSpawner.ts` (new) | `tryFireNone` | `GymEnemies` |

**Existing seams used without modification:** `buildRectFormationOffsets`,
`buildDiverFormationOffsets`, `buildSingleOffset`, `buildVFormationOffsets`,
`aimed`, `spread`, `radial`, `coordinated`, `none`, `tryFireAimedBullet`
(default), `tryFireSpreadBurst`, `tryFireNone`.

**New seams to be created (per child work item):** `Ghost.ts` (+ `ghostSteering.ts`, `GhostSpawner.ts`, `tryFireNone`), `Centipede.ts` + `tryFireCentipede` + `GymCentipede`,
`Grunt.ts` + `gruntSteering.ts` + `HordeSpawner.ts` + `tryFireNone` explicit,
`Raider.ts` + `raiderPatrol.ts` + `tryFireAimedBullet` reuse,
`MissileStrike.ts` + `tryFireMissileStrike` + `GymMissileStrike`,
`LaneTraffic.ts` + `LaneTrafficSpawner.ts` + `tryFireNone` explicit.

---

## Child work items

Each selected archetype has its own child work item that implements the full
lifecycle (code + tests + gym parity + docs). All children reference this
document as their design brief.

| Archetype | Child work item |
|-----------|-----------------|
| Space Invaders | AH-0MV01EDZS0005R20 |
| Galaga | AH-0MV01EFII008298D |
| Pac-Man Ghosts | AH-0MV01EH2U008XT3Q |
| Centipede | AH-0MV01EJ92008ZZ86 |
| Robotron Horde | AH-0MV01EKTL001NRE6 |
| Defender | AH-0MV01EM7U0033W7L (delivered) |
| Missile Command | AH-0MV01ENX00055CG1 (delivered) |
| Frogger | AH-0MV01EPM40008N8T |

---

*Document created as part of AH-0MV01EBUR003BDNK. Cross-linked from
`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` (updated in this work item).*
