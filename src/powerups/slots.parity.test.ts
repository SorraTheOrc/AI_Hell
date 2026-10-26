/**
 * Six-slot cap — game ↔ gym parity and run scope (AH-0MVNT30OT0074NNM,
 * parent "Limit the number of powerup slots" AH-0MVLIJT3M005HPHF).
 *
 * Proves the shared six-slot rule behaves identically in the shipped game and
 * in a formation gym, and that slot state is run-scoped:
 *
 * - **Drop-draw parity** — the seeded drop draw through the *real* `PlayScene`
 *   path (`_maybeDropPowerUp`) and the *real* formation-gym path
 *   (`GymFormationScene._spawnPowerUpDrop`) covers exactly the ids the shared
 *   `isWithinSlotPool` predicate allows, and both call paths cover the same
 *   eligible set. The test never hard-codes the allowed ids — it reads them
 *   back from the one shared predicate, so this is a parity assertion rather
 *   than a re-implementation of the rule (AC3).
 * - **Choice-offer parity** — the hold-full choice on both paths offers exactly
 *   the same eligible option ids, again equal to the shared predicate.
 * - **Run scope** — filling six slots then running the run-restart reset
 *   (`PowerUpLevelStore.reset()` + `Player.resetWeaponLevels()`) returns the
 *   pool to empty and the full catalogue to eligibility.
 * - **One rule, one home** — a source-level guard pins that the slot accounting
 *   and both gate seams are defined exactly once in shared code, so a scene
 *   that re-introduces a copy fails this file.
 *
 * The rule itself lives once in `src/powerups/slots.ts`
 * (`resolveSlotState` / `isWithinSlotPool` / `eligibleForSlotPool`) and is
 * consumed by the two shared decision points: `drawNextDrop`
 * (`src/scenes/core/dropLayer.ts`) and `buildChoiceCandidates`
 * (`src/powerups/choice.ts`). `PlayScene` and every formation gym consume those
 * seams, never a private copy (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * This is a test-only slice: no production behaviour changes here.
 *
 * @module powerups/slots.parity.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../test/duplicateBodyGuard';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import {
  POWER_UP_WEIGHT_IDS,
  WEAPON_WEIGHT_IDS,
  loadRules,
} from '../core/rules';
import type { Player } from '../entities/Player';
import { buildDefaultDropSpawner } from '../scenes/core/dropLayer';
import { PlayScene } from '../scenes/PlayScene';
import { GameOverScene } from '../scenes/GameOverScene';
import { MenuScene } from '../scenes/MenuScene';
import { MineralChoiceScene } from '../scenes/MineralChoiceScene';
import { GymFodderEnemies } from '../scenes/gym/GymFodderEnemies';
import type { WeaponId } from '../utils/weapons';
import {
  CHOICE_POOL,
  buildChoiceCandidates,
  type ChoiceStrategy,
  type ChoiceOption,
} from './choice';
import { isWithinSlotPool, resolvePlayerSlotState, type PowerUpSlotState } from './slots';
import type { DropId, PowerUpId } from './types';

/** Two Phaser games are booted per parity test — give the file headroom. */
vi.setConfig({ testTimeout: 60000 });

/** Stable host ids for the two booted games (deterministic boot). */
const PLAY_HOST = 'slots-parity-play-host';
const GYM_HOST = 'slots-parity-gym-host';

/** The complete drop pool both scene drop paths draw from. */
const DROP_POOL: readonly DropId[] = [...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS];

/**
 * Six distinct permanent kinds — four power-ups and two weapon drops — that
 * fill the shared pool exactly. A mixed build exercises both demand sides
 * (producer Q1 answer (c): weapons consume power-up slots too).
 */
const SIX_SLOT_POWER_UPS: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
];
const SIX_SLOT_WEAPONS: readonly WeaponId[] = ['spread', 'dual'];

/** Deterministic LCG (Numerical Recipes constants) — no `Math.random`. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** Grants six permanent kinds through the real player stores. */
function fillSixSlots(player: Player): PowerUpSlotState {
  for (const id of SIX_SLOT_POWER_UPS) {
    player.getPowerUpLevelStore().collect(id, true);
  }
  for (const id of SIX_SLOT_WEAPONS) {
    player.equipWeapon(id, true);
  }
  const state = resolvePlayerSlotState(player);
  expect(state.used).toBe(POWER_UP_SLOT_CAP);
  expect(state.isFull).toBe(true);
  return state;
}

/**
 * The ids the one shared predicate allows for a slot state.
 *
 * Reading the expected set back from `isWithinSlotPool` (rather than listing
 * ids in the test) is what makes this a parity assertion instead of a second
 * copy of the rule (AC3).
 */
