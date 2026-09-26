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
> Right = **turn right** (rotation 3 rad/s) — never 4-directional movement.
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

- **Auto-fire**: The player ship fires continuously without any input (GDD §2.3; implemented in the GymWeapons gym, `src/scenes/gym/GymWeapons.ts`). Bullets fire in the direction of travel — the current velocity heading — falling back to the **most recent** non-zero heading when the ship is stationary (default before any movement: right / 0°). The fire rate and shot pattern depend on the **active weapons** (§4.4): the permanent **Cannon** fires a single bullet straight ahead every ~400 ms; weapon power-ups (Spread/Dual/Rapid) are **cumulative and timed** — each collected power-up is **added** to the active set for **10 seconds** (independent countdown per weapon) and **all** active weapons fire simultaneously, each at its own rate, before the timed ones silently expire (Reset clears them instantly, leaving only the Cannon).
- **Bullet range and wrap-around**: Every bullet — player and enemy — **wraps across all four screen edges** using the same classic Asteroids model as the player ship and asteroids (leave left → reappear right, etc.). A bullet is **never** removed merely for leaving the screen. Instead, each bullet type has its own **lifetime in seconds** (effective range = `bulletSpeed × lifetime`, §4.4); a bullet is destroyed only once its lifetime elapses. Wrapping is **positional only** — like the ship and asteroids, bullets do not collide across the seam.
- **Collision model**: The player loses **one life** when hit by **any** object — an enemy body or an enemy-fired bullet. Hits never deal partial damage; there is **no player health bar**. The player starts with 3 lives (§3.1); collecting **P8 – Extra Life** grants +1 life (up to a maximum of 5). A hit costs one life and the run continues until the lives run out.
  - **Early levels (1–3)**: Enemies are the primary collision threat. Flying into an enemy costs the player one life (same effect as being hit by a bullet). The enemies themselves **are** the bullets — their formation movements are the hazard.
  - **Later levels (4–5)**: Enemies additionally fire projectiles, adding a second layer of threat. Being hit by a projectile also costs one life. The enemies remain as collision threats as well.
  - **Boss level**: Boss fires complex bullet patterns; enemies may also fire. Bullet hits cost one life, exactly as on other levels.
- **Enemy health**: All regular enemies (E1–E5) are destroyed by a single player bullet hit (1 HP). Only the Boss (§4.3) is multi-hit via its 4-phase health bar. This means P4 Bomb (see §4.4) does not deal damage to enemies — it clears on-screen enemy bullets only.
- **Power-ups**: Dropped by destroyed enemies and collected by flying over them (§4.4). Most provide **temporary** abilities; some are permanent or stored — **P7 Teleport** (stored, activated with S or ↓), **P8 Extra Life** (permanent +1 life), and **P9 Magnet** (permanent attraction). **S key or ↓** activates the teleport power-up while the player holds at least one Teleport power-up.
- **Audio feedback**: All key game events produce immediate, distinct audio cues (see §7.3). This includes player fire, enemy destruction, power-up collection, player hits, and key events (boss entrance, wave spawns, phase transitions) which are announced by an advance audio cue with ≥ 500 ms lead time before the visual event.

### 2.4 The "Enemies Are the Bullets" Design

In the first levels, enemies move in coordinated formation patterns across the screen. These formations **are** the primary hazard — the player must navigate through or avoid enemy formations just as in a traditional bullet hell, where the bullets themselves are the threat. The enemies do not fire projectiles in these levels; their positional threat is sufficient.

This creates a unique gameplay tension: the player must manage both their own ship's position relative to the formations and their auto-fire trajectory against enemies.

### 2.5 Enemy-Fired Projectiles (Levels 4–5 and Boss)

- Starting in **Level 4**, enemies begin firing bullets in recognizable patterns.
- **Level 5 (the final pre-boss level)**: Contains a **smaller number of enemies** than earlier levels, but these enemies fire bullets in **predictable, repeating patterns**. This level tests the player's ability to learn and memorize patterns before the boss encounter.
- Bullet patterns include radial bursts, sweeping arcs, and aimed shots.
- The predictability of patterns is intentional — players should be able to learn and exploit them through practice.

---

### 2.6 Enemy Interaction Rules

The following rules govern how enemy entities interact with each other and with bullets. These rules are universal across all levels and enemy types.

- **Enemy pass-through**: Enemies **do not collide with or block** other enemies at any time. All enemy types pass freely through one another regardless of formation, wave, or level. This applies to all enemy types (E1–E5) and all wave configurations (Line, V-Formation, Circle, Wall, Dive Bomb, Orbital). There is no special "shielding" or "blocking" behavior between enemy types.

