/**
 * Shared bullet-shape rendering seam (AH-0MV8228MD009UBF7).
 *
 * The single, parity-safe place where a projectile's code-drawn appearance
 * is resolved from **visual metadata** and drawn into a Phaser `Graphics`
 * context. `PlayerBullet` (player weapons) and `bulletUtils.createBullet`
 * (enemy bullets) consume it identically in the game and every gym, so the
 * repo's gym↔game parity rule holds by construction: a shape is defined here
 * once and rendered the same everywhere.
 *
 * ## Shape primitives
 *
 * `drawBulletShape` supports at least: **disc** (filled circle, `circle` is
 * the legacy alias), **line/beam** (`line`), **teardrop/streak**
 * (`teardrop`), **missile**, **ring**, **shell**, **jagged bolt** (`bolt`),
 * plus the roster's `diamond`, `spark` (4-point star) and `chevron`
 * primitives needed to give every weapon a unique in-flight identity.
 *
 * Shapes are drawn in the Graphics' local space, long axis along +x; callers
 * orient the GameObject with `setRotation(heading)` (see `PlayerBullet._draw`).
 *
 * ## Registries
 *
 * - Player weapons resolve through `resolvePlayerBulletVisual(def)` — the
 *   weapon catalogue (`src/utils/weapons.ts`) stays the single source of
 *   truth for `bulletShape` / `bulletShapeLength` / `bulletRim` /
 *   `bulletThickness`.
 * - Enemy bullet identities resolve through `resolveEnemyBulletVisual(archetype)`
 *   from `ENEMY_BULLET_VISUALS`, keyed by the AC identities (Scout/Invader,
 *   Diver, Tank, Phaser, Swarm, Raider, the four Boss patterns, Capturer and
 *   Orbital-Strike). `ENEMY_BULLET_IDENTITIES` documents the roster (aliases
 *   share a family so catalogue-wide uniqueness is testable).
 *
 * Visuals only — no behaviour/balance tuning. Firing logic, speeds, intervals
 * and patterns are untouched; this module changes only how projectiles look.
 *
 * @module utils/bulletVisuals
 */

import type Phaser from 'phaser';

import { PLAYER_BULLET_RADIUS } from '../core/constants';
import type { BulletShape, WeaponDefinition } from './weapons';

// ── Visual metadata shape ──────────────────────────────────────────

/**
 * The visual metadata that determines how a bullet is drawn: the shape
 * primitive, its fill colour, its base radius and the optional
 * elongation/rim/thickness knobs. This is the "signature" the roster tests
 * use to assert catalogue-wide uniqueness.
 */
export interface BulletVisualSpec {
  /** Shape primitive to draw (see module docs). */
  shape: BulletShape;
  /** Fill colour (Phaser integer). */
  color: number;
  /** Base radius in px (the disc radius shapes scale from). */
  radius: number;
  /**
   * Elongation multiplier for the long axis of elongated shapes
   * (line/teardrop/missile/bolt/chevron). Absent → {@link DEFAULT_SHAPE_LENGTH}.
   */
  length?: number;
  /** Optional neon rim/outline colour (Phaser integer). */
  rimColor?: number;
  /**
   * Stroke thickness multiplier for stroked shapes (line/ring/bolt/chevron);
   * `1` uses the default 2 px stroke.
   */
  thickness?: number;
  /** Fill/line alpha (default 1). */
  alpha?: number;
  /**
   * Short fading trail drawn behind the shape (length × radius
   * multiplier) — AH-0MV8228YW0050IXS. Absent → no trail. Drawn last so it
   * reads as the shape's wake; the tapering fade follows the bullet as it
   * flies (the buffer is re-drawn each frame). Visual metadata only.
   */
  tail?: number;
  /**
   * Animated exhaust-flame length (× radius multiplier) drawn behind a
   * `missile` shape's tail (AH-0MV822B1B0048UZT). The flame length shimmers
   * with {@link BulletVisualSpec.time} so a powered missile reads as live;
   * absent → no flame. Visual metadata only.
   */
  flame?: number;
  /**
   * Seconds since the bullet spawned. Shapes with animated parts (the
   * missile exhaust flame) use it to flicker; absent → 0. Set by
   * `PlayerBullet._draw` from its elapsed counter, never by metadata
   * resolvers.
   */
  time?: number;
}

