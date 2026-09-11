import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import * as effectsModule from '../audio/effects';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { FormationOffset } from '../utils/formations';
import {
  colorToHSL,
  EXPLOSION_HUE_JITTER_DEG,
  resolvePatterns,
  scaledCount,
} from '../vfx/explosionParticles';
import {
  PHASER_ADVANCE_CUE_DURATION,
  PHASER_BULLET_SPEED,
  PHASER_COLOR,
  PHASER_COLOR_NUMBER,
  PHASER_FIRE_INTERVAL,
  PHASER_SIZE,
  PhaserEntity,
  PhaserConfig,
} from './Phaser';

/** Minimal scene that only constructs Phaser entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Phaser entity (E4 phaser, GDD §4.1 — telegraph rules + live aim)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makePhaser(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): PhaserEntity {
    const scene = booted!.scene;
    const config: PhaserConfig = { x, y, formationOffset: offset };
    return new PhaserEntity(scene, config);
  }

  it('renders a visible magenta ring body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser(100, 100);

    expect(phaser.alive).toBe(true);
    expect(PHASER_COLOR).toBe('#ff00ff'); // magenta per GDD §4.1
  });

  it('setAimTarget retargets the radial pattern to the player’s live position (replacing the stand-in)', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser(240, 300);

    // Default aim is the bottom-centre stand-in.
    const standIn = phaser.aimTarget;
    expect(standIn.x).toBe(GAME_WIDTH / 2);
    expect(standIn.y).toBe(GAME_HEIGHT - 40);

    phaser.setAimTarget(240, 100);
    const live = phaser.aimTarget;
    expect(live.x).toBe(240);
    expect(live.y).toBe(100);
  });

  it('AC5 — the telegraph rules are preserved while the pattern aims at the live player', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser(240, 300);
    const t0 = 1_000_000;

    // Aim straight UP from the phaser: the pattern must point one spoke
    // exactly at the player while keeping the ≥500ms tell before firing.
    phaser.setAimTarget(240, 100);
    phaser.shootEnabled = true;

    // First eligible call starts the tell — nothing fires yet.
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]);
    expect(phaser.isTelling).toBe(true);

    // After the advance-cue duration the pattern fires: 8 radial spokes,
    // all at the configured speed, ONE aimed exactly at the player (up).
    const bullets = phaser.tryFireRadialBullets(
      t0 + PHASER_ADVANCE_CUE_DURATION,
    );
    expect(bullets).toHaveLength(8);
    expect(phaser.isTelling).toBe(false);

    // All spokes travel at the configured speed.
    for (const b of bullets) {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      expect(speed).toBeCloseTo(PHASER_BULLET_SPEED, 5);
    }

    // One spoke points exactly at the live aim (straight up).
    const up = bullets.find(
      (b) =>
        Math.abs(b.vx) < 1e-6 &&
        Math.abs(b.vy + PHASER_BULLET_SPEED) < 1e-6,
    );
    expect(up).toBeDefined();
  });

  it('destruction plays NO entity-level sound — the base scene owns playDestructionSound (no double-play)', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playDestructionSound');

    const phaser = makePhaser(100, 100);
    phaser.destroySelf();

    // The entity's explosion path must stay silent: GymFormationScene
    // .explodeRandom() plays playDestructionSound() exactly once per
    // destruction (design doc §7). An entity call here would double-play.
    expect(effectsModule.playDestructionSound).not.toHaveBeenCalled();
  });

  it('destruction spawns a ring+implosion particle burst tinted around the Phaser magenta (AC1)', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser(100, 100);
    expect(phaser.getExplosionHandles().length).toBe(0);

    phaser.destroySelf();

    const handles = phaser.getExplosionHandles();
    expect(handles.length).toBe(1);
    expect(handles[0].patterns).toEqual(resolvePatterns('phaser'));
    expect(handles[0].patterns).toEqual(['ring', 'implosion']);
    expect(handles[0].totalCount).toBe(scaledCount(PHASER_SIZE));

    const base = colorToHSL(PHASER_COLOR_NUMBER);
    for (const p of handles[0].particles) {
      const hsl = colorToHSL(p.color);
      let delta = Math.abs(hsl.h - base.h) % 360;
      if (delta > 180) delta = 360 - delta;
      // +0.5° allows for hex↔HSL round-trip precision at the jitter edge.
      expect(delta).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.5);
    }
  });

  it('AC5 — the fire interval still gates repeating cycles while aiming', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser(240, 300);
    const t0 = 1_000_000;
    phaser.setAimTarget(240, 100);
    phaser.shootEnabled = true;

    // Cycle 1: tell then fire.
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]);
    const first = phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION);
    expect(first).toHaveLength(8);

    // Within the fire interval, no new cycle may start (and therefore
    // nothing may fire) — the telegraph must also reset.
    expect(
      phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION + 500),
    ).toEqual([]);

    // After the interval, a fresh tell starts, then the next volley fires.
    const nextStart = t0 + PHASER_ADVANCE_CUE_DURATION + PHASER_FIRE_INTERVAL;
    expect(phaser.tryFireRadialBullets(nextStart)).toEqual([]);
    expect(phaser.isTelling).toBe(true);
    const second = phaser.tryFireRadialBullets(
      nextStart + PHASER_ADVANCE_CUE_DURATION,
    );
    expect(second).toHaveLength(8);
  });

  describe('scene-less (stale) phaser — AH-0MTPLHLZ3006MOC4 AC3', () => {
    it('AC3 — applyFormationPosition no longer reads a live scene (a display-list-destroyed phaser with scene undefined ticks without throwing)', async () => {
      booted = await bootScene([HarnessScene]);
      const phaser = makePhaser(240, 300);

      // Simulate Phaser's DisplayList.shutdown: destroys the object and sets
      // its `scene` to undefined (GameObject.destroy).  The stale object may
      // still sit in the scene's bookkeeping array with _alive === true.
      (phaser as unknown as { scene: Phaser.Scene | undefined }).scene =
        undefined;
      expect(phaser.alive).toBe(true);

      // The per-frame orbital update must not dereference `this.scene`
      // (the old code read scene.time.now here and threw on frame one).
      expect(() =>
        phaser.applyFormationPosition(240, 300, 0.016, 0, 0),
      ).not.toThrow();
      for (let i = 0; i < 60; i++) {
        phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
      }
      // The orbit still advances via its local phase accumulator.
      expect(phaser.x).not.toBe(240);
      expect(phaser.y).not.toBe(300);
    });

    it('AC — destroySelf on a scene-less phaser never throws (null-scene playExplosion guard)', async () => {
      booted = await bootScene([HarnessScene]);
      const phaser = makePhaser(100, 100);
      (phaser as unknown as { scene: Phaser.Scene | undefined }).scene =
        undefined;

      expect(() => phaser.destroySelf()).not.toThrow();
      expect(phaser.alive).toBe(false);
    });
  });
});