- **Bullet–enemy interaction**: A single player bullet is **consumed** (destroyed) when it hits and destroys an enemy. The first enemy hit by a bullet is destroyed; the bullet does not pass through. There is no multi-hit bullet, no shield layer, and no piercing behavior. Each enemy requires exactly one bullet to destroy (see also §4.1 for enemy health).

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
| 1 | Entry | Moderate | No | Introduction to formation waves (Scout V-formations) plus randomly spawning, self-splitting Asteroids that drift in from a random offscreen edge every wave — simple movement patterns, no enemy bullets |
| 2 | Descent | Moderate–Large | No | Tighter formations; more complex movement |
| 3 | The Core | Large | No | Dense formations; maximum positional threat |
| 4 | Firestorm | Moderate | Yes | Enemies begin firing; introduction to bullet patterns |
| 5 | Predictable Death | Smaller | Yes (predictable) | Fewer enemies with highly structured, memorizable bullet patterns — final test before boss |
| Boss | AI Throne | N/A | Yes (complex) | Final boss encounter with multi-phase attack patterns |

> **Note**: "Moderate," "Large," and "Smaller" are relative. The exact enemy counts per level are design decisions that can be tuned during implementation, but the progression from no-bullets to bullets to fewer-but-patterned enemies must be preserved.

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
- **Behavior**: Dives straight down toward the player (x locked at its formation slot — a vertical trajectory), then returns to its current formation slot.
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
  other. The full chain from one large is 1 + 2 + 4 = **7** destroyed enemies,
  and every spawned child counts toward the wave's alive target (dynamic
  spawn registration in `WaveManager`).
- **Wave placement — random offscreen spawner**: Asteroids are **not** a
  fixed formation group. Every **regular wave** (Levels 1–5) plans a set of
  asteroid spawns with the pure planner `src/waves/AsteroidSpawner.ts`
  (`computeSpawns`), and `PlayScene` releases each one at its scheduled time
  during the wave. Each asteroid appears **fully offscreen** on a random edge
  (top/bottom/left/right, uniform) — offset outward by its half-size plus a
  small margin — and drifts **inward** (perpendicular to the edge, with a ±30°
  spread) into the playfield. The **boss encounter spawns no asteroids**.
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

### 4.2 Wave / Formation Structures

Each level consists of one or more **waves** of enemies. A wave is a set of enemies that spawn together, execute their pattern, and are cleared when all are destroyed.

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
> encounter spawns none. The rows above describe the **formation** enemies
> only.

### 4.3 Boss Design

**Boss: The Central AI**

- **Appearance**: A large, glowing neon geometric structure (e.g., a rotating dodecahedron or layered ring system) at the center of the screen, with the name "AI_Hell" or a stylized symbol.
- **Health**: Single health bar divided into **4 phases**.
- **Phases**:
  1. **Scan**: Fires slow, predictable aimed shots; formation enemies spawn on the sides.
  2. **Firestorm**: Rapid radial bursts in all directions; enemies dive from top and bottom.
  3. **Pulse**: Screen-wide pulse wave that expands from the boss, followed by aimed shots at the player's last known position.
  4. **Desperation**: All previous patterns combined at higher speed; boss loses armor (visual cue: core becomes more exposed/bright).
- **Pattern design philosophy**: Each phase has clear telegraphing (glow, charge, audio cue) before the attack begins. Patterns should be learnable but require precise movement.

### 4.4 Power-Ups

The player collects power-ups dropped by destroyed enemies (random chance, ~15–20% per enemy for standard power-ups). There are **9+ distinct types** (note: P8 Extra Life has a reduced drop rate of ~5%, see below):

| ID | Name | Effect | Icon Suggestion |
|----|------|--------|-----------------|
| P1 | **Spread Shot** | Fires a 3-bullet fan (-30°/0°/+30° relative to heading) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Triple-line neon arc |
| P2 | **Rapid Fire** | Fires single bullets at a markedly higher rate (~125 ms) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Stacked dots (stream of bullets) |
| P3 | **Shield** | Absorbs one hit; visible shield bubble for 15 seconds | Shield outline |
| P4 | **Bomb** | Clears all on-screen enemy bullets (does not damage enemies — they are 1 HP) | Exploding circle |
| P5 | **Speed Boost** | Increases movement speed and rate of fire by 50% for 10 seconds | Arrow with motion lines |
| P6 | **Phase Shift** | Player becomes briefly intangible (passes through enemies and bullets) for 3 seconds | Ghostly outline |
| P7 | **Teleport** *(collectable)* | Press S or ↓ to teleport the player in the direction of travel to the nearest safe spot (free of enemies and bullets, clamped to screen bounds); if no safe spot exists, teleport to nearest on-screen position; each collection grants one use (consumed on activation, stacks FIFO); on arrival, player gains P6 Phase Shift effect (3-second intangibility) | Teleport symbol (portal/ripple) |
| P8 | **Extra Life** *(passive, rare)* | Collecting this power-up grants **+1 life** immediately (applied passively, no activation required). Lives are capped at **5 total** — excess pickups have no effect. Drops at **~5% chance per enemy** (significantly rarer than standard power-ups at ~15–20%). | Heart outline with neon glow |
| P9 | **Magnet** *(permanent, passive)* | Collecting this power-up permanently attracts **all power-up drops on screen** — including rare types such as P8 Extra Life — toward the player ship, making pickups easier to grab during dense bullet patterns. It is a **permanent** effect for the rest of the run (no activation key required, nothing is consumed), unlike the timed P1–P6 effects. Collecting additional Magnets **stacks**, increasing the attraction radius by **+50% per stack**, starting from a **base radius of 2× the player ship size**, up to a **cap of 5 stacks**. The attraction speed is **slower than the ship's movement speed**, so the player must still move toward the power-up — or remain stationary for it to drift in — to collect it. | Horseshoe magnet with neon glow |

