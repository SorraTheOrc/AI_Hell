/**
 * Shared gym help affordance (AH-0MUAYB67I002REOZ).
 *
 * Adds a `Help (?)` button next to the existing `← INDEX` button and wires
 * both the button and the `?` key to pause the gym and launch the
 * full-screen `HelpScene` overlay:
 *
 * ```ts
 * // inside a gym's create()
 * addBackToIndexButton(this);
 * addHelpButton(this, { gymKey: 'GymWeapons', drops: ['cannon', 'spread', …] });
 * ```
 *
 * The helper is deliberately **gym-agnostic**: the caller passes the
 * ordered drop list it can spawn (`DropId | 'cannon'`), and the helper
 * resolves each id to its display name, one-line description and
 * code-drawn icon from the **shared catalogues** (`POWER_UP_CATALOGUE`,
 * `WEAPON_CATALOGUE`, `RESET_DROP`). This guarantees the help copy cannot
 * drift from the implemented behaviour and reuses the exact in-game icon
 * drawers (`drawPowerUpIcon` / `drawWeaponIcon`).
 *
 * `HelpScene` lives in `src/scenes/` (not `src/scenes/gym/`) so the gym
 * index's `import.meta.glob('../scenes/gym/*.ts')` discovery never lists
 * the overlay as a gym, and it is registered in `gameConfig.ts`.
 */

import Phaser from 'phaser';

import { GAME_WIDTH } from '../core/constants';
import { BACK_TO_INDEX_LABEL } from './gymNavigation';
import {
  POWER_UP_CATALOGUE,
  isWeaponDrop,
  type DropId,
} from '../powerups/types';
import { RESET_DROP, WEAPON_CATALOGUE } from './weapons';
import { drawPowerUpIcon, drawWeaponIcon } from '../powerups/icons';

/** Scene key of the shared help overlay (registered in `gameConfig.ts`). */
export const HELP_SCENE_KEY = 'HelpScene';

/** Label shown by the shared help button. */
export const HELP_BUTTON_LABEL = 'Help (?)';

/** Horizontal gap (px) between the `← INDEX` button and `Help (?)`. */
export const HELP_BUTTON_GAP = 12;

/**
 * Every drop the help overlay can describe: the field drops (`DropId`,
 * i.e. P3–P9 plus spread/dual/rapid/reset) and the permanent cannon.
 */
export type HelpDropId = DropId | 'cannon';

/** Resolved help row: display name, one-line description and icon drawer. */
export interface HelpEntry {
  /** The drop id this row describes. */
  id: HelpDropId;
  /** Human-readable display name (from the shared catalogue). */
  name: string;
  /** One-line player-facing effect description (from the shared catalogue). */
  description: string;
  /**
   * Draws the drop's code-drawn icon into a caller-owned Graphics at
   * (x, y), matching the in-game drop exactly.
   */
  drawIcon: (
    graphics: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    size: number,
  ) => void;
}

/**
 * Resolves one drop id to its help row by reading the shared catalogues.
 * Weapon drops (including `reset`) and `cannon` come from the weapon
 * catalogue / reset entry; power-ups come from `POWER_UP_CATALOGUE`.
 *
 * @param id — a drop id (`DropId`) or the permanent `'cannon'`.
 * @throws Error if the id is not present in any catalogue.
 */
export function getHelpEntry(id: HelpDropId): HelpEntry {
  if (id === 'cannon' || isWeaponDrop(id)) {
    if (id === 'reset') {
      return {
        id,
        name: RESET_DROP.name,
        description: RESET_DROP.description,
        drawIcon: (graphics, x, y, size) =>
          drawWeaponIcon(graphics, 'reset', x, y, size),
      };
    }
    const weapon = WEAPON_CATALOGUE[id];
    if (!weapon) throw new Error(`Unknown weapon drop for help: ${id}`);
    return {
      id,
      name: weapon.name,
      description: weapon.description,
      drawIcon: (graphics, x, y, size) =>
        drawWeaponIcon(graphics, id, x, y, size),
    };
  }

  const powerUp = POWER_UP_CATALOGUE[id];
  if (!powerUp) throw new Error(`Unknown power-up for help: ${id}`);
  return {
    id,
    name: powerUp.name,
    description: powerUp.description,
    drawIcon: (graphics, x, y, size) =>
      drawPowerUpIcon(graphics, powerUp.type, x, y, size),
  };
}

