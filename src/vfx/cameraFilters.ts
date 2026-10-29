/**
 * Camera filter driver — the single guarded entry point for Phaser 4 camera
 * filters (parent AH-0MVNTR89P0022JIU, approach C; contract pinned by
 * AH-0MVNTXSQ1000QO12).
 *
 * ## Why a driver
 *
 * The player Phase Shift treatment wants a genuine *structural* read on its
 * activation edge (a pixelate + barrel distortion hit) and a gentle sustained
 * distortion while phased. Phaser 4 exposes both as camera post-FX filters
 * (`camera.filters.internal.addPixelate()` / `.addBarrel()`), and the game and
 * every gym must run that code **once** (AGENTS.md gym<->game parity), so this
 * module owns the whole lifecycle: probe, apply, per-frame decay, teardown.
 *
 * ## WebGL only
 *
 * Phaser filters require the WebGL renderer. Canvas builds, headless unit
 * tests and stub scenes have no filter list at all, so every entry point here
 * is **total**: `supportsCameraFilters()` answers `false` instead of throwing,
 * the driver reports `supported: false`, and `applyBurst()` /
 * `applySustained()` return `false` without allocating anything. Callers keep
 * their overlay-only layers and never need a renderer branch of their own:
 *
 * ```ts
 * const filters = createPhaseFilterDriver(this.scene);
 * if (params.distortionEnabled) filters.applyBurst();
 * if (params.sustainedFilterEnabled) filters.applySustained();
 * // every frame while phased:
 * filters.update(delta / 1000);
 * // on the falling edge (and on scene SHUTDOWN):
 * filters.clear();
 * ```
 *
 * ## Ownership and teardown
 *
 * A driver owns **exactly** the controllers it created: `clear()` removes only
 * those, so a filter the rest of the game (or a future effect) already applied
 * survives untouched and undestroyed. Every method is idempotent, so a second
 * `applyBurst()`, a second `clear()` or an `update()` after the burst already
 * expired is a safe no-op rather than a leak or a double-destroy.
 *
 * ## Tunables (no hard-coded magnitudes anywhere)
 *
 * | Export | Meaning |
 * |---|---|
 * | {@link PHASE_FILTER_BURST_DURATION_MS} | lifetime of the activation burst (ms) |
 * | {@link PHASE_FILTER_BURST_PIXELATE_SIZE} | pixelate block size used by the burst |
 * | {@link PHASE_FILTER_BURST_BARREL_AMOUNT} | barrel amount at burst start (1.35 = expand outward) |
 * | {@link PHASE_FILTER_SUSTAINED_BARREL_AMOUNT} | gentle sustained barrel amount (weaker than the burst) |
 * | {@link PHASE_FILTER_BARREL_NEUTRAL_AMOUNT} | Phaser's neutral barrel amount (no distortion) |
 *
 * ## Performance
 *
 * Steady state is allocation-free: `update()` mutates the live barrel
 * controller's `amount` in place and allocates nothing, so the module is safe
 * to tick every frame. Controllers are only created on `applyBurst()` /
 * `applySustained()` and only released on burst expiry / `clear()`.
 *
 * @module vfx/cameraFilters
 */

import Phaser from 'phaser';

// ── Tunables ────────────────────────────────────────────────────────

/**
 * Lifetime of the activation distortion burst, in milliseconds.
 *
 * The burst is the aggressive part of the Phase Shift activation edge, so it
 * stays short: long enough to read as a hit, short enough that the pixelate
 * blockiness never obscures gameplay.
 */
export const PHASE_FILTER_BURST_DURATION_MS = 220;

/**
 * Pixelate block size requested by the activation burst.
 *
 * Phaser adds 2 to this value internally (`pixelSize = floor(2 + amount)`), so
 * `4` yields 6 px blocks: unmistakably blocky on a 360 px tall playfield
 * without swallowing bullets.
 */
export const PHASE_FILTER_BURST_PIXELATE_SIZE = 4;

/**
 * Barrel distortion amount at the start of the activation burst.
 *
 * Phaser treats `1` as no distortion: values above `1` expand the view
 * outward (barrel), values below `1` pinch it inward. `1.35` is a deliberate
 * outward "punch" that decays back to
 * {@link PHASE_FILTER_BARREL_NEUTRAL_AMOUNT} over
 * {@link PHASE_FILTER_BURST_DURATION_MS}.
 */
export const PHASE_FILTER_BURST_BARREL_AMOUNT = 1.35;

/**
 * Gentle sustained barrel amount while the phase is active.
 *
 * Must stay strictly weaker than {@link PHASE_FILTER_BURST_BARREL_AMOUNT}: the
 * sustained state has to remain comfortable for the whole phase duration, so
 * this is a barely-there 8 % expansion rather than a distortion effect.
 */
