/**
 * Lightweight Phaser boot harness for tests: boots a real Phaser.Game
 * (rendering stubbed by src/test/setup.ts) with the given scene classes
 * and waits for the scene to become active.
 *
 * ## Deterministic boot (default since AH-0MVF6XQIC005RY3P)
 *
 * Every boot is deterministic. The live requestAnimationFrame loop is
 * stopped before its first frame and the scene is booted with a fixed-delta
 * `game.step` sequence, so the state a test observes is identical on every
 * run, independent of wall-clock frame timing and host load. The live loop
 * is then resumed so tests that `await` a scene transition (e.g. the
 * game-over flow) keep working — the synchronous part of a test always runs
 * before the next animation frame.
 *
 * The legacy real-time boot (`setTimeout(150)` while the rAF loop drained
 * an unpredictable number of frames) was **deleted**: it cost ~89 s of pure
 * sleeping per full run and made post-boot assertions (and helpers that
 * clear a wave by draining the scene) load-sensitive. Deterministic boot is
 * now the only path — there is no opt-in flag to pass. Drive behaviour with
 * explicit `scene.tick(dt)` calls or the `stepGameUntil(game, …)` helper
 * below, never with wall-clock waits. A repo-level guard test
 * (`src/test/deterministicBootGuard.test.ts`) asserts the legacy path cannot
 * return.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

export interface BootedGame {
  game: Phaser.Game;
  scene: Phaser.Scene;
}

/**
 * A game shell created lazily on the first `boot()` and reused for every later
 * `boot()` (AH-0MVF6VZG9000AN6E).
 *
 * Creating a `Phaser.Game` (renderer, canvas context, scene manager) costs a
 * material share of a deterministic boot (measured ~10–27 ms of the ~20–90 ms
 * a gym boot takes on a loaded 16-core host), so heavy suites that boot once
 * per test can reuse the game shell and only pay for the scene `create()` +
 * the fixed-delta boot steps.
 *
 * **Why this is safe:** every `boot()` call shuts down and destroys the
 * previous scene instances and creates **new** instances of the requested
 * scene classes — the same per-test scene state isolation a fresh game gives.
 * What is shared is only the Phaser game shell (renderer +
 * `game.registry`/`game.textures`/`game.anims`), which the gym scenes and
 * `PlayScene` do not mutate. Suites that mutate game-global state or replace
 * the DOM host (`document.body.innerHTML`) must keep per-test `bootScene()`.
 */
export interface ReusableBoot {
  /**
   * The reused game, or `null` before the first `boot()`. Do **not** call
   * `destroy()` on it; call `dispose()`.
   */
  readonly game: Phaser.Game | null;
  /**
   * Replaces every scene on the reused game (creating the game on first use)
   * with fresh instances of `sceneClasses` and runs the deterministic boot,
   * resolving with the first active scene.
   */
  boot(sceneClasses: (typeof Phaser.Scene)[]): Promise<BootedGame>;
  /** Destroys the reused game (no-op if never booted). */
  dispose(): void;
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

/**
 * Boots a game containing `sceneClasses` and resolves with the first
 * scene instance once active. Callers must `game.destroy()` after use.
 *
 * Boot is always deterministic (see the file header): the live loop is
 * stopped before its first frame, the scene is advanced by fixed-delta
 * `game.step` calls, and the loop is then resumed. `parent` optionally
 * names the DOM element that hosts the canvas.
 *
 * @param sceneClasses — Scene classes to register on the game.
 * @param parent — DOM element id that hosts the canvas.
 */
export async function bootScene(
  sceneClasses: (typeof Phaser.Scene)[],
  parent = 'game-container',
): Promise<BootedGame> {
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

  await bootDeterministic(game);

  const scene = game.scene.getScenes(true)[0];
  if (!scene) throw new Error('no active scene after boot');
  return { game, scene };
}

/**
 * Boots `game` without letting the live loop advance the scene by an
 * unpredictable amount.
 *
 * The game boots asynchronously: `Phaser.Core.Events.READY` fires
 * synchronously just before the game starts its loop. The loop is stopped
 * synchronously as soon as the READY promise resolves — still inside the
 * microtask continuation, before any `requestAnimationFrame` callback can
 * run — so no wall-clock frame advances the scene. The scene is then booted
 * by fixed-delta `game.step` calls, advanced by a fixed simulated time so the
 * post-boot state matches the legacy harness, and the live loop is resumed
 * for tests that `await` transitions.
 *
 * Note: do **not** defer the stop into a `queueMicrotask` from the READY
 * handler — that microtask is queued *after* the `await` continuation, so it
 * would run last and stop the loop we just resumed (AH-0MVF6XQIC005RY3P).
 *
 * @param game — The freshly constructed game to boot.
 */
async function bootDeterministic(game: Phaser.Game): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    // `isBooted` covers the defensive case where READY already fired before
    // the handler could be registered — without a wall-clock fallback delay.
    if (game.isBooted) {
      resolve();
      return;
    }
    game.events.once(Phaser.Core.Events.READY, () => resolve());
  });

  // Wait for the async game boot only. READY normally fires after
  // construction, so this resolves without any wall-clock delay; if it has
  // already fired, `isBooted` above resolves the promise immediately.
  await ready;

  // Stop the loop synchronously, before the first animation frame can run.
  game.loop.stop();

  runDeterministicBootSteps(game);

  // Resume the live loop so tests that `await` a scene transition still
  // work. The next animation frame cannot run before the synchronous part
  // of the calling test has finished, so the booted state stays
  // deterministic.
  game.loop.start(game.step.bind(game));
}

