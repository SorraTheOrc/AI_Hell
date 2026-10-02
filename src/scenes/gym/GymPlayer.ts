/**
 * Gym scene — the thruster-navigation training space for the player ship
 * (listed as `Player` on the gym index).
 *
 * Re-based onto the shared combat core (AH-0MUAYB2XR007N10W) so the gym is
 * more than a bare ship-tuning testbed. It now:
 *
 * - advances the player through the shared {@link CombatCoreScene._tickPlayer}
 *   step (weapon timers → live P5 multipliers → scheme-aware input → physics
 *   → auto-fire), so input and auto-fire are the *same code* the shipped
 *   game and the other gyms run;
 * - auto-fires the active weapon(s) through the shared
 *   {@link CombatCoreScene._autoFire} path, with player bullets that render,
 *   wrap and expire by lifetime via the shared `advancePlayerBullets` helper;
 * - spawns a deterministic set of **indestructible obstacles** — static
 *   hexagon barriers plus a small variety of circular pillars — which the
 *   ship must weave around;
 * - resolves collisions through the shared `CombatScene._handleCollisions`
 *   pass: player bullets are absorbed by an obstacle (never destroying it),
 *   and a player-body collision triggers the shared player-hit lifecycle
 *   (explosion juice, brief invulnerability and in-place respawn).
 *
 * The obstacles are a **gym-only training feature** — the shipped game has
 * no static hazards yet, so there is no game counterpart to enable. This is
 * the documented divergence permitted by the gym↔game parity convention
 * (AGENTS.md § Game Architecture Conventions, AH-0MUGZDTFX004RBD1); the
 * obstacle entity itself is a shared, reusable `src/entities/Obstacle.ts`
 * and the collision/auto-fire code is shared, not copied.
 *
 * The ship-config tuning panel is retained: a plain-DOM overlay anchored
 * bottom-left (via the shared `.gym-panel` class, AH-0MUAYB7O4009LWBF) with
 * one slider per numeric config value (thrust, max speed, size, flame,
 * deceleration), colour inputs, a scheme toggle and a Save button. It sits
 * alongside the obstacles and shooting.
 *
 * A shared "← INDEX" back button lets the tester return to the gym index
 * without reloading the page, and ESC returns to the main menu.
 */

import Phaser from 'phaser';

import { CombatScene } from '../core/CombatScene';
import type { CombatEnemyBullet } from '../core/CombatCoreScene';
import { advancePlayerBullets } from '../core/bulletLifecycle';
import { Player } from '../../entities/Player';
import { PlayerBullet } from '../../entities/PlayerBullet';
import { Obstacle, type ObstacleConfig } from '../../entities/Obstacle';
import {
  ControlSchemeType,
} from '../../utils/movementModel';
import { WasdKeysLike } from '../../utils/input';
import { makeCollapsible } from '../../utils/gymPanel';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import {
  loadShipConfig,
  saveShipConfig,
  ShipConfig,
  ControlScheme,
} from '../../core/config';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { EffectsRegistry } from '../../powerups/effects';

/** Slider ranges for the numeric ship config values. */
const SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  thrustAcceleration: { min: 0, max: 1200, step: 10 },
  maxSpeed: { min: 0, max: 500, step: 5 },
  shipSize: { min: 4, max: 60, step: 1 },
  thrustFlameLength: { min: 0.1, max: 2, step: 0.05 },
  frictionDeceleration: { min: 0, max: 400, step: 5 },
  asteroidsRotationSpeed: { min: 0.5, max: 10, step: 0.5 },
  asteroidsRotationAcceleration: { min: 2, max: 60, step: 2 },
  asteroidsRotationDeceleration: { min: 12, max: 300, step: 12 },
};

/**
 * The Player gym's fixed obstacle course (deterministic across loads/tests).
 *
 * Two hexagon barrier walls bracket the play area (left and right), a
 * horizontal barrier splits the middle with a central gap, and four circular
 * pillars add a small variety. The layout is deliberately a plain data table
 * so it can be swapped without touching behaviour. Spawn is at the centre
 * (480, 270), which is kept clear of every obstacle.
 */
export const OBSTACLE_LAYOUT: readonly ObstacleConfig[] = [
  // Left vertical barrier wall.
  { x: 220, y: 120, radius: 24, kind: 'barrier' },
  { x: 220, y: 166, radius: 24, kind: 'barrier' },
  { x: 220, y: 212, radius: 24, kind: 'barrier' },
  { x: 220, y: 258, radius: 24, kind: 'barrier' },
  // Right vertical barrier wall (offset downward).
  { x: 740, y: 282, radius: 24, kind: 'barrier' },
  { x: 740, y: 328, radius: 24, kind: 'barrier' },
  { x: 740, y: 374, radius: 24, kind: 'barrier' },
  { x: 740, y: 420, radius: 24, kind: 'barrier' },
  // Central horizontal barrier, split around a gap at the spawn.
  { x: 360, y: 270, radius: 22, kind: 'barrier' },
  { x: 406, y: 270, radius: 22, kind: 'barrier' },
  { x: 554, y: 270, radius: 22, kind: 'barrier' },
  { x: 600, y: 270, radius: 22, kind: 'barrier' },
  // Pillar variety.
  { x: 480, y: 100, radius: 16, kind: 'pillar' },
  { x: 480, y: 440, radius: 16, kind: 'pillar' },
  { x: 130, y: 440, radius: 14, kind: 'pillar' },
  { x: 830, y: 110, radius: 14, kind: 'pillar' },
];

