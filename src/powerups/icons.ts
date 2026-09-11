/**
 * Code-drawn neon power-up icons (GDD §4.4) — shared by field drops and
 * the standalone HUD. No external art assets (code-first convention).
 *
 * Each icon is drawn into a caller-owned Phaser Graphics object at the
 * given position and size, in the neon style (outlined shapes on black).
 */

import Phaser from 'phaser';

import { PowerUpType } from './types';
import { WeaponId } from '../utils/weapons';
import {
  POWER_UP_BUBBLE_GLOW_ALPHA,
  POWER_UP_BUBBLE_RADIUS_FACTOR,
  POWER_UP_BUBBLE_STROKE_WIDTH,
} from '../core/constants';

/** Icon stroke colours per type. */
const ICON_COLORS: Record<PowerUpType, number> = {
  [PowerUpType.SHIELD]: 0x3399ff, // blue — shield
  [PowerUpType.BOMB]: 0xff3333, // red — bomb
  [PowerUpType.SPEED_BOOST]: 0x00ffff, // cyan — speed
  [PowerUpType.PHASE_SHIFT]: 0xaaaaaa, // grey — ghost/phase
  [PowerUpType.TELEPORT]: 0xffcc00, // amber — teleport portal
  [PowerUpType.EXTRA_LIFE]: 0xff6ec7, // pink — life
  [PowerUpType.MAGNET]: 0xb57bff, // purple — magnet
};

/** Icon stroke colours per weapon type (matching bullet colours). */
const WEAPON_ICON_COLORS: Record<WeaponId, number> = {
  cannon: 0x00ffff, // neon cyan
  spread: 0xffaa00, // neon orange — fan arc
  dual: 0xff00ff, // neon magenta — parallel bars
  rapid: 0xffff00, // neon yellow — waveform
};

/** Icon stroke colour for the Reset drop (returns ship to cannon). */
const RESET_ICON_COLOR = 0xffffff; // white — return/undo arrow

/**
 * Draws the icon for a power-up type into `graphics` (cleared first),
 * centred at (x, y) with the given size (radius extent in px).
 */
export function drawPowerUpIcon(
  graphics: Phaser.GameObjects.Graphics,
  type: PowerUpType,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  _drawPowerUpIcon(graphics, type, x, y, size);
}

/**
 * Inner power-up icon drawing WITHOUT clearing first — shared by
 * `drawPowerUpIcon` (HUD icons) and `drawPowerUpDrop` (field drops
 * with the glowing bubble layered underneath).
 */
function _drawPowerUpIcon(
  graphics: Phaser.GameObjects.Graphics,
  type: PowerUpType,
  x: number,
  y: number,
  size: number,
): void {
  graphics.lineStyle(2, ICON_COLORS[type], 1);

  switch (type) {
    case PowerUpType.SHIELD:
      drawShield(graphics, x, y, size);
      break;
    case PowerUpType.BOMB:
      drawBomb(graphics, x, y, size);
      break;
    case PowerUpType.SPEED_BOOST:
      drawLightning(graphics, x, y, size);
      break;
    case PowerUpType.PHASE_SHIFT:
      drawPhase(graphics, x, y, size);
      break;
    case PowerUpType.TELEPORT:
      drawTeleport(graphics, x, y, size);
      break;
    case PowerUpType.EXTRA_LIFE:
      drawHeart(graphics, x, y, size);
      break;
    case PowerUpType.MAGNET:
      drawMagnet(graphics, x, y, size);
      break;
  }
}

/** Lightning bolt — speed. */
function drawLightning(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  g.beginPath();
  g.moveTo(x + s * 0.1, y - s);
  g.lineTo(x - s * 0.6, y + s * 0.1);
  g.lineTo(x - s * 0.1, y + s * 0.1);
  g.lineTo(x - s * 0.1, y + s);
  g.lineTo(x + s * 0.6, y - s * 0.1);
  g.lineTo(x + s * 0.1, y - s * 0.1);
  g.closePath();
  g.strokePath();
}

/** Heart — extra life. */
function drawHeart(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Two circle lobes + a triangle base.
  g.beginPath();
  g.arc(x - s * 0.3, y - s * 0.25, s * 0.35, Math.PI, 0, false);
  g.arc(x + s * 0.3, y - s * 0.25, s * 0.35, Math.PI, 0, false);
  g.closePath();
  g.strokePath();

  g.beginPath();
  g.moveTo(x - s * 0.65, y - s * 0.1);
  g.lineTo(x, y + s);
  g.lineTo(x + s * 0.65, y - s * 0.1);
  g.closePath();
  g.strokePath();
}

