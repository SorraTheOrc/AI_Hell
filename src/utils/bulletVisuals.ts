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
 * (`teardrop`), **missile**, **ring**, **shell**, **heavy-shell** (the Tank's
 * large two-tone shell with a slow breathing glow, AH-0MV822DF60001EPA),
 * **shard** (the Diver's sharp splinter/arrowhead with a sweeping spine
 * glint, AH-0MV822D2U000LRFV), **jagged bolt** (`bolt`), **phaser-bolt**
 * (the Phaser's crisply-edged hexagonal bolt with a bright velocity-aligned
 * core streak, AH-0MV822DRX009RYUB), **fleck** (the Swarm's tiny fast
 * cometary micro-shard, AH-0MV822E4T006F37Y), **dart** (the Raider's slim
 * sharp-nosed dart with a short trail, AH-0MV822EH800780GI),
 * plus the roster's `diamond`, `spark` (4-point star), `chevron` and
 * `pellet` (scalloped alien pod with a tinted core + faint pulse,
 * AH-0MV822CQL005R4MM) primitives needed to give every weapon a unique
 * in-flight identity.
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
import type { BulletShape, MuzzleFlashSpec, WeaponDefinition } from './weapons';

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
  'heavy-shell': 1,
  shard: 2.4,
  bolt: 2.4,
  'phaser-bolt': 2.6,
  fleck: 1.4,
  dart: 2.8,
  diamond: 1,
  spark: 1,
  chevron: 2,
  pellet: 1,
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
    case 'heavy-shell':
      _heavyShell(graphics, spec, alpha, rim);
      break;
    case 'shard':
      _shard(graphics, spec, alpha, rim);
      break;
    case 'bolt':
      _bolt(graphics, spec, alpha, stroke);
      break;
    case 'phaser-bolt':
      _phaserBolt(graphics, spec, alpha, rim, stroke);
      break;
    case 'fleck':
      _fleck(graphics, spec, alpha, rim);
      break;
    case 'dart':
      _dart(graphics, spec, alpha, rim);
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
    case 'pellet':
      _pellet(graphics, spec, alpha, rim);
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

/**
 * Heavy armour-piercing shell: the Tank's radial-shot identity
 * (AH-0MV822DF60001EPA).
 *
 * A visibly larger two-tone shell (1.6× the base radius — the AC's "larger
 * body") with a white-hot core and a **slow breathing glow** ring whose
 * alpha swells and fades at 1.8 rad/s with the bullet's age (the AC's "slow
 * glow") — time-driven, so the shared bullet lifecycle redraws it each frame
 * identically in the game and every gym. The lazy ember read is deliberately
 * the opposite of the Scout's fast-pulsing pellet, so the Tank's shells
 * parse as heavy, slow artillery rather than a blinking alien pod.
 */
function _heavyShell(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius) * 1.6;
  // Larger two-tone body: the shell colour with a white-hot core offset
  // toward the trailing side (the shell is burning as it lumbers forward).
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.fillPath();
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.9));
  graphics.beginPath();
  graphics.arc(-r * 0.2, 0, r * 0.42, 0, Math.PI * 2, false);
  graphics.fillPath();
  // Neon rim so the heavy body reads as a solid shell, not a blob.
  if (rim !== undefined) {
    graphics.lineStyle(2, rim, Math.min(1, alpha * 0.9));
    graphics.beginPath();
    graphics.arc(0, 0, r + 1, 0, Math.PI * 2, false);
    graphics.strokePath();
  }
  // Slow breathing glow: a faint outer ring that swells slowly with the
  // bullet's age — the lazy ember halo of a heavy shell.
  const breathe = 0.5 + 0.5 * Math.sin((spec.time ?? 0) * 1.8);
  graphics.lineStyle(1, rim ?? spec.color, Math.max(0, alpha * (0.15 + 0.25 * breathe)));
  graphics.beginPath();
  graphics.arc(0, 0, r * 1.9, 0, Math.PI * 2, false);
  graphics.strokePath();
}

