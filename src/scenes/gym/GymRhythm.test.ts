/**
 * GymRhythm tests (epic AH-0MVYA1JFK003RLAW, child AH-0MVYA28AC006XMKL).
 *
 * The rhythm gym is an audition of the **shared** Euclidean fire scheduler,
 * so these tests assert behaviour, not source: the six canonical voices fire
 * through the same `Player.tryFire` path the game runs, every onset is an
 * exact tick of the shared lattice, and the sixteen-step onset stack is the
 * documented canonical 46-onset superposition.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import {
  advanceGame,
  bootScene,
  createReusableBoot,
  type BootedGame,
} from '../../test/gameHarness';
import {
  GYM_RHYTHM_BAR_STEPS,
  GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR,
  GYM_RHYTHM_HINT,
  GYM_RHYTHM_VOICES,
  GymRhythm,
} from './GymRhythm';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { Player } from '../../entities/Player';
import { WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';
import { resolveWeaponPattern } from '../../utils/weaponLevels';
import { euclidPattern, isOnset, stepIndexAt } from '../../utils/euclid';
import { createBeatClock, isOnGrid } from '../../utils/beat';
import { createSeededRng } from '../../core/rng';

/** The documented canonical per-step voice counts of the six-voice bar. */
const CANONICAL_STEP_VOICES = [5, 2, 4, 2, 2, 3, 4, 2, 4, 1, 4, 4, 1, 4, 2, 2];

/** Fixed simulation step used to drive the scene deterministically. */
const DT = 1 / 60;

/** Ticks covering just over one 3 s bar (46 onsets + the next bar's start). */
const TICKS = 200;

/** Canonical onsets of one voice, from the shared pure generator. */
function canonicalOnsets(weaponId: WeaponId): number[] {
  const pattern = resolveWeaponPattern(weaponId, 0);
  return [...euclidPattern(pattern.k, pattern.n, pattern.rotation).onsets];
}

/** Boots GymRhythm and fails loudly when the scene did not create a player. */
async function bootRhythm(
  booted: BootedGame,
): Promise<GymRhythm> {
  const scene = booted.scene as GymRhythm;
  expect(scene.getPlayer(), 'gym created no player').not.toBeNull();
  return scene;
}

describe('GymRhythm — index discovery and scene shell', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('is auto-discovered from the gym folder with label Rhythm', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymRhythm');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('Rhythm');
  });

  it('is listed and registered by the real gym index', async () => {
    booted = await bootScene([GymIndex]);
    const index = booted.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymRhythm');
    expect(booted.game.scene.getScene('GymRhythm')).not.toBeNull();
  });

  it('boots the ship, the back button and the hint line', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    expect(scene.getPlayer()!.active).toBe(true);
    const texts = scene.children.list.filter(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text,
    );
    expect(texts.some((text) => text.text === BACK_TO_INDEX_LABEL)).toBe(true);
    expect(texts.some((text) => text.text === GYM_RHYTHM_HINT)).toBe(true);
  });
});

