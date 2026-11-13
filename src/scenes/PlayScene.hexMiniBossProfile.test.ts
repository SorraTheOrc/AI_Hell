/**
 * PlayScene — the deployment's mini-boss wears the hex profile (Rule 2)
 * (AH-0MWCOW50P002TWGP, parent AH-0MWBW1B1Z0059CC2; producer Q3 = a).
 *
 * A Hangar War deployment now ends on its level's wave-5 **mini-boss**, so
 * Rule 2 ("the boss wields it first") has to hold for that encounter rather
 * than the shipped final boss. The hex profile (`buildHexBossProfile`) already
 * publishes what the encounter must wear — the granted weapon's colour, the
 * aggressive hit-pool multiplier and the catalogue-derived volley — but
 * `PlayScene.miniBossConfigFor()` still returns the untouched per-level design.
 *
 * The intended mapping, pinned here (implementation item AH-0MWCOW5IO001KJ8D):
 *
 * - `color` / `desperationColor` ← `profile.bodyColor` / `profile.desperationColor`;
 * - `hpPerPhase` ← `max(1, round(scaledEncounterHp(design.hpPerPhase, power) × profile.hpMultiplier))`
 *   — the same bounded perturbation the shipped hex boss applies;
 * - `demonstratedWeapon` ← `profile.demonstration` (absent for a non-weapon
 *   grant, so nothing is demonstrated);
 * - every other field (identity, phases, minions, position, RNG) stays the
 *   per-level design's, so later phases keep the level's `MiniBossPattern`.
 *
 * An arcade run (`▶ Play Game`) has no hex profile, so its config must stay
 * byte-identical to the design's — asserted here every run.
 *
 * **TEST-FIRST — red-before/green-after.** These cases were authored red
 * against pre-change HEAD (the config was the bare design: design colour,
 * design hit pool, no demonstration) and turned green by the implementation
 * item (AH-0MWCOW5IO001KJ8D), which flipped them to plain `it`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { scaledEncounterHp } from '../core/difficultyScaling';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import type { MiniBossConfig } from '../entities/MiniBoss';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { BULLET_COLORS } from '../utils/weapons';
import {
  miniBossConfigForLevel,
  miniBossDesignForLevel,
} from '../waves/miniBossDesigns';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from './hangarWar/hangarDeployment';

/** The weapon hex: aggression 3 → campaign level 4, grants `rapid`. */
const WEAPON_HEX = 'hex-r1-3';
/** The non-weapon hex: aggression 1 → campaign level 2, grants `extra-life`. */
const SUPPORT_HEX = 'hex-r1-2';

/** The deployed mini-boss config with the not-yet-shipped demonstration hook. */
type DemoMiniBossConfig = MiniBossConfig & {
  demonstratedWeapon?: unknown;
};

/** Private scene seams this suite reads (the same seams the existing suites use). */
interface SceneSeams {
  miniBossConfigFor(level: number): MiniBossConfig;
  rng: () => number;
}

/** A fresh war with ring 1 materialised from the authored data. */
function ringPayload(): HangarWarPayload {
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
}

