/**
 * Shared deterministic test fixtures for the visible collector-drone path
 * (parent AH-0MV9G113S009B37I, leading task AH-0MVBMPYPB004RP0P).
 *
 * This module is **test infrastructure only** — nothing here is imported by
 * production code. It exists so the downstream drone items (level variables,
 * `MysteryUfoDrone` entity, shared-core lifecycle pass, spawn wiring,
 * gym parity) can write focused, non-duplicated tests without re-inventing:
 *
 * - {@link resolveSeededMineralPositions} / {@link createSeededMineralField}
 *   build a deterministic mineral field, always placed clear of the ship
 *   start, so a seeker never begins by instantly vacuuming a mineral;
 * - {@link createSteppedClock} provides a stepped/mock clock for the
 *   permanent-spawn-timer and lifetime tests (parent AC4);
 * - {@link createMysteryUfoDrop} manufactures a `mystery_ufo` drop that the
 *   shared drop path can collect, so pickup tests drive the same seam the
 *   game and every gym use.
 *
 * ## UFO feel verification seams (AH-0MVSAJJ8F000ZD5Q)
 *
 * The feel slices of parent AH-0MVI4J8R4002WTT6 are verified through the
 * seams below, laid down before any behaviour lands:
 *
 * - {@link installUfoCueRecorder} / {@link UfoCueRecorder} records every cue
 *   dispatch — warble start/stop, reward, destroy and mineral tinkle included
 *   — in call order, through an injected recording playback provider. No
 *   `AudioContext` is ever constructed. The recorder observes the **shared
 *   cue-dispatch path** (`src/audio/effects.ts` → cue manifest → provider),
 *   so it starts recording the UFO cues the moment the ToneForge bake
 *   (AH-0MVSAJMLL00835T8) adds them to the manifest; no `vi.mock` of wrappers
 *   that do not exist yet is needed.
 * - {@link getDroneVfxCounts} / {@link resetDroneVfxCounts} (re-exported from
 *   `src/vfx/droneVfxCounts.ts`) expose the per-moment saucer VFX spawn
 *   counters — launch poof, collect sparkle, return trail and destruction —
 *   following the `getExplosionVfxCounts` / `resetExplosionVfxCounts`
 *   pattern, so a test can reset them between cases.
 * - {@link expectUfoPayoutLifecycle} / {@link expectUfoDestructionLifecycle}
 *   assert one drone's lifecycle feedback (payout success, enemy destruction).
 *   Their default expectation is today's **zero-feedback baseline** — the
 *   drone is silent and spawns no VFX — and later slices extend the helper
 *   call with {@link UFO_PAYOUT_CUE_SEQUENCE} /
 *   {@link UFO_DESTRUCTION_CUE_SEQUENCE} plus VFX counts via
 *   {@link UfoLifecycleExpectation}.
 *
 * ## Test matrix (parent ACs of AH-0MV9G113S009B37I → verifying test)
 *
 * | Parent AC | Behaviour pinned | Verifying test | Lands in |
 * |---|---|---|---|
 * | AC1 | field pickup spawns one drone, never a direct instant mineral payout | `effects.test.ts` mystery_ufo group (survivor contract) + spawn-seam unit test | this item (survivor reframe) + AH-0MVBMQ04X0051002 |
 * | AC2 | seek → collect → return → pay out; lifetime/capacity termination | `MysteryUfoDrone.test.ts` / `src/scenes/core/combatDrone.test.ts` (shared-core) | AH-0MVBMPZFE00382DA, AH-0MVBMPZS90038715 |
 * | AC3 | lifetime/capacity/radius/spawn-interval resolve on the shared curve, monotonic | `powerUpLevels.test.ts` new-axis + monotonic tests | AH-0MVBMPZ2C0008VAE |
 * | AC4 | permanent timer fires at the resolved interval; field pickup spawns exactly one drone | `effects.test.ts` / `CombatCoreScene.test.ts` mock-clock test (`createSteppedClock`) | AH-0MVBMQ04X0051002 |
 * | AC5 | enemy bullet / enemy body destroy; player fire passes through; minerals + 2×level drop | shared-core destruction test | AH-0MVBMPZS90038715 |
 * | AC6 | one shared implementation in `PlayScene` + `GymPowerUpsUtility`; equivalence + gym-parity-docs green | `CombatScene.equivalence.test.ts`, `gymParityDocs.test.ts`, `GymPowerUpsUtility.test.ts` | AH-0MVBMQ0HR0064THH |
 * | AC7 | docs (research §8, GDD catalogue, README, help/HUD) | docs + HUD copy checks | AH-0MVBMQ0UT007O2MX |
 * | AC8 | full project suite passes after the drone lands | `/skill:test` full-suite gate | AH-0MVBMRS4K000TTTP |
 *
 * Fixture → feature consumption: the mineral field is consumed by the
 * seek/collect/destruction tests (AC2/AC5); the stepped clock by the
 * permanent-timer test (AC4); the drop manufacture by the pickup tests
 * (AC1/AC4) and the gym lifecycle test (AC6).
 *
 * @module test/collectorDroneFixtures
 */

