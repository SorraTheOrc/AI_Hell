# Game Design Document — AI_Hell

> **Living Document** — This GDD may be edited during development as the game evolves. All changes should be tracked in the worklog so decisions remain traceable. Last updated: 2026-08-27.

---

## 1. Game Identity

| Field | Value |
|-------|-------|
| **Working Title** | AI_Hell |
| **Genre** | 2D top-down bullet hell |
| **Inspirations** | Galaxians, classic arcade shoot-'em-ups |
| **One-Sentence Pitch** | Pilot a ship through an AI-generated hellscape of formation waves and bullet patterns, surviving 5 levels of increasingly lethal encounters before facing the final boss. |
| **Target Audience** | Technical users following an AI-framework tutorial; players who enjoy pattern-based bullet hell games |
| **Visual Aesthetic** | Neon vector, Tron-inspired — dark background with glowing neon outlines, minimal fill, crisp geometric shapes |
| **Fictional Context** | The player pilots a resistance ship through a digital underworld ruled by rogue/berserk AI constructs. Enemies are literal AI manifestations — waves of code given form. |

---

## 2. Core Gameplay Loop

### 2.1 Player Controls

| Input | Action |
|-------|--------|
| **W / Arrow Up** | Move up |
| **S / Arrow Down** | Move down |
| **A / Arrow Left** | Move left |
| **D / Arrow Right** | Move right |
| **Auto-fire** | Continuous (always active) |
| **S / ↓** | Activate teleport power-up (teleport to nearest safe spot in direction of travel; consumes one Teleport per use) |

> **Control schemes:** the ship honours the player's **saved control scheme**,
> applied in every gym scene (enemy, power-up and weapons) via
> `player.getScheme()`-keyed input handlers (`FourDirectionalInputHandler` and
> `AsteroidsInputHandler` in `src/utils/movementModel.ts`). The table above
> describes the **4-directional scheme (default)**. Under the **Asteroids
> scheme** the movement keys are re-mapped: `W`/Arrow Up = **forward thrust**
> (in the current facing direction), `A`/Arrow Left = **turn left**, `D`/Arrow
> Right = **turn right** — never 4-directional movement. Turning uses a
> constant-angular-acceleration ramp (default: spin up to a **3 rad/s** top
> speed at **12 rad/s²** while a key is held, spin down at **60 rad/s²** on
> release), so a short tap nudges the heading a few degrees while a sustained
> hold still reaches the full, responsive rotation speed. See §2.2 for the
> ramp details and tuning.
> Note: turn right is bound to **D** (not S); S remains the 4-directional
> backward thrust binding only.

#### Menu & UI navigation (keyboard)

Gameplay is fully keyboard-driven, and every menu-style scene is too — no
mouse is ever required. Because the game renders to a single Phaser canvas
(no native DOM controls, so browser Tab-focus does not apply), menu
navigation uses a reusable **in-canvas focus model** implemented by
`FocusManager` (`src/utils/focusManager.ts`), shared by the main menu and
the game-over screen (the in-game pause menu follows the same model).

| Input | Action |
|-------|--------|
| **Tab** / **Arrow Down** / **Arrow Right** | Move focus forward (wraps) |
| **Shift+Tab** / **Arrow Up** / **Arrow Left** | Move focus backward (wraps) |
| **Enter** / **Space** | Activate the focused control |

- The **primary control is focused by default** and shown with a visible
  focus style (brighter colour + highlight border); exactly one control is
  focused at a time.
- **Menu (`MenuScene`):** *Play Game* is focused by default, so pressing
  **Enter** starts a run; **Tab**/arrows cycle through *Play Game* →
  *Settings* → *Gym Scene Index (dev)*.
