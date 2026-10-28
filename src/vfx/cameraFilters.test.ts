/**
 * Camera-filter driver — capability probe / apply / teardown contract
 * (test-first for AH-0MVNTXV8P009B531, contract owned by AH-0MVNTXSQ1000QO12).
 *
 * **TEST-FIRST.** This suite was authored before `src/vfx/cameraFilters.ts`
 * existed, wrapped in Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts`) so the suite stays green on
 * pre-change HEAD. The implementation item **flips every `it.fails` back to a
 * plain `it`** once the module lands. A leftover `it.fails` here fails the
 * suite (an expected failure that stops failing is reported as a failure).
 *
 * The module is loaded through a non-literal dynamic import on purpose: a
 * static `import './cameraFilters'` would fail `tsc --noEmit` (and therefore
 * the build) while the module is absent, or if it is ever removed again.
 *
 * ## Why a driver, and why WebGL-only
 *
 * Phaser 4 camera filters are **WebGL only**. The player Phase Shift treatment
 * must therefore apply its filter layers only where they exist, and degrade to
 * the overlay-only layers everywhere else (canvas renderer, headless unit
 * tests, a camera without a filter list) without throwing and without leaking.
 * This module is the single guarded entry point; the game and every gym share
 * it, so the two can never diverge.
 *
 * ## Pinned contract (AH-0MVNTXV8P009B531 must match exactly)
 *
 * `src/vfx/cameraFilters.ts` — no module-level mutable state, no I/O:
 *
 * Tunables (every magnitude driven from one of these — no hard-coded numbers):
 * - `PHASE_FILTER_BURST_DURATION_MS` — activation-burst lifetime (ms).
 * - `PHASE_FILTER_BURST_PIXELATE_SIZE` — pixelate block size used by the burst.
 * - `PHASE_FILTER_BURST_BARREL_AMOUNT` — barrel distortion strength at burst
 *   start (decays to 0 over the burst duration).
 * - `PHASE_FILTER_SUSTAINED_BARREL_AMOUNT` — gentle sustained barrel strength
 *   (strictly weaker than the burst).
 *
 * - `supportsCameraFilters(scene)` — `true` only when the renderer reports
 *   `Phaser.WEBGL` **and** the main camera exposes an `internal` filter list
 *   with `list`, `remove` and the `addPixelate` / `addBarrel` factories. It is
 *   total: a stub scene, a missing camera, a renderer without `type`, a `null`
 *   filter list or a list without the factories all return `false` and never
 *   throw.
 *
 * - `createPhaseFilterDriver(scene)` — returns a `PhaseFilterDriver`:
 *   - `supported` mirrors `supportsCameraFilters(scene)`.
 *   - `controllers` is the list of filter controllers this driver currently
 *     owns (empty when unsupported or cleared). It never contains controllers
 *     added by anyone else.
 *   - `applyBurst()` adds **exactly two** controllers to
 *     `camera.filters.internal` — one `addPixelate(PHASE_FILTER_BURST_PIXELATE_SIZE)`
 *     and one `addBarrel(PHASE_FILTER_BURST_BARREL_AMOUNT)` — and returns
 *     `true`. Calling it again while a burst is live does not duplicate them.
 *     On an unsupported scene it allocates nothing and returns `false`.
 *   - `applySustained()` adds **exactly one** controller —
 *     `addBarrel(PHASE_FILTER_SUSTAINED_BARREL_AMOUNT)` — and returns `true`;
 *     it is idempotent (a second call adds nothing). On an unsupported scene it
 *     allocates nothing and returns `false`.
 *   - `applyBurst()` / `applySustained()` are independent: the driver never
 *     adds the same controller twice and never removes one layer when applying
 *     the other.
 *   - `update(dtSeconds)` advances the burst: the live barrel controller's
 *     `amount` decays monotonically toward `0` (mutating the existing
 *     controller, never allocating), and when the elapsed burst time reaches
 *     `PHASE_FILTER_BURST_DURATION_MS` the burst controllers are removed from
 *     the camera filter list and destroyed **exactly once**. The sustained
 *     controller (if applied) is untouched by `update`. Non-positive/`NaN`
 *     deltas are ignored.
 *   - `clear()` removes and destroys only this driver's controllers (`remove`
 *     on the owning filter list), leaving every pre-existing controller in the
 *     camera's filter list intact and undestroyed. It is idempotent (a second
 *     call is a safe no-op) and resets `controllers` to empty.
 *
 * All filter work targets `camera.filters.internal` (full-camera space); the
 * tests use a minimal fake filter list rather than a real WebGL context, so the
 * suite runs headless.
 *
 * @module vfx/cameraFilters.test
 */

import { describe, expect, it } from 'vitest';
import Phaser from 'phaser';

