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

| ID | Name | Movement | Attack | GDD | Behaviour | Appearance | Fires (L1–3 → L4+) |
|----|------|----------|--------|-----|-----------|------------|---------------------|
| E1 | Scout | `formation` | `projectile` | §4.1 | V-formation flight, subtle wiggle | Small angular chevron, neon green | none → aimed shot |
| E2 | Diver | `diver` | `projectile` | §4.1 | Diagonal parabolic dive toward the player's position snapshotted at dive start (both x and y follow the quadratic bezier arc — no x-lock; AH-0MTGBOKLC006N8UX), then the Diver group re-forms around the attack end: when the pause ends the Diver-group origin re-bases so the Diver's slot coincides with its attack end; only the Diver group moves (the Divers glide to their new slots) while every non-Diver enemy stays put (no return glide, no formation hold; AH-0MUAYB957002EMYV, AH-0MUL15N63003PUDB) | Medium dart shape, neon yellow | none → short-burst spread (3–5) |
| E3 | Tank | `formation` | `projectile` | §4.1 | Slow deliberate formation, long hold positions | Large hexagonal/blocky, neon | none → radial burst (10 shots) |
| E4 | Phaser | `formation` | `projectile` | §4.1 (L5) | Fixed orbital path, predictable firing cycles | Circular ring with central core | yes — patterned, telegraphed (≥ 500 ms lead) |
| E5 | Swarm | `formation` | `projectile` | §4.1 | Tight fast clusters, sudden direction changes | Small diamonds, groups | none → coordinated burst |
| E6 | Asteroid | `roamer` | `contact` | §4.1 | Free-roaming straight-line drift (screen wrap), continuous rotation, splits into two smaller rocks when shot | Jagged procedural neon polygon (grey), 3 size tiers | **never fires** |
| E7 | Harvester | `roamer` | `contact` | §4.1 | Large, slow roaming mineral-seeker: always steers to the nearest live mineral and absorbs it on overlap; holds station with no mineral; **5 HP**; rare Levels 4–5 roaming spawn (wave-accounted) | Large violet hexagonal "collector" | **never fires** |
| Boss | The Central AI | `formation` | `projectile` | §4.3 | 4 attack phases, 50 hits per phase (200 total; 4-phase screen-fixed bar), figure-of-eight movement, per-hit SFX/VFX | Large neon geometric structure with core | complex patterns per phase |

Regular-enemy health is **data-driven** (`EnemyConfig.health`, default **1**):
E1–E6 are 1 HP (one bullet destroys them) and E7 Harvester is **5 HP**; the
Boss is multi-hit via its 4-phase bar — **50 hits per phase (200 total)**. All enemies **never collide with each
other** (GDD §2.6) — no collision system is installed in the gym scenes.

### 1.1 Classic arcade research (AH-0MUYAQ6YH0010G52)

The current roster (E1–E7 + Boss) is a self-contained set of seven archetypes.
A research epic (AH-0MUYAQ6YH0010G52) selected eight classic arcade enemy
archetypes for future implementation: Space Invaders, Galaga, Pac-Man Ghosts,
Centipede, Robotron 2084 Horde, Defender Raider, Missile Command Strike, and
Frogger Lane Traffic. Each selected archetype has its own child work item that
implements the full lifecycle (code + tests + gym parity + docs). All eight are
now implemented:

| Archetype | Source game | Config key | Formation / seam | Fires |
|-----------|-------------|------------|------------------|-------|
| Space Invaders | Space Invaders (1978) | `march` | `march` formation (`Scout` body) | aimed (L4+) |
| Galaga capturer | Galaga (1981) | `capturer` | `Capturer` + capture beam | never |
| Pac-Man ghosts | Pac-Man (1980) | `ghost-chase`, `ghost-ambush`, `ghost-flank`, `ghost-wander` | `Ghost` + ghost steering | never |
| Centipede | Centipede (1981) | `centipede` | `Centipede` + chain model | never |
| Robotron horde | Robotron 2084 (1982) | `grunt` | `Grunt` + grunt steering | never |
| Defender raider | Defender (1981) | `raider` | `Raider` + patrol state machine | aimed (L4+, attack run) |
| Missile Command strike | Missile Command (1980) | `orbital-strike` | `OrbitalStrike` + strike spawner (non-blocking hazard) | never |
| Frogger lane traffic | Frogger (1981) | `lane-traffic` | `LaneTraffic` + lane-traffic spawner (non-blocking hazard) | never |

The full research catalogue — source game, original behaviour, AI_Hell
adaptation, pipeline fit, difficulty scoring inputs, and gym scenes — is in
[`CLASSIC_ENEMY_RESEARCH.md`](CLASSIC_ENEMY_RESEARCH.md). The "considered but
not selected" section (Joust, Dig Dug, Q*bert, Star Castle) is also recorded
there for future roster expansion.

The **Pac-Man ghost personality pursuers** (AH-0MV01EH2U008XT3Q) are the first
of these to be implemented as a full vertical slice. Four non-firing CSV rows
(`ghost-chase`, `ghost-ambush`, `ghost-flank`, `ghost-wander`) share the pure
`src/scenes/core/ghostSteering.ts` targeting policy and the
`src/entities/Ghost.ts` entity; `src/waves/GhostSpawner.ts` plans the
four-personality group as a tight cluster from one entry point (released
within a single ~90 ms window, AH-0MV9G78DO0053MGK) and `PlayScene` registers
every released ghost with the
`WaveManager`, gated behind a per-wave `ghosts: true` opt-in (so existing wave
data is unchanged). The entity never fires — body contact is the threat — and
its `tryFireNone` dispatch entry keeps it out of the aimed-shot fallback.

The **Centipede linked chain** (AH-0MV01EJ92008ZZ86) is the second delivered
classic archetype and the first that is **not** expressible as a CSV
formation: a coordinated chain of segments is delivered by a dedicated
`src/entities/Centipede.ts` entity (one segment) plus the pure shared model
`src/scenes/core/centipedeChain.ts` and the `src/waves/CentipedeSpawner.ts`
planner. The lead weaves laterally (reversing at the left/right bounds) while
descending, wrapping at the bottom edge; every following segment trails at a
fixed arc-length. Destroying a **middle** segment splits the chain into two
independent sub-chains (lead/tail deaths simply shorten it), and the chain
speeds up monotonically as segments die. Segments **never fire** — body
contact is the threat — its `tryFireNone` dispatch entry keeps it out of the
aimed-shot fallback, and every spawned segment is registered with the
`WaveManager`, gated behind a per-wave `centipede: true` opt-in. The dedicated
`GymCentipede` scene runs the same shared entity/chain code, so the game and
the gym cannot diverge. Because it is not a CSV config it is surfaced as a
dedicated **Centipede** option inside `GymFodderEnemies`'s in-panel enemy
selector (`src/scenes/gym/core/centipedeFormation.ts` owns the single shared
formation config both scenes use), not as a separate ENEMIES row on the gym
index (AH-0MV4ZOIZR0086T66).

The **Robotron 2084 homing horde** (AH-0MV01EKTL001NRE6) is the third
delivered classic archetype and is **partly** a CSV row and partly a new
entity: the horde size, group size, spawn cadence and homing speed are
data-driven (`count`, `hordeGroupSize`, `hordeSpawnInterval`, `driftSpeed` on
the `grunt` row), while the movement lives in the pure shared policy
`src/scenes/core/gruntSteering.ts` and the `src/entities/Grunt.ts` entity. The
pure `src/waves/HordeSpawner.ts` planner releases small groups from the four
arena edges over time and **bounded steering** turns each grunt toward the
live player at a capped turn rate, so it homes in an arc rather than
snap-reversing. Grunts **never fire** — the swarm of bodies, resolved by the
existing enemy-body contact rule, is the whole threat — and the explicit
`tryFireNone` dispatch entry keeps them out of the aimed-shot fallback. Every
spawned grunt is registered with the `WaveManager`, gated behind a per-wave
`horde: true` opt-in, and the existing `GymFodderEnemies` scene runs the same shared
entity/steering code with a live player for gym↔game parity.

The **Defender patrol-and-attack raider** (AH-0MV01EM7U0033W7L) is the fourth
delivered classic archetype. It is a single, fast CSV row (`raider`,
`formationKind: single`) backed by a dedicated `src/entities/Raider.ts` entity
and the pure shared state machine `src/scenes/core/raiderPatrol.ts`: the raider
sweeps the arena in a horizontal patrol (wrapping at the side edges), then
commits to a straight high-speed attack run toward the player position
snapshotted at the commit moment, overshoots, wraps at the first edge and
re-enters patrol, so it can commit repeatedly. The `driftSpeed` column is the
patrol speed; the raider-specific `attackSpeed` and `commitRange` columns tune
the attack run and the commit proximity. The entity reuses the Scout's
aimed-shot tell but fires only during a committed attack and only when the
level's fire rule enables firing, so it never fires in Levels 1–3; it passes
through every other enemy (GDD §2.6 — no enemy–enemy collision). The existing
`GymFodderEnemies` scene runs the same shared entity/state-machine code with a live
player for gym↔game parity.

The **Missile Command telegraphed orbital strike** (AH-0MV01ENX00055CG1) is the
fifth delivered classic archetype and is a **non-blocking world hazard**
rather than a wave-gating ship. It is a single CSV row (`orbital-strike`,
`formationKind: single`, `shotPattern: none`) backed by a dedicated
`src/entities/OrbitalStrike.ts` entity and the pure planner
`src/waves/StrikeSpawner.ts` (modelled on `AsteroidSpawner`). The entity
lifecycle is a three-phase state machine — **telegraph → fall → detonate**:
a visible marker pulses at the predicted impact point for a configurable tell
of at least 500 ms (`TELEGRAPH_DURATION`, reusing the Scout advance cue), then
a fast projectile falls from off-screen to that exact point and detonates in a
`burstCount`-shrapnel radial burst. The strike never fires on the fire cycle
(`tryFireNone`), so its only threat is the telegraphed projectile and the
detonation burst; it never collides with or damages other enemies (GDD §2.6),
and — matching the asteroid accounting (AH-0MUJM746P000QAEO) — it is **not
registered with the `WaveManager`**, so a wave can neither stall nor clear
early on it. The radial detonation burst is hoisted into the shared
enemy-bullet path (so it can damage the player) while the strike entity itself
is skipped once destroyed. Because the tell is driven by the simulation `dt`
accumulated in `update(dt)`, the game and every gym run the identical
lifecycle. The existing `GymFodderEnemies` scene runs the same shared entity code
with a live player for gym↔game parity.

The **Frogger lane-traffic hazard** (AH-0MV01EPM40008N8T) is the sixth
delivered classic archetype. It is a CSV row (`lane-traffic`) backed by the
`src/entities/LaneTraffic.ts` entity and the pure
`src/waves/LaneTrafficSpawner.ts` planner. Each wave plans one to three
horizontal lanes of fast-moving, non-firing hazards that cross the arena at a
constant speed (`driftSpeed`) and wrap at the edges; `count` is the members per
lane, `spacingX` the within-lane gap and the neutral `laneCount`/`laneSpacing`
columns the lane count and vertical gap. Lane traffic is a **non-blocking
world hazard** (the Asteroid accounting): the `LaneTrafficSpawner` events are
spawned directly and never registered with the `WaveManager`, so traffic can
never stall or prematurely clear a wave, and destroying one never advances the
wave. It **never fires** (an explicit `tryFireNone` dispatch entry keeps it out
of the aimed-shot fallback), is single-hit destructible, passes through every
other enemy (GDD §2.6 — no enemy–enemy collision) and is mineral-inert. The
`formationKind` is `rect` so the existing `GymFodderEnemies` scene displays the lane
as a row of members and runs the same shared `updatePosition` seam with a live
player for gym↔game parity.

### 1.2 Data-driven enemy pipeline (AH-0MTFP7EIC004F1MN, CSV AH-0MTZWZ9TE009CVUA)

Enemy tuning is data, not code. Each archetype is a row in the committed
`src/data/enemy-configs.csv`; at boot the config store parses/validates it into
typed `EnemyConfig` objects and the scenes/factory consume the synchronous
loaders. Retuning an enemy — or adding a new one — is a CSV edit (or a gym
**Save** / **Save As…**), with no TypeScript change required. See §8 for the
full schema, codec, config-store and Vite-plugin reference.

### 1.3 E6 Asteroid — the roaming, self-splitting rock (AH-0MU8BZ2ZM004J47F)

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
**different from the parent and from each other** (≥ π/3 separation). The spawn
loop lives **once** in the shared helper `src/scenes/core/asteroidSplit.ts`
(`splitAsteroid({ scene, parent, register })`), consumed by
`PlayScene._splitAsteroid` and the `GymFodderEnemies`/`GymMinerals` destruction seams,
so a split-physics change is made in one place.

**Wave-aware splitting**: split children are **not** registered with the
`WaveManager` and do **not** count toward `enemiesAlive`. A wave clears once
its **enemy ships** are destroyed, regardless of how many asteroids remain,
and the children persist in the field across wave and level transitions
(AH-0MUJM746P000QAEO). See `PlayScene._splitAsteroid`.

**Scoring** (GDD §4.5): large and medium asteroids award **no** points; small
asteroids award **50** (`SCORE_VALUES.asteroid`, tier-checked in
`PlayScene._onEnemyKilled`). Collision (ramming) kills award no points, as
always.

