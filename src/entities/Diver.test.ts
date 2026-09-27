import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import * as effectsModule from '../audio/effects';
import {
  colorToHSL,
  EXPLOSION_HUE_JITTER_DEG,
  resolvePatterns,
  scaledCount,
} from '../vfx/explosionParticles';
import {
  DIVER_COLOR,
  DIVER_SIZE,
  DIVER_HOLD_FORMATION_SECONDS,
  DIVER_DIVE_DURATION,
  DIVER_DIVE_APEX_FRACTION,
  DIVER_FIRE_INTERVAL,
  DIVER_PAUSE_DURATION,
  Diver,
  DiverState,
  DiverConfig,
  FormationOffset,
} from './Diver';

/** Minimal scene that only constructs Diver entities (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('Diver entity (E2 diver, GDD §4.1 — live aim tracking)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeDiver(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset });
  }

  it('renders a visible yellow body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = makeDiver(100, 100);

    expect(diver.alive).toBe(true);
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
    expect(DIVER_COLOR).toBe(0xffff00); // neon yellow per GDD §4.1
  });

  it('setAimTarget retargets the dive to the player’s live position (replacing the stand-in)', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = makeDiver(400, 300);

    // Default aim is the bottom-centre stand-in.
    const standIn = diver.aimTarget;
    expect(standIn.x).toBe(GAME_WIDTH / 2);
    expect(standIn.y).toBe(GAME_HEIGHT - 40);

    diver.setAimTarget(400, 100);
    const live = diver.aimTarget;
    expect(live.x).toBe(400);
    expect(live.y).toBe(100);
  });

  it('AC4 — the dive snapshots the aim target AT DIVE START; aim changes mid-dive leave the dive untouched', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });

    // Aim the dive far UP (target y=100). Apex is at
    // GAME_HEIGHT * DIVER_DIVE_APEX_FRACTION (0.3) — above the start.
    const aimA = { x: 400, y: 100 };
    diver.setAimTarget(aimA.x, aimA.y);

    // Hold in formation for the full hold duration — the dive starts.
    const holdTicks = Math.ceil(DIVER_HOLD_FORMATION_SECONDS / 0.5);
    for (let i = 0; i < holdTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Change the aim MID-Dive to somewhere completely different (DOWN).
    const aimB = { x: 400, y: 560 };
    diver.setAimTarget(aimB.x, aimB.y);
    expect(diver.aimTarget.x).toBe(aimB.x); // the new aim IS live for the entity
    expect(diver.aimTarget.y).toBe(aimB.y);

    // Advance the dive part-way (t=0.25 → 0.5s of the 2s dive).
    diver.applyFormationPosition(baseX, baseY, DIVER_DIVE_DURATION * 0.25, 26, 22);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // The in-flight dive still follows the dive-start snapshot (aim A),
    // NOT the mid-dive change (aim B).
    const apexY = GAME_HEIGHT * DIVER_DIVE_APEX_FRACTION;
    const apexXA = (baseX + aimA.x) / 2;
    const apexXB = (baseX + aimB.x) / 2;
    const t = 0.25;
    const pointA = Diver.computeDivePoint(
      baseX,
      baseY,
      apexXA,
      apexY,
      aimA.x,
      aimA.y,
      t,
    );
    const pointB = Diver.computeDivePoint(
      baseX,
      baseY,
      apexXB,
      apexY,
      aimB.x,
      aimB.y,
      t,
    );

    // x is locked at the dive-start slot: the snapshot path and B diverge
    // only in y, and (x+y) both match the snapshot arc.
    expect(diver.x).toBeCloseTo(pointA.x, 5);
    expect(diver.y).toBeCloseTo(pointA.y, 5);
    expect(Math.abs(diver.y - pointB.y)).toBeGreaterThan(5);
  });
});

describe('Diver entity — dive SFX (AH-0MTVYC6E8005YN6F)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    // Restore (not just clear) so the cleanup stopDiveSound() below runs
    // on the real function and is not recorded by any test's spy.
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
    // Reset module-level dive sound state.
    effectsModule.stopDiveSound();
  });

  function makeDiver(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset });
  }

  /**
   * Advances ticks until the diver reaches the target state (or gives up
   * after maxTicks). Returns the ticks used.
   */
  function advanceToState(
    diver: Diver,
    baseX: number,
    baseY: number,
    target: DiverState,
    maxTicks = 50,
  ): void {
    for (let i = 0; i < maxTicks && diver.behaviourState !== target; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
  }

  it('AC — dive-start cue fires exactly once per dive transition', async () => {
    booted = await bootScene([HarnessScene]);
    const spy = vi.spyOn(effectsModule, 'playDiverDiveStartSound');

    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);

    // Hold in formation until the dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);
    expect(spy).toHaveBeenCalledTimes(1);

    // Dive completes, returns through RETURNING to FORMATION (no extra cue).
    advanceToState(diver, baseX, baseY, DiverState.FORMATION);
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
    expect(spy).toHaveBeenCalledTimes(1);

    // Next dive cycle fires the cue again.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('AC — sustained dive sound start/stop pair is called at correct lifecycle points', async () => {
    booted = await bootScene([HarnessScene]);
    const startSpy = vi.spyOn(effectsModule, 'playDiveSound');
    const stopSpy = vi.spyOn(effectsModule, 'stopDiveSound');

    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);

    // Before dive: neither function called.
    expect(startSpy).toHaveBeenCalledTimes(0);
    expect(stopSpy).toHaveBeenCalledTimes(0);

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // Dive completes → RETURNING (stop called at DIVING→RETURNING)
    // → FORMATION.
    advanceToState(diver, baseX, baseY, DiverState.FORMATION);
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Next dive cycle: start again.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it('AC — no oscillator leak when destroyed mid-dive (stopDiveSound called)', async () => {
    booted = await bootScene([HarnessScene]);
    const stopSpy = vi.spyOn(effectsModule, 'stopDiveSound');

    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Destroy mid-dive.
    diver.destroySelf();
    expect(diver.alive).toBe(false);
    // stopDiveSound must be called to prevent oscillator leak.
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('AC — no oscillator leak on destroy() (stopDiveSound called)', async () => {
    booted = await bootScene([HarnessScene]);
    const stopSpy = vi.spyOn(effectsModule, 'stopDiveSound');

    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Call destroy() (full teardown).
    diver.destroy();
    // stopDiveSound must be called to prevent oscillator leak.
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('AC — overlapping dives pair start/stop per diver (shared-voice refcount covered in effects.test.ts)', async () => {
    booted = await bootScene([HarnessScene]);
    const startSpy = vi.spyOn(effectsModule, 'playDiveSound');
    const stopSpy = vi.spyOn(effectsModule, 'stopDiveSound');

    const baseX = 400;
    const baseY = 300;
    const diverA = makeDiver(baseX, baseY, { row: 0, col: 0 });
    const diverB = makeDiver(baseX, baseY, { row: 1, col: 1 });

    // Both divers hold into DIVING — one sustained-sound start each.
    advanceToState(diverA, baseX, baseY, DiverState.DIVING);
    advanceToState(diverB, baseX, baseY, DiverState.DIVING);
    expect(diverA.behaviourState).toBe(DiverState.DIVING);
    expect(diverB.behaviourState).toBe(DiverState.DIVING);
    expect(startSpy).toHaveBeenCalledTimes(2);

    // Diver A destroyed mid-dive releases its hold exactly once.
    diverA.destroySelf();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Diver B ending its dive releases the second hold — starts and
    // stops stay paired even with overlapping dives.
    advanceToState(diverB, baseX, baseY, DiverState.FORMATION);
    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it('AC — dive sounds degrade to no-ops in headless (no AudioContext)', async () => {
    // These functions must never throw even without a working AudioContext.
    // The effects module is shared; we just verify the calls are safe.
    expect(() => effectsModule.playDiverDiveStartSound()).not.toThrow();
    expect(() => effectsModule.playDiveSound()).not.toThrow();
    expect(() => effectsModule.stopDiveSound()).not.toThrow();
    expect(effectsModule._getDiverDiveSoundStateForTests()).toBeNull();
  });
});

describe('Diver entity — audio (GDD §7.3, Diver fire/destruction sounds)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeDiver(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset });
  }

  it('AC — plays the fire sound exactly once per spread burst (not per projectile)', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playDiverFireSound');

    const diver = makeDiver(100, 100);
    diver.shootEnabled = true;
    const t0 = 1_000_000;

    const bullets = diver.tryFireSpreadBurst(t0);
    // A full 4-projectile burst was produced…
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    // …but the sound played exactly once (shared across the volley).
    expect(effectsModule.playDiverFireSound).toHaveBeenCalledTimes(1);

    // Before the fire interval elapses no burst and no additional sound.
    expect(diver.tryFireSpreadBurst(t0 + 10)).toEqual([]);
    expect(effectsModule.playDiverFireSound).toHaveBeenCalledTimes(1);

    // After the interval a new burst fires another single sound.
    const bullets2 = diver.tryFireSpreadBurst(t0 + DIVER_FIRE_INTERVAL);
    expect(bullets2.length).toBeGreaterThanOrEqual(3);
    expect(effectsModule.playDiverFireSound).toHaveBeenCalledTimes(2);
  });

  it('AC — no firing advance cue is wired into the Diver fire path', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playDiverFireSound');
    // The Scout cue helper exists but must NOT be wired into the Diver
    // path (producer decision Q2 — fire sound alone is sufficient).
    vi.spyOn(effectsModule, 'playScoutAdvanceCue');

    const diver = makeDiver(100, 100);
    diver.shootEnabled = true;
    diver.tryFireSpreadBurst(1_000_000);

    expect(effectsModule.playDiverFireSound).toHaveBeenCalledTimes(1);
    expect(effectsModule.playScoutAdvanceCue).not.toHaveBeenCalled();
  });

  it('AC — destruction plays the Diver-specific sound via the hook and NO shared sound in playExplosion (no double-play)', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playDiverDestructionSound');
    vi.spyOn(effectsModule, 'playDestructionSound');

    const diver = makeDiver(100, 100);
    // The optional seam exists on the entity.
    expect(typeof diver.playDestructionAudio).toBe('function');

    // The destruction sound hook plays the Diver-specific sound.
    diver.playDestructionAudio();
    expect(effectsModule.playDiverDestructionSound).toHaveBeenCalledTimes(1);
    expect(effectsModule.playDestructionSound).not.toHaveBeenCalled();

    // The entity explosion path stays silent: the base scene owns
    // destruction audio timing via the seam (no double-play, §7).
    diver.destroySelf();
    expect(effectsModule.playDiverDestructionSound).toHaveBeenCalledTimes(1);
    expect(effectsModule.playDestructionSound).not.toHaveBeenCalled();
  });

  it('destruction spawns a particle burst tinted around DIVER_COLOR (AC1)', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = makeDiver(100, 100);
    expect(diver.getExplosionHandles().length).toBe(0);

    diver.destroySelf();

    const handles = diver.getExplosionHandles();
    expect(handles.length).toBe(1);
    expect(handles[0].patterns).toEqual(resolvePatterns('diver'));
    expect(handles[0].totalCount).toBe(scaledCount(DIVER_SIZE));

    const base = colorToHSL(DIVER_COLOR);
    for (const p of handles[0].particles) {
      const hsl = colorToHSL(p.color);
      let delta = Math.abs(hsl.h - base.h) % 360;
      if (delta > 180) delta = 360 - delta;
      // +0.5° allows for hex↔HSL round-trip precision at the jitter edge.
      expect(delta).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.5);
    }
  });
});

