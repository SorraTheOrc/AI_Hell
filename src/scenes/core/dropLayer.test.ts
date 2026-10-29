/**
 * Unit tests for the shared power-up drop layer (AH-0MUII3CXX0023H24, AC1–AC4).
 *
 * These exercise the pure helpers directly with structural doubles, so the
 * lifecycle/collection/magnet/cue rules are pinned independently of any
 * scene. Cross-scene behavioural equivalence lives in
 * `CombatScene.equivalence.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as effects from '../../audio/effects';
import { POWER_UP_DROP_SIZE } from '../../core/constants';
import { DEFAULT_RULES } from '../../core/rules';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { WeightedRandomSpawner } from '../../powerups/spawner';
import {
  isWithinSlotPool,
  resolveSlotState,
  type PowerUpSlotState,
} from '../../powerups/slots';
import {
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  type DropId,
  type PowerUpId,
} from '../../powerups/types';
import { dropCollectRadius } from '../../powerups/icons';
import * as dropLayerModule from './dropLayer';
import {
  advanceDropLifecycles,
  applyDropMagnet,
  buildDefaultDropSpawner,
  collectOverlappingDrops,
  playDropPickupCue,
  type DropLifecycleDrop,
} from './dropLayer';

/** A drop double with a real PowerUp lifecycle and spied Graphics. */
function makeDrop(
  overrides: Partial<{
    x: number;
    y: number;
    scale: number;
    state: PowerUpState;
    absorbing: boolean;
  }> = {},
): {
  drop: DropLifecycleDrop;
  graphics: { setPosition: ReturnType<typeof vi.fn>; setScale: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> };
  powerUp: PowerUp;
} {
  const powerUp = new PowerUp('speed_boost');
  if (overrides.scale !== undefined) powerUp.currentScale = overrides.scale;
  if (overrides.state !== undefined) powerUp.state = overrides.state;
  const graphics = {
    setPosition: vi.fn(),
    setScale: vi.fn(),
    destroy: vi.fn(),
  };
  const drop: DropLifecycleDrop = {
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    graphics,
    powerUp,
    absorbing: overrides.absorbing,
  };
  return { drop, graphics, powerUp };
}