/** Shield outline — classic heater shield. */
function drawShield(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  g.beginPath();
  g.moveTo(x - s * 0.6, y - s * 0.5);
  g.lineTo(x + s * 0.6, y - s * 0.5);
  g.lineTo(x + s * 0.6, y + s * 0.2);
  g.lineTo(x, y + s * 0.9);
  g.lineTo(x - s * 0.6, y + s * 0.2);
  g.closePath();
  g.strokePath();
  // Inner highlight line
  g.beginPath();
  g.moveTo(x, y - s * 0.5);
  g.lineTo(x, y + s * 0.5);
  g.strokePath();
}

/** Bomb — circle body with fuse and radiating blast lines. */
function drawBomb(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  g.beginPath();
  g.arc(x, y + s * 0.2, s * 0.45, 0, Math.PI * 2);
  g.strokePath();
  // Fuse
  g.beginPath();
  g.moveTo(x + s * 0.15, y - s * 0.15);
  g.lineTo(x + s * 0.4, y - s * 0.6);
  g.strokePath();
  // Spark
  g.beginPath();
  g.arc(x + s * 0.45, y - s * 0.65, s * 0.1, 0, Math.PI * 2);
  g.strokePath();
  // Radiating blast ticks
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const r0 = s * 0.65;
    const r1 = s * 0.9;
    g.beginPath();
    g.moveTo(x + Math.cos(angle) * r0, y + Math.sin(angle) * r0);
    g.lineTo(x + Math.cos(angle) * r1, y + Math.sin(angle) * r1);
    g.strokePath();
  }
}

/** Phase shift — ghostly double outline (offset ghost). */
function drawPhase(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Outer ghost body (rounded top, wavy bottom)
  g.beginPath();
  g.arc(x, y - s * 0.2, s * 0.5, Math.PI, 0, false);
  g.lineTo(x + s * 0.5, y + s * 0.6);
  g.lineTo(x + s * 0.25, y + s * 0.35);
  g.lineTo(x, y + s * 0.6);
  g.lineTo(x - s * 0.25, y + s * 0.35);
  g.lineTo(x - s * 0.5, y + s * 0.6);
  g.closePath();
  g.strokePath();
  // Inner offset ghost for shift effect
  g.beginPath();
  g.arc(x + s * 0.15, y - s * 0.15, s * 0.35, Math.PI, 0, false);
  g.lineTo(x + s * 0.5, y + s * 0.45);
  g.lineTo(x + s * 0.32, y + s * 0.25);
  g.lineTo(x + s * 0.15, y + s * 0.45);
  g.closePath();
  g.strokePath();
  // Eyes
  g.beginPath();
  g.arc(x - s * 0.18, y - s * 0.15, s * 0.08, 0, Math.PI * 2);
  g.strokePath();
  g.beginPath();
  g.arc(x + s * 0.18, y - s * 0.15, s * 0.08, 0, Math.PI * 2);
  g.strokePath();
}

/** Teleport — concentric portal rings with directional chevron. */
function drawTeleport(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  for (const r of [0.3, 0.55, 0.8]) {
    g.beginPath();
    g.arc(x, y, s * r, 0, Math.PI * 2);
    g.strokePath();
  }
  // Directional chevron (right-pointing)
  g.beginPath();
  g.moveTo(x - s * 0.15, y - s * 0.25);
  g.lineTo(x + s * 0.25, y);
  g.lineTo(x - s * 0.15, y + s * 0.25);
  g.strokePath();
}

/** U-shaped magnet. */
function drawMagnet(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  const arm = s * 0.8;
  const width = s * 0.7;
  const thick = s * 0.28;

  g.lineStyle(2, ICON_COLORS[PowerUpType.MAGNET], 1);
  // Left arm
  g.beginPath();
  g.moveTo(x - width / 2, y - arm);
  g.lineTo(x - width / 2, y - arm / 3);
  g.lineTo(x - width / 2 + thick, y - arm / 3);
  g.lineTo(x - width / 2 + thick, y - arm);
  g.strokePath();

  // Right arm
  g.beginPath();
  g.moveTo(x + width / 2 - thick, y - arm);
  g.lineTo(x + width / 2 - thick, y - arm / 3);
  g.lineTo(x + width / 2, y - arm / 3);
  g.lineTo(x + width / 2, y - arm);
  g.strokePath();

  // Base connecting the arms
  g.beginPath();
  g.moveTo(x - width / 2, y - arm / 3);
  g.lineTo(x + width / 2, y - arm / 3);
  g.strokePath();
}

