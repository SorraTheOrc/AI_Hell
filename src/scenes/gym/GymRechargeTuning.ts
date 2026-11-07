/**
 * Gym scene — recharge-time tuning (AH-0MV82IAYG000WS8B).
 *
 * A dedicated balance-tuning harness for the two defensive consumables whose
 * recharge pacing is level-derived only: **Phase Shift** (30 s → 10 s) and
 * **Teleport** (60 s → 20 s). Both are granted as **permanent power-ups from
 * the first frame**, so the observer never has to farm a drop, and two groups
 * of shooting `raider`s keep the ship under converging pressure so both
 * abilities auto-activate repeatedly.
 *
 * The panel exposes one live slider per ability:
 *
 * - **Phase Shift recharge** — 1–60 s in 0.5 s steps;
 * - **Teleport recharge** — 1–120 s in 0.5 s steps.
 *
 * Moving a slider immediately changes the recharge time applied to
 * **subsequently spent** charges (a running timer keeps the duration it
 * captured, matching the run-scoped recharge model) and persists the value in
 * the shared game-rules config (`phaseRechargeOverrideSeconds` /
 * `teleportRechargeOverrideSeconds`), so it survives a page reload and is
 * re-applied on the next scene create. An unset (`null`) override seeds the
 * slider from the level-derived default and leaves gameplay untouched.
 *
 * **The override is gym-only.** The shipped `PlayScene` and every other gym
 * keep level-derived recharge times: only this scene reads the persisted rule
 * and pushes it into the effect store's override seam
 * (`PowerUpLevelStore.setRechargeTimeOverride`), so the level catalogue stays
 * authoritative for gameplay.
 *
 * **Permanent-grant model note.** Phase Shift is a recharging charge pool
 * whose regenerating ceiling is 3 (`POWER_UP_CHARGE_CAP`): the permanent
 * grant owns the kind and banks one charge, and completed recharges fill the
 * pool up to that ceiling. Teleport is a **single-use** ability (parent
 * AH-0MVY096RT006QMF4) whose whole state is its level-derived readiness
 * timer, so its permanent grant simply leaves the warp ready. The work item's
 * "cap 3" wording is honoured by the Phase Shift pool's regenerating ceiling;
 * giving Teleport a stored multi-charge pool would change shipped gameplay,
 * which this gym must not do.
 *
 * Gym ↔ game parity (AGENTS.md § Game Architecture Conventions): the threats
 * are built through the shared `createEnemyFromConfig` factory and emerge
 * through the shared spawn presentation (`resolveSpawnTransitTarget` +
 * `startSpawnAnimation` / `updateSpawnEmergence`), fire through the shared
 * `collectEnemyFire` dispatcher, and the wave-timeout lifecycle comes from the
 * shared `CombatScene`. Auto-fire is deliberately disabled so the defensive
 * abilities — not player fire — remain the demonstration, and raiders are
 * persistent demonstration threats (ramming does not destroy them), matching
 * `GymPowerUpsCombat` (recorded in `docs/GYM_PARITY.md`).
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically through
 * the shared game harness.
 */

import Phaser from 'phaser';

import { CombatScene } from '../core/CombatScene';
import { gymBackgroundLevel } from './core/gymBackground';
import type { SceneSetupState } from '../core/sceneSetup';
import { advanceWrappingBullets } from '../core/bulletLifecycle';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import { Player } from '../../entities/Player';
import { ScoutBullet } from '../../entities/Scout';
import { Raider } from '../../entities/Raider';
import { createEnemyFromConfig } from '../../entities/enemyFactory';
import { loadEnemyConfig } from '../../core/enemyConfig';
import { collectEnemyFire } from '../../entities/enemyFire';
import {
  WORMHOLE_OPEN_DURATION,
  startSpawnAnimation,
  updateSpawnAnimation,
  updateSpawnEmergence,
  type SpawnAnimatable,
} from '../../vfx/wormholeSpawn';
import {
  resolveSpawnTransitTarget,
  type SpawnTransitEntity,
} from '../core/spawnTransit';
import { RAIDER_SIZE } from '../core/raiderPatrol';
import { HUD } from '../../ui/HUD';
import { combatHudOptions } from '../core/hudWiring';
import { EffectsRegistry } from '../../powerups/effects';
import { grantPermanentPowerUp } from '../../powerups/choiceReward';
import { playSpawnSound } from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { makeCollapsible } from '../../utils/gymPanel';
import {
  applyAndPersistRechargeOverride,
  buildRechargeTimeSlider,
  type RechargeAbility,
} from '../../utils/gymPowerUpControl';
import { buildVFormationOffsets } from '../../utils/formations';
import { loadRules } from '../../core/rules';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';

