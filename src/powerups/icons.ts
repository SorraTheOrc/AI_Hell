/**
 * Code-drawn neon power-up icons (GDD §4.4) — shared by field drops and
 * the standalone HUD. No external art assets (code-first convention).
 *
 * Each icon is drawn into a caller-owned Phaser Graphics object at the
 * given position and size, in the neon style (outlined shapes on black).
 */

import Phaser from 'phaser';

import { PowerUpId } from './types';
import { WeaponId } from '../utils/weapons';
import {
  POWER_UP_BUBBLE_GLOW_ALPHA,
  POWER_UP_BUBBLE_RADIUS_FACTOR,
  POWER_UP_BUBBLE_STROKE_WIDTH,
} from '../core/constants';

/** Icon stroke colours per type. */
const ICON_COLORS: Record<PowerUpId, number> = {
  shield: 0x3399ff, // blue — shield
  bomb: 0xff3333, // red — bomb
  speed_boost: 0x00ffff, // cyan — speed
  phase_shift: 0xaaaaaa, // grey — ghost/phase
  teleport: 0xffcc00, // amber — teleport portal
  extra_life: 0xff6ec7, // pink — life
  magnet: 0xb57bff, // purple — magnet
  mineral_scoop: 0x33ff99, // neon green — mineral scoop
  power_pellet: 0xfff45e, // bright amber — Pac-Man power pellet
  smart_bomb: 0xcc66ff, // electric violet — Defender smart-bomb starburst
};

/** Icon stroke colours per weapon type (matching bullet colours). */
const WEAPON_ICON_COLORS: Record<WeaponId, number> = {
  cannon: 0x00ffff, // neon cyan
  spread: 0xffaa00, // neon orange — fan arc
  dual: 0xff00ff, // neon magenta — parallel bars
  rapid: 0xffff00, // neon yellow — stacked dots
  wave_laser: 0x3366ff, // neon blue — piercing beam
  ricochet: 0x33ff66, // neon green — edge-bouncing pellet
  cluster: 0xff3366, // neon hot pink — splitting warhead cluster
  options: 0x00ffcc, // neon aquamarine — orbiting satellite pods
  nova: 0x66ffff, // pale cyan — expanding ring
  mortar: 0xff6600, // deep orange — shell/blast
  arc: 0xcc66ff, // electric purple — chaining bolt
};

/** Icon stroke colour for the Reset drop (returns ship to cannon). */
const RESET_ICON_COLOR = 0xffffff; // white — return/undo arrow

/**
 * Draws a weapon power-up icon into `graphics` (cleared first),
 * centred at (x, y) with the given size (radius extent in px).
 *
 * Each weapon's icon is a distinctive shape that hints at its shot
 * pattern: fan arc for Spread, parallel bars for Dual, stacked dots
 * for Rapid (high fire rate), and a return/undo arrow for Reset.
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
 * pattern: fan arc for Spread, parallel bars for Dual, stacked dots
 * for Rapid (high fire rate), and a return/undo arrow for Reset.
 *
 * @param graphics — Caller-owned Phaser Graphics.
 * @param weaponId — The weapon or reset identifier.
 * @param x — Centre x position.
 * @param y — Centre y position.
 * @param size — Icon radius extent in px.
 */
export function drawPowerUpIcon(
  graphics: Phaser.GameObjects.Graphics,
  id: PowerUpId,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  _drawPowerUpIcon(graphics, id, x, y, size);
}

/**
 * Inner power-up icon drawing WITHOUT clearing first — shared by
 * `drawPowerUpIcon` (HUD icons) and `drawPowerUpDrop` (field drops
 * with the glowing bubble layered underneath).
 */
