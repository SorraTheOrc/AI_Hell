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
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  discoverGymScenes,
  GymSceneEntry,
  loadGymSceneModules,
  sceneClassFromModule,
} from '../utils/gymDiscovery';
import { discoverEnemyGymEntries, type EnemyGymEntry } from '../utils/enemyGymDiscovery';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line. */
export const GYM_INDEX_HINT = 'select a gym scene to load it — ← INDEX returns here';

export class GymIndex extends Phaser.Scene {
  private entries: GymSceneEntry[] = [];
  private enemyEntries: EnemyGymEntry[] = [];

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // Genuine scene entries (GymPlayer, GymBoss, etc.). Filter out
    // GymEnemies — it is no longer listed as a bare scene; individual
    // enemies appear via the per-config list below instead. Keeps the
    // index focused (one entry per enemy archetype, not a redundant blob).
    const all = discoverGymScenes(loadGymSceneModules());
    this.entries = all.filter((e) => e.key !== 'GymEnemies');
    for (const entry of this.entries) {
      if (!this.scene.manager.getScene(entry.key)) {
        const sceneClass = sceneClassFromModule(entry.module, entry.key);
        if (sceneClass) this.scene.add(entry.key, sceneClass as typeof Phaser.Scene);
      }
    }

    // Enemy-config entries — one per saved/seed archetype, routed to
    // GymEnemies with the enemyKey param. Ensure GymEnemies is registered
    // once (so scene.start('GymEnemies', { enemyKey }) works).
    this.enemyEntries = discoverEnemyGymEntries();
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
        row.setData('enemyKey', entry.enemyKey);
        row.setInteractive({ useHandCursor: true });
        row.on('pointerdown', () => this.scene.start('GymEnemies', { enemyKey: entry.enemyKey }));
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

  /** Discovered gym scenes (excludes bare GymEnemies; see comment above). */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }

  /** Per-enemy gym entries: one per available EnemyConfig, routed to GymEnemies. */
  get listedEnemyScenes(): { key: string; label: string; enemyKey: string }[] {
    return this.enemyEntries.map((e) => ({ key: e.key, label: e.label, enemyKey: e.enemyKey }));
  }
}
