/**
 * Code-drawn neon power-up icons (GDD §4.4) — shared by field drops and
 * the standalone HUD. No external art assets (code-first convention).
 *
 * Each icon is drawn into a caller-owned Phaser Graphics object at the
 * given position and size, in the neon style (outlined shapes on black).
 */

import Phaser from 'phaser';

import { PowerUpType } from './types';

/** Icon stroke colours per type. */
const ICON_COLORS: Record<PowerUpType, number> = {
  [PowerUpType.SPEED_BOOST]: 0x00ffff, // cyan — speed
  [PowerUpType.EXTRA_LIFE]: 0xff6ec7, // pink — life
  [PowerUpType.MAGNET]: 0xb57bff, // purple — magnet
};

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