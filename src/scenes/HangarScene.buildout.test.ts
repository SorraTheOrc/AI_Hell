/**
 * Auto-fit on open and the apply-suggested-buildout button
 * (AH-0MWOWEPO2004B0MR, parent AH-0MWOROJYT004WPSD AC4/AC5/AC7/AC8).
 *
 * The shared model publishes the selector's suggestion and the
 * `⚡ APPLY SUGGESTED BUILDOUT` row (AH-0MWOWEF3Q008BO5J); this suite pins the
 * **scene** half:
 *
 * - an empty loadout is auto-fitted on open and persisted in one store write;
 * - a hand-picked loadout is never rewritten on open;
 * - activating the row equips the published suggestion and persists it;
 * - manual weapon toggles still work after either path;
 * - re-opening is idempotent (no second fit, no second write);
 * - under `demo` the row is non-actionable, never wired and nothing is written.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import {
  HANGAR_WAR_STORAGE_KEY,
  parseHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createRingState } from '../core/hangarWar/hexRing';
import { VALID_HANGAR_WAR_PAYLOAD } from '../core/hangarWar/fixtures';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import { HANGAR_SCENE_KEY, HangarScene } from './HangarScene';
import { BUILDOUT_ROW_KEY } from './hangarWar/hangarScreen';

/** Deep, detached copy of a payload. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** A deterministic in-memory storage adapter that counts writes. */
interface CountingStorage extends HangarWarStorage {
  entries: Map<string, string>;
  writes: number;
}