import Phaser from 'phaser';
import { expect } from 'vitest';

import {
  GAME_HEIGHT,
  GAME_WIDTH,
  PLAYER_SPAWN,
  POWER_UP_DROP_SIZE,
} from '../core/constants';
import { createSeededRng } from '../core/rng';
import { Mineral } from '../entities/Mineral';
import { PowerUp } from '../powerups/PowerUp';
import { drawPowerUpDrop } from '../powerups/icons';
import { bootScene } from './gameHarness';
import { RecordingSfxProvider } from './audioTestDouble';
import { _resetAudioContextForTests, setSfxSoundProvider } from '../audio/effects';
import {
  CONTROL_CUES,
  CUE_MANIFEST,
  assetUrlFor,
  bakedAssetFiles,
} from '../audio/cueManifest';
import type { SfxPlayOptions, SfxSoundHandle } from '../audio/sfxPlayback';
import {
  DRONE_VFX_MOMENTS,
  getDroneVfxCounts,
  recordDroneVfxSpawn,
  resetDroneVfxCounts,
  type DroneVfxCounts,
} from '../vfx/droneVfxCounts';

// The saucer VFX counters are production-owned (the VFX slice records into
// them); the shared fixtures re-export them so tests have one import surface.
export {
  DRONE_VFX_MOMENTS,
  getDroneVfxCounts,
  recordDroneVfxSpawn,
  resetDroneVfxCounts,
};
export type { DroneVfxCounts };

// ── Seeded mineral-field builder ────────────────────────────────────

/**
 * Default clearance between a seeded mineral and the ship start, matching
 * the gym mineral-field convention (`MINERAL_SEED_CLEARANCE = 60`): a field
 * mineral is never silently collected the moment the scene opens, and the
 * ring stays inside the play area from the centre (PLAYER_SPAWN is centred).
 */
export const COLLECTOR_DRONE_MINERAL_CLEARANCE = 60;

/** Play-area margins kept clear for the seeded field (mirrors the gyms). */
const HUD_TOP_MARGIN = 20;
const EDGE_MARGIN = 20;
const BOTTOM_MARGIN = 120;

/** Options controlling where the seeded mineral field is placed. */
export interface SeededMineralFieldOptions {
  /** Number of minerals to place (default 8). */
  count?: number;
  /** Seed for the deterministic RNG (default 1). */
  seed?: number;
  /** Position the field must keep clear of (default the ship start). */
  clearOf?: { x: number; y: number };
  /** Minimum distance (px) between every mineral and `clearOf`. */
  clearance?: number;
  /** Explicit sampling bounds (defaults to the play area minus margins). */
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
}

/** Resolved play-area bounds used when `options.bounds` is omitted. */
export const DEFAULT_MINERAL_FIELD_BOUNDS = {
  minX: EDGE_MARGIN,
  maxX: GAME_WIDTH - EDGE_MARGIN,
  minY: HUD_TOP_MARGIN,
  maxY: GAME_HEIGHT - BOTTOM_MARGIN,
} as const;

