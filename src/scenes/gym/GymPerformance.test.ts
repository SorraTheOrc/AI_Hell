/**
 * Performance stress gym tests (AH-0MVXV0DT50028RF8, parent
 * AH-0MVWJQUN6009IS87).
 *
 * The gym's job is a **reproducible worst case**: exactly 100 late-game
 * enemies, alive, firing, on a stable formation, exposing the live counts the
 * performance harness samples. These tests pin that contract and the roster's
 * provenance (the campaign's final third, restricted to firing archetypes), so
 * neither the count nor the archetype mix can drift silently.
 *
 * The second half of this file pins the **sweep parameterisation**
 * (AH-0MW5IUD410063FSI, paired implementation AH-0MW5IUDQD001WOXI): one scene
 * measured at any enemy count, with a per-step shoot/dive mix, a firing player
 * and a seeded loadout, all through the existing shared seams. Those specs are
 * authored red under Vitest's `it.fails` (the repo's red-before/green-after
 * convention) against the declarations-only skeleton in `GymPerformance.ts`, so
 * each one fails for the documented reason — the scene does not read the
 * parameters yet — instead of passing vacuously. The paired implementation
 * fills the bodies and flips every marker back to `it`; a leftover `it.fails`
 * then fails the suite, so the flip is deliberate.
 *
 * The plain `it` specs in that block are **invariants that must hold before and
 * after** the change, not placeholders: the sweep roster mirrors the scene
 * roster, the default (no launch data) scenario still fires no player bullets,
 * and a sweep loadout still arrives only through the shared
 * `applySceneSetup` seam. They are the guard that the parameterisation cannot
 * fork spawn, fire or loadout logic.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH, POWER_UP_SLOT_CAP } from '../../core/constants';
import { LEVELS } from '../../waves/Formations';
import { ENEMY_FIRE_METHODS } from '../../entities/enemyFire';
import { Diver } from '../../entities/Diver';
import { PhaserEntity } from '../../entities/Phaser';
import { Raider } from '../../entities/Raider';
import { Scout } from '../../entities/Scout';
import { Swarm } from '../../entities/Swarm';
import { Tank } from '../../entities/Tank';
import { WATCHABLE_GYM_SCENE_KEYS } from '../../../scripts/capture-scenes.mjs';
import {
  SWEEP_ARCHETYPE_KEYS,
  selectEnemyMix,
  selectLoadout,
} from '../../perf/sweepPlan';
import { GymFormationScene } from './core/GymFormationScene';
import {
  GYM_PERFORMANCE_ARCHETYPE_KEYS,
  GYM_PERFORMANCE_ENEMY_COUNT,
  GYM_PERFORMANCE_GRID_COLUMNS,
  GYM_PERFORMANCE_MIN_SPACING_X,
  GYM_PERFORMANCE_MIN_SPACING_Y,
  GYM_PERFORMANCE_OVERLAY_NAME,
  GYM_PERFORMANCE_PLAYFIELD,
  GYM_PERFORMANCE_SCENE_KEY,
  GYM_PERFORMANCE_SPACING_X,
  GYM_PERFORMANCE_SPACING_Y,
  GYM_PERFORMANCE_START_X,
  GYM_PERFORMANCE_START_Y,
  GymPerformance,
  buildStressGridOffsets,
  layoutForCount,
  type GymPerformanceLaunchData,
  type GymPerformanceMixEntry,
} from './GymPerformance';

/**
 * Archetypes the campaign's final third (levels 6–10) fields, derived from
 * the shipped `LEVELS` data rather than hard-coded, so a campaign change makes
 * the roster pin fail instead of silently drifting.
 */
const LATE_GAME_CAMPAIGN_ARCHETYPES = new Set(
  LEVELS.filter((level) => level.level >= 6).flatMap((level) =>
    level.waves.flatMap((wave) => wave.groups.map((group) => group.enemyKey)),
  ),
);