> **P4 (Bomb)** is only available on levels with enemy-fired bullets (Levels 4–5 and Boss) since regular enemies (E1–E5) are 1 HP and cannot be damaged by Bomb. It clears all on-screen enemy bullets only.

> **P7 (Teleport)** is a collectable power-up like P1–P6, dropped by enemies at ~15–20% chance. Each collected Teleport grants one use, consumed when S or ↓ is pressed. Multiple Teleports stack (FIFO — earliest collected used first). Upon teleporting, the player gains the P6 Phase Shift effect (3-second intangibility, passing through enemies and bullets) to guarantee safety at the landing spot.

> **P9 (Magnet)** is a **permanent, passive** power-up dropped at the standard ~15–20% chance. It requires no activation key and is never consumed: each pickup permanently increases the attraction radius for the rest of the run (base radius **2× the player ship size**, **+50% per stack**, cap **5 stacks**). It attracts **all power-up drops on screen** (including P8 Extra Life) at a speed **slower than the ship's movement speed**, so the player still needs to move — or hold position — to collect drifted drops.

> **P1 / P2 (Weapon Power-Ups) — Cumulative and timed (10 s):** Weapon power-ups (P1 Spread Shot, P2 Rapid Fire, plus Dual) are **cumulative and timed** — collecting one **adds** it to the ship's active set for **10 seconds**, with its own independent countdown from the moment of collection (re-collecting resets only that weapon's timer). All active weapons fire simultaneously, each at its own fire rate; the **Cannon** is permanent and never times out. A fourth power-up drop, **Reset**, clears **all** timed weapons, leaving only the Cannon.

> **Bullet range — per-type lifetime + four-edge wrap:** All bullets (player and enemy) **wrap around all four screen edges** (the same classic Asteroids model as the player ship and asteroids) and are **never culled for leaving the screen**. Each bullet type is instead destroyed once its own **lifetime in seconds** elapses, so its **effective range is `bulletSpeed × lifetime`**. Player-weapon lifetimes live on `WeaponDefinition` (`src/utils/weapons.ts`): Cannon **1.5 s** (~525 px at 350 px/s), Spread **1.4 s** (~490 px), Dual **1.4 s** (~490 px), Rapid **0.75 s** (~262 px). Enemy bullet lifetimes live on `EnemyConfig` (`src/core/enemyConfig.ts`) and are overridable through the existing enemy-config / localStorage plumbing: Scout **1.5 s** (200 px/s ≈ 300 px), Diver **1.5 s** (220 px/s ≈ 330 px), Tank **2.0 s** (150 px/s ≈ 300 px), Phaser **1.75 s** (180 px/s ≈ 315 px), Swarm **1.5 s** (180 px/s ≈ 270 px), Boss Swarm **2.0 s** (160 px/s ≈ 320 px). The Central AI boss uses the same 2.0 s default. Because wrapping keeps more bullets alive, the lifetime caps on-screen density; the values above are the shipped tuning baseline (halved from the original proposal after review, AH-0MU960UTE001PTV0) and are safe to adjust without any architectural change. A bullet whose lifetime elapses is **destroyed and removed from the display list** — it never lingers on screen as a stationary projectile.

> **Implemented in the GymWeapons gym (§6.4, `src/scenes/gym/GymWeapons.ts`):** The weapon power-ups (Cannon default, Spread, Dual, Rapid) are implemented with **cumulative + timed (10 s)** semantics, along with auto-fire in the direction of travel (GDD §2.3). The scene demonstrates round-robin weapon-drop spawning (**Spread → Dual → Rapid → Reset**, one drop at a time, 7 s lifetime) and cumulative collection — each collected drop **adds** its weapon to the active set, expired weapons are **silently dropped**, and Reset clears them all. The weapon catalogue (`src/utils/weapons.ts`) provides pure definitions (pattern offsets, fire rates, bullet visuals) plus `isTimedWeapon()` (cannon = permanent, all other weapons = timed) and heading math (including the most-recent-heading fallback when stationary); `src/entities/Player.ts` exposes the cumulative weapon collection (`equipWeapon` adds, `resetWeapon` clears timed weapons), per-weapon 10 s timers (`tickWeaponTimers`), per-weapon fire cooldowns (`tryFire` returns every active weapon that fired this frame), and `src/entities/PlayerBullet.ts` the player projectile. Audio cues (spawn, despawn, collection, weapon-change) are in `src/audio/effects.ts`, and icon shapes in `src/powerups/icons.ts` visually hint at each weapon's pattern: fan arc for Spread, parallel bars for Dual, stacked dots for Rapid, return/undo arrow for Reset.