/**
 * Boots the (loop-stopped) game with fixed-delta steps — no wall-clock frames
 * — then advances a fixed simulated time so the state does not depend on how
 * many frames happened to drain during a real-time boot.
 *
 * The simulated clock is anchored to the real clock so `scene.time.now`
 * keeps the semantics the legacy real-time boot had (an absolute,
 * monotonically increasing timestamp). Only the *origin* is real: the step
 * count and the resulting scene state stay fixed-delta and deterministic
 * (AH-0MVF6XQIC005RY3P).
 *
 * Shared by the first (fresh-game) boot and every reusable-boot reboot
 * (AH-0MVF6VZG9000AN6E) so both paths advance the scene identically.
 *
 * @param game — A booted game whose live loop is stopped.
 */
function runDeterministicBootSteps(game: Phaser.Game): void {
  let time = window.performance.now();
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
}

/**
 * Creates a lazy reusable boot for suites that want to boot **once per test
 * file** (one game shell) instead of once per test (AH-0MVF6VZG9000AN6E).
 *
 * Typical use — one pool per file, disposed by the file-level `afterAll`:
 *
 * ```ts
 * const reuse = createReusableBoot();
 * afterAll(() => reuse.dispose());
 *
 * describe('GymWeapons …', () => {
 *   let booted: BootedGame | null = null;
 *   afterEach(() => { booted = null; });
 *
 *   async function bootWeapons(): Promise<GymWeapons> {
 *     booted = await reuse.boot([GymWeapons]);
 *     return booted.scene as GymWeapons;
 *   }
 * });
 * ```
 *
 * The first `boot()` is the normal deterministic `bootScene()` boot, so the
 * first test observes exactly what a per-test boot would produce; every later
 * `boot()` pays only for the scene `create()` + boot steps. Scenes are always
 * fresh instances — only the game shell is shared.
 *
 * @param parent — DOM element id that hosts the canvas (fixed for the pool).
 */
export function createReusableBoot(parent = 'game-container'): ReusableBoot {
  let game: Phaser.Game | null = null;

  async function boot(nextSceneClasses: (typeof Phaser.Scene)[]): Promise<BootedGame> {
    if (!game) {
      const first = await bootScene(nextSceneClasses, parent);
      game = first.game;
      return first;
    }

    game.loop.stop();

    // Drain any scene operations the previous test queued (e.g.
    // `ScenePlugin.launch`/`pause` queue `start`/`pause` ops). If left in the
    // queue they would run inside the first boot step and target the *fresh*
    // scene instances we add below — a stale overlay `start` would even become
    // the "active" scene and a stale `pause` would freeze the new gym
    // (observed in GymMinerals). Draining first applies them to the old
    // instances we are about to destroy.
    game.scene.processQueue();

    // Shut down and destroy every previous scene instance so no per-test scene
    // state can leak into the next test (fresh instance == fresh game, except
    // for the shared game shell). `SceneManager.remove` destroys a scene's
    // systems and display list but does **not** emit `SHUTDOWN` (nor does
    // `Game#destroy`), so emit it explicitly first: scene cleanup handlers
    // (DOM panels, listeners) must run or reused games accumulate debris.
    for (const stale of [...game.scene.getScenes(false)]) {
      const sys = stale.sys;
      if (sys.settings.status !== Phaser.Scenes.DESTROYED) sys.shutdown();
      game.scene.remove(sys.settings.key);
    }
    // `remove` queues itself while the manager is processing; drain again so
    // the old scenes are gone before the fresh instances reuse their keys.
    game.scene.processQueue();
    const leftovers = game.scene.getScenes(false);
    if (leftovers.length > 0) {
      throw new Error(
        `scene removal did not complete (${leftovers
          .map((s) => s.sys.settings.key)
          .join(', ')})`,
      );
    }

    nextSceneClasses.forEach((SceneClass, index) => {
      // `SceneManager.add(key, sceneConfig, autoStart)`: the class has to be
      // the *second* argument, and `createSceneFromFunction` replaces the
      // placeholder key with the instance's own scene key.
      game!.scene.add(SceneClass.name, SceneClass, index === 0);
    });
    // An added scene with `autoStart` boots `create()` synchronously; the
    // yield lets any microtask-deferred work it scheduled (e.g. happy-dom's
    // deferred image `src` assignment) settle before the boot steps run.
    await yieldMacrotask();

    runDeterministicBootSteps(game);

    const scene = game.scene.getScenes(true)[0];
    if (!scene) throw new Error('no active scene after reboot');

    game.loop.start(game.step.bind(game));
    return { game, scene };
  }

  return {
    get game() {
      return game;
    },
    boot,
    dispose: () => {
      game?.destroy(true);
      game = null;
    },
  };
}

