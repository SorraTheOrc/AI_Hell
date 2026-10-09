# Classic Power-Up & Weapon Research Catalogue

> **Work item:** AH-0MV1BIUGE005BJO8 — Research catalogue and engine-constraint validation
> **Epic:** AH-0MV14SO0G0095IJ4 — New power-ups and weapons from classic arcade games

This document catalogues the selected classic-arcade power-up and weapon
concepts for AI_Hell. For each concept it records the source game and era, the
original behaviour, the adaptation to AI_Hell's top-down free-2D neon-vector
code-drawn arena (including any documented divergence), whether it is a
power-up or a weapon, its pipeline fit against the shared catalogue / level /
dispatch seams, its selection rationale and balance guardrail, and the gym
scene(s) that will exercise it. It also records the candidates that were
considered but not selected, so the research pool can be revisited later.

**Cross-references:**

- `docs/Game Design Document.md` §4.4 — the shipped power-up and weapon
  catalogue, §4.4.2 weapon leveling and §4.4.3 power-up leveling.
- `docs/CLASSIC_ENEMY_RESEARCH.md` — the sibling enemy research catalogue this
  document mirrors.
- `src/utils/weapons.ts` (`WeaponId`, `WEAPON_CATALOGUE`), `src/powerups/types.ts`
  (`PowerUpId`, `POWER_UP_CATALOGUE`), `src/utils/weaponLevels.ts`,
  `src/powerups/powerUpLevels.ts`, `src/core/rules.ts` (`powerUpWeights`,
  `weaponWeights`) and `src/powerups/icons.ts`.

Every child work item listed at the end of this document references this
document as its design brief.

---

## Selection rationale

The eight concepts below were chosen because each one (a) is a signature,
instantly recognisable classic-arcade ability, (b) maps onto at least one
existing engine seam (a `WEAPON_CATALOGUE`/`POWER_UP_CATALOGUE` entry, the
`AoEDescriptor` seam, the `weaponLevels`/`powerUpLevels` curves, the shared
`CombatCoreScene` dispatch, the `EffectsRegistry` or the code-drawn icon
registry), and (c) adds a behaviour the existing nine weapons and eight
power-ups do **not** already cover. The pool deliberately mixes four weapons
and four power-ups so the arsenal grows on both axes.

**Engine-constraint validation.** Each concept was reviewed against the epic's
constraints before selection:

- **Neon-vector, code-drawn graphics only** — every new drop gets a code-drawn
  icon in `src/powerups/icons.ts`; no external art (GDD §7.2).
- **Gym↔game parity** — any concept that changes enemy or projectile behaviour
  proposes shared-core code in `src/scenes/core/` (or a shared pure policy),
  never a per-scene copy; the duplicate-body guard in
  `src/scenes/core/CombatScene.equivalence.test.ts` enforces it.
- **80 BPM beat grid** — every new weapon fires on an exact subdivision or
  whole-beat multiple (AH-0MUAYB8EH005RJ8B); `isOnBeatGrid` is the
  catalogue-wide invariant.
- **Weapons are cumulative and timed (10 s)**; **power-ups split
  temporary/permanent** (AH-0MUX802450085VZZ).
- **Every item carries a level curve** — a weapon needs `WEAPON_UPGRADE_SPECS`
  entries, a power-up needs `POWER_UP_LEVEL_SPECS` entries, on the single
  shared `src/utils/curve.ts` curve.
- **Data-driven catalogue + drop weights** — tuning is data in
  `src/utils/weapons.ts` / `src/powerups/types.ts` and `src/core/rules.ts`.
- **"Enemies are the bullets" (GDD §2.4), no enemy–enemy collisions (GDD §2.6)**
  and a **top-down free-2D arena** bound any enemy-behaviour power-up.

Concepts whose core mechanic is incompatible with these constraints (a
momentum ram, a terrain grid, an isometric hop, a rotating ring shield) are
recorded in "Considered but not selected".

---

## Weapons

### 1. R-Type wave laser — piercing beam

**Source game:** *R-Type* (Irem, 1987).

**Original behaviour:** The player charges and fires a "Wave Cannon" — a long
horizontal beam that punches straight through enemies instead of stopping on
the first hit, with a charge meter that grows the beam.