> **Implemented in the GymPowerUpsCombat gym (§6.4, `src/scenes/gym/GymPowerUpsCombat.ts`, AH-0MTC2P6G3007PJ40):** The combat-coupled power-ups **P3 Shield (15 s, absorbs one hit), P4 Bomb (instant clear of enemy bullets, no enemy damage), P6 Phase Shift (3 s intangibility), and P7 Teleport (stored FIFO stacks, S/↓ → nearest safe spot in direction of travel + P6 on arrival)** are demonstrated with **low-level scout threats** (3 scouts in V-formation, aimed fire). Round-robin spawning **P3 → P4 → P6 → P7** (one drop at a time, 5 s lifetime, grow/hold/shrink, 3% collection threshold, 32 px bubble + icon) mirrors the threat-free GymPowerUps gym but with live threats so shield absorb, bomb clear, phase pass-through and safe-spot teleport are observable. S or ↓ consumes one P7 stack; hit response respects P6 pass-through > P3 shield pop > unshielded hit + brief invulnerability blink. `findTeleportDestination` resolves the nearest safe spot (free of enemies/bullets within `TELEPORT_SAFE_RADIUS`, clamped to screen bounds). The standalone HUD (`src/ui/HUD.ts`) is reused unchanged (reads P3/P6 timers and P7 stacks from the shared `EffectsRegistry`).

> **Implemented in the combat formation gyms (§6.4, `src/scenes/gym/GymEnemies.ts` / `src/scenes/gym/GymBoss.ts`, AH-0MU3VOQKH005YOBH):** From here the enemy-bearing formation gyms run a **shared opt-in power-up layer** in `GymFormationScene`: a `WeightedRandomSpawner` over **the full drop pool — P3–P9 power-ups plus the weapon drops (Spread → Dual, Rapid, Reset)** seeded from the game-rules config (`src/core/rules.ts`), a `RandomAvoidingPlacement` strategy (`src/powerups/placement.ts`) that avoids live enemy bodies and the player, **one drop on screen at a time** on the configured interval (default **12.5 s**), fly-over collection (≥ 3 % scale; the ship hull collects a drop on first contact with its visible bubble ring — `POWER_UP_DROP_SIZE × POWER_UP_BUBBLE_RADIUS_FACTOR × scale`, 32.4 px at full scale) applied through the shared `EffectsRegistry`, and the standalone HUD with the lives counter visible (one row per active effect, plus one row per equipped weapon). The §4.4 rarity guidance is encoded as **relative weights** — standard power-up IDs (P3–P7, P9) default to **4** and **P8 Extra Life** to **1**, while each weapon drop (spread/dual/rapid/reset) defaults to **2** so weapons appear alongside standard effects without dominating them; the existing `WeightedRandomSpawner` normalises them internally. Collecting a weapon drop equips it through the registry for 10 s (independent countdown per weapon); the **Reset** drop clears every active weapon. A **live spawn-interval slider** (`src/utils/gymPowerUpControl.ts`) tunes the cadence of the running scene and persists the value through the rules config, so the interval is no longer a compile-time constant.

> **Shared P3/P6 hit-gating in the formation gyms (AH-0MUHM66ES0027QQV):** Collecting a dropped **P3 Shield** or **P6 Phase Shift** in a formation gym now has the **same defensive effect as in `PlayScene`**: the gating lives once in the shared `CombatScene` (`isPlayerPhased()` reads `getEffectsRegistry().isPhased`; `tryAbsorbPlayerHit()` consumes one shield, runs the `onShieldAbsorbed()` cue seam, starts the shared invulnerability window and reports the hit absorbed). `GymFormationScene` and its `GymEnemies`/`GymBoss`/`GymMinerals` subclasses inherit it — a gym scene must **not** re-implement the hooks. The P3 shield bubble and P6 phase ghost are drawn through the shared `CombatEffectVisuals` helper, so the enemy gym looks identical to the shipped game and the combat gym.