/**
 * Canonical shape name: the legacy `'circle'` name renders as a `disc`.
 * Used by the roster tests so `'circle'` and `'disc'` never count as two
 * distinct signatures.
 */
export function canonicalShape(shape: BulletShape): BulletShape {
  return shape === 'circle' ? 'disc' : shape;
}

/**
 * Default elongation multiplier per shape. Elongated shapes (line, teardrop,
 * missile, bolt, chevron) default to a longer axis; radially symmetric shapes
 * (disc, ring, shell, diamond, spark) ignore the field but keep a `1` entry
 * so the table is total over the shape union.
 */
export const DEFAULT_SHAPE_LENGTH: Record<BulletShape, number> = {
  circle: 1,
  disc: 1,
  line: 4,
  teardrop: 2.2,
  missile: 3,
  ring: 1,
  shell: 1,
  bolt: 2.4,
  diamond: 1,
  spark: 1,
  chevron: 2,
};

/** Default stroke width (px) for stroked shapes. */
const BASE_STROKE = 2;

/**
 * Flickering length (px) of a missile's exhaust flame
 * (AH-0MV822B1B0048UZT). Zero when `flame` is 0 (no flame requested);
 * otherwise a length inside `[0.55, 1.0] × radius × flame` driven by two
 * incommensurate sines of `time`, so the flame shimmers without ever
 * disappearing or outgrowing the body.
 *
 * Pure and delta-time based, so the flame is framerate-independent and
 * unit-testable without a Phaser boot.
 *
 * @param radius - Bullet radius in px.
 * @param time - Seconds since the bullet spawned.
 * @param flame - Flame length multiplier (absent/0 → no flame).
 */
export function missileFlameLength(
  radius: number,
  time: number,
  flame = 0,
): number {
  const max = Math.max(0.1, radius) * flame;
  if (max <= 0) return 0;
  const t = Number.isFinite(time) ? time : 0;
  const shimmer =
    0.5 + 0.25 * Math.sin(t * 47) + 0.25 * Math.sin(t * 71 + 1.3);
  const clamped = Math.min(1, Math.max(0, shimmer));
  return max * (0.55 + 0.45 * clamped);
}

/** Resolves the effective long-axis length for a spec. */
function shapeLength(radius: number, spec: BulletVisualSpec): number {
  return radius * (spec.length ?? DEFAULT_SHAPE_LENGTH[spec.shape]);
}

/**
 * Lays down all of the shape's draw commands into `graphics` in local space,
 * origin at the bullet centre, long axis along +x. The buffer is cleared
 * first so a caller may safely re-draw every frame (the `PlayerBullet.advance`
 * pattern).
 *
 * @param graphics - The Graphics context to draw into.
 * @param spec - The visual metadata driving the draw.
 */
export function drawBulletShape(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
): void {
  graphics.clear();
  const shape = canonicalShape(spec.shape);
  const alpha = spec.alpha ?? 1;
  const stroke = BASE_STROKE * (spec.thickness ?? 1);
  const rim = spec.rimColor;

  switch (shape) {
    case 'disc':
      _disc(graphics, spec, alpha);
      break;
    case 'line':
      _line(graphics, spec, alpha, stroke);
      break;
    case 'teardrop':
      _teardrop(graphics, spec, alpha, rim);
      break;
    case 'missile':
      _missile(graphics, spec, alpha, rim);
      break;
    case 'ring':
      _ring(graphics, spec, alpha, stroke, rim);
      break;
    case 'shell':
      _shell(graphics, spec, alpha, rim);
      break;
    case 'bolt':
      _bolt(graphics, spec, alpha, stroke);
      break;
    case 'diamond':
      _diamond(graphics, spec, alpha, rim);
      break;
    case 'spark':
      _spark(graphics, spec, alpha, rim);
      break;
    case 'chevron':
      _chevron(graphics, spec, alpha, stroke, rim);
      break;
  }
  if (spec.tail !== undefined && spec.tail > 0) {
    _bulletTail(graphics, spec, alpha);
  }
}

/**
 * Short fading trail: three overlapping tapering segments behind the shape's
 * trailing edge, faint at the tip and brightening toward the body so the
 * bullet reads as a compact disc with a fading wake (AH-0MV8228YW0050IXS).
 */