// ── Test-facing contract types (declared before the module exists) ──

/** Minimal fake filter controller: only what the driver may touch. */
interface StubFilterController {
  kind: string;
  amount: number;
  destroyed: boolean;
  destroy(): void;
}

/** A recorded factory invocation (`addPixelate(4)` → `{ factory: 'addPixelate', args: [4] }`). */
interface StubFactoryCall {
  factory: string;
  args: unknown[];
}

/** Minimal fake `Phaser.GameObjects.Components.FilterList`. */
interface StubFilterList {
  list: StubFilterController[];
  calls: StubFactoryCall[];
  addPixelate(amount?: number): StubFilterController;
  addBarrel(amount?: number): StubFilterController;
  addGlow(): StubFilterController;
  addDisplacement(): StubFilterController;
  remove(filter: StubFilterController): StubFilterList;
  clear(): StubFilterList;
}

/** Fake scene carrying only the camera-filter surface the driver may use. */
interface StubFilterScene {
  game: { renderer: { type?: number } };
  cameras: { main: { filters: unknown } };
  internal: StubFilterList;
  external: StubFilterList;
}

/** The `src/vfx/cameraFilters.ts` surface this suite pins. */
interface CameraFiltersContract {
  readonly PHASE_FILTER_BURST_DURATION_MS: number;
  readonly PHASE_FILTER_BURST_PIXELATE_SIZE: number;
  readonly PHASE_FILTER_BURST_BARREL_AMOUNT: number;
  readonly PHASE_FILTER_SUSTAINED_BARREL_AMOUNT: number;
  supportsCameraFilters(scene: Phaser.Scene): boolean;
  createPhaseFilterDriver(scene: Phaser.Scene): PhaseFilterDriver;
}

/** The driver surface the player Phase Shift treatment consumes. */
interface PhaseFilterDriver {
  readonly supported: boolean;
  readonly controllers: readonly StubFilterController[];
  applyBurst(): boolean;
  applySustained(): boolean;
  update(dtSeconds: number): void;
  clear(): void;
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const CAMERA_FILTERS_MODULE = './cameraFilters';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function cameraFilters(): Promise<CameraFiltersContract> {
  return (await import(CAMERA_FILTERS_MODULE)) as CameraFiltersContract;
}

// ── Stub builders ──────────────────────────────────────────────────

/** A fake filter list that mirrors the real add/remove/clear contract. */
function makeStubFilterList(): StubFilterList {
  const list: StubFilterController[] = [];
  const calls: StubFactoryCall[] = [];

  const factory = (kind: string) => (amount?: number): StubFilterController => {
    calls.push({ factory: kind, args: amount === undefined ? [] : [amount] });
    const controller: StubFilterController = {
      kind,
      amount: amount ?? 1,
      destroyed: false,
      destroy() {
        controller.destroyed = true;
      },
    };
    list.push(controller);
    return controller;
  };

  return {
    list,
    calls,
    addPixelate: factory('addPixelate'),
    addBarrel: factory('addBarrel'),
    addGlow: factory('addGlow'),
    addDisplacement: factory('addDisplacement'),
    remove(filter) {
      const index = list.indexOf(filter);
      if (index >= 0) {
        list.splice(index, 1);
        // Real Phaser's `FilterList.remove` destroys the controller.
        filter.destroy();
      }
      return this;
    },
    clear() {
      for (const filter of [...list]) filter.destroy();
      list.length = 0;
      return this;
    },
  };
}

/**
 * Builds a fake scene with a WebGL renderer (`rendererType`) and a main camera
 * exposing `internal` / `external` filter lists.
 */
function makeStubScene(rendererType: number = Phaser.WEBGL): StubFilterScene {
  const internal = makeStubFilterList();
  const external = makeStubFilterList();
  return {
    game: { renderer: { type: rendererType } },
    cameras: { main: { filters: { internal, external } } },
    internal,
    external,
  };
}

/** Casts a stub scene to the production scene type (structurally minimal). */
function asScene(scene: StubFilterScene | Record<string, unknown>): Phaser.Scene {
  return scene as unknown as Phaser.Scene;
}

describe('supportsCameraFilters — capability probe (AH-0MVNTXSQ1000QO12)', () => {
  it.fails('reports support for a WebGL scene whose camera exposes a usable filter list', async () => {
    const { supportsCameraFilters } = await cameraFilters();
    const scene = makeStubScene(Phaser.WEBGL);

    expect(supportsCameraFilters(asScene(scene))).toBe(true);
    // The probe must be read-only: it allocates no controllers.
    expect(scene.internal.calls).toHaveLength(0);
    expect(scene.internal.list).toHaveLength(0);
  });

  it.fails('reports no support on a canvas renderer even when a filter list exists', async () => {
    const { supportsCameraFilters } = await cameraFilters();
    const scene = makeStubScene(Phaser.CANVAS);

    expect(supportsCameraFilters(asScene(scene))).toBe(false);
  });

  it.fails('never throws and reports no support for a partial or empty scene', async () => {
    const { supportsCameraFilters } = await cameraFilters();

    // No scene at all.
    expect(() => supportsCameraFilters(undefined as unknown as Phaser.Scene)).not.toThrow();
    expect(supportsCameraFilters(undefined as unknown as Phaser.Scene)).toBe(false);

    // Renderer without a `type`.
    expect(supportsCameraFilters(asScene({ game: { renderer: {} }, cameras: { main: {} } }))).toBe(
      false,
    );

    // No cameras at all.
    expect(supportsCameraFilters(asScene({ game: { renderer: { type: Phaser.WEBGL } } }))).toBe(
      false,
    );

    // Camera without a filter list.
    expect(
      supportsCameraFilters(
        asScene({ game: { renderer: { type: Phaser.WEBGL } }, cameras: { main: { filters: null } } }),
      ),
    ).toBe(false);

    // Filter list without the distortion factories.
    expect(
      supportsCameraFilters(
        asScene({
          game: { renderer: { type: Phaser.WEBGL } },
          cameras: { main: { filters: { internal: { list: [] }, external: { list: [] } } } },
        }),
      ),
    ).toBe(false);

    // ### with no add factories at all.
    expect(
      supportsCameraFilters(
        asScene({
          game: { renderer: { type: Phaser.WEBGL } },
          cameras: { main: { filters: { internal: null, external: null } } },
        }),
      ),
    ).toBe(false);
  });
});

describe('createPhaseFilterDriver — activation distortion burst', () => {
  it.fails('adds exactly one pixelate + one barrel controller at the documented magnitudes', async () => {
    const { createPhaseFilterDriver, PHASE_FILTER_BURST_BARREL_AMOUNT, PHASE_FILTER_BURST_PIXELATE_SIZE } =
      await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));

    expect(driver.supported).toBe(true);
    expect(driver.applyBurst()).toBe(true);

    expect(scene.internal.list).toHaveLength(2);
    expect(driver.controllers).toHaveLength(2);

    const pixelate = scene.internal.list.find((c) => c.kind === 'pixelate');
    const barrel = scene.internal.list.find((c) => c.kind === 'barrel');
    expect(pixelate).toBeDefined();
    expect(barrel).toBeDefined();
    // Driven verbatim from the exported tunables — never hard-coded.
    expect(pixelate?.amount).toBe(PHASE_FILTER_BURST_PIXELATE_SIZE);
    expect(barrel?.amount).toBe(PHASE_FILTER_BURST_BARREL_AMOUNT);
    // The burst must never touch the external filter list.
    expect(scene.external.list).toHaveLength(0);
  });