**AI_Hell adaptation:** A single, wide, slow neon beam projectile fired ahead
of the ship that **passes through every enemy it overlaps**, damaging each one
once, rather than being destroyed on the first contact. Range is long
(`bulletLifetime`-driven) and the fire cadence is deliberately slow so the beam
reads as a committed, aimed shot. It does not clear enemy bullets (that stays
Nova/Arc/Bomb territory) so it does not eclipse the AOE family.

**Divergence from original:** No charge meter — AI_Hell's weapons are
cumulative pickups on the beat grid rather than chargeable, so the beam is a
fixed cadence. It is a travelling beam rather than an instant screen-spanning
beam, so the "pierce everything it reaches" behaviour stays positional and
readable in free 2D.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'wave_laser'`; a new `WEAPON_CATALOGUE` entry with a single `[0]`
  offset pattern (the beam is aimed along the ship's heading).
- Fire subdivision: **1 shot per beat** (`1` in `DEFAULT_WEAPON_SUBDIVISIONS` →
  750 ms at 80 BPM), on the shared grid.
- Seam: **new shared combat-core dispatch seam.** The catalogue currently only
  expresses area effects through `AoEDescriptor`; pass-through hitting needs a
  new optional per-bullet `piercing` field read by the shared player-bullet
  collision path in `CombatCoreScene`, which tracks already-hit enemies so each
  is damaged once. No `AoEDescriptor` is used. Shared core = gym↔game parity by
  construction.
- `weaponLevels.ts` variables: **Piercing** (`piercing`, 0 → 5, k=0.25 — the
  planned variable this weapon exists to exercise), **Fire rate** (`fireRate`,
  MVP), **Bullet size** (`bulletSize`, MVP) and **Damage** (`damage`).

**Balance / coverage:** The first weapon that rewards line-ups through a
crowd rather than area coverage; it cannot clear bullets and cannot hit around
corners, and its slow cadence keeps it from dominating Rapid or the AOE family.
Intended rarity: standard weapon weight.

**Gym scene:** `GymWeapons` (weapon drops plus the inert practice targets) —
the beam visibly passes through all three targets, demonstrating piercing and
weapon-level growth in the same shared core the game runs.

---

### 2. Centipede ricochet shot — edge-bouncing bullet

**Source game:** *Centipede* (Atari, 1981).

**Original behaviour:** The player's shot travels up the screen; in later
home conversions it can bounce off the playfield edges, letting a shot reach
enemies it would otherwise miss.

**AI_Hell adaptation:** A player bullet that **reflects off the arena edges**
instead of wrapping (the default Asteroids wrap model), continuing to damage
enemies for a small number of bounces before expiring. The existing catalogue
`cannon` bullet wraps; the ricochet bullet bounces, which makes it a distinct
"bank shot" tool for the top-down arena.

**Divergence from original:** Documented divergence from the bullet wrap rule
(GDD §2.4): a ricochet bullet **reflects** while it has bounces remaining and
then expires rather than wrapping forever. The bounce count keeps the total
on-screen lifetime bounded, so the departure from wrap cannot saturate the
field.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'ricochet'`; a new `WEAPON_CATALOGUE` entry with a single `[0]`
  offset pattern.
- Fire subdivision: **1 shot per beat** (`1` → 750 ms at 80 BPM), on the shared
  grid.
- Seam: **new shared combat-core dispatch seam.** A boundary-reflection update
  on the shared player-bullet step (reflect velocity component at the arena
  edge; decrement the bounce count; expire at zero), read from a new optional
  `bounce` field on `WeaponDefinition`. No `AoEDescriptor`; the seam lives in
  shared core so game and gyms bounce identically.
- `weaponLevels.ts` variables: **Bounce** (`bounce`, 0 → 4, k=0.25 — the
  planned variable this weapon exercises), **Fire rate** (`fireRate`, MVP),
  **Bullet size** (`bulletSize`, MVP) and **Damage** (`damage`).

**Balance / coverage:** Bank shots reward positioning and are hard to aim, so
the weapon is a skill expression; a low bounce cap prevents perpetual
wall-ping bullets. Intended rarity: standard weapon weight.

**Gym scene:** `GymWeapons` — the practice targets and the arena edges make
each bank visible; leveling adds bounces on the same shared update the game
uses.

---

### 3. Missile Command cluster/MIRV missile — splitting warheads

