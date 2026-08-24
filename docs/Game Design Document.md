# Game Design Document — AI_Hell

> **Living Document** — This GDD may be edited during development as the game evolves. All changes should be tracked in the worklog so decisions remain traceable. Last updated: 2026-08-24.

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
| **Space** | Activate movement power-up (dash/teleport away from nearest threat) |

### 2.2 Movement

- **Full 2D movement** on a 2D plane (not lane-based). The player ship can move freely in all directions within the screen bounds.
- Movement speed is constant; acceleration and deceleration are smooth but responsive.

### 2.3 Combat Mechanics

- **Auto-fire**: The player ship fires continuously without any input. The fire rate is fixed and consistent.
- **Collision model**:
  - **Early levels (1–3)**: Enemies are the primary collision threat. Flying into an enemy destroys the player ship (same effect as being hit by a bullet). The enemies themselves **are** the bullets — their formation movements are the hazard.
  - **Later levels (4–5)**: Enemies additionally fire projectiles, adding a second layer of threat. The enemies remain as collision threats as well.
  - **Boss level**: Boss fires complex bullet patterns; enemies may also fire.
- **Power-ups**: Collected by flying over them. They provide temporary or permanent abilities. **Space bar** activates the movement-type power-up (see §4.4).

### 2.4 The "Enemies Are the Bullets" Design

In the first levels, enemies move in coordinated formation patterns across the screen. These formations **are** the primary hazard — the player must navigate through or avoid enemy formations just as in a traditional bullet hell, where the bullets themselves are the threat. The enemies do not fire projectiles in these levels; their positional threat is sufficient.

This creates a unique gameplay tension: the player must manage both their own ship's position relative to the formations and their auto-fire trajectory against enemies.

### 2.5 Enemy-Fired Projectiles (Levels 4–5 and Boss)

- Starting in **Level 4**, enemies begin firing bullets in recognizable patterns.
- **Level 5 (the final pre-boss level)**: Contains a **smaller number of enemies** than earlier levels, but these enemies fire bullets in **predictable, repeating patterns**. This level tests the player's ability to learn and memorize patterns before the boss encounter.
- Bullet patterns include radial bursts, sweeping arcs, and aimed shots.
- The predictability of patterns is intentional — players should be able to learn and exploit them through practice.

---

## 3. MVP Vertical-Slice Content

### 3.1 Scope Summary

| Element | Value | Notes |
|---------|-------|-------|
| **Levels** | 5 | Levels 1–3: enemies-as-bullets formations; Level 4: enemies fire bullets; Level 5: fewer enemies, predictable bullet patterns |
| **Boss encounters** | 1 | Final boss after Level 5 |
| **Lives** | 3 | Per-run; no continue mechanic |
| **Power-up types** | ≥ 6 | Distinct types (see §4.4) |
| **Leaderboard** | Local storage | localStorage-based, single-machine |
| **Difficulty scaling** | **Out of scope** | Not implemented in MVP |
| **Multiplayer** | **Out of scope** | Single-player only in MVP |

### 3.2 Level Progression Overview

| Level | Theme | Enemy Count | Enemy-Fired Bullets | Description |
|-------|-------|-------------|---------------------|-------------|
| 1 | Entry | Moderate | No | Introduction to formation waves; simple movement patterns |
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
- **Threat level**: Low (early levels only).
- **Fires**: No (Levels 1–3); yes, aimed shot (Level 4+).

#### E2 — Diver
- **Behavior**: Dives toward the player in a curved trajectory, then returns to formation.
- **Appearance**: Medium, dart-shaped neon entity.
- **Threat level**: Medium.
- **Fires**: No (Levels 1–3); yes, short-burst spread (Level 4+).

#### E3 — Tank
- **Behavior**: Slow, deliberate formation movement; holds position longer than other types.
- **Appearance**: Larger, hexagonal or blocky neon shape.
- **Threat level**: Medium–High (acts as an immovable obstacle in formations).
- **Fires**: No (Levels 1–3); yes, radial burst (Level 4+).

#### E4 — Phaser (Level 5 exclusive)
- **Behavior**: Moves slowly in a fixed orbital path; fires in predictable, repeating cycles.
- **Appearance**: Circular neon ring with a central core.
- **Threat level**: Medium (but high pattern-based challenge).
- **Fires**: Yes — predictable radial or aimed patterns with clear tell animations.

