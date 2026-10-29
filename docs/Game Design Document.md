# Game Design Document — AI_Hell

> **Living Document** — This GDD may be edited during development as the game evolves. All changes should be tracked in the worklog so decisions remain traceable. Last updated: 2026-10-28.

---

## 1. Game Identity

| Field | Value |
|-------|-------|
| **Working Title** | AI_Hell |
| **Genre** | 2D top-down bullet hell |
| **Inspirations** | Galaxians, classic arcade shoot-'em-ups |
| **One-Sentence Pitch** | Pilot a ship through an AI-generated hellscape of formation waves and bullet patterns, surviving 10 levels of increasingly lethal encounters before facing the final boss. |
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

> **Teleport is automatic** (AH-0MUZE4AIP009HZWC): a stored Teleport in the recharging pool (AH-0MV82I7TX0009JMT) is
> spent automatically when the ship is in danger — no key press — so
> **S / ↓** are not overloaded and are reserved for the reverse thruster
> (AH-0MUZCSB4B00107RG). See §4.4 for the automatic-defence selection rule.

> **Control schemes:** the ship honours the player's **saved control scheme**,
> applied in every gym scene (enemy, power-up and weapons) via
> `player.getScheme()`-keyed input handlers (`FourDirectionalInputHandler` and
> `AsteroidsInputHandler` in `src/utils/movementModel.ts`). The table above
> describes the **4-directional scheme**. Under the **Asteroids
> scheme** the movement keys are re-mapped: `W`/Arrow Up = **forward thrust**
> (in the current facing direction), `A`/Arrow Left = **turn left**, `D`/Arrow
> Right = **turn right** — never 4-directional movement. Turning uses a
> constant-angular-acceleration ramp (default: spin up to a **3 rad/s** top
> speed at **12 rad/s²** while a key is held, spin down at **60 rad/s²** on
> release), so a short tap nudges the heading a few degrees while a sustained
> hold still reaches the full, responsive rotation speed. See §2.2 for the
> ramp details and tuning. **S** / **↓** = **reverse thrust** — a held
> retro-thrust opposite the facing direction, on by default and individually
> tunable or disabled in the Player gym (§2.2). The 4-directional scheme does
> not use reverse thrust, so `S` / `↓` keep their backward-thrust meaning
> there.

**Choosing the scheme in-game (AH-0MVI7LRCJ006Q8SA).** The control scheme is a
player-facing setting: **Settings → Controls → Control Scheme** cycles between
`Asteroids` and `Four Directional` with **Left/Right**, and **Enter** (or a
click) advances the selection. The options come from the `ControlScheme` union
(`CONTROL_SCHEMES` in `src/core/settingsStore.ts`), so a scheme added to the
union appears in the list automatically. The choice is stored **per player, per
device** in `ai_hell_settings.controlScheme` (§6.6) and is remembered across
runs. It takes effect immediately: a change made in the in-game Settings
applies to the running game when you return from the pause menu (mid-run), as
well as to every subsequent run from the first frame (AH-0MVIMPC11001F7WU).

The effective scheme is resolved by one helper,
`resolvePlayerControlScheme()` (`src/core/playerScheme.ts`), with an explicit
precedence:

1. the player's saved setting (`ai_hell_settings.controlScheme`), when present
   and valid;
2. otherwise the designer-owned `controlScheme` in
   [`src/data/ship-config.csv`](src/data/ship-config.csv);
3. otherwise the built-in default, `asteroids`.

The settings screen only ever writes the per-player setting — it never writes
`ship-config.csv`, which stays the designer's shipped default. The Settings
Controls rows are **relabelled** for the selected scheme (Asteroids: *Thrust /
Turn Left / Turn Right / Reverse*; four-directional: *Move Up / Move Down /
Move Left / Move Right*) while the key **bindings stay shared** across both
schemes — there are no per-scheme bindings. Gyms are unaffected: they keep
their own scheme toggle and stay config-driven.

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
  **Enter** starts a run. When a resumable checkpoint exists, a **Continue**
  control is added above it, becomes the focused default instead, and
  pressing **Enter** resumes the saved run. **Tab**/arrows cycle in visual
  order through *Continue* (when present) → *Play Game* → *Watch Demo* →
  *Settings* → *Leaderboard* → *GitHub* → *Gym Scene Index (dev)*,
  wrapping at both ends.
