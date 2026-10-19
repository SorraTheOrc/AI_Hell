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
  PHASER_BULLET_COLOR,
  PHASER_BULLET_SPEED,
  PHASER_COLOR,
  PHASER_COLOR_NUMBER,
  PHASER_FIRE_INTERVAL,
  PHASER_ORBITAL_RADIUS,
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

describe('Phaser — shot probability gate (AH-0MU0F1T2H003B4K0)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('a forced-success roll starts the tell then fires a radial burst', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = new PhaserEntity(booted.scene, {
      x: 240, y: 300, formationOffset: { row: 0, col: 0 },
      shotProbability: 0.25, rng: () => 0.1, burstCount: 8,
    });
    phaser.shootEnabled = true;
    const t0 = 1_000_000;
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]); // tell starts
    expect(phaser.isTelling).toBe(true);
    const bullets = phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION);
    expect(bullets).toHaveLength(8);
    expect(phaser.isTelling).toBe(false);
  });

  it('a forced-failure roll consumes the cycle and never starts a tell', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = new PhaserEntity(booted.scene, {
      x: 240, y: 300, formationOffset: { row: 0, col: 0 },
      shotProbability: 0.25, rng: () => 0.9, burstCount: 8,
    });
    phaser.shootEnabled = true;
    const t0 = 1_000_000;
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]);
    expect(phaser.isTelling).toBe(false);
    // Consumed cycle: nothing within the interval, next elapsed cycle rolls again.
    expect(phaser.tryFireRadialBullets(t0 + PHASER_FIRE_INTERVAL - 1)).toEqual([]);
    expect(phaser.tryFireRadialBullets(t0 + PHASER_FIRE_INTERVAL)).toEqual([]);
    expect(phaser.isTelling).toBe(false);
  });

  it('defaults shotProbability to 1.0 when omitted and always fires', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = new PhaserEntity(booted.scene, {
      x: 240, y: 300, formationOffset: { row: 0, col: 0 }, burstCount: 8,
    });
    phaser.shootEnabled = true;
    const t0 = 1_000_000;
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]); // tell
    expect(phaser.isTelling).toBe(true);
    const bullets = phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION);
    spy.mockRestore();
    expect(bullets).toHaveLength(8);
  });
});
// ── AC3: Phaser SFX wiring (AH-0MU3VPIA900697E8) ───────────────────