> **Collection feedback — pop SFX + absorb VFX (AH-0MUAYB3OU0087H9W):** Every collected drop — power-up or weapon — plays the generic percussive pop (`playPowerUpCollectPopSound()` in `src/audio/effects.ts`) alongside its existing per-type pickup cue, and is visibly "sucked into the ship" by a shared absorb animation (`src/powerups/collectAnimation.ts`): over ≤ 0.3 s the drop's position converges on the ship's world position, its scale shrinks to zero, and its shape shears/rotates toward the hull before its `Graphics` is destroyed. One generic treatment is used for all drop types; the VFX is cosmetic only and never delays the gameplay effect (registry/lives/weapon updates, P4 bullet clear), which fires immediately on overlap. Wired into `PlayScene`, the shared `GymFormationScene` (covering `GymEnemies`/`GymBoss`), and the legacy `GymPowerUpsUtility`/`GymPowerUpsCombat`/`GymWeapons` scenes so the game and gyms never diverge.

> **Catalogue descriptions + gym help overlay (AH-0MUAYB67I002REOZ):** Every catalogue entry now carries a one-line player-facing `description`: `POWER_UP_CATALOGUE.description` (`src/powerups/types.ts`) for P3–P9, and `WEAPON_CATALOGUE.description` plus a `RESET_DROP` entry (`src/utils/weapons.ts`) for Cannon/Spread/Dual/Rapid/Reset. The three tuning gyms (`GymPowerUpsUtility`, `GymPowerUpsCombat`, `GymWeapons`) each render a `Help (?)` button next to `← INDEX` and also respond to the `?` key. Opening the help **pauses** the gym's simulation and launches the full-screen `HelpScene` (`src/scenes/HelpScene.ts`), which lists **exactly the drops that gym can spawn**, one row each showing the same code-drawn icon as the field drop, the display name and the catalogue description — read from the shared catalogues so the help text cannot drift from implemented behaviour. Closing via `?`, the `Close` control (focused by default, keyboard-operable) or **ESC** resumes the gym exactly where it paused; while the overlay is open ESC closes the help and does **not** return to the menu. The shared helper is `addHelpButton` (`src/utils/gymHelp.ts`), wired into the three gyms only (the full-pool formation gyms and the shipped `PlayScene` are out of scope).

#### 4.4.1 Minerals, the Ship's Hold & the Power-Up Choice (AH-0MUBVGI62004ED9Q)

Alongside power-up drops, destroying a **small `Asteroid`** leaves a **mineral** — a small, stationary gold dot that persists until collected. Minerals are collected by flying the player ship over them, or absorbed by a **non-asteroid enemy** that overlaps them (asteroids are inert to minerals). Neither contact causes damage, and bullets pass straight through.

- **Dropping**: each destroyed small asteroid drops one mineral; large/medium asteroids drop none (their small split children do). An enemy that absorbed minerals **re-drops 25–50 %** (configurable) of its total as individual minerals scattered at its explosion site when destroyed, never exceeding the amount collected.
- **Ship's hold**: collected minerals fill a run-scoped hold (`GameState.minerals`), capacity default **20** (configurable). The hold is shown on the HUD as a fixed-length, hollow-outlined bar that fills proportionally from empty to full (`src/ui/HUD.ts`), resets on `GameState.startGame()`, and is never written to the leaderboard.
- **Hold full → power-up choice**: when the hold reaches capacity the game **pauses at the SceneManager level** and a modal overlay (`src/scenes/MineralChoiceScene.ts`) offers **three distinct** power-up options. The options come from a **pluggable strategy** (`src/powerups/choice.ts`); the default draws uniformly at random without replacement from the full drop pool (**P3–P9 plus Spread/Dual/Rapid**) and degrades gracefully when the pool has fewer than three entries.
- **Permanent pick**: the chosen option is applied to the player **permanently for the current run** — timed effects never expire and chosen weapons never time out (`EffectsRegistry.applyCollect(id, true)` / `applyWeapon(id, true)`, `Player.equipWeapon(id, true)`). Permanence is scoped to the run and cleared on reset/restart.
- **Tunables** (`src/core/rules.ts`): `mineralCollectAmount` (default 1), `mineralHoldCapacity` (20), `mineralRedropFractionMin`/`Max` (0.25/0.5).
- **Gym**: the asteroids-only `GymMinerals` gym (§6.4) demonstrates the whole loop; every formation gym also seeds 100 random minerals on create.

> **Hold-full rewards are functional in every gym (AH-0MUHMXWGC0058BO4):** The overlay renders **exactly** the option set the caller stored, so the label shown is the option applied — `PlayScene.openMineralChoice()` passes its `mineralChoiceOptions` (and active strategy) into `MineralChoiceScene`, and the gyms already pass `options` + an `onSelect` callback. In the asteroids-only `GymMinerals` — which has no field power-up drops — the P3/P6/P7 rewards granted by the hold-full choice behave as in the main game: **P7 Teleport** is bound to **S / ↓** whenever a player exists and consumes a stored use (granting P6 on arrival), **P3 Shield** and **P6 Phase Shift** are honoured through the shared `CombatScene` hit-gating hooks (`isPlayerPhased()` / `tryAbsorbPlayerHit()`), and the effects registry ticks every frame (driving the HUD) independent of the opt-in drop layer so timed effects expire normally. The teleport gate accepts a stored use (`canTeleport()` is true when `hasTeleport()`), while the opt-in drop layer still gates field-drop teleports elsewhere.