describe('dropLayer — buildDefaultDropSpawner (AC1)', () => {
  it('builds a weighted spawner over the combined power-up + weapon pool with the configured weights', () => {
    const spawner = buildDefaultDropSpawner(
      DEFAULT_RULES.powerUpWeights,
      DEFAULT_RULES.weaponWeights,
      () => 0,
    );
    const weights = (spawner as WeightedRandomSpawner<DropId>).getWeights();
    for (const id of ['shield', 'bomb', 'speed_boost', 'phase_shift', 'teleport', 'extra_life', 'magnet'] as const) {
      expect(weights[id]).toBe(DEFAULT_RULES.powerUpWeights[id]);
    }
    for (const id of ['spread', 'dual', 'rapid', 'reset'] as const) {
      expect(weights[id]).toBe(DEFAULT_RULES.weaponWeights[id]);
    }
    // Deterministic rng 0 selects the first pool entry.
    expect(spawner.next()).toBe('shield');
  });

  it('gives P8 Extra Life a ≈ 3/58 share of power-up draws', () => {
    // Deterministic sweep RNG: sample evenly across [0, 1) so each id's count
    // is exactly proportional to its weight — no statistical noise and no seed
    // dependence. The sample count is a multiple of the combined pool weight
    // (58 power-up + 22 weapon = 80), so every band boundary lands exactly.
    const weightTotal = Object.values(DEFAULT_RULES.powerUpWeights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(weightTotal).toBe(58);
    const SAMPLE_COUNT = 80_000;
    let cursor = 0;
    const sweepRng = () => cursor++ / SAMPLE_COUNT;
    const spawner = buildDefaultDropSpawner(
      DEFAULT_RULES.powerUpWeights,
      DEFAULT_RULES.weaponWeights,
      sweepRng,
    );

    let powerUps = 0;
    let extraLives = 0;
    for (let n = 0; n < SAMPLE_COUNT; n++) {
      const id = spawner.next();
      if ((WEAPON_DROP_IDS as readonly DropId[]).includes(id)) continue;
      powerUps += 1;
      if (id === 'extra_life') extraLives += 1;
    }

    // Extra Life weight 3 of the 58 total power-up weight → exactly 3/58.
    const p8Share = extraLives / powerUps;
    expect(p8Share).toBeCloseTo(3 / 58, 3);
    // Tied to the shipped weight table (not a hard-coded expectation).
    expect(p8Share).toBeCloseTo(DEFAULT_RULES.powerUpWeights.extra_life / weightTotal, 3);
    // Relative weight tripled (1 → 3): ≈ 1.3× the former 1/25 normalised share
    // (the Mineral Scoop, Smart Bomb, Force Field, Mystery UFO and the five
    // net-new power-ups widen the denominator from 27 to 58).
    expect(p8Share / (1 / 25)).toBeCloseTo((3 / 58) / (1 / 25), 2);
  });
});

describe('dropLayer — advanceDropLifecycles (AC1)', () => {
  it('advances the lifecycle, syncs the graphics scale and keeps live drops', () => {
    const { drop, graphics, powerUp } = makeDrop();
    const kept = advanceDropLifecycles([drop], 0.25);

    expect(kept).toEqual([drop]);
    expect(powerUp.currentScale).toBeCloseTo(0.5, 5);
    expect(graphics.setScale).toHaveBeenCalledWith(powerUp.currentScale);
    expect(graphics.destroy).not.toHaveBeenCalled();
  });

  it('destroys despawned Graphics, drops them and runs the despawn hook once', () => {
    const powerUp = new PowerUp('speed_boost', 0.1, 0.1, 0.3);
    const graphics = { setPosition: vi.fn(), setScale: vi.fn(), destroy: vi.fn() };
    const drop: DropLifecycleDrop = { x: 0, y: 0, graphics, powerUp };
    const onDespawn = vi.fn();

    const kept = advanceDropLifecycles([drop], 0.5, onDespawn);

    expect(kept).toEqual([]);
    expect(powerUp.state).toBe(PowerUpState.DESPAWNED);
    expect(onDespawn).toHaveBeenCalledTimes(1);
    expect(onDespawn).toHaveBeenCalledWith(drop);
    expect(graphics.destroy).toHaveBeenCalledTimes(1);
  });

  it('skips absorbing drops (owned by their absorb animation)', () => {
    const { drop, graphics } = makeDrop({ absorbing: true });
    const kept = advanceDropLifecycles([drop], 0.5);
    expect(kept).toEqual([]);
    expect(graphics.setScale).not.toHaveBeenCalled();
  });
});

describe('dropLayer — collectOverlappingDrops (AC1)', () => {
  const hull = 10; // SHIP_SIZE / 2
  const fullScale = 1;
  const boundary = hull + dropCollectRadius(POWER_UP_DROP_SIZE, fullScale);

  it('collects a collectible drop whose hull touches the visible bubble', () => {
    const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(onCollect).toHaveBeenCalledWith(drop);
    expect(kept).toEqual([]);
  });

  it('leaves a drop just beyond the bubble boundary untouched', () => {
    const { drop } = makeDrop({ x: boundary + 1, y: 0, scale: fullScale });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).not.toHaveBeenCalled();
    expect(kept).toEqual([drop]);
  });

  it('does not collect a drop below the 3% scale gate', () => {
    const { drop } = makeDrop({ x: 0, y: 0, scale: 0.02 });
    const onCollect = vi.fn();
    const kept = collectOverlappingDrops([drop], { x: 0, y: 0 }, onCollect);
    expect(onCollect).not.toHaveBeenCalled();
    expect(kept).toEqual([drop]);
  });

  it('returns the drops untouched when there is no player', () => {
    const { drop } = makeDrop({ scale: fullScale });
    const onCollect = vi.fn();
    expect(collectOverlappingDrops([drop], null, onCollect)).toEqual([drop]);
    expect(onCollect).not.toHaveBeenCalled();
  });
});