- **Game over (`GameOverScene`):** the initials field is focused by default
  and **A–Z** / **Backspace** edit it; **Tab**/arrows move focus to
  *Return to Menu*. **Enter** auto-submits when the initials are complete;
  **Enter**/**Space** on the button also submits and returns to the menu.
- Focus keys call `preventDefault()` so the page does not scroll or the
  browser move focus while the game has keyboard focus.
- Pointer interaction is unchanged: hovering still highlights a control and
  clicking still activates it (keyboard support is additive).

#### Attract / demo mode (AH-0MUX2NENC008AHOQ)

The game ships an optional **attract/demo mode** that plays itself — for an
arcade attract loop, capture/marketing clips, and as a regression harness.

- **Entry points:** the menu's **👁 Watch Demo** control, or **15 seconds of
  menu inactivity** (the idle-attract timer, `ATTRACT_IDLE_TIMEOUT_MS` in
  `src/scenes/MenuScene.ts`, reset by any key or pointer input). Both start
  `PlayScene` with `{ demo: true }`.
- **Start-data contract (AH-0MUY4881P007FJ8R):** Phaser reuses the `PlayScene`
  instance and only rewrites `settings.data` for a **truthy** payload, so a
  no-argument `scene.start('PlayScene')` would receive the previous
  `{ demo: true }` via `init()` and leave the bot in control. Every **normal**
  start therefore passes an explicit non-demo payload (`{ demo: false }`), and
  `PlayScene.init()` treats absent/`undefined`/non-`true` data as non-demo.
- **The bot:** a **survival-first** heuristic in `src/ai/`. A read-only,
  deep-frozen `BotSnapshot` (`buildBotSnapshot`) is built each decision tick
  from the scene's existing getters, and the pure `decideBotIntent(snapshot)`
  returns a scheme-agnostic *steering intent*: the nearest-cardinal
  four-directional projection (consumed by the `fourDirectional` scheme),
  **plus the precise bearing to the chosen target** (`dirX`/`dirY`). The
  decision uses a **utility / willingness model** (superseding the former
  fixed ladder): clearing the wave is the default objective and pickups must
  **earn** a diversion.
  1. **Survive** — never steer into a bullet, asteroid, enemy or wall when a
     safe alternative exists (best-effort fire-pattern avoidance from fire
     tells/intervals and in-flight bullets).
  2. **Clear the wave** (default) — pursue the nearest live non-asteroid
     enemy so the wave is destroyed before its 30 s time-limit carries
     survivors over.
  3. **Opportunistic diversion** — divert to a pickup only when its
     willingness clears a threshold: a mineral must belong to a **cluster**
     (a lone scattered mineral never diverts — more minerals drop when
     enemies/asteroids are destroyed, so chasing one is a net loss),
     willingness falls off with distance, and a power-up is a little more
     diverting than a lone mineral. As the wave timer runs down the threshold
     rises, so the bot stops detouring and focuses fire.
  4. **Asteroids** — engage the nearest live asteroid within range (they drop
     minerals too), keeping a minimum distance.
  5. **Idle** — nothing to do: hold station.
  All tunables live in one place (`BOT_DECISION_TUNABLES` in
  `src/ai/botDecision.ts`).
- **Predictive braking (AC10):** the ship is Newtonian and has no brakes, so
  the bot models its own **stopping distance** (`v² / 2a`, where `a` is the
  ship's friction deceleration) and stops thrusting when continuing would
  overshoot. It coasts to a controlled stop within the collection radius or
  the engagement standoff instead of flying past its target. The `thrust`
  flag is re-evaluated **every tick** (a fast reflex) while the chosen
  heading stays committed for the human reaction window; each forward-thrust
  press is held for a human-like burst (200–225 ms normally, extended to
  400 ms on a long-travel leg) so the reflex cannot toggle the key every
  frame (AC15/AC16). Each press is then gently shortened by a per-press
  random **1–5 %** of its drawn duration, so the bot is a little gentler on
  the thrusters (AH-0MUYRJQE50021T4A); the tunable bounds live in
  `BOT_HUMAN_INPUT_TUNABLES` (`thrustPressGentleMinPct`/`thrustPressGentleMaxPct`).
- **Same input path as a player:** the bot's decision flows through the shared
  `CombatCoreScene.getBotInput()` seam, which `_readPlayerInput()` consults
  before the keyboard — so the demo ship obeys exactly the same
  `_tickPlayer` movement/auto-fire path as a human.
- **Human input limits (AH-0MUXXQ1MN002RXGB):** the demo drives whatever
  control scheme the ship is configured with — the shipped default is the
  **asteroids** controls, so the bot is limited to the keys a person uses:
  **W** (forward thrust in the ship's facing direction) and **A/Left** and
  **D/Right** (turn), never a reverse/S key. The governor resolves the
  scheme-agnostic steering intent to the ship's own input shape
  (`toAsteroidsInput` aims the hull at the intent's **precise bearing** — or,
  when a caller supplies only the cardinals, at the nearest cardinal — and
  then thrusts; the four-directional path strips down). Because the held
  intent is re-resolved against the ship's **current** facing every tick, the
  turn is **closed-loop**: the ship points straight at its target ("point
  towards it and thrust forward") rather than snapping between cardinals and
  oscillating. Its committed intent changes no faster than a human reaction
  cadence (`BotInputGovernor` / `BOT_HUMAN_INPUT_TUNABLES` in
  `src/ai/botHumanLike.ts`, default **250 ms**), holding a command between
  reactions instead of flip-flopping every frame.
  `PlayScene` never forces a scheme, so the demo ship looks and handles like
  the player's ship. The governor advances by the frame `dt`, so demo
  behaviour stays deterministic.
- **Rotation skills (AH-0MV1DUSM2005HL98):** the demo bot aims with the
  ship's real rotation physics rather than a fixed error band, so its
  forward-firing shots actually land on moving enemies.
  - **Inertia-aware turn hold (AC1):** the governor holds the turn input
    until the ship's **predicted stop heading** — current facing plus the
    closed-form coast to zero spin at the ship's live
    `asteroidsRotationDeceleration` — is within `alignmentToleranceRad` of the
    target bearing, instead of releasing on the instantaneous error. When the
    coast would overshoot, the opposite turn brakes the spin. The check is
    re-resolved every tick against the live facing and reads the ship's live
    rotation config, so it stays closed-loop and never hard-codes a rotation
    constant; with no angular velocity it reduces exactly to the previous
    release.
  - **Lead prediction (AC2):** when engaging a target whose velocity is
    known, the aim objective is the **iterated intercept** — the enemy's
    position advanced by its velocity over the estimated turn time plus the
    shot's time of flight — rather than its current position. A stationary
    target (or one whose velocity is not exposed) reduces exactly to the
    previous aim.
  - **`skill` tunable (AC3):** a single normalised **0..1** knob (default
    **1.0**) perturbs the committed **aim** bearing by a seeded random error
    that scales with `(1 − skill)` and is capped at `maxAimErrorRad` (default
    **0.35 rad**). It is zero at `skill = 1`, grows as skill falls, and is
    reproducible for a run seed; survival/evade intents are never perturbed,
    so lowering skill degrades aim but never collision avoidance.

  All the new values (`skill`, `maxAimErrorRad`, `aimLeadAlignSeconds`,
  `aimLeadIterations`, plus the `aimLeadEnabled` toggle) are exposed as live
  sliders/toggles in the bot-tuning gym (see
  [docs/BOT_FRAMEWORK.md](BOT_FRAMEWORK.md#12-tuning-the-bot-live-the-bot-tuning-gym))
  and live in the shared `src/ai/` code, so the game and the gym fly
  identically (gym↔game parity).
- **Predictive hazard avoidance (AH-0MVI4QDN90037DIN):** the bot avoids where
  a **moving** hazard will be, not just where it is. Aim lead (above) covers
  leading a target; this is the avoidance half. Because the snapshot exposes
  no per-archetype velocity for formation enemies, the bot derives one
  **itself**, bot-side, from each live enemy/asteroid/boss's position delta
  across decision ticks (keyed by a stable bot-side entity id, clamped so a
  wrap/respawn cannot imply an absurd speed). When `hazardPredictionEnabled`
  is on (default) a steering bearing is also unsafe when the ship and a
  moving hazard are predicted to come within `threatRadius` inside
  `hazardPredictionHorizon` (default **0.6 s**) — the same closest-approach
  solve used for incoming fire — and the engage behaviour's kiting gate uses
  the same test for an imminent collision. A hazard with no/zero estimate, or
  prediction turned off, reproduces the previous positional keep-away
  behaviour exactly. Both knobs are live sliders/toggles in the bot-tuning
  gym and live in the shared `src/ai/` code
  ([docs/BOT_FRAMEWORK.md](BOT_FRAMEWORK.md#910-predictive-hazard-avoidance-ah-0mvi4qdn90037din)).
- **Hold-full auto-select (AH-0MUXXQ1MN002RXGB):** when the mineral hold fills,
  the modal hold-full choice overlay auto-selects its first option after
  `BOT_MINERAL_CHOICE_DELAY_MS` (**900 ms**) and resumes play, so a demo run
  never stalls on the selection screen. The auto-select drives the **same
  selection → 3-2-1 countdown → on-beat resume** path as a human choice
  (§4.5), so an attract-mode run keeps its audible cadence. Normal play never
  auto-selects.
- **Extra Life priority (AH-0MV03GXZQ00801T4):** the competent demo brain
  (`createCompetentBotBrain`) values the ship's remaining lives. While the
  ship is **below the 5-life cap** it pursues a live **Extra Life** drop above
  every objective except immediate survival (the `secure-life` band, directly
  below the hard-constraint survival tier and above minerals), and its
  hold-full auto-select takes an offered **Extra Life** instead of the first
  option. When a life would be wasted — at the cap — the drop receives no
  special priority and the auto-select falls back to the first option. The
  life count and cap are read from the run state (`GameState.lives` /
  `MAX_LIVES`), so the bot introduces no cap constant of its own; survival
  still dominates, so the bot never trades its life for a life. Normal play is
  unaffected (the preference only drives the demo bot and the demo
  auto-select).
- **Take over (AH-0MUYP6M6W006Z1AY, AH-0MUYG8XHI0044MQ1):** pressing a **movement key** (W/A/S/D
  per the configured bindings, or an arrow key) leaves demo mode in place
  (`setDemoMode(false)`) — the run continues under player control, no restart.
  Any **other** key — including **ESC** — returns to the main menu, abandoning
  the demo run without scoring; the pointer stays ignored.
- **Non-scoring:** on death or victory a demo run returns straight to the main
  menu (it never enters `GameOverScene`), so it writes no leaderboard entry and
  no session state.
- **Opt-in and PlayScene-only:** normal play is unaffected (the seam returns
  `null`), and the gyms inherit that default — so **gym↔game parity** is
  preserved: the shared input seam is exercised by both the game and the gyms,
  while the bot itself is a `PlayScene`-only consumer.

### 2.2 Movement

- **Thrust-based Newtonian movement** — space physics with thrust input and tunable linear deceleration (friction). The player ship moves on a 2D plane (not lane-based); velocity changes via thrust input and, when no direction key is held, decays toward zero.
- **Thrust acceleration:** Holding a direction key applies continuous acceleration in that direction (8 directions supported — W/A/S/D and arrows, including diagonals). The ship's velocity increases each frame while thrust is held.
- **Deceleration on release:** Releasing all direction keys applies **linear deceleration (friction)** at a tunable rate in px/s², slowing the ship to a full stop. The velocity decays evenly (direction preserved) and clamps at exactly zero — no overshoot, no residual drift. Stopping or reversing faster can be achieved by thrusting in the opposite direction.
- **Tunable deceleration rate:** The deceleration rate is configurable from **0 to 400 px/s²** (default **100 px/s²**) via the Gym scene ship-tuning sliders, and persists with the rest of the ship configuration. A value of **0 restores the original zero-friction drift** (velocity preserved when no key is held) for experimentation. As a reference point, the default 100 px/s² brings the ship from max speed (~175 px/s) to rest in roughly 1.75 s.
- **Deceleration applies only when no direction key is held** — while thrusting, the deceleration rate has no effect and thrust behaviour is unchanged.
- **Asteroids turning (angular ramp):** under the Asteroids control scheme the ship's turn rate ramps toward the configured `asteroidsRotationSpeed` (default **3 rad/s**) instead of jumping straight to it. Holding a turn key spins the angular velocity up at `asteroidsRotationAcceleration` (default **12 rad/s²**); releasing it — or holding both turn keys together, which cancels to a zero target — ramps the rate back to zero at `asteroidsRotationDeceleration` (default **60 rad/s²**), so the ship stops crisply with minimal glide (under 5° of post-release rotation at the defaults). A short tap therefore rotates only a few degrees (~3–4° for a 100 ms tap at the defaults, versus ~17° under the old instantaneous model), while a sustained hold still reaches the full, snappy top speed. Both rates are configurable from the Gym ship-tuning sliders — acceleration **2–60 rad/s²** (step 2) and deceleration **12–300 rad/s²** (step 12) — and are persisted with the rest of the ship config (`asteroidsRotationAcceleration` / `asteroidsRotationDeceleration`). The ramp is a pure, closed-form, framerate-independent integration in the shared `AsteroidsModel` (`src/utils/movementModel.ts`), so the shipped game and every gym behave identically (gym↔game parity).
- **Asteroids reverse thruster (retro-thrust):** under the Asteroids control scheme, holding **S** or **↓** applies continuous acceleration **opposite** the ship's facing direction — a held retro-thrust that brakes the ship, then backs it up, without turning the hull. The reverse acceleration (`asteroidsReverseThrustAcceleration`, default **200 px/s²**) and the reverse speed cap (`asteroidsReverseMaxSpeed`, default **120 px/s**) are **independent** of the forward `thrustAcceleration` / `maxSpeed`. The cap is applied only to the speed the reverse thruster *adds*, so it never yanks pre-existing faster forward momentum to a halt — it clamps the reverse-accelerated speed to `max(current speed, reverse max speed)`. Releasing the key restores the normal friction behaviour, exactly as releasing forward thrust does, and when no reverse key is held the ship behaves as before. The thruster is **on by default** (`asteroidsReverseEnabled`) and can be switched **off completely** from the Player gym checkbox; when off, **S** / **↓** apply no acceleration, select no engine and do not suppress friction, while forward thrust and turning are unaffected. Reverse thrust renders a dedicated **nose retro-thruster** flame — a full-size port at the hull front whose flame grows and decays with the shared animated-flame model and rotates with the hull; only engines that are firing are drawn. The physics and engine selection live once in the shared `AsteroidsModel` / `Player` (`src/utils/movementModel.ts`, `src/entities/Player.ts`), so the game and every gym behave identically (gym↔game parity); the tunables default in `src/core/configDefaults.ts` and round-trip through `src/data/ship-config.csv`.
- **Maximum speed cap:** Velocity is clamped to a maximum speed to prevent unbounded acceleration. Tunable constants (thrust acceleration, deceleration, max speed) live in a single configuration module so the feel can be adjusted without digging through scene code.
- **Responsive feel:** Tuning targets are designed so the ship reaches meaningful speed quickly and decelerates/reverses within a "short moment" of holding the opposite key — the ship should feel agile but never sluggish.
- **Screen-edge wrap-around:** The ship wraps across all four screen edges (leaves left → reappears right, etc.), matching the classic Asteroids model. No hard walls or clamping.
- **Thruster feedback:** Visual thrust flames appear **from the four engine ports on the hull** whenever a direction key is held, making movement input legible without racing the physics. In the four-directional scheme the hull is direction-neutral (§7.2), so the flame positions are the only heading cue; in the Asteroids scheme the concave rear hull additionally points along the facing. The engine whose outward normal opposes a thrust component fires (thrust right → left port; up+right → bottom and left ports), and each flame's length is scaled by its thrust component. Under the Asteroids scheme the engines are the main rear thruster, two 70% forward-side thrusters and the **nose retro-thruster** at the hull front, which fires only while reversing (§2.2). Each flame is animated: it grows from length 0 toward `shipSize × thrustFlameLength × component` at a rate proportional to `thrustAcceleration` (higher thrust springs it to full size faster; at 0 thrust it stays invisible), and decays back to 0 at 4× the growth rate when the thrust stops. A change of the pressed keys while still thrusting (e.g. turning from Forward to Left) restarts every flame as a fresh burst from length 0, so each new direction is immediately legible; releasing all keys keeps the shrink-back. Growth/shrink is delta-time based so the animation is framerate-independent and re-targets the current config live.
- **Tunable constants** (exposed in `src/core/constants.ts`):
  - `THRUST_ACCELERATION` (px/s²): acceleration applied each second when thrust is held.
  - `FRICTION_DECELERATION` (px/s²): linear deceleration applied each second when no direction key is held; 0 disables friction (original drift behaviour).
  - `MAX_SPEED` (px/s): absolute speed cap.
  - `asteroidsReverseEnabled` (boolean): master on/off for the Asteroids reverse thruster (default **on**).
  - `asteroidsReverseThrustAcceleration` (px/s²): reverse-thrust acceleration, independent of `thrustAcceleration` (default **200**).
  - `asteroidsReverseMaxSpeed` (px/s): speed cap reachable under reverse thrust, independent of `maxSpeed` (default **120**).
  - Tuning targets: ship reaches ~80% of max speed in under 1 second of continuous thrust; from full speed with default deceleration, the ship comes to rest in under 2 seconds of no input; reversing from full speed to opposite direction takes under 1.5 seconds.

### 2.3 Combat Mechanics

- **Auto-fire**: The player ship fires continuously without any input (GDD §2.3; implemented in the GymWeapons gym, `src/scenes/gym/GymWeapons.ts`). Bullets fire in the direction of travel — the current velocity heading — falling back to the **most recent** non-zero heading when the ship is stationary (default before any movement: right / 0°). Fire is **globally quantised to a silent 80 BPM beat grid** (AH-0MUAYB8EH005RJ8B): every active weapon's shots land on an exact subdivision of the beat, all simultaneously active weapons are **phase-locked** to the same grid, and a weapon collected mid-beat fires its first shot on the next grid tick. The default subdivisions are **Cannon 2/beat (375 ms)**, **Spread 1/beat (750 ms)**, **Dual 1/beat (750 ms)** and **Rapid 6/beat (125 ms)**; the BPM and the per-weapon subdivisions are configurable through the game-rules config (`src/core/rules.ts`: `beatBpm`, `weaponSubdivisions`). Weapon power-ups (Spread/Dual/Rapid) are **cumulative and timed** — each collected power-up is **added** to the active set for **10 seconds** (independent countdown per weapon) and all active weapons fire on the shared grid before the timed ones silently expire (Reset clears them instantly, leaving only the Cannon).
- **Auto-fire stops when the run is over** (AH-0MVCB6LBE007I6R8): the moment the Central AI boss is destroyed the ship is no longer fighting, so from the next tick it spawns **no new player bullets, muzzle flashes or shoot cues** for the rest of the in-run victory hold (`VICTORY_TRANSITION_HOLD_MS`, §7.2). This is the **run-end only** — mini-boss defeats, wave/level transitions and the transition pause keep full auto-fire (the player stays in control), and shots already in flight keep flying to their normal lifetime. The gate is a single shared hook (`CombatCoreScene.playerFireSuppressed`, default `false`, overridden by `PlayScene` with its per-run "run finished" flag) next to `autoFireEnabled()` / `isCaptureDisabled()`, and the shared beat clock keeps advancing while fire is suppressed so the beat-modulated thruster hum (§7.3) does not stall. Combat gyms keep firing after their own boss dies — the documented gym divergence in §7.2.
- **Bullet range and wrap-around**: Every bullet — player and enemy — **wraps across all four screen edges** using the same classic Asteroids model as the player ship and asteroids (leave left → reappear right, etc.). A bullet is **never** removed merely for leaving the screen. Instead, each bullet type has its own **lifetime in seconds** (effective range = `bulletSpeed × lifetime`, §4.4); a bullet is destroyed only once its lifetime elapses. Wrapping is **positional only** — like the ship and asteroids, bullets do not collide across the seam.
- **Collision model**: The player loses **one life** when hit by **any** object — an enemy body or an enemy-fired bullet. Hits never deal partial damage; there is **no player health bar**. The player starts with 3 lives (§3.1); collecting **Extra Life – Extra Life** grants +1 life (up to a maximum of 5). A hit costs one life and the run continues until the lives run out.
  - **Early levels (1–3)**: Enemies are the primary collision threat. Flying into an enemy costs the player one life (same effect as being hit by a bullet). The enemies themselves **are** the bullets — their formation movements are the hazard.
  - **Later levels (4–5)**: Enemies additionally fire projectiles, adding a second layer of threat. Being hit by a projectile also costs one life. The enemies remain as collision threats as well.
  - **Boss level**: Boss fires complex bullet patterns; enemies may also fire. Bullet hits cost one life, exactly as on other levels.
- **Enemy health**: Regular-enemy health is **data-driven** (`EnemyConfig.health`, default **1**). Enemies E1–E6 are 1 HP and are destroyed by a single player bullet hit; the **E7 Harvester** (§4.1) has **5 HP** and survives five hits. The Boss (§4.3) remains multi-hit via its 4-phase health bar. Bomb (see §4.4) does not deal damage to enemies — it clears on-screen enemy bullets only.
- **Power-ups**: Dropped by destroyed enemies and collected by flying over them (§4.4). Most provide **temporary** abilities; some are permanent or stored with **finite recharging pools** — **Phase Shift** (auto-activation charges, base 1 → cap 3, level-derived recharge 30 s → 10 s) and **Teleport** (stored teleports, base 1 → cap 3, level-derived recharge 15 s → 5 s, spent automatically on danger), **Extra Life** (permanent +1 life), **Magnet** and **Mineral Scoop** (each a timed 15 s field pickup; permanent stacking when chosen as a hold-full reward). **Teleport is automatic** (AH-0MUZE4AIP009HZWC): while the player holds at least one Teleport stack it is spent automatically when the ship is in danger; **S / ↓** are reserved for movement/reverse thrust.
- **Audio feedback**: All key game events produce immediate, distinct audio cues (see §7.3). This includes player fire, enemy destruction, power-up collection, player hits, and key events (boss entrance, wave spawns, phase transitions) which are announced by an advance audio cue with ≥ 500 ms lead time before the visual event.

### 2.4 The "Enemies Are the Bullets" Design

In the first levels, enemies move in coordinated formation patterns across the screen. These formations **are** the primary hazard — the player must navigate through or avoid enemy formations just as in a traditional bullet hell, where the bullets themselves are the threat. The enemies do not fire projectiles in these levels; their positional threat is sufficient.

This creates a unique gameplay tension: the player must manage both their own ship's position relative to the formations and their auto-fire trajectory against enemies.

### 2.5 Enemy-Fired Projectiles (Levels 4–10 and Boss)

- Starting in **Level 4**, enemies begin firing bullets in recognizable patterns.
- **Level 5 (Predictable Death)**: Contains a **smaller number of enemies** than earlier levels, but these enemies fire bullets in **predictable, repeating patterns**. This level tests the player's ability to learn and memorize patterns.
- **Levels 6–10** showcase the classic-arcade roster — the Space-Invaders `march`, the Galaga `capturer`, the Pac-Man `ghosts`, the Centipede chain, the Robotron `grunt` horde, the Defender `raider`, the Missile-Command `orbital-strike` and the Frogger `lane-traffic` — interleaved with the existing archetypes. Every wave that fields a player-targeting archetype (`capturer`, `ghost-*`, `grunt`, `raider`) also fields at least one non-player-targeting kind, and adjacent levels differ in their dominant movement/attack style (see §3.2 and `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §9.4).
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

- **Bullet–enemy interaction**: A player bullet is **consumed** (destroyed) when it hits an enemy. The first enemy hit by a bullet takes the hit; the bullet does not pass through. There is no multi-hit bullet and no piercing behaviour. A 1-HP enemy is destroyed by the bullet; a multi-hit enemy (E7 Harvester) loses one hit point per bullet and the **fifth** hit destroys it (see also §4.1 for enemy health).

- **Enemy force fields (deeper levels only)**: From campaign level 2 onwards, some enemy archetypes spawn behind a **force field** — a visible bubble that sits **in front of the hull** (barrier first, hull second). The field absorbs a data-driven number of player hits **before** `health` is touched; every absorbed hit still consumes the bullet and plays the normal impact feedback, but the enemy's hull is undamaged until the field breaks. Only after the field is down does the enemy's normal `health` apply (a 1-HP enemy dies on the next hit; the 5-HP Harvester still needs five). Field strength per archetype per level, the formula, and the tuning table are in §4.1; level 1 never spawns a shielded enemy. Every player damage source (normal bullet, piercing, AOE weapons, Smart Bomb, Orbital Strike, Frenzy bonus hits) depletes the field through the shared `takeDamage()` seam — there is no parallel damage path.

- **Ram/contact vs. a shielded enemy**: when the player **crashes into** a shielded enemy, the field absorbs the ram — exactly **one** field hit is consumed, the enemy survives and the player survives the collision (a short shared re-arm prevents the field draining frame-by-frame during sustained overlap). Once the field is down the original contact rule applies unchanged: contact destroys **both** the player and the enemy.

- **The Wall wave (density challenge)**: Level 3's Wall wave is a **density challenge, not a blocking mechanic**. The Wall consists of a dense horizontal line of enemies that advances slowly. Enemies in the Wall pass through each other freely. To create a gap through which the player can advance or through which bullets can reach enemies behind the Wall, the player must destroy each Wall enemy individually — one bullet per enemy. There is no special "Wall shielding" that blocks bullets from reaching enemies behind the line; bullets simply pass through gaps created by destroyed enemies.

---

### 2.7 Intended experience: measurable targets

The design intent in this chapter — survive the escalating waves, earn a
power-up every hold-full, ramp through the campaign — is also recorded as a
**versioned, machine-checkable statement**, so the experience can be validated
periodically instead of remembered (AH-0MV7WVHU0000U775).

- **Source of truth:** [`src/data/experience-targets.json`](../src/data/experience-targets.json)
  — one target band (centre ± tolerance) per key experience metric, derived
  from a recorded 100-game competent-bot campaign batch (seeds 1–100, 18 000
  ticks per game, full shipped campaign). `targetsVersion` identifies the
  standard.
- **Narrative:** this section. The two are updated in the same change whenever
  a band moves materially.

| Experience dimension | Metric | Intended band (targets v1) | What it means in play |
|---|---|---|---|
| Survival | `survivalSeconds` | 300.00 ± 30.00 s | A competent run lasts about five simulated minutes — the batch tick budget — i.e. the run is not cut short by a death spiral. |
| Reward cadence | `mineralsCollected` | 18.00 ± 1.80 | A run collects about eighteen minerals, enough for roughly two hold-full resolutions. |
| Build progression | `upgradesSelected` (per run) | 2.00 ± 0.50 | A run takes about two upgrades through the shared hold-full choice flow, so a run develops a build identity. |
| Pacing (within a level) | `waveReached` | 6.46 ± 4.96 | A run progresses to the middle of a level's wave list, not just the opening waves. |
| Pacing (campaign) | `levelReached` | 1.15 ± 0.71 | Most runs stay in level 1–2, so later-level content is reached only by better play. |
| Challenge | `avoidableHits` | 0.00 ± 0.50 | A competent run takes no hits that cost a life; a human run taking a hit is a prompt to investigate, not automatically a defect. |

The band width is `max(2 × baseline std-dev, 10 % of |centre|, 0.5)` (the exact
rule is stored in the artifact). Verify the measured experience — a bot batch
**or** a recorded human session — against these bands with
`npm run validate-experience -- <balance-report.json>`; it writes a versioned
JSON report plus a Markdown summary and exits non-zero on drift. The workflow,
the report shape, the scheduling recipe and the tolerance-tuning guidance are in
[`docs/EXPERIENCE_VALIDATION.md`](./EXPERIENCE_VALIDATION.md).

> **Fidelity caveat.** The bands come from the headless bot baseline, not from
> human play (see the fidelity boundary in [`docs/BALANCING.md`](./BALANCING.md)).
> They are deliberately tolerant and are a **directional** statement of intent:
> an out-of-band human result starts an investigation (regression, deliberate
> change, or stale baseline) rather than proving a bug. The recorded baseline's
> degenerate metrics — survival at the tick budget, zero avoidable hits — and
> the re-baseline workflow are documented in the validation guide.

---

## 3. MVP Vertical-Slice Content

### 3.1 Scope Summary

| Element | Value | Notes |
|---------|-------|-------|
| **Levels** | 10 | Levels 1–3: enemies-as-bullets formations; Levels 4–5: enemies fire bullets (Level 5 predictable patterns); Levels 6–10: the classic-arcade roster in curated, mixed encounters. Every level spans **10 waves** (100 waves total) |
| **Mini-bosses** | 10 | One bespoke mini-boss is wave 10 of every level (see §3.3); the final boss still follows Level 10 |
| **Boss encounters** | 1 | Final boss after Level 10 (after its mini-boss) |
| **Lives** | 3 (up to 5 with Extra Life) | Per-run; **Continue** resumes from the last mini-boss checkpoint |
| **Power-up types** | 16 | Distinct types (see §4.4) |
| **Weapon types** | 16 | 11 conventional/AOE weapons + **5 unlock-pool weapons** (see §4.4) |
| **Checkpoint save** | 1 slot | Auto-saved at every mini-boss to `ai_hell_checkpoint`; Continue on the main menu (see §6.6) |
| **Leaderboard** | Local storage | localStorage-based, single-machine |
| **Difficulty scaling** | **Data-driven level curves** | As levels progress, wave groups hold more enemies (1.00× → 2.00×) and the per-kill power-up drop chance falls (0.18 → 0.05), resolved from one pure module (`src/core/levelScaling.ts`, tuning data in `GameRules`) — see §3.2 and §4.4 |
| **Multiplayer** | **Out of scope** | Single-player only in MVP |

### 3.2 Level Progression Overview

| Level | Theme | Enemy Count | Enemy-Fired Bullets | Description |
|-------|-------|-------------|---------------------|-------------|
| 1 | Entry | Moderate | No | Introduction to formation waves — the opening is a varied, non-firing mix of light archetypes (Scouts, Divers, Swarms) rebuilt per run from a seeded curve — plus randomly spawning, self-splitting Asteroids that drift in from a random offscreen edge every wave — simple movement patterns, no enemy bullets |
| 2 | Descent | Moderate–Large | No | Tighter formations; more complex movement |
| 3 | The Core | Large | No | Dense formations; maximum positional threat |
| 4 | Firestorm | Moderate | Yes | Enemies begin firing; introduction to bullet patterns |
| 5 | Predictable Death | Smaller | Yes (predictable) | Fewer enemies with highly structured, memorizable bullet patterns — the memorisation test before the classic-arcade finale |
| 6 | Invasion | Large | Yes | The classic-arcade debut: stepping Space-Invaders `march` formations plus the Galaga `capturer` tractor pull |
| 7 | Segmented Assault | Large | Yes | The winding Centipede `centipede` chain plus Pac-Man `ghosts` pursuing the live player |
| 8 | Gridlock | Large | Yes | Frogger `laneTraffic` lanes, the Robotron `horde` rush and the Defender `raider` patrol-and-dive |
| 9 | Orbital Siege | Large | Yes | Missile-Command telegraphed `orbital-strike` arcs among orbital Phasers with pursuing `ghosts` |
| 10 | The Gauntlet | Large | Yes (full mix) | Dense mixed finale pairing every player-targeter with non-targeting archetypes before the boss |
| Boss | AI Throne | N/A | Yes (complex) | Final boss encounter with multi-phase attack patterns |

> **Note**: "Moderate," "Large," and "Smaller" are relative. The exact enemy counts per level are design decisions that can be tuned during implementation, but the progression from no-bullets to bullets to fewer-but-patterned enemies must be preserved.

> **Level density scaling (AH-0MVHT1M6O003PU7P).** Every campaign wave's group
> counts are multiplied by a level factor that ramps linearly from **1.00× at
> level 1** to **2.00× at level 10** — rounded half up, floored at 1, capped at
> 200, and never applied to `single`-formation groups (one entity). The same
> shared seam (`applyEnemyCountScaling` in `src/core/levelScaling.ts`) scales
> the static `LEVELS` campaign and the sequenced campaign, and the level-based
> gyms (`GymLevel` / `GymBotTuning`) spawn the same counts, so tuning transfers
> to the game. Level 1 is the identity transform, so onboarding is untouched;
> the tuning values live in `GameRules` (`enemyCountMultiplierAtMaxLevel`,
> `levelScalingMaxLevel`, `enemyCountCap`), not in the seam. The full scaling
> table and the before/after bot-batch evidence are in
> [`docs/BALANCING.md`](./BALANCING.md).

> **Default sequenced campaigns (AH-0MUH6LEYY0054E63; per-wave modes
> AH-0MUJSUQD8003FSUT; default-on AH-0MUJSUTLA006Q8E1; 10-wave expansion
> AH-0MVCC8XSS007P01Z / AH-0MVCYANT6003SG5C).** The table above
> describes the hand-authored static campaign, which is now the opt-out. With
> the `sequencedWavesEnabled` game rule on (default **on**), each wave is either
> generated from `src/data/difficulty-curves.csv` (`curve`), kept verbatim from
> `LEVELS` (`fixed`) or rebuilt at run start from a seeded curve (`dynamic`),
> selected by the config's per-wave `generation` column (see §2.5.1). Every
> level 1–10 now spans exactly **10 waves (100 waves total)**, and wave 10 of
> every level is that level's hand-authored **mini-boss** encounter (flagged
> `miniBoss: true` on the wave and consumed by `WaveManager`'s per-level
> mini-boss gating); the final boss still triggers after Level 10's wave 10 is
> cleared. The shipped default campaign mixes all three modes: the first four
> campaign waves (L1W1, L1W2, L2W1, L2W2) are `dynamic` and open on a curated,
> varied, non-firing mix; the remaining levels 1–3 waves are `fixed`; levels 4–
> 10 keep their pre-existing `curve` rows (plus the level-5 `dynamic` wave) and
> add hand-authored `fixed` filler + wave-10 mini-boss waves (each new
> archetype still debuts on a fixed showcase wave so its showcase is guaranteed
> for a run seed). A **per-level
> archetype variety cap** (`MAX_ARCHETYPE_PER_LEVEL`, default **1** in
> `src/core/difficultySequencer.ts`) keeps any single archetype — in particular
> the orbital Phaser — to at most one **generated** wave per level, so the
> generated campaign
> escalates through varied movement styles instead of repeating one formation
> once the target passes ~30 (AH-0MV2SGIX5005PFJT); authored `fixed` waves and
> the gyms are not constrained. The static skeleton
> (levels 1–10) is always present; the static campaign is the fallback, and the
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
> numeric form (`Level N of 10, Wave M of K`) when a level has no name. The
> boss encounter keeps its literal `Boss` label. Both surfaces read the single
> `PlayScene._progressLabel()` helper so they cannot diverge.

> **Transient announcement banner (AH-0MV8BQ75V005QNZ1).** The centred
> transition/level-start banner is **transient** — it expires on its own after
> **3.5 s** (`BANNER_DURATION_SECONDS`) even while enemies remain alive, so
> it never blocks progress. Its background panel is **60 % opaque**
> (`rgba(0, 0, 0, 0.6)`, `BANNER_BACKGROUND_ALPHA`), letting the player see
> the field behind the announcement while keeping the white label legible.

---

### 3.3 Mini-Boss Designs (wave 10 of every level)

Every level's **10th wave is a bespoke mini-boss** (epic AH-0MVCC8XSS007P01Z;
data source `src/waves/miniBossDesigns.ts`). Each is a **net-new named alien
archetype** built on the reusable, config-driven `MiniBoss` entity family
(phases/pattern sets, HP, colour, optional phase minions), so the game and the
gyms run identical code. The hit pool escalates with the level (12→32 per
phase; 2–4 phases) and stays below the final boss's 200-hit pool. The final
boss still triggers once Level 10's mini-boss is defeated.

| Level | Mini-boss archetype | Phases (pattern set) | HP/phase | Minion wave |
|-------|---------------------|----------------------|----------|-------------|
| 1 | **Pulse Warden** | spread → pulse | 12 | — |
| 2 | **Coil Sentinel** | spiral → combined | 14 | — |
| 3 | **Shard Matron** | pulse → spiral → pulse | 16 | Scouts (phase 1) |
| 4 | **Void Herald** | combined → spread → pulse | 18 | — |
| 5 | **Ion Tyrant** | spiral → spiral → pulse | 20 | Divers (phase 2) |
| 6 | **Cinder Maw** | pulse → combined → spread | 22 | — |
| 7 | **Prism Wraith** | spread → pulse → combined | 24 | Scouts (phase 2) |
| 8 | **Gravemind** | spiral → combined → spiral → pulse | 26 | — |
| 9 | **Star Eater** | combined → pulse → spiral → spread | 28 | Divers (phase 3) |
| 10 | **The Hollow King** | spread → spiral → pulse → combined | 32 | Scouts (phase 4) |

Patterns map onto the shared Boss implementations (`spread`, `spiral`, `pulse`,
`combined`), so mini-bosses reuse the shipped firing code; the mini-boss wave
has **no time limit** — the level only completes when the mini-boss (and its
escorts) are destroyed. Defeating it opens the **one choice** reward (§4.4.3)
and writes a **checkpoint** (§6.6). The gym scene `GymMiniBoss` cycles all ten
designs through the same shared core.

> **Net-new archetypes.** These ten named designs are the campaign's mini-boss
> roster beyond the 17 regular enemy archetypes (§4.1). They are encounters,
> not wave-filler enemies, and are exercised in `GymMiniBoss`.

> **Power scaling (AH-0MVH87A3L004VOLD).** Both the mini-boss and the final
> boss strengthen with the ship's firepower. The run's **power score** is the
> total of every permanent upgrade level (permanent weapon levels + permanent
> power-up levels; 0 on a fresh run). The per-phase hit pool is
> `round(baseHp × min(1 + 0.06 × score, 2))` — each permanent upgrade adds 6 %
> and the pool never exceeds **twice** the base (`src/core/difficultyScaling.ts`).
> Scaling is applied once, when the encounter spawns, so it is deterministic
> and an unupgraded player always sees the base values.

#### 3.3.1 Mini-boss defeat sweep (AH-0MVOFGB6K003YD0Z)

A mini-boss kill is a **celebration**, not just a body disappearing: the lethal
hit triggers a staggered **explosion sweep** that runs to completion before the
reward overlay (§4.4.4) appears.

- **Swept scope.** Every remaining **wave-gating** enemy explodes — the
  encounter's surviving escort ships **plus the mini-boss's live summoned
  minions** (captured before the entity's own teardown clears them). Non-blocking
  hazards (`asteroid`, `lane-traffic`, the shared `isNonBlockingHazard`
  classifier) are **not** swept: they stay on the field and never gate the
  wave.
- **Cascade.** The swept enemies burst in a short staggered sweep starting on
  the defeat frame (enemy-scale bursts through the shared
  `spawnExplosionParticles` VFX, ~360 ms per burst), so the display reads as a
  chain reaction rather than N simultaneous flashes.
- **Celebration scatter.** The sweep adds `max(0, 30 − n)` extra bursts at
  positions sampled uniformly inside the playfield (inset so no burst is
  clipped off-screen), where `n` is the number of swept wave-gating enemies —
  `n = 0` → 30 extras, `n = 30` → 0, `n > 30` → 0 (never negative) — **plus
  exactly 10** bursts clustered around the mini-boss's death position captured
  at destruction. A sweep is therefore bounded at
  `n + max(0, 30 − n) + 10 ≤ 40` bursts.
- **Cosmetic only.** Swept enemies are removed from play visually and award
  **no score, no mineral/power-up/Extra-Life drops and no kill telemetry** —
  they never route through the reward-bearing kill path. The mini-boss reward
  (§4.4.4) remains the encounter's single reward.
- **Ordering.** The reward overlay opens only after the **last** burst has
  finished animating (its `setPaused(true)` would otherwise freeze the burst
  tweens mid-flight), and the wave/level accounting advances **exactly once,
  after** the sweep — never mid-display, never twice. Demo/attract mode keeps
  its reward auto-select (§4.4.4) after that delay, so the demo never stalls.
- **Determinism.** All placement and jitter draw from the run-seeded RNG (no
  `Math.random()`), so a given seed replays the same display.
- **Parity.** The sweep lives once in `src/scenes/core/miniBossDeathSweep.ts`
  (pure planner + thin Phaser executor, with a Clock watchdog so completion is
  real animation time) and is consumed by both `PlayScene` and the
  `GymMiniBoss` gym — the gym's EXPLODE button shows the same cascade.

---

## 4. Content Catalogs

### 4.1 Enemy Types

#### E1 — Scout (Basic Formation)
- **Behavior**: Flies in a standard V-formation or line across the screen.
- **Appearance**: Small, angular neon shape (e.g., triangle or chevron).
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Low (early levels only).
- **Fires**: No (Levels 1–3); yes, aimed shot (Level 4+).
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): the aimed shot renders as a **small alien pellet** — a scalloped neon body with a bright **enemy-tinted (green) core**, a **faint pulsing rim** (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`) and a short fading trail — with a green launch pop at the scout's body when the shot leaves and a green-tinted impact flash when the shot connects or is intercepted (shared fire/impact seams, AH-0MV822CQL005R4MM). Visuals/feel only — firing logic, speed, interval and lifetime are unchanged.

#### E2 — Diver
- **Behavior**: Dives diagonally toward the player's position snapshotted at dive start (a quadratic-bezier parabolic arc in which both x and y follow the curve — no x-lock; AH-0MTGBOKLC006N8UX), pauses for 500 ms at the attack end, then re-forms. There is **no return target**: when the pause ends the **Diver group** re-anchors around the attack-end location (the player position snapshotted at dive start), preserving the Diver group's relative offsets. **Only the Divers move** — non-Diver enemies (Scouts, Tanks, Phasers, Swarms) stay exactly where they are and are unaffected by the re-anchor. The **Divers then glide** to their re-anchored slots over a short bounded duration (~0.32 s, `FORMATION_GLIDE_SECONDS`) — each Diver eases from its current position to the live (drifting) slot rather than teleporting, landing exactly on the slot when the glide completes. The formation drift keeps advancing throughout the attack and the glide (AH-0MUAYB957002EMYV, AH-0MUL15N63003PUDB).
- **Appearance**: Medium, dart-shaped neon entity.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium.
- **Fires**: No (Levels 1–3); yes, short-burst spread (Level 4+).
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): each spread-burst shot renders as a **sharp shard/splinter** — a razor arrowhead with a **white-hot spine**, a neon rim in the Diver's own body yellow, a short fading trail and a **sweeping time-driven spine glint** (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `shard` primitive) — echoing the Diver's dart body and diving arc — with one pale-yellow launch pop at the diver's body per burst and a pale-yellow-tinted impact flash when a shard connects or is intercepted (shared fire/impact seams, AH-0MV822D2U000LRFV). Visuals/feel only — firing logic, speed, interval, burst count and spread pattern are unchanged.

#### E3 — Tank
- **Behavior**: Slow, deliberate formation movement; holds position longer than other types.
- **Appearance**: Larger, hexagonal or blocky neon shape.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium–High (acts as an immovable obstacle in formations).
- **Fires**: No (Levels 1–3); yes, radial burst (Level 4+).
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): each radial shell renders as a **heavy shell** — a larger two-tone amber body with a **white-hot core** and a **slow breathing glow** ring (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `heavy-shell` primitive) plus a short ember trail — with one amber launch pop at the tank's body per burst and an amber-tinted impact flash when a shell connects or is intercepted (shared fire/impact seams, AH-0MV822DF60001EPA). Visuals/feel only — firing logic, speed, interval, burst count and pattern are unchanged.

#### E4 — Phaser (Level 5+)
- **Behavior**: Moves slowly in a fixed orbital path; fires in predictable, repeating cycles.
- **Orbital formation & entry (AH-0MVEXVME1004SIIS)**: a Phaser group shares **one ring** around the formation centre (`PHASER_ORBITAL_RADIUS`, 80 px) and spreads its members **evenly by the group's actual count** — `phase_i = i × 2π / N` for `i = 0…N−1`. Four Phasers keep the familiar 0°/90°/180°/270° square, while a scaled group (e.g. the difficulty sequencer's `phaser × 12`) occupies twelve distinct slots with none coincident. A spawning Phaser transits from the wave wormhole **straight to its live orbital slot** (no line-then-snap), and the same shared orbital geometry drives both the transit destination and the per-frame orbit (gym↔game parity).
- **Appearance**: Circular neon ring with a central core.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: Medium (but high pattern-based challenge).
- **Fires**: Yes — predictable radial or aimed patterns with clear tell animations and an advance audio cue (≥ 500 ms lead time) before each firing cycle begins.
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): each radial shot renders as a **crisply-edged phaser bolt** — a hexagonal prism (pointed tips, parallel long edges) with a **bright white velocity-aligned core streak**, a neon rim in the Phaser's own magenta, a short fading trail and a magenta launch pop at the phaser's body per radial volley (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `phaser-bolt` primitive) — the crisp, straight-edged energy bolt of a telegraphed phaser volley, distinct from the jagged player `bolt` and every other enemy identity, with a red-tinted impact flash when a bolt connects or is intercepted (shared fire/impact seams, AH-0MV822DRX009RYUB). Visuals/feel only — firing logic, speed, interval, spoke count and radial pattern are unchanged.

#### E5 — Swarm
- **Behavior**: Moves in tight, fast-moving clusters; changes direction suddenly.
- **Appearance**: Small, diamond-shaped neon entities in groups.
- **Health**: 1 HP — destroyed by a single player bullet.
- **Threat level**: High (positional threat in dense formations).
- **Fires**: No (Levels 1–3); yes, coordinated burst (Level 4).
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): each coordinated-burst shot renders as a **tiny fast cometary fleck** — a small elongated tear with a **white-hot leading glint**, a pointed tail, a cyan neon rim, a short fading trail and a cyan launch pop at the member's body (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `fleck` primitive) — a tiny-fast-fleck micro-shard that reads as massed fire, distinct from the Raider's wide diamond and every other identity, with a cyan-tinted impact flash when a fleck connects or is intercepted (shared fire/impact seams, AH-0MV822E4T006F37Y). Visuals/feel only — firing logic, speed, interval and spread are unchanged.

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
- **Kill reward (AH-0MV6M2M9P0078N4S)**: in addition to the generic per-kill
  power-up roll (§4.4), a fully destroyed **small** asteroid rolls an
  additional, configurable **Extra Life** chance
  (`GameRules.asteroidExtraLifeDropChance`, default **5 %**); a winning roll
  leaves exactly one `extra_life` pickup at the death site (standard drop
  placement/separation nudging). Large/medium asteroids (which split) and
  non-asteroid enemies never roll it. The roll is implemented **once** in the
  shared helper `src/scenes/core/asteroidKillDrops.ts`
  (`rollAsteroidExtraLife`) and consumed by `PlayScene`, every
  asteroid-bearing formation gym (`GymMinerals`, the `GymFodderEnemies`
  asteroid row) and `GymLevel`, so the game and the gyms cannot drift apart.

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

#### Classic-arcade roster (research epic AH-0MUYAQ6YH0010G52)

Alongside the E1–E7 roster, eight archetypes selected from the classic arcade
era (late 1970s–mid 1980s) have been implemented from the research catalogue in
[`CLASSIC_ENEMY_RESEARCH.md`](./CLASSIC_ENEMY_RESEARCH.md):

| Archetype | Source game | Config key | Behaviour summary |
|-----------|-------------|------------|-------------------|
| Space Invaders | Space Invaders (1978) | `march` | Rigid block that steps sideways, reverses and drops at the arena edge, speeding up as it thins |
| Galaga capturer | Galaga (1981) | `capturer` | Descends to the player's row and projects a bounded tractor beam |
| Pac-Man ghosts | Pac-Man (1980) | `ghost-chase`, `ghost-ambush`, `ghost-flank`, `ghost-wander` | Four pursuers with distinct chase / ambush / flank / wander personalities |
| Centipede | Centipede (1981) | `centipede` | Linked chain that descends and splits into sub-chains when a middle segment dies |
| Robotron horde | Robotron 2084 (1982) | `grunt` | Fast, non-firing homing horde that swarm-steers to the player |
| Defender raider | Defender (1981) | `raider` | Patrol-then-attack raider that commits to a high-speed run |
| Missile Command strike | Missile Command (1980) | `orbital-strike` | Telegraphed impact marker, falling projectile and radial detonation (non-blocking hazard) |
| Frogger lane traffic | Frogger (1981) | `lane-traffic` | Fast, non-firing horizontal lanes that wrap at the arena edges (non-blocking hazard) |

The dynamic archetypes are gated behind per-wave opt-ins (`ghosts`,
`centipede`, `horde`, `laneTraffic`) so the shipped campaign wave data is
unchanged; the `orbital-strike` hazard is enabled for regular waves.

**Defender raider projectile identity** (per-enemy visuals epic,
AH-0MV2K5SR0005RTTE): during a committed attack run the raider fires a
**slim sharp-nosed dart** — a long spearhead body with a **white-hot nose
tip**, a hot-pink neon rim, a short fading trail and a pale-amber launch pop
at its body (drawn through the shared bullet-shape seam,
`src/utils/bulletVisuals.ts`, `dart` primitive; the raider reuses the Scout's
shared aimed-shot path but resolves its own identity via the overridable
`bulletVisualArchetype` seam) — a needle-like fast-attacker read, distinct
from the Scout pellet and the Raider's own wide diamond body, with a
pale-amber-tinted impact flash when a dart connects or is intercepted
(shared fire/impact seams, AH-0MV822EH800780GI). Visuals/feel only — the
patrol/attack state machine, fire gate, speed, interval and tell are
unchanged.

**Galaga capturer projectile identity** (per-enemy visuals epic,
AH-0MV2K5SR0005RTTE): the capturer **never fires a bullet** — its threat is
the projecting tractor beam, which renders as a **magenta tugging
beam/field** drawn by the shared `Capturer` entity: a tapering funnel
(narrow at the capturer, flaring far), a bright core rail, converging side
field-lines, flowing time-driven energy motes and a bright capture lure at
the beam's far end (AH-0MV822G6F002JRRY). Visuals/feel only — beam
lifecycle, width, length, pull strength and capture timing are unchanged.

**Missile Command orbital-strike projectile identity** (per-enemy visuals
epic, AH-0MV2K5SR0005RTTE): the falling shell renders as a **falling
warhead** — a cap-shaped shell body with a **white-hot nose** and a
**flickering fiery tail**, a hot-amber neon rim, a short fading trail and
an amber launch pop where the shell enters from above (drawn through the
shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `warhead`
primitive) — with a red-tinted impact/detonation flash at the impact point
(shared fire/impact seams, AH-0MV822GIO005B685). The radial-detonation
shrapnel keeps its plain disc look. Visuals/feel only — telegraph duration,
fall speed, impact timing and burst pattern are unchanged.

**Behavioural classification (AH-0MV29NWI1007NKN7).** Every CSV archetype
carries two coarse, descriptive fields for wave-design and balance tooling:
`movementClass` (`formation | diver | chaser | patroller | roamer`) and
`attackClass` (`contact | projectile | beam | area`). Because every enemy
damages the player on contact, `attackClass` describes only the ranged/special
attack — `contact` is contact-only, so there is deliberately no `none` value.
The classification is consumed by the wave balance rules R1–R3, which the
runtime wave generator enforces for generated waves and the campaign audit
validates. See the enemy guide §1.4 for the archetype mapping and codec
defaults, and §1.5 for the rules, tunable constants and enforcement design.

#### Enemy force fields (AH-0MVJ8W4GE007OMNT, §2.6)

From campaign level 2 onwards some archetypes spawn behind a **force field**
that absorbs player hits before the hull is exposed (GDD §2.6). The layer is
data-driven per archetype and grows with campaign depth:

```
fieldHits(level) = clamp(round(lerp(forceFieldStartHits @ forceFieldStartLevel
                                     → forceFieldMaxHits @ 10)), 0, 5)
```

- `forceFieldStartLevel` — campaign level at which the archetype first gains a
  field; `0` = **never shielded** (every level resolves to 0 hits).
- `forceFieldStartHits` — field hits when the field first appears.
- `forceFieldMaxHits` — field hits at the campaign maximum level (10).
- The result is always clamped to **`[0, 5]`**; below the start level the field
  is 0, and **level 1 is never shielded for any archetype** (onboarding,
  balance baseline and existing tests are unchanged).

The resolver is the pure, Phaser-free `enemyForceFieldHits(level, config)` in
`src/core/enemyForceField.ts`; the game (`PlayScene` spawn path, run level from
`WaveManager`), the level gym (`GymLevel`) and the headless balance harness all
consume the same values, so a shielded enemy behaves identically everywhere.
Resolution is deterministic (same level + same config ⇒ identical shields),
preserving the campaign determinism contract.

Shipped tuning (CSV `src/data/enemy-configs.csv`):

| Archetype | Config key | Start level | Start hits | Max hits (L10) | Field at L2 | L3 | L5 | L10 |
|-----------|------------|:-----------:|:----------:|:--------------:|:-----------:|:--:|:--:|:---:|
| Scout | `scout` | 3 | 1 | 2 | – | 1 | 1 | 2 |
| Diver | `diver` | 2 | 1 | 2 | 1 | 1 | 1 | 2 |
| Tank | `tank` | 2 | 2 | 4 | 2 | 2 | 3 | 4 |
| Phaser | `phaser` | 3 | 1 | 3 | – | 1 | 2 | 3 |
| Swarm | `swarm` | 4 | 1 | 2 | – | – | 1 | 2 |
| Boss | `boss` | 2 | 3 | 5 | 3 | 3 | 4 | 5 |
| Harvester | `harvester` | 3 | 3 | 5 | – | 3 | 4 | 5 |
| March (Space Invaders) | `march` | 4 | 1 | 2 | – | – | 1 | 2 |
| Capturer (Galaga) | `capturer` | 3 | 2 | 3 | – | 2 | 2 | 3 |
| Grunt (Robotron) | `grunt` | 5 | 1 | 2 | – | – | 1 | 2 |
| Raider (Defender) | `raider` | 3 | 1 | 3 | – | 1 | 2 | 3 |
| Orbital strike (Missile Command) | `orbital-strike` | 4 | 2 | 4 | – | – | 2 | 4 |
| Asteroid (E6) | `asteroid` | 0 (never) | 1 | 1 | – | – | – | – |
| Ghosts, lane traffic (non-firing hazards) | `ghost-*`, `lane-traffic` | 0 (never) | 1 | 1 | – | – | – | – |

Heavier archetypes (Tank, Boss, Harvester, Orbital strike) carry the higher
values; light fodder starts later and caps lower. Every value is tunable in the
CSV (or the gym enemy editor) with no scene-code change; the neutral defaults
are `0` / `1` / `1`, i.e. unshielded.

**Feedback.** Shielded enemies render a shared bubble drawn by the
`CombatEffectVisuals` helper family — visually distinct from the player's
Shield and Force Field bubbles. Each absorbed hit triggers the existing shared
impact feedback; the breaking hit runs a distinct break flash and audio cue.

**Ram rule.** A player contact/ram is absorbed by an intact field: exactly one
field hit is consumed, the enemy and the player both survive, and a shared
re-arm prevents a sustained overlap from draining the field frame-by-frame.
Once the field is down, contact destroys both (AH-0MTV7JOLU006W8PT).

### 4.2 Wave / Formation Structures

Each level consists of exactly **ten waves** (100 waves across the ten-level
campaign); wave 10 of every level is that level's **mini-boss** encounter (a
dense hand-authored wave flagged `miniBoss: true` in `src/waves/Formations.ts`).
A wave is a set of
enemy ships that spawn together and execute their pattern; the wave is
**cleared when its enemy ships are destroyed**. Asteroids do **not** gate that
clear: surviving asteroids persist in the field across wave and level
transitions (still drifting, wrapping, rotating and shootable), as do minerals
already on the field. Only the boss encounter removes carried-over asteroids,
on entry (AH-0MUJM746P000QAEO).

> **Wave-timeout carry-over is physically continuous**
> (AH-0MUNS3ZQ1002DJ9S, AH-0MV9FUG4J008OHKA): when the wave timer expires,
> surviving formation enemies are carried over into the next wave **in
> place** — they keep drifting/marching exactly where they were, and the next
> wave's fresh enemies join that continuing formation base rather than
> resetting it. A wave that is wiped clean (no survivors) still starts its
> fresh formation at the configured start positions.

| Wave Type | Description | Levels |
|-----------|-------------|--------|
| **Line** | Enemies fly across in a horizontal or diagonal line | 1, 2 |
| **V-Formation** | Classic V-shape advancing across the screen | 1, 2, 3 |
| **Circle** | Enemies form a rotating circle, occasionally breaking out | 2, 3 |
| **Wall** | Dense horizontal line of enemies that advances slowly; a density challenge — each enemy consumes one bullet (see §2.6) | 3 |
| **Dive Bomb** | Enemies alternate between formation flight and diving toward the player | 3, 4 |
| **Orbital** | Enemies in fixed orbital paths around a central point (Level 5+); each member takes a distinct, evenly spaced phase (`phase_i = i × 2π / N`) and enters from the wormhole straight onto its live orbital slot | 5, 7, 8, 9, 10 |
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
- **Power scaling**: the per-phase hit pool scales with the player's total permanent upgrade levels using the same bounded formula as the mini-bosses (§3.3: `round(base × min(1 + 0.06 × score, 2))`; `src/core/difficultyScaling.ts`), so a heavily upgraded ship faces a tougher final boss (AH-0MVH87A3L004VOLD).
- **Health**: A single health bar fixed to the **top-centre of the screen** (`BOSS_HEALTH_BAR_Y = 60`; camera-fixed via `setScrollFactor(0)` so it never moves with the boss), divided into **4 phases**, each requiring **50 player hits** (**200 hits total**, `BOSS_HIT_POINTS_PER_PHASE = 50`). The bar is always visible during the encounter and its fill is proportional to remaining total HP (`getHpFraction()`), so every hit visibly reduces it; the four phase-segment dividers are retained. A hit that does not deplete the current phase leaves the phase unchanged; score and the next phase's minions are granted only on the **depleting** hit (hits 50, 100, 150 and 200). Every hit also plays a dedicated boss-hit cue (`playBossHitSound` → `aihell-boss-hit`) and spawns a hot-yellow impact flash (`spawnBulletImpact`, `BOSS_IMPACT_COLOR = 0xffee44`) at the hit point, from the shared feedback path used by both the game and the boss gym; a depleting hit additionally plays the existing phase-transition cue.
- **Movement**: The boss traces a **figure-of-eight (Gerono lemniscate)** around its spawn anchor: `x = anchorX + BOSS_MOVE_AMPLITUDE_X · sin(θ)`, `y = anchorY + BOSS_MOVE_AMPLITUDE_Y · sin(2θ)`, where `θ = 2π · elapsedMs / BOSS_MOVE_PERIOD_MS`. Horizontal amplitude is **≈120 px**, vertical amplitude **≈60 px**, and one full cycle takes **≈8 s** (`BOSS_MOVE_AMPLITUDE_X = 120`, `BOSS_MOVE_AMPLITUDE_Y = 60`, `BOSS_MOVE_PERIOD_MS = 8000`). The traced position is clamped to the playfield (`BOSS_RADIUS` inset) so the boss never leaves the screen; hit detection uses the boss's live position while the health bar stays put.
- **Phases**:
  1. **Scan**: Fires slow, predictable aimed shots; **12 scouts** (two groups of 6) spawn on the sides.
  2. **Firestorm**: Rapid radial bursts in all directions; **12 divers** (two groups of 6) dive from the top.
  3. **Pulse**: Screen-wide pulse wave that expands from the boss, followed by aimed shots at the player's last known position; **no minions** — the pulse is the threat.
  4. **Desperation**: All previous patterns combined at higher speed; **15 swarm** reinforce the boss; boss loses armour (visual cue: core becomes more exposed/bright).
- **Pattern design philosophy**: Each phase has clear telegraphing (glow, charge, audio cue) before the attack begins. Patterns should be learnable but require precise movement.
- **Destruction ends the fight** (AH-0MVCB6LBE007I6R8): the final phase's lethal hit awards the phase score, hides the health bar, fires the victory celebration and ends the run — and from the next tick the ship **stops firing**, so the 5 s in-run victory hold (§7.2) plays without stray player bullets, muzzle flashes or shoot SFX underneath the fireworks. The boss's own live minions and hazards are untouched; only *new* player shots are suppressed.
- **Projectile identity** (per-enemy visuals epic, AH-0MV2K5SR0005RTTE): the **Scan (Phase 1) spread volley** fires **dense boss pellets** — heavy hexagonal pellets with a white-hot core and a **menacing concentric ring accent** (a blood-red targeting halo), a short fading trail and a blood-red launch pop at the boss's body once per volley (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `boss-pellet` primitive) — with a white-tinted impact flash when a pellet connects or is intercepted (shared fire/impact seams, AH-0MV822ETD008LLZX). The **Firestorm (Phase 2) spiral volley** fires **phase-coloured spiral pellets** — compact pellets carrying the Boss's **current phase colour** (green → yellow → orange → red) in their cores with a **spiral-wake arc** trailing behind and a short fading trail, with a phase-tinted launch pop at the boss's body once per volley (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `spiral-pellet` primitive) — so the spinning volley visually tracks the Boss's phase (shared fire/impact seams, AH-0MV822F5J006WFR0). The **Pulse (Phase 3) aimed shots** render as **slow wide pulse rings** — pale rings with a faint filling and a dim inner halo that read as the compact echo of the expanding screen-wide wave (which keeps its own dedicated pulse-wave rendering), a short fading trail and a pale launch pop at the boss's body once per volley (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `pulse-ring` primitive; shared fire/impact seams, AH-0MV822FHN005PK37). The **Desperation (Phase 4) combined volley** fires **bright velocity-aligned tracers** — long hot-gold streaks with **white-hot heads** and short tail flares at higher speed (the exposed, brighter core read), a short fading trail and a hot-gold launch pop at the boss's body once per volley (drawn through the shared bullet-shape seam, `src/utils/bulletVisuals.ts`, `tracer` primitive; shared fire/impact seams, AH-0MV822FTS00156F5). Visuals/feel only — firing logic, counts, layers, speeds and the telegraph cadence are unchanged.

### 4.4 Power-Ups

The player collects power-ups dropped by destroyed enemies through the shared weighted-random drop pool (§6.4). There are **10+ distinct types** — including the three **area-of-effect weapons** (Nova, Mortar, Arc) documented in the table below; the shipped defaults encode rarity as **relative weights** — standard power-ups (Shield–Teleport, Magnet, Mineral Scoop, Force Field) at **4**, **Extra Life** and the **Mystery UFO** at **3**, the **Smart Bomb** at **2**, and each weapon drop at **2** (the `~15–20 %` / `~5 %` per-enemy figures below are conceptual guidance, not a directly coded per-enemy chance). Extra Life therefore takes ≈ **7.5 % of power-up draws** (weight 3 of the 40 total power-up weight) — still rarer than standard drops, but roughly 1.9× its former share (its weight was 1 of 27):

> **Per-kill drop chance scales with the campaign level (AH-0MVHT1M6O003PU7P).**
> A destroyed enemy's chance to drop from the shared weighted pool is no longer
> a flat level-1 rate: `PlayScene` resolves it per level through the shared
> `powerUpDropChance(level)` curve (`src/core/levelScaling.ts`), which falls
> **linearly from 0.18 at level 1 to 0.05 at level 10** (level 1 is exactly the
> old flat rate). The small-asteroid **Extra Life** roll scales by the same
> ratio (`extraLifeDropChance`, 0.05 → 0.0139). The pool's relative weights,
> the collection rules and every timed/permanent effect are unchanged — only
> the per-kill roll is level-resolved. The level-based gyms (`GymLevel`,
> `GymBotTuning`) adopt the same curve by lengthening their supply cadence by
> the inverse ratio; formation gyms have no campaign-level input and keep their
> flat cadence (documented divergence in `GymLevel` and
> [`docs/BALANCING.md`](./BALANCING.md), which also carries the scaling table
> and the before/after bot-batch evidence).

> **Planned classic-arcade arsenal (AH-0MV14SO0G0095IJ4):** A researched expansion of this catalogue is recorded in `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md` — eight selected concepts (four weapons: R-Type wave laser, Centipede ricochet shot, Missile Command cluster/MIRV missile, Gradius Options orbiting satellites; four power-ups: Defender smart bomb, Gradius force field, Space Invaders mystery UFO, and the Pac-Man power pellet — since **removed**, see the research doc §5) plus the candidates considered but not selected. Each selected concept's entry specifies its catalogue seam, level-curve variables and the gym scene that will exercise it; the document is the design brief for the epic's per-concept child work items and is validated by `src/classicPowerUpWeaponResearchDocs.test.ts`.

| ID | Name | Effect | Icon Suggestion |
|----|------|--------|-----------------|
| P1 | **Spread Shot** | Fires a 3-bullet fan (-30°/0°/+30° relative to heading) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Triple-line neon arc |
| P2 | **Rapid Fire** | Fires single bullets at a markedly higher rate (**6/beat** ≈ 125 ms at 80 BPM) for **10 seconds** (timed, cumulative — added to the active set alongside other weapons) | Stacked dots (stream of bullets) |
| A1 | **Nova** | **AOE (onFire ring).** An expanding ring centred on the ship damages every enemy and clears enemy bullets within **45 px**, every **4 beats** (3000 ms at 80 BPM). The ring shot is a **bright expanding ring shockwave** from the ship — a `ring`-shape bullet identity with a bright pale-cyan muzzle flash launch cue and a baked expanding-ring impact cue played through the shared AOE VFX seam (AH-0MV822BPT002GF17). Collected as a timed 10 s drop. | Concentric neon rings |
| A2 | **Mortar** | **AOE (onRandom blast).** Detonates **immediately at a random point** within its effective range (180 px = projectile speed 180 px/s × 1 s lifetime) of the ship — no travelling shell, no forward bias — damaging every enemy and clearing enemy bullets within **35 px**, every **2 beats** (1500 ms at 80 BPM). The shell reads as an **arcing shell**: a hot deep-orange launch flash at the ship and a wispy inbound arcing shell trail into a bright blast flash through the shared AOE detonation seam, the blast playing the baked **mortar impact crack** layered under the heavy detonation boom (AH-0MV822C250051OVN). The audio cue always fires; VFX is culled when the sampled point falls off-screen. Collected as a timed 10 s drop. | Random blast burst |
| A3 | **Arc** | **AOE (onFire chain).** Strikes the nearest enemy, then chains to **2 additional nearby** targets within **60 px**, damaging each and clearing enemy bullets along the bolt path, every **1 beat** (750 ms at 80 BPM). The shot renders as a **jagged lightning bolt** between the chained targets (the shared `spawnArcChain` bolt VFX) with an electric-purple launch flash at the ship, and a baked electric impact crack + purple impact flash at every connected target through the shared impact seam (AH-0MV822CE7004MQ14). Collected as a timed 10 s drop. | Jagged lightning bolt |
| P3 | **Wave Laser** | **Bounded R-Type beam (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S).** Fires a single slow, long-range neon beam (**1/beat** = 750 ms at 80 BPM, ~350 px range) along the ship's heading. The beam has a **total damage budget** (`maxHitPoints`, a base of **2** at level 0): it **passes through** the ships it destroys, spending one damage point per hit point, and deals its remaining damage to the ships behind them before being consumed — a base budget of **2**, grown by the **Max Hit Points** weapon-level variable with **no clamp** (it saturates near ~7 via the shared exponential-saturation curve). It does not clear enemy bullets. Collected as a timed 10 s drop. | Long horizontal beam with pass-through chevrons |
| P4 | **Ricochet** | **Edge-bouncing shot (Centipede homage, AH-0MV1BIV5L005NJAI).** Fires a single neon **teardrop/streak pellet with a short fading trail** (visual metadata on `WeaponDefinition`, drawn through the shared bullet-shape seam) (**1/beat** = 750 ms at 80 BPM, 1.6 s lifetime) along the ship's heading. Instead of wrapping, the pellet **reflects off the arena edges** while it has **bounce budget** left — a base budget of **2**, grown by the **Bounce** weapon-level variable toward its cap of **4** — and expires on the wall contact once the budget is spent, so a missed shot can still bank into an enemy. Each wall bounce plays a brief green edge-flash + the baked ricochet impact cue through the shared impact seam (AH-0MV822AP1006W2F9), so the bounce lands audibly and visually even when it misses. It does not pierce and does not clear enemy bullets. Collected as a timed 10 s drop. | Zig-zag bank-shot path between two walls |
| P5 | **Cluster Missile** | **Splitting/MIRV missile (Missile Command homage, AH-0MV1BIVIJ007KYXU).** Fires a single small missile shell (**1 shot every 2 beats** = 1500 ms at 80 BPM, 0.9 s lifetime) along the ship's heading, rendered as a neon **missile with a flickering exhaust flame, a white-hot rim and a short fading smoke trail**, launching with a low whoosh + magenta launch puff (AH-0MV822B1B0048UZT). On its first impact or on expiry it **splits once** into a radial cluster of **warheads** — a base count of **2**, grown by the **Split** weapon-level variable toward its cap of **3**, fanned **evenly around the full 360° circle** with a constant +90° phase offset from the heading (the base two fly at **90°/270°**, perpendicular to the direction of travel — never straight ahead or 180° backwards) — each an ordinary short-lived **small disc** bullet that damages enemies on contact, playing the baked cluster detonation cue + hot-pink flash through the shared impact seam when a warhead connects. It uses a neutral `splits` projectile seam, **not** an `AoEDescriptor`: the warheads are points, not an area, so it is the offensive counterpart of the Mortar. It does not pierce, bounce or clear enemy bullets. Collected as a timed 10 s drop. | Central shell bursting into a radial cluster of warheads |
| P6 | **Options** | **Orbiting satellite escort (Gradius homage, AH-0MV1BIVVK0043TEM).** Adds **two neon satellite pods** that orbit the ship and each fire a bullet **radially outward along its own orbit direction** — in the direction of the orb, not the ship's heading (**1/beat** = 750 ms at 80 BPM) — on the shared beat grid. The 2000 ms orbit is deliberately not a whole multiple of the 750 ms fire interval (0.375 revolutions per trigger), so consecutive volleys aim in different directions and the escort fans into a rotating spike pattern (`isOptionsOrbitTriggerAligned`, AH-0MV5DFBVW002J2XO). The pod count grows with the **Projectiles** weapon-level variable (one extra pod per point, capped at **6** so the orbit stays legible); each pod bullet is smaller and slower than the cannon's, so the escort multiplies firepower without eclipsing the main gun. Each pod shot is a **small pod dart with a pale-aqua rim tint and a short faint fading trail**, firing with a bright soft-tone cue + aqua launch flash and popping with a soft-aqua hit pop + impact flash on connect (AH-0MV822BDN008IYL6). The pods are decorative satellites only — they never block bullets and never collide. It uses a new shared `orbit` companion-entity seam, **not** an `AoEDescriptor`. Collected as a timed 10 s drop. | Ship ringed by orbiting satellite pods |
| shield | **Shield** | Absorbs its level-resolved number of hits (base 1 → cap 3) before popping; visible shield bubble for 15 seconds (the rim pulses continuously for the whole 15 s; in the final second the fill turns opaque, then the fill shrinks inside the hull before the bubble clears) | Shield outline |
| bomb | **Bomb** | Clears enemy bullets within a level-resolved radius (base 120 px → cap 320 px) centred on the ship. A field pickup is a single explosion; a hold-full (permanent) bomb pulses at a level-resolved rate (base 0.33/s → cap 1/s). Does not damage enemies — they are 1 HP. | Exploding circle |
| speed_boost | **Speed Boost** | Increases movement speed and rate of fire by 50% for 10 seconds | Arrow with motion lines |
| phase_shift | **Phase Shift** | **Automatic** defensive pass-through (parent AH-0MUIYX1EE008FVS8). Collecting Phase Shift grants its level-derived **auto-activation charges** (base 1 → cap 3, §4.4.3) into a **finite recharging pool capped at 3**: each spent charge starts its **own per-charge recharge timer** whose duration is the **level-derived recharge time** at the moment of consumption (30 s at base → 10 s at the cap; §4.4.3), advanced by the shared per-frame recharge clock, and a completed timer returns one charge to the pool. When **3 or more hostile bodies/bullets** close within **40 px** (`2 × ship size`) of the ship and a charge is available, the ship phases out for **1.5 s** — passing through enemies and bullets and **unable to collect minerals** while phased during combat (power-up/weapon drops remain collectable; the between-waves/levels transition pause is the one exception — a phase active at wave-clear still collects minerals, AH-0MUX96GJF006CAZP). After expiry the effect re-arms only once the danger has dropped below the threshold **and** a **~0.5 s re-arm cooldown** has elapsed. The **hold-full reward adds exactly one charge** to the same recharging pool (never an unlimited supply, AH-0MV82I7TX0009JMT), so an empty pool blocks activation until a charge recharges. | Ghostly outline |
| teleport | **Teleport** *(collectable)* | Automatically teleports the player (no key press) in the direction of travel to the nearest safe spot (free of enemies and bullets, clamped to screen bounds) when the ship is in danger; if no safe spot exists, teleport to nearest on-screen position; it is a **finite recharging pool capped at 3**: each collection grants its level-derived stored teleports (base 1 → cap 3, §4.4.3), consumed on activation FIFO, and each spent teleport starts its **own per-charge recharge timer** at the **level-derived recharge time** (15 s at base → 5 s at the cap; §4.4.3) returning to the pool when it elapses; on arrival, player gains Phase Shift effect (1.5-second intangibility) | Teleport symbol (portal/ripple) |
| extra_life | **Extra Life** *(passive, rare)* | Collecting this power-up grants **+1 life** immediately (applied passively, no activation required). Lives are capped at **5 total** — excess pickups have no effect. Carries the **Extra Life relative weight of 3** versus **4** for standard power-ups (Shield–Teleport, Magnet, Mineral Scoop), so it takes ≈ **11.1 % of power-up draws** in the shared weighted pool — rarer than standard drops, but ≈ 2.8× its former share (weight 1). | Heart outline with neon glow |
| magnet | **Magnet** *(hybrid: timed pickup / permanent upgrade)* | Attracts **all power-up drops on screen** — including rare types such as Extra Life — toward the player ship, making pickups easier to grab during dense bullet patterns. As a **field drop** it activates a **15 s** attraction that **refreshes on re-collection** (never stacks); as a **hold-full reward** it is applied **permanently** and **stacks up to 5**, increasing the attraction radius by **+50% per stack** from a **base radius of 1× the player ship size** (halved from 2× by AH-0MUTTAHQ9001T83A). No activation key is required and nothing is consumed. The attraction speed is **slower than the ship's movement speed**, so the player must still move toward the power-up — or remain stationary for it to drift in — to collect it. | Horseshoe magnet with neon glow |
| mineral_scoop | **Mineral Scoop** *(hybrid: timed pickup / permanent upgrade)* | Attracts **nearby minerals on screen** toward the player ship — the mineral-field analogue of Magnet. As a **field drop** it activates a **15 s** attraction that **refreshes on re-collection** (never stacks). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**, using the same radius curve as Magnet (base **1× the player ship size**, **+50% per stack**) and the same attraction speed (`MAGNET_ATTRACTION_SPEED`, 120 px/s — slower than the ship). It only **attracts**; minerals are still collected by hull contact (and are not collectable while phased during combat, with the between-waves transition pause as the exception — AH-0MUX96GJF006CAZP). | Neon scoop bowl with mineral dots |
| smart_bomb | **Smart Bomb** *(stored)* | Fires a **ship-centred pulse** (Defender/Robotron homage, AH-0MV1BIWP9003EHRQ, weight **2**): it damages **every enemy within the pulse radius once** and clears **every enemy bullet in range**. A field pickup fires **one** pulse; the hold-full reward makes the pulse **permanent**, repeating on a level-resolved interval. It is deliberately sharper than the **Bomb** (bullets only) but only chips multi-hit enemies (one damage instance), so the Harvester and boss survive — the pulse resolves through the shared `AoEDescriptor` area seam, not a parallel implementation. Level variables: **Pulse radius** (`aoeRadius`, 200 → 400 px), **Pulse damage** (1 → 3 HP) and **Pulse interval** (`smartBombInterval`, 30 → 10 s, permanent only). | Neon starburst inside a pulse ring |
| force_field | **Force Field** *(timed)* | A Gradius-homage **reflect bubble** (AH-0MV1BIX1W006XF95, weight **4**): while active an enemy bullet that enters the bubble is bounced **back along its incoming direction** as a **player-owned bullet** that damages enemies through the same shared path as the cannon, and every reflection flashes at the bounce point with the dedicated baked `playForceFieldReflectSound` cue. A level-resolved **reflect budget** caps how many bullets one field returns; once spent the bubble **dims** but **never vanishes**, so a spent field still reads as up even though it no longer reflects. When the timed window (base **8 s**, level cap **18 s**) expires, enemy bullets damage the ship again. The hold-full reward makes the bubble **permanent** for the run, so it persists for the whole run (dimming once its budget is spent). It is distinct from **Shield** (silent absorption) and **Bomb** (clears bullets): it turns incoming fire into offence. Level variables: **Field time** and **Field reflects**. | Hexagonal neon bubble with inward arrows |
| mystery_ufo | **Mystery UFO** *(visible collector drone, rare)* | A Space Invaders-homage **visible collector drone** (AH-0MV1BIXFO006Z1I7 → AH-0MV9G113S009B37I, weight **3**): a field pickup spawns **exactly one** small, code-drawn copy of the player ship. The drone seeks the nearest live mineral, vacuums any whose centre enters its **collector radius**, flies back to the ship and pays the held minerals into the hold when its hold is full **or** its lifetime expires (whichever comes first), then disappears. A full-hull (permanent) reward keeps one drone spawning on a level-resolved interval for the rest of the run. **Enemy bullets and enemy bodies destroy the drone**, spilling its held minerals plus a **2 × level** bonus at the crash site as collectable minerals; the **player's own fire passes through**. The retired instant mineral/score bounty no longer exists. Deliberately rarer than a standard drop, it is purely economic and cannot trivialise combat. Level variables (AH-0MVBMPZ2C0008VAE): **Drone lifetime** (5 → 8 s), **Drone capacity** (10 → 20), **Collector radius** (20 → 40 px), **Spawn interval** (30 → 12 s, permanent only). | Neon flying saucer with a domed cockpit |
| salvage | **Salvage** *(timed)* | A timed **mineral bounty** (parent AH-0MVH80ZJ7009W18Z, weight **4**): while the window is active every destroyed **enemy ship** additionally scatters its level-resolved bonus minerals (**1 → 4**, k=0.35) at the wreck. The bonus drops render **orange** (`MINERAL_SALVAGE_COLOR`, AH-0MVJ72I8O0009T09) so the payout is visible on the field, while every ordinary mineral (asteroid drop, enemy re-drop, seeded gym field, collector-drone spill) stays **gold** (`MINERAL_COLOR`) — the bounty is legible without reading the HUD. Non-blocking hazards (asteroids, lane traffic) are **not** bounty targets, and an orange mineral is still worth exactly one mineral. | Orange mineral shower at the wreck |

> **Salvage — orange mineral bounty (parent AH-0MVH80ZJ7009W18Z, colour AH-0MVJ72I8O0009T09):** A field pickup opens a timed window (`salvageDuration`, base **10 s** → cap **20 s**) during which every destroyed **enemy ship** additionally drops its level-resolved **bonus minerals** (`salvageMinerals`, base **1** → cap **4**) at the wreck — added through the same shared kill seam that re-drops an enemy's absorbed minerals (`PlayScene` and `GymFormationScene`), and gated so asteroid and lane-traffic hazards never pay out. The bonus dots are **orange** (`MINERAL_SALVAGE_COLOR`), decided once in the shared seam `scatterSalvageMineralDrops` (`src/scenes/core/mineralKillDrops.ts`) on top of the shared scatter maths in `src/entities/Mineral.ts`, so the game and every gym cannot drift in colour or position; ordinary minerals keep the gold default. The payout is **purely cosmetic in colour**: each orange dot is still worth exactly one mineral, the scatter consumes the same two RNG draws per drop in the same order, and the HUD already shows the active Salvage window with its level. Coverage: `src/entities/__tests__/Mineral.test.ts`, `src/scenes/core/mineralKillDrops.test.ts`, `src/scenes/PlayScene.test.ts` (`AH-0MVJ72I8O0009T09 — Salvage bonus minerals render orange while ordinary drops stay gold`), `src/scenes/gym/core/GymFormationScene.test.ts` and the repo-wide defined-once guard in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Mineral Scoop — hybrid timed/permanent (parent AH-0MUTPEHMP0074Y1L):** the mineral-targeted counterpart of Magnet. As a **field drop** it grants a **15 s** mineral-attraction field that **refreshes on re-collection and never stacks** (the timed state expires on the shared `EffectsRegistry.tick`). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**. Both paths drive the **same shared attraction helper** (`src/powerups/mineralScoop.ts`) via `CombatCoreScene._applyMineralScoop`, called immediately before the shared `collectMinerals` pass in `PlayScene`, `GymFormationScene` (inherited by `GymMinerals`) and `GymPowerUpsUtility`, so an enabled scoop runs identical code everywhere. The timed-only radius uses **one stack's worth** (`1 × ship size × 1.5` = 30 px at `SHIP_SIZE = 20`); permanent stacks use `1 × shipSize × (1 + 0.5 × stacks)`. It attracts minerals only — it does **not** collect them, and the phased collection gate applies during normal wave play (a phased player cannot collect minerals and the scoop grants no collection on its own). Between waves/levels and at boss entry, however, the ~1.5 s transition pause runs the shared scoop + collection passes with the phase gate bypassed, so a defensive phase active at wave-clear does not cost earned minerals (AH-0MUX96GJF006CAZP). While phased the attraction may still drift minerals, matching the magnet's relationship to drop collection. The **utility gym** (`GymPowerUpsUtility`) seeds a live mineral field **clear of the ship's start position** (a centred 60 px clearance disc, `MINERAL_SEED_CLEARANCE`) so a mineral is never silently collected the instant the gym opens, and cycles **Speed Boost → Extra Life → Magnet → Mineral Scoop**; its help overlay lists Mineral Scoop with its code-drawn icon and catalogue description. Since AH-0MUTOTLCY005NZ8L the Magnet follows the same hybrid model and shares this radius curve and attraction speed, so the two attraction power-ups are behaviourally consistent.

> **Power Pellet — removed (Pac-Man homage, AH-0MV1BIW95004POSX; removed AH-0MV5CB6KO0079N08):** The Pac-Man-inspired Power Pellet and its shared frightened-enemy status layer were removed from the game at the producer's decision (full removal). It previously opened a timed **fright window** during which every live enemy **fled the ship** and had its fire **suppressed**, and ramming a frightened enemy **destroyed it without harming the ship**; the catalogue entry, drop weight, hold-full choice entry, level axes, HUD/icon surfaces, competent-bot valuation and the `src/scenes/core/frightenedState.ts` policy (with its `EffectsRegistry` fright accessors, the combat-core flee/suppression hooks and the `fireForEnemy` suppression parameter) were deleted in one change. The Pac-Man **ghost enemy family** is a separate archetype and is unchanged. The removal is recorded with its reason and recovery path in [`CLASSIC_POWERUP_WEAPON_RESEARCH.md`](./CLASSIC_POWERUP_WEAPON_RESEARCH.md) §5.

> **Smart Bomb — ship-centred pulse (Defender/Robotron homage, AH-0MV1BIWP9003EHRQ):** A field pickup fires **one ship-centred pulse** that damages **every enemy in range once** and clears **every enemy bullet in range**. The pulse is described by an `AoEDescriptor` (`trigger: 'screenPulse'`, `damagesEnemies: true`, `clearsEnemyBullets: true`, `damage`) resolved through the **same** `CombatScene.applyAoEDescriptor` seam as the Nova/Mortar/Arc weapons — there is no parallel area-effect implementation. The registry queues the pulse (mirroring the Bomb), the shared `CombatCoreScene._updateSmartBomb` detects it once per frame, and the scene resolves it via `onSmartBombPulse`, so the game and every gym (notably `GymPowerUpsCombat`) run identical code. The base pulse radius (**200 px**, 10 × SHIP_SIZE) covers a modest ship-centred area that never spans the whole 960×540 field; it adds +2 % of the base per level, capped at **400 px** (2 × base), so an off-screen enemy beyond the radius is provably unaffected. It is deliberately sharper than the **Bomb** but only deals a single damage instance, so multi-hit enemies (the Harvester, the boss) survive; the **hold-full reward** makes the pulse permanent and repeating on a level-resolved interval. Level variables: **Pulse radius** (`aoeRadius`, 200 → 400 px), **Pulse damage** (`smartBombDamage`, 1 → 3) and **Pulse interval** (`smartBombInterval`, 30 → 10 s, permanent only).

> **Force Field — bullet reflector (Gradius homage, AH-0MV1BIX1W006XF95; bubble persistence/spent-dim AH-0MVRDMG0N000Y03Z; reflect feedback AH-0MVRDMMYO002SC5V, parent AH-0MVBKT2WO001AR14):** A field pickup raises a **reflect bubble** around the ship (timed base **8 s**, level cap **18 s**, weight **4**). While the bubble is active, any enemy bullet whose centre enters `EffectsRegistry.forceFieldRadius()` (`SHIP_SIZE × FORCE_FIELD_RADIUS_FACTOR`) is consumed and **re-spawned as a player-owned bullet travelling back along its incoming direction** (velocity reversed) through the shared `CombatCoreScene.spawnPlayerBullet` path — so the bounced shot damages enemies exactly like the cannon, with no parallel bullet system. Every reflection also confirms itself at the bounce point with a shared impact flash in `FORCE_FIELD_COLOR` plus the dedicated baked `playForceFieldReflectSound` cue. The reflection is capped by the level-resolved **reflect budget** (`forceFieldReflects`, base 3 → cap 10): once spent the bubble **dims** (the reduced `FORCE_FIELD_SPENT_STROKE_ALPHA`/`FORCE_FIELD_SPENT_FILL_ALPHA` baseline) but **never vanishes**, so a spent field still reads as up but inert (producer decision Q1 = b on AH-0MVBKT2WO001AR14); when a timed window expires enemy bullets damage the ship normally again. The **hold-full reward** makes the bubble **permanent** for the run: permanence is read from `powerUpTemporaryRemaining()` (`undefined` for a permanent field with no active window), never from the countdown, so the bubble persists for the whole run and dims once its budget is spent. The reflect branch lives once in `CombatScene._handleCollisions` (`_reflectEnemyBullet`), consumed by `PlayScene`, every `GymFormationScene`-derived gym and `GymPowerUpsCombat`, so the game and every gym reflect identically (the duplicate-body guard forbids per-scene copies). The bubble is drawn by the shared `drawForceFieldBubble` helper (hexagonal boundary + inward chevrons) so the visual boundary matches the gameplay radius; a permanent-only field holds a steady pulse with no ending brighten. Coverage: `src/powerups/effects.test.ts`, `src/powerups/powerUpLevels.test.ts`, `src/scenes/core/CombatEffectVisuals.test.ts`, `src/scenes/core/CombatScene.test.ts`, `src/audio/effects.contract.test.ts`, `src/scenes/gym/GymPowerUpsCombat.test.ts` and the game/gym parity block in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Mystery UFO — visible collector drone (Space Invaders homage, AH-0MV1BIXFO006Z1I7 → AH-0MV9G113S009B37I):** The classic mystery-ship bounty, translated into AI_Hell's collection-based economy as a friendly entity. A field pickup spawns **exactly one** small, code-drawn copy of the player ship (`src/entities/MysteryUfoDrone.ts`): it seeks the nearest live mineral, vacuums any whose centre enters its level-resolved **collector radius**, and flies home to the ship, paying exactly the minerals it holds into the hold when its hold reaches **capacity** or its **lifetime** expires (whichever comes first). A full-hull (permanent) reward keeps a drone spawning on the level-resolved **spawn interval** (30 s at the curve base, descending to a 12 s floor). **Enemy bullets and enemy bodies** destroy a drone — it spills its held minerals plus a `2 × level` bonus at the crash site as collectable minerals — while the **player's own fire passes straight through**. The spawn request is queued by the shared `EffectsRegistry.applyCollect` (the same single mutation point every power-up uses) and the shared `src/scenes/core/combatDrone.ts` pass spawns, ticks, pays out and tears the drone down for the game and every gym. The retired instant mineral/score bounty (including `mysteryUfoMinerals`/`mysteryUfoScore`) no longer exists. The collector-drone level axes (**Drone lifetime** 5 → 8 s, **Drone capacity** 10 → 20, **Collector radius** 20 → 40 px, **Spawn interval** 30 → 12 s, AH-0MVBMPZ2C0008VAE) resolve from the shared curve. The drop weight is **3** (rarer than the standard 4) so the reward stays special. The threat-free `GymPowerUpsUtility` gym spawns and drives the drone through the same shared pass, so the spawn → seek → collect → return → payout lifecycle is observable in the gym and identical in the game.

> **AOE weapons — Nova, Mortar and Arc (parent AH-0MQUYOB3OR001V8CD):** Three **area-of-effect** weapons extend the catalogue as ordinary timed weapon drops (10 s, cumulative, cleared by Reset). Each carries a declarative `aoe` descriptor on `WeaponDefinition` (`src/utils/weapons.ts`) — `{ trigger: 'onFire' | 'onImpact' | 'onRandom'; radius; damagesEnemies; clearsEnemyBullets; chains?; projectileSpeed? }` — read **once** by the shared combat core so the game and every gym resolve the same effect. `'onFire'` effects (Nova ring, Arc chain) resolve at the ship the instant the weapon fires and spawn no travelling bullet; `'onRandom'` effects (Mortar) resolve immediately at points sampled uniformly at random within `projectileSpeed × bulletLifetime` of the ship — one per pattern bullet, so `projectileCount` leveling adds detonations; `'onImpact'` effects launch a projectile whose blast resolves at its impact/expiry point (retained for future weapons, not currently used by any catalogue weapon). AOE damage routes through the same `takeDamage()`/`destroySelf()` + single-kill-finalisation seam as a player bullet (destruction audio + score/drop/wave accounting exactly once), the boss is damaged through the same phase path as a player bullet, and enemy bullets inside the effect area are destroyed with the shared impact feedback. **AOE does not alter Bomb** — the bomb keeps its own ranged periodic clear (a single explosion on a field pickup, repeated on a resolved interval when permanent) and never damages enemies; AOE is complementary. AOE fire rates are exact beat subdivisions/multiples (Nova 4 beats, Mortar 2 beats, Arc 1 beat), so the catalogue-wide on-grid invariant holds. Each weapon has a distinctive neon-vector VFX helper (`src/vfx/aoeEffect.ts`: Nova ring, Mortar burst, Arc chain) and a dedicated SFX cue (`src/audio/effects.ts`; the Nova ring expansion additionally plays the baked `playNovaImpactSound` shockwave-hit cue through the shared AOE VFX seam — AH-0MV822BPT002GF17 — and the Mortar blast plays the baked `playMortarImpactSound` shell-impact crack plus the heavy `playMortarDetonationSound` boom through the shared AOE detonation seam, with a wispy inbound arcing shell trail drawn into the burst — AH-0MV822C250051OVN — and the Arc chain plays the baked `playArcImpactSound` electric crack plus a purple impact flash at each connected target through the shared AOE chain seam, alongside the jagged bolt — AH-0MV822CE7004MQ14), plus a code-drawn drop icon (`src/powerups/icons.ts`). Coverage: `src/utils/weapons.test.ts`, `src/utils/aoe.test.ts`, `src/vfx/aoeEffect.test.ts`, `src/scenes/core/AoeWeapons.test.ts` and `src/audio/effects.test.ts`.

> **Wave laser — bounded R-Type beam (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S):** The R-Type homage adds the first **damage-budget** weapon. `WeaponDefinition.maxHitPoints` (optional, `src/utils/weapons.ts`) supplies the base damage budget (2 at level 0); the shared combat core reads it via the per-bullet `PlayerBullet.maxHitPoints` budget. When a player bullet overlaps a new enemy the shared `CombatScene.onPlayerBulletHitsEnemy` spends up to the remaining budget on it (one hit point per `takeDamage()`, so per-enemy damage is capped at the enemy's remaining HP), remembers it in `PlayerBullet.damagedEnemies` (so each enemy is charged at most once) and — if the enemy was destroyed and budget remains — returns `false` so the bullet survives and keeps scanning to the ships behind it; if the enemy survives a partial hit or the budget is spent, the bullet is consumed. `resolveWeaponDefinition` grows the base budget with the level-resolved `maxHitPoints` variable (`src/utils/weaponLevels.ts`) with **no weapon-level clamp**, so it saturates only at the shared curve's asymptote (~7). The shared player-bullets-vs-enemies pass is hosted once in `CombatScene._resolvePlayerBulletsVsEnemies`, consumed by `_handleCollisions` (game + combat gyms) and directly by `GymWeapons` so its inert practice targets demonstrate the budget; no `AoEDescriptor` is used and enemy bullets are not cleared. Coverage: `src/utils/weapons.test.ts`, `src/utils/weaponLevels.test.ts`, `src/scenes/core/CombatScene.test.ts`, `src/scenes/gym/GymWeapons.test.ts` and the game/gym parity block in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Ricochet — edge-bouncing shot (Centipede homage, AH-0MV1BIV5L005NJAI):** The Centipede homage adds the first **wall-bouncing** weapon. `WeaponDefinition.bounce` (optional, `src/utils/weapons.ts`) supplies the base wall-bounce budget; the shared player-bullet step reads it via the per-bullet `PlayerBullet.bounces` field. An ordinary bullet leaves `bounces` undefined and keeps the default four-edge wrap; a ricochet bullet **reflects** off each arena edge it crosses (mirroring its position back inside and reversing the crossed velocity component), decrementing the budget, and — once the budget is spent — **expires** on the next wall contact instead of wrapping. This is the documented divergence from the bullet-wrap rule (GDD §2.4): the bounded bounce count keeps the total on-screen path finite. The reflection lives once in the shared `PlayerBullet.advance` step (consumed by `advanceAndCull`/`advancePlayerBullets` in every scene), so the game and every gym bounce identically. The shot's in-flight identity (AH-0MV822AP1006W2F9) is a neon **teardrop/streak pellet** (white rim, short fading trail) fired with a bright springy ping + green muzzle flash; each wall reflection fires the optional `PlayerBullet.onWallBounce` callback wired by the shared spawn path, which resolves the weapon's baked impact cue and green edge-flash through the same shared impact seam an enemy hit uses — so the bank reads audibly and visually in the game and every gym. `resolveWeaponDefinition` grows the base budget with the level-resolved `bounce` variable (`src/utils/weaponLevels.ts`), clamped to that variable's spec cap, so a levelled ricochet bounces more; the visual/feel metadata is carried through unchanged. No `AoEDescriptor` is used and enemy bullets are not cleared. Coverage: `src/utils/weapons.test.ts`, `src/utils/weaponLevels.test.ts`, `src/entities/PlayerBullet.test.ts`, `src/scenes/core/CombatScene.test.ts`, `src/scenes/gym/GymWeapons.test.ts` and the game/gym parity block in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Cluster Missile — splitting/MIRV missile (Missile Command homage, AH-0MV1BIVIJ007KYXU):** The Missile Command homage adds the first **splitting** weapon. `WeaponDefinition.splits` (optional, `src/utils/weapons.ts`) supplies the base warhead count; the shared combat core tags the fired shell and, on its first impact/expiry, splits it **exactly once** into `splits` radial warheads through `CombatCoreScene.splitProjectile`. This is deliberately **not** an `AoEDescriptor`: the split is a projectile seam (the warheads are points that damage on contact), so it reuses neither the AOE dispatch nor the Mortar blast. Each warhead is an ordinary `PlayerBullet` spawned with a short lifetime, so it damages enemies through the same shared bullet-vs-enemy path the cannon uses. The warheads fan **evenly around the full 360° circle** with a constant **+90° phase offset** from the missile's heading — the base two split to **90°/270°** (perpendicular, never 0° or 180° backwards), and each extra warhead divides the circle evenly. The warheads are **queued** and admitted into the live bullet list at the start of the next shared player tick, so a split during a collision pass can never mutate the array being iterated; the split resolves at most once per shell (`PlayerBullet.splitSpawned`). The seam lives once in the shared core (`CombatCoreScene`), consumed by `_autoFire` and the collision paths in `CombatScene`, so the game and every gym split identically. The shell's in-flight identity (AH-0MV822B1B0048UZT) is a neon **missile with a flickering exhaust flame** (the shared missile shape honouring `bulletRim`, `bulletFlame` and `bulletTrail` visual metadata, the flame length shimmering with the bullet's elapsed time), firing with the baked low-launch `playClusterFireSound` cue + magenta launch puff; the warheads render as **small discs**, and a warhead connect plays the baked `playClusterImpactSound` detonation thump + hot-pink flash through the shared impact seam. `resolveWeaponDefinition` grows the base count with the level-resolved `splitCount` variable (`src/utils/weaponLevels.ts`), clamped to that variable's spec cap; the visual/feel metadata is carried through unchanged. Coverage: `src/utils/weapons.test.ts`, `src/utils/weaponLevels.test.ts`, `src/entities/PlayerBullet.test.ts`, `src/scenes/core/CombatScene.test.ts`, `src/scenes/gym/GymWeapons.test.ts` and the game/gym parity block in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Options — orbiting satellite escort (Gradius homage, AH-0MV1BIVVK0043TEM):** The Gradius homage adds the first **companion-entity** weapon. `WeaponDefinition.orbit` (optional, `src/utils/weapons.ts`) supplies the base pod count and orbit radius; the pure geometry lives once in `src/scenes/core/optionsEscort.ts` (`resolveOptionsPodCount`, `advanceOrbitPhase`, `optionsPodPositions`, `optionsPodFireDirections`, `optionsRevolutionsPerTrigger`, `isOptionsOrbitTriggerAligned`). The shared combat core advances one orbit phase per shared player tick, redraws the pods, and — on the Options weapon's beat tick — spawns one ordinary `PlayerBullet` per pod **radially outward along that pod's own orbit direction** (the ship→pod line, in the direction of the orb) rather than along the ship's heading (`CombatCoreScene.fireOptionsPods`, AH-0MV5DFBVW002J2XO). Because the orbit advances between beat-triggered volleys, each volley fans into a rotating spike/flower pattern; the 2000 ms orbit is deliberately not a whole multiple of the 750 ms fire interval (0.375 revolutions per trigger), an invariant guarded by `isOptionsOrbitTriggerAligned`, so consecutive volleys always aim differently. The pods are decorative satellites: they never block bullets and never collide. `resolveWeaponDefinition` grows the base two-pod escort with the level-resolved `projectileCount` variable, clamped to the legibility cap `OPTIONS_MAX_PODS` (6); the pods fire on the shared 80 BPM grid (1/beat). The seam lives once in the shared core, so the game and every gym orbit and fire identical pods. The pod shot's in-flight identity (AH-0MV822BDN008IYL6) is a neon **small pod dart** — the shared `chevron` family with a **pale-aqua rim tint and a short faint fading trail** (visual metadata on `WeaponDefinition`, drawn through the shared bullet-shape seam), firing with the baked bright-soft `playOptionsFireSound` cue + aqua launch flash and connecting with the baked soft-aqua `playOptionsImpactSound` pop + aqua impact flash through the shared impact seam, so the escort reads and sounds distinct from the main gun. The `homing` variable listed in the research brief remains a planned (unshipped) upgrade. Coverage: `src/scenes/core/optionsEscort.test.ts`, `src/utils/weapons.test.ts`, `src/utils/weaponLevels.test.ts`, `src/scenes/core/CombatScene.test.ts`, `src/scenes/gym/GymWeapons.test.ts`, `src/ui/HUD.test.ts` and the game/gym parity block in `src/scenes/core/CombatScene.equivalence.test.ts`.

> **Bomb** is only available on levels with enemy-fired bullets (Levels 4–5 and Boss) since regular enemies (E1–E7) cannot be damaged by Bomb (E1–E6 are 1 HP, E7 is 5 HP). It clears enemy bullets only, within a level-resolved radius around the ship (AH-0MUVM9RAO004Y3LB).

> **Teleport** is a collectable power-up like other power-ups, dropped by enemies at ~15–20% chance. Teleport is a **finite recharging pool** (AH-0MV82I7TX0009JMT): each collection grants its level-derived stored teleports (base 1 → cap 3), **spent automatically** when the ship is in danger (AH-0MUZE4AIP009HZWC) — there is no activation key. Multiple Teleports stack (FIFO — earliest collected used first) and each spent teleport starts its **own per-charge recharge timer** at the **level-derived recharge time** (15 s base → 5 s cap, §4.4.3); a completed timer returns one teleport and any grant/recharge that would exceed the cap of 3 is discarded. When both a Phase Shift charge and a Teleport stack are held, the shared automatic-defence resolver spends the ability with the **greater available count** (an exact tie is a seeded 50/50); both pools are **finite**, so an empty pool counts as zero and the permanent Phase Shift reward — an ownership flag that adds one charge to the same capped pool, never an unlimited supply — cannot outrank a stored Teleport on ownership alone. One shared re-arm governor allows **at most one defensive activation per danger episode** (danger-cleared plus the ~0.5 s cooldown), so the recharging pools are never drained in a single continuous threat. Upon teleporting, the player gains the Phase Shift effect (1.5-second intangibility, passing through enemies and bullets) to guarantee safety at the landing spot; this direct activation does **not** consume a Phase Shift auto-activation charge (producer Q6).

> **Magnet — hybrid timed/permanent (AH-0MUTOTLCY005NZ8L):** the drop-targeted counterpart of Mineral Scoop. As a **field drop** it grants a **15 s** drop-attraction field that **refreshes on re-collection and never stacks** (the timed state expires on the shared `EffectsRegistry.tick`). As a **hold-full reward** it is applied **permanently** and **stacks up to 5**. Both paths are modelled once in the shared `EffectsRegistry` and consumed through `magnetEffectStacks()`, which `CombatCoreScene._applyDropMagnet` passes to the shared attraction helper (`src/powerups/dropMagnet.ts`), so PlayScene and every gym pull drops with identical range semantics. The timed-only radius uses **one stack's worth** (`1 × ship size × 1.5` = 30 px at `SHIP_SIZE = 20`); permanent stacks use `1 × shipSize × (1 + 0.5 × stacks)`. It is passive — no activation key and nothing is consumed — and the attraction speed is **slower than the ship's movement speed**, so the player still needs to move — or hold position — to collect drifted drops.

> **P1 / P2 (Weapon Power-Ups) — Cumulative and timed (10 s):** Weapon power-ups (P1 Spread Shot, P2 Rapid Fire, plus Dual) are **cumulative and timed** — collecting one **adds** it to the ship's active set for **10 seconds**, with its own independent countdown from the moment of collection (re-collecting resets only that weapon's timer). All active weapons fire simultaneously, each at its own fire rate; the **Cannon** is permanent and never times out. A fourth power-up drop, **Reset**, clears **all** timed weapons, leaving only the Cannon.

> **Beat-aligned fire grid (AH-0MUAYB8EH005RJ8B):** Player fire is globally quantised to a **silent internal 80 BPM beat** (no audible metronome and no background music — GDD §7.3 keeps music out of MVP scope). Every weapon's fire interval is an exact subdivision of the beat — Cannon **2/beat (375 ms)**, Spread **1/beat (750 ms)**, Dual **1/beat (750 ms)**, Rapid **6/beat (125 ms)** — so every shot lands on a grid tick (`beatPeriodMs % fireRateMs === 0`) and all simultaneously active weapons stay phase-locked. A weapon collected mid-beat fires its first shot on the next tick. The beat clock lives in the shared combat core (`CombatCoreScene.beatClock`, `src/utils/beat.ts`) and is anchored at scene/player start, advancing with game time (it pauses with the game). BPM and the per-weapon subdivisions are configurable through the game-rules config (`src/core/rules.ts`: `beatBpm` default **80**, `weaponSubdivisions` default `{cannon: 2, spread: 1, dual: 1, rapid: 6}`), persisted in localStorage like the other rules; each fire rate is derived as `60000 / beatBpm / subdivision`, so the catalogue-wide on-grid invariant holds for any configuration. Enemy fire timing is unchanged. **Explosion accents** (AH-0MV01HNLU008S5E3): the non-weapon destruction cues (`playDestructionSound`, `playDiverDestructionSound`, `playPlayerDestructionSound`) are deferred to the next 16th note (`beatPeriodMs(bpm) / 4`; 187.5 ms at 80 BPM) with a small per-tick cap, while explosion VFX stays on the death frame and weapon/interception cues stay immediate. Coverage: `src/utils/beat.test.ts`, `src/utils/weapons.test.ts` (catalogue invariant), `src/audio/effects.test.ts` (accent scheduling), `src/entities/Player.test.ts` and the scene-level grid tests.

> **Bullet range — per-type lifetime + four-edge wrap:** All bullets (player and enemy) **wrap around all four screen edges** (the same classic Asteroids model as the player ship and asteroids) and are **never culled for leaving the screen**. Each bullet type is instead destroyed once its own **lifetime in seconds** elapses, so its **effective range is `bulletSpeed × lifetime`**. Player-weapon lifetimes live on `WeaponDefinition` (`src/utils/weapons.ts`): Cannon **0.75 s** (~262 px at 350 px/s), Spread **0.7 s** (~245 px), Dual **0.7 s** (~245 px), Rapid **0.375 s** (~131 px); the AOE radii (`AOE_RADII`) are Nova **45 px**, Mortar **35 px** and Arc **60 px**. These base values were **halved** from the original tuning baseline to bring engagements closer and reduce on-screen bullet saturation (AH-0MUU131PU006O7ZD); because weapon-levelling applies **relative** multipliers to the base catalogue values (`resolveWeaponDefinition`, `src/utils/weaponLevels.ts`), the effective range at **every** weapon level is halved too, and the levelling curve itself is unchanged. Enemy bullet speeds were **halved** by AH-0MUWZ5GST003NMFQ so incoming fire is more readable and dodgeable; enemy bullet lifetimes are **unchanged** by that item and live on `EnemyConfig` (`src/core/enemyConfig.ts`), overridable through the existing enemy-config / CSV plumbing. Because effective range is `bulletSpeed × lifetime` and the lifetimes are unchanged, every enemy's effective range is also **halved**. Using the committed CSV lifetimes (the runtime source of truth), the effective ranges are now: Scout **1.4 s** (90 px/s ≈ 126 px), Diver **1.5 s** (110 px/s ≈ 165 px), Tank **1.5 s** (75 px/s ≈ 113 px), Phaser **1.75 s** (90 px/s ≈ 158 px), Swarm **1.5 s** (90 px/s ≈ 135 px), Boss Swarm **0.7 s** (80 px/s ≈ 56 px). The Central AI boss keeps its 2.0 s default lifetime. Because wrapping keeps more bullets alive, the lifetime caps on-screen density; the values above are the shipped tuning baseline (player weapons halved again after review, AH-0MUU131PU006O7ZD) and are safe to adjust without any architectural change. A bullet whose lifetime elapses is **destroyed and removed from the display list** — it never lingers on screen as a stationary projectile.

> **Net-new unlock-pool weapons (AH-0MVCRC52P001YIPW):** Five weapons extend the catalogue beyond the original 11 (16 total): **Rear Guard** (one backward shot; `pellet`), **Broadside** (a perpendicular left/right pair; `dart`), **Railgun** (a slow long-range tracer with a base damage budget of **5** — deeper than the Wave Laser — `tracer`), **Shard Swarm** (a tight symmetric five-shard fan within ±15°; `shard`) and **Heavy Slug** (the largest, slowest single round; `heavy-shell`). Each has its own beat-grid cadence, colour and code-drawn icon, and fires through the shared pattern/`maxHitPoints` seams, so the game and every gym run identical code. They are **not** in the basic spread→dual→rapid drop rotation; they are the **mini-boss unlock pool** (§4.4.4): at Level 1 exactly half of the 16-weapon catalogue (these five plus Wave Laser, Cluster Missile and Arc) is locked and becomes available through mini-boss rewards.

> **Implemented in the GymWeapons gym (§6.4, `src/scenes/gym/GymWeapons.ts`):** The weapon power-ups (Cannon default, Spread, Dual, Rapid, **the wave laser, ricochet and cluster missile, the Options escort, plus the AOE family Nova/Mortar/Arc**) are implemented with **cumulative + timed (10 s)** semantics, along with auto-fire in the direction of travel (GDD §2.3). The scene demonstrates round-robin weapon-drop spawning (**Spread → Dual → Rapid → Wave Laser → Ricochet → Cluster Missile → Options → Nova → Mortar → Arc → Reset**, one drop at a time, 7 s lifetime) and cumulative collection — each collected drop **adds** its weapon to the active set, expired weapons are **silently dropped**, and Reset clears them all. It extends the shared `CombatScene` core so the AOE dispatch and VFX are inherited unchanged, and hosts **three inert practice targets** (an intentional gym-only divergence, F6 AC5) so the Nova ring, Mortar blast and Arc chain are visibly demonstrated; the targets respawn after a short delay once cleared. The weapon catalogue (`src/utils/weapons.ts`) provides pure definitions (pattern offsets, fire rates, bullet visuals, AOE descriptors) plus `isTimedWeapon()` (cannon = permanent, all other weapons = timed) and heading math (including the most-recent-heading fallback when stationary); `src/entities/Player.ts` exposes the cumulative weapon collection (`equipWeapon` adds, `resetWeapon` clears timed weapons), per-weapon 10 s timers (`tickWeaponTimers`), and **phase-locked beat scheduling** (`getBeatClock`/`getLastShotTime`, `tryFire` returns every active weapon whose next beat tick has elapsed this frame), and `src/entities/PlayerBullet.ts` the player projectile. Audio cues (spawn, despawn, collection, weapon-change, plus the AOE fire/detonation cues) are in `src/audio/effects.ts`, and icon shapes in `src/powerups/icons.ts` visually hint at each weapon's pattern: fan arc for Spread, parallel bars for Dual, stacked dots for Rapid, a pass-through beam for Wave Laser, a bank-shot zig-zag for Ricochet, a splitting warhead cluster for Cluster Missile, a ship ringed by orbiting pods for Options, concentric rings for Nova, arced shell for Mortar, jagged bolt for Arc, return/undo arrow for Reset.

> **Implemented in the GymPowerUpsCombat gym (§6.4, `src/scenes/gym/GymPowerUpsCombat.ts`, AH-0MTC2P6G3007PJ40):** The combat-coupled power-ups **Shield (15 s, absorbs its level-resolved hits), Bomb (ranged periodic enemy-bullet clear, no enemy damage), Phase Shift (finite recharging charge pool, auto-triggered 1.5 s pass-through), and Teleport (finite recharging FIFO pool, automatic on danger → nearest safe spot in direction of travel + 1.5 s Phase Shift on arrival)** are demonstrated with **low-level scout threats** (3 scouts in V-formation, aimed fire). Round-robin spawning **Shield → Bomb → Phase Shift → Teleport** (one drop at a time, 5 s lifetime, grow/hold/shrink, 3% collection threshold, 32 px bubble + icon) mirrors the threat-free GymPowerUps gym but with live threats so shield absorb, bomb clear, phase pass-through and safe-spot teleport are observable. The shared automatic-defence feed consumes one Teleport stack when Teleport is selected; hit response respects Phase Shift pass-through > shield absorb (popping on its last absorption) > unshielded hit + brief invulnerability blink. teleport runs through the single shared `CombatScene.triggerTeleport` path — the gym supplies only its enemy list and hit radii through the `getEnemyEntities`/`getTeleportEnemyHitRadius`/`getTeleportBulletHitRadius` hooks, so game and gym cannot diverge on the teleport safety rule (gap 7, AH-0MUII3EPU0039R5O). `findTeleportDestination` resolves the nearest safe spot (free of enemies/bullets within `TELEPORT_SAFE_RADIUS`, clamped to screen bounds). The standalone HUD (`src/ui/HUD.ts`) is reused unchanged (reads Shield/Phase Shift timers, Phase Shift auto-activation charges and Teleport stacks from the shared `EffectsRegistry`).

> **Implemented in the combat formation gyms (§6.4, `src/scenes/gym/GymFodderEnemies.ts` / `src/scenes/gym/GymBoss.ts`, AH-0MU3VOQKH005YOBH):** From here the enemy-bearing formation gyms run a **shared opt-in power-up layer** in `GymFormationScene`: a `WeightedRandomSpawner` over **the full drop pool — all power-ups plus the weapon drops (Spread, Dual, Rapid, Nova, Mortar, Arc, Reset)** seeded from the game-rules config (`src/core/rules.ts`), a `RandomAvoidingPlacement` strategy (`src/powerups/placement.ts`) that avoids live enemy bodies and the player, **one drop on screen at a time** on the configured interval (default **12.5 s**), fly-over collection (≥ 3 % scale; the ship hull collects a drop on first contact with its visible bubble ring — `POWER_UP_DROP_SIZE × POWER_UP_BUBBLE_RADIUS_FACTOR × scale`, 32.4 px at full scale) applied through the shared `EffectsRegistry`, and the standalone HUD with the lives counter visible (**one merged row per owned/active power-up or weapon**, each showing the current effective level and an `∞`/countdown indicator — AH-0MUX802450085VZZ). The §4.4 rarity guidance is encoded as **relative weights** — standard power-up IDs (Shield–Teleport, Magnet, Mineral Scoop) default to **4** and **Extra Life** to **3** (a 4:3 ratio: Extra Life remains rarer but now takes ≈ 11.1 % of power-up draws), while each weapon drop (spread/dual/rapid/reset) defaults to **2** so weapons appear alongside standard effects without dominating them; the existing `WeightedRandomSpawner` normalises them internally. Collecting a weapon drop equips it through the registry for 10 s (independent countdown per weapon); the **Reset** drop clears every active weapon. A **live spawn-interval slider** (`src/utils/gymPowerUpControl.ts`) tunes the cadence of the running scene and persists the value through the rules config, so the interval is no longer a compile-time constant.

> **Shared Shield/Phase Shift hit-gating in the formation gyms (AH-0MUHM66ES0027QQV):** Collecting a dropped **Shield** or **Phase Shift** in a formation gym has the **same defensive effect as in `PlayScene`**: the gating lives once in the shared `CombatScene` (`isPlayerPhased()` reads `getEffectsRegistry().isPhased`; `tryAbsorbPlayerHit()` consumes one shield absorption, runs the `onShieldAbsorbed()` cue seam, starts the shared invulnerability window and reports the hit absorbed). Since the automatic Phase Shift change (parent AH-0MUIYX1EE008FVS8) a collected Phase Shift grants its level-derived auto-activation charges into a finite recharging pool and the shared per-frame danger feed (`CombatScene._updateAutoDefence`, wired into `PlayScene`, `GymFormationScene` and `GymPowerUpsCombat` immediately before `_handleCollisions`) triggers the 1.5 s pass-through in every scene (and, since AH-0MUZE4AIP009HZWC, spends a stored Teleport when that is the selected defence); the hit-gating hooks themselves are unchanged. `GymFormationScene` and its `GymFodderEnemies`/`GymBoss`/`GymMinerals` subclasses inherit it — a gym scene must **not** re-implement the hooks. The shield bubble and Phase Shift ghost are drawn through the shared `CombatEffectVisuals` helper, and the Phase Shift screen-wide juice through `src/vfx/phaseShiftJuice.ts`, so the enemy gym looks identical to the shipped game and the combat gym.

> **shield ending indicator (AH-0MUAYB5HR001HDYC):** The shield bubble winds down as it expires so the drop is telegraphed rather than instant, and its rim **pulses continuously** for the whole active lifetime (from collection until it disappears) rather than only at the end. The animation is owned by the shared `drawShieldBubble` helper (`src/scenes/core/CombatEffectVisuals.ts`) and is a **pure function of `registry.remaining('Shield')`** — frame-rate independent and identical in `PlayScene`, `GymPowerUpsCombat` and `GymFormationScene`. The **rim pulses** (stroke alpha oscillates between `SHIELD_BUBBLE_PULSE_MIN_MULTIPLIER` and `1×` the base `SHIELD_BUBBLE_STROKE_ALPHA` `0.9` at `SHIELD_BUBBLE_PULSE_RATE`) for the entire active lifetime, while the **fill** stays at its steady translucent alpha `SHIELD_BUBBLE_FILL_ALPHA` `0.12` and the radius stays at `SHIP_SIZE × SHIELD_BUBBLE_RADIUS_FACTOR` `1.6`. In the **final second** (`SHIELD_BUBBLE_ENDING_SECONDS` `1.0`) the fill ramps up to the documented "opaque" alpha `SHIELD_BUBBLE_ENDING_FILL_ALPHA` `0.6`. In the **final half second** (`SHIELD_BUBBLE_SHRINK_SECONDS` `0.5`) the **fill** shrinks monotonically from the full bubble radius down to `SHIP_SIZE × SHIELD_BUBBLE_SHRINK_MIN_FACTOR` (`0.3` → 6 px, inside the hull radius `SHIP_SIZE / 2` = 10 px) while the pulsing rim keeps its full radius; at expiry the bubble clears and nothing is drawn. The animation is **cosmetic only** — the shield keeps absorbing until its remaining count reaches zero or the bubble expires (`tryAbsorbShield` is multi-hit aware) and each absorbed hit decrements the remaining count, popping the bubble on the last with no ending animation. All thresholds/colours are exported constants and pinned by `src/scenes/core/CombatEffectVisuals.test.ts`.

> **Collection feedback — pop SFX + absorb VFX (AH-0MUAYB3OU0087H9W):** Every collected drop — power-up or weapon — plays the generic percussive pop (`playPowerUpCollectPopSound()` in `src/audio/effects.ts`) alongside its existing per-type pickup cue, and is visibly "sucked into the ship" by a shared absorb animation (`src/powerups/collectAnimation.ts`): over ≤ 0.3 s the drop's position converges on the ship's world position, its scale shrinks to zero, and its shape shears/rotates toward the hull before its `Graphics` is destroyed. One generic treatment is used for all drop types; the VFX is cosmetic only and never delays the gameplay effect (registry/lives/weapon updates; the Bomb ranged pulse is applied by the shared per-frame bomb step), which is applied on collection. Wired into `PlayScene`, the shared `GymFormationScene` (covering `GymFodderEnemies`/`GymBoss`), and the legacy `GymPowerUpsUtility`/`GymPowerUpsCombat`/`GymWeapons` scenes so the game and gyms never diverge.

> **Catalogue descriptions + gym help overlay (AH-0MUAYB67I002REOZ):** Every catalogue entry now carries a one-line player-facing `description`: `POWER_UP_CATALOGUE.description` (`src/powerups/types.ts`) for all power-ups, and `WEAPON_CATALOGUE.description` plus a `RESET_DROP` entry (`src/utils/weapons.ts`) for Cannon/Spread/Dual/Rapid/**Nova/Mortar/Arc**/Reset. The three tuning gyms (`GymPowerUpsUtility`, `GymPowerUpsCombat`, `GymWeapons`) each render a `Help (?)` button next to `← INDEX` and also respond to the `?` key. Opening the help **pauses** the gym's simulation and launches the full-screen `HelpScene` (`src/scenes/HelpScene.ts`), which lists **exactly the drops that gym can spawn**, one row each showing the same code-drawn icon as the field drop, the display name and the catalogue description — read from the shared catalogues so the help text cannot drift from implemented behaviour. Closing via `?`, the `Close` control (focused by default, keyboard-operable) or **ESC** resumes the gym exactly where it paused; while the overlay is open ESC closes the help and does **not** return to the menu. The shared helper is `addHelpButton` (`src/utils/gymHelp.ts`), wired into the three gyms only (the full-pool formation gyms and the shipped `PlayScene` are out of scope).