### 4.5 Scoring System

| Action | Points |
|--------|--------|
| Destroy E1 Scout | 100 |
| Destroy E2 Diver | 200 |
| Destroy E3 Tank | 300 |
| Destroy E4 Phaser | 250 |
| Destroy E5 Swarm | 150 |
| Destroy E6 Asteroid (small only) | 50 (large/medium award none) |
| Destroy Boss Phase 1 | 1000 |
| Destroy Boss Phase 2 | 2000 |
| Destroy Boss Phase 3 | 3000 |
| Destroy Boss Phase 4 | 5000 |
| Time bonus (per level) | 50 × seconds remaining |

- **Score display**: Neon-styled numeric display in the top-right corner.

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
  `addEntry(initials, score)`, `getTopN(n)` and `isQualifying(score)` — and
  persists through the injectable `LeaderboardStore` interface so a future
  online backend can replace `localStorage` without touching the scenes
  (§5.3 migration note; also §6.6).
- **Entry**: On game over, prompt for a 3-character **neon-style initials**
  entry. A score qualifies while fewer than 10 entries exist, or when it
  strictly beats the current lowest entry; a non-qualifying score shows an
  explanatory message and can be skipped without writing.
- **Display**: The full ranked table (rank, initials, score, date) is shown
  on the game-over screen (`GameOverScene`) and from the main menu
  (`MenuScene` → `LeaderboardScene`), both through the shared rendering path
  in `src/ui/leaderboardView.ts`.
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
│   ├── GameState.ts     — Game state (lives, score, level)
│   ├── Input.ts         — Input handling (keyboard, auto-fire)
│   └── rules.ts         — General game-rules config (implemented): localStorage-backed
│                          `loadRules()` / `saveRules()` holding the power-up spawn
│                          interval (default 12.5 s) and per-ID drop weights (P3–P9)
│                          for the combat gyms; `POWER_UP_SPAWN_INTERVAL` re-sources
│                          from it in `../core/constants.ts`
├── scenes/
│   ├── core/
│   │   ├── CombatCoreScene.ts — Narrower shared combat/lifecycle base (implemented,
│   │   │                      AH-0MUDCT7EU0061OSZ): owns the input path
│   │   │                      (`_readPlayerInput`), auto-fire (`_autoFire` +
│   │   │                      `spawnPlayerBullet`, with the `onWeaponFired` cue hook) and
│   │   │                      drop collection (`_collectDrop` + absorb VFX + the
│   │   │                      `onWeaponCollected`/`onPowerUpCollected`/`_playPickupCue`
│   │   │                      hooks), the player-explosion/collect registries,
│   │   │                      `_clearEnemyBullets`/`_spawnPlayerExplosion`, and the shared
│   │   │                      invulnerability/phase/absorption hooks
│   │   │                      (`getInvulnerabilityDuration`, `isPlayerPhased`,
│   │   │                      `tryAbsorbPlayerHit`). Extended directly by the threat-free
│   │   │                      gyms `GymWeapons` and `GymPowerUpsUtility`.
│   │   └── CombatScene.ts — Shared abstract combat core (implemented, AH-0MUD8E015004C4JO):
│   │                      extends `CombatCoreScene` and adds the combat-only template
│   │                      methods (`_handleCollisions`, `_hitPlayer`, `_handleTeleport`/
│   │                      `triggerTeleport`) plus the bullet-vs-bullet impact feedback
│   │                      (`src/vfx/bulletImpact.ts` + `playBulletDestructionSound`), with
│   │                      the participant accessors and combat hooks (`onWeaponFired`,
│   │                      `onEnemyDestroyed`, `onPlayerHit`, `tryAbsorbPlayerHit`,
│   │                      `onBulletVsBulletImpact`, …). Together the two files define the
│   │                      eight shared methods exactly once, enforced repo-wide by
│   │                      `CombatScene.equivalence.test.ts`; extended by `PlayScene`,
│   │                      `GymFormationScene` and `GymPowerUpsCombat`.
│   ├── MenuScene.ts     — Main-menu boot scene (implemented): Play Game → PlayScene,
│   │                      Settings → SettingsScene (audio + controls, origin MenuScene),
│   │                      Gym Scene Index (dev) → GymIndex; resumes Web Audio on click;
│   │                      FocusManager keyboard navigation (default focus on Play Game)
│   ├── PlayScene.ts     — Playable run (implemented): extends the shared `scenes/core/CombatScene`
│   │                      base (which extends `CombatCoreScene`; implementing its hooks for
│   │                      boss multi-hit, asteroid split,
│   │                      mineral absorption, wave accounting, lives/game-over and the P4
│   │                      bomb notice); WaveManager-driven levels 1–5 +
│   │                      Central AI boss, player/collisions/power-ups/HUD, transitions
│   │                      to GameOverScene on win or loss; **ESC pauses** the run and
│   │                      opens PauseScene (movement/layer-drop/pause keys are rebindable);
│   │                      mineral drops/hold and the hold-full power-up choice overlay
│   ├── MineralChoiceScene.ts — Modal hold-full power-up choice (3 distinct options, paused
│   │                      SceneManager overlay; applies the pick permanently, resumes, resets hold)
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
│   │                      scenes from scenes/gym/ via import.meta.glob)
│   └── gym/
│       ├── core/
│       │   └── GymFormationScene.ts — Shared gym formation base (implemented): extends the
│       │                      shared `scenes/core/CombatScene` (itself extending
│       │                      `CombatCoreScene`), generic over the entity/bullet
│       │                      types and driven by an `EnemyFormationConfig`; owns formation
│       │                      spawn/drift/respawn, the opt-in power-up layer and the
│       │                      enemy-only mode. Concrete E1–E5 gyms and GymEnemies/GymBoss
│       │                      supply only their entity-specific config.
│       ├── GymDiver.ts  — E2 Diver gym (key GymDiver, label "Diver")
│       ├── GymPhaser.ts — E4 Phaser gym (key GymPhaser, label "Phaser")
│       ├── GymMinerals.ts — asteroids-only mineral gym (key GymMinerals, label "Minerals"):
│       │                   small-asteroid mineral drops, hold fill + HUD hold bar,
│       │                   enemy absorption/re-drop, hold-full choice overlay (100 seeded minerals);
│       │                   choice-granted P3/P6/P7 rewards are functional (S/↓ teleport,
│       │                   shared shield/phase hit-gating, registry ticks independent of drop layer)
│       ├── GymPlayer.ts — Player movement/tuning gym (key GymPlayer, label "Player")
│       ├── GymPowerUpsUtility.ts — non-combat power-up gym (key GymPowerUpsUtility, label "PowerUpsUtility"):
│       │                  extends the narrower shared `scenes/core/CombatCoreScene`;
│       │                  round-robin P5/P8/P9 spawning, collection, standalone HUD
│       ├── GymPowerUpsCombat.ts — combat-coupled power-up gym (key GymPowerUpsCombat, label "PowerUpsCombat"):
│       │                  extends the shared `scenes/core/CombatScene` (hook-based shield/phase/bomb/invuln);
│       │                  round-robin P3/P4/P6/P7 with low-level scout threats; P3 Shield, P4 Bomb, P6 Phase, P7 Teleport (S/↓)
│       ├── GymScout.ts  — E1 Scout gym (key GymScout, label "Scout")
│       ├── GymSwarm.ts  — E5 Swarm gym (key GymSwarm, label "Swarm")
│       ├── GymTank.ts   — E3 Tank gym (key GymTank, label "Tank")
│       └── GymWeapons.ts — weapon power-up gym (key GymWeapons, label "Weapons"):
│                           extends the narrower shared `scenes/core/CombatCoreScene`;
│                           auto-fire ship + round-robin Spread/Dual/Rapid/Reset
│                           drops (7 s lifetime, persistent weapon switching)
├── entities/
│   ├── Player.ts        — Player ship (auto-fire, weapon slot)
│   ├── Mineral.ts       — Mineral collectable (small gold dot; collected by the player,
│   │                      absorbed by non-asteroid enemies; inert to bullets/asteroids)
│   ├── PlayerBullet.ts  — Player-fired projectile (Graphics, vx/vy, per-type lifetime; four-edge wrap)
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
│   ├── types.ts         — Power-up catalogue (P3–P9; P3 Shield 15 s, P4 Bomb instant, P6 Phase 3 s, P7 Teleport stored FIFO)
│   │                      with a one-line `description` per entry (gym help source of truth)
│   ├── choice.ts        — Pluggable hold-full choice strategy (default: 3 distinct random
│   │                      picks from P3–P9 + Spread/Dual/Rapid; graceful degradation)
│   ├── effects.ts       — Active-effects registry (timers, lives, P5 speed, P9 magnet, P3 shield absorb, P6 phase, P7 teleport stacks)
│   └── icons.ts         — Code-drawn neon power-up icons (shield/bomb/phase/teleport/speed/life/magnet)
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
  type: 'scout' | 'diver' | 'tank' | 'phaser' | 'swarm';
  x: number;
  y: number;
  width: number;
  height: number;
  health: number;       // All regular enemies: health = 1 (one-hit kill); Boss handled by phase system
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

  The three player-hit paths all route through the helper: `PlayScene._loseLife` (real run — `'fatal'` at 0 lives, `'respawn'` otherwise), the shared `CombatScene.applyPlayerHit` used by the formation gyms (`GymEnemies` / `GymBoss` / `GymMinerals`), and `GymPowerUpsCombat` via the inherited hit lifecycle. The wave-timeout life penalty (`_loseLife(false)`) deliberately keeps the lighter generic cue and spawns no juice VFX, and shield absorption is unchanged in both the run and the combat gym.