/**
 * Sharp shard/splinter: the Diver's spread-burst identity
 * (AH-0MV822D2U000LRFV).
 *
 * An elongated, razor-edged arrowhead echoing the Diver's dart body and
 * diving arc — a pointed tip flaring to narrow shoulders then tapering to a
 * pointed tail, with a **white-hot spine** running its length and a neon
 * rim in the Diver's own body colour. A bright **glint** sweeps up and down
 * the spine with the bullet's age (time-driven), so the shard reads as live
 * arc-energy rather than a static splinter — the sharp-shard silhouette is
 * deliberately the opposite of the Tank's fat ember shell. The glint is
 * redrawn each frame through the shared bullet lifecycle
 * (`shapeAnimates('shard')` → `createBullet` hands back a redraw hook), so
 * the shimmer is identical in the game and every gym.
 */
function _shard(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  const w = r * 0.95;
  // Razor shard: pointed tip forward (+x), flared shoulders, pointed tail.
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(half, 0);
  graphics.lineTo(-half * 0.15, w);
  graphics.lineTo(-half, r * 0.38);
  graphics.lineTo(-half, 0);
  graphics.lineTo(-half, -r * 0.38);
  graphics.lineTo(-half * 0.15, -w);
  graphics.closePath();
  graphics.fillPath();
  // White-hot spine: the arc-energy core running the shard's length.
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.95));
  graphics.beginPath();
  graphics.moveTo(half * 0.92, 0);
  graphics.lineTo(-half * 0.22, r * 0.42);
  graphics.lineTo(-half * 0.22, -r * 0.42);
  graphics.closePath();
  graphics.fillPath();
  // Neon rim around the razor edge so the shard pops against the field.
  if (rim !== undefined) {
    graphics.lineStyle(1.5, rim, Math.min(1, alpha * 0.9));
    graphics.beginPath();
    graphics.moveTo(half, 0);
    graphics.lineTo(-half * 0.15, w);
    graphics.lineTo(-half, r * 0.38);
    graphics.lineTo(-half, 0);
    graphics.lineTo(-half, -r * 0.38);
    graphics.lineTo(-half * 0.15, -w);
    graphics.closePath();
    graphics.strokePath();
  }
  // Arc-energy glint: a bright mote sweeping tail→tip→tail along the spine
  // with the bullet's age (~1.4 Hz) — the shard shimmers as it flies its
  // diving arc, distinct from the pellet's fast pulse and the shell's slow
  // breathe.
  const t = spec.time ?? 0;
  const sweep = 0.5 + 0.5 * Math.sin(t * 9); // 0 (tail) → 0.5 → 1 (tip)
  const glintX = -half + sweep * (half * 2);
  graphics.fillStyle(
    0xffffff,
    Math.min(1, alpha * (0.3 + 0.35 * Math.abs(Math.cos(t * 9)))),
  );
  graphics.beginPath();
  graphics.arc(glintX, 0, r * 0.3, 0, Math.PI * 2, false);
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

/**
 * Crisp-edged phaser bolt (AH-0MV822DRX009RYUB): the Phaser's radial-shot
 * identity.
 *
 * A smooth hexagonal prism — pointed tips at each end of the long (+x)
 * axis, parallel long edges, no zig-zag — filled with the shot's colour and
 * stroked with a neon rim in the Phaser's own magenta. A **bright white-hot
 * core streak** runs down the velocity line through the prism's centre, so
 * the bolt reads as energy under power (the Phaser's telegraphed radial
 * volleys). Distinct from the jagged `bolt` (a multi-segment stroke with no
 * body) and from the Scout's pulsing pod / Tank's ember shell / Diver's
 * splinter — crisp, straight-edged and velocity-aligned, the Phaser
 * archetype rendered in flight.
 */