/** Expected per-archetype counts for a round-robin over the 100 grid slots. */
function expectedArchetypeCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of buildStressGridOffsets(GYM_PERFORMANCE_ENEMY_COUNT).map(
    (offset) =>
      GYM_PERFORMANCE_ARCHETYPE_KEYS[
        (offset.row * 10 + offset.col) % GYM_PERFORMANCE_ARCHETYPE_KEYS.length
      ],
  )) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('GymPerformance — 100-enemy stress scenario', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
  });

  async function boot(): Promise<GymPerformance> {
    const game = await bootScene([GymPerformance]);
    games.push(game);
    return game.scene as GymPerformance;
  }

  it('is auto-discovered and registered as a watchable scene (AC3)', () => {
    expect(GymPerformance.name).toBe(GYM_PERFORMANCE_SCENE_KEY);
    expect(WATCHABLE_GYM_SCENE_KEYS).toContain(GYM_PERFORMANCE_SCENE_KEY);
  });

  it('runs the shipped gym/combat core rather than a copy (AC1)', async () => {
    const scene = await boot();
    expect(scene).toBeInstanceOf(GymFormationScene);
    expect(scene.getPlayer(), 'the shared player ship is present').not.toBeNull();
  });

  it('boots exactly 100 live late-game enemies (AC2)', async () => {
    const scene = await boot();

    expect(GYM_PERFORMANCE_ENEMY_COUNT).toBe(100);
    expect(scene.formationEntities).toHaveLength(100);
    expect(scene.aliveCount).toBe(100);
    expect(scene.getPerformanceCounts().enemies).toBe(100);

    // Roster provenance: every archetype is one the campaign's final third
    // fields, and every one of them fires bullets (the measured load).
    for (const key of GYM_PERFORMANCE_ARCHETYPE_KEYS) {
      expect(LATE_GAME_CAMPAIGN_ARCHETYPES, `${key} is late-game`).toContain(key);
      expect(
        ENEMY_FIRE_METHODS[key as keyof typeof ENEMY_FIRE_METHODS],
        `${key} fires bullets`,
      ).not.toBe('tryFireNone');
    }

    // Deterministic round-robin mix over the grid.
    const seen = new Map<string, number>();
    for (const key of scene.archetypes) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen).toEqual(expectedArchetypeCounts());
    expect(new Set(scene.archetypes).size).toBe(
      GYM_PERFORMANCE_ARCHETYPE_KEYS.length,
    );
  });

  it('spawns each archetype through the shared entity factory', async () => {
    const scene = await boot();
    const counts = expectedArchetypeCounts();
    const entities = scene.formationEntities;

    expect(entities.filter((entity) => entity instanceof Tank)).toHaveLength(
      counts.get('tank') ?? 0,
    );
    expect(entities.filter((entity) => entity instanceof Swarm)).toHaveLength(
      counts.get('swarm') ?? 0,
    );
    expect(
      entities.filter((entity) => entity instanceof PhaserEntity),
    ).toHaveLength(counts.get('phaser') ?? 0);
    expect(entities.filter((entity) => entity instanceof Diver)).toHaveLength(
      counts.get('diver') ?? 0,
    );
    expect(entities.filter((entity) => entity instanceof Raider)).toHaveLength(
      counts.get('raider') ?? 0,
    );
    // `march` reuses the Scout body with the shared march movement policy.
    expect(
      entities.filter(
        (entity) => entity instanceof Scout && !(entity instanceof Raider),
      ),
    ).toHaveLength(counts.get('march') ?? 0);
  });

  it('runs live enemy fire through the shared dispatcher (AC2)', async () => {
    const scene = await boot();

    expect(scene.shootingEnabled).toBe(true);
    expect(scene.getEntityShootingStates()).toEqual(
      new Array(GYM_PERFORMANCE_ENEMY_COUNT).fill(true),
    );

    // Finish the wormhole emergence (enemies cannot fire while spawning),
    // then let the shared fire cadence produce bullets.
    scene.finishSpawnAnimations();
    scene.tick(1.5);
    scene.tick(0.5);

    const counts = scene.getPerformanceCounts();
    expect(counts.enemyBullets, 'enemy bullets in flight').toBeGreaterThan(0);
    expect(scene.aliveCount, 'the full load is still on screen').toBe(100);

    // Player auto-fire is off, so the 100-enemy load cannot decay during the
    // measured window (the scenario is a stable worst case, not a playthrough).
    expect(scene.getPerformanceCounts().playerBullets).toBe(0);
  });

  it('exposes the live counts the harness samples, with no mineral load (AC2)', async () => {
    const scene = await boot();

    const counts = scene.liveCounts;
    expect(counts.enemies).toBe(GYM_PERFORMANCE_ENEMY_COUNT);
    // The scenario is enemies + fire only: no seeded mineral field.
    expect(counts.minerals).toBe(0);
    // Bullet counts are live readings (the player may already have fired).
    expect(counts.enemyBullets).toBeGreaterThanOrEqual(0);
    expect(counts.playerBullets).toBeGreaterThanOrEqual(0);
    expect(
      scene.getMinerals(),
      'the demonstration mineral field is disabled',
    ).toHaveLength(0);
  });

  it('renders a stress overlay with FPS and live counts (AC7)', async () => {
    const scene = await boot();
    // Cross the overlay's low-cadence refresh interval.
    scene.tick(0.3);

    expect(
      scene.children.list.some(
        (child) => child.name === GYM_PERFORMANCE_OVERLAY_NAME,
      ),
    ).toBe(true);
    expect(scene.stressOverlayText).toMatch(/FPS/);
    expect(scene.stressOverlayText).toMatch(/enemies 100/);
    expect(scene.stressOverlayText).toMatch(/enemy bullets \d+/);
    expect(scene.stressOverlayText).toMatch(/player bullets \d+/);
  });

  it('lays the formation out as a deterministic 10 × 10 grid (AC2)', () => {
    const offsets = buildStressGridOffsets(GYM_PERFORMANCE_ENEMY_COUNT);
    expect(offsets).toHaveLength(GYM_PERFORMANCE_ENEMY_COUNT);
    expect(new Set(offsets.map(({ row, col }) => `${row}:${col}`)).size).toBe(
      GYM_PERFORMANCE_ENEMY_COUNT,
    );
    expect(offsets[0]).toEqual({ row: 0, col: 0 });
    expect(offsets[offsets.length - 1]).toEqual({ row: 9, col: 9 });
    expect(buildStressGridOffsets(0)).toEqual([]);
    // Deterministic: two builds are byte-for-byte equal.
    expect(buildStressGridOffsets(GYM_PERFORMANCE_ENEMY_COUNT)).toEqual(offsets);
  });
});

