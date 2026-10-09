/**
 * Gym index — dev-mode entry scene (AC2/AC3/AC4).
 *
 * Discovers every gym scene under `src/scenes/gym/` via `import.meta.glob`.
 * The index renders three columns left-to-right (AH-0MV13G5EV008D41E):
 *
 * - **scenes** — plain scene entries;
 * - **ENEMIES** — a single "Fodder Enemies" row booting the reusable
 *   `GymFodderEnemies` scene bare (its in-panel dropdown selects the
 *   archetype) plus the dedicated multi-phase `GymBoss` "Boss" row;
 * - **Dev Utilities** — tooling scenes such as the difficulty-curve
 *   sequencer, booted directly via `sceneKey`.
 *
 * A new `Gym<Name>.ts` file dropped into the folder appears automatically;
 * the EnemyConfig archetypes are discovered *inside* `GymFodderEnemies`'s
 * panel from the config store, so a Save As entry needs no index change.
 *
 * Keyboard navigation (AH-0MUDZFBYY008P7ZE) is provided by the shared
 * {@link FocusManager}: the first row is focused by default, Tab / Shift+Tab
 * and the arrow keys cycle focus through every row in reading order (wrapping
 * at both ends), and Enter/Space activate the focused row through the same
 * code path as a pointer click. Pointer handlers and ESC-to-menu remain
 * unchanged (keyboard support is additive).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  discoverGymScenes,
  GymSceneEntry,
  loadGymSceneModules,
  sceneClassFromModule,
} from '../utils/gymDiscovery';
import { FocusManager } from '../utils/focusManager';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line (advertises the keyboard controls). */
export const GYM_INDEX_HINT =
  'tab/arrows move · enter/space select · ESC returns to menu';

/** Scene key of the reusable fodder-enemy gym (formerly `GymEnemies`). */
export const FODDER_ENEMIES_SCENE_KEY = 'GymFodderEnemies';
/** Label of the single fodder-enemy row in the ENEMIES column. */
export const FODDER_ENEMIES_LABEL = 'Fodder Enemies';
/** Scene key of the dedicated multi-phase boss (the real Central AI). */
export const BOSS_SCENE_KEY = 'GymBoss';
/** Label of the dedicated boss row in the ENEMIES column. */
export const BOSS_SCENE_LABEL = 'Boss';

/**
 * Scene keys surfaced in the far-right **Dev Utilities** column rather than
 * the plain scene list (AH-0MUGXDVPH005TIZL). Each row boots its scene
 * directly via `sceneKey`, mirroring the dedicated `GymBoss` row.
 */
export const DEV_UTILITY_SCENE_KEYS = ['GymCurveSequencer'] as const;
/** Membership set for {@link DEV_UTILITY_SCENE_KEYS}. */
const DEV_UTILITY_SCENE_KEY_SET: ReadonlySet<string> = new Set(DEV_UTILITY_SCENE_KEYS);

/**
 * Column X positions as fractions of `GAME_WIDTH`, ordered left-to-right:
 * scenes | ENEMIES | Dev Utilities (AH-0MV13G5EV008D41E; the Bosses column
 * was retired and its dedicated row moved into ENEMIES).
 */
export const GYM_INDEX_COLUMN_X = {
  scenes: 0.25,
  enemies: 0.55,
  devUtilities: 0.85,
} as const;

/** Header label for the middle ENEMIES column (kept uppercase). */
export const GYM_INDEX_ENEMIES_HEADER = 'ENEMIES';
/** Header label for the far-right Dev Utilities column. */
export const GYM_INDEX_DEV_UTILITIES_HEADER = 'Dev Utilities';

/**
 * A clickable row rendered in the ENEMIES or Dev Utilities column.
 *
 * Two flavours are merged here:
 * - **config rows** carry `enemyKey` and boot `GymFodderEnemies` with
 *   `{ enemyKey }` (kept for completeness/deep links);
 * - **scene rows** carry `sceneKey` and boot that scene directly (the
 *   reusable `GymFodderEnemies` row, the dedicated `GymBoss` row and the
 *   Dev Utilities tooling scenes are surfaced this way).
 */
export interface EnemyColumnEntry {
  /** Unique row key: scene key for scene rows, `GymFodderEnemies:<configKey>` for config rows. */
  key: string;
  /** Human label shown on the index. */
  label: string;
  /** Enemy config key for rows routed to `GymFodderEnemies` as `{ enemyKey }`. */
  enemyKey?: string;
  /** Dedicated scene key for rows that boot a scene directly (e.g. `GymBoss`). */
  sceneKey?: string;
}

