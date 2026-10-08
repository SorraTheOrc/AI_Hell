/**
 * Standalone power-up HUD (GDD §6.4 — `src/ui/HUD.ts`).
 *
 * A Phaser Container subclass attachable to ANY scene (the GymPowerUpsUtility
 * gym, the combat gym, the main game). It renders above gameplay
 * (`HUD_DEPTH`) and displays, from the shared EffectsRegistry:
 *
 * - **one row per power-up/weapon** — merged permanent and temporary state
 *   rather than one row per internal effect (AH-0MUX802450085VZZ);
 * - each row's label carries the item's **current effective level**
 *   (`permanent + temporary`, e.g. `Speed Boost Lvl 3`);
 * - each row's value is either the infinity glyph `∞` (no temporary
 *   level-up window is active — the level is permanent for the run) or a
 *   live `Ns` countdown while a temporary window is active;
 * - a lives counter (Extra Life), starting at 3 and incrementing on collection; and
 * - a fixed-length, hollow-outlined hold bar that fills proportionally as
 *   minerals are collected (replaces the former `Minerals: n/20` text).
 *
 * Consumable counts that the level alone does not convey (Shield shield
 * remaining absorptions, Phase Shift phase charges, Teleport teleport uses) are appended to
 * the label as ` ×N` so the value column stays strictly `∞`/countdown.
 *
 * Contains NO gym-specific imports or logic — it depends only on the
 * engine-agnostic power-up modules (`powerups/effects.ts`, `powerups/types.ts`,
 * `powerups/powerUpLevels.ts`, `powerups/icons.ts`), so any scene can
 * construct and refresh it.
 */

import Phaser from 'phaser';

import {
  EffectsRegistry,
  WeaponEffect,
} from '../powerups/effects';
import { getPowerUpById, type PowerUpId } from '../powerups/types';
import { POWER_UP_LEVEL_IDS } from '../powerups/powerUpLevels';
import { drawPowerUpIcon, drawWeaponIcon } from '../powerups/icons';
import type { WeaponDropIconId } from '../powerups/icons';
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
export const HUD_ROW_HEIGHT = 22;
const ROW_HEIGHT = HUD_ROW_HEIGHT;

/** Extra vertical gap between the lives label and the first effect row. */
const LIVES_GAP = 4;

/** Horizontal offsets for the icon / name / value columns. */
const ICON_X = 10;
const NAME_X = 24;
const VALUE_X = 160;

/**
 * Mineral hold bar geometry (px). The bar keeps a fixed length at all
 * times so the row never shifts; only the inner fill grows (AC4).
 */
export const MINERAL_BAR_WIDTH = 120;
export const MINERAL_BAR_HEIGHT = 10;
export const MINERAL_BAR_STROKE = 1;

/** Name of the bar Graphics object (test/debug access). */
export const MINERAL_BAR_NAME = 'hud-mineral-bar';

/** Neon cyan outline/fill, matching the HUD palette (GDD Visual Aesthetic). */
const MINERAL_BAR_OUTLINE_COLOR = 0x00ffff;
const MINERAL_BAR_FILL_COLOR = 0x00ffff;
const MINERAL_BAR_FILL_ALPHA = 0.85;

/** Smallest visible fill for any non-zero hold (px) — keeps tiny progress readable. */
const MINERAL_BAR_MIN_FILL = 2;

/** Inner width of the bar track (outer width inset by the stroke on each side). */
function mineralBarInnerWidth(): number {
  return MINERAL_BAR_WIDTH - MINERAL_BAR_STROKE * 2;
}

/** Label prefix for weapon rows in the HUD. */
const WEAPON_ROW_PREFIX = 'Weapon: ';

/**
 * Value shown when no temporary level-up window is active — the infinity
 * glyph reads as "the level is permanent for the run" rather than a
 * misleading countdown.
 */
export const PERMANENT_VALUE = '∞';

/** One display row in the HUD model (one per power-up/weapon). */
export interface HUDEntry {
  /** Power-up ID (e.g. "speed_boost"). */
  id: string;
  /** Catalogue display name (e.g. "Speed Boost"). */
  name: string;
  /** Rendered label including the current level (e.g. "Speed Boost Lvl 3"). */
  label: string;
  /** Effect type — drives the icon drawn. */
  icon: import('../powerups/types').PowerUpId;
  /** Rendered value: a countdown (`"12s"`) while temporary, else `∞`. */
  value: string;
  /** Current effective level (`permanent + temporary`). */
  level: number;
  /** True while a temporary level-up window is active. */
  temporary: boolean;
  /** Consumable count (Shield absorptions, Phase Shift charges, Teleport teleports), if any. */
  stacks?: number;
}