// ── Panel ids (stable selectors for tests) ─────────────────────────

/** Stable DOM id of the tuning panel container. */
export const RECHARGE_PANEL_ID = 'recharge-gym-panel';
/** Stable DOM id of the in-panel SHOOT toggle. */
export const RECHARGE_SHOOT_ID = 'recharge-gym-shoot';

// ── Threat tuning ──────────────────────────────────────────────────

/** Raiders per group (the work item's default). */
export const RAIDER_GROUP_SIZE = 3;

/** Group origins: one left of the ship, one right, both above the centre. */
export const RAIDER_GROUP_ORIGINS: readonly { x: number; y: number }[] = [
  { x: GAME_WIDTH * 0.22, y: GAME_HEIGHT * 0.28 },
  { x: GAME_WIDTH * 0.78, y: GAME_HEIGHT * 0.28 },
];

/** Horizontal spacing between raiders in one group (px). */
const RAIDER_SPACING_X = 34;
/** Vertical spacing between raider rows in one group (px). */
const RAIDER_SPACING_Y = 30;

/** Teleport-avoidance hit radii supplied through the shared hooks (px). */
const ENEMY_HIT_RADIUS = RAIDER_SIZE / 2 + 4;
const BULLET_HIT_RADIUS = 5;

/**
 * Recharge-time tuning gym. Extends the shared {@link CombatScene} core so its
 * collision, teleport, auto-defence and wave-timeout flow through the one
 * shared implementation; the gym supplies only its scenario specifics.
 */
export class GymRechargeTuning extends CombatScene<Raider, ScoutBullet, never> {
  private player: Player | null = null;
  private effectsRegistry = new EffectsRegistry();

  // Threats
  private raiders: Raider[] = [];
  private raiderBullets: ScoutBullet[] = [];
  private shootEnabled = true;

  // Recharge overrides (gym-only). `null` = level-derived default.
  private phaseOverride: number | null = null;
  private teleportOverride: number | null = null;

  // UI
  private hud: HUD | null = null;
  private panel: HTMLDivElement | null = null;
  private shootButton: HTMLButtonElement | null = null;

  constructor() {
    super({ key: 'GymRechargeTuning' });
  }

  /** Gym family background decision: fixed representative level, no warp. */
  protected override backgroundLevel(): number | null {
    return gymBackgroundLevel();
  }

  create(data?: SceneSetupState): void {
    this.resetRunState();
    this._createSceneBackground();

    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    // Scripted-scene setup (AH-0MVRMHYJR000Y9H8): loadout, power-up levels
    // and content seed are live before the first captured frame.
    this._adoptCaptureSetup(data);

    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this.hud = new HUD(
      this,
      this.effectsRegistry,
      combatHudOptions(() => this.player, { showLives: false }),
    );

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.teardownRunState(),
    );

    this.cursors =
      this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as
      | WasdKeysLike
      | undefined;

    // Permanent grants: both abilities are owned from the first frame so the
    // observer needs no drops. Phase Shift's grant banks one charge into its
    // recharging pool (whose regenerating ceiling is 3), so both abilities
    // cycle under the sustained threat the raiders provide.
    grantPermanentPowerUp('phase_shift', this.effectsRegistry);
    grantPermanentPowerUp('teleport', this.effectsRegistry);

    // Re-apply the persisted gym-only overrides, then spawn the threats and
    // arm the shared wave timeout.
    this._applyPersistedOverrides();
    this._spawnRaiderGroups();
    playSpawnSound();
    this.startWaveTimeout();

    this._buildPanel();