**Source game:** *Missile Command* (Atari, 1980).

**Original behaviour:** Incoming ICBMs arc down toward the cities; the smart
bomb / MIRV variants split into multiple independent warheads mid-flight,
forcing the player to intercept several targets at once.

**AI_Hell adaptation:** A slow player missile that flies ahead of the ship and,
**on expiry or impact, splits into a small radial cluster of warheads**, each
of which damages enemies it overlaps and expires. It is the offensive
counterpart of the Mortar (which detonates a random *area*): the MIRV spreads
damage across several *points* along its flight path, rewarding lead-aim into a
formation.

**Divergence from original:** No ground/city target model and no inbound arcing
ICBM — the MIRV is the player's own projectile, and the cluster is a radial
spray of short-lived warheads rather than independent tracking warheads.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'cluster_missile'`; a new `WEAPON_CATALOGUE` entry with a single
  `[0]` offset pattern.
- Fire subdivision: **1 shot every 2 beats** (`0.5` → 1500 ms at 80 BPM), on
  the shared grid — the slower cadence the split payload pays for.
- Seam: **new shared combat-core split dispatch seam**, reusing the
  **`AoEDescriptor` `'onImpact'` trigger** that is already retained in
  `src/utils/weapons.ts` for exactly this kind of future projectile: the
  descriptor launches the shell and, at expiry/impact, a new shared split step
  spawns `splitCount + 1` warheads. The split step lives in shared core so game
  and gyms agree on fragment count and spread.
- `weaponLevels.ts` variables: **Split** (`splitCount`, 0 → 3, k=0.20 — the
  planned variable this weapon exercises), **Area** (`aoeRadius`, MVP; scales
  the cluster spread radius), **Fire rate** (`fireRate`, MVP) and **Damage**
  (`damage`).

**Balance / coverage:** Spreads damage rather than concentrating it, so a
single warhead is weak; the slow cadence and fragment cap bound total output.
Distinct from Mortar (random area detonation) and Arc (chained single targets).
Intended rarity: standard weapon weight.

**Gym scene:** `GymWeapons` — the three practice targets show the split
cluster landing across targets; the shared split step is the same code the game
runs.

---

### 4. Gradius Options orbiting satellites — companion emitters

**Source game:** *Gradius* (Konami, 1985).

**Original behaviour:** Collecting "Options"/"Multiple" power-ups adds trailing
satellite pods that mirror the ship's position and each fire a shot along the
ship's heading, multiplying firepower without changing the main gun.

**AI_Hell adaptation:** Collecting the weapon adds **two neon satellite pods
that orbit the ship** (a shallow, readable circle). Each pod fires its own
bullet along the ship's current heading on the weapon's beat subdivision, so
the weapon's damage scales with positioning and the ship's facing. The pods are
visual entities owned by the shared player/bullet layer, not new enemy types.

**Divergence from original:** The original pods trail directly behind the ship;
AI_Hell orbits them so the top-down free-2D player can see and steer them, and
so their firing lines differ from the main gun. No ship-upgrade path — the pods
are a timed cumulative weapon like Spread/Dual/Rapid.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'options'`; a new `WEAPON_CATALOGUE` entry. The pods are modelled
  through a new optional orbit-emitter descriptor rather than `offsets`, because
  the emitters are positional entities rather than one-shot angle offsets.
- Fire subdivision: **1 shot per beat** (`1` → 750 ms at 80 BPM), on the shared
  grid; the pods and the active main guns stay phase-locked.
- Seam: **new shared combat-core dispatch seam.** A shared orbit-emitter update
  in `CombatCoreScene` maintains each pod's angle and fires from its world
  position through the same `PlayerBullet` path; no new `AoEDescriptor`. Living
  in shared core means `PlayScene` and every gym render and fire identical pods.
- `weaponLevels.ts` variables: **Projectiles** (`projectileCount`, MVP; extra
  pods beyond the base two, capped to keep the orbit legible), **Fire rate**
  (`fireRate`, MVP), **Bullet size** (`bulletSize`, MVP) and **Homing**
  (`homing`, late-game curve of the pod shots).

**Balance / coverage:** Pods multiply effective firepower, so the base is two
pods, the pod bullet is weaker/smaller than the cannon's, and the orbit keeps
the firing lines distinct from the main gun. It is the first weapon whose DPS
depends on the ship's heading rather than a static pattern. Intended rarity:
standard weapon weight.