/**
 * Formats a HUD row value: a live countdown while a temporary level-up
 * window is active, otherwise the infinity glyph (the level is permanent for
 * the run).
 */
export function formatHUDValue(
  temporary: boolean,
  remaining?: number,
): string {
  if (!temporary) return PERMANENT_VALUE;
  return `${Math.max(0, Math.ceil(remaining ?? 0))}s`;
}

/**
 * Builds the rendered row label `"<Name> Lvl <N>"`, appending the optional
 * consumable count as ` ×<stacks>` so the value column stays `∞`/countdown.
 */
export function buildHUDLabel(
  name: string,
  level: number,
  stacks?: number,
): string {
  const base = `${name} Lvl ${level}`;
  return stacks !== undefined && stacks > 0 ? `${base} ×${stacks}` : base;
}

/**
 * Standalone Phaser HUD class. Cast `scene` explicitly when the scene is
 * untyped: the class is intentionally a plain `Phaser.Container` so it
 * binds to any scene without importing scene-specific types.
 */
export interface HUDOptions {
  /** Whether to show the lives counter row. Defaults to true for backward compatibility. Combat gyms with no lives mechanic pass `{ showLives: false }`. */
  showLives?: boolean;
  /**
   * Reads the current run-scoped **effective** level for an active weapon
   * (from the player). When provided, the weapon row label appends
   * `Lvl N` (e.g. `Weapon: spread Lvl 3`); without a provider the level
   * falls back to 0 (standalone use).
   */
  getWeaponLevel?: (weaponId: string) => number;
}

export class HUD extends Phaser.GameObjects.Container {
  private _registry: EffectsRegistry | null = null;
  private _livesLabel: Phaser.GameObjects.Text;
  private _mineralBar: Phaser.GameObjects.Graphics;
  private _rows: HUDEntry[] = [];
  private _rowObjects: Phaser.GameObjects.GameObject[] = [];
  private _iconGraphics: Phaser.GameObjects.Graphics;
  private _showLives: boolean;
  private _getWeaponLevel?: (weaponId: string) => number;
  private _minerals = 0;
  private _mineralCapacity = 0;

  constructor(scene: Phaser.Scene, registry: EffectsRegistry | null = null, options?: HUDOptions) {
    super(scene, 8, 8);
    scene.add.existing(this);
    this.setDepth(HUD_DEPTH);

    this._showLives = options?.showLives ?? true;
    this._getWeaponLevel = options?.getWeaponLevel;

    this._iconGraphics = new Phaser.GameObjects.Graphics(scene);
    this._livesLabel = new Phaser.GameObjects.Text(
      scene,
      ICON_X,
      ROW_HEIGHT * 0.5,
      '',
      TEXT_STYLE,
    );
    this._livesLabel.setVisible(this._showLives);
    this._mineralBar = new Phaser.GameObjects.Graphics(scene);
    this._mineralBar.name = MINERAL_BAR_NAME;
    this._mineralBar.setVisible(false);
    this.add([this._iconGraphics, this._livesLabel, this._mineralBar]);

    this._registry = registry;
    if (registry) {
      this.refresh();
    }
  }

  /**
   * Sets the mineral hold values shown by the hold bar and refreshes the
   * HUD. A capacity of 0 hides the row (e.g. gyms without the mineral
   * mechanic).
   */
  setMineralStore(minerals: number, capacity: number): void {
    this._minerals = Math.max(0, minerals);
    this._mineralCapacity = Math.max(0, capacity);
    this.refresh();
  }

  /** Current mineral hold values shown by the hold bar. */
  getMineralStoreValue(): { minerals: number; capacity: number } {
    return { minerals: this._minerals, capacity: this._mineralCapacity };
  }

