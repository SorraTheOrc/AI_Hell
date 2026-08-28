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

/** Icon stroke colours per type. */
const ICON_COLORS: Record<PowerUpType, number> = {
  [PowerUpType.SPEED_BOOST]: 0x00ffff, // cyan — speed
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
  graphics.lineStyle(2, ICON_COLORS[type], 1);

  switch (type) {
    case PowerUpType.SPEED_BOOST:
      drawLightning(graphics, x, y, size);
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