#### Loadout slots — the shared six-slot cap (parent AH-0MVLIJT3M005HPHF)

A run's loadout is capped at **six slots**, and that pool is **shared** across
power-up and weapon kinds. A kind holds a slot while it is held **permanently**
(a hold-full choice §4.4.1 or mini-boss reward §4.4.4 grant) **or
temporarily** (an active field pickup), so a run can never hold more than six
distinct kinds at once, however they were acquired. This is the **demand-side**
counterpart of the level-scaled supply reduction in §4.4
(AH-0MVHT1M6O003PU7P); its balance rationale and the chosen shared-pool
semantics are recorded in [`docs/BALANCING.md`](./BALANCING.md).

- **One named constant.** `POWER_UP_SLOT_CAP = 6`
  ([`src/core/constants.ts`](../src/core/constants.ts)) governs occupancy; a
  slot is a **distinct held drop kind**, whether that kind is a power-up or a
  weapon drop, and whether it is held permanently or temporarily.
- **Derived, not counted.** Occupancy is **derived** from the existing
  run-scoped stores — `PowerUpLevelStore.getLevels()` and
  `PowerUpLevelStore.getTempPowerUpIds()` for power-ups,
  `Player.getWeaponLevels()` and `Player.getTempWeaponIds()` for weapon drops —
  so there is **no second slot counter**, and a repeat pickup or grant of a held
  kind **levels it up** instead of opening a new slot.
