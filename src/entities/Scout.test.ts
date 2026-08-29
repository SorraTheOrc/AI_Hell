import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import * as effectsModule from '../audio/effects';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  buildVFormationOffsets,
  SCOUT_ADVANCE_CUE_DURATION,
  SCOUT_BULLET_COLOR,
  SCOUT_BULLET_SPEED,
  SCOUT_COLOR,
  SCOUT_FIRE_INTERVAL,
  Scout,
  FormationOffset,
} from './Scout';

/** Minimal scene that only constructs Scouts (no scene logic needed). */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('HarnessScene');
  }
}

describe('buildVFormationOffsets (GDD §4.1 V-formation geometry)', () => {
  it('returns no offsets for a zero/empty formation', () => {
    expect(buildVFormationOffsets(0)).toEqual([]);
    expect(buildVFormationOffsets(-3)).toEqual([]);
  });

  it('produces the requested number of scouts', () => {
    expect(buildVFormationOffsets(6).length).toBe(6);
    expect(buildVFormationOffsets(10).length).toBe(10);
  });

  it('builds a symmetric V: row 0 has one scout, each row widens by one', () => {
    const offsets = buildVFormationOffsets(6);
    const rows = new Map<number, number>();
    for (const o of offsets) {
      rows.set(o.row, (rows.get(o.row) ?? 0) + 1);
    }
    expect(rows.get(0)).toBe(1);
    expect(rows.get(1)).toBe(2);
    expect(rows.get(2)).toBe(3);
  });

  it('spreads wings symmetrically around the apex column', () => {
    const offsets = buildVFormationOffsets(6);
    const colsByRow = new Map<number, number[]>();
    for (const o of offsets) {
      rows(colsByRow, o.row, o.col);
    }
    for (const cols of colsByRow.values()) {
      const sorted = [...cols].sort((a, b) => a - b);
      // Each row's columns are mirror-symmetric: -k..+k spaced by 2.
      expect(sorted[0] + sorted[sorted.length - 1]).toBe(0);
    }
  });
});

function rows(map: Map<number, number[]>, key: number, value: number): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

