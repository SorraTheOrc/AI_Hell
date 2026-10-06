/**
 * Shared gym formation-scene base class (refactor of E1–E3 boilerplate).
 *
 * The first three enemy gym scenes (`GymScout`, `GymDiver`, `GymTank`)
 * were built independently and duplicated ~200 lines each: formation
 * spawn loop, EXPLODE/SHOOT HUD buttons, status line, hint line,
 * back-to-index button, formation drift + respawn, per-entity
 * `applyFormationPosition` updates, and bullet collection/advance/
 * wrap + lifetime expiry (now the shared
 * `src/scenes/core/bulletLifecycle.ts` helpers, AH-0MUII3CF00024EDM). This
 * base class encapsulates all of that; each
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
 * **Shared mineral kill-drop rule:** the gym's mineral layer seeds and
 * collects minerals, and its destruction paths (`onEnemyDestroyed` and the
 * EXPLODE button) call the shared `resolveMineralKillDrops` rule from
 * `src/scenes/core/mineralKillDrops.ts` — the *same code* the game runs —
 * so a small asteroid drops one mineral and a non-asteroid enemy re-drops a
 * fraction of the minerals it absorbed, exactly as in `PlayScene`.
 *
 * **Shared power-up drop layer:** the opt-in power-up layer runs the same
 * lifecycle, collection gate, P9 magnet and per-type pickup cues as the
 * game, via the shared `src/scenes/core/dropLayer.ts` template methods
 * (`_updateDropLayer` etc.); the P4 ranged bomb pulse is driven by the
 * shared `CombatCoreScene._updateP4Bomb` path. Only the spawn *source*
 * (a timer, not a kill chance) is gym-specific (AH-0MUII3CXX0023H24, gap 4).
 *
 * **Shared mineral collection + hold + choice:** the collection/absorption
 * pass is the shared `collectMinerals` routine (`scenes/core/mineralLayer.ts`),
 * the hold is the shared `MineralHold` model (`core/mineralHold.ts`), and the
 * permanent reward is the shared `applyMineralChoiceReward` helper — the
 * *same code* `PlayScene` runs. The gym therefore adopts the game's
 * overflow-carry semantics (resolving the hold restores
 * `collected − capacity`, not 0) and offers the exact options it applies
 * through `MineralChoiceScene`'s single `onSelect` contract
 * (AH-0MUII3DHM008L7JF, gap 5).
 *
 * **Discovery note:** this file lives in the `core/` subfolder, so the
 * gym index glob (`src/scenes/gym/*.ts`) never lists it as a scene.
 */

import Phaser from 'phaser';

