/**
 * Shared gym formation-scene base class (refactor of E1–E3 boilerplate).
 *
 * The first three enemy gym scenes (`GymScout`, `GymDiver`, `GymTank`)
 * were built independently and duplicated ~200 lines each: formation
 * spawn loop, EXPLODE/SHOOT HUD buttons, status line, hint line,
 * back-to-index button, formation drift + respawn, per-entity
 * `applyFormationPosition` updates, and bullet collection/advance/
 * wrap + lifetime expiry. This base class encapsulates all of that; each
 * concrete scene supplies only its entity-specific configuration via
 * {@link EnemyFormationConfig}.
 *
 * **Shared combat core:** this class extends
 * {@link CombatScene} (`src/scenes/core/CombatScene.ts`), so collision
 * resolution, player hits, auto-fire, drop collection, teleports and
 * player explosions are the *same code* the shipped `PlayScene` runs.
 * This class supplies the gym participant accessors (`entities`,
 * `bullets`) and config-driven hooks (teleport gate, bullet hit radius,
 * `config.onEntityDestroyed`).
 *
 * **Discovery note:** this file lives in the `core/` subfolder, so the
 * gym index glob (`src/scenes/gym/*.ts`) never lists it as a scene.
 */

import Phaser from 'phaser';

import { CombatScene } from '../../../scenes/core/CombatScene';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  MINERAL_SIZE,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../../core/constants';
import {
  playDestructionSound,
  playSpawnSound,
} from '../../../audio/effects';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../../utils/gymNavigation';
import { FormationOffset } from '../../../utils/formations';
import { Player } from '../../../entities/Player';
import {
  PlayerBullet,
  advanceAndCull,
} from '../../../entities/PlayerBullet';
import {
  WasdKeysLike,
} from '../../../utils/input';
import {
  loadRules,
  POWER_UP_WEIGHT_IDS,
  WEAPON_WEIGHT_IDS,
  type PowerUpWeights,
  type WeaponWeights,
} from '../../../core/rules';
import { drawPowerUpDrop, drawWeaponDrop, dropCollectRadius } from '../../../powerups/icons';
import { PowerUp, PowerUpState } from '../../../powerups/PowerUp';
import { EffectsRegistry } from '../../../powerups/effects';
import {
  type CollectAnimationHandle,
} from '../../../powerups/collectAnimation';
import {
  RandomAvoidingPlacement,
  type PlacementContext,
  type PowerUpPlacement,
} from '../../../powerups/placement';
import {
  WeightedRandomSpawner,
  type PowerUpSpawner,
} from '../../../powerups/spawner';
import {
  getPowerUpById,
  isWeaponDrop,
  type DropId,
  type PowerUpId,
  type WeaponDropId,
} from '../../../powerups/types';
import type { WeaponId } from '../../../utils/weapons';
import { HUD } from '../../../ui/HUD';
import { Mineral } from '../../../entities/Mineral';
import { Asteroid } from '../../../entities/Asteroid';
import {
  randomChoiceStrategy,
  type ChoiceOption,
  type ChoiceStrategy,
} from '../../../powerups/choice';

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
   * Optional: advances a non-formation (roaming) enemy's own motion for
   * this frame (e.g. Asteroid straight-line drift + four-edge wrap +
   * continuous rotation). Formation enemies omit it — the base scene
   * positions them through `applyFormationPosition`. The scene calls this
   * BEFORE `applyFormationPosition`; roaming entities' formation method is
   * expected to be a no-op.
   */
  updatePosition?(dt: number): void;
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
  /** Bullet lifetime in seconds (AH-0MU960UTE001PTV0). */
  lifetime: number;
  /** Elapsed time since creation (seconds). */
  elapsed: number;
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
   * P3–P9 plus the weapon drops (spread, dual, rapid, reset) using the
   * game-rules weights.
   */
  spawner?: PowerUpSpawner<DropId>;
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
  /** The weapon drop ID (spread/dual/rapid/reset) when this is a weapon drop. */
  weaponDropId?: WeaponDropId;
  /** The unified drop ID (power-up or weapon). */
  dropId: DropId;
  /** Fixed world-space position at spawn time (px). */
  x: number;
  y: number;
  /** The drawn bubble + icon. */
  graphics: Phaser.GameObjects.Graphics;
  /**
   * True once the drop has been collected and is playing its absorb VFX —
   * the overlap gate must not re-collect it (AC5, AH-0MUBYXRFT005Y30S).
   */
  absorbing?: boolean;
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
  /**
   * Optional: called after an entity is destroyed (player bullet, body
   * ram, or the EXPLODE button) once its `destroySelf()` has run. Lets a
   * scene spawn replacement/dynamic entities into the live formation list
   * (e.g. Asteroid split children, GDD §4.1 — E6 Asteroid).
   */
  onEntityDestroyed?(entity: TEntity): void;
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
> extends CombatScene<TEntity, TBullet, FormationSceneDrop> {
  protected config: EnemyFormationConfig<TEntity, TBullet>;

  protected entities: TEntity[] = [];
  protected bullets: TBullet[] = [];

  /** Keyboard-controlled player ship (null unless `config.player` set). */
  protected player: Player | null = null;

  protected formationBaseX: number;
  protected formationBaseY: number;
  private shootEnabled = false;

  // Wipe → 3s countdown → respawn lifecycle (core-library owned, AH-0MTFXKA5Q003LBH5).
  private respawnCountdown = 0;
  private respawnCountdownActive = false;
  private countdownText: Phaser.GameObjects.Text | null = null;

  // UI toggles
  protected shootButton!: Phaser.GameObjects.Text;
  protected explodeButton!: Phaser.GameObjects.Text;
  protected statusText!: Phaser.GameObjects.Text;

  // Power-up layer (opt-in via `config.powerUps`).
  private powerUpsEnabled = false;
  private powerUpDrops: FormationSceneDrop[] = [];
  private powerUpSpawner: PowerUpSpawner<DropId> | null = null;
  private powerUpPlacement: PowerUpPlacement | null = null;
  private powerUpSpawnInterval = 0;
  private powerUpSpawnTimer = 0;
  private powerUpPlacementMargin = DEFAULT_POWER_UP_PLACEMENT_MARGIN;
  private powerUpSpawnCount = 0;
  /** Shared active-effect registry (effects applied by collected drops). */
  private effectsRegistry = new EffectsRegistry();
  /** Standalone HUD rendering the active effects (null when disabled). */
  private hud: HUD | null = null;

  // ── Mineral layer (GDD §4.5, AH-0MUBVGI62004ED9Q) ───────────────

  /** Live mineral collectables seeded across the play area. */
  private minerals: Mineral[] = [];
  /** Cumulative minerals seeded since the gym started. */
  private mineralsSeeded = 0;
  /** Run-scoped mineral hold for the gym demo. */
  private mineralHold = 0;
  /** Hold capacity (from the game-rules config). */
  private mineralCapacity = 20;
  /** Whether the hold-full choice overlay is currently open. */
  private mineralChoiceOpen = false;
  /** Pluggable choice strategy for the hold-full overlay. */
  private mineralChoiceStrategy: ChoiceStrategy = randomChoiceStrategy;

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
      // Graphics objects are not auto-added to the display list either.
      this.add.existing(this.player);
      this.cursors = this.input.keyboard?.createCursorKeys();
      this.wasd = this.input.keyboard?.addKeys(
        'W,A,S,D',
      ) as WasdKeysLike | undefined;
    }

    // ── Controls (bottom-right HUD, minimal) ───────────────────────
    // AH-0MUAYB7O4009LWBF — repositioned from bottom-left to avoid
    // overlap with the bottom-left anchored gym editor panels.
    this.explodeButton = this._addButton(
      GAME_WIDTH - 120,
      GAME_HEIGHT - 60,
      'EXPLODE',
      LABEL_STYLE,
    );
    this.shootButton = this._addButton(
      GAME_WIDTH - 240,
      GAME_HEIGHT - 60,
      'SHOOT: OFF',
      LABEL_STYLE,
    );

    this.explodeButton.on('pointerdown', () => this.explodeRandom());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(
      GAME_WIDTH - 10,
      GAME_HEIGHT - 36,
      `SCORE: n/a — ${config.statusLabel}: ${this.entities.length}`,
      {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#888888',
      },
    ).setOrigin(1, 0);

    // ── Hint line (centred, above the controls) ─────────────────────
    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, config.hintText, {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#555555',
    }).setOrigin(0.5);

    // ── Back to gym index ───────────────────────────────────────────
    addBackToIndexButton(this);

    // ── ESC key — return to main menu (AH-0MU9LRTK3004KR04) ────────
    addBackToMenuOnEsc(this);

    // ── Optional power-up layer (opt-in via config.powerUps) ────────
    this._initPowerUpLayer();

    // ── Mineral layer: seed 100 random minerals + HUD counter ───────
    this._initMineralLayer();

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

      // Composed player-death juice registry (flash/debris/shockwave/particles)
      // must not survive a stop/restart either (parent AH-0MUAYB4R3002ZIZY AC6).
      for (const effect of this.playerDeathEffects) effect.destroy();
      this.playerDeathEffects.length = 0;

      // Null-out the player reference so any stale callback does not
      // reach the destroyed ship.
      this.player = null;

      // Reset scene toggle state so a fresh create() starts clean.
      this.shootEnabled = false;

      // Tear down any power-up drops owned by the scene.
      for (const drop of this.powerUpDrops) drop.graphics.destroy();
      this.powerUpDrops = [];
      for (const anim of this.collectAnimations) anim.destroy();
      this.collectAnimations = [];
      this.powerUpSpawnCount = 0;
      for (const mineral of this.minerals) mineral.destroy();
      this.minerals = [];
      this.mineralHold = 0;
      this.mineralChoiceOpen = false;
      this.hud?.destroy();
      this.hud = null;
      this.teleportKey = null;
      this.downKey = null;
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
    // Dynamic-replacement seam (Asteroid split children, GDD §4.1).
    this.config.onEntityDestroyed?.(victim);
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
      cfg.spawner ??
      this._buildDefaultPowerUpSpawner(
        rules.powerUpWeights,
        rules.weaponWeights,
        rng,
      );
    this.powerUpSpawnInterval =
      cfg.spawnInterval ?? rules.powerUpSpawnInterval;
    this.powerUpPlacementMargin =
      cfg.margin ?? DEFAULT_POWER_UP_PLACEMENT_MARGIN;
    this.powerUpSpawnTimer = this.powerUpSpawnInterval;

    // Fresh registry + standalone HUD per scene start (lives visible so
    // P8 is observable).
    this.effectsRegistry = new EffectsRegistry();
    this.hud = new HUD(this, this.effectsRegistry, { showLives: true });

    // P7 teleport keys (only meaningful when a player is present).
    if (this.player) {
      this.teleportKey =
        this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.S) ?? null;
      this.downKey =
        this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN) ?? null;
    }

    // One drop on screen immediately so the layer is observable at boot.
    this._spawnPowerUpDrop();
  }

  /**
   * Builds the default weighted-random spawner over power-up IDs AND
   * weapon drops (spread, dual, rapid, reset) using the rules weights.
   */
  private _buildDefaultPowerUpSpawner(
    powerUpWeights: PowerUpWeights,
    weaponWeights: WeaponWeights,
    rng: () => number,
  ): PowerUpSpawner<DropId> {
    const ids: DropId[] = [...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS];
    const spawner = new WeightedRandomSpawner<DropId>(ids, rng);
    for (const id of POWER_UP_WEIGHT_IDS) {
      spawner.setWeight(id, powerUpWeights[id]);
    }
    for (const id of WEAPON_WEIGHT_IDS) {
      spawner.setWeight(id, weaponWeights[id]);
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

  /** Spawns one drop at a placement-strategy position (cadence path). */
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
    this.spawnPowerUpDrop(id, x, y);
    this.powerUpSpawnCount += 1;
  }

  /**
   * Spawns a drop of *id* at (x, y). Weapon drops (spread/dual/rapid/
   * reset) are rendered with the weapon icon; power-up drops with the
   * power-up icon. Public so tests (and future live controls) can place
   * a deterministic drop; returns null when the power-up layer is
   * disabled.
   */
  spawnPowerUpDrop(
    id: DropId,
    x: number,
    y: number,
  ): FormationSceneDrop | null {
    if (!this.powerUpsEnabled) return null;

    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    if (isWeaponDrop(id)) {
      drawWeaponDrop(graphics, id, 0, 0, POWER_UP_DROP_SIZE);
    } else {
      drawPowerUpDrop(graphics, getPowerUpById(id).type, 0, 0, POWER_UP_DROP_SIZE);
    }
    graphics.setScale(0);

    const drop: FormationSceneDrop = {
      powerUp: new PowerUp(isWeaponDrop(id) ? 'P3' : id),
      id: isWeaponDrop(id) ? 'P3' : id,
      weaponDropId: isWeaponDrop(id) ? id : undefined,
      dropId: id,
      x,
      y,
      graphics,
    };
    this.powerUpDrops.push(drop);
    return drop;
  }

  /**
   * Advances drop lifecycles, resolves fly-over collection, spawns the
   * next drop when the configured interval has elapsed and no previous
   * drop is still live (one drop on screen at a time), handles P7
   * teleport, ticks the effects registry and refreshes the HUD.
   */
  private _updatePowerUpLayer(dt: number): void {
    if (!this.powerUpsEnabled) return;

    this._handleTeleport();

    const kept: FormationSceneDrop[] = [];
    for (const drop of this.powerUpDrops) {
      // An absorbing drop is owned by its animation — never re-process it.
      if (drop.absorbing) continue;
      drop.powerUp.advance(dt);
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state !== PowerUpState.DESPAWNED) {
        kept.push(drop);
      } else {
        drop.graphics.destroy();
      }
    }
    this.powerUpDrops = kept;

    this._collectOverlappingDrops();
    // Advance the absorb VFX for collected drops (cosmetic only).
    this._updateCollectAnimations(dt);

    this.powerUpSpawnTimer -= dt;
    if (this.powerUpSpawnTimer <= 0 && this.powerUpDrops.length === 0) {
      this._spawnPowerUpDrop();
      this.powerUpSpawnTimer = this.powerUpSpawnInterval;
    }

    this.effectsRegistry.tick(dt);
    this.hud?.refresh();
  }

  // ── Drop collection (fly-over) ───────────────────────────────────

  /** Collects any collectible drop overlapping the player's hull. */
  private _collectOverlappingDrops(): void {
    if (!this.player) return;
    const hull = SHIP_SIZE / 2;

    const kept: FormationSceneDrop[] = [];
    for (const drop of this.powerUpDrops) {
      if (
        !drop.absorbing &&
        drop.powerUp.canCollect() &&
        this._dropOverlapsShip(drop, hull)
      ) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.powerUpDrops = kept;
  }

  /** Whether a drop's current radius overlaps the player's hull. */
  private _dropOverlapsShip(drop: FormationSceneDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = dropCollectRadius(POWER_UP_DROP_SIZE, drop.powerUp.currentScale);
    return (
      Math.hypot(this.player.x - drop.x, this.player.y - drop.y) <=
      hull + dropRadius
    );
  }

  /**
   * Weapon drops advance their placeholder power-up lifecycle as the
   * collect-gate (the registry/player equipping is handled by the shared
   * `_collectDrop`).
   */
  protected override onWeaponCollected(drop: FormationSceneDrop): void {
    drop.powerUp.tryCollect();
  }

  // ── Teleport (P7, S/↓) ───────────────────────────────────────────

  /** Teleports are gated on the gym's opt-in power-up layer. */
  protected override canTeleport(): boolean {
    return this.powerUpsEnabled;
  }

  /** Enemy hit radius used for teleport destination avoidance (px). */
  protected override getTeleportEnemyHitRadius(): number {
    return this.getEntityHitRadius();
  }

  /** Enemy-bullet hit radius used for teleport avoidance (px). */
  protected override getTeleportBulletHitRadius(): number {
    return this.getBulletHitRadius();
  }

  /** Enemy-bullet collision radius (config-driven; default 6 px). */
  protected override getEnemyBulletRadius(): number {
    return this.getBulletHitRadius();
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

  /** Shared active-effect registry (effects applied by collected drops). */
  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  /** The standalone effects HUD (null when the power-up layer is disabled). */
  getHUD(): HUD | null {
    return this.hud;
  }

  // ── Mineral layer (GDD §4.5, AH-0MUBVGI62004ED9Q) ───────────────

  /**
   * Seeds `count` random mineral collectables across the play area
   * (default 100 for the gyms). Returns the spawned minerals.
   */
  seedMinerals(count: number): Mineral[] {
    const seeded: Mineral[] = [];
    for (let i = 0; i < count; i++) {
      const x = 20 + Math.random() * (GAME_WIDTH - 40);
      const y = 20 + Math.random() * (GAME_HEIGHT - 120);
      const mineral = new Mineral(this, { x, y });
      this.minerals.push(mineral);
      seeded.push(mineral);
    }
    this.mineralsSeeded += count;
    return seeded;
  }

  /** Cumulative number of minerals seeded since the gym started. */
  getSeededMineralCount(): number {
    return this.mineralsSeeded;
  }

  /** Live mineral collectables currently on the field (copy). */
  getMinerals(): Mineral[] {
    return [...this.minerals];
  }

  /** Current gym mineral hold value. */
  getMineralHold(): number {
    return this.mineralHold;
  }

  /** Current gym mineral hold capacity. */
  getMineralCapacity(): number {
    return this.mineralCapacity;
  }

  /** Whether the hold-full choice overlay is open. */
  isMineralChoiceOpen(): boolean {
    return this.mineralChoiceOpen;
  }

  /** Overrides the pluggable choice strategy. */
  setMineralChoiceStrategy(strategy: ChoiceStrategy): void {
    this.mineralChoiceStrategy = strategy;
  }

  /** Creates the mineral HUD and seeds the field; called from `create()`. */
  private _initMineralLayer(): void {
    this.mineralCapacity = loadRules().mineralHoldCapacity;
    this.mineralHold = 0;
    this.mineralChoiceOpen = false;
    this.mineralsSeeded = 0;
    if (!this.hud) {
      this.hud = new HUD(this, this.effectsRegistry, { showLives: false });
    }
    this.hud.setMineralStore(this.mineralHold, this.mineralCapacity);
    this.seedMinerals(100);
  }

  /**
   * Player collects overlapping minerals into the hold; non-asteroid
   * enemies absorb them. Asteroids are inert to minerals.
   */
  private _updateMinerals(): void {
    if (this.minerals.length === 0) return;
    const hull = SHIP_SIZE / 2;
    const kept: Mineral[] = [];
    for (const mineral of this.minerals) {
      if (!mineral.alive) continue;

      if (
        this.player &&
        this._collide(mineral.x, mineral.y, MINERAL_SIZE, this.player.x, this.player.y, hull)
      ) {
        mineral.handleOverlap('player');
        this.mineralHold = Math.min(
          this.mineralCapacity,
          this.mineralHold + loadRules().mineralCollectAmount,
        );
        this.hud?.setMineralStore(this.mineralHold, this.mineralCapacity);
        if (this.mineralHold >= this.mineralCapacity && !this.mineralChoiceOpen) {
          this.openMineralChoice();
        }
        continue;
      }

      let absorbed = false;
      for (const entity of this.entities) {
        if (!entity.alive || entity instanceof Asteroid) continue;
        const collector = entity as unknown as { collectMineral?: () => void };
        if (!collector.collectMineral) continue;
        if (
          this._collide(
            mineral.x,
            mineral.y,
            MINERAL_SIZE,
            entity.x,
            entity.y,
            entity.getHitRadius(),
          )
        ) {
          collector.collectMineral();
          mineral.handleOverlap('enemy');
          absorbed = true;
          break;
        }
      }
      if (!absorbed) kept.push(mineral);
    }
    for (const mineral of this.minerals) {
      if (!kept.includes(mineral)) mineral.destroy();
    }
    this.minerals = kept;
  }

  /**
   * Opens the hold-full choice overlay, pausing the gym scene and launching
   * `MineralChoiceScene`. The pick is applied permanently and the hold reset.
   */
  openMineralChoice(): ChoiceOption[] {
    if (this.mineralChoiceOpen) return [];
    const options = this.mineralChoiceStrategy.choose(3);
    this.mineralChoiceOpen = true;
    this.scene.launch('MineralChoiceScene', {
      options,
      onSelect: (index: number) => this.selectMineralChoice(index, options),
    });
    this.scene.pause();
    return options;
  }

  /**
   * Applies the chosen option permanently for the gym run, resumes the gym
   * scene, and resets the hold.
   */
  selectMineralChoice(index: number, options: ChoiceOption[]): ChoiceOption | null {
    const option = options[index];
    if (!option) return null;
    if (option.kind === 'weapon') {
      const weaponId = option.id as WeaponId;
      this.effectsRegistry.applyWeapon(weaponId, true);
      this.player?.equipWeapon(weaponId, true);
    } else {
      this.effectsRegistry.applyCollect(option.id as PowerUpId, true);
    }
    this.mineralChoiceOpen = false;
    this.mineralHold = 0;
    this.hud?.setMineralStore(this.mineralHold, this.mineralCapacity);
    this.scene.resume();
    return option;
  }

  /** The live power-up drops currently on screen. */
  getPowerUpDrops(): FormationSceneDrop[] {
    return [...this.powerUpDrops];
  }

  /** In-flight absorb animations for collected drops (test seam). */
  getCollectAnimations(): CollectAnimationHandle[] {
    return [...this.collectAnimations];
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
  getPowerUpSpawner(): PowerUpSpawner<DropId> | null {
    return this.powerUpSpawner;
  }

  /** Replaces the ID spawner (used by tests and live controls). */
  setPowerUpSpawner(spawner: PowerUpSpawner<DropId>): void {
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
    return this.invulnerable > 0;
  }

  /** Seconds of invulnerability remaining (0 once the blink ends). */
  getPlayerInvulnerableRemaining(): number {
    return Math.max(0, this.invulnerable);
  }

  /** Active player-explosion VFX graphics (empty once the tweens end). */
  getPlayerExplosions(): Phaser.GameObjects.Graphics[] {
    return this.playerExplosions.slice();
  }

  /** Active composed player-death juice effects (empty once torn down). */
  getPlayerDeathEffects(): Phaser.GameObjects.GameObject[] {
    return this.playerDeathEffects.slice();
  }

  /** Hit radius (px) used for player-bullet vs entity collisions. */
  getEntityHitRadius(): number {
    return this.config.entityHitRadius ?? DEFAULT_ENTITY_HIT_RADIUS;
  }

  /** Hit radius (px) used for enemy-bullet collision checks. */
  getBulletHitRadius(): number {
    return this.config.bulletHitRadius ?? DEFAULT_BULLET_HIT_RADIUS;
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
      // Roaming enemies (e.g. Asteroid) advance their own straight-line
      // motion + wrap + rotation; a no-op for formation enemies.
      entity.updatePosition?.(dt);

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

    // Advance bullets; wrap across all four edges and expire by lifetime
    // (AH-0MU960UTE001PTV0). Bullets are never culled for off-screen position.
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i];
      bullet.elapsed += dt;
      bullet.graphics.x += bullet.vx * dt;
      bullet.graphics.y += bullet.vy * dt;
      if (bullet.graphics.x < 0) bullet.graphics.x += GAME_WIDTH;
      if (bullet.graphics.x >= GAME_WIDTH) bullet.graphics.x -= GAME_WIDTH;
      if (bullet.graphics.y < 0) bullet.graphics.y += GAME_HEIGHT;
      if (bullet.graphics.y >= GAME_HEIGHT) bullet.graphics.y -= GAME_HEIGHT;
      if (bullet.elapsed >= bullet.lifetime) {
        bullet.graphics.destroy();
        this.bullets.splice(i, 1);
      }
    }

    // ── Player ship: input → thrust, auto-fire, bullet lifecycle ──
    if (this.player) {
      // Advance timed weapon countdowns (collected weapon drops expire
      // after 10 s, mirroring GymWeapons) before auto-fire so an expired
      // weapon stops firing this frame.
      this.player.tickWeaponTimers(dt * 1000);
      // P5 live boost: scale thrust/max-speed and fire rate each frame.
      this.player.setSpeedMultiplier(this.effectsRegistry.speedMultiplier());
      this.player.setFireRateMultiplier(this.effectsRegistry.fireRateMultiplier());
      const input = this._readPlayerInput();
      if (input) this.player.setInput(input);
      this.player.physicsTick(dt, this.scale.width, this.scale.height);
      this._autoFire(dt);
      this._advancePlayerBullets(dt);

      // Collisions + post-hit invulnerability blink (player component only).
      this._handleCollisions();
      this._updateInvulnerability(dt);
    }

    // ── Mineral layer: collection + hold-full choice ────────────────
    this._updateMinerals();

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
  // ── Shared combat-core participant accessors ─────────────────────

  /** Live enemy entities for the shared collision pass. */
  protected override getEnemyEntities(): readonly TEntity[] {
    return this.entities;
  }

  /** Live enemy bullets for the shared collision pass. */
  protected override getEnemyBullets(): readonly TBullet[] {
    return this.bullets;
  }

  /** Replaces the enemy-bullet collection after a shared collision pass. */
  protected override setEnemyBullets(bullets: TBullet[]): void {
    this.bullets = bullets;
  }

  /** Enemy destroyed through the generic path: forward to the config seam. */
  protected override onEnemyDestroyed(entity: TEntity): void {
    this.config.onEntityDestroyed?.(entity);
  }

  /** Advances player bullets and removes those whose lifetime has elapsed. */
  private _advancePlayerBullets(dt: number): void {
    this.playerBullets = this.playerBullets.filter((b) => advanceAndCull(b, dt));
  }

  /**
   * Off-screen test — retained for compatibility. Enemy bullets no longer
   * cull on off-screen position; they wrap and expire by lifetime
   * (AH-0MU960UTE001PTV0).
   */
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