function _drawPowerUpIcon(
  graphics: Phaser.GameObjects.Graphics,
  id: PowerUpId,
  x: number,
  y: number,
  size: number,
): void {
  graphics.lineStyle(2, ICON_COLORS[id], 1);

  switch (id) {
    case 'shield':
      drawShield(graphics, x, y, size);
      break;
    case 'bomb':
      drawBomb(graphics, x, y, size);
      break;
    case 'speed_boost':
      drawLightning(graphics, x, y, size);
      break;
    case 'phase_shift':
      drawPhase(graphics, x, y, size);
      break;
    case 'teleport':
      drawTeleport(graphics, x, y, size);
      break;
    case 'extra_life':
      drawHeart(graphics, x, y, size);
      break;
    case 'magnet':
      drawMagnet(graphics, x, y, size);
      break;
    case 'mineral_scoop':
      drawMineralScoop(graphics, x, y, size);
      break;
    case 'power_pellet':
      drawPowerPellet(graphics, x, y, size);
      break;
    case 'smart_bomb':
      drawSmartBomb(graphics, x, y, size);
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

  g.lineStyle(2, ICON_COLORS.magnet, 1);
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

/**
 * Mineral scoop — a shovel/scoop bowl with a handle and mineral dots
 * gathering inside it. Distinct neon-green hue so it never reads as the
 * purple Magnet.
 */
function drawMineralScoop(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Handle: diagonal shaft from the upper-right into the bowl.
  g.beginPath();
  g.moveTo(x + s * 0.75, y - s * 0.85);
  g.lineTo(x + s * 0.2, y - s * 0.15);
  g.strokePath();
  // Bowl: lower semi-circle with a rim across the top opening.
  g.beginPath();
  g.arc(x, y + s * 0.05, s * 0.6, 0, Math.PI, false);
  g.strokePath();
  g.beginPath();
  g.moveTo(x - s * 0.6, y + s * 0.05);
  g.lineTo(x + s * 0.6, y + s * 0.05);
  g.strokePath();
  // Attracted mineral dots gathering in the bowl.
  for (const dotX of [-0.28, 0, 0.28]) {
    g.beginPath();
    g.arc(x + s * dotX, y + s * 0.32, s * 0.08, 0, Math.PI * 2);
    g.strokePath();
  }
}

/**
 * Power pellet — a bright filled core inside a glowing outer ring, the
 * Pac-Man power pellet that frightens enemies.
 */
function drawPowerPellet(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Glowing outer ring.
  g.lineStyle(2, ICON_COLORS.power_pellet, 1);
  g.beginPath();
  g.arc(x, y, s * 0.85, 0, Math.PI * 2);
  g.strokePath();
  // Filled pellet core (the bright power pellet itself).
  g.fillStyle(ICON_COLORS.power_pellet, 1);
  g.fillCircle(x, y, s * 0.42);
}

/**
 * Smart Bomb — a neon starburst inside a ring: the screen-wide pulse
 * (Defender adaptation, AH-0MV1BIWP9003EHRQ). The ring echoes the pulse
 * wavefront, the radiating spokes the screen-clearing burst.
 */
function drawSmartBomb(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Outer pulse ring.
  g.beginPath();
  g.arc(x, y, s * 0.85, 0, Math.PI * 2);
  g.strokePath();
  // Eight radiating spokes (a starburst); alternating long/short so the
  // silhouette reads as a burst rather than a plain asterisk.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const inner = s * 0.3;
    const outer = s * (i % 2 === 0 ? 0.72 : 0.55);
    g.beginPath();
    g.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    g.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    g.strokePath();
  }
  // Bright core.
  g.fillStyle(ICON_COLORS.smart_bomb, 1);
  g.fillCircle(x, y, s * 0.22);
}

// ── Weapon power-up icons ──────────────────────────────────────────

/**
 * Draws a weapon power-up icon into `graphics` (cleared first),
 * centred at (x, y) with the given size (radius extent in px).
 *
 * Each weapon's icon is a distinctive shape that hints at its shot
 * pattern: fan arc for Spread, parallel bars for Dual, stacked dots
 * for Rapid (high fire rate), and a return/undo arrow for Reset.
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
 * drops with the glowing bubble layered underneath). Each weapon's
 * icon metaphor: fan arc (Spread), parallel bars (Dual), stacked
 * dots (Rapid — high rate), return arrow (Reset).
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
    case 'wave_laser':
      drawWaveLaserIcon(graphics, x, y, size);
      break;
    case 'ricochet':
      drawRicochetIcon(graphics, x, y, size);
      break;
    case 'cluster':
      drawClusterIcon(graphics, x, y, size);
      break;
    case 'options':
      drawOptionsIcon(graphics, x, y, size);
      break;
    case 'nova':
      drawNovaIcon(graphics, x, y, size);
      break;
    case 'mortar':
      drawMortarIcon(graphics, x, y, size);
      break;
    case 'arc':
      drawArcIcon(graphics, x, y, size);
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
 * Rapid icon — tightly stacked dots, hinting at the rapid fire-rate
 * (125 ms interval) — a stream of bullets firing faster than the
 * eye can track. The dot stack is noticeably denser than the cannon's
 * single bullet, making the rate difference immediately apparent.
 */
function drawRapidIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // 5 dots stacked vertically (along the y-axis) with tight spacing.
  // At small sizes this reads as a rapid stream of bullets.
  const dotRadius = s * 0.1;
  const spacing = s * 0.25;
  const startY = y - s * 0.5;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.arc(x, startY + i * spacing, dotRadius, 0, Math.PI * 2);
    g.strokePath();
  }
}