/** Counts each archetype key of a spawn-order archetype list. */
function countArchetypes(
  keys: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

/** Every rendered text string in a scene (the overlay and the hint line). */
function renderedTexts(scene: GymPerformance): string[] {
  return scene.children.list.flatMap((child) => {
    const text = (child as { text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  });
}

/**
 * A `GymPerformance` booted with sweep launch data, plus the read-back seams
 * the parameterisation contract needs: the formation count the shared spawn
 * loop actually uses (`config.count`, the only source of the number) and the
 * slot spacing it was built with.
 */
type ParameterisedPerformance = GymPerformance & {
  readonly formationCount: number;
  readonly formationSpacing: { readonly x: number; readonly y: number };
};

describe('GymPerformance — sweep parameterisation (AH-0MW5IUD410063FSI)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    localStorage.clear();
  });

  /**
   * Boots the scene with launch data through a wrapper, so `init(data)` runs
   * before `create()` (the shared harness boots a scene class with no data).
   */
  async function bootWithLaunch(
    launch?: GymPerformanceLaunchData,
  ): Promise<ParameterisedPerformance> {
    class Wrapper extends GymPerformance {
      override init(_data?: GymPerformanceLaunchData | null): void {
        super.init(launch ?? null);
      }

      get formationCount(): number {
        return this.config.count;
      }

      get formationSpacing(): { x: number; y: number } {
        return { x: this.config.spacingX, y: this.config.spacingY };
      }
    }
    const game = await bootScene([Wrapper]);
    games.push(game);
    return game.scene as ParameterisedPerformance;
  }

  it('keeps the sweep and scene rosters identical (AH-0MW5IUBGV005IFHM request)', () => {
    // The planner declares its own Phaser-free mirror of the roster so its
    // specs run in the fast unit project; this integration spec is the one
    // place both can be imported, so the mirror cannot drift silently.
    expect(SWEEP_ARCHETYPE_KEYS).toEqual(GYM_PERFORMANCE_ARCHETYPE_KEYS);
  });

  it('keeps player fire off unless the launch data asks for it (AC3 default)', async () => {
    // The 100-enemy stress scenario must not decay during a measurement: with
    // no launch data the shared auto-fire path stays off, even though enemies
    // fire. This pins the default before and after the parameterisation.
    const scene = await bootWithLaunch({ autoFire: false });
    scene.finishSpawnAnimations();
    scene.tick(1.5);
    scene.tick(0.5);

    expect(scene.getPerformanceCounts().playerBullets).toBe(0);
  });

  it('applies a sweep loadout only through the shared applySceneSetup seam (AC4)', async () => {
    const loadout = selectLoadout({ seed: 0x5eed_10ad, aggression: 7 });
    // The planner fills at most the shipped six-slot cap.
    expect(loadout.weapons.length + loadout.powerUps.length).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP,
    );

    const scene = await bootWithLaunch({
      count: 50,
      player: {
        // A level N is N permanent grants, so the weapon lands at level N.
        weaponLevels: Object.fromEntries(
          loadout.weapons.map((grant) => [grant.id, grant.level]),
        ),
        // A stationary ship must aim into the formation above it.
        heading: -90,
      },
      powerUps: Object.fromEntries(
        loadout.powerUps.map((grant) => [grant.id, grant.level]),
      ),
      seed: loadout.seed,
    });

    const player = scene.getPlayer();
    if (!player) throw new Error('the shared player ship is missing');

    for (const grant of loadout.weapons) {
      expect(player.hasWeapon(grant.id), `${grant.id} is equipped`).toBe(true);
      expect(
        player.getPermanentWeaponLevel(grant.id),
        `${grant.id} level`,
      ).toBe(grant.level);
    }
    const store = player.getPowerUpLevelStore();
    for (const grant of loadout.powerUps) {
      expect(store.getLevel(grant.id), `${grant.id} level`).toBe(grant.level);
    }

    // Exactly the supplied loadout was granted (nothing test-only, no extras),
    // and the applied counted kinds respect the six-slot cap.
    const equipped = player
      .getActiveWeapons()
      .filter((id) => id !== 'cannon')
      .sort();
    expect(equipped).toEqual(loadout.weapons.map((grant) => grant.id).sort());
    expect(
      equipped.length + store.getLevels().length,
      'applied counted kinds respect POWER_UP_SLOT_CAP',
    ).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);

    // Aimed up the screen (direction-checked, so angle normalisation is free).
    expect(Math.cos(player.getHeading())).toBeCloseTo(0, 5);
    expect(Math.sin(player.getHeading())).toBeCloseTo(-1, 5);
  });

  it.fails(
    'spawns exactly the configured count through the shared config.count seam (AC1)',
    async () => {
      const scene = await bootWithLaunch({ count: 150 });
      const layout = layoutForCount(150);

      // config.count is the only source of the number: the shared spawn loop
      // and the reported counts all agree with the launch data.
      expect(scene.formationCount).toBe(150);
      expect(scene.formationEntities).toHaveLength(150);
      expect(scene.aliveCount).toBe(150);
      expect(scene.getPerformanceCounts().enemies).toBe(150);
      // The layout the count resolves to is what the spawn loop is built with.
      expect(scene.formationSpacing).toEqual({
        x: layout.spacingX,
        y: layout.spacingY,
      });
    },
  );

  it.fails(
    'applies a supplied enemy mix exactly and deterministically (AC2)',
    async () => {
      const mix: GymPerformanceMixEntry[] = [
        { archetype: 'tank', count: 6 },
        { archetype: 'diver', count: 3 },
        { archetype: 'swarm', count: 3 },
      ];
      const first = await bootWithLaunch({ count: 12, enemyMix: mix });
      const second = await bootWithLaunch({ count: 12, enemyMix: mix });

      const expected = { tank: 6, diver: 3, swarm: 3 };
      expect(countArchetypes(first.archetypes)).toEqual(expected);
      // Derived from the slot index, never a mutable spawn counter: two boots
      // of the same setup produce the identical slot-by-slot roster.
      expect(second.archetypes).toEqual(first.archetypes);
      expect(new Set(first.archetypes)).toEqual(
        new Set(['tank', 'diver', 'swarm']),
      );

      // The mix reaches the live entities through the shared factory.
      expect(
        first.formationEntities.filter((entity) => entity instanceof Tank),
      ).toHaveLength(6);
      expect(
        first.formationEntities.filter((entity) => entity instanceof Diver),
      ).toHaveLength(3);
      expect(
        first.formationEntities.filter((entity) => entity instanceof Swarm),
      ).toHaveLength(3);
    },
  );

  it.fails(
    "accepts the planner's seeded mix entries verbatim (sweep driver seam, AC2)",
    async () => {
      const mix = selectEnemyMix({ seed: 0x5eed_3a71, count: 24, stepIndex: 2 });
      expect(
        mix.entries.reduce((total, entry) => total + entry.count, 0),
      ).toBe(24);

      const scene = await bootWithLaunch({ count: 24, enemyMix: mix.entries });
      const expected: Record<string, number> = {};
      for (const entry of mix.entries) expected[entry.archetype] = entry.count;

      expect(countArchetypes(scene.archetypes)).toEqual(expected);
    },
  );

  it.fails(
    'enables the shared player auto-fire path only when asked (AC3)',
    async () => {
      const scene = await bootWithLaunch({ autoFire: true });
      scene.finishSpawnAnimations();
      scene.tick(1.5);
      scene.tick(0.5);

      // The measured step includes the player's own bullets and kills.
      expect(scene.getPerformanceCounts().playerBullets).toBeGreaterThan(0);
    },
  );

  it.fails(
    'lays a fully on-screen grid for every swept count with the documented minimum spacing (AC5)',
    () => {
      // The box itself must sit inside the canvas, clear of the HUD.
      expect(GYM_PERFORMANCE_PLAYFIELD.left).toBeGreaterThanOrEqual(0);
      expect(GYM_PERFORMANCE_PLAYFIELD.top).toBeGreaterThanOrEqual(0);
      expect(
        GYM_PERFORMANCE_PLAYFIELD.left + GYM_PERFORMANCE_PLAYFIELD.width,
      ).toBeLessThanOrEqual(GAME_WIDTH);
      expect(
        GYM_PERFORMANCE_PLAYFIELD.top + GYM_PERFORMANCE_PLAYFIELD.height,
      ).toBeLessThanOrEqual(GAME_HEIGHT);

      for (const count of [50, 100, 200, 400]) {
        const layout = layoutForCount(count);
        const label = `count ${count}`;

        expect(layout.count, label).toBe(count);
        expect(layout.offsets, label).toHaveLength(count);
        expect(layout.columns * layout.rows, label).toBeGreaterThanOrEqual(count);
        expect(new Set(layout.offsets.map(({ row, col }) => `${row}:${col}`)).size,
          `${label} slots are unique`,
        ).toBe(count);
        // Documented minimum spacing: the block must not collapse into itself.
        expect(layout.spacingX, label).toBeGreaterThanOrEqual(
          GYM_PERFORMANCE_MIN_SPACING_X,
        );
        expect(layout.spacingY, label).toBeGreaterThanOrEqual(
          GYM_PERFORMANCE_MIN_SPACING_Y,
        );

        // The whole block stays inside the on-screen box (a block below the
        // canvas would measure an off-screen load).
        const blockWidth = (layout.columns - 1) * layout.spacingX;
        const blockHeight = (layout.rows - 1) * layout.spacingY;
        expect(layout.startX, label).toBeGreaterThanOrEqual(
          GYM_PERFORMANCE_PLAYFIELD.left,
        );
        expect(layout.startX + blockWidth, label).toBeLessThanOrEqual(
          GYM_PERFORMANCE_PLAYFIELD.left + GYM_PERFORMANCE_PLAYFIELD.width,
        );
        expect(layout.startY, label).toBeGreaterThanOrEqual(
          GYM_PERFORMANCE_PLAYFIELD.top,
        );
        expect(layout.startY + blockHeight, label).toBeLessThanOrEqual(
          GYM_PERFORMANCE_PLAYFIELD.top + GYM_PERFORMANCE_PLAYFIELD.height,
        );

        // Deterministic geometry: a re-run lays out identically.
        expect(layoutForCount(count), `${label} is deterministic`).toEqual(layout);
      }
    },
  );

  it.fails(
    'keeps the historical 10 × 10 geometry at the default count (AC5)',
    () => {
      const layout = layoutForCount(GYM_PERFORMANCE_ENEMY_COUNT);

      expect(layout.columns).toBe(GYM_PERFORMANCE_GRID_COLUMNS);
      expect(layout.rows).toBe(10);
      expect(layout.spacingX).toBe(GYM_PERFORMANCE_SPACING_X);
      expect(layout.spacingY).toBe(GYM_PERFORMANCE_SPACING_Y);
      expect(layout.startX).toBe(GYM_PERFORMANCE_START_X);
      expect(layout.startY).toBe(GYM_PERFORMANCE_START_Y);
      expect(layout.offsets).toEqual(
        buildStressGridOffsets(GYM_PERFORMANCE_ENEMY_COUNT),
      );
    },
  );

  it.fails(
    'names the configured count in the stress overlay and hint (AC6)',
    async () => {
      const scene = await bootWithLaunch({ count: 150 });
      // Cross the overlay's low-cadence refresh interval.
      scene.tick(0.3);
      const texts = renderedTexts(scene);

      expect(scene.stressOverlayText).toContain('enemies 150');
      // No stress label still advertises the hard-coded default load.
      expect(
        texts.some((text) => text.includes('100 late-game enemies')),
        'no label still advertises 100 enemies',
      ).toBe(false);
      // The hint line names the configured count too.
      expect(
        texts.some((text) => text.includes('150 late-game enemies')),
        'the hint names the configured count',
      ).toBe(true);
    },
  );
});