    this.add
      .text(
        GAME_WIDTH / 2,
        GAME_HEIGHT - 12,
        'Phase Shift + Teleport owned — tune their recharge in the panel',
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#555555',
        },
      )
      .setOrigin(0.5);
  }

  /**
   * Resets shared per-run state plus this gym's player, threats and UI so a
   * stop/restart of the same scene instance starts clean.
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.raiders = [];
    this.raiderBullets = [];
    this.shootEnabled = true;
    this.phaseOverride = null;
    this.teleportOverride = null;
    this.hud = null;
    this.panel = null;
    this.shootButton = null;
  }

  /** Destroys every scene-owned object on `SHUTDOWN` so a restart leaks nothing. */
  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const raider of this.raiders) raider.destroy();
    this.raiders = [];
    for (const bullet of this.raiderBullets) bullet.graphics.destroy();
    this.raiderBullets = [];
    this.player?.destroy();
    this.player = null;
    this.hud?.destroy();
    this.hud = null;
    this.panel?.remove();
    this.panel = null;
    this.shootButton = null;
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * The tuning gym's threats are persistent demonstration pressure and it has
   * no drop supply, so the player does not auto-fire; the shared step's
   * auto-fire resolves to a no-op (mirrors `GymPowerUpsCombat`).
   */
  protected override autoFireEnabled(): boolean {
    return false;
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement, raider
   * patrol/attack movement and fire, bullet lifecycle, automatic defence,
   * collisions, the shared wave-timeout refresh and the HUD.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // Shared player-control step: timers → multipliers → input → physics →
    // auto-fire (a no-op here).
    this._tickPlayer(dt);

    // Raider patrol / attack-run movement plus the live aim seam.
    this._tickRaiders(dt);

    // Aimed fire only during a committed attack run, routed through the one
    // shared dispatcher.
    this._collectRaiderFire();

    // Enemy bullets through the shared projectile lifecycle.
    this._advanceEnemyBullets(dt);

    // Automatic defence (Phase Shift / Teleport): feed live danger before
    // gating so an activation this frame protects this frame.
    this._updateAutoDefence(dt);

    // Shared spawn presentation: grow each raider from 1 px while it is
    // spawn-protected, exactly as the game does.
    this._updateSpawnAnimations(dt);

    // Hit response (bullets + bodies), gated by phase / shield.
    this._handleCollisions();

    // Invulnerability blink.
    this._updateInvulnerability(dt);

    // Effect timers (including the shared store's recharge timers).
    this.effectsRegistry.tick(dt);

    // Shared wave-timeout: detonate survivors, then refresh.
    this._advanceWaveTimeout(dt);
    this._drawWaveTimeoutBar();
    this._tickRespawnCountdown(dt);

    this.hud?.refresh();
  }

  // ── Threat lifecycle ─────────────────────────────────────────────

  /**
   * Spawns the two raider groups through the shared factory and spawn
   * presentation, so the active `raider` `EnemyConfig` (sizes, colours, fire
   * tuning, patrol/attack columns) reaches the entity exactly as it does in
   * `PlayScene`.
   */
  private _spawnRaiderGroups(): void {
    const config = loadEnemyConfig('raider');
    const offsets = buildVFormationOffsets(RAIDER_GROUP_SIZE);
    for (const group of RAIDER_GROUP_ORIGINS) {
      for (const offset of offsets) {
        const x = group.x + offset.col * RAIDER_SPACING_X;
        const y = group.y + offset.row * RAIDER_SPACING_Y;
        const raider = createEnemyFromConfig(
          this,
          config,
          x,
          y,
          offset,
        ) as Raider;
        raider.shootEnabled = this.shootEnabled;
        // In-place spawn: these raiders are not part of a wave wormhole entry,
        // so no destination is supplied (`transit: false` asks the shared
        // seam for the exemption rather than re-implementing it).
        const transitTarget = resolveSpawnTransitTarget({
          entity: raider as unknown as SpawnTransitEntity,
          transit: false,
          base: { x, y },
          offset,
          spacingX: RAIDER_SPACING_X,
          spacingY: RAIDER_SPACING_Y,
        });
        startSpawnAnimation(
          raider as unknown as SpawnAnimatable,
          raider.scaleX,
          WORMHOLE_OPEN_DURATION,
          transitTarget ? () => transitTarget : undefined,
        );
        raider.setSpawning(true);
        this.add.existing(raider);
        this.raiders.push(raider);
      }
    }
  }

  /** Advances the shared emergence step for every spawning raider. */
  private _updateSpawnAnimations(dt: number): void {
    for (const raider of this.raiders) {
      if (!raider.alive || !raider.isSpawning) continue;
      const stillGrowing = updateSpawnEmergence(
        raider as unknown as SpawnAnimatable,
        dt,
      );
      if (!stillGrowing) raider.setSpawning(false);
    }
  }

  /**
   * Test seam: completes every in-progress spawn emergence immediately, so a
   * scene test observes fully-formed, hittable threats without waiting out the
   * shared spawn-protection window (the same seam the other gyms use).
   */
  finishSpawnAnimations(): void {
    for (const raider of this.raiders) {
      if (!raider.isSpawning) continue;
      updateSpawnAnimation(raider as unknown as SpawnAnimatable, 10);
      raider.setSpawning(false);
    }
  }

  /**
   * Opt into the shared wave-timeout so the two groups refresh under sustained
   * pressure (mirrors the shipped game and the other threat gyms).
   */
  protected override getWaveTimeoutDuration(): number {
    return WAVE_TIME_LIMIT_SECONDS;
  }

  /** Wave-timeout expiry: start the shared 3 s countdown, then refresh. */
  protected override onWaveTimeoutExpired(): void {
    this._startRespawnCountdown();
  }

  /**
   * Refresh the scenario after the shared countdown: clear stale bullets and
   * respawn exactly two fresh raider groups. A clean-slate refresh keeps the
   * tuning scenario's population constant instead of accumulating survivors
   * over a long balance session.
   */
  protected override respawnWave(): void {
    for (const bullet of this.raiderBullets) bullet.graphics.destroy();
    this.raiderBullets = [];
    for (const raider of this.raiders) raider.destroy();
    this.raiders = [];
    this._spawnRaiderGroups();
    playSpawnSound();
    this.startWaveTimeout();
  }

  // ── Threats: movement + fire ─────────────────────────────────────

  private _tickRaiders(dt: number): void {
    if (!this.player) return;
    for (const raider of this.raiders) {
      if (!raider.alive) continue;
      raider.setAimTarget(this.player.x, this.player.y);
      // The raider owns its patrol/attack motion and ignores the formation
      // base (shared `stepRaider` policy); passing its own group origin keeps
      // the call shape identical to the shared positioning pass.
      raider.applyFormationPosition(
        0,
        0,
        dt,
        RAIDER_SPACING_X,
        RAIDER_SPACING_Y,
      );
    }
  }

  private _collectRaiderFire(): void {
    if (!this.shootEnabled) return;
    const now = this.time.now;
    for (const raider of this.raiders) {
      if (!raider.alive) continue;
      collectEnemyFire(raider, 'raider', now, this.raiderBullets);
    }
  }

  private _advanceEnemyBullets(dt: number): void {
    advanceWrappingBullets(this.raiderBullets, dt, GAME_WIDTH, GAME_HEIGHT);
  }

  // ── Shared combat-core hooks ─────────────────────────────────────

  /** Enemy hit radius used for teleport destination avoidance (px). */
  protected override getTeleportEnemyHitRadius(): number {
    return ENEMY_HIT_RADIUS;
  }

  /** Enemy-bullet hit radius used for teleport avoidance (px). */
  protected override getTeleportBulletHitRadius(): number {
    return BULLET_HIT_RADIUS;
  }

  /** Raiders are persistent demonstration threats — ramming does not destroy them. */
  protected override onPlayerRamsEnemy(_enemy: Raider): void {}

  /** Enemy-destruction seam (no-op: the gym keeps its raiders alive). */
  protected override onEnemyDestroyed(_enemy: Raider): void {}

  /** Live enemy entities for the shared collision/teleport/auto-defence passes. */
  protected override getEnemyEntities(): readonly Raider[] {
    return this.raiders;
  }

  /** Live enemy bullets for the shared collision/teleport passes. */
  getEnemyBullets(): ScoutBullet[] {
    return this.raiderBullets.slice();
  }

  /** Replaces the enemy-bullet collection after a shared collision pass. */
  protected override setEnemyBullets(bullets: ScoutBullet[]): void {
    this.raiderBullets = bullets;
  }

  // ── Recharge overrides ───────────────────────────────────────────

  /**
   * Reads the persisted gym-only overrides and pushes them into the effect
   * store. `null` leaves the level-derived interval in place.
   */
  private _applyPersistedOverrides(): void {
    const rules = loadRules();
    this.phaseOverride = rules.phaseRechargeOverrideSeconds;
    this.teleportOverride = rules.teleportRechargeOverrideSeconds;
    this.effectsRegistry
      .levelStore()
      .setRechargeTimeOverride(this.phaseOverride, this.teleportOverride);
  }

  /** Pushes the current in-memory overrides into the effect store. */
  private _applyRechargeOverrides(): void {
    this.effectsRegistry
      .levelStore()
      .setRechargeTimeOverride(this.phaseOverride, this.teleportOverride);
  }

  /** Slider handler: apply live, then persist for the next session. */
  private _onRechargeSlider(ability: RechargeAbility, seconds: number): void {
    if (ability === 'phase_shift') {
      this.phaseOverride = seconds;
    } else {
      this.teleportOverride = seconds;
    }
    this._applyRechargeOverrides();
    applyAndPersistRechargeOverride(ability, seconds);
  }

  // ── Panel ────────────────────────────────────────────────────────

  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    // Remove a stale panel left behind by a previous test/game instance.
    document.getElementById(RECHARGE_PANEL_ID)?.remove();

    const panel = document.createElement('div');
    panel.id = RECHARGE_PANEL_ID;
    // Shared bottom-left anchoring + viewport height cap.
    panel.className = 'gym-panel';

    const store = this.effectsRegistry.levelStore();
    const phaseSeed =
      this.phaseOverride ?? store.phaseRechargeTime();
    const teleportSeed =
      this.teleportOverride ?? store.teleportRechargeTime();

    const phaseSlider = buildRechargeTimeSlider(
      'phase_shift',
      phaseSeed,
      (seconds) => this._onRechargeSlider('phase_shift', seconds),
    );
    const teleportSlider = buildRechargeTimeSlider(
      'teleport',
      teleportSeed,
      (seconds) => this._onRechargeSlider('teleport', seconds),
    );
    panel.append(phaseSlider.row, teleportSlider.row);

    // In-panel SHOOT toggle (on by default) so the threat pressure can be
    // paused while a recharge cycle is observed.
    const actions = document.createElement('div');
    actions.className = 'gym-panel-actions';
    const shoot = document.createElement('button');
    shoot.id = RECHARGE_SHOOT_ID;
    shoot.type = 'button';
    shoot.dataset['enabled'] = this.shootEnabled ? 'true' : 'false';
    shoot.textContent = this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF';
    shoot.addEventListener('click', () => this.toggleShooting());
    actions.appendChild(shoot);
    panel.appendChild(actions);

    makeCollapsible({ panel, title: 'Recharge Tuning' });
    host.appendChild(panel);
    this.panel = panel;
    this.shootButton = shoot;
  }

  // ── Shooting toggle ──────────────────────────────────────────────

  /**
   * Toggles aimed firing for the whole raider population and syncs the
   * in-panel toggle.
   */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const raider of this.raiders) {
      raider.shootEnabled = this.shootEnabled;
    }
    if (this.shootButton) {
      this.shootButton.textContent = this.shootEnabled
        ? 'SHOOT: ON'
        : 'SHOOT: OFF';
      this.shootButton.dataset['enabled'] = this.shootEnabled
        ? 'true'
        : 'false';
    }
  }

  // ── Test accessors ───────────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  getRaiders(): Raider[] {
    return [...this.raiders];
  }

  getHud(): HUD | null {
    return this.hud;
  }

  getPanel(): HTMLDivElement | null {
    return this.panel;
  }

  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined {
    return this.cursors;
  }

  getWasd(): WasdKeysLike | undefined {
    return this.wasd;
  }
}