**Kill reward (AH-0MV6M2M9P0078N4S)**: in addition to the generic per-kill
power-up roll, a fully destroyed **small** asteroid additionally rolls the
configurable **Extra Life** chance (`GameRules.asteroidExtraLifeDropChance`,
default **0.05**); a winning roll leaves exactly one `extra_life` pickup at
the death site. The roll lives **once** in the shared helper
`src/scenes/core/asteroidKillDrops.ts`
(`rollAsteroidExtraLife(entity, rng, chance)` — tier gate first, then
`rng() < chance`), consumed by `PlayScene._onEnemyKilled` and the gym kill
seams (`GymFormationScene.onEnemyDestroyed`/EXPLODE and
`GymLevel.onEnemyDestroyed`), so the game and the gyms cannot drift. Large and
medium asteroids never roll it.

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
- **Registration**: asteroids are **not** registered with the `WaveManager`,
  so they do not gate wave completion and persist across wave/level
  transitions. (The generic `registerDynamicSpawn` / `unregisterDynamicSpawn`
  seam remains on `WaveManager` for any future dynamically spawned enemy that
  must be wave-accounted.) The asteroid is therefore **excluded from the
  difficulty auto-sequencer's candidate pool** (`defaultCandidatePool()`) — a
  sequenced asteroid group would be counted as a wave enemy but never un-counted
  (AH-0MUR1HZLQ001ELX9).

The **boss encounter spawns no asteroids**: `planAsteroidSpawns()` clears the
plan outside a regular wave and the release loop is guarded on boss state.
`PlayScene.setAsteroidSpawnerEnabled(false)` is a tuning/test seam that
suppresses the spawner entirely.

**Gym support**: the asteroid is selectable in the enemy gym (auto-discovery
via `DEFAULT_ENEMY_CONFIGS`). `GymFormationScene` gained two small seams —
optional `updatePosition(dt)` on `FormationSceneEntity` (roamer motion) and
optional `onEntityDestroyed(entity)` on `EnemyFormationConfig` (dynamic split
children) — so EXPLODE, player bullets and body-rams all cascade splits and
the wipe→respawn cycle runs only once the whole chain is cleared. Split
children are registered through the base's `registerDynamicEntity(child)` seam
(no casting into `entities`), and the base also exposes the protected
`respawnFormation()` and `setPlayerEnabled(enabled)` seams
(AH-0MUII3F7Q002O7WX, gap 9) so `GymFodderEnemies._onRespawn`/`_onTogglePlayer`
consume the shared respawn and player lifecycle instead of re-implementing
them.

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

**Gym surface.** `GymFodderEnemies` (`src/scenes/gym/GymFodderEnemies.ts`,
key `GymFodderEnemies`; renamed from `GymEnemies`, AH-0MV13G5EV008D41E) is the
**single reusable *fodder* enemy gym scene**. It is parameterized by
`{ enemyKey }` via `init()` → `loadEnemyConfig(enemyKey)` and derives
formation/bullet behaviour from the loaded config; the key is also the
optional deep-link default for the **in-panel enemy selector** (an `<select>`
listing every non-boss config plus the Centipede chain — see §8.5). The gym
index (`GymIndex`) no longer enumerates one row per config: its **ENEMIES**
column has a single **"Fodder Enemies"** row that boots `GymFodderEnemies`
bare (the dropdown picks the archetype, default `scout`) and a dedicated
**"Boss"** row that boots `GymBoss` directly (AH-0MUAYB28C004KK7X). The
Centipede chain (a wave opt-in, not a CSV config) is **not** a separate row —
it appears as a dedicated **"Centipede"** option inside the fodder gym's
enemy selector, which swaps in the shared linked-chain formation the game and
`GymCentipede` run (`src/scenes/gym/core/centipedeFormation.ts`,
AH-0MV4ZOIZR0086T66). The index renders three columns — plain scenes,
**ENEMIES** and **Dev Utilities** — so the Bosses column, the redundant `boss`
"Boss Swarm" config row and the per-config rows were retired
(AH-0MV13G5EV008D41E; formerly AH-0MTV8OV9V002D8B7/AH-0MUAYB28C004KK7X).
`GymBoss` and `GymCentipede` are excluded from the plain scene list (left
column) so enemy testbeds are not duplicated as bare scenes. Legacy
`GymScout`/`GymDiver`/… scenes have been
retired; their formation/bullet assertions now live in `GymFodderEnemies.test.ts`
keyed by `enemyKey`.

### 1.4 Behavioural classification (AH-0MV29NWI1007NKN7)

Every CSV archetype carries two coarse, **descriptive** behavioural fields
that sit above the low-level `formationKind` / `shotPattern` axes and exist so
wave composition can be reasoned about and validated for balance:

- **`movementClass`** — how the archetype moves:
  `formation` (coordinated/patterned, no independent pursuit), `diver` (a
  formation that breaks off into a targeted dive), `chaser` (homes on the
  player), `patroller` (independent path that may commit to an attack run),
  `roamer` (independent trajectory/hazard that ignores the player).
- **`attackClass`** — the archetype's *ranged/special* attack: `contact`
  (contact-only), `projectile` (fires projectiles), `beam` (tractor beam),
  `area` (telegraphed area detonation).

**Contact invariant:** *every* enemy damages the player on contact, so
`attackClass` describes only the additional ranged/special attack — `contact`
means contact-only. There is deliberately no `none` value.

Both fields are validated (`validateEnemyConfig`) and coerced
(`coerceEnemyConfig`) by the CSV codec. Absent values fall back to the
documented defaults — `movementClass` → `formation`, `attackClass` derived
from the effective `shotPattern` (`none` → `contact`, otherwise `projectile`) —
so legacy files without the columns still parse. The classification is
**consumed**: it drives the wave balance rules R1–R3 (§1.5), which the
runtime wave generator enforces for generated waves and the campaign audit
validates. The consuming module is `src/core/waveBalance.ts`.

The agreed mapping for all 18 CSV archetypes:

| Config key | movementClass | attackClass |
|------------|---------------|-------------|
| `scout` | `formation` | `projectile` |
| `diver` | `diver` | `projectile` |
| `tank` | `formation` | `projectile` |
| `phaser` | `formation` | `projectile` |
| `swarm` | `formation` | `projectile` |
| `boss` | `formation` | `projectile` |
| `march` | `formation` | `projectile` |
| `capturer` | `formation` | `beam` |
| `ghost-chase` | `chaser` | `contact` |
| `ghost-ambush` | `chaser` | `contact` |
| `ghost-flank` | `chaser` | `contact` |
| `ghost-wander` | `chaser` | `contact` |
| `grunt` | `chaser` | `contact` |
| `raider` | `patroller` | `projectile` |
| `asteroid` | `roamer` | `contact` |
| `harvester` | `roamer` | `contact` |
| `lane-traffic` | `roamer` | `contact` |
| `orbital-strike` | `roamer` | `area` |

The `centipede` linked chain (AH-0MV01EJ92008ZZ86) is a dedicated entity, not
a CSV row, so it carries no classification pair; it is a contact-only chaser.

### 1.5 Wave balance rules R1–R3 (AH-0MV29XQ0H009P9WP)

The classification in §1.4 is consumed by the **wave balance rules**, a pure,
Phaser-free module (`src/core/waveBalance.ts`) that is the single source of
truth for three hard design constraints. The runtime auto-sequencer (F3,
`src/core/difficultySequencer.ts`) enforces the rules when composing generated
(`curve` / `dynamic`) waves; the same rule functions are reused by a pure audit
validator (F5) and by the classification-driven opening curation (F4,
`src/waves/sequencedLevels.ts`). Hand-authored `fixed` waves are never
sequenced and are exempt from the rules by design.

#### 1.5.1 Rule definitions

- **R1 — opening-wave purity.** Opening waves (the `dynamic` onboarding slots,
  see `OPENING_WAVE_POSITIONS`) may contain only archetypes whose
  `movementClass` is in `OPENING_MOVEMENT_CLASSES` — formation or diver
  movement; chasers, patrollers and roamers are excluded. `attackClass` is
  deliberately unconstrained for R1: onboarding waves are no-fire and their
  openers are ranged-class.
- **R2 — no all-chaser wave.** A wave may not be composed entirely of
  archetypes with `movementClass === CHASER_MOVEMENT_CLASS`. At least one
  non-chaser group must be present.
- **R3 — bounded ranged mix.** A *firing* wave may not be composed entirely of
  ranged attackers (`attackClass` in `RANGED_ATTACK_CLASSES`); the share of
  ranged groups must stay strictly below `RANGED_SHARE_CAP`, so every firing
  wave includes at least one effective-*contact* group.

#### 1.5.2 Effective-attack semantics (R3)

R3 judges a wave's **effective** attack, not its raw `attackClass` values. When
a wave's shooting is disabled (`shootEnabled === false`), every group counts as
effective contact and R3 is satisfied by construction. This resolves the R1↔R3
tension: the R1-permitted openers are all ranged-class, yet the no-fire opening
waves are compliant. The generator consequently never forces a contact group
into a no-fire wave.

#### 1.5.3 Named tunable constants

All rule constants live in `src/core/waveBalance.ts` — the module is the single
source of truth, so this section references the constants by name rather than
restating their values.

| Constant | Role | How to tune |
|---|---|---|
| `OPENING_WAVE_POSITIONS` | The `(level, wave)` slots R1 treats as opening waves. | Add or move entries to change which waves are openings; `isOpeningWavePosition()` generalises the lookup. |
| `OPENING_MOVEMENT_CLASSES` | Movement classes an opening wave may contain (R1). | Widen or narrow to admit or exclude behaviours in the opening. |
| `CHASER_MOVEMENT_CLASS` | The movement class R2 forbids from filling a whole wave. | Change only if the "no all-chaser" rule should target a different behaviour. |
| `RANGED_ATTACK_CLASSES` | Attack classes counted as ranged (R3). | Add or remove classes to redefine which attackers count toward the mix. |
| `RANGED_SHARE_CAP` | The maximum ranged share of a firing wave (strict `<`), R3. | Lower it to force more contact groups (a tighter mix); raising it relaxes the rule. |
| `DEFAULT_MOVEMENT_CLASS` | Fallback `movementClass` for unknown archetype keys. | Change to alter the classification fixture's fallback, not the rules. |
| `deriveAttackClassFromShotPattern()` | Derives the fallback `attackClass` from a shot pattern (no-fire ⇒ contact). | Change to alter the fixture's attack-class fallback. |

#### 1.5.4 Generator enforcement (F3)

The sequencer evaluates R2 and R3 **after** greedy composition, because its
scorer has no intrinsic notion of the classification constraints. On a
violation it repairs the wave in place: it adds — or, when the wave is at its
group limit, swaps in — a compliant candidate tuned to the remaining target
gap, preferring candidates not yet at the per-level archetype cap. When no
compliant candidate exists, the wave is returned unchanged so it is never
empty.

**Rules win over exact target match.** A repair may grow the wave's difficulty
error; the sequencer returns the best error-minimising compliant composition
available within the constrained candidate space rather than an exact but
invalid one. R1 is position-dependent (the pure sequencer cannot know which
wave is an opening), so the campaign builder passes the R1-allowed movement
classes through `SequencerOptions` / `SequencerRuleConstraints`; the sequencer
consults the shared `OPENING_MOVEMENT_CLASSES` rather than re-implementing the
rule.

#### 1.5.5 Opening curation (F4)

`src/waves/sequencedLevels.ts` derives the opening-wave candidate pool from R1
(via `OPENING_MOVEMENT_CLASSES` and `classifyArchetype`) and then narrows it to
a curated sub-selection kept as data, because the opening target band is narrow
and a full R1 pool would make openers degenerate. The curated band may narrow
the R1 pool but never widen it.

#### 1.5.6 Audit validator (F5)

`auditWaves()` / `auditWave()` reuse the exact same rule functions to audit a
list of waves, returning a per-wave, per-rule verdict plus a human-readable
message. `fixed` waves are reported as exempt (no rules evaluated). A campaign
audit test (`src/waves/campaignBalanceAudit.test.ts`) runs the shipped campaign
built from `defaultDifficultyCurves()` through the validator and pins the
per-wave target-difficulty error, so any rule, curve or pool change that moves
the enforcement cost fails the test and forces a documentation update.

#### 1.5.7 Enforcement cost on the shipped campaign

Enforcement is free on most waves: for 13 of the 15 generated waves of the
shipped campaign the rule-constrained composition matches the raw greedy
composition exactly. The two late-campaign waves whose raw composition is
all-ranged are repaired with a tuned contact group that lands *closer* to the
target than the invalid composition, so enforcement reduced their error rather
than growing it. The largest remaining per-wave error stays within the
sequencer's default tolerance. The measured vector is pinned in
`campaignBalanceAudit.test.ts`.

#### 1.5.8 Design principles

- **Single source of truth.** Generator enforcement, opening curation and the
  audit validator all consume `src/core/waveBalance.ts`; no rule logic is
  duplicated.
- **Gym↔game parity.** The rules live in the shared core consumed by both the
  game's campaign builder and the `GymCurveSequencer` preview, so parity holds
  by construction.
- **Fixed waves exempt.** Authored `fixed` waves are never sequenced, altered
  or rejected.
