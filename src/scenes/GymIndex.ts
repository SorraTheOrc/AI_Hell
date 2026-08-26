/**
 * Gym index — dev-mode entry scene (AC2/AC3/AC4).
 *
 * Booted first by `gameConfig.ts` (sole registered scene). It discovers
 * every gym scene under `src/scenes/gym/` via Vite's `import.meta.glob`
 * (see `src/utils/gymDiscovery.ts`), registers those scenes so they can be
 * started, and lists them alphabetically as clickable entries. Selecting an
 * entry switches straight into that scene; each gym scene offers a shared
 * "← INDEX" button (AC5) to jump back here.
 *
 * The index lives outside the glob folder (`src/scenes/GymIndex.ts`) so it
 * is never listed as one of its own entries.
 *
 * Aesthetic: neon-vector, dark background, monospace UI text consistent
 * with the gym HUD buttons (GDD §7.1 / §2.3, `GymScout.ts` label style).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  discoverGymScenes,
  GymSceneEntry,
  loadGymSceneModules,
  sceneClassFromModule,
} from '../utils/gymDiscovery';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line. */
export const GYM_INDEX_HINT = 'select a gym scene to load it — ← INDEX returns here';

export class GymIndex extends Phaser.Scene {
  private entries: GymSceneEntry[] = [];

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // Discover + register every gym scene (no hard-coded list, AC3).
    this.entries = discoverGymScenes(loadGymSceneModules());
    for (const entry of this.entries) {
      // Only add scenes the manager does not know about yet; re-entry
      // (e.g. returning from a gym scene) must not register duplicates.
      if (!this.scene.manager.getScene(entry.key)) {
        const sceneClass = sceneClassFromModule(entry.module, entry.key);
        if (sceneClass) {
          this.scene.add(entry.key, sceneClass as typeof Phaser.Scene);
        }
      }
    }

    // ── Title ────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, 90, GYM_INDEX_TITLE, {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: '#00ffff',
      })
      .setOrigin(0.5);

    // ── Scene entries (alphabetical, clickable) ──────────────────────
    const entryStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#00ff00',
      backgroundColor: '#1a1a1a',
      padding: { x: 10, y: 6 },
    };

    const startY = 150;
    const rowGap = 42;
    this.entries.forEach((entry, index) => {
      const row = this.add
        .text(GAME_WIDTH / 2, startY + index * rowGap, entry.label, entryStyle)
        .setOrigin(0.5);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.scene.start(entry.key));
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

  // ── Public test accessors ─────────────────────────────────────────

  /** Discovered gym scenes ({ key, label }), sorted alphabetically by label. */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }
}