/**
 * Resolves a deterministic set of mineral-field positions from the seed,
 * each at least `clearance` px from `clearOf` and inside `bounds`.
 *
 * A sample that lands inside the clearance disc is pushed radially out
 * onto the clearance ring (deterministic, always in bounds — mirrors the
 * gym `seedMinerals` push-out), so callers never need to re-draw and the
 * returned positions are reproducible for a given seed.
 *
 * @param options - Field options (see {@link SeededMineralFieldOptions}).
 * @returns `count` positions in deterministic order.
 */
export function resolveSeededMineralPositions(
  options: SeededMineralFieldOptions = {},
): Array<{ x: number; y: number }> {
  const count = options.count ?? 8;
  const seed = options.seed ?? 1;
  const clearOf = options.clearOf ?? PLAYER_SPAWN;
  const clearance = options.clearance ?? COLLECTOR_DRONE_MINERAL_CLEARANCE;
  const bounds = options.bounds ?? DEFAULT_MINERAL_FIELD_BOUNDS;
  const rng = createSeededRng(seed);

  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
    const y = bounds.minY + rng() * (bounds.maxY - bounds.minY);
    const distance = Math.hypot(x - clearOf.x, y - clearOf.y);
    // Push a too-close sample radially out onto the clearance ring instead
    // of re-drawing: deterministic, and in bounds because the ring radius
    // stays below the nearest play-area edge from `clearOf`.
    let px = x;
    let py = y;
    if (distance < clearance) {
      if (distance === 0) {
        px = clearOf.x + clearance;
      } else {
        const scale = clearance / distance;
        px = clearOf.x + (x - clearOf.x) * scale;
        py = clearOf.y + (y - clearOf.y) * scale;
      }
    }
    positions.push({ x: px, y: py });
  }
  return positions;
}

/**
 * Independent clearance oracle: whether a point lies at least `clearance`
 * px from `clearOf`. Kept separate from the builder so tests assert the
 * field against an expectation, not the builder's own math.
 */
export function isClearOf(
  point: { x: number; y: number },
  clearOf: { x: number; y: number },
  clearance: number = COLLECTOR_DRONE_MINERAL_CLEARANCE,
): boolean {
  return Math.hypot(point.x - clearOf.x, point.y - clearOf.y) >= clearance;
}

/**
 * Creates `count` live `Mineral`s in `scene` at the deterministic seeded
 * positions (see {@link resolveSeededMineralPositions}). Callers must
 * `game.destroy()` after use.
 *
 * @param scene   - A booted Phaser scene that will own the minerals.
 * @param options - Field options (see {@link SeededMineralFieldOptions}).
 * @returns The created `Mineral` entities (positions mirror the solver).
 */
export function createSeededMineralField(
  scene: Phaser.Scene,
  options: SeededMineralFieldOptions = {},
): Mineral[] {
  const positions = resolveSeededMineralPositions(options);
  return positions.map(
    ({ x, y }) => new Mineral(scene, { x, y }),
  );
}

// ── Stepped / mock clock ────────────────────────────────────────────

/** A deterministic stepped clock sized in seconds for simulation tests. */
export interface SteppedClock {
  /** Current simulated time in seconds. */
  now(): number;
  /** Advances the clock by `dt` seconds and returns the new time. */
  advance(dt: number): number;
  /** Advances one fixed step (default 1/60 s) and returns that dt. */
  step(): number;
  /**
   * Runs `onTick(now)` every fixed step until `seconds` of simulated time
   * have elapsed — the "stepped update" driving the permanent-timer and
   * lifetime assertions (parent AC4). Returns the new clock time.
   */
  run(seconds: number, onTick: (now: number) => void): number;
  /** Resets the clock to zero. */
  reset(): void;
}

/**
 * Creates a stepped/mock clock for timer tests.
 *
 * Time only advances through explicit `advance`/`step`/`run` calls, so a
 * permanent spawn timer, lifetime counter or recharge timer can be driven
 * deterministically without a wall clock or a live Phaser loop.
 *
 * @param stepSeconds - Fixed step size (default 1/60 s ≈ one frame).
 * @returns A `SteppedClock`.
 */