describe('PlayScene — hex mini-boss wears the hex profile (AH-0MWCOW50P002TWGP)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    saveHangarWarPayload(ringPayload());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(
    hangarWar: HangarWarDeployment | null,
  ): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({ demo: false, hangarWar });
    await advanceGame(scene.game, 200);
    return scene;
  }

  /** Boots a deployment to `hexId` and returns its scene, level and profile. */
  async function bootDeployment(hexId: string): Promise<{
    scene: PlayScene;
    level: number;
    profile: NonNullable<ReturnType<PlayScene['getHexBossProfile']>>;
  }> {
    const payload = ringPayload();
    saveHangarWarPayload(payload);
    const deployment = buildHangarDeployment(payload, { hexId });
    const scene = await bootPlay(deployment);
    const profile = scene.getHexBossProfile();
    if (profile === null) {
      throw new Error(`fixture error: ${hexId} must resolve a hex profile`);
    }
    return { scene, level: deployment.startLevel, profile };
  }

  /** The live mini-boss config the scene would spawn at `level`. */
  function configFor(level: number, scene: PlayScene): DemoMiniBossConfig {
    return (scene as unknown as SceneSeams).miniBossConfigFor(level);
  }

  /** The untouched per-level design config, as the arcade run builds it. */
  function designConfigFor(level: number, scene: PlayScene): MiniBossConfig {
    const design = miniBossDesignForLevel(level);
    return miniBossConfigForLevel(level, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2 - 80,
      formationOffset: { row: 0, col: 0 },
      rng: (scene as unknown as SceneSeams).rng,
      hpPerPhase: scaledEncounterHp(
        design.hpPerPhase,
        scene.getPlayerPowerScore(),
      ),
    });
  }

  // ── AC1: the granted weapon's colour ────────────────────────────

  it(
    'AC1 — a deployment’s mini-boss wears the granted weapon’s colour',
    async () => {
      const { scene, level, profile } = await bootDeployment(WEAPON_HEX);
      const config = configFor(level, scene);

      // The profile demonstrates `rapid` (the hex's authored grant).
      expect(profile.grant?.weaponId).toBe('rapid');
      expect(profile.bodyColor).toBe(BULLET_COLORS.rapid);

      expect(config.color).toBe(profile.bodyColor);
      expect(config.desperationColor).toBe(profile.desperationColor);
    },
  );

  // ── AC1: the opening volley is the granted weapon's ────────────

  it(
    'AC1 — a deployment’s mini-boss opens with the granted weapon’s volley',
    async () => {
      const { scene, level, profile } = await bootDeployment(WEAPON_HEX);

      expect(profile.demonstration).not.toBeNull();
      expect(configFor(level, scene).demonstratedWeapon).toEqual(
        profile.demonstration,
      );
    },
  );

  // ── AC2: the profile perturbs the hit pool ─────────────────────

  it(
    'AC2 — the hit pool is perturbed by the hex profile’s multiplier',
    async () => {
      const { scene, level, profile } = await bootDeployment(WEAPON_HEX);
      const design = miniBossDesignForLevel(level);
      const scaled = scaledEncounterHp(
        design.hpPerPhase,
        scene.getPlayerPowerScore(),
      );

      expect(configFor(level, scene).hpPerPhase).toBe(
        Math.max(1, Math.round(scaled * profile.hpMultiplier)),
      );
    },
  );

  // ── AC2: a non-weapon grant demonstrates nothing ───────────────

  it(
    'AC2 — a non-weapon grant falls back to the deterministic palette',
    async () => {
      const { scene, level, profile } = await bootDeployment(SUPPORT_HEX);

      // `extra-life` is a hangar entry, not a weapon: nothing to demonstrate.
      expect(profile.grant?.weaponId).toBeNull();
      expect(profile.demonstration).toBeNull();
      expect(configFor(level, scene).color).toBe(profile.bodyColor);
    },
  );

  it('AC2 — a non-weapon grant demonstrates no volley', async () => {
    const { scene, level } = await bootDeployment(SUPPORT_HEX);
    const config = configFor(level, scene);

    expect(config.demonstratedWeapon ?? null).toBeNull();
  });

  // ── AC3: later phases keep the design ──────────────────────────

  it('AC3 — a deployment keeps the design’s per-phase patterns and identity', async () => {
    const { scene, level } = await bootDeployment(WEAPON_HEX);
    const design = miniBossDesignForLevel(level);
    const config = configFor(level, scene);

    expect(config.phases).toEqual(design.phases.map((pattern) => ({ pattern })));
    expect(config.name).toBe(design.archetype);
    expect(config.level).toBe(design.level);
    expect(config.minions).toEqual(
      design.minions?.map((wave) => ({
        ...wave,
        groups: wave.groups.map((group) => ({ ...group })),
      })),
    );
  });

  // ── AC3: the arcade campaign is untouched ─────────────────────

  it('AC3 — an arcade run’s mini-boss config is unchanged', async () => {
    const scene = await bootPlay(null);
    expect(scene.isHangarWarRun()).toBe(false);
    expect(scene.getHexBossProfile()).toBeNull();

    const config = configFor(1, scene);
    expect(config).toEqual(designConfigFor(1, scene));
    expect('demonstratedWeapon' in config).toBe(false);
  });
});
