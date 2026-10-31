/**
 * Acquisition-surface gate audit (AH-0MVVJS34M00551ES, parent
 * AH-0MVVF0POV001JNKX AC2).
 *
 * The six-slot cap is only real if **every** surface that can acquire a kind
 * consults it. Sibling files already prove the accounting
 * (`powerups/slots.test.ts`), the drop-draw/choice parity between the game and
 * a gym (`powerups/slots.parity.test.ts`) and the collection gate's blocked
 * cue (`scenes/core/dropLayer.test.ts`). This file is the **per-surface audit**
 * the parent item asks for: for each remaining acquisition route it drives the
 * real seam into a full, *mixed* pool (permanent kinds **and** open temporary
 * windows) and proves a seventh counted kind is refused while an exempt entry
 * or an already-held kind still passes.
 *
 * Surfaces covered here:
 *
 * 1. **field collection** — the real `CombatCoreScene._canCollectDrop` gate;
 * 2. **shared drop draw** — `drawNextDrop` over a weighted source;
 * 3. **hold-full choice** — `buildChoiceCandidates` with the live snapshot;
 * 4. **mini-boss reward** — the real `PlayScene.openMiniBossReward`: since the
 *    unlock feature was removed it offers level-ups of held kinds only
 *    (parent epic AH-0MVLISU03006WDOD AC5);
 * 5. **checkpoint resume** — the save seam (`saveCheckpoint`) bounds the
 *    persisted payload, so a resumed run cannot restore a seventh kind. The
 *    documented divergence (the replay itself does not re-gate a hand-written
 *    payload) is recorded in GDD §4.4 / `docs/BALANCING.md`;
 * 6. **capture/scripted setup** — the documented divergence: the applier may
 *    pre-grant more than six kinds, and `resolveSceneSetupState` keeps that
 *    state off the normal play path (dev gate folded off in a shipped build).
 *
 * The invariant `resolveSlotState(...).used <= POWER_UP_SLOT_CAP` is asserted
 * at the moment of every attempted grant, so a future surface that forgets the
 * gate fails here rather than in a player's run.
 *
 * @module powerups/slots.surfaces.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, advanceGame, type BootedGame } from '../test/gameHarness';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import {
  CHECKPOINT_VERSION,
  capCheckpointLoadout,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from '../core/checkpointStore';
import { loadRules } from '../core/rules';
import type { Player } from '../entities/Player';
import { GameOverScene } from '../scenes/GameOverScene';
import { MenuScene } from '../scenes/MenuScene';
import { MineralChoiceScene } from '../scenes/MineralChoiceScene';
import { PlayScene } from '../scenes/PlayScene';
import { resolveSceneSetupState } from '../scenes/core/sceneSetup';
import { buildDefaultDropSpawner, drawNextDrop } from '../scenes/core/dropLayer';
import {
  CHOICE_POOL,
  buildChoiceCandidates,
  type ChoiceOption,
} from './choice';
import {
  isWithinSlotPool,
  resolvePlayerSlotState,
  resolveSlotState,
  type PowerUpSlotState,
} from './slots';
import type { DropId, PowerUpId } from './types';
import type { WeaponId } from '../utils/weapons';

vi.setConfig({ testTimeout: 60000 });

/** The six counted kinds the mixed fixture fills the pool with. */
const MIXED_PERMANENT_POWER_UPS: readonly PowerUpId[] = ['shield', 'bomb', 'magnet'];
const MIXED_TEMPORARY_POWER_UP: PowerUpId = 'speed_boost';
const MIXED_PERMANENT_WEAPON: WeaponId = 'spread';
const MIXED_TEMPORARY_WEAPON: WeaponId = 'rapid';

/** A counted kind the fixture does **not** hold: the seventh-slot candidate. */
const NEW_COUNTED_POWER_UP: PowerUpId = 'phase_shift';
const NEW_COUNTED_WEAPON: WeaponId = 'wave_laser';

/** An exempt entry (`availableWhenSlotsFull`): always admissible (Q7a). */
const EXEMPT_ENTRY: PowerUpId = 'mystery_ufo';

/** Deterministic LCG (Numerical Recipes constants) — no `Math.random`. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Fills the shared pool to exactly six counted kinds with a **mixed** loadout:
 * three permanent power-ups, one temporary power-up window, one permanent
 * weapon and one temporary weapon window.
 *
 * The temporary halves go straight into the player's run-scoped stores (the
 * same stores `resolvePlayerSlotState` reads) rather than through the registry
 * clock, so the windows cannot expire mid-test and the occupied state is
 * deterministic — the point of this file is the *gate*, not TTL behaviour
 * (`powerups/slots.weaponLevels.test.ts` covers expiry).
 */
