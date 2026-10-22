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

> **Removal note (AH-0MV5CB6KO0079N08):** one of the eight selected concepts,
the **Pac-Man power pellet**, has since been removed from the game. Its entry
below (§5) records the removal, the reason and the recovery path; the other
seven concepts remain shipped.

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
"bank shot" tool for the top-down arena. **In-flight identity (AH-0MV822AP1006W2F9):**
the shot renders as a neon **teardrop/streak pellet** with a short fading trail
and a white neon rim (visual metadata on `WeaponDefinition`, drawn through the
shared bullet-shape seam), fires with a bright springy ping + green launch flash,
and plays a brief green edge-flash + soft bounce tick through the shared impact
seam on every wall reflection — so the bank shot is legible and audible even
when it misses.

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
**In-flight identity (AH-0MV822B1B0048UZT):** the shell renders as a neon
**small missile with a flickering exhaust flame** (the shared missile shape
honouring `bulletRim`/`bulletFlame`/`bulletTrail` visual metadata), fires with a
baked low launch whoosh + magenta launch puff, splits into **small disc
warheads**, and every warhead connect plays the baked cluster detonation thump
+ hot-pink impact flash through the shared impact seam — so the payload is
legible and audible in flight and on contact, with no behaviour change.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'cluster'` (`'Cluster Missile'`); a new `WEAPON_CATALOGUE` entry with a single `[0]` offset pattern.
- Fire subdivision: **1 shot every 2 beats** (`0.5` → 1500 ms at 80 BPM), on
  the shared grid — the slower cadence the split payload pays for.
- Seam: **new shared combat-core split dispatch seam** in
  `src/scenes/core/CombatCoreScene.ts` (`splitProjectile`), reading a neutral
  `WeaponDefinition.splits` field. This is deliberately **not** an
  `AoEDescriptor`: the split is a projectile seam, not an area effect. The
  shared core tags the spawned shell, and at expiry/impact it splits it once
  into `splits` radial warheads (each an ordinary player bullet that damages
  enemies on contact) and spawns the shared split-burst VFX. The warheads fan
  **evenly around the full 360° circle** with a constant **+90° phase offset**
  from the parent heading — the base count of 2 splits to **90°/270°**
  (perpendicular to the direction of travel, never straight ahead or 180°
  backwards), and each extra warhead divides the circle evenly (count 3 →
  90°/210°/330°). The seam lives in
  shared core so game and gyms agree on fragment count and spread.
- `weaponLevels.ts` variables: **Split** (`splitCount`, base 0 → cap 3,
  k=0.20 — the planned variable this weapon exercises, growing the effective
  warhead count from the base 2 toward the cap — always divided **evenly**
  around the full 360° circle with a constant +90° phase offset), **Fire rate** (`fireRate`,
  MVP) and **Damage** (`damage`).

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
bullet **radially outward** along its current orbit direction (the ship→pod
line, in the direction of the orb) on the weapon's beat subdivision, so a
volley fans into a rotating spike/flower pattern and the weapon's damage scales
with positioning and the orbit phase rather than the ship's facing. The 2000 ms
orbit is deliberately not a whole multiple of the 750 ms fire interval (0.375
revolutions per trigger), so consecutive volleys aim differently and the spread
stays alive (`isOptionsOrbitTriggerAligned`). The pods are visual entities
owned by the shared player/bullet layer, not new enemy types.

**Divergence from original:** The original pods trail directly behind the ship
and mirror its heading; AI_Hell orbits them so the top-down free-2D player can
see and steer them, and each pod fires **radially outward along its own orbit
direction** instead of the ship's heading, so their firing lines fan
independently of the main gun. No ship-upgrade path — the pods are a timed
cumulative weapon like Spread/Dual/Rapid.
**In-flight identity (AH-0MV822BDN008IYL6):** each pod shot renders as a neon
**small pod dart** (the shared `chevron` family the catalogue assigns to the
Options) with its own **pale-aqua rim tint and a short faint fading trail**, so
the rotating volley reads as the escort's shots, never as the main gun's cyan
disc. The volley fires with a baked bright soft-tone cue + aqua launch flash,
and every pod-shot connect plays the baked soft-aqua hit pop + aqua impact
flash through the shared impact seam — with no behaviour change.

**Type:** weapon.

**Pipeline fit:**

- `WeaponId`: `'options'`; a new `WEAPON_CATALOGUE` entry. The pods are modelled
  through a new optional orbit-emitter descriptor rather than `offsets`, because
  the emitters are positional entities rather than one-shot angle offsets.
- Fire subdivision: **1 shot per beat** (`1` → 750 ms at 80 BPM), on the shared
  grid; the pods and the active main guns stay phase-locked.
- Seam: **new shared combat-core dispatch seam.** A shared orbit-emitter update
  in `CombatCoreScene` maintains each pod's angle and fires radially outward
  from its world position through the same `PlayerBullet` path; the pure
  geometry and the orbit-vs-trigger invariant live in `optionsEscort.ts`
  (`optionsPodFireDirections`, `isOptionsOrbitTriggerAligned`); no new
  `AoEDescriptor`. Living in shared core means `PlayScene` and every gym render
  and fire identical pods.
- `weaponLevels.ts` variables: **Projectiles** (`projectileCount`, MVP; extra
  pods beyond the base two, capped to keep the orbit legible), **Fire rate**
  (`fireRate`, MVP), **Bullet size** (`bulletSize`, MVP) and **Homing**
  (`homing`, late-game curve of the pod shots).

**Balance / coverage:** Pods multiply effective firepower, so the base is two
pods, the pod bullet is weaker/smaller than the cannon's, and each volley's
radial spread keeps the firing lines distinct from the main gun. Its DPS
depends on the orbit phase rather than a static pattern or the ship's heading.
Intended rarity: standard weapon weight.

**Gym scene:** `GymWeapons` — the orbiting pods and their beat-locked fire are
visible around the ship; the shared emitter update is identical in the game.

---

## Power-ups

### 5. Pac-Man power pellet — REMOVED

**Status: removed from the game (2026-10-12, AH-0MV5CB6KO0079N08).**

**Source game:** *Pac-Man* (Namco, 1980).

**Original behaviour:** Eating a power pellet turns the four ghosts blue and
frightened for a timed window: they reverse, flee the player and stop
attacking, while the player can destroy them.

**AI_Hell adaptation (historical):** A timed field power-up that put every live
enemy into a **frightened state for a short window**: enemies fled the player
instead of approaching and **stopped firing**; ramming a frightened enemy
**destroyed it without damaging the ship**. Enemy bullets were **not** cleared,
so the power-up was a breathing-space and repositioning tool rather than an
instant board clear. It was the first **enemy-behaviour** power-up.

**Reason for removal:** The producer decided the fright mechanic was no longer
wanted and that it should be removed **wholesale** rather than hidden or
retained (intake decision Q1=A, Q3="See 1"): the catalogue entry, drop weight,
hold-full choice entry, level specs, HUD/icon surfaces, competent-bot valuation
and the entire shared **frightened-enemy status layer**
(`src/scenes/core/frightenedState.ts`, the `EffectsRegistry` fright accessors,
the combat-core flee/suppression hooks and the `fireForEnemy` suppression
parameter) were deleted in one change. Multi-step options (player-only with
documented gym divergence; disabled-by-default retaining the code) were
rejected because they would have left a half-removed feature and a divergent
gym.

**Recovery:** No git-history rewrite — the feature and its tests were deleted
in the normal way (original feature AH-0MV1BIW95004POSX; captured-flee-heading
refinement AH-0MV4BXUWT005MWAJ), so git history remains the recovery path if a
future power-up needs the mechanic.

**Unaffected:** The Pac-Man **ghost enemy family** (`src/entities/Ghost.ts`,
`src/scenes/core/ghostSteering.ts`, `src/waves/GhostSpawner.ts` and the
`ghost-chase`/`ghost-ambush`/`ghost-flank`/`ghost-wander` configs) is a separate
archetype and never depended on the fright layer; its personality steering and
scatter/chase cycle are unchanged.

**Type:** power-up (removed).

---

### 6. Defender smart bomb — ship-centred pulse

**Source game:** *Defender* (Williams, 1980); shared with *Robotron: 2084*
(Williams, 1982).

**Original behaviour:** The smart bomb detonates instantly, destroying every
enemy and clearing bullets on screen — the ultimate panic button, but limited
in supply.

**AI_Hell adaptation:** A power-up that fires **one ship-centred pulse within
a modest radius**: it clears every enemy bullet in range and deals a single
hit to every enemy in range (so 1 HP regulars die, multi-hit enemies lose one
health). It is deliberately sharper than the existing Bomb (which clears
bullets only and never damages enemies) but is a one-shot stored/periodic
effect rather than a persistent weapon. Re-balanced in AH-0MV8GPGBL009M0D8:
a rare panic-button clear (variables below), never a continuous screen wipe.

**Divergence from original:** The pulse clears bullets *and* deals exactly one
hit rather than destroying all enemies outright, so the Harvester (5 HP) and
the boss survive it — the "enemies are the bullets" balance guardrail is
preserved — and its finite radius means enemies beyond it are unaffected. No
supply counter; the supply is the temporary/permanent level model.

**Type:** power-up (the weapon-form smart bomb is deferred — see below).

**Pipeline fit:**

- `PowerUpId`: `'smart_bomb'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **stored**, auto-triggered on pickup as a single pulse when
  collected as a field drop; a hold-full reward raises the permanent level and
  the pulse repeats on a levelled interval (permanent), mirroring the Bomb's
  single-explosion vs periodic-pulse design.