export const PHASE_FILTER_SUSTAINED_BARREL_AMOUNT = 1.08;

/**
 * Phaser's neutral barrel amount — `1` means "no distortion".
 *
 * Exported (rather than inlined) so the decay back to neutral is expressed in
 * the engine's own terms and cannot drift from the tunables above.
 */
export const PHASE_FILTER_BARREL_NEUTRAL_AMOUNT = 1;

// ── Structural view of the Phaser filter API ────────────────────────

/**
 * The slice of a Phaser filter controller this module touches.
 *
 * Typed structurally (instead of against `Phaser.Filters.Controller`) so the
 * unit suite can drive the driver with a headless stub filter list; the real
 * engine controllers satisfy it as-is.
 */
export interface CameraFilterController {
  destroy(): void;
}

/** A barrel controller, whose `amount` may be mutated live (no reallocation). */
interface CameraBarrelController extends CameraFilterController {
  amount: number;
}

/**
 * The slice of `Phaser.Filters.FilterList` (camera `internal` space) this
 * module uses. Methods are always called on the engine object itself so their
 * `this` binding stays intact.
 */
interface CameraFilterList {
  list: unknown[];
  remove(filter: CameraFilterController): unknown;
  addPixelate(amount?: number): CameraFilterController;
  addBarrel(amount?: number): CameraBarrelController;
}

/**
 * The driver the player Phase Shift treatment consumes
 * (`phaseShiftJuice.ts`).
 */
export interface PhaseFilterDriver {
  /** Mirrors {@link supportsCameraFilters} for the scene this driver was built on. */
  readonly supported: boolean;
  /** The controllers this driver currently owns (empty when unsupported or cleared). */
  readonly controllers: readonly CameraFilterController[];
  /**
   * Starts the activation distortion burst (pixelate + barrel) if supported.
   *
   * Idempotent while a burst is live, and re-usable after it expires.
   *
   * @returns `true` when a burst is (already) live, `false` when the renderer
   *   does not support camera filters (nothing is allocated in that case).
   */
  applyBurst(): boolean;
  /**
   * Adds the gentle sustained distortion layer if supported.
   *
   * @returns `true` when the layer is (already) applied, `false` when
   *   unsupported (nothing is allocated in that case).
   */
  applySustained(): boolean;
  /**
   * Advances the burst by `dtSeconds` of real time.
   *
   * Mutates the live barrel controller's `amount` in place (no allocation)
   * and tears the burst pair down exactly once when
   * {@link PHASE_FILTER_BURST_DURATION_MS} has elapsed. The sustained layer is
   * never touched here. Non-positive and `NaN` deltas are ignored.
   *
   * @param dtSeconds Frame delta in seconds.
   */
  update(dtSeconds: number): void;
  /**
   * Removes and destroys every controller this driver owns, leaving any
   * pre-existing camera filter untouched. Idempotent.
   */
  clear(): void;
}

// ── Capability probe ───────────────────────────────────────────────

/**
 * Resolves the main camera's `internal` filter list, or `null` when camera
 * filters are unavailable. Total: never throws.
 *
 * A usable list requires **all** of: the WebGL renderer
 * (`scene.game.renderer.type === Phaser.WEBGL`), a main camera, a non-null
 * `camera.filters.internal`, an array `list`, and the `remove` / `addPixelate`
 * / `addBarrel` methods the driver delegates to. Anything else — a stub scene,
 * a missing camera, a canvas renderer, a renderer without `type` — yields
 * `null` so the caller degrades to overlay-only layers.
 *
 * The probe is read-only: it never creates a controller.
 */
function readCameraFilterList(
  scene: Phaser.Scene | null | undefined,
): CameraFilterList | null {
  if (!scene) return null;

  try {
    if (scene.game?.renderer?.type !== Phaser.WEBGL) return null;

    // Structural access: `Phaser.Types.GameObjects.FiltersInternalExternal` is
    // `any` in the shipped typings, so narrow it explicitly here.
    const cameras = scene.cameras as unknown as
      | { main?: { filters?: { internal?: unknown } | null } | null }
      | undefined;
    const internal = cameras?.main?.filters?.internal as
      | Partial<CameraFilterList>
      | null
      | undefined;

    if (!internal) return null;
    if (!Array.isArray(internal.list)) return null;
    if (typeof internal.remove !== 'function') return null;
    if (typeof internal.addPixelate !== 'function') return null;
    if (typeof internal.addBarrel !== 'function') return null;

    return internal as CameraFilterList;
  } catch {
    // A partial stub (or a renderer that rejects the access) is "unsupported",
    // never a hard failure: headless and canvas builds must keep running.
    return null;
  }
}

