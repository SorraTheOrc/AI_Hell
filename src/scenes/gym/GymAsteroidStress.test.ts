/**
 * Asteroid stress gym tests (AH-0MW507M5L0084TSW, parent AH-0MW4857B0004GMWR).
 *
 * The gym's job is a **reproducible asteroid-rendering load**: 200 live
 * asteroids plus a representative late-game wave, stable for the whole
 * measured window and identical on every boot. These tests pin that contract,
 * the shared-entity/shared-spawn provenance the parity rule requires, and the
 * determinism a before/after `perf:measure` pair depends on.
 */

import { afterAll, describe, expect, it } from 'vitest';

import { createReusableBoot, type BootedGame } from '../../test/gameHarness';
import { createSeededRng } from '../../core/rng';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { Asteroid } from '../../entities/Asteroid';
import { ENEMY_FIRE_METHODS } from '../../entities/enemyFire';
import { LEVELS } from '../../waves/Formations';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import { WATCHABLE_GYM_SCENE_KEYS } from '../../../scripts/capture-scenes.mjs';
import { GymFormationScene } from './core/GymFormationScene';
import { GYM_PERFORMANCE_ARCHETYPE_KEYS } from './GymPerformance';
import {
  GYM_ASTEROID_STRESS_ASTEROID_COUNT,
  GYM_ASTEROID_STRESS_FIELD_SEED,
  GYM_ASTEROID_STRESS_OVERLAY_NAME,
  GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS,
  GYM_ASTEROID_STRESS_PLAYER_SPAWN,
  GYM_ASTEROID_STRESS_SCENE_KEY,
  GYM_ASTEROID_STRESS_WAVE_COUNT,
  GymAsteroidStress,
  buildAsteroidStressSpawnEvents,
} from './GymAsteroidStress';

/** One rock's observable state, rounded so a comparison is exact. */
interface RockSnapshot {
  tier: string;
  x: number;
  y: number;
  rotation: number;
}

/** A gym's live asteroids, in field (spawn) order. */
function liveAsteroids(scene: GymAsteroidStress): Asteroid[] {
  return scene.formationEntities.filter(
    (entity): entity is Asteroid => entity instanceof Asteroid && entity.alive,
  );
}

/** Rounded, ordered snapshot of the live asteroid field. */
function rockSnapshot(scene: GymAsteroidStress): RockSnapshot[] {
  return liveAsteroids(scene).map((rock) => ({
    tier: rock.getSizeTier(),
    x: Math.round(rock.x * 1e6) / 1e6,
    y: Math.round(rock.y * 1e6) / 1e6,
    rotation: Math.round(rock.rotation * 1e6) / 1e6,
  }));
}

/** The deterministic field the scene is expected to spawn. */
function expectedField() {
  return buildAsteroidStressSpawnEvents(
    createSeededRng(GYM_ASTEROID_STRESS_FIELD_SEED),
  );
}

/**
 * Archetypes the campaign's final third (levels 6–10) fields, derived from the
 * shipped `LEVELS` data so a campaign change fails the roster pin instead of
 * drifting silently.
 */
const LATE_GAME_CAMPAIGN_ARCHETYPES = new Set(
  LEVELS.filter((level) => level.level >= 6).flatMap((level) =>
    level.waves.flatMap((wave) => wave.groups.map((group) => group.enemyKey)),
  ),
);