- **Game over (`GameOverScene`):** the initials field is focused by default
  and **A–Z** / **Backspace** edit it; **Tab**/arrows move focus to
  *Return to Menu*. **Enter** auto-submits when the initials are complete;
  **Enter**/**Space** on the button also submits and returns to the menu.
- Focus keys call `preventDefault()` so the page does not scroll or the
  browser move focus while the game has keyboard focus.
- Pointer interaction is unchanged: hovering still highlights a control and
  clicking still activates it (keyboard support is additive).

### 2.2 Movement

- **Thrust-based Newtonian movement** — space physics with thrust input and tunable linear deceleration (friction). The player ship moves on a 2D plane (not lane-based); velocity changes via thrust input and, when no direction key is held, decays toward zero.
- **Thrust acceleration:** Holding a direction key applies continuous acceleration in that direction (8 directions supported — W/A/S/D and arrows, including diagonals). The ship's velocity increases each frame while thrust is held.
- **Deceleration on release:** Releasing all direction keys applies **linear deceleration (friction)** at a tunable rate in px/s², slowing the ship to a full stop. The velocity decays evenly (direction preserved) and clamps at exactly zero — no overshoot, no residual drift. Stopping or reversing faster can be achieved by thrusting in the opposite direction.
- **Tunable deceleration rate:** The deceleration rate is configurable from **0 to 400 px/s²** (default **100 px/s²**) via the Gym scene ship-tuning sliders, and persists with the rest of the ship configuration. A value of **0 restores the original zero-friction drift** (velocity preserved when no key is held) for experimentation. As a reference point, the default 100 px/s² brings the ship from max speed (~175 px/s) to rest in roughly 1.75 s.
- **Deceleration applies only when no direction key is held** — while thrusting, the deceleration rate has no effect and thrust behaviour is unchanged.
- **Asteroids turning (angular ramp):** under the Asteroids control scheme the ship's turn rate ramps toward the configured `asteroidsRotationSpeed` (default **3 rad/s**) instead of jumping straight to it. Holding a turn key spins the angular velocity up at `asteroidsRotationAcceleration` (default **12 rad/s²**); releasing it — or holding both turn keys together, which cancels to a zero target — ramps the rate back to zero at `asteroidsRotationDeceleration` (default **60 rad/s²**), so the ship stops crisply with minimal glide (under 5° of post-release rotation at the defaults). A short tap therefore rotates only a few degrees (~3–4° for a 100 ms tap at the defaults, versus ~17° under the old instantaneous model), while a sustained hold still reaches the full, snappy top speed. Both rates are configurable from the Gym ship-tuning sliders — acceleration **2–60 rad/s²** (step 2) and deceleration **12–300 rad/s²** (step 12) — and are persisted with the rest of the ship config (`asteroidsRotationAcceleration` / `asteroidsRotationDeceleration`). The ramp is a pure, closed-form, framerate-independent integration in the shared `AsteroidsModel` (`src/utils/movementModel.ts`), so the shipped game and every gym behave identically (gym↔game parity).
- **Maximum speed cap:** Velocity is clamped to a maximum speed to prevent unbounded acceleration. Tunable constants (thrust acceleration, deceleration, max speed) live in a single configuration module so the feel can be adjusted without digging through scene code.
- **Responsive feel:** Tuning targets are designed so the ship reaches meaningful speed quickly and decelerates/reverses within a "short moment" of holding the opposite key — the ship should feel agile but never sluggish.
- **Screen-edge wrap-around:** The ship wraps across all four screen edges (leaves left → reappears right, etc.), matching the classic Asteroids model. No hard walls or clamping.
- **Thruster feedback:** Visual thrust flames appear **from the four engine ports on the hull** whenever a direction key is held, making movement input legible without racing the physics. The hull is direction-neutral (§7.2), so the flame positions are the only heading cue. The engine whose outward normal opposes a thrust component fires (thrust right → left port; up+right → bottom and left ports), and each flame's length is scaled by its thrust component. Each flame is animated: it grows from length 0 toward `shipSize × thrustFlameLength × component` at a rate proportional to `thrustAcceleration` (higher thrust springs it to full size faster; at 0 thrust it stays invisible), and decays back to 0 at 4× the growth rate when the thrust stops. A change of the pressed keys while still thrusting (e.g. turning from Forward to Left) restarts every flame as a fresh burst from length 0, so each new direction is immediately legible; releasing all keys keeps the shrink-back. Growth/shrink is delta-time based so the animation is framerate-independent and re-targets the current config live.
- **Tunable constants** (exposed in `src/core/constants.ts`):
  - `THRUST_ACCELERATION` (px/s²): acceleration applied each second when thrust is held.
  - `FRICTION_DECELERATION` (px/s²): linear deceleration applied each second when no direction key is held; 0 disables friction (original drift behaviour).
  - `MAX_SPEED` (px/s): absolute speed cap.
  - Tuning targets: ship reaches ~80% of max speed in under 1 second of continuous thrust; from full speed with default deceleration, the ship comes to rest in under 2 seconds of no input; reversing from full speed to opposite direction takes under 1.5 seconds.

### 2.3 Combat Mechanics

- **Auto-fire**: The player ship fires continuously without any input (GDD §2.3; implemented in the GymWeapons gym, `src/scenes/gym/GymWeapons.ts`). Bullets fire in the direction of travel — the current velocity heading — falling back to the **most recent** non-zero heading when the ship is stationary (default before any movement: right / 0°). Fire is **globally quantised to a silent 80 BPM beat grid** (AH-0MUAYB8EH005RJ8B): every active weapon's shots land on an exact subdivision of the beat, all simultaneously active weapons are **phase-locked** to the same grid, and a weapon collected mid-beat fires its first shot on the next grid tick. The default subdivisions are **Cannon 2/beat (375 ms)**, **Spread 1/beat (750 ms)**, **Dual 1/beat (750 ms)** and **Rapid 6/beat (125 ms)**; the BPM and the per-weapon subdivisions are configurable through the game-rules config (`src/core/rules.ts`: `beatBpm`, `weaponSubdivisions`). Weapon power-ups (Spread/Dual/Rapid) are **cumulative and timed** — each collected power-up is **added** to the active set for **10 seconds** (independent countdown per weapon) and all active weapons fire on the shared grid before the timed ones silently expire (Reset clears them instantly, leaving only the Cannon).
- **Bullet range and wrap-around**: Every bullet — player and enemy — **wraps across all four screen edges** using the same classic Asteroids model as the player ship and asteroids (leave left → reappear right, etc.). A bullet is **never** removed merely for leaving the screen. Instead, each bullet type has its own **lifetime in seconds** (effective range = `bulletSpeed × lifetime`, §4.4); a bullet is destroyed only once its lifetime elapses. Wrapping is **positional only** — like the ship and asteroids, bullets do not collide across the seam.
- **Collision model**: The player loses **one life** when hit by **any** object — an enemy body or an enemy-fired bullet. Hits never deal partial damage; there is **no player health bar**. The player starts with 3 lives (§3.1); collecting **P8 – Extra Life** grants +1 life (up to a maximum of 5). A hit costs one life and the run continues until the lives run out.
  - **Early levels (1–3)**: Enemies are the primary collision threat. Flying into an enemy costs the player one life (same effect as being hit by a bullet). The enemies themselves **are** the bullets — their formation movements are the hazard.
  - **Later levels (4–5)**: Enemies additionally fire projectiles, adding a second layer of threat. Being hit by a projectile also costs one life. The enemies remain as collision threats as well.
  - **Boss level**: Boss fires complex bullet patterns; enemies may also fire. Bullet hits cost one life, exactly as on other levels.
- **Enemy health**: Regular-enemy health is **data-driven** (`EnemyConfig.health`, default **1**). Enemies E1–E6 are 1 HP and are destroyed by a single player bullet hit; the **E7 Harvester** (§4.1) has **5 HP** and survives five hits. The Boss (§4.3) remains multi-hit via its 4-phase health bar. P4 Bomb (see §4.4) does not deal damage to enemies — it clears on-screen enemy bullets only.
- **Power-ups**: Dropped by destroyed enemies and collected by flying over them (§4.4). Most provide **temporary** abilities; some are permanent or stored — **P7 Teleport** (stored, activated with S or ↓), **P8 Extra Life** (permanent +1 life), **P9 Magnet** and **P10 Mineral Scoop** (each a timed 15 s field pickup; permanent stacking when chosen as a hold-full reward). **S key or ↓** activates the teleport power-up while the player holds at least one Teleport power-up.
- **Audio feedback**: All key game events produce immediate, distinct audio cues (see §7.3). This includes player fire, enemy destruction, power-up collection, player hits, and key events (boss entrance, wave spawns, phase transitions) which are announced by an advance audio cue with ≥ 500 ms lead time before the visual event.

### 2.4 The "Enemies Are the Bullets" Design

In the first levels, enemies move in coordinated formation patterns across the screen. These formations **are** the primary hazard — the player must navigate through or avoid enemy formations just as in a traditional bullet hell, where the bullets themselves are the threat. The enemies do not fire projectiles in these levels; their positional threat is sufficient.

This creates a unique gameplay tension: the player must manage both their own ship's position relative to the formations and their auto-fire trajectory against enemies.

### 2.5 Enemy-Fired Projectiles (Levels 4–5 and Boss)

- Starting in **Level 4**, enemies begin firing bullets in recognizable patterns.
- **Level 5 (the final pre-boss level)**: Contains a **smaller number of enemies** than earlier levels, but these enemies fire bullets in **predictable, repeating patterns**. This level tests the player's ability to learn and memorize patterns before the boss encounter.
- Bullet patterns include radial bursts, sweeping arcs, and aimed shots.
- The predictability of patterns is intentional — players should be able to learn and exploit them through practice.

#### 2.5.1 Optional sequenced (data-driven) campaigns

The fire rules above describe the hand-authored campaign, but the shipped
campaign is **generated at runtime** from a target difficulty curve. With the
`sequencedWavesEnabled` rule on (default **on**, AH-0MUJSUTLA006Q8E1),
`PlayScene` builds the level list from `src/data/difficulty-curves.csv` through
the runtime auto-sequencer (`src/core/difficultySequencer.ts`) via
`buildSequencedLevels()` (`src/waves/sequencedLevels.ts`). Persisting
`sequencedWavesEnabled: false` opts back into the static `LEVELS` campaign.

Each wave declares a `generation` mode (`curve` | `fixed` | `dynamic`,
default `curve`) and the three modes may be mixed freely within one level
(AH-0MUJSUQD8003FSUT):

- **`curve`** — the wave comes from the sequencer, one curve per configured
  level, with the curve length setting that level's wave count and the level
  name read from the config. The fire rule is derived from the **1-based level
  number** — `curve` and `dynamic` levels 1–3 do not fire and levels 4+ do — so
  generated campaigns obey §2.4/§2.5.
- **`fixed`** — the wave uses the hand-authored static `LEVELS` wave at the
  same `(level, wave)` verbatim (its own fire flag) and is never passed to the
  sequencer, so designers can hand-tune onboarding and set-piece waves while
  the sequencer ramps the rest. Its `targetDifficulty` is ignored; a `fixed`
  wave with no static counterpart falls back to `curve` generation for that
  wave.
- **`dynamic`** — the wave is rebuilt from its curve at run start, seeded from
  the run's seed, so successive runs differ while a given seed reproduces
  exactly. The seed perturbs the wave's target before sequencing; the saved
  curve is unchanged. The shipped opening waves (L1W1, L1W2, L2W1, L2W2) are
  `dynamic` on a **curated** set of light archetypes with a minimum count of 4
  and a tight ±2 target jitter, so the opening is varied and never degenerate
  (AH-0MUOCJM0N000RW2B); the level-5 dynamic wave keeps the global ±20 jitter.
  A legacy per-level `source` column
  (`generated` | `scripted`) is still read when `generation` is absent, mapping
  `generated` → `curve` and `scripted` → `fixed`.

The sequencer's default candidate pool (`defaultCandidatePool()`)
deliberately excludes two archetypes delivered by their own spawners: the rare
**Harvester** (§4.1 E7) and the non-wave-accounted **Asteroid** (random
offscreen spawner, §4.1 E6). Because asteroids do not gate wave completion, a
sequenced wave group containing one would be counted as a wave enemy but never
un-counted; excluding it keeps every sequenced wave clearable and the run
advancing to the boss (AH-0MUR1HZLQ001ELX9).

The merged campaign always starts from the static `LEVELS` skeleton, so levels
1–5 are present unless a configured level overrides one; a configured level
numbered beyond the static five is appended, ascending. Fallback is **per
level**: a level with an empty/malformed curve (or a sequencer failure) keeps
its static `LEVELS` definition when one exists and is skipped otherwise; the
whole campaign falls back to static `LEVELS` only when the curve config or
candidate pool is empty, or the merged result would be empty. With the toggle
off, the scripted `LEVELS` campaign ships unchanged. The boss still triggers
after the final level.

---

### 2.6 Enemy Interaction Rules

The following rules govern how enemy entities interact with each other and with bullets. These rules are universal across all levels and enemy types.

- **Enemy pass-through**: Enemies **do not collide with or block** other enemies at any time. All enemy types pass freely through one another regardless of formation, wave, or level. This applies to all enemy types (E1–E7) and all wave configurations (Line, V-Formation, Circle, Wall, Dive Bomb, Orbital). There is no special "shielding" or "blocking" behavior between enemy types.

- **Bullet–enemy interaction**: A player bullet is **consumed** (destroyed) when it hits an enemy. The first enemy hit by a bullet takes the hit; the bullet does not pass through. There is no multi-hit bullet, no shield layer, and no piercing behaviour. A 1-HP enemy is destroyed by the bullet; a multi-hit enemy (E7 Harvester) loses one hit point per bullet and the **fifth** hit destroys it (see also §4.1 for enemy health).

- **The Wall wave (density challenge)**: Level 3's Wall wave is a **density challenge, not a blocking mechanic**. The Wall consists of a dense horizontal line of enemies that advances slowly. Enemies in the Wall pass through each other freely. To create a gap through which the player can advance or through which bullets can reach enemies behind the Wall, the player must destroy each Wall enemy individually — one bullet per enemy. There is no special "Wall shielding" that blocks bullets from reaching enemies behind the line; bullets simply pass through gaps created by destroyed enemies.

---

## 3. MVP Vertical-Slice Content

### 3.1 Scope Summary

| Element | Value | Notes |
|---------|-------|-------|
| **Levels** | 5 | Levels 1–3: enemies-as-bullets formations; Level 4: enemies fire bullets; Level 5: fewer enemies, predictable bullet patterns |
| **Boss encounters** | 1 | Final boss after Level 5 |
| **Lives** | 3 (up to 5 with P8) | Per-run; no continue mechanic. P8 Extra Life grants +1 life, capped at 5. |
| **Power-up types** | ≥ 9 | Distinct types (see §4.4) |
| **Leaderboard** | Local storage | localStorage-based, single-machine |
| **Difficulty scaling** | **Out of scope** | Not implemented in MVP |
| **Multiplayer** | **Out of scope** | Single-player only in MVP |

### 3.2 Level Progression Overview

| Level | Theme | Enemy Count | Enemy-Fired Bullets | Description |
|-------|-------|-------------|---------------------|-------------|
| 1 | Entry | Moderate | No | Introduction to formation waves — the opening is a varied, non-firing mix of light archetypes (Scouts, Divers, Swarms) rebuilt per run from a seeded curve — plus randomly spawning, self-splitting Asteroids that drift in from a random offscreen edge every wave — simple movement patterns, no enemy bullets |
| 2 | Descent | Moderate–Large | No | Tighter formations; more complex movement |
| 3 | The Core | Large | No | Dense formations; maximum positional threat |
| 4 | Firestorm | Moderate | Yes | Enemies begin firing; introduction to bullet patterns |
| 5 | Predictable Death | Smaller | Yes (predictable) | Fewer enemies with highly structured, memorizable bullet patterns — final test before boss |
| Boss | AI Throne | N/A | Yes (complex) | Final boss encounter with multi-phase attack patterns |

> **Note**: "Moderate," "Large," and "Smaller" are relative. The exact enemy counts per level are design decisions that can be tuned during implementation, but the progression from no-bullets to bullets to fewer-but-patterned enemies must be preserved.

> **Default sequenced campaigns (AH-0MUH6LEYY0054E63; per-wave modes
> AH-0MUJSUQD8003FSUT; default-on AH-0MUJSUTLA006Q8E1).** The table above
> describes the hand-authored static campaign, which is now the opt-out. With
> the `sequencedWavesEnabled` game rule on (default **on**), each wave is either
> generated from `src/data/difficulty-curves.csv` (`curve`), kept verbatim from
> `LEVELS` (`fixed`) or rebuilt at run start from a seeded curve (`dynamic`),
> selected by the config's per-wave `generation` column (see §2.5.1). The
> shipped default campaign mixes all three modes: the first four campaign waves
> (L1W1, L1W2, L2W1, L2W2) are `dynamic` and open on a curated, varied,
> non-firing mix; the remaining levels 1–3 waves are `fixed`; levels 4–5 are
> `curve` with a final `dynamic` wave (AH-0MUOCJM0N000RW2B). The static skeleton
> (levels 1–5) is always present; the static campaign is the fallback, and the
> boss still triggers after the final level.

> **Level-name progress label (AH-0MUMMBRCC0093MGV).** The shared
> level/wave progress label shown in both the persistent HUD readout and the
> centred transition/level-start banner includes the active level's theme name
> from the table above — e.g. `Level 1: Entry, Wave: 1 of 2`
> (`Level <N>: <Name>, Wave: <M> of <K>`). The name is sourced from the same
> data that defines the level: the `levelName` column in
> `src/data/difficulty-curves.csv` when sequenced waves are enabled, or
> `LevelDefinition.name` in the static `LEVELS` when the
> `sequencedWavesEnabled` rule is off. The name is shown on **every** wave of
> the level, not just the first, and the label falls back to the name-free
> numeric form (`Level N of 5, Wave M of K`) when a level has no name. The
> boss encounter keeps its literal `Boss` label. Both surfaces read the single
> `PlayScene._progressLabel()` helper so they cannot diverge.

---

## 4. Content Catalogs

### 4.1 Enemy Types

#### E1 — Scout (Basic Formation)
- **Behavior**: Flies in a standard V-formation or line across the screen.
- **Appearance**: Small, angular neon shape (e.g., triangle or chevron).
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Low (early levels only).
- **Fires**: No (Levels 1–3); yes, aimed shot (Level 4+).

#### E2 — Diver
- **Behavior**: Dives diagonally toward the player's position snapshotted at dive start (a quadratic-bezier parabolic arc in which both x and y follow the curve — no x-lock; AH-0MTGBOKLC006N8UX), pauses for 500 ms at the attack end, then re-forms. There is **no return target**: when the pause ends the **Diver group** re-anchors around the attack-end location (the player position snapshotted at dive start), preserving the Diver group's relative offsets. **Only the Divers move** — non-Diver enemies (Scouts, Tanks, Phasers, Swarms) stay exactly where they are and are unaffected by the re-anchor. The **Divers then glide** to their re-anchored slots over a short bounded duration (~0.32 s, `FORMATION_GLIDE_SECONDS`) — each Diver eases from its current position to the live (drifting) slot rather than teleporting, landing exactly on the slot when the glide completes. The formation drift keeps advancing throughout the attack and the glide (AH-0MUAYB957002EMYV, AH-0MUL15N63003PUDB).
- **Appearance**: Medium, dart-shaped neon entity.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium.
- **Fires**: No (Levels 1–3); yes, short-burst spread (Level 4+).

#### E3 — Tank
- **Behavior**: Slow, deliberate formation movement; holds position longer than other types.
- **Appearance**: Larger, hexagonal or blocky neon shape.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium–High (acts as an immovable obstacle in formations).
- **Fires**: No (Levels 1–3); yes, radial burst (Level 4+).

#### E4 — Phaser (Level 5 exclusive)
- **Behavior**: Moves slowly in a fixed orbital path; fires in predictable, repeating cycles.
- **Appearance**: Circular neon ring with a central core.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium (but high pattern-based challenge).
- **Fires**: Yes — predictable radial or aimed patterns with clear tell animations and an advance audio cue (≥ 500 ms lead time) before each firing cycle begins.

#### E5 — Swarm
- **Behavior**: Moves in tight, fast-moving clusters; changes direction suddenly.
- **Appearance**: Small, diamond-shaped neon entities in groups.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: High (positional threat in dense formations).
- **Fires**: No (Levels 1–3); yes, coordinated burst (Level 4).

#### E6 — Asteroid
- **Behavior**: Free-roaming rock that drifts in a **straight line at constant
  speed**, wrapping around all four screen edges (matching the player ship's
  wrap). Rotates continuously; rotation speed is size-scaled (small fastest).
  **Never fires bullets**, at any level — `shootEnabled` has no effect.
- **Appearance**: Jagged procedural neon polygon (grey), in three size tiers:
  large (28 px), medium (18 px), small (12 px). Speeds: large ≈ 18 px/s
  (Tank-like), medium 27 px/s, small 36 px/s — slow overall.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Splitting**: destroying a `large` asteroid spawns exactly **two** `medium`
  children at its position; a `medium` spawns two `small`; a `small` destroys
  cleanly. Children move in directions different from the parent and from each
  other. The full chain from one large is 1 + 2 + 4 = **7** destroyed enemies.
  Asteroids (including split children) are **not** registered with the
  `WaveManager` and do **not** count toward a wave's alive target: a wave
  clears once its **enemy ships** are destroyed, regardless of how many
  asteroids remain (AH-0MUJM746P000QAEO).
- **Wave placement — random offscreen spawner**: Asteroids are **not** a
  fixed formation group. Every **regular wave** (Levels 1–5) plans a set of
  asteroid spawns with the pure planner `src/waves/AsteroidSpawner.ts`
  (`computeSpawns`), and `PlayScene` releases each one at its scheduled time
  during the wave. Each asteroid appears **fully offscreen** on a random edge
  (top/bottom/left/right, uniform) — offset outward by its half-size plus a
  small margin — and drifts **inward** (perpendicular to the edge, with a ±30°
  spread) into the playfield. The **boss encounter spawns no asteroids**. The
  asteroid is deliberately excluded from the difficulty auto-sequencer's
  candidate pool (`defaultCandidatePool`), so a sequenced wave never contains a
  group the game counts but never un-counts (AH-0MUR1HZLQ001ELX9).
- **Escalation**: each wave starts at **2** asteroids. Weights are medium
  **80** (fixed) vs large **20** (+20 each wave); when the large weight
  reaches 2× the medium weight (**160**) the weights reset to 80:20 and the
  per-wave count **doubles** (2 → 4 → 8 …). Spawn times divide the wave window
  into equal segments with ±5% jitter; the first asteroid is constrained to
  the first 10% of the window.
- **Threat level**: Low–Medium (drifting, escalating hazard; no bullets).
- **Collision**: passes through other enemies (GDD §2.6 — no enemy–enemy
  collision); colliding with the player is destructive to the player (GDD §2.3
  enemy-body → lose-one-life model).
- **Fires**: Never.

#### E7 — Harvester
- **Behavior**: A large, slow **mineral-denial roamer**. It always steers toward
  the **nearest live mineral anywhere on the field** at its slow speed and
  **absorbs** it on overlap through the shared enemy-absorption rule
  (`collectMinerals`), incrementing its tracked mineral count. With no mineral
  present it holds station. It can never take minerals from the player's hold.
- **Appearance**: Large (≈ 44 px half-size), slow (≈ 24 px/s) violet hexagonal
  "collector" body — bigger than the Tank and easy to hit.
- **Health**: **5 HP** — survives five player bullets; the fifth hit destroys it
  (destruction audio, ≈ 400 score, wave accounting and the additive mineral
  re-drop all fire exactly once on the killing blow). Each **non-lethal** hit
  consumes the bullet and spawns the shared bullet-impact flash at the point of
  contact, so the player can read that the hit registered even though the body
  does not explode.
- **Spawn**: a **rare roaming spawn** in later levels (Levels 4–5) only, via the
  pure planner `src/waves/HarvesterSpawner.ts`; at most one per qualifying wave.
  Every Harvester spawn is registered with the `WaveManager` so the wave neither
  clears early nor stalls. Levels 1–3 and the boss encounter never spawn one.
  It is deliberately excluded from the difficulty auto-sequencer's candidate
  pool (`defaultCandidatePool`).
- **Threat level**: Medium–High (resource denial; durable, but never fires).
- **Fires**: **Never** — `shootEnabled` is a no-op and its effective shot
  pattern is `none`.

### 4.2 Wave / Formation Structures

Each level consists of one or more **waves** of enemies. A wave is a set of
enemy ships that spawn together and execute their pattern; the wave is
**cleared when its enemy ships are destroyed**. Asteroids do **not** gate that
clear: surviving asteroids persist in the field across wave and level
transitions (still drifting, wrapping, rotating and shootable), as do minerals
already on the field. Only the boss encounter removes carried-over asteroids,
on entry (AH-0MUJM746P000QAEO).

| Wave Type | Description | Levels |
|-----------|-------------|--------|
| **Line** | Enemies fly across in a horizontal or diagonal line | 1, 2 |
| **V-Formation** | Classic V-shape advancing across the screen | 1, 2, 3 |
| **Circle** | Enemies form a rotating circle, occasionally breaking out | 2, 3 |
| **Wall** | Dense horizontal line of enemies that advances slowly; a density challenge — each enemy consumes one bullet (see §2.6) | 3 |
| **Dive Bomb** | Enemies alternate between formation flight and diving toward the player | 3, 4 |
| **Orbital** | Enemies in fixed orbital paths around a central point (Level 5) | 5 |
| **Boss Phases** | The boss cycles through 3–4 distinct attack patterns | Boss |

> **Asteroids are not a wave structure.** Since the random offscreen spawner
> landed, no wave declares a fixed asteroid group: every regular wave
> additionally spawns random offscreen asteroids (see §4.1 E6), while the boss
> encounter spawns none. The rows above describe the **enemy ships** only.
> Asteroids do not gate wave completion and survive wave/level transitions;
> minerals already on the field persist across them too (AH-0MUJM746P000QAEO).

### 4.3 Boss Design

**Boss: The Central AI**

- **Appearance**: A large, glowing neon geometric structure (e.g., a rotating dodecahedron or layered ring system) at the center of the screen, with the name "AI_Hell" or a stylized symbol.
- **Health**: Single health bar divided into **4 phases**, each requiring **10 player hits** (**40 hits total**, `BOSS_HIT_POINTS_PER_PHASE = 10`). The fill is proportional to remaining total HP (`getHpFraction()`), so every hit visibly reduces it, and the four phase-segment dividers are retained. A hit that does not deplete the current phase leaves the phase unchanged; score and the next phase's minions are granted only on the **depleting** hit (hits 10, 20, 30 and 40).
- **Phases**:
  1. **Scan**: Fires slow, predictable aimed shots; formation enemies spawn on the sides.
  2. **Firestorm**: Rapid radial bursts in all directions; enemies dive from top and bottom.
  3. **Pulse**: Screen-wide pulse wave that expands from the boss, followed by aimed shots at the player's last known position.
  4. **Desperation**: All previous patterns combined at higher speed; boss loses armor (visual cue: core becomes more exposed/bright).
- **Pattern design philosophy**: Each phase has clear telegraphing (glow, charge, audio cue) before the attack begins. Patterns should be learnable but require precise movement.

### 4.4 Power-Ups

The player collects power-ups dropped by destroyed enemies through the shared weighted-random drop pool (§6.4). There are **9+ distinct types** — including the three **area-of-effect weapons** (Nova, Mortar, Arc) documented in the table below; the shipped defaults encode rarity as **relative weights** — standard power-ups (P3–P7, P9, P10) at **4**, **P8 Extra Life** at **3**, and each weapon drop at **2** (the `~15–20 %` / `~5 %` per-enemy figures below are conceptual guidance, not a directly coded per-enemy chance). P8 therefore takes ≈ **11.1 % of power-up draws** (weight 3 of the 27 total power-up weight) — still rarer than standard drops, but roughly three times as likely as before (its former weight was 1):

| ID | Name | Effect | Icon Suggestion |
|----|------|--------|-----------------|
| P1 | **Spread Shot** | Fires a 3-bullet fan (-30°/0°/+30° relative to heading) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Triple-line neon arc |
| P2 | **Rapid Fire** | Fires single bullets at a markedly higher rate (**6/beat** ≈ 125 ms at 80 BPM) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Stacked dots (stream of bullets) |
| A1 | **Nova** | **AOE (onFire ring).** An expanding ring centred on the ship damages every enemy and clears enemy bullets within **45 px**, every **4 beats** (3000 ms at 80 BPM). Collected as a timed 10 s drop. | Concentric neon rings |
| A2 | **Mortar** | **AOE (onRandom blast).** Detonates **immediately at a random point** within its effective range (180 px = projectile speed 180 px/s × 1 s lifetime) of the ship — no travelling shell, no forward bias — damaging every enemy and clearing enemy bullets within **35 px**, every **2 beats** (1500 ms at 80 BPM). The audio cue always fires; VFX is culled when the sampled point falls off-screen. Collected as a timed 10 s drop. | Random blast burst |
| A3 | **Arc** | **AOE (onFire chain).** Strikes the nearest enemy, then chains to **2 additional nearby** targets within **60 px**, damaging each and clearing enemy bullets along the bolt path, every **1 beat** (750 ms at 80 BPM). Collected as a timed 10 s drop. | Jagged lightning bolt |
| P3 | **Shield** | Absorbs one hit; visible shield bubble for 15 seconds (the rim pulses continuously for the whole 15 s; in the final second the fill turns opaque, then the fill shrinks inside the hull before the bubble clears) | Shield outline |
| P4 | **Bomb** | Clears all on-screen enemy bullets (does not damage enemies — they are 1 HP) | Exploding circle |
| P5 | **Speed Boost** | Increases movement speed and rate of fire by 50% for 10 seconds | Arrow with motion lines |
| P6 | **Phase Shift** | **Automatic** defensive pass-through (parent AH-0MUIYX1EE008FVS8). Collecting P6 stores **one auto-activation charge** (the hold-full reward makes activations **unlimited**); when **3 or more hostile bodies/bullets** close within **40 px** (`2 × ship size`) of the ship, the ship phases out for **1.5 s** — passing through enemies and bullets and **unable to collect minerals** while phased (power-up/weapon drops remain collectable). After expiry the effect re-arms only once the danger has dropped below the threshold **and** a **~0.5 s re-arm cooldown** has elapsed, so a permanent P6 is powerful but not perpetual invincibility. | Ghostly outline |
| P7 | **Teleport** *(collectable)* | Press S or ↓ to teleport the player in the direction of travel to the nearest safe spot (free of enemies and bullets, clamped to screen bounds); if no safe spot exists, teleport to nearest on-screen position; each collection grants one use (consumed on activation, stacks FIFO); on arrival, player gains P6 Phase Shift effect (1.5-second intangibility) | Teleport symbol (portal/ripple) |
| P8 | **Extra Life** *(passive, rare)* | Collecting this power-up grants **+1 life** immediately (applied passively, no activation required). Lives are capped at **5 total** — excess pickups have no effect. Carries the **Extra Life relative weight of 3** versus **4** for standard power-ups (P3–P7, P9, P10), so it takes ≈ **11.1 % of power-up draws** in the shared weighted pool — rarer than standard drops, but ≈ 2.8× its former share (weight 1). | Heart outline with neon glow |
| P9 | **Magnet** *(hybrid: timed pickup / permanent upgrade)* | Attracts **all power-up drops on screen** — including rare types such as P8 Extra Life — toward the player ship, making pickups easier to grab during dense bullet patterns. As a **field drop** it activates a **15 s** attraction that **refreshes on re-collection** (never stacks); as a **hold-full reward** it is applied **permanently** and **stacks up to 5**, increasing the attraction radius by **+50% per stack** from a **base radius of 1× the player ship size** (halved from 2× by AH-0MUTTAHQ9001T83A). No activation key is required and nothing is consumed. The attraction speed is **slower than the ship's movement speed**, so the player must still move toward the power-up — or remain stationary for it to drift in — to collect it. | Horseshoe magnet with neon glow |
| P10 | **Mineral Scoop** *(hybrid: timed pickup / permanent upgrade)* | Attracts **nearby minerals on screen** toward the player ship — the mineral-field analogue of P9 Magnet. As a **field drop** it activates a **15 s** attraction that **refreshes on re-collection** (never stacks). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**, using the same radius curve as P9 (base **1× the player ship size**, **+50% per stack**) and the same attraction speed (`MAGNET_ATTRACTION_SPEED`, 120 px/s — slower than the ship). It only **attracts**; minerals are still collected by hull contact (and are not collectable while phased). | Neon scoop bowl with mineral dots |

> **P10 (Mineral Scoop) — hybrid timed/permanent (parent AH-0MUTPEHMP0074Y1L):** the mineral-targeted counterpart of P9 Magnet. As a **field drop** it grants a **15 s** mineral-attraction field that **refreshes on re-collection and never stacks** (the timed state expires on the shared `EffectsRegistry.tick`). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**. Both paths drive the **same shared attraction helper** (`src/powerups/mineralScoop.ts`) via `CombatCoreScene._applyMineralScoop`, called immediately before the shared `collectMinerals` pass in `PlayScene`, `GymFormationScene` (inherited by `GymMinerals`) and `GymPowerUpsUtility`, so an enabled scoop runs identical code everywhere. The timed-only radius uses **one stack's worth** (`1 × ship size × 1.5` = 30 px at `SHIP_SIZE = 20`); permanent stacks use `1 × shipSize × (1 + 0.5 × stacks)`. It attracts minerals only — it does **not** collect them, and the P6 phased collection gate is unchanged (a phased player cannot collect minerals, and the scoop grants no collection on its own). While phased the attraction may still drift minerals, matching the magnet's relationship to drop collection. The **utility gym** (`GymPowerUpsUtility`) seeds a live mineral field and cycles **P5 → P8 → P9 → P10**; its help overlay lists P10 with its code-drawn icon and catalogue description. Since AH-0MUTOTLCY005NZ8L the P9 Magnet follows the same hybrid model and shares this radius curve and attraction speed, so the two attraction power-ups are behaviourally consistent.

> **AOE weapons — Nova, Mortar and Arc (parent AH-0MQUYOB3OR001V8CD):** Three **area-of-effect** weapons extend the catalogue as ordinary timed weapon drops (10 s, cumulative, cleared by Reset). Each carries a declarative `aoe` descriptor on `WeaponDefinition` (`src/utils/weapons.ts`) — `{ trigger: 'onFire' | 'onImpact' | 'onRandom'; radius; damagesEnemies; clearsEnemyBullets; chains?; projectileSpeed? }` — read **once** by the shared combat core so the game and every gym resolve the same effect. `'onFire'` effects (Nova ring, Arc chain) resolve at the ship the instant the weapon fires and spawn no travelling bullet; `'onRandom'` effects (Mortar) resolve immediately at points sampled uniformly at random within `projectileSpeed × bulletLifetime` of the ship — one per pattern bullet, so `projectileCount` leveling adds detonations; `'onImpact'` effects launch a projectile whose blast resolves at its impact/expiry point (retained for future weapons, not currently used by any catalogue weapon). AOE damage routes through the same `takeDamage()`/`destroySelf()` + single-kill-finalisation seam as a player bullet (destruction audio + score/drop/wave accounting exactly once), the boss is damaged through the same phase path as a player bullet, and enemy bullets inside the effect area are destroyed with the shared impact feedback. **P4 Bomb is unchanged** — it still clears enemy bullets instantly on collection and never damages enemies; AOE is complementary. AOE fire rates are exact beat subdivisions/multiples (Nova 4 beats, Mortar 2 beats, Arc 1 beat), so the catalogue-wide on-grid invariant holds. Each weapon has a distinctive neon-vector VFX helper (`src/vfx/aoeEffect.ts`: Nova ring, Mortar burst, Arc chain) and a dedicated SFX cue (`src/audio/effects.ts`), plus a code-drawn drop icon (`src/powerups/icons.ts`). Coverage: `src/utils/weapons.test.ts`, `src/utils/aoe.test.ts`, `src/vfx/aoeEffect.test.ts`, `src/scenes/core/AoeWeapons.test.ts` and `src/audio/effects.test.ts`.

> **P4 (Bomb)** is only available on levels with enemy-fired bullets (Levels 4–5 and Boss) since regular enemies (E1–E7) cannot be damaged by Bomb (E1–E6 are 1 HP, E7 is 5 HP). It clears all on-screen enemy bullets only.

> **P7 (Teleport)** is a collectable power-up like P1–P6, dropped by enemies at ~15–20% chance. Each collected Teleport grants one use, consumed when S or ↓ is pressed. Multiple Teleports stack (FIFO — earliest collected used first). Upon teleporting, the player gains the P6 Phase Shift effect (1.5-second intangibility, passing through enemies and bullets) to guarantee safety at the landing spot; this direct activation does **not** consume a P6 auto-activation charge (producer Q6).

> **P9 (Magnet) — hybrid timed/permanent (AH-0MUTOTLCY005NZ8L):** the drop-targeted counterpart of P10 Mineral Scoop. As a **field drop** it grants a **15 s** drop-attraction field that **refreshes on re-collection and never stacks** (the timed state expires on the shared `EffectsRegistry.tick`). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**. Both paths are modelled once in the shared `EffectsRegistry` and consumed through `magnetEffectStacks()`, which `CombatCoreScene._applyDropMagnet` passes to the shared attraction helper (`src/powerups/dropMagnet.ts`), so PlayScene and every gym pull drops with identical range semantics. The timed-only radius uses **one stack's worth** (`1 × ship size × 1.5` = 30 px at `SHIP_SIZE = 20`); permanent stacks use `1 × shipSize × (1 + 0.5 × stacks)`. It is passive — no activation key and nothing is consumed — and the attraction speed is **slower than the ship's movement speed**, so the player still needs to move — or hold position — to collect drifted drops.

> **P1 / P2 (Weapon Power-Ups) — Cumulative and timed (10 s):** Weapon power-ups (P1 Spread Shot, P2 Rapid Fire, plus Dual) are **cumulative and timed** — collecting one **adds** it to the ship's active set for **10 seconds**, with its own independent countdown from the moment of collection (re-collecting resets only that weapon's timer). All active weapons fire simultaneously, each at its own fire rate; the **Cannon** is permanent and never times out. A fourth power-up drop, **Reset**, clears **all** timed weapons, leaving only the Cannon.

> **Beat-aligned fire grid (AH-0MUAYB8EH005RJ8B):** Player fire is globally quantised to a **silent internal 80 BPM beat** (no audible metronome and no background music — GDD §7.3 keeps music out of MVP scope). Every weapon's fire interval is an exact subdivision of the beat — Cannon **2/beat (375 ms)**, Spread **1/beat (750 ms)**, Dual **1/beat (750 ms)**, Rapid **6/beat (125 ms)** — so every shot lands on a grid tick (`beatPeriodMs % fireRateMs === 0`) and all simultaneously active weapons stay phase-locked. A weapon collected mid-beat fires its first shot on the next tick. The beat clock lives in the shared combat core (`CombatCoreScene.beatClock`, `src/utils/beat.ts`) and is anchored at scene/player start, advancing with game time (it pauses with the game). BPM and the per-weapon subdivisions are configurable through the game-rules config (`src/core/rules.ts`: `beatBpm` default **80**, `weaponSubdivisions` default `{cannon: 2, spread: 1, dual: 1, rapid: 6}`), persisted in localStorage like the other rules; each fire rate is derived as `60000 / beatBpm / subdivision`, so the catalogue-wide on-grid invariant holds for any configuration. Enemy fire timing is unchanged. Coverage: `src/utils/beat.test.ts`, `src/utils/weapons.test.ts` (catalogue invariant), `src/entities/Player.test.ts` and the scene-level grid tests.

> **Bullet range — per-type lifetime + four-edge wrap:** All bullets (player and enemy) **wrap around all four screen edges** (the same classic Asteroids model as the player ship and asteroids) and are **never culled for leaving the screen**. Each bullet type is instead destroyed once its own **lifetime in seconds** elapses, so its **effective range is `bulletSpeed × lifetime`**. Player-weapon lifetimes live on `WeaponDefinition` (`src/utils/weapons.ts`): Cannon **0.75 s** (~262 px at 350 px/s), Spread **0.7 s** (~245 px), Dual **0.7 s** (~245 px), Rapid **0.375 s** (~131 px); the AOE radii (`AOE_RADII`) are Nova **45 px**, Mortar **35 px** and Arc **60 px**. These base values were **halved** from the original tuning baseline to bring engagements closer and reduce on-screen bullet saturation (AH-0MUU131PU006O7ZD); because weapon-levelling applies **relative** multipliers to the base catalogue values (`resolveWeaponDefinition`, `src/utils/weaponLevels.ts`), the effective range at **every** weapon level is halved too, and the levelling curve itself is unchanged. Enemy bullet lifetimes are **unchanged** by this item and live on `EnemyConfig` (`src/core/enemyConfig.ts`), overridable through the existing enemy-config / CSV plumbing: Scout **1.5 s** (200 px/s ≈ 300 px), Diver **1.5 s** (220 px/s ≈ 330 px), Tank **2.0 s** (150 px/s ≈ 300 px), Phaser **1.75 s** (180 px/s ≈ 315 px), Swarm **1.5 s** (180 px/s ≈ 270 px), Boss Swarm **2.0 s** (160 px/s ≈ 320 px). The Central AI boss uses the same 2.0 s default. Because wrapping keeps more bullets alive, the lifetime caps on-screen density; the values above are the shipped tuning baseline (player weapons halved again after review, AH-0MUU131PU006O7ZD) and are safe to adjust without any architectural change. A bullet whose lifetime elapses is **destroyed and removed from the display list** — it never lingers on screen as a stationary projectile.

> **Implemented in the GymWeapons gym (§6.4, `src/scenes/gym/GymWeapons.ts`):** The weapon power-ups (Cannon default, Spread, Dual, Rapid, **plus the AOE family Nova/Mortar/Arc**) are implemented with **cumulative + timed (10 s)** semantics, along with auto-fire in the direction of travel (GDD §2.3). The scene demonstrates round-robin weapon-drop spawning (**Spread → Dual → Rapid → Nova → Mortar → Arc → Reset**, one drop at a time, 7 s lifetime) and cumulative collection — each collected drop **adds** its weapon to the active set, expired weapons are **silently dropped**, and Reset clears them all. It extends the shared `CombatScene` core so the AOE dispatch and VFX are inherited unchanged, and hosts **three inert practice targets** (an intentional gym-only divergence, F6 AC5) so the Nova ring, Mortar blast and Arc chain are visibly demonstrated; the targets respawn after a short delay once cleared. The weapon catalogue (`src/utils/weapons.ts`) provides pure definitions (pattern offsets, fire rates, bullet visuals, AOE descriptors) plus `isTimedWeapon()` (cannon = permanent, all other weapons = timed) and heading math (including the most-recent-heading fallback when stationary); `src/entities/Player.ts` exposes the cumulative weapon collection (`equipWeapon` adds, `resetWeapon` clears timed weapons), per-weapon 10 s timers (`tickWeaponTimers`), and **phase-locked beat scheduling** (`getBeatClock`/`getLastShotTime`, `tryFire` returns every active weapon whose next beat tick has elapsed this frame), and `src/entities/PlayerBullet.ts` the player projectile. Audio cues (spawn, despawn, collection, weapon-change, plus the AOE fire/detonation cues) are in `src/audio/effects.ts`, and icon shapes in `src/powerups/icons.ts` visually hint at each weapon's pattern: fan arc for Spread, parallel bars for Dual, stacked dots for Rapid, concentric rings for Nova, arced shell for Mortar, jagged bolt for Arc, return/undo arrow for Reset.

> **Implemented in the GymPowerUpsCombat gym (§6.4, `src/scenes/gym/GymPowerUpsCombat.ts`, AH-0MTC2P6G3007PJ40):** The combat-coupled power-ups **P3 Shield (15 s, absorbs one hit), P4 Bomb (instant clear of enemy bullets, no enemy damage), P6 Phase Shift (charge-based, auto-triggered 1.5 s pass-through), and P7 Teleport (stored FIFO stacks, S/↓ → nearest safe spot in direction of travel + 1.5 s P6 on arrival)** are demonstrated with **low-level scout threats** (3 scouts in V-formation, aimed fire). Round-robin spawning **P3 → P4 → P6 → P7** (one drop at a time, 5 s lifetime, grow/hold/shrink, 3% collection threshold, 32 px bubble + icon) mirrors the threat-free GymPowerUps gym but with live threats so shield absorb, bomb clear, phase pass-through and safe-spot teleport are observable. S or ↓ consumes one P7 stack; hit response respects P6 pass-through > P3 shield pop > unshielded hit + brief invulnerability blink. P7 teleport runs through the single shared `CombatScene.triggerTeleport` path — the gym supplies only its enemy list and hit radii through the `getEnemyEntities`/`getTeleportEnemyHitRadius`/`getTeleportBulletHitRadius` hooks, so game and gym cannot diverge on the teleport safety rule (gap 7, AH-0MUII3EPU0039R5O). `findTeleportDestination` resolves the nearest safe spot (free of enemies/bullets within `TELEPORT_SAFE_RADIUS`, clamped to screen bounds). The standalone HUD (`src/ui/HUD.ts`) is reused unchanged (reads P3/P6 timers, P6 auto-activation charges and P7 stacks from the shared `EffectsRegistry`).

> **Implemented in the combat formation gyms (§6.4, `src/scenes/gym/GymEnemies.ts` / `src/scenes/gym/GymBoss.ts`, AH-0MU3VOQKH005YOBH):** From here the enemy-bearing formation gyms run a **shared opt-in power-up layer** in `GymFormationScene`: a `WeightedRandomSpawner` over **the full drop pool — P3–P10 power-ups plus the weapon drops (Spread, Dual, Rapid, Nova, Mortar, Arc, Reset)** seeded from the game-rules config (`src/core/rules.ts`), a `RandomAvoidingPlacement` strategy (`src/powerups/placement.ts`) that avoids live enemy bodies and the player, **one drop on screen at a time** on the configured interval (default **12.5 s**), fly-over collection (≥ 3 % scale; the ship hull collects a drop on first contact with its visible bubble ring — `POWER_UP_DROP_SIZE × POWER_UP_BUBBLE_RADIUS_FACTOR × scale`, 32.4 px at full scale) applied through the shared `EffectsRegistry`, and the standalone HUD with the lives counter visible (one row per active effect, plus one row per equipped weapon). The §4.4 rarity guidance is encoded as **relative weights** — standard power-up IDs (P3–P7, P9, P10) default to **4** and **P8 Extra Life** to **3** (a 4:3 ratio: P8 remains rarer but now takes ≈ 11.1 % of power-up draws), while each weapon drop (spread/dual/rapid/reset) defaults to **2** so weapons appear alongside standard effects without dominating them; the existing `WeightedRandomSpawner` normalises them internally. Collecting a weapon drop equips it through the registry for 10 s (independent countdown per weapon); the **Reset** drop clears every active weapon. A **live spawn-interval slider** (`src/utils/gymPowerUpControl.ts`) tunes the cadence of the running scene and persists the value through the rules config, so the interval is no longer a compile-time constant.

> **Shared P3/P6 hit-gating in the formation gyms (AH-0MUHM66ES0027QQV):** Collecting a dropped **P3 Shield** or **P6 Phase Shift** in a formation gym has the **same defensive effect as in `PlayScene`**: the gating lives once in the shared `CombatScene` (`isPlayerPhased()` reads `getEffectsRegistry().isPhased`; `tryAbsorbPlayerHit()` consumes one shield, runs the `onShieldAbsorbed()` cue seam, starts the shared invulnerability window and reports the hit absorbed). Since the automatic Phase Shift change (parent AH-0MUIYX1EE008FVS8) a collected P6 stores an auto-activation charge and the shared per-frame danger feed (`CombatScene._updatePhaseShiftAutoTrigger`, wired into `PlayScene`, `GymFormationScene` and `GymPowerUpsCombat` immediately before `_handleCollisions`) triggers the 1.5 s pass-through in every scene; the hit-gating hooks themselves are unchanged. `GymFormationScene` and its `GymEnemies`/`GymBoss`/`GymMinerals` subclasses inherit it — a gym scene must **not** re-implement the hooks. The P3 shield bubble and P6 phase ghost are drawn through the shared `CombatEffectVisuals` helper, and the Phase Shift screen-wide juice through `src/vfx/phaseShiftJuice.ts`, so the enemy gym looks identical to the shipped game and the combat gym.

> **P3 shield ending indicator (AH-0MUAYB5HR001HDYC):** The shield bubble winds down as it expires so the drop is telegraphed rather than instant, and its rim **pulses continuously** for the whole active lifetime (from collection until it disappears) rather than only at the end. The animation is owned by the shared `drawShieldBubble` helper (`src/scenes/core/CombatEffectVisuals.ts`) and is a **pure function of `registry.remaining('P3')`** — frame-rate independent and identical in `PlayScene`, `GymPowerUpsCombat` and `GymFormationScene`. The **rim pulses** (stroke alpha oscillates between `SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER` and `1×` the base `SHIELD_BUBBLE_STROKE_ALPHA` `0.9` at `SHIELD_BUBBLE_PULSE_RATE`) for the entire active lifetime, while the **fill** stays at its steady translucent alpha `SHIELD_BUBBLE_FILL_ALPHA` `0.12` and the radius stays at `SHIP_SIZE × SHIELD_BUBBLE_RADIUS_FACTOR` `1.6`. In the **final second** (`SHIELD_BUBBLE_ENDING_SECONDS` `1.0`) the fill ramps up to the documented "opaque" alpha `SHIELD_BUBBLE_ENDING_FILL_ALPHA` `0.6`. In the **final half second** (`SHIELD_BUBBLE_SHRINK_SECONDS` `0.5`) the **fill** shrinks monotonically from the full bubble radius down to `SHIP_SIZE × SHIELD_BUBBLE_SHRINK_MIN_FACTOR` (`0.3` → 6 px, inside the hull radius `SHIP_SIZE / 2` = 10 px) while the pulsing rim keeps its full radius; at expiry the bubble clears and nothing is drawn. The animation is **cosmetic only** — the shield keeps absorbing until true expiry/pop (`tryAbsorbShield` is unchanged) and an absorbed hit still pops the bubble immediately with no ending animation. All thresholds/colours are exported constants and pinned by `src/scenes/core/CombatEffectVisuals.test.ts`.

> **Collection feedback — pop SFX + absorb VFX (AH-0MUAYB3OU0087H9W):** Every collected drop — power-up or weapon — plays the generic percussive pop (`playPowerUpCollectPopSound()` in `src/audio/effects.ts`) alongside its existing per-type pickup cue, and is visibly "sucked into the ship" by a shared absorb animation (`src/powerups/collectAnimation.ts`): over ≤ 0.3 s the drop's position converges on the ship's world position, its scale shrinks to zero, and its shape shears/rotates toward the hull before its `Graphics` is destroyed. One generic treatment is used for all drop types; the VFX is cosmetic only and never delays the gameplay effect (registry/lives/weapon updates, P4 bullet clear), which fires immediately on overlap. Wired into `PlayScene`, the shared `GymFormationScene` (covering `GymEnemies`/`GymBoss`), and the legacy `GymPowerUpsUtility`/`GymPowerUpsCombat`/`GymWeapons` scenes so the game and gyms never diverge.

> **Catalogue descriptions + gym help overlay (AH-0MUAYB67I002REOZ):** Every catalogue entry now carries a one-line player-facing `description`: `POWER_UP_CATALOGUE.description` (`src/powerups/types.ts`) for P3–P10, and `WEAPON_CATALOGUE.description` plus a `RESET_DROP` entry (`src/utils/weapons.ts`) for Cannon/Spread/Dual/Rapid/**Nova/Mortar/Arc**/Reset. The three tuning gyms (`GymPowerUpsUtility`, `GymPowerUpsCombat`, `GymWeapons`) each render a `Help (?)` button next to `← INDEX` and also respond to the `?` key. Opening the help **pauses** the gym's simulation and launches the full-screen `HelpScene` (`src/scenes/HelpScene.ts`), which lists **exactly the drops that gym can spawn**, one row each showing the same code-drawn icon as the field drop, the display name and the catalogue description — read from the shared catalogues so the help text cannot drift from implemented behaviour. Closing via `?`, the `Close` control (focused by default, keyboard-operable) or **ESC** resumes the gym exactly where it paused; while the overlay is open ESC closes the help and does **not** return to the menu. The shared helper is `addHelpButton` (`src/utils/gymHelp.ts`), wired into the three gyms only (the full-pool formation gyms and the shipped `PlayScene` are out of scope).