/** Scheme toggle button id. */
export const SCHEME_TOGGLE_ID = 'gym-scheme-toggle';

/** Scheme toggle text label for display. */
function schemeLabel(scheme: ControlSchemeType): string {
  return scheme === 'asteroids' ? 'Scheme: Asteroids' : 'Scheme: 4-Directional';
}

/** Colour config values (rendered with `<input type="color">`). */
const COLOR_FIELDS = ['shipColor', 'thrustFlameColor', 'thrustFlameInnerColor'];

/** Panel element ids. */
export const PANEL_ID = 'gym-config-panel';
export const SAVE_BUTTON_ID = 'gym-save-config';
export const STATUS_ID = 'gym-save-status';

/** Converts a Phaser hex colour number to a "#rrggbb" string. */
export function colorToHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/** Converts a "#rrggbb" string to a Phaser hex colour number. */
export function hexToColor(value: string): number {
  return parseInt(value.replace('#', ''), 16);
}

/**
 * Player gym scene. Extends the shared {@link CombatScene} so input,
 * auto-fire, collision resolution and the player-hit lifecycle flow through
 * the one shared implementation; the scene supplies its obstacles through
 * the inherited participant accessors and overrides only the two
 * destruction hooks so obstacles are indestructible.
 */
export class GymPlayer extends CombatScene<Obstacle, CombatEnemyBullet> {
  private player: Player | null = null;
  private obstacles: Obstacle[] = [];
  private enemyBullets: CombatEnemyBullet[] = [];
  private panel: HTMLDivElement | null = null;
  /** Shared active-effect registry (part of the shared combat-core contract). */
  private effectsRegistry = new EffectsRegistry();

  constructor() {
    super({ key: 'GymPlayer' });
  }