describe('GymRhythm — canonical cast runs the shared scheduler', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  it('activates exactly the six canonical voices at their level-0 rungs', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    const player = scene.getPlayer()!;

    const expectedWeapons = GYM_RHYTHM_VOICES.map((voice) => voice.weaponId);
    expect(player.getActiveWeapons().sort()).toEqual([...expectedWeapons].sort());

    for (const voice of GYM_RHYTHM_VOICES) {
      // The gym exposes the scheduler's own pattern — the pure resolver's
      // level-0 fixture for each canonical voice.
      expect(scene.getVoicePattern(voice.weaponId)).toEqual(
        resolveWeaponPattern(voice.weaponId, 0),
      );
    }
  });

  it('renders the onset stack from the shared pattern data', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);

    const stack = scene.getOnsetStack();
    expect(stack).toHaveLength(GYM_RHYTHM_BAR_STEPS);

    const expected = Array.from({ length: GYM_RHYTHM_BAR_STEPS }, () => [] as WeaponId[]);
    for (const voice of GYM_RHYTHM_VOICES) {
      for (const onset of canonicalOnsets(voice.weaponId)) {
        expected[onset].push(voice.weaponId);
      }
    }
    expect(stack.map((voices) => [...voices])).toEqual(expected);
  });

  it('shows the documented canonical superposition: 46 onsets, slow/medium/fast', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);

    expect(scene.getBarOnsetTotal()).toBe(GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR);
    expect(GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR).toBe(46);
    expect(scene.getOnsetStack().map((voices) => voices.length)).toEqual(
      CANONICAL_STEP_VOICES,
    );

    const voicesInBar = new Set(scene.getOnsetStack().flat());
    for (const voice of GYM_RHYTHM_VOICES) {
      expect(voicesInBar.has(voice.weaponId), `${voice.weaponId} never sounds`).toBe(
        true,
      );
    }
    // Each voice's onsets-per-bar is its ladder rung's k.
    for (const voice of GYM_RHYTHM_VOICES) {
      const pattern = resolveWeaponPattern(voice.weaponId, 0);
      const count = scene
        .getOnsetStack()
        .filter((voices) => voices.includes(voice.weaponId)).length;
      expect(count, voice.weaponId).toBe(pattern.k);
    }
    // Sparse, medium and dense roles each contribute inside one bar.
    const roles = new Set(GYM_RHYTHM_VOICES.map((voice) => voice.role));
    expect(roles).toEqual(new Set(['slow', 'medium', 'fast']));
  });

  it('tracks the playhead on the shared beat clock', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    const player = scene.getPlayer()!;
    expect(scene.getBarStep()).toBe(0);

    const stepMs = player.getFirePattern('cannon')!.stepMs;
    // Advance 5 sixteenth-note steps of the shared lattice.
    const ticks = Math.round((5 * stepMs) / (DT * 1000));
    for (let i = 0; i < ticks; i += 1) scene.tick(DT);
    expect(scene.getBarStep()).toBe(
      ((stepIndexAt(player.getBeatClock().now(), stepMs) % GYM_RHYTHM_BAR_STEPS) +
        GYM_RHYTHM_BAR_STEPS) %
        GYM_RHYTHM_BAR_STEPS,
    );
    expect(scene.getBarStep()).toBe(5);
  });
});

describe('GymRhythm — fires and parity with the shared scheduler', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
  });

  it('fires every onset as an exact lattice tick of its own pattern', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);

    for (let i = 0; i < TICKS; i += 1) scene.tick(DT);

    const events = scene.getFiredEvents();
    expect(events.length).toBeGreaterThan(GYM_RHYTHM_CANONICAL_ONSETS_PER_BAR);
    for (const event of events) {
      const pattern = scene.getVoicePattern(event.weaponId)!;
      const tile = euclidPattern(pattern.k, pattern.n, pattern.rotation);
      expect(isOnGrid(event.shotTime, pattern.stepMs), `${event.weaponId} off-grid`).toBe(
        true,
      );
      expect(
        isOnset(event.shotTime, tile, pattern.stepMs),
        `${event.weaponId} fired off its onset set`,
      ).toBe(true);
    }
  });

  it('fires the documented per-voice onset counts in one bar', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    const stepMs = scene.getVoicePattern('cannon')!.stepMs;

    for (let i = 0; i < TICKS; i += 1) scene.tick(DT);

    const firstBar = scene.getFiredEvents().filter((event) => event.shotTime < stepMs * GYM_RHYTHM_BAR_STEPS);
    for (const voice of GYM_RHYTHM_VOICES) {
      const count = firstBar.filter((event) => event.weaponId === voice.weaponId).length;
      expect(count, `${voice.weaponId} onsets in bar 0`).toBe(
        resolveWeaponPattern(voice.weaponId, 0).k,
      );
    }
  });

  it('matches a bare Player driven with the same input — the shared scheduler', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    const player = scene.getPlayer()!;

    // Align at a point mid-step, where every voice's next onset is comfortably
    // ahead, so both schedulers resolve the same upcoming onset from the same
    // absolute beat time (the boot harness has already advanced the scene clock).
    for (let guard = 0; guard < 1000; guard += 1) {
      const now = player.getBeatClock().now();
      const lead = Math.min(
        ...GYM_RHYTHM_VOICES.map(
          (voice) => (player.getNextShotTime(voice.weaponId) ?? Infinity) - now,
        ),
      );
      if (lead > DT * 1000 * 2) break;
      scene.tick(DT);
    }
    const baseline = scene.getFiredEvents().length;
    const startMs = player.getBeatClock().now();

    // Reference: the same scheduler, outside the scene's shared step, anchored
    // on a clock that stands at the same absolute beat time.
    const clock = createBeatClock();
    clock.advance(startMs);
    const reference = new Player(scene, { x: 0, y: 0 });
    scene.add.existing(reference);
    reference.setBeatClock(clock);
    for (const voice of GYM_RHYTHM_VOICES) {
      reference.equipWeapon(voice.weaponId, true);
    }
    const expected: Array<{ weaponId: WeaponId; shotTime: number }> = [];
    for (let i = 0; i < TICKS; i += 1) {
      for (const weaponId of reference.tryFire(DT)) {
        expected.push({ weaponId, shotTime: reference.getLastShotTime(weaponId)! });
      }
      scene.tick(DT);
    }

    const actual = scene
      .getFiredEvents()
      .slice(baseline)
      .map((event) => ({
        weaponId: event.weaponId,
        shotTime: event.shotTime,
      }));
    expect(actual.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected);
  });

  it('is deterministic: the same driven input plays the same bar', async () => {
    booted = await bootScene([GymRhythm]);
    const first = await bootRhythm(booted);
    for (let i = 0; i < TICKS; i += 1) first.tick(DT);
    const firstEvents = first.getFiredEvents().map((event) => ({ ...event }));
    booted.game.destroy(true);

    booted = await bootScene([GymRhythm]);
    const second = await bootRhythm(booted);
    for (let i = 0; i < TICKS; i += 1) second.tick(DT);
    expect(second.getFiredEvents().map((event) => ({ ...event }))).toEqual(
      firstEvents,
    );
  });

  it('records every fire on its own bar step and labels the voices that sound', async () => {
    booted = await bootScene([GymRhythm]);
    const scene = await bootRhythm(booted);
    for (let i = 0; i < TICKS; i += 1) scene.tick(DT);

    const stack = scene.getOnsetStack();
    for (const event of scene.getFiredEvents()) {
      expect(event.step).toBeGreaterThanOrEqual(0);
      expect(event.step).toBeLessThan(GYM_RHYTHM_BAR_STEPS);
      expect(
        stack[event.step].includes(event.weaponId),
        `${event.weaponId} fired on step ${event.step} which its pattern excludes`,
      ).toBe(true);
    }
  });
});

