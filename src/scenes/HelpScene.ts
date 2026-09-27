/**
 * Full-screen gym help overlay (AH-0MUAYB67I002REOZ).
 *
 * Launched by the shared `addHelpButton` helper (`src/utils/gymHelp.ts`)
 * after the originating gym pauses itself, so the gym's simulation
 * (movement, spawning, firing) is frozen for exactly as long as the
 * overlay is open. The overlay:
 *
 * - is an **opaque full-screen replacement** (consistent with
 *   `PauseScene`), so nothing shows through;
 * - lists **exactly the drops the originating gym can spawn**, one row per
 *   drop, each with the code-drawn icon that matches the in-game drop
 *   (`drawPowerUpIcon` / `drawWeaponIcon`), the display name and a
 *   one-line description read from the shared catalogues;
 * - focuses its `Close` control by default and is keyboard-operable
 *   (Tab / arrows cycle focus, Enter / Space activate) via the shared
 *   `FocusManager`;
 * - closes on `?`, **ESC**, or the `Close` control, resuming the
 *   originating gym exactly where it paused.
 *
 * While the overlay is open the gym is paused and therefore receives no
 * keyboard input, so the `?`/ESC close handling lives here — ESC closes
 * the help and never reaches the gym's ESC-to-menu handler. Closing the
 * overlay re-activates the gym's ESC-to-menu behaviour.
 *
 * The scene lives in `src/scenes/` (not `src/scenes/gym/`) so the gym
 * index's directory-dynamic discovery never lists it as a gym; it is
 * registered in `src/core/gameConfig.ts`.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { FocusManager } from '../utils/focusManager';
import {
  getHelpEntries,
  type HelpDropId,
  type HelpEntry,
} from '../utils/gymHelp';

/** Data passed by `addHelpButton` when launching the overlay. */
export interface HelpSceneData {
  /** Scene key of the gym the help belongs to (resumed on close). */
  gymKey: string;
  /** The ordered drop list the gym can spawn. */
  drops: readonly HelpDropId[];
}

/** Opaque background — a full-screen replacement, not a translucent overlay. */
const HELP_BACKGROUND = 0x000000;
/** Title colour (neon cyan, matching the gym HUD). */
const TITLE_COLOR = '#00ffff';
/** Row name colour. */
const NAME_COLOR = '#ffffff';
/** Row description colour. */
const DESCRIPTION_COLOR = '#8899aa';
/** Focus highlight colour for the Close control. */
const FOCUS_COLOR = '#ffffff';
/** Dimmed colour for the unfocused Close control. */
const DIM_COLOR = '#8899aa';
/** Icon radius extent in px inside the overlay. */
export const HELP_ICON_SIZE = 16;
/** Icon centre x. */
const ICON_X = 130;
/** Left edge of the text column (name + description). */
const TEXT_X = 172;
/** Vertical spacing between rows. */
const ROW_HEIGHT = 56;
/** Y position of the first row. */
const ROWS_START_Y = 118;
/** Wrapped width for row descriptions. */
const DESCRIPTION_WRAP_WIDTH = GAME_WIDTH - TEXT_X - 120;
/** Label of the overlay's close control. */
export const HELP_CLOSE_LABEL = 'Close';

/**
 * Derives a friendly gym title from its scene key, e.g.
 * `GymPowerUpsUtility` → `Power Ups Utility`.
 */
