/**
 * Mineral collectable entity stub (AH-0MUBVGI62004ED9Q).
 *
 * This stub exists so that the test-first item can build.
 * The real implementation will be added by the implementation child.
 * TODO: Replace with full implementation.
 */

import Phaser from 'phaser';

// Stub MineralConfig interface
export interface MineralConfig {
  x: number;
  y: number;
  onCollect?: () => void;
}

// Stub Mineral class
export class Mineral extends Phaser.GameObjects.Graphics {
  alive = true;
  bodyGraphics!: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, config: MineralConfig) {
    super(scene, { x: config.x, y: config.y });
    // Stub constructor — no real implementation yet.
  }

  updatePosition(_dt: number): void {
    // Stub — minerals don't move.
  }

  handleOverlap(_type: string): void {
    // Stub — no real implementation yet.
  }
}
