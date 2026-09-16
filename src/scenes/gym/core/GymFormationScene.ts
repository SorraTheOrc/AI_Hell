/**
 * Shared gym formation-scene base class (refactor of E1–E3 boilerplate).
 *
 * The first three enemy gym scenes (`GymScout`, `GymDiver`, `GymTank`)
 * were built independently and duplicated ~200 lines each: formation
 * spawn loop, EXPLODE/SHOOT HUD buttons, status line, hint line,
 * back-to-index button, formation drift + respawn, per-entity
 * `applyFormationPosition` updates, and bullet collection/advance/
 * off-screen removal. This base class encapsulates all of that; each
 * concrete scene supplies only its entity-specific configuration via
 * {@link EnemyFormationConfig}.
 *
 * **Discovery note:** this file lives in the `core/` subfolder, so the
 * gym index glob (`src/scenes/gym/*.ts`) never lists it as a scene.
 */

import Phaser from 'phaser';

import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
  PLAYER_RESPAWN_INVULNERABLE,
  POWER_UP_DROP_SIZE,
  SHIP_COLOR,
  SHIP_SIZE,
} from '../../../core/constants';
import {
  playDestructionSound,
  playSpawnSound,
} from '../../../audio/effects';
import { addBackToIndexButton } from '../../../utils/gymNavigation';
import { FormationOffset } from '../../../utils/formations';
import { Player } from '../../../entities/Player';
import {
  PlayerBullet,
  advanceAndCull,
  createPlayerBullet,
} from '../../../entities/PlayerBullet';
import {
  angleToVelocity,
  createBulletsFromHeading,
} from '../../../utils/weapons';
import {
  WasdKeysLike,
} from '../../../utils/input';
import {
  resolvePatterns,
  spawnExplosionParticles,
} from '../../../vfx/explosionParticles';
import {
  AsteroidsInputHandler,
  ControlInput,
  FourDirectionalInputHandler,
} from '../../../utils/movementModel';
import {
  loadRules,
  POWER_UP_WEIGHT_IDS,
  type PowerUpWeights,
} from '../../../core/rules';
import { drawPowerUpDrop } from '../../../powerups/icons';
import { PowerUp, PowerUpState } from '../../../powerups/PowerUp';
import {
  RandomAvoidingPlacement,
  type PlacementContext,
  type PowerUpPlacement,
} from '../../../powerups/placement';
import {
  WeightedRandomSpawner,
  type PowerUpSpawner,
} from '../../../powerups/spawner';
import { getPowerUpById, type PowerUpId } from '../../../powerups/types';

/** Contract an enemy entity must satisfy to be driven by the base scene. */
export interface FormationSceneEntity extends Phaser.GameObjects.GameObject {
  /** World-space position (set via `applyFormationPosition`/`setPosition`). */
  x: number;
  y: number;
  /** False once the entity is destroyed (explosion playing). */
  readonly alive: boolean;
  /** Whether the entity currently fires (Level 4+ behaviour toggle). */
  shootEnabled: boolean;
  /** The entity's slot within the formation. */
  readonly offset: FormationOffset;
  /** Destroys the entity: hides the body, plays the explosion animation. */
  destroySelf(): void;
  /**
   * Applies the formation translation for this frame: base + offset
   * (+ any entity-specific animation, e.g. wiggle/dive).
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    dt: number,
    spacingX: number,
    spacingY: number,
  ): void;
  /**
   * Optional: receives the player's live world position so aimed fire
   * (Scout shots, Diver dives, Swarm bursts, Phaser patterns) targets the
   * player each frame instead of the fixed bottom-centre stand-in.
   * Entities that don't aim (e.g. Tank, test stubs) simply omit it — the
   * scene skips the call via optional chaining.
   */
  setAimTarget?(x: number, y: number): void;
  /**
   * Optional: plays the entity-specific destruction sound. When present
   * the base scene prefers it over the shared `playDestructionSound()`,
   * so the entity's destruction sound plays exactly once (no double-play).
   * Entities that omit it fall through to the shared destruction sound,
   * preserving backward-compatible behaviour for Scout / Tank / Swarm /
   * Phaser.
   */
  playDestructionAudio?(): void;
  /**
   * Optional multi-hit damage seam (Boss, GDD §4.3). When present,
   * player-bullet collisions delegate to this instead of `destroySelf()`
   * so the entity can decrement phased health and only self-destruct
   * when depleted. The entity must handle its own SFX/visuals and
   * `alive` flag; the base scene consumes the bullet and skips the
   * generic destruction sound.
   */
  takeDamage?(): number | void;
  /**
   * Hit radius (px) used for circle-vs-circle collision checks.
   *
   * Each entity returns a value proportional to its visual half-size
   * plus `HIT_RADIUS_BUFFER_PX`, so the hit circle matches the visual
   * bounds rather than using the flat default.
   */
  getHitRadius(): number;
}

/** Contract a bullet must satisfy for the base scene to own its lifecycle. */
export interface FormationSceneBullet {
  /** The drawn shape — the base scene advances its x/y position. */
  readonly graphics: Phaser.GameObjects.Graphics;
  /** Horizontal speed (px/s). */
  vx: number;
  /** Vertical speed (px/s). */
  vy: number;
}