- **No Phaser dependency.** The module runs under Vitest as pure functions; the
  classification fixture resolves through `classifyArchetype` (with the
  documented defaults for unknown keys).

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
  `_spawnPlayerExplosion`, `_clearEnemyBullets`, `_updateAutoDefence`,
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

  **Shared Shield/Phase Shift hit-gating (**AH-0MUHM66ES0027QQV**).** The shield/phase
  hit-gating hooks are part of the shared core and are **not** per-scene
  overrides: `CombatScene` provides the registry-backed defaults
  `isPlayerPhased()` → `getEffectsRegistry().isPhased` and
  `tryAbsorbPlayerHit()` → `getEffectsRegistry().tryAbsorbShield()` (consume
  **one** shield, run the `onShieldAbsorbed()` cue seam, start the shared
  post-hit invulnerability window, return `true`). `CombatCoreScene` keeps
  its safe non-combat `false` defaults for threat-free direct subclasses
  (`GymWeapons`, `GymPowerUpsUtility`). Every `CombatScene` subclass
  inherits the gating exactly once — `PlayScene`, `GymPowerUpsCombat`, and
  `GymFormationScene` (`GymFodderEnemies`/`GymBoss`/`GymMinerals`) — so collecting
  Shield or Phase Shift behaves identically in the shipped game and
  the enemy gym. **No scene should re-implement these hooks**; a scene may
  add a per-type cue only through the `onShieldAbsorbed()` seam. The Shield
  shield-bubble and phase-ghost player visuals live once in
  `src/scenes/core/CombatEffectVisuals.ts` and are used by all three scenes
  (see §7.2).

  **Hold-full rewards in the mineral gym (**AH-0MUHMXWGC0058BO4**).**
  `GymMinerals` has no field power-up drops, so its rewards come from the
  hold-full choice overlay. Because the choice can grant Teleport, the shared
  automatic-defence feed (`_updateAutoDefence()`) runs every tick —
  independent of `powerUpsEnabled` — so a stored Teleport use is spent
  automatically when the ship is in danger; `canTeleport()` accepts a stored
  use in addition to the opt-in drop layer. The effects registry ticks (and the
  HUD refreshes) every frame in all formation gyms, so a Phase Shift granted on
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
  result to a bullet array. `PlayScene`, `GymFodderEnemies` and
  `GymPowerUpsCombat` all route through it, so a new archetype is wired by
  one table entry and every scene fires it with the same cadence. The helper
  takes the scene clock as an explicit `now` argument — never a frame-count
  accumulator — so the combat gym's fire timing matches the game's. The
  single definition is pinned by
  `src/scenes/core/CombatScene.equivalence.test.ts` and the
  dispatch/fallback behaviour by `src/entities/enemyFire.test.ts`.
- **Shared boss integration** (AH-0MUII3E5E006A93F, gap 6) — the boss
  advance (`_advanceBoss(dt)`) and the teleport boss-avoidance
  (`getAdditionalTeleportBodies()`) live once in `CombatScene` and are
  driven by each scene's own `tick(dt)`, so a single deterministic tick
  advances the boss with the same ordering relative to collisions in the
  shipped game and in `GymBoss`. A scene exposes its boss through the
  `getBoss()` accessor (`GymBoss` returns its single formation entity); the
  boss is also added to the teleport-avoidance body list. Phase minions are
  summoned from the shared `planMinionSpawns(phase)`
  (`src/waves/BossMinions.ts`) — the same plan the game uses — and advanced
  and fired on the shared tick through the overridable `onBossAdvanced(dt)`
  hook. The single definition is pinned by
  `src/scenes/core/CombatScene.equivalence.test.ts` and `GymBoss.test.ts`.

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
  (`GymFodderEnemies` for every `enemyKey`) inherits it with no per-scene code.
- **Shared restart/teardown lifecycle** (AH-0MUII3FYN0072QRT, gap 10) — the
  per-run reset/teardown lives once in `CombatCoreScene.resetRunState()` /
  `teardownRunState()`. `create()` calls `resetRunState()`, which clears the
  active `EffectsRegistry` through the polymorphic `getEffectsRegistry()`
  accessor — so a gym that owns its own registry (every gym) is cleared by
  the same code as the shipped game — plus the shared bullet/effect/animation
  registries; `SHUTDOWN` calls `teardownRunState()`, which destroys those
  registries and resets the effects registry. `CombatScene` overrides both to
  add invulnerability, hit-count, teleport-arrival and bullet-impact state;
  `GymFormationScene`, `GymWeapons`, `GymPowerUpsCombat`,
  `GymPowerUpsUtility` and `GymPlayer` override them to add their own object
  families (enemies, drops, minerals, player, obstacles, HUD) and call
  `super` first. `GymPlayer` (now based on the shared `CombatScene`,
  AH-0MUAYB2XR007N10W) resets its ship, deterministic obstacle course and
  input bindings through the same pair. A stop/restart of any instance
  therefore starts with a clean registry
  and no leaked display objects, and the behaviour is pinned by the
  restart/teardown parity tests in `GymFormationScene.test.ts` and each gym's
  test file.

The generic geometry (formation offsets) lives in
`src/utils/formations.ts`:
`FormationOffset`, `buildVFormationOffsets`, `buildDiverFormationOffsets`,
`buildRectFormationOffsets`. These are pure functions — unit-test them
directly without booting a scene.

The `single` formation is **count-independent**: `buildSingleOffset` always
returns one centred offset because a `single` group represents exactly
**one** entity (the Boss), so its declared `count` must be `1`. Wave
accounting derives the number of enemies a group spawns from its builder via
`formationSpawnCount` — not the raw `count` field — so a wave's declared size
(`WaveManager.waveEnemyCount()`) always equals its planned spawns
(`planSpawns().length`). `validateWaveGroups` reports any `single` group whose
`count !== 1` (see §8.3).