export class GymIndex extends Phaser.Scene {
  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  /** Focusable rows in reading order (label + text object). */
  private controls: { label: string; text: Phaser.GameObjects.Text }[] = [];

  private entries: GymSceneEntry[] = [];
  private enemyEntries: EnemyColumnEntry[] = [];
  private devEntries: EnemyColumnEntry[] = [];

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // Fresh focus registry on every create() so a restarted scene does not
    // accumulate stale controls from a previous run.
    this.focusManager = new FocusManager();
    this.controls = [];

    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    // Genuine scene entries (GymPlayer, etc.). Filter out GymFodderEnemies —
    // it is no longer listed as a bare scene; a single ENEMIES row boots it.
    // Filter out GymBoss — the real boss is surfaced as a dedicated row in
    // the ENEMIES column instead of the plain scene list (AH-0MUAYB28C004KK7X).
    const all = discoverGymScenes(loadGymSceneModules());

    // Far-right Dev Utilities column — tooling scenes categorised away from
    // the plain scene list, each booted directly via `sceneKey`
    // (AH-0MUGXDVPH005TIZL).
    this.devEntries = all
      .filter((e) => DEV_UTILITY_SCENE_KEY_SET.has(e.key))
      .map((e) => ({ key: e.key, label: e.label, sceneKey: e.key }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

    this.entries = all.filter(
      (e) =>
        e.key !== FODDER_ENEMIES_SCENE_KEY &&
        e.key !== BOSS_SCENE_KEY &&
        !DEV_UTILITY_SCENE_KEY_SET.has(e.key),
    );

    // Register every discovered scene so `scene.start(key)` works for each
    // index row (plain scenes, Dev Utilities, the reusable fodder gym and the
    // dedicated boss). The fodder and boss scenes are not in the plain list
    // but are booted directly by their ENEMIES rows.
    for (const entry of all) {
      if (!this.scene.manager.getScene(entry.key)) {
        const sceneClass = sceneClassFromModule(entry.module, entry.key);
        if (sceneClass) this.scene.add(entry.key, sceneClass as typeof Phaser.Scene);
      }
    }

    // Middle ENEMIES column (AH-0MV13G5EV008D41E): the single reusable fodder
    // gym (booted bare; its dropdown selects the archetype) followed by the
    // dedicated multi-phase `GymBoss` scene. Per-config rows, the `boss`
    // "Boss Swarm" row and the Bosses column were retired.
    this.enemyEntries = [
      {
        key: FODDER_ENEMIES_SCENE_KEY,
        label: FODDER_ENEMIES_LABEL,
        sceneKey: FODDER_ENEMIES_SCENE_KEY,
      },
      {
        key: BOSS_SCENE_KEY,
        label: BOSS_SCENE_LABEL,
        sceneKey: BOSS_SCENE_KEY,
      },
    ];

    // ── Title ────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, 90, GYM_INDEX_TITLE, {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#00ffff',
      })
      .setOrigin(0.5);