#### 4.4.1 Minerals, the Ship's Hold & the Power-Up Choice (AH-0MUBVGI62004ED9Q)

Alongside power-up drops, destroying a **small `Asteroid`** leaves a **mineral** — a small, stationary gold dot that persists until collected. Minerals are collected by flying the player ship over them, or absorbed by a **non-asteroid enemy** that overlaps them (asteroids are inert to minerals). Neither contact causes damage, and bullets pass straight through. The **E7 Harvester** (§4.1) is the one enemy that **actively seeks** the nearest live mineral rather than absorbing only what it happens to overlap; it steers toward it and absorbs it through the same shared rule, but it cannot take minerals from the player's hold.

- **Dropping**: each destroyed small asteroid drops one mineral; large/medium asteroids drop none (their small split children do). An enemy that absorbed minerals **re-drops its collected total plus a random additive bonus** (configurable `mineralRedropBonusMin`/`Max`, defaults 0.25/1.25), rounded to the nearest integer, as individual minerals scattered at its explosion site when destroyed. There is **no upper cap**, so a kill may return slightly more than the enemy absorbed. An enemy that absorbed nothing still draws the bonus and may occasionally drop a single mineral (when `round(bonus) = 1`). The rule is implemented **once** in the shared helper `src/scenes/core/mineralKillDrops.ts` (`resolveMineralKillDrops`, plus the shared scatter maths in `src/entities/Mineral.ts`) and consumed by **both** `PlayScene` and `GymFormationScene`, so the game and every formation gym (`GymMinerals`, the `GymEnemies` asteroid row, …) drop identically and cannot drift apart.
- **Collection**: the pickup/absorption pass (player collects, non-asteroid enemy absorbs, asteroids inert) is implemented **once** in `src/scenes/core/mineralLayer.ts` (`collectMinerals`) and called by `PlayScene` and `GymFormationScene`, so the two scenes can no longer run divergent collection loops.
- **Ship's hold**: collected minerals fill a run-scoped hold modelled by the shared **`MineralHold`** (`src/core/mineralHold.ts`). The **first** hold fills at **5** minerals (configurable) and each hold-full resolution **doubles** the next requirement — `capacity(n) = firstHoldCapacity × growthMultiplier^(n−1)` → **5, 10, 20, 40, …** — so early power-ups are earned quickly while later ones ramp up (growth is multiplicative, and unbounded by default). Pick-up amount defaults to **1**. `GameState` (game) and `GymFormationScene` (every formation gym) both hold this one model, so the gym adopts the game's **overflow-carry** semantics (resolving the hold restores `collected − capacity`, clamped to the new capacity, never 0 — the gym previously reset to 0) and the same progression. The hold is shown on the HUD as a bar that fills proportionally to the **current** capacity (`src/ui/HUD.ts`), resets to the first-hold capacity on `GameState.startGame()`, and is never written to the leaderboard.
- **Hold full → power-up choice**: when the hold reaches capacity the game **pauses at the SceneManager level** and a modal overlay (`src/scenes/MineralChoiceScene.ts`) offers **three distinct** power-up options. The overlay knows nothing about its launcher: its only selection contract is an optional `onSelect(index, option)` callback, supplied by `PlayScene` and by every gym. The options come from a **pluggable strategy** (`src/powerups/choice.ts`); the default draws uniformly at random without replacement from the full drop pool (**P3–P10 plus Spread/Dual/Rapid/Nova/Mortar/Arc**) and degrades gracefully when the pool has fewer than three entries, and the launcher always passes the exact options it will apply. When the player already owns weapons, the pool is **extended with a permanent level-up offer for each** (`kind: 'weapon-level'`, e.g. "Spread Shot Lv.3"), so a choice can strengthen an existing weapon instead of only granting a new one (parent AH-0MUPMPCB2009J54J); the offer label always names the level it grants. Each option in the overlay additionally shows:
  - A **change summary** (e.g. "+1 Projectiles, +15% Bullet size") beneath the name for weapon-level offers and owned base-pool weapons, derived from the shared level maths in `weaponLevels.ts`; power-up-level offers and owned base-pool power-ups derive theirs from the shared power-up resolver in `powerUpLevels.ts` (AH-0MUU1GOAU007RFVR, AH-0MUU2QJE2007JNR6). Only variables that actually change are listed.
  - A **★ New** badge (orange) for weapons **and power-ups** the player does not yet own, distinguishing them from upgrade offers (AH-0MUU1GOAU007RFVR, AH-0MUU2QJE2007JNR6). Ownership is only known when the launcher supplies `ChoiceContext.powerUpLevels`; when it is omitted, no badge is shown (backward compatible).
