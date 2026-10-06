/**
 * Read-only bot snapshot — type definition and builder.
 *
 * The bot decision logic (`decideBotInput`) is a pure function over a
 * `BotSnapshot` so it can be unit-tested without a browser, a Phaser scene
 * or any wall-clock state. This module is the adapter between the live
 * `PlayScene` and that pure decision layer: `buildBotSnapshot(scene)` reads
 * the scene's existing public getters and copies the relevant state into a
 * frozen, plain-object snapshot.
 *
 * ## Design
 *
 * - The snapshot is a **deep-frozen** plain object (AC4): neither the
 *   snapshot nor its nested arrays/entries can be mutated after
 *   construction, so the decision layer cannot accidentally write back into
 *   live game state.
 * - The builder depends on a minimal **structural** scene interface
 *   (`BotSnapshotScene`) rather than `PlayScene` itself. `PlayScene`
 *   satisfies it via its existing getters, and tests can pass lightweight
 *   stubs instead of booting Phaser (AC3).
 * - `PlayScene` is wired to the builder in a later child; this module does
 *   not import `PlayScene` (avoiding a scene → AI → scene import cycle).
 *
 * @module src/ai/botSnapshot
 */

/** Discriminator stored on every snapshot mineral entry (AC1). */
export const BOT_MINERAL_TYPE = 'mineral';

// ── Snapshot shape (consumed by the pure decision logic) ─────────────

/** An immutable 2-D point. */
export interface BotVec2 {
  readonly x: number;
  readonly y: number;
}

/** Player position and velocity. */
export interface BotPlayer {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** A single enemy (or asteroid) and its threat-relevant state. */
export interface BotEnemy {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  /** Archetype key, e.g. `'scout'`, `'diver'`, `'asteroid'`. */
  readonly archetype: string;
}

/** An in-flight projectile with position and velocity. */
export interface BotBullet {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** A live power-up / weapon drop. */
export interface BotDrop {
  readonly x: number;
  readonly y: number;
  /** Drop id, e.g. `'P3'`, `'spread'`. */
  readonly type: string;
}

/** A live mineral collectable. */
export interface BotMineral {
  readonly x: number;
  readonly y: number;
  /** Mineral discriminator (currently always {@link BOT_MINERAL_TYPE}). */
  readonly type: string;
}

/** The Central AI boss and its current phase. */
export interface BotBoss {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  readonly phase: number;
}

/**
 * The complete read-only game state the bot decides from. Every field is
 * `readonly`; at runtime the object is deep-frozen by
 * {@link buildBotSnapshot} (AC4).
 */
export interface BotSnapshot {
  readonly player: BotPlayer | null;
  readonly enemies: readonly BotEnemy[];
  readonly enemyBullets: readonly BotBullet[];
  readonly playerBullets: readonly BotBullet[];
  readonly drops: readonly BotDrop[];
  readonly minerals: readonly BotMineral[];
  readonly boss: BotBoss | null;
  readonly aliveCount: number;
}

// ── Structural scene seam (PlayScene satisfies this) ─────────────────

/** Minimal player source: position plus the scene's movement state seam. */
export interface BotPlayerSource {
  readonly x: number;
  readonly y: number;
  getMovementState(): { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number };
}

/** Minimal enemy source (a `BaseEnemy`/`EnemyEntity` satisfies this). */
export interface BotEnemySource {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  readonly archetype: string;
}

/** Minimal enemy-bullet source: position lives on the drawn `graphics`. */
export interface BotEnemyBulletSource {
  readonly graphics: { readonly x: number; readonly y: number };
  readonly vx: number;
  readonly vy: number;
}

/** Minimal player-bullet source. */
export interface BotPlayerBulletSource {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** Minimal drop source. */
export interface BotDropSource {
  readonly x: number;
  readonly y: number;
  readonly dropId: string;
}

/** Minimal mineral source. */
export interface BotMineralSource {
  readonly x: number;
  readonly y: number;
}

/** Minimal boss source. */
export interface BotBossSource {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
}

/**
 * The slice of the owning scene the snapshot builder reads. `PlayScene`
 * satisfies it through its existing public getters; tests provide stubs.
 */
export interface BotSnapshotScene {
  getPlayer(): BotPlayerSource | null;
  getBoss(): BotBossSource | null;
  getBossPhase(): number;
  getEnemies(): readonly BotEnemySource[];
  getEnemyBullets(): readonly BotEnemyBulletSource[];
  getPlayerBullets(): readonly BotPlayerBulletSource[];
  getDrops(): readonly BotDropSource[];
  getMinerals(): readonly BotMineralSource[];
  getAliveCount(): number;
}

// ── Builder ──────────────────────────────────────────────────────────

/**
 * Builds a deep-frozen {@link BotSnapshot} from the scene's existing
 * read-only getters (AC2). The source scene is never mutated: every nested
 * array and entry in the result is a fresh plain object.
 *
 * @param scene — a `PlayScene` (or a structural stub in tests).
 */
export function buildBotSnapshot(scene: BotSnapshotScene): BotSnapshot {
  const playerSource = scene.getPlayer();
  const bossSource = scene.getBoss();

  const player: BotPlayer | null = playerSource
    ? copyMovement(playerSource.getMovementState())
    : null;

  const boss: BotBoss | null = bossSource
    ? {
        x: bossSource.x,
        y: bossSource.y,
        alive: bossSource.alive,
        phase: scene.getBossPhase(),
      }
    : null;

  return deepFreeze({
    player,
    enemies: scene.getEnemies().map((enemy) => ({
      x: enemy.x,
      y: enemy.y,
      alive: enemy.alive,
      archetype: enemy.archetype,
    })),
    enemyBullets: scene.getEnemyBullets().map((bullet) => ({
      x: bullet.graphics.x,
      y: bullet.graphics.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: scene.getPlayerBullets().map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: scene.getDrops().map((drop) => ({
      x: drop.x,
      y: drop.y,
      type: drop.dropId,
    })),
    minerals: scene.getMinerals().map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: BOT_MINERAL_TYPE,
    })),
    boss,
    aliveCount: scene.getAliveCount(),
  });
}

/** Copies the movement state into a plain `BotPlayer` object. */
function copyMovement(state: {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}): BotPlayer {
  return { x: state.x, y: state.y, vx: state.vx, vy: state.vy };
}

/**
 * Recursively freezes an object graph (the snapshot, its arrays and the
 * plain entries inside them). Cycles are impossible here — the builder
 * constructs a fresh tree — but `Object.isFrozen` guards re-freezing in
 * case a future change shares a subtree.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