#### E5 — Swarm
- **Behavior**: Moves in tight, fast-moving clusters; changes direction suddenly.
- **Appearance**: Small, diamond-shaped neon entities in groups.
- **Threat level**: High (positional threat in dense formations).
- **Fires**: No (Levels 1–3); yes, coordinated burst (Level 4).

### 4.2 Wave / Formation Structures

Each level consists of one or more **waves** of enemies. A wave is a set of enemies that spawn together, execute their pattern, and are cleared when all are destroyed.

| Wave Type | Description | Levels |
|-----------|-------------|--------|
| **Line** | Enemies fly across in a horizontal or diagonal line | 1, 2 |
| **V-Formation** | Classic V-shape advancing across the screen | 1, 2, 3 |
| **Circle** | Enemies form a rotating circle, occasionally breaking out | 2, 3 |
| **Wall** | Dense horizontal line of enemies that advances slowly | 3 |
| **Dive Bomb** | Enemies alternate between formation flight and diving toward the player | 3, 4 |
| **Orbital** | Enemies in fixed orbital paths around a central point (Level 5) | 5 |
| **Boss Phases** | The boss cycles through 3–4 distinct attack patterns | Boss |

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

The player collects power-ups dropped by destroyed enemies (random chance, ~15–20% per enemy). There are **6+ distinct types**:

| ID | Name | Effect | Icon Suggestion |
|----|------|--------|-----------------|
| P1 | **Spread Shot** | Fires 3 bullets in a fan pattern for 10 seconds | Triple-line neon arc |
| P2 | **Rapid Fire** | Doubles fire rate for 10 seconds | Firing-rate waveform |
| P3 | **Shield** | Absorbs one hit; visible shield bubble for 15 seconds | Shield outline |
| P4 | **Bomb** | Clears all on-screen bullets and deals damage to enemies | Exploding circle |
| P5 | **Speed Boost** | Increases movement speed by 50% for 10 seconds | Arrow with motion lines |
| P6 | **Phase Shift** | Player becomes briefly intangible (passes through enemies and bullets) for 3 seconds | Ghostly outline |
| P7 | **Dash** *(Space-activated, permanent)* | Press Space to dash/teleport away from the nearest enemy in the opposite direction; 3-second cooldown | Dash/teleport symbol |

> **P7 (Dash)** is unique: it is always available and activated by the **Space bar**. It is not a temporary power-up but a core ability that is always active. It may be visually enhanced by collecting other power-ups (e.g., Speed Boost increases dash distance), but the base ability is always present.

### 4.5 Scoring System

| Action | Points |
|--------|--------|
| Destroy E1 Scout | 100 |
| Destroy E2 Diver | 200 |
| Destroy E3 Tank | 300 |
| Destroy E4 Phaser | 250 |
| Destroy E5 Swarm | 150 |
| Destroy Boss Phase 1 | 1000 |
| Destroy Boss Phase 2 | 2000 |
| Destroy Boss Phase 3 | 3000 |
| Destroy Boss Phase 4 | 5000 |
| Time bonus (per level) | 50 × seconds remaining |
| Combo bonus | +10% per consecutive enemy destroyed without being hit (stacks up to 5×) |

- **Score display**: Neon-styled numeric display in the top-right corner.
- **Combo indicator**: Neon bar or counter in the top-left that fills with consecutive kills.

### 4.6 Level Progression Mechanics

- Beating a level advances to the next level automatically.
- If the player runs out of lives (3 total), the game ends and the **final score** is submitted to the local leaderboard.
- There is **no continue** mechanic. Game over is final.
- Players may restart from Level 1 at any time after a game over.

---

## 5. Leaderboard

### 5.1 Design

- **Storage**: Browser `localStorage` (key: `ai_hell_leaderboard`).
- **Entry**: On game over, prompt for a 3-character **neon-style initials** entry (max 10 entries).
- **Display**: Shown on the game-over screen; accessible from the main menu.
- **Content**: Rank, initials, score, date.

### 5.2 Data Model

```json
{
  "entries": [
    { "rank": 1, "initials": "AI_", "score": 50000, "date": "2026-08-24" }
  ]
}
```

---

## 6. Technical Architecture

### 6.1 Engine Policy