  it.fails('does not duplicate the burst controllers when applied twice', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));

    expect(driver.applyBurst()).toBe(true);
    const applied = [...scene.internal.list];
    expect(driver.applyBurst()).toBe(true);

    expect(scene.internal.list).toEqual(applied);
    expect(driver.controllers).toHaveLength(2);
  });

  it.fails(
    'decays the barrel wobble and removes/destroys both controllers exactly once when the documented duration elapses',
    async () => {
      const { createPhaseFilterDriver, PHASE_FILTER_BURST_DURATION_MS } = await cameraFilters();
      const scene = makeStubScene();
      const driver = createPhaseFilterDriver(asScene(scene));
      driver.applyBurst();

      const [pixelate, barrel] = [
        scene.internal.list.find((c) => c.kind === 'pixelate')!,
        scene.internal.list.find((c) => c.kind === 'barrel')!,
      ];
      const initialAmount = barrel.amount;

      // Half the documented duration: still live, decayed, same controller.
      driver.update(PHASE_FILTER_BURST_DURATION_MS / 1000 / 2);
      expect(scene.internal.list).toHaveLength(2);
      expect(scene.internal.list.find((c) => c.kind === 'barrel')).toBe(barrel);
      expect(barrel.amount).toBeLessThan(initialAmount);
      expect(barrel.amount).toBeGreaterThan(0);

      // Past the documented duration: the burst is torn down exactly once.
      driver.update(PHASE_FILTER_BURST_DURATION_MS / 1000);
      expect(scene.internal.list).toHaveLength(0);
      expect(driver.controllers).toHaveLength(0);
      expect(pixelate.destroyed).toBe(true);
      expect(barrel.destroyed).toBe(true);

      // Further ticks do not re-destroy or resurrect anything.
      driver.update(1);
      expect(scene.internal.list).toHaveLength(0);
      expect(pixelate.destroyed).toBe(true);
      expect(barrel.destroyed).toBe(true);
    },
  );

  it.fails('ignores non-positive and NaN deltas', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));
    driver.applyBurst();
    const barrel = scene.internal.list.find((c) => c.kind === 'barrel')!;
    const initialAmount = barrel.amount;

    driver.update(0);
    driver.update(-1);
    driver.update(Number.NaN);

    expect(scene.internal.list).toHaveLength(2);
    expect(barrel.amount).toBe(initialAmount);
  });

  it.fails('is a pure no-op on an unsupported scene: no allocation, no throw, falsy result', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene(Phaser.CANVAS);
    const driver = createPhaseFilterDriver(asScene(scene));

    expect(driver.supported).toBe(false);
    expect(driver.applyBurst()).toBe(false);
    expect(driver.controllers).toHaveLength(0);
    expect(scene.internal.calls).toHaveLength(0);
    expect(scene.internal.list).toHaveLength(0);
    // Updates and teardown stay no-ops instead of throwing.
    expect(() => driver.update(0.5)).not.toThrow();
    expect(() => driver.clear()).not.toThrow();
  });
});