- **Permanent pick**: the chosen option is applied to the player **permanently for the current run** via the shared `applyMineralChoiceReward` helper (also in `src/scenes/core/mineralLayer.ts`), so a choice grants the same effect in the game and in every gym — timed effects never expire and chosen weapons never time out (`EffectsRegistry.applyCollect(id, true)` / `applyWeapon(id, true)`, `Player.equipWeapon(id, true)`). A `weapon-level` option takes the same permanent `equipWeapon(id, true)` path, which raises the weapon's run-scoped level by one (parent AH-0MUPMPCB2009J54J §4.4.2); a `power-up-level` option takes the permanent `EffectsRegistry.applyCollect(id, true)` path, which raises the power-up's run-scoped level by one on the single player-owned store the registry consumes (parent AH-0MUV5CLVO002ZHS9 §4.4.3; single mutation point — AH-0MUV5CLW6005VF7K). Every launcher (`PlayScene`, `GymFormationScene` and `GymWeaponLeveling`) supplies `ChoiceContext.powerUpLevels` from the player's run-scoped power-up level store, so the choice can offer a level-up for each power-up the player already owns and mark unowned base-pool power-ups as **★ New**. Permanence is scoped to the run and cleared on reset/restart.
- **Tunables** (`src/core/rules.ts`): `mineralCollectAmount` (default 1), `mineralHoldCapacity` (**first-hold** capacity, default 5), `mineralHoldGrowthMultiplier` (default 2), `mineralRedropBonusMin`/`Max` (additive re-drop bonus, defaults 0.25/1.25). Persisted rules are schema-versioned (v3); pre-v2 configs (which stored a *fixed* capacity) migrate to the new first-hold defaults, and pre-v3 configs reset the re-drop tunables to the additive defaults so stale fraction values are never carried forward.
- **Gym**: the asteroids-only `GymMinerals` gym (§6.4) demonstrates the whole loop; every formation gym also seeds 100 random minerals on create.

> **Hold-full rewards are functional in every gym (AH-0MUHMXWGC0058BO4):** The overlay renders **exactly** the option set the caller stored, so the label shown is the option applied — every launcher (`PlayScene` and each formation gym) passes its stored `options` plus an `onSelect` callback to the single `MineralChoiceScene` contract. In the asteroids-only `GymMinerals` — which has no field power-up drops — the P3/P6/P7 rewards granted by the hold-full choice behave as in the main game: **P7 Teleport** is bound to **S / ↓** whenever a player exists and consumes a stored use (granting a 1.5 s P6 on arrival), **P3 Shield** is honoured through the shared `CombatScene` hit-gating hooks (`isPlayerPhased()` / `tryAbsorbPlayerHit()`), and a permanent **P6 Phase Shift** grants unlimited automatic activations through the shared danger feed while the phase pass-through and mineral gate stay identical to the game. The effects registry ticks every frame (driving the HUD, including the finite/unlimited P6 charge readout) independent of the opt-in drop layer so timed effects expire normally. The teleport gate accepts a stored use (`canTeleport()` is true when `hasTeleport()`), while the opt-in drop layer still gates field-drop teleports elsewhere.

#### 4.4.2 Weapon Leveling (AH-0MUPMPCB2009J54J)

Weapons are **constantly upgradable**: every weapon carries a **run-scoped integer level** and each level changes a set of tunable variables. A **temporary** weapon drop increases that weapon's level (and re-activates it under the existing 10 s timed semantics); a **permanent** mineral-choice pick can raise a weapon's level for the rest of the run. Levels are **unbounded**, persist for the run (including across a weapon timing out), and reset only on run restart. The full catalogue lives in `src/utils/weaponLevels.ts`; the pure resolver is `resolveWeaponAtLevel(weaponId, level)`.

**Diminishing-returns curve.** Every variable uses the same exponential-saturation curve, so a higher level is always at least as good, but each successive level adds less:

```
effective(level) = cap − (cap − base) × e^(−k × level)
```

- `base` is the un-upgraded (level 0) value; `effective(0) = base`.
- `cap` is a hard, finite ceiling the value approaches but never exceeds for continuous variables (discrete counts round and saturate exactly at the cap).
- `k` is the saturation rate; larger `k` reaches the cap sooner.
- Integer counts (projectiles, piercing, bounce, chain, split) are rounded to whole numbers and clamped to their cap.

**Catalogue (16 variables).** The four **MVP** variables — **Fire rate**, **Projectiles**, **Bullet size** and **Area** — are implemented in this epic; the remainder are fully specified here and shipped by follow-up items. `Level-1` is the resolved value at level 1 (the first pickup), shown to make the per-level gain concrete.

| Variable | Base (L0) | Cap | k | Level-1 | Tier |
|----------|-----------|-----|---|---------|------|
| **Fire rate** (shots/s multiplier) | 1 | 3 | 0.18 | ≈1.33 | MVP |
| **Projectiles** (extra per shot) | 0 | 8 | 0.22 | 2 | MVP |
| Spread (extra fan half-angle, °) | 0 | 45 | 0.20 | ≈8.16 | planned |
| **Bullet size** (radius multiplier) | 1 | 2.5 | 0.16 | ≈1.22 | MVP |
| Bullet speed (multiplier) | 1 | 1.8 | 0.14 | ≈1.10 | planned |
| Range (lifetime multiplier) | 1 | 2.2 | 0.12 | ≈1.14 | planned |
| Damage (multiplier) | 1 | 4 | 0.20 | ≈1.54 | planned |
| Piercing (extra targets) | 0 | 5 | 0.25 | 1 | planned |
| Bounce (extra bounces) | 0 | 4 | 0.25 | 1 | planned |
| Homing (strength, 0–1) | 0 | 0.9 | 0.15 | ≈0.13 | planned |
| **Area** (AoE radius multiplier) | 1 | 2.5 | 0.18 | ≈1.25 | MVP |
| Status (chance, 0–1) | 0 | 0.6 | 0.12 | ≈0.07 | planned |
| Chain (extra jumps) | 0 | 4 | 0.22 | 1 | planned |
| Crit (chance, 0–1) | 0 | 0.5 | 0.12 | ≈0.06 | planned |
| Split (extra fragments) | 0 | 3 | 0.20 | 1 | planned |
| Knockback (force multiplier) | 1 | 3 | 0.18 | ≈1.33 | planned |

**Rationale for each cap/rate.** Fire rate is the most feel-sensitive variable, so a 3× ceiling keeps indefinite levels from trivialising bullet density while `k=0.18` front-loads the early gains. Extra projectiles multiply total damage, so the cap is deliberately small (8) and `k=0.22` lands the first extra bullet at level 1. Spread is a coverage/readability tool: 45° is the widest fan that still reads as aimed fire. Bullet size improves hit probability; 2.5× keeps bullets legible against the neon background. Bullet speed trades readability for reach (1.8× is the fastest still-trackable bullet), and range extends reach without filling the screen with wrapped bullets (2.2×, a slow `k=0.12`). Damage is the strongest scalar, so it saturates late and high (4×) — meaningful but never an instant win. Piercing and bounce are very strong in crowds, so both cap at 5/4 with `k=0.25` granting the first step at level 1. Homing changes aiming feel (0.9 is strong but imperfect, a late-game payoff), while area-of-effect radius is the AOE family's identity (2.5× is a large but bounded blast). Status, crit and split stay bonuses rather than primary damage, so their ceilings are modest (60 % / 50 % / 3 extra fragments). Chain scales with enemy density (4 extra jumps), and knockback is a control tool (3× is enough to push enemies clear). Every rationale is kept beside its numbers in `WEAPON_UPGRADE_SPECS` (`rationale` field) so balance intent cannot drift from the values.

**Beat-grid invariant.** A fire-rate upgrade must not produce an off-grid interval: fire-rate levels map to the nearest valid beat subdivision so every shot stays on the shared 80 BPM grid (AH-0MUAYB8EH005RJ8B). Coverage: `src/utils/weaponLevels.test.ts` (monotonicity, caps, curve, catalogue completeness) and the fire-rate beat-grid work item.

#### 4.4.3 Power-Up Leveling (AH-0MUU2QJE2007JNR6)

Power-ups are **constantly upgradable**, exactly like weapons: every power-up P3–P10 carries a **run-scoped integer level** and each level changes a set of tunable variables. The full catalogue lives in `src/powerups/powerUpLevels.ts`; the pure resolver is `resolvePowerUpAtLevel(powerUpId, level)`, backed by the **same** exponential-saturation curve as weapons (extracted into `src/utils/curve.ts` so there is exactly one curve implementation).

