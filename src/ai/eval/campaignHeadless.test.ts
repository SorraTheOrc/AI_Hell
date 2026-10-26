/**
 * Spike scaffold: prove the shared campaign core runs headless
 * (AH-0MVD1REUI0032OXG).
 *
 * The automated-balancing arena (AH-0MV8QT7CB0060A7A) must drive the **shared**
 * campaign sequencer, wave state machine and upgrade-choice flow rather than a
 * divergent copy (gym↔game parity, AH-0MUGZDTFX004RBD1). Before any arena build
 * work, this spike instantiates and exercises every module the arena plans to
 * consume in a Node/vitest run with no rendering runtime:
 *
 * - `buildSequencedLevels` — all three generation modes (`fixed`, `curve`,
 *   `dynamic`) via the shipped default curve rows and the real sequencer.
 * - `sequencer` / `defaultCandidatePool` — the campaign sequencer directly.
 * - `WaveManager` — plays the *built* campaign to the boss, exercising spawn
 *   planning and every wave/level transition.
 * - `chooseOptions` / `buildChoiceCandidates` — the shared hold-full upgrade
 *   flow with a seeded RNG.
 * - `MineralHold` — capacity growth and overflow carry.
 * - `applyMineralChoiceReward` — the reward application path.
 *
 * ## Why this proves "headless"
 *
 * Nothing in this file's **runtime** import graph imports `phaser` or reads the
 * wall clock: `mineralLayer`'s only Phaser coupling is a *type-only*
 * `import type { Mineral }` (erased at transform time), and every other module
 * is engine-agnostic by design. The assertions below prove the purity hazards
 * behaviourally:
 *
 * - **No wall clock / ambient randomness:** the same seed replays byte-identical
 *   campaigns, spawn plans and upgrade selections.
 * - **No network/IO on the default path:** `buildSequencedLevels()` with no
 *   arguments resolves synchronously from the config store's pure default rows
 *   (no `fetch`), which is the same path `PlayScene` uses when the CSV registry
 *   is not populated.
 *
 * **Known classifier nuance (AC2 finding):** the repo's test-project classifier
 * (`vitest.projects.ts`) follows type-only imports conservatively, so this file
 * is classified into the **integration** project even though its runtime graph
 * is Phaser-free — the fallout of `mineralLayer`'s `import type { Mineral }`.
 * This is exactly the coupling the arena design must decide on (consume the
 * shared reward applyer directly and accept integration-classified eval tests,
 * or defer hold-full reward modelling).
 *
 * ## Seed derivation (AC3)
 *
 * `PlayScene` builds its campaign with
 * `buildSequencedLevels(undefined, undefined, { seed: this.runSeed })` and
 * seeds every other gameplay draw with `createSeededRng(runSeed)`. The tests
 * mirror exactly that call shape, so the determinism claim covers the real
 * game derivation rather than an approximation.
 *
 * @module ai/eval/campaignHeadless
 */

import { describe, expect, it } from 'vitest';

import { createSeededRng } from '../../core/rng';
import { loadDifficultyCurves } from '../../core/configStore';
import {
  defaultCandidatePool,
  sequencer,
} from '../../core/difficultySequencer';
import { MineralHold } from '../../core/mineralHold';
import { LEVELS, type LevelDefinition } from '../../waves/Formations';
import { WaveManager } from '../../waves/WaveManager';
import { buildSequencedLevels } from '../../waves/sequencedLevels';
import {
  CHOICE_POOL,
  buildChoiceCandidates,
  chooseOptions,
  createRandomChoiceStrategy,
  toChoiceOption,
  type ChoiceOption,
} from '../../powerups/choice';
import { EffectsRegistry } from '../../powerups/effects';
import { applyMineralChoiceReward } from '../../scenes/core/mineralLayer';

/** Total regular waves in a campaign (one per level wave). */
function totalWaves(campaign: LevelDefinition[]): number {
  return campaign.reduce((sum, level) => sum + level.waves.length, 0);
}