/**
 * Optional player component for a formation scene. When present, the
 * scene spawns the keyboard-controlled `Player` ship (arrows + WASD)
 * at this position and auto-fires its equipped weapon toward the
 * direction of travel — see `EnemyFormationConfig.player`.
 */
export interface PlayerFormationConfig {
  /** Initial spawn x (px). */
  x: number;
  /** Initial spawn y (px). */
  y: number;
}

/** Optional power-up layer configuration for a formation scene. */
export interface PowerUpLayerConfig {
  /**
   * Injectable ID spawner. Defaults to a `WeightedRandomSpawner` over
   * P3–P9 using the game-rules weights.
   */
  spawner?: PowerUpSpawner<PowerUpId>;
  /**
   * Injectable placement strategy. Defaults to `RandomAvoidingPlacement`
   * (seeded from `rng`).
   */
  placement?: PowerUpPlacement;
  /** Injectable RNG used to build the default spawner and placement. */
  rng?: () => number;
  /**
   * Seconds between spawns. Defaults to the interval from the game-rules
   * config (`loadRules().powerUpSpawnInterval`).
   */
  spawnInterval?: number;
  /** Minimum distance from the screen edge for a drop (px). */
  margin?: number;
}

/** A live power-up drop owned by the scene. */
export interface FormationSceneDrop {
  /** The drop's grow → hold → shrink → despawn lifecycle. */
  powerUp: PowerUp;
  /** The power-up ID. */
  id: PowerUpId;
  /** Fixed world-space position at spawn time (px). */
  x: number;
  y: number;
  /** The drawn bubble + icon. */
  graphics: Phaser.GameObjects.Graphics;
}

/** Per-scene configuration for a formation gym scene. */
export interface EnemyFormationConfig<
  TEntity extends FormationSceneEntity,
  TBullet extends FormationSceneBullet,
> {
  /** Phaser scene key, e.g. `GymScout`. */
  sceneKey: string;
  /** Builds the formation offsets for `count` enemies (spawn order). */
  buildOffsets(count: number): FormationOffset[];
  /** Number of enemies in the formation. */
  count: number;
  /** Horizontal spacing between columns (px). */
  spacingX: number;
  /** Vertical spacing between rows (px). */
  spacingY: number;
  /** Forward (rightward) drift speed of the whole formation (px/s). */
  driftSpeed: number;
  /** Initial formation base x. */
  startX: number;
  /** Initial formation base y. */
  startY: number;
  /** Status-line label, e.g. `scouts`. */
  statusLabel: string;
  /** Bottom hint line, e.g. `E1 Scout gym — V-formation demo`. */
  hintText: string;
  /**
   * Optional player spawn — when set, the scene adds a keyboard-
   * controlled `Player` ship (arrows + WASD) with auto-fire in the
   * direction of travel. Omit to keep the scene enemy-only.
   */
  player?: PlayerFormationConfig;
  /**
   * Hit radius (px) of each enemy entity used for player-bullet vs
   * entity collisions. Defaults to {@link DEFAULT_ENTITY_HIT_RADIUS}.
   */
  entityHitRadius?: number;
  /**
   * Hit radius (px) of enemy bullets used for bullet-vs-bullet and
   * bullet-vs-player collisions. Defaults to
   * {@link DEFAULT_BULLET_HIT_RADIUS}.
   */
  bulletHitRadius?: number;
  /**
   * Opt-in power-up layer. When present, the scene spawns power-up drops
   * (one at a time) on the configured interval, choosing the ID through a
   * `PowerUpSpawner` and the position through a `PowerUpPlacement`.
   */
  powerUps?: PowerUpLayerConfig;
  /** Creates one enemy at the given absolute position with its offset. */
  createEntity(
    scene: Phaser.Scene,
    x: number,
    y: number,
    offset: FormationOffset,
  ): TEntity;
  /** Collects any bullets the entity fires this frame (empty if none). */
  collectBullets(entity: TEntity, now: number): TBullet[];
}

/** Monospace neon HUD button style (matches the existing gym HUD). */
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#00ff00',
  backgroundColor: '#1a1a1a',
  padding: { x: 8, y: 4 },
};

/** Default hit radius (px) of an enemy entity when no config is given. */
const DEFAULT_ENTITY_HIT_RADIUS = 20;

/** Default hit radius (px) of an enemy bullet when no config is given. */
const DEFAULT_BULLET_HIT_RADIUS = 6;

/** Default placement margin (px) from the screen edge for power-up drops. */
const DEFAULT_POWER_UP_PLACEMENT_MARGIN = 24;

/** Blink half-period (s) while the player is invulnerable after a hit. */
const PLAYER_BLINK_INTERVAL = 0.1;

/** Wipe → respawn countdown (s) — visible centred text, deterministic via tick(dt). */
const RESPAWN_COUNTDOWN_SECONDS = 3;

