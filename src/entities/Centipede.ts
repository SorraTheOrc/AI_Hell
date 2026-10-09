/**
 * Centipede segment entity (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
 *
 * One linked segment of a Centipede chain. The shared chain law lives in
 * `src/scenes/core/centipedeChain.ts`; this class is a thin shell that:
 *
 * - reads its position from the chain each frame (the chain's current lead
 *   advances the whole sub-chain), and
 * - tells the chain when it is destroyed, so a middle segment splits the
 *   chain into two independent sub-chains.
 *
 * Segments **never fire** — the archetype's threat is the weaving body,
 * resolved by the existing enemy-body collision rule. `shootEnabled` is a
 * no-op setter and the effective shot pattern is always `none`. Segments
 * pass through each other and every other enemy (GDD §2.6 — no enemy–enemy
 * collision).
 *
 * The entity is deliberately shared code: `PlayScene` and `GymCentipede`
 * construct the same class over the same chain model, so the game and the
 * gym cannot diverge.
 *
 * @module entities/Centipede
 */

import Phaser from 'phaser';

import type { EnemyShotPattern } from '../core/configTypes';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import type { FormationOffset } from '../utils/formations';
import type { CentipedeChain } from '../scenes/core/centipedeChain';

// ── Visual / behaviour tuning ───────────────────────────────────────

/** Default segment body colour — classic neon centipede green. */
export const CENTIPEDE_COLOR = 0x33ff88;
/** Default segment half-size (px). */
export const CENTIPEDE_SIZE = 14;

/** Config accepted by a Centipede segment. */
export interface CentipedeConfig {
  x: number;
  y: number;
  /** Offset within the (non-existent) formation; required by the base class. */
  formationOffset: FormationOffset;
  /** The shared chain this segment belongs to. */
  chain: CentipedeChain;
  /** This segment's stable id within the chain. */
  segmentId: number;
  /** Optional config-driven overrides; when absent the constants above win. */
  size?: number;
  color?: number;
  bulletColor?: number;
  health?: number;
  rng?: () => number;
}

/** One segment of a linked Centipede chain. Never fires; body contact is its threat. */
export class Centipede extends BaseEnemy {
  private readonly _chain: CentipedeChain;
  private readonly _segmentId: number;

  constructor(scene: Phaser.Scene, config: CentipedeConfig) {
    const baseConfig: BaseEnemyConfig = {
      formationOffset: config.formationOffset,
      size: config.size ?? CENTIPEDE_SIZE,
      color: config.color ?? CENTIPEDE_COLOR,
      bulletColor: config.bulletColor,
      health: config.health,
      rng: config.rng,
    };
    super(scene, config.x, config.y, baseConfig);

    this._chain = config.chain;
    this._segmentId = config.segmentId;

    this._drawBody();
    this.addSharedGraphics();
  }

  /** Archetype key (`'centipede'`), matching the scene's enemy key. */
  override get archetype(): string {
    return 'centipede';
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  // ── Chain seam ───────────────────────────────────────────────────

  /** The shared chain this segment belongs to. */
  get chain(): CentipedeChain {
    return this._chain;
  }

  /** This segment's stable id within the chain. */
  get segmentId(): number {
    return this._segmentId;
  }

  // ── Drawing ──────────────────────────────────────────────────────

  /**
   * Draws a small neon rounded segment with a forward chevron. Style is set
   * **after** `clear()` (Graphics is command-buffered) so the body never
   * inherits Phaser's module-global stroke tint (docs/ENEMY_DESIGN_AND_IMPLEMENTATION
   * §4.2).
   */
  protected _drawBody(): void {
    const g = this.bodyGraphics;
    const r = this._size / 2;
    g.clear();
    g.lineStyle(2, this._color, 1);

    // Rounded body: a hexagon reads as a segmented carapace.
    const points: Array<[number, number]> = [
      [r, 0],
      [r * 0.5, r * 0.9],
      [-r * 0.5, r * 0.9],
      [-r, 0],
      [-r * 0.5, -r * 0.9],
      [r * 0.5, -r * 0.9],
    ];
    g.beginPath();
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
    g.closePath();
    g.strokePath();

    // Forward chevron marker so the chain's heading is readable.
    g.beginPath();
    g.moveTo(r * 0.75, 0);
    g.lineTo(r * 0.25, r * 0.35);
    g.moveTo(r * 0.75, 0);
    g.lineTo(r * 0.25, -r * 0.35);
    g.strokePath();
  }

  // ── Effective config (for tests / gym tuning) ────────────────────

  /** Effective config-driven size (for tests). */
  get effectiveSize(): number {
    return this._size;
  }

  /** Effective config-driven body colour (for tests). */
  get effectiveColor(): number {
    return this._color;
  }

  // ── No-fire guarantee ────────────────────────────────────────────

  /**
   * Both halves of the shootEnabled accessor pair are overridden so reads
   * stay false and writes are ignored (the Centipede never fires).
   */
  override get shootEnabled(): boolean {
    return false;
  }

  override set shootEnabled(_value: boolean) {
    // No-op — the Centipede never fires; body contact is the threat.
  }

  /** Effective shot pattern is always 'none'. */
  get effectiveShotPattern(): EnemyShotPattern {
    return 'none';
  }

  /** Whether this enemy uses formation-based movement. Segments do not. */
  isFormationEnemy(): boolean {
    return false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Marks this segment destroyed in the shared chain, then runs the standard
   * base destruction (hidden body + explosion). The chain splits or shortens
   * itself from the recorded death.
   */
  override destroySelf(scale = 1): void {
    if (!this._alive) return;
    this._chain.destroySegment(this._segmentId);
    super.destroySelf(scale);
  }

  /**
   * Reads this segment's current position from the chain. Only the current
   * lead of a sub-chain advances it — the other segments are simply placed —
   * so a shared chain advances exactly once per frame regardless of how many
   * segment entities call this.
   *
   * The formation base is ignored: the chain owns its own weave and descent.
   * The `baseX`/`baseY`/spacing parameters keep the shared entity signature
   * intact.
   */
  applyFormationPosition(
    _baseX: number,
    _baseY: number,
    dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;
    this._chain.tick(dt, this._segmentId);
    const segment = this._chain.segment(this._segmentId);
    if (segment) this.setPosition(segment.x, segment.y);
  }
}
