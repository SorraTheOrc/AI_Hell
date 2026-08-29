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
} from '../../../core/constants';
import { playDestructionSound, playSpawnSound } from '../../../audio/effects';
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
  keysToInput,
} from '../../../utils/input';
import { MovementInput } from '../../../utils/movement';

/** Contract an enemy entity must satisfy to be driven by the base scene. */
export interface FormationSceneEntity extends Phaser.GameObjects.GameObject {
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

/**
 * Generic formation gym scene. Parameterised by entity + bullet types so
 * concrete scenes keep fully-typed accessors (`formationScouts` etc.).
 */
export class GymFormationScene<
  TEntity extends FormationSceneEntity,
  TBullet extends FormationSceneBullet,
> extends Phaser.Scene {
  private readonly config: EnemyFormationConfig<TEntity, TBullet>;

  protected entities: TEntity[] = [];
  protected bullets: TBullet[] = [];

  /** Keyboard-controlled player ship (null unless `config.player` set). */
  protected player: Player | null = null;
  /** Player bullets in flight (auto-fired toward the direction of travel). */
  protected playerBullets: PlayerBullet[] = [];

  protected formationBaseX: number;
  protected formationBaseY: number;
  private shootEnabled = false;

  // Arrow-key (cursor) and WASD bindings for the player ship.
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;

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
    playDestructionSound();
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

      // Collect any bullets the entity fired this frame.
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
    }
  }

  /** Reads the held arrow/WASD keys into the MovementInput contract. */
  private _readPlayerInput(): MovementInput | null {
    if (!this.cursors || !this.wasd) return null;
    return keysToInput(this.cursors, this.wasd);
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
      this.playerBullets.push(
        createPlayerBullet(
          this,
          bd.x,
          bd.y,
          bd.color,
          PLAYER_BULLET_RADIUS,
          vel.vx,
          vel.vy,
        ),
      );
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

  /** x-coordinate that puts the whole formation off the left edge. */
  private _respawnX(): number {
    const maxAbsCol = Math.max(
      ...this.entities.map((e) => Math.abs(e.offset.col)),
      0,
    );
    return -maxAbsCol * this.config.spacingX - 40;
  }
}