**Formation & shot registries** (see §2.4): formation kinds map to builder
functions (`FORMATION_BUILDERS` / `getFormationBuilder(kind)` with a safe
`buildVFormationOffsets` fallback for unknown kinds), and shot patterns are
validated by `src/utils/enemyShotPatterns.ts` (`VALID ShotPattern` set,
`sanitizeShotPattern` → `'none'`). Together they keep `EnemyConfig` small
and `GymFodderEnemies` free of per-type branches.

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
  false` (single-hit enemies via `destroySelf()`; multi-hit enemies only after
  their last hit point is spent). Explosion VFX still playing
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
  countdown. The shared seam is `GymFormationScene.respawnFormation()`
  (protected); a subclass's manual respawn (e.g. `GymFodderEnemies._onRespawn`)
  syncs its live config then calls it (and clears player bullets itself when
  it wants a clean slate) rather than re-implementing the rebuild.
- **Scope:** core-library owned in `GymFormationScene`; inherited by
  every formation gym (including `GymFodderEnemies` for every `enemyKey`).
  `GymBoss` (multi-phase) is out of scope.
- **Tear-down:** `SHUTDOWN` cancels the countdown and hides the overlay
  so a scene restart never double-fires or leaks.

### 2.6 Wave-timeout carry-over in the enemy gyms (AH-0MUNS3ZQ1002DJ9S, AH-0MUNR5LM1004B223, AH-0MUK5ONAA0007YEX)

The shipped game's wave time-limit is mirrored by the enemy gyms as a
single shared implementation so the two cannot diverge. On timeout the
survivors are **kept** and carry over — there is no detonation and no
life/formation wipe (carry-over semantics, AH-0MUNS3ZQ1002DJ9S):

- **Shared state machine.** The timer, the depleting bar and the
  wipe→3 s countdown→respawn lifecycle live once in the shared
  `CombatScene` core (`startWaveTimeout` / `_advanceWaveTimeout` /
  `_onWaveTimeout` / `_drawWaveTimeoutBar` and the shared respawn countdown),
  so every combat gym opts in through the same hooks — a single kind of
  scene. `GymFormationScene` (and every `GymFodderEnemies` / `GymBoss` /
  `GymMinerals` subclass) and `GymPowerUpsCombat` all consume it.
- **Shared helper is a no-op.** `detonateWaveTimeoutSurvivors` in
  `src/scenes/core/waveTimeout.ts` is retained as a stable API but returns 0
  and destroys nothing; `WAVE_TIME_LIMIT_SECONDS` and the bar-geometry
  constants live there too. `PlayScene._timeoutWave` and the shared
  `CombatScene._onWaveTimeout` both call it, so the game and the gyms cannot
  diverge on the (now absent) penalty.
- **Opt-in.** `GymFormationScene` subclasses enable it through
  `EnemyFormationConfig.timeoutDuration` (seconds); `GymPowerUpsCombat` opts in
  by overriding `getWaveTimeoutDuration()`. `GymFodderEnemies` sets it to
  `WAVE_TIME_LIMIT_SECONDS` for every non-boss `enemyKey`, `GymMinerals`
  enables it for its asteroids-only field, and `GymPowerUpsCombat` enables it
  for its scout wave. The boss (`GymFodderEnemies` with the `boss` config) and
  `GymBoss` leave it unset, as do the enemy-free `GymPlayer`, `GymWeapons`
  and `GymPowerUpsUtility`.
- **Expiry flow.** On expiry survivors persist, the bar hides, and the shared
  3 s wipe→respawn countdown starts. At the countdown's end a **fresh
  formation spawns alongside the survivors** (`GymFormationScene`'s
  `respawnWithCarriedSurvivors`, or `GymPowerUpsCombat.respawnWave`), so both
  the survivors and the fresh formation must be cleared before the wipe is
  complete. A full wipe with no survivors falls back to a clean-slate
  `respawnFormation`/base reset. The timeout pauses while a countdown is
  active and restarts on every respawn.
- **The game keeps survivors physically continuous (AH-0MV9FUG4J008OHKA).**
  In `PlayScene`, `spawnWave()` was resetting the shared formation state on
  every wave boundary, so carried-over survivors snapped back to their spawn
  origins the moment the next wave spawned. It now preserves the continuing
  base whenever a formation survivor carries over: the drift position,
  direction and Diver anchors stay put, and a carried march block keeps its
  march state (fresh march spawns join the continuing block as one rigid
  body, mirroring `respawnWithCarriedSurvivors`). The fresh wave's enemies
  join the continuing base. A clean start with no survivors resets exactly
  as before.
- **UI.** A depleting top-of-screen bar mirrors `PlayScene._drawWaveTimer()`
  and shares its geometry constants and drawing code.
- **Parity guard.** `CombatScene.equivalence.test.ts` asserts the shared
  wave-timeout / countdown methods are defined exactly once (in the shared
  core) and that both gym bases resolve them to the same function objects, so
  a divergent copy cannot be re-introduced.
- **Tests.** `src/scenes/core/waveTimeout.test.ts` covers the no-op helper;
  `GymFormationScene.test.ts` covers the opt-in/expiry/carry-over-respawn
  behaviour (survivors + fresh formation must both be cleared),
  `GymFodderEnemies.test.ts` asserts every non-boss key enables it while the boss
  does not, and `GymMinerals.test.ts` / `GymPowerUpsCombat.test.ts` cover the
  newly-enabled gyms.

### 2.7 Wormhole spawn animation (AH-0MURBER4L00821RR)

When a wave (or formation gym) spawns enemies, each enemy enters through a
wormhole and grows from **1 pixel to its full size** instead of appearing
fully formed. The same code runs in `PlayScene` and every formation gym, per
the gym-parity convention (§5.1).

**Timeline** (scene-tick seconds, not wall-clock — so deterministic
`scene.tick(dt)` tests drive it identically to a live run):

| Phase | Duration | Behaviour |
|-------|----------|-----------|
| Wormhole opens | 1 s | The wormhole VFX scales from 0.01 to full at the spawn position. |
| Enemy grows | 1.5 s | Each enemy eases from 0.01 scale to its full scale (ease-out cubic). |
| Wormhole closes | 0.5 s | The wormhole scales to zero and fades out. |

Total spawn-protection window = **3 s**. During that window the spawning
enemy is protected (AC4):

- **Player bullets pass through** — `CombatScene.onPlayerBulletHitsEnemy`
  returns `false` for a spawning enemy, so the bullet is not consumed and no
  damage is applied.
- **No body collision** — the player-body-vs-enemy pass in
  `CombatScene._handleCollisions` skips spawning enemies.
- **No shooting** — `fireForEnemy` returns `[]` for a spawning enemy, so
  firing is suppressed regardless of `shootEnabled`.
- **No mineral absorption** — the enemy-absorption loop in
  `collectMinerals` (`src/scenes/core/mineralLayer.ts`) skips spawning
  enemies.

**Implementation.**

- `src/vfx/wormholeSpawn.ts` owns the wormhole VFX (`spawnWormholeOpen` /
  `spawnWormholeClose`), the dt-driven growth helpers
  (`startSpawnAnimation`, `updateSpawnAnimation`, `isEnemySpawning`) and the
  `WormholeController` shared lifecycle. The spawn state is stored as entity
  data, so any `Container`-based entity works.
- `BaseEnemy` exposes `isSpawning` / `setSpawning()` — the single flag every
  shared collision/fire/absorption gate reads.
- `PlayScene._spawnEnemy` starts the animation; `PlayScene._updateSpawnAnimations`
  advances it before collisions so an enemy that finishes growing this frame
  is collidable on the same frame; the wormhole closes once every wave enemy
  has finished.
- `GymFormationScene` starts the animation for each formation entity through
  the shared `_spawnFormation()` helper (used by `create()` and the
  wipe→respawn / carry-over respawn paths) and `_updateSpawnAnimations`
  advances/closes it, so `GymFodderEnemies` and the other formation gyms are
  in lock-step with the game — a respawned formation enters through a fresh
  wormhole exactly as the game's next wave does.
- Both scenes expose a `finishSpawnAnimations()` test seam that completes the
  animation without advancing wave timers/asteroid spawns, so collision tests
  can observe fully-spawned enemies deterministically.

**Single-live lifecycle (AH-0MV9KHLV8006GMX6).** At most **one** wormhole is
live at a time. Both scenes owns a `WormholeController` (`vfx/wormholeSpawn.ts`):
`open(x, y)` first closes any still-open wormhole (so a second `spawnWave()` /
formation respawn never strands the previous one), and `close()` is idempotent.
The close is driven everywhere a live wormhole could otherwise be left behind:

- `_updateSpawnAnimations`/`finishSpawnAnimations` close once every entity has
  finished growing (scale→0, alpha→0, registry removal, destroy).
- `PlayScene._startTransition` closes any wormhole still open when a
  wave/level/boss transition begins — the normal close tick is gated behind
  the non-transition branch, so a mid-spawn timeout/carry-over no longer
  leaves the wormhole frozen on screen.
- `resetRunState` closes on run reset/restart.
- Gym formation respawns re-open a wormhole through the controller (which
  closes any previous first), keeping the gym matched to the game.

**Portal placement (AH-0MV8BR9Y70079TKC).** The wave wormhole is opened at
an **independent position well away from the player** — never at the first
enemy's formation slot — and every formation enemy is anchored **relative to
the portal** rather than to the screen. The shared rule lives once in
`src/vfx/wormholeSpawn.ts` (gym↔game parity, §5.1):

- `placeWavePortal()` is a pure function of (formation geometry, playfield
  bounds, player state) with an injected RNG (used only for exact-distance
  ties — deterministic replays stay deterministic). With **no player** (the
  formation gyms have no in-game ship) it returns the formation base
  unchanged, so gym behaviour is unchanged.
- **`D_MIN` = the largest of the formation's height or width**, derived from
  the planned wave's bounding box (`formationExtents(spawns)`) — the single
  source, never hard-coded per call site. The portal keeps `D_MIN` Euclidean
  distance from the player's live position **and** from its position
  projected `WAVE_PORTAL_TRAJECTORY_HORIZON_SECONDS` (2 s ≈ the
  open+growth window) along its current velocity vector (AC1/AC2).
- When the planned anchor already satisfies `D_MIN` it is kept untouched —
  the formation stays exactly where the wave designer placed it. Otherwise
  the nearest conforming candidate is chosen, so the formation displaces as
  little as possible. When **no** in-bounds candidate meets `D_MIN`, the
  furthest-available candidate is used and the position is still **never
  placed inside the player's hull radius + a safety margin** (AC4).
- `PlayScene.spawnWave()` derives the extents, calls `placeWavePortal()`
  with the player's live movement state, then translates every planned spawn
  onto the portal with `anchorSpawnsToPortal()` (portal-relative offsets —
  spacing, counts, offsets and wave pacing unchanged; a moved portal moves the
  whole formation with it). The gyms call the same `placeWavePortal()`
  without a player and lay the formation out from the returned base.
- `GymFormationScene._spawnFormation()` routes its entity placement through
  `computeFormationPosition(portal, …)` so both scenes share one code path;
  with the portal pinned to the formation base this is byte-for-byte the old
  arithmetic.

**Tests.** `src/vfx/wormholeSpawn.test.ts` covers the VFX tween parameters,
  the dt-driven growth curve, the `WormholeController` single-live
  lifecycle, and the placement/anchoring helpers (`placeWavePortal`:
  far-anchor fast path, near-player rejection, trajectory projection,
  no-safe-candidate fallback, hull safety, gym no-player path;
  `anchorSpawnsToPortal`: portal-relative translation preserving spacing);
  `PlayScene.test.ts` (describe “wormhole spawn animation” and “wave portal
  placed away from the player”) and
  `GymFodderEnemies.test.ts` (describe “wormhole spawn animation parity”)
  cover the spawn-protection gates in both scenes plus the regression cases
  (second `spawnWave()` while a wormhole is live, transition/timeout
  mid-spawn, a gym wipe→respawn re-opening one wormhole, and the portal
  staying ≥ `D_MIN` away from the player and its trajectory).

### 3.2 Existing scenes (reference implementations)

| Scene | Entity | Formation | Fire pattern | Audio |
|-------|--------|-----------|--------------|-------+-------|
| `GymScout` | `Scout` | V (offset columns +2/row) | aimed shot (single) | advance cue (≥ 500 ms) + fire sound scheduled at cue end (entity-level, per aimed shot, no gap between cue and fire sound) |
| `GymDiver` | `Diver` | diamond/chevron | spread burst (array) | `playDiverFireSound()` once per spread burst (entity-level, no advance cue); dive-phase sounds — `playDiverDiveStartSound()` once at the FORMATION→DIVING transition plus a refcounted shared sustained dive voice (`playDiveSound()`/`stopDiveSound()`, ~2 s, stopped at the end of the dive / destroy); distinct `playDiverDestructionSound()` via the optional `playDestructionAudio?()` seam (once per destruction) |
| `GymTank` | `Tank` | 3-column rectangle | radial burst (array) | mechanical-whine advance cue (≥ 500 ms) + cannon thump (entity-level, one cue+thump pair per burst inside `tryFireRadialBurst()`, no gap between cue and thump) |
| `GymSwarm` | `Swarm` | loose 3–5 clusters (`buildSwarmClusterOffsets`) | coordinated burst (single per member) | volley burst sound (`playSwarmBurstSound()`, entity-level, once per volley, no advance cue) |
| `GymBoss` | `Boss` | single entity (centred) | spread / spiral / pulse / desperation (phase-gated) | per-phase telegraph cue (`playBossPhaseCue()`) at telegraph start + `playBossFireSound()` once per volley (entity-level) |

`GymBoss` also consumes the shared boss hooks (§2.1): its `tick(dt)`
advances the Boss through `CombatScene._advanceBoss`, teleports avoid the
boss via the shared `getAdditionalTeleportBodies()`, and its phase minions
are summoned from the shared `planMinionSpawns()` plan and advanced on the
same tick path through `onBossAdvanced()` — so the gym Boss runs the same
code as the shipped game's Boss (AH-0MUII3E5E006A93F).

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

### 5.1 Gym parity

A gym may enable only a **constrained set of features** (one enemy type, the
editor, fixed formations, no campaign/wave progression), but the code that
runs an enabled object must be the **same code** as the shipped game. The
only legitimate difference is a disabled feature — never a divergent copy.
Every shared behaviour therefore lives once: the core template methods and
hooks (§2.1), the pure helpers under `src/scenes/core/`
(`bulletLifecycle`, `dropLayer`, `mineralLayer`, `mineralKillDrops`,
`asteroidKillDrops`, `asteroidSplit`, `enemyTargeting`), the shared dispatcher
`src/entities/enemyFire.ts`, the scheme→input helper
`mapControlInput` in `src/utils/movementModel.ts`, and the spawn-range
helpers `resolveSpawnRange` / `pickInRange` in `src/core/configTypes.ts`
(consumed identically by `planGroupSpawns` in the game and
`GymFormationScene` in the gyms). The repo-wide
duplicate-body guard in `src/scenes/core/CombatScene.equivalence.test.ts`
(`EPIC_SHARED_HELPERS` / `EPIC_SHARED_METHODS`) fails the suite if a
production scene re-introduces a copy, and the cross-scene equivalence
tests boot `PlayScene` and each gym to prove identical outcomes under the
same input and `dt`. See
[AGENTS.md § Game Architecture Conventions](../AGENTS.md#game-architecture-conventions)
for the governing principle (tracked by AH-0MUGZDTFX004RBD1).

The classic-arcade power-up and weapon roster
([`CLASSIC_POWERUP_WEAPON_RESEARCH.md`](CLASSIC_POWERUP_WEAPON_RESEARCH.md),
epic AH-0MV14SO0G0095IJ4) follows the same rule: every behaviour it adds runs
in shared code — the shared piercing-collision, bullet-bounce and
missile-split seams (`src/scenes/core/CombatCoreScene.ts`), the pure
`src/scenes/core/optionsEscort.ts` orbit geometry, the screen-wide
`AoEDescriptor` (`screenPulse`) pulse, and the shared `_reflectEnemyBullet`
Force Field seam — so the game and every gym (`GymWeapons`,
`GymPowerUpsCombat`, `GymPowerUpsUtility`) run identical arsenal behaviour.

**Projectile identity & per-shot feel are shared (per-enemy visuals epic,
AH-0MV2K5SR0005RTTE).** Every weapon/attack's in-flight look, fire-time
launch pop and impact feedback is resolved from the shared bullet-shape
seams consumers run in both the game and every gym: the per-weapon bullet
looks from the weapon catalogue → `resolvePlayerBulletVisual` (consumed by
`PlayerBullet._draw` and the shared combat-core spawn path), the per-enemy
identities from `ENEMY_BULLET_VISUALS` → `resolveEnemyBulletVisual`
(consumed by `bulletUtils.createBullet` inside each shared entity's own fire
method), the enemy launch pop from `src/vfx/enemyMuzzleFlash.ts`, and the
impact flash/cue from the shared `CombatScene` interception + hit passes.
The repo duplicate-body guard and the gym↔game equivalence suite therefore
cover the new visuals exactly as they do behaviours: a weapon or enemy
renders the same code-drawn silhouette, muzzle flash and hit feedback in
`PlayScene` and in `GymWeapons` / `GymFodderEnemies` / `GymBoss` / the
classic-arcade gyms — a disabled feature is the only permitted divergence.
See "Projectile identity & per-shot feel" in this document for the full
per-attack roster.

**Documented divergence — the Player gym's obstacle course.** `GymPlayer`
spawns a deterministic set of indestructible obstacles
(`src/entities/Obstacle.ts`) that the shipped `PlayScene` does not yet have.
This is a gym-only training feature, so there is no game counterpart to
enable; the reason is recorded here and in the `GymPlayer` scene header. The
entity itself is shared and reusable, and the input, auto-fire and collision
handling all run through the shared core (`_tickPlayer`, `_autoFire`,
`_handleCollisions`) — the gym overrides only the two destruction hooks
(`onPlayerBulletHitsEnemy` absorbs the bullet; `onPlayerRamsEnemy` leaves the
obstacle alive), so no collision loop is copied (AH-0MUAYB2XR007N10W).

**Documented divergence — the weapon gym's AOE practice targets.**
`GymWeapons` spawns three inert, static `TrainingTarget`s that the shipped
`PlayScene` has no counterpart for. They exist solely so the inherited AOE
dispatch/VFX (`CombatScene.onAoeFired` → `applyAoeEffect` / `applyArcChainEffect`)
can visibly demonstrate the Nova ring, Mortar blast and Arc chain in a
theatre that otherwise has no enemies; they never move and never fire, so the
gym stays threat-free. The AOE resolution itself is **not** duplicated — the
gym exposes the targets through the shared `getEnemyEntities()` participant
contract and inherits every AOE hook from the shared core, so the game and the
gym resolve the same effect from one implementation (parent
AH-0MQUYHY0000MZ2F, F6 AC3/AC5).
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
  copies were removed in AH-0MUDCT7EU0061OSZ); `GymPlayer` (the
  thruster-navigation training scene, re-based onto the shared `CombatScene`)
  now inherits the same routing too, and adds a deterministic, indestructible
  obstacle course consumed through the shared collision pass
  (AH-0MUAYB2XR007N10W).
  > **Data-driven successor:** the per-scene wiring described in this §7
  > is complemented by the Enemy Config pipeline (AH-0MTFP7EIC004F1MN,
  > CSV AH-0MTZWZ9TE009CVUA): enemy tuning also lives in
  > `src/data/enemy-configs.csv` (`EnemyConfig`) and is exercised through
  > the single `GymFodderEnemies` scene (see §1.2 / §8). The per-scene `player`
  > seam itself is unchanged — `GymFodderEnemies` reuses it.
- **Auto-fire:** while the SHOOT toggle is on, the ship auto-fires
  `PlayerBullet`s toward its current heading.

### 7.2 Collisions & respawn

Resolved in the shared `CombatScene._handleCollisions` (inherited by
`GymFormationScene`; the same path `PlayScene` uses) each tick:

1. Player bullets → enemies (hit radius 20): the entity takes one hit
   (`takeDamage()` for multi-hit entities, otherwise `destroySelf()`); on the
   killing blow `alive=false` + explosion SFX + `onEnemyDestroyed` run exactly
   once, and the bullet is consumed either way.
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

**Power-up hit-gating (Shield / Phase Shift).** The Shield/Phase Shift gating is
inherited from the shared `CombatScene`, not re-implemented in the gym:

- **Phase Shift** — `CombatScene.isPlayerPhased()` returns
  `getEffectsRegistry().isPhased`; while active, `_handleCollisions()` skips
  both the enemy-bullet-vs-player and player-body-vs-enemy passes, so the
  ship passes through bullets and bodies for the **1.5 s** effect window (no
  `getPlayerHitCount()` increment, no respawn). Since the automatic Phase
  Shift change (parent AH-0MUIYX1EE008FVS8) the phase is triggered by the
  shared per-frame danger feed (`CombatScene._updateAutoDefence`,
  called in `PlayScene`, `GymFormationScene` and `GymPowerUpsCombat`
  immediately before `_handleCollisions`): when **3 or more** hostile
  bodies/bullets are within **40 px** (`2 × SHIP_SIZE`) of the ship and a
  stored charge (or the permanent hold-full reward) is available, the phase
  activates automatically; after expiry it re-arms only once danger has
  dropped below the threshold and a **~0.5 s** cooldown has elapsed. While
  phased the shared mineral layer (`collectMinerals({ playerPhased: true })`)
  also blocks **mineral collection**; power-up/weapon drops stay collectable
  and mineral pickup resumes the instant the phase expires. **Exception —
  between waves/levels:** during the wave/level transition pause `PlayScene`
  runs the shared scoop + collection passes and calls
  `collectMinerals({ playerPhased: false })`, so a phase active at wave-clear
  still collects minerals; the Q7 gate is unchanged during normal wave play
  (AH-0MUX96GJF006CAZP).
- **Shield** — `CombatScene.tryAbsorbPlayerHit()` consumes exactly one
  shield (`tryAbsorbShield()`), runs the `onShieldAbsorbed()` cue seam (the
  play scene plays `playDestructionSound()`; the gym stays silent), starts
  the shared post-hit invulnerability window and reports the hit absorbed,
  so an absorbed hit costs no life; the following hit lands normally.
- **Visuals** — `GymFormationScene` draws the same shield bubble
  (colour `0x3399ff`, line width 2, radius `SHIP_SIZE * 1.6`, fill alpha
  `0.12`) and Phase Shift ghost (alpha `0.45`, blink-aware) as `PlayScene` and
  `GymPowerUpsCombat`, through the shared `CombatEffectVisuals` helper. Test
  seams: `isShieldBubbleVisible()`, `isPhaseGhostActive()`.

`GymFormationScene`-based scenes therefore record **and** apply Shield/Phase Shift
identically to the other combat scenes — a regression is guarded by the
enemy-gym phase/shield tests and the cross-scene equivalence tests. The
mineral gate is unit-tested in `src/scenes/core/mineralLayer.test.ts` and
exercised in the gym by `GymMinerals.test.ts`.

### 7.3 Live aim tracking

Every player-bearing enemy base scene — `PlayScene`, `GymFormationScene` and
the Level Gym (`GymLevel`, and therefore the Bot Tuning gym built on it) —
pushes the player's live position into every alive enemy each frame through
the single shared helper `pushAimTargets` in
`src/scenes/core/enemyTargeting.ts` (an optional seam, forward-compatible
with entities that have no target concept). The push runs **before** that
frame's bullets are collected in all three scenes — `PlayScene._collectEnemyFire`,
`GymFormationScene`'s entity loop and `GymLevel.tick` (immediately before
`fireLiveEnemies`) — so that frame's shots use the current position and the
ordering can never drift between game and gyms (AH-0MV4XFQ0J0082BN6). The
same file's `pushSeekTargets` forwards each scene's **live mineral field** to
roaming seekers (Harvester) in the same passes; `GymLevel._moveEnemies`
passes its live field, not the empty array it previously sent, so Harvesters
seek minerals exactly as they do in the game:

- **Scout / Swarm** — retarget `target`/burst aim continuously; bullets arc
  toward the player's live position at fire time.
- **Phaser** — rotates its 8-spoke radial pattern so one spoke points at the
  live player; telegraph rules (two-phase tell ≥ 600 ms advance cue, then
  the volley) are unchanged.
- **Diver** — **snapshots the target at dive start** (recorded seam
  decision): a mid-dive aim change does not alter the in-flight dive arc.
  The dive is a **diagonal parabolic arc** — both x and y follow the
  quadratic bezier from the formation slot to the snapshotted player
  position (`computeDivePoint`; AH-0MTGBOKLC006N8UX); there is no x-lock.
  When the attack ends (`DIVING`/`PAUSING`) the Diver group re-anchors to the
  attack-end location (non-Divers do not move) — see §7.6.
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

The Boss gym (`GymBoss`) follows this convention: it spawns the player via
the same `player` config seam, reuses the live-combat collision/respawn
machinery, and routes the Boss itself through the shared boss hooks
(`CombatScene._advanceBoss` / `getAdditionalTeleportBodies`, §2.1). Its
phase minions are summoned from the shared `planMinionSpawns()` plan and
advanced on the shared `tick(dt)` path via `onBossAdvanced()`, so the gym
Boss and the shipped game's Boss run the same code
(AH-0MUII3E5E006A93F, gap 6).

### 7.6 Attack-end re-anchor when a Diver finishes its attack (AH-0MUAYB957002EMYV, AH-0MUL15N63003PUDB)

A Diver leaves the formation for the whole `DIVING → PAUSING` attack window.
There is **no return glide**: when the pause ends the Diver re-enters
`FORMATION` and latches a re-anchor request at its attack-end position (the
player position snapshotted at dive start). The owning scene consumes the
request through the optional `consumeFormationReanchor?()` seam (on
`FormationSceneEntity` and the shared `EnemyEntity` type alongside
`DestructionAudioSeam`):

- `Diver.consumeFormationReanchor()` returns and clears the latched
  `FormationReanchorRequest` (`{ offset, x, y }`); a destroyed Diver never
  returns a request.
- Both independent drift implementations apply the same shared rule,
  `computeFormationReanchorDelta(request, originX, originY, spacingX,
  spacingY)`, which returns the translation that makes the requester's slot
  (`origin + offset * spacing`) coincide with its attack end.
- **Only the Diver group moves.** The `(dx, dy)` translation is applied to a
  **Diver-only offset**, not to the shared formation base, so non-Diver
  enemies keep their own positions (producer review: *"Only the divers should
  move"* / *"they should stay where they are"*):
  - `GymFormationScene.tick()` adds `diverAnchorX`/`Y` to
    `formationBaseX`/`formationBaseY` for entities that expose the seam; the
    shared base — and therefore every non-Diver — is untouched. The
    `diverFormationX`/`Y` getters expose the Diver-group origin.
  - `PlayScene._moveEnemies()` adds a `diverAnchorX`/`Y` offset only to Diver
    spawns; every other spawn uses `startX + driftX` / `startY` alone.
- The re-anchor is applied after the drift and before the positioning pass,
  so the Divers use the new origin in the same frame. The drift itself is
  never frozen — no entity can hold the cluster (the interim formation-hold
  seam was removed).
- When Divers become desynchronised (destruction + later respawn) the most
  recent attack-end wins — a documented assumption, since the shared rule is
  a single translation and can satisfy only one requester's slot.
- Non-Diver entities have no re-anchor request and are not part of the Diver
  group, so a Diver's attack does not move them at all.

#### 7.6.1 Animated re-anchor glide (AH-0MUL15N63003PUDB)

The Diver-group origin re-base is a translation, so applying it directly made
the Divers **teleport** to their new slots in one frame. The transition is now
animated by the shared `FormationGlide` helper
(`src/scenes/core/formationGlide.ts`), consumed identically by
`GymFormationScene` and `PlayScene` (gym↔game parity):

- On the frame a re-anchor is applied, the scene calls `glide.begin(targets)`
  with every **re-anchor-capable** entity — the Divers that expose the
  `consumeFormationReanchor()` seam. Non-Diver formation members (Scouts,
  Tanks, Phasers, Swarms) are **not part of the Diver group and stay exactly
  where they are** — they are not tracked by the glide and receive no
  re-anchor delta (producer review: *"they should stay where they are"*).
  Roamers (asteroids, harvesters) are likewise excluded: their own motion must
  not be eased. `begin` captures each entity's current position as the glide's
  `from` point.
- After the normal `applyFormationPosition` positioning pass the scene calls
  `glide.update(dt)` exactly once. For each tracked entity the helper reads
  the **live** target already set by `applyFormationPosition` and renders
  `target + (from − target₀) × (1 − smoothstep(elapsed / FORMATION_GLIDE_SECONDS))`.
  Because the target is read live each frame, the glide tracks the drifting
  slot and lands on the **current** slot, not a stale re-anchor-time snapshot.
- `FORMATION_GLIDE_SECONDS` (`0.32 s`) is the single tunable duration,
  exported from the helper.
- When `elapsed ≥ FORMATION_GLIDE_SECONDS` the entity is left exactly on the
  live slot (residual `0`) and its glide state is dropped — the Diver group's
  relative offsets are preserved on completion.
- The attacking Diver is tracked (it is the re-anchor requester). Its
  re-based slot coincides with its attack end, so its residual is only the
  idle x-wiggle; it eases that out and keeps drifting with the Diver group.
  Passing Divers in a multi-Diver group are also tracked and glide to their
  shifted slots.
- `clear()` is called from each scene's `teardownRunState()` and from
  `GymFormationScene.respawnFormation()` so a stop/restart or a formation
  respawn starts with no active glide.

---

## 8. EnemyConfig reference & adding a new enemy

### 8.1 EnemyConfig shape (`src/core/enemyConfig.ts`)

| Field | Type | Purpose |
|-------|------|---------|
| `key` | `string` | Stable slug (lowercase/numbers/hyphens, ≤40 chars) and CSV row identity. Validated by `isValidEnemyKey` / `sanitizeEnemyKey`. |
| `displayName` | `string` | Human label shown in the index and `GymFodderEnemies` hint. |
| `formationKind` | `EnemyFormationKind` | `'v' \| 'diver' \| 'rect' \| 'swarm' \| 'orbital' \| 'single' \| 'march'` — selects the builder in `src/utils/formations.ts`. `march` is the Space Invaders stepping block (AH-0MV01EDZS0005R20) and additionally reads `marchStep`/`marchDrop`. |
| `marchStep` | `number?` | Horizontal step (px) for the `march` formation; neutral/absent otherwise. |
| `marchDrop` | `number?` | Vertical drop per arena-edge reversal (px) for the `march` formation; neutral/absent otherwise. |
| `count` | `number` | Formation size. Must be `1` for the `single` formation (one entity); `validateWaveGroups` reports violations. |
| `spacingX` / `spacingY` | `number` | Slot spacing (px). |
| `driftSpeed` | `number` | Rightward drift (px/s). |
| `startX` / `startY` | `number` | Legacy scalar base position (px); used verbatim when the range fields below are absent or degenerate. |
| `startXMin` / `startXMax` | `number?` | Optional spawn-band X (px). When a genuine range (`min !== max`), each wave group / gym formation draws a random base X within it; when absent or `min === max`, the scalar `startX` is used (backward compatible). |
| `startYMin` / `startYMax` | `number?` | Optional spawn-band Y (px); see `startXMin` / `startXMax`. |
| `size` | `number` | Body radius/half-size (px). |
| `health` | `number` | Hit points before destruction (positive integer, default **1**). Data-driven so multi-hit archetypes need no code branch; the Harvester (E7) is **5**. |
| `color` | `number` | Body colour `0xRRGGBB`. |
| `bulletColor` / `bulletSize` | `number` | Bullet colour / radius. |
| `shotPattern` | `EnemyShotPattern` | `'none' \| 'aimed' \| 'spread' \| 'radial' \| 'orbital' \| 'coordinated'` — validated in `src/utils/enemyShotPatterns.ts`. |
| `movementClass` | `EnemyMovementClass` | `'formation' \| 'diver' \| 'chaser' \| 'patroller' \| 'roamer'` — coarse behavioural movement class for wave-design/balance tooling (AH-0MV29NWI1007NKN7). Validated by `validateEnemyConfig`; an absent/invalid value falls back to `formation` (see §1.4). |
| `attackClass` | `EnemyAttackClass` | `'contact' \| 'projectile' \| 'beam' \| 'area'` — coarse behavioural attack class; `contact` is contact-only (every enemy still damages on contact). Validated by `validateEnemyConfig`; an absent/invalid value is derived from the effective `shotPattern` (`none` → `contact`, otherwise `projectile`). See §1.4. |
| `fireInterval` | `number` | ms between volleys. |
| `shotProbability` | `number` | Fraction `0.0`–`1.0` chance an individual enemy fires per shot cycle; rolled once at the fire decision point, a failed roll consumes the cycle (no bullet, no tell). Seed default `1.0` everywhere except the Swarm (`0.25`). |
| `bulletSpeed` | `number` | Bullet velocity (px/s). Enemy archetype values were halved by AH-0MUWZ5GST003NMFQ (Scout **90**, Diver **110**, Tank **75**, Phaser **90**, Swarm **90**, Boss **80**, Asteroid **50**, Harvester **50**); because `bulletLifetime` is unchanged, each enemy's effective range (`bulletSpeed × lifetime`) is halved too. The player's `PLAYER_BULLET_SPEED` (350 px/s) is unchanged. |
| `burstCount` | `number` | Burst / radial spoke count. |
| `[extra]` | `unknown` | Open passthrough — future axes without breaking JSON. **Not representable in a flat CSV row and dropped for CSV-sourced configs** (documented limitation). |

Types live in `src/core/configTypes.ts`; seed fallbacks in
`src/core/configDefaults.ts` (`DEFAULT_ENEMY_CONFIGS` scout/diver/tank/phaser/
swarm/boss/asteroid/harvester, `DEFAULT_ENEMY_KEYS`). `createEnemyFromConfig()` in
`src/entities/enemyFactory.ts` maps a config to its entity class (unknown keys
fall back to Scout; Swarm's `clusterIndex` is `row / SWARM_CLUSTER_ROW_STRIDE`).

### 8.2 CSV files, codec & config store

The CSV files are the **single source of truth** for enemy and ship tuning:

- `src/data/enemy-configs.csv` — one row per enemy archetype.
- `src/data/ship-config.csv` — the single player-ship row.
- `src/data/difficulty-curves.csv` — one row per `(level, wave)` for the optional
  runtime-sequenced campaign (AH-0MUH6LEYY0054E63; per-wave modes
  AH-0MUJSUQD8003FSUT): `level`, `levelName`, `wave`, `targetDifficulty`
  (0–100) and an optional `generation` (`curve` | `fixed` | `dynamic`, default
  `curve`). See §9.6.
- `enemy-configs.csv` starts with a `#` comment header listing every column,
  the enum values and how to add an entry. The header is optional and is **not**
  rewritten by the dev save path, so `ship-config.csv` is currently headerless.
  Colours are `0xRRGGBB`; `formationKind` and
  `shotPattern` are the plain enum strings; numeric columns are plain numbers.