describe('Diver — rotate to face player and diagonal dive (AH-0MTGBOKLC006N8UX)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeDiver(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset });
  }

  it('AC1 — computeFacingRotation maps nose-up to the target direction', async () => {
    // Nose points up in local space: 0 = up, PI/2 = right, PI = down, -PI/2 = left.
    expect(Diver.computeFacingRotation(0, 0, 0, -100)).toBeCloseTo(0, 5);           // up
    expect(Diver.computeFacingRotation(0, 0, 100, 0)).toBeCloseTo(Math.PI / 2, 5); // right
    expect(Diver.computeFacingRotation(0, 0, 0, 100)).toBeCloseTo(Math.PI, 5);     // down
    expect(Diver.computeFacingRotation(0, 0, -100, 0)).toBeCloseTo(-Math.PI / 2, 5); // left
  });

  it('AC1 — rotation during formation smoothly tracks toward the player', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);
    // Player far to the right of the diver.
    diver.setAimTarget(600, 300);
    const desired = Diver.computeFacingRotation(diver.x, diver.y, 600, 300);
    expect(desired).toBeCloseTo(Math.PI / 2, 5);

    // One small tick: rotation moves part-way toward the target, not instantly.
    const rot0 = diver.rotation;
    diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
    expect(diver.rotation).not.toBeCloseTo(desired, 1);
    expect(Math.abs(diver.rotation - desired)).toBeLessThan(Math.abs(rot0 - desired));

    // Many ticks: converges close to the desired angle.
    for (let i = 0; i < 40; i++) diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
    expect(diver.rotation).toBeCloseTo(desired, 1);
  });

  it('AC1 — rotation updates when the target moves', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY);
    diver.setAimTarget(600, 300); // right
    for (let i = 0; i < 30; i++) diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
    const rotRight = diver.rotation;
    expect(rotRight).toBeGreaterThan(0.5);

    // Swing the target to the left — rotation should track the new direction.
    diver.setAimTarget(200, 300); // left
    for (let i = 0; i < 40; i++) diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
    expect(diver.rotation).toBeLessThan(-0.5);
  });

  it('AC2 — dive follows the full bezier diagonally to the snapshotted player position', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 200;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });
    const aim = { x: 700, y: 500 };
    diver.setAimTarget(aim.x, aim.y);

    const holdTicks = Math.ceil(DIVER_HOLD_FORMATION_SECONDS / 0.5);
    for (let i = 0; i < holdTicks; i++) diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Advance to t=0.5 (half the 2s dive) and verify both x and y follow the bezier.
    diver.applyFormationPosition(baseX, baseY, DIVER_DIVE_DURATION * 0.5, 26, 22);
    expect(diver.behaviourState).toBe(DiverState.DIVING);
    const apexY = GAME_HEIGHT * DIVER_DIVE_APEX_FRACTION;
    const apexX = (baseX + aim.x) / 2;
    const point = Diver.computeDivePoint(baseX, baseY, apexX, apexY, aim.x, aim.y, 0.5);
    expect(diver.x).toBeCloseTo(point.x, 2);
    expect(diver.y).toBeCloseTo(point.y, 2);
    // x must have moved diagonally away from start, not stayed locked.
    expect(Math.abs(diver.x - baseX)).toBeGreaterThan(50);
  });

  it('AC2 — diagonal dive also snapshots x: aim changes mid-dive do not alter x', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 200;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });
    const aimA = { x: 700, y: 500 };
    diver.setAimTarget(aimA.x, aimA.y);
    const holdTicks = Math.ceil(DIVER_HOLD_FORMATION_SECONDS / 0.5);
    for (let i = 0; i < holdTicks; i++) diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    const aimB = { x: 100, y: 100 };
    diver.setAimTarget(aimB.x, aimB.y);
    diver.applyFormationPosition(baseX, baseY, DIVER_DIVE_DURATION * 0.25, 26, 22);
    const apexY = GAME_HEIGHT * DIVER_DIVE_APEX_FRACTION;
    const apexXA = (baseX + aimA.x) / 2;
    const apexXB = (baseX + aimB.x) / 2;
    const pointA = Diver.computeDivePoint(baseX, baseY, apexXA, apexY, aimA.x, aimA.y, 0.25);
    const pointB = Diver.computeDivePoint(baseX, baseY, apexXB, apexY, aimB.x, aimB.y, 0.25);
    expect(diver.x).toBeCloseTo(pointA.x, 4);
    expect(diver.y).toBeCloseTo(pointA.y, 4);
    expect(Math.abs(diver.x - pointB.x)).toBeGreaterThan(5);
  });

  describe('rotation during dive and return — AH-0MTVYBY430008GB2', () => {
    it('AC1 — rotation during dive updates toward the player (not frozen)', async () => {
      booted = await bootScene([HarnessScene]);
      const baseX = 400;
      const baseY = 300;
      const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });
      diver.setAimTarget(700, 500); // player bottom-right

      // Hold in formation until the dive starts.
      const holdTicks = Math.ceil(DIVER_HOLD_FORMATION_SECONDS / 0.5);
      for (let i = 0; i < holdTicks; i++) {
        diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
      }
      expect(diver.behaviourState).toBe(DiverState.DIVING);

      // Reset rotation to 0 to verify dive-phase rotation updates.
      diver.rotation = 0;
      const rotBefore = diver.rotation;

      // Advance one dive tick.
      diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
      // Rotation should have changed (not frozen during dive).
      expect(diver.rotation).not.toBeCloseTo(rotBefore, 6);

      // The rotation should be moving toward the player direction.
      // At the start position, compute desired and verify rotation
      // is closer to desired than 0 was.
      const desired = Diver.computeFacingRotation(diver.x, diver.y, 700, 500);
      expect(Math.abs(diver.rotation - desired)).toBeLessThan(
        Math.abs(rotBefore - desired),
      );
    });

    it('AC2 — rotation during return updates toward the player (not frozen)', async () => {
      booted = await bootScene([HarnessScene]);
      const baseX = 200;
      const baseY = 200;
      const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });
      diver.setAimTarget(700, 500); // player bottom-right

      // Hold until dive starts.
      const holdTicks = Math.ceil(DIVER_HOLD_FORMATION_SECONDS / 0.5);
      for (let i = 0; i < holdTicks; i++) {
        diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
      }
      expect(diver.behaviourState).toBe(DiverState.DIVING);

      // Advance the dive to completion (enters PAUSING), then advance
      // past the pause to reach RETURNING.
      const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.05);
      for (let i = 0; i < diveTicks; i++) {
        diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
      }
      expect(diver.behaviourState).toBe(DiverState.PAUSING);

      // Advance past the pause duration.
      let pausingTicks = 0;
      while (
        diver.behaviourState === DiverState.PAUSING &&
        pausingTicks < 20
      ) {
        diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
        pausingTicks++;
      }
      expect(diver.behaviourState).toBe(DiverState.RETURNING);

      // Reset rotation to 0 to verify return-phase rotation updates.
      diver.rotation = 0;
      const rotBefore = diver.rotation;

      // Advance one return tick.
      diver.applyFormationPosition(baseX, baseY, 0.05, 26, 22);
      // Rotation should have changed (not frozen during return).
      expect(diver.rotation).not.toBeCloseTo(rotBefore, 6);

      // The rotation should be moving toward the player direction.
      const desired = Diver.computeFacingRotation(diver.x, diver.y, 700, 500);
      expect(Math.abs(diver.rotation - desired)).toBeLessThan(
        Math.abs(rotBefore - desired),
      );
    });
  });

  describe('scene-less (stale) diver — AH-0MTPLHLZ3006MOC4 AC3', () => {
    it('AC3 — applyFormationPosition no longer reads a live scene (a display-list-destroyed diver with scene undefined ticks without throwing)', async () => {
      booted = await bootScene([HarnessScene]);
      const diver = makeDiver(400, 300);

      // Simulate Phaser's DisplayList.shutdown: destroys the object and sets
      // its `scene` to undefined (GameObject.destroy).  The stale object may
      // still sit in the scene's bookkeeping array with _alive === true.
      (diver as unknown as { scene: Phaser.Scene | undefined }).scene =
        undefined;
      expect(diver.alive).toBe(true);

      // The per-frame formation update must not dereference `this.scene`
      // (the old code read scene.time.now here and threw).
      expect(() =>
        diver.applyFormationPosition(400, 300, 0.016, 26, 22),
      ).not.toThrow();

      // Still animate into a dive over ticks — never touching the scene.
      for (let i = 0; i < 40; i++) {
        diver.applyFormationPosition(400, 300, 0.1, 26, 22);
      }
      expect(diver.behaviourState).not.toBe(DiverState.FORMATION);
    });

    it('AC — destroySelf on a scene-less diver never throws (null-scene playExplosion guard)', async () => {
      booted = await bootScene([HarnessScene]);
      const diver = makeDiver(100, 100);
      (diver as unknown as { scene: Phaser.Scene | undefined }).scene =
        undefined;

      expect(() => diver.destroySelf()).not.toThrow();
      expect(diver.alive).toBe(false);
    });
  });
});