function _phaserBolt(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
  stroke: number = BASE_STROKE,
): void {
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  const w = r * 0.85;
  // Hexagonal prism body: pointed nose, parallel edges, pointed tail.
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(half, 0);
  graphics.lineTo(half * 0.55, -w);
  graphics.lineTo(-half * 0.55, -w);
  graphics.lineTo(-half, 0);
  graphics.lineTo(-half * 0.55, w);
  graphics.lineTo(half * 0.55, w);
  graphics.closePath();
  graphics.fillPath();
  // Bright velocity-aligned core streak — energy under power.
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.92));
  graphics.beginPath();
  graphics.moveTo(half * 0.85, 0);
  graphics.lineTo(half * 0.34, -w * 0.5);
  graphics.lineTo(-half * 0.34, -w * 0.5);
  graphics.lineTo(-half * 0.34, w * 0.5);
  graphics.lineTo(half * 0.34, w * 0.5);
  graphics.closePath();
  graphics.fillPath();
  // Neon rim (the Phaser's magenta) around the crisp edge.
  if (rim !== undefined) {
    graphics.lineStyle(stroke, rim, Math.min(1, alpha * 0.9));
    graphics.beginPath();
    graphics.moveTo(half, 0);
    graphics.lineTo(half * 0.55, -w);
    graphics.lineTo(-half * 0.55, -w);
    graphics.lineTo(-half, 0);
    graphics.lineTo(-half * 0.55, w);
    graphics.lineTo(half * 0.55, w);
    graphics.closePath();
    graphics.strokePath();
  }
}

/**
 * Tiny fast cometary fleck (AH-0MV822E4T006F37Y): the Swarm's coordinated-burst
 * shot identity.
 *
 * A small elongated tear/comet — a bright cyan head with a white-hot leading
 * glint and a short pointed tail at the rear — reads as one of a massed,
 * fast-moving swarm of flecks (the tiny-fast-fleck read the AC calls for).
 * Deliberately the smallest, simplest silhouette in the roster: the Swarm
 * fires en masse, so the fleck must stay cheap at high bullet counts while
 * still being visibly different from the Scout's pulsing pod (a rounded
 * scalloped disc) and the Diamond shot of the Raider (a wide 4-point
 * rhombus).
 */
function _fleck(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  // Elongated tear body along +x (the flight axis).
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(half, 0);
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.closePath();
  graphics.fillPath();
  // Pointed tail: a sliver triangle behind the head.
  graphics.fillStyle(spec.color, Math.min(1, alpha * 0.9));
  graphics.beginPath();
  graphics.moveTo(-r * 0.6, -r * 0.5);
  graphics.lineTo(-half * 1.05, 0);
  graphics.lineTo(-r * 0.6, r * 0.5);
  graphics.closePath();
  graphics.fillPath();
  // White-hot leading glint (tiny, so the massed volley stays cheap).
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.85));
  graphics.beginPath();
  graphics.arc(r * 0.45, 0, r * 0.4, 0, Math.PI * 2, false);
  graphics.fillPath();
  // Neon rim (swarm cyan) around the head.
  if (rim !== undefined) {
    graphics.lineStyle(1.5, rim, Math.min(1, alpha * 0.9));
    graphics.beginPath();
    graphics.arc(0, 0, r, 0, Math.PI * 2, false);
    graphics.strokePath();
  }
}

/**
 * Slim sharp-nosed dart (AH-0MV822EH800780GI): the Raider's aimed-shot
 * identity.
 *
 * A long, narrow spearhead — a sharp point forward (+x), thin straight
 * flanks sweeping back to a pair of small swept tail fins — with a white-hot
 * nose tip and a brisk neon rim in a hot pink that echoes the raider's
 * attack-run threat. Deliberately the most needle-like silhouette in the
 * roster (the Raider is a fast committed attacker), distinct from the
 * Raider's own `diamond`-shaped body and every other shot identity.
 */
