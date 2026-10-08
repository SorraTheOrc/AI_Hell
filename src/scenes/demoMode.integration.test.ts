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
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import * as leaderboardModule from '../core/Leaderboard';
import { DEFAULT_CONFIG } from '../core/config';
import { seedConfigStore } from '../core/configStore';
import {
  buildBotSnapshot,
  type BotSnapshotScene,
} from '../ai/botSnapshot';
import type { ControlInput } from '../utils/movementModel';
import {
  decideBotInput,
} from '../ai/botDecision';
import { BOT_MINERAL_CHOICE_DELAY_MS } from '../ai/botHumanLike';
import type { BotInputGovernor } from '../ai/botHumanLike';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { LeaderboardScene } from './LeaderboardScene';
import { MineralChoiceScene } from './MineralChoiceScene';
import { GymIndex } from './GymIndex';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Short demo game-over dwell driven through `MenuScene.startDemo(...)` so the
 * integration tests observe the demo hold + auto-return without waiting the
 * 5 s production dwell (AH-0MUXZ4CAE008QRFZ).
 */
const TEST_DWELL_MS = 800;

/**
 * Extra wall-clock margin on top of the demo dwell so the queued
 * `scene.start('MenuScene')` has certainly run before asserting (the create
 * frame and scene transition add a few frames on top of the timer).
 */
const DWELL_MARGIN_MS = 500;

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

/** Invokes the protected bot seam to inspect the live scheme input. */
function botInputOf(scene: PlayScene): ControlInput | null {
  return (
    scene as unknown as {
      getBotInput(): ControlInput | null;
    }
  ).getBotInput();
}

