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
  AsteroidsInputHandler,
  ControlInput,
  FourDirectionalInputHandler,
} from '../../../utils/movementModel';

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

/** Blink half-period (s) while the player is invulnerable after a hit. */
const PLAYER_BLINK_INTERVAL = 0.1;

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

    // ── Controls (top-left HUD, minimal) ────────────────────────────
    this.explodeButton = this._addButton(10, 10, 'EXPLODE', LABEL_STYLE);
    this.shootButton = this._addButton(120, 10, 'SHOOT: OFF', LABEL_STYLE);

    this.explodeButton.on('pointerdown', () => this.explodeRandom());
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.statusText = this.add.text(
      10,
      44,
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
   * Auto-fires the equipped weapon toward the direction of travel when
   * its cooldown has elapsed (mirrors GymWeapons' auto-fire).
   */
  private _autoFire(dt: number): void {
    if (!this.player) return;
    if (!this.player.tryFire(dt)) return;

    const headingDeg = (this.player.getHeading() * 180) / Math.PI;
    const weaponDef = this.player.getWeaponDef();
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

    const entityHitRadius = this.getEntityHitRadius();
    const bulletHitRadius = this.getBulletHitRadius();
    const playerHull = SHIP_SIZE / 2;

    // 1. Player bullets vs enemy entities: destroy the enemy, consume
    //    the bullet. Rebuild the list so consumed bullets are dropped.
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
            entityHitRadius,
          )
        ) {
          entity.destroySelf();
          if (entity.playDestructionAudio) {
            entity.playDestructionAudio();
          } else {
            playDestructionSound();
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
   * Spawns a tweened expanding-ring explosion at (x, y) — the player
   * equivalent of `Scout.playExplosion`. Tracked in `playerExplosions`
   * so tests can observe the VFX without pixel assertions.
   */
  private _spawnPlayerExplosion(x: number, y: number): void {
    const gfx = this.add.graphics({ x, y });
    this.playerExplosions.push(gfx);
    this.tweens.add({
      targets: gfx,
      alpha: { from: 1, to: 0 },
      duration: 400,
      onUpdate: () => {
        const t = gfx.alpha;
        const radius = 8 + 24 * (1 - t);
        gfx.clear();
        gfx.lineStyle(2, 0x00ffff, t);
        gfx.strokeCircle(0, 0, radius);
        gfx.beginPath();
        gfx.moveTo(-radius, 0);
        gfx.lineTo(radius, 0);
        gfx.moveTo(0, -radius);
        gfx.lineTo(0, radius);
        gfx.strokePath();
      },
      onComplete: () => {
        gfx.destroy();
        const idx = this.playerExplosions.indexOf(gfx);
        if (idx >= 0) this.playerExplosions.splice(idx, 1);
      },
    });
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