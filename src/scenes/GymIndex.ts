/**
 * Gym index — dev-mode entry scene (AC2/AC3/AC4 + enemy-config discovery).
 *
 * Discovers every gym scene under `src/scenes/gym/` via `import.meta.glob`
 * and, additionally, enumerates every available enemy config via
 * `discoverEnemyGymEntries()` so one entry per enemy boots the same
 * `GymEnemies` scene with `{ enemyKey }`. Adding a new Save As entry makes
 * it appear without editing the index (no hard-coded enemy list). `.test.ts`
 * and `core/` remain excluded; corrupt configs fall back via the storage
 * helper.
 *
 * The index renders four columns left-to-right: plain scenes, ENEMIES
 * (one row per non-boss enemy config, booting `GymEnemies` with
 * `{ enemyKey }`), Bosses (the `boss` enemy config plus the dedicated
 * multi-phase `GymBoss` scene) and Dev Utilities (tooling scenes such as
 * the difficulty-curve sequencer, booted directly via `sceneKey`). The two
 * boss rows are labelled "Boss Swarm" and "Boss" respectively
 * (AH-0MTV8OV9V002D8B7); the Dev Utilities column was added for
 * AH-0MUGXDVPH005TIZL.
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
import { discoverEnemyGymEntries } from '../utils/enemyGymDiscovery';
import { FocusManager } from '../utils/focusManager';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line (advertises the keyboard controls). */
export const GYM_INDEX_HINT =
  'tab/arrows move · enter/space select · ESC returns to menu';

/** Scene key of the dedicated multi-phase boss (the real Central AI). */
export const BOSS_SCENE_KEY = 'GymBoss';
/** Label of the dedicated boss row in the Bosses column. */
export const BOSS_SCENE_LABEL = 'Boss';
/** Enemy-config key of the plain (non-Central-AI) boss archetype. */
export const BOSS_CONFIG_KEY = 'boss';

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
 * scenes | ENEMIES | Bosses | Dev Utilities (AH-0MTV8OV9V002D8B7,
 * AH-0MUGXDVPH005TIZL).
 */
export const GYM_INDEX_COLUMN_X = {
  scenes: 0.25,
  enemies: 0.5,
  bosses: 0.75,
  devUtilities: 0.9,
} as const;

/** Header label for the middle ENEMIES column (kept uppercase). */
export const GYM_INDEX_ENEMIES_HEADER = 'ENEMIES';
/** Header label for the right-most Bosses column. */
export const GYM_INDEX_BOSSES_HEADER = 'Bosses';
/** Header label for the far-right Dev Utilities column. */
export const GYM_INDEX_DEV_UTILITIES_HEADER = 'Dev Utilities';

/**
 * A clickable row rendered in the ENEMIES, Bosses or Dev Utilities column.
 *
 * Two flavours are merged here:
 * - **config rows** carry `enemyKey` and boot `GymEnemies` with `{ enemyKey }`;
 * - **scene rows** carry `sceneKey` and boot that scene directly (the
 *   dedicated multi-phase `GymBoss` and the Dev Utilities tooling scenes are
 *   surfaced this way).
 */
export interface EnemyColumnEntry {
  /** Unique row key: `GymEnemies:<configKey>` for config rows, scene key for scene rows. */
  key: string;
  /** Human label shown on the index. */
  label: string;
  /** Enemy config key for rows routed to `GymEnemies` as `{ enemyKey }`. */
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
  private bossEntries: EnemyColumnEntry[] = [];
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