- `powerUpLevels.ts` variables: **Pulse radius** (`aoeRadius`, **200 → 400 px**,
  linear-clamped, +2 % of base per level — 10 × SHIP_SIZE base, never
  spanning the 960×540 field), **Pulse damage** (`smartBombDamage`, base 1 →
  cap 3, k=0.3) and **Pulse interval** (`smartBombInterval`, **30 → 10 s**,
  linear-clamped descending at −2 s per level, used only when permanent) — a
  new `PowerUpLevelVariable` trio.
- Code-drawn icon: a neon starburst inside a ring (added to
  `src/powerups/icons.ts`).
- `powerUpWeights` drop weight: **2** (rare — the strongest defensive pickup)
  in `src/core/rules.ts`.
- Seam: **reuses the existing `AoEDescriptor`/`AoETrigger` area seam** — a
  ship-centred `AoEDescriptor` (`trigger: 'screenPulse'`, `damagesEnemies:
  true`, `clearsEnemyBullets: true`, `damage`, `aoeRadius`), resolved by the
  shared `CombatScene.applyAoEDescriptor` used by Nova/Mortar/Arc, so the
  level-resolved radius keeps the pulse a local clear around the ship (no
  parallel area-effect implementation). The `'screenPulse'` `AoETrigger`
  value records the non-weapon, once-per-activation timing.