**Gym scene:** `GymWeapons` — the orbiting pods and their beat-locked fire are
visible around the ship; the shared emitter update is identical in the game.

---

## Power-ups

### 5. Pac-Man power pellet — frightened enemies

**Source game:** *Pac-Man* (Namco, 1980).

**Original behaviour:** Eating a power pellet turns the four ghosts blue and
frightened for a timed window: they reverse, flee the player and (in AI_Hell's
translation) stop attacking, while the player can destroy them.

**AI_Hell adaptation:** A timed field power-up that puts every live enemy into a
**frightened state for a short window**: enemies flee the player instead of
approaching and **stop firing** (their weapon fire is suppressed for the
window). Frightened enemies are still lethal on body contact (the "enemies are
the bullets" rule is unchanged — the player must still dodge), so the power-up
is a breathing-space and repositioning tool rather than an instant board clear.

**Divergence from original:** No maze, no ghost house, no "eat the ghost for
points" mechanic and no per-ghost personality — the state is a uniform timed
debuff on all live enemies. Enemy–enemy collisions remain disabled (GDD §2.6);
fleeing enemies pass through one another.

**Type:** power-up.

**Pipeline fit:**

- `PowerUpId`: `'power_pellet'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **timed** — a single field pickup applies a temporary window (the
  frightened state is cleared when the window expires). A hold-full reward
  raises the permanent level, extending the window, matching the
  temporary/permanent split (AH-0MUX802450085VZZ).
- `powerUpLevels.ts` variables: **Frighten time** (`frightenDuration`, base 6 s
  → cap 14 s, k=0.2) and **Frighten flee** (`frightenSpeedMultiplier`, base 1×
  → cap 1.8×, k=0.2) — a new `PowerUpLevelVariable` pair.
- Code-drawn icon: a glowing neon pellet ring (a small circle with an outer
  glow arc) added to `src/powerups/icons.ts`.
- `powerUpWeights` drop weight: **3** (rarer than standard 4 — the state is a
  strong defensive tool) in `src/core/rules.ts`.
- Seam: **new shared combat-core enemy-status seam** in `src/scenes/core/`
  (a shared frightened timer plus a flee-steering policy) so the state behaves
  identically in `PlayScene` and every gym, enforced by the duplicate-body
  guard.

**Balance / coverage:** The first enemy-behaviour power-up. The flee window is
short and does not make enemies harmless (body contact still kills), and it
does not clear bullets, so it complements Bomb/Shield rather than replacing
them.

**Gym scene:** `GymPowerUpsCombat` (live scout threats) — the frightened flee
and fire suppression are observable against real enemies, running the shared
status seam.

---

### 6. Defender smart bomb — screen-wide pulse

**Source game:** *Defender* (Williams, 1980); shared with *Robotron: 2084*
(Williams, 1982).

**Original behaviour:** The smart bomb detonates instantly, destroying every
enemy and clearing bullets on screen — the ultimate panic button, but limited
in supply.

**AI_Hell adaptation:** A power-up that fires **one screen-wide pulse**: it
clears every enemy bullet on screen and deals a single hit to every enemy
(so 1 HP regulars die, multi-hit enemies lose one health). It is deliberately
sharper than the existing Bomb (which clears bullets only and never damages
enemies) but is a one-shot stored/periodic effect rather than a persistent
weapon.

**Divergence from original:** The pulse clears bullets *and* deals exactly one
hit rather than destroying all enemies outright, so the Harvester (5 HP) and
the boss survive it — the "enemies are the bullets" balance guardrail is
preserved. No supply counter; the supply is the temporary/permanent level
model.

**Type:** power-up (the weapon-form smart bomb is deferred — see below).

**Pipeline fit:**

- `PowerUpId`: `'smart_bomb'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **stored**, auto-triggered on pickup as a single pulse when
  collected as a field drop; a hold-full reward raises the permanent level and
  the pulse repeats on a levelled interval (permanent), mirroring the Bomb's
  single-explosion vs periodic-pulse design.
- `powerUpLevels.ts` variables: **Pulse damage** (`smartBombDamage`, base 1 →
  cap 3, k=0.3) and **Pulse rate** (`smartBombFrequency`, base 0.2/s → cap
  0.5/s, k=0.3, used only when permanent) — a new `PowerUpLevelVariable` pair.
- Code-drawn icon: a neon starburst inside a ring (added to
  `src/powerups/icons.ts`).
- `powerUpWeights` drop weight: **2** (rare — the strongest defensive pickup)
  in `src/core/rules.ts`.
- Seam: **new shared combat-core dispatch seam** — a screen-wide once-per-
  activation pulse (clear all enemy bullets + one hit to every enemy) hoisted
  into the shared core so the game and every gym resolve it identically; the
  AOE `AoEDescriptor` is radius-bound and is not reused for a screen-wide
  effect.

**Balance / coverage:** Does not destroy multi-hit enemies, keeps the Bomb
distinct (Bomb = bullets only, Smart Bomb = bullets + one hit) and is the
rarer of the two, so the existing catalogue is not made redundant.

**Gym scene:** `GymPowerUpsCombat` (live threats and enemy bullets) — the
bullet clear and the single-hit enemy damage are both observable.

---

### 7. Gradius force field — bullet reflector

**Source game:** *Gradius* (Konami, 1985).

**Original behaviour:** The "Force Field" shield protects the ship and deflects
incoming enemy shots; in several Gradius entries the shield visibly bounces
enemy bullets away.

**AI_Hell adaptation:** A timed defensive bubble that **reflects enemy bullets
back toward their source** as player-owned bullets (turning the enemy's own
fire against it) and absorbs body contact while active. It differs from the
existing Shield (which silently absorbs hits) by making the reflected bullets
an offensive resource — a defensive tool with a skill ceiling tied to enemy
positioning.

**Divergence from original:** Only enemy *bullets* are reflected; enemy bodies
still deal contact damage through the normal Shield-style absorption path. The
bubble is a timed power-up rather than an equipped upgrade.

**Type:** power-up.

**Pipeline fit:**

- `PowerUpId`: `'force_field'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **timed** — a field pickup grants the bubble for its duration and
  refreshes on re-collection; a hold-full reward raises the permanent level,
  extending duration and the number of reflections, matching the
  temporary/permanent split.
- `powerUpLevels.ts` variables: **Field time** (`forceFieldDuration`, base 8 s
  → cap 18 s, k=0.15) and **Field reflects** (`forceFieldReflects`, base 3 →
  cap 10, k=0.25) — a new `PowerUpLevelVariable` pair.
- Code-drawn icon: a hexagonal neon bubble with arrow motifs (added to
  `src/powerups/icons.ts`).
- `powerUpWeights` drop weight: **4** (standard) — the bubble is bounded by its
  reflection count and duration.
- Seam: **new shared combat-core dispatch seam** — a per-bullet reflection
  handler in the shared player-vs-enemy-bullet collision path that re-parents
  the bullet as a player bullet along the reflection vector; it lives in shared
  core so game and gyms reflect identically.

**Balance / coverage:** The reflection count is capped and the bubble expires,
so it cannot become perpetual cover; reflection reuses the enemy bullet's speed
so it is not a damage multiplier by itself. It is distinct from Shield
(absorbs only) and Bomb (clears only).

**Gym scene:** `GymPowerUpsCombat` (live threats with enemy fire) — reflected
bullets are clearly visible turning back on the scouts; `GymWeapons` is not
needed because the behaviour is defensive, not a weapon pattern.

---

### 8. Space Invaders mystery UFO — bonus pickup

**Source game:** *Space Invaders* (Taito, 1978).

**Original behaviour:** A red "mystery" UFO crosses the top of the screen at
random intervals; shooting it awards a large, hidden points bonus (50–300
points), making it a high-value target of opportunity.

**AI_Hell adaptation:** A rare, short-lived **bonus pickup** that occasionally
crosses the arena (as an inert, collectible drop) and grants a burst of
minerals (feeding the ship's hold and the hold-full power-up choice) plus a
score bonus when collected. It translates the "shoot the mystery ship for a
surprise reward" loop into a collectible that rewards the player for leaving
their lane.

**Divergence from original:** AI_Hell's drop pipeline is collection-based, not
shooting-based, so the UFO is a moving field drop the player flies into rather
than an enemy to shoot. The reward is a burst of **minerals and score** rather
than a pure points value, so it feeds the existing economy and choice system.

**Type:** power-up.

**Pipeline fit:**

- `PowerUpId`: `'mystery_ufo'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **permanent** — the bonus is applied immediately on collection and
  never expires; each pickup levels the power-up and increases the mineral and
  score burst, matching the permanent reward path.
- `powerUpLevels.ts` variables: **Bonus minerals** (`mysteryUfoMinerals`, base
  2 → cap 6, k=0.3) and **Bonus score** (`mysteryUfoScore`, base 250 → cap
  1500, k=0.3) — a new `PowerUpLevelVariable` pair.
- Code-drawn icon: a classic neon flying saucer (added to
  `src/powerups/icons.ts`).
- `powerUpWeights` drop weight: **3** (rarer than standard 4 — it is a bonus,
  not a combat tool) in `src/core/rules.ts`.
- Seam: **catalogue entry plus the `EffectsRegistry`** — the reward routes
  through the shared effects registry (minerals into the ship's hold, score
  into the run total); no new combat-core dispatch seam is needed.

**Balance / coverage:** Purely economic, so it cannot trivialise combat; the
mineral burst is capped and the drop is rare, so it accelerates the hold-full
choice without flooding it.

**Gym scene:** `GymPowerUpsUtility` (threat-free drop gym with a live mineral
field) — the mineral burst and the hold progression are observable, and the
shared `EffectsRegistry` path is the same one the game runs.

---

## Considered but not selected

The following candidates were reviewed as part of the research pool but do not
fit AI_Hell's current engine constraints or the top-down free-2D arena well
enough to warrant a child work item in this round. Each is recorded with a
one-line deferral reason so the pool can be revisited.

| Candidate | Deferral reason |
|-----------|-----------------|
| **Galaga Dual Fighter** | A trailing escort ship that doubles the main gun requires a persistent companion-entity lifecycle and a second hitbox; the Options weapon already covers "add firepower that follows the ship", so this is deferred as redundant for now. |
| **Defender / Robotron smart bomb weapon form** | A screen-wide enemy-clearing *weapon* (as opposed to the timed power-up chosen here) makes every regular enemy obsolete the moment it is equipped and would eclipse Nova/Mortar/Arc, so the pulse is scoped as the rarer Smart Bomb power-up only; the weapon form is deferred on balance grounds. |
| **Tempest Superzapper** | Another screen-wide "damage every enemy once" pulse duplicates the Smart Bomb power-up's effect, so it is deferred as redundant. |
| **Sinistar Sinibomb** | A stored-ammo consumable needs a new ammo-count seam and a manual-fire input; AI_Hell auto-fires and has no per-weapon ammo model, so the stored-ammo mechanic is deferred until that seam exists. |
| **Galaga Repulsor** | A player-side repulsor that pushes enemies and bullets away changes shared enemy/bullet steering and overlaps Force Field's reflection role; it is deferred to avoid two near-identical defensive fields. |
| **Frogger Super Leap** | A timed invulnerability/dash across a hazard lane is effectively Phase Shift (already shipped) plus a teleport; deferred as an existing capability rather than a new one. |
| **Asteroids Decoy** | A decoy that draws enemy fire needs enemy targeting to be re-pointed at a second entity, which the "enemies are the bullets" model and the no-enemy-collision rule do not support cleanly; deferred pending a targeting seam. |
| **Gauntlet Potion** | A "clear nearby threats on pickup" burst is a smaller Bomb + Smart Bomb; it would make both the existing Bomb and the new Smart Bomb redundant, so it is deferred on coverage grounds. |

---

## Pipeline-fit summary

| Concept | Type | Catalogue seam | Beat subdivision | New dispatch seam? | Level variables (`weaponLevels` / `powerUpLevels`) | Gym scene(s) |
|---------|------|----------------|------------------|--------------------|----------------------------------------------------|--------------|
| R-Type wave laser | weapon | `WeaponId: 'wave_laser'` / `WEAPON_CATALOGUE` | 1/beat (750 ms) | New shared piercing-collision seam | `piercing`, `fireRate`, `bulletSize`, `damage` | `GymWeapons` |
| Centipede ricochet shot | weapon | `WeaponId: 'ricochet'` / `WEAPON_CATALOGUE` | 1/beat (750 ms) | New shared bullet-bounce seam | `bounce`, `fireRate`, `bulletSize`, `damage` | `GymWeapons` |
| Missile Command cluster/MIRV missile | weapon | `WeaponId: 'cluster_missile'` / `WEAPON_CATALOGUE` | 1 shot / 2 beats (1500 ms) | New shared split seam, reuses `AoEDescriptor` `'onImpact'` | `splitCount`, `aoeRadius`, `fireRate`, `damage` | `GymWeapons` |
| Gradius Options orbiting satellites | weapon | `WeaponId: 'options'` / `WEAPON_CATALOGUE` | 1/beat (750 ms) | New shared orbit-emitter seam | `projectileCount`, `fireRate`, `bulletSize`, `homing` | `GymWeapons` |
| Pac-Man power pellet | power-up | `PowerUpId: 'power_pellet'` / `POWER_UP_CATALOGUE` | — | New shared enemy-status (frightened) seam | `frightenDuration`, `frightenSpeedMultiplier` | `GymPowerUpsCombat` |
| Defender smart bomb | power-up | `PowerUpId: 'smart_bomb'` / `POWER_UP_CATALOGUE` | — | New shared screen-wide pulse seam | `smartBombDamage`, `smartBombFrequency` | `GymPowerUpsCombat` |
| Gradius force field | power-up | `PowerUpId: 'force_field'` / `POWER_UP_CATALOGUE` | — | New shared bullet-reflection seam | `forceFieldDuration`, `forceFieldReflects` | `GymPowerUpsCombat` |
| Space Invaders mystery UFO | power-up | `PowerUpId: 'mystery_ufo'` / `POWER_UP_CATALOGUE` | — | None — catalogue entry + `EffectsRegistry` | `mysteryUfoMinerals`, `mysteryUfoScore` | `GymPowerUpsUtility` |

**Existing seams reused without modification:** `WeaponDefinition.offsets` /
`sideOffsets`, `AoEDescriptor` (`'onImpact'` retained for the MIRV), the
`EffectsRegistry`, the shared `curve.ts` exponential-saturation curve, the
`WeightedRandomSpawner` drop pipeline and `src/powerups/icons.ts`.

**New seams to be created (per child work item):** shared piercing-collision,
shared bullet-bounce, shared missile-split, shared orbit-emitter, shared
frightened-enemy status, shared screen-wide pulse and shared bullet-reflection
— all in `src/scenes/core/` (or shared pure policies alongside it) so the game
and every gym run the same code.

---

## Gym-parity coverage summary

| Gym scene | Concepts exercised |
|-----------|--------------------|
| `GymWeapons` | R-Type wave laser, Centipede ricochet shot, Missile Command cluster/MIRV missile, Gradius Options orbiting satellites |
| `GymPowerUpsCombat` | Pac-Man power pellet, Defender smart bomb, Gradius force field |
| `GymPowerUpsUtility` | Space Invaders mystery UFO |
| `GymFormationScene`-derived gyms | Formations remain the parity venue for enemy-behaviour changes; the frightened-enemy state must run in the shared core they inherit |

No new gym scene is required: each concept maps onto an existing tuning gym,
and each enemy/projectile behaviour change is implemented in shared core so the
game and the gyms cannot diverge.

---

## Child work items

Each selected concept has its own child work item that implements the full
lifecycle (catalogue/config entry + level-curve variables + code + tests + gym
parity + docs). All children reference this document as their design brief.

| Concept | Child work item |
|---------|-----------------|
| R-Type wave laser | AH-0MV1BIUSJ0090W92 |
| Centipede ricochet shot | AH-0MV1BIV5L005NJAI |
| Missile Command cluster/MIRV missile | AH-0MV1BIVIJ007KYXU |
| Gradius Options orbiting satellites | AH-0MV1BIVVK0043TEM |
| Pac-Man power pellet | AH-0MV1BIW95004POSX |
| Defender smart bomb | AH-0MV1BIWP9003EHRQ |
| Gradius force field | AH-0MV1BIX1W006XF95 |
| Space Invaders mystery UFO | AH-0MV1BIXFO006Z1I7 |
| Documentation integration | AH-0MV1BIXSH000JLN0 |

---

*Document created as part of AH-0MV1BIUGE005BJO8. Cross-linked from
`docs/Game Design Document.md` §4.4.*
