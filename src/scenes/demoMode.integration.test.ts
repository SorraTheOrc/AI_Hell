/**
 * Cross-module integration and regression tests for the shipped
 * attract/demo mode (AH-0MUX496TY005FF3P).
 *
 * The individual pieces are unit-tested elsewhere:
 * - `src/ai/botSnapshot.test.ts` — the snapshot builder mapping/freeze,
 * - `src/ai/botDecision.test.ts` — every decision branch in isolation,
 * - `src/scenes/MenuScene.test.ts` — the demo control + idle timer,
 * - `src/scenes/PlayScene.test.ts` — the demo flag + lifecycle.
 *
 * This suite exercises the **seams between them**:
 * - AC1/AC3 — `MenuScene.startDemo()` → live `PlayScene` demo → back to the
 *   menu on death, with no leaderboard/session write.
 * - AC1 — the bot drives the ship through the live shared input path.
 * - AC2 — normal play is unaffected while demo mode is off.
 * - AC4/AC5 — the snapshot builder feeds the decision function end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import * as leaderboardModule from '../core/Leaderboard';
import { DEFAULT_CONFIG } from '../core/config';
import { seedConfigStore } from '../core/configStore';
import {
  buildBotSnapshot,
  type BotSnapshotScene,
} from '../ai/botSnapshot';
import {
  decideBotInput,
} from '../ai/botDecision';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { LeaderboardScene } from './LeaderboardScene';
import { GymIndex } from './GymIndex';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The shipped default control scheme is `asteroids`; keyboard-movement
// assertions need the four-directional scheme the rest of the PlayScene suite
// seeds (AH-0MUBZU8IL0067GOU).
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

/** Narrows a live scene's private cursors for keyboard-input simulation. */
function cursorsOf(scene: PlayScene): Record<'up' | 'down' | 'left' | 'right', { isDown: boolean }> {
  return (scene as unknown as {
    cursors: Record<'up' | 'down' | 'left' | 'right', { isDown: boolean }>;
  }).cursors;
}

/** Invokes the protected hit hook so a test can end a run deterministically. */
function killPlayer(scene: PlayScene): void {
  (scene as unknown as { onPlayerHit(): void }).onPlayerHit();
}

/** Invokes the protected bot seam to inspect the live decision. */
function botInputOf(scene: PlayScene) {
  return (
    scene as unknown as {
      getBotInput(): { up: boolean; down: boolean; left: boolean; right: boolean } | null;
    }
  ).getBotInput();
}

describe('Demo mode integration (AH-0MUX496TY005FF3P)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene(
      [MenuScene, PlayScene, GameOverScene, LeaderboardScene, GymIndex],
      { deterministicBoot: true },
    );
    return booted.scene as MenuScene;
  }

  it('AC1/AC3 — the menu starts the demo and a demo death returns to the menu without scoring', async () => {
    const addEntrySpy = vi.spyOn(leaderboardModule, 'addEntry');
    const menu = await bootMenu();

    menu.startDemo();
    await wait(150);

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // End the run — on the final life the hit finishes the demo.
    play.getGameState().lives = 1;
    killPlayer(play);
    await wait(250);

    // AC1 — the demo returns to the menu, never the score-entry scene.
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(false);
    // AC3 — a demo run is non-scoring: no leaderboard or session write.
    expect(addEntrySpy).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(leaderboardModule.LEADERBOARD_STORAGE_KEY),
    ).toBeNull();
  });

  it('AC1 — the demo bot drives the ship through the live shared input path', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);
    // The demo seam is live and produces a real four-directional decision.
    expect(botInputOf(play)).not.toBeNull();

    // Tick the live scene with no keyboard input: the bot must move the ship
    // (from spawn it engages the wave-1 formation / seeks pickups).
    const player = play.getPlayer()!;
    const beforeY = player.y;
    for (let i = 0; i < 60; i += 1) play.tick(1 / 60);

    expect(player.y).toBeLessThan(beforeY);
  });

  it('AC2 — normal play is unaffected: the keyboard drives and the bot seam stays off', async () => {
    const menu = await bootMenu();
    // Enter activates the focused Play Game control (normal run).
    menu.input.keyboard!.emit('keydown', {
      key: 'Enter',
      repeat: false,
      preventDefault: () => {},
    } as KeyboardEvent);
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(false);
    expect(botInputOf(play)).toBeNull();

    // The keyboard path still moves the ship exactly as before.
    const player = play.getPlayer()!;
    const cursors = cursorsOf(play);
    const beforeX = player.x;
    cursors.right.isDown = true;
    for (let i = 0; i < 20; i += 1) play.tick(1 / 60);
    cursors.right.isDown = false;

    expect(player.x).toBeGreaterThan(beforeX);
  });

  it('AC2 — a normal restart after a demo resets the demo flag (no leak)', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // Restart PlayScene normally (no demo data) — init must clear the flag.
    play.scene.restart({});
    await wait(150);
    const restarted = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(restarted.isDemoMode()).toBe(false);
  });
});

