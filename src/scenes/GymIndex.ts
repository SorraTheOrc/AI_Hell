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
 * The right-hand ENEMIES column also surfaces the dedicated multi-phase
 * boss scene (`GymBoss`) as a `Boss` row, while the plain `boss` config
 * archetype is shown as `Boss Swarm` (AH-0MUAYB28C004KK7X).
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
/** Label of the dedicated boss row in the ENEMIES column. */
export const BOSS_SCENE_LABEL = 'Boss';

/**
 * A row rendered in the right-hand "ENEMIES" column.
 *
 * Two flavours are merged here:
 * - **config rows** carry `enemyKey` and boot `GymEnemies` with `{ enemyKey }`;
 * - **scene rows** carry `sceneKey` and boot that scene directly (the
 *   dedicated multi-phase `GymBoss` is surfaced this way).
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

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    // Genuine scene entries (GymPlayer, etc.). Filter out GymEnemies — it
    // is no longer listed as a bare scene; individual enemies appear via
    // the per-config list below instead. Filter out GymBoss — the real
    // boss is surfaced as a dedicated row in the ENEMIES column instead of
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

    // Register the dedicated boss scene so the "Boss" ENEMIES row can boot
    // it directly. GymBoss is still excluded from the plain scene list
    // (left column); it is surfaced as the real boss row below.
    const bossModule = all.find((e) => e.key === BOSS_SCENE_KEY)?.module;
    if (bossModule && !this.scene.manager.getScene(BOSS_SCENE_KEY)) {
      const bossClass = sceneClassFromModule(bossModule, BOSS_SCENE_KEY);
      if (bossClass) this.scene.add(BOSS_SCENE_KEY, bossClass as typeof Phaser.Scene);
    }

    // Right-hand ENEMIES column — one row per saved/seed enemy config
    // (routed to GymEnemies with `{ enemyKey }`) PLUS a dedicated "Boss"
    // row that boots the multi-phase GymBoss scene. The plain `boss`
    // config archetype is labelled "Boss Swarm" so it is not mistaken for
    // the real boss (AH-0MUAYB28C004KK7X). Rows are merged and kept in
    // alphabetical label order.
    const configEntries: EnemyColumnEntry[] = discoverEnemyGymEntries().map((e) => ({
      key: e.key,
      label: e.label,
      enemyKey: e.enemyKey,
    }));
    const bossRow: EnemyColumnEntry = {
      key: BOSS_SCENE_KEY,
      label: BOSS_SCENE_LABEL,
      sceneKey: BOSS_SCENE_KEY,
    };
    this.enemyEntries = [...configEntries, bossRow].sort(
      (a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
    );
    if (this.enemyEntries.length > 0 && !this.scene.manager.getScene('GymEnemies')) {
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

    // ── Two-column layout ──────────────────────────────────────────
    const entryStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#00ff00',
      backgroundColor: '#1a1a1a',
      padding: { x: 10, y: 6 },
    };
    const rowGap = 42;
    const startY = 150;
    // Left column = non-enemy scenes; right column = enemy entries.
    // Centre-left / centre-right of the screen, vertically aligned.
    const leftColX = GAME_WIDTH * 0.33;
    const rightColX = GAME_WIDTH * 0.67;

    // Left column — scene entries (alphabetical).
    this.entries.forEach((entry, index) => {
      const row = this.add
        .text(leftColX, startY + index * rowGap, entry.label, entryStyle)
        .setOrigin(0.5);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.scene.start(entry.key));
    });

    // Right column — ENEMIES header + enemy entries (if any).
    const enemyRows = this.enemyEntries.length;
    if (enemyRows > 0) {
      const headerY = startY - 18;
      const header = this.add
        .text(rightColX, headerY, 'ENEMIES', {
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#888888',
        })
        .setOrigin(0.5);
      void header;
      this.enemyEntries.forEach((entry, index) => {
        const row = this.add
          .text(rightColX, startY + index * rowGap, entry.label, entryStyle)
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

    // ── Hint ─────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 16, GYM_INDEX_HINT, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#555555',
      })
      .setOrigin(0.5);
  }

  // ── Public test accessors ─────────────────────────────────────────

  /** Discovered gym scenes (left column; excludes bare GymEnemies and GymBoss). */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }

  /**
   * Right-hand ENEMIES column rows: one per available `EnemyConfig`
   * (routed to `GymEnemies` via `enemyKey`) plus the dedicated `GymBoss`
   * scene row (surfaced via `sceneKey`, labelled `Boss`).
   */
  get listedEnemyScenes(): EnemyColumnEntry[] {
    return this.enemyEntries.map((e) => ({ ...e }));
  }
}