function _bulletTail(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const full = r * (spec.tail ?? 0);
  if (full <= 0) return;
  const startX = -r * 0.85;
  const segments: ReadonlyArray<Readonly<[number, number]>> = [
    [full, 0.16],
    [full * 0.66, 0.3],
    [full * 0.33, 0.48],
  ];
  for (const [len, segAlpha] of segments) {
    const h = r * 0.55 * (len / full);
    graphics.fillStyle(spec.color, Math.min(1, alpha * segAlpha));
    graphics.fillTriangle(startX, h, startX - len, 0, startX, -h);
  }
}

/** Filled disc (the `circle`/`disc` primitive) plus an optional rim. */
function _disc(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
): void {
  const r = Math.max(0.1, spec.radius);
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.fillPath();
  if (spec.rimColor !== undefined) {
    graphics.lineStyle(1.5, spec.rimColor, alpha);
    graphics.beginPath();
    graphics.arc(0, 0, r + 0.5, 0, Math.PI * 2, false);
    graphics.strokePath();
  }
}

/** Straight line/beam segment with rounded end caps. */
function _line(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  stroke: number,
): void {
  const half = shapeLength(spec.radius, spec) / 2;
  graphics.lineStyle(stroke, spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(-half, 0);
  graphics.lineTo(half, 0);
  graphics.strokePath();
  // Rounded end caps — the beam reads as a bar, not a hairline.
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(-half, 0, stroke / 2, 0, Math.PI * 2, false);
  graphics.fillPath();
  graphics.beginPath();
  graphics.arc(half, 0, stroke / 2, 0, Math.PI * 2, false);
  graphics.fillPath();
}

/** Teardrop/streak: a disc body with a tapering tail. */
function _teardrop(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const tail = shapeLength(spec.radius, spec);
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.fillPath();
  // Tapered tail from the body's rear to the trailing tip (a filled
  // triangle so the streak reads as a distinct shape primitive).
  graphics.fillTriangle(-r * 0.45, r * 0.75, -tail, 0, -r * 0.45, -r * 0.75);
  if (rim !== undefined) {
    graphics.lineStyle(1, rim, alpha * 0.9);
    graphics.beginPath();
    graphics.arc(0, 0, r + 0.4, 0, Math.PI * 2, false);
    graphics.strokePath();
  }
}

/** Missile: capsule body, nose cone, tail fins and a flickering exhaust flame. */
function _missile(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const len = shapeLength(spec.radius, spec);
  const bodyX = (-len * 0.28) as number;
  const bodyW = len * 0.68;
  const halfH = r * 0.45;
  graphics.fillStyle(spec.color, alpha);
  // Body capsule.
  graphics.fillRect(bodyX, -halfH, bodyW, halfH * 2);
  // Nose cone.
  graphics.fillTriangle(
    bodyX + bodyW,
    -halfH,
    bodyX + bodyW + r * 1.1,
    0,
    bodyX + bodyW,
    halfH,
  );
  // Tail fins (top and bottom).
  for (const dir of [-1, 1]) {
    graphics.fillTriangle(
      bodyX,
      dir * halfH,
      bodyX - r * 0.55,
      dir * r,
      bodyX + r * 0.35,
      dir * halfH,
    );
  }
  // Neon rim around the body + nose so the missile pops (AH-0MV822B1B0048UZT).
  if (rim !== undefined) {
    graphics.lineStyle(1, rim, alpha);
    graphics.beginPath();
    graphics.moveTo(bodyX, -halfH);
    graphics.lineTo(bodyX + bodyW, -halfH);
    graphics.lineTo(bodyX + bodyW + r * 1.1, 0);
    graphics.lineTo(bodyX + bodyW, halfH);
    graphics.lineTo(bodyX, halfH);
    graphics.closePath();
    graphics.strokePath();
  }
  // Flickering exhaust flame behind the tail (AH-0MV822B1B0048UZT): an
  // outer body-coloured flame with a white-hot inner core. Its length is a
  // pure function of the bullet's elapsed time, so the missile reads as
  // powered and the flame shimmers frame to frame.
  const flameLen = missileFlameLength(r, spec.time ?? 0, spec.flame ?? 0);
  if (flameLen > 0) {
    graphics.fillStyle(spec.color, alpha * 0.9);
    graphics.fillTriangle(bodyX, -halfH, bodyX - flameLen, 0, bodyX, halfH);
    graphics.fillStyle(0xffffff, alpha);
    graphics.fillTriangle(
      bodyX,
      -halfH * 0.5,
      bodyX - flameLen * 0.55,
      0,
      bodyX,
      halfH * 0.5,
    );
  }
}

/** Ring: a stroked ring (with a faint core disc for presence). */
function _ring(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  stroke: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  void rim;
  graphics.lineStyle(stroke, spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.strokePath();
  graphics.fillStyle(spec.color, alpha * 0.25);
  graphics.beginPath();
  graphics.arc(0, 0, r * 0.45, 0, Math.PI * 2, false);
  graphics.fillPath();
}

/** Shell: a two-tone round shell with a hot core. */
function _shell(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  void rim;
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.fillPath();
  // Hot core offset toward the trailing side — reads as a burning shell.
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.9));
  graphics.beginPath();
  graphics.arc(-r * 0.2, 0, r * 0.45, 0, Math.PI * 2, false);
  graphics.fillPath();
}