- **Spawn-position ranges (AH-0MUKCLXLW0032R67):** `enemy-configs.csv` may carry
  four optional columns — `startXMin`, `startXMax`, `startYMin`, `startYMax` —
  emitted after `startY` in `ENEMY_COLUMN_ORDER`. A missing column falls back to
  the scalar `startX`/`startY` (so legacy files without them load unchanged and
  spawn at exactly the same point). A genuine band (`min !== max`) makes the
  game's `planGroupSpawns` and the gym's `GymFormationScene` draw a random base
  within it through the **shared** `resolveSpawnRange` / `pickInRange` helpers
  in `src/core/configTypes.ts`; reversed bounds are normalised so `min ≤ max`.
- **Behavioural classification (AH-0MV29NWI1007NKN7):** `enemy-configs.csv`
  carries two further columns, `movementClass` and `attackClass`, emitted last in
  `ENEMY_COLUMN_ORDER`. They are the coarse wave-design groupings documented in
  §1.4; both are optional for backward compatibility (absent/invalid values fall
  back to the documented defaults via `coerceEnemyConfig`), and the committed
  CSV always carries explicit values.

Supporting modules:

- `src/core/csv.ts` — hand-rolled RFC 4180 parser/serialiser plus typed
  coercion and validation. `parseCsvRows(csv)` → `Record<string, string>[]`
  (skips `#` comments/blank rows, strips a leading BOM);
  `coerceEnemyConfig` / `coerceShipConfig` convert strings to typed fields
  (missing → default, malformed → `0` / `0x000000`); `validateEnemyConfig` /
  `validateShipConfig` return `{ ok, errors }`; `serializeEnemyConfigs` /
  `serializeShipConfigs` round-trip back. `ENEMY_COLUMN_ORDER` /
  `SHIP_COLUMN_ORDER` are the stable exported column orders. The
  difficulty-curve codec (`DIFFICULTY_CURVE_COLUMN_ORDER`,
  `parseDifficultyCurves`, `serializeDifficultyCurves`,
  `validateDifficultyCurveRow`, `coerceDifficultyCurveRow`) mirrors these for
  the sequenced-campaign CSV (§9.6).
