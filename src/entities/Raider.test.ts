/**
 * Raider entity tests (classic-arcade archetype, AH-0MV01EM7U0033W7L).
 *
 * Behaviour-focused: the entity drives the shared patrol/attack state
 * machine (so the game and every gym run the same code), fires aimed shots
 * only during a committed attack and only when the level's fire rule enables
 * firing, never fires in Levels 1–3, and passes through other enemies
 * (GDD §2.6 — no enemy–enemy collision).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GAME_WIDTH } from '../core/constants';
import { fireForEnemy } from './enemyFire';
import { Scout } from './Scout';
import {
  RAIDER_ATTACK_SPEED,
  RAIDER_COLOR,
  RAIDER_COMMIT_RANGE,
  RAIDER_PATROL_SPEED,
  RAIDER_SIZE,
} from '../scenes/core/raiderPatrol';
import { Raider, raiderArena } from './Raider';

class Harness extends Phaser.Scene {
  constructor() {
    super('RaiderHarness');
  }
}

const OFFSET = { row: 0, col: 0 };

/** An RNG that always seeds the +x patrol heading (rng >= 0.5). */
const HEADING_PLUS = () => 0.9;

describe('Raider entity', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function scene(): Promise<Phaser.Scene> {
    booted = await bootScene([Harness]);
    return booted.scene;
  }

  function make(
    s: Phaser.Scene,
    overrides: Partial<ConstructorParameters<typeof Raider>[1]> = {},
  ): Raider {
    return new Raider(s, {
      x: 100,
      y: 300,
      formationOffset: OFFSET,
      rng: HEADING_PLUS,
      ...overrides,
    });
  }

  it('reports the raider archetype and shared default tuning', async () => {
    const s = await scene();
    const r = make(s);
    expect(r).toBeInstanceOf(Scout);
    expect(r.archetype).toBe('raider');
    expect(r.effectiveSize).toBe(RAIDER_SIZE);
    expect(r.effectiveColor).toBe(RAIDER_COLOR);
    expect(r.patrolSpeed).toBe(RAIDER_PATROL_SPEED);
    expect(r.attackSpeed).toBe(RAIDER_ATTACK_SPEED);
    expect(r.commitRange).toBe(RAIDER_COMMIT_RANGE);
    expect(r.mode).toBe('patrol');
    r.destroy(true);
  });

  it('accepts config-driven patrol/attack/commit overrides', async () => {
    const s = await scene();
    const r = make(s, {
      size: 30,
      color: 0x123456,
      patrolSpeed: 180,
      attackSpeed: 500,
      commitRange: 420,
    });
    expect(r.effectiveSize).toBe(30);
    expect(r.effectiveColor).toBe(0x123456);
    expect(r.patrolSpeed).toBe(180);
    expect(r.attackSpeed).toBe(500);
    expect(r.commitRange).toBe(420);
    r.destroy(true);
  });

  it('seeds the initial patrol heading from the injected RNG', async () => {
    const s = await scene();
    const left = make(s, { rng: () => 0 });
    const right = make(s, { rng: () => 0.9 });
    expect(left.patrolDir).toBe(-1);
    expect(right.patrolDir).toBe(1);
    left.destroy(true);
    right.destroy(true);
  });

  it('patrols horizontally, wrapping at the arena edge', async () => {
    const s = await scene();
    const r = make(s, { x: 950, y: 300 });
    r.applyFormationPosition(0, 0, 0.5, 0, 0);
    // 950 + 140*0.5 = 1020 → wrapped into the arena.
    expect(r.mode).toBe('patrol');
    expect(r.x).toBeLessThan(r.arena.maxX);
    expect(r.x).toBeGreaterThanOrEqual(r.arena.minX);
    r.destroy(true);
  });

  it('commits to a straight attack run when the player is in range', async () => {
    const s = await scene();
    const r = make(s, { patrolSpeed: 0 });
    r.setAimTarget(300, 300);
    expect(r.hasAimTarget).toBe(true);
    r.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(r.mode).toBe('attack');
    expect(r.attackVelocity.vx).toBeCloseTo(RAIDER_ATTACK_SPEED, 6);
    expect(r.attackVelocity.vy).toBeCloseTo(0, 6);
    r.destroy(true);
  });

  it('overshoots and wraps back into patrol, then can commit again', async () => {
    const s = await scene();
    const r = make(s, { patrolSpeed: 0, attackSpeed: 400, commitRange: 400 });
    r.setAimTarget(300, 300);
    r.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(r.mode).toBe('attack');

    // Fly the attack until it wraps.
    let sawAttack = true;
    let wrapped = false;
    for (let i = 0; i < 200 && !wrapped; i++) {
      r.applyFormationPosition(0, 0, 0.1, 0, 0);
      if (r.mode === 'attack') sawAttack = true;
      if (r.mode === 'patrol' && i > 0) wrapped = true;
    }
    expect(sawAttack).toBe(true);
    expect(wrapped).toBe(true);
    // Still on the playfield and able to re-commit.
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x).toBeLessThanOrEqual(GAME_WIDTH);
    r.setAimTarget(r.x + 20, r.y);
    r.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(r.mode).toBe('attack');
    r.destroy(true);
  });

  it('never fires during patrol, even when shooting is enabled', async () => {
    const s = await scene();
    const r = make(s, { patrolSpeed: 0 });
    r.shootEnabled = true;
    // No target → patrol; no committed attack → no shot.
    expect(r.mode).toBe('patrol');
    expect(r.tryFireAimedBullet(1_000_000)).toBeNull();
    expect(fireForEnemy(r, 'raider', 1_000_000)).toEqual([]);
    r.destroy(true);
  });

  it('never fires in Levels 1–3 (fire rule off) even during an attack', async () => {
    const s = await scene();
    const r = make(s, { patrolSpeed: 0 });
    r.setAimTarget(300, 300);
    r.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(r.mode).toBe('attack');

    // `shootEnabled` is false by default — the level fire rule (Levels 1–3).
    expect(r.shootEnabled).toBe(false);
    expect(r.tryFireAimedBullet(1_000_000)).toBeNull();
    expect(fireForEnemy(r, 'raider', 1_000_000)).toEqual([]);
    r.destroy(true);
  });

  it('fires an aimed shot during an attack when the fire rule enables it', async () => {
    const s = await scene();
    const r = make(s, { patrolSpeed: 0, shotProbability: 1, rng: () => 0 });
    r.setAimTarget(300, 300);
    r.applyFormationPosition(0, 0, 0.1, 0, 0);
    expect(r.mode).toBe('attack');

    r.shootEnabled = true;
    const t0 = 2_000_000;
    // First call starts the ≥500 ms advance-cue tell (no bullet yet) ...
    expect(r.tryFireAimedBullet(t0)).toBeNull();
    // ... the shot lands once the tell completes.
    const bullet = r.tryFireAimedBullet(t0 + 600);
    expect(bullet).not.toBeNull();
    // The bullet is aimed at the pushed target (+x from the raider).
    expect(bullet!.vx).toBeGreaterThan(0);
    expect(bullet!.vy).toBeCloseTo(0, 6);
    r.destroy(true);
  });

  it('passes through other enemies without colliding (GDD §2.6)', async () => {
    const s = await scene();
    const a = make(s, { x: 400, y: 300, rng: () => 0.9 });
    const b = make(s, { x: 400, y: 300, rng: () => 0 });
    expect(a.getHitRadius() + b.getHitRadius()).toBeGreaterThan(0);

    // Fully overlapping at spawn; stepping both must not destroy either.
    for (let i = 0; i < 5; i++) {
      a.applyFormationPosition(0, 0, 0.1, 0, 0);
      b.applyFormationPosition(0, 0, 0.1, 0, 0);
    }
    expect(a.alive).toBe(true);
    expect(b.alive).toBe(true);
    expect(a.bodyVisible).toBe(true);
    expect(b.bodyVisible).toBe(true);
    // They still moved independently.
    expect(a.x).not.toBe(b.x);
    a.destroy(true);
    b.destroy(true);
  });

  it('stays inside the arena through repeated attack cycles', async () => {
    const s = await scene();
    const r = make(s, { x: 40, y: 40, patrolSpeed: 160, attackSpeed: 360 });
    const arena = raiderArena(RAIDER_SIZE);
    for (let i = 0; i < 600; i++) {
      // Keep a live target near the raider so it commits repeatedly.
      r.setAimTarget(r.x + 30, r.y + 20);
      r.applyFormationPosition(0, 0, 0.05, 0, 0);
      expect(r.x).toBeGreaterThanOrEqual(arena.minX - 1e-6);
      expect(r.x).toBeLessThanOrEqual(arena.maxX + 1e-6);
      expect(r.y).toBeGreaterThanOrEqual(arena.minY - 1e-6);
      expect(r.y).toBeLessThanOrEqual(arena.maxY + 1e-6);
    }
    r.destroy(true);
  });
});