**Balance / coverage:** Does not destroy multi-hit enemies, keeps the Bomb
distinct (Bomb = bullets only, Smart Bomb = bullets + one hit) and is the
rarer pickup, so the catalogue is not made redundant.

**Gym scene:** `GymPowerUpsCombat` (live threats and enemy bullets) — the
bullet clear and the single-hit enemy damage are both observable.
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

**AI_Hell adaptation:** A rare reward that spawns a **visible collector drone**
— a small, code-drawn copy of the player ship. The drone seeks the nearest
mineral, vacuums any whose centre enters its collector radius, flies back to
the ship and pays the minerals into the hold. It translates the "shoot the
mystery ship for a surprise reward" loop into a friendly entity the player can
watch working for them.

**Divergence from original:** AI_Hell's drop pipeline is collection-based, not
shooting-based, so the UFO is a field drop the player flies into rather than an
enemy to shoot. The reward is **minerals ferried home** rather than a pure
points value, so it feeds the existing economy and choice system; the original
instant mineral/score bounty was retired with the visible-drone epic
(AH-0MV9G113S009B37I).

**Type:** power-up.

**Pipeline fit:**

- `PowerUpId`: `'mystery_ufo'`; a new `POWER_UP_CATALOGUE` entry.
- Semantics: **permanent level, one-shot spawn**. A field pickup spawns exactly
  one drone; a full-hull (permanent) reward keeps one spawning on the
  level-resolved interval for the rest of the run. There is no timed effect
  window and no stored consumable state.
- `powerUpLevels.ts` variables: **Drone lifetime** (`mysteryUfoLifetime`,
  5 → 8 s), **Drone capacity** (`mysteryUfoCapacity`, 10 → 20), **Collector
  radius** (`mysteryUfoRadius`, 20 → 40 px) and **Spawn interval**
  (`mysteryUfoSpawnInterval`, 30 → 12 s descending, permanent only), all on
  the shared curve (`k=0.3`). The retired instant-bounty `mysteryUfoMinerals`
  and `mysteryUfoScore` axes no longer exist.