/** Jagged bolt: a multi-segment zig-zag stroke. */
function _bolt(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  stroke: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  graphics.lineStyle(stroke, spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(-half, 0);
  graphics.lineTo(-half / 3, -r * 0.75);
  graphics.lineTo(half / 3, r * 0.75);
  graphics.lineTo(half, 0);
  graphics.strokePath();
}

/** Diamond: a filled four-point rhombus. */
function _diamond(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const h = r * 1.15;
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(r, 0);
  graphics.lineTo(0, h);
  graphics.lineTo(-r, 0);
  graphics.lineTo(0, -h);
  graphics.closePath();
  graphics.fillPath();
  if (rim !== undefined) {
    graphics.lineStyle(1.5, rim, alpha);
    graphics.beginPath();
    graphics.moveTo(r, 0);
    graphics.lineTo(0, h);
    graphics.lineTo(-r, 0);
    graphics.lineTo(0, -h);
    graphics.closePath();
    graphics.strokePath();
  }
}

/** Spark: a filled four-point star (the rapid-fire flare). */
function _spark(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const inner = r * 0.28;
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(r, 0);
  graphics.lineTo(inner, inner);
  graphics.lineTo(0, r);
  graphics.lineTo(-inner, inner);
  graphics.lineTo(-r, 0);
  graphics.lineTo(-inner, -inner);
  graphics.lineTo(0, -r);
  graphics.lineTo(inner, -inner);
  graphics.closePath();
  graphics.fillPath();
  if (rim !== undefined) {
    graphics.lineStyle(1, rim, alpha);
    graphics.beginPath();
    graphics.arc(0, 0, r * 0.4, 0, Math.PI * 2, false);
    graphics.strokePath();
  }
}

/** Chevron: a stroked forward-opening V. */
function _chevron(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  stroke: number,
  rim?: number,
): void {
  void rim;
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  graphics.lineStyle(stroke, spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(-half, -r * 0.7);
  graphics.lineTo(0, 0);
  graphics.lineTo(-half, r * 0.7);
  graphics.strokePath();
}

// ── Player weapon visual resolution ────────────────────────────────

/**
 * Resolves the visual spec a weapon's bullets are drawn with, derived from
 * the weapon definition (the catalogue stays the single source of truth).
 *
 * The spec's radius is the base player-bullet radius scaled by the weapon's
 * `bulletSize` flavour; the level-resolved radius applied at spawn time
 * (`PLAYER_BULLET_RADIUS × levelBulletSize`) is layered on by the shared
 * spawn path, so this function is for roster/test use and for children to
 * read a weapon's intended look.
 *
 * @param def - A (base or level-resolved) weapon definition.
 */
export function resolvePlayerBulletVisual(
  def: WeaponDefinition,
): BulletVisualSpec {
  return {
    shape: def.bulletShape,
    color: def.bulletColor,
    radius: PLAYER_BULLET_RADIUS * (def.bulletSize ?? 1),
    length: def.bulletShapeLength,
    rimColor: def.bulletRim,
    thickness: def.bulletThickness,
    tail: def.bulletTrail,
    flame: def.bulletFlame,
  };
}

// ── Enemy bullet identity registry ─────────────────────────────────

/**
 * Enemy bullet archetype identities nameable in the shared enemy-bullet seam
 * (parent AH-0MV2K5SR0005RTTE). Each of the AC enemy attacks maps to one
 * identity; the Scout and the (Space Invaders) March block share the
 * `scout-invader` family.
 */
export type EnemyBulletArchetype =
  | 'scout'
  | 'march'
  | 'diver'
  | 'tank'
  | 'phaser'
  | 'swarm'
  | 'raider'
  | 'boss-spread'
  | 'boss-spiral'
  | 'boss-pulse'
  | 'boss-desperation'
  | 'capturer'
  | 'orbital-strike';

/**
 * An enemy bullet's visual identity — the shape/colour/feel knobs the shared
 * `bulletUtils.createBullet` seam consumes. `radius` is deliberately *not*
 * part of the identity: each entity sizes its own shots (`bulletSize`), so
 * two identities stay distinct even at the same size.
 */
export interface EnemyBulletVisual {
  /** Shape primitive (see module docs). */
  shape: BulletShape;
  /** Fill colour (Phaser integer). */
  color: number;
  /** Elongation multiplier for elongated shapes (optional). */
  length?: number;
  /** Rim/outline colour (optional). */
  rimColor?: number;
  /** Stroke thickness multiplier (optional). */
  thickness?: number;
  /** Fill/line alpha (optional). */
  alpha?: number;
}

/**
 * The registered per-identity enemy bullet visuals. Colours mirror each
 * archetype's existing `*_BULLET_COLOR` so identity is carried by *shape +
 * colour* together, never a behaviour/balance re-tune.
 */
export const ENEMY_BULLET_VISUALS: Record<EnemyBulletArchetype, EnemyBulletVisual> = {
  scout: { shape: 'disc', color: 0xff4444 },
  march: { shape: 'disc', color: 0xff4444 },
  diver: { shape: 'teardrop', color: 0xffee88, length: 1.8 },
  tank: { shape: 'shell', color: 0xffaa00 },
  phaser: { shape: 'bolt', color: 0xff4444, length: 1.6 },
  swarm: { shape: 'spark', color: 0x00ccff },
  raider: { shape: 'diamond', color: 0xffddaa },
  'boss-spread': { shape: 'disc', color: 0xffffff, rimColor: 0xff3366 },
  'boss-spiral': { shape: 'ring', color: 0xffffff },
  'boss-pulse': { shape: 'shell', color: 0xffffff },
  'boss-desperation': { shape: 'bolt', color: 0xffdd66, length: 1.8 },
  capturer: { shape: 'line', color: 0xff88ff, length: 2.2 },
  'orbital-strike': { shape: 'shell', color: 0xff4444 },
};

/**
 * The documented enemy bullet roster: every identity plus the family it
 * belongs to. Aliases (Scout + Invader) share a family, so catalogue-wide
 * uniqueness is asserted per family, not per key.
 */
export const ENEMY_BULLET_IDENTITIES: ReadonlyArray<
  Readonly<{ id: EnemyBulletArchetype; family: string }>
> = [
  { id: 'scout', family: 'scout-invader' },
  { id: 'march', family: 'scout-invader' },
  { id: 'diver', family: 'diver' },
  { id: 'tank', family: 'tank' },
  { id: 'phaser', family: 'phaser' },
  { id: 'swarm', family: 'swarm' },
  { id: 'raider', family: 'raider' },
  { id: 'boss-spread', family: 'boss-spread' },
  { id: 'boss-spiral', family: 'boss-spiral' },
  { id: 'boss-pulse', family: 'boss-pulse' },
  { id: 'boss-desperation', family: 'boss-desperation' },
  { id: 'capturer', family: 'capturer' },
  { id: 'orbital-strike', family: 'orbital-strike' },
];

/**
 * Looks up an enemy bullet's registered visual identity.
 * @throws Error for an unknown archetype — fail loud so a new identity is
 *   registered (and roster-tested) before it is consumed.
 */
export function resolveEnemyBulletVisual(
  archetype: EnemyBulletArchetype,
): EnemyBulletVisual {
  const visual = ENEMY_BULLET_VISUALS[archetype];
  if (!visual) {
    throw new Error(`Unknown enemy bullet archetype: ${archetype}`);
  }
  return visual;
}


