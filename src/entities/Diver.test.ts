import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import * as effectsModule from '../audio/effects';
import {
  DIVER_COLOR,
  DIVER_HOLD_FORMATION_SECONDS,
  DIVER_DIVE_DURATION,
  DIVER_DIVE_APEX_FRACTION,
  DIVER_FIRE_INTERVAL,
  Diver,
  DiverState,
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
});