  create(): void {
    // A stop/restart of the same instance must start clean — no stale ship,
    // obstacles, bullets or input bindings (AH-0MUII3FYN0072QRT, gap 10).
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });

    // Shared "← INDEX" button so the tester can return to the gym index.
    addBackToIndexButton(this);
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);
    // A Graphics built via `new` is not on the scene display list until
    // added — without this the ship is never rendered.
    this.add.existing(this.player);

    // ── Indestructible obstacle course ───────────────────────────────
    this._spawnObstacles();

    // ── Input keys ─────────────────────────────────────────────────
    // cursor keys (arrows) + WASD via a comma-separated key string,
    // per the Phaser KeyboardPlugin API. The shared `_readPlayerInput`
    // step reads them through the shared scheme→input helper.
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    this._buildPanel();

    // ── Config panel ───────────────────────────────────────────────
    // Seed the controls from the persisted config, apply it to the ship,
    // then tear everything down when the scene shuts down (e.g. tests).
    const config = loadShipConfig();
    this._applyPanelValues(config);
    this.player.setConfig(config);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
  }

  /** Spawns the deterministic obstacle course into the scene. */
  private _spawnObstacles(): void {
    for (const spec of OBSTACLE_LAYOUT) {
      const obstacle = new Obstacle(this, spec);
      this.add.existing(obstacle);
      this.obstacles.push(obstacle);
    }
  }

  // ── Shared combat-core participant accessors ─────────────────────

  /** The keyboard-controlled player ship. */
  override getPlayer(): Player | null {
    return this.player;
  }

  /** Shared active-effect registry consumed by the shared control step. */
  override getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /** Live obstacles consumed by the shared collision/teleport passes. */
  protected override getEnemyEntities(): readonly Obstacle[] {
    return this.obstacles;
  }

  /** The gym has no enemy bullets. */
  protected override getEnemyBullets(): readonly CombatEnemyBullet[] {
    return this.enemyBullets;
  }

  /** Replaces the enemy-bullet collection after a shared collision pass. */
  protected override setEnemyBullets(bullets: CombatEnemyBullet[]): void {
    this.enemyBullets = bullets;
  }

  // ── Indestructible-obstacle hooks ────────────────────────────────

  /**
   * Player bullet hits an obstacle: the solid, indestructible geometry
   * absorbs the bullet, which is consumed on impact, while the obstacle
   * stays alive. Overriding this single shared hook keeps the collision
   * loop itself in the shared core (no copied loop).
   */
  protected override onPlayerBulletHitsEnemy(
    _enemy: Obstacle,
    bullet: PlayerBullet,
  ): boolean {
    bullet.destroy();
    return true;
  }

  /**
   * Player body rams an obstacle: the obstacle is indestructible, so unlike
   * the generic path it is *not* destroyed. The shared collision step still
   * registers the player hit that follows (see the base `_handleCollisions`
   * step 4), so a crash destroys the player, never the obstacle.
   */
  protected override onPlayerRamsEnemy(_enemy: Obstacle): void {
    // Intentionally empty — obstacles survive the ram.
  }

  /** Obstacles are never destroyed through the generic kill path. */
  protected override onEnemyDestroyed(_enemy: Obstacle): void {
    // Intentionally empty — no destruction accounting for obstacles.
  }

  // ── Control panel ────────────────────────────────────────────────

  /**
   * Clears per-run state (the ship, obstacles, bullets, input bindings) so a
   * stop/restart of the same instance starts fresh
   * (AH-0MUII3FYN0072QRT, gap 10). The `Player.destroy()` is a no-op once
   * the display list has already torn the child down, so this is safe to
   * call from both `create()` and the SHUTDOWN handler.
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player?.destroy();
    this.player = null;
    for (const obstacle of this.obstacles) obstacle.destroy();
    this.obstacles = [];
    this.enemyBullets = [];
    this.cursors = undefined;
    this.wasd = undefined;
  }

  /**
   * Destroys every scene-owned object on `SHUTDOWN` after the shared core
   * teardown has run, so a stop/restart leaks nothing (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    this.panel?.remove();
    this.panel = null;
    this.player?.destroy();
    this.player = null;
    for (const obstacle of this.obstacles) obstacle.destroy();
    this.obstacles = [];
    this.enemyBullets = [];
    this.cursors = undefined;
    this.wasd = undefined;
  }

  /** Builds the plain-DOM tuning panel (bottom-left overlay). */
  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    // Shared bottom-left anchoring + viewport height cap (AH-0MUAYB7O4009LWBF).
    panel.className = 'gym-panel';

    // Control-scheme toggle (AC3 — button to switch schemes).
    const schemeRow = document.createElement('div');
    schemeRow.className = 'gym-panel-row';
    const toggle = document.createElement('button');
    toggle.id = SCHEME_TOGGLE_ID;
    toggle.type = 'button';
    toggle.dataset['scheme'] = 'fourDirectional';
    toggle.textContent = schemeLabel('fourDirectional');
    toggle.addEventListener('click', () => this._onToggleScheme());
    schemeRow.appendChild(toggle);
    panel.appendChild(schemeRow);

    // Numeric sliders.
    for (const [field, range] of Object.entries(SLIDER_RANGES)) {
      panel.appendChild(this._sliderRow(field, range));
    }

    // Colour inputs.
    for (const field of COLOR_FIELDS) {
      panel.appendChild(this._colorRow(field));
    }

    // Save button + status.
    const save = document.createElement('button');
    save.id = SAVE_BUTTON_ID;
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => this._onSave());

    const status = document.createElement('span');
    status.id = STATUS_ID;

    const actions = document.createElement('div');
    actions.className = 'gym-panel-actions';
    actions.append(save, status);
    panel.appendChild(actions);

    // Wrap the controls in a collapsible body + header (AH-0MUDYFMUX007Q0W3).
    makeCollapsible({ panel, title: 'Ship Config' });

    host.appendChild(panel);
    this.panel = panel;
  }

  private _sliderRow(
    field: string,
    range: { min: number; max: number; step: number },
  ): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.textContent = field;
    label.className = 'gym-panel-label';

    const input = document.createElement('input');
    input.type = 'range';
    input.dataset['config'] = field;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.addEventListener('input', () => this._onControlInput());

    const value = document.createElement('output');
    value.dataset['configValue'] = field;

    row.append(label, input, value);
    return row;
  }

  private _colorRow(field: string): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.textContent = field;
    label.className = 'gym-panel-label';

    const input = document.createElement('input');
    input.type = 'color';
    input.dataset['config'] = field;
    input.addEventListener('input', () => this._onControlInput());

    row.append(label, input);
    return row;
  }

  /** Toggles the control scheme button and applies it live (AC3). */
  private _onToggleScheme(): void {
    const toggle = this.panel?.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (!toggle) return;
    const next: ControlSchemeType =
      toggle.dataset['scheme'] === 'asteroids'
        ? 'fourDirectional'
        : 'asteroids';
    toggle.dataset['scheme'] = next;
    toggle.textContent = schemeLabel(next);
    // Applies the merged config (with the new scheme) to the player live.
    this._onControlInput();
  }

  /** Reads all controls into a ShipConfig. */
  private _readPanelValues(): ShipConfig {
    const source = loadShipConfig();
    for (const field of Object.keys(SLIDER_RANGES)) {
      const input = this.panel?.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) (source as unknown as Record<string, unknown>)[field] = Number(input.value);
    }
    for (const field of COLOR_FIELDS) {
      const input = this.panel?.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) (source as unknown as Record<string, unknown>)[field] = hexToColor(input.value);
    }
    // The scheme toggle is the source of truth for controlScheme (AC3).
    const toggle = this.panel?.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (toggle) {
      source.controlScheme = (toggle.dataset['scheme'] ??
        'fourDirectional') as ControlScheme;
    }
    return source;
  }

  /** Sets control values (and labels) from a ShipConfig without firing events. */
  private _applyPanelValues(config: ShipConfig): void {
    if (!this.panel) return;
    for (const field of Object.keys(SLIDER_RANGES)) {
      const input = this.panel.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      const value = this.panel.querySelector<HTMLElement>(
        `output[data-config-value="${field}"]`,
      );
      if (input) input.value = String(config[field as keyof ShipConfig]);
      if (value) value.textContent = String(config[field as keyof ShipConfig]);
    }
    for (const field of COLOR_FIELDS) {
      const input = this.panel.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) {
        input.value = colorToHex(config[field as keyof ShipConfig] as number);
      }
    }
    // Sync the scheme toggle button with the config's control scheme.
    const toggle = this.panel.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (toggle) {
      toggle.dataset['scheme'] = config.controlScheme ?? 'fourDirectional';
      toggle.textContent = schemeLabel(config.controlScheme ?? 'fourDirectional');
    }
  }

  /** Any slider/colour change applies the merged config to the player live. */
  private _onControlInput(): void {
    if (!this.player) return;
    const config = this._readPanelValues();
    this.player.setConfig(config);
    this._updateValueLabels(config);
  }

  /** Keeps the output labels in sync with the current control values. */
  private _updateValueLabels(config: ShipConfig): void {
    for (const field of Object.keys(SLIDER_RANGES)) {
      const value = this.panel?.querySelector<HTMLElement>(
        `output[data-config-value="${field}"]`,
      );
      if (value) value.textContent = String(config[field as keyof ShipConfig]);
    }
  }

  /** Persists the current control values via the CSV store and shows a status. */
  private _onSave(): void {
    const status = this.panel?.querySelector<HTMLElement>(`#${STATUS_ID}`);
    void (async () => {
      try {
        const config = this._readPanelValues();
        if (status) status.textContent = 'Saving…';
        const result = await saveShipConfig(config);
        if (status) {
          status.textContent = result.ok
            ? 'Saved'
            : `Save failed — ${result.reason ?? 'writes unavailable'}`;
        }
      } catch (err) {
        if (status) status.textContent = `Save failed: ${String(err)}`;
      }
    })();
  }

  // ── Scene update loop ────────────────────────────────────────────

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives the shared
   * player-control step (input → thrust, auto-fire), player-bullet
   * lifecycle, and the shared collision/hit pass — used by the scene loop
   * and by tests.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // Shared input → timers → multipliers → physics → auto-fire step
    // (AH-0MUII39KX007YUQ0). Auto-fires the active weapon(s) toward the
    // direction of travel via the shared `_autoFire` path.
    this._tickPlayer(dt);

    // Bullet lifecycle: advance + wrap + lifetime expiry (shared helper).
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);

    // Automatic Phase Shift danger feed, before collision gating (shared).
    this._updatePhaseShiftAutoTrigger(dt);

    // Shared collision pass: player bullets vs obstacles, obstacle body vs
    // player (the player hit is handled by the shared player-hit lifecycle).
    this._handleCollisions();

    // Post-hit invulnerability blink (shared).
    this._updateInvulnerability(dt);

    // Timed effects (none collected here, but keeps the shared ordering).
    this.effectsRegistry.tick(dt);
  }

  // ── Public test accessors ────────────────────────────────────────

  /** The live obstacle course (copy). */
  getObstacles(): Obstacle[] {
    return [...this.obstacles];
  }

  /** Player bullets currently in flight (copy). */
  getPlayerBullets(): PlayerBullet[] {
    return [...this.playerBullets];
  }

  /** Arrow-key bindings for the player (undefined when no keyboard). */
  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined {
    return this.cursors;
  }

  /** WASD bindings for the player (undefined when no keyboard). */
  getWasd(): WasdKeysLike | undefined {
    return this.wasd;
  }

  /** Number of times the player ship has been hit (informational only). */
  getPlayerHitCount(): number {
    return this.playerHitCount;
  }

  /** True while the player is invulnerable (blinking) after a hit. */
  isPlayerInvulnerable(): boolean {
    return this.invulnerable > 0;
  }
}