### 7.3 Audio Direction (MVP: In Scope — Simple SFX)

**Approach**: All sound effects use **procedural synthesis via the Web Audio API** (zero external audio assets). Sound is code-generated — crisp, digital, neon-style "blips, zaps, and hums" consistent with the Tron-inspired aesthetic. Phaser's built-in Web Audio support is available but the spec remains engine-agnostic.

#### SFX Event Catalog

| Category | Event | Sound Character | Volume | Lead Time |
|----------|-------|-----------------|--------|-----------|
| **Interactions** | Power-up pickup | Short percussive pop + "sucked into ship" absorb VFX | Medium | Immediate |
| **Interactions** | Teleport activate (S/↓) | Short whoosh + portal effect | Medium | Immediate |
| **Impacts** | Player hit (life lost) | Low, heavy layered "hull breach" boom (`playPlayerDestructionSound()`: impact thump + descending body + shrapnel hiss); replaces the generic enemy cue on the player-death paths | High | Immediate |
| **Impacts** | Enemy destroyed | Sharp pop / crack | Medium | Immediate |
| **Impacts** | Boss phase damage | Deeper zap, slightly longer decay | High | Immediate |
| **Impacts** | Player bullet hits enemy | Very short tick | Low | Immediate |
| **Impacts** | Player bullet destroys enemy bullet | Dedicated high, very short tick (`playBulletDestructionSound()`; distinct from the heavier enemy-destruction fall) + small impact flash | Low | Immediate |
| **Enemy actions** | Enemy spawn | Subtle hum rise | Low | Immediate |
| **Enemy actions** | Enemy fire (Level 4+) | Short zap | Low-medium | Immediate |
| **Enemy actions** | Dive bomb attack | Descending tone | Medium | ≥ 500 ms advance |

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

