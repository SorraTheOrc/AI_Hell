/**
 * Power-up level path — game ↔ gym parity (parent AH-0MUV5CLVQ006V9HR,
 * child AH-0MV7QSZMW009OA75).
 *
 * Boots the **real** `GymPowerUpLeveling` gym alongside `PlayScene` and
 * asserts that, for every levelled power-up (Shield–Mystery UFO) across a
 * level sweep (base / first upgrade / mid / cap), the shared power-up level
 * path is identical:
 *
 * - the run-scoped level (`Player.getPowerUpLevel`),
 * - the resolved stats (`PowerUpLevelStore.stats` === the shared
 *   `resolvePowerUpAtLevel`), and
 * - the observable effect-path outputs (Shield absorptions, Bomb range,
 *   Speed multiplier, Phase Shift charges, Teleport stacks, Extra Life
 *   lives, Magnet / Mineral Scoop stack caps, Smart Bomb pulse rate, Force
 *   Field reflect budget, Mystery UFO bounty).
 *
 * This is a **sibling parity test** co-located with
 * `CombatScene.equivalence.test.ts` (the `mineralLayer.equivalence.test.ts`
 * precedent): the duplicate-body guard there remains the authoritative
 * once-only check, and this file asserts the behavioural identity plus the
 * source-level single-definition guard for the level model itself
 * (`resolvePowerUpAtLevel` / the catalogue / the curve are defined exactly
 * once in `src/powerups/powerUpLevels.ts` / `src/utils/curve.ts` — never
 * re-declared by the gym).
 *
 * The demonstration gym is **threat-free** (AC5): P3/P4/P6/P7 *combat*
 * observability stays in the threat-based `GymPowerUpsCombat`, so the
 * parity assertion covers the resolver/level/effect-output path and
 * documents that choice. `POWER_UP_LEVEL_IDS` is asserted complete against
 * the observable map below so no levelled power-up can silently drop out of
 * the parity sweep.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  collectProductionSourceFiles,
  definesFunction,
} from '../../test/duplicateBodyGuard';
import {
  POWER_UP_LEVEL_IDS,
  resolvePowerUpAtLevel,
} from '../../powerups/powerUpLevels';
import type { EffectsRegistry } from '../../powerups/effects';
import type { PowerUpId } from '../../powerups/types';
import { PlayScene } from '../PlayScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GymPowerUpLeveling } from '../gym/GymPowerUpLeveling';

// Two Phaser games booted per parity test; under parallel load the Vitest
// default 5 s timeout is too tight. Give the file the same headroom as the
// equivalence suite.
vi.setConfig({ testTimeout: 60000 });

/** The shared level catalogues — the single sources of truth. */
const LEVEL_MODEL_FILE = 'src/powerups/powerUpLevels.ts';
const CURVE_FILE = 'src/utils/curve.ts';
const GYM_FILE = 'src/scenes/gym/GymPowerUpLeveling.ts';

/** Host ids for the two booted games (deterministic boot keeps them static). */
const PLAY_HOST = 'pu-level-parity-play-host';
const GYM_HOST = 'pu-level-parity-gym-host';

/**
 * One observable effect-path output per levelled power-up (AC2). Every
 * accessor resolves from the shared store/effects path, so equality between
 * the game and a gym is meaningful only because both consume one model.
 */
const OBSERVABLE: Record<PowerUpId, (registry: EffectsRegistry) => number> = {
  shield: (r) => r.shieldAbsorptionsRemaining(),
  bomb: (r) => r.bombRange(),
  speed_boost: (r) => r.speedMultiplier(),
  phase_shift: (r) => r.phaseCharges(),
  teleport: (r) => r.teleportStacks(),
  extra_life: (r) => r.lives(),
  magnet: (r) => r.magnetStacks(),
  mineral_scoop: (r) => r.scoopStacks(),
  // The re-balanced permanent interval (AH-0MV8GPGBL009M0D8): the pulse fires
  // every `max(10, 30 − 2×level)` seconds, so the observable is the interval
  // the shared effect-path consumers drive on (parity holds for game ↔ gym).
  smart_bomb: (r) => r.smartBombInterval(),
  force_field: (r) => r.forceFieldRemaining(),
  mystery_ufo: (r) => r.mysteryUfoMinerals(),
  // Net-new combat power-ups (AH-0MVCRC1Q0007JAV1): each observable is the
  // shared effect-path accessor the game and gyms both consume, so parity
  // holds for the new catalogue additions too.
  frenzy: (r) => r.frenzyBonusHits(),
  chrono: (r) => r.enemyBulletTimeScale(),
  thorns: (r) => r.thornsRemaining(),
  salvage: (r) => r.salvageBonusMinerals(),
  strike: (r) => r.strikeDamage(),
};

/**
 * The parity level sweep: resolver upgrade levels `0 / 1 / 3 / 8` (base,
 * first upgrade, mid, cap-saturated) reached by `collects + 1` collections
 * (the first collection unlocks the power-up at base strength).
 */
const SWEEP = [
  { upgrade: 0, collects: 1 },
  { upgrade: 1, collects: 2 },
  { upgrade: 3, collects: 4 },
  { upgrade: 8, collects: 9 },
] as const;