- **Level acquisition (weapon parity).** Every collection — a field pickup or a hold-full permanent reward — increments the power-up's level. The **first** collection unlocks the power-up at its base (existing) strength (`resolvePowerUpAtLevel(id, 0)`); each **further** collection applies the next upgrade. The level is **run-scoped**: it persists across a timed effect expiring (only the *active effect* expires on its duration, never the level) and resets only on run restart. A permanent hold-full pick never expires.
- **Diminishing-returns curve.** Identical to §4.4.2: `effective(level) = cap − (cap − base) × e^(−k × level)`. Every variable is monotonic non-decreasing and clamped to a finite cap; discrete counts round and saturate at the cap.
- **Stack reconciliation (AC3).** Existing stack/charge semantics are derived from the level model rather than a second counter: P9/P10 permanent stacks are `min(permanentGrants, levelCap)` with a cap of **5**; P7 stored teleports and P6 charges are level-derived grants minus consumes; P8 lives are `min(livesStart + Σ lifeGain(level), 5)`. The P9/P10 **hybrid is preserved**: a field pickup levels the power-up up and refreshes the timed attraction, but does **not** create a permanent stack — only a hold-full reward does.
- **Wired into the effect path (AH-0MUV5CLW6005VF7K).** `EffectsRegistry` consumes the **single** run-scoped `PowerUpLevelStore` owned by `Player` — every scene injects that same instance (via a dynamic resolver, so a respawned player is picked up automatically), so there is no second, independently-incremented counter. `EffectsRegistry.applyCollect` is the single mutation point: it advances the level exactly once (field pickup **or** hold-full reward), then resolves the effect strength from the catalogue — P3/P5 durations, the P5 `speedMultiplier`, P6/P7 phase durations, P7 teleports, P6 charges, P8 lives and the P9/P10 stack caps all come from `resolvePowerUpAtLevel`/`store.stats()` rather than raw tuning constants. The only non-levelled effect constants that remain are the **P9/P10 field-pickup timed windows** (15 s): that window has no catalogue axis, so only the permanent stack cap (and hence attraction radius) levels. Game and every gym consume the same code, enforced by the duplicate-body guard.
- **P3/P4 consumption deferred (AH-0MUVM9RAO004Y3LB).** The level store tracks the P3 `shieldAbsorptions` (1 → 3) and P4 `bombCharges` (1 → 3) axes, but their **consumption** is not yet wired: P3 still absorbs exactly **one** hit before popping, and P4 still clears bullets instantly with no stored-charge trigger. A `power-up-level` change summary excludes these deferred axes (`DEFERRED_POWER_UP_LEVEL_VARIABLES`) so the hold-full choice never promises a delta the effect path does not apply.
- **Every power-up levels (AC5).** Every P3–P10 has at least one meaningful axis (no power-up is exempt). P4 Bomb, which is instant and stateless, levels the number of stored auto-clear **charges** banked per pickup.

| Power-up | Level variables (base → cap, k) |
|----------|----------------------------------|
| **P3 Shield** | Shield time (15 s → 30 s, k=0.12); Shield hits (1 → 3, k=0.5) |
| **P4 Bomb** | Bomb charges (1 → 3, k=0.5) |
| **P5 Speed Boost** | Speed boost (1.5× → 2.5×, k=0.2); Boost time (10 s → 20 s, k=0.12) |
| **P6 Phase Shift** | Phase time (1.5 s → 3 s, k=0.2); Phase charges (1 → 3, k=0.5) |
| **P7 Teleport** | Teleports (1 → 3, k=0.5); Arrival phase (1.5 s → 3 s, k=0.2) |
| **P8 Extra Life** | Lives (1 → 3, k=0.5); Life cap (5, flat) |
| **P9 Magnet** | Magnet stacks (1 → 5, k=0.35) |
| **P10 Mineral Scoop** | Scoop stacks (1 → 5, k=0.35) |

Every cap/rate is recorded with a written rationale beside it in `POWER_UP_LEVEL_SPECS` so balance intent cannot drift from the numbers. **Status:** the **design + catalogue + pure resolver + integration contract** is shipped, the hold-full choice integration (the launcher supplies `ChoiceContext.powerUpLevels` and a chosen `power-up-level` offer is applied through the shared `applyMineralChoiceReward` path — parent AH-0MUV5CLVO002ZHS9) is shipped, and the resolver/store is **wired into `EffectsRegistry`** and the shared effect path in `PlayScene` and every gym (AH-0MUV5CLW6005VF7K). The P3 multi-hit absorption and P4 stored-charge consumption remain deferred to **AH-0MUVM9RAO004Y3LB**, and the gym parity demonstration/test suite ships in **AH-0MUV5CLVQ006V9HR** (see the README). Coverage: `src/powerups/powerUpLevels.test.ts`, `src/utils/curve.test.ts`, the power-up choice tests, `src/powerups/effects.test.ts`, `src/scenes/__tests__/PlayScene.powerUpLevels.test.ts`, `src/scenes/core/CombatScene.equivalence.test.ts` and `src/entities/Player.test.ts`.

### 4.5 Scoring System

| Action | Points |
|--------|--------|
| Destroy E1 Scout | 100 |
| Destroy E2 Diver | 200 |
| Destroy E3 Tank | 300 |
| Destroy E4 Phaser | 250 |
| Destroy E5 Swarm | 150 |
| Destroy E6 Asteroid (small only) | 50 (large/medium award none) |
| Destroy E7 Harvester | 400 |
| Destroy Boss Phase 1 | 1000 |
| Destroy Boss Phase 2 | 2000 |
| Destroy Boss Phase 3 | 3000 |
| Destroy Boss Phase 4 | 5000 |
| Time bonus (per level) | 50 × seconds remaining |

- **Score display**: Neon-styled numeric display in the top-right corner.

> **Boss phase scoring (AH-0MUTV3J7T006MZ4K):** The four `Destroy Boss Phase N` values above are **unchanged**. Because each phase now takes **10 hits** (`BOSS_HIT_POINTS_PER_PHASE`), a phase's points are awarded on the **depleting hit** — hits **10, 20, 30 and 40** — not on every hit. A partial-phase hit awards no score, summons no minions and does not advance the phase; it only reduces the visible health-bar fill. This keeps fully levelled weapons from trivialising the encounter: the Central AI still requires **40 player hits** regardless of weapon level.

### 4.6 Level Progression Mechanics

- Beating a level advances to the next level automatically.
- If the player runs out of lives (3 starting; up to 5 with P8 Extra Life power-up), the game ends and the **final score** is submitted to the local leaderboard.
- There is **no continue** mechanic. Game over is final.
- Players may restart from Level 1 at any time after a game over.

---

## 5. Leaderboard

### 5.1 Design

- **Storage**: Browser `localStorage` (key: `ai_hell_leaderboard`), max 10
  entries.
- **Module**: `src/core/Leaderboard.ts` owns the table — `getEntries()`,
  `addEntry(initials, score)`, `buildPreview(entries, score, initials)`,
  `getTopN(n)` and `isQualifying(score)` — and persists through the injectable
  `LeaderboardStore` interface so a future online backend can replace
  `localStorage` without touching the scenes (§5.3 migration note; also §6.6).
- **Entry**: On game over, prompt for a 3-character **neon-style initials**
  entry. A score qualifies while fewer than 10 entries exist, or when it
  strictly beats the current lowest entry; a non-qualifying score shows an
  explanatory message and can be skipped without writing.
- **Live preview (game-over)**: While a qualifying score is being entered,
  the game-over table also shows a single **prospective row** at the rank the
  score will occupy — highlighted in a distinct colour with a leading `▶`
  marker and initials filling in live (`___` placeholders until typing
  begins). It is inserted with the same stable score-descending tie-break
  and 10-entry cap as `addEntry`, so it matches the persisted entry on submit
  and the current lowest entry is displaced when the table is full. A
  non-qualifying score renders no prospective row.
- **Display**: The full ranked table (rank, initials, score, date) is shown
  on the game-over screen (`GameOverScene`) and from the main menu
  (`MenuScene` → `LeaderboardScene`), both through the shared rendering path
  in `src/ui/leaderboardView.ts`. The main-menu table never shows a
  prospective row.
- **Content**: Rank, initials, score, date.

> The earlier `GameOverScene` leaderboard stub (`readLeaderboard` /
> `saveScoreEntry` and its local schema) has been retired in favour of the
> shared module.

#### Keyboard entry (game-over screen)

The game-over screen follows the shared in-canvas focus model (§2.1, *Menu &
UI navigation*): the **initials field is focused by default** and accepts
**A–Z** (uppercase, up to 3 characters) and **Backspace**. **Tab** / arrow
keys move focus to **Return to Menu**, and **Enter** / **Space** activate the
focused control. **Enter** on the initials field auto-submits once three
letters are entered, persisting the score before returning to the main menu.
Pointer entry (clicking **Return to Menu**) continues to work unchanged.

For a **qualifying** score the ranked table shows a live prospective row: it
appears immediately on screen open with `___` placeholders and is refreshed
on every **A–Z** key and **Backspace**, so the player can see the position
their run will take before committing. The row is highlighted with a leading
`▶` marker and a distinct colour, and is replaced (never accumulated) on
each keystroke.

### 5.2 Data Model

The table is stored under `ai_hell_leaderboard` as a JSON array, sorted by
score descending and capped at 10 entries:

```json
[
  { "rank": 1, "initials": "AI_", "score": 50000, "date": "2026-08-24" }
]
```

- `rank` — 1-based position, recomputed on read (never trusted from storage).
- `initials` — exactly three uppercase A–Z letters.
- `score` — non-negative points.
- `date` — ISO `YYYY-MM-DD`.

Absent, non-JSON or wrong-shape storage yields an empty list; malformed rows
inside a valid array are dropped, so bad data never crashes the game.

---

## 6. Technical Architecture

### 6.1 Engine Policy

- **No engine with an extensive UI/editor** — Godot, Unity, and similar are explicitly excluded.
- **Code-first game engine libraries are encouraged** — the game should be built primarily through code, not through visual editors or scene builders.
- The game must **run on the web** and be **distributable as a Windows binary**.

### 6.2 Selected Engine: Phaser (TypeScript / HTML5)

The selected engine for AI_Hell is **Phaser (TypeScript / HTML5)**. This decision was made to balance rapid development with robust feature availability, fitting the tutorial/demonstration context.

| Aspect | Details |
|--------|---------|
| **Type** | Mature 2D game framework with built-in scenes, physics (Arcade or Matter), tweening, input handling, and asset management |
| **Pros** | Large ecosystem, extensive documentation, and active community. Fast to scaffold a playable prototype. Ideal for a tutorial project where time is limited. Built-in audio (Web Audio API), input handling, and scene management align well with the GDD's requirements. |
| **Cons** | Opinionated framework layer over the raw game loop; some abstraction to learn. Less "from scratch" educational value for AI-framework demonstration. |
| **Best for** | Rapid development with a robust feature set; best balance of speed and capability for a tutorial/demonstration project. |

**Why Phaser:** The tutorial context prioritizes getting a playable game quickly. Phaser satisfies the "code-first" constraint — the game is built through TypeScript code, not a visual editor. Its built-in features (scenes, tweens, input, audio) reduce boilerplate and let the team focus on game mechanics and AI-framework integration.

> **Engine locked:** Phaser is the definitive engine for this project. The engine must still satisfy the web + Windows binary constraint (see §6.3). |

### 6.3 Distribution: Web and Windows

- **Web**: The game runs in any modern browser. Built as a standard web application (HTML + CSS + JavaScript/TypeScript).
- **Windows binary**: Package the same web codebase using:
  - **Tauri v2** (recommended) — lightweight, Rust-based, produces small native Windows binaries. Fits the code-first philosophy.
  - **Electron** (alternative) — heavier but more familiar to JavaScript developers.

### 6.4 Module / File Breakdown (Proposed)