- **No engine with an extensive UI/editor** — Godot, Unity, and similar are explicitly excluded.
- **Code-first game engine libraries are encouraged** — the game should be built primarily through code, not through visual editors or scene builders.
- The game must **run on the web** and be **distributable as a Windows binary**.

### 6.2 Engine Options

#### Option A: Phaser (TypeScript / HTML5) — **Recommended**

| Aspect | Details |
|--------|---------|
| **Pros** | Mature 2D game framework with built-in scenes, physics (Arcade or Matter), tweening, input handling, and asset management. Large ecosystem, extensive documentation, and active community. Fast to scaffold a playable prototype. Ideal for a tutorial project where time is limited. |
| **Cons** | Opinionated framework layer over the raw game loop; some abstraction to learn. Less "from scratch" educational value for AI-framework demonstration. |
| **Best for** | Rapid development with a robust feature set; best balance of speed and capability for a tutorial/demonstration project. |

#### Option B: PixiJS + Hand-Written Game Loop (TypeScript)

| Aspect | Details |
|--------|---------|
| **Pros** | Rendering-focused WebGL library — maximum control over the game loop, entity systems, and architecture. Excellent for teaching game development fundamentals and AI-framework integration. Minimal abstraction. |
| **Cons** | No built-in scene management, physics, collision detection, or audio — all must be hand-rolled. More boilerplate and development time. |
| **Best for** | Maximum architectural control and didactic value; teaching the game loop and entity systems by hand. |

#### Option C: Plain HTML5 Canvas + TypeScript (No Game Library)

| Aspect | Details |
|--------|---------|
| **Pros** | Zero external game-library dependencies. Maximum didactic value — every aspect (input, game loop, rendering, collision, audio) is hand-rolled. Perfect for an AI-framework tutorial where the code itself is the demonstration. |
| **Cons** | Slowest to build. Input handling, game loop timing, collision detection, and rendering all require custom implementation. No built-in asset management or scene system. |
| **Best for** | Maximum educational value and minimum dependencies; the code is the product. |

#### Recommendation

**Option A (Phaser)** is recommended for the MVP because:
- The tutorial context prioritizes getting a playable game quickly.
- Phaser's built-in features (scenes, tweens, input) align well with the GDD's requirements.
- It still satisfies the "code-first" constraint — the game is built through TypeScript code, not a visual editor.
- If the team later decides to refactor for more educational value, Phaser can be replaced with Option B or C.

> **Final engine selection is an implementor decision.** This GDD presents the options and recommendation but does not lock in the choice. The selected engine must still satisfy the web + Windows binary constraint.

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
│   └── Input.ts         — Input handling (keyboard, auto-fire)
├── entities/
│   ├── Player.ts        — Player ship
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
│   ├── PowerUp.ts       — Base power-up class
│   ├── SpreadShot.ts    — P1
│   ├── RapidFire.ts     — P2
│   ├── Shield.ts        — P3
│   ├── Bomb.ts          — P4
│   ├── SpeedBoost.ts    — P5
│   ├── PhaseShift.ts    — P6
│   └── Dash.ts          — P7 (always active)
├── waves/
│   ├── WaveManager.ts   — Wave spawning and management
│   └── Formations.ts    — Formation movement patterns
├── ui/
│   ├── HUD.ts           — Heads-up display (score, lives)
│   ├── Menu.ts          — Main menu, game-over screen
│   └── Leaderboard.ts   — Leaderboard display and input
├── audio/
│   └── AudioManager.ts  — Sound effects and music
├── data/
│   ├── enemyData.ts     — Enemy stat definitions
│   ├── bossData.ts      — Boss phase definitions
│   └── scoring.ts       — Scoring constants
└── utils/
    ├── collision.ts     — Collision detection
    └── math.ts          — Helper math functions
assets/
├── images/              — Neon vector graphics (placeholder_ prefix)
└── audio/               — Sound effects and music
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
  combo: number;
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
  health: number;
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
| `ai_hell_settings` | Sound volume, control bindings |
| `ai_hell_lastSession` | Last played score (optional, for "continue" if added later) |

**Migration note**: If the project later adds online leaderboards, the local storage layer should be abstracted behind an interface so it can be swapped for an API backend.