export function createSteppedClock(stepSeconds = 1 / 60): SteppedClock {
  let elapsed = 0;
  return {
    now: () => elapsed,
    advance: (dt: number) => {
      elapsed += dt;
      return elapsed;
    },
    step: () => {
      elapsed += stepSeconds;
      return stepSeconds;
    },
    run: (seconds: number, onTick: (now: number) => void) => {
      const steps = Math.max(0, Math.ceil(seconds / stepSeconds));
      for (let i = 0; i < steps; i += 1) {
        elapsed += stepSeconds;
        onTick(elapsed);
      }
      return elapsed;
    },
    reset: () => {
      elapsed = 0;
    },
  };
}

// ── Mystery UFO drop manufacture ────────────────────────────────────

/** Structural shape of a manufactured `mystery_ufo` drop (mirrors the gym's
 * `ActiveDrop`: lifecycle + position + visuals + unified drop id). */
export interface MysteryUfoDrop {
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** Graphics rendering the glowing bubble + saucer icon (scaled by lifecycle). */
  graphics: Phaser.GameObjects.Graphics;
  /** The drop's grow/hold/shrink/collect lifecycle. */
  powerUp: PowerUp;
  /** Unified drop id the shared collect path dispatches on. */
  dropId: 'mystery_ufo';
  /** True once collected and playing its absorb VFX. */
  absorbing?: boolean;
}

/**
 * Manufactures a `mystery_ufo` drop at `(x, y)`, constructed exactly like
 * the gym's `_spawnDrop` (bubble + saucer icon drawn in local space,
 * starting at scale 0). The drop satisfies the shared `DropLifecycleDrop`
 * seam, so a test can collect it through the same code the game and every
 * gym use (`collectOverlappingDrops` / the scene's collect step).
 *
 * @param scene - The scene owning the drop's graphics.
 * @param x     - World x position (px).
 * @param y     - World y position (px).
 * @returns The manufactured drop.
 */
export function createMysteryUfoDrop(
  scene: Phaser.Scene,
  x: number,
  y: number,
): MysteryUfoDrop {
  const graphics = scene.add.graphics();
  graphics.setPosition(x, y);
  drawPowerUpDrop(graphics, 'mystery_ufo', 0, 0, POWER_UP_DROP_SIZE);
  graphics.setScale(0);
  return { x, y, graphics, dropId: 'mystery_ufo', powerUp: new PowerUp('mystery_ufo') };
}

/**
 * Advances `drop`'s lifecycle until it is collectible (past the grow phase),
 * so pickup tests can drive the real shared collection gate without
 * hand-advancing a loop everywhere. Returns the same drop for chaining.
 *
 * @param drop  - The manufactured drop to mature.
 * @param dt    - Lifecycle step in seconds (default 0.05 s, like the gym tests).
 * @param steps - Max steps (default 40 → 2 s, comfortably past grow 0.5 s).
 * @returns The same drop, now collectible.
 */
export function makeDropCollectible(
  drop: MysteryUfoDrop,
  dt = 0.05,
  steps = 40,
): MysteryUfoDrop {
  for (let i = 0; i < steps; i += 1) {
    drop.powerUp.advance(dt);
  }
  return drop;
}

// ── UFO feel cue recorder ───────────────────────────────────────────

/**
 * The UFO feel cue wrappers the recorder understands.
 *
 * These are the wrapper names the feel slices add to `src/audio/effects.ts`
 * (AH-0MVSAJMLL00835T8); recording keys on the exported wrapper name resolved
 * from the cue manifest, so the seam needs no import of a wrapper that does
 * not exist yet.
 */
export const UFO_CUES = {
  /** Continuous "woo-woo-woo" warble start. */
  warble: 'playMysteryUfoWarbleSound',
  /** Warble stop control companion (must be listed in the manifest `controlCues`). */
  stopWarble: 'stopMysteryUfoWarbleSound',
  /** Reward fanfare on payout. */
  reward: 'playMysteryUfoRewardSound',
  /** Destruction explosion cue. */
  destroy: 'playMysteryUfoDestroySound',
  /** Mineral "tinkle" in sync with the destruction spill. */
  tinkle: 'playMineralTinkleSound',
} as const;

