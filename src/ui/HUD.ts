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
 * the label as ` ×N` so the value column stays strictly `∞`/countdown. A
 * recharging consumable (the Thorn Field, AH-0MVJ8YKR70096C6T) also appends
 * its `next in Ns` recharge countdown to the label.
 *
 * A charge-based power-up the player **owns** but whose pool is currently
 * **empty** stays visible as a greyed-out row (icon + label + value all in
 * the shared grey from `powerups/icons.ts`) instead of being hidden, so the
 * recharging pool is always legible (AH-0MV82I97Y007MB6M). A power-up the
 * player has never owned is still hidden.
 *
 * ## Slot budget and non-slot rows (AH-0MVVJRRN10038VFR)
 *
 * The row list is **not** the loadout: the six-slot model
 * (`powerups/slots.ts`) counts distinct kinds a run holds, while a row is a
 * display entry — and two row classes never hold a slot (exempt entries such
 * as the Mystery UFO, and Phase Shift / Teleport charge pools that outlive a
 * temporary window). When a scene supplies `HUDOptions.getSlotState`
 * (`resolvePlayerSlotState(player)`, wired once through
 * `scenes/core/hudWiring.ts`), the HUD:
 *
 * - renders an explicit `Loadout n/6` budget read-out;
 * - marks every non-slot row (`always available` / `charges only`); and
 * - renders a row for every slot-held kind, including a temporary one-shot
 *   (Orbital Strike, Smart Bomb) whose pre-existing rule hid it.
 *
 * Without a provider (standalone use) the HUD behaves exactly as before.
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
import {
  drawPowerUpIcon,
  drawWeaponIcon,
  POWER_UP_GREY_COLOUR,
  POWER_UP_GREY_COLOUR_CSS,
} from '../powerups/icons';
import type { WeaponDropIconId } from '../powerups/icons';
import { HUD_DEPTH, POWER_UP_SLOT_CAP } from '../core/constants';
import {
  isSlotCountedHeldKind,
  type PowerUpSlotState,
} from '../powerups/slots';

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
 * Horizontal offset of the non-slot marker column. Sits right of the value
 * column so a marker never shifts a row's label or value (the existing
 * `∞`/countdown contract) — the marker is additional information.
 */
const MARKER_X = 210;

/** Name of the slot-budget read-out Text object (test/debug access). */
export const SLOT_BUDGET_NAME = 'hud-slot-budget';

/** Marker on a row whose kind never consumes a slot because it is exempt. */
export const SLOT_MARKER_ALWAYS_AVAILABLE = 'always available';

/**
 * Marker on a row kept visible by remaining consumable charges after its
 * temporary level window expired — the row is a charge pool, not a slot.
 */
export const SLOT_MARKER_CHARGES_ONLY = 'charges only';

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
  /**
   * Seconds until the next automatic recharge for a recharging consumable
   * (Thorn Field), or `undefined` when nothing is recharging. Rendered in the
   * label as `next in Ns` so the row is never an inert bare label
   * (AH-0MVJ8YKR70096C6T).
   */
  recharge?: number;
  /**
   * True when the row is rendered inactive (greyed out) because a
   * charge-based pool the player owns is currently empty
   * (AH-0MV82I97Y007MB6M). Always `false` for charged rows and for
   * non-charge rows.
   */
  greyed: boolean;
  /**
   * True when the row's kind holds one of the six loadout slots, derived from
   * the shared slot model (`resolvePlayerSlotState`) — never counted in the
   * HUD. `true` when no slot-state provider is wired (standalone use), so the
   * pre-existing "every rendered row is equipped" reading is preserved.
   */
  slotCounted?: boolean;
  /**
   * Non-slot marker rendered to the right of the row when the kind holds no
   * slot (an exempt entry, or a charge pool outliving its window). Absent on
   * slot-counted rows (AH-0MVVJRRN10038VFR).
   */
  marker?: string;
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
 * consumable count as ` ×<stacks>` so the value column stays `∞`/countdown,
 * plus an optional `next in Ns` recharge countdown (Thorn Field,
 * AH-0MVJ8YKR70096C6T) so a recharging row is never an inert bare label.
 */
