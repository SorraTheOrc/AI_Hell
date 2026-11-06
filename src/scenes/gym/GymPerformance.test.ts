/**
 * Performance stress gym tests (AH-0MVXV0DT50028RF8, parent
 * AH-0MVWJQUN6009IS87).
 *
 * The gym's job is a **reproducible worst case**: exactly 100 late-game
 * enemies, alive, firing, on a stable formation, exposing the live counts the
 * performance harness samples. These tests pin that contract and the roster's
 * provenance (the campaign's final third, restricted to firing archetypes), so
 * neither the count nor the archetype mix can drift silently.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { LEVELS } from '../../waves/Formations';
import { ENEMY_FIRE_METHODS } from '../../entities/enemyFire';
import { Diver } from '../../entities/Diver';
import { PhaserEntity } from '../../entities/Phaser';
import { Raider } from '../../entities/Raider';
import { Scout } from '../../entities/Scout';
import { Swarm } from '../../entities/Swarm';
import { Tank } from '../../entities/Tank';
import { WATCHABLE_GYM_SCENE_KEYS } from '../../../scripts/capture-scenes.mjs';
import { GymFormationScene } from './core/GymFormationScene';
import {
  GYM_PERFORMANCE_ARCHETYPE_KEYS,
  GYM_PERFORMANCE_ENEMY_COUNT,
  GYM_PERFORMANCE_OVERLAY_NAME,
  GYM_PERFORMANCE_SCENE_KEY,
  GymPerformance,
  buildStressGridOffsets,
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