/** One UFO cue wrapper name (see {@link UFO_CUES}). */
export type UfoCueWrapper = (typeof UFO_CUES)[keyof typeof UFO_CUES];

/** The lifecycle feedback vocabulary the sequence helpers assert on. */
export type UfoFeedbackEventName =
  | 'warble-start'
  | 'warble-stop'
  | 'reward'
  | 'destroy'
  | 'tinkle';

/** Cue-wrapper name → lifecycle feedback event name. */
const UFO_EVENT_NAME_BY_CUE: Readonly<Record<string, UfoFeedbackEventName>> = {
  [UFO_CUES.warble]: 'warble-start',
  [UFO_CUES.stopWarble]: 'warble-stop',
  [UFO_CUES.reward]: 'reward',
  [UFO_CUES.destroy]: 'destroy',
  [UFO_CUES.tinkle]: 'tinkle',
};

/**
 * The target cue order for a successful sortie (payout), documented here so
 * the warble and terminal-feedback slices assert one canonical sequence.
 *
 * The warble starts at spawn, stops when the return leg begins, and the reward
 * fanfare lands with the pay-in. Not asserted until those slices land —
 * today's baseline is no feedback at all.
 */
export const UFO_PAYOUT_CUE_SEQUENCE: readonly UfoFeedbackEventName[] = [
  'warble-start',
  'warble-stop',
  'reward',
];

/**
 * The target cue order for an enemy-destroyed sortie, documented here so the
 * warble and terminal-feedback slices assert one canonical sequence.
 *
 * The warble starts at spawn, stops as the drone dies, then the explosion cue
 * and the mineral tinkle fire with the spill.
 */
export const UFO_DESTRUCTION_CUE_SEQUENCE: readonly UfoFeedbackEventName[] = [
  'warble-start',
  'warble-stop',
  'destroy',
  'tinkle',
];

/**
 * Cue-wrapper name for a baked asset URL: the inverse of the cue manifest,
 * covering every baked seed variant. `undefined` for an unmapped URL (e.g. a
 * runtime-shim voice, which never reaches a provider).
 *
 * A URL is only unambiguous when one cue owns the recipe; when several cues
 * share a recipe (e.g. `playPlayerDestructionSound` / `playVolumeFeedback`)
 * the last manifest entry wins. The four UFO cues each own their recipe, so
 * their resolution is exact.
 */
const CUE_BY_ASSET_URL: ReadonlyMap<string, string> = (() => {
  const byUrl = new Map<string, string>();
  for (const entry of CUE_MANIFEST) {
    const files = bakedAssetFiles(entry);
    if (files.length === 0) {
      byUrl.set(assetUrlFor(entry), entry.cue);
      continue;
    }
    for (const file of files) byUrl.set(file, entry.cue);
  }
  return byUrl;
})();

/**
 * The stop control companion for a continuous cue wrapper (`playDiveSound` →
 * `stopDiveSound`), or `undefined` when the cue has no control companion.
 */
function controlCompanionFor(cue: string): string | undefined {
  const companion = cue.replace(/^play/, 'stop');
  return companion !== cue && CONTROL_CUES.includes(companion)
    ? companion
    : undefined;
}

/** A single cue dispatch observed by {@link UfoCueRecorder}. */
export interface RecordedCueEvent {
  /** 0-based dispatch order across the whole recorder log. */
  readonly order: number;
  /** Exported wrapper that produced the dispatch (raw URL when unmapped). */
  readonly cue: string;
  /** Baked asset URL dispatched through the playback provider. */
  readonly url: string;
  /** `play` = a wrapper started a cue; `stop` = a returned handle stopped. */
  readonly kind: 'play' | 'stop';
  /** Whether the wrapper asked the provider to loop the asset. */
  readonly loop: boolean;
}