describe('createPhaseFilterDriver — sustained filter layer', () => {
  it.fails('adds exactly one gentle barrel controller, weaker than the burst', async () => {
    const {
      createPhaseFilterDriver,
      PHASE_FILTER_BURST_BARREL_AMOUNT,
      PHASE_FILTER_SUSTAINED_BARREL_AMOUNT,
    } = await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));

    expect(driver.applySustained()).toBe(true);

    expect(scene.internal.list).toHaveLength(1);
    const sustained = scene.internal.list[0];
    expect(sustained.kind).toBe('barrel');
    expect(sustained.amount).toBe(PHASE_FILTER_SUSTAINED_BARREL_AMOUNT);
    expect(Math.abs(sustained.amount)).toBeLessThan(Math.abs(PHASE_FILTER_BURST_BARREL_AMOUNT));
    // Idempotent: a second call adds nothing.
    expect(driver.applySustained()).toBe(true);
    expect(scene.internal.list).toHaveLength(1);
  });

  it.fails('keeps the burst and sustained layers independent', async () => {
    const { createPhaseFilterDriver, PHASE_FILTER_BURST_DURATION_MS } = await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));

    driver.applySustained();
    // Capture the sustained controller before the burst adds its own barrel.
    const sustained = scene.internal.list[0];
    driver.applyBurst();
    expect(scene.internal.list).toHaveLength(3);

    // Expiring the burst leaves the sustained controller untouched.
    driver.update(PHASE_FILTER_BURST_DURATION_MS / 1000 + 0.1);
    expect(scene.internal.list).toHaveLength(1);
    expect(scene.internal.list[0]).toBe(sustained);
    expect(sustained.destroyed).toBe(false);

    // Re-applying the burst after expiry adds a fresh pair, not a duplicate.
    expect(driver.applyBurst()).toBe(true);
    expect(scene.internal.list).toHaveLength(3);
  });

  it.fails('is a pure no-op on an unsupported scene', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene(Phaser.CANVAS);
    const driver = createPhaseFilterDriver(asScene(scene));

    expect(driver.applySustained()).toBe(false);
    expect(driver.controllers).toHaveLength(0);
    expect(scene.internal.calls).toHaveLength(0);
  });
});

describe('createPhaseFilterDriver — exact teardown', () => {
  it.fails('removes and destroys only its own controllers, leaving a pre-existing filter untouched', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene();
    // A filter the rest of the game (or a future effect) already applied.
    const preexisting = scene.internal.addGlow();
    const driver = createPhaseFilterDriver(asScene(scene));

    driver.applyBurst();
    driver.applySustained();
    expect(scene.internal.list).toHaveLength(4);

    driver.clear();

    expect(scene.internal.list).toEqual([preexisting]);
    expect(preexisting.destroyed).toBe(false);
    expect(driver.controllers).toHaveLength(0);
    // Nothing was removed from the external list either.
    expect(scene.external.calls).toHaveLength(0);
  });

  it.fails('is idempotent: a second clear neither throws nor double-destroys', async () => {
    const { createPhaseFilterDriver } = await cameraFilters();
    const scene = makeStubScene();
    const driver = createPhaseFilterDriver(asScene(scene));
    driver.applyBurst();
    const controllers = [...scene.internal.list];

    driver.clear();
    expect(() => driver.clear()).not.toThrow();

    expect(controllers.every((c) => c.destroyed)).toBe(true);
    expect(scene.internal.list).toHaveLength(0);
    expect(driver.controllers).toHaveLength(0);
  });
});