export function buildHUDLabel(
  name: string,
  level: number,
  stacks?: number,
  rechargeSeconds?: number,
): string {
  const withStacks =
    stacks !== undefined && stacks > 0
      ? `${name} Lvl ${level} ×${stacks}`
      : `${name} Lvl ${level}`;
  if (rechargeSeconds === undefined || rechargeSeconds <= 0) {
    return withStacks;
  }
  return `${withStacks} (next in ${Math.ceil(rechargeSeconds)}s)`;
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
  /**
   * Reads the live six-slot state — `resolvePlayerSlotState(player)`, the one
   * shared seam (game and every gym). When provided, the HUD renders the slot
   * budget (`Loadout n/6`), marks rows that hold no slot, and renders a row for
   * every slot-held kind (including a temporary one-shot that previously had
   * none) so the displayed loadout agrees with the model
   * (AH-0MVVJRRN10038VFR). Without a provider the HUD is unchanged.
   */
  getSlotState?: () => PowerUpSlotState | null;
}

export class HUD extends Phaser.GameObjects.Container {
  private _registry: EffectsRegistry | null = null;
  private _livesLabel: Phaser.GameObjects.Text;
  private _mineralBar: Phaser.GameObjects.Graphics;
  private _rows: HUDEntry[] = [];
  private _rowObjects: Phaser.GameObjects.GameObject[] = [];
  private _iconGraphics: Phaser.GameObjects.Graphics;
  private _budgetLabel: Phaser.GameObjects.Text;
  private _showLives: boolean;
  private _getWeaponLevel?: (weaponId: string) => number;
  private _getSlotState?: () => PowerUpSlotState | null;
  /** Weapon rows rendered this frame (id + label), for the loadout read-out. */
  private _weaponRows: Array<{ id: string; label: string }> = [];
  private _minerals = 0;
  private _mineralCapacity = 0;

  constructor(scene: Phaser.Scene, registry: EffectsRegistry | null = null, options?: HUDOptions) {
    super(scene, 8, 8);
    scene.add.existing(this);
    this.setDepth(HUD_DEPTH);

    this._showLives = options?.showLives ?? true;
    this._getWeaponLevel = options?.getWeaponLevel;
    this._getSlotState = options?.getSlotState;

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
    this._budgetLabel = new Phaser.GameObjects.Text(
      scene,
      ICON_X,
      ROW_HEIGHT * 0.25,
      '',
      TEXT_STYLE,
    );
    this._budgetLabel.name = SLOT_BUDGET_NAME;
    this._budgetLabel.setVisible(false);
    this.add([
      this._iconGraphics,
      this._livesLabel,
      this._mineralBar,
      this._budgetLabel,
    ]);

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
    this._weaponRows = [];
    this._drawSlotBudget();

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
    return (
      livesOffset +
      mineralOffset +
      this._budgetOffset() +
      row * ROW_HEIGHT
    );
  }

  /**
   * Extra offset reserved for the slot-budget read-out. A wired slot-state
   * provider (every game/gym scene) reserves the row so the budget never
   * shifts as the ship spawns; a standalone HUD without one keeps its exact
   * pre-existing layout (AH-0MVVJRRN10038VFR AC4).
   */
  private _budgetOffset(): number {
    return this._getSlotState ? ROW_HEIGHT : 0;
  }

  /** The live slot state, or `null` when unwired / no player yet. */
  private _slotState(): PowerUpSlotState | null {
    return this._getSlotState?.() ?? null;
  }