describe('Diver — PAUSING state (AH-0MU0EIDQQ003S1JT)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeDiver(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset });
  }

  function makeDiverWithConfig(
    x: number,
    y: number,
    offset: FormationOffset,
    config: Partial<DiverConfig> & { pauseDuration?: number },
  ): Diver {
    const scene = booted!.scene;
    return new Diver(scene, { x, y, formationOffset: offset, ...config });
  }

  function advanceToState(
    diver: Diver,
    baseX: number,
    baseY: number,
    target: DiverState,
    maxTicks = 50,
  ): void {
    for (let i = 0; i < maxTicks && diver.behaviourState !== target; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
  }

  it('AC1 — PAUSING exists in DiverState enum', async () => {
    expect((DiverState as unknown as Record<string, string>).PAUSING).toBe(
      'pausing',
    );
  });

  it('AC2 — DIVER_PAUSE_DURATION constant defaults to 500', async () => {
    expect(DIVER_PAUSE_DURATION).toBe(500);
  });

  it('AC5a — diver enters PAUSING state immediately after dive completes', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    expect(diver.behaviourState).toBe(DiverState.DIVING);

    // Advance the dive to completion — diver should enter PAUSING, not RETURNING.
    const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.5);
    for (let i = 0; i < diveTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.PAUSING);
  });

  it('AC5e — position is held during the pause (no x/y movement)', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });

    // Hold until dive starts, then advance dive to completion.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);
    const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.5);
    for (let i = 0; i < diveTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.PAUSING);

    const pauseStartX = diver.x;
    const pauseStartY = diver.y;

    // Advance through the entire pause duration.
    advanceToState(
      diver,
      baseX,
      baseY,
      DiverState.RETURNING,
      Math.ceil((DIVER_PAUSE_DURATION + 500) / 50),
    );

    // Position at the end of pause should match position at start of pause
    // (position held during pause).
    expect(diver.x).toBeCloseTo(pauseStartX, 1);
    expect(diver.y).toBeCloseTo(pauseStartY, 1);
  });

  it('AC5d — diver transitions to RETURNING after pause elapses', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);

    // Advance dive to completion (enter PAUSING).
    const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.5);
    for (let i = 0; i < diveTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.PAUSING);

    // Advance past pause duration — should transition to RETURNING.
    advanceToState(
      diver,
      baseX,
      baseY,
      DiverState.RETURNING,
      Math.ceil((DIVER_PAUSE_DURATION + 500) / 50),
    );
    expect(diver.behaviourState).toBe(DiverState.RETURNING);
  });

  it('AC5b — pause duration defaults to 500 ms (DIVER_PAUSE_DURATION)', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const diver = makeDiver(baseX, baseY, { row: 0, col: 0 });

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);

    // Advance dive to completion.
    const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.5);
    for (let i = 0; i < diveTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.PAUSING);

    // Advance with small ticks until we exit PAUSING.
    let pausingTicks = 0;
    while (
      diver.behaviourState === DiverState.PAUSING &&
      pausingTicks < 200
    ) {
      diver.applyFormationPosition(baseX, baseY, 0.1, 26, 22);
      pausingTicks++;
    }

    // The pause should have lasted approximately 500ms (5 ticks of 100ms).
    // Allow a small tolerance for tick timing.
    expect(pausingTicks).toBeGreaterThanOrEqual(4);
    expect(pausingTicks).toBeLessThanOrEqual(8);
    expect(diver.behaviourState).toBe(DiverState.RETURNING);
  });

  it('AC5c — configurable pauseDuration overrides the default', async () => {
    booted = await bootScene([HarnessScene]);
    const baseX = 400;
    const baseY = 300;
    const customPause = 1500;
    const diver = makeDiverWithConfig(baseX, baseY, { row: 0, col: 0 }, {
      pauseDuration: customPause,
    });

    // Hold until dive starts.
    advanceToState(diver, baseX, baseY, DiverState.DIVING);

    // Advance dive to completion.
    const diveTicks = Math.ceil(DIVER_DIVE_DURATION / 0.5);
    for (let i = 0; i < diveTicks; i++) {
      diver.applyFormationPosition(baseX, baseY, 0.5, 26, 22);
    }
    expect(diver.behaviourState).toBe(DiverState.PAUSING);

    // Advance with small ticks — should take ~1500ms at 100ms ticks.
    let pausingTicks = 0;
    while (
      diver.behaviourState === DiverState.PAUSING &&
      pausingTicks < 400
    ) {
      diver.applyFormationPosition(baseX, baseY, 0.1, 26, 22);
      pausingTicks++;
    }

    // Custom pause of 1500ms → ~15 ticks of 100ms.
    expect(pausingTicks).toBeGreaterThanOrEqual(13);
    expect(pausingTicks).toBeLessThanOrEqual(18);
    expect(diver.behaviourState).toBe(DiverState.RETURNING);
  });
});