/**
 * Recording playback provider for the UFO feel cues (and every other cue).
 *
 * Inject it with {@link installUfoCueRecorder} and assert on {@link events}:
 * the log is ordered by dispatch, resolves each call to its cue wrapper through
 * the manifest, and pairs a stopped handle back to the cue it started. It never
 * constructs an `AudioContext` — it extends the shared
 * {@link RecordingSfxProvider} double, so sound is a pure no-op.
 */
export class UfoCueRecorder extends RecordingSfxProvider {
  /** Every recorded cue dispatch, in call order. */
  readonly events: RecordedCueEvent[] = [];

  override play(url: string, options: SfxPlayOptions = {}): SfxSoundHandle {
    // Keep the shared double's own log (`plays`), then record the ordered
    // cue-level event so start/stop pairing is observable.
    const handle = super.play(url, options);
    const cue = CUE_BY_ASSET_URL.get(url) ?? url;
    const loop = options.loop ?? false;
    this.events.push({
      order: this.events.length,
      cue,
      url,
      kind: 'play',
      loop,
    });
    return {
      stop: () => {
        handle.stop();
        this.events.push({
          order: this.events.length,
          cue: controlCompanionFor(cue) ?? cue,
          url,
          kind: 'stop',
          loop,
        });
      },
    };
  }

  /** Every UFO feel cue event (warble/reward/destroy/tinkle), in call order. */
  ufoEvents(): RecordedCueEvent[] {
    return this.events.filter(
      (event) => UFO_EVENT_NAME_BY_CUE[event.cue] !== undefined,
    );
  }

  /** The UFO feel event names, in dispatch order. */
  ufoEventNames(): UfoFeedbackEventName[] {
    return this.ufoEvents().map(
      (event) => UFO_EVENT_NAME_BY_CUE[event.cue] as UfoFeedbackEventName,
    );
  }

  /** Clears the recorded dispatches (counts and cue events). */
  override reset(): void {
    super.reset();
    this.events.length = 0;
  }

  /**
   * Uninstalls the recorder: restores the default playback provider and
   * clears the shared cue-layer test state (voice limiter, continuous-cue
   * handles). Safe to call more than once.
   */
  dispose(): void {
    _resetAudioContextForTests();
  }
}

/**
 * Installs a fresh {@link UfoCueRecorder} as the shared playback provider and
 * returns it. Pair with `recorder.dispose()` in `afterEach`.
 *
 * @returns The installed recorder.
 */
export function installUfoCueRecorder(): UfoCueRecorder {
  // Start every case from clean cue-layer state: the limiter and any
  // continuous-cue handle must not leak a previous test's playback into this
  // one (`_resetAudioContextForTests` restores the default provider too).
  _resetAudioContextForTests();
  const recorder = new UfoCueRecorder();
  setSfxSoundProvider(recorder);
  return recorder;
}

// ── UFO lifecycle feedback + sequence assertions ────────────────────

/** One drone lifecycle's observed feedback: cue events and VFX spawn counts. */
export interface UfoLifecycleFeedback {
  /** UFO feel events, in dispatch order. */
  readonly cues: readonly UfoFeedbackEventName[];
  /** Per-moment VFX spawn counts at capture time. */
  readonly vfx: DroneVfxCounts;
}

/**
 * Captures the current UFO feedback: the recorder's cue events plus a VFX
 * count snapshot.
 */
export function captureUfoLifecycleFeedback(
  recorder: UfoCueRecorder,
): UfoLifecycleFeedback {
  return { cues: recorder.ufoEventNames(), vfx: getDroneVfxCounts() };
}

/**
 * What a lifecycle sequence is expected to observe.
 *
 * Omitted fields mean **today's zero-feedback baseline**: no cue and no VFX.
 * A slice that adds feedback passes the observed expectation, e.g.
 * `{ cues: UFO_PAYOUT_CUE_SEQUENCE, vfx: { returnTrail: 1 } }`.
 */
export interface UfoLifecycleExpectation {
  /** Expected cues in dispatch order (default: none). */
  readonly cues?: readonly UfoFeedbackEventName[];
  /** Expected VFX spawn count per moment (default: every moment zero). */
  readonly vfx?: Partial<DroneVfxCounts>;
}