```
src/
├── core/
│   ├── Game.ts          — Main game class, scene management
│   ├── GameState.ts     — Game state (lives, score, level, ship's mineral hold)
│   ├── mineralHold.ts   — Shared mineral hold model (implemented, AH-0MUII3DHM008L7JF,
│   │                      gap 5; progression AH-0MUKC6IML0082ZR4): `MineralHold` owns the
│   │                      first-hold capacity, growth multiplier, per-pickup collect amount and
│   │                      overflow carry used by *both* `GameState` and `GymFormationScene`, so
│   │                      the gym adopts the game's hold/overflow semantics (resolve grows the
│   │                      capacity and carries `collected − capacity`, clamped to the new
│   │                      capacity) instead of resetting to 0
│   ├── Input.ts         — Input handling (keyboard, auto-fire)
│   └── rules.ts         — General game-rules config (implemented): localStorage-backed
│                          `loadRules()` / `saveRules()` holding the power-up spawn
│                          interval (default 12.5 s) and per-ID drop weights (P3–P10)
│                          for the combat gyms; `POWER_UP_SPAWN_INTERVAL` re-sources
│                          from it in `../core/constants.ts`
├── scenes/
│   ├── core/
│   │   ├── CombatCoreScene.ts — Narrower shared combat/lifecycle base (implemented,
│   │   │                      AH-0MUDCT7EU0061OSZ): owns the shared player-control
│   │   │                      step (`_tickPlayer`: weapon timers → live P5
│   │   │                      multipliers → input → physics → auto-fire, with the
│   │   │                      `autoFireEnabled` feature toggle) and the input path
│   │   │                      (`_readPlayerInput`, delegating to the shared
│   │   │                      `mapControlInput` helper in `src/utils/movementModel.ts`),
│   │   │                      auto-fire (`_autoFire` +
│   │   │                      `spawnPlayerBullet`, with the `onWeaponFired` cue hook) and
│   │   │                      drop collection (`_collectDrop` + absorb VFX + the
│   │   │                      `onWeaponCollected`/`onPowerUpCollected`/`_playPickupCue`
│   │   │                      hooks), the player-explosion/collect registries,
│   │   │                      `_clearEnemyBullets`/`_spawnPlayerExplosion`, and the shared
│   │   │                      invulnerability/phase/absorption hooks
│   │   │                      (`getInvulnerabilityDuration`, `isPlayerPhased`,
│   │   │                      `tryAbsorbPlayerHit`). It also owns the shared run
│   │   │                      lifecycle (`resetRunState`/`teardownRunState`) that clears
│   │   │                      the active effects registry (through the polymorphic
│   │   │                      `getEffectsRegistry()` accessor) and the shared per-run object
│   │   │                      families on create/`SHUTDOWN`, so a stop/restart of any scene
│   │   │                      starts clean (AH-0MUII3FYN0072QRT, gap 10). Extended directly
│   │   │                      by the threat-free gyms `GymWeapons` and `GymPowerUpsUtility`.
│   │   ├── CombatScene.ts — Shared abstract combat core (implemented, AH-0MUD8E015004C4JO):
│   │                      extends `CombatCoreScene` and adds the combat-only template
│   │                      methods (`_handleCollisions`, `_hitPlayer`, `_handleTeleport`/
│   │                      `triggerTeleport`) plus the bullet-vs-bullet impact feedback
│   │                      (`src/vfx/bulletImpact.ts` + `playBulletDestructionSound`), with
│   │                      the participant accessors and combat hooks (`onWeaponFired`,
│   │                      `onEnemyDestroyed`, `onPlayerHit`, `tryAbsorbPlayerHit`,
│   │                      `onBulletVsBulletImpact`, …). Together the two files define the
│   │                      nine shared methods exactly once, enforced repo-wide by
│   │                      `CombatScene.equivalence.test.ts`; extended by `PlayScene`,
│   │                      `GymFormationScene` and `GymPowerUpsCombat`.
│   │   ├── mineralKillDrops.ts — Shared mineral kill-drop rule (implemented,
│   │   │                      AH-0MUHMT5JC004WRSB): `resolveMineralKillDrops(scene,
│   │   │                      entity, rng)` decides the drops for a destroyed enemy
│   │   │                      (small asteroid → one mineral at the death site; large/
│   │   │                      medium asteroid → none; non-asteroid enemy → its collected
│   │   │                      minerals plus a random additive bonus, scattered near the
│   │   │                      death site). Consumed by
│   │   │                      `PlayScene` and `GymFormationScene` so the game and the gyms
│   │   │                      cannot diverge; the repo-wide guard in
│   │   │                      `CombatScene.equivalence.test.ts` pins the single definition.
│   │   ├── dropLayer.ts — Shared power-up drop layer (implemented, AH-0MUII3CXX0023H24,
│   │   │                      gap 4): `buildDefaultDropSpawner` (default weighted pool over
│   │   │                      P3–P10 + weapon drops), `advanceDropLifecycles` (grow → hold →
│   │   │                      shrink → despawn), `collectOverlappingDrops` (collect-gate: ≥ 3 %
│   │   │                      scale + hull-touches-bubble via `dropCollectRadius`),
│   │   │                      `applyDropMagnet` (P9 range/speed) and `playDropPickupCue`
│   │   │                      (per-type P5/P8/P9 + weapon/Reset cue dispatcher with the generic
│   │   │                      chime fallback). `CombatCoreScene` wraps them as template methods
│   │   │                      (`_updateDropLayer`, `_advanceDropLifecycles`,
│   │   │                      `_collectOverlappingDrops`, `_applyDropMagnet`,
│   │   │                      `_buildDefaultDropSpawner`, `_playPickupCue`) consumed by
│   │   │                      `PlayScene` and every gym, so an enabled drop behaves identically
│   │   │                      everywhere. Only the spawn *source* (kill chance vs timer vs
│   │   │                      round-robin) stays per-scene (OQ6). Pinned by the repo-wide guard
│   │   │                      and the cross-scene equivalence tests in
│   │   │                      `CombatScene.equivalence.test.ts`.
│   │   ├── BombNotice.ts — Shared P4 bomb notice (implemented, AH-0MUII3CXX0023H24, gap 4):
│   │   │                      owns the centred “BOMB! Bullets cleared” flash and its 1.2 s
│   │   │                      auto-hide timer. `CombatCoreScene.onPowerUpCollected` shows it
│   │   │                      through the polymorphic `_getBombNotice()` accessor, so every
│   │   │                      scene that can collect a P4 (`PlayScene`, `GymFormationScene`,
│   │   │                      `GymPowerUpsCombat`) shows the same notice.
│   │   ├── asteroidSplit.ts — Shared asteroid-split helper (implemented,
│   │   │                      AH-0MUII3F7Q002O7WX, gap 8): `splitAsteroid({ scene,
│   │   │                      parent, register })` spawns the two smaller children of
│   │   │                      a destroyed large/medium rock (position, velocity fan,
│   │   │                      rotation) and hands each to the caller's registration
│   │   │                      callback. Consumed by `PlayScene._splitAsteroid` and the
│   │   │                      `GymEnemies`/`GymMinerals` destruction seams so the split
│   │   │                      physics cannot drift; pinned by the repo-wide source guard
│   │   │                      in `src/scenes/core/asteroidSplit.test.ts`.
│   │   ├── bulletLifecycle.ts — Shared projectile-lifecycle helpers (implemented,
│   │                      AH-0MUII3CF00024EDM, gap 3): `advanceWrappingBullets(bullets,
│   │                      dt, width, height)` advances enemy bullets (velocity
│   │                      integration, four-edge wrap, lifetime expiry) and
│   │                      `advancePlayerBullets(bullets, dt)` advances player bullets via
│   │                      the existing `advanceAndCull`. Consumed by `PlayScene`,
│   │                      `GymFormationScene`, `GymWeapons` and `GymPowerUpsCombat` so the
│   │                      wrap/expiry semantics cannot drift (AH-0MU960UTE001PTV0); the
│   │                      repo-wide guard plus cross-scene equivalence tests in
│   │                      `CombatScene.equivalence.test.ts` pin the definition and the
│   │                      behaviour.
│   │   └── mineralLayer.ts — Shared mineral collection + choice-reward layer (implemented,
│   │                      AH-0MUII3DHM008L7JF, gap 5): `collectMinerals(minerals,
│   │                      player, enemies, onPlayerCollected)` runs the single player-pickup/
│   │                      non-asteroid-absorption pass, `applyMineralChoiceReward(option, ...)`
│   │                      applies a hold-full choice permanently, and `MineralHold` is
│   │                      re-exported from `core/mineralHold.ts` so the whole collection + hold
│   │                      seam lives together. Consumed by `PlayScene` and
│   │                      `GymFormationScene`; the single-definition guard and the cross-scene
│   │                      overflow test live in `mineralLayer.equivalence.test.ts`.
│   ├── MenuScene.ts     — Main-menu boot scene (implemented): Play Game → PlayScene,
│   │                      Settings → SettingsScene (audio + controls, origin MenuScene),
│   │                      Gym Scene Index (dev) → GymIndex; resumes Web Audio on click;
│   │                      FocusManager keyboard navigation (default focus on Play Game)
│   ├── PlayScene.ts     — Playable run (implemented): extends the shared `scenes/core/CombatScene`
│   │                      base (which extends `CombatCoreScene`; implementing its hooks for
│   │                      boss multi-hit, asteroid split (delegated to the shared
│   │                      `scenes/core/asteroidSplit.ts` helper),
│   │                      mineral absorption, wave accounting, lives/game-over and the P4
│   │                      bomb notice); WaveManager-driven levels 1–5 +
│   │                      Central AI boss, player/collisions/power-ups/HUD, transitions
│   │                      to GameOverScene on win or loss; **ESC pauses** the run and
│   │                      opens PauseScene (movement/layer-drop/pause keys are rebindable);
│   │                      mineral drops/hold and the hold-full power-up choice overlay
│   ├── MineralChoiceScene.ts — Modal hold-full power-up choice (implemented): 3 distinct
│   │                      options, paused SceneManager overlay; the only selection contract is
│   │                      the optional `onSelect(index, option)` callback (no launcher-specific
│   │                      branches), so the exact option shown is the option the launcher applies;
│   │                      resumes and resolves the hold with the overflow carry
│   ├── PauseScene.ts    — In-game pause menu (implemented): full-screen replacement scene
│   │                      with Resume / Settings / Quit (pointer + keyboard), launched by
│   │                      PlayScene's ESC toggle; resume continues the run exactly
│   ├── HelpScene.ts     — Gym help overlay (implemented, AH-0MUAYB67I002REOZ): opaque
│   │                      full-screen replacement launched by the shared gym helper;
│   │                      icon + name + catalogue description per spawnable drop, with a
│   │                      default-focused Close control; `?`/Close/ESC resume the paused gym
│   │                      (ESC never exits to the menu while the overlay is open)
│   ├── SettingsScene.ts — Settings screen (implemented): SFX volume slider (0.0–1.0),
│   │                      SFX mute toggle, and key-binding remapping with conflict
│   │                      warnings + Reset to defaults; persisted to `ai_hell_settings`;
│   │                      Back returns to the origin scene (PauseScene or MenuScene)
│   ├── GameOverScene.ts — Game-over (implemented): final score, qualifying 3-letter
│   │                      initials entry, full ranked leaderboard (src/core/Leaderboard.ts),
│   │                      Return to Menu / Skip; FocusManager keyboard navigation
│   │                      (initials field focused by default). The earlier localStorage
│   │                      stub (readLeaderboard/saveScoreEntry) has been retired.
│   ├── LeaderboardScene.ts — Shared leaderboard view (implemented): full ranked table
│   │                      (rank, initials, score, date) via src/ui/leaderboardView.ts,
│   │                      opened from the main menu; Back returns to MenuScene
│   ├── GymIndex.ts      — Dev-mode gym entry scene (dev tool, reachable via the
│   │                      main menu's Gym Scene Index button; discovers + lists gym
│   │                      scenes from scenes/gym/ via import.meta.glob;
│   │                      FocusManager keyboard navigation — Tab/arrows move focus,
│   │                      Enter/Space launch the focused row)
│   └── gym/
│       ├── core/
│       │   └── GymFormationScene.ts — Shared gym formation base (implemented): extends the
│       │                      shared `scenes/core/CombatScene` (itself extending
│       │                      `CombatCoreScene`), generic over the entity/bullet
│       │                      types and driven by an `EnemyFormationConfig`; owns formation
│       │                      spawn/drift/respawn, the opt-in power-up layer and the
│       │                      shared mineral layer (`scenes/core/mineralLayer.ts` collection +
│       │                      `core/mineralHold.ts` hold) and the
│       │                      enemy-only mode. Exposes the protected `respawnFormation()`
│       │                      and `setPlayerEnabled(enabled)` seams plus
│       │                      `registerDynamicEntity(child)` (AH-0MUII3F7Q002O7WX, gaps 8/9),
│       │                      so subclasses share the game's respawn/player lifecycle
│       │                      instead of casting into base internals. Concrete E1–E5 gyms
│       │                      and GymEnemies/GymBoss supply only their entity-specific config.
│       ├── GymDiver.ts  — E2 Diver gym (key GymDiver, label "Diver")
│       ├── GymPhaser.ts — E4 Phaser gym (key GymPhaser, label "Phaser")
│       ├── GymMinerals.ts — asteroids-only mineral gym (key GymMinerals, label "Minerals"):
│       │                   small-asteroid mineral drops (via the shared
│       │                   `scenes/core/mineralKillDrops.ts` rule), the shared
│       │                   `scenes/core/mineralLayer.ts` collection/hold/choice layer,
│       │                   hold fill + HUD hold bar,
│       │                   enemy absorption/re-drop, hold-full choice overlay (100 seeded minerals);
│       │                   choice-granted P3/P6/P7 rewards are functional (S/↓ teleport,
│       │                   shared shield/phase hit-gating, registry ticks independent of drop layer)
│       ├── GymPlayer.ts — Player thruster-navigation/tuning gym (key GymPlayer, label "Player");
│       │                   extends the shared `scenes/core/CombatScene` (shared input,
│       │                   auto-fire and collision/hit pass) and adds a deterministic,
│       │                   indestructible obstacle course while keeping the ship-config panel
│       │                   (AH-0MUAYB2XR007N10W)
│       ├── GymPowerUpsUtility.ts — non-combat power-up gym (key GymPowerUpsUtility, label "PowerUpsUtility"):
│       │                  extends the narrower shared `scenes/core/CombatCoreScene`;
│       │                  round-robin P5/P8/P9/P10 spawning, a live mineral field,
│       │                  the shared P10 mineral scoop, collection, standalone HUD
│       ├── GymPowerUpsCombat.ts — combat-coupled power-up gym (key GymPowerUpsCombat, label "PowerUpsCombat"):
│       │                  extends the shared `scenes/core/CombatScene` (hook-based shield/phase/bomb/invuln);
│       │                  round-robin P3/P4/P6/P7 with low-level scout threats; P3 Shield, P4 Bomb, P6 Phase, P7 Teleport (S/↓)
│       ├── GymScout.ts  — E1 Scout gym (key GymScout, label "Scout")
│       ├── GymSwarm.ts  — E5 Swarm gym (key GymSwarm, label "Swarm")
│       ├── GymTank.ts   — E3 Tank gym (key GymTank, label "Tank")
│       ├── GymWeaponLeveling.ts — weapon leveling gym (key GymWeaponLeveling, label "WeaponLeveling"):
│       │                  extends the shared `scenes/core/CombatScene`; collect weapon drops to level
│       │                  weapons up (temporary) and fill the mineral hold for a permanent level-up
│       │                  (per-weapon levels, diminishing returns — see §4.4.2)
│       └── GymWeapons.ts — weapon power-up gym (key GymWeapons, label "Weapons"):
│                           extends the narrower shared `scenes/core/CombatCoreScene`;
│                           auto-fire ship + round-robin Spread/Dual/Rapid/Reset
│                           drops (7 s lifetime, persistent weapon switching)
├── entities/
│   ├── Player.ts        — Player ship (auto-fire, weapon slot)
│   ├── Mineral.ts       — Mineral collectable (small gold dot; collected by the player,
│   │                      absorbed by non-asteroid enemies; inert to bullets/asteroids)
│   ├── PlayerBullet.ts  — Player-fired projectile (Graphics, vx/vy, per-type lifetime; four-edge wrap)
│   ├── enemyFire.ts     — Shared enemy-fire dispatcher (implemented, AH-0MUII3BBW000XZ46,
│   │                      gap 2): `fireForEnemy(entity, enemyKey, now)` maps an archetype
│   │                      key → its `tryFire*` method once (unknown/custom keys fall back
│   │                      to the aimed shot) and takes the caller's scene clock explicitly.
│   │                      Consumed by `PlayScene`, `GymEnemies` and `GymPowerUpsCombat` so a
│   │                      new archetype is wired once and every scene fires it identically;
│   │                      pinned by the repo-wide guard in `CombatScene.equivalence.test.ts`.
│   ├── Enemy.ts         — Base enemy class
│   ├── Scout.ts         — E1 Scout
│   ├── Diver.ts         — E2 Diver
│   ├── Tank.ts          — E3 Tank
│   ├── PhaserEnemy.ts   — E4 Phaser
│   ├── Swarm.ts         — E5 Swarm
│   └── Boss.ts          — Central AI boss
├── bullets/
│   ├── PlayerBullet.ts  — Player-fired projectiles
│   ├── EnemyBullet.ts   — Enemy-fired projectiles
│   └── BulletPattern.ts — Bullet pattern definitions
├── powerups/
│   ├── PowerUp.ts       — Base power-up drop class: grow/hold/shrink/despawn lifecycle,
│   │                      delta-time driven (framerate-independent), collection gated at >3% full-size scale
│   ├── spawner.ts       — Pluggable spawner strategy layer: PowerUpSpawner interface,
│   │                      RoundRobinSpawner (deterministic gym drops),
│   │                      WeightedRandomSpawner (semi-random in-game drops with mid-run weight tuning)
│   ├── placement.ts     — Pluggable avoiding placement strategy (implemented):
│   │                      PowerUpPlacement interface + RandomAvoidingPlacement
│   │                      (random in-margin position clear of live enemy bodies/player,
│   │                      retry limit + deterministic fallback)
│   ├── teleport.ts      — Shared P7 safe-spot resolver (implemented):
│   │                      findTeleportDestination reused by GymPowerUpsCombat and
│   │                      the combat base (ray + grid candidates, clamped to screen)
│   ├── types.ts         — Power-up catalogue (P3–P10; P3 Shield 15 s, P4 Bomb instant, P6 Phase Shift charge-based 1.5 s auto, P7 Teleport stored FIFO, P10 Mineral Scoop timed 15 s / permanent stacks)
│   │                      with a one-line `description` per entry (gym help source of truth)
│   ├── choice.ts        — Pluggable hold-full choice strategy (default: 3 distinct random
│   │                      picks from P3–P10 + Spread/Dual/Rapid; graceful degradation)
│   ├── effects.ts       — Active-effects registry (timers, lives, P5 speed, P9 magnet, P10 scoop, P3 shield absorb, P6 phase auto-trigger charges, P7 teleport stacks)
│   ├── mineralScoop.ts  — Shared P10 mineral attraction helper (applyMineralScoop: in-range
│   │                      live minerals pulled toward the player at MAGNET_ATTRACTION_SPEED)
│   └── icons.ts         — Code-drawn neon power-up icons (shield/bomb/phase/teleport/speed/life/magnet/scoop)
├── waves/
│   ├── WaveManager.ts   — Wave spawning and management
│   └── Formations.ts    — Formation movement patterns
├── ui/
│   ├── HUD.ts           — Standalone power-up HUD (implemented): Phaser Container attachable to any
│   │                      scene, renders above gameplay; per-active-effect rows (icon, name,
│   │                      remaining-seconds timer or stack count) + lives counter
│   └── leaderboardView.ts — Shared leaderboard rendering (implemented): formatLeaderboardRow +
│                            renderLeaderboard, used by GameOverScene and LeaderboardScene
├── audio/
│   └── AudioManager.ts  — Sound effects (procedural Web Audio API synthesis)
├── data/
│   ├── enemyData.ts     — Enemy stat definitions
│   ├── bossData.ts      — Boss phase definitions
│   └── scoring.ts       — Scoring constants
└── utils/
    ├── collision.ts     — Collision detection
    ├── math.ts          — Helper math functions
    ├── focusManager.ts  — Reusable in-canvas focus model (implemented): register/unregister
    │                      focusable controls, Tab/Shift+Tab/arrow cycling with wrap-around,
    │                      Enter/Space activation, visible focus style, shutdown cleanup
    ├── gymDiscovery.ts  — Gym-scene discovery (import.meta.glob, .test.ts filter, labels, sort)
    ├── gymNavigation.ts — Shared "← INDEX" back-button helper for gym scenes
    ├── gymHelp.ts      — Shared gym help helper (implemented, AH-0MUAYB67I002REOZ):
    │                      `addHelpButton(scene, { gymKey, drops })` renders the `Help (?)`
    │                      button beside `← INDEX`, pauses + launches HelpScene on click/`?`,
    │                      and exposes the id → { name, description, drawIcon } catalogue lookup
    └── gymPowerUpControl.ts — Live spawn-interval slider (implemented): plain-DOM range input
                           mounted in GymEnemies/GymBoss that applies the new cadence to the
                           running scene and persists it via the rules config (stable DOM id)
assets/
├── images/              — Neon vector graphics (placeholder_ prefix)
└── audio/               — No external audio assets (all SFX are procedural; see §7.3)
docs/
└── Game Design Document.md
```

### 6.5 Entity / Bullet / Wave Data Model

#### Player Entity
```typescript
interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  lives: number;
  speed: number;
  fireRate: number;         // ms between shots
  score: number;
  effects: PlayerEffect[];
}

interface PlayerEffect {
  type: 'spread' | 'rapid' | 'shield' | 'speed' | 'phase';
  remaining: number;        // seconds
}
```

#### Enemy Entity
```typescript
interface Enemy {
  id: string;
  type: 'scout' | 'diver' | 'tank' | 'phaser' | 'swarm' | 'asteroid' | 'harvester';
  x: number;
  y: number;
  width: number;
  height: number;
  health: number;       // Data-driven hit points (EnemyConfig.health, default 1). E1–E6 = 1 (one-hit kill); E7 Harvester = 5; Boss handled by the phase system
  scoreValue: number;
  behavior: FormationBehavior | DiveBehavior;
  canFire: boolean;
  firePattern?: BulletPattern;
}
```

#### Bullet Entity
```typescript
interface Bullet {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  isPlayerBullet: boolean;
}
```

#### Wave Definition
```typescript
interface Wave {
  enemies: WaveEnemy[];     // Spawned enemy definitions
  formation: FormationType; // 'line' | 'v-formation' | 'circle' | 'wall' | 'dive' | 'orbital'
  duration: number;         // ms before next wave
}
```

### 6.6 Save-Data Design (Local Storage)

All persistence uses browser `localStorage` (or the Tauri/Electron equivalent):

| Key | Content |
|-----|---------|
| `ai_hell_leaderboard` | Leaderboard entries (see §5.2) |
| `ai_hell_settings` | `sfxVolume` (0.0–1.0), `sfxMuted` (SFX mute toggle), `bindings` (remappable key controls: movement, layer-drop, pause toggle). Edited in SettingsScene (reachable from the main menu and the pause menu); defaults restored via **Reset to defaults** |
| `ai_hell_lastSession` | Last played score (optional, for "continue" if added later) |

**Migration note**: If the project later adds online leaderboards, the local storage layer should be abstracted behind an interface so it can be swapped for an API backend.

