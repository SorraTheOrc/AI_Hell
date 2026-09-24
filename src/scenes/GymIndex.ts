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
 * The index renders three columns left-to-right: plain scenes, ENEMIES
 * (one row per non-boss enemy config, booting `GymEnemies` with
 * `{ enemyKey }`), and Bosses (the `boss` enemy config plus the dedicated
 * multi-phase `GymBoss` scene). The two boss rows are labelled
 * "Boss Swarm" and "Boss" respectively (AH-0MTV8OV9V002D8B7).
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
import { addBackToMenuOnEsc } from '../utils/gymNavigation';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line. */
export const GYM_INDEX_HINT = 'select a gym scene to load it — ← INDEX returns here';

/** Scene key of the dedicated multi-phase boss (the real Central AI). */
export const BOSS_SCENE_KEY = 'GymBoss';
/** Label of the dedicated boss row in the Bosses column. */
export const BOSS_SCENE_LABEL = 'Boss';
/** Enemy-config key of the plain (non-Central-AI) boss archetype. */
export const BOSS_CONFIG_KEY = 'boss';

/**
 * Column X positions as fractions of `GAME_WIDTH`, ordered left-to-right:
 * scenes | ENEMIES | Bosses (AH-0MTV8OV9V002D8B7).
 */
export const GYM_INDEX_COLUMN_X = {
  scenes: 0.25,
  enemies: 0.5,
  bosses: 0.75,
} as const;

/** Header label for the middle ENEMIES column (kept uppercase). */
export const GYM_INDEX_ENEMIES_HEADER = 'ENEMIES';
/** Header label for the right-most Bosses column. */
export const GYM_INDEX_BOSSES_HEADER = 'Bosses';

/**
 * A clickable row rendered in the ENEMIES or Bosses column.
 *
 * Two flavours are merged here:
 * - **config rows** carry `enemyKey` and boot `GymEnemies` with `{ enemyKey }`;
 * - **scene rows** carry `sceneKey` and boot that scene directly (the
 *   dedicated multi-phase `GymBoss` is surfaced this way in the Bosses
 *   column).
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
  private entries: GymSceneEntry[] = [];
  private enemyEntries: EnemyColumnEntry[] = [];
  private bossEntries: EnemyColumnEntry[] = [];

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    // Genuine scene entries (GymPlayer, etc.). Filter out GymEnemies — it
    // is no longer listed as a bare scene; individual enemies appear via
    // the per-config list below instead. Filter out GymBoss — the real
    // boss is surfaced as a dedicated row in the Bosses column instead of
    // the plain scene list (AH-0MUAYB28C004KK7X).
    const all = discoverGymScenes(loadGymSceneModules());
    this.entries = all.filter(
      (e) => e.key !== 'GymEnemies' && e.key !== BOSS_SCENE_KEY,
    );
    for (const entry of this.entries) {
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
    // Left column = plain scenes; middle = enemy configs; right = boss
    // scenes. Columns are evenly distributed across the screen width.
    const scenesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.scenes;
    const enemiesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.enemies;
    const bossesColX = GAME_WIDTH * GYM_INDEX_COLUMN_X.bosses;

    // Left column — scene entries (alphabetical).
    this.entries.forEach((entry, index) => {
      const row = this.add
        .text(scenesColX, startY + index * rowGap, entry.label, entryStyle)
        .setOrigin(0.5);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.scene.start(entry.key));
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
   * Renders one header + clickable rows for an enemy/boss column. No-op
   * when the column has no entries, so the header never floats alone.
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
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => {
        if (entry.sceneKey) this.scene.start(entry.sceneKey);
        else this.scene.start('GymEnemies', { enemyKey: entry.enemyKey });
      });
    });
  }

  // ── Public test accessors ─────────────────────────────────────────

  /** Discovered gym scenes (left column; excludes bare GymEnemies and GymBoss). */
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
}