  /**
   * Current hold-bar geometry. `filled` and `total` are the pixel widths of
   * the inner fill and the full inner track; `visible` is false when no
   * capacity is configured (the row is hidden entirely).
   */
  getMineralBarState(): { filled: number; total: number; visible: boolean } {
    return {
      filled: this._mineralFillWidth(),
      total: mineralBarInnerWidth(),
      visible: this._mineralCapacity > 0,
    };
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
      let row = 0;
      // One row per power-up/weapon: the shared registry merges permanent
      // and temporary state so a field pickup never adds a second row.
      for (const entry of this._buildPowerUpRows()) {
        this._addRow(entry, row);
        row += 1;
      }
      // Render active weapon rows after power-up rows.
      const weapons = this._registry.activeWeapons();
      for (const weapon of weapons) {
        this._addWeaponRow(weapon, row);
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

    // Mineral hold bar row (drawn only when a capacity is configured).
    this._drawMineralBar();
  }

  /** Phaser per-frame hook: keep the HUD in sync with the registry. */
  update(): void {
    this.refresh();
  }

  /**
   * Y offset (container-relative) at which the first effect/weapon row
   * starts. When the lives counter is shown it owns the top row, so the
   * effect list is pushed below it to avoid overlap
   * (AH-0MU7JTFY1006QA8I). Without lives the list starts at the top,
   * keeping the gym HUD layout unchanged (AC3).
   */
  private _rowY(row: number): number {
    const livesOffset = this._showLives ? ROW_HEIGHT + LIVES_GAP : 0;
    const mineralOffset = this._mineralCapacity > 0 ? ROW_HEIGHT : 0;
    return livesOffset + mineralOffset + row * ROW_HEIGHT;
  }

  /**
   * Draws the mineral hold bar: a fixed-length hollow outline plus a fill
   * that grows linearly from the left. Hidden when no capacity is
   * configured. The fill is inset by the stroke so it never bleeds outside
   * the outline (AC3).
   */
  private _drawMineralBar(): void {
    const bar = this._mineralBar;
    bar.clear();

    if (this._mineralCapacity <= 0) {
      bar.setVisible(false);
      return;
    }

    bar.setVisible(true);
    const livesOffset = this._showLives ? ROW_HEIGHT + LIVES_GAP : 0;
    const y = livesOffset + (ROW_HEIGHT - MINERAL_BAR_HEIGHT) / 2;

    bar.lineStyle(MINERAL_BAR_STROKE, MINERAL_BAR_OUTLINE_COLOR, 1);
    bar.strokeRect(ICON_X, y, MINERAL_BAR_WIDTH, MINERAL_BAR_HEIGHT);

    const filled = this._mineralFillWidth();
    if (filled > 0) {
      bar.fillStyle(MINERAL_BAR_FILL_COLOR, MINERAL_BAR_FILL_ALPHA);
      bar.fillRect(
        ICON_X + MINERAL_BAR_STROKE,
        y + MINERAL_BAR_STROKE,
        filled,
        MINERAL_BAR_HEIGHT - MINERAL_BAR_STROKE * 2,
      );
    }
  }

  /**
   * Pixel width of the inner fill for the current hold: linear from 0 at
   * empty to the full inner width at capacity, clamped, with a small
   * minimum for any non-zero hold.
   */
  private _mineralFillWidth(): number {
    const total = mineralBarInnerWidth();
    if (this._mineralCapacity <= 0) return 0;

    const ratio = Math.min(1, Math.max(0, this._minerals / this._mineralCapacity));
    let filled = Math.round(total * ratio);
    if (this._minerals > 0 && filled < MINERAL_BAR_MIN_FILL) {
      filled = Math.min(MINERAL_BAR_MIN_FILL, total);
    }
    return Math.min(filled, total);
  }

  // ── Rendering helpers ─────────────────────────────────────────────

  /** Builds one display row (icon + label + value) from a HUD entry. */
  private _addRow(entry: HUDEntry, row: number): void {
    const y = this._rowY(row);

    const icon = new Phaser.GameObjects.Graphics(this.scene);
    drawPowerUpIcon(icon, entry.icon, ICON_X, y + ROW_HEIGHT / 2, 8);

    const name = new Phaser.GameObjects.Text(
      this.scene,
      NAME_X,
      y + ROW_HEIGHT * 0.25,
      entry.label,
      TEXT_STYLE,
    );

    const value = new Phaser.GameObjects.Text(
      this.scene,
      VALUE_X,
      y + ROW_HEIGHT * 0.25,
      entry.value,
      TEXT_STYLE,
    );

    this.add([icon, name, value]);
    this._rowObjects.push(icon, name, value);
    this._rows.push(entry);
  }

  // ── Power-up row model ────────────────────────────────────────────

  /**
   * Builds the merged power-up rows: one entry per owned/active power-up,
   * with the effective level in the label and `∞`/countdown in the value
   * (AH-0MUX802450085VZZ). Extra Life is represented by the dedicated lives counter
   * and is never a row. Preserves the pre-existing visibility rules (a
   * permanent Bomb bomb, Phase Shift charges/permanent/active phase, Teleport stored
   * teleports, Magnet/Mineral Scoop timed or permanent).
   */
  private _buildPowerUpRows(): HUDEntry[] {
    const reg = this._registry;
    if (!reg) return [];
    const rows: HUDEntry[] = [];
    for (const id of POWER_UP_LEVEL_IDS) {
      if (id === 'extra_life') continue; // lives are shown by the dedicated counter
      if (!this._isPowerUpRowVisible(id)) continue;
      const entry = getPowerUpById(id);
      const level = reg.powerUpLevel(id);
      const remaining = reg.powerUpTemporaryRemaining(id);
      const temporary = remaining !== undefined;
      const stacks = this._powerUpStacks(id);
      rows.push({
        id,
        name: entry.name,
        label: buildHUDLabel(entry.name, level, stacks),
        icon: entry.id,
        value: formatHUDValue(temporary, remaining),
        level,
        temporary,
        ...(stacks !== undefined ? { stacks } : {}),
      });
    }
    return rows;
  }

  /** Whether a power-up currently warrants a row (pre-existing rules). */
  private _isPowerUpRowVisible(id: PowerUpId): boolean {
    const reg = this._registry!;
    switch (id) {
      case 'shield':
        return reg.isActive('shield');
      case 'bomb':
        return reg.isBombPermanent();
      case 'speed_boost':
        return reg.isActive('speed_boost');
      case 'phase_shift':
        return (
          reg.isPhasePermanent() ||
          reg.phaseCharges() > 0 ||
          reg.isActive('phase_shift')
        );
      case 'teleport':
        return reg.teleportStacks() > 0;
      case 'magnet':
        return reg.isMagnetActive();
      case 'mineral_scoop':
        return reg.isScoopActive() || reg.scoopStacks() > 0;
      default:
        return false;
    }
  }

  /**
   * Consumable count for a power-up (appended to the label), or `undefined`
   * when the level alone conveys the state. A zero count is never surfaced.
   */
  private _powerUpStacks(id: PowerUpId): number | undefined {
    const reg = this._registry!;
    switch (id) {
      case 'shield':
        return reg.shieldAbsorptionsRemaining() || undefined;
      case 'phase_shift':
        return reg.isPhasePermanent() ? undefined : reg.phaseCharges() || undefined;
      case 'teleport':
        return reg.teleportStacks() || undefined;
      default:
        return undefined;
    }
  }

  // ── Test accessors (public model) ─────────────────────────────────

  /** Current display rows (one merged entry per power-up/weapon). */
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

  // ── Weapon row rendering ──────────────────────────────────────────

  /** Builds one weapon display row (icon + name + value). */
  private _addWeaponRow(weapon: WeaponEffect, row: number): void {
    const y = this._rowY(row);

    // Weapon icon.
    const icon = new Phaser.GameObjects.Graphics(this.scene);
    drawWeaponIcon(
      icon,
      weapon.weaponId as WeaponDropIconId,
      ICON_X,
      y + ROW_HEIGHT / 2,
      8,
    );

    // Weapon label, always suffixed with the run-scoped **effective** level
    // (permanent + temporary); the value shows a countdown while a temporary
    // field-pickup window is active, else `∞` (AH-0MUX802450085VZZ).
    const level = this._getWeaponLevel?.(weapon.weaponId) ?? 0;
    const label = `${WEAPON_ROW_PREFIX}${weapon.weaponId} Lvl ${level}`;
    const name = new Phaser.GameObjects.Text(
      this.scene,
      NAME_X,
      y + ROW_HEIGHT * 0.25,
      label,
      TEXT_STYLE,
    );

    // Remaining seconds while the temporary window is active; `∞` for a
    // permanent-only weapon.
    const temporary = weapon.tempWindow === true;
    const value = new Phaser.GameObjects.Text(
      this.scene,
      VALUE_X,
      y + ROW_HEIGHT * 0.25,
      formatHUDValue(temporary, weapon.remaining),
      TEXT_STYLE,
    );

    this.add([icon, name, value]);
    this._rowObjects.push(icon, name, value);
  }
}