- Destruction rule: an enemy bullet or an enemy body destroys the drone
  (the player's own fire passes through); it spills its held minerals plus a
  `2 × level` bonus at the crash site as collectable field minerals.
- Code-drawn icon: a classic neon flying saucer (added to
  `src/powerups/icons.ts`); the drone itself is a code-drawn scaled player
  ship (`src/entities/MysteryUfoDrone.ts`).
- `powerUpWeights` drop weight: **3** (rarer than standard 4 — it is a bonus,
  not a combat tool) in `src/core/rules.ts`.
- Seam: **catalogue entry plus the shared combat core** — the registry queues
  the spawn (`consumeMysteryUfoSpawns` / `isMysteryUfoPermanent`) and the
  shared `src/scenes/core/combatDrone.ts` pass spawns, ticks, pays out and
  tears the drone down for the game and every gym.

**Balance / coverage:** Purely economic, so it cannot trivialise combat; the
mineral payload is carried home rather than granted instantly, the hold
capacity caps a single sortie, and the drop is rare, so the drone accelerates
the hold-full choice without flooding it.

**Gym scene:** `GymPowerUpsUtility` (threat-free drop gym with a live mineral
field) — the drone's spawn → seek → collect → return → payout lifecycle and
the shared-core payout path are observable, identical to the game; destruction
is covered by the shared-core tests.

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
| **Tempest Superzapper** | Another screen-wide "damage every enemy once" pulse overlaps the Smart Bomb power-up's one-hit clear (whose ship-centred radius no longer spans the field), so it is deferred as redundant. |
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
| Missile Command cluster/MIRV missile | weapon | `WeaponId: 'cluster'` / `WEAPON_CATALOGUE` | 1 shot / 2 beats (1500 ms) | New shared split seam (`WeaponDefinition.splits`, not AoE) | `splitCount`, `fireRate`, `damage` | `GymWeapons` |
| Gradius Options orbiting satellites | weapon | `WeaponId: 'options'` / `WEAPON_CATALOGUE` | 1/beat (750 ms) | New shared orbit-emitter seam | `projectileCount`, `fireRate`, `bulletSize`, `homing` | `GymWeapons` |
| Pac-Man power pellet | power-up | — (removed, AH-0MV5CB6KO0079N08) | — | — (removed) | — (removed) | — (removed) |
| Defender smart bomb | power-up | `PowerUpId: 'smart_bomb'` / `POWER_UP_CATALOGUE` | — | Existing `AoEDescriptor`/`AoETrigger` seam (`screenPulse`) | `aoeRadius`, `smartBombDamage`, `smartBombInterval` | `GymPowerUpsCombat` |
| Gradius force field | power-up | `PowerUpId: 'force_field'` / `POWER_UP_CATALOGUE` | — | New shared bullet-reflection seam | `forceFieldDuration`, `forceFieldReflects` | `GymPowerUpsCombat` |
| Space Invaders mystery UFO | power-up | `PowerUpId: 'mystery_ufo'` / `POWER_UP_CATALOGUE` | — | Shared collector-drone pass (`scenes/core/combatDrone.ts`) | `mysteryUfoLifetime`, `mysteryUfoCapacity`, `mysteryUfoRadius`, `mysteryUfoSpawnInterval` | `GymPowerUpsUtility` |

**Existing seams reused without modification:** `WeaponDefinition.offsets` /
`sideOffsets`, `AoEDescriptor` (`'onImpact'` retained as the AOE projectile
path), the `EffectsRegistry`, the shared `curve.ts` exponential-saturation
curve, the `WeightedRandomSpawner` drop pipeline and `src/powerups/icons.ts`.

**New seams to be created (per child work item):** shared piercing-collision,
shared bullet-bounce, shared missile-split, shared orbit-emitter, shared
ship-centred `screenPulse` and shared bullet-reflection — all in `src/scenes/core/` (or
shared pure policies alongside it) so the game and every gym run the same code.
(The shared frightened-enemy status seam was created with the Pac-Man power
pellet and deleted with it in AH-0MV5CB6KO0079N08.)

---

## Gym-parity coverage summary

| Gym scene | Concepts exercised |
|-----------|--------------------|
| `GymWeapons` | R-Type wave laser, Centipede ricochet shot, Missile Command cluster/MIRV missile, Gradius Options orbiting satellites |
| `GymPowerUpsCombat` | Defender smart bomb, Gradius force field |
| `GymPowerUpsUtility` | Space Invaders mystery UFO |
| `GymFormationScene`-derived gyms | Formations remain the parity venue for enemy-behaviour changes; any such state must run in the shared core they inherit |

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
| Pac-Man power pellet — **removed** (AH-0MV5CB6KO0079N08) | AH-0MV1BIW95004POSX |
| Defender smart bomb | AH-0MV1BIWP9003EHRQ |
| Gradius force field | AH-0MV1BIX1W006XF95 |
| Space Invaders mystery UFO | AH-0MV1BIXFO006Z1I7 |
| Documentation integration | AH-0MV1BIXSH000JLN0 |

---

*Document created as part of AH-0MV1BIUGE005BJO8. Cross-linked from
`docs/Game Design Document.md` §4.4.*