// ── Six-slot collection gate (parent AH-0MVLIJT3M005HPHF AC8) ───────
//
// At six filled slots a drop whose kind is neither held (permanently or
// temporarily), exempt, nor the slot-exempt `reset` utility cannot be taken:
// it stays on the field and the caller is told, so it can play the
// not-collectable cue. The gate is a predicate, so a slot freeing later makes
// the very same drop collectable again.

describe('dropLayer — collectOverlappingDrops six-slot gate (AC8)', () => {
  const hull = 10;
  const fullScale = 1;
  const boundary = hull + dropCollectRadius(POWER_UP_DROP_SIZE, fullScale);

  /** A full pool: four permanent power-ups and two permanent weapons. */
  const fullState = resolveSlotState(
    [
      { id: 'shield', level: 1 },
      { id: 'bomb', level: 1 },
      { id: 'speed_boost', level: 1 },
      { id: 'phase_shift', level: 1 },
    ],
    [
      { id: 'spread', level: 1 },
      { id: 'dual', level: 1 },
    ],
  );

  /** The production gate: the shared helper's pool predicate. */
  const gateFor = (dropId: DropId) => ({
    canCollect: () => isWithinSlotPool(dropId, fullState),
  });

  it('keeps an ineligible drop on the field and reports it as blocked', () => {
    const { drop, powerUp } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const gatedDrop = { ...drop, dropId: 'teleport' as DropId };
    const onCollect = vi.fn();
    const onBlocked = vi.fn();

    const kept = collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, onCollect, undefined, {
      ...gateFor(gatedDrop.dropId),
      onBlocked,
    });

    // Not collected: no effect, the drop survives, and the caller is told.
    expect(onCollect).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith(gatedDrop);
    expect(kept).toEqual([gatedDrop]);
    expect(powerUp.state).not.toBe(PowerUpState.DESPAWNED);
  });

  it('collects a held kind at the cap', () => {
    const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const gatedDrop = { ...drop, dropId: 'shield' as DropId };
    const onCollect = vi.fn();
    const onBlocked = vi.fn();

    const kept = collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, onCollect, undefined, {
      ...gateFor(gatedDrop.dropId),
      onBlocked,
    });

    expect(onCollect).toHaveBeenCalledTimes(1);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(kept).toEqual([]);
  });

  it('collects an available-when-full entry and the slot-exempt reset at the cap', () => {
    for (const dropId of ['extra_life', 'mystery_ufo', 'reset'] as DropId[]) {
      const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
      const gatedDrop = { ...drop, dropId };
      const onCollect = vi.fn();

      collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, onCollect, undefined, gateFor(gatedDrop.dropId));

      expect(onCollect, `${dropId} must stay collectable at the cap`).toHaveBeenCalledTimes(1);
    }
  });

  it('collects everything while the pool has a free slot', () => {
    const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const gatedDrop = { ...drop, dropId: 'teleport' as DropId };
    const onCollect = vi.fn();
    const fiveSlots = resolveSlotState(
      [
        { id: 'shield', level: 1 },
        { id: 'bomb', level: 1 },
        { id: 'speed_boost', level: 1 },
        { id: 'phase_shift', level: 1 },
      ],
      [{ id: 'spread', level: 1 }],
    );
    expect(fiveSlots.isFull).toBe(false);

    collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, onCollect, undefined, {
      canCollect: () => isWithinSlotPool(gatedDrop.dropId, fiveSlots),
    });

    expect(onCollect).toHaveBeenCalledTimes(1);
  });

  it('the same drop becomes collectable once a slot frees', () => {
    const { drop } = makeDrop({ x: boundary - 1, y: 0, scale: fullScale });
    const gatedDrop = { ...drop, dropId: 'teleport' as DropId };
    const onBlocked = vi.fn();

    // Full: refused.
    const refused = collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, vi.fn(), undefined, {
      ...gateFor(gatedDrop.dropId),
      onBlocked,
    });
    expect(refused).toEqual([gatedDrop]);
    expect(onBlocked).toHaveBeenCalledTimes(1);

    // A temporary window expired, freeing a slot — the same drop is taken.
    const freedState = resolveSlotState(
      [
        { id: 'shield', level: 1 },
        { id: 'bomb', level: 1 },
        { id: 'speed_boost', level: 1 },
        { id: 'phase_shift', level: 1 },
      ],
      [{ id: 'spread', level: 1 }],
    );
    const onCollect = vi.fn();
    collectOverlappingDrops([gatedDrop], { x: 0, y: 0 }, onCollect, undefined, {
      canCollect: () => isWithinSlotPool(gatedDrop.dropId, freedState),
    });
    expect(onCollect).toHaveBeenCalledTimes(1);
  });
});