describe('Scout entity (visuals, firing, destruction)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeScout(
    x: number,
    y: number,
    offset: FormationOffset = { row: 0, col: 0 },
  ): Scout {
    const scene = booted!.scene;
    return new Scout(scene, { x, y, formationOffset: offset });
  }

  it('renders a visible green body and starts alive', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);

    expect(scout.alive).toBe(true);
    expect(scout.bodyVisible).toBe(true);
    expect(SCOUT_COLOR).toBe(0x00ff00); // neon green per GDD §4.1
  });

  it('strokes the chevron with the GDD green style applied AFTER the buffer clear (browser render regression)', async () => {
    // Graphics is command-buffered: `clear()` wipes any styles queued
    // before it (re-applying only the default white 1px stroke). The
    // original code called `lineStyle()` before `clear()`, so in a real
    // browser the chevrons were stroked with the default style and
    // rendered invisible — the operator saw buttons but no scouts, with
    // no console error (headless tests cannot see pixels, so the suite
    // stayed green). Assert the effective stroke for the body path is
    // SCOUT_COLOR at width 2, i.e. queued AFTER the last clear.
    // Phaser Graphics command ids (src/gameobjects/graphics/Commands.js).
    const LINE_STYLE = 6;
    const STROKE_PATH = 9;

    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);

    // The body is the container child whose buffer contains a stroked
    // path (the explosion layer's buffer is empty until a destruction).
    const children = (scout as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    const body = children.find(
      (c): c is Phaser.GameObjects.Graphics =>
        c instanceof Phaser.GameObjects.Graphics &&
        c.commandBuffer.includes(STROKE_PATH),
    );
    expect(body, 'expected a body Graphics child with a stroked path').toBeDefined();

    const buf: number[] = body!.commandBuffer as number[];
    const strokeIdx = buf.lastIndexOf(STROKE_PATH);
    let lineStyleIdx = -1;
    for (let i = strokeIdx - 1; i >= 0; i--) {
      if (buf[i] === LINE_STYLE) {
        lineStyleIdx = i;
        break;
      }
    }
    expect(lineStyleIdx).toBeGreaterThanOrEqual(0);
    // LINE_STYLE layout: [id, lineWidth, color, alpha].
    expect(buf[lineStyleIdx + 1]).toBe(2);
    expect(buf[lineStyleIdx + 2]).toBe(SCOUT_COLOR);
  });

  it('fires an aimed bullet only when enabled, after BOTH the interval and the advance-cue tell', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);
    const t0 = 1_000_000;

    // Disabled — never fires.
    scout.shootEnabled = false;
    expect(scout.tryFireAimedBullet(t0)).toBeNull();

    // Enabled — the first eligible call starts the ≥ 500 ms advance-cue
    // tell (GDD §7.3) and returns no bullet yet.
    scout.shootEnabled = true;
    expect(scout.tryFireAimedBullet(t0)).toBeNull();
    expect(scout.isTelling).toBe(true);

    // Still inside the tell window — no shot.
    expect(scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION - 1)).toBeNull();
    expect(scout.isTelling).toBe(true);

    // Tell completed — the shot fires with the expected bullet colour.
    const bullet = scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION);
    expect(bullet).not.toBeNull();
    expect(bullet!.color).toBe(SCOUT_BULLET_COLOR);
    expect(scout.isTelling).toBe(false);

    // Within the fire interval — refuses to fire again.
    expect(scout.tryFireAimedBullet(
      t0 + SCOUT_ADVANCE_CUE_DURATION + SCOUT_FIRE_INTERVAL - 1,
    )).toBeNull();

    // After the interval the cycle restarts with a fresh tell, then fires.
    expect(scout.tryFireAimedBullet(
      t0 + SCOUT_ADVANCE_CUE_DURATION + SCOUT_FIRE_INTERVAL + 1,
    )).toBeNull();
    expect(scout.tryFireAimedBullet(
      t0 + SCOUT_ADVANCE_CUE_DURATION * 2 + SCOUT_FIRE_INTERVAL + 1,
    )).not.toBeNull();
  });

  it('aims bullets at the configured target position', async () => {
    booted = await bootScene([HarnessScene]);
    const scene = booted.scene;
    // Scout on the left; target default is bottom-centre of the screen.
    const scout = new Scout(scene, {
      x: 100,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });
    const target = scout.aimTarget;

    scout.shootEnabled = true;
    // First eligible call starts the tell; the shot fires after the cue.
    expect(scout.tryFireAimedBullet(1_000_000)).toBeNull();
    const bullet = scout.tryFireAimedBullet(1_000_000 + SCOUT_ADVANCE_CUE_DURATION)!;

    const dist = Math.sqrt(
      (target.x - scout.x) ** 2 + (target.y - scout.y) ** 2,
    );
    const expectedVx = ((target.x - scout.x) / dist) * SCOUT_BULLET_SPEED;
    const expectedVy = ((target.y - scout.y) / dist) * SCOUT_BULLET_SPEED;

    expect(bullet.vx).toBeCloseTo(expectedVx, 5);
    expect(bullet.vy).toBeCloseTo(expectedVy, 5);
    // Scout below-left of target ⇒ the shot travels down and to the right.
    expect(bullet.vy).toBeGreaterThan(0);
    expect(bullet.vx).toBeGreaterThan(0);
  });

  it('destroySelf hides the body and plays an explosion (no-op when already destroyed)', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);

    scout.destroySelf();
    expect(scout.alive).toBe(false);
    expect(scout.bodyVisible).toBe(false);

    // Destroying twice is harmless.
    expect(() => scout.destroySelf()).not.toThrow();
  });

  it('destruction plays NO entity-level sound — the base scene owns playDestructionSound (no double-play)', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playDestructionSound');

    const scout = makeScout(100, 100);
    scout.destroySelf();

    // The entity's explosion path must stay silent: GymFormationScene
    // .explodeRandom() plays playDestructionSound() exactly once per
    // destruction (design doc §7). An entity call here would double-play.
    expect(effectsModule.playDestructionSound).not.toHaveBeenCalled();
  });

  it('plays the advance cue once at tell start and the fire sound exactly once at the shot — cue precedes shot', async () => {
    booted = await bootScene([HarnessScene]);
    vi.spyOn(effectsModule, 'playScoutAdvanceCue');
    vi.spyOn(effectsModule, 'playScoutFireSound');

    const scout = makeScout(100, 100);
    const t0 = 1_000_000;
    scout.shootEnabled = true;

    // Tell starts: the advance cue plays once, no shot, no fire sound.
    expect(scout.tryFireAimedBullet(t0)).toBeNull();
    expect(effectsModule.playScoutAdvanceCue).toHaveBeenCalledTimes(1);
    expect(effectsModule.playScoutFireSound).not.toHaveBeenCalled();

    // Still telling one millisecond before the cue completes — no shot.
    expect(scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION - 1)).toBeNull();
    expect(effectsModule.playScoutFireSound).not.toHaveBeenCalled();

    // Tell completes: the shot fires and the fire sound plays exactly once.
    expect(scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION)).not.toBeNull();
    expect(effectsModule.playScoutFireSound).toHaveBeenCalledTimes(1);
    expect(effectsModule.playScoutAdvanceCue).toHaveBeenCalledTimes(1);

    // Ordering: the advance cue played before the fire sound.
    const cueOrder = vi.mocked(effectsModule.playScoutAdvanceCue).mock
      .invocationCallOrder[0];
    const fireOrder = vi.mocked(effectsModule.playScoutFireSound).mock
      .invocationCallOrder[0];
    expect(cueOrder).toBeLessThan(fireOrder);

    // A second cycle repeats the pattern exactly (one cue, one fire sound).
    const t1 = t0 + SCOUT_ADVANCE_CUE_DURATION + SCOUT_FIRE_INTERVAL;
    expect(scout.tryFireAimedBullet(t1)).toBeNull();
    expect(scout.tryFireAimedBullet(t1 + SCOUT_ADVANCE_CUE_DURATION)).not.toBeNull();
    expect(effectsModule.playScoutAdvanceCue).toHaveBeenCalledTimes(2);
    expect(effectsModule.playScoutFireSound).toHaveBeenCalledTimes(2);
  });

  it('disabling shoot mode mid-tell resets the tell so a re-enable starts a fresh cycle', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);
    const t0 = 1_000_000;

    scout.shootEnabled = true;
    expect(scout.tryFireAimedBullet(t0)).toBeNull(); // tell starts
    expect(scout.isTelling).toBe(true);

    // Toggle off mid-tell → tell state cleared.
    scout.shootEnabled = false;
    expect(scout.isTelling).toBe(false);

    // Re-enable → a fresh tell cycle begins from the new time base.
    const t1 = t0 + 500_000;
    scout.shootEnabled = true;
    expect(scout.tryFireAimedBullet(t1)).toBeNull();
    expect(scout.isTelling).toBe(true);
    expect(scout.tryFireAimedBullet(t1 + SCOUT_ADVANCE_CUE_DURATION)).not.toBeNull();
  });

  it('scouts pass freely through each other — overlapping scouts neither repel nor separate (GDD §2.6)', async () => {
    booted = await bootScene([HarnessScene]);
    const left = new Scout(booted.scene, {
      x: 480,
      y: 270,
      formationOffset: { row: 0, col: 0 },
    });
    const right = new Scout(booted.scene, {
      x: 480,
      y: 270,
      formationOffset: { row: 0, col: 0 },
    });

    left.applyFormationPosition(480, 270, 0.016, 26, 22);
    right.applyFormationPosition(480, 270, 0.016, 26, 22);

    // A collision system would push overlapping bodies apart (by at least
    // one full body width). Here the scouts stay co-located: y is exact
    // (wiggle is x-only), x differs only by each scout's independent
    // ±2 px wiggle animation.
    expect(left.alive).toBe(true);
    expect(right.alive).toBe(true);
    expect(left.y).toBe(270);
    expect(right.y).toBe(270);
    expect(Math.abs(left.x - right.x)).toBeLessThanOrEqual(4.2);
  });

  it('firing is unaffected by headless audio — audio helpers are safe no-ops without an AudioContext', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = makeScout(100, 100);
    const t0 = 1_000_000;

    scout.shootEnabled = true;
    // No AudioContext exists in the headless harness; starting the tell
    // and firing must not throw and must still produce a bullet.
    expect(() => scout.tryFireAimedBullet(t0)).not.toThrow();
    expect(() => scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION)).not.toThrow();
    expect(scout.tryFireAimedBullet(t0 + SCOUT_ADVANCE_CUE_DURATION)).toBeNull(); // within interval
  });

  it('setAimTarget retargets aimed shots to the player’s live position (replacing the stand-in)', async () => {
    booted = await bootScene([HarnessScene]);
    const scout = new Scout(booted.scene, {
      x: 100,
      y: 200,
      formationOffset: { row: 0, col: 0 },
    });

    // Default aim is the bottom-centre stand-in.
    const standIn = scout.aimTarget;
    expect(standIn.x).toBe(GAME_WIDTH / 2);
    expect(standIn.y).toBe(GAME_HEIGHT - 40);

    // Live player position (top-right of the scout): the shot must now
    // travel toward the player, not the stand-in.
    scout.setAimTarget(700, 120);
    const live = scout.aimTarget;
    expect(live.x).toBe(700);
    expect(live.y).toBe(120);

    scout.shootEnabled = true;
    expect(scout.tryFireAimedBullet(1_000_000)).toBeNull(); // tell
    const bullet = scout.tryFireAimedBullet(1_000_000 + SCOUT_ADVANCE_CUE_DURATION)!;

    const dist = Math.sqrt((live.x - scout.x) ** 2 + (live.y - scout.y) ** 2);
    const expectedVx = ((live.x - scout.x) / dist) * SCOUT_BULLET_SPEED;
    const expectedVy = ((live.y - scout.y) / dist) * SCOUT_BULLET_SPEED;
    expect(bullet.vx).toBeCloseTo(expectedVx, 5);
    expect(bullet.vy).toBeCloseTo(expectedVy, 5);

    // The shot flies up-and-right towards the player — the opposite arc
    // of the bottom-centre stand-in (which would fly down-and-right).
    expect(bullet.vy).toBeLessThan(0);
    expect(bullet.vx).toBeGreaterThan(0);
  });
});