- **Field pickups occupy a slot while they last (producer Q4a, 2026-10-27).** A
  temporary field-pickup stack counts towards the six for as long as its timed
  window is active, and the slot is **released when the window expires**
  (`PowerUpLevelStore.clearTemporary` / `Player.tickWeaponTimers`), so occupancy
  can churn during a run. Run restart (`PowerUpLevelStore.reset()` /
  `Player.resetWeaponLevels()`) clears both components, emptying the pool.
- **A blocked drop is refused with a distinct cue (producer Q5b).** At six held
  kinds a drop whose kind is neither held, nor available-when-full, nor the
  slot-exempt `reset` utility is **not collectable**: it stays on the field (and
  becomes collectable again if a slot frees), no effect or absorb animation is
  applied, and the distinct **not-collectable cue**
  (`playPowerUpBlockedSound()`, played once per drop while it stays blocked)
  replaces the pickup pop, so the player can tell why the pickup failed. The
  gate is the shared `canCollect` predicate of `collectOverlappingDrops`,
  supplied by `CombatCoreScene`, so the game and the gyms refuse identically.
- **The permanent cannon and `reset` never count.** The cannon can never hold a
  timed level and the `reset` weapon utility cannot be permanently granted, so
  neither can occupy a slot; `reset` is also never gated by the cap. A weapon
  slot therefore means a real weapon **drop** at a permanent level ≥ 1 or with
  an active temporary stack.