/**
 * Resolves an ordered drop list to its ordered help rows (one per drop,
 * no de-duplication — the caller controls the list).
 */
export function getHelpEntries(drops: readonly HelpDropId[]): HelpEntry[] {
  return drops.map((id) => getHelpEntry(id));
}

/** Configuration for {@link addHelpButton}. */
export interface GymHelpConfig {
  /** Scene key of the gym the help belongs to (resumed on close). */
  gymKey: string;
  /** The ordered drop list this gym can spawn. */
  drops: readonly HelpDropId[];
}

/** Handle returned by {@link addHelpButton} (button + open action). */
export interface GymHelpHandle {
  /** The rendered `Help (?)` button. */
  button: Phaser.GameObjects.Text;
  /**
   * Opens the help overlay (pauses the gym, launches `HelpScene`). Exposed
   * so tests can drive the open path without faking pointer/key events.
   */
  openHelp: () => void;
}

/** Monospace neon button style (matches the gym HUD / index button). */
const BUTTON_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#00ffff',
  backgroundColor: '#1a1a1a',
  padding: { x: 8, y: 4 },
};

/**
 * Finds the gym's existing `← INDEX` button (added by
 * `addBackToIndexButton`). Used only to position the help button adjacent
 * to it; returns `null` when the index button is absent, in which case a
 * sensible default position is used.
 */
function findBackToIndexButton(
  scene: Phaser.Scene,
): Phaser.GameObjects.Text | null {
  for (const child of scene.children.list) {
    if (
      child instanceof Phaser.GameObjects.Text &&
      child.text === BACK_TO_INDEX_LABEL
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Adds a `Help (?)` button immediately to the **left** of the `← INDEX`
 * button (non-overlapping) and wires it to open the help overlay: pausing
 * the gym's simulation and launching `HelpScene` with `{ gymKey, drops }`.
 * Also binds the `?` key to open the same overlay.
 *
 * Open is idempotent: a second open call while the gym is already paused
 * (e.g. key auto-repeat) is ignored.
 *
 * @param scene — the gym scene (already showing its `← INDEX` button).
 * @param config — the gym key and its ordered spawnable drop list.
 * @returns a handle with the button and the open action.
 */
export function addHelpButton(
  scene: Phaser.Scene,
  config: GymHelpConfig,
): GymHelpHandle {
  const indexButton = findBackToIndexButton(scene);
  const indexLeft = indexButton
    ? indexButton.x - indexButton.width
    : GAME_WIDTH - 10;
  const button = scene.add
    .text(indexLeft - HELP_BUTTON_GAP, 10, HELP_BUTTON_LABEL, BUTTON_STYLE)
    .setOrigin(1, 0);
  button.setInteractive({ useHandCursor: true });

  const openHelp = (): void => {
    // Idempotent open: ignore a repeat while help is already shown.
    if (scene.scene.isPaused(config.gymKey)) return;
    // Pause the gym's simulation (movement, spawning, firing all stop) and
    // launch the full-screen overlay. The paused gym receives no keyboard
    // input, so close handling lives in HelpScene.
    scene.scene.pause(config.gymKey);
    scene.scene.launch(HELP_SCENE_KEY, {
      gymKey: config.gymKey,
      drops: [...config.drops],
    });
  };

  button.on('pointerdown', openHelp);
  scene.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
    if (event.key === '?') {
      event.preventDefault?.();
      openHelp();
    }
  });

  return { button, openHelp };
}