// ── Snapshot builder → decision integration (AC4/AC5) ────────────────

/** Builds a structural scene stub with inert defaults. */
function makeScene(
  overrides: Partial<BotSnapshotScene> = {},
): BotSnapshotScene {
  return {
    getPlayer: () => null,
    getBoss: () => null,
    getBossPhase: () => 0,
    getEnemies: () => [],
    getEnemyBullets: () => [],
    getPlayerBullets: () => [],
    getDrops: () => [],
    getMinerals: () => [],
    getAliveCount: () => 0,
    ...overrides,
  };
}

/** A player source at `(x, y)` with zero velocity. */
function stillPlayer(x: number, y: number) {
  return {
    x,
    y,
    getMovementState: () => ({ x, y, vx: 0, vy: 0 }),
  };
}

describe('snapshot builder → decision integration (AC4/AC5)', () => {
  it('AC4 — a short-range power-up outranks a distant enemy', () => {
    const snapshot = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 500),
        // 450 px above — outside the 300 px engagement radius.
        getEnemies: () => [{ x: 400, y: 50, alive: true, archetype: 'scout' }],
        // 200 px above — in power-up range.
        getDrops: () => [{ x: 400, y: 300, dropId: 'spread' }],
        getAliveCount: () => 1,
      }),
    );

    expect(decideBotInput(snapshot).up).toBe(true);
  });

  it('AC4 — a live enemy inside the engagement radius is engaged', () => {
    const snapshot = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [{ x: 200, y: 300, alive: true, archetype: 'tank' }],
        getAliveCount: () => 1,
      }),
    );

    expect(decideBotInput(snapshot).left).toBe(true);
  });

  it('AC4 — a mineral is collected as a second-priority pickup', () => {
    const snapshot = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [{ x: 1000, y: 300, alive: true, archetype: 'scout' }],
        getMinerals: () => [{ x: 350, y: 300 }],
        getAliveCount: () => 1,
      }),
    );

    expect(decideBotInput(snapshot).left).toBe(true);
  });

  it('AC5 — a fire tell flows through the builder and the bot refuses the shot line', () => {
    // A telling enemy 200 px above would normally be engaged by steering up;
    // the tell makes the bot refuse that direction instead.
    const telling = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [
          { x: 400, y: 100, alive: true, archetype: 'scout', isTelling: true },
        ],
        getAliveCount: () => 1,
      }),
    );
    expect(decideBotInput(telling).up).toBe(false);

    // Without the tell the same snapshot engages the enemy.
    const quiet = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [
          { x: 400, y: 100, alive: true, archetype: 'scout' },
        ],
        getAliveCount: () => 1,
      }),
    );
    expect(decideBotInput(quiet).up).toBe(true);
  });
});