describe('Phaser SFX wiring (AH-0MU3VPIA900697E8)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makePhaser(config: Partial<PhaserConfig> = {}): PhaserEntity {
    return new PhaserEntity(booted!.scene, {
      x: 240, y: 300, formationOffset: { row: 0, col: 0 }, burstCount: 8,
      ...config,
    });
  }

  it('plays playPhaserAdvanceCue + playPhaserFireSound back-to-back at tell start', async () => {
    booted = await bootScene([HarnessScene]);
    const advanceSpy = vi.spyOn(effectsModule, 'playPhaserAdvanceCue');
    const fireSpy = vi.spyOn(effectsModule, 'playPhaserFireSound');

    const phaser = makePhaser();
    const t0 = 1_000_000;
    phaser.shootEnabled = true;

    expect(phaser.tryFireRadialBullets(t0)).toEqual([]); // tell starts
    expect(phaser.isTelling).toBe(true);
    // The tell visual + audio run in applyFormationPosition on the first
    // frame after the tell starts (audio plays within the first 50 ms).
    phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledTimes(1);

    // Advance cue fires before the fire sound.
    const advanceOrder = advanceSpy.mock.invocationCallOrder[0];
    const fireOrder = fireSpy.mock.invocationCallOrder[0];
    expect(advanceOrder).toBeLessThan(fireOrder);

    // No additional audio per subsequent tell frame — exactly one pair.
    phaser.applyFormationPosition(240, 300, 0.1, 0, 0);
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('plays no additional fire SFX when the volley fires (already scheduled at tell start)', async () => {
    booted = await bootScene([HarnessScene]);
    const advanceSpy = vi.spyOn(effectsModule, 'playPhaserAdvanceCue');
    const fireSpy = vi.spyOn(effectsModule, 'playPhaserFireSound');

    const phaser = makePhaser();
    const t0 = 1_000_000;
    phaser.shootEnabled = true;

    expect(phaser.tryFireRadialBullets(t0)).toEqual([]); // tell starts
    phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledTimes(1);

    const bullets = phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION);
    expect(bullets).toHaveLength(8);
    // No double-play: the firing branch adds no audio.
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledTimes(1);
  });

  it('a full cycle: one advance cue + one fire sound per burst', async () => {
    booted = await bootScene([HarnessScene]);
    const advanceSpy = vi.spyOn(effectsModule, 'playPhaserAdvanceCue');
    const fireSpy = vi.spyOn(effectsModule, 'playPhaserFireSound');

    const phaser = makePhaser();
    const t0 = 1_000_000;
    phaser.shootEnabled = true;

    // First cycle.
    expect(phaser.tryFireRadialBullets(t0)).toEqual([]); // tell
    phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
    expect(phaser.tryFireRadialBullets(t0 + PHASER_ADVANCE_CUE_DURATION))
      .toHaveLength(8); // fire
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledTimes(1);

    // Second cycle.
    const t1 = t0 + PHASER_ADVANCE_CUE_DURATION + PHASER_FIRE_INTERVAL;
    expect(phaser.tryFireRadialBullets(t1)).toEqual([]); // tell
    phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
    expect(phaser.tryFireRadialBullets(t1 + PHASER_ADVANCE_CUE_DURATION))
      .toHaveLength(8); // fire
    expect(advanceSpy).toHaveBeenCalledTimes(2);
    expect(fireSpy).toHaveBeenCalledTimes(2);
  });

  it('does not play SFX when shotProbability fails (no tell)', async () => {
    booted = await bootScene([HarnessScene]);
    const advanceSpy = vi.spyOn(effectsModule, 'playPhaserAdvanceCue');
    const fireSpy = vi.spyOn(effectsModule, 'playPhaserFireSound');

    const phaser = makePhaser({ shotProbability: 0.25, rng: () => 0.9 });
    const t0 = 1_000_000;
    phaser.shootEnabled = true;

    expect(phaser.tryFireRadialBullets(t0)).toEqual([]);
    phaser.applyFormationPosition(240, 300, 0.016, 0, 0);
    expect(phaser.isTelling).toBe(false);
    expect(advanceSpy).not.toHaveBeenCalled();
    expect(fireSpy).not.toHaveBeenCalled();
  });
});

// ── Phaser orbital geometry (AH-0MVEXVME1004SIIS) ───────────────────