### 6.7 Key Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Performance on web** — Many bullets and enemies on screen simultaneously could cause FPS drops. | High | Optimize collision detection (grid-based); limit concurrent bullet count; use object pooling. |
| **Pattern design complexity** — Creating 5 distinct, balanced levels of bullet patterns is time-consuming. | Medium | Start with simple patterns; iterate based on playtesting; reuse pattern primitives. |
| **Neon aesthetic consistency** — Achieving a cohesive Tron-inspired look requires careful color and glow management. | Medium | Define a limited neon color palette early; use a single post-processing glow effect if available. |
| **Phaser abstraction** — If the team later wants more architectural control, refactoring away from Phaser requires decoupling game logic from engine-specific code. | Low | Keep game logic decoupled from engine-specific code; abstract core systems (input, rendering, game loop) behind interfaces. |
| **Browser autoplay policy** — AudioContext cannot start before a user gesture; SFX will be silent until the user interacts (e.g., clicking Start/Play). | Medium | Initialize audio on first input or menu interaction; fall back silently until then; document the gesture requirement. |
| **SFX rate limiting** — High-frequency events (auto-fire, fast bullet hits) could overlap into cacophony. | Medium | Per-sound rate limiting/throttle; modest volume levels; avoid stacking more than 3–4 concurrent SFX instances. |
| **Windows distribution** — Packaging requires a build step (Tauri/Electron) not all developers may have set up. | Low | Document the packaging steps in README; provide a build script. |

---

## 7. Aesthetic Guidelines

### 7.1 Color Palette

| Color | Hex | Usage |
|-------|-----|-------|
| Background | `#0a0a0a` (near-black) | Screen background |
| Player | `#00ffff` (cyan) | Player ship, player bullets |
| Enemy E1 | `#00ff00` (green) | Scout |
| Enemy E2 | `#ffff00` (yellow) | Diver |
| Enemy E3 | `#ff6600` (orange) | Tank |
| Enemy E4 | `#ff00ff` (magenta) | Phaser |
| Enemy E5 | `#0066ff` (blue) | Swarm |
| Boss | `#ff0000` (red) — phases shift to brighter red | Central AI |
| Power-ups | `#ffffff` (white) with colored aura | All power-ups |
| UI text | `#00ffff` (cyan) | HUD, menus |

> **Pause menu & settings** — the in-game pause menu (`PauseScene`) and the settings screen (`SettingsScene`) render as full-screen replacement scenes in the same neon palette: cyan text on a near-black background, with the focused keyboard control highlighted in white (GDD §7.1).

### 7.2 Visual Style

- **Glow effects**: All neon elements have a subtle bloom/glow (outer glow, not inner shadow).
- **Shapes**: Geometric, angular shapes — triangles, chevrons, hexagons, rings. No organic forms.
- **Player hull**: Direction-neutral regular hexagon (flat top/bottom, circumradius = `shipSize / 2`), neon outline only (no fill), with four small engine ports at the top, bottom, left, and right cardinal points. The hexagon's 60° rotational symmetry means the hull never implies a heading — in a thrust-based 360°-movement game the player has no fixed forward direction, so thrust intent is read from the engine flames, not the silhouette. Enemy ships keep directional silhouettes (chevrons/darts in §4.1) since they do fly with a heading.
- **Animations**: Smooth, fluid motion for formations; sharp, precise motion for bullets.
- **Power-up collection absorb**: Collected drops are "sucked into the ship" over ≤ 0.3 s by a shared absorb animation (`src/powerups/collectAnimation.ts`) — position converges on the ship's world position, scale shrinks to zero, and the shape shears/rotates toward the hull before the `Graphics` is destroyed. One generic treatment covers all drop types (power-ups and weapon drops); it is cosmetic only and never delays the applied effect. See §7.3.
- **Bullet-vs-bullet impact flash**: When a player bullet shoots down an enemy bullet, a brief small flash/glow appears at the impact point (`src/vfx/bulletImpact.ts`, `resolveBulletVsBulletImpact()`) — a warm-white filled circle that fades and scales up slightly over ~120 ms before destroying itself. Deliberately NOT the full particle burst (bullets are only ~3 px radius). It is invoked from the single shared `CombatScene.onBulletVsBulletImpact` path used by both `PlayScene` and `GymFormationScene`.
- **Particle effects**: Minimal — use for explosions (enemy destruction, player death). Every destruction plays a single **particle explosion burst** (`src/vfx/explosionParticles.ts`, `spawnExplosionParticles()`) as the primary VFX: small filled circles tinted with a small HSL jitter around the exploding entity's neon colour, fading from alpha 1 → 0 while shrinking to nothing over ~400 ms. Particle counts scale with entity size (clamped to 8–80), so a Boss bursts far larger than a Scout. Every particle's own radius is additionally jittered by ±30 % (`EXPLOSION_SIZE_JITTER`) and its emitted start position offset by up to ±15 % of the entity size on each axis (`EXPLOSION_POSITION_JITTER`), so repeated kills look different while each pattern keeps its identity; the jitter is drawn from the existing seeded PRNG, so a fixed seed still reproduces the burst exactly. Hues stay recognisably "that ship": Scout green, Diver yellow, Tank orange, Phaser magenta, Swarm blue, Boss red, player cyan (`SHIP_COLOR`).
- **Explosion patterns**: Three burst patterns are available — **radial** (uniform random directions with a speed spread), **ring/shell** (particles on a shared circle forming an expanding ring), and **implosion-then-burst** (particles drift inward for ~100 ms, then burst outward). Each entity type is assigned one, two, or three patterns (even split of the size-scaled count across them) via the single `EXPLOSION_PATTERNS_BY_TYPE` map; death paths call `resolvePatterns(type)` rather than hard-coding patterns:

  | Entity | Patterns | Feel |
  |---|---|---|
  | Scout (E1) | radial | quick green spray |
  | Diver (E2) | radial | quick yellow spray |
  | Tank (E3) | radial + ring | heavy orange shell + spray |
  | Phaser (E4) | ring + implosion | magenta ring that gathers then blows |
  | Swarm (E5) | radial | small blue spray (per member) |
  | Boss | radial + ring + implosion | layered red detonation |
  | Player | radial + ring | cyan shell + spray on death |

  Counts, lifespan, jitter ranges (including the per-particle `EXPLOSION_SIZE_JITTER` / `EXPLOSION_POSITION_JITTER`), and per-pattern speeds/radii are all tunable constants in `src/vfx/explosionParticles.ts`; the initial values here (and the table above) are the pre-tuning baseline. Size and position jitter apply uniformly to all three patterns and every entity type — the `ring` pattern's particles are position-jittered too, so it reads as a slightly ragged ring rather than a perfect circle.
- **Player-death juice**: The player's destruction is the most consequential event in the game, so it plays a deliberately layered effect rather than a single particle puff. The composed effect lives in one shared module, `src/vfx/playerDeathJuice.ts`, and is invoked through a single entry point `spawnPlayerDeathJuice(scene, x, y, severity, options?)` so no scene has to know the layer set. One call composes:
  1. **Camera shake** (`applyShake`) — full-2D `camera.shake(duration, intensity)`, short (~250–400 ms) to avoid motion discomfort.
  2. **Dedicated SFX** (`playPlayerDestructionSound`, see §7.3) — played exactly once; the generic enemy cue is never played on this path.
  3. **Particle burst** — delegated to `spawnExplosionParticles()` with the `'player'` (`radial + ring`) pattern assignment, so the player keeps the cyan shell-and-spray identity from the table above.
  4. **Full-screen flash** (`spawnDeathFlash`) — a brief non-interactive cyan-white overlay that fades from a peak alpha to zero in ~120–200 ms.
  5. **Debris shards** (`spawnDeathDebris`) — small cyan fragments flung outward on seeded-random headings, fading and shrinking over ~0.5 s.
  6. **Shockwave ring** (`spawnDeathShockwave`) — an expanding stroked ring that outlives the particle burst briefly before fading.

  **Severity scaling:** `resolveJuiceParams(severity)` maps a `'respawn'` (mid-run life lost) or `'fatal'` (final life / game over) death to a complete parameter set; `'fatal'` scales every magnitude up via the `PLAYER_DEATH_SEVERITY_FATAL_*` multipliers (shake intensity/duration, flash alpha, debris count, shockwave radius), so a run-ending death reads heavier without becoming disorienting. Unknown severities fall back to `'respawn'` (never throws).

  **Per-layer toggles:** each layer is individually switchable via a `PLAYER_DEATH_ENABLE_*` constant (shake, flash, particles, debris, shockwave, sound), and all intensities/counts/durations are exported constants in the same module — a designer can drop or retune any layer without code surgery. Every juice-owned display object is pushed to a caller-owned `playerDeathEffects` registry and removed on completion, and the scenes clear that registry on `SHUTDOWN`, so a stop/restart leaks nothing.

  The three player-hit paths all route through the helper: `PlayScene._loseLife` (real run — `'fatal'` at 0 lives, `'respawn'` otherwise), the shared `CombatScene.applyPlayerHit` used by the formation gyms (`GymEnemies` / `GymBoss` / `GymMinerals`), and `GymPowerUpsCombat` via the inherited hit lifecycle. The wave timeout no longer costs a life (AH-0MUNS3ZQ1002DJ9S), so there is no timeout life-penalty cue; shield absorption is unchanged in both the run and the combat gym.
- **End-of-run treatment (victory celebration & defeat signal)**: the two most consequential moments in a run are dressed by one shared module, `src/vfx/endOfRunJuice.ts`, so the win and the loss are instantly distinguishable. A pure `resolveEndOfRunJuiceParams('victory' | 'defeat')` mapping (no Phaser import) returns the complete, outcome-specific parameter set; unknown outcomes fall back to `'victory'` and never throw. Victory is bright and celebratory (cyan `ENDOFRUN_VICTORY_COLOR`, green `ENDOFRUN_VICTORY_GREEN`, sparkle `ENDOFRUN_VICTORY_SPARKLE`); defeat is sombre and desaturated (`ENDOFRUN_DEFEAT_COLOR` red, `ENDOFRUN_DEFEAT_RED` vignette, `ENDOFRUN_DEFEAT_GRAY` glitch). Two composition entry points consume it:
  1. **`spawnVictoryJuice(scene, options?)`** — layered celebration: a bright full-screen **flash/glow** (`ENDOFRUN_VICTORY_FLASH_ALPHA` 0.55, 320 ms), three staggered expanding **shockwave rings** (`ENDOFRUN_VICTORY_RING_COUNT` 3, radius 120 px, `ENDOFRUN_VICTORY_RING_STAGGER_MS` 180 ms), and a 140-piece multi-colour **confetti burst** (`ENDOFRUN_VICTORY_PARTICLE_COUNT`, 2200 ms lifespan, `ENDOFRUN_CONFETTI_TRAVEL` 260 px). A producer audit (2026-10-04) asked for a bigger celebration, so the flash/confetti were strengthened and the ring count raised.
  2. **`spawnDefeatScreenJuice(scene, options?)`** — layered defeat treatment: a red **edge vignette** (12 bands drawn inward from the screen edge, peak alpha 0.6, fades over 1500 ms), a slow dim red **ring** (radius 80 px), and a **desaturated grey glitch flicker** (5 flashes of 40 ms at alpha 0.15).

  **Deployment and depth:** the sustained treatment is rendered on `GameOverScene` behind the score/initials/leaderboard UI, while `PlayScene` fires the in-run flourish at the moment the boss dies (a short tunable `VICTORY_TRANSITION_HOLD_MS` = 250 ms before the transition). The juice layers sit at **negative depth** (`ENDOFRUN_VICTORY_*_DEPTH` / `ENDOFRUN_DEFEAT_*_DEPTH`, −10…−8) so they render above the background (which `GameOverScene` gives depth −100) and behind the default-depth-0 UI; none of them is interactive, so the treatment can never occlude or intercept keyboard/pointer input. Every layer is individually switchable via an `ENDOFRUN_ENABLE_*` constant (victory flash/particles/ring, defeat vignette/glitch/ring, sound), all counts/colours/durations are exported constants, and every display object is tracked in a caller-owned registry destroyed on scene `SHUTDOWN` (no leaks across restart). The defeat treatment layers on top of — and stays visually distinct from — the in-run fatal `spawnPlayerDeathJuice` (§7.2 player-death juice): it is screen-centred, red and desaturated rather than a cyan point-burst.

  **Gym-parity note:** `GameOverScene` is reached only from `PlayScene`; no gym scene has a run-end screen. The shared helper therefore lives once in `src/vfx/endOfRunJuice.ts` and is consumed by the game path (the in-run `PlayScene` flourish and the `GameOverScene` victory/defeat branches) — there is no gym run-end behaviour to change, so the gym↔game parity convention is satisfied by construction rather than by a scene-level copy.
- **Phase Shift juice**: The automatic Phase Shift (P6) gets one shared, screen-wide treatment so the player can read the reactive activation (`src/vfx/phaseShiftJuice.ts`, advanced each frame by the shared `CombatCoreScene._updatePhaseShiftJuice` in `PlayScene`, `GymFormationScene` and `GymPowerUpsCombat`). It composes two layers — a subtle dark-blue **desaturation/dim** overlay and a **chromatic split-tint** (cyan and red ADD overlays offset ±3 px that fringe enemies, bullets and minerals alike) — held for the duration of the 1.5 s effect and destroyed on expiry, while the ship keeps its existing phase ghost (`applyPhaseGhost`). **Camera shake is deliberately omitted:** the first cut of this feature used a light shake, but a producer review rejected it because it made Phase Shift read like the player-death juice above; the chromatic split alone sells the phase shift while keeping the two events visually distinct. Each layer has a `PHASE_SHIFT_ENABLE_*` toggle and every overlay is tracked in a `phaseShiftEffects` registry cleared on scene `SHUTDOWN`.

### 7.3 Audio Direction (MVP: In Scope — Simple SFX)

**Approach**: All sound effects use **procedural synthesis via the Web Audio API** (zero external audio assets). Sound is code-generated — crisp, digital, neon-style "blips, zaps, and hums" consistent with the Tron-inspired aesthetic. Phaser's built-in Web Audio support is available but the spec remains engine-agnostic.

#### SFX Event Catalog

| Category | Event | Sound Character | Volume | Lead Time |
|----------|-------|-----------------|--------|-----------|
| **Interactions** | Power-up pickup | Short percussive pop + "sucked into ship" absorb VFX | Medium | Immediate |
| **Interactions** | Teleport activate (S/↓) | Short whoosh + portal effect | Medium | Immediate |
| **Interactions** | Phase Shift activates (automatic) | Rising sci-fi chirp + noise whoosh (`playPhaseShiftSound()`: triangle sweep 320 → 1560 Hz over ~0.28 s + bandpass noise sweep 600 → 3200 Hz) | Medium | Immediate |
| **Impacts** | Player hit (life lost) | Low, heavy layered "hull breach" boom (`playPlayerDestructionSound()`: impact thump + descending body + shrapnel hiss); replaces the generic enemy cue on the player-death paths | High | Immediate |
| **Impacts** | Enemy destroyed | Sharp pop / crack | Medium | Immediate |
| **Impacts** | Wave timeout — survivors carry over (no detonation) | No cue: survivors persist into the next wave as active threats (AH-0MUNS3ZQ1002DJ9S). `playMajorExplosionSound()` is retained but unused by the timeout path | — | — |
| **Impacts** | Boss phase damage | Deeper zap, slightly longer decay | High | Immediate |
| **Impacts** | Player bullet hits enemy | Very short tick | Low | Immediate |
| **Impacts** | Player bullet destroys enemy bullet | Dedicated high, very short tick (`playBulletDestructionSound()`; distinct from the heavier enemy-destruction fall) + small impact flash | Low | Immediate |
| **Enemy actions** | Enemy spawn | Subtle hum rise | Low | Immediate |
| **Enemy actions** | Enemy fire (Level 4+) | Short zap | Low-medium | Immediate |
| **Enemy actions** | Dive bomb attack | Descending tone | Medium | ≥ 500 ms advance |
| **Run flow** | Victory (boss defeated) | Bright **two-phrase** major fanfare: rising arpeggio (C5 → E5 → G5 → C6) then a faster rising cadence (C6 → E6 → G6 → C7) resolving into a sustained major chord over a C4/G4 bass bed, with a high sparkle flourish and a soft high-pass shimmer crackle tail (`playVictoryFanfareSound()`), ~3.3 s | Medium | Immediate |
| **Run flow** | Defeat (run lost) | Slow **five-note** descending sombre line (G4 → F4 → D4 → B3 → G3) over a sinking 98 Hz drone with a dark low-pass rumble tail (`playDefeatStingSound()`), distinct from the player-destruction cue, ~2.9 s | Medium | Immediate |

#### Explosion Pitch Randomisation

Explosion destruction sweeps are intentionally non-identical between kills: each invocation draws a single pitch factor uniformly in **[0.85, 1.15]** (±15 %, tunable via `EXPLOSION_PITCH_JITTER` in `src/audio/effects.ts`) and multiplies **all** sweep endpoints by it, so the cue varies while its descending character and tonal relationships are preserved. This applies to the shared enemy-destruction burst (`playDestructionSound()`, 440 → 60 Hz sawtooth) and the Diver's heavier destruction cue (`playDiverDestructionSound()`, 280 → 40 Hz sawtooth plus the 80 → 25 Hz sine undertone). The intentionally-unwired Tank destruction variant (`playTankDestructionSound()`) is unchanged, and volume, waveform and duration are unaffected. Unlike the VFX path (which reuses the seeded particle PRNG for deterministic replays), audio pitch jitter uses `Math.random()` — audio is outside the deterministic VFX seed contract.

#### Per-Enemy Audio Character

Audio-character decisions for individual enemies are made **per-enemy at
implementation time** and may deliberately deviate from the generic catalog
entries above — the catalog defines the default character, not a straitjacket.
Example: the E1 Scout (gym scene `GymScout`) uses a rising sine-wave advance
cue flowing with **no gap** into a sharp square-wave shot blip, with the fire
sound scheduled at the cue's end; the E3 Tank (gym scene `GymTank`) uses a
rising mechanical-whine advance cue flowing with **no gap** into a heavy low
cannon thump, one cue+thump pair per radial burst, instead of the generic
"short zap". See `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` for the per-enemy
audio decisions and the implementation best practices (which audio is owned by
the base scene, where entity-specific sounds are orchestrated, and the no-gap
pattern).