describe('GymAsteroidStress — 200-rock asteroid stress scenario', () => {
  const reuse = createReusableBoot();
  afterAll(() => reuse.dispose());

  async function boot(): Promise<GymAsteroidStress> {
    const booted: BootedGame = await reuse.boot([GymAsteroidStress]);
    return booted.scene as GymAsteroidStress;
  }

  it('is auto-discovered and registered as a watchable scene (AC6)', () => {
    expect(GymAsteroidStress.name).toBe(GYM_ASTEROID_STRESS_SCENE_KEY);
    expect(WATCHABLE_GYM_SCENE_KEYS).toContain(GYM_ASTEROID_STRESS_SCENE_KEY);

    const entries = discoverGymScenes({
      '/src/scenes/gym/GymAsteroidStress.ts': { GymAsteroidStress },
    });
    expect(entries.map((entry) => entry.key)).toContain(
      GYM_ASTEROID_STRESS_SCENE_KEY,
    );
  });

  it('is a thin shared-core gym, not a divergent simulation (AC3)', async () => {
    const scene = await boot();
    expect(scene).toBeInstanceOf(GymFormationScene);
    expect(scene.getPlayer(), 'the shared player ship is present').not.toBeNull();
  });

  it('hosts 200 live asteroids plus the 12-enemy late-game wave (AC1/AC2)', async () => {
    const scene = await boot();

    expect(GYM_ASTEROID_STRESS_ASTEROID_COUNT).toBe(200);
    expect(scene.getAsteroidCount()).toBe(200);
    expect(scene.getWaveCount()).toBe(GYM_ASTEROID_STRESS_WAVE_COUNT);
    expect(GYM_ASTEROID_STRESS_WAVE_COUNT).toBe(12);
    // The shared probe reports every hostile body, rocks included.
    expect(scene.getPerformanceCounts().enemies).toBe(212);
    expect(scene.aliveCount).toBe(212);
    // Mixed tiers, exactly the two the shared asteroid planner produces.
    const tiers = new Set(liveAsteroids(scene).map((rock) => rock.getSizeTier()));
    expect(tiers).toEqual(new Set(['large', 'medium']));
    // No mineral load: the measured scenario is the rocks and the wave.
    expect(scene.getPerformanceCounts().minerals).toBe(0);
  });

  it('spawns every rock through the shared deterministic asteroid plan (AC3/AC4)', async () => {
    const scene = await boot();
    const planned = expectedField();
    expect(planned).toHaveLength(GYM_ASTEROID_STRESS_ASTEROID_COUNT);

    // Each live rock matches one planned event of the same tier: the shared
    // `createAsteroidFromEvent` materialiser placed it where the pure plan
    // says, at the planned (zero) velocity. The rocks are stationary, so the
    // position is exact apart from float canonicalisation.
    const rocks = liveAsteroids(scene);
    const matched = new Set<number>();
    for (const rock of rocks) {
      const index = planned.findIndex(
        (event, candidate) =>
          !matched.has(candidate) &&
          event.sizeTier === rock.getSizeTier() &&
          Math.hypot(event.x - rock.x, event.y - rock.y) <= 0.5 &&
          Math.abs(event.vx - rock.vx) < 1e-9 &&
          Math.abs(event.vy - rock.vy) < 1e-9,
      );
      expect(index, `rock at ${rock.x},${rock.y} matches a planned event`).toBeGreaterThanOrEqual(0);
      matched.add(index);
    }
    expect(matched.size).toBe(planned.length);
  });

  it('reproduces the same rock positions, rotations and count on a second boot (AC4)', async () => {
    const first = rockSnapshot(await boot());
    const second = rockSnapshot(await boot());

    expect(first).toHaveLength(200);
    expect(second).toEqual(first);
  });

  it('keeps the full load alive and the wave timeout off for the measured window (AC2)', async () => {
    const scene = await boot();

    expect(scene.isWaveTimeoutActive()).toBe(false);
    expect(scene.shootingEnabled).toBe(true);

    // Five simulated seconds of the measured scenario.
    for (let i = 0; i < 5; i += 1) scene.tick(1);

    expect(scene.getAsteroidCount()).toBe(200);
    expect(scene.getWaveCount()).toBe(12);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    // Player auto-fire is off, so the load cannot decay during a measurement.
    expect(scene.getPerformanceCounts().playerBullets).toBe(0);
  });

  it('runs rocks as shared Asteroid entities: stationary bodies, shared rotation (AC3/AC4)', async () => {
    const scene = await boot();
    const rocks = liveAsteroids(scene);
    const before = rockSnapshot(scene);

    scene.tick(1);

    // The shared Asteroid path still advances every rock's rotation each
    // frame, while the scenario's zero velocity keeps the load's positions
    // fixed (a moving field could be rammed and split mid-measurement).
    const after = liveAsteroids(scene);
    expect(after).toHaveLength(rocks.length);
    for (let i = 0; i < rocks.length; i += 1) {
      expect(rocks[i].vx).toBe(0);
      expect(rocks[i].vy).toBe(0);
      expect(after[i].x).toBeCloseTo(before[i].x, 6);
      expect(after[i].y).toBeCloseTo(before[i].y, 6);
      expect(after[i].rotation).toBeGreaterThan(before[i].rotation);
      expect(after[i].rotation - before[i].rotation).toBeCloseTo(
        rocks[i].currentRotationSpeed,
        3,
      );
    }
  });

  it('fields the late-game firing archetypes through the shared dispatcher (AC2)', async () => {
    const scene = await boot();

    // Roster provenance: late-game campaign archetypes that fire bullets.
    for (const key of GYM_PERFORMANCE_ARCHETYPE_KEYS) {
      expect(LATE_GAME_CAMPAIGN_ARCHETYPES, `${key} is late-game`).toContain(key);
      expect(
        ENEMY_FIRE_METHODS[key as keyof typeof ENEMY_FIRE_METHODS],
        `${key} fires bullets`,
      ).not.toBe('tryFireNone');
    }
    const seen = new Map<string, number>();
    for (const key of scene.waveArchetypes) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(GYM_PERFORMANCE_ARCHETYPE_KEYS.length);
    for (const key of GYM_PERFORMANCE_ARCHETYPE_KEYS) {
      expect(seen.get(key), `${key} appears twice`).toBe(2);
    }

    // Finish the wormhole emergence (enemies cannot fire while spawning), then
    // let the shared fire cadence produce bullets.
    scene.finishSpawnAnimations();
    scene.tick(1.5);
    scene.tick(0.5);

    expect(scene.getPerformanceCounts().enemyBullets).toBeGreaterThan(0);
    expect(scene.getWaveCount(), 'the wave is still on screen').toBe(12);
  });

  it('renders a stress overlay with the live asteroid and wave counts (AC5)', async () => {
    const scene = await boot();
    scene.tick(0.3);

    expect(
      scene.children.list.some(
        (child) => child.name === GYM_ASTEROID_STRESS_OVERLAY_NAME,
      ),
    ).toBe(true);
    expect(scene.stressOverlayText).toMatch(/FPS/);
    expect(scene.stressOverlayText).toMatch(/asteroids 200/);
    expect(scene.stressOverlayText).toMatch(/wave 12/);
    expect(scene.stressOverlayText).toMatch(/enemies 212/);
    expect(scene.stressOverlayText).toMatch(/enemy bullets \d+/);
  });
});