describe('dropLayer — applyDropMagnet (AC2)', () => {
  it('pulls a collectible drop toward the player and syncs its graphics', () => {
    const { drop, graphics } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], { x: 0, y: 0 }, 1, 0.5); // 120 px/s × 0.5 s
    expect(drop.x).toBeCloseTo(0, 5);
    expect(drop.y).toBeCloseTo(0, 5);
    expect(graphics.setPosition).toHaveBeenCalledWith(drop.x, drop.y);
  });

  it('does nothing without magnet stacks', () => {
    const { drop, graphics } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], { x: 0, y: 0 }, 0, 0.5);
    expect(drop.x).toBe(30);
    expect(graphics.setPosition).not.toHaveBeenCalled();
  });

  it('does nothing without a player', () => {
    const { drop } = makeDrop({ x: 30, y: 0, scale: 1 });
    applyDropMagnet([drop], null, 1, 0.5);
    expect(drop.x).toBe(30);
  });
});

describe('dropLayer — playDropPickupCue (AC4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('plays the generic pop plus the dedicated P5/P8/P9 cue', () => {
    const pop = vi.spyOn(effects, 'playPowerUpCollectPopSound');
    const speed = vi.spyOn(effects, 'playSpeedBoostCollectSound');
    const life = vi.spyOn(effects, 'playExtraLifeCollectSound');
    const magnet = vi.spyOn(effects, 'playMagnetCollectSound');
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');

    playDropPickupCue({ dropId: 'speed_boost' });
    expect(pop).toHaveBeenCalledTimes(1);
    expect(speed).toHaveBeenCalledTimes(1);

    playDropPickupCue({ dropId: 'extra_life' });
    expect(life).toHaveBeenCalledTimes(1);

    playDropPickupCue({ dropId: 'magnet' });
    expect(magnet).toHaveBeenCalledTimes(1);

    expect(generic).not.toHaveBeenCalled();
  });

  it('plays the dedicated weapon/Reset cue for weapon drops', () => {
    const spread = vi.spyOn(effects, 'playSpreadPickupSound');
    const dual = vi.spyOn(effects, 'playDualPickupSound');
    const rapid = vi.spyOn(effects, 'playRapidPickupSound');
    const reset = vi.spyOn(effects, 'playResetPickupSound');
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');

    playDropPickupCue({ dropId: 'spread', weaponDropId: 'spread' });
    playDropPickupCue({ dropId: 'dual', weaponDropId: 'dual' });
    playDropPickupCue({ dropId: 'rapid', weaponDropId: 'rapid' });
    playDropPickupCue({ dropId: 'reset', weaponDropId: 'reset' });

    expect(spread).toHaveBeenCalledTimes(1);
    expect(dual).toHaveBeenCalledTimes(1);
    expect(rapid).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(generic).not.toHaveBeenCalled();
  });

  it('falls back to the generic chime for types without a dedicated cue', () => {
    const generic = vi.spyOn(effects, 'playPowerUpCollectSound');
    const pop = vi.spyOn(effects, 'playPowerUpCollectPopSound');
    playDropPickupCue({ dropId: 'shield' });
    playDropPickupCue({ dropId: 'bomb' });
    expect(generic).toHaveBeenCalledTimes(2);
    expect(pop).toHaveBeenCalledTimes(2);
  });
});

// ── Six-slot drop gating (AH-0MVNT2XHB000YR2Z) ─────────────────────
//
// Activated in AH-0MVNT2YGD003N8NR. This slice pinned the gated draw seam's
// contract (`drawNextDrop` in this module) and the spawner eligibility filter
// **before** they existed (each assertion was registered with `it.fails(...)`
// — the repo's red-before/green-after convention). The implementation landed
// in AH-0MVNT2YGD003N8NR and every `.fails` below was flipped to a plain
// `it(...)` — the assertions themselves were not changed.
//
// The seam is loaded through the module namespace plus a cast rather than a
// named import, so this file still compiles and collects before the seam
// exists (a static named import of a missing export fails `tsc --noEmit`).