import { CombatScene } from '../../../scenes/core/CombatScene';
import {
  FormationGlide,
} from '../../../scenes/core/formationGlide';
import {
  applyPhaseGhost,
  drawShieldBubble,
} from '../../core/CombatEffectVisuals';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../../core/constants';
import {
  playDestructionSound,
  playSpawnSound,
} from '../../../audio/effects';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../../utils/gymNavigation';
import {
  computeFormationReanchorDelta,
  FormationOffset,
  type FormationReanchorRequest,
} from '../../../utils/formations';
import { Player } from '../../../entities/Player';
import { PlayerBullet } from '../../../entities/PlayerBullet';
import {
  WasdKeysLike,
} from '../../../utils/input';
import { loadRules } from '../../../core/rules';
import { pickInRange, resolveSpawnRange } from '../../../core/configTypes';
import { drawPowerUpDrop, drawWeaponDrop } from '../../../powerups/icons';
import { PowerUp } from '../../../powerups/PowerUp';
import { EffectsRegistry } from '../../../powerups/effects';
import {
  type CollectAnimationHandle,
} from '../../../powerups/collectAnimation';
import {
  RandomAvoidingPlacement,
  type PlacementContext,
  type PowerUpPlacement,
} from '../../../powerups/placement';
import { type PowerUpSpawner } from '../../../powerups/spawner';
import {
  getPowerUpById,
  isWeaponDrop,
  type DropId,
  type PowerUpId,
  type WeaponDropId,
} from '../../../powerups/types';
import { HUD } from '../../../ui/HUD';
import { Mineral } from '../../../entities/Mineral';
import { Asteroid } from '../../../entities/Asteroid';
import {
  advancePlayerBullets,
  advanceWrappingBullets,
} from '../../core/bulletLifecycle';
import {
  resolveMineralKillDrops,
  type MineralKillDropEntity,
} from '../../core/mineralKillDrops';
import {
  applyMineralChoiceReward,
  collectMinerals,
  isMineralAbsorbingEnemy,
  MineralHold,
  type MineralAbsorbingEnemy,
} from '../../core/mineralLayer';
import {
  randomChoiceStrategy,
  type ChoiceOption,
  type ChoiceStrategy,
} from '../../../powerups/choice';
import { type WeaponId } from '../../../utils/weapons';
import {
  spawnWormholeOpen,
  spawnWormholeClose,
  startSpawnAnimation,
  updateSpawnAnimation,
  type SpawnAnimatable,
  type WormholeHandle,
} from '../../../vfx/wormholeSpawn';

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
  /**
   * Destroys the entity: hides the body, plays the explosion animation.
   * `scale` enlarges the explosion geometry (the wave-timeout penalty uses
   * `WAVE_TIMEOUT_EXPLOSION_SCALE`, 10x). Defaults to 1.
   */
  destroySelf(scale?: number): void;
  /**
   * Set the world-space position. All concrete entities extend
   * `Phaser.GameObjects.Container` and inherit this method.
   */
  setPosition(x: number, y: number): void;
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
   * Optional: returns a pending re-anchor request when this entity's attack
   * finished (GDD §4.1 — E2 Diver), so the base scene can re-base the whole
   * formation origin and keep every unit's relative offset. The call clears
   * the request (fires once). Other entities omit it and the base scene uses
   * optional chaining.
   */
  consumeFormationReanchor?(): FormationReanchorRequest | null;
  /**
   * Optional multi-hit damage seam (Harvester, GDD §4.1). When present,
   * player-bullet collisions delegate to this instead of `destroySelf()`
   * so the entity can decrement health and only self-destruct when depleted.
   * The entity clears its own `alive` flag on the lethal hit; the base scene
   * then finalises the kill exactly once (destruction audio +
   * `onEnemyDestroyed`) by observing `alive` after the call. Non-lethal hits
   * consume the bullet with no destruction side effects.
   */
  takeDamage?(): number | void | { destroyed: boolean; phaseAdvanced: boolean; phase: number; hpRemaining: number; };
  /**
   * Optional roaming-seek seam (Harvester, GDD §4.1 — E7). When present, the
   * base scene pushes its live mineral field to the entity each frame so a
   * roaming enemy can steer toward the nearest mineral. Defined once on the
   * shared contract and consumed by the game and the gyms; entities that do
   * not seek simply omit it (optional chaining skips them).
   */
  setSeekTargets?(minerals: readonly Mineral[]): void;
  /**
   * Optional: whether the entity is in its wormhole spawn animation.
   * While spawning the entity is protected from collisions and cannot
   * fire. Entities that omit the seam are treated as fully spawned.
   */
  readonly isSpawning?: boolean;
  /**
   * Optional: sets the wormhole spawn-animation state.  Called by the
   * scene when the growth animation starts and finishes.
   */
  setSpawning?(value: boolean): void;
  /** Current horizontal scale (drives the growth animation). */
  readonly scaleX: number;
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
  /**
   * Optional spawn-position ranges (AH-0MUKCLXLW0032R67). When a genuine
   * band is configured on an axis the formation base is drawn randomly
   * within it using the shared {@link resolveSpawnRange}/{@link pickInRange}
   * helpers — the same code path as `planGroupSpawns` in the game, so gyms
   * and `PlayScene` cannot diverge. Absent/degenerate ranges keep the
   * scalar `startX`/`startY` base unchanged.
   */
  startXMin?: number;
  startXMax?: number;
  startYMin?: number;
  startYMax?: number;
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
  /**
   * Optional wave-timeout duration (seconds). When set and > 0 the scene runs
   * the shared game wave-timeout: on expiry survivors are **kept** (no
   * detonation — the shared helper is now a no-op, AH-0MUNS3ZQ1002DJ9S) and
   * the formation refreshes through the existing wipe→countdown lifecycle,
   * spawning a fresh formation alongside the survivors. Omit (or 0) to
   * disable — used by the boss and by gyms whose entities must not be
   * destroyed (AH-0MUNR5LM1004B223).
   */
  timeoutDuration?: number;
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

  /**
   * Canonical player spawn (px) — the point {@link setPlayerEnabled}(true)
   * restores. Derived from `config.player` in `create()`; null when the
   * scene has no player component (AH-0MUII3F7Q002O7WX, gap 9).
   */
  protected playerSpawnX: number | null = null;
  protected playerSpawnY: number | null = null;

  protected formationBaseX!: number;
  protected formationBaseY!: number;
  private shootEnabled = false;

  /** Live wormhole handle for the current formation spawn, or null. */
  private _spawnWormhole: WormholeHandle | null = null;

  // Wipe → 3s countdown → respawn and the opt-in wave-timeout lifecycle now
  // live in the shared `CombatScene` core (AH-0MUNR5LM1004B223) so every
  // combat scene runs one implementation.

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
  /** Shared P3 shield-bubble graphics (draws the shared helper output). */
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  /** Whether the shield bubble was drawn in the last visual update. */
  private shieldBubbleDrawn = false;

  // ── Formation glide (AH-0MUL15N63003PUDB)

  /** Glide manager: eases enemies from their old positions to the re-anchored slots. */
  private glide = new FormationGlide();

  /**
   * Diver-group re-anchor offset (px). Only entities that expose the
   * `consumeFormationReanchor` seam (Divers) have this offset added to their
   * origin, so a Diver's attack re-anchors the Diver group alone and every
   * other enemy stays where it is (producer review, AH-0MUL15N63003PUDB).
   */
  private diverAnchorX = 0;
  private diverAnchorY = 0;

  // ── Mineral layer (GDD §4.5, AH-0MUBVGI62004ED9Q) ───────────────

  /** Live mineral collectables seeded across the play area. */
  private minerals: Mineral[] = [];
  /** Cumulative minerals seeded since the gym started. */
  private mineralsSeeded = 0;
  /**
   * Run-scoped mineral hold. This is the shared `MineralHold` model
   * (capacity, pick-up amount, overflow carry) that `GameState` also uses,
   * so the gym adopts the game's overflow semantics instead of resetting
   * to 0 (AH-0MUII3DHM008L7JF · AC2).
   */
  private mineralHoldModel = new MineralHold();
  /** Whether the hold-full choice overlay is currently open. */
  private mineralChoiceOpen = false;
  /** The options currently offered by the hold-full choice. */
  private mineralChoiceOptions: ChoiceOption[] = [];
  /** Pluggable choice strategy for the hold-full overlay. */
  private mineralChoiceStrategy: ChoiceStrategy = randomChoiceStrategy;
  /**
   * Scene-level random-number generator for the mineral kill-drop rule.
   * Defaults to `Math.random`; injectable so gym drop tests are deterministic.
   */
  private _sceneRng: () => number = Math.random;

  constructor(config: EnemyFormationConfig<TEntity, TBullet>) {
    super({ key: config.sceneKey });
    this.config = config;
    this._resolveFormationBase();
  }

  /**
   * Positions the formation base, applying any configured spawn range on
   * each axis through the shared `resolveSpawnRange`/`pickInRange` helpers
   * (AH-0MUKCLXLW0032R67). This is the same code path `planGroupSpawns`
   * uses in the game, so gym and `PlayScene` range behaviour cannot diverge.
   * A degenerate/absent range leaves the scalar `startX`/`startY` unchanged.
   */
  protected _resolveFormationBase(): void {
    this.formationBaseX = pickInRange(
      resolveSpawnRange(this.config.startX, this.config.startXMin, this.config.startXMax),
      this._sceneRng,
    );
    this.formationBaseY = pickInRange(
      resolveSpawnRange(this.config.startY, this.config.startYMin, this.config.startYMax),
      this._sceneRng,
    );
    // A fresh base (initial create or respawn) starts with no Diver re-anchor
    // offset, so the Diver group is back on the shared formation base.
    this.diverAnchorX = 0;
    this.diverAnchorY = 0;
  }

  create(): void {
    // Reset shared + scene-owned per-run state so a stop/restart of the
    // same instance starts clean (AH-0MUII3FYN0072QRT, gap 10).
    this.resetRunState();
    const { config } = this;

    // ── Spawn the formation ─────────────────────────────────────────
    const offsets = config.buildOffsets(config.count);
    // Wormhole opens at the formation origin; every entity grows from
    // 1 px to its full size while protected (AC1–AC4, gym parity).
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
      startSpawnAnimation(entity as unknown as SpawnAnimatable, entity.scaleX);
      entity.setSpawning?.(true);
      this.entities.push(entity);
    }
    if (offsets.length > 0) {
      this._spawnWormhole = spawnWormholeOpen(
        this,
        this.formationBaseX,
        this.formationBaseY,
      );
    }
    playSpawnSound();

    // ── Player ship (optional per-scene opt-in) ────────────────────
    if (config.player) {
      this.playerSpawnX = config.player.x;
      this.playerSpawnY = config.player.y;
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

    // ── Shared P3/P6 player visuals (parity with PlayScene/gym combat) ──
    // Drawn through the shared CombatEffectVisuals helper so the enemy gym
    // cannot drift from the other scenes (AH-0MUICQC34005QOYF).
    this.shieldBubble = this.add.graphics();
    this.shieldBubble.setDepth(50);
    this.shieldBubbleDrawn = false;

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

    // ── P7 teleport keys (S/↓) — bound whenever a player exists ─────
    // Independent of the opt-in power-up drop layer: the minerals gym
    // grants P7 through the hold-full choice, not field drops, so teleport
    // must be usable there too (AH-0MUHMXWGC0058BO4 · AC2).
    this._bindTeleportKeys();

    // ── Mineral layer: seed 100 random minerals + HUD hold bar ─────
    this._initMineralLayer();

    // Ensure any stale countdown state from a prior create() (e.g. after
    // a manual _onRespawn that rebuilt the formation) is cleared so a
    // fresh scene never starts mid-countdown.
    this._cancelRespawnCountdown();

    // Start the opt-in wave-timeout for this run (AH-0MUNR5LM1004B223).
    this.startWaveTimeout();

    // Tear down all scene-owned objects on shutdown so a stop/restart of
    // the same instance leaks nothing (AH-0MUII3FYN0072QRT, gap 10).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());
  }

  /**
   * Resets shared per-run state (effects registry + bullet/effect
   * registries via the core) plus this scene's own per-run state:
   * formation, bullets, player, power-up layer, mineral layer, HUD and
   * wipe/countdown. Called at the top of `create()`
   * (AH-0MUII3FYN0072QRT, gap 10).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.entities = [];
    this.bullets = [];
    this.player = null;
    this.playerSpawnX = null;
    this.playerSpawnY = null;
    this.shootEnabled = false;
    this.powerUpsEnabled = false;
    this.powerUpDrops = [];
    this.powerUpSpawner = null;
    this.powerUpPlacement = null;
    this.powerUpSpawnInterval = 0;
    this.powerUpSpawnTimer = 0;
    this.powerUpSpawnCount = 0;
    this.hud = null;
    this.shieldBubble = null;
    this.shieldBubbleDrawn = false;
    this.minerals = [];
    this.mineralsSeeded = 0;
    this.mineralHoldModel.reset();
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this._spawnWormhole = null;
    this._resolveFormationBase();
  }

  /**
   * Destroys every scene-owned object on `SHUTDOWN` after the shared core
   * teardown has run, so a stop/restart leaks nothing (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    this._cancelRespawnCountdown();
    // The countdown overlay Text is a display-list child destroyed by the
    // DisplayList shutdown; drop the reference so a restart's respawn
    // creates a fresh overlay on the new display list.
    this.countdownText = null;

    for (const entity of this.entities) entity.destroy(true);
    this.entities = [];

    for (const bullet of this.bullets) bullet.graphics.destroy();
    this.bullets = [];

    // Null-out the player reference so any stale callback does not
    // reach the destroyed ship.
    this.player = null;

    // Reset scene toggle state so a fresh create() starts clean.
    this.shootEnabled = false;

    // Tear down any power-up drops owned by the scene.
    for (const drop of this.powerUpDrops) drop.graphics.destroy();
    this.powerUpDrops = [];
    this.powerUpSpawnCount = 0;

    for (const mineral of this.minerals) mineral.destroy();
    this.minerals = [];
    this.mineralHoldModel.reset();
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];

    this.hud?.destroy();
    this.hud = null;
    this.shieldBubble?.destroy();
    this.shieldBubble = null;
    this.shieldBubbleDrawn = false;

    // Clear glide state so a stop/restart starts fresh (AH-0MUL15N63003PUDB).
    this.glide.clear();
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
    // Shared mineral kill-drop rule (GDD §4.5) — the EXPLODE path bypasses
    // `onEnemyDestroyed`, so it must drop here too (no double-drop: the two
    // paths are mutually exclusive).
    this._dropMineralsForKill(victim);
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
      this._buildDefaultDropSpawner(
        rules.powerUpWeights,
        rules.weaponWeights,
        rng,
      );
    this.powerUpSpawnInterval =
      cfg.spawnInterval ?? rules.powerUpSpawnInterval;
    this.powerUpPlacementMargin =
      cfg.margin ?? DEFAULT_POWER_UP_PLACEMENT_MARGIN;
    this.powerUpSpawnTimer = this.powerUpSpawnInterval;

    // The registry is reset by `resetRunState()` at the top of `create()`,
    // so it is already clean here; only the standalone HUD is rebuilt per
    // scene start (lives visible so P8 is observable). Sharing the one
    // reset path stops the registry drifting on restart (gap 10).
    this.hud = new HUD(this, this.effectsRegistry, {
      showLives: true,
      // Show each weapon's run-scoped level (parent AH-0MUPMPCB2009J54J).
      getWeaponLevel: (id) => this.player?.getWeaponLevel(id as WeaponId) ?? 0,
    });

    // One drop on screen immediately so the layer is observable at boot.
    this._spawnPowerUpDrop();
  }

  /**
   * Binds the S / ↓ teleport keys whenever a player exists, independent of
   * the opt-in power-up drop layer. `addKey` is idempotent for the same
   * key code, so this is safe to call from `create()` on every restart.
   */
  private _bindTeleportKeys(): void {
    if (!this.player) return;
    this.teleportKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.S) ?? null;
    this.downKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN) ?? null;
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

    // Single shared drop sequence (gap 4): P4 notice, P9 magnet,
    // lifecycle, overlap collection, absorb VFX. Only the spawn *source*
    // (the cadence below) differs from the game (OQ6).
    this.powerUpDrops = this._updateDropLayer(this.powerUpDrops, dt);

    this.powerUpSpawnTimer -= dt;
    if (this.powerUpSpawnTimer <= 0 && this.powerUpDrops.length === 0) {
      this._spawnPowerUpDrop();
      this.powerUpSpawnTimer = this.powerUpSpawnInterval;
    }
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

  /**
   * Teleports are allowed when the opt-in drop layer is active, or whenever
   * a stored P7 use is available (the minerals gym grants P7 through the
   * hold-full choice, not field drops — AH-0MUHMXWGC0058BO4 · AC2).
   */
  protected override canTeleport(): boolean {
    return this.powerUpsEnabled || this.effectsRegistry.hasTeleport();
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

  /**
   * Registers a dynamically spawned entity (e.g. an asteroid-split child)
   * with the live formation list. Public so a scene config's
   * `onEntityDestroyed` hook can register children without casting into the
   * base's protected `entities` (AH-0MUII3F7Q002O7WX, gap 8).
   */
  registerDynamicEntity(entity: TEntity): void {
    this.entities.push(entity);
  }

  /** Number of enemies still alive. */
  get aliveCount(): number {
    return this.entities.filter((e) => e.alive).length;
  }

  /** Whether firing is currently enabled. */
  get shootingEnabled(): boolean {
    return this.shootEnabled;
  }

  // `isRespawnCountdownActive` / `getRespawnCountdownRemaining` /
  // `getRespawnCountdownText` are inherited from the shared `CombatScene`
  // core (AH-0MUNR5LM1004B223).

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

  /**
   * Current origin for the re-anchor-capable (Diver) group: the shared
   * formation base plus the Diver-only re-anchor offset. Non-Diver entities
   * sit on {@link formationX}/{@link formationY} alone.
   */
  get diverFormationX(): number {
    return this.formationBaseX + this.diverAnchorX;
  }

  /** Current origin y for the re-anchor-capable (Diver) group. */
  get diverFormationY(): number {
    return this.formationBaseY + this.diverAnchorY;
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

  /**
   * Draws the shared P3 shield bubble and applies the shared P6 phase ghost
   * each frame (parity with `PlayScene`/`GymPowerUpsCombat`). Safe when no
   * player is present.
   */
  private _updateEffectVisuals(): void {
    this.shieldBubbleDrawn = drawShieldBubble(
      this.shieldBubble,
      this.player,
      this.effectsRegistry,
    );
    applyPhaseGhost(this.player, this.effectsRegistry, this.invulnerable > 0);
  }

  /** Whether the P3 shield bubble was drawn in the last visual update. */
  isShieldBubbleVisible(): boolean {
    return this.shieldBubbleDrawn;
  }

  /** Whether the P6 phase ghost is currently active. */
  isPhaseGhostActive(): boolean {
    return this.effectsRegistry.isPhased;
  }

  /** The shield-bubble Graphics (null before create/teardown; for tests). */
  getShieldBubbleGraphics(): Phaser.GameObjects.Graphics | null {
    return this.shieldBubble;
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
    return this.mineralHoldModel.store;
  }

  /** Current gym mineral hold capacity. */
  getMineralCapacity(): number {
    return this.mineralHoldModel.capacity;
  }

  /** Whether the hold-full choice overlay is open. */
  isMineralChoiceOpen(): boolean {
    return this.mineralChoiceOpen;
  }

  /** The options currently offered by the hold-full choice (copy). */
  getMineralChoiceOptions(): ChoiceOption[] {
    return [...this.mineralChoiceOptions];
  }

  /** Overrides the pluggable choice strategy. */
  setMineralChoiceStrategy(strategy: ChoiceStrategy): void {
    this.mineralChoiceStrategy = strategy;
  }

  /**
   * Injects the scene-level RNG used by the shared mineral kill-drop rule.
   * Exposed so gym tests can make non-asteroid re-drops deterministic; the
   * default (`Math.random`) is used in production.
   */
  setSceneRng(rng: () => number): void {
    this._sceneRng = rng;
  }

  /** Creates the mineral HUD and seeds the field; called from `create()`. */
  private _initMineralLayer(): void {
    const rules = loadRules();
    // First-hold capacity and growth multiplier come from the shared rules,
    // so the gym's hold progression matches the game exactly
    // (AH-0MUKC6IML0082ZR4).
    this.mineralHoldModel.capacity = rules.mineralHoldCapacity;
    this.mineralHoldModel.collectAmount = rules.mineralCollectAmount;
    this.mineralHoldModel.growthMultiplier =
      rules.mineralHoldGrowthMultiplier;
    this.mineralHoldModel.reset();
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.mineralsSeeded = 0;
    if (!this.hud) {
      this.hud = new HUD(this, this.effectsRegistry, {
        showLives: false,
        // Show each weapon's run-scoped level (parent AH-0MUPMPCB2009J54J).
        getWeaponLevel: (id) => this.player?.getWeaponLevel(id as WeaponId) ?? 0,
      });
    }
    this._syncMineralHud();
    this.seedMinerals(100);
  }

  /**
   * Player collects overlapping minerals into the hold; non-asteroid
   * enemies absorb them. Asteroids are inert to minerals. Runs the shared
   * `collectMinerals` routine — the same code the game runs
   * (AH-0MUII3DHM008L7JF · AC1). The P10 Mineral Scoop attraction pass runs
   * first (shared `_applyMineralScoop`), so a mineral pulled into the hull
   * this frame is collected this frame — matching `PlayScene`.
   */
  private _updateMinerals(dt: number): void {
    if (this.minerals.length === 0) return;
    this._applyMineralScoop(this.minerals, dt);
    // Only mineral-absorbing, non-asteroid entities collect minerals
    // (asteroids are inert — GDD §4.5).
    const absorbers = this.entities.filter(
      (entity): entity is TEntity & MineralAbsorbingEnemy =>
        !(entity instanceof Asteroid) && isMineralAbsorbingEnemy(entity),
    );
    this.minerals = collectMinerals(
      this.minerals,
      this.player,
      absorbers,
      () => this._collectMineral(),
      { playerPhased: this.isPlayerPhased() },
    );
  }

  /** Collects a mineral into the shared hold; opens the choice when full. */
  private _collectMineral(): void {
    this.mineralHoldModel.collect();
    this._syncMineralHud();
    if (this.mineralHoldModel.isFull) this.openMineralChoice();
  }

  /** Mirrors the gym hold onto the HUD mineral hold bar. */
  private _syncMineralHud(): void {
    this.hud?.setMineralStore(
      this.mineralHoldModel.store,
      this.mineralHoldModel.capacity,
    );
  }

  /**
   * Opens the hold-full choice overlay, pausing the gym scene and launching
   * `MineralChoiceScene` with the single `onSelect` contract. The pick is
   * applied permanently and the hold resolved with any overflow.
   */
  openMineralChoice(): ChoiceOption[] {
    if (this.mineralChoiceOpen) return [...this.mineralChoiceOptions];
    this.mineralChoiceOptions = this.mineralChoiceStrategy.choose(3, undefined, {
      // Offer level-ups for weapons the player already owns (parent
      // AH-0MUPMPCB2009J54J); an unarmed player falls back to the base pool.
      weaponLevels: this.player?.getWeaponLevels() ?? [],
      // Offer level-ups for power-ups the player already owns (parent
      // AH-0MUV5CLVO002ZHS9); an unowned player falls back to the base pool.
      powerUpLevels: this.player?.getPowerUpLevels() ?? [],
    });
    this.mineralChoiceOpen = true;
    this.scene.launch('MineralChoiceScene', {
      options: [...this.mineralChoiceOptions],
      onSelect: (index: number) => this.selectMineralChoice(index),
    });
    this.scene.pause();
    return [...this.mineralChoiceOptions];
  }

  /**
   * Applies the chosen option permanently for the gym run, resumes the gym
   * scene, and resolves the hold with the override carry
   * (store = collected − capacity). Returns the chosen option, or null for
   * an out-of-range index.
   */
  selectMineralChoice(index: number): ChoiceOption | null {
    const option = this.mineralChoiceOptions[index];
    if (!option) return null;
    applyMineralChoiceReward(option, this.effectsRegistry, this.player);
    this.mineralChoiceOpen = false;
    this.mineralChoiceOptions = [];
    this.mineralHoldModel.resolve();
    this._syncMineralHud();
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

    // Advance the formation base unconditionally; when the whole formation
    // has crossed the right edge, respawn it off the left edge so it flies
    // again. No entity can freeze the drift (the obsolete formation-hold seam
    // was removed in AH-0MUAYB957002EMYV).
    this.formationBaseX += config.driftSpeed * dt;
    if (this.formationBaseX > GAME_WIDTH + 60) {
      this.formationBaseX = this._respawnX();
    }

    // Diver re-anchor (GDD §4.1 — E2, AH-0MUAYB957002EMYV): if a Diver's
    // attack finished, re-base the Diver-group origin so its slot coincides
    // with the attack end. Applied after the drift and before the positioning
    // pass so the Divers use the new origin in the same frame; every other
    // enemy is unaffected (AH-0MUL15N63003PUDB).
    const reanchorApplied = this._applyFormationReanchor();

    // Position each enemy from the formation base + its own offset.
    for (const entity of this.entities) {
      // Live mineral-seek: push the scene's live mineral field BEFORE the
      // entity advances its own motion, so a roaming seeker (Harvester)
      // steers on the same frame it receives a target — matching the game's
      // `PlayScene._moveEnemies` ordering exactly (F4 parity).
      entity.setSeekTargets?.(this.minerals);

      // Roaming enemies (e.g. Asteroid) advance their own straight-line
      // motion + wrap + rotation; a no-op for formation enemies.
      entity.updatePosition?.(dt);

      // Only re-anchor-capable entities (Divers) ride the Diver re-anchor
      // offset; every other enemy uses the shared base alone and therefore
      // stays where it is when a Diver re-anchors (AC5).
      const isDiver = entity.consumeFormationReanchor != null;
      entity.applyFormationPosition(
        this.formationBaseX + (isDiver ? this.diverAnchorX : 0),
        this.formationBaseY + (isDiver ? this.diverAnchorY : 0),
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

    // If a re-anchor fired (now or on an earlier frame), ease every entity
    // from its old position to the live (drifting) slot over a short glide
    // (AH-0MUL15N63003PUDB). Applied once after the positioning pass so each
    // entity's live target is read after `applyFormationPosition` set it for
    // this frame. A no-op when no glide is active.
    if (reanchorApplied || this.glide.active) {
      this.glide.update(dt);
    }

    // Advance the wormhole spawn animation (AC1–AC4): grown enemies are
    // marked spawned and the wormhole closes once every entity has finished.
    this._updateSpawnAnimations(dt);

    // Shared boss advance (AH-0MUII3E5E006A93F, AC1): appended boss bullets
    // are advanced by the shared bullet lifecycle below, matching the
    // PlayScene ordering relative to collisions. A no-op without a boss.
    this._advanceBoss(dt);

    // Advance bullets; wrap across all four edges and expire by lifetime
    // (AH-0MU960UTE001PTV0). Bullets are never culled for off-screen
    // position. Shared with PlayScene/GymPowerUpsCombat so the semantics
    // cannot drift (AH-0MUII3CF00024EDM, gap 3).
    this._advanceEnemyBullets(dt);

    // ── Player ship: shared control step + bullet lifecycle ────
    if (this.player) {
      // Shared input → timers → multipliers → physics → auto-fire step
      // (AH-0MUII39KX007YUQ0, AC1).
      this._tickPlayer(dt);
      this._advancePlayerBullets(dt);

      // Automatic Phase Shift (P6): feed live danger before collision gating
      // so a trigger this frame protects this frame (parent AH-0MUIYX1EE008FVS8).
      this._updatePhaseShiftAutoTrigger(dt);

      // Collisions + post-hit invulnerability blink (player component only).
      this._handleCollisions();
      this._updateInvulnerability(dt);
    }

    // ── Mineral layer: collection + hold-full choice ────────────────
    this._updateMinerals(dt);

    // ── Optional power-up layer: cadence + drop lifecycles ───────────
    this._updatePowerUpLayer(dt);

    // ── P7 teleport (S/↓) — independent of the opt-in drop layer ─────
    // The minerals gym grants P7 through the hold-full choice, so the
    // handler must run even when field drops are disabled
    // (AH-0MUHMXWGC0058BO4 · AC2).
    this._handleTeleport();

    // ── Effect timers + HUD — independent of the opt-in drop layer ───
    // Timed effects (e.g. P6 granted on teleport arrival) and the HUD must
    // advance in every gym, not only those with field drops.
    this.effectsRegistry.tick(dt);
    this.hud?.refresh();

    // ── Shared P3/P6 player visuals (parity with the other scenes) ──
    // Runs after the power-up layer so a drop collected this frame is
    // reflected immediately. Safe when no player is present.
    this._updateEffectVisuals();
    this._updatePhaseShiftJuice(dt);

    // ── Opt-in wave-timeout: detonate survivors before wipe detection ──
    // Runs first so a timeout that wipes the wave is observed by the
    // countdown tick below (AH-0MUNR5LM1004B223).
    this._advanceWaveTimeout(dt);
    this._drawWaveTimeoutBar();

    // ── Wipe detection → 3s countdown → formation respawn ───────────
    this._tickRespawnCountdown(dt);
  }

  /**
   * Advances the wormhole spawn animation for every spawning entity.
   * Once all entities have finished growing the wormhole closes and
   * every entity is marked fully spawned (AC1–AC4, gym parity).
   */
  private _updateSpawnAnimations(dt: number): void {
    let anySpawning = false;
    for (const entity of this.entities) {
      if (!entity.isSpawning) continue;
      const stillGrowing = updateSpawnAnimation(entity as unknown as SpawnAnimatable, dt);
      if (stillGrowing) {
        anySpawning = true;
      } else {
        entity.setSpawning?.(false);
      }
    }
    if (!anySpawning && this._spawnWormhole) {
      spawnWormholeClose(this, this._spawnWormhole);
      this._spawnWormhole = null;
    }
  }

  /**
   * Test seam: immediately completes any in-progress wormhole spawn
   * animations without ticking the whole scene (AH-0MURBER4L00821RR).
   * Not used by gameplay.
   */
  finishSpawnAnimations(): void {
    for (const entity of this.entities) {
      if (!entity.isSpawning) continue;
      updateSpawnAnimation(entity as unknown as SpawnAnimatable, 10);
      entity.setSpawning?.(false);
    }
    if (this._spawnWormhole) {
      spawnWormholeClose(this, this._spawnWormhole);
      this._spawnWormhole = null;
    }
  }

  /**
   * Consumes any pending entity re-anchor requests (GDD §4.1 — E2, Diver)
   * and re-bases `formationBaseX`/`formationBaseY` so the requesting entity's
   * slot lands on its attack-end position. Every other entity shifts by the
   * same delta, preserving the grid's relative offsets. The most recent
   * request wins when Divers are desynchronised (documented assumption).
   *
   * @returns `true` if a re-anchor was applied (and the glide was begun),
   *   `false` otherwise.
   */
  private _applyFormationReanchor(): boolean {
    let latest: FormationReanchorRequest | null = null;
    for (const entity of this.entities) {
      const request = entity.consumeFormationReanchor?.();
      if (request) latest = request;
    }
    if (!latest) return false;

    // Re-anchor the Diver group only: the delta moves the Diver origin so the
    // requester's slot lands on the attack end. Every other enemy is left
    // exactly where it is (producer review, AH-0MUL15N63003PUDB) — the shared
    // formation base is untouched.
    const { dx, dy } = computeFormationReanchorDelta(
      latest,
      this.formationBaseX + this.diverAnchorX,
      this.formationBaseY + this.diverAnchorY,
      this.config.spacingX,
      this.config.spacingY,
    );
    this.diverAnchorX += dx;
    this.diverAnchorY += dy;

    // Only the re-anchor-capable (Diver) entities glide to their new slots;
    // non-Divers did not move this frame, so they are not tracked.
    const glideTargets = this.entities.filter(
      (entity) => entity.consumeFormationReanchor != null,
    );
    this.glide.begin(glideTargets);
    return true;
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
    // Shared mineral kill-drop rule (GDD §4.5): a small asteroid leaves one
    // mineral, large/medium split instead, and a non-asteroid enemy re-drops
    // a fraction of the minerals it absorbed — exactly as the game does.
    this._dropMineralsForKill(entity);
    this.config.onEntityDestroyed?.(entity);
  }

  /**
   * Applies the shared mineral kill-drop rule to a destroyed entity and adds
   * the resulting minerals to this gym's live mineral field.
   */
  private _dropMineralsForKill(entity: TEntity): void {
    const drops = resolveMineralKillDrops(
      this,
      entity as unknown as MineralKillDropEntity,
      this._sceneRng,
    );
    if (drops.length > 0) this.minerals.push(...drops);
  }

  /** Advances player bullets and removes those whose lifetime has elapsed. */
  private _advancePlayerBullets(dt: number): void {
    this.playerBullets = advancePlayerBullets(this.playerBullets, dt);
  }

  /**
   * Advances enemy bullets through the shared lifecycle helper: four-edge
   * wrap + lifetime expiry, the single implementation every scene consumes
   * (AH-0MUII3CF00024EDM, gap 3).
   */
  private _advanceEnemyBullets(dt: number): void {
    advanceWrappingBullets(this.bullets, dt, GAME_WIDTH, GAME_HEIGHT);
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

  // ── Shared wipe → countdown → respawn + wave-timeout hooks ──────
  // The wipe→3 s countdown→respawn lifecycle and the wave-timeout state
  // machine live in the shared `CombatScene` core (AH-0MUNR5LM1004B223);
  // this scene supplies only its config-driven specifics through the hooks
  // below so every combat scene runs one implementation.

  /** Opt-in timeout duration from the scene config (0 disables). */
  protected override getWaveTimeoutDuration(): number {
    return this.config.timeoutDuration ?? 0;
  }

  /**
   * Pause the timeout while the wipe→respawn countdown is active so the two
   * lifecycles never overlap.
   */
  protected override isWaveTimeoutPaused(): boolean {
    return this.respawnCountdownActive;
  }

  /**
   * On timeout expiry survivors are **kept** (the shared base no longer
   * detonates them — AH-0MUNS3ZQ1002DJ9S) and the gym refreshes through the
   * existing 3 s wipe→respawn countdown. At the countdown's end a fresh
   * formation is spawned alongside the surviving enemies so both must be
   * cleared (game parity).
   */
  protected override onWaveTimeoutExpired(): void {
    this._startRespawnCountdown();
  }

  /**
   * Rebuild the formation when the shared countdown elapses, preserving any
   * live survivors so a fresh formation spawns alongside them (carry-over
   * parity with `PlayScene._timeoutWave`, AH-0MUNS3ZQ1002DJ9S).
   */
  protected override respawnWave(): void {
    this.respawnWithCarriedSurvivors();
  }

  /**
   * Carry-over respawn (AH-0MUNS3ZQ1002DJ9S): keep every live entity where
   * it is, drop only the dead ones, and add a fresh formation alongside the
   * survivors. Both the survivors and the fresh formation must be destroyed
   * before the wipe→respawn countdown can trigger again.
   *
   * Distinct from {@link respawnFormation}, which is a clean slate (used by
   * the manual Respawn button). During the countdown the survivors remain in
   * `entities`, so they keep moving and firing; they are re-anchored to the
   * same formation base as the fresh formation on the next tick.
   */
  protected respawnWithCarriedSurvivors(): void {
    const survivors = this.entities.filter((entity) => entity.alive);

    // No survivors to carry (an ordinary full wipe): a clean-slate respawn is
    // the correct behaviour, including re-resolving the formation base.
    if (survivors.length === 0) {
      this.respawnFormation();
      return;
    }

    // Clear enemy bullets so a stale shot does not instantly hit the player
    // after the respawn. Player bullets are intentionally kept (parity with
    // `respawnFormation`).
    for (const bullet of this.bullets) bullet.graphics.destroy();
    this.bullets.length = 0;

    // Drop the glide for dead entities; survivors keep their live positions.
    this.glide.clear();

    // Keep live survivors in place; tear down only the dead entities.
    for (const entity of this.entities) {
      if (!entity.alive) entity.destroy();
    }
    this.entities = survivors;

    // Rebuild a fresh formation alongside the survivors at the current base
    // (no resample, so the survivors do not jump when the formation base is
    // regenerated). The fresh formation is a complete formation for the
    // configured geometry.
    const wasShooting = this.shootEnabled;
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
    // A fresh formation restarts the opt-in wave-timeout
    // (AH-0MUNR5LM1004B223).
    this.startWaveTimeout();
    playSpawnSound();
  }

  /**
   * Shared formation-respawn seam (AH-0MUII3F7Q002O7WX, gap 9): clears
   * enemy bullets, rebuilds the formation at its initial geometry and
   * preserves the SHOOT toggle. Subclasses that need a manual respawn (e.g.
   * the enemy-gym Respawn button) call this instead of re-implementing it;
   * the wipe→countdown path calls it too.
   *
   * Player bullets are intentionally kept — a subclass that wants a clean
   * slate clears them before calling this (see `GymEnemies._onRespawn`).
   */
  protected respawnFormation(): void {
    // Clear enemy bullets so a stale shot does not instantly hit the player
    // after the respawn. Player bullets are intentionally kept.
    for (const bullet of this.bullets) bullet.graphics.destroy();
    this.bullets.length = 0;

    // Drop any in-flight glide: its tracked entities are about to be
    // destroyed and recreated at the initial geometry (AH-0MUL15N63003PUDB).
    this.glide.clear();

    // Tear down the old (dead) entities and recreate the formation at its
    // initial geometry, matching the initial create() path.
    const wasShooting = this.shootEnabled;
    for (const entity of this.entities) entity.destroy();
    this.entities.length = 0;
    this._resolveFormationBase();
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
    // A fresh formation restarts the opt-in wave-timeout
    // (AH-0MUNR5LM1004B223).
    this.startWaveTimeout();
    playSpawnSound();
  }

  /**
   * Respawns the player ship at the canonical spawn point when it is
   * currently absent; a no-op returning the existing ship otherwise.
   * Returns null when the scene has no player component.
   */
  protected respawnPlayer(): Player | null {
    if (this.player) return this.player;
    const spawn = this.config.player;
    if (this.playerSpawnX === null || this.playerSpawnY === null) {
      if (!spawn) return null;
      this.playerSpawnX = spawn.x;
      this.playerSpawnY = spawn.y;
    }
    const player = new Player(this, {
      x: this.playerSpawnX,
      y: this.playerSpawnY,
    });
    this.add.existing(player);
    this.player = player;
    return player;
  }

  /**
   * Protected player-enable seam (AH-0MUII3F7Q002O7WX, gap 9). Disabling
   * destroys the ship and clears its bullets; enabling respawns the ship at
   * the canonical spawn point. Returns whether a player is present
   * afterwards so subclasses can drive their own panel/UI state without
   * casting into base internals.
   */
  protected setPlayerEnabled(enabled: boolean): boolean {
    if (enabled) {
      this.respawnPlayer();
    } else {
      this.player?.destroy();
      this.player = null;
      for (const bullet of this.playerBullets) bullet.destroy();
      this.playerBullets = [];
    }
    return this.player !== null;
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