- `src/core/configStore.ts` — in-memory registry. `loadConfigs()` (async,
  awaited by `src/core/boot.ts` before the game/scenes are constructed) fetches
  both CSVs through the dev plugin (or reads the bundled CSV in production),
  parses/validates them and populates the registry;
  a failed fetch falls back to `DEFAULT_ENEMY_CONFIGS` / `DEFAULT_CONFIG`
  without throwing. `loadEnemyConfig` / `loadShipConfig` / `listEnemyConfigKeys`
  / `loadAllEnemyConfigs` are synchronous reads of the registry. The
  difficulty-curve loader (`DIFFICULTY_CURVES_CSV_PATH`,
  `loadDifficultyCurves()`, `saveDifficultyCurves()`,
  `seedDifficultyCurves()`, `defaultDifficultyCurves()`) follows the same
  pipeline and never throws (§9.6).
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
  `EnemyFormationKind`, `FORMATION_BUILDERS`, `getFormationBuilder(kind)` (unknown → `buildVFormationOffsets`),
  `formationSpawnCount(kind, count)` — the number of offsets a builder
  produces, used as the source of truth for a group's spawned size.
- `src/utils/enemyShotPatterns.ts`: `VALID_SHOT_PATTERNS`, `sanitizeShotPattern` (unknown → `'none'`), `isValidShotPattern`.
- `src/waves/WaveManager.ts`: `wavePlannedSpawnCount(groups)` (total planned
  spawns) and `validateWaveGroups(groups)` (returns an error naming any
  `single` group whose `count !== 1`). The **declared-vs-planned invariant**
  is that `waveEnemyCount() === planSpawns().length` for every wave; the
  declared size is derived from the builders so an over-declared `single`
  group cannot inflate the alive count, while `validateWaveGroups` surfaces
  the misconfiguration at authoring time.

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

### 8.5 Gym surface — GymFodderEnemies + editor panel

`GymFodderEnemies` is the only enemy gym scene. `init({ enemyKey })` loads the
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
(`GymPlayer`), `AI Config` (`GymFodderEnemies`) and `Boss Config` (`GymBoss`). The
helper is unit-tested in `src/utils/gymPanel.test.ts`, the collapsed CSS
contract in `src/style.test.ts`, and the per-scene toggle in each scene's test
file.

The **editor panel** (`src/scenes/gym/GymFodderEnemies.ts`, plain-DOM under
`#game-container`, id `enemy-gym-panel`) mirrors `GymPlayer`: sliders for
`count/spacingX/spacingY/driftSpeed/startX/startY/startXMin/startXMax/startYMin/startYMax/size/bulletSize/fireInterval/shotProbability/bulletSpeed/bulletLifetime/burstCount`,
colour pickers for `color/bulletColor`, selects for
`formationKind`/`shotPattern`/`movementClass`/`attackClass` (the last two are
persisted through the same CSV save path — AH-0MV29NWI1007NKN7),
plus **Save** (overwrite active row in `src/data/enemy-configs.csv` via the dev
plugin) and **Save As…** (sanitize → validate → duplicate check via
`listEnemyConfigKeys()`, displayName = raw input; appends a new CSV row).

**In-panel enemy selector (AH-0MV13G5EV008D41E).** The panel also carries the
**enemy selector** (id `enemy-gym-select`): a single `<select>` whose options
are every non-boss `EnemyConfig` key discovered from the config store
(`loadAllEnemyConfigs()`, so seed and `Save As…` entries both appear with no
hard-coded key list) **plus the dedicated Centipede linked-chain archetype**
(AH-0MV4ZOIZR0086T66) — labelled by `displayName` / `Centipede` and seeded from
the scene's active key. Choosing a different config enemy rebuilds the scene
through the shared `respawnFormation()` clean-slate seam — it destroys every
live formation entity and the player's in-flight bullets, loads the selected
config, then reloads every other panel control from that config (discarding
unsaved edits) — so the running scene always matches the selection. Choosing
**Centipede** instead swaps in the shared centipede formation
(`src/scenes/gym/core/centipedeFormation.ts`, the *same* `CentipedeChain` /
`Centipede` code `PlayScene` and `GymCentipede` run) and hides the config-tuning
controls (id `enemy-gym-config-body`) — the Centipede is a wave opt-in, not a
CSV row, so it has no tunable/saveable config. The `boss` archetype is
deliberately excluded (it has its own gym entry).
The four spawn-range sliders (`startXMin/startXMax/startYMin/startYMax`, bounds
`0..GAME_WIDTH` / `0..GAME_HEIGHT`, step 1) are clamped to the canvas and
auto-corrected so `min ≤ max` before the value is used or saved; editing the
legacy scalar `startX`/`startY` collapses its range to that point so the scalar
slider keeps moving the formation base.
Both flows are async: the panel shows `Saving…`, then `Saved`/`Saved as <key>`
or a red **`Save failed — …`** status (`enemy-gym-save-status`). In production
builds writes are unavailable and the status reports it. After a successful
write the scene re-reads the config from the store.
Live `input`/`change` events patch `config.buildOffsets/spacing/drift/start/count`
and best-effort mutate entity `_*` fields (including `_bulletLifetime`, so the
`bulletLifetime` 0.1–5.0 s TTL slider live-applies to already-spawned entities).
Panel is removed on scene
`SHUTDOWN`; stale panels are cleared on rebuild for test isolation.
Queryable DOM ids: `enemy-gym-panel`, `enemy-gym-select`,
`enemy-gym-config-body`, `enemy-gym-save`,
`enemy-gym-save-as`, `enemy-gym-save-as-input`, `enemy-gym-save-status`,
`data-config` / `data-config-value` on controls. The panel also shows a
**live difficulty readout** (id `enemy-gym-difficulty`) that recomputes the
0–100 archetype score on every control change — see §9.

Archetype discovery now lives inside the scene: the enemy selector enumerates
the config store (`loadAllEnemyConfigs()`), so a `Save As…` entry appears on
the next boot with no code change (the retired `src/utils/enemyGymDiscovery.ts`
used to build one index row per config). The gym index lays out three columns:
plain scenes (left), **ENEMIES** (middle) and **Dev Utilities** (right). The
**ENEMIES** column holds a single **"Fodder Enemies"** row that boots
`GymFodderEnemies` bare plus the dedicated **"Boss"** row (scene key
`GymBoss`) that boots the multi-phase `GymBoss` scene directly. Bare
`GymFodderEnemies` is excluded from the plain scene
list, and `GymBoss` is likewise excluded there so the real boss is not
duplicated (AH-0MV13G5EV008D41E; formerly AH-0MUAYB28C004KK7X,
AH-0MTV8OV9V002D8B7). Index rows are
keyboard-operable through the shared `src/utils/focusManager.ts`
(`FocusManager`): rows are focused in reading order with the first row
focused by default, Tab/Shift+Tab and the arrow keys cycle with wrap-around,
and Enter/Space launch the focused row through the same path as a pointer
click (AH-0MUDZFBYY008P7ZE).

**Level Gym (`GymLevel`, AH-0MUNU6MGM007CI45).** The left column also lists
`GymLevel` (label **Level**). It is a parameterised level-playback gym that
takes a `LevelDefinition` (`{ level, name, waves }`) and plays the waves
sequentially through the shared `CombatScene` core (input, auto-fire,
collision/hit lifecycle and formation drift are the same code as the game and
the other gyms). It shows the level name plus `Wave n/N` in the HUD, starts
the ship with the **spread** and **dual** weapons equipped, and offers the
standard "← INDEX"/ESC navigation. Like every player-bearing gym it binds the
arrow/WASD keys for the shared `_tickPlayer` control step and plays the shared
spawn cue (`playSpawnSound`) as each wave spawns, so the launched level is
fully playable and audible (parity with the game and the other gyms). It is
the launch target of the
difficulty-curve editor's **Launch Level** / **Launch Wave N** buttons: the
editor folds its generated waves into level groups of `CURVE_WAVES_PER_LEVEL`
(3) and offers one **Launch Level** button per group (full level) plus one
**Launch Wave** button per row (single wave). Because the runtime sequencer is
a pure function of its target, a flat curve would otherwise play the *same*
wave three times in a level; regeneration therefore runs each level group
through `sequenceVariedWaves()` (`GymCurveSequencer.ts`), which nudges a
wave's target deterministically (bounded, alternating, at most
`CURVE_WAVE_VARIATION_JITTER` per step) until the composition differs from the
level's earlier waves, while still reporting the designer's authored target on
each wave. This is what fixed the producer-audit rejection of this work item.

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
   `src/entities/enemyFire.ts` (the single fire-dispatch seam; non-firing
   archetypes get an explicit `tryFireNone` entry so they never fall back to
   the aimed shot), wire it in `src/entities/enemyFactory.ts`, and add a seed
   fallback to `DEFAULT_ENEMY_CONFIGS` in `src/core/configDefaults.ts` plus a
   `health` value (default 1). If the entity is multi-hit, implement
   `takeDamage()` (extend `BaseEnemy`, which already provides it from the
   configured `health`).
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
  `shotPattern === 'none'` independence, health factor (monotonicity and
  non-firing independence), Asteroid split chain, wave mix).
- **Calibration test:** `src/waves/enemyDifficulty.campaign.test.ts` (pins the
  non-decreasing ten-level configured curve and the real `LEVELS`), plus
  `src/waves/campaignInvariants.test.ts` (style variety, difficulty continuity,
  authoring mix) and `src/waves/campaignRoster.test.ts` (roster coverage and
  player-targeter pairing).

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
| `bulletLifetime` | 6 | 0.1–5.0 s | Bullet TTL — **not** inverted: a longer-lived bullet wraps the screen and stays lethal, so a higher value scores higher. Matches the gym slider range. |
| `burstCount` | 12 | 1–24 | Bullets per volley / radial spokes. |
| `formationKind` | 8 | ordinal 0–5 | Positional threat: single 0, v 1, diver 2, rect 3, march 3 (rigid block, shares the rect ordinal), swarm 4, orbital 5. |
| `asteroidSplit` | 10 | 1–7 | Split-chain entity count; one large Asteroid = 7 destroyed enemies (GDD §4.1 E6). |
| `health` | 10 | 1–5 HP | Enemy durability; **not** inverted — a durable multi-hit archetype is harder to survive, so a higher value scores higher. Range covers the single-hit default (1) and the 5-HP Harvester (GDD §4.2). |

**Non-firing axes** (`count`, `driftSpeed`, `shotPattern`, `formationKind`,
`asteroidSplit`, `health`) always contribute. The **firing factors**
(`fireInterval`, `shotProbability`, `bulletSpeed`, `bulletLifetime`,
`burstCount`) **contribute zero** when
`shotPattern === 'none'` (e.g. the Asteroid) or when `waveDifficulty` scores a
wave with `shootEnabled: false` (GDD §2.4 — Levels 1–3). Health is a *non-firing*
axis — durability is not an attack behaviour — so it contributes even for an
archetype or wave whose firing is suppressed.

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
campaign is **ten levels**: Levels 1–3 are the no-fire onboarding section,
Levels 4–5 introduce enemy fire, and Levels 6–10 interleave the classic-arcade
roster as hand-authored showcase waves. The **configured target curve**
(`defaultDifficultyCurves()`) is non-decreasing across all ten levels and is
enforced by `src/waves/enemyDifficulty.campaign.test.ts` and
`src/waves/campaignInvariants.test.ts`. The **computed** `levelDifficulty` mean
below is a composition property, not the calibrated guarantee: a `fixed`
showcase wave can deliberately feature a weaker archetype, so the computed means
are not strictly monotonic across Levels 6–10.

| Level | Theme | Difficulty (0–100) |
|-------|-------|-------------------:|
| 1 | Entry | 6.01 |
| 2 | Descent | 10.95 |
| 3 | The Core | 12.30 |
| 4 | Firestorm | 20.87 |
| 5 | Predictable Death | 28.56 |
| 6 | Invasion | 19.36 |
| 7 | Segmented Assault | 22.43 |
| 8 | Gridlock | 19.80 |
| 9 | Orbital Siege | 23.15 |
| 10 | The Gauntlet | 22.12 |

