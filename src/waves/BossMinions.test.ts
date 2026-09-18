/**
 * Unit tests for the boss minion spawning logic (AH-0MU730M3T008C7CQ — child 5).
 *
 * Covers the GDD §4.3 phase mechanic: which phases summon minions, their
 * archetypes, counts, formation positions, and fire gating.
 */

import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  BOSS_MINION_WAVES,
  minionCountForPhase,
  minionsForPhase,
  planMinionSpawns,
} from './BossMinions';

describe('BossMinions — phase mechanic (GDD §4.3)', () => {
  it('summons minions on phases 1, 2 and 4 but not phase 3', () => {
    expect(minionsForPhase(1)).not.toBeNull();
    expect(minionsForPhase(2)).not.toBeNull();
    expect(minionsForPhase(4)).not.toBeNull();
    expect(minionsForPhase(3)?.groups).toEqual([]);
    expect(minionCountForPhase(3)).toBe(0);
  });

  it('returns null for unknown phases', () => {
    expect(minionsForPhase(0)).toBeNull();
    expect(minionsForPhase(5)).toBeNull();
    expect(planMinionSpawns(99)).toEqual([]);
  });

  it('Phase 1 (Scan) spawns formation enemies on both sides', () => {
    const wave = BOSS_MINION_WAVES[1];
    expect(wave.groups).toHaveLength(2);
    expect(wave.groups.every((g) => g.enemyKey === 'scout')).toBe(true);
    const starts = wave.groups.map((g) => g.startX).sort((a, b) => a - b);
    // One group hugs the left side, one the right.
    expect(starts[0]).toBeLessThan(GAME_WIDTH * 0.2);
    expect(starts[1]).toBeGreaterThan(GAME_WIDTH * 0.7);
    expect(wave.shootEnabled).toBe(true);
  });

  it('Phase 2 (Firestorm) spawns divers from the top', () => {
    const wave = BOSS_MINION_WAVES[2];
    expect(wave.groups.length).toBeGreaterThan(0);
    expect(wave.groups.every((g) => g.enemyKey === 'diver')).toBe(true);
    expect(wave.groups.every((g) => g.startY < GAME_HEIGHT * 0.2)).toBe(true);
    expect(wave.shootEnabled).toBe(true);
  });

  it('Phase 4 (Desperation) reinforces with a swarm', () => {
    const wave = BOSS_MINION_WAVES[4];
    expect(wave.groups.some((g) => g.enemyKey === 'swarm')).toBe(true);
    expect(wave.shootEnabled).toBe(true);
  });

  it('planMinionSpawns produces one on-screen spawn per minion, all firing', () => {
    const spawns = planMinionSpawns(1);
    expect(spawns).toHaveLength(minionCountForPhase(1));
    expect(spawns.length).toBeGreaterThan(0);

    const positions = new Set(spawns.map((s) => `${s.x},${s.y}`));
    expect(positions.size).toBe(spawns.length);

    for (const s of spawns) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(GAME_HEIGHT);
      expect(s.shootEnabled).toBe(true);
      expect(s.enemyKey).toBe('scout');
    }
  });

  it('minion phases never spawn on the boss anchor point', () => {
    // The boss sits at the centre; minions must reinforce from the edges.
    const centre = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 - 80 };
    for (const phase of [1, 2, 4]) {
      for (const s of planMinionSpawns(phase)) {
        const distance = Math.hypot(s.x - centre.x, s.y - centre.y);
        expect(distance).toBeGreaterThan(60);
      }
    }
  });

  it('minionCountForPhase matches the planned spawn count', () => {
    for (const phase of [1, 2, 3, 4]) {
      expect(planMinionSpawns(phase)).toHaveLength(minionCountForPhase(phase));
    }
  });
});