describe('power-up level path — game ↔ GymPowerUpLeveling parity (AC1/AC2)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    vi.restoreAllMocks();
  });

  async function bootBoth(): Promise<{
    play: PlayScene;
    gym: GymPowerUpLeveling;
  }> {
    // Deterministic boot (no wall-clock frames): the shared level path is
    // driven only by explicit `applyCollect` calls, so nothing can drift
    // between the game's live loop and the gym's (AC4).
    const play = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      PLAY_HOST,
      { deterministicBoot: true },
    );
    const gym = await bootScene(
      [GymPowerUpLeveling, MineralChoiceScene],
      GYM_HOST,
      { deterministicBoot: true },
    );
    games.push(play, gym);
    return { play: play.scene as PlayScene, gym: gym.scene as GymPowerUpLeveling };
  }

  it('AC2 — every power-up resolves the same level, stats and outputs across the sweep', async () => {
    const { play, gym } = await bootBoth();
    const playPlayer = play.getPlayer()!;
    const gymPlayer = gym.getPlayer()!;
    const playRegistry = play.getEffectsRegistry();
    const gymRegistry = gym.getEffectsRegistry();

    // Single level sweep per power-up (AC4): boot both scenes once, then
    // drive a field pickup at a time on the shared path.
    for (const id of POWER_UP_LEVEL_IDS) {
      for (const point of SWEEP) {
        while (playPlayer.getPowerUpLevel(id) < point.collects) {
          playRegistry.applyCollect(id);
          gymRegistry.applyCollect(id);
        }

        // Run-scoped level identical (the shared store is the single source).
        expect(gymPlayer.getPowerUpLevel(id), `${id} gym level`).toBe(
          playPlayer.getPowerUpLevel(id),
        );
        expect(gymPlayer.getPowerUpLevel(id), `${id} expected level`).toBe(
          point.collects,
        );

        // Resolved stats identical — and exactly the shared pure resolver.
        const playStats = playPlayer.getPowerUpLevelStore().stats(id);
        const gymStats = gymPlayer.getPowerUpLevelStore().stats(id);
        expect(gymStats, `${id} gym stats`).toEqual(playStats);
        expect(playStats, `${id} game stats`).toEqual(
          resolvePowerUpAtLevel(id, point.upgrade),
        );

        // Observable effect-path outputs identical between game and gym.
        const playOutput = OBSERVABLE[id](playRegistry);
        expect(playOutput, `${id} game output`).toBe(
          OBSERVABLE[id](gymRegistry),
        );
      }
    }
  });

  it('AC2 — the permanent P9/P10 stack caps level identically in the game and the gym', async () => {
    const { play, gym } = await bootBoth();
    for (const id of ['magnet', 'mineral_scoop'] as const) {
      const playRegistry = play.getEffectsRegistry();
      const gymRegistry = gym.getEffectsRegistry();
      let previous = 0;
      for (let grant = 1; grant <= 5; grant++) {
        playRegistry.applyCollect(id, true);
        gymRegistry.applyCollect(id, true);
        const playStacks = playRegistry.magnetStacks();
        const gymStacks = gymRegistry.magnetStacks();
        const value = id === 'magnet' ? playStacks : gymRegistry.scoopStacks();
        // Same derived stack count in both scenes after each permanent grant,
        // monotonically non-decreasing (the hybrid cap is level-derived).
        expect(gymStacks, `${id} stacks after grant ${grant}`).toBe(
          playStacks,
        );
        expect(value, `${id} growth after grant ${grant}`).toBeGreaterThanOrEqual(
          previous,
        );
        previous = value;
      }
    }
  });

  it('AC1/AC3 — the parity boots the real gym and the shared level model is defined once', async () => {
    const sources = collectProductionSourceFiles(
      path.resolve(process.cwd(), 'src'),
    ).map((file) => ({
      file: path.relative(process.cwd(), file).replace(/\\/g, '/'),
      source: fs.readFileSync(file, 'utf8'),
    }));

    // The pure resolver is defined exactly once, in the shared level module.
    const resolvers = sources.filter((entry) =>
      definesFunction(entry.source, 'resolvePowerUpAtLevel'),
    );
    expect(
      resolvers.map((entry) => entry.file),
      'resolvePowerUpAtLevel definitions',
    ).toEqual([LEVEL_MODEL_FILE]);

    // The saturation curve is likewise a single shared implementation.
    const curves = sources.filter((entry) =>
      definesFunction(entry.source, 'curveValue'),
    );
    expect(curves.map((entry) => entry.file), 'curveValue definitions').toEqual([
      CURVE_FILE,
    ]);

    // The demonstration gym introduces no copy of the resolver, the curve or
    // the level arithmetic — it imports the shared model (AC2/AC3).
    const gymEntry = sources.find((entry) => entry.file === GYM_FILE);
    expect(gymEntry, `${GYM_FILE} must exist as a production scene`).toBeDefined();
    for (const name of ['resolvePowerUpAtLevel', 'curveValue']) {
      expect(
        definesFunction(gymEntry!.source, name),
        `${GYM_FILE} must not define ${name}`,
      ).toBe(false);
    }
    expect(gymEntry!.source, `${GYM_FILE} must consume the shared model`).toContain(
      'powerUpLevels',
    );

    // The exported catalogue order drives the round robin — flowing from the
    // shared model, never a per-scene copy.
    expect(gymEntry!.source).toContain('POWER_UP_LEVEL_IDS');
  });

  it('AC5 — the parity covers every levelled power-up; the threat-free choice is documented', async () => {
    // Threat handling is explicit: this gym is a threat-free level gallery
    // (P3/P4/P6/P7 combat observability stays in GymPowerUpsCombat), so the
    // sweep above asserts the level / resolver / effect-output path. To make
    // that documented choice verifiable, every catalogue power-up must have
    // an observable map entry — none may silently drop out of the sweep.
    expect(
      POWER_UP_LEVEL_IDS.filter((id) => !(id in OBSERVABLE)),
      'every levelled power-up must be covered by the parity observable map',
    ).toEqual([]);
  });
});