### 6.7 Key Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Performance on web** — Many bullets and enemies on screen simultaneously could cause FPS drops. | High | Optimize collision detection (grid-based); limit concurrent bullet count; use object pooling. |
| **Pattern design complexity** — Creating 5 distinct, balanced levels of bullet patterns is time-consuming. | Medium | Start with simple patterns; iterate based on playtesting; reuse pattern primitives. |
| **Neon aesthetic consistency** — Achieving a cohesive Tron-inspired look requires careful color and glow management. | Medium | Define a limited neon color palette early; use a single post-processing glow effect if available. |
| **Engine selection lock-in** — Choosing Phaser may make a later refactor harder if the team wants more control. | Low | Keep game logic decoupled from engine-specific code; abstract core systems (input, rendering, game loop) behind interfaces. |
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

### 7.2 Visual Style

- **Glow effects**: All neon elements have a subtle bloom/glow (outer glow, not inner shadow).
- **Shapes**: Geometric, angular shapes — triangles, chevrons, hexagons, rings. No organic forms.
- **Animations**: Smooth, fluid motion for formations; sharp, precise motion for bullets.
- **Particle effects**: Minimal — use for explosions (enemy destruction) and power-up collection.

### 7.3 Audio Direction (Out of Scope for MVP, Noted for Future)

- **Music**: Synthwave / retro electronic, low-tempo, atmospheric.
- **SFX**: Neon-inspired — crisp, digital sounds (blips, zaps, hums).
- **Out of scope for MVP**: Audio is a nice-to-have but not required for the initial vertical slice. Visual feedback (screen shake, flash) can substitute temporarily.

---

## 8. Future Scope (Out of MVP)

The following are explicitly **out of scope** for the MVP but should be tracked as future work items:

| Feature | Description |
|---------|-------------|
| **Difficulty scaling** | Easy / Normal / Hard modes with adjusted enemy counts, bullet speeds, and fire rates. |
| **Online leaderboard** | Backend service for persistent, cross-machine leaderboards. |
| **Additional levels** | Levels 6–10+ with new enemy types and pattern variations. |
| **Online multiplayer** | Co-op or competitive play over network. |
| **Sound and music** | Full audio implementation. |
| **Save/load game state** | Pause and resume functionality. |
| **Achievements** | Unlockable challenges and rewards. |
| **Mobile support** | Touch controls for mobile devices. |

---

## 9. Appendix: Clarifying Questions & Answers

All clarifying questions and their answers from the intake process are captured in the parent work item (AH-0MT7O8KCY0059RA5). This GDD incorporates the following key decisions:

1. **Full 2D movement** — Not lane-based. The player has free movement in all directions.
2. **5 levels** — Expanded from the initial 3; Levels 1–3 are formation-based, Level 4 adds enemy fire, Level 5 has fewer enemies with predictable bullet patterns.
3. **Pre-boss wave** — Level 5 is explicitly an enemy-fired-projectile level with fewer enemies and predictable patterns.
4. **Code-first engines allowed** — The engine policy bans UI-heavy engines (Godot/Unity) but encourages code-first libraries (Phaser, PixiJS, plain Canvas).
5. **Living document** — The GDD is not rigid; it may be edited during development with worklog-tracked changes.
6. **Local leaderboard** — Simple `localStorage` for the MVP; no backend required.
7. **Controls** — WASD/Arrow keys, auto-fire, Space for dash power-up.
8. **Tron-inspired neon vector aesthetic** — Confirmed.

---

## 10. Validation Checklist

| AC | Status | Covered By |
|----|--------|------------|
| **AC1** — Document exists at `docs/Game Design Document.md` | ✅ | This document |
| **AC2** — Game identity section (title, genre, pitch, audience, aesthetic) | ✅ | §1 |
| **AC3** — Core gameplay loop (formation waves, 2D movement, auto-fire, power-up, pre-boss wave) | ✅ | §2 |
| **AC4** — MVP content (5 levels, 1 boss, 3 lives, 6+ power-ups, local leaderboard, no difficulty scaling) | ✅ | §3 |
| **AC5** — Content catalogs (enemies, waves, boss, power-ups, scoring, progression) | ✅ | §4 |
| **AC6** — Technical architecture (2–3 engine options, pros/cons, module breakdown, data model, save design, risks) | ✅ | §6 |

---

*End of Game Design Document.*