- **Thruster hum** — single ship-level continuous jet-engine roar (NOT per-engine flame port), synthesised as a soft triangle fundamental (60 Hz) with a sine undertone (35 Hz) for low rumble plus white noise through a band-pass filter (700–1100 Hz, Q 0.6–1.1) for jet-engine whoosh; filtered noise is the dominant texture, all through one reused gain node; gain follows `getEngineSoundLevel` level `min(1, thrustAcceleration / FLAME_REF_THRUST)` (GDD §2.2 `ShipConfig`), so the tuning slider is audible (half thrust → ~0.5 level). Contour: smooth fade-in ramping over `THRUSTER_HUM_GROWTH_TIME` (30 ms at reference thrust) and ~4× quicker decay when thrust stops (mirrors the flame growth/shrink timing), with no clicks on retrigger; volume ≤ 0.075 (halved from 0.15 to sit comfortably behind other cues, within the "≤ 0.2" ceiling for all player cues). Driven per-frame by `Player.preUpdate` → `getEngineSoundLevel(state, input, thrustAcceleration)` → `updateThrusterSound(level)` for both `fourDirectional` (any arrow/WASD) and `asteroids` (forward/turn) schemes; stops on release, respawn, player destroy, or scene shutdown so no audio nodes leak.
- **Player destruction** — the dedicated `playPlayerDestructionSound()` in `src/audio/effects.ts` is a heavier, layered cue distinct from the generic enemy `playDestructionSound()` (440 → 60 Hz sawtooth): a sawtooth impact thump (120 → 32 Hz, ~0.4 s) plus a slower triangle body sliding 260 → 42 Hz (~0.6 s) and a short high-pass filtered noise tail (~0.28 s) for the shrapnel hiss. It is played **exactly once** per player destruction by the shared `spawnPlayerDeathJuice` helper (§7.2) and fully replaces the generic enemy cue on the player-death paths (`PlayScene._loseLife`, `CombatScene.applyPlayerHit`, and the inherited `GymPowerUpsCombat` hit lifecycle). Its amplitudes and lengths are exported `PLAYER_DESTRUCTION_*` constants, and every layer stays within the ≤ 0.2 player-cue volume ceiling. The wave-timeout life penalty and shield absorption keep the generic cue; the dedicated cue is a safe no-op without an `AudioContext`.
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

To prevent cacophony from high-frequency events, SFX instances are rate-limited (maximum 3–4 concurrent sounds). Auto-fire and rapid bullet hits use short, low-volume sounds to minimize overlap impact. See §6.7 (risk entry).

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
   - **Duration/stacking model** (Q: "Temporary timed effect or permanent upgrade?") — Answer: **permanent**; each pickup permanently increases the attraction radius for the rest of the run.
   - **Scope of attraction** (Q: "Attract all power-up types on screen, or only standard types?") — Answer: **all** — including rare types such as P8 Extra Life.
   - **Base radius** (Q: "Any preference on base radius or propose defaults?") — Answer: **2× the player ship size**.
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