/**
 * Boss-aware auto-loadout — hangar model and render contract tests
 * (AH-0MWOWDWAG007MBY1, test-first slice of parent AH-0MWOROJYT004WPSD).
 *
 * ## RED by design
 *
 * The model surface pinned here does **not** exist yet; the two implementation
 * slices land it:
 *
 * - **AH-0MWOWEF3Q008BO5J** ("Hangar model: auto-fit and suggested buildout
 *   row") adds `suggestedLoadout`, `buildoutRow`, `BUILDOUT_ROW_KEY` and
 *   `isDefaultHangarLoadout` to `src/scenes/hangarWar/hangarScreen.ts`;
 * - **AH-0MWOWEPO2004B0MR** ("Hangar screen: auto-fit on open and buildout
 *   button") renders the row, which the gym parity test in
 *   `GymHangar.test.ts` then exercises read-only.
 *
 * To keep `tsc --noEmit` clean while the exports are absent, the new module
 * members are loaded through a **non-literal** specifier ({@link
 * HANGAR_SCREEN_MODULE}), exactly as the F1 selector contract suite does. The
 * specs fail at runtime for the intended reason — an undefined
 * `BUILDOUT_ROW_KEY` / missing `buildoutRow` / `isDefaultHangarLoadout` is not
 * a function — and go green as the two slices land. No production behaviour is
 * added in this slice.
 *
 * ## The contract these specs pin
 *
 * `src/scenes/hangarWar/hangarScreen.ts` gains:
 *
 * ```ts
 * export const BUILDOUT_ROW_KEY = 'buildout';
 *
 * export function isDefaultHangarLoadout(payload: HangarWarPayload): boolean;
 * // === payload.hangar.activeLoadout.startingWeapons.length === 0
 * // (NOT "the selector found no strong weapon")
 *
 * interface HangarBuildoutRow {
 *   key: typeof BUILDOUT_ROW_KEY;
 *   label: string;      // "⚡ APPLY SUGGESTED BUILDOUT — <n> weapons"
 *   actionable: boolean; // true whenever a suggestion exists
 * }
 *
 * interface HangarScreenModel {
 *   // ...existing fields...
 *   suggestedLoadout: AutoLoadoutSuggestion; // selectAutoLoadout(payload, target, catalogue)
 *   buildoutRow: HangarBuildoutRow;
 * }
 * ```
 *
 * and `buildHangarScreenModel` appends `BUILDOUT_ROW_KEY` to `focusOrder`
 * after the loadout options and before `▶ DEPLOY`, for every loadout (empty
 * **and** customised).
 *
 * The existing matchup rendering is a guard, not new behaviour: every equipped
 * weapon row keeps its non-colour glyph (`▲ EFFECTIVE` / `▼ RESISTED`) paired
 * with its strong/weak colour, while power-up and modifier rows stay neutral
 * (repo CVD policy: never colour-only).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { createRingState } from '../../core/hangarWar/hexRing';
import { VALID_HANGAR_WAR_PAYLOAD } from '../../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  selectAutoLoadout,
  type AutoLoadoutSuggestion,
} from '../../core/hangarWar/hangarAutoLoadout';
import { HANGAR_SCENE_KEY, HangarScene } from '../HangarScene';
import {
  buildHangarScreenModel,
  HANGAR_STRONG_COLOR,
  HANGAR_STRONG_MARKER,
  HANGAR_WEAK_COLOR,
  HANGAR_WEAK_MARKER,
  renderHangarScreen,
  type HangarScreenModel,
} from './hangarScreen';

// ── The pinned surface (declared here, implemented by the model slice) ──

/** The apply-suggested-buildout row added to the shared model. */
interface HangarBuildoutRowContract {
  /** Stable row key (`buildout`). */
  readonly key: string;
  /** Full row text as rendered (`⚡ APPLY SUGGESTED BUILDOUT — 3 weapons`). */
  readonly label: string;
  /** True whenever a suggestion exists (empty and customised loadouts alike). */
  readonly actionable: boolean;
}

/** The shared model after the auto-loadout slice lands. */
interface HangarScreenModelContract extends HangarScreenModel {
  /** The selector's full-replacement suggestion. */
  readonly suggestedLoadout: AutoLoadoutSuggestion;
  /** The apply-suggested-buildout row. */
  readonly buildoutRow: HangarBuildoutRowContract;
}

/** The new module members this suite pins. */
interface HangarScreenExtras {
  /** Row key of the apply-suggested-buildout row. */
  readonly BUILDOUT_ROW_KEY: string;
  /** Exactly `activeLoadout.startingWeapons.length === 0`. */
  isDefaultHangarLoadout(payload: HangarWarPayload): boolean;
}