// ── Weapon power-up icons ──────────────────────────────────────────

/**
 * Draws a weapon power-up icon into `graphics` (cleared first),
 * centred at (x, y) with the given size (radius extent in px).
 *
 * Each weapon's icon is a distinctive shape that hints at its shot
 * pattern: fan arc for Spread, parallel bars for Dual, waveform for
 * Rapid, and an undo/return arrow for Reset.
 *
 * @param graphics — Caller-owned Phaser Graphics.
 * @param weaponId — The weapon identifier.
 * @param x — Centre x position.
 * @param y — Centre y position.
 * @param size — Icon radius extent in px.
 */
/** The weapon-drop icon types, including the Reset drop. */
export type WeaponDropIconId = WeaponId | 'reset';

/**
 * Draws a weapon power-up icon into `graphics` (cleared first),
 * centred at (x, y) with the given size (radius extent in px).
 *
 * Each weapon's icon is a distinctive shape that hints at its shot
 * pattern: fan arc for Spread, parallel bars for Dual, waveform for
 * Rapid, and a return/undo arrow for Reset.
 *
 * @param graphics — Caller-owned Phaser Graphics.
 * @param weaponId — The weapon or reset identifier.
 * @param x — Centre x position.
 * @param y — Centre y position.
 * @param size — Icon radius extent in px.
 */
export function drawWeaponIcon(
  graphics: Phaser.GameObjects.Graphics,
  weaponId: WeaponDropIconId,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  _drawWeaponIcon(graphics, weaponId, x, y, size);
}

/**
 * Inner weapon icon drawing WITHOUT clearing first — shared by
 * `drawWeaponIcon` (caller-owned buffers) and `drawWeaponDrop` (field
 * drops with the glowing bubble layered underneath).
 */
function _drawWeaponIcon(
  graphics: Phaser.GameObjects.Graphics,
  weaponId: WeaponDropIconId,
  x: number,
  y: number,
  size: number,
): void {
  if (weaponId === 'reset') {
    graphics.lineStyle(2, RESET_ICON_COLOR, 1);
    drawResetIcon(graphics, x, y, size);
    return;
  }
  graphics.lineStyle(2, WEAPON_ICON_COLORS[weaponId], 1);

  switch (weaponId) {
    case 'cannon':
      drawCannonIcon(graphics, x, y, size);
      break;
    case 'spread':
      drawSpreadIcon(graphics, x, y, size);
      break;
    case 'dual':
      drawDualIcon(graphics, x, y, size);
      break;
    case 'rapid':
      drawRapidIcon(graphics, x, y, size);
      break;
  }
}

/**
 * Reset icon — a return/undo arrow (counter-clockwise arc with arrowhead),
 * hinting at "return to the starting cannon".
 */
function drawResetIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Counter-clockwise arc from the top, sweeping left, ending at 45°.
  g.beginPath();
  g.arc(x, y, s * 0.55, -Math.PI / 2, Math.PI * 0.8, false);
  g.strokePath();
  // Arrowhead at the arc end (pointing left-ish / back).
  const tipAngle = Math.PI * 0.7;
  const tipX = x + Math.cos(tipAngle) * s * 0.55;
  const tipY = y + Math.sin(tipAngle) * s * 0.55;
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(tipX - s * 0.22, tipY - s * 0.14);
  g.strokePath();
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(tipX - s * 0.22, tipY + s * 0.14);
  g.strokePath();
}

/**
 * Cannon icon — simple bullet circle with a barrel line.
 * Hints at the single-shot, straight-ahead pattern.
 */
function drawCannonIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Barrel line pointing right
  g.beginPath();
  g.moveTo(x - s * 0.4, y);
  g.lineTo(x + s * 0.6, y);
  g.strokePath();
  // Bullet circle at the tip
  g.beginPath();
  g.arc(x + s * 0.6, y, s * 0.25, 0, Math.PI * 2);
  g.strokePath();
}

/**
 * Spread icon — three radial lines fanning from a central point,
 * hinting at the 3-bullet fan pattern (-30°/0°/+30°).
 */
function drawSpreadIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Fan of three lines from a common origin
  const originX = x - s * 0.3;
  const spreadAngle = Math.PI / 6; // 30°
  for (const offset of [-1, 0, 1]) {
    g.beginPath();
    g.moveTo(originX, y);
    const endX = originX + s * 0.9;
    const endY = y + Math.sin(offset * spreadAngle) * s * 0.6;
    g.lineTo(endX, endY);
    g.strokePath();
  }
}