    // ── Three-column layout ────────────────────────────────────────
    const entryStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#00ff00',
      backgroundColor: '#1a1a1a',
      padding: { x: 10, y: 6 },
    };
    const headerStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#888888',
    };
    const rowGap = 42;
    const startY = 150;
    const headerY = startY - 18;
    // Left column = plain scenes; middle = ENEMIES; far-right = Dev Utilities
    // tooling scenes. Columns are distributed left-to-right across the width.
    const scenesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const enemiesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const devUtilitiesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;

    // Left column — scene entries (alphabetical).
    this.entries.forEach((entry, index) => {
      const row = this.add
        .text(scenesColX, startY + index * rowGap, entry.label, entryStyle)
        .setOrigin(0.5);
      this.registerRow(row, entry.label, () => this.scene.start(entry.key));
    });

    // Middle column — ENEMIES header + fodder/boss rows.
    this.renderColumn(this.enemyEntries, enemiesColX, GYM_INDEX_ENEMIES_HEADER, {
      startY,
      headerY,
      rowGap,
      entryStyle,
      headerStyle,
    });

    // Far-right column — Dev Utilities header + tooling scene entries
    // (AH-0MUGXDVPH005TIZL).
    this.renderColumn(
      this.devEntries,
      devUtilitiesColX,
      GYM_INDEX_DEV_UTILITIES_HEADER,
      { startY, headerY, rowGap, entryStyle, headerStyle },
    );

    // ── Keyboard focus (AH-0MUDZFBYY008P7ZE) ─────────────────────────
    // The shared FocusManager owns Tab / arrow cycling and Enter / Space
    // activation. Rows are registered in reading order (plain scenes →
    // ENEMIES → Dev Utilities), so the first row is focused by default.
    // Pointer handlers stay unchanged — keyboard support is additive. Tear
    // the listener down on scene shutdown so a restart does not leak it.
    this.focusManager.attachKeyboard(this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });

    // ── Hint ─────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 16, GYM_INDEX_HINT, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#555555',
      })
      .setOrigin(0.5);
  }

  // ── Rendering helpers ─────────────────────────────────────────────

  /**
   * Renders one header + clickable rows for an index column (ENEMIES or Dev
   * Utilities). No-op when the column has no entries, so the header never
   * floats alone.
   */
  private renderColumn(
    entries: EnemyColumnEntry[],
    x: number,
    headerText: string,
    layout: {
      startY: number;
      headerY: number;
      rowGap: number;
      entryStyle: Phaser.Types.GameObjects.Text.TextStyle;
      headerStyle: Phaser.Types.GameObjects.Text.TextStyle;
    },
  ): void {
    if (entries.length === 0) return;
    this.add.text(x, layout.headerY, headerText, layout.headerStyle).setOrigin(0.5);
    entries.forEach((entry, index) => {
      const row = this.add
        .text(x, layout.startY + index * layout.rowGap, entry.label, layout.entryStyle)
        .setOrigin(0.5);
      if (entry.enemyKey) row.setData('enemyKey', entry.enemyKey);
      if (entry.sceneKey) row.setData('sceneKey', entry.sceneKey);
      this.registerRow(row, entry.label, () => this.activateEntry(entry));
    });
  }

  // ── Activation & focus helpers ────────────────────────────────────

  /**
   * Activation shared by pointer and keyboard for an ENEMIES/Dev Utilities
   * row: scene rows boot their `sceneKey` directly (including the bare
   * `GymFodderEnemies` and `GymBoss` rows), config rows boot
   * `GymFodderEnemies` with `{ enemyKey }`.
   */
  private activateEntry(entry: EnemyColumnEntry): void {
    if (entry.sceneKey) this.scene.start(entry.sceneKey);
    else this.scene.start(FODDER_ENEMIES_SCENE_KEY, { enemyKey: entry.enemyKey });
  }

  /**
   * Wires a row for pointer (`pointerdown`) and keyboard (FocusManager)
   * activation through the same callback, and records its label so
   * {@link getFocusedLabel} can report the focused row in tests.
   */
  private registerRow(
    row: Phaser.GameObjects.Text,
    label: string,
    activate: () => void,
  ): void {
    row.setInteractive({ useHandCursor: true });
    row.on('pointerdown', activate);
    this.focusManager.register(row, activate);
    this.controls.push({ label, text: row });
  }

  // ── Public test accessors ─────────────────────────────────────────

  /** Discovered gym scenes (left column; excludes GymFodderEnemies, GymBoss and Dev Utilities). */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }

  /**
   * Middle ENEMIES column rows: the single reusable fodder-enemy row
   * (booted bare) followed by the dedicated `GymBoss` row.
   */
  get listedEnemyScenes(): EnemyColumnEntry[] {
    return this.enemyEntries.map((e) => ({ ...e }));
  }

  /**
   * Far-right Dev Utilities column rows: tooling scenes (e.g.
   * `GymCurveSequencer`), each booted directly via `sceneKey`.
   */
  get listedDevUtilityScenes(): EnemyColumnEntry[] {
    return this.devEntries.map((e) => ({ ...e }));
  }

  /** Index of the currently focused row in reading order (−1 when none). */
  getFocusedIndex(): number {
    return this.focusManager.getFocusedIndex();
  }

  /** Total number of focusable rows registered across all columns. */
  getFocusControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** Display label of the currently focused row ('' when none). */
  getFocusedLabel(): string {
    const index = this.focusManager.getFocusedIndex();
    return this.controls[index]?.label ?? '';
  }
}