Per-archetype scores for the seed enemies (with firing where the archetype
fires): Scout 13.57, Diver 21.46, Tank 27.08, Phaser 29.20, Swarm 18.87,
Boss Swarm 21.40, Asteroid 8.62 (split chain only — it never fires),
Harvester 8.62 (5 HP, non-firing; its durability contribution equals the
Asteroid's split-chain contribution).

> **Tuning guidance.** The weights are subjective by nature; the index is a
> relative, monotonic ordering, not an absolute truth. Tests pin *ordering*
> and *monotonicity*, not the magic numbers. Any weight change must be
> re-checked against both the per-axis monotonicity tests and the campaign
> calibration test.

#### Campaign structure and design rules (10 levels)

The ten-level campaign (parent epic AH-0MV29SBAQ000HQR2) interleaves the
classic-arcade roster with the existing archetypes:

| Level | Theme | Featured showcase |
|-------|-------|-------------------|
| 1 | Entry | V-formation drift (no fire) |
| 2 | Descent | Diver/swarm drift (no fire) |
| 3 | The Core | Rect + V pairs (no fire) |
| 4 | Firestorm | First enemy fire (aimed/spread/radial) |
| 5 | Predictable Death | Fixed orbital Phasers (memorisable radial) |
| 6 | Invasion | Space-Invaders `march` + Galaga `capturer` tractor pull |
| 7 | Segmented Assault | Centipede `centipede` chain + Pac-Man `ghosts` pursuit |
| 8 | Gridlock | Frogger `laneTraffic` lanes + Robotron `horde` + Defender `raider` dive |
| 9 | Orbital Siege | Missile-Command `orbital-strike` arcs + orbital Phasers + `ghosts` |
| 10 | The Gauntlet | Dense mixed finale of the remaining roster |

Three design rules are enforced by tests:

1. **Roster coverage** — every classic-arcade archetype appears at least once
   across the merged campaign (`src/waves/campaignRoster.test.ts`). `march`,
   `capturer` and `raider` ship as wave groups; `ghosts`, `centipede`, `horde`
   and `laneTraffic` are spawner-delivered via per-wave opt-in flags;
   `orbital-strike` is the campaign-wide telegraphed hazard armed by the strike
   planner from global wave index 3.
2. **Player-targeter pairing** — every wave that fields a player-targeting
   archetype (`capturer`, `ghost-*`, `grunt`, `raider`) also fields at least one
   non-player-targeting kind, so a targeter is never the sole threat in a wave
   (`src/waves/campaignRoster.test.ts`).
3. **Style variety** — adjacent levels differ in their dominant movement/attack
   style, and the configured target curve is non-decreasing
   (`src/waves/campaignInvariants.test.ts`).

Levels 1–3 stay `shootEnabled: false` (GDD §2.4); Levels 4–10 fire (GDD §2.5).
Each featured archetype debuts on a hand-authored `fixed` wave so its showcase
is guaranteed for a given run seed; the remaining waves are generated (`curve`).

### 9.5 Where it surfaces

- **Enemy Gym editor panel:** the live `enemy-gym-difficulty` readout shows the
  edited archetype's score and updates on every slider/select/colour change
  (`GymFodderEnemies._updateDifficulty`).
- **Library:** `enemyDifficulty` / `waveDifficulty` / `levelDifficulty` are
  importable for scripts, docs tables and future tooling.

### 9.6 Runtime auto-sequencer & sequenced campaigns (AH-0MUDIWETP003XC3X, AH-0MUH6LEYY0054E63)

The runtime **auto-sequencer** (`src/core/difficultySequencer.ts`,
`sequencer(curve, candidates, options)`) is the delivered, pure primitive that
picks and tunes candidate enemy groups to best approximate a target difficulty
curve (one target per wave). It is wired into the playable run by
`src/waves/sequencedLevels.ts` (`buildSequencedLevels(rows?, candidates?,
options?)`), which calls `sequencer()` per `curve`/`dynamic` wave, converts each
`ShootableWave` to a `WaveDefinition`, and applies the campaign fire rule.

- **Config:** `src/data/difficulty-curves.csv` — one row per `(level, wave)`.
  Columns: `level` (1-based), `levelName`, `wave` (1-based), `targetDifficulty`
  (0–100) and an optional `generation` (`curve` | `fixed` | `dynamic`, default
  `curve`). The number of rows for a level sets its wave count; the level
  count and names are therefore data-driven. The CSV is loaded through the same
  `configStore` / `configCsvPlugin` pipeline as the enemy/ship CSVs (editable in
  dev via `/api/csv/...`, bundled read-only in production) with the
  `parseDifficultyCurves` / `serializeDifficultyCurves` /
  `validateDifficultyCurveRow` codec (`src/core/csv.ts`). The legacy 4-column
  form keeps working: an absent `generation` defaults to `curve`, and the codec
  always writes the column back.
- **Candidate pool (AH-0MUR1HZLQ001ELX9):** the default pool
  (`defaultCandidatePool()`) deliberately excludes two archetypes that are
  delivered by their own spawners: the **Harvester** (rare later-level roaming
  spawn, `HarvesterSpawner`) and the **Asteroid** (random offscreen spawner,
  `AsteroidSpawner`). The asteroid is explicitly **not wave-accounted**
  (AH-0MUJM746P000QAEO), so a sequenced wave group containing one would be
  counted by `WaveManager.waveEnemyCount()` but never un-counted — the wave
  would never clear, soft-locking the run and making the boss unreachable.
  Excluding it keeps every sequenced group wave-accounted and preserves the
  "asteroids are not wave-accounted" contract for the random spawner and split
  children.
- **Per-level archetype variety cap (AH-0MV2SGIX5005PFJT):** the sequencer
  selects a wave's composition purely by minimising the error against its
  `targetDifficulty`, so without a composition constraint the highest-rated
  archetype — the Phaser's `orbital` formation (ordinal 5 in the
  `formationKind` scale) — became the best fit for **every** wave once the
  target crossed ~30. The late game then collapsed onto one movement style
  ("once an orbital formation appeared, all subsequent waves were orbital").
  `MAX_ARCHETYPE_PER_LEVEL` (`src/core/difficultySequencer.ts`, default **1**)
  caps the number of waves within one level in which a single archetype may
  appear. `buildSequencedLevels()` creates one `archetypeUsage` map per level
  and shares it across the level's per-wave `sequencer()` calls, so the cap
  spans the whole level; `sequencer()` records each wave's archetypes and
  excludes at-cap archetypes from both the primary selection and multi-group
  composition. It falls back to the full pool when every archetype is already
  at the cap, so a wave can never be starved into an empty/soft-locking
  composition. The cap applies **only to generated (`curve`/`dynamic`) waves**:
  an authored `fixed` wave is never passed to the sequencer and may still use
  any archetype, so the orbital Phaser remains an authorable set-piece and is
  still exercised by the gyms (gym↔game parity, §5.1). Raise the constant or
  pass `maxArchetypePerLevel` to relax the rule; `Infinity` disables it. The
  shipped level 5 therefore keeps the orbital Phaser in one wave (W1) and
  composes W2 from non-orbital archetypes.
- **Per-wave generation modes (AH-0MUJSUQD8003FSUT):** `generation` is a
  **per-wave** selector and the three modes may be mixed freely within a level:
  `curve` builds the wave from its target once (fixed for the run); `fixed`
  uses the static `LEVELS` wave at the same `(level, wave)` verbatim (its own
  `shootEnabled` flag) and is **never** passed to the sequencer (its
  `targetDifficulty` is ignored); `dynamic` rebuilds the wave from its curve at
  run start, seeded from the run seed, so successive runs differ while a given
  seed reproduces exactly. The `dynamic` seed shifts the wave's target by up to
  ±`DYNAMIC_TARGET_JITTER` points before sequencing (the saved curve is never
  mutated); the no-fire opening waves (levels 1–3) instead use the tight
  ±`EARLY_DYNAMIC_TARGET_JITTER` (2) and a **curated** candidate pool with a
  minimum count of 4, so the opening (L1W1, L1W2, L2W1, L2W2) stays varied and
  never degenerate (AH-0MUOCJM0N000RW2B). A missing/unknown mode falls back to
  `curve`. The legacy per-level
  `source` column (`generated` | `scripted`, AH-0MUH7Q6HN0006QPD) is still read
  when `generation` is absent: `scripted` → `fixed`, `generated` → `curve`. The
  merged campaign starts from the static `LEVELS` skeleton, so levels 1–5 are
  always present unless a configured level overrides one, and a configured
  level numbered beyond the static five is appended (ordered ascending by
  `level`, because `WaveManager` progresses by array index). An all-`fixed`
  level whose row count matches the static level is returned byte-for-byte.
  This lets designers hand-tune onboarding and set-piece waves while the
  sequencer ramps the rest.
- **Toggle:** the `GameRules.sequencedWavesEnabled` scalar
  (`src/core/rules.ts`, default **`true`** — AH-0MUJSUTLA006Q8E1) in the
  `ai-hell-game-rules` localStorage record. `PlayScene.create()` overrides the
  campaign with the sequenced one when it is `true`; persisting `false` opts
  back into the static `LEVELS` campaign. A malformed/non-boolean value falls
  back to the default.
- **Fire rule:** derived from the 1-based level number for **`curve`/`dynamic`**
  waves — levels 1–3 do not fire, levels 4+ do (GDD §2.4/§2.5) — and passed to
  `sequencer()` as `defaultShootEnabled`; **`fixed`** waves keep their own
  `LEVELS` flags.
- **Determinism:** `curve` and `fixed` waves are a pure function of the config
  and the candidate pool (no RNG, no clock, no I/O), so the same inputs yield
  identical definitions; `dynamic` waves are a pure function of (curve,
  candidate pool, seed), so they differ between runs but reproduce for a given
  seed. `PlayScene` derives one run seed from the scene RNG (`setRunSeed()` is
  the test seam) and threads it into the builder.
- **Fallback:** per level — a level with an empty/malformed curve (or a throw
  from the sequencer) keeps its static `LEVELS` definition when one exists and
  is skipped when it has no static counterpart (a configured level numbered
  beyond `LEVEL_COUNT`). A `fixed` wave with no static counterpart (a level
  beyond `LEVEL_COUNT`, or an out-of-range wave index) falls back to `curve`
  generation for that wave. The whole campaign falls back to static `LEVELS`
  only when there are no rows, the candidate pool is empty, or the merged result
  would be empty. A missing/malformed curve CSV falls back to the computed
  default curve (`defaultDifficultyCurves()`: the first four campaign waves
  `dynamic` on a curated opening, the remaining levels 1–3 waves `fixed` on the
  measured `LEVELS` calibration, levels 4–5 `curve` on hand-tuned targets with
  level 5 wave 2 `dynamic` — AH-0MUOCJM0N000RW2B / AH-0MUJSUTXI008NP8K /
  AH-0MUJSUTLA006Q8E1); and
  `PlayScene` catches any error and leaves the static campaign active. The run
  is therefore never left unplayable.

Related work: the sequencer primitive was delivered by `AH-0MUDIWETP003XC3X`;
the wiring is `AH-0MUH6LEYY0054E63`; per-level generated-vs-scripted mixing was
`AH-0MUH7Q6HN0006QPD` (generalised to per-wave modes by
`AH-0MUJSUQD8003FSUT`); player-state adaptation and runtime curve editing
(`AH-0MUGXDVPH005TIZL`) remain out of scope.

## Audio Best Practices

All enemy audio functions live in
[`src/audio/effects.ts`](../src/audio/effects.ts) — the **single source of
truth**; never inline an audio call anywhere else. Each cue is a **build-time
baked ToneForge WAV asset** (one recipe slug per cue) played by the thin
manifest-driven layer in `effects.ts`; the continuous thruster hum is the only
runtime-synthesised exception and is player-only. The authoritative
cue→recipe catalogue is the
[Audio cue-to-recipe mapping](AUDIO_TONEFORGE_CUE_MAPPING.md), and the assets
are rendered by `scripts/build-audio.sh` into `public/audio/sfx/`. The audio
event catalog and default sound characters are defined in
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
| E2 Diver | none (no advance cue — fire sound alone is the tell); `playDiverDiveStartSound()` — rising whoosh/crack once at the FORMATION→DIVING transition (the dive danger cue) | `playDiverFireSound()` — short low/nasal crack; `playDiveSound()`/`stopDiveSound()` — refcounted shared sustained dive whoosh for the ~2 s dive (stopped at the end of the dive, `destroySelf()`, and `destroy()`) | **entity-level**, fire exactly once per spread burst inside `tryFireSpreadBurst()`; dive-start cue once per dive in `_startDive()` |
| E3 Tank | `playTankAdvanceCue()` — mechanical whine (≥ 500 ms, `TANK_ADVANCE_CUE_DURATION`) | `playTankFireSound()` — heavy cannon thump | **entity-level**, one cue+thump pair per radial burst inside `tryFireRadialBurst()` — the cue flows with **no gap** into the thump |
| E4 Phaser | `playPhaserAdvanceCue()` — rising sine 660→880 Hz (replaces the old inline `_playAdvanceCue()`, `PHASER_ADVANCE_CUE_DURATION`) | `playPhaserFireSound()` — short sharp blip, scheduled at the cue's end | **entity-level**, one advance cue + fire sound pair at tell start inside `applyFormationPosition()` (matching the Scout no-gap pattern) — no audio on the firing branch (no double-play) |
| E5 Swarm | none (no warning cue) | `playSwarmBurstSound()` | **entity-level** volley burst, once per volley inside `tryFireBurstBullet()` |
| Boss | `playBossPhaseCue()` — per-phase telegraph tone (retained) | `playBossFireSound()` — deep resonant boom (in `src/audio/effects.ts`) | **entity-level**, once per volley in each attack method (`tryFireSpreadBullets`, `tryFireSpiralBullets`, `tryFirePulseBullets`, `tryFireDesperationBullets`) |

Orchestration rule: entity-specific fire sounds are invoked **where the shots
are produced** — the entity's own fire/tell logic (Tank's `tryFireRadialBurst`,
Swarm's `tryFireBurstBullet`, Phaser's tell, the Boss's attack methods, the
Scout's two-phase tell) — never re-added in a thin scene class.

**ToneForge recipes per cue:** Scout advance `aihell-scout-advance`, Scout fire
`aihell-scout-fire` (baked, seed 32181 — AC4, AH-0MVCRR2H2007VPDU; replaces the
near-clipping `weapon-laser-zap`); Diver dive-start `aihell-diver-dive-start`, dive loop
`aihell-diver-dive-loop`, fire `aihell-diver-fire`, destruction
`aihell-diver-destruction` (multi-seed 32173/32176/32197 — AC3 scale-degree variants); Tank advance
`aihell-tank-advance`, fire `aihell-tank-fire`; Phaser advance
`aihell-phaser-advance`, fire `aihell-phaser-fire`; Swarm burst
`aihell-swarm-burst`; Boss phase cue `aihell-boss-phase-cue` (per-phase seeds
32242/32227/32207/32204 — AC3 scale-degree variants), Boss fire `aihell-boss-fire`; spawn `aihell-enemy-spawn`;
destruction `aihell-enemy-destruction` (multi-seed 32113/32128/32144 — AC3 scale-degree variants). Full catalogue:
[Audio cue-to-recipe mapping](AUDIO_TONEFORGE_CUE_MAPPING.md).