function memoryStorage(initial?: HangarWarPayload): CountingStorage {
  const entries = new Map<string, string>();
  if (initial) entries.set(HANGAR_WAR_STORAGE_KEY, JSON.stringify(initial));
  const storage: CountingStorage = {
    entries,
    writes: 0,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      storage.writes += 1;
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
  return storage;
}

/**
 * The authored ring 1 with every catalogue kind owned and the requested
 * starting-weapon selection. The ring's default target moved to `hex-r1-1`
 * (AH-0MWW28ET2002PNI8, the sorted-id tie-break between two aggression-1
 * hexes), and that boss (`the-dawnbreaker`) does not resist `spread`, so tests
 * that need a resisted weapon pass `targetHexId: 'hex-r1-2'` explicitly —
 * `shroud-merchant` resists `spread` and is countered by `wave_laser`.
 */
function ownedPayload(startingWeapons: readonly string[]): HangarWarPayload {
  const payload = clonePayload(VALID_HANGAR_WAR_PAYLOAD);
  payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
  payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
  payload.hangar.unlockedWeapons = [
    'spread',
    'wave_laser',
    'ricochet',
    'cluster',
  ];
  payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  payload.hangar.activeHull = 'hull-1';
  payload.hangar.activeLoadout = {
    startingWeapons: [...startingWeapons],
    modifiers: [],
  };
  payload.hangar.bankedMinerals = 0;
  payload.hangar.bankedCores = 0;
  return payload;
}

/** The persisted payload read back through the versioned parser. */
function persisted(storage: CountingStorage): HangarWarPayload {
  const raw = storage.entries.get(HANGAR_WAR_STORAGE_KEY);
  expect(raw, 'nothing was persisted').toBeDefined();
  const parsed = parseHangarWarPayload(JSON.parse(raw!));
  expect(parsed).not.toBeNull();
  return parsed!;
}

describe('HangarScene auto-fit on open and apply-suggested-buildout (AH-0MWOWEPO2004B0MR)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  /** Boots the hangar with the given launch data and returns the live scene. */
  async function bootHangar(
    data?: Partial<{
      payload: HangarWarPayload;
      storage: HangarWarStorage | null;
      targetHexId: string | null;
      demo: boolean;
      demoDwellMs: number;
    }>,
  ): Promise<HangarScene> {
    booted = await bootScene([HangarScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: HangarScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** The rendered row for a key. */
  function rowFor(scene: HangarScene, key: string) {
    const row = scene.getRows().find((entry) => entry.key === key);
    expect(row, `row "${key}" not rendered`).toBeDefined();
    return row!;
  }

  it('auto-fits an empty loadout on open and persists it in one write', async () => {
    const initial = ownedPayload([]);
    initial.hangar.activeLoadout.modifiers = ['hardened_plating'];
    const storage = memoryStorage(initial);
    // Explicit target: `hex-r1-2` (shroud-merchant) resists `spread` and is
    // countered by `wave_laser`, so the fit assertions stay about the matchup
    // rule. The ring's default target is `hex-r1-1` since
    // AH-0MWW28ET2002PNI8, whose boss does not resist a starter weapon.
    const scene = await bootHangar({ storage, targetHexId: 'hex-r1-2' });

    const model = scene.getModel();
    const fitted = model.suggestedLoadout.startingWeapons;
    expect(fitted.length).toBeGreaterThan(0);
    // The persisted selection is the suggestion the model publishes — one rule,
    // no scene-local selection.
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
    // The suggested weapons are the boss's weaknesses, never its strengths.
    expect(fitted).not.toContain('spread');
    expect(fitted).toContain('wave_laser');
    // The chosen modifiers are carried across untouched.
    expect(scene.getPayload().hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);

    // One store write for the whole open (no ring materialisation on a full
    // ring), and the fitted loadout is what survives leaving the screen.
    expect(storage.writes).toBe(1);
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
    expect(persisted(storage).hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);

    // The six-slot display is honest: the fit never presents more counted
    // kinds than the deployment will grant.
    expect(
      fitted.length + model.suggestedLoadout.grantedPowerUps.length,
    ).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
  });

  it('fits against the carried target hex, not only the weakest-unheld default', async () => {
    // `hex-r1-6` (maw-of-ashes) is weak to `spread` and `dual`, so the fit must
    // include `spread` — the same target the `▶ DEPLOY` row and the intel name.
    const storage = memoryStorage(ownedPayload([]));
    const scene = await bootHangar({ storage, targetHexId: 'hex-r1-6' });

    expect(scene.getModel().bossIntel.hexId).toBe('hex-r1-6');
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toContain(
      'spread',
    );
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toContain(
      'spread',
    );
  });

  it('never rewrites a customised loadout on open', async () => {
    const initial = ownedPayload(['spread']);
    const storage = memoryStorage(initial);
    const scene = await bootHangar({ storage });

    // The suggestion is not the hand-picked list (and a boss that resists
    // `spread` is targetable), but opening the screen must leave the
    // hand-picked list alone and write nothing.
    expect(scene.getModel().suggestedLoadout.startingWeapons).not.toEqual([
      'spread',
    ]);
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
    ]);
    expect(storage.writes).toBe(0);
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual([
      'spread',
    ]);
  });

  it('equips the published suggestion from the buildout row on Enter and persists it', async () => {
    const storage = memoryStorage(ownedPayload(['spread']));
    const scene = await bootHangar({ storage });
    const suggestion = scene.getModel().suggestedLoadout.startingWeapons;

    expect(rowFor(scene, BUILDOUT_ROW_KEY).actionable).toBe(true);
    expect(scene.focusRow(BUILDOUT_ROW_KEY)).toBe(true);
    pressKey(scene, { key: 'Enter' });

    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      suggestion,
    );
    // Focus stays on the row after the rebuild.
    expect(scene.getFocusedKey()).toBe(BUILDOUT_ROW_KEY);
    expect(storage.writes).toBe(1);
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual(
      suggestion,
    );
  });

  it('equips the suggestion on a pointer click too (the same row action)', async () => {
    const storage = memoryStorage(ownedPayload(['spread']));
    const scene = await bootHangar({ storage });
    const suggestion = scene.getModel().suggestedLoadout.startingWeapons;

    rowFor(scene, BUILDOUT_ROW_KEY).text.emit('pointerdown');

    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      suggestion,
    );
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual(
      suggestion,
    );
  });

  it('keeps manual weapon toggles working after an auto-fit', async () => {
    const storage = memoryStorage(ownedPayload([]));
    const scene = await bootHangar({ storage });
    const fitted = scene.getPayload().hangar.activeLoadout.startingWeapons;
    const weapon = fitted[fitted.length - 1];

    // Toggle an auto-fitted weapon off through the existing toggle path.
    expect(scene.focusRow(`weapon:${weapon}`)).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).not.toContain(
      weapon,
    );

    // And straight back on: manual control survives the automatic fit.
    expect(scene.focusRow(`weapon:${weapon}`)).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
  });

  it('keeps manual weapon toggles working after applying the buildout', async () => {
    const storage = memoryStorage(ownedPayload(['spread']));
    const scene = await bootHangar({ storage });

    scene.focusRow(BUILDOUT_ROW_KEY);
    pressKey(scene, { key: 'Enter' });
    const applied = scene.getPayload().hangar.activeLoadout.startingWeapons;
    const weapon = applied[0];
    expect(weapon).toBeDefined();

    expect(scene.focusRow(`weapon:${weapon}`)).toBe(true);
    pressKey(scene, { key: 'Enter' });
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).not.toContain(
      weapon,
    );
  });

  it('is idempotent: re-opening the hangar keeps the fitted selection and writes nothing', async () => {
    const storage = memoryStorage(ownedPayload([]));
    const first = await bootHangar({ storage });
    const fitted = [...first.getPayload().hangar.activeLoadout.startingWeapons];
    expect(fitted.length).toBeGreaterThan(0);
    expect(storage.writes).toBe(1);

    // Re-open the same scene from the same store (a second visit).
    booted!.game.scene.start(HANGAR_SCENE_KEY, { storage });
    await advanceGame(booted!.game, 200);
    const revisited = booted!.game.scene.getScene(
      HANGAR_SCENE_KEY,
    ) as HangarScene;

    expect(revisited.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
    // A non-empty loadout is not re-fitted, so the second open never writes.
    expect(storage.writes).toBe(1);
    expect(persisted(storage).hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
  });

  it('is idempotent when the button is activated on the suggested loadout', async () => {
    const storage = memoryStorage(ownedPayload([]));
    const scene = await bootHangar({ storage });
    const fitted = scene.getPayload().hangar.activeLoadout.startingWeapons;
    expect(storage.writes).toBe(1);

    scene.focusRow(BUILDOUT_ROW_KEY);
    pressKey(scene, { key: 'Enter' });

    // Re-applying the same suggestion changes nothing and writes nothing.
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual(
      fitted,
    );
    expect(storage.writes).toBe(1);
  });

  it('renders the row read-only under demo: no fit, no wiring, no write', async () => {
    const initial = ownedPayload([]);
    const storage = memoryStorage(initial);
    const scene = await bootHangar({
      payload: initial,
      storage,
      demo: true,
      demoDwellMs: 1_000_000,
    });

    // The row renders the identical label, but is not actionable and has no
    // pointer handler — the demo can never overwrite the war.
    const row = rowFor(scene, BUILDOUT_ROW_KEY);
    expect(row.label).toBe(scene.getModel().buildoutRow.label);
    expect(row.label).toContain('APPLY SUGGESTED BUILDOUT');
    expect(row.actionable).toBe(false);
    expect(row.text.input).toBeNull();

    row.text.emit('pointerdown');
    expect(scene.getPayload().hangar.activeLoadout.startingWeapons).toEqual([]);
    expect(storage.writes).toBe(0);

    // The row is absent from the interactive focus cycle: every reachable row
    // is an actionable one, and the buildout key is never among them.
    const focusable = new Set(
      scene.getRows().filter((entry) => entry.actionable).map((entry) => entry.key),
    );
    expect(focusable).not.toContain(BUILDOUT_ROW_KEY);
    for (let i = 0; i < scene.getRows().length + 2; i += 1) {
      const focused = scene.getFocusedKey();
      expect(focused === null || focusable.has(focused)).toBe(true);
      expect(focused).not.toBe(BUILDOUT_ROW_KEY);
      pressKey(scene, { key: 'Tab' });
    }
  });
});