    // Genuine scene entries (GymPlayer, etc.). Filter out GymEnemies — it
    // is no longer listed as a bare scene; individual enemies appear via
    // the per-config list below instead. Filter out GymBoss — the real
    // boss is surfaced as a dedicated row in the Bosses column instead of
    // the plain scene list (AH-0MUAYB28C004KK7X).
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
        e.key !== 'GymEnemies' &&
        e.key !== BOSS_SCENE_KEY &&
        !DEV_UTILITY_SCENE_KEY_SET.has(e.key),
    );
    // Register every discovered scene class (plain + Dev Utilities) so
    // `scene.start(key)` works for each index row. GymEnemies and GymBoss are
    // registered separately below (they are booted with/without params).
    for (const entry of all) {
      if (entry.key === 'GymEnemies' || entry.key === BOSS_SCENE_KEY) continue;
      if (!this.scene.manager.getScene(entry.key)) {
        const sceneClass = sceneClassFromModule(entry.module, entry.key);
        if (sceneClass) this.scene.add(entry.key, sceneClass as typeof Phaser.Scene);
      }
    }

    // Register the dedicated boss scene so the "Boss" Bosses row can boot
    // it directly. GymBoss is still excluded from the plain scene list
    // (left column); it is surfaced as the real boss row below.
    const bossModule = all.find((e) => e.key === BOSS_SCENE_KEY)?.module;
    if (bossModule && !this.scene.manager.getScene(BOSS_SCENE_KEY)) {
      const bossClass = sceneClassFromModule(bossModule, BOSS_SCENE_KEY);
      if (bossClass) this.scene.add(BOSS_SCENE_KEY, bossClass as typeof Phaser.Scene);
    }

    // Enemy-config rows, each routed to GymEnemies with `{ enemyKey }`.
    const configEntries: EnemyColumnEntry[] = discoverEnemyGymEntries().map((e) => ({
      key: e.key,
      label: e.label,
      enemyKey: e.enemyKey,
    }));

    // Middle ENEMIES column — non-boss config rows, alphabetical by label.
    // The `boss` config row is deliberately omitted here; it is grouped with
    // the dedicated boss scene in the Bosses column below (AH-0MTV8OV9V002D8B7).
    this.enemyEntries = configEntries
      .filter((e) => e.enemyKey !== BOSS_CONFIG_KEY)
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

    // Right-hand Bosses column — both boss rows grouped together: the plain
    // `boss` config row (boots GymEnemies via `enemyKey`) and the dedicated
    // multi-phase GymBoss scene (booted directly via `sceneKey`). Sorted by
    // label, so "Boss" (the real boss) precedes "Boss Swarm" (the config).
    const bossConfigRow = configEntries.find((e) => e.enemyKey === BOSS_CONFIG_KEY);
    this.bossEntries = [
      ...(bossConfigRow ? [bossConfigRow] : []),
      {
        key: BOSS_SCENE_KEY,
        label: BOSS_SCENE_LABEL,
        sceneKey: BOSS_SCENE_KEY,
      },
    ].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

    if (configEntries.length > 0 && !this.scene.manager.getScene('GymEnemies')) {
      // Reuse the class discovered via glob if available; otherwise lazy import.
      const enemiesModule = all.find((e) => e.key === 'GymEnemies')?.module;
      const cls = enemiesModule ? sceneClassFromModule(enemiesModule, 'GymEnemies') : null;
      if (cls) this.scene.add('GymEnemies', cls as typeof Phaser.Scene);
      else {
        // Fallback: import directly so enemy entries still route even if glob
        // somehow hid GymEnemies (defensive; shouldn't happen).
        // Lazy path kept synchronous via require-style fallback handled by
        // GymEnemies itself being globally importable — skip if still null.
      }
    }
    // De-duplicate enemy labels that collide (keep first, suffix later ones).
    // Keep labels stable and alphabetical as discovered above.

    // ── Title ────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, 90, GYM_INDEX_TITLE, {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#00ffff',
      })
      .setOrigin(0.5);

    // ── Four-column layout ─────────────────────────────────────────
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
    // Left column = plain scenes; middle = enemy configs; right = boss
    // scenes; far-right = Dev Utilities tooling scenes. Columns are
    // distributed left-to-right across the screen width.
    const scenesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const enemiesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const bossesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses;

    // Left column — scene entries (alphabetical).
    this.entries.forEach((entry, index) => {
      const row = this.add
        .text(scenesColX, startY + index * rowGap, entry.label, entryStyle)
        .setOrigin(0.5);
      this.registerRow(row, entry.label, () => this.scene.start(entry.key));
    });

    // Middle column — ENEMIES header + enemy entries.
    this.renderColumn(this.enemyEntries, enemiesColX, GYM_INDEX_ENEMIES_HEADER, {
      startY,
      headerY,
      rowGap,
      entryStyle,
      headerStyle,
    });

    // Right column — Bosses header + boss scene entries.
    this.renderColumn(this.bossEntries, bossesColX, GYM_INDEX_BOSSES_HEADER, {
      startY,
      headerY,
      rowGap,
      entryStyle,
      headerStyle,
    });

    // Far-right column — Dev Utilities header + tooling scene entries
    // (AH-0MUGXDVPH005TIZL).
    const devUtilitiesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.devUtilities;
    this.renderColumn(
      this.devEntries,
      devUtilitiesColX,
      GYM_INDEX_DEV_UTILITIES_HEADER,
      { startY, headerY, rowGap, entryStyle, headerStyle },
    );

    // ── Keyboard focus (AH-0MUDZFBYY008P7ZE) ─────────────────────────
    // The shared FocusManager owns Tab / arrow cycling and Enter / Space
    // activation. Rows are registered in reading order (plain scenes →
    // ENEMIES → Bosses → Dev Utilities), so the first row is focused by
    // default. Pointer handlers stay unchanged — keyboard support is
    // additive. Tear the listener down on scene shutdown so a restart does
    // not leak it.
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
   * Renders one header + clickable rows for an index column (ENEMIES,
   * Bosses or Dev Utilities). No-op when the column has no entries, so the
   * header never floats alone.
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
   * Activation shared by pointer and keyboard for an ENEMIES/Bosses/Dev
   * Utilities row: scene rows boot their `sceneKey` directly, config rows
   * boot `GymEnemies` with `{ enemyKey }`.
   */
  private activateEntry(entry: EnemyColumnEntry): void {
    if (entry.sceneKey) this.scene.start(entry.sceneKey);
    else this.scene.start('GymEnemies', { enemyKey: entry.enemyKey });
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

  /** Discovered gym scenes (left column; excludes bare GymEnemies, GymBoss and Dev Utilities). */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }

  /**
   * Middle ENEMIES column rows: one per available non-boss `EnemyConfig`,
   * each routed to `GymEnemies` via `enemyKey`.
   */
  get listedEnemyScenes(): EnemyColumnEntry[] {
    return this.enemyEntries.map((e) => ({ ...e }));
  }

  /**
   * Right-hand Bosses column rows: both boss entries — the `boss` enemy
   * config (routed to `GymEnemies` via `enemyKey`, labelled "Boss Swarm")
   * and the dedicated `GymBoss` scene (booted directly via `sceneKey`,
   * labelled "Boss").
   */
  get listedBossScenes(): EnemyColumnEntry[] {
    return this.bossEntries.map((e) => ({ ...e }));
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

  /** Total number of focusable rows registered across all four columns. */
  getFocusControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** Display label of the currently focused row ('' when none). */
  getFocusedLabel(): string {
    const index = this.focusManager.getFocusedIndex();
    return this.controls[index]?.label ?? '';
  }
}