  /**
   * Draws the `Loadout n/6` slot-budget read-out from the shared model.
   * Inert (invisible, empty) when no provider is wired or no player exists
   * yet, so a scene before the ship spawns never shows a false occupancy.
   */
  private _drawSlotBudget(): void {
    const state = this._slotState();
    if (!state) {
      this._budgetLabel.setText('');
      this._budgetLabel.setVisible(false);
      return;
    }
    const livesOffset = this._showLives ? ROW_HEIGHT + LIVES_GAP : 0;
    const mineralOffset = this._mineralCapacity > 0 ? ROW_HEIGHT : 0;
    this._budgetLabel.setPosition(
      ICON_X,
      livesOffset + mineralOffset + ROW_HEIGHT * 0.25,
    );
    this._budgetLabel.setText(`Loadout ${state.used}/${POWER_UP_SLOT_CAP}`);
    this._budgetLabel.setVisible(true);
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
    drawPowerUpIcon(
      icon,
      entry.icon,
      ICON_X,
      y + ROW_HEIGHT / 2,
      8,
      entry.greyed ? POWER_UP_GREY_COLOUR : undefined,
    );

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

    // A greyed (owned-but-empty) row paints the icon, label and value with
    // the one shared grey so they cannot diverge (AH-0MV82I97Y007MB6M).
    if (entry.greyed) {
      name.setColor(POWER_UP_GREY_COLOUR_CSS);
      value.setColor(POWER_UP_GREY_COLOUR_CSS);
    }

    this.add([icon, name, value]);
    this._rowObjects.push(icon, name, value);
    this._rows.push(entry);

    // Non-slot marker: tells the player the row is not one of the six
    // loadout slots (exempt entry / charge pool) without changing the label
    // or value the rest of the HUD contract pins.
    if (entry.marker) {
      const marker = new Phaser.GameObjects.Text(
        this.scene,
        MARKER_X,
        y + ROW_HEIGHT * 0.25,
        entry.marker,
        { ...TEXT_STYLE, color: POWER_UP_GREY_COLOUR_CSS },
      );
      this.add(marker);
      this._rowObjects.push(marker);
    }
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
    const state = this._slotState();
    for (const id of POWER_UP_LEVEL_IDS) {
      if (id === 'extra_life') continue; // lives are shown by the dedicated counter
      // A kind that holds a slot always gets a row, even when the
      // pre-existing visibility rule hides it (a temporary one-shot such as
      // Orbital Strike): otherwise the list would under-report the loadout
      // (tick 4540 of the RCA recording).
      const heldByModel = state !== null && state.heldIds.has(id);
      if (!this._isPowerUpRowVisible(id) && !heldByModel) continue;
      const entry = getPowerUpById(id);
      // An owned consumable holds level 0 (a hold-full reward adds a charge,
      // never a level — parent AH-0MVTQMREN009DSFW AC1); it is displayed at
      // its base level 1 so the row still reads as a levelled item.
      const level = Math.max(1, reg.powerUpLevel(id));
      const remaining = reg.powerUpTemporaryRemaining(id);
      const temporary = remaining !== undefined;
      const stacks = this._powerUpStacks(id);
      const recharge = this._powerUpRecharge(id);
      const greyed = this._isPowerUpGreyed(id);
      const marker = state ? this._slotMarker(id, state) : undefined;
      rows.push({
        id,
        name: entry.name,
        label: buildHUDLabel(entry.name, level, stacks, recharge),
        icon: entry.id,
        value: formatHUDValue(temporary, remaining),
        level,
        temporary,
        greyed,
        slotCounted: state ? isSlotCountedHeldKind(id, state) : true,
        ...(stacks !== undefined ? { stacks } : {}),
        ...(recharge !== undefined ? { recharge } : {}),
        ...(marker !== undefined ? { marker } : {}),
      });
    }
    return rows;
  }