describe('Phaser — count-based orbital geometry (AH-0MVEXVME1004SIIS)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makePhaser(offset: FormationOffset): PhaserEntity {
    return new PhaserEntity(booted!.scene, { x: 0, y: 0, formationOffset: offset });
  }

  it('places the body on the orbital ring at its phase (applyFormationPosition)', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser({ row: 0, col: 0, phaseCount: 4 });

    phaser.applyFormationPosition(100, 50, 0, 0, 0);

    // Phase 0 sits one orbit radius directly right of the formation centre.
    expect(phaser.x).toBeCloseTo(100 + PHASER_ORBITAL_RADIUS, 6);
    expect(phaser.y).toBeCloseTo(50, 6);
    expect(Math.hypot(phaser.x - 100, phaser.y - 50)).toBeCloseTo(
      PHASER_ORBITAL_RADIUS,
      6,
    );
  });

  it('exposes a live formation-slot seam matching the placed position', async () => {
    booted = await bootScene([HarnessScene]);
    const phaser = makePhaser({ row: 0, col: 1, phaseCount: 4 });

    phaser.applyFormationPosition(100, 50, 0.5, 0, 0);
    const slot = phaser.formationSlot(100, 50);

    // The seam returns exactly where applyFormationPosition parked the body.
    expect(slot.x).toBeCloseTo(phaser.x, 9);
    expect(slot.y).toBeCloseTo(phaser.y, 9);
    // Index 1 of 4 starts a quarter turn away from index 0.
    const phase0 = makePhaser({ row: 0, col: 0, phaseCount: 4 });
    const slot0 = phase0.formationSlot(100, 50);
    expect(Math.atan2(slot0.y - 50, slot0.x - 100)).toBeCloseTo(0, 9);
    expect(Math.atan2(slot.y - 50, slot.x - 100)).not.toBeCloseTo(0, 3);
  });

  it('gives N = 4 the existing square of four distinct on-ring slots', async () => {
    booted = await bootScene([HarnessScene]);
    const phasers = [0, 1, 2, 3].map((i) =>
      makePhaser({ row: 0, col: i, phaseCount: 4 }),
    );
    for (const p of phasers) p.applyFormationPosition(100, 50, 0, 0, 0);

    const angles = phasers.map((p) =>
      Math.round(
        (((Math.atan2(p.y - 50, p.x - 100) * 180) / Math.PI) + 360) % 360,
      ),
    );
    expect(new Set(angles).size).toBe(4);
    for (const p of phasers) {
      expect(Math.hypot(p.x - 100, p.y - 50)).toBeCloseTo(
        PHASER_ORBITAL_RADIUS,
        6,
      );
    }
  });

  it('regression — a 12-member group produces no coincident slots', async () => {
    booted = await bootScene([HarnessScene]);
    const count = 12;
    const phasers = Array.from({ length: count }, (_, i) =>
      makePhaser({ row: 0, col: i, phaseCount: count }),
    );
    for (const p of phasers) p.applyFormationPosition(100, 50, 0, 0, 0);

    const keys = phasers.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`);
    expect(new Set(keys).size).toBe(count);
  });
});

describe('Phaser — radial projectile identity (AH-0MV822DRX009RYUB)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('fires crisp phaser bolts with the shared identity: one launch pop + rotated core-streak bolts', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    const phaser = new PhaserEntity(scene, {
      x: 240, y: 300, formationOffset: { row: 0, col: 0 }, burstCount: 8,
    });

    const graphicsBefore = scene.children.list.filter(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics,
    ).length;

    phaser.shootEnabled = true;
    expect(phaser.tryFireRadialBullets(1_000_000)).toEqual([]); // tell starts
    const bullets = phaser.tryFireRadialBullets(
      1_000_000 + PHASER_ADVANCE_CUE_DURATION,
    );
    expect(bullets).toHaveLength(8);

    // The volley spawns its bolt bullet Graphics **plus** one magenta launch
    // pop at the phaser body — the enemy-side fire VFX for the whole radial
    // burst (one pop per volley, not per spoke — the burst is one fire event
    // that already plays one cue+sound pair).
    const graphicsAfter = scene.children.list.filter(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics,
    ).length;
    expect(graphicsAfter).toBe(graphicsBefore + 8 + 1);

    for (const bullet of bullets) {
      // The identity bolt keeps the established lethal-red bullet colour (the
      // shared impact pass tints the hit flash with it).
      expect(bullet.color).toBe(PHASER_BULLET_COLOR);
    }
    // Each bolt is rotated to fly nose-first along its own spoke (Phaser
    // normalises rotation to [-π, π], so compare a normalised heading).
    for (const bullet of bullets) {
      const heading = Math.atan2(bullet.vy, bullet.vx);
      let rotation = bullet.graphics.rotation;
      let expected = heading;
      if (rotation - expected > Math.PI) rotation -= Math.PI * 2;
      if (rotation - expected < -Math.PI) rotation += Math.PI * 2;
      expect(rotation).toBeCloseTo(expected, 5);
    }
  });
});