- **Available-when-full is a per-entry catalogue flag.** Once all six slots are
  filled, only the held kinds plus catalogue entries flagged
  `availableWhenSlotsFull` may spawn or be offered as a **permanent pick**. The
  flag lives on the power-up catalogue entry
  (`PowerUpEntry.availableWhenSlotsFull`), **defaults to `false`** so a newly
  added entry is non-exempt unless it opts in, and there are no
  `id === '…'` special cases — a future exemption is a data change, not a code
  change. **Extra Life** and **Mystery UFO** set the flag today. An exempt entry
  **never occupies a slot** (producer Q7a): it is excluded from the count as
  well as from the gates, so taking it can never push a run past six.
- **The hold-full choice offers only what is in the slots (producer Q6a).** When
  a hold-full offer (or the mini-boss reward, which reuses the same builder) is
  made at six held kinds, it offers level-ups of permanently-owned kinds, a
  permanent pick for a kind held only temporarily (it already owns its slot) and
  the available-when-full entries — never a kind outside the slots, so a seventh
  kind can never be taken. Below the cap the gate is inert.
- **Every permanent-grant surface is gated, including the mini-boss unlock.**
  The mini-boss reward (§4.4.4) offers two option families, and only the
  **upgrade** half is built by `buildChoiceCandidates`. Its **unlock** half — a
  brand-new weapon kind from the initially-locked pool — is an offer of its own,
  so it is filtered through the same shared predicate
  (`filterOptionsWithinSlotPool` in [`src/powerups/slots.ts`](../src/powerups/slots.ts))
  before the reward opens. At six held kinds an unlock survives only for a kind
  already in the slots (a locked weapon currently held from a field pickup,
  taking it makes it permanent); every other unlock is withheld. A full pool
  therefore cannot be exceeded through a reward screen: the reward offers only
  what is in the slots, and if that leaves nothing to pick it falls back to base
  picks of the held kinds (which add no new kind) so the paused overlay can
  never open empty.
- **One implementation, observable in the gyms.** The rule lives once in
  [`src/powerups/slots.ts`](../src/powerups/slots.ts). The shared drop draw
  (`drawNextDrop` in [`src/scenes/core/dropLayer.ts`](../src/scenes/core/dropLayer.ts)),
  the shared collection gate (`CombatCoreScene`) and the hold-full choice pool
  (`buildChoiceCandidates` in
  [`src/powerups/choice.ts`](../src/powerups/choice.ts)) all consume it, so
  `PlayScene` and every gym apply the identical gate (gym↔game parity —
  [`docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md`](./ENEMY_DESIGN_AND_IMPLEMENTATION.md)
  §5.1). Below the cap the gate is inert, so spawning, collection and choice
  behaviour are unchanged.

#### 4.4.1 Minerals, the Ship's Hold & the Power-Up Choice (AH-0MUBVGI62004ED9Q)