export function gymLabelFromKey(key: string): string {
  const base = key.startsWith('Gym') ? key.slice(3) : key;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

export class HelpScene extends Phaser.Scene {
  private gymKey = '';
  private entries: HelpEntry[] = [];
  private closeControl: Phaser.GameObjects.Text | null = null;

  /** Shared in-canvas focus manager (Close is focused by default). */
  private focusManager = new FocusManager(
    { color: FOCUS_COLOR, stroke: '#ffffff', strokeThickness: 3 },
    { color: DIM_COLOR },
  );

  constructor() {
    super({ key: 'HelpScene' });
  }

  create(data: HelpSceneData): void {
    this.gymKey = data?.gymKey ?? '';
    this.entries = getHelpEntries(data?.drops ?? []);
    this.focusManager = new FocusManager(
      { color: FOCUS_COLOR, stroke: '#ffffff', strokeThickness: 3 },
      { color: DIM_COLOR },
    );

    // Render above the paused gym. Gym scenes are added dynamically by
    // `GymIndex`, so they sit *after* this config-registered scene in the
    // SceneManager list and would otherwise render on top of the overlay
    // (paused scenes still render). Bringing this scene to the top makes
    // the opaque background cover the whole screen.
    this.scene.bringToTop();

    // Full-screen opaque background — a replacement screen, not an overlay.
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, HELP_BACKGROUND).setOrigin(0);

    this.add
      .text(GAME_WIDTH / 2, 46, `HELP — ${gymLabelFromKey(this.gymKey)}`, {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: TITLE_COLOR,
      })
      .setOrigin(0.5);

    this._renderRows();
    this._addCloseControl();

    // Own keydown handling: `?`/ESC close; everything else is delegated to
    // the shared focus manager (attaching its own listener too would
    // double-handle Tab/arrow keys).
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.handleKey(event);
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  // ── Rendering ───────────────────────────────────────────────────

  /** Renders one icon + name + wrapped description row per drop. */
  private _renderRows(): void {
    this.entries.forEach((entry, index) => {
      const rowY = ROWS_START_Y + index * ROW_HEIGHT;

      const icon = this.add.graphics();
      entry.drawIcon(icon, ICON_X, rowY, HELP_ICON_SIZE);

      this.add.text(TEXT_X, rowY - HELP_ICON_SIZE, entry.name, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: NAME_COLOR,
      });

      this.add.text(TEXT_X, rowY + 4, entry.description, {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: DESCRIPTION_COLOR,
        wordWrap: { width: DESCRIPTION_WRAP_WIDTH },
      });
    });
  }

  /** Builds the focused `Close` control (keyboard- and pointer-operable). */
  private _addCloseControl(): void {
    this.closeControl = this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 44, HELP_CLOSE_LABEL, {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    this.closeControl.setInteractive({ useHandCursor: true });
    this.closeControl.on('pointerdown', () => this.closeHelp());
    // Registering the first control focuses it by default.
    this.focusManager.register(this.closeControl, () => this.closeHelp());
  }

  // ── Input ───────────────────────────────────────────────────────

  /**
   * Processes one keydown event and returns whether it was consumed.
   * `?` and ESC close the help; all other keys are delegated to the
   * shared focus manager (Tab / arrows / Enter / Space).
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.repeat) return false;
    if (event.key === '?' || event.key === 'Escape') {
      event.preventDefault?.();
      this.closeHelp();
      return true;
    }
    return this.focusManager.handleKey(event);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /**
   * Closes the overlay and resumes the originating gym exactly where it
   * paused. Safe no-op for the scene-level resume when the gym is not
   * being managed by this scene (direct unit tests).
   */
  closeHelp(): void {
    const gymKey = this.gymKey;
    if (gymKey && this.scene.manager.getScene(gymKey) && this.scene.isPaused(gymKey)) {
      this.scene.resume(gymKey);
    }
    this.scene.stop();
  }

  // ── Public test accessors ───────────────────────────────────────

  /** Scene key of the gym this overlay documents. */
  getGymKey(): string {
    return this.gymKey;
  }

  /** The resolved help rows, in the order they were requested. */
  getEntries(): HelpEntry[] {
    return [...this.entries];
  }

  /** The `Close` control text object (null before `create`). */
  getCloseControl(): Phaser.GameObjects.Text | null {
    return this.closeControl;
  }

  /** Display label of the currently focused control (`''` when none). */
  getFocusedLabel(): string {
    return this.closeControl && this.focusManager.getFocusedIndex() === 0
      ? this.closeControl.text
      : '';
  }

  /** Number of registered focusable controls (1: `Close`). */
  getControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** Activates the currently focused control (keyboard proxy for tests). */
  activateFocused(): void {
    this.focusManager.activateFocused();
  }
}
