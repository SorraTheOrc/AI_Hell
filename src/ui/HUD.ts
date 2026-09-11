/**
 * Standalone power-up HUD (GDD §6.4 — `src/ui/HUD.ts`).
 *
 * A Phaser Container subclass attachable to ANY scene (the GymPowerUps
 * gym, the combat gym, the main game). It renders above gameplay
 * (`HUD_DEPTH`) and displays, from the shared EffectsRegistry:
 *
 * - one row per active timed power-up: icon, name, remaining-seconds timer;
 * - a pickup/stack count row for stackable types (P9 magnet); and
 * - a lives counter (P8), starting at 3 and incrementing on collection.
 *
 * Contains NO gym-specific imports or logic — it depends only on the
 * engine-agnostic power-up modules (`powerups/effects.ts`, `powerups/types.ts`,
 * `powerups/icons.ts`), so any scene can construct and refresh it.
 */

import Phaser from 'phaser';

import { EffectsRegistry, ActiveEffect } from '../powerups/effects';
import { getPowerUpById } from '../powerups/types';
import { drawPowerUpIcon } from '../powerups/icons';
import { HUD_DEPTH } from '../core/constants';

// Re-export for consumers wiring depth at construction.
export { HUD_DEPTH };

/** Font used for HUD text — monospace fits the neon terminal aesthetic. */
const TEXT_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#ffffff',
};

/** Vertical spacing between HUD rows. */
const ROW_HEIGHT = 22;

/** Horizontal offsets for the icon / name / value columns. */
const ICON_X = 10;
const NAME_X = 24;
const VALUE_X = 160;

/** One display row in the HUD model. */
export interface HUDEntry {
  /** Power-up ID (e.g. "P5"). */
  id: string;
  /** Display name (e.g. "Speed Boost"). */
  name: string;
  /** Effect type — drives the icon drawn. */
  icon: import('../powerups/types').PowerUpType;
  /** Formatted value: "10s" (remaining) or "x3" (stacks). */
  value: string;
}

/**
 * Standalone Phaser HUD class. Cast `scene` explicitly when the scene is
 * untyped: the class is intentionally a plain `Phaser.Container` so it
 * binds to any scene without importing scene-specific types.
 */
export interface HUDOptions {
  /** Whether to show the lives counter row. Defaults to true for backward compatibility. Combat gyms with no lives mechanic pass `{ showLives: false }`. */
  showLives?: boolean;
}

export class HUD extends Phaser.GameObjects.Container {
  private _registry: EffectsRegistry | null = null;
  private _livesLabel: Phaser.GameObjects.Text;
  private _rows: HUDEntry[] = [];
  private _rowObjects: Phaser.GameObjects.GameObject[] = [];
  private _iconGraphics: Phaser.GameObjects.Graphics;
  private _showLives: boolean;

  constructor(scene: Phaser.Scene, registry: EffectsRegistry | null = null, options?: HUDOptions) {
    super(scene, 8, 8);
    scene.add.existing(this);
    this.setDepth(HUD_DEPTH);

    this._showLives = options?.showLives ?? true;

    this._iconGraphics = new Phaser.GameObjects.Graphics(scene);
    this._livesLabel = new Phaser.GameObjects.Text(
      scene,
      ICON_X,
      ROW_HEIGHT * 0.5,
      '',
      TEXT_STYLE,
    );
    this._livesLabel.setVisible(this._showLives);
    this.add([this._iconGraphics, this._livesLabel]);

    this._registry = registry;
    if (registry) {
      this.refresh();
    }
  }

  /** Attaches a registry (or detaches with null). */
  setRegistry(registry: EffectsRegistry | null): void {
    this._registry = registry;
  }

  /** The attached registry, if any. */
  getRegistry(): EffectsRegistry | null {
    return this._registry;
  }

  /**
   * Rebuilds the display rows and lives label from the current registry
   * state. Call after the registry ticks or changes (or rely on the
   * scene calling it each frame via `update`).
   */
  refresh(): void {
    // Tear down the previous frame's row objects (lives label + icon
    // graphics are rebuilt too — keep the list consistent).
    for (const obj of this._rowObjects) {
      obj.destroy();
    }
    this._rowObjects = [];
    this._rows = [];

    if (this._registry) {
      const effects = this._registry.activeEffects();
      let row = 0;
      for (const effect of effects) {
        this._addRow(effect, row);
        row += 1;
      }
      if (this._showLives) {
        this._livesLabel.setVisible(true);
        this._livesLabel.setText(`Lives: ${this._registry.lives()}`);
      } else {
        this._livesLabel.setVisible(false);
        this._livesLabel.setText('');
      }
    } else {
      this._livesLabel.setText('');
      if (!this._showLives) this._livesLabel.setVisible(false);
    }
  }

  /** Phaser per-frame hook: keep the HUD in sync with the registry. */
  update(): void {
    this.refresh();
  }

  // ── Rendering helpers ─────────────────────────────────────────────

  /** Builds one display row (icon + name + value) from an active effect. */
  private _addRow(effect: ActiveEffect, row: number): void {
    const entry = getPowerUpById(effect.id);
    const y = ROW_HEIGHT * row;

    const icon = new Phaser.GameObjects.Graphics(this.scene);
    drawPowerUpIcon(icon, entry.type, ICON_X, y + ROW_HEIGHT / 2, 8);

    const name = new Phaser.GameObjects.Text(
      this.scene,
      NAME_X,
      y + ROW_HEIGHT * 0.25,
      entry.name,
      TEXT_STYLE,
    );

    const value = new Phaser.GameObjects.Text(
      this.scene,
      VALUE_X,
      y + ROW_HEIGHT * 0.25,
      formatValue(effect),
      TEXT_STYLE,
    );

    this.add([icon, name, value]);
    this._rowObjects.push(icon, name, value);
    this._rows.push({
      id: effect.id,
      name: entry.name,
      icon: entry.type,
      value: formatValue(effect),
    });
  }

  // ── Test accessors (public model) ─────────────────────────────────

  /** Current display rows (icon/name/value per active effect). */
  getRows(): HUDEntry[] {
    return [...this._rows];
  }

  /** Current lives value from the registry (0 when unattached). */
  getLivesValue(): number {
    return this._registry?.lives() ?? 0;
  }

  /** Rendered lives label text (e.g. "Lives: 3"). */
  getLivesLabel(): string {
    return this._livesLabel.text;
  }
}

/** Formats an effect's value: "Ns" (remaining) or "xN" (stacks). */
export function formatValue(effect: ActiveEffect): string {
  if (effect.stacks !== undefined) {
    return `x${effect.stacks}`;
  }
  const remaining = Math.max(0, Math.ceil(effect.remaining ?? 0));
  return `${remaining}s`;
}