/**
 * Wave laser icon — a long horizontal beam with pass-through chevrons,
 * hinting at the R-Type piercing shot that survives the enemies it hits.
 */
function drawWaveLaserIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Long horizontal beam.
  g.beginPath();
  g.moveTo(x - s * 0.9, y);
  g.lineTo(x + s * 0.9, y);
  g.strokePath();
  // Two pass-through chevrons along the beam ("pierces onward").
  for (const cx of [-0.35, 0.25]) {
    g.beginPath();
    g.moveTo(x + s * cx, y - s * 0.5);
    g.lineTo(x + s * (cx + 0.25), y);
    g.lineTo(x + s * cx, y + s * 0.5);
    g.strokePath();
  }
}

/**
 * Cluster missile icon — a central warhead with four fragment dots radiating
 * outward along short spokes, hinting at the Missile Command MIRV split.
 */
function drawClusterIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Central missile body (stroked, matching the other weapon icon style).
  g.beginPath();
  g.arc(x, y, s * 0.28, 0, Math.PI * 2);
  g.strokePath();
  // Four fragment warheads radiating along short spokes.
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI / 2) * i + Math.PI / 4;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    g.beginPath();
    g.moveTo(x + dx * s * 0.4, y + dy * s * 0.4);
    g.lineTo(x + dx * s * 0.72, y + dy * s * 0.72);
    g.strokePath();
    g.beginPath();
    g.arc(x + dx * s * 0.88, y + dy * s * 0.88, s * 0.14, 0, Math.PI * 2);
    g.strokePath();
  }
}

/**
 * Options icon — a central ship dot ringed by orbiting satellite pods, hinting
 * at the Gradius Options escort that trails the ship and fires alongside it.
 */
function drawOptionsIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Central ship.
  g.beginPath();
  g.arc(x, y, s * 0.22, 0, Math.PI * 2);
  g.strokePath();
  // Orbit ring.
  g.beginPath();
  g.arc(x, y, s * 0.72, 0, Math.PI * 2);
  g.strokePath();
  // Two satellite pods on the orbit (base escort).
  for (let i = 0; i < 2; i++) {
    const angle = Math.PI * i + Math.PI / 6;
    g.beginPath();
    g.arc(
      x + Math.cos(angle) * s * 0.72,
      y + Math.sin(angle) * s * 0.72,
      s * 0.16,
      0,
      Math.PI * 2,
    );
    g.strokePath();
  }
}

/**
 * Ricochet icon — a zig-zag "bank shot" path bouncing between two walls,
 * hinting at the Centipede edge-reflecting pellet.
 */
function drawRicochetIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Two vertical walls the pellet banks between.
  for (const wx of [-0.7, 0.7]) {
    g.beginPath();
    g.moveTo(x + s * wx, y - s * 0.8);
    g.lineTo(x + s * wx, y + s * 0.8);
    g.strokePath();
  }
  // Zig-zag trajectory reflecting off each wall.
  g.beginPath();
  g.moveTo(x - s * 0.7, y - s * 0.5);
  g.lineTo(x + s * 0.7, y + s * 0.1);
  g.lineTo(x - s * 0.7, y + s * 0.6);
  g.strokePath();
}

/**
 * Nova icon — two concentric rings around a core dot, hinting at the
 * expanding onFire pulse centred on the ship.
 */
function drawNovaIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  g.beginPath();
  g.arc(x, y, s * 0.85, 0, Math.PI * 2);
  g.strokePath();
  g.beginPath();
  g.arc(x, y, s * 0.5, 0, Math.PI * 2);
  g.strokePath();
  g.beginPath();
  g.arc(x, y, s * 0.14, 0, Math.PI * 2);
  g.strokePath();
}

/**
 * Mortar icon — a lobbed shell (rounded body) with an arced trajectory and
 * a small blast burst, hinting at the onImpact detonation.
 */
function drawMortarIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  // Arced trajectory from the lower-left to the shell.
  g.beginPath();
  g.moveTo(x - s * 0.8, y + s * 0.4);
  g.lineTo(x - s * 0.3, y - s * 0.4);
  g.lineTo(x + s * 0.15, y - s * 0.1);
  g.strokePath();
  // Shell body (rounded) at the arc's end.
  g.beginPath();
  g.arc(x + s * 0.3, y + s * 0.25, s * 0.32, 0, Math.PI * 2);
  g.strokePath();
  // Blast ticks radiating from the shell.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const r0 = s * 0.45;
    const r1 = s * 0.8;
    g.beginPath();
    g.moveTo(x + s * 0.3 + Math.cos(angle) * r0, y + s * 0.25 + Math.sin(angle) * r0);
    g.lineTo(x + s * 0.3 + Math.cos(angle) * r1, y + s * 0.25 + Math.sin(angle) * r1);
    g.strokePath();
  }
}

/**
 * Arc icon — a jagged lightning bolt, hinting at the chaining electric
 * strike between nearby targets.
 */
function drawArcIcon(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  s: number,
): void {
  g.beginPath();
  g.moveTo(x + s * 0.25, y - s * 0.95);
  g.lineTo(x - s * 0.45, y + s * 0.05);
  g.lineTo(x - s * 0.05, y + s * 0.05);
  g.lineTo(x - s * 0.25, y + s * 0.95);
  g.lineTo(x + s * 0.45, y - s * 0.05);
  g.lineTo(x + s * 0.05, y - s * 0.05);
  g.closePath();
  g.strokePath();
}

// ── Field drop rendering: glowing bubble + icon ────────────────────
// Larger, legible on-field drops (AH-0MTG5MGPZ00986B4): every drop is
// surrounded by a neon bubble (glow halo + crisp ring) in its aura
// colour, drawn with raw Phaser Graphics — no external assets (GDD
// §7.1). The bubble is scaled with the drop lifecycle by the caller
// (`setScale` on the shared Graphics).
//
// Collection matches the bubble (AH-0MTVYCM2N002NKE4): `dropCollectRadius()`
// derives the pickup boundary from the same `POWER_UP_BUBBLE_RADIUS_FACTOR`
// used to draw the ring, so the ship collects a drop as soon as its hull
// touches the visible bubble and the visual and collision boundaries cannot
// drift apart.

/**
 * Radius (px) of the crisp bubble ring drawn around a drop whose icon
 * radius-extent is `size` px. Single source of truth for the visible
 * bubble (`drawDropBubble`) and the collection boundary
 * (`dropCollectRadius`).
 */
export function dropBubbleRadius(size: number): number {
  return size * POWER_UP_BUBBLE_RADIUS_FACTOR;
}

/**
 * Collection radius (px) for a drop whose icon radius-extent is `size`
 * px at lifecycle `scale`: the ship hull collects the drop on first
 * contact with its visible bubble (`dropBubbleRadius(size) × scale`).
 *
 * Tune `POWER_UP_BUBBLE_RADIUS_FACTOR` to change both the bubble and the
 * pickup boundary; scenes must use this helper rather than recomputing the
 * radius so the game and every gym stay consistent.
 */
export function dropCollectRadius(size: number, scale: number): number {
  return dropBubbleRadius(size) * scale;
}

/** Bubble aura colour for a non-combat power-up type. */
function powerUpBubbleColor(id: PowerUpId): number {
  return ICON_COLORS[id];
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
  const radius = dropBubbleRadius(size);

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
  id: PowerUpId,
  x: number,
  y: number,
  size: number,
): void {
  graphics.clear();
  drawDropBubble(graphics, x, y, size, powerUpBubbleColor(id));
  _drawPowerUpIcon(graphics, id, x, y, size);
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