### Projectile identity & per-shot feel (per-enemy visuals epic)

Each AC-listed enemy attack gets its own in-flight projectile identity
(shape/colour/feel through the shared bullet-shape seam) plus fire/impact
VFX + SFX, gated by its existing fire behaviour (AH-0MV2K5SR0005RTTE —
visuals/feel only: firing logic, speeds, intervals and patterns are
unchanged). The shared seams the children consume: `bulletUtils.createBullet`
(the shared enemy-bullet spawn path), `resolveEnemyBulletVisual`
(`src/utils/bulletVisuals.ts`, the identity registry the roster guard pins),
`src/vfx/enemyMuzzleFlash.ts` (the enemy fire-time launch pop) and the shared
impact passes in `src/scenes/core/CombatScene.ts` (coloured interception
flash + per-identity hit pop through `playBulletDestructionSound`, the reused
per-enemy impact cue).

### Projectile identity roster (AH-0MV2K5SR0005RTTE)

The consolidated per-attack identity — shape primitive, fire-time VFX (launch
pop at the emitter) and impact feel — for every AC-listed enemy attack. All
shapes are code-drawn `src/utils/bulletVisuals.ts` primitives rendered
through the shared seam, so the game and every gym draw them identically
(gym↔game parity by construction; the docs-guard test pins this table).

| Identity | Family/pattern | Shape primitive | Fire VFX (launch pop) | Impact feel |
|---|---|---|---|---|
| Alien pellet | Scout / Space-Invaders March | `pellet` (pulsing rim) | green pop at scout | green flash + shared destruction cue |
| Sharp shard | Diver spread burst | `shard` (spine glint) | one pale-yellow pop per burst | pale-yellow flash + shared destruction cue |
| Heavy shell | Tank radial | `heavy-shell` (breathing glow) | one amber pop per burst | amber flash + shared destruction cue |
| Crisp phaser bolt | Phaser radial | `phaser-bolt` (core streak) | one magenta pop per volley | red flash + shared destruction cue |
| Cometary fleck | Swarm burst | `fleck` (comet tear) | cyan pop per member shot | cyan flash + shared destruction cue |
| Slim dart | Defender raider | `dart` (spearhead) | pale-amber pop per shot | pale-amber flash + shared destruction cue |
| Dense boss pellet | Boss spread | `boss-pellet` (ring accent) | one blood-red pop per volley | white flash + shared destruction cue |
| Phase pellet | Boss spiral | `spiral-pellet` (phase core) | one phase-tinted pop per volley | white flash + shared destruction cue |
| Pulse ring | Boss pulse aimed shots | `pulse-ring` (wide wave echo) | one pale pop per volley | white flash + shared destruction cue |
| Tracer | Boss desperation | `tracer` (white-hot streak) | one hot-gold pop per volley | hot-gold flash + shared destruction cue |
| Tractor beam | Galaga capturer | beam field (tapering funnel) | beam-start field shimmer | capture lure + shared destruction cue |
| Falling warhead | Missile-Command orbital-strike | `warhead` (fiery tail) | amber pop at spawn | red detonation flash + shared explosion cue |

**Aliasing note:** the Space-Invaders March (`march`) shares the Scout
identity (same entity class, one roster family); the Boss's four patterns
are separate identities (one child per pattern). The Capturer and
OrbitalStrike never fire a bullet — their identities are the beam field and
the falling warhead respectively.

**E1 Scout / Space-Invaders March (scout-invader family,
AH-0MV822CQL005R4MM):** the aimed shot renders as a **small alien pellet** —
scalloped pod body, a bright **enemy-tinted (green) core** and a **faint
pulsing rim** (time-driven, redrawn each frame through the shared bullet
lifecycle) plus a short fading trail — with a green launch pop at the scout's
body when the shot leaves and a green-tinted impact flash when the shot
connects or is intercepted. The March block shares the identity (same
entity class, same family per the roster guard).

**E3 Tank (tank family, AH-0MV822DF60001EPA):** each radial shell renders as
a **heavy shell** — a visibly larger two-tone amber body with a **white-hot
core** and a **slow breathing glow** ring (a dedicated `heavy-shell` seam
primitive; the glow swells at ~1.8 rad/s with the shell's age and is redrawn
each frame through the shared bullet lifecycle — the lazy ember read of slow
artillery, deliberately the opposite of the Scout's fast-pulsing pellet)
plus a short ember trail. The volley spawns **one amber launch pop** at the
tank's body per burst (the burst is one fire event, matching its single
cue+thump pair — not ten stacked pops), and each shell carries its amber
colour so the shared impact pass tints the flash when a shell connects or is
intercepted. Visuals/feel only: firing logic, speed, interval, burst count
and the direction-agnostic radial pattern are unchanged.

**E2 Diver (diver family, AH-0MV822D2U000LRFV):** each spread-burst shot
renders as a **sharp shard/splinter** — a dedicated `shard` seam primitive
(razor arrowhead outline with a **white-hot spine**, a neon rim in the
Diver's own body yellow and a short fading trail) whose bright **glint**
sweeps up and down the spine with the shot's age (~1.4 Hz, redrawn each
frame through the shared bullet lifecycle) — the shard echoes the Diver's
dart body and dive arc, deliberately the opposite of the Tank's fat ember
shell and the Scout's pulsing pod. The volley spawns **one pale-yellow
launch pop** at the diver's body per burst (the burst is one fire event,
matching its single fire cue — not N stacked pops), each shard flies
nose-first along its own spread heading, and each shard carries its
pale-yellow colour so the shared impact pass tints the flash when a shard
connects or is intercepted. Visuals/feel only: firing logic, speed,
interval, burst count and the spread pattern are unchanged.

**E4 Phaser (phaser family, AH-0MV822DRX009RYUB):** each radial shot renders
as a **crisp-edged phaser bolt** — a dedicated `phaser-bolt` seam primitive
(a smooth hexagonal prism with pointed tips at each end of the flight axis
and parallel long edges — no zig-zag) filled with the shot's lethal red,
with a **bright white velocity-aligned core streak** running the prism's
length, a neon rim in the Phaser's own body magenta and a short fading
trail. The radial volley spawns **one magenta launch pop** at the phaser's
body per volley (the volley is one fire event, matching its single
cue+sound pair — not eight stacked pops), each bolt flies nose-first along
its own spoke, and each bolt carries its red colour so the shared impact
pass tints the flash when a bolt connects or is intercepted. The clean
straight-edged prism is deliberately the opposite of the player's jagged
`bolt` and of every other enemy identity — crisp, telegraphed energy rather
than a splinter, ember or pod. Visuals/feel only: firing logic, speed,
interval, spoke count and the radial pattern are unchanged.

**E5 Swarm (swarm family, AH-0MV822E4T006F37Y):** each coordinated-burst
shot renders as a **tiny fast cometary fleck** — a dedicated `fleck` seam
primitive (a small elongated tear with a **white-hot leading glint**, a
pointed tail, a cyan neon rim and a short fading trail) that reads as one
of a massed fast-moving volley — deliberately the smallest, simplest
silhouette in the roster, so the Swarm's massed fire stays cheap at high
bullet counts while still being visibly distinct from the Scout's pulsing
pod and the Raider's wide diamond. Each member's shot spawns **one cyan
launch pop** at the member's body (each member is its own emitter, so each
fleck gets its own tiny pop), each fleck flies nose-first along its spread
heading, and each fleck carries its cyan colour so the shared impact pass
tints the flash when a fleck connects or is intercepted. Visuals/feel only:
firing logic, speed, interval and spread are unchanged.

**Defender raider (raider family, AH-0MV822EH800780GI):** during a committed
attack run the raider's aimed shot renders as a **slim sharp-nosed dart** —
a dedicated `dart` seam primitive (a long spearhead body with a **white-hot
nose tip**, a hot-pink neon rim and a short fading trail) — a needle-like
fast-attacker read, deliberately distinct from the Scout pellet whose shared
`tryFireAimedBullet` path the raider reuses. The raider resolves its own
identity through the overridable `bulletVisualArchetype` seam on the shared
Scout fire path (the one place the shared aimed-shot code names its
projectile identity), so the game and every gym draw the same dart with no
per-scene copy. Each shot spawns **one pale-amber launch pop** at the
raider's body and each dart carries its pale-amber colour so the shared
impact pass tints the flash when a dart connects or is intercepted.
Visuals/feel only: the patrol/attack state machine, fire gate, speed,
interval and advance-cue tell are unchanged.

**Boss spread (boss-spread pattern, AH-0MV822ETD008LLZX):** the Scan
(Phase 1) spread volley's shots render as **dense boss pellets** — a
dedicated `boss-pellet` seam primitive (a heavy hexagonal body with a
white-hot core and a **menacing concentric ring accent** — a blood-red
targeting halo — plus a short fading trail). The volley spawns **one
blood-red launch pop** at the boss's body (the volley is one fire event
that already plays one Boss fire cue — not 7–9 stacked pops), each pellet
flies nose-first along its spread direction, and each pellet carries its
white colour so the shared impact pass tints the flash when a pellet
connects or is intercepted. The remaining boss patterns (spiral, pulse,
desperation) get their own identities under their own child items.
Visuals/feel only: firing logic, counts, spread angle, speeds and the
telegraph cadence are unchanged.

**Boss spiral (boss-spiral pattern, AH-0MV822F5J006WFR0):** the Firestorm
(Phase 2) spiral volley's shots render as **phase-coloured spiral pellets**
— a dedicated `spiral-pellet` seam primitive (a compact white pellet with a
bright **phase-coloured core** — the Boss's current health-phase colour,
green → yellow → orange → red, resolved live at fire time through the same
mapping the health bar uses — and a **spiral-wake arc** trailing behind, plus
a short fading trail). The volley spawns **one phase-tinted launch pop** at
the boss's body (one pop per volley — the volley is one fire event that
already plays one Boss fire cue), each pellet flies nose-first along its
rotating spiral spoke, and each pellet carries its white colour so the
shared impact pass tints the flash when a pellet connects or is
intercepted. The remaining boss patterns (pulse, desperation) get their own
identities under their own child items. Visuals/feel only: firing logic,
counts, rotation step, speeds and the telegraph cadence are unchanged.

**Boss pulse (boss-pulse pattern, AH-0MV822FHN005PK37):** the Pulse pattern's
aimed shots render as **slow wide pulse rings** — a dedicated `pulse-ring`
seam primitive (a pale ring with a faint filling, a bright outer edge and a
dim inner halo — the compact echo of the screen-wide wave that the pattern
also spawns, which keeps its own dedicated expanding-ring pulse-wave
rendering) plus a short fading trail. The pattern plays **one pale launch
pop** at the boss's body alongside the wave spawn (one pop per volley — the
pattern is one fire event that already plays one Boss fire cue), each aimed
shot flies nose-first along its fan direction, and each carries its white
colour so the shared impact pass tints the flash when a shot connects or is
intercepted. The remaining boss pattern (desperation) gets its own identity
under its own child item. Visuals/feel only: firing logic, wave speed, aim
count, fan spread and the telegraph cadence are unchanged.

**Boss desperation (boss-desperation pattern, AH-0MV822FTS00156F5):** every
bullet of the combined desperation volley (spread + spiral + aimed) renders
as a **bright velocity-aligned tracer** — a dedicated `tracer` seam primitive
(a long hot-gold streak with a **white-hot head** and a short tail flare)
plus a short fading trail — the exposed, brighter-core read of the boss's
final phase, hotter and faster-looking than every other boss identity. The
volley plays **one hot-gold launch pop** at the boss's body (one pop per
combined volley — the volley is one fire event that already plays one Boss
fire cue), each tracer flies nose-first along its layer direction, and each
carries its hot-gold colour so the shared impact pass tints the flash when a
tracer connects or is intercepted (the expanding pulse wave keeps its own
rendering). Visuals/feel only: firing logic, counts, layers, speeds and the
telegraph cadence are unchanged.

**Galaga capturer (capturer family, AH-0MV822G6F002JRRY):** the capturer
**never fires a bullet** — its threat is the tractor beam it projects, so
its projectile identity is the beam itself: a **magenta tugging
beam/field** drawn by the shared `Capturer` entity (`_drawBeam`) as a
**tapering funnel** (narrow at the capturer, flaring at the far end) with a
bright core rail, **converging side field-lines** (the "tractor" read),
**flowing energy motes** that travel down the field with the entity's local
phase (time-driven, redrawn each frame so the tug shimmers identically in
the game and every gym) and a **bright capture lure** at the beam's far end
(the hazard point). The archetype's registered visual signature records the
beam tint (`capturer` → `line`, magenta) so the roster guard stays total.
Visuals/feel only: the beam lifecycle, width, length, pull strength and
capture timing are unchanged.

**Missile Command orbital-strike (orbital-strike pattern,
AH-0MV822GIO005B685):** the falling shell renders as a **falling warhead** —
a dedicated `warhead` seam primitive (a cap-shaped shell body with a
**white-hot nose** and a **flickering fiery tail** — a time-driven flame
behind the rear — plus a short fading trail and a hot-amber neon rim). The
strike plays **one amber launch pop** where the shell enters from above (the
enemy-side fire VFX for the strike), the warhead flies nose-first straight
down the fall, and it carries its hot-red colour so the shared impact pass
tints the detonation flash at the impact point. The radial-detonation
shrapnel keeps its plain disc look (the strike's shrapnel is the burst, not
a named identity). Visuals/feel only: telegraph duration, fall speed,
impact timing and the burst pattern are unchanged.

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