/** The one-shot cues a single lifecycle may fire at most once. */
const ONE_SHOT_CUES = ['reward', 'destroy', 'tinkle'] as const;

/**
 * Asserts one drone lifecycle's feedback.
 *
 * Always checks the structural invariants (only sequence-appropriate cues,
 * the warble starts before it stops and never twice, one-shots fire at most
 * once), then asserts the exact cue sequence and VFX counts against
 * `expectation` — whose defaults are the documented silent baseline.
 */
function expectUfoFeedbackSequence(
  label: string,
  feedback: UfoLifecycleFeedback,
  allowed: readonly UfoFeedbackEventName[],
  expectation: UfoLifecycleExpectation,
): void {
  const { cues } = feedback;
  const sequence = cues.length === 0 ? '(silent)' : cues.join(' → ');

  for (const name of cues) {
    if (!allowed.includes(name)) {
      throw new Error(
        `${label}: unexpected '${name}' feedback (${sequence}); ` +
          `allowed events: ${allowed.join(', ')}`,
      );
    }
  }

  const startIndex = cues.indexOf('warble-start');
  const stopIndex = cues.indexOf('warble-stop');
  if (stopIndex !== -1 && (startIndex === -1 || stopIndex < startIndex)) {
    throw new Error(`${label}: warble stopped before it started (${sequence})`);
  }
  if (cues.filter((name) => name === 'warble-start').length > 1) {
    throw new Error(`${label}: warble started more than once (${sequence})`);
  }
  if (cues.filter((name) => name === 'warble-stop').length > 1) {
    throw new Error(`${label}: warble stopped more than once (${sequence})`);
  }
  for (const oneShot of ONE_SHOT_CUES) {
    if (cues.filter((name) => name === oneShot).length > 1) {
      throw new Error(`${label}: '${oneShot}' fired more than once (${sequence})`);
    }
  }

  expect(cues, `${label}: cue sequence`).toEqual([...(expectation.cues ?? [])]);

  for (const moment of DRONE_VFX_MOMENTS) {
    expect(feedback.vfx[moment], `${label}: ${moment} spawn count`).toBe(
      expectation.vfx?.[moment] ?? 0,
    );
  }
}

/**
 * Asserts the feedback of one **successful sortie** (spawn → collect → return
 * → payout).
 *
 * Pass the expectation once the feel slices land; with no expectation it
 * pins today's silent baseline (no cue, no VFX).
 */
export function expectUfoPayoutLifecycle(
  feedback: UfoLifecycleFeedback,
  expectation: UfoLifecycleExpectation = {},
): void {
  expectUfoFeedbackSequence(
    'payout lifecycle',
    feedback,
    UFO_PAYOUT_CUE_SEQUENCE,
    expectation,
  );
}

/**
 * Asserts the feedback of one **enemy-destroyed sortie** (spawn → destroyed).
 *
 * Pass the expectation once the feel slices land; with no expectation it
 * pins today's silent baseline (no cue, no VFX).
 */
export function expectUfoDestructionLifecycle(
  feedback: UfoLifecycleFeedback,
  expectation: UfoLifecycleExpectation = {},
): void {
  expectUfoFeedbackSequence(
    'destruction lifecycle',
    feedback,
    UFO_DESTRUCTION_CUE_SEQUENCE,
    expectation,
  );
}

// ── Boot harness for fixture smoke tests ────────────────────────────

/** A booted game plus its typed harness scene (caller destroys the game). */
export interface BootedCollectorDroneScene {
  game: Phaser.Game;
  scene: HarnessScene;
}

/** Minimal scene used to own minerals/drop graphics in fixture tests. */
export class HarnessScene extends Phaser.Scene {
  constructor() {
    super('CollectorDroneHarnessScene');
  }
}

/**
 * Boots a `HarnessScene` through the shared game harness.
 *
 * @returns The booted game and its harness scene.
 */
export async function bootCollectorDroneScene(): Promise<BootedCollectorDroneScene> {
  const booted = await bootScene([HarnessScene]);
  return { game: booted.game, scene: booted.scene as unknown as HarnessScene };
}