/** Play a campaign headlessly, returning every transition event in order. */
function playCampaign(
  campaign: LevelDefinition[],
  seed: number,
): { events: string[]; spawnPlans: number[] } {
  const manager = new WaveManager(campaign);
  const rng = createSeededRng(seed);
  const events: string[] = [];
  const spawnPlans: number[] = [];

  manager.beginGame();
  // Bound the loop: a full campaign is at most ~100 waves × ~20 enemies, so
  // 20 000 transitions is a generous ceiling that still fails fast on a stall.
  for (let guard = 0; !manager.bossTriggered && guard < 20_000; guard++) {
    if (manager.bossActive || manager.bossDefeated) break;
    const spawns = manager.planSpawns(rng);
    spawnPlans.push(spawns.length);
    // The declared wave size and the concrete spawn plan must always agree;
    // otherwise the state machine can clear early or stall.
    expect(spawns.length).toBe(manager.waveEnemyCount());
    // A wave with no planned enemies still needs one transition to advance.
    const destructions = Math.max(1, spawns.length);
    for (let i = 0; i < destructions; i++) {
      events.push(manager.onEnemyDestroyed());
    }
  }

  return { events, spawnPlans };
}

describe('campaign core headless spike (AH-0MVD1REUI0032OXG)', () => {
  describe('buildSequencedLevels', () => {
    it('builds the shipped campaign from the pure default curve rows without IO', () => {
      const rows = loadDifficultyCurves();
      // The config store is not populated in a unit run, so the loader falls
      // back to the computed default rows — synchronously, with no fetch.
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);

      const campaign = buildSequencedLevels();
      expect(campaign.length).toBe(LEVELS.length);
      // Ordered ascending by level because WaveManager indexes the array.
      expect(campaign.map((level) => level.level)).toEqual(
        [...campaign.map((level) => level.level)].sort((a, b) => a - b),
      );
      for (const level of campaign) {
        expect(level.waves.length).toBeGreaterThan(0);
        for (const wave of level.waves) {
          expect(wave.groups.length).toBeGreaterThan(0);
        }
      }
    });

    it('exercises fixed, curve and dynamic generation modes', () => {
      const rows = loadDifficultyCurves();
      const modes = new Set(rows.map((row) => row.generation ?? 'curve'));
      // The shipped defaults mix all three modes; a mode disappearing would
      // silently narrow the arena's fidelity.
      expect(modes).toEqual(new Set(['fixed', 'curve', 'dynamic']));

      // An injected sequencer records which waves were generated. `fixed`
      // waves must never reach it, so the real sequencer only sees
      // `curve`/`dynamic` rows.
      const sequencedWaves: number[] = [];
      buildSequencedLevels(rows, defaultCandidatePool(), {
        seed: 7,
        sequencer: (curve, candidates, options) => {
          sequencedWaves.push(curve.length);
          return sequencer(curve, candidates, options);
        },
      });
      const generatedRowCount = rows.filter(
        (row) => (row.generation ?? 'curve') !== 'fixed',
      ).length;
      expect(sequencedWaves.reduce((sum, n) => sum + n, 0)).toBe(
        generatedRowCount,
      );
    });

    it('is a deterministic function of the run seed', () => {
      const first = buildSequencedLevels(undefined, undefined, { seed: 1234 });
      const second = buildSequencedLevels(undefined, undefined, { seed: 1234 });
      expect(second).toEqual(first);

      // Dynamic waves are seeded from the run seed, so a different seed must
      // diverge somewhere for at least one of a handful of candidate seeds
      // (a single pair could legitimately land on the same composition).
      const differs = [1, 2, 3, 4, 5].some(
        (seed) =>
          JSON.stringify(buildSequencedLevels(undefined, undefined, { seed })) !==
          JSON.stringify(first),
      );
      expect(differs).toBe(true);
    });
  });

  describe('difficulty sequencer', () => {
    it('produces one wave per target deterministically', () => {
      const curve = [10, 25, 40, 55];
      const pool = defaultCandidatePool();
      const first = sequencer(curve, pool);
      const second = sequencer(curve, pool);

      expect(first.waves).toHaveLength(curve.length);
      expect(first.errors).toHaveLength(curve.length);
      expect(second).toEqual(first);
    });
  });

  describe('WaveManager', () => {
    it('plays the built campaign from wave 1 to the final boss', () => {
      const campaign = buildSequencedLevels(undefined, undefined, { seed: 99 });
      const { events, spawnPlans } = playCampaign(campaign, 99);

      expect(spawnPlans.length).toBeGreaterThan(0);
      expect(events.at(-1)).toBe('bossTriggered');
      expect(events.filter((event) => event === 'levelCleared')).toHaveLength(
        campaign.length - 1,
      );
      expect(events.filter((event) => event === 'waveCleared')).toHaveLength(
        totalWaves(campaign) - campaign.length,
      );
    });

    it('replays the identical spawn plan for the same seed', () => {
      const campaign = buildSequencedLevels(undefined, undefined, { seed: 42 });
      expect(playCampaign(campaign, 42)).toEqual(playCampaign(campaign, 42));
    });
  });

  describe('upgrade choice flow', () => {
    it('offers owned items once, as level-up options, with a seeded strategy', () => {
      const context = {
        weaponLevels: [{ id: 'spread' as const, level: 2 }],
      };
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const spreadOffers = candidates.filter(
        (option) => option.id === 'spread',
      );
      expect(spreadOffers).toHaveLength(1);
      expect(spreadOffers[0].kind).toBe('weapon-level');
      // Unowned base entries are marked new.
      const unowned = candidates.find((option) => option.id === 'dual');
      expect(unowned?.kind).toBe('weapon');
      expect(unowned?.isNew).toBe(true);
    });

    it('draws distinct options deterministically from a seeded RNG', () => {
      const strategy = createRandomChoiceStrategy();
      const draw = (seed: number): ChoiceOption[] =>
        chooseOptions(3, strategy, createSeededRng(seed));

      const first = draw(2024);
      expect(first).toHaveLength(3);
      expect(new Set(first.map((option) => option.id)).size).toBe(3);
      expect(draw(2024).map((option) => option.id)).toEqual(
        first.map((option) => option.id),
      );
    });
  });

  describe('MineralHold', () => {
    it('caps the store, carries overflow and grows capacity', () => {
      const hold = new MineralHold({ capacity: 5, collectAmount: 3 });
      expect(hold.collect()).toBe(0); // 3 / 5
      expect(hold.collect()).toBe(1); // 6 → capped at 5, overflow 1
      expect(hold.isFull).toBe(true);
      expect(hold.store).toBe(5);
      expect(hold.overflow).toBe(1);

      hold.resolve();
      expect(hold.capacity).toBe(10);
      expect(hold.store).toBe(1); // overflow carried, never reset to 0
      expect(hold.isFull).toBe(false);
    });
  });

  describe('applyMineralChoiceReward', () => {
    it('applies a weapon reward through the shared registry and player seam', () => {
      const registry = new EffectsRegistry();
      const equipped: Array<[string, boolean | undefined]> = [];
      const player = {
        equipWeapon(id: string, permanent?: boolean) {
          equipped.push([id, permanent]);
        },
      };

      applyMineralChoiceReward(toChoiceOption('spread'), registry, player);

      expect(equipped).toEqual([['spread', true]]);
      expect(registry.hasWeapon('spread')).toBe(true);
      expect(registry.activeWeapons().find((w) => w.weaponId === 'spread')?.permanent).toBe(true);
    });

    it('applies a power-up reward to the run-scoped level store', () => {
      const registry = new EffectsRegistry();
      const player = { equipWeapon: () => undefined };

      expect(registry.powerUpLevel('extra_life')).toBe(0);
      applyMineralChoiceReward(toChoiceOption('extra_life'), registry, player);
      expect(registry.powerUpLevel('extra_life')).toBe(1);
    });
  });
});