function eligibleIds(
  state: PowerUpSlotState,
  pool: readonly DropId[],
): Set<DropId> {
  return new Set(pool.filter((id) => isWithinSlotPool(id, state)));
}

/** The private draw seams the two real scene drop paths run through. */
interface PlayDropDriver {
  _maybeDropPowerUp(x: number, y: number): void;
}
interface GymDropDriver {
  _spawnPowerUpDrop(): void;
}

/** The launcher surface shared by `PlayScene` and `GymFormationScene`. */
interface ChoiceLauncher {
  setMineralChoiceStrategy(strategy: ChoiceStrategy): void;
  openMineralChoice(): ChoiceOption[];
}

describe('six-slot cap — game ↔ gym parity (AH-0MVNT30OT0074NNM)', () => {
  const games: BootedGame[] = [];

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    vi.restoreAllMocks();
    localStorage.clear();
  });

  /** Boots the game and a formation gym, returning the live scene pairs. */
  async function bootBoth(): Promise<{ play: PlayScene; gym: GymFodderEnemies }> {
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene, MineralChoiceScene],
      PLAY_HOST,
    );
    const gym = await bootScene(
      [GymFodderEnemies, MineralChoiceScene],
      GYM_HOST,
    );
    games.push(play, gym);
    return {
      play: play.scene as PlayScene,
      gym: gym.scene as GymFodderEnemies,
    };
  }

  /**
   * Drives the game's real per-kill drop path with a seeded RNG and returns
   * the ids it handed to the spawn seam.
   */
  function driveGameDrops(play: PlayScene, seed: number): Set<DropId> {
    play.setRng(seededRng(seed));
    const spawn = vi.spyOn(play, 'spawnPowerUpDrop').mockReturnValue(null);
    const driver = play as unknown as PlayDropDriver;
    try {
      for (let i = 0; i < 6000; i++) driver._maybeDropPowerUp(100, 120);
      return new Set(spawn.mock.calls.map(([id]) => id as DropId));
    } finally {
      spawn.mockRestore();
    }
  }

  /**
   * Drives the formation gym's real cadence drop path with the same seeded
   * spawner and returns the ids it handed to the spawn seam.
   */
  function driveGymDrops(gym: GymFodderEnemies, seed: number): Set<DropId> {
    const rules = loadRules();
    gym.setPowerUpSpawner(
      buildDefaultDropSpawner(
        rules.powerUpWeights,
        rules.weaponWeights,
        seededRng(seed),
      ),
    );
    const spawn = vi.spyOn(gym, 'spawnPowerUpDrop').mockReturnValue(null);
    const driver = gym as unknown as GymDropDriver;
    try {
      for (let i = 0; i < 3000; i++) driver._spawnPowerUpDrop();
      return new Set(spawn.mock.calls.map(([id]) => id as DropId));
    } finally {
      spawn.mockRestore();
    }
  }

  it('drops only the shared eligible set, identically in the game and a formation gym (AC1/AC2/AC3)', async () => {
    const { play, gym } = await bootBoth();
    const playPlayer = play.getPlayer();
    const gymPlayer = gym.getPlayer();
    expect(playPlayer).not.toBeNull();
    expect(gymPlayer).not.toBeNull();

    fillSixSlots(playPlayer!);
    fillSixSlots(gymPlayer!);

    const gameDrawn = driveGameDrops(play, 20261025);
    const gymDrawn = driveGymDrops(gym, 20261025);

    const gameState = resolvePlayerSlotState(playPlayer!);
    const gymState = resolvePlayerSlotState(gymPlayer!);
    // Both scenes derive the same occupancy from the same permanent-only stores.
    expect(gymState.used).toBe(gameState.used);
    expect(gymState.isFull).toBe(true);

    // The allowed set is exactly what the one shared predicate permits — and
    // both real call paths deliver exactly that set (no divergent copy).
    const eligible = eligibleIds(gameState, DROP_POOL);
    expect(eligible.size).toBeLessThan(DROP_POOL.length);
    expect(gameDrawn).toEqual(eligible);
    expect(gymDrawn).toEqual(eligible);
    expect(gymDrawn).toEqual(gameDrawn);
    // Every drawn id is owned or exempt; no gated-out kind ever appears.
    for (const id of gameDrawn) {
      expect(isWithinSlotPool(id, gameState), `${id} is gated out`).toBe(true);
    }
  });

  it('offers the same eligible choice options in the game and a formation gym (AC1/AC3)', async () => {
    const { play, gym } = await bootBoth();
    fillSixSlots(play.getPlayer()!);
    fillSixSlots(gym.getPlayer()!);

    // A deterministic strategy that returns the shared full candidate list for
    // the context each scene supplies. The *scene* still supplies the owned
    // snapshot, so this compares the two call paths rather than the builder.
    const fullCandidates: ChoiceStrategy = {
      choose: (_count, _rng, context) =>
        buildChoiceCandidates(CHOICE_POOL, context),
    };
    (play as unknown as ChoiceLauncher).setMineralChoiceStrategy(fullCandidates);
    (gym as unknown as ChoiceLauncher).setMineralChoiceStrategy(fullCandidates);

    const gameOffered = new Set(
      (play as unknown as ChoiceLauncher)
        .openMineralChoice()
        .map((option) => option.id as DropId),
    );
    const gymOffered = new Set(
      (gym as unknown as ChoiceLauncher)
        .openMineralChoice()
        .map((option) => option.id as DropId),
    );

    const eligible = eligibleIds(resolvePlayerSlotState(play.getPlayer()!), CHOICE_POOL);
    expect(eligible.size).toBeLessThan(CHOICE_POOL.length);
    // Offered ids are exactly the shared eligible set in both call paths and
    // therefore identical to each other.
    expect(gameOffered).toEqual(eligible);
    expect(gymOffered).toEqual(eligible);
    expect(gymOffered).toEqual(gameOffered);
    // Every offered option passes the one shared predicate.
    for (const id of gameOffered) {
      expect(
        isWithinSlotPool(id, resolvePlayerSlotState(play.getPlayer()!)),
        `${id} offered though gated out`,
      ).toBe(true);
    }
  });

  it('resets slot state to empty and the full catalogue back to eligibility on run restart (AC1)', async () => {
    const { play, gym } = await bootBoth();
    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;

    fillSixSlots(playPlayer);
    fillSixSlots(gymPlayer);

    // The ids the full pool had gated out, read from the shared predicate so
    // the reopened-draw assertion below stays a parity check, not a copy.
    const preResetFull = resolvePlayerSlotState(playPlayer);
    const gatedBeforeReset = DROP_POOL.filter(
      (id) => !isWithinSlotPool(id, preResetFull),
    );
    expect(gatedBeforeReset.length).toBeGreaterThan(0);

    // The run-restart reset the AC names: the two permanent-grant stores are
    // cleared. `PowerUpLevelStore.reset()` clears power-ups, and
    // `Player.resetWeaponLevels()` clears the shared weapon half.
    for (const player of [playPlayer, gymPlayer]) {
      player.getPowerUpLevelStore().reset();
      player.resetWeaponLevels();

      const state = resolvePlayerSlotState(player);
      expect(state.used).toBe(0);
      expect(state.free).toBe(POWER_UP_SLOT_CAP);
      expect(state.isFull).toBe(false);
      expect(state.ownedIds.size).toBe(0);
      // Both gate domains are fully eligible again — read from the shared
      // predicate, not a hard-coded catalogue.
      expect(eligibleIds(state, DROP_POOL)).toEqual(new Set(DROP_POOL));
      expect(eligibleIds(state, CHOICE_POOL)).toEqual(new Set(CHOICE_POOL));
    }

    // The game's live drop path reopens too: draws now include kinds the full
    // pool had gated out, so the pool is genuinely run-scoped, not just the
    // accounting.
    const reopened = driveGameDrops(play, 20261025);
    expect(
      [...reopened].some((id) => gatedBeforeReset.includes(id)),
      'a previously gated-out drop id never reappeared after reset',
    ).toBe(true);
  });

  it('defines the six-slot rule and both gate seams exactly once in shared code (AC4)', () => {
    const sources = collectProductionSourceFiles(
      path.resolve(process.cwd(), 'src'),
    ).map((file) => ({
      file: path.relative(process.cwd(), file).replace(/\\/g, '/'),
      source: fs.readFileSync(file, 'utf8'),
    }));

    const singleDefiners: ReadonlyArray<readonly [name: string, file: string]> = [
      ['resolveSlotState', 'src/powerups/slots.ts'],
      ['isWithinSlotPool', 'src/powerups/slots.ts'],
      ['eligibleForSlotPool', 'src/powerups/slots.ts'],
      ['eligibleDropIds', 'src/powerups/slots.ts'],
      ['drawNextDrop', 'src/scenes/core/dropLayer.ts'],
      ['buildChoiceCandidates', 'src/powerups/choice.ts'],
    ];
    for (const [name, file] of singleDefiners) {
      const definers = sources
        .filter((entry) => definesFunction(entry.source, name))
        .map((entry) => entry.file)
        .sort();
      expect(definers, `${name} must be defined only in ${file}`).toEqual([file]);
    }
  });
});