/** The gated draw seam's pinned surface (added by AH-0MVNT2YGD003N8NR). */
interface GatedDropLayer {
  /**
   * Draws the next drop id through the shared six-slot gate: below the cap the
   * draw is byte-for-byte the unfiltered weighted draw, at/above the cap only
   * owned kinds plus `availableWhenSlotsFull` entries may be returned.
   */
  drawNextDrop(spawner: WeightedRandomSpawner<DropId>, state: PowerUpSlotState): DropId;
}

const gatedDropLayer = dropLayerModule as unknown as GatedDropLayer;

/** Deterministic LCG (Numerical Recipes constants) returning values in [0, 1). */
function makeSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * The default weighted drop spawner, typed as the concrete spawner the gated
 * draw seam filters (`buildDefaultDropSpawner` only advertises the
 * `PowerUpSpawner` interface).
 */
function buildDefaultWeightedSpawner(seed: number): WeightedRandomSpawner<DropId> {
  return buildDefaultDropSpawner(
    DEFAULT_RULES.powerUpWeights,
    DEFAULT_RULES.weaponWeights,
    makeSeededRng(seed),
  ) as WeightedRandomSpawner<DropId>;
}

/**
 * The pre-change draw sequence captured from the **unfiltered** spawner
 * (`buildDefaultDropSpawner`, seed 12345): the regression baseline the gated
 * path must reproduce exactly while fewer than six slots are filled. Captured
 * before the gating change so a later retune of the gate cannot quietly shift
 * the below-cap distribution.
 */
const PRE_CHANGE_DRAW_SEQUENCE: DropId[] = [
  'shield',
  'shield',
  'thorns',
  'strike',
  'rear_guard',
  'speed_boost',
  'chrono',
  'thorns',
  'salvage',
  'options',
  'shield',
  'ricochet',
  'shard_swarm',
  'bomb',
  'rapid',
  'frenzy',
  'force_field',
  'shard_swarm',
  'force_field',
  'railgun',
  'heavy_slug',
  'spread',
  'mystery_ufo',
  'chrono',
];

/** Every catalogue entry flagged available-when-full (Extra Life, Mystery UFO). */
const EXEMPT_WHEN_FULL: readonly PowerUpId[] = (
  Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]
).filter((id) => POWER_UP_CATALOGUE[id].availableWhenSlotsFull === true);

/**
 * Six filled slots: four permanent power-up grants and two permanent weapon
 * grants, so the shared pool is exactly at `POWER_UP_SLOT_CAP`.
 */
function fullSlotState(): PowerUpSlotState {
  return resolveSlotState(
    [
      { id: 'shield', level: 1 },
      { id: 'bomb', level: 1 },
      { id: 'speed_boost', level: 1 },
      { id: 'phase_shift', level: 1 },
    ],
    [
      { id: 'spread', level: 1 },
      { id: 'dual', level: 1 },
    ],
  );
}

describe('dropLayer — drawNextDrop below the cap (AC3, no behaviour change)', () => {
  it('captures the pre-change draw sequence from the unfiltered spawner', () => {
    // Guards the snapshot itself: it is what the pre-change code produces.
    const spawner = buildDefaultDropSpawner(
      DEFAULT_RULES.powerUpWeights,
      DEFAULT_RULES.weaponWeights,
      makeSeededRng(12345),
    );
    const draws = Array.from({ length: PRE_CHANGE_DRAW_SEQUENCE.length }, () => spawner.next());
    expect(draws).toEqual(PRE_CHANGE_DRAW_SEQUENCE);
  });

  it('reproduces the identical sequence for power-ups and weapons while slots are free', () => {
    const state = resolveSlotState([], []);
    expect(state.isFull).toBe(false);

    const spawner = buildDefaultWeightedSpawner(12345);
    const draws = Array.from({ length: PRE_CHANGE_DRAW_SEQUENCE.length }, () =>
      gatedDropLayer.drawNextDrop(spawner, state),
    );

    expect(draws).toEqual(PRE_CHANGE_DRAW_SEQUENCE);
    // The baseline covers both drop families, power-ups and weapons alike.
    const isWeapon = (id: DropId) => (WEAPON_DROP_IDS as readonly DropId[]).includes(id);
    expect(draws.some(isWeapon)).toBe(true);
    expect(draws.some((id) => !isWeapon(id))).toBe(true);
  });
});