describe('Diver — shot probability gate (AH-0MU0F1T2H003B4K0)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  it('a forced-success roll produces a full spread burst when the interval elapses', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = new Diver(booted.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 },
      shotProbability: 0.25, rng: () => 0.1, burstCount: 4,
    });
    diver.shootEnabled = true;
    const bullets = diver.tryFireSpreadBurst(1_000_000);
    expect(bullets.length).toBe(4);
  });

  it('a forced-failure roll consumes the cycle with no burst and leaves dive state untouched', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = new Diver(booted.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 },
      shotProbability: 0.25, rng: () => 0.9, burstCount: 4,
    });
    diver.shootEnabled = true;
    const t0 = 1_000_000;

    // Skipped: no bullets emitted, cycle consumed.
    expect(diver.tryFireSpreadBurst(t0)).toEqual([]);
    expect(diver.tryFireSpreadBurst(t0 + DIVER_FIRE_INTERVAL - 1)).toEqual([]);

    // The next elapsed cycle rolls again (also forced failure).
    expect(diver.tryFireSpreadBurst(t0 + DIVER_FIRE_INTERVAL)).toEqual([]);
    // Dive state machine was never entered/corrupted by the skipped fire.
    expect(diver.behaviourState).toBe(DiverState.FORMATION);
  });

  it('defaults shotProbability to 1.0 when omitted and always fires', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = new Diver(booted.scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 }, burstCount: 4,
    });
    diver.shootEnabled = true;
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const bullets = diver.tryFireSpreadBurst(1_000_000);
    spy.mockRestore();
    expect(bullets.length).toBe(4);
  });
});