function _dart(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const half = shapeLength(spec.radius, spec) / 2;
  const w = r * 0.6;
  // Long spearhead body: sharp nose, thin flanks, swept tail.
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.moveTo(half, 0);
  graphics.lineTo(half * 0.25, w);
  graphics.lineTo(-half * 0.72, w * 0.85);
  graphics.lineTo(-half, 0);
  graphics.lineTo(-half * 0.72, -w * 0.85);
  graphics.lineTo(half * 0.25, -w);
  graphics.closePath();
  graphics.fillPath();
  // White-hot nose tip — the dart leads with a bright point.
  graphics.fillStyle(0xffffff, Math.min(1, alpha * 0.9));
  graphics.beginPath();
  graphics.moveTo(half, 0);
  graphics.lineTo(half * 0.3, w * 0.38);
  graphics.lineTo(half * 0.3, -w * 0.38);
  graphics.closePath();
  graphics.fillPath();
  // Neon rim around the slim body.
  if (rim !== undefined) {
    graphics.lineStyle(1.5, rim, Math.min(1, alpha * 0.9));
    graphics.beginPath();
    graphics.moveTo(half, 0);
    graphics.lineTo(half * 0.25, w);
    graphics.lineTo(-half * 0.72, w * 0.85);
    graphics.lineTo(-half, 0);
    graphics.lineTo(-half * 0.72, -w * 0.85);
    graphics.lineTo(half * 0.25, -w);
    graphics.closePath();
    graphics.strokePath();
  }
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

/**
 * Alien pod pellet: a small scalloped body, a bright enemy-tinted core and a
 * faint pulsing rim (AH-0MV822CQL005R4MM).
 *
 * The Scout/Invader aimed shot's distinct in-flight identity: three bump
 * protrusions around a compact disc give the silhouette an alien-pod read
 * (decidedly not the plain disc every enemy uses before it adopts an
 * identity), the `rimColor` inner disc echoes the enemy's own tint (the neon
 * green Scout chevron), and the outer ring breathes with {@link spec.time} —
 * the faint pulse that makes the shot feel alive. The pulse is time-driven,
 * so an enemy bullet carrying this shape redraws each frame through the
 * shared bullet lifecycle (`bulletUtils.createBullet` hands back a `redraw`
 * hook for exactly these animated shapes).
 */
function _pellet(
  graphics: Phaser.GameObjects.Graphics,
  spec: BulletVisualSpec,
  alpha: number,
  rim?: number,
): void {
  const r = Math.max(0.1, spec.radius);
  const tint = rim ?? 0xffffff;
  // Scalloped alien-pod body: a compact disc ringed by three bumps.
  graphics.fillStyle(spec.color, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r, 0, Math.PI * 2, false);
  graphics.fillPath();
  const bumpRadius = r * 0.3;
  for (const angle of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    graphics.fillStyle(spec.color, alpha * 0.85);
    graphics.beginPath();
    graphics.arc(
      Math.cos(angle) * r * 1.3,
      Math.sin(angle) * r * 1.3,
      bumpRadius,
      0,
      Math.PI * 2,
      false,
    );
    graphics.fillPath();
  }
  // Enemy-tinted bright core — the shot reads as belonging to this enemy.
  graphics.fillStyle(tint, alpha);
  graphics.beginPath();
  graphics.arc(0, 0, r * 0.42, 0, Math.PI * 2, false);
  graphics.fillPath();
  // Faint pulse ring whose alpha breathes with the bullet's age.
  const pulse = 0.35 + 0.3 * Math.sin((spec.time ?? 0) * 7);
  graphics.lineStyle(1, tint, Math.min(1, Math.max(0, alpha * pulse)));
  graphics.beginPath();
  graphics.arc(0, 0, r * 1.55, 0, Math.PI * 2, false);
  graphics.strokePath();
}

/**
 * Whether a shape carries parts animated by `spec.time` (so enemy bullets
 * must be redrawn each frame to show them). Currently the pellet's faint
 * pulse; the player-side missile exhaust flame animates through
 * `PlayerBullet._draw` directly. `bulletUtils.createBullet` hands back a
 * `redraw` hook exactly for these shapes (AH-0MV822CQL005R4MM).
 */
export function shapeAnimates(shape: BulletShape): boolean {
  const canonical = canonicalShape(shape);
  return (
    canonical === 'pellet' ||
    canonical === 'heavy-shell' ||
    canonical === 'shard'
  );
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
  /**
   * Short fading trail behind the shape (× radius; see `BulletVisualSpec.tail`).
   * Optional — absent → no trail (AH-0MV822CQL005R4MM).
   */
  tail?: number;
  /**
   * Fire-time launch-pop VFX spawned at the enemy's body when a shot leaves
   * (AH-0MV822CQL005R4MM). The enemy side of the player's per-weapon
   * `muzzleFlash` metadata: the entity's shared fire method spawns the pop
   * through the shared `src/vfx/enemyMuzzleFlash.ts` helper, so the game and
   * every gym pop identically. Absent → no launch pop.
   */
  muzzle?: MuzzleFlashSpec;
}

/**
 * The registered per-identity enemy bullet visuals. Colours mirror each
 * archetype's existing `*_BULLET_COLOR` so identity is carried by *shape +
 * colour* together, never a behaviour/balance re-tune.
 */
export const ENEMY_BULLET_VISUALS: Record<EnemyBulletArchetype, EnemyBulletVisual> = {
  // Scout/Invader aimed shot (AH-0MV822CQL005R4MM): a small alien pellet —
  // scalloped body, enemy-tinted (green) core and a faint time-driven pulse —
  // with a green launch pop at the shot and a short fading trail. The shot
  // body keeps the established lethal-red `SCOUT_BULLET_COLOR`; identity is
  // carried by shape + rim + feel, never a behaviour change.
  scout: {
    shape: 'pellet',
    color: 0xff4444,
    rimColor: 0x00ff66,
    tail: 1.2,
    muzzle: { color: 0x00ff66, radius: 5, duration: 0.12 },
  },
  march: {
    shape: 'pellet',
    color: 0xff4444,
    rimColor: 0x00ff66,
    tail: 1.2,
    muzzle: { color: 0x00ff66, radius: 5, duration: 0.12 },
  },
  // Diver spread burst (AH-0MV822D2U000LRFV): a sharp splinter/arrowhead
  // echoing the Diver's dart body and diving arc — `shard` primitive with a
  // white-hot spine, a neon rim in the Diver's own body yellow, a sweeping
  // time-driven spine glint and a short fading trail — with a pale-yellow
  // launch pop at the diver's body per burst. The shot body keeps the
  // established `DIVER_BULLET_COLOR`; identity is carried by shape + rim +
  // feel, never a behaviour change.
  diver: {
    shape: 'shard',
    color: 0xffee88,
    length: 2.6,
    rimColor: 0xffff00,
    tail: 1.1,
    muzzle: { color: 0xffee88, radius: 5, duration: 0.12 },
  },
  tank: {
    shape: 'heavy-shell',
    color: 0xffaa00,
    rimColor: 0xffcc88,
    tail: 1.4,
    muzzle: { color: 0xffaa00, radius: 7, duration: 0.14 },
  },
  // Phaser radial shot (AH-0MV822DRX009RYUB): a crisply-edged hexagonal
  // phaser bolt with a bright white velocity-aligned core streak and a neon
  // rim in the Phaser's own body magenta, a short fading trail and a magenta
  // launch pop at the body per radial volley. The shot body keeps the
  // established lethal-red `PHASER_BULLET_COLOR`; identity is carried by
  // shape + rim + feel, never a behaviour change.
  phaser: {
    shape: 'phaser-bolt',
    color: 0xff4444,
    length: 1.8,
    rimColor: 0xff00ff,
    tail: 1.2,
    muzzle: { color: 0xff00ff, radius: 5, duration: 0.12 },
  },
  // Swarm coordinated burst (AH-0MV822E4T006F37Y): each member's shot is a
  // tiny fast cometary fleck — a small elongated tear with a white-hot
  // leading glint, a pointed tail, a cyan neon rim and a short fading trail
  // — with a cyan launch pop at the member's body. The shot body keeps the
  // established `SWARM_BULLET_COLOR`; identity is carried by shape + rim +
  // feel, never a behaviour change.
  swarm: {
    shape: 'fleck',
    color: 0x00ccff,
    rimColor: 0x00ccff,
    tail: 0.9,
    muzzle: { color: 0x00ccff, radius: 4, duration: 0.1 },
  },
  raider: {
    shape: 'dart',
    color: 0xffddaa,
    length: 2.8,
    rimColor: 0xff6688,
    tail: 1.0,
    muzzle: { color: 0xffddaa, radius: 5, duration: 0.12 },
  },
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