/**
 * Non-literal specifier so TypeScript does not resolve the absent members at
 * type-check time; Vitest still resolves the module at runtime.
 */
const HANGAR_SCREEN_MODULE = './hangarScreen';

/** Loads the module; the absent members are `undefined` on pre-change HEAD. */
async function screenExtras(): Promise<HangarScreenExtras> {
  return (await import(HANGAR_SCREEN_MODULE)) as HangarScreenExtras;
}

/** The model builder's optional third argument (target hex, definitions, …). */
type ModelOptions = NonNullable<
  Parameters<typeof buildHangarScreenModel>[2]
>;

/** Builds the model and views it through the post-slice contract. */
function modelOf(
  payload: HangarWarPayload,
  options: ModelOptions = {},
): HangarScreenModelContract {
  return buildHangarScreenModel(
    payload,
    HANGAR_CATALOGUE,
    options,
  ) as unknown as HangarScreenModelContract;
}

/** A deep, detached copy, so mutation assertions are meaningful. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/**
 * The authored ring 1 with every catalogue kind owned and the requested
 * starting-weapon selection. The default target is the authored `hex-r1-2`
 * (the weakest unheld hex), where `spread` is resisted and `wave_laser`
 * counters the boss.
 */
function ownedPayload(startingWeapons: readonly string[]): HangarWarPayload {
  const payload = clone(VALID_HANGAR_WAR_PAYLOAD);
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

// ── AC1: the model publishes the suggestion and the buildout row ─────

describe('the model publishes the selector suggestion and an apply-suggested-buildout row', () => {
  it('publishes the selector result and a labelled, actionable buildout row', async () => {
    const { BUILDOUT_ROW_KEY } = await screenExtras();
    expect(BUILDOUT_ROW_KEY).toBe('buildout');

    const payload = ownedPayload([]);
    const model = modelOf(payload);
    // The model's suggestion is the selector's result for the same target it
    // resolved for `▶ DEPLOY` — one rule, not a second copy.
    const expected = selectAutoLoadout(
      payload,
      model.bossIntel,
      HANGAR_CATALOGUE,
    );
    expect(model.suggestedLoadout).toEqual(expected);

    expect(model.buildoutRow.key).toBe(BUILDOUT_ROW_KEY);
    expect(model.buildoutRow.actionable).toBe(true);
    // The label states what it will equip, paired with a non-colour glyph.
    expect(model.buildoutRow.label).toContain('⚡');
    expect(model.buildoutRow.label).toContain('APPLY SUGGESTED BUILDOUT');
    expect(model.buildoutRow.label).toContain(
      String(expected.startingWeapons.length),
    );
  });

  it('keeps the buildout row actionable for a hand-picked (non-empty) loadout', async () => {
    const { BUILDOUT_ROW_KEY } = await screenExtras();
    const payload = ownedPayload(['spread']);
    const model = modelOf(payload);

    expect(model.buildoutRow.key).toBe(BUILDOUT_ROW_KEY);
    expect(model.buildoutRow.actionable).toBe(true);
    expect(model.suggestedLoadout.startingWeapons.length).toBeGreaterThan(0);
  });

  it('places the buildout row after the loadout options and before deploy', async () => {
    const { BUILDOUT_ROW_KEY } = await screenExtras();
    const model = modelOf(ownedPayload([]));
    const buildoutIndex = model.focusOrder.indexOf(BUILDOUT_ROW_KEY);
    const deployIndex = model.focusOrder.indexOf(model.deployRow.key);

    expect(buildoutIndex).toBeGreaterThanOrEqual(0);
    expect(buildoutIndex).toBeLessThan(deployIndex);
    for (const option of model.weaponOptions) {
      expect(buildoutIndex).toBeGreaterThan(model.focusOrder.indexOf(option.key));
    }
  });
});

// ── AC2: "default/empty" is exactly an empty startingWeapon list ─────

describe('default/empty means an empty startingWeapon selection, never "no strong weapon"', () => {
  it('treats an empty loadout as default when no owned weapon counters the target', async () => {
    const { isDefaultHangarLoadout } = await screenExtras();
    const payload = ownedPayload([]);
    // An empty definition set leaves every weapon neutral: the suggestion has
    // no strong pick, yet the loadout is still at its default/empty state.
    const model = modelOf(payload, { definitions: [] });
    expect(
      model.suggestedLoadout.picks.every((pick) => pick.reason !== 'strong'),
    ).toBe(true);
    expect(isDefaultHangarLoadout(payload)).toBe(true);
  });

  it('treats a hand-picked non-empty loadout as non-default even with no strong weapon', async () => {
    const { isDefaultHangarLoadout } = await screenExtras();
    const payload = ownedPayload(['spread']);
    const model = modelOf(payload, { definitions: [] });
    expect(
      model.suggestedLoadout.picks.every((pick) => pick.reason !== 'strong'),
    ).toBe(true);
    expect(isDefaultHangarLoadout(payload)).toBe(false);
  });

  it('keys the rule on startingWeapons length only (a modifier does not count)', async () => {
    const { isDefaultHangarLoadout } = await screenExtras();
    const payload = ownedPayload([]);
    payload.hangar.activeLoadout.modifiers = ['hardened_plating'];
    expect(isDefaultHangarLoadout(payload)).toBe(true);
  });
});

// ── AC3: the model never silently replaces a hand-picked loadout ─────

describe('a hand-picked loadout is never silently replaced by the model', () => {
  it('keeps the picked list, shows the suggestion separately and mutates nothing', async () => {
    const { isDefaultHangarLoadout } = await screenExtras();
    // `spread` is resisted by the default target, so the suggestion would drop
    // it — which makes "the model left it alone" a meaningful assertion.
    const payload = ownedPayload(['spread']);
    const before = clone(payload);
    const model = modelOf(payload);

    expect(model.suggestedLoadout.startingWeapons).not.toContain('spread');
    // The equipped list still reflects the hand-picked loadout, not the
    // suggestion.
    expect(
      model.weaponOptions.find((option) => option.id === 'spread')?.equipped,
    ).toBe(true);
    for (const id of model.suggestedLoadout.startingWeapons) {
      expect(
        model.weaponOptions.find((option) => option.id === id)?.equipped,
      ).toBe(false);
    }
    // Building the model is pure: the persisted payload is unchanged.
    expect(payload).toEqual(before);
    expect(isDefaultHangarLoadout(payload)).toBe(false);
  });
});

// ── AC4: glyph + colour semantics, never colour-only (CVD) ───────────

describe('equipped weapon rows pair their glyph with a colour; other rows stay neutral', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootForRender(
    payload: HangarWarPayload,
  ): Promise<HangarScene> {
    booted = await bootScene([HangarScene]);
    booted.game.scene.start(HANGAR_SCENE_KEY, { payload, storage: null });
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(HANGAR_SCENE_KEY) as HangarScene;
  }

  it('marks the resisted/effective weapon rows and leaves power-ups and modifiers neutral', async () => {
    // A non-empty hand-picked loadout, so the later auto-fit-on-open slice
    // leaves the payload alone and this render assertion stays stable.
    const payload = ownedPayload(['spread', 'wave_laser', 'ricochet']);
    const scene = await bootForRender(payload);
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });
    const view = renderHangarScreen(scene, model);
    try {
      // `spread` is in the boss's strengths → weak, red + ▼.
      const weak = view.rows.find((row) => row.key === 'weapon:spread')!;
      expect(weak.label).toContain(HANGAR_WEAK_MARKER);
      expect(weak.text.style.color).toBe(HANGAR_WEAK_COLOR);

      // `wave_laser` is in the boss's weaknesses → strong, green + ▲.
      const strong = view.rows.find((row) => row.key === 'weapon:wave_laser')!;
      expect(strong.label).toContain(HANGAR_STRONG_MARKER);
      expect(strong.text.style.color).toBe(HANGAR_STRONG_COLOR);

      // A neutral equipped weapon carries no glyph and keeps the plain colour.
      const neutral = view.rows.find((row) => row.key === 'weapon:ricochet')!;
      expect(neutral.label).not.toContain('▲');
      expect(neutral.label).not.toContain('▼');
      expect(neutral.text.style.color).toBe('#00ff88');

      // Power-up and modifier rows never carry a matchup verdict or colour.
      const nonWeaponRows = view.rows.filter(
        (row) =>
          row.key.startsWith('buy:bomb')
          || row.key.startsWith('buy:magnet')
          || row.key.startsWith('modifier:'),
      );
      expect(nonWeaponRows.length).toBeGreaterThan(0);
      for (const row of nonWeaponRows) {
        expect(row.matchup).toBeNull();
        expect(row.label).not.toContain('▲');
        expect(row.label).not.toContain('▼');
        expect(row.text.style.color).not.toBe(HANGAR_STRONG_COLOR);
        expect(row.text.style.color).not.toBe(HANGAR_WEAK_COLOR);
      }
    } finally {
      view.destroy();
    }
  });
});