/** Style for the centred respawn countdown overlay. */
const COUNTDOWN_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '24px',
  color: '#ffffff',
  backgroundColor: '#000000',
  padding: { x: 12, y: 8 },
};

/**
 * Generic formation gym scene. Parameterised by entity + bullet types so
 * concrete scenes keep fully-typed accessors (`formationScouts` etc.).
 */
export class GymFormationScene<
  TEntity extends FormationSceneEntity,
  TBullet extends FormationSceneBullet,
> extends Phaser.Scene {
  protected config: EnemyFormationConfig<TEntity, TBullet>;

  protected entities: TEntity[] = [];
  protected bullets: TBullet[] = [];

  /** Keyboard-controlled player ship (null unless `config.player` set). */
  protected player: Player | null = null;
  /** Player bullets in flight (auto-fired toward the direction of travel). */
  protected playerBullets: PlayerBullet[] = [];

  // Player hit/respawn state (only meaningful when `config.player` set).
  private playerSpawnX = 0;
  private playerSpawnY = 0;
  private playerHitCount = 0;
  /** Seconds of invulnerability remaining after a hit (blinks while > 0). */
  private playerInvulnerable = 0;
  private playerBlinkPhase = 0;
  /** Active player-explosion VFX graphics (for observation in tests). */
  private playerExplosions: Phaser.GameObjects.Graphics[] = [];

  protected formationBaseX: number;
  protected formationBaseY: number;
  private shootEnabled = false;

  // Wipe → 3s countdown → respawn lifecycle (core-library owned, AH-0MTFXKA5Q003LBH5).
  private respawnCountdown = 0;
  private respawnCountdownActive = false;
  private countdownText: Phaser.GameObjects.Text | null = null;

  // Arrow-key (cursor) and WASD bindings for the player ship.
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;
  /** Pluggable input handlers (one per control scheme, mirrors GymPlayer). */
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();

  // UI toggles
  protected shootButton!: Phaser.GameObjects.Text;
  protected explodeButton!: Phaser.GameObjects.Text;
  protected statusText!: Phaser.GameObjects.Text;

  // Power-up layer (opt-in via `config.powerUps`).
  private powerUpsEnabled = false;
  private powerUpDrops: FormationSceneDrop[] = [];
  private powerUpSpawner: PowerUpSpawner<PowerUpId> | null = null;
  private powerUpPlacement: PowerUpPlacement | null = null;
  private powerUpSpawnInterval = 0;
  private powerUpSpawnTimer = 0;
  private powerUpPlacementMargin = DEFAULT_POWER_UP_PLACEMENT_MARGIN;
  private powerUpSpawnCount = 0;

  constructor(config: EnemyFormationConfig<TEntity, TBullet>) {
    super({ key: config.sceneKey });
    this.config = config;
    this.formationBaseX = config.startX;
    this.formationBaseY = config.startY;
  }

  create(): void {
    const { config } = this;

    // ── Spawn the formation ─────────────────────────────────────────
    const offsets = config.buildOffsets(config.count);
    for (const offset of offsets) {
      const entity = config.createEntity(
        this,
        this.formationBaseX + offset.col * config.spacingX,
        this.formationBaseY + offset.row * config.spacingY,
        offset,
      );
      // Containers are not auto-added to the display list — without this
      // the enemies would never render (project convention, see Gym.ts).
      this.add.existing(entity);
      this.entities.push(entity);
    }
    playSpawnSound();

    // ── Player ship (optional per-scene opt-in) ────────────────────
    if (config.player) {
      this.player = new Player(this, {
        x: config.player.x,
        y: config.player.y,
      });
      this.playerSpawnX = config.player.x;
      this.playerSpawnY = config.player.y;
      // Graphics objects are not auto-added to the display list either.
      this.add.existing(this.player);
      this.cursors = this.input.keyboard?.createCursorKeys();
      this.wasd = this.input.keyboard?.addKeys(
        'W,A,S,D',
      ) as WasdKeysLike | undefined;
    }

    // ── Controls (bottom-left HUD, minimal) ─────────────────────────
    this.explodeButton = this._addButton(10, GAME_HEIGHT - 60, 'EXPLODE', LABEL_STYLE);
    this.shootButton = this._addButton(120, GAME_HEIGHT - 60, 'SHOOT: OFF', LABEL_STYLE);

    this.explodeButton.on('pointerdown', () => this.explodeRandom());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(
      10,
      GAME_HEIGHT - 36,
      `SCORE: n/a — ${config.statusLabel}: ${this.entities.length}`,
      {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#888888',
      },
    );

    // ── Hint line ───────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, config.hintText, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#555555',
    }).setOrigin(0.5);

    // ── Back to gym index ───────────────────────────────────────────
    addBackToIndexButton(this);

    // ── Optional power-up layer (opt-in via config.powerUps) ────────
    this._initPowerUpLayer();

    // Ensure any stale countdown state from a prior create() (e.g. after
    // a manual _onRespawn that rebuilt the formation) is cleared so a
    // fresh scene never starts mid-countdown.
    this._cancelRespawnCountdown();

    // Clean up the countdown overlay if the scene is torn down
    // mid-countdown so a restart does not leak or double-fire.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this._cancelRespawnCountdown();
      // The countdown overlay Text is a display-list child destroyed by the
      // DisplayList shutdown; drop the reference so a restart's respawn
      // creates a fresh overlay on the new display list.
      this.countdownText = null;
      // ── Full teardown: destroy and clear all scene-owned objects ──
      // This prevents stale references from being iterated after a
      // stop/restart of the same scene instance (the only restart
      // vector in the gym index flow).  Phaser's DisplayList.shutdown
      // already sets each display-list child's `scene = undefined`,
      // but the bookkeeping arrays (`entities`, `bullets`,
      // `playerBullets`) are never cleared — on a fresh create() they
      // are populated again on top of the stale array, so tick() now
      // iterates destroyed objects whose `scene` property is
      // undefined.  Destroying them explicitly and clearing the arrays
      // avoids that double-population.
      for (const entity of this.entities) entity.destroy(true);
      this.entities.length = 0;

      for (const bullet of this.bullets) bullet.graphics.destroy();
      this.bullets.length = 0;

      for (const pb of this.playerBullets) pb.destroy();
      this.playerBullets.length = 0;

      for (const exp of this.playerExplosions) exp.destroy();
      this.playerExplosions.length = 0;

      // Null-out the player reference so any stale callback does not
      // reach the destroyed ship.
      this.player = null;

      // Reset scene toggle state so a fresh create() starts clean.
      this.shootEnabled = false;

      // Tear down any power-up drops owned by the scene.
      for (const drop of this.powerUpDrops) drop.graphics.destroy();
      this.powerUpDrops = [];
      this.powerUpSpawnCount = 0;
    });
  }

  // ── Button helpers ───────────────────────────────────────────────

  protected _addButton(
    x: number,
    y: number,
    label: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const button = this.add.text(x, y, label, style);
    button.setInteractive({ useHandCursor: true });
    return button;
  }

  /** Destroys a random surviving enemy with an explosion animation. */
  explodeRandom(): void {
    const alive = this.entities.filter((e) => e.alive);
    if (alive.length === 0) return;
    const victim = alive[Math.floor(Math.random() * alive.length)];
    victim.destroySelf();
    if (victim.playDestructionAudio) {
      victim.playDestructionAudio();
    } else {
      playDestructionSound();
    }
    this.statusText.setText(
      `exploded: ${victim.offset.row}:${victim.offset.col} — ${this.config.statusLabel}: ${this.aliveCount}`,
    );
  }

  /** Toggles firing for the whole formation. */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const entity of this.entities) entity.shootEnabled = this.shootEnabled;
    this.shootButton.setText(this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF');
  }

  // ── Power-up layer (spawning, cadence, placement) ────────────────

  /** Initialises the opt-in power-up layer and spawns the first drop. */
  private _initPowerUpLayer(): void {
    const cfg = this.config.powerUps;
    if (!cfg) {
      this.powerUpsEnabled = false;
      return;
    }

    this.powerUpsEnabled = true;
    const rules = loadRules();
    const rng = cfg.rng ?? Math.random;

    this.powerUpPlacement =
      cfg.placement ?? new RandomAvoidingPlacement({ rng });
    this.powerUpSpawner =
      cfg.spawner ?? this._buildDefaultPowerUpSpawner(rules.powerUpWeights, rng);
    this.powerUpSpawnInterval =
      cfg.spawnInterval ?? rules.powerUpSpawnInterval;
    this.powerUpPlacementMargin =
      cfg.margin ?? DEFAULT_POWER_UP_PLACEMENT_MARGIN;
    this.powerUpSpawnTimer = this.powerUpSpawnInterval;

    // One drop on screen immediately so the layer is observable at boot.
    this._spawnPowerUpDrop();
  }

  /** Builds the default weighted-random spawner from the rules weights. */
  private _buildDefaultPowerUpSpawner(
    weights: PowerUpWeights,
    rng: () => number,
  ): PowerUpSpawner<PowerUpId> {
    const spawner = new WeightedRandomSpawner([...POWER_UP_WEIGHT_IDS], rng);
    for (const id of POWER_UP_WEIGHT_IDS) {
      spawner.setWeight(id, weights[id]);
    }
    return spawner;
  }

  /** Snapshot of the live bodies a drop must avoid (enemies + player). */
  private _powerUpPlacementContext(): PlacementContext {
    const enemies = this.entities
      .filter((entity) => entity.alive)
      .map((entity) => ({
        x: entity.x,
        y: entity.y,
        radius: entity.getHitRadius(),
      }));
    const player = this.player
      ? { x: this.player.x, y: this.player.y, radius: SHIP_SIZE / 2 }
      : { x: -1e6, y: -1e6, radius: 0 };

    return {
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      margin: this.powerUpPlacementMargin,
      dropRadius: POWER_UP_DROP_SIZE,
      enemies,
      player,
    };
  }

  /** Spawns one drop at a placement-strategy position. */
  private _spawnPowerUpDrop(): void {
    if (
      !this.powerUpsEnabled ||
      !this.powerUpSpawner ||
      !this.powerUpPlacement
    ) {
      return;
    }

    const id = this.powerUpSpawner.next();
    const { x, y } = this.powerUpPlacement.place(
      this._powerUpPlacementContext(),
    );

    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    drawPowerUpDrop(graphics, getPowerUpById(id).type, 0, 0, POWER_UP_DROP_SIZE);
    graphics.setScale(0);

    this.powerUpDrops.push({
      powerUp: new PowerUp(id),
      id,
      x,
      y,
      graphics,
    });
    this.powerUpSpawnCount += 1;
  }

  /**
   * Advances every drop's lifecycle and spawns the next drop when the
   * configured interval has elapsed and no previous drop is still live
   * (one drop on screen at a time).
   */
  private _updatePowerUpLayer(dt: number): void {
    if (!this.powerUpsEnabled) return;

    const kept: FormationSceneDrop[] = [];
    for (const drop of this.powerUpDrops) {
      drop.powerUp.advance(dt);
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state !== PowerUpState.DESPAWNED) {
        kept.push(drop);
      } else {
        drop.graphics.destroy();
      }
    }
    this.powerUpDrops = kept;

    this.powerUpSpawnTimer -= dt;
    if (this.powerUpSpawnTimer <= 0 && this.powerUpDrops.length === 0) {
      this._spawnPowerUpDrop();
      this.powerUpSpawnTimer = this.powerUpSpawnInterval;
    }
  }

  // ── Public test accessors ────────────────────────────────────────

  /** All enemies in the scene (alive or destroyed). */
  get formationEntities(): TEntity[] {
    return this.entities.slice();
  }

  /** Number of enemies still alive. */
  get aliveCount(): number {
    return this.entities.filter((e) => e.alive).length;
  }

  /** Whether firing is currently enabled. */
  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  /** True while the wipe → respawn countdown is active. */
  isRespawnCountdownActive(): boolean {
    return this.respawnCountdownActive;
  }

  /** Seconds remaining on the respawn countdown (0 when inactive). */
  getRespawnCountdownRemaining(): number {
    return this.respawnCountdownActive ? Math.max(0, this.respawnCountdown) : 0;
  }

  /** The centred countdown overlay text (null when not active / not yet created). */
  getRespawnCountdownText(): Phaser.GameObjects.Text | null {
    return this.countdownText;
  }

  /** Bullets currently in flight. */
  get activeBullets(): TBullet[] {
    return this.bullets.slice();
  }

  /** Current formation base x (for shape verification). */
  get formationX(): number {
    return this.formationBaseX;
  }

  /** Current formation base y. */
  get formationY(): number {
    return this.formationBaseY;
  }

  /** The player ship (null when the config omitted `player`). */
  getPlayer(): Player | null {
    return this.player;
  }

  /** Whether the opt-in power-up layer is active for this scene. */
  isPowerUpLayerEnabled(): boolean {
    return this.powerUpsEnabled;
  }

  /** The live power-up drops currently on screen. */
  getPowerUpDrops(): FormationSceneDrop[] {
    return [...this.powerUpDrops];
  }

  /** Cumulative number of drops spawned since the scene started. */
  getPowerUpSpawnCount(): number {
    return this.powerUpSpawnCount;
  }

  /** The configured seconds between spawns. */
  getPowerUpSpawnInterval(): number {
    return this.powerUpSpawnInterval;
  }

  /** The active ID spawner (null when the layer is disabled). */
  getPowerUpSpawner(): PowerUpSpawner<PowerUpId> | null {
    return this.powerUpSpawner;
  }

  /** Replaces the ID spawner (used by tests and live controls). */
  setPowerUpSpawner(spawner: PowerUpSpawner<PowerUpId>): void {
    this.powerUpSpawner = spawner;
  }

  /** The active placement strategy (null when the layer is disabled). */
  getPowerUpPlacement(): PowerUpPlacement | null {
    return this.powerUpPlacement;
  }

  /** Replaces the placement strategy (used by tests). */
  setPowerUpPlacement(placement: PowerUpPlacement): void {
    this.powerUpPlacement = placement;
  }

  /**
   * Updates the spawn interval (seconds). Ignored when not a positive
   * finite value. The next spawn uses the new cadence.
   */
  setPowerUpSpawnInterval(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.powerUpSpawnInterval = seconds;
    this.powerUpSpawnTimer = seconds;
  }

  /** Player bullets currently in flight. */
  getPlayerBullets(): PlayerBullet[] {
    return this.playerBullets.slice();
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

  /** True while the player is invulnerable (blinking) after a respawn. */
  isPlayerInvulnerable(): boolean {
    return this.playerInvulnerable > 0;
  }

  /** Seconds of invulnerability remaining (0 once the blink ends). */
  getPlayerInvulnerableRemaining(): number {
    return Math.max(0, this.playerInvulnerable);
  }

  /** Active player-explosion VFX graphics (empty once the tweens end). */
  getPlayerExplosions(): Phaser.GameObjects.Graphics[] {
    return this.playerExplosions.slice();
  }

  /** Hit radius (px) used for player-bullet vs entity collisions. */
  getEntityHitRadius(): number {
    return this.config.entityHitRadius ?? DEFAULT_ENTITY_HIT_RADIUS;
  }

  /** Hit radius (px) used for enemy-bullet collision checks. */
  getBulletHitRadius(): number {
    return this.config.bulletHitRadius ?? DEFAULT_BULLET_HIT_RADIUS;
  }

  /**
   * Spawns a player bullet at (x, y) travelling at (vx, vy) px/s.
   * Used by `_autoFire` and by tests to place bullets deterministically.
   */
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
    color = 0x00ffff,
  ): PlayerBullet {
    const bullet = createPlayerBullet(
      this,
      x,
      y,
      color,
      PLAYER_BULLET_RADIUS,
      vx,
      vy,
    );
    this.playerBullets.push(bullet);
    return bullet;
  }

  // ── Scene update loop ────────────────────────────────────────────

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives the formation
   * drift, per-entity positioning, enemy bullet lifecycle, and (when
   * `config.player` is set) the player ship: input → thrust, auto-fire
   * in the direction of travel, and player-bullet lifecycle. Called by
   * Phaser's `update` and by tests.
   */
  tick(dt: number): void {
    const { config } = this;

    // Advance the formation base; when the whole formation has crossed
    // the right edge, respawn it off the left edge so it flies again.
    this.formationBaseX += config.driftSpeed * dt;
    if (this.formationBaseX > GAME_WIDTH + 60) {
      this.formationBaseX = this._respawnX();
    }

    // Position each enemy from the formation base + its own offset.
    for (const entity of this.entities) {
      entity.applyFormationPosition(
        this.formationBaseX,
        this.formationBaseY,
        dt,
        config.spacingX,
        config.spacingY,
      );

      // Live aim tracking: when a player is on screen, push its current
      // position so aimed enemies target the player this frame (instead of
      // the fixed stand-in). Entities without the seam are skipped.
      if (this.player) {
        entity.setAimTarget?.(this.player.x, this.player.y);
      }

      // Collect any bullets the entity fired this frame (uses the fresh aim).
      this.bullets.push(...config.collectBullets(entity, this.time.now));
    }

    // Advance bullets; remove any that leave the screen.
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.graphics.x += bullet.vx * dt;
      bullet.graphics.y += bullet.vy * dt;
      if (this._bulletOffScreen(bullet.graphics)) {
        bullet.graphics.destroy();
        this.bullets.splice(i, 1);
      }
    }

    // ── Player ship: input → thrust, auto-fire, bullet lifecycle ──
    if (this.player) {
      const input = this._readPlayerInput();
      if (input) this.player.setInput(input);
      this.player.physicsTick(dt, this.scale.width, this.scale.height);
      this._autoFire(dt);
      this._advancePlayerBullets(dt);

      // Collisions + post-hit invulnerability blink (player component only).
      this._handleCollisions();
      this._updatePlayerInvulnerability(dt);
    }

    // ── Optional power-up layer: cadence + drop lifecycles ───────────
    this._updatePowerUpLayer(dt);

    // ── Wipe detection → 3s countdown → formation respawn ───────────
    this._tickRespawnCountdown(dt);
  }

  /**
   * Reads the held arrow/WASD keys into the scheme-appropriate
   * `ControlInput` contract, keyed off the player's saved control scheme
   * (mirrors GymPlayer._readInput — parent AC3). An asteroids-scheme
   * player receives `{ forward, turnLeft, turnRight }`; a
   * 4-directional-scheme player receives `{ up, down, left, right }`.
   */
  private _readPlayerInput(): ControlInput | null {
    if (!this.player || !this.cursors || !this.wasd) return null;
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return this.player.getScheme() === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
  }

  /**
   * Auto-fires every active weapon toward the direction of travel when
   * its cooldown has elapsed (mirrors GymWeapons' auto-fire). Combat
   * scenes only ever have the permanent cannon active, so behaviour is
   * unchanged: one cannon volley per 400 ms cycle.
   */
  private _autoFire(dt: number): void {
    if (!this.player) return;
    const firedWeapons = this.player.tryFire(dt);
    if (firedWeapons.length === 0) return;

    const headingDeg = (this.player.getHeading() * 180) / Math.PI;
    for (const weaponId of firedWeapons) {
      const weaponDef = this.player.getWeaponDef(weaponId);
      const bulletDescs = createBulletsFromHeading(
        weaponDef,
        headingDeg,
        this.player.x,
        this.player.y,
      );

      for (const bd of bulletDescs) {
        const vel = angleToVelocity(bd.angleDeg, PLAYER_BULLET_SPEED);
        this.spawnPlayerBullet(bd.x, bd.y, vel.vx, vel.vy, bd.color);
      }
    }
  }

  /** Advances player bullets and removes any that leave the screen. */
  private _advancePlayerBullets(dt: number): void {
    this.playerBullets = this.playerBullets.filter((b) =>
      advanceAndCull(b, dt, this.scale.width, this.scale.height),
    );
  }

  protected _bulletOffScreen(g: Phaser.GameObjects.Graphics): boolean {
    return (
      g.x < -20 ||
      g.x > GAME_WIDTH + 20 ||
      g.y < -20 ||
      g.y > GAME_HEIGHT + 20
    );
  }

  /**
   * Circle-vs-circle collision test using manual distance checks
   * (`Math.hypot <= rA + rB`), consistent with `GymWeapons._overlapsShip`.
   */
  private _collide(
    ax: number,
    ay: number,
    aRadius: number,
    bx: number,
    by: number,
    bRadius: number,
  ): boolean {
    return Math.hypot(ax - bx, ay - by) <= aRadius + bRadius;
  }

  /**
   * Resolves player-component collisions (only runs when `config.player`
   * is set, so enemy-only scenes behave exactly as before):
   * player bullets vs enemies, player bullets vs enemy bullets, and
   * enemy bullets vs the player ship (hit → respawn + invulnerability).
   */
  private _handleCollisions(): void {
    if (!this.player) return;

    const bulletHitRadius = this.getBulletHitRadius();
    const playerHull = SHIP_SIZE / 2;

    // 1. Player bullets vs enemy entities: damage the enemy, consume
    //    the bullet. Multi-hit entities (Boss, GDD §4.3) expose
    //    `takeDamage()` — each hit decrements one phase and only
    //    destroys on the final phase. Single-HP enemies fall through
    //    to `destroySelf()`. Rebuild the list so consumed bullets are dropped.
    const keptPlayerBullets: PlayerBullet[] = [];
    for (const pb of this.playerBullets) {
      let spent = false;
      for (const entity of this.entities) {
        if (!entity.alive) continue;
        if (
          this._collide(
            pb.x,
            pb.y,
            PLAYER_BULLET_RADIUS,
            entity.x,
            entity.y,
            entity.getHitRadius(),
          )
        ) {
          if (entity.takeDamage) {
            // Multi-hit path (Boss): entity owns health, phase
            // transition, and SFX — base scene only consumes the bullet.
            entity.takeDamage();
          } else {
            entity.destroySelf();
            if (entity.playDestructionAudio) {
              entity.playDestructionAudio();
            } else {
              playDestructionSound();
            }
          }
          pb.destroy();
          spent = true;
          break;
        }
      }
      if (!spent) keptPlayerBullets.push(pb);
    }
    this.playerBullets = keptPlayerBullets;

    // 2. Player bullets vs enemy bullets: both are destroyed.
    const destroyedEnemyBullets: TBullet[] = [];
    const keptPlayerBullets2: PlayerBullet[] = [];
    for (const pb of this.playerBullets) {
      let spent = false;
      for (const eb of this.bullets) {
        if (
          this._collide(
            pb.x,
            pb.y,
            PLAYER_BULLET_RADIUS,
            eb.graphics.x,
            eb.graphics.y,
            bulletHitRadius,
          )
        ) {
          eb.graphics.destroy();
          destroyedEnemyBullets.push(eb);
          pb.destroy();
          spent = true;
          break;
        }
      }
      if (!spent) keptPlayerBullets2.push(pb);
    }
    this.playerBullets = keptPlayerBullets2;
    this.bullets = this.bullets.filter(
      (b) => !destroyedEnemyBullets.includes(b),
    );

    // 3. Enemy bullets vs player: hit → explosion VFX/SFX + respawn at
    //    spawn point + invulnerability blink. The player is never
    //    destroyed (infinite lives, no score/game-over changes).
    const keptEnemyBullets: TBullet[] = [];
    for (const eb of this.bullets) {
      if (
        this.playerInvulnerable <= 0 &&
        this._collide(
          eb.graphics.x,
          eb.graphics.y,
          bulletHitRadius,
          this.player.x,
          this.player.y,
          playerHull,
        )
      ) {
        this._hitPlayer();
        eb.graphics.destroy();
      } else {
        keptEnemyBullets.push(eb);
      }
    }
    this.bullets = keptEnemyBullets;

    // 4. Player body vs enemy body: when the player ship overlaps an
    //    enemy entity, the enemy is destroyed and the player is hit
    //    (explosion VFX/SFX + respawn + invulnerability). Skipped if
    //    the player is currently invulnerable.
    if (this.playerInvulnerable <= 0) {
      for (const entity of this.entities) {
        if (!entity.alive) continue;
        if (
          this._collide(
            this.player.x,
            this.player.y,
            playerHull,
            entity.x,
            entity.y,
            entity.getHitRadius(),
          )
        ) {
          entity.destroySelf();
          // Only play the entity-specific destruction audio (if any).
          // The generic destruction sound is already played by
          // _hitPlayer(), so we avoid double-play.
          if (entity.playDestructionAudio) {
            entity.playDestructionAudio();
          }
          this._hitPlayer();
          break;
        }
      }
    }
  }

  /**
   * Player hit: records the hit, plays the destruction sound, spawns the
   * explosion VFX at the ship position, respawns the player at the spawn
   * point with a short invulnerability window, and resets the blink phase.
   */
  private _hitPlayer(): void {
    if (!this.player) return;
    this.playerHitCount += 1;
    playDestructionSound();
    this._spawnPlayerExplosion(this.player.x, this.player.y);
    this.player.respawn(this.playerSpawnX, this.playerSpawnY);
    this.playerInvulnerable = PLAYER_RESPAWN_INVULNERABLE;
    this.playerBlinkPhase = 0;
    this.player.setAlpha(1);
  }

  /**
   * Counts down invulnerability and blinks the ship's alpha every
   * half blink-interval; restores full alpha once the window ends.
   */
  private _updatePlayerInvulnerability(dt: number): void {
    if (!this.player || this.playerInvulnerable <= 0) return;
    this.playerInvulnerable = Math.max(0, this.playerInvulnerable - dt);
    this.playerBlinkPhase += dt;
    const visible =
      Math.floor(this.playerBlinkPhase / PLAYER_BLINK_INTERVAL) % 2 === 0;
    this.player.setAlpha(visible ? 1 : 0.3);
    if (this.playerInvulnerable <= 0) this.player.setAlpha(1);
  }

  /**
   * Spawns the player-death particle burst at (x, y) — the player
   * equivalent of an entity `playExplosion()`. Colours are tinted around
   * `SHIP_COLOR` and the burst scales with `SHIP_SIZE`; the Graphics are
   * tracked in `playerExplosions` so the SHUTDOWN handler (and tests) see
   * them without pixel assertions, and the helper unregisters them on
   * completion.
   */
  private _spawnPlayerExplosion(x: number, y: number): void {
    spawnExplosionParticles(this, x, y, SHIP_COLOR, SHIP_SIZE, {
      patterns: resolvePatterns('player'),
      registry: this.playerExplosions,
    });
  }

  // ── Wipe → 3s countdown → respawn lifecycle (AH-0MTFXKA5Q003LBH5) ─

  private _startRespawnCountdown(): void {
    this.respawnCountdownActive = true;
    this.respawnCountdown = RESPAWN_COUNTDOWN_SECONDS;
    if (!this.countdownText) {
      this.countdownText = this.add
        .text(
          GAME_WIDTH / 2,
          GAME_HEIGHT / 2,
          this._countdownLabel(),
          COUNTDOWN_STYLE,
        )
        .setOrigin(0.5)
        .setDepth(100);
    } else {
      this.countdownText.setVisible(true);
    }
    this.countdownText.setText(this._countdownLabel());
  }

  private _countdownLabel(): string {
    const n = Math.max(1, Math.ceil(this.respawnCountdown));
    return `Respawning in ${n}...`;
  }

  private _cancelRespawnCountdown(): void {
    this.respawnCountdownActive = false;
    this.respawnCountdown = 0;
    if (this.countdownText) {
      this.countdownText.setVisible(false);
    }
  }

  private _tickRespawnCountdown(dt: number): void {
    // No formation → nothing to wipe.
    if (this.entities.length === 0) return;

    if (this.respawnCountdownActive) {
      this.respawnCountdown = Math.max(0, this.respawnCountdown - dt);
      if (this.countdownText) {
        this.countdownText.setText(
          this.respawnCountdown <= 0 ? 'Respawning...' : this._countdownLabel(),
        );
      }
      if (this.respawnCountdown <= 0) {
        this._respawnFormation();
      }
      return;
    }

    // Wipe signal: every entity is no longer alive (mid-explosion counts
    // as killed, per `alive === false` after `destroySelf()`).
    if (this.aliveCount === 0) {
      this._startRespawnCountdown();
    }
  }

  private _respawnFormation(): void {
    // Clear enemy bullets so a stale shot does not instantly hit the player
    // after the respawn. Player bullets are intentionally kept.
    for (const bullet of this.bullets) bullet.graphics.destroy();
    this.bullets.length = 0;

    // Tear down the old (dead) entities and recreate the formation at its
    // initial geometry, matching the initial create() path.
    const wasShooting = this.shootEnabled;
    for (const entity of this.entities) entity.destroy();
    this.entities.length = 0;
    this.formationBaseX = this.config.startX;
    this.formationBaseY = this.config.startY;
    const offsets = this.config.buildOffsets(this.config.count);
    for (const offset of offsets) {
      const entity = this.config.createEntity(
        this,
        this.formationBaseX + offset.col * this.config.spacingX,
        this.formationBaseY + offset.row * this.config.spacingY,
        offset,
      );
      this.add.existing(entity);
      this.entities.push(entity);
    }
    // Preserve SHOOT toggle across the respawn (no surprise toggle).
    for (const entity of this.entities) entity.shootEnabled = wasShooting;

    this._cancelRespawnCountdown();
    if (this.countdownText) this.countdownText.setVisible(false);
    this.statusText?.setText(
      `SCORE: n/a — ${this.config.statusLabel}: ${this.entities.length}`,
    );
    playSpawnSound();
  }

  /** x-coordinate that puts the whole formation off the left edge. */
  private _respawnX(): number {
    const maxAbsCol = Math.max(
      ...this.entities.map((e) => Math.abs(e.offset.col)),
      0,
    );
    return -maxAbsCol * this.config.spacingX - 40;
  }
}