/** Macrotask yield (never a wall-clock sleep). */
async function yieldMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Stops Phaser's live `requestAnimationFrame` loop and advances the stopped
 * game's clock with fixed-delta `game.step` calls until `predicate` holds,
 * throwing a descriptive error if it never does.
 * `game.step` drives the whole game — including every active scene's Phaser
 * `Clock` — so a production `this.time.delayedCall(...)` transition (for
 * example PlayScene's `VICTORY_TRANSITION_HOLD_MS` victory hold before
 * `GameOverScene`) is reached deterministically. `scene.tick(dt)` only runs
 * PlayScene's own simulation and does **not** advance the `Clock`, which
 * leaves a wall-clock `setTimeout` as the only alternative — and that can be
 * missed under full-suite parallel load (AH-0MUYALJ9S0002XXZ).
 *
 * @param game — The booted game whose live loop is stopped before stepping.
 * @param label — Condition name used in the failure message.
 * @param predicate — Condition to reach; polled before each step.
 * @param maxSteps — Step budget before failing loudly (default 600 ≈ 10 s).
 */
export function stepGameUntil(
  game: Phaser.Game,
  label: string,
  predicate: () => boolean,
  maxSteps = 600,
): void {
  game.loop.stop();
  // Anchor to the real clock (same rationale as `bootDeterministic`): timers
  // advance by the fixed `delta`, while absolute-time checks keep looking at
  // a monotonic timestamp.
  let time = window.performance.now();
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate()) return;
    time += DETERMINISTIC_STEP_MS;
    game.step(time, DETERMINISTIC_STEP_MS);
  }
  throw new Error(
    `stepGameUntil(${label}): condition not met after ${maxSteps} steps ` +
      `(~${((maxSteps * DETERMINISTIC_STEP_MS) / 1000).toFixed(1)}s simulated)`,
  );
}

/**
 * Deterministically advances the booted game by `ms` of simulated time in
 * fixed ~60 Hz `game.step` calls, then lets the promise chains started by
 * those frames settle.
 *
 * This is the replacement for the wall-clock sleeps that used to pepper the
 * Phaser suites:
 *
 * ```ts
 * // before — load-sensitive, burns real time
 * await new Promise((r) => setTimeout(r, 350));
 * // after — deterministic, instant
 * await advanceGame(booted.game, 350);
 * ```
 *
 * The live loop is stopped for the duration and restored to its previous
 * state afterwards, so it works in suites that drive the game manually as
 * well as in suites that rely on the live loop. The `setImmediate` turn after
 * the steps is a macrotask yield (never a sleep) that drains queued
 * microtasks/IO callbacks — e.g. a texture `load` handler queued by a stepped
 * frame — before the caller asserts.
 *
 * @param game — The booted game to advance.
 * @param ms — Simulated milliseconds to advance.
 * @param stepMs — Fixed step size (default ~60 fps).
 */
export async function advanceGame(
  game: Phaser.Game,
  ms: number,
  stepMs: number = DETERMINISTIC_STEP_MS,
): Promise<void> {
  const wasRunning = game.loop.running;
  game.loop.stop();

  let time = window.performance.now();
  const steps = Math.max(1, Math.ceil(ms / stepMs));
  for (let i = 0; i < steps; i += 1) {
    time += stepMs;
    game.step(time, stepMs);
  }

  // Macrotask yield (not a wall-clock sleep) so queued callbacks run.
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  if (wasRunning) game.loop.start(game.step.bind(game));
}