describe('buildAsteroidStressSpawnEvents — deterministic field planner (AC4)', () => {
  it('plans exactly 200 in-bounds, mixed-tier events from the same seed', () => {
    const first = buildAsteroidStressSpawnEvents(
      createSeededRng(GYM_ASTEROID_STRESS_FIELD_SEED),
    );
    const second = buildAsteroidStressSpawnEvents(
      createSeededRng(GYM_ASTEROID_STRESS_FIELD_SEED),
    );

    expect(first).toHaveLength(GYM_ASTEROID_STRESS_ASTEROID_COUNT);
    expect(second).toEqual(first);
    expect(new Set(first.map((event) => event.sizeTier))).toEqual(
      new Set(['large', 'medium']),
    );

    for (const event of first) {
      // Fully on screen: the stress field must render from the first frame
      // (no offscreen entry drift) and never wrap in from an edge.
      expect(event.x).toBeGreaterThanOrEqual(0);
      expect(event.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(event.y).toBeGreaterThanOrEqual(0);
      expect(event.y).toBeLessThanOrEqual(GAME_HEIGHT);
      // Stationary scenario load (no ram-splits mid-window).
      expect(event.vx).toBe(0);
      expect(event.vy).toBe(0);
      // Never inside the player's safe pocket.
      expect(
        Math.hypot(
          event.x - GYM_ASTEROID_STRESS_PLAYER_SPAWN.x,
          event.y - GYM_ASTEROID_STRESS_PLAYER_SPAWN.y,
        ),
      ).toBeGreaterThanOrEqual(GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS - 1e-6);
    }

    // A different seed moves the field (the seed is what varies).
    const other = buildAsteroidStressSpawnEvents(
      createSeededRng(GYM_ASTEROID_STRESS_FIELD_SEED + 1),
    );
    expect(other).not.toEqual(first);
    expect(buildAsteroidStressSpawnEvents(createSeededRng(1), 0)).toEqual([]);
  });
});