Alongside power-up drops, destroying a **small `Asteroid`** leaves a **mineral** — a small, stationary gold dot that persists until collected (the **Salvage** bounty's bonus drops are the one exception: they render **orange**, AH-0MVJ72I8O0009T09). Minerals are collected by flying the player ship over them, or absorbed by a **non-asteroid enemy** that overlaps them (asteroids are inert to minerals). Neither contact causes damage, and bullets pass straight through. The **E7 Harvester** (§4.1) is the one enemy that **actively seeks** the nearest live mineral rather than absorbing only what it happens to overlap; it steers toward it and absorbs it through the same shared rule, but it cannot take minerals from the player's hold.

- **Dropping**: each destroyed small asteroid drops one mineral; large/medium asteroids drop none (their small split children do). An enemy that absorbed minerals **re-drops its collected total plus a random additive bonus** (configurable `mineralRedropBonusMin`/`Max`, defaults 0.25/1.25), rounded to the nearest integer, as individual minerals scattered at its explosion site when destroyed. There is **no upper cap**, so a kill may return slightly more than the enemy absorbed. An enemy that absorbed nothing still draws the bonus and may occasionally drop a single mineral (when `round(bonus) = 1`). The rule is implemented **once** in the shared helper `src/scenes/core/mineralKillDrops.ts` (`resolveMineralKillDrops`, plus the shared scatter maths in `src/entities/Mineral.ts`) and consumed by **both** `PlayScene` and `GymFormationScene`, so the game and every formation gym (`GymMinerals`, the `GymFodderEnemies` asteroid row, …) drop identically and cannot drift apart. **Salvage bonus drops are orange** (AH-0MVJ72I8O0009T09): while the Salvage bounty window is active each destroyed enemy ship also scatters its level-resolved bonus minerals through the shared `scatterSalvageMineralDrops` seam, which renders them `MINERAL_SALVAGE_COLOR` (orange) instead of the gold `MINERAL_COLOR`. Every other mineral — asteroid drop, enemy re-drop, seeded gym field, collector-drone spill — stays gold, so the orange dots uniquely mean "Salvage bonus" and the baseline economy stays readable; the bonus is still worth one mineral per dot.
- **Asteroid Extra Life drop (AH-0MV6M2M9P0078N4S)**: a fully destroyed **small** asteroid additionally rolls an **Extra Life** with configurable probability `asteroidExtraLifeDropChance` (default **0.05**), persisted in the game-rules config (`src/core/rules.ts`, schema-optional key — older blobs load the default) and clamped to `[0, 1]`. This roll is **additive** to the generic per-kill drop pool (§4.4 — asteroids stay in the shared weighted pool and may still drop other power-ups/weapons) and to the mineral rule above; large/medium asteroids (which split) never roll it. The roll is implemented **once** in the shared helper `src/scenes/core/asteroidKillDrops.ts` (`rollAsteroidExtraLife`) and consumed by `PlayScene`, every asteroid-bearing formation gym (`GymMinerals`, the `GymFodderEnemies` asteroid row) and `GymLevel`, so the game and the gyms drop identically.
- **Collection**: the pickup/absorption pass (player collects, non-asteroid enemy absorbs, asteroids inert) is implemented **once** in `src/scenes/core/mineralLayer.ts` (`collectMinerals`) and called by `PlayScene` and `GymFormationScene`, so the two scenes can no longer run divergent collection loops. Between waves/levels and at boss entry `PlayScene` keeps running the shared scoop (`_applyMineralScoop`) and collection passes through the ~1.5 s transition pause, and bypasses the phase gate for that non-combat breather only, so an automatic defensive phase activation at wave-clear does not cost the player minerals already earned; normal wave play keeps the Q7 gate unchanged (AH-0MUX96GJF006CAZP).
- **Ship's hold**: collected minerals fill a run-scoped hold modelled by the shared **`MineralHold`** (`src/core/mineralHold.ts`). The **first** hold fills at **5** minerals (configurable) and each hold-full resolution **doubles** the next requirement — `capacity(n) = firstHoldCapacity × growthMultiplier^(n−1)` → **5, 10, 20, 40, …** — so early power-ups are earned quickly while later ones ramp up (growth is multiplicative, and unbounded by default). Pick-up amount defaults to **1**. `GameState` (game) and `GymFormationScene` (every formation gym) both hold this one model, so the gym adopts the game's **overflow-carry** semantics (resolving the hold restores `collected − capacity`, clamped to the new capacity, never 0 — the gym previously reset to 0) and the same progression. **On Continue** the checkpoint's hold capacity is restored **first** and the saved mineral count is then clamped into `[0, capacity]` with any recorded overflow cleared (`MineralHold.restore` via `GameState.restoreHold`, applied by `PlayScene._restoreCheckpoint()`), so a resumed hold is **never over-capacity**, the HUD bar never exceeds 100%, and the next hold-full choice arrives only once the **restored** hold has actually been filled — the saved surplus is never carried into the next hold. A legacy checkpoint that predates the persisted capacity resumes at the first-hold capacity (its over-capacity minerals are still clamped). The hold is shown on the HUD as a bar that fills proportionally to the **current** capacity (`src/ui/HUD.ts`), resets to the first-hold capacity on `GameState.startGame()`, and is never written to the leaderboard.
- **Hold full → power-up choice**: when the hold reaches capacity the game **pauses at the SceneManager level** and a modal overlay (`src/scenes/MineralChoiceScene.ts`) offers **three distinct** power-up options. The overlay knows nothing about its launcher: its only selection contract is an optional `onSelect(index, option)` callback, supplied by `PlayScene` and by every gym. The options come from a **pluggable strategy** (`src/powerups/choice.ts`); the default draws at **weighted random** without replacement from the full drop pool (**every power-up and every weapon drop — the whole catalogue minus the `reset` utility**; below the six-slot cap — see the six-slot gate below) and degrades gracefully when the pool has fewer than three entries, and the launcher always passes the exact options it will apply. Owned `weapon-level`/`power-up-level` offers carry a **1.35×** weight named `OWNED_UPGRADE_BONUS_WEIGHT`, while unowned base entries keep **1.0×**, so an owned upgrade is **35% more likely** to be drawn than an unowned item of the same pool size (AH-0MUY47W62005FF74; retuned 1.1×→1.25× and then 1.25×→1.35× by AH-0MVCFB00Y004AQ2Z); the weighting lives in the strategy layer only, never in `buildChoiceCandidates`, so the game and every gym share one implementation. When the player already owns weapons or power-ups, the pool is **extended with a permanent level-up offer for each** (`kind: 'weapon-level'` / `'power-up-level'`, e.g. "Spread Shot Lv.3") and the item's **base-pool entry is suppressed**, so each owned item is offered **exactly once** — as its correctly-labelled level-up — instead of as both a base and a levelled offer (AH-0MUVRACE9001WVT2, parents AH-0MUPMPCB2009J54J and AH-0MUV5CLVO002ZHS9); the offer label always names the level it grants. **Ownership and the offered level derive from the permanent level only** (AH-0MUX802450085VZZ): a field-only item is not owned for the choice, so it is still offered as a **★ New** base entry and never as a level-up — the choice never prices a temporary level that would vanish on expiry. Each option in the overlay additionally shows:
  - A **description** of what the item actually does, rendered in a **two-line description area** beneath the option name and resolved from the shared catalogue `description` via `getHelpDescription` (`src/utils/gymHelp.ts`) — the same copy the gym help overlay shows, so the overlay and the help cannot drift (AH-0MV2N2591007UGPD). The area word-wraps the copy onto up to **two lines** so even the longest catalogue entries (Teleport, 210 characters) stay inside the 960-pixel playfield, and copy needing more than two lines is ellipsised (AH-0MVBLBSG3002WHBI). The change summary / **★ New** line sits beneath it, so every option is a **three-part block** (name → two-line description area → detail). The catalogue wording is **level-neutral**, accurate for both a timed field pickup and a permanent hold-full reward (hard-coded temporary-duration clauses such as "for 10 s" were removed, while the per-level deltas stay in the change summary).
  - A **change summary** (e.g. "+1 Projectiles, +15% Bullet size") beneath the name for weapon-level offers, derived from the shared level maths in `weaponLevels.ts`; power-up-level offers derive theirs from the shared power-up resolver in `powerUpLevels.ts` (AH-0MUU1GOAU007RFVR, AH-0MUU2QJE2007JNR6). Only variables that actually change are listed.
  - A **★ New** badge (orange) for weapons **and power-ups** the player does not yet own, distinguishing them from upgrade offers (AH-0MUU1GOAU007RFVR, AH-0MUU2QJE2007JNR6). Ownership is only known when the launcher supplies `ChoiceContext.powerUpLevels`; when it is omitted, no badge is shown (backward compatible).
- **Six-slot gate at the choice (parent AH-0MVLIJT3M005HPHF, AC4)**: once all **six** slots are held — permanently **or** by an active field pickup (§4.4, "Loadout slots") — the choice offers **only items currently in the slots**: level-ups of permanently-owned items, a permanent pick for a kind held only temporarily, and entries flagged `availableWhenSlotsFull` (**Extra Life**, **Mystery UFO**), which never occupy a slot. A kind outside the slots is never offered, so a seventh kind can never be taken and the candidate list degrades gracefully instead of emptying. The gate lives once in `buildChoiceCandidates` (`src/powerups/choice.ts`); the mini-boss reward (§4.4.4) inherits it through the shared `buildOwnedLevelUpOptions` builder — no scene, gym or `unlocks.ts` re-derives it. Launchers supply `ChoiceContext.tempPowerUpIds` / `tempWeaponIds` from the run's temporary stacks so the gate sees the same state as the spawn draw and the collection gate. Below the cap the gate is inert, so the candidate list and its weights are unchanged.
- **Permanent pick**: the chosen option is applied to the player **permanently for the current run** via the shared `applyMineralChoiceReward` helper (also in `src/scenes/core/mineralLayer.ts`), so a choice grants the same effect in the game and in every gym — timed effects never expire and chosen weapons never time out (`EffectsRegistry.applyCollect(id, true)` / `applyWeapon(id, true)`, `Player.equipWeapon(id, true)`). A `weapon-level` option takes the same permanent `equipWeapon(id, true)` path, which raises the weapon's run-scoped level by one (parent AH-0MUPMPCB2009J54J §4.4.2); a `power-up-level` option takes the permanent `EffectsRegistry.applyCollect(id, true)` path, which raises the power-up's run-scoped level by one on the single player-owned store the registry consumes (parent AH-0MUV5CLVO002ZHS9 §4.4.3; single mutation point — AH-0MUV5CLW6005VF7K). Every launcher (`PlayScene`, `GymFormationScene` and `GymWeaponLeveling`) supplies `ChoiceContext.powerUpLevels` from the player's run-scoped power-up level store and `ChoiceContext.weaponLevels` from the weapon level state — both reporting **permanent** levels only (`PowerUpLevelStore.getLevels()` / `Player.getWeaponLevels()`), so a temporary field pickup never inflates an offer — and marks unowned base-pool power-ups as **★ New**. Permanence is scoped to the run and cleared on reset/restart.
- **Metronomic ghost fire while the overlay is open (AH-0MV0QPO4N009KWVT)**: opening the hold-full choice pauses the launcher at the SceneManager level, which freezes the shared beat clock and would otherwise cut the fire audio dead. Instead, the overlay keeps playing the player's **currently active** weapon fire cues on the same beat grid (§4.4 beat-aligned fire grid) at a reduced volume — **`HOLD_FULL_FIRE_VOLUME_SCALE` (0.3×)** — with **no projectiles and no gameplay simulation advanced**. No enemy or other gameplay cue plays during the overlay. A pure scheduler (`createHoldFullFireMetronome`, `src/scenes/core/holdFullFire.ts`) derives every ghost tick from `src/utils/beat.ts` grid maths (phase-locked to the tick the next real shot would have used), and the launcher captures the frozen schedule (`buildHoldFullFireSchedule` from `Player.getActiveWeapons()` / `getFireInterval`) into the overlay's `fireSchedule` payload. The same cue path (`playWeaponFireSound`) serves live fire and the ghosts, so the two cannot drift.
- **Beat-locked 3-2-1 countdown and resume (AH-0MV0QPO4N009KWVT)**: when the player selects an option the choice is **not applied instantly** — `MineralChoiceScene` plays a **3-2-1 countdown, one count per beat** (750 ms at the default 80 BPM, `createHoldFullCountdown` in `src/scenes/core/holdFullCountdown.ts`), each count showing a large on-screen numeral and playing the distinct countdown cue (`playCountdownTickSound`, baked `aihell-countdown-tick` ‑ see §7.3). The moment the choice is made the **choice screen is torn down** — the backdrop, the option rows and the heading disappear, leaving only the countdown numeral (AH-0MV722WJS0075UTZ). The tone **rises with each beat** (count 3 base, 2 a major third above, 1 a perfect fifth above — a C6→E6→G6 rise) by playing the single baked asset at a rising playback rate (`playCountdownTickSound(step)`, `countdownTickRate`, §7.3). The reduced-volume fire **continues underneath** the countdown and ends only when the overlay closes. On the beat after "1" (≈2.25 s after selection) the choice is applied and gameplay resumes via the same single `onSelect` contract; the launcher then **re-bases the frozen beat clock** across the whole overlay duration (`CombatCoreScene.rebaseBeatClockForHoldFullResume`) so the ship's real fire resumes **phase-locked on the same grid** — no phase jump or restart. The demo/attract auto-select drives the identical selection → countdown → resume path, so an attract-mode run never stalls and keeps its cadence (AC6).
- **Tunables** (`src/core/rules.ts`): `mineralCollectAmount` (default 1), `mineralHoldCapacity` (**first-hold** capacity, default 5), `mineralHoldGrowthMultiplier` (default 2), `mineralRedropBonusMin`/`Max` (additive re-drop bonus, defaults 0.25/1.25). Persisted rules are schema-versioned (v3); pre-v2 configs (which stored a *fixed* capacity) migrate to the new first-hold defaults, and pre-v3 configs reset the re-drop tunables to the additive defaults so stale fraction values are never carried forward.
- **Gym**: the asteroids-only `GymMinerals` gym (§6.4) demonstrates the whole loop; every formation gym also seeds 100 random minerals on create.

> **Hold-full rewards are functional in every gym (AH-0MUHMXWGC0058BO4):** The overlay renders **exactly** the option set the caller stored, so the label shown is the option applied — every launcher (`PlayScene` and each formation gym) passes its stored `options` plus an `onSelect` callback to the single `MineralChoiceScene` contract. In the asteroids-only `GymMinerals` — which has no field power-up drops — the Shield/Phase Shift/Teleport rewards granted by the hold-full choice behave as in the main game: **Teleport** is spent automatically (no key press) when the ship is in danger and consumes a stored use from its recharging pool (granting a 1.5 s Phase Shift on arrival and recovering on the level-derived recharge timer), **Shield** is honoured through the shared `CombatScene` hit-gating hooks (`isPlayerPhased()` / `tryAbsorbPlayerHit()`), and a permanent **Phase Shift** marks the pool permanently owned and adds exactly **one** charge — an empty pool blocks activation until a charge recharges, never an unlimited supply (AH-0MV82I7TX0009JMT). The effects registry ticks every frame (driving the HUD, including the finite Phase Shift/Teleport charge readouts and the recharge clock) independent of the opt-in drop layer so timed effects and recharges expire/advance normally. The teleport gate accepts a stored use (`canTeleport()` is true when `hasTeleport()`), while the opt-in drop layer still gates field-drop teleports elsewhere.

#### 4.4.2 Weapon Leveling (AH-0MUPMPCB2009J54J)

Weapons are **constantly upgradable**: every weapon carries a **run-scoped integer level** split into a **permanent** component and a **temporary** component (AH-0MUX802450085VZZ). A **field pickup** adds a temporary stack tied to the weapon's existing **10 s** timed window; a **permanent mineral-choice** `weapon`/`weapon-level` pick raises the permanent level for the rest of the run with no timeout. The **effective** level (`permanent + temporary`) drives the resolved definition, fire behaviour and HUD readout; when a field pickup's window expires the temporary component is removed and the effective level reverts to the permanent level (or the weapon becomes inactive when no permanent level was earned). The **hold-full choice prices the permanent level only** (§4.5), so a temporary pickup never inflates the offered level. Both components are unbounded and reset on run restart. The full catalogue lives in `src/utils/weaponLevels.ts`; the pure resolver is `resolveWeaponAtLevel(weaponId, level)`.

> **HUD presentation (AH-0MUX802450085VZZ).** The standalone HUD shows **one merged row per weapon** — never a separate permanent and temporary row. The label carries the **current effective level** (e.g. `Weapon: spread Lvl 3`) and the value is either a live `Ns` countdown while the field-pickup window is active or the infinity glyph `∞` when no temporary level-up is active (permanent-only). A field pickup on top of a permanent weapon therefore shows a single row whose value counts down and then reverts to `∞` when the window expires.

> **Temporary vs permanent field pickups (AH-0MUX802450085VZZ).** Worked example: pick up a weapon in the field → base level for 10 s; pick it up again before expiry → one level higher for 10 s (the window refreshes); the window expires → back to base (the field-only weapon becomes inactive). After a permanent hold-full pick, a later field pickup adds a temporary level on top of the permanent one and, on expiry, reverts to the permanent level (the weapon stays active). `Player` owns the single split (`_permanentWeaponGrants` / `_tempWeaponStacks`); `tickWeaponTimers` clears the temporary stacks when the window expires, and `resetWeapon` (the Reset drop) clears the timed activations and their temporary stacks while retaining permanent levels. `resetWeaponLevels()` clears both on run restart. `getWeaponLevels()` (used by the hold-full choice) reports permanent levels only, while `getWeaponLevel()` (HUD/def) reports the effective level.

**Diminishing-returns curve.** Every variable uses the same exponential-saturation curve, so a higher level is always at least as good, but each successive level adds less:

```
effective(level) = cap − (cap − base) × e^(−k × level)
```

- `base` is the un-upgraded (level 0) value; `effective(0) = base`.
- `cap` is a hard, finite ceiling the value approaches but never exceeds for continuous variables (discrete counts round and saturate exactly at the cap).
- `k` is the saturation rate; larger `k` reaches the cap sooner.
- Integer counts (projectiles, maxHitPoints, bounce, chain, split) are rounded to whole numbers and clamped to their cap.

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
| Max Hit Points (damage budget) | 0 | 5 | 0.25 | 1 | planned |
| Bounce (extra bounces) | 0 | 4 | 0.25 | 1 | planned |
| Homing (strength, 0–1) | 0 | 0.9 | 0.15 | ≈0.13 | planned |
| **Area** (AoE radius multiplier) | 1 | 2.5 | 0.18 | ≈1.25 | MVP |
| Status (chance, 0–1) | 0 | 0.6 | 0.12 | ≈0.07 | planned |
| Chain (extra jumps) | 0 | 4 | 0.22 | 1 | planned |
| Crit (chance, 0–1) | 0 | 0.5 | 0.12 | ≈0.06 | planned |
| Split (extra fragments) | 0 | 3 | 0.20 | 1 | planned |
| Knockback (force multiplier) | 1 | 3 | 0.18 | ≈1.33 | planned |

**Rationale for each cap/rate.** Fire rate is the most feel-sensitive variable, so a 3× ceiling keeps indefinite levels from trivialising bullet density while `k=0.18` front-loads the early gains. Extra projectiles multiply total damage, so the cap is deliberately small (8) and `k=0.22` lands the first extra bullet at level 1. Spread is a coverage/readability tool: 45° is the widest fan that still reads as aimed fire. Bullet size improves hit probability; 2.5× keeps bullets legible against the neon background. Bullet speed trades readability for reach (1.8× is the fastest still-trackable bullet), and range extends reach without filling the screen with wrapped bullets (2.2×, a slow `k=0.12`). Damage is the strongest scalar, so it saturates late and high (4×) — meaningful but never an instant win. The damage budget (`maxHitPoints`) and bounce are very strong in crowds, so both cap at 5/4 with `k=0.25` granting the first step at level 1 (the budget's weapon-level clamp is removed, so only the shared curve bounds it). Homing changes aiming feel (0.9 is strong but imperfect, a late-game payoff), while area-of-effect radius is the AOE family's identity (2.5× is a large but bounded blast). Status, crit and split stay bonuses rather than primary damage, so their ceilings are modest (60 % / 50 % / 3 extra fragments). Chain scales with enemy density (4 extra jumps), and knockback is a control tool (3× is enough to push enemies clear). Every rationale is kept beside its numbers in `WEAPON_UPGRADE_SPECS` (`rationale` field) so balance intent cannot drift from the values.

**Beat-grid invariant.** A fire-rate upgrade must not produce an off-grid interval: fire-rate levels map to the nearest valid beat subdivision so every shot stays on the shared 80 BPM grid (AH-0MUAYB8EH005RJ8B). Coverage: `src/utils/weaponLevels.test.ts` (monotonicity, caps, curve, catalogue completeness) and the fire-rate beat-grid work item.

**Level-change summary (AH-0MVL9P2SF009QFON).** Every offered level-up — in the hold-full choice §4.5 **and** the mini-boss reward §4.4.4 — carries a level-accurate `changeSummary` derived from `summariseWeaponLevelChange` / `summarisePowerUpLevelChange`, so the option text states the real delta between the current and the offered level (e.g. `+1 Projectiles, +17% Fire rate`). The summary lists implemented (MVP) variables only, and `aoeRadius` appears **only** for weapons that declare an `aoe` descriptor (Nova, Mortar, Arc) — a non-AoE weapon never promises an `Area` gain it cannot deliver. Both surfaces build their level-up options through the single shared `buildOwnedLevelUpOptions` path in `src/powerups/choice.ts`, so the copy can never drift between the game and the gyms (gym↔game parity).

#### 4.4.3 Power-Up Leveling (AH-0MUU2QJE2007JNR6)

Power-ups are **constantly upgradable**, exactly like weapons: every power-up carries a **run-scoped integer level** and each level changes a set of tunable variables. The full catalogue lives in `src/powerups/powerUpLevels.ts`; the pure resolver is `resolvePowerUpAtLevel(powerUpId, level)`, backed by the **same** exponential-saturation curve as weapons (extracted into `src/utils/curve.ts` so there is exactly one curve implementation).

- **Level acquisition (weapon parity).** Each power-up's level is split into a **permanent** component (hold-full rewards only) and a **temporary** component (field pickups). A **field pickup** adds one temporary stack to the item's effective level and (re)starts its timed window — **Shield** 15 s, **Speed Boost** 10 s, **Magnet/Mineral Scoop** 15 s; **Bomb/Phase Shift/Teleport/Extra Life have no timed window** (Resolved decision 4), so their temporary stacks persist until run reset. When a timed window expires the temporary component is cleared and the effective level reverts to the permanent level (or the item becomes inactive). A **hold-full permanent reward** increments the permanent grant with no timeout and does **not** touch the temporary stacks. The **first** grant unlocks the item at its base (existing) strength (`resolvePowerUpAtLevel(id, 0)`); each **further** grant applies the next upgrade. The **effective** level (`permanent + temporary`) drives the effect path and readouts; the **permanent** level alone drives the hold-full choice (§4.5), so a field-only item is still offered as **★ New**. Both components reset only on run restart. Unconsumed consumable grants (Phase Shift charges / teleports) **persist across a temporary-window expiry** and are never clawed back (producer Resolved decision 1b).
   - **Recharging charge pools (AH-0MV82I7TX0009JMT).** Phase Shift and Teleport are **finite recharging pools** rather than static counters. Each pool holds at most **3** charges (`POWER_UP_CHARGE_CAP`): a **field pickup** grants the level-derived count (Phase charges / Teleports, base 1 → cap 3), a **hold-full reward** grants exactly **one** charge (the permanent Phase Shift reward marks ownership — never an unlimited supply), and a completed recharge returns one charge; any grant/recharge that would exceed the cap is discarded. A **consumed** charge starts its **own per-charge recharge timer** whose duration is the **level-derived recharge time** at the moment of consumption (`phaseRechargeRate` / `teleportRechargeRate`, stored as charges/second and inverted to seconds: Phase Shift **30 s** base → **10 s** cap, Teleport **15 s** base → **5 s** cap — §4.4.3 table below). The shared per-frame `EffectsRegistry.tick(dt)` forwards `dt` to `PowerUpLevelStore.tickRecharge`, which advances every timer independently and returns a completed charge to its pool; an empty pool blocks activation until a charge recharges (HUD grey-out below).
   - **HUD presentation (AH-0MUX802450085VZZ; grey-out AH-0MV82I97Y007MB6M).** The HUD renders **one merged row per power-up/weapon** (never separate permanent and temporary rows). The label shows the item's **current effective level** (`permanent + temporary`, e.g. `Speed Boost Lvl 3`); consumable counts that the level does not convey (Shield remaining absorptions, Phase Shift charges, teleports) are appended as ` ×N`. The value column is either the infinity glyph `∞` (no temporary level-up window active — the level is permanent for the run, **not** an unlimited charge supply) or a live `Ns` countdown while a temporary window is active. A **charge-based** power-up the player **owns** but whose pool is currently **empty** stays visible as a **greyed-out row** (icon, label and value all painted with the one shared grey) instead of being hidden, so a recharging pool is always legible; a power-up the player has never owned is still hidden.
- **Curve family.** Most variables use the same exponential-saturation curve as §4.4.2: `effective(level) = cap − (cap − base) × e^(−k × level)` — monotonic non-decreasing, clamped to a finite cap; discrete counts round and saturate at the cap. **Additive-capped schedules use the `src/utils/curve.ts` linear/clamped curve instead** (`effective(level) = clamp(base + k × level, [min(base, cap), max(base, cap)])`): the Smart Bomb's pulse radius (**200 → 400 px**, +2 % of base per level) and its permanent pulse interval (**30 → 10 s**, −2 s per level, floor 10 s) both resolve through it — a fixed per-level step that flattens at the clamp rather than asymptotically.
- **Stack reconciliation (AC3).** Existing stack/charge semantics are derived from the level model rather than a second counter: Magnet/Mineral Scoop permanent stacks are `min(permanentGrants, levelCap)` with a cap of **5**; Teleport stored teleports and Phase Shift charges are level-derived grants **minus consumes plus completed recharges** in a run-scoped pool capped at **3**; Extra Life lives are `min(livesStart + Σ lifeGain(level), 5)`. The Magnet/Mineral Scoop **hybrid is preserved**: a field pickup levels the power-up up and refreshes the timed attraction, but does **not** create a permanent stack — only a hold-full reward does.
- **Wired into the effect path (AH-0MUV5CLW6005VF7K).** `EffectsRegistry` consumes the **single** run-scoped `PowerUpLevelStore` owned by `Player` — every scene injects that same instance (via a dynamic resolver, so a respawned player is picked up automatically), so there is no second, independently-incremented counter. `EffectsRegistry.applyCollect` is the single mutation point: it routes the collection to the store's **temporary stack** (field pickup) or **permanent grant** (hold-full reward), then resolves the effect strength from the catalogue — Shield/Speed Boost durations, the Speed Boost `speedMultiplier`, Phase Shift/Teleport durations, teleports, Phase Shift charges, Extra Life lives and the Magnet/Mineral Scoop stack caps all come from `resolvePowerUpAtLevel`/`store.stats()` rather than raw tuning constants. Spent Phase Shift/Teleport charges are recovered through the **shared recharge clock**: every scene that ticks the registry (`EffectsRegistry.tick(dt)`) forwards `dt` to `PowerUpLevelStore.tickRecharge`, so the game and every gym recharge identically (AH-0MV82I8IL0012RXY AC1/AC5). On a timed-window expiry the effect path calls `store.clearTemporary(id)`, which reverts the effective level without removing the permanent grant or any consumable already banked. The only non-levelled effect constants that remain are the **Magnet/Mineral Scoop field-pickup timed windows** (15 s): that window has no catalogue axis, so only the permanent stack cap (and hence attraction radius) levels. Game and every gym consume the same code, enforced by the duplicate-body guard.
- **Deterministic expiry tests (AH-0MV6T0HU0001IS71).** The scene-level P5/Speed Boost expiry tests (PlayScene: "P5 expired → multiplier back to 1" and "…fire-rate multiplier back to 1 (AC2)") derive their advance from the registry's **actual remaining timed window** (`EffectsRegistry.remaining`) plus a fixed safety margin, rather than a hard-coded tick count. The first-level resolved window is exactly 10 s, so a fixed 10.1 s advance left only ~0.1 s of margin and flaked under full-suite load; advancing to *just inside* the resolved window (asserting the effect is still active) and then *comfortably past* it (asserting expiry and the fallback to the un-boosted base) keeps the test deterministic regardless of catalogue tuning.
- **Shield/Bomb level axes wired (AH-0MUVM9RAO004Y3LB).** The catalogue expresses Shield multi-hit absorption (`shieldAbsorptions`, 1 → 3) and the redesigned Bomb ranged periodic bomb (`bombRange` px and `bombFrequency` pulses/s) in place of the superseded stored-charge axis. The effect path consumes them (Shield absorbs its level-resolved hits; Bomb clears a level-resolved radius, pulsing at a level-resolved rate when permanent), so the `power-up-level` change summary no longer excludes any axis (`DEFERRED_POWER_UP_LEVEL_VARIABLES` is now empty).
- **Mystery UFO level axes (AH-0MV1BIXFO006Z1I7 / AH-0MVBMPZ2C0008VAE / AH-0MV9G113S009B37I).** The Space Invaders-inspired Mystery UFO is a visible collector drone, so its axes are the drone's **lifetime** (`mysteryUfoLifetime`, 5 → 8 s), **capacity** (`mysteryUfoCapacity`, 10 → 20), **collector radius** (`mysteryUfoRadius`, 20 → 40 px) and **spawn interval** (`mysteryUfoSpawnInterval`, 30 → 12 s, descending; permanent reward only). The retired instant mineral/score axes are removed and there is no timed window or consumable state, so the axes are pure magnitudes consumed by the shared collector-drone pass.
- **Force Field level axes wired (AH-0MV1BIX1W006XF95).** The Gradius-inspired Force Field levels its **bubble window** (`forceFieldDuration`, 8 s → 18 s) and its **reflect budget** (`forceFieldReflects`, 3 → 10). Both are resolved from the catalogue and consumed by the shared reflect branch in `CombatScene._handleCollisions`: while the bubble is active an enemy bullet inside `EffectsRegistry.forceFieldRadius()` is consumed and re-spawned through `CombatCoreScene.spawnPlayerBullet` with its velocity reversed, until the budget is spent. The reflect branch lives once in the shared core (`CombatScene._reflectEnemyBullet`), so the game and every gym reflect identically (enforced by the duplicate-body guard and a parity test).
- **Thorn Field visibility + recharge (AH-0MVJ8YKR70096C6T).** The field is now visible and never inert: a lime spiked aura (`drawThornsAura` in `src/scenes/core/CombatEffectVisuals.ts`, shared by the game and every gym) reads the remaining ram budget, an absorbed ram fires a distinct lime spike-shatter burst plus cue (`src/vfx/thornsAbsorb.ts`), and a spent ram refills automatically on the level-resolved **Thorn recharge** interval (12 s → 5 s) — for the whole run on a hold-full field, and while its window is open on a field pickup. The aura is a **fixed-orientation, densely spiked** halo (it does not rotate; spike count rises with the remaining rams without growing the radius), per operator audit feedback. The HUD `Thorn Field` row shows the remaining rams and the `next in Ns` recharge countdown. Mechanics are otherwise unchanged: no passive contact damage, and ramming stays destroy-enemy-no-score.
- **Orbital Strike visibility + retained bolt (AH-0MVRE6N08001TE4V; docs AH-0MVS2T5N30031SL5).** The bolt now carries its own identity instead of the generic Smart Bomb ring: `spawnOrbitalStrike` (`src/vfx/orbitalStrike.ts`) draws a **descending bolt** — a tapered, glowing column that streaks down from above the top of the play area to the target's column, under a bracketed target reticle — ending in a white-hot **impact flash plus a brief outward shock ring**. The difference from the Smart Bomb pulse is **geometric, not chromatic**: `spawnNovaRing` emits concentric arcs that expand outward from the ship, whereas the bolt only ever draws within `ORBITAL_STRIKE_BOLT_WIDTH` (14 px) of the target's column and lasts `ORBITAL_STRIKE_DURATION` (0.32 s), so it can never wash the screen. The strike plays its own baked cue `playOrbitalStrikeSound` (`aihell-orbital-strike`, a 0.62 s two-act fall-then-impact) **at the bolt's impact** — the VFX module owns the cue, so no consumer can forget it and no scene can fork it. A bolt is **never spent silently**: the effects registry latches a decided bolt (`updateStrike`/`resolveStrike` in `src/powerups/effects.ts`) and the shared core (`CombatCoreScene._updateOrbitalStrike`) consumes it only once it actually lands, so a strike that resolves with no live enemy (or no live player) is **retained** and lands on the first frame with a valid target — at most **one** bolt is ever retained (the permanent interval clock freezes while a bolt is latched, so a long enemy-free gap cannot bank a volley). The bolt lands on the **nearest live enemy**, never on an **asteroid** (AH-0MVU3341U001B40T — producer rejection of AH-0MVRE6N08001TE4V: "we want it to fire on the nearest enemy"): asteroids are a non-blocking world hazard, so the shared target rule `selectOrbitalStrikeTarget` (`src/scenes/core/strikeTargeting.ts`) skips the `asteroid` archetype and a rock drifting closer than the nearest enemy can no longer absorb the bolt or waste the pickup. A **permanent** (hold-full) strike's cadence is a **whole-beat cadence on the shared 80 BPM grid** (`src/utils/beat.ts`), not a whole-second schedule: **9 beats = 6.75 s (≈7 s) on the first grant**, one beat (0.75 s) sooner per level, floored at **3 beats = 2.25 s** (AH-0MVRE6N08001TE4V — the earlier 30 s first-grant interval read as "doing nothing" in play). Expressing it in beats means every bolt lands on the same pulse the rest of the game's cues are quantised to, so the strike's 0.62 s impact cue reads as part of the mix rather than against it. A **permanent** (hold-full) strike's HUD row shows the `next in Ns` countdown to the next bolt (`EffectsRegistry.strikeNextBoltSeconds`; hidden, not stale, while a bolt is landing). Like Thorn Field, the identity layer is code-drawn Phaser Graphics plus the one cue — no textures, no new assets, no runtime dependencies — and lives once in the shared core, so `PlayScene` and every combat gym run the identical strike (gym↔game parity). Coverage: `src/vfx/orbitalStrike.test.ts`, `src/vfx/orbitalStrike.docs.test.ts`, `src/scenes/core/strikeTargeting.test.ts`, `src/scenes/core/orbitalStrikeRetention.test.ts` (including the end-to-end bolt-to-bolt cadence measured through the real shared step), `src/powerups/effects.test.ts`, `src/ui/HUD.test.ts` and `src/scenes/gym/GymPowerUpsCombat.test.ts`. The unrelated Missile-Command `orbital-strike` **hazard** (`src/entities/OrbitalStrike.ts`) is untouched — telegraphed marker, falling shell and radial detonation, with its borrowed `playScoutAdvanceCue`, are unchanged (non-regression only, parent AC7).
- **Every power-up levels (AC5).** Every power-up has at least one meaningful axis (no power-up is exempt). Bomb levels its **clear radius** and, when permanent, its **pulse rate**.

| Power-up | Level variables (base → cap, k) |
|----------|----------------------------------|
| **Shield** | Shield time (15 s → 30 s, k=0.12); Shield hits (1 → 3, k=0.5) |
| **Bomb** | Bomb range (120 px → 320 px, k=0.3); Bomb rate (0.33/s → 1/s, k=0.35) |
| **Speed Boost** | Speed boost (1.5× → 2.5×, k=0.2); Boost time (10 s → 20 s, k=0.12) |
| **Phase Shift** | Phase time (1.5 s → 3 s, k=0.2); Phase charges (1 → 3, k=0.5); Phase recharge (1/30 → 1/10 charges/s ≈ 30 s → 10 s, k=0.3) |
| **Teleport** | Teleports (1 → 3, k=0.5); Arrival phase (1.5 s → 3 s, k=0.2); Teleport recharge (1/15 → 1/5 charges/s ≈ 15 s → 5 s, k=0.3) |
| **Extra Life** | Lives (1 → 3, k=0.5); Life cap (5, flat) |
| **Magnet** | Magnet stacks (1 → 5, k=0.35) |
| **Mineral Scoop** | Scoop stacks (1 → 5, k=0.35) |
| **Smart Bomb** | Pulse radius (200 px → 400 px, +2 %/level); Pulse damage (1 → 3, k=0.3); Pulse interval (30 s → 10 s, −2 s/level, permanent only) |
| **Force Field** | Field time (8 s → 18 s, k=0.15); Field reflects (3 → 10, k=0.25) |
| **Mystery UFO** | Drone lifetime (5 s → 8 s, k=0.3); Drone capacity (10 → 20, k=0.3); Collector radius (20 px → 40 px, k=0.3); Spawn interval (30 s → 12 s, −2 s/level, permanent only) |
| **Frenzy** | Frenzy bonus (1 → 3 extra hits, k=0.5); Frenzy time (8 s → 16 s, k=0.12) |
| **Chrono Field** | Chrono slow (0.5 → 0.75 speed removed, k=0.25); Chrono time (5 s → 12 s, k=0.12) |
| **Thorn Field** | Thorn rams (2 → 6 absorbs, k=0.35); Thorn time (8 s → 16 s, k=0.12); Thorn recharge (12 s → 5 s, −1 s/level) |
| **Salvage** | Salvage minerals (1 → 4 bonus minerals, k=0.35); Salvage time (10 s → 20 s, k=0.12) |
| **Orbital Strike** | Strike interval (9 → 3 beats of the shared 80 BPM grid = 6.75 s → 2.25 s, −1 beat/level, permanent only; AH-0MVRE6N08001TE4V); Strike damage (1 → 3 HP, k=0.3) |

Every cap/rate is recorded with a written rationale beside it in `POWER_UP_LEVEL_SPECS` so balance intent cannot drift from the numbers. The **Smart Bomb** was re-balanced in AH-0MV8GPGBL009M0D8: its pulse radius (**200 → 400 px**) and permanent pulse interval (**30 → 10 s**) resolve through the **linear/clamped** curve family (damage per pulse is unchanged, 1 → 3 HP), so a permanent smart bomb is a rare, modest panic-button clear rather than a continuous screen wipe. **Status:** the **design + catalogue + pure resolver + integration contract** is shipped, the hold-full choice integration (the launcher supplies `ChoiceContext.powerUpLevels` and a chosen `power-up-level` offer is applied through the shared `applyMineralChoiceReward` path — parent AH-0MUV5CLVO002ZHS9) is shipped, and the resolver/store is **wired into `EffectsRegistry`** and the shared effect path in `PlayScene` and every gym (AH-0MUV5CLW6005VF7K). The Shield multi-hit absorption and the Bomb ranged periodic bomb are wired by **AH-0MUVM9RAO004Y3LB**; the **recharge-time axes** (Phase recharge / Teleport recharge), the **per-charge recharging pools** (cap 3, `PowerUpLevelStore.tickRecharge`, AH-0MV82I7TX0009JMT) and the **HUD grey-out for empty pools** (AH-0MV82I97Y007MB6M) are wired by AH-0MV82I7TX0009JMT / AH-0MV82I8IL0012RXY; and the **power-up leveling gym** **`GymPowerUpLeveling`** (`src/scenes/gym/GymPowerUpLeveling.ts`, key `GymPowerUpLeveling`, label `PowerUpLeveling` — the power-up counterpart of the weapon-leveling gym, AH-0MUV5CLVQ006V9HR) ships as the canonical place to observe the curve: a threat-free gallery where the operator collects each power-up repeatedly (field drops) and takes hold-full permanent rewards, with the shared HUD showing each owned power-up's effective level and a gym-local `.gym-panel` readout listing every levelled power-up's run-scoped level plus its resolver-derived stats. It reads levels and stats only through `PowerUpLevelStore` / `resolvePowerUpAtLevel` / the shared `EffectsRegistry` — no duplicated curve, catalogue or arithmetic — and is covered by its integration suite (`src/scenes/gym/GymPowerUpLeveling.test.ts`) and the game↔gym parity sweep in `src/scenes/core/powerUpLeveling.parity.test.ts` (see the README). Coverage: `src/powerups/powerUpLevels.test.ts`, `src/utils/curve.test.ts`, the power-up choice tests, `src/powerups/effects.test.ts`, `src/scenes/__tests__/PlayScene.powerUpLevels.test.ts`, `src/scenes/gym/GymPowerUpLeveling.test.ts`, `src/scenes/core/powerUpLeveling.parity.test.ts`, `src/scenes/core/CombatScene.equivalence.test.ts` and `src/entities/Player.test.ts`.

#### 4.4.4 Mini-Boss Reward — Upgrade or Unlock (AH-0MVCRBNO6003E1CH)

Defeating a mini-boss (§3.3) grants **exactly one** choice, offered through
the same launcher-agnostic `MineralChoiceScene` overlay as the hold-full
choice (same pause, countdown and `onSelect` contract):

- **Upgrade** — raise any **one** owned permanent weapon or power-up by one
  level (the ordinary `weapon-level`/`power-up-level` offers, applied through
  the permanent-level machinery, §4.4.2/§4.4.3); or
- **Unlock** — add **one** weapon from the initially-locked pool
  (`src/powerups/unlocks.ts`): at Level 1 exactly **8 of the 16** weapons are
  locked (the five net-new unlock-pool weapons plus Wave Laser, Cluster Missile
  and Arc), biased toward the newer and later-level picks. Unlocks obey the
  six-slot loadout cap (§4.4): at six held kinds only an unlock for a kind
  already in the slots is offered, so a reward can never add a seventh kind —
  and if the gated offer would be empty, the reward falls back to base picks of
  the held kinds rather than opening with nothing to choose.

The chosen option is applied immediately through the shared
`applyMineralChoiceReward` seam; an unlock is recorded in the run-scoped unlock
state (exposed via `PlayScene.getUnlockedWeapons()`), which the
**checkpoint** persists (§6.6) and the run keeps until it ends. Exactly one
option is consumed per mini-boss. The **upgrade** options carry the same
level-accurate `changeSummary` as the hold-full choice (§4.4.2) — built through
the single shared `buildOwnedLevelUpOptions` path — so the reward text states
what each owned weapon/power-up actually gains at the offered level and never
promises an unimplemented or inapplicable effect (AH-0MVL9P2SF009QFON).
Coverage: `src/powerups/unlocks.test.ts`
(the ~50 % locked-pool invariant, option builders, single consumption) and the
`PlayScene — mini-boss encounter` reward tests.

**The overlay waits for the defeat sweep (AH-0MVOFGB6K003YD0Z).** The reward is
offered when the encounter is *defeated*, and a defeat now plays the staggered
explosion sweep of §3.3.1 first: the overlay opens only once the last burst has
finished animating, because its `setPaused(true)` would freeze the burst tweens
mid-display. The `miniBossRewardOpen` latch still opens exactly **one** overlay
per defeat, and the level advances once **after** the sweep.

**Demo/attract auto-select (AH-0MVJ8U79V0056I2F).** In demo mode the reward is
not left waiting for a human: the launcher passes the same overlay
`autoSelectMs`/`autoSelectIndex` contract the hold-full choice uses
(§4.4.1), so the reward overlay auto-selects after `BOT_MINERAL_CHOICE_DELAY_MS`
(`src/ai/botHumanLike.ts`), runs the shared 3-2-1 countdown, applies the choice
through `selectMiniBossReward` and resumes play — the demo never stalls on the
reward screen. The pick is **random** among the offered upgrade-or-unlock
options, drawn from the run-seeded RNG (no `Math.random()`), so a given seed
reproduces the same reward. Normal play is unchanged: outside demo mode the
overlay waits for a real pointer/keyboard selection. There is no
mini-boss-specific overlay or resume path — the single tunable stays
`BOT_MINERAL_CHOICE_DELAY_MS`.

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

> **Boss phase scoring (AH-0MUTV3J7T006MZ4K, scaled by AH-0MUWTS07L008KVP9):** The four `Destroy Boss Phase N` values above are **unchanged**. Because each phase now takes **50 hits** (`BOSS_HIT_POINTS_PER_PHASE`), a phase's points are awarded on the **depleting hit** — hits **50, 100, 150 and 200** — not on every hit. A partial-phase hit awards no score, summons no minions and does not advance the phase; it only reduces the visible health-bar fill. This keeps fully levelled weapons from trivialising the encounter: the Central AI still requires **200 player hits** regardless of weapon level.

### 4.6 Level Progression Mechanics

- Every level spans **ten waves**; the 10th wave is that level's **mini-boss**.
  Clearing the mini-boss advances to the next level automatically (the level
  does not advance while the mini-boss is still alive — `WaveManager` gates the
  wave, and `PlayScene` gates on the spawned encounter entity). The mini-boss
  wave has no time limit. Clearing Level 10's mini-boss triggers the
  multi-phase final boss.
- **Difficulty rises on two axes.** Each level's waves hold more enemies —
  group counts × `enemyCountMultiplier(level)`, linear **1.00× at L1 → 2.00×
  at L10** (rounded half up, floor 1, cap 200, `single` groups stay at 1) —
  and each kill's power-up drop chance falls — `powerUpDropChance(level)`,
  linear **0.18 at L1 → 0.05 at L10** — with the asteroid Extra Life roll
  scaled by the same ratio. Both curves are pure, shared and data-driven
  (`src/core/levelScaling.ts`, values in `GameRules`); level 1 is the identity,
  so the opening calibration is unchanged. The scaling table, the documented
  formation-gym divergence and the same-seed before/after bot-batch evidence
  live in [`docs/BALANCING.md`](./BALANCING.md) (AH-0MVHT1M6O003PU7P).
- If the player runs out of lives (3 starting; up to 5 with Extra Life power-up), the game ends and the **final score** is submitted to the local leaderboard.
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
│                          interval (default 12.5 s) and per-ID drop weights (all power-ups)
│                          for the combat gyms; `POWER_UP_SPAWN_INTERVAL` re-sources
│                          from it in `../core/constants.ts`
├── scenes/
│   ├── core/
│   │   ├── CombatCoreScene.ts — Narrower shared combat/lifecycle base (implemented,
│   │   │                      AH-0MUDCT7EU0061OSZ): owns the shared player-control
│   │   │                      step (`_tickPlayer`: weapon timers → live Speed Boost
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
│   │                      methods (`_handleCollisions`, `_hitPlayer`, `_updateAutoDefence`/
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
│   │   │                      all power-ups + weapon drops), `advanceDropLifecycles` (grow → hold →
│   │   │                      shrink → despawn), `collectOverlappingDrops` (collect-gate: ≥ 3 %
│   │   │                      scale + hull-touches-bubble via `dropCollectRadius`),
│   │   │                      `applyDropMagnet` (Magnet range/speed) and `playDropPickupCue`
│   │   │                      (per-type Speed Boost/Extra Life/Magnet + weapon/Reset cue dispatcher with the generic
│   │   │                      chime fallback). `CombatCoreScene` wraps them as template methods
│   │   │                      (`_updateDropLayer`, `_advanceDropLifecycles`,
│   │   │                      `_collectOverlappingDrops`, `_applyDropMagnet`,
│   │   │                      `_buildDefaultDropSpawner`, `_playPickupCue`) consumed by
│   │   │                      `PlayScene` and every gym, so an enabled drop behaves identically
│   │   │                      everywhere. Only the spawn *source* (kill chance vs timer vs
│   │   │                      round-robin) stays per-scene (OQ6). Pinned by the repo-wide guard
│   │   │                      and the cross-scene equivalence tests in
│   │   │                      `CombatScene.equivalence.test.ts`.
│   │   ├── asteroidSplit.ts — Shared asteroid-split helper (implemented,
│   │   │                      AH-0MUII3F7Q002O7WX, gap 8): `splitAsteroid({ scene,
│   │   │                      parent, register })` spawns the two smaller children of
│   │   │                      a destroyed large/medium rock (position, velocity fan,
│   │   │                      rotation) and hands each to the caller's registration
│   │   │                      callback. Consumed by `PlayScene._splitAsteroid` and the
│   │   │                      `GymFodderEnemies`/`GymMinerals` destruction seams so the split
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
│   │                      Continue (checkpoint resume) → PlayScene, Settings → SettingsScene
│   │                      (audio + controls, origin MenuScene), Gym Scene Index (dev) → GymIndex;
│   │                      resumes Web Audio on click; FocusManager keyboard navigation
│   │                      (default focus on Continue when a checkpoint exists, else Play Game)
│   ├── PlayScene.ts     — Playable run (implemented): extends the shared `scenes/core/CombatScene`
│   │                      base (which extends `CombatCoreScene`; implementing its hooks for
│   │                      boss multi-hit, asteroid split (delegated to the shared
│   │                      `scenes/core/asteroidSplit.ts` helper),
│   │                      mineral absorption, wave accounting, lives/game-over and the Bomb
│   │                      ranged bomb pulse); WaveManager-driven levels 1–5 +
│   │                      Central AI boss, player/collisions/power-ups/HUD, transitions
│   │                      to GameOverScene on win or loss; **ESC pauses** the run and
│   │                      opens PauseScene (movement/pause keys are rebindable);
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
│       │                      and GymFodderEnemies/GymBoss supply only their entity-specific config.
│       ├── GymDiver.ts  — E2 Diver gym (key GymDiver, label "Diver")
│       ├── GymPhaser.ts — E4 Phaser gym (key GymPhaser, label "Phaser")
│       ├── GymMinerals.ts — asteroids-only mineral gym (key GymMinerals, label "Minerals"):
│       │                   small-asteroid mineral drops (via the shared
│       │                   `scenes/core/mineralKillDrops.ts` rule), the shared
│       │                   `scenes/core/mineralLayer.ts` collection/hold/choice layer,
│       │                   hold fill + HUD hold bar,
│       │                   enemy absorption/re-drop, hold-full choice overlay (100 seeded minerals);
│       │                   choice-granted Shield/Phase Shift/Teleport rewards are functional (automatic teleport,
│       │                   shared shield/phase hit-gating, registry ticks independent of drop layer)
│       ├── GymPlayer.ts — Player thruster-navigation/tuning gym (key GymPlayer, label "Player");
│       │                   extends the shared `scenes/core/CombatScene` (shared input,
│       │                   auto-fire and collision/hit pass) and adds a deterministic,
│       │                   indestructible obstacle course while keeping the ship-config panel
│       │                   (AH-0MUAYB2XR007N10W)
│       ├── GymPowerUpsUtility.ts — non-combat power-up gym (key GymPowerUpsUtility, label "PowerUpsUtility"):
│       │                  extends the narrower shared `scenes/core/CombatCoreScene`;
│       │                  round-robin Speed Boost/Extra Life/Magnet/Mineral Scoop spawning, a live mineral field,
│       │                  the shared Mineral Scoop mineral scoop, collection, standalone HUD
│       ├── GymPowerUpsCombat.ts — combat-coupled power-up gym (key GymPowerUpsCombat, label "PowerUpsCombat"):
│       │                  extends the shared `scenes/core/CombatScene` (hook-based shield/phase/bomb/invuln);
│       │                  round-robin Shield/Bomb/Phase Shift/Teleport with low-level scout threats; Shield, Bomb, Phase Shift Phase, Teleport (auto)
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
│   │                      Consumed by `PlayScene`, `GymFodderEnemies` and `GymPowerUpsCombat` so a
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
│   ├── teleport.ts      — Shared Teleport safe-spot resolver (implemented):
│   │                      findTeleportDestination reused by GymPowerUpsCombat and
│   │                      the combat base (ray + grid candidates, clamped to screen)
│   ├── types.ts         — Power-up catalogue (all power-ups; Shield 15 s, Bomb instant, Phase Shift charge-based 1.5 s auto/recharging pool, Teleport stored FIFO/recharging pool, Mineral Scoop timed 15 s / permanent stacks)
│   │                      with a one-line `description` per entry (gym help source of truth)
│   ├── choice.ts        — Pluggable hold-full choice strategy (default: 3 distinct weighted-random
│   │                      picks from every power-up and weapon drop except Reset; owned upgrades 1.35×; graceful degradation)
│   ├── effects.ts       — Active-effects registry (timers, lives, speed, magnet, scoop, shield absorb, Phase Shift phase auto-trigger charges + LevelStore-backed recharge clock, teleport stacks)
│   ├── powerUpLevels.ts — Run-scoped level model + per-charge recharging pools (Phase Shift/Teleport, cap 3) and recharge clock (tickRecharge)
│   ├── mineralScoop.ts  — Shared Mineral Scoop mineral attraction helper (applyMineralScoop: in-range
│   │                      live minerals pulled toward the player at MAGNET_ATTRACTION_SPEED)
│   └── icons.ts         — Code-drawn neon power-up icons (shield/bomb/phase/teleport/speed/life/magnet/scoop)
├── waves/
│   ├── WaveManager.ts   — Wave spawning and management
│   └── Formations.ts    — Formation movement patterns
├── ui/
│   ├── HUD.ts           — Standalone power-up HUD (implemented): Phaser Container attachable to any
│   │                      scene, renders above gameplay; one merged row per power-up/weapon (icon,
│   │                      label with the current effective level, value = ∞ or remaining-seconds
│   │                      timer; consumable counts as ×N; owned-but-empty charge pools greyed out) + lives counter
│   └── leaderboardView.ts — Shared leaderboard rendering (implemented): formatLeaderboardRow +
│                            renderLeaderboard, used by GameOverScene and LeaderboardScene
├── audio/
│   └── AudioManager.ts  — Sound effects (ToneForge baked-asset playback via src/audio/effects.ts)
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
                           mounted in GymFodderEnemies/GymBoss that applies the new cadence to the
                           running scene and persists it via the rules config (stable DOM id)
assets/
├── images/              — Neon vector graphics (placeholder_ prefix)
└── audio/               — ToneForge recipes/presets (rendered to public/audio/sfx/ by scripts/build-audio.sh; see §7.3)
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
| `ai_hell_settings` | `sfxVolume` (0.0–1.0), `sfxMuted` (SFX mute toggle), `bindings` (remappable key controls: movement, pause toggle), `shareTelemetryDev` (dev-build only), `controlScheme` (per-player ship control scheme: `asteroids` (default) or `fourDirectional`; a missing, non-string or out-of-union value falls back to `asteroids`; overrides the `ship-config.csv` `controlScheme` for the player and applies to the running game on resume from the in-game Settings and to every subsequent run — see §2.2). Edited in SettingsScene (reachable from the main menu and the pause menu); defaults restored via **Reset to defaults** |
| `ai_hell_checkpoint` | **Run checkpoint** (AH-0MVCRBTNF000DK51): auto-written after every mini-boss defeat. Stores the resume level (the level after the defeated mini-boss) and wave 1, plus lives, score, minerals, the **ship's hold capacity** the run had earned, permanent weapon/power-up levels, unlocked weapons and the run seed. The main menu shows **Continue — Level N** only when a usable checkpoint exists; resuming starts that level at wave 1 with the saved stats and RNG seed and **replays every stored permanent grant through the same shared grant seam live play uses** (AH-0MVSHI07B003BZIP), so the HUD upgrade list and the permanent effect state (shield armed with its absorption budget, permanent Bomb/Smart Bomb/Strike pulses, permanently-open Frenzy/Chrono/Force Field/Thorns windows, capped Phase Shift/Teleport charge pools, Magnet/Mineral Scoop stacks) match a live run that earned the same upgrades — the restored lives are never inflated by the Extra Life replay. Temporary field-pickup windows are intentionally **not** persisted and never re-open on resume. **The hold is restored through the shared hold model** (schema **v2**, AH-0MVT1DYO5004UC4P / AH-0MVT1DZRG000Q1US): Continue applies the persisted capacity first, then clamps the saved mineral count into `[0, capacity]` and clears overflow, so a resumed hold is never over-capacity and the next hold-full choice needs a real collection. A **legacy v1** payload has no capacity field and resumes at the first-hold capacity (its over-capacity minerals are still clamped); migration is decided by field presence, so the schema version itself is informational. **Play Game (New Game)** clears it. Corrupt/invalid payloads load as "no checkpoint" (defensive parse, same fallback discipline as the leaderboard) |
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
- **Player hull**: Neon outline only (no fill), circumradius = `shipSize / 2`, with small engine ports and a **scheme-dependent** silhouette (AH-0MV78PAX3002MO20). The **four-directional** scheme keeps the direction-neutral regular hexagon (flat top/bottom) whose 60° rotational symmetry never implies a heading — in a thrust-based scheme each axis is a valid forward, so thrust intent is read from the engine flames, not the silhouette. The default **Asteroids** scheme (which has a real facing) keeps the hexagon form but cuts a **concave** V-notch into its rear edge (opposite the nose) — the rear-edge midpoint inset ≈ 40% of the circumradius, a depth explicitly required by a producer re-audit (2× the originally shipped inset, AH-0MV78PAX3002MO20) — so the silhouette points along the direction of travel while turning and thrusting; the whole hull rotates with the facing, and the notch is an inward cut so the bounding circumradius (and `shipSize` semantics) is unchanged. Enemy ships keep directional silhouettes (chevrons/darts in §4.1) since they do fly with a heading.
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

  The three player-hit paths all route through the helper: `PlayScene._loseLife` (real run — `'fatal'` at 0 lives, `'respawn'` otherwise), the shared `CombatScene.applyPlayerHit` used by the formation gyms (`GymFodderEnemies` / `GymBoss` / `GymMinerals`), and `GymPowerUpsCombat` via the inherited hit lifecycle. The wave timeout no longer costs a life (AH-0MUNS3ZQ1002DJ9S), so there is no timeout life-penalty cue; shield absorption is unchanged in both the run and the combat gym.
- **End-of-run treatment (victory celebration & defeat signal)**: the two most consequential moments in a run are dressed by one shared module, `src/vfx/endOfRunJuice.ts`, so the win and the loss are instantly distinguishable. A pure `resolveEndOfRunJuiceParams('victory' | 'defeat')` mapping (no Phaser import) returns the complete, outcome-specific parameter set; unknown outcomes fall back to `'victory'` and never throw. Victory is bright and celebratory (cyan `ENDOFRUN_VICTORY_COLOR`, green `ENDOFRUN_VICTORY_GREEN`, sparkle `ENDOFRUN_VICTORY_SPARKLE`); defeat is sombre and desaturated (`ENDOFRUN_DEFEAT_COLOR` red, `ENDOFRUN_DEFEAT_RED` vignette, `ENDOFRUN_DEFEAT_GRAY` glitch). Three composition entry points consume it:
  1. **`spawnVictoryJuice(scene, options?)`** — layered celebration: a bright full-screen **flash/glow** (`ENDOFRUN_VICTORY_FLASH_ALPHA` 0.55, 320 ms), three staggered expanding **shockwave rings** (`ENDOFRUN_VICTORY_RING_COUNT` 3, radius 120 px, `ENDOFRUN_VICTORY_RING_STAGGER_MS` 180 ms), and a 140-piece multi-colour **confetti burst** (`ENDOFRUN_VICTORY_PARTICLE_COUNT`, 2200 ms lifespan, `ENDOFRUN_CONFETTI_TRAVEL` 260 px). A producer audit (2026-10-04) asked for a bigger celebration, so the flash/confetti were strengthened and the ring count raised.
  2. **`spawnDefeatScreenJuice(scene, options?)`** — layered defeat treatment: a red **edge vignette** (12 bands drawn inward from the screen edge, peak alpha 0.6, fades over 1500 ms), a slow dim red **ring** (radius 80 px), and a **desaturated grey glitch flicker** (5 flashes of 40 ms at alpha 0.15).
  3. **`spawnVictoryFireworks(scene, x, y, options?)`** — the sustained, boss-position-anchored explosion/firework display (added by AH-0MUWZ5HCV0034H44). A pure, seeded `planVictoryFireworks(originX, originY, options?)` planner decides the sequence: bursts are placed at uniformly-random positions within `ENDOFRUN_VICTORY_FIREWORKS_SPREAD_RADIUS` (240 px) of the anchor and scheduled at staggered `[ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MIN_MS, ENDOFRUN_VICTORY_FIREWORKS_INTERVAL_MAX_MS]` intervals (200–800 ms) for `ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS` (5000 ms in-run, 3–5 s as requested) or until `ENDOFRUN_VICTORY_FIREWORKS_MAX_BURSTS` (30) bursts cap the particle budget. Each burst cycles one of **five distinct firework types** — a radial particle **burst**, an expanding **ring**, an **implosion**-then-burst, a bright **sparkle** and a combined **starburst** (radial + ring) — mapped to the `spawnExplosionParticles` pattern sets (`ENDOFRUN_VICTORY_FIREWORK_PATTERNS`), rendering `ENDOFRUN_VICTORY_FIREWORKS_PARTICLE_COUNT` (32) particles at `ENDOFRUN_VICTORY_FIREWORKS_SCALE` (1.6×). A production audit (2026-10-06) asked for **more explosions**, **more explosive SFX** and **other juice**, so the sequence was lengthened to `ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS` (5000 ms), the burst cap raised to 30, two extra kinds added, and every burst now also spawns a soft expanding **glow pulse** (`spawnVictoryBurstGlow`, `ENDOFRUN_ENABLE_VICTORY_GLOW`, 72 px radius) and a fan of bright **spark shards** (`spawnVictorySparkShards`, `ENDOFRUN_ENABLE_VICTORY_SPARKS`, 6 per burst), while anchored radial **light rays** (`spawnVictoryRays`, `ENDOFRUN_ENABLE_VICTORY_RAYS`, 4 staggered sweeps of 14 rays) sweep out from the death point for the whole display. Each burst also schedules its matching explosion cue (§7.3, `playVictoryFireworkCue` → `playVictoryExplosionSound` / `playVictoryCrackSound` / `playVictoryPopSound` / `playVictorySparkleSound`, gated by `ENDOFRUN_ENABLE_VICTORY_FIREWORKS_SOUND`). The renderer dispatches each planned burst to `spawnExplosionParticles` with its planned tween `delay`, so the whole multi-burst display is scheduled up front with deterministic timing and no per-burst timers. The whole sequence is gated by the `ENDOFRUN_ENABLE_VICTORY_FIREWORKS` toggle and each extra layer by its own `ENDOFRUN_ENABLE_VICTORY_*` toggle.

  **Deployment and depth:** the in-run display is anchored at the boss's death position captured at destruction (`PlayScene._damageBoss` → `_triggerVictoryCelebration(x, y)`), and the sustained treatment re-renders on `GameOverScene` behind the score/initials/leaderboard UI. `PlayScene` holds the transition for `VICTORY_TRANSITION_HOLD_MS` (derived from `ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS`, 5 s) so the full explosion/firework sequence plays before the screen changes, and the ship **stops firing for that whole hold** (AH-0MVCB6LBE007I6R8) so the celebration is not competing with endless shots and shoot cues — the shared player step keeps the beat clock advancing, in-flight bullets finish their flight, and the fanfare/fireworks/transition timing are unchanged; the victory screen then continues for a shorter `ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS` (2000 ms, 1–2 s) in addition to its screen-centred confetti burst. The `GameOverScene` juice layers sit at **negative depth** (`ENDOFRUN_VICTORY_*_DEPTH` / `ENDOFRUN_DEFEAT_*_DEPTH`, −10…−7, `ENDOFRUN_VICTORY_FIREWORK_DEPTH` = −7) so they render above the background (which `GameOverScene` gives depth −100) and behind the default-depth-0 UI; in-run, `PlayScene` gives its backdrop depth −1000 and renders the fireworks at a positive HUD-relative `VICTORY_FIREWORK_DEPTH` (300, below the HUD's depth 1000). None of the layers is interactive, so the treatment can never occlude or intercept keyboard/pointer input. Every layer is individually switchable via an `ENDOFRUN_ENABLE_*` constant (victory flash/particles/ring/fireworks/glow/sparks/rays/fireworks-sound, defeat vignette/glitch/ring, sound), all counts/colours/durations are exported constants, and every display object is tracked in a caller-owned registry destroyed on scene `SHUTDOWN` (no leaks across restart). The defeat treatment layers on top of — and stays visually distinct from — the in-run fatal `spawnPlayerDeathJuice` (§7.2 player-death juice): it is screen-centred, red and desaturated rather than a cyan point-burst.

  **Gym-parity note:** `GameOverScene` is reached only from `PlayScene`; no gym scene has a run-end screen. The shared helper therefore lives once in `src/vfx/endOfRunJuice.ts` and is consumed by the game path (the in-run `PlayScene` flourish and the `GameOverScene` victory/defeat branches) — there is no gym run-end behaviour to change, so the gym↔game parity convention is satisfied by construction rather than by a scene-level copy. The same reasoning covers the run-end fire suppression (AH-0MVCB6LBE007I6R8): the shared hook lives once in `CombatCoreScene.playerFireSuppressed` and defaults to `false`, so `GymBoss` — which destroys its boss but has no run-end screen — keeps auto-firing after its boss dies. That divergence is deliberate and documented here rather than copied into the gym.
- **Phase Shift juice**: The automatic Phase Shift gets one shared, screen-wide treatment so the player can read the reactive activation (`src/vfx/phaseShiftJuice.ts`, advanced each frame by the shared `CombatCoreScene._updatePhaseShiftJuice` in `PlayScene`, `GymFormationScene` and `GymPowerUpsCombat`). The treatment is **edge-triggered**: on the frame `isPhased` rises it applies its layers, while `isPhased` stays true it sustains the shimmer, and on the falling edge it destroys every layer so no residual tint is left; the ship keeps its existing phase ghost (`applyPhaseGhost`, unchanged). It composes the layers below (AH-0MVD2MXAB004K0V4 upgraded the original two-layer version; the unmistakable upgrade AH-0MVNTXWJP004DBCW added tiers 4–5 and the camera-filter driver AH-0MVNTXV8P009B531):
  1. **Desaturation/dim** — a subtle dark-blue full-screen overlay (`PHASE_SHIFT_DIM_ALPHA` 0.22).
  2. **Vivid, pulsing chromatic split** — cyan (`PHASE_SHIFT_SPLIT_COLOR_CYAN` 0x33ffee) and red (`PHASE_SHIFT_SPLIT_COLOR_RED` 0xff3355) ADD overlays that fringe enemies, bullets and minerals alike. The producer chose to keep this identity and make it **more vivid rather than recolour it**, so the peak alpha is `PHASE_SHIFT_SPLIT_ALPHA` 0.45 (0.10 → 0.20 → 0.45) and the base offset is `PHASE_SHIFT_SPLIT_OFFSET` 14 px (3 → 6 → 14), breathing between ±`PHASE_SHIFT_OSCILLATION_AMPLITUDE` (1.5 px) once per `PHASE_SHIFT_OSCILLATION_PERIOD` (1.6 s).
  3. **Activation surge** — a short, sharp, *wider* chromatic-surge pair (`PHASE_SHIFT_BURST_ALPHA` 0.7 at ±`PHASE_SHIFT_BURST_OFFSET` 26 px, widened from 12 px) fires on the rising edge and fades out over `PHASE_SHIFT_BURST_DURATION_MS` (200 ms), so the automatic trigger visibly "fires" as a glitch hit.
  4. **Aggressive activation edge (aggressive, one frame)** — on the same frame as the surge: a full-screen **phase flash** (`PHASE_SHIFT_FLASH_COLOR` 0xa8f0ff, `PHASE_SHIFT_FLASH_ALPHA` 0.5, linear decay over `PHASE_SHIFT_FLASH_DURATION_MS` 180 ms, driven by deterministic dt ticks rather than a tween so headless tests stay deterministic), a cyan **edge/vignette band frame** (`PHASE_SHIFT_VIGNETTE_COLOR` 0x29d8ff, peak `PHASE_SHIFT_VIGNETTE_ALPHA` 0.55, `PHASE_SHIFT_VIGNETTE_BANDS` 6 bands of `PHASE_SHIFT_VIGNETTE_BAND_WIDTH` 14 px stroked inward from the screen edge, so the *frame* changes and not just the objects), and — on WebGL only — a **camera-filter distortion burst** (pixelate + barrel, `src/vfx/cameraFilters.ts`).
  5. **Soft sustained state (comfortable, whole phase duration)** — the split keeps breathing (offset oscillation, tier 2) with a gentle ≈`PHASE_SHIFT_FLICKER_HZ` 3 Hz alpha flicker (dipping `PHASE_SHIFT_FLICKER_DEPTH` 25 % at the trough — deliberately not a rapid strobe, for seizure safety) and a soft colour-pulse that cross-fades the two split hues over `PHASE_SHIFT_COLOUR_PULSE_RANGE` [0.75, 1]; the cyan vignette bands pulse gently between 0.9× and 1× their peak alpha; and the camera keeps a **gentle sustained barrel filter** (`PHASE_FILTER_SUSTAINED_BARREL_AMOUNT` 1.08, barely-there next to the 1.35 burst).

  Every layer sits at `PHASE_SHIFT_OVERLAY_DEPTH` (850 — above the world, below the death flash) with `setScrollFactor(0)`, and every magnitude is an exported tunable with its own toggle:

  | Layer | Real tunables | Toggle |
  |---|---|---|
  | Dim | `PHASE_SHIFT_DIM_COLOR` 0x0a1a33, `PHASE_SHIFT_DIM_ALPHA` 0.22 | `PHASE_SHIFT_ENABLE_DIM` |
  | Pulsing split (sustained) | `PHASE_SHIFT_SPLIT_COLOR_CYAN` 0x33ffee, `PHASE_SHIFT_SPLIT_COLOR_RED` 0xff3355, `PHASE_SHIFT_SPLIT_ALPHA` 0.45, `PHASE_SHIFT_SPLIT_OFFSET` 14 px, `PHASE_SHIFT_OSCILLATION_AMPLITUDE` ±1.5 px, `PHASE_SHIFT_OSCILLATION_PERIOD` 1.6 s, `PHASE_SHIFT_FLICKER_HZ` 3, `PHASE_SHIFT_FLICKER_DEPTH` 0.25, `PHASE_SHIFT_COLOUR_PULSE_RANGE` [0.75, 1] | `PHASE_SHIFT_ENABLE_SPLIT` + `PHASE_SHIFT_ENABLE_SHIMMER` |
  | Activation surge | `PHASE_SHIFT_BURST_ALPHA` 0.7, `PHASE_SHIFT_BURST_OFFSET` ±26 px, `PHASE_SHIFT_BURST_DURATION_MS` 200 | `PHASE_SHIFT_ENABLE_BURST` |
  | Phase flash | `PHASE_SHIFT_FLASH_COLOR` 0xa8f0ff, `PHASE_SHIFT_FLASH_ALPHA` 0.5, `PHASE_SHIFT_FLASH_DURATION_MS` 180 | `PHASE_SHIFT_ENABLE_FLASH` |
  | Vignette bands | `PHASE_SHIFT_VIGNETTE_COLOR` 0x29d8ff, `PHASE_SHIFT_VIGNETTE_ALPHA` 0.55, `PHASE_SHIFT_VIGNETTE_BANDS` 6, `PHASE_SHIFT_VIGNETTE_BAND_WIDTH` 14 px | `PHASE_SHIFT_ENABLE_VIGNETTE` |
  | Camera filters (WebGL only) | `PHASE_FILTER_BURST_DURATION_MS` 220, `PHASE_FILTER_BURST_PIXELATE_SIZE` 4 (Phaser adds 2 → 6 px blocks), `PHASE_FILTER_BURST_BARREL_AMOUNT` 1.35, `PHASE_FILTER_SUSTAINED_BARREL_AMOUNT` 1.08, `PHASE_FILTER_BARREL_NEUTRAL_AMOUNT` 1 (no distortion) | `PHASE_SHIFT_ENABLE_DISTORTION` + `PHASE_SHIFT_ENABLE_SUSTAINED_FILTER` |

  **Distinctness from player-death juice — there is deliberately no camera shake.** The first cut of this feature used a light shake, but a producer review rejected it because it made Phase Shift read like the player-death juice above; the producer re-confirmed the no-shake decision for the unmistakable upgrade (Q3), so the "punch" comes from the flash, the distortion burst and the wider surge only. The phase flash is a soft cyan (`PHASE_SHIFT_FLASH_COLOR` 0xa8f0ff), never the death flash colour (`PLAYER_DEATH_FLASH_COLOR` 0x00ffff), and the phase layer set never borrows the death shake/flash/debris/ring combination; the activation edge is capped at ~200 ms so it cannot be mistaken for a death sequence. A regression test asserts the treatment never calls `camera.shake`.

  **WebGL-only fallback.** The camera filters are the one non-overlay technique, and Phaser camera filters exist only on the WebGL renderer. `supportsCameraFilters(scene)` / `readCameraFilterList()` probe (`src/vfx/cameraFilters.ts`) require *all* of: a WebGL renderer (`scene.game.renderer.type === Phaser.WEBGL`), a main camera, a non-null `camera.filters.internal` with an array `list`, and the `remove`/`addPixelate`/`addBarrel` methods. On a canvas renderer, a stub scene, a headless unit-test scene or any partial object the probe answers `false` **without throwing**, the driver reports `supported: false`, and `applyBurst()` / `applySustained()` return `false` without allocating anything — the effect degrades to the **overlay-only** layers (dim, split, surge, flash, vignette) with no error storm. Teardown is exact: `clear()` removes and destroys only the controllers this driver created, so a pre-existing camera filter survives untouched, and the falling edge, a second expiry, a re-activation cycle and scene `SHUTDOWN` all leave no residual tint or filter controller.

  **Accessibility note.** Sustained flicker is **capped at 3 Hz** on every layer (player split `PHASE_SHIFT_FLICKER_HZ` 3, per-enemy shimmer `ENEMY_SHIMMER_FLICKER_HZ` 3, outline pulse 2 Hz) with a modest trough depth, so nothing strobes; the aggressive part is confined to the short activation edge. Every layer has its own `PHASE_SHIFT_ENABLE_*` toggle and the parameter model stays pure and unit-testable (no Phaser import) with the resolved values in `resolvePhaseShiftJuiceParams()`. A **reduce-motion player option is a separate, not-yet-built idea** — no in-game toggle exists today, and adding one remains its own work item rather than something this treatment silently implies.

  **Single shared step, teardown on both edges.** The treatment is consumed once: the shared step is the single advance point for the game and every gym, every overlay is tracked in the caller's registry and cleared on scene `SHUTDOWN`, and the full JSDoc for every tunable lives in the module beside the constants.
- **Wormhole emergence treatment (per-entity, no screen-space effects)**: enemies arriving through a wave's wormhole get their own emergence read, and the producer explicitly chose **no screen-wide effect** for that path (AH-0MV8BUKFK003Z23S Q2). Both layers live once in the shared spawn module `src/vfx/wormholeSpawn.ts` and are consumed by `PlayScene`, `GymFormationScene` and `GymLevel` through the one shared spawn-update step `updateSpawnEmergence` (growth → shimmer in a single call), so the game and the gyms cannot diverge:
  1. **Per-enemy shimmer/glitch** (`updateEnemyShimmer`, driven from the spawn-state window): a brief **ripple burst** as the enemy starts to materialise — extra scale `ENEMY_SHIMMER_BURST_SCALE_BOOST` 0.18 and a *toward-opaque* extra alpha `ENEMY_SHIMMER_BURST_ALPHA_BOOST` 0.45, both decaying over `ENEMY_SHIMMER_BURST_DURATION_MS` (240 ms) — then a **continuous shimmer** for the rest of the growth window: alpha flickering between `ENEMY_SHIMMER_ALPHA_MIN` 0.25 and `ENEMY_SHIMMER_ALPHA_MAX` 1 at `ENEMY_SHIMMER_FLICKER_HZ` 3 Hz, a tiny scale pulse (`ENEMY_SHIMMER_SCALE_AMOUNT` 0.04, layered on the growth scale so it never fights it) and a soft colour-pulse at `ENEMY_SHIMMER_COLOUR_PULSE_PERIOD` (1.6 s). Because Phaser 4 `Container`/`Graphics` expose no tint component, that colour pulse is expressed as a soft **additive bloom** (the entity renders with `BlendModes.ADD` through the upper half of the pulse); the pulse range is `ENEMY_SHIMMER_COLOUR_PULSE_RANGE` [0.25, 0.75]. A pulsing stroke **outline silhouette** is parented to each emerging entity so it reads as "not solid yet" for the whole growth window: `ENEMY_SHIMMER_OUTLINE_RADIUS` 30 px, `ENEMY_SHIMMER_OUTLINE_LINE_WIDTH` 4 px, violet-white `ENEMY_SHIMMER_OUTLINE_COLOR` 0xd9b3ff, breathing at `ENEMY_SHIMMER_OUTLINE_PULSE_HZ` 2 Hz between `ENEMY_SHIMMER_OUTLINE_ALPHA_MIN` 0.45 and `ENEMY_SHIMMER_OUTLINE_ALPHA_MAX` 0.95 (marked by `ENEMY_SHIMMER_OUTLINE_DATA_KEY`). Layers are toggled by `ENEMY_SHIMMER_ENABLE_BURST` / `ENEMY_SHIMMER_ENABLE_SHIMMER` / `ENEMY_SHIMMER_ENABLE_COLOUR_PULSE` / `ENEMY_SHIMMER_ENABLE_OUTLINE`. When the growth window ends the helper **releases** the entity — its own alpha and blend mode are restored, the outline is destroyed and the clock is dropped — so a fully-emerged enemy carries no residual tint or duplicate outline. The player ship is never touched (its ghost alpha stays owned by `applyPhaseGhost`). All of it is per-entity: there is no screen-wide overlay on the emergence path.
  2. **Wormhole glow/pulse ring and open shockwave** (`spawnWormholeOpen`): while a wormhole is open for a wave it carries a bright pulsing ring (`WORMHOLE_RING_COLOR` 0xd9b3ff, `WORMHOLE_RING_RADIUS` 80 px, stroke `WORMHOLE_RING_LINE_WIDTH` 6 px) at `WORMHOLE_RING_GLOW_ALPHA` 0.8, with a soft halo pass (3× stroke width at 35 % of the glow alpha) and a yoyo scale pulse between `WORMHOLE_RING_PULSE_RANGE` [0.9, 1.15] every `WORMHOLE_RING_PULSE_DURATION_MS` (900 ms per direction). On open it also fires a **one-shot expanding shockwave** — `WORMHOLE_SHOCKWAVE_COLOR` 0xd9b3ff, base radius `WORMHOLE_SHOCKWAVE_RADIUS` 64 px, stroke `WORMHOLE_SHOCKWAVE_LINE_WIDTH` 6 px, starting alpha `WORMHOLE_SHOCKWAVE_ALPHA` 0.9, tweening from `WORMHOLE_SHOCKWAVE_SCALE_RANGE` [0.35, 1.6] and fading to 0 over `WORMHOLE_SHOCKWAVE_DURATION_MS` (400 ms) with `repeat: 0` (marked by `WORMHOLE_SHOCKWAVE_DATA_KEY`). Both are gated (`WORMHOLE_RING_ENABLE`, `WORMHOLE_SHOCKWAVE_ENABLE`) and drawn **once per wormhole** as children of the wormhole container (pure Graphics, no new assets), so they are tracked by the caller's existing `wormholeEffects` registry for free and destroyed with the container when the close tween completes — the ring's looping pulse and the shockwave's tween are stopped first so no tween is left targeting a dead object, and a second close is a full no-op. The violet-white ring/shockwave palette is deliberately distinct from both the phase-shift cyan/red split and the player-death palette.

  The emergence treatment is purely cosmetic (gameplay, hitboxes and spawn protection are unchanged) and allocates nothing per frame beyond the one per-enemy clock created on the first shimmering frame.

### 7.3 Audio Direction (MVP: In Scope — Simple SFX)

**Approach**: All one-shot sound effects are **build-time baked WAV assets rendered by ToneForge** and played through Phaser's shared `AudioContext` (parent epic *Switch game audio from procedural Web Audio to ToneForge*, AH-0MUTUOB7X007PR9J). Each cue is authored as a data-only ToneForge recipe/preset under `audio/toneforge/`, rendered **deterministically** (a reserved seed per cue) by `scripts/build-audio.sh` into `public/audio/sfx/`, and verified by the SHA-256 checksums committed alongside the assets. The **authoritative cue→recipe catalogue** is [Audio cue-to-recipe mapping](AUDIO_TONEFORGE_CUE_MAPPING.md); the runtime is a thin manifest-driven playback layer in `src/audio/effects.ts`.

The former procedural Web Audio synthesis has been **removed**. The **one** runtime-synthesised exception is the continuous, thrust-coupled **thruster hum** (`src/audio/thrusterShim.ts`), which a baked one-shot cannot reproduce; every other cue is a baked asset. Cues that used per-invocation pitch jitter are baked as a small **multi-seed variant range** (see *Destruction Variation* below). The audible character is unchanged — each recipe reproduces the documented character and is auditioned during authoring (Author game-specific ToneForge recipes, AH-0MUTYV8480019Z51). ToneForge is consumed reproducibly at build time only (pinned revision in `audio/toneforge/pin.json`); the browser bundle imports no ToneForge or Node-only code (`npm run check-bundle`).

#### SFX Event Catalog

| Category | Event | Sound Character | Volume | Lead Time |
|----------|-------|-----------------|--------|-----------|
| **Interactions** | Power-up pickup | Short percussive pop + "sucked into ship" absorb VFX | Medium | Immediate |
| **Interactions** | Teleport activate (automatic) | Short whoosh + portal effect | Medium | Immediate |
| **Interactions** | Phase Shift activates (automatic) | Rising sci-fi chirp + noise whoosh (`playPhaseShiftSound()`: triangle sweep 320 → 1560 Hz over ~0.28 s + bandpass noise sweep 600 → 3200 Hz) | Medium | Immediate |
| **Impacts** | Player hit (life lost) | Low, heavy layered "hull breach" boom (`playPlayerDestructionSound()`: impact thump + descending body + shrapnel hiss); replaces the generic enemy cue on the player-death paths | High | Next 16th note (accent) |
| **Impacts** | Enemy destroyed | Sharp pop / crack (`playDestructionSound()` / `playDiverDestructionSound()`) | Medium | Next 16th note (accent) |
| **Impacts** | Wave timeout — survivors carry over (no detonation) | No cue: survivors persist into the next wave as active threats (AH-0MUNS3ZQ1002DJ9S). `playMajorExplosionSound()` is retained but unused by the timeout path | — | — |
| **Impacts** | Boss phase damage | Deeper zap, slightly longer decay | High | Immediate |
| **Impacts** | Player bullet hits enemy | Very short tick | Low | Immediate |
| **Impacts** | Player bullet destroys enemy bullet | Dedicated high, very short tick (`playBulletDestructionSound()`; distinct from the heavier enemy-destruction fall) + small impact flash | Low | Immediate |
| **Enemy actions** | Enemy spawn | Subtle hum rise | Low | Immediate |
| **Enemy actions** | Enemy fire (Level 4+) | Short zap; the per-enemy Tank/Scout fire sequences (heavy cannon thump / sharp laser blip *and* their advance whine/blip warmups) play at **half volume** (`TANK_SCOUT_FIRE_VOLUME_SCALE` 0.5, AH-0MV74ROYR009X8U3) | Low-medium | Immediate |
| **Enemy actions** | Dive bomb attack | Descending tone | Medium | ≥ 500 ms advance |
| **Run flow** | Victory (boss defeated) | Bright **two-phrase** major fanfare: rising arpeggio (C5 → E5 → G5 → C6) then a faster rising cadence (C6 → E6 → G6 → C7) resolving into a sustained major chord over a C4/G4 bass bed, with a high sparkle flourish and a soft high-pass shimmer crackle tail (`playVictoryFanfareSound()`), ~3.3 s | Medium | Immediate |
| **Run flow** | Defeat (run lost) | Slow **five-note** descending sombre line (G4 → F4 → D4 → B3 → G3) over a sinking 98 Hz drone with a dark low-pass rumble tail (`playDefeatStingSound()`), distinct from the player-destruction cue, ~2.9 s | Medium | Immediate |

#### Beat-synced explosion accents (AH-0MV01HNLU008S5E3)

The non-weapon destruction booms — `playDestructionSound` (enemy/asteroid),
`playDiverDestructionSound` and `playPlayerDestructionSound` — are scheduled
onto the **next 16th note** of the current tempo (`beatPeriodMs(bpm) / 4`,
187.5 ms at the default 80 BPM) rather than firing on the exact kill frame, so
kills land as a rhythmic accent against the silent player-fire grid (§4).
Several cues inside one 16th-note window stack onto the same tick, capped at
`EXPLOSION_PER_TICK_CAP` (4) per tick so a mass kill cannot clip the mix. The
delay is the **game-time** distance to the tick (`nextTick(now) − now`), never
a wall-clock read, so a paused scene whose beat clock does not advance never
queues audio into the future. Only the **cue** is deferred — particle bursts,
AOE detonation graphics and camera juice still spawn on the death frame
(audio only). Weapon cues (Mortar detonation; Nova/Mortar/Arc fire) and the
bullet-interception cue stay immediate because weapon fire already lands on
exact beat subdivisions. The quantisation is implemented once in the shared
audio seam (`setExplosionBeatClock`, `src/audio/effects.ts`) and registered by
the shared combat core (`CombatCoreScene.resetRunState`), so the game and every
gym behave identically. Coverage: `src/utils/beat.test.ts`,
`src/audio/effects.test.ts`, the `PlayScene` beat-accent integration test and
the gym↔game equivalence suite.

#### Destruction Variation (baked scale-degree variants)

Destruction sweeps are intentionally non-identical between kills. The original per-invocation pitch jitter (a single ±15 % factor applied to all endpoints) is now **approximated at build time as A-minor scale-degree variants**: `aihell-enemy-destruction` is baked as a **3-seed variant range** (32113 / 32128 / 32144 — starts A3/A4/E5, each descending to A1) and `aihell-diver-destruction` as 32173 / 32176 / 32197 (starts E3/B3/E4, each descending to E2) under the enemy-balance epic (AH-0MVAUU594007S92Q, AC3), and one variant is chosen at random per play in `src/audio/effects.ts`. The descending character and tonal relationships are preserved, every variant sits on a note of the battle-scenes' provisional **A natural minor** scale (equal temperament, A4 = 440 Hz), and every variant is seed-deterministic. Audio remains outside the deterministic VFX seed contract, so the runtime variant choice uses `Math.random()`. The retired `playTankDestructionSound()` cue and the runtime `EXPLOSION_PITCH_JITTER` / `explosionPitchFactor()` helpers no longer exist (see the [cue mapping](AUDIO_TONEFORGE_CUE_MAPPING.md)).

All **enemy** SFX (spawn, advance, fire, destruction, boss cues) are pitched onto the battle-scenes'
A natural minor scale and gain-staged onto category-relative amplitude tiers (ambience ≤ 0.02,
subtle one-shots 0.055, heavy one-shots 0.090 RMS, every peak ≤ 0.50) — see [Enemy audio balance](AUDIO_ENEMY_BALANCE.md) and the [cue mapping](AUDIO_TONEFORGE_CUE_MAPPING.md); the balance guard
(`scripts/audio-balance-guard.mjs`) asserts both invariants in `npm run build-audio:verify`
(balance epic AH-0MVAUU594007S92Q).

#### Per-Enemy Audio Character

Audio-character decisions for individual enemies are made **per-enemy at
implementation time** and may deliberately deviate from the generic catalog
entries above — the catalog defines the default character, not a straitjacket.
Example: the E1 Scout (gym scene `GymScout`) uses a rising sine-wave advance
cue flowing with **no gap** into a sharp square-wave shot blip, with the fire
sound scheduled at the cue's end; the E3 Tank (gym scene `GymTank`) uses a
rising mechanical-whine advance cue flowing with **no gap** into a heavy low
cannon thump, one cue+thump pair per radial burst, instead of the generic
"short zap". The E3 Tank and E1 Scout **fire sequences** (advance whine/blip
and shot) play at **half volume** (`TANK_SCOUT_FIRE_VOLUME_SCALE` 0.5) so
enemy fire reads clearly without dominating the mix (AH-0MV74ROYR009X8U3);
the producer confirmed the advance (warmup) cues are part of that
reduction. See `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` for the per-enemy
audio decisions and the implementation best practices (which audio is owned
by the base scene, where entity-specific sounds are orchestrated, and the
no-gap pattern).

#### Player Audio Character

The player ship has its own ToneForge-rendered audio palette (all played via
`src/audio/effects.ts`), giving the player the same by-ear feedback the
enemies get:

> The `Recipe character` column documents the audibly-reproduced character of
each baked recipe (the wave family, frequency contour and duration the recipe
targets); it is no longer synthesised at runtime. Amplitude is baked into the
asset and the master SFX gain applies on top.

| Cue | Sound Character | Recipe character (wave, contour) | Volume |
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
| Speed Boost pickup | Bright ascending zip | Square 600 → 1800 Hz | 0.13 |
| Extra Life pickup | Warm two-note chime | Sine 440 → 880 then 660 → 990 Hz | 0.13 |
| Magnet pickup | Low pulsing field hum | Square 180 → 90 → 180 Hz + sine undertone | ≤ 0.12 |
| Thruster hum (held thrust) | Continuous jet-engine roar pulsed on the cannon grid | Triangle 60 Hz + sine 35 Hz rumble + band-pass filtered white noise (700–1100 Hz) whoosh, thrust-scaled (≤ 0.05) with an amplitude tremolo + counter-phase filter sweep on the shared beat clock's cannon cadence (2 subdivisions/beat, 375 ms at 80 BPM); **side-thruster profile** (turn/strafe) is half the forward gain and shifts both pitched oscillators up one semitone | ≤ 0.05 |
| Player death (hull breach) | Heavy layered boom — deep impact thump + slow descending body + brief shrapnel hiss | Sawtooth 120 → 32 Hz (~0.4 s) + triangle 260 → 42 Hz (~0.6 s) + high-pass filtered noise tail (~0.28 s) | ≤ 0.2 |
| End-of-run victory fanfare | Bright celebratory fanfare — rising major arpeggio into a sustained major chord plus a light sparkle tail | Triangle arpeggio C5 → E5 → G5 → C6 (0.16 s apart, 0.12 peak) + sine chord C6/E6/G6 (~0.9 s, 0.09) + sine sparkles 2093–3520 Hz (0.06), ~1.5–2.5 s | ≤ 0.2 |
| End-of-run defeat sting | Slow, sombre descending sting — a mournful minor fall over a low drone with a dark rumble wash | Triangle G4 → F4 → D4 → A3 (0.24 s apart, 0.13) + sine drone 98 Hz (~1.1 s, 0.09) + low-pass filtered noise tail (320 Hz, ~0.6 s, 0.07) | ≤ 0.2 |
| Volume-change feedback (Settings) | Player-explosion cue at the selected volume (pitch unchanged) | Same as player death — sawtooth 120 → 32 Hz + triangle 260 → 42 Hz + filtered noise tail; gain × volume | ≤ 0.2 |
| Countdown tick (hold-full restart) | Bright two-note blip, one per countdown beat, **rising with each beat** — the single baked asset (`aihell-countdown-tick`, seed 32264) is played at a rising playback rate so count 3 is base, 2 a major third up, 1 a perfect fifth up (C6→E6→G6) | Square 1046 (C6) → 784 (G5) Hz (exponential drop), ~0.12 s, × rate 1.0 / 1.26 / 1.50 | 0.15 |
| Hold-full metronomic ghost fire | The player's currently active weapon fire cues replayed on the same beat grid at a reduced volume while the choice overlay is open (no bullets) | Reuses the player-weapon fire recipes (§7.3) | ×0.3 of normal (`HOLD_FULL_FIRE_VOLUME_SCALE`) |

- **Thruster hum** — single ship-level continuous jet-engine roar (NOT per-engine flame port), synthesised as a soft triangle fundamental (60 Hz) with a sine undertone (35 Hz) for low rumble plus white noise through a band-pass filter (700–1100 Hz, Q 0.6–1.1) for jet-engine whoosh; filtered noise is the dominant texture, all through one reused gain node; gain follows `getEngineSoundLevel` level `min(1, thrustAcceleration / FLAME_REF_THRUST)` (GDD §2.2 `ShipConfig`), so the tuning slider is audible (half thrust → ~0.5 level). Contour: smooth fade-in ramping over `THRUSTER_HUM_GROWTH_TIME` (30 ms at reference thrust) and ~4× quicker decay when thrust stops (mirrors the flame growth/shrink timing), with no clicks on retrigger; volume ≤ 0.05 (reduced from 0.075 so the hum sits behind the mix and never dominates it, within the "≤ 0.2" ceiling for all player cues — AH-0MV01G4NL009JK92). **Beat-locked pulse**: while thrusting the hum is phase-locked to the shared beat clock (the same silent 80 BPM grid that drives player fire, §4) and modulated on the **cannon cadence** (`THRUSTER_HUM_CANNON_SUBDIVISIONS` 2 subdivisions/beat → 375 ms at the default tempo): an **amplitude tremolo** (`THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH` 0.35) makes the loudness pulse the primary "beat", and the band-pass centre **sweeps in counter-phase** between the 700–1100 Hz bounds on the same grid, adding movement without harshness. The modulation is derived from the clock's **game time** (never a hard-coded wall-clock interval), so it pauses with the game and follows the configurable `beatBpm`, and the game and every gym sound identical (the clock is registered/detached by the shared `CombatCoreScene` alongside the explosion-accent seam). With no clock registered, no `AudioContext`, or in a headless test the hum degrades to the plain level-scaled voice and every entry point is a safe no-op. Driven per-frame by `Player.preUpdate` → `getEngineSoundLevel(state, input, thrustAcceleration)` → `updateThrusterSound(level)` for both `fourDirectional` (any arrow/WASD) and `asteroids` (forward/turn) schemes; stops on release, respawn, player destroy, or scene shutdown so no audio nodes leak. **Side-thruster profile**: when any side engine fires — Asteroids turn (`leftSide`/`rightSide`) or fourDirectional lateral strafe (`left`/`right`) — the hum switches to a **quieter, one-semitone-higher** variant so manoeuvring is legible by ear without dominating the mix: the gain target is multiplied by `THRUSTER_HUM_SIDE_VOLUME_SCALE` (0.5, i.e. 50% of the forward profile) and **both** pitched oscillators (triangle fundamental and sine undertone) are shifted up one equal-tempered semitone (`THRUSTER_HUM_SIDE_PITCH_SCALE` = 2^(1/12) ≈ 1.0595), composed with the existing thrust-dependent `pitchScale`; the band-pass noise filter is identical to the forward profile. Arbitration is **side-wins**: a side engine firing alongside a forward/main engine selects the side profile (one voice cannot blend). The classification is implemented **once** in shared code (`src/utils/thrusterProfile.ts`, `getThrusterProfile`) and derived from the firing-engine list already computed in `Player.preUpdate`, so the game and every gym agree (gym↔game parity, AH-0MV78QUIX001EZN2). The nose retro-thruster and fourDirectional vertical thrust use the default (forward) profile.
- **Player destruction** — the dedicated `playPlayerDestructionSound()` in `src/audio/effects.ts` is a heavier, layered cue distinct from the generic enemy `playDestructionSound()` (440 → 60 Hz sawtooth): a sawtooth impact thump (120 → 32 Hz, ~0.4 s) plus a slower triangle body sliding 260 → 42 Hz (~0.6 s) and a short high-pass filtered noise tail (~0.28 s) for the shrapnel hiss. It is played **exactly once** per player destruction by the shared `spawnPlayerDeathJuice` helper (§7.2) and fully replaces the generic enemy cue on the player-death paths (`PlayScene._loseLife`, `CombatScene.applyPlayerHit`, and the inherited `GymPowerUpsCombat` hit lifecycle). Its amplitudes and lengths are exported `PLAYER_DESTRUCTION_*` constants, and every layer stays within the ≤ 0.2 player-cue volume ceiling. The wave timeout no longer costs a life (AH-0MUNS3ZQ1002DJ9S); shield absorption keeps the generic cue, and the dedicated cue is a safe no-op without an `AudioContext`.
- **End-of-run victory fanfare** — `playVictoryFanfareSound()` in `src/audio/effects.ts` is a long, multi-layer celebration built as a two-phrase fanfare. The **call** is a rising major arpeggio (triangle C5 → E5 → G5 → C6, `VICTORY_ARPEGGIO_FREQS`, `VICTORY_ARPEGGIO_STEP` 0.2 s, each note ringing `VICTORY_ARPEGGIO_NOTE_DURATION` 0.36 s at `VICTORY_ARPEGGIO_VOLUME` 0.15); the **answer** is a faster rising cadence (triangle C6 → E6 → G6 → C7, `VICTORY_CADENCE_FREQS`, `VICTORY_CADENCE_STEP` 0.16 s at `VICTORY_CADENCE_VOLUME` 0.17) that resolves into a sustained major chord (sine C6/E6/G6/C7, `VICTORY_CHORD_FREQS`, held `VICTORY_CHORD_DURATION` 1.6 s at `VICTORY_CHORD_VOLUME` 0.1) with a low bass bed (sine C4/G4, `VICTORY_BASS_FREQS`, `VICTORY_BASS_DURATION` 1.8 s at `VICTORY_BASS_VOLUME` 0.08), a high sparkle flourish (sine 2349–4186 Hz, `VICTORY_SPARKLE_FREQS`) and a soft high-passed shimmer crackle tail (`VICTORY_SHIMMER_FILTER_HZ` 6000 Hz at `VICTORY_SHIMMER_VOLUME` 0.045). It plays **exactly once** at the moment the boss dies (`PlayScene._damageBoss`), while the sustained visual celebration plays in-run and continues on `GameOverScene` (§7.2); total duration is ~3.3 s, every layer peaks at ≤ 0.2, and it is a safe no-op without an `AudioContext`. Deliberately SFX-only — no background music (§7.3 out of MVP scope). A producer audit (2026-10-04) rejected the original single-scale cue as "nothing more than a monotonic peep"; the two-phrase rebuild directly addresses that.
- **Victory firework explosion SFX** — a production audit (2026-10-06) asked for "more explosive SFX" over the fanfare, so each burst of the sustained in-run/screen fireworks (§7.2 `spawnVictoryFireworks`) schedules a matching explosion cue. Four baked ToneForge cues are used, cycled by firework kind via `playVictoryFireworkCue`: `playVictoryExplosionSound()` for the heavy burst/starburst kinds (a layered saw 110 → 32 Hz boom + sine sub-rumble + low-passed white-noise crackle, ~0.65 s), `playVictoryCrackSound()` for rings (quick 587 → 140 Hz saw plus high-passed crack transient, ~0.18 s), `playVictoryPopSound()` for implosions (short 784 → 240 Hz sine pop, ~0.09 s) and `playVictorySparkleSound()` for sparkle bursts (bright 1400 → 600 Hz sine with high-passed shimmer, ~0.12 s). Each cue is baked with pitch-jitter seed variants (32250–32263) so a long sequence does not sound like one repeated sample, and `ENDOFRUN_VICTORY_FIREWORKS_SOUND_EVERY_N` thins the cadence if a dense sequence needs it. The whole layer is gated by `ENDOFRUN_ENABLE_VICTORY_FIREWORKS_SOUND`, plays at `ENDOFRUN_VICTORY_FIREWORKS_SOUND_VOLUME`, and every cue is a safe no-op without an `AudioContext`. The two-phrase fanfare still plays exactly once at the moment of victory and sits over the per-burst explosions.
- **End-of-run defeat sting** — `playDefeatStingSound()` in `src/audio/effects.ts` is the sombre counterpart: a slow five-note descending minor line (triangle G4 → F4 → D4 → B3 → G3, `DEFEAT_STING_FREQS`, `DEFEAT_STING_STEP` 0.3 s, each note ringing `DEFEAT_STING_NOTE_DURATION` 0.55 s at `DEFEAT_STING_NOTE_VOLUME` 0.14) over a sustained low drone (sine 98 Hz, `DEFEAT_STING_DRONE_HZ`) that **sinks in pitch** to `DEFEAT_STING_DRONE_END_HZ` 73.42 Hz as it fades over `DEFEAT_STING_DRONE_DURATION` 2.2 s, with a dark low-pass filtered noise tail (`DEFEAT_STING_TAIL_FILTER_HZ` 280 Hz, `DEFEAT_STING_TAIL_DURATION` 1.4 s). It is triggered **exactly once** on the defeat branch of `GameOverScene` (gated by the shared `ENDOFRUN_ENABLE_SOUND` toggle) and is structurally distinct from `playPlayerDestructionSound()` — a slow discrete descending line with a **low-pass** rumble wash versus that cue's fast sawtooth sweep with a **high-pass** shrapnel hiss. Total duration is ~2.9 s, every layer peaks at ≤ 0.2 and it is a safe no-op without an `AudioContext`.
- **Wave timeout carry-over (no detonation, AH-0MUNS3ZQ1002DJ9S)** — when the wave timer expires, survivors are **kept** and carry over into the next wave; the previous 10× detonation and the per-ship `playMajorExplosionSound()` cue were **retired** (the cue and its `MAJOR_EXPLOSION_*` limiter no longer exist). The shared `detonateWaveTimeoutSurvivors` helper (`src/scenes/core/waveTimeout.ts`) is a no-op so `PlayScene._timeoutWave` and the **enemy gyms** (`GymFodderEnemies` / `GymMinerals` / `GymPowerUpsCombat`) run one carry-over path. The boss (`GymBoss` and the `boss` config) still opts out of the timeout.
- **Phase Shift activation** — every automatic danger-triggered activation and every Teleport-teleport activation plays the dedicated `playPhaseShiftSound()` (parent AH-0MUIYX1EE008FVS8): a rising triangle chirp (320 → 1560 Hz, ~0.28 s) layered with a bandpass noise whoosh sweeping 600 → 3200 Hz (~0.24 s), so the cue reads as "phase engaged" and is distinct from the descending destruction cues. Every layer stays within the ≤ 0.2 player-cue ceiling, the cue is triggered from the single shared `CombatScene` activation sites (`_updateAutoDefence` and `triggerTeleport` — never per scene), and it is a safe no-op without an `AudioContext`.
- **Volume-change feedback** — adjusting the SFX volume slider in `SettingsScene` plays the existing player-explosion cue via `playVolumeFeedback()` (AH-0MUADK77K008RBMB): its pitch/synthesis is unchanged and only the gain is scaled by the selected volume, so the player hears the hull-breach boom at a loudness matching the setting. The cue fires after each keyboard left/right nudge and exactly once on slider-drag release (never during the drag, so a drag does not emit a stream of overlapping booms). Like every other cue it routes through the master SFX gain node, so it respects the current mute state and volume (silent while muted). Mute-toggle feedback is intentionally out of scope. Safe no-op without an `AudioContext`.
- **Shoot cues play once per shot** (not once per bullet), keyed off each
  firing weapon, so fast weapons (e.g. Rapid at 125 ms) stay legible.

**Hold-full metronome + countdown (AH-0MV0QPO4N009KWVT).** Opening the
hold-full choice pauses the launcher and would cut the fire audio dead;
instead every currently active player weapon's fire cue keeps playing on the
same beat grid **at 0.3× volume** (`HOLD_FULL_FIRE_VOLUME_SCALE`) with **no
projectiles and no simulation** — the metronomic ghost fire (§4.5). Selecting
an option then plays a **3-2-1 countdown, one count per beat** (750 ms at the
default 80 BPM), each count with a large on-screen numeral and the distinct
**countdown tick** (`playCountdownTickSound()` — a short bright square
1046 → 784 Hz blip, baked as the `aihell-countdown-tick` tone recipe via the
ToneForge pipeline); the ghost fire **continues underneath** the countdown and
stops when the overlay closes. On the beat after "1" the choice is applied and
play resumes with the beat clock re-based so real fire continues
**phase-locked** on the same grid (no phase jump). The whole metronome +
countdown plays the **same shared cues** as live fire (player fire) plus the
one dedicated countdown tick, in the game and in every gym that launches the
overlay.
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
the Bomb ranged bomb pulse) plus the SFX fire on collection, so responsiveness is
unchanged.
- All player cues keep volume ≤ 0.2 so they read over enemy audio without
drowning it out, and every cue degrades to a safe no-op without an
AudioContext (headless tests, autoplay-blocked browsers).

#### Advance Telegraphing (≥ 500 ms Lead Time)

Key events are announced by an **advance audio cue** with a minimum 500 ms lead time before the visual event:

- **Boss entrance** — Low rumble before boss appears
- **Boss phase transitions** — Rising tone before new attack pattern
- **Levels 4–10 enemy fire** — Short warning tone before bullets fire
- **Level 5+ Phaser firing cycles** — Ascending beep before each cycle (see §4.1)
- **Wave spawns** — Subtle chime before enemies appear
- **Power-up spawns** — Brief chime before power-up appears

#### Background Music

Background music is explicitly a **nice-to-have** and **out of scope for the MVP**. Simple SFX only. If music is added later, it would be a separate work item.

The musical direction for that future work is defined in the **[AI Hell Music System — Audio Design Chapter](AUDIO_DESIGN_CHAPTER.md)** (GDD addendum, design reference only; AH-0MVAUUV1U005UM4W). It captures the tonal language (Phrygian Dominant combat / Lydian ambient), the core motifs and progressions, the instrumentation palette, the dynamic-mixing and state-driven transition rules, the implementation contract and the audio-accessibility requirements. The chapter does **not** change the MVP scope: the baked ToneForge pipeline and SFX catalogue above remain the only in-scope audio, and promoting music into the MVP requires an explicit producer decision (GDD §8). Implementation is future work, tracked by *Implement the Music System from the Audio Design Chapter* (AH-0MVKXT7O70061FXU).

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
| **Action-intensity tracking & pacing** | A recorded measure of on-screen action per run (weighted object count + event bursts) to evaluate pacing, calibrate difficulty and pick highlight clips. Research + decision: [docs/dev/action-intensity.md](./dev/action-intensity.md) (AH-0MUZCSJXQ004TREN); implementation epic AH-0MUZMTTYH008KVS2. |
| **Online leaderboard** | Backend service for persistent, cross-machine leaderboards. |
| **Additional levels** | Levels 6–10+ with new enemy types and pattern variations. |
| **Online multiplayer** | Co-op or competitive play over network. |
| **Background music** | Synthwave / retro electronic soundtrack (SFX is in scope for MVP per §7.3). Musical direction — Phrygian Dominant combat and Lydian ambient scales, Combat Motifs A/B and "Star Drift", the combat/boss/ambient progressions, instrumentation palette, dynamic-mixing and state-driven transition rules — is defined in the design-reference addendum [AI Hell Music System — Audio Design Chapter](./AUDIO_DESIGN_CHAPTER.md) (AH-0MVAUUV1U005UM4W); implementation is tracked by AH-0MVKXT7O70061FXU. |
| **Save/load game state** | Pause and resume functionality. |
| **Achievements** | Unlockable challenges and rewards. |
| **Mobile support** | Touch controls for mobile devices. |

The classic-arcade roster selected by research epic **AH-0MUYAQ6YH0010G52** is
now implemented (see §4.1 and
[`CLASSIC_ENEMY_RESEARCH.md`](./CLASSIC_ENEMY_RESEARCH.md)). The candidates
considered but **not** selected this round — **Joust**, **Dig Dug**, **Q*bert**
and **Star Castle** — remain future scope and are recorded with a deferral
reason each in the research document's "considered but not selected" section.

The classic-arcade power-up and weapon roster selected by research epic
**AH-0MV14SO0G0095IJ4** is now implemented (see §4.4 and
[`CLASSIC_POWERUP_WEAPON_RESEARCH.md`](./CLASSIC_POWERUP_WEAPON_RESEARCH.md)):
four weapons (**R-Type** wave laser, **Centipede** ricochet shot, **Missile
Command** cluster/MIRV missile, **Gradius** Options orbiting satellites) and
four power-ups (**Defender** smart bomb, **Gradius** force field, **Space
Invaders** mystery UFO, and the **Pac-Man** power pellet — subsequently
**removed** in AH-0MV5CB6KO0079N08, see the research document §5). The candidates considered but
**not** selected this round — the **Galaga Dual Fighter**, the Defender /
Robotron **smart bomb weapon form**, the **Tempest Superzapper**, the
**Sinistar Sinibomb**, the **Galaga Repulsor**, the **Frogger Super Leap**, the
**Asteroids Decoy** and the **Gauntlet Potion** — remain future scope and are
recorded with a deferral reason each in the research document's "considered but
not selected" section.

**Outer loop (long-term progression).** The game has an inner loop (seconds:
flying, dodging, destroying) and a middle loop (a run: minerals → hold-full
power-up/weapon choices → levelled effects), but **no outer loop**: nothing
persists between runs except the leaderboard (§5), player settings and a single
run checkpoint (§6.6), and game over is final (§4.6). Four decision-ready
candidates — **Contested Regions / Home World** (the producer's proposal),
**Salvage Fleet**, **Signal Decode** and **Hangar War** (A's war wrapped around
B's hangar) — are outlined on the same footing, compared across agreed criteria
and ranked, with the producer's choice left pending, in
[`OUTER_LOOP_CANDIDATES.md`](./OUTER_LOOP_CANDIDATES.md) (AH-0MVNSSY9L001P1CC,
AH-0MVTE4EOS008RMQ7). That document carries two progression rules common to every
candidate — a reduced starting kit so power is discovered through play, and
mini-bosses that introduce a weapon the player must first defeat and then may
use — recommends **Candidate D — Hangar War** (shipped as Candidate B's MVP plus
one ring), and is **design only, not scheduled**: no candidate's gameplay,
persistence-schema or scene implementation is specified here, and this GDD gains
no playable specification until the producer chooses a loop (a follow-on work
item).

---

## 9. Appendix: Clarifying Questions & Answers

All clarifying questions and their answers from the intake process are captured in the parent work item (AH-0MT7O8KCY0059RA5). This GDD incorporates the following key decisions:

1. **Full 2D movement** — Not lane-based. The player has free movement in all directions.
2. **10 levels** — Expanded from the initial 3; Levels 1–3 are formation-based, Levels 4–10 add enemy fire, and Levels 6–10 interleave the classic-arcade roster (Level 5 remains the sparse, predictable-pattern level).
3. **Pre-boss wave** — Level 5 is explicitly an enemy-fired-projectile level with fewer enemies and predictable patterns; it is no longer the final level — Levels 6–10 showcase the classic-arcade roster before the boss.
4. **Engine selected** — Phaser (TypeScript/HTML5) is the locked engine choice. The engine policy bans UI-heavy engines (Godot/Unity); Phaser satisfies the code-first constraint.
5. **Living document** — The GDD is not rigid; it may be edited during development with worklog-tracked changes.
6. **Local leaderboard** — Simple `localStorage` for the MVP; no backend required.
7. **Controls** — WASD/Arrow keys, auto-fire, automatic teleport power-up on danger (S / ↓ reserved for reverse thrust).
8. **Tron-inspired neon vector aesthetic** — Confirmed.
9. **Magnet power-up (Magnet)** — Confirmed via interactive intake for AH-0MT7VE4SX0005A8V:
   - **Duration/stacking model** (Q: "Temporary timed effect or permanent upgrade?") — Answer: **permanent**; each pickup permanently increases the attraction radius for the rest of the run. **Revised by AH-0MUTOTLCY005NZ8L:** Magnet is now a hybrid — a **15 s refreshing** timed effect as a field pickup, and a **permanent stacking** effect when chosen as a hold-full reward — matching Mineral Scoop.
   - **Scope of attraction** (Q: "Attract all power-up types on screen, or only standard types?") — Answer: **all** — including rare types such as Extra Life.
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
| **AC4** — MVP content (10 levels, 1 boss, 3 lives, 9+ power-ups, local leaderboard, no difficulty scaling) | ✅ | §3 |
| **AC5** — Content catalogs (enemies, waves, boss, power-ups, scoring, progression) | ✅ | §4 |
| **AC6** — Technical architecture (selected engine, module breakdown, data model, save design, risks) | ✅ | §6 |

---

*End of Game Design Document.*