describe('Diver — formation hold seam (AH-0MUAYB957002EMYV)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  const BASE_X = 400;
  const BASE_Y = 300;
  const SPACING_X = 26;
  const SPACING_Y = 22;

  function makeDiver(offset: FormationOffset = { row: 0, col: 0 }): Diver {
    return new Diver(booted!.scene, {
      x: BASE_X,
      y: BASE_Y,
      formationOffset: offset,
    });
  }

  /** Advances the diver's state machine until it reaches `target`. */
  function advanceToState(diver: Diver, target: DiverState): void {
    for (let i = 0; i < 100 && diver.behaviourState !== target; i++) {
      diver.applyFormationPosition(BASE_X, BASE_Y, 0.5, SPACING_X, SPACING_Y);
    }
    expect(diver.behaviourState).toBe(target);
  }

  it('AC1 — reports a hold in every detached state and releases in FORMATION', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = makeDiver();

    expect(typeof diver.requiresFormationHold).toBe('function');
    expect(diver.requiresFormationHold()).toBe(false);

    advanceToState(diver, DiverState.DIVING);
    expect(diver.requiresFormationHold()).toBe(true);

    advanceToState(diver, DiverState.PAUSING);
    expect(diver.requiresFormationHold()).toBe(true);

    advanceToState(diver, DiverState.RETURNING);
    expect(diver.requiresFormationHold()).toBe(true);

    advanceToState(diver, DiverState.FORMATION);
    expect(diver.requiresFormationHold()).toBe(false);
  });

  it('AC1 — a destroyed Diver stops requiring a hold so a mid-dive kill cannot freeze the cluster', async () => {
    booted = await bootScene([HarnessScene]);
    const diver = makeDiver();

    advanceToState(diver, DiverState.DIVING);
    expect(diver.requiresFormationHold()).toBe(true);

    diver.destroySelf();
    expect(diver.alive).toBe(false);
    expect(diver.requiresFormationHold()).toBe(false);
  });

  it('AC3 — the return re-evaluates the supplied base each frame (rejoins the live slot, never a stale dive-start point)', async () => {
    booted = await bootScene([HarnessScene]);
    // Two identical divers; both dive to the same snapshotted target.
    const diverRight = makeDiver({ row: 0, col: 1 });
    const diverLeft = makeDiver({ row: 0, col: 1 });

    advanceToState(diverRight, DiverState.RETURNING);
    advanceToState(diverLeft, DiverState.RETURNING);

    const rightBefore = diverRight.x;
    const leftBefore = diverLeft.x;

    // Same tick, different supplied formation base: the return slot is the
    // base that is passed in THIS frame, not the base at dive start.
    diverRight.applyFormationPosition(900, BASE_Y, 0.1, SPACING_X, SPACING_Y);
    diverLeft.applyFormationPosition(-400, BASE_Y, 0.1, SPACING_X, SPACING_Y);

    expect(diverRight.x).toBeGreaterThan(rightBefore);
    expect(diverLeft.x).toBeLessThan(leftBefore);
  });
});