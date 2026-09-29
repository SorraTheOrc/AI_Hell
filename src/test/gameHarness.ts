/**
 * Lightweight Phaser boot harness for tests: boots a real Phaser.Game
 * (rendering stubbed by src/test/setup.ts) with the given scene classes
 * and waits for the scene to become active.
 *
 * ## Deterministic boot (AH-0MUHA0MMP001DZ5C)
 *
 * By default the harness waits a fixed **real-time** 150 ms while Phaser's
 * requestAnimationFrame loop is live, so the scene drains an unpredictable
 * number of frames (frame timing varies under full-suite parallel load).
 * That makes any assertion taken immediately after boot — and any helper
 * that clears a wave by draining the scene — load-sensitive.
 *
 * Passing `{ deterministicBoot: true }` removes that nondeterminism: the
 * live loop is stopped before its first frame and the scene is booted with
 * a single fixed-delta `game.step`, so the state a test observes is
 * identical on every run. The live loop is then resumed so tests that
 * `await` a scene transition (e.g. the game-over flow) keep working — the
 * synchronous part of a test always runs before the next animation frame.
 *
 * The PlayScene suites opt in so their wave-clear → transition assertions
 * are driven only by explicit `scene.tick(dt)` calls, never by wall-clock
 * frames.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

export interface BootedGame {
  game: Phaser.Game;
  scene: Phaser.Scene;
}

export interface BootSceneOptions {
  /**
   * Stop Phaser's live render loop before its first frame and boot the
   * scene with a single fixed-delta step, then resume the loop. This makes
   * the booted scene state deterministic and independent of wall-clock
   * frame timing (see the file header). Default: `false` (legacy
   * real-time boot).
   */
  deterministicBoot?: boolean;
}

/** Fixed simulation step used to boot the scene deterministically (~60 fps). */
const DETERMINISTIC_STEP_MS = 1000 / 60;
/**
 * Simulated game time advanced after the scene becomes active, matching
 * the typical real-time boot delay so tests observe the same "settled"
 * state as the legacy harness without any wall-clock variance.
 */
const DETERMINISTIC_SETTLE_MS = 150;
/** Upper bound on fixed-delta steps used to reach an active scene. */
const DETERMINISTIC_MAX_STEPS = 120;

const bootDelay = () => new Promise((resolve) => setTimeout(resolve, 150));

/**
 * Boots a game containing `sceneClasses` and resolves with the first
 * scene instance once active. Callers must `game.destroy()` after use.
 *
 * The second argument is either the host element id (legacy form) or a
 * {@link BootSceneOptions} object.
 *
 * @param sceneClasses — Scene classes to register on the game.
 * @param parentOrOptions — DOM element id that hosts the canvas, or options.
 * @param maybeOptions — Options when `parentOrOptions` is a string.
 */
export async function bootScene(
  sceneClasses: (typeof Phaser.Scene)[],
  parentOrOptions: string | BootSceneOptions = 'game-container',
  maybeOptions: BootSceneOptions = {},
): Promise<BootedGame> {
  const parent =
    typeof parentOrOptions === 'string' ? parentOrOptions : 'game-container';
  const options =
    typeof parentOrOptions === 'string' ? maybeOptions : parentOrOptions;

  if (document.body.querySelector(`#${parent}`) === null) {
    const div = document.createElement('div');
    div.id = parent;
    document.body.appendChild(div);
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#000000',
    parent,
    scene: sceneClasses,
  });

  if (options.deterministicBoot) {
    await bootDeterministic(game);
  } else {
    await bootDelay();
  }

  const scene = game.scene.getScenes(true)[0];
  if (!scene) throw new Error('no active scene after boot');
  return { game, scene };
}

/**
 * Boots `game` without letting the live loop advance the scene by an
 * unpredictable amount.
 *
 * The game boots asynchronously: `Phaser.Core.Events.READY` fires
 * synchronously just before the game starts its loop. Registering a
 * `once(READY)` handler that defers `loop.stop()` to a microtask lands the
 * stop after `start()` but before the first animation frame, so no
 * wall-clock frame runs. The scene is then booted by fixed-delta
 * `game.step` calls, advanced by a fixed simulated time so the post-boot
 * state matches the legacy harness, and the live loop is resumed for tests
 * that await transitions.
 *
 * @param game — The freshly constructed game to boot.
 */
async function bootDeterministic(game: Phaser.Game): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    game.events.once(Phaser.Core.Events.READY, () => resolve());
  });
  game.events.once(Phaser.Core.Events.READY, () => {
    // Defer so the stop lands after Phaser's `start()` (which runs
    // synchronously after READY) but before the first rAF frame.
    queueMicrotask(() => game.loop.stop());
  });

  // Wait for the async game boot; fall back to the legacy delay if READY
  // has already fired (defensive — it normally fires after construction).
  await Promise.race([ready, bootDelay()]);

  // Guarantee the loop is stopped even if the microtask above was missed.
  game.loop.stop();

  // Boot the scene with fixed-delta steps — no wall-clock frames — then
  // advance a fixed simulated time so the state does not depend on how
  // many frames happened to drain during a real-time boot.
  let time = 0;
  let activeAtStep = -1;
  const settleSteps = Math.ceil(DETERMINISTIC_SETTLE_MS / DETERMINISTIC_STEP_MS);
  for (let i = 0; i < DETERMINISTIC_MAX_STEPS; i++) {
    time += DETERMINISTIC_STEP_MS;
    game.step(time, DETERMINISTIC_STEP_MS);
    if (activeAtStep < 0 && game.scene.getScenes(true).length > 0) {
      activeAtStep = i;
    }
    if (activeAtStep >= 0 && i - activeAtStep >= settleSteps) break;
  }

  // Resume the live loop so tests that `await` a scene transition still
  // work. The next animation frame cannot run before the synchronous part
  // of the calling test has finished, so the booted state stays
  // deterministic.
  game.loop.start(game.step.bind(game));
}