describe('dropLayer — drawNextDrop at six filled slots (AC2, spawn gating)', () => {
  it('draws only owned kinds and available-when-full entries over a large seeded sample', () => {
    const state = fullSlotState();
    expect(state.isFull).toBe(true);

    // Held kinds plus the exempt entries plus the slot-exempt reset utility.
    const eligible = new Set<DropId>([...state.heldIds, ...EXEMPT_WHEN_FULL, 'reset']);
    const spawner = buildDefaultWeightedSpawner(2026);

    const draws = Array.from({ length: 5000 }, () => gatedDropLayer.drawNextDrop(spawner, state));

    // Every non-owned, non-exempt power-up *and* weapon id is gated out.
    expect(draws.filter((id) => !eligible.has(id))).toEqual([]);

    // Gating must not starve an eligible id: each owned kind and each exempt
    // entry still appears in a large sample.
    for (const id of eligible) expect(draws).toContain(id);
  });

  it('never zeroes or retunes weights — exclusion is an eligibility filter', () => {
    const state = fullSlotState();
    const spawner = buildDefaultWeightedSpawner(7);
    const before = spawner.getWeights();

    for (let i = 0; i < 200; i++) gatedDropLayer.drawNextDrop(spawner, state);

    // The shipped weight table is untouched for power-ups and weapons alike.
    expect(spawner.getWeights()).toEqual(before);
    expect(spawner.getWeights()).toMatchObject({
      ...DEFAULT_RULES.powerUpWeights,
      ...DEFAULT_RULES.weaponWeights,
    });
  });

  it('still yields an eligible id when every weight is zeroed (not the exclusion mechanism)', () => {
    const state = fullSlotState();
    // Held kinds plus the exempt entries plus the slot-exempt reset utility.
    const eligible = new Set<DropId>([...state.heldIds, ...EXEMPT_WHEN_FULL, 'reset']);

    const build = () => {
      const spawner = buildDefaultWeightedSpawner(11);
      for (const id of Object.keys(spawner.getWeights()) as DropId[]) spawner.setWeight(id, 0);
      return spawner;
    };

    const spawnerA = build();
    const spawnerB = build();
    const drawsA = Array.from({ length: 10 }, () => gatedDropLayer.drawNextDrop(spawnerA, state));
    const drawsB = Array.from({ length: 10 }, () => gatedDropLayer.drawNextDrop(spawnerB, state));

    // Deterministic (all-zero weights fall back to the first *eligible* id) …
    expect(drawsA).toEqual(drawsB);
    // … and never an ineligible id.
    expect(drawsA.filter((id) => !eligible.has(id))).toEqual([]);
  });

  it('degrades an empty eligible set to a deterministic exempt id, not the first pool entry', () => {
    const state = fullSlotState();
    // A pool containing neither an owned kind nor an exempt entry: every id in
    // it is gated out, so the eligible set is empty. (At activation the pool
    // was corrected from `['shield', 'bomb']` — both are in the full slot
    // state's owned set — to `['teleport', 'frenzy']`, which are neither owned
    // nor exempt, so the empty-eligible degradation is genuinely exercised.)
    const build = () => new WeightedRandomSpawner<DropId>(['teleport', 'frenzy'], makeSeededRng(5));

    const first = gatedDropLayer.drawNextDrop(build(), state);
    const second = gatedDropLayer.drawNextDrop(build(), state);

    // Deterministic, crash-free, and an available-when-full entry.
    expect(first).toBe(second);
    expect(EXEMPT_WHEN_FULL as readonly DropId[]).toContain(first);
    // The all-zero-weight first-entry fallback would have returned 'shield'.
    expect(first).not.toBe('shield');
  });
});