/**
 * Dual icon — two parallel vertical bars, hinting at the two
 * side-by-side bullets offset perpendicular to heading.
 */
function drawDualIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  const halfW = s * 0.2;
  const barH = s * 0.7;
  // Left bar
  g.beginPath();
  g.moveTo(x - halfW, y - barH / 2);
  g.lineTo(x - halfW, y + barH / 2);
  g.strokePath();
  // Right bar
  g.beginPath();
  g.moveTo(x + halfW, y - barH / 2);
  g.lineTo(x + halfW, y + barH / 2);
  g.strokePath();
}

/**
 * Rapid icon — a sine-wave / waveform shape, hinting at the rapid
 * burst-fire pattern (single bullets at high rate).
 */
function drawRapidIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Sine wave from left to right
  const steps = 16;
  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const px = x - s * 0.6 + t * s * 1.2;
    const py = y + Math.sin(t * Math.PI * 4) * s * 0.3;
    if (i === 0) {
      g.moveTo(px, py);
    } else {
      g.lineTo(px, py);
    }
  }
  g.strokePath();
}

// ── Field drop rendering: glowing bubble + icon ────────────────────
// Larger, legible on-field drops (AH-0MTG5MGPZ00986B4): every drop is
// surrounded by a neon bubble (glow halo + crisp ring) in its aura
// colour, drawn with raw Phaser Graphics — no external assets (GDD
// §7.1). The bubble is scaled with the drop lifecycle by the caller
// (`setScale` on the shared Graphics); it is purely visual and does not
// extend the collection radius.

/** Bubble aura colour for a non-combat power-up type. */
function powerUpBubbleColor(type: PowerUpType): number {
  return ICON_COLORS[type];
}

/** Bubble aura colour for a weapon/reset drop. */
function weaponBubbleColor(weaponId: WeaponDropIconId): number {
  return weaponId === 'reset' ? RESET_ICON_COLOR : WEAPON_ICON_COLORS[weaponId];
}

/**
 * Draws the glowing bubble around a drop icon into `graphics`
 * (appends — never clears). Neon style: a soft outer glow halo (two
 * stacked translucent fills, approximation of a bloom without shaders)
 * plus a crisp ring, centred at (x, y). Radius is
 * `POWER_UP_BUBBLE_RADIUS_FACTOR × size`.
 *
 * @param graphics — Caller-owned Phaser Graphics.
 * @param x — Centre x position.
 * @param y — Centre y position.
 * @param size — Drop radius extent in px (e.g. `POWER_UP_DROP_SIZE`).
 * @param color — Aura colour (per-type neon colour of the drop).
 */
export function drawDropBubble(
  graphics: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  size: number,
  color: number,
): void {
  const radius = size * POWER_UP_BUBBLE_RADIUS_FACTOR;

  // Soft outer halo — two stacked fills read as a glow on black.
  graphics.fillStyle(color, POWER_UP_BUBBLE_GLOW_ALPHA * 0.4);
  graphics.fillCircle(x, y, radius * 1.6);
  graphics.fillStyle(color, POWER_UP_BUBBLE_GLOW_ALPHA);
  graphics.fillCircle(x, y, radius * 1.2);

  // Crisp neon ring.
  graphics.lineStyle(POWER_UP_BUBBLE_STROKE_WIDTH, color, 1);
  graphics.strokeCircle(x, y, radius);
}

/**
 * Draws a complete non-combat field drop into `graphics` (cleared
 * first): glowing bubble + icon, centred at (x, y) with the given size
 * (radius extent in px).
 */
export function drawPowerUpDrop(
  graphics: Phaser.GameObjects.Graphics,
  type: PowerUpType,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  drawDropBubble(graphics, x, y, size, powerUpBubbleColor(type));
  _drawPowerUpIcon(graphics, type, x, y, size);
}

/**
 * Draws a complete weapon/reset field drop into `graphics` (cleared
 * first): glowing bubble + icon, centred at (x, y) with the given size
 * (radius extent in px).
 */
export function drawWeaponDrop(
  graphics: Phaser.GameObjects.Graphics,
  weaponId: WeaponDropIconId,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  drawDropBubble(graphics, x, y, size, weaponBubbleColor(weaponId));
  _drawWeaponIcon(graphics, weaponId, x, y, size);
}