/** Finds an on-screen text control by label. */
function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  return found!;
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
      [
        MenuScene,
        PlayScene,
        GameOverScene,
        LeaderboardScene,
        MineralChoiceScene,
        GymIndex,
      ],
      { deterministicBoot: true },
    );
    return booted.scene as MenuScene;
  }

  it('AC1/AC3 — the menu starts the demo and a demo death dwells then returns to the menu without scoring', async () => {
    const addEntrySpy = vi.spyOn(leaderboardModule, 'addEntry');
    const menu = await bootMenu();

    menu.startDemo(TEST_DWELL_MS);
    await wait(150);

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // End the run — on the final life the hit finishes the demo. The demo
    // holds on the outcome screen for the demo dwell (AH-0MUXZ4CAE008QRFZ),
    // so shortly after the death it is NOT yet back at the menu.
    play.getGameState().lives = 1;
    killPlayer(play);
    await wait(250);

    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
    const over = booted!.game.scene.getScene('GameOverScene') as GameOverScene;
    expect(over.isDemoMode()).toBe(true);
    // AC3 — the demo outcome screen is non-scoring: no leaderboard or
    // session write, even though the screen is shown.
    expect(addEntrySpy).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(leaderboardModule.LEADERBOARD_STORAGE_KEY),
    ).toBeNull();

    // AC1 — after the dwell the demo loops back to the menu, never the
    // interactive score-entry flow.
    await wait(TEST_DWELL_MS + DWELL_MARGIN_MS);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(false);
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
    // (it engages the wave-1 formation / seeks pickups).  The exact direction
    // depends on the run-seeded field, so assert real movement rather than a
    // specific heading.
    const player = play.getPlayer()!;
    const beforeX = player.x;
    const beforeY = player.y;
    let maxDisplacement = 0;
    for (let i = 0; i < 60; i += 1) {
      play.tick(1 / 60);
      maxDisplacement = Math.max(
        maxDisplacement,
        Math.hypot(player.x - beforeX, player.y - beforeY),
      );
    }

    expect(maxDisplacement).toBeGreaterThan(5);
  });

  it('AC14 — the live scene exposes its wave timer state to the bot snapshot', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    const state = play.getWaveState();
    expect(typeof state.active).toBe('boolean');
    expect(state.timeLimit).toBeGreaterThan(0);
    // The wave state flows verbatim through the snapshot builder.
    expect(buildBotSnapshot(play).wave).toEqual(state);
  });

  it('AC1/AC3 — the committed steering is held at a human cadence, not every tick', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // Reset the governor cadence, then tick a window shorter than the
    // reaction time: the committed *steering decision* (chosen target bearing)
    // must be held, not flip-flopped every frame (AH-0MUXXQ1MN002RXGB).  The
    // resolved scheme input may still vary every tick — the closed-loop turn
    // tracks the held bearing and the forward-model throttle is a fast
    // braking reflex (AC10) — so we assert the committed intent here.
    play.setDemoMode(true);
    const governor = (play as unknown as { botGovernor: BotInputGovernor })
      .botGovernor;
    const steering = (): unknown => {
      const { thrust: _thrust, ...held } = governor.currentIntent();
      return held;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      play.tick(1 / 60);
      seen.add(JSON.stringify(steering()));
    }
    expect(seen.size).toBe(1);
  });

  it('AC4 — the demo bot resolves the hold-full choice instead of stalling', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // Open the hold-full choice exactly as a filled hold would.
    const offered = play.openMineralChoice();
    expect(offered).toHaveLength(3);
    expect(play.isMineralChoiceOpen()).toBe(true);

    // The launch is queued; give Phaser a step to activate the overlay.
    await wait(80);
    expect(booted!.game.scene.isActive('MineralChoiceScene')).toBe(true);

    // The overlay auto-selects after the human-like delay, applies the choice
    // and resumes play — the run never stalls.
    await wait(BOT_MINERAL_CHOICE_DELAY_MS + 400);

    expect(play.isMineralChoiceOpen()).toBe(false);
    expect(booted!.game.scene.isActive('MineralChoiceScene')).toBe(false);
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

  // ── Narrowed demo take-over (AH-0MUYP6M6W006Z1AY) ──────────────

  it('AC1 — ESC during the demo returns to the live MenuScene, not pause', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    play.input.keyboard!.emit('keydown', {
      key: 'Escape',
      repeat: false,
      preventDefault: () => {},
    } as KeyboardEvent);
    await wait(150);

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
    expect(play.isPaused()).toBe(false);
  });

  it('AC2 — a movement key takes over the live demo in place', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    play.input.keyboard!.emit('keydown', {
      key: 'ArrowLeft',
      repeat: false,
      preventDefault: () => {},
    } as KeyboardEvent);

    // Control handed to the keyboard mid-run: the bot seam is off and the
    // ship now moves under the player's keys.
    expect(play.isDemoMode()).toBe(false);
    expect(botInputOf(play)).toBeNull();
    const player = play.getPlayer()!;
    const cursors = cursorsOf(play);
    const beforeX = player.x;
    cursors.right.isDown = true;
    for (let i = 0; i < 20; i += 1) play.tick(1 / 60);
    cursors.right.isDown = false;
    expect(player.x).toBeGreaterThan(beforeX);
  });

  it('AC3 — other input during the demo is a no-op', async () => {
    const menu = await bootMenu();
    menu.startDemo();
    await wait(150);

    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    for (const key of [' ', 'Enter', 'Tab']) {
      play.input.keyboard!.emit('keydown', {
        key,
        repeat: false,
        preventDefault: () => {},
      } as KeyboardEvent);
    }
    play.input.emit('pointerdown', { x: 100, y: 100 });

    // Unattended: the bot is still in control.
    expect(play.isDemoMode()).toBe(true);
    expect(botInputOf(play)).not.toBeNull();
  });

  // ── Stale scene-start data leak (AH-0MUY4881P007FJ8R) ──────────
  //
  // Phaser's `Systems.start(data)` only writes `settings.data` for a
  // *truthy* `data`, and `bootScene` then calls `init(settings.data)`. A
  // no-argument normal start after a demo therefore inherits the stale
  // `{ demo: true }` payload and re-enables the bot. These tests drive the
  // real menu entry points to prove the explicit non-demo payload clears it.

  it('AC1/AC5 — Watch Demo then Play Game (pointer) hands control back to the keyboard', async () => {
    const menu = await bootMenu();

    // 1. Watch Demo — `{ demo: true }` is written to the reused PlayScene.
    menu.startDemo(TEST_DWELL_MS);
    await wait(150);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);
    expect(botInputOf(play)).not.toBeNull();

    // 2. End the demo on the final life: PlayScene shuts down (Phaser keeps
    //    its settings.data), the demo dwells on the outcome screen, then the
    //    menu becomes active again (AH-0MUXZ4CAE008QRFZ).
    play.getGameState().lives = 1;
    killPlayer(play);
    await wait(TEST_DWELL_MS + DWELL_MARGIN_MS);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);

    // 3. Normal Play Game via the pointer handler.
    findText(booted!.scene, '▶  Play Game').emit('pointerdown');
    await wait(150);

    const fresh = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(fresh.isDemoMode()).toBe(false);
    expect(botInputOf(fresh)).toBeNull();

    // The keyboard — not the bot — now drives the ship.
    const player = fresh.getPlayer()!;
    const cursors = cursorsOf(fresh);
    const beforeX = player.x;
    cursors.right.isDown = true;
    fresh.tick(0);
    for (let i = 0; i < 20; i += 1) fresh.tick(1 / 60);
    cursors.right.isDown = false;
    expect(player.x).toBeGreaterThan(beforeX);
  });

  it('AC1/AC5 — Watch Demo then Play Game (keyboard) does not re-enter demo mode', async () => {
    const menu = await bootMenu();

    menu.startDemo(TEST_DWELL_MS);
    await wait(150);
    const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(play.isDemoMode()).toBe(true);

    // End the demo (after its dwell), returning to the menu (PlayScene's
    // settings.data is kept).
    play.getGameState().lives = 1;
    killPlayer(play);
    await wait(TEST_DWELL_MS + DWELL_MARGIN_MS);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);

    // Activate the focused Play Game control (the FocusManager entry point).
    (booted!.scene as MenuScene).input.keyboard!.emit('keydown', {
      key: 'Enter',
      repeat: false,
      preventDefault: () => {},
    } as KeyboardEvent);
    await wait(150);

    const fresh = booted!.game.scene.getScene('PlayScene') as PlayScene;
    expect(fresh.isDemoMode()).toBe(false);
    expect(botInputOf(fresh)).toBeNull();
  });

  // ── Asteroid scheme (producer review AH-0MUX2NENC008AHOQ) ──────────
  // The demo must drive the ship's own control scheme — the shipped
  // default is `asteroids` (W = forward thrust, A/D = turn) — not a forced
  // four-directional impostor. These tests seed the asteroid scheme and
  // assert the live demo ship keeps it and receives asteroid input.

  describe('Asteroids scheme — demo drives the shipped controls', () => {
    beforeEach(() => {
      seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'asteroids' });
    });

    it('keeps the ship on its configured asteroid scheme', async () => {
      const menu = await bootMenu();
      menu.startDemo();
      await wait(150);

      const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
      expect(play.isDemoMode()).toBe(true);
      expect(play.getPlayer()!.getScheme()).toBe('asteroids');
    });

    it('emits asteroid input (W/A/D) — never a reverse/S key', async () => {
      const menu = await bootMenu();
      menu.startDemo();
      await wait(150);

      const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
      const input = botInputOf(play);
      expect(input).not.toBeNull();
      // The asteroid input shape is exactly W/A/D — no four-directional and
      // therefore no down/S field at all.
      expect(Object.keys(input!).sort()).toEqual([
        'forward',
        'turnLeft',
        'turnRight',
      ]);
      expect('down' in input!).toBe(false);
      expect('up' in input!).toBe(false);
    });

    it('rotates the hull under asteroid controls (a four-directional ship never turns)', async () => {
      const menu = await bootMenu();
      menu.startDemo();
      await wait(150);

      const play = booted!.game.scene.getScene('PlayScene') as PlayScene;
      const player = play.getPlayer()!;
      // Clean start: zero the facing so any rotation is the asteroid model
      // turning the hull toward the bot's steering intent.
      player.respawn(player.x, player.y);
      expect(player.getMovementState().facing ?? 0).toBe(0);

      for (let i = 0; i < 60; i += 1) play.tick(1 / 60);

      // Wave-1 enemies sit above the spawn, so the bot's intent points away
      // from the spawn facing and the ship turns.
      expect(player.getMovementState().facing ?? 0).not.toBe(0);
    });
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
    getWaveState: () => ({ active: false, timeRemaining: 0, timeLimit: 30 }),
    getRunSeed: () => 0,
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

  it('AC11 — a mineral cluster diverts the bot through the snapshot builder', () => {
    const snapshot = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [{ x: 200, y: 300, alive: true, archetype: 'scout' }],
        getMinerals: () => [
          { x: 460, y: 300 },
          { x: 480, y: 300 },
          { x: 500, y: 300 },
        ],
        getAliveCount: () => 1,
      }),
    );

    expect(decideBotInput(snapshot).right).toBe(true);
  });

  it('AC11 — a lone mineral does not divert the bot from an enemy', () => {
    const snapshot = buildBotSnapshot(
      makeScene({
        getPlayer: () => stillPlayer(400, 300),
        getEnemies: () => [{ x: 1000, y: 300, alive: true, archetype: 'scout' }],
        getMinerals: () => [{ x: 350, y: 300 }],
        getAliveCount: () => 1,
      }),
    );

    expect(decideBotInput(snapshot).right).toBe(true);
  });

  it('AC14 — wave pressure flows through the builder and reverses the diversion', () => {
    const base = {
      getPlayer: () => stillPlayer(400, 300),
      getEnemies: () => [{ x: 200, y: 300, alive: true, archetype: 'scout' }],
      getMinerals: () => [
        { x: 460, y: 300 },
        { x: 480, y: 300 },
        { x: 500, y: 300 },
      ],
      getAliveCount: () => 1,
    };
    const calm = buildBotSnapshot(
      makeScene({ ...base, getWaveState: () => ({ active: true, timeRemaining: 30, timeLimit: 30 }) }),
    );
    const urgent = buildBotSnapshot(
      makeScene({ ...base, getWaveState: () => ({ active: true, timeRemaining: 1, timeLimit: 30 }) }),
    );
    expect(decideBotInput(calm).right).toBe(true);
    expect(decideBotInput(urgent).left).toBe(true);
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