function fillMixedSix(player: Player): PowerUpSlotState {
  const store = player.getPowerUpLevelStore();
  for (const id of MIXED_PERMANENT_POWER_UPS) store.collect(id, true);
  store.collect(MIXED_TEMPORARY_POWER_UP);
  player.equipWeapon(MIXED_PERMANENT_WEAPON, true);
  player.equipWeapon(MIXED_TEMPORARY_WEAPON);

  const state = resolvePlayerSlotState(player);
  expect(state.used).toBe(POWER_UP_SLOT_CAP);
  expect(state.isFull).toBe(true);
  return state;
}

/** The private scene seams this audit drives. */
interface DropGateDriver {
  _canCollectDrop(drop: { dropId: DropId }): boolean;
}
interface ChoiceLauncher {
  openMineralChoice(): ChoiceOption[];
}
interface MiniBossLauncher {
  openMiniBossReward(context: unknown): ChoiceOption[];
}

describe('acquisition-surface gate audit (AH-0MVVJS34M00551ES)', () => {
  let booted: BootedGame | null = null;
  let scene: PlayScene;

  beforeEach(async () => {
    localStorage.clear();
    booted = await bootScene([
      PlayScene,
      GameOverScene,
      MenuScene,
      MineralChoiceScene,
    ]);
    scene = booted.scene as PlayScene;
    scene.finishSpawnAnimations();
    scene.tick(0.001);
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    vi.restoreAllMocks();
  });

  /** The live player (the fixture needs one; PlayScene always spawns it). */
  function player(): Player {
    const live = scene.getPlayer();
    expect(live).not.toBeNull();
    return live!;
  }

  // ── 1. Field collection ────────────────────────────────────────────
  it('field collection refuses a seventh counted kind and admits exempt/held kinds', () => {
    const live = player();
    const gate = scene as unknown as DropGateDriver;

    // Below the cap every kind is collectable (no behaviour change).
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_WEAPON })).toBe(true);
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_POWER_UP })).toBe(true);

    fillMixedSix(live);

    // At six held kinds a brand-new counted kind is refused.
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_WEAPON })).toBe(false);
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_POWER_UP })).toBe(false);
    // …while an already-held kind (level-up) and an exempt entry still pass.
    expect(gate._canCollectDrop({ dropId: MIXED_PERMANENT_WEAPON })).toBe(true);
    expect(
      gate._canCollectDrop({ dropId: MIXED_TEMPORARY_POWER_UP }),
    ).toBe(true);
    expect(gate._canCollectDrop({ dropId: EXEMPT_ENTRY })).toBe(true);

    // The invariant holds at the moment of the refused grants.
    expect(resolvePlayerSlotState(live).used).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP,
    );
  });

  it('frees a slot for the refused kind when a temporary window expires', () => {
    const live = player();
    const gate = scene as unknown as DropGateDriver;
    fillMixedSix(live);
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_WEAPON })).toBe(false);

    // Release the temporary power-up window through the ordinary store seam.
    live.getPowerUpLevelStore().clearTemporary(MIXED_TEMPORARY_POWER_UP);

    expect(resolvePlayerSlotState(live).used).toBe(POWER_UP_SLOT_CAP - 1);
    expect(gate._canCollectDrop({ dropId: NEW_COUNTED_WEAPON })).toBe(true);
  });

  // ── 2. Shared drop draw ────────────────────────────────────────────
  it('the shared drop draw never yields a seventh counted kind from a mixed pool', () => {
    const live = player();
    fillMixedSix(live);
    const state = resolvePlayerSlotState(live);
    const rules = loadRules();
    const drawn = new Set<DropId>();
    const spawner = buildDefaultDropSpawner(
      rules.powerUpWeights,
      rules.weaponWeights,
      seededRng(424242),
    );

    for (let i = 0; i < 2000; i += 1) {
      // The gated draw seam the scenes consume, not the raw source.
      const id = drawNextDrop(spawner, state);
      // Every draw is admissible for the current (full) pool.
      expect(isWithinSlotPool(id, state), `${id} drawn while gated out`).toBe(
        true,
      );
      drawn.add(id);
      expect(resolvePlayerSlotState(live).used).toBeLessThanOrEqual(
        POWER_UP_SLOT_CAP,
      );
    }

    // A brand-new counted kind is genuinely excluded from the draw.
    expect(drawn.has(NEW_COUNTED_WEAPON)).toBe(false);
    expect(drawn.has(NEW_COUNTED_POWER_UP)).toBe(false);
    // The pool is not empty: held kinds are still drawable.
    expect(drawn.size).toBeGreaterThan(0);
  });

  // ── 3. Hold-full choice ───────────────────────────────────────────
  it('the hold-full choice offers only admissible kinds from a mixed pool', () => {
    const live = player();
    fillMixedSix(live);
    const state = resolvePlayerSlotState(live);

    const offered = buildChoiceCandidates(CHOICE_POOL, {
      weaponLevels: live.getWeaponLevels(),
      powerUpLevels: live.getPowerUpLevels(),
      tempPowerUpIds: live.getTempPowerUpIds(),
      tempWeaponIds: live.getTempWeaponIds(),
    });

    expect(offered.length).toBeGreaterThan(0);
    for (const option of offered) {
      expect(
        isWithinSlotPool(option.id as DropId, state),
        `${option.id} offered while gated out`,
      ).toBe(true);
    }
    expect(offered.map((option) => option.id)).not.toContain(
      NEW_COUNTED_POWER_UP,
    );
    expect(resolvePlayerSlotState(live).used).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP,
    );
  });

  it('the live hold-full launcher offers only admissible kinds', () => {
    const live = player();
    fillMixedSix(live);
    const state = resolvePlayerSlotState(live);

    const offered = (scene as unknown as ChoiceLauncher).openMineralChoice();

    expect(offered.length).toBeGreaterThan(0);
    for (const option of offered) {
      expect(
        isWithinSlotPool(option.id as DropId, state),
        `${option.id} offered by the live launcher`,
      ).toBe(true);
    }
  });

  // ── 4. Mini-boss reward ─────────────────────────────────────────
  it('the mini-boss reward offers only kinds already in the pool (full pool)', () => {
    const live = player();
    fillMixedSix(live);
    const state = resolvePlayerSlotState(live);

    const options = (scene as unknown as MiniBossLauncher).openMiniBossReward(
      {},
    );

    // The overlay must never open empty (it pauses play).
    expect(options.length).toBeGreaterThan(0);
    // Every offer names a kind the player already holds: the unlock half was
    // removed (parent AH-0MVLISU03006WDOD AC5), so the reward is a level-up
    // only and can never acquire a seventh counted kind.
    for (const option of options) {
      expect(
        isWithinSlotPool(option.id as DropId, state),
        `${option.id} offered as a seventh slot`,
      ).toBe(true);
      expect([...state.heldIds]).toContain(option.id);
    }
    expect(options.map((option) => option.id)).not.toContain(
      NEW_COUNTED_WEAPON,
    );
    expect(options.map((option) => option.id)).not.toContain(
      NEW_COUNTED_POWER_UP,
    );
  });

  it('the mini-boss reward never offers a brand-new weapon with room to spare', () => {
    const live = player();
    // Own one permanent kind so the reward takes its level-up path (with
    // nothing owned at all it deliberately falls back to the hold-full-style
    // choice, which may offer base-pool kinds — parent AC4).
    live.equipWeapon(MIXED_PERMANENT_WEAPON, true);
    const held = new Set<string>([...resolvePlayerSlotState(live).heldIds]);

    const options = (scene as unknown as MiniBossLauncher).openMiniBossReward(
      {},
    );

    // Below the cap the old unlock half would have offered a locked weapon. The
    // reward now offers level-ups of held kinds only, so a mini-boss is no
    // longer an acquisition surface at all.
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      expect(held.has(option.id)).toBe(true);
    }
    expect(options.map((option) => option.id)).not.toContain(
      NEW_COUNTED_WEAPON,
    );
    expect(resolvePlayerSlotState(live).used).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP,
    );
  });

  // ── 5. Checkpoint resume ──────────────────────────────────────────
  /**
   * A checkpoint naming **seven** counted kinds plus one exempt entry — a
   * payload no capped run can produce, used here as the worst case the save
   * gate must bound.
   */
  const OVER_CAP_CHECKPOINT: Checkpoint = {
    version: CHECKPOINT_VERSION,
    level: 3,
    wave: 1,
    lives: 3,
    score: 1000,
    minerals: 0,
    mineralHoldCapacity: 5,
    weaponLevels: [
      { id: MIXED_PERMANENT_WEAPON, level: 1 },
      { id: NEW_COUNTED_WEAPON, level: 1 },
    ],
    powerUpLevels: [
      { id: 'shield', level: 1 },
      { id: 'bomb', level: 1 },
      { id: 'magnet', level: 1 },
      { id: 'speed_boost', level: 1 },
      { id: NEW_COUNTED_POWER_UP, level: 1 },
      // Exempt entries never occupy a slot, so they survive the gate (Q7a).
      { id: 'extra_life', level: 1 },
    ],
    runSeed: 4242,
    savedAt: '2026-10-20T00:00:00.000Z',
  };

  it('bounds an over-cap checkpoint payload to the six-slot pool on save', () => {
    const bounded = capCheckpointLoadout(OVER_CAP_CHECKPOINT);

    const state = resolveSlotState(
      bounded.powerUpLevels,
      bounded.weaponLevels,
    );
    expect(state.used).toBe(POWER_UP_SLOT_CAP);
    expect(state.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    // The seventh *counted* kind is dropped…
    expect(bounded.powerUpLevels.map((entry) => entry.id)).not.toContain(
      NEW_COUNTED_POWER_UP,
    );
    // …while the exempt entry and every admitted kind keep their levels.
    expect(bounded.powerUpLevels.map((entry) => entry.id)).toContain(
      'extra_life',
    );
    expect(bounded.weaponLevels).toHaveLength(2);
    // Four counted power-ups fill the pool, then the exempt Extra Life is
    // still admitted (it never occupies a slot, producer Q7a).
    expect(bounded.powerUpLevels.map((entry) => entry.id)).toEqual([
      'shield',
      'bomb',
      'magnet',
      'speed_boost',
      'extra_life',
    ]);
    // Everything else in the checkpoint is preserved untouched.
    expect(bounded.score).toBe(OVER_CAP_CHECKPOINT.score);
    expect(bounded.runSeed).toBe(OVER_CAP_CHECKPOINT.runSeed);
    expect(bounded.mineralHoldCapacity).toBe(5);
  });

  it('persists the bounded payload (save seam) and never restores a seventh kind', () => {
    expect(saveCheckpoint(OVER_CAP_CHECKPOINT)).toBe(true);

    // The persisted payload is already within the cap…
    const persisted = loadCheckpoint();
    expect(persisted).not.toBeNull();
    const persistedState = resolveSlotState(
      persisted!.powerUpLevels,
      persisted!.weaponLevels,
    );
    expect(persistedState.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect(
      persisted!.powerUpLevels.map((entry) => entry.id),
    ).not.toContain(NEW_COUNTED_POWER_UP);

    // …so resuming through the real replay restores at most six counted kinds.
    return (async () => {
      booted!.game.scene.start('PlayScene', { resume: true });
      await advanceGame(booted!.game, 150);
      const resumed = booted!.game.scene.getScene('PlayScene') as PlayScene;
      resumed.finishSpawnAnimations();
      resumed.tick(0.001);

      const live = resumed.getPlayer()!;
      const state = resolvePlayerSlotState(live);
      expect(state.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
      expect(state.heldIds.has(NEW_COUNTED_POWER_UP as DropId)).toBe(false);
      // The admitted kinds really came back (the replay was not skipped).
      expect(state.heldIds.has('shield' as DropId)).toBe(true);
      expect(state.heldIds.has(MIXED_PERMANENT_WEAPON as DropId)).toBe(true);
      // The exempt entry is restored and still counts for nothing.
      expect(state.heldIds.has('extra_life' as DropId)).toBe(true);
    })();
  });

  // ── 6. Capture/scripted setup (documented divergence) ─────────────
  it('keeps a capture setup off the normal play path (dev gate folded off)', () => {
    const setup = {
      player: { weapons: ['spread', 'dual', 'rapid', 'broadside', 'wave_laser', 'ricochet'] },
      powerUps: { shield: 2 },
    };

    // A shipped build folds the run-progress gate off: no setup is applied, so
    // a pre-granted over-cap loadout can never enter normal play.
    expect(resolveSceneSetupState(setup, { devEnabled: false })).toBeNull();
    // Absent or malformed payloads are ignored even in dev.
    expect(resolveSceneSetupState(undefined, { devEnabled: true })).toBeNull();
    expect(resolveSceneSetupState('nope', { devEnabled: true })).toBeNull();

    // In dev (capture/gym/video only) the documented divergence stands: the
    // scripted loadout is applied verbatim, including more than six kinds.
    const applied = resolveSceneSetupState(setup, { devEnabled: true });
    expect(applied).toEqual(setup);
    const scriptedKinds = [
      ...(applied!.player?.weapons ?? []),
      ...Object.keys(applied!.powerUps ?? {}),
    ];
    expect(scriptedKinds.length).toBeGreaterThan(POWER_UP_SLOT_CAP);
  });
});