#### Player Audio Character

The player ship has its own procedural audio palette (all in
`src/audio/effects.ts`), giving the player the same by-ear feedback the
enemies get:

| Cue | Sound Character | Synthesis (wave, contour) | Volume |
|-----|-----------------|---------------------------|--------|
| Cannon fire | Solid medium blip | Square 800 → 400 Hz, ~80 ms | 0.15 |
| Spread fire | Wide multi-tone sweep | Triangle 600 → 1200 → 800 Hz, ~120 ms | 0.15 |
| Dual fire | Sharp crack (twin barrels) | Sawtooth 900 → 300 Hz + offset sine tick | ≤ 0.15 |
| Rapid fire | Tight staccato | Triangle 500 → 900 Hz, ~50 ms | 0.12 |
| Spread pickup | Widening fan sweep | Triangle 500 → 1500 → 800 Hz | 0.15 |
| Dual pickup | Two-note crack | Sawtooth 1000 → 500 then 1200 → 700 Hz | 0.14 |
| Rapid pickup | Accelerating rise | Triangle 400 → 1600 Hz | 0.14 |
| Reset pickup (→ cannon) | Gentle unwind to baseline | Sine 900 → 300 Hz, ~200 ms | 0.12 |
| Power-up pickup (generic pop) | Short percussive pop | Sawtooth 600 → 100 Hz + high-pass filtered noise transient, ~80 ms | 0.15 |
| P5 Speed Boost pickup | Bright ascending zip | Square 600 → 1800 Hz | 0.13 |
| P8 Extra Life pickup | Warm two-note chime | Sine 440 → 880 then 660 → 990 Hz | 0.13 |
| P9 Magnet pickup | Low pulsing field hum | Square 180 → 90 → 180 Hz + sine undertone | ≤ 0.12 |
| Thruster hum (held thrust) | Continuous jet-engine roar | Triangle 60 Hz + sine 35 Hz rumble + band-pass filtered white noise (700–1100 Hz) whoosh, thrust-scaled (≤ 0.075) | ≤ 0.075 |
| Player death (hull breach) | Heavy layered boom — deep impact thump + slow descending body + brief shrapnel hiss | Sawtooth 120 → 32 Hz (~0.4 s) + triangle 260 → 42 Hz (~0.6 s) + high-pass filtered noise tail (~0.28 s) | ≤ 0.2 |
| End-of-run victory fanfare | Bright celebratory fanfare — rising major arpeggio into a sustained major chord plus a light sparkle tail | Triangle arpeggio C5 → E5 → G5 → C6 (0.16 s apart, 0.12 peak) + sine chord C6/E6/G6 (~0.9 s, 0.09) + sine sparkles 2093–3520 Hz (0.06), ~1.5–2.5 s | ≤ 0.2 |
| End-of-run defeat sting | Slow, sombre descending sting — a mournful minor fall over a low drone with a dark rumble wash | Triangle G4 → F4 → D4 → A3 (0.24 s apart, 0.13) + sine drone 98 Hz (~1.1 s, 0.09) + low-pass filtered noise tail (320 Hz, ~0.6 s, 0.07) | ≤ 0.2 |
| Volume-change feedback (Settings) | Player-explosion cue at the selected volume (pitch unchanged) | Same as player death — sawtooth 120 → 32 Hz + triangle 260 → 42 Hz + filtered noise tail; gain × volume | ≤ 0.2 |

- **Thruster hum** — single ship-level continuous jet-engine roar (NOT per-engine flame port), synthesised as a soft triangle fundamental (60 Hz) with a sine undertone (35 Hz) for low rumble plus white noise through a band-pass filter (700–1100 Hz, Q 0.6–1.1) for jet-engine whoosh; filtered noise is the dominant texture, all through one reused gain node; gain follows `getEngineSoundLevel` level `min(1, thrustAcceleration / FLAME_REF_THRUST)` (GDD §2.2 `ShipConfig`), so the tuning slider is audible (half thrust → ~0.5 level). Contour: smooth fade-in ramping over `THRUSTER_HUM_GROWTH_TIME` (30 ms at reference thrust) and ~4× quicker decay when thrust stops (mirrors the flame growth/shrink timing), with no clicks on retrigger; volume ≤ 0.075 (halved from 0.15 to sit comfortably behind other cues, within the "≤ 0.2" ceiling for all player cues). Driven per-frame by `Player.preUpdate` → `getEngineSoundLevel(state, input, thrustAcceleration)` → `updateThrusterSound(level)` for both `fourDirectional` (any arrow/WASD) and `asteroids` (forward/turn) schemes; stops on release, respawn, player destroy, or scene shutdown so no audio nodes leak.
- **Player destruction** — the dedicated `playPlayerDestructionSound()` in `src/audio/effects.ts` is a heavier, layered cue distinct from the generic enemy `playDestructionSound()` (440 → 60 Hz sawtooth): a sawtooth impact thump (120 → 32 Hz, ~0.4 s) plus a slower triangle body sliding 260 → 42 Hz (~0.6 s) and a short high-pass filtered noise tail (~0.28 s) for the shrapnel hiss. It is played **exactly once** per player destruction by the shared `spawnPlayerDeathJuice` helper (§7.2) and fully replaces the generic enemy cue on the player-death paths (`PlayScene._loseLife`, `CombatScene.applyPlayerHit`, and the inherited `GymPowerUpsCombat` hit lifecycle). Its amplitudes and lengths are exported `PLAYER_DESTRUCTION_*` constants, and every layer stays within the ≤ 0.2 player-cue volume ceiling. The wave timeout no longer costs a life (AH-0MUNS3ZQ1002DJ9S); shield absorption keeps the generic cue, and the dedicated cue is a safe no-op without an `AudioContext`.
- **End-of-run victory fanfare** — `playVictoryFanfareSound()` in `src/audio/effects.ts` is a long, multi-layer celebration built as a two-phrase fanfare. The **call** is a rising major arpeggio (triangle C5 → E5 → G5 → C6, `VICTORY_ARPEGGIO_FREQS`, `VICTORY_ARPEGGIO_STEP` 0.2 s, each note ringing `VICTORY_ARPEGGIO_NOTE_DURATION` 0.36 s at `VICTORY_ARPEGGIO_VOLUME` 0.15); the **answer** is a faster rising cadence (triangle C6 → E6 → G6 → C7, `VICTORY_CADENCE_FREQS`, `VICTORY_CADENCE_STEP` 0.16 s at `VICTORY_CADENCE_VOLUME` 0.17) that resolves into a sustained major chord (sine C6/E6/G6/C7, `VICTORY_CHORD_FREQS`, held `VICTORY_CHORD_DURATION` 1.6 s at `VICTORY_CHORD_VOLUME` 0.1) with a low bass bed (sine C4/G4, `VICTORY_BASS_FREQS`, `VICTORY_BASS_DURATION` 1.8 s at `VICTORY_BASS_VOLUME` 0.08), a high sparkle flourish (sine 2349–4186 Hz, `VICTORY_SPARKLE_FREQS`) and a soft high-passed shimmer crackle tail (`VICTORY_SHIMMER_FILTER_HZ` 6000 Hz at `VICTORY_SHIMMER_VOLUME` 0.045). It plays **exactly once** at the moment the boss dies (`PlayScene._damageBoss`), while the sustained visual celebration lives on `GameOverScene` (§7.2); total duration is ~3.3 s, every layer peaks at ≤ 0.2, and it is a safe no-op without an `AudioContext`. Deliberately SFX-only — no background music (§7.3 out of MVP scope). A producer audit (2026-10-04) rejected the original single-scale cue as "nothing more than a monotonic peep"; the two-phrase rebuild directly addresses that.
- **End-of-run defeat sting** — `playDefeatStingSound()` in `src/audio/effects.ts` is the sombre counterpart: a slow five-note descending minor line (triangle G4 → F4 → D4 → B3 → G3, `DEFEAT_STING_FREQS`, `DEFEAT_STING_STEP` 0.3 s, each note ringing `DEFEAT_STING_NOTE_DURATION` 0.55 s at `DEFEAT_STING_NOTE_VOLUME` 0.14) over a sustained low drone (sine 98 Hz, `DEFEAT_STING_DRONE_HZ`) that **sinks in pitch** to `DEFEAT_STING_DRONE_END_HZ` 73.42 Hz as it fades over `DEFEAT_STING_DRONE_DURATION` 2.2 s, with a dark low-pass filtered noise tail (`DEFEAT_STING_TAIL_FILTER_HZ` 280 Hz, `DEFEAT_STING_TAIL_DURATION` 1.4 s). It is triggered **exactly once** on the defeat branch of `GameOverScene` (gated by the shared `ENDOFRUN_ENABLE_SOUND` toggle) and is structurally distinct from `playPlayerDestructionSound()` — a slow discrete descending line with a **low-pass** rumble wash versus that cue's fast sawtooth sweep with a **high-pass** shrapnel hiss. Total duration is ~2.9 s, every layer peaks at ≤ 0.2 and it is a safe no-op without an `AudioContext`.
- **Wave timeout carry-over (no detonation)** — when the wave timer expires, survivors are **kept** and carry over into the next wave (AH-0MUNS3ZQ1002DJ9S); the previous 10× detonation and the per-ship `playMajorExplosionSound()` cue were retired with the punitive penalty. `playMajorExplosionSound()` and its `MAJOR_EXPLOSION_*` limiter remain in `src/audio/effects.ts` (a safe no-op without an `AudioContext`), and the shared `detonateWaveTimeoutSurvivors` helper (`src/scenes/core/waveTimeout.ts`) is now a no-op so `PlayScene._timeoutWave` and the **enemy gyms** (`GymEnemies` / `GymMinerals` / `GymPowerUpsCombat`, AH-0MUNR5LM1004B223, AH-0MUK5ONAA0007YEX) run one carry-over path. The boss (`GymBoss` and the `boss` config) still opts out of the timeout.
- **Phase Shift activation** — every automatic danger-triggered activation and every P7-teleport activation plays the dedicated `playPhaseShiftSound()` (parent AH-0MUIYX1EE008FVS8): a rising triangle chirp (320 → 1560 Hz, ~0.28 s) layered with a bandpass noise whoosh sweeping 600 → 3200 Hz (~0.24 s), so the cue reads as "phase engaged" and is distinct from the descending destruction cues. Every layer stays within the ≤ 0.2 player-cue ceiling, the cue is triggered from the single shared `CombatScene` activation sites (`_updatePhaseShiftAutoTrigger` and `triggerTeleport` — never per scene), and it is a safe no-op without an `AudioContext`.
- **Volume-change feedback** — adjusting the SFX volume slider in `SettingsScene` plays the existing player-explosion cue via `playVolumeFeedback()` (AH-0MUADK77K008RBMB): its pitch/synthesis is unchanged and only the gain is scaled by the selected volume, so the player hears the hull-breach boom at a loudness matching the setting. The cue fires after each keyboard left/right nudge and exactly once on slider-drag release (never during the drag, so a drag does not emit a stream of overlapping booms). Like every other cue it routes through the master SFX gain node, so it respects the current mute state and volume (silent while muted). Mute-toggle feedback is intentionally out of scope. Safe no-op without an `AudioContext`.
- **Shoot cues play once per shot** (not once per bullet), keyed off each
  firing weapon, so fast weapons (e.g. Rapid at 125 ms) stay legible.
- **Pickup activation cues** are unique per pickup type and distinct from the
generic collection chime and weapon-change arpeggio, so the player knows at a
glance which bonus was collected. In addition, every collection plays the
generic percussive pop (`playPowerUpCollectPopSound()`) for immediate tactile
feedback.
- **Collection absorb VFX** — every collected drop (power-up or weapon) is
visibly "sucked into the ship" by a shared absorb animation
(`src/powerups/collectAnimation.ts`): over ≤ 0.3 s its position converges on the
ship's world position, its scale shrinks to zero, and its shape shears/rotates
toward the hull before its `Graphics` is destroyed. One generic treatment is
used for all drop types. The VFX is cosmetic only — the gameplay effect (and
P4 bullet clear) plus the SFX fire immediately on overlap, so responsiveness is
unchanged.
- All player cues keep volume ≤ 0.2 so they read over enemy audio without
drowning it out, and every cue degrades to a safe no-op without an
AudioContext (headless tests, autoplay-blocked browsers).

#### Advance Telegraphing (≥ 500 ms Lead Time)

Key events are announced by an **advance audio cue** with a minimum 500 ms lead time before the visual event:

- **Boss entrance** — Low rumble before boss appears
- **Boss phase transitions** — Rising tone before new attack pattern
- **Level 4–5 enemy fire** — Short warning tone before bullets fire
- **Level 5 Phaser firing cycles** — Ascending beep before each cycle (see §4.1)
- **Wave spawns** — Subtle chime before enemies appear
- **Power-up spawns** — Brief chime before power-up appears

#### Background Music

Background music is explicitly a **nice-to-have** and **out of scope for the MVP**. Simple SFX only. If music is added later, it would be a separate work item.

#### Browser Autoplay Policy

AudioContext must be created and resumed only after a user gesture (e.g., clicking Start/Play). Audio is silent until the user interacts with the game. This is documented in §6.7 (risk entry).

#### SFX Rate Limiting

To prevent cacophony from high-frequency events, SFX instances are rate-limited (maximum 3–4 concurrent sounds). Auto-fire and rapid bullet hits use short, low-volume sounds to minimize overlap impact. The wave-timeout path no longer plays a cue (survivors carry over, AH-0MUNS3ZQ1002DJ9S); the retired `playMajorExplosionSound()` retains its `MAJOR_EXPLOSION_MAX_VOICES` (4) limiter and `MAJOR_EXPLOSION_OVERFLOW_ATTENUATION` should it be reused. See §6.7 (risk entry).

---

## 8. Future Scope (Out of MVP)

The following are explicitly **out of scope** for the MVP but should be tracked as future work items:

| Feature | Description |
|---------|-------------|
| **Difficulty scaling** | Easy / Normal / Hard modes with adjusted enemy counts, bullet speeds, and fire rates. |
| **Online leaderboard** | Backend service for persistent, cross-machine leaderboards. |
| **Additional levels** | Levels 6–10+ with new enemy types and pattern variations. |
| **Online multiplayer** | Co-op or competitive play over network. |
| **Background music** | Synthwave / retro electronic soundtrack (SFX is in scope for MVP per §7.3). |
| **Save/load game state** | Pause and resume functionality. |
| **Achievements** | Unlockable challenges and rewards. |
| **Mobile support** | Touch controls for mobile devices. |

---

## 9. Appendix: Clarifying Questions & Answers

All clarifying questions and their answers from the intake process are captured in the parent work item (AH-0MT7O8KCY0059RA5). This GDD incorporates the following key decisions:

1. **Full 2D movement** — Not lane-based. The player has free movement in all directions.
2. **5 levels** — Expanded from the initial 3; Levels 1–3 are formation-based, Level 4 adds enemy fire, Level 5 has fewer enemies with predictable bullet patterns.
3. **Pre-boss wave** — Level 5 is explicitly an enemy-fired-projectile level with fewer enemies and predictable patterns.
4. **Engine selected** — Phaser (TypeScript/HTML5) is the locked engine choice. The engine policy bans UI-heavy engines (Godot/Unity); Phaser satisfies the code-first constraint.
5. **Living document** — The GDD is not rigid; it may be edited during development with worklog-tracked changes.
6. **Local leaderboard** — Simple `localStorage` for the MVP; no backend required.
7. **Controls** — WASD/Arrow keys, auto-fire, S or ↓ for teleport power-up.
8. **Tron-inspired neon vector aesthetic** — Confirmed.
9. **Magnet power-up (P9)** — Confirmed via interactive intake for AH-0MT7VE4SX0005A8V:
   - **Duration/stacking model** (Q: "Temporary timed effect or permanent upgrade?") — Answer: **permanent**; each pickup permanently increases the attraction radius for the rest of the run. **Revised by AH-0MUTOTLCY005NZ8L:** P9 is now a hybrid — a **15 s refreshing** timed effect as a field pickup, and a **permanent stacking** effect when chosen as a hold-full reward — matching P10 Mineral Scoop.
   - **Scope of attraction** (Q: "Attract all power-up types on screen, or only standard types?") — Answer: **all** — including rare types such as P8 Extra Life.
   - **Base radius** (Q: "Any preference on base radius or propose defaults?") — Answer: **2× the player ship size** (later halved to **1×** by AH-0MUTTAHQ9001T83A).
   - **Per-stack increment and cap** (planned defaults, per planning for AH-0MT7VE4SX0005A8V): **+50% radius per stack**, capped at **5 stacks**. Operator may override at review.
   - **Attraction speed** — **slower than the ship's movement speed**, so the player must still move toward the power-up (or remain stationary for it to drift in) to collect it.

---

## 10. Validation Checklist

| AC | Status | Covered By |
|----|--------|------------|
| **AC1** — Document exists at `docs/Game Design Document.md` | ✅ | This document |
| **AC2** — Game identity section (title, genre, pitch, audience, aesthetic) | ✅ | §1 |
| **AC3** — Core gameplay loop (formation waves, 2D movement, auto-fire, power-up, pre-boss wave) | ✅ | §2 |
| **AC4** — MVP content (5 levels, 1 boss, 3 lives, 9+ power-ups, local leaderboard, no difficulty scaling) | ✅ | §3 |
| **AC5** — Content catalogs (enemies, waves, boss, power-ups, scoring, progression) | ✅ | §4 |
| **AC6** — Technical architecture (selected engine, module breakdown, data model, save design, risks) | ✅ | §6 |

---

*End of Game Design Document.*