describe('GymRhythm — scripted-scene setup adoption', () => {
  const reuse = createReusableBoot();
  let booted: BootedGame | null = null;

  afterAll(() => reuse.dispose());

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function bootWithSetup(setup?: Record<string, unknown>): Promise<GymRhythm> {
    booted = await reuse.boot([GymRhythm]);
    booted.game.scene.start('GymRhythm', setup);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene('GymRhythm') as unknown as GymRhythm;
  }

  it('keeps the canonical six voices and their level-0 patterns with no setup', async () => {
    const scene = await bootWithSetup();
    const player = scene.getPlayer()!;
    expect(player.getActiveWeapons()).toEqual(
      expect.arrayContaining(GYM_RHYTHM_VOICES.map((voice) => voice.weaponId)),
    );
    for (const voice of GYM_RHYTHM_VOICES) {
      expect(scene.getVoicePattern(voice.weaponId)).toEqual(
        resolveWeaponPattern(voice.weaponId, 0),
      );
    }
  });

  it('consumes the setup seed through the shared applier', async () => {
    const scene = await bootWithSetup({ seed: 0x5eed_1234 });
    const rng = scene.getContentRng();
    const expected = createSeededRng(0x5eed_1234);
    expect([rng(), rng(), rng()]).toEqual([expected(), expected(), expected()]);
  });

  it('applies setup power-up levels alongside the fixed cast', async () => {
    const scene = await bootWithSetup({ powerUps: { shield: 2 } });
    const player = scene.getPlayer()!;
    expect(player.getPowerUpLevelStore().getEffectiveLevel('shield')).toBe(2);
    expect(player.getActiveWeapons()).toEqual(
      expect.arrayContaining(GYM_RHYTHM_VOICES.map((voice) => voice.weaponId)),
    );
  });
});

describe('GymRhythm — voice cast documents the shipped weapons', () => {
  it('names six distinct catalogue weapons', () => {
    const ids = GYM_RHYTHM_VOICES.map((voice) => voice.weaponId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
    for (const id of ids) expect(WEAPON_CATALOGUE[id]).toBeDefined();
  });
});
