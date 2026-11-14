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
 * Resolves once the game has finished its asynchronous boot
 * (`Phaser.Core.Events.READY`) — no wall-clock delay, no fallback sleep.
 *
 * Shared by the deterministic boot and by `advanceGame`, so a suite that
 * constructs its own `Phaser.Game` can step it deterministically even when the
 * boot has not completed yet (AH-0MVFPMT4P005UHZL). Stepping a not-yet-booted
 * game is a no-op, which used to be masked by a wall-clock sleep.
 *
 * @param game — The game whose boot to await (immediate when already booted).
 */
export async function awaitGameReady(game: Phaser.Game): Promise<void> {
  if (game.isBooted) return;
  await new Promise<void>((resolve) => {
    game.events.once(Phaser.Core.Events.READY, () => resolve());
  });
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
  await awaitGameReady(game);

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
 * Structural view of the scene hooks that explain a stalled deterministic
 * step (AH-0MWFLOUVH006GAPT). Every member is optional: only a scene that
 * exposes the `PlayScene` pause/mineral accessors is described, so the helper
 * works for any booted scene set without importing `PlayScene` (no cycle).
 */
export interface BlockingStateProbe {
  /** Freeze flag — a paused `PlayScene.tick()` returns immediately. */
  isPaused?: () => boolean;
  /** Whether the hold-full choice overlay owns the scene. */
  isMineralChoiceOpen?: () => boolean;
  /** Whether the boss is already dead (run outcome decided). */
  isRunFinished?: () => boolean;
  /** The active boss (mini-boss or final boss), or null. */
  getBoss?: () => {
    alive?: boolean;
    getHpFraction?: () => number;
    getTotalHp?: () => number;
    getPhaseNumber?: () => number;
    getPhaseCount?: () => number;
  } | null;
  /** Whether a wave/level transition pause is running. */
  isTransitioning?: () => boolean;
  /** Seconds left on the transition pause. */
  getTransitionRemaining?: () => number;
}

/**
 * Formats the blocking state of one scene, or `null` when the scene exposes no
 * blocking probe.
 *
 * Reports the state a deterministic walk can freeze in: the hold-full choice
 * pause (the AC4 stall mechanism), the run-finished flag, the boss hit
 * pool/phase and the level-transition timer. A paused scene is described even
 * when it is paused at the SceneManager level (`active=false`), because that
 * is exactly when `getScenes(true)` no longer lists it — and when its Phaser
 * `Clock` (and therefore the victory `delayedCall`) stops.
 *
 * Exported for focused unit tests of the message format; production callers
 * use {@link describeBlockingState}.
 *
 * @param scene — A booted scene (structurally probed; see
 *   {@link BlockingStateProbe}).
 */
export function describePlaySceneBlockingState(
  scene: Phaser.Scene,
): string | null {
  const probe = scene as unknown as BlockingStateProbe;
  if (typeof probe.isPaused !== 'function') return null;
  if (typeof probe.isMineralChoiceOpen !== 'function') return null;

  const parts: string[] = [`paused=${probe.isPaused()}`];
  parts.push(`mineralChoiceOpen=${probe.isMineralChoiceOpen()}`);
  if (typeof probe.isRunFinished === 'function') {
    parts.push(`runFinished=${probe.isRunFinished()}`);
  }
  const boss = probe.getBoss?.() ?? null;
  if (boss) {
    const total = boss.getTotalHp?.() ?? 0;
    const fraction = boss.getHpFraction?.() ?? 0;
    const remaining = boss.alive === false ? 0 : Math.round(total * fraction);
    const phase = boss.getPhaseNumber?.() ?? 0;
    const phases = boss.getPhaseCount?.() ?? 0;
    parts.push(
      `bossAlive=${boss.alive === true}`,
      `bossHp=${remaining}/${total}`,
      `bossPhase=${phase}/${phases}`,
    );
  } else {
    parts.push('boss=none');
  }
  if (typeof probe.isTransitioning === 'function') {
    parts.push(`transitioning=${probe.isTransitioning()}`);
  }
  if (typeof probe.getTransitionRemaining === 'function') {
    parts.push(
      `transitionRemaining=${probe.getTransitionRemaining().toFixed(2)}s`,
    );
  }
  parts.push(`active=${scene.sys.isActive()}`);
  return `${scene.scene.key}{${parts.join(', ')}}`;
}

/**
 * Describes a stepped game for a failure message: the active scene set plus
 * the blocking state of every scene that exposes one (see
 * {@link describePlaySceneBlockingState}).
 *
 * A paused `PlayScene` ignores `tick()`, and when the hold-full overlay pauses
 * it at the SceneManager level its `Clock` stops too — so every victory/wave
 * `delayedCall` freezes. Naming that state is what separates a real stall from
 * a too-small step budget (AH-0MWFLOUVH006GAPT).
 *
 * @param game — The booted game a stepping helper just exhausted.
 */
export function describeBlockingState(game: Phaser.Game): string {
  const activeNames = game.scene.getScenes(true).map((s) => s.scene.key);
  // Inspect every scene, not just the active ones: a scene paused at the
  // SceneManager level drops out of `getScenes(true)` and is exactly the state
  // that needs naming.
  const blocking = game.scene
    .getScenes(false)
    .map((scene) => describePlaySceneBlockingState(scene))
    .filter((detail): detail is string => detail !== null);
  const active = `active=[${activeNames.join(', ')}]`;
  return blocking.length > 0 ? `${active}; ${blocking.join('; ')}` : active;
}

/**
 * Structural view of the hold-full pause seam a deterministic walk has to
 * resolve (AH-0MWFLOWI6007WVZI). Both members are optional so the resolver is
 * a safe no-op for a scene that does not host a hold-full choice — the
 * stepping helpers probe **every** scene on the game.
 */
export interface HoldFullChoiceProbe {
  /** Whether the hold-full mineral choice overlay owns (and has paused) the scene. */
  isMineralChoiceOpen?: () => boolean;
  /** Applies one offered option permanently and resumes the scene. */
  selectMineralChoice?: (index: number) => unknown;
}

/**
 * Resolves an open hold-full power-up choice, if any — the **single** shared
 * implementation every deterministic walk in the test tree uses
 * (AH-0MWFLOWI6007WVZI; it replaces the per-suite copies that had drifted).
 *
 * ## Why this guard exists
 *
 * Long deterministic walks tick the auto-fire through many waves; the
 * resulting mineral drops eventually fill the hold and `PlayScene` pauses for
 * the hold-full choice overlay (`openMineralChoice()` → `setPaused(true)`, and
 * a SceneManager-level pause when `MineralChoiceScene` is registered). A
 * paused scene's `tick()` returns immediately, so every remaining walk tick —
 * **and** any `this.time.delayedCall` transition waiting on the (stopped)
 * `Clock` — becomes a no-op and the walk burns its whole budget in an
 * otherwise silent stall (AH-0MV5L6BVN005DP4I, AH-0MUFLOUVH006GAPT's AC4
 * victory flake). Selecting the first offered option resumes play, exactly as
 * a player would.
 *
 * Only a **hold-full** choice is resolved: `isMineralChoiceOpen()` reports the
 * hold-full flag alone, never the mini-boss reward overlay (which reuses the
 * selection callback but is not a hold-full drop).
 *
 * @param scene — The scene to probe (structurally; see
 *   {@link HoldFullChoiceProbe}). Any scene without the seam is a no-op.
 * @returns `true` when a choice was open and has been resolved, so the caller
 *   can retry the step.
 */
export function resolveMineralChoiceIfOpen(
  scene: HoldFullChoiceProbe,
): boolean {
  if (typeof scene.isMineralChoiceOpen !== 'function') return false;
  if (typeof scene.selectMineralChoice !== 'function') return false;
  if (!scene.isMineralChoiceOpen()) return false;
  scene.selectMineralChoice(0);
  return true;
}

/**
 * Resolves an open hold-full choice on whichever scene of `game` hosts one.
 *
 * Shared by the stepping helpers so `stepGameUntil`'s `resolveHoldFullChoice`
 * option and the navigation suite's local `stepUntil` walk the scene set the
 * same way (AH-0MWFLOWI6007WVZI).
 *
 * @param game — A booted game whose scenes to probe.
 * @returns `true` when a choice was open and has been resolved.
 */
export function resolveOpenHoldFullChoice(game: Phaser.Game): boolean {
  for (const scene of game.scene.getScenes(false)) {
    if (resolveMineralChoiceIfOpen(scene as HoldFullChoiceProbe)) return true;
  }
  return false;
}

/**
 * Options for {@link stepGameUntil}.
 */
export interface StepGameUntilOptions {
  /**
   * Resolve an open hold-full mineral choice between steps so a paused scene
   * cannot silently stall the walk (AH-0MWFLOWI6007WVZI).
   *
   * **Default `false`** — deliberately, so a suite that *asserts* the paused
   * or hold-full-overlay state keeps today's behaviour and stays green. Opt in
   * only when the walk expects the run to keep advancing (e.g. a boss-kill /
   * victory wait after a mineral fill).
   */
  resolveHoldFullChoice?: boolean;
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
 * @param options — Optional stepping behaviour; see
 *   {@link StepGameUntilOptions}. A hold-full choice is **not** resolved
 *   unless `resolveHoldFullChoice` is set, so paused-state suites are
 *   unaffected.
 */
export function stepGameUntil(
  game: Phaser.Game,
  label: string,
  predicate: () => boolean,
  maxSteps = 600,
  options: StepGameUntilOptions = {},
): void {
  game.loop.stop();
  // Anchor to the real clock (same rationale as `bootDeterministic`): timers
  // advance by the fixed `delta`, while absolute-time checks keep looking at
  // a monotonic timestamp.
  let time = window.performance.now();
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate()) return;
    // A paused scene ignores `step`, so an open hold-full choice would burn
    // the whole budget; resolve it first when the walk opts in.
    if (options.resolveHoldFullChoice) resolveOpenHoldFullChoice(game);
    time += DETERMINISTIC_STEP_MS;
    game.step(time, DETERMINISTIC_STEP_MS);
  }
  throw new Error(
    `stepGameUntil(${label}): condition not met after ${maxSteps} steps ` +
      `(~${((maxSteps * DETERMINISTIC_STEP_MS) / 1000).toFixed(1)}s simulated); ` +
      describeBlockingState(game),
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
 * well as in suites that rely on the live loop. A game that is still booting
 * (a suite constructing its own `Phaser.Game`) is awaited to READY first —
 * never a wall-clock delay — so the steps actually reach a scene
 * (AH-0MVFPMT4P005UHZL). The `setImmediate` turn after
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
  // A suite that constructs its own `Phaser.Game` may still be mid-boot: wait
  // for READY (no wall-clock delay) so the steps actually reach a scene.
  await awaitGameReady(game);

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