/**
 * Reports whether this scene can render camera filters.
 *
 * `true` only for a WebGL renderer whose main camera exposes a usable
 * `internal` filter list (see {@link readCameraFilterList}); `false` for
 * every other scene, without throwing.
 *
 * @param scene Scene to probe (a partial stub is accepted and reports `false`).
 */
export function supportsCameraFilters(scene: Phaser.Scene): boolean {
  return readCameraFilterList(scene) !== null;
}

// ── Driver ─────────────────────────────────────────────────────────

/**
 * Creates the guarded camera-filter driver for `scene`.
 *
 * The driver binds the scene's main-camera `internal` filter list **once**, at
 * construction, and owns every controller it creates from then on. On an
 * unsupported scene it stays a documented no-op: `supported` is `false`,
 * `controllers` stays empty, `applyBurst()` / `applySustained()` return
 * `false`, and `update()` / `clear()` do nothing (no allocation, no throw).
 *
 * Cleanup is the caller's responsibility by design (no scene event wiring
 * here): call `clear()` on the falling edge of whatever effect applied the
 * layers, and on scene `SHUTDOWN`.
 *
 * @param scene Scene whose main camera should receive the filters.
 */
export function createPhaseFilterDriver(scene: Phaser.Scene): PhaseFilterDriver {
  const filterList = readCameraFilterList(scene);
  const supported = filterList !== null;

  /** Every controller this driver currently owns (the `controllers` view). */
  const owned: CameraFilterController[] = [];
  /** The live activation-burst pair (empty when no burst is running). */
  const burst: CameraFilterController[] = [];
  let burstBarrel: CameraBarrelController | null = null;
  let burstElapsedMs = 0;
  let sustained: CameraFilterController | null = null;

  /** Detaches one owned controller from the list and from the owned set. */
  const releaseController = (controller: CameraFilterController): void => {
    const index = owned.indexOf(controller);
    if (index >= 0) owned.splice(index, 1);
    // `FilterList.remove` both detaches and destroys; it is tolerant of a
    // controller that is no longer in the list.
    filterList?.remove(controller);
  };

  /** Tears the burst pair down exactly once and resets its state. */
  const endBurst = (): void => {
    const controllers = burst.splice(0, burst.length);
    burstBarrel = null;
    burstElapsedMs = 0;
    for (const controller of controllers) releaseController(controller);
  };

  const applyBurst = (): boolean => {
    if (!filterList) return false;
    if (burst.length > 0) return true;

    const pixelate = filterList.addPixelate(PHASE_FILTER_BURST_PIXELATE_SIZE);
    const barrel = filterList.addBarrel(PHASE_FILTER_BURST_BARREL_AMOUNT);
    burst.push(pixelate, barrel);
    owned.push(pixelate, barrel);
    burstBarrel = barrel;
    burstElapsedMs = 0;
    return true;
  };

  const applySustained = (): boolean => {
    if (!filterList) return false;
    if (sustained) return true;

    const barrel = filterList.addBarrel(PHASE_FILTER_SUSTAINED_BARREL_AMOUNT);
    sustained = barrel;
    owned.push(barrel);
    return true;
  };

  const update = (dtSeconds: number): void => {
    if (!filterList || burst.length === 0) return;
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return;

    burstElapsedMs += dtSeconds * 1000;
    if (burstElapsedMs >= PHASE_FILTER_BURST_DURATION_MS) {
      endBurst();
      return;
    }

    if (burstBarrel) {
      // Decay the *distortion offset* (not the raw amount) to zero, so the
      // controller settles on Phaser's neutral barrel value (1 = no
      // distortion) exactly as the burst expires instead of snapping there.
      const remaining = 1 - burstElapsedMs / PHASE_FILTER_BURST_DURATION_MS;
      burstBarrel.amount =
        PHASE_FILTER_BARREL_NEUTRAL_AMOUNT +
        (PHASE_FILTER_BURST_BARREL_AMOUNT - PHASE_FILTER_BARREL_NEUTRAL_AMOUNT) * remaining;
    }
  };

  const clear = (): void => {
    const controllers = owned.splice(0, owned.length);
    burst.length = 0;
    burstBarrel = null;
    burstElapsedMs = 0;
    sustained = null;
    if (!filterList) return;
    for (const controller of controllers) filterList.remove(controller);
  };

  return {
    get supported() {
      return supported;
    },
    get controllers() {
      return owned;
    },
    applyBurst,
    applySustained,
    update,
    clear,
  };
}