  /**
   * The non-slot marker for a rendered row, or `undefined` when the kind
   * holds a slot. Derived from the shared model, never from row knowledge:
   *
   * - exempt entries (`availableWhenSlotsFull`) → "always available";
   * - anything else held-only by a consumable pool (a Phase Shift / Teleport
   *   row kept alive by remaining charges after its window expired) →
   *   "charges only".
   */
  private _slotMarker(
    id: PowerUpId,
    state: PowerUpSlotState,
  ): string | undefined {
    if (isSlotCountedHeldKind(id, state)) return undefined;
    return getPowerUpById(id).availableWhenSlotsFull === true
      ? SLOT_MARKER_ALWAYS_AVAILABLE
      : SLOT_MARKER_CHARGES_ONLY;
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
          reg.isActive('phase_shift') ||
          // Owned (permanent or field pickup) but spent: the recharging pool
          // keeps the row visible (greyed) rather than hiding it
          // (AH-0MV82I97Y007MB6M).
          this._ownsChargePool(id)
        );
      case 'teleport':
        return reg.teleportStacks() > 0 || this._ownsChargePool(id);
      case 'magnet':
        return reg.isMagnetActive();
      case 'mineral_scoop':
        return reg.isScoopActive() || reg.scoopStacks() > 0;
      case 'smart_bomb':
        // A permanent (hold-full) Smart Bomb is a run-scoped active effect; a
        // field pickup is a one-shot and leaves no row (AH-0MV1BIWP9003EHRQ).
        return reg.isSmartBombPermanent();
      case 'force_field':
        // Show the row while the reflect bubble is active (field pickup or
        // permanent reward) so the remaining reflect budget is visible
        // (AH-0MV1BIX1W006XF95).
        return reg.isForceFieldActive();
      case 'mystery_ufo':
        // The Mystery UFO is a visible collector drone with no timed effect of
        // its own, but a field pickup still opens its per-upgrade 15 s
        // temporary-level window (§4.4.3), so show its row for as long as the
        // player owns it (any collection advanced its level); the row renders
        // the effective level (drone lifetime/capacity/radius) and the window
        // countdown or ∞ (AH-0MV9G113S009B37I). A hold-full reward owns the
        // kind without levelling it (parent AH-0MVTQMREN009DSFW AC1), so
        // ownership also keeps the row visible.
        return (
          reg.powerUpLevel('mystery_ufo') > 0 ||
          reg.levelStore().consumableCharges('mystery_ufo') > 0 ||
          reg.isMysteryUfoPermanent()
        );
      case 'frenzy':
      case 'chrono':
      case 'salvage':
        // Timed net-new power-ups (AH-0MVCRC1Q0007JAV1): show the row while
        // their window is active, so the player can read the countdown.
        return reg.isActive(id);
      case 'thorns':
        // Thorn Field: visible while active OR a ram budget remains (the
        // budget is the informative part, like the Force Field absorb row).
        return reg.isActive('thorns') || reg.thornsRemaining() > 0;
      case 'strike':
        // Orbital Strike: a permanent bolt is a run-scoped active effect; a
        // field pickup is a one-shot and leaves no row (mirrors Smart Bomb).
        return reg.isStrikePermanent();
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
        // The finite recharging pool is surfaced even for the permanent
        // reward, which is no longer an unlimited supply
        // (AH-0MV82I97Y007MB6M).
        return reg.phaseCharges() || undefined;
      case 'teleport':
        return reg.teleportStacks() || undefined;
      case 'force_field':
        return reg.forceFieldRemaining() || undefined;
      case 'thorns':
        // Thorn Field carries its remaining ram absorbs so the HUD renders
        // `Thorn Field xN` and updates as rams are absorbed.
        return reg.thornsRemaining() || undefined;
      default:
        return undefined;
    }
  }

  /**
   * Seconds until the next automatic recharge for a recharging consumable, or
   * `undefined` when nothing is recharging. Only the Thorn Field recharges
   * today (AH-0MVJ8YKR70096C6T); an armed field with a spent budget — and, in
   * particular, a permanent (hold-full) field sitting at zero charges — shows
   * its countdown so the row never reads as an inert bare label.
   *
   * The permanent Orbital Strike row also carries a countdown to its next bolt
   * (AH-0MVS2T40T006QL7H): a multi-second interval (6.75 s at the first grant,
   * AH-0MVRE6N08001TE4V) otherwise reads as an inert power-up. The registry
   * owns the clock; the HUD only projects it through the same `next in Ns`
   * label formatter, so there is one formatting path.
   */
  private _powerUpRecharge(id: PowerUpId): number | undefined {
    const reg = this._registry!;
    switch (id) {
      case 'thorns': {
        const seconds = reg.thornsRechargeRemaining();
        return seconds > 0 ? seconds : undefined;
      }
      case 'strike':
        // `undefined` when no permanent strike is armed (field pickup: no row)
        // or a bolt is latched/landing, so the label never shows a stalled or
        // negative countdown.
        return reg.strikeNextBoltSeconds();
      default:
        return undefined;
    }
  }

  /**
   * Whether the player **owns** a charge-based pool (`phase_shift` /
   * `teleport`) this run — permanent grants and field-pickup stacks both
   * count (`powerUpLevel` is their sum, 0 when never picked up). Used to keep
   * an owned-but-empty pool visible (greyed) instead of hiding it
   * (AH-0MV82I97Y007MB6M).
   */
  private _ownsChargePool(id: PowerUpId): boolean {
    // A consumable hold-full reward never raises the level (parent
    // AH-0MVTQMREN009DSFW AC1): ownership is the per-kind flag, so an owned
    // kind stays visible (greyed) while its empty pool regenerates.
    const store = this._registry!.levelStore?.();
    if (store && store.isConsumableOwned(id)) return true;
    return this._registry!.powerUpLevel(id) > 0;
  }

  /**
   * Whether a row should render greyed-out/inactive: the player owns the
   * charge-based pool but has zero available charges/stacks
   * (AH-0MV82I97Y007MB6M). Non-charge rows are never greyed.
   */
  private _isPowerUpGreyed(id: PowerUpId): boolean {
    const reg = this._registry!;
    switch (id) {
      case 'phase_shift':
        return this._ownsChargePool(id) && reg.phaseCharges() === 0;
      case 'teleport':
        return this._ownsChargePool(id) && reg.teleportStacks() === 0;
      default:
        return false;
    }
  }

  // ── Test accessors (public model) ─────────────────────────────────

  /** Current display rows (one merged entry per power-up/weapon). */
  getRows(): HUDEntry[] {
    return [...this._rows];
  }

  /**
   * The slot budget the HUD displays, from the shared model only: `used` is
   * `resolvePlayerSlotState(...).used` and `cap` is `POWER_UP_SLOT_CAP`.
   * Inert (`0/6`) when no provider is wired or no player exists yet.
   */
  getSlotBudget(): { used: number; cap: number } {
    const state = this._slotState();
    return { used: state?.used ?? 0, cap: POWER_UP_SLOT_CAP };
  }

  /** Rendered slot-budget text (e.g. `Loadout 5/6`), empty when inert. */
  getSlotBudgetLabel(): string {
    return this._budgetLabel.text;
  }

  /**
   * Every rendered loadout row (power-ups **and** weapons) with its slot
   * classification, so a non-slot row is marked rather than silently counted
   * as equipped (AH-0MVVJRRN10038VFR AC2).
   */
  getLoadoutRows(): Array<{
    id: string;
    label: string;
    slotCounted: boolean;
    marker?: string;
  }> {
    const state = this._slotState();
    return [
      ...this._rows.map((row) => ({
        id: row.id,
        label: row.label,
        slotCounted: row.slotCounted ?? true,
        ...(row.marker !== undefined ? { marker: row.marker } : {}),
      })),
      ...this._weaponRows.map((row) => ({
        id: row.id,
        label: row.label,
        slotCounted: state ? isSlotCountedHeldKind(row.id, state) : true,
      })),
    ];
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
    this._weaponRows.push({ id: weapon.weaponId, label });
  }
}
