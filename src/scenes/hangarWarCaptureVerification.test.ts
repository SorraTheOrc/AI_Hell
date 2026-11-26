/**
 * End-to-end capture verification for `hex-r1-3`
 * (AH-0MWWI3P85002GO2G, parent AH-0MWW6PNA5008NC91 AC6/AC8).
 *
 * The saved field was already correct before the catalogue derivation landed:
 * a boss victory recorded `rapid` in `hangar.unlockedWeapons`. What was
 * missing was that the catalogue could not display, equip or deploy the id, so
 * a captured weapon was silently swallowed. This suite proves the fix **from
 * the player's side** by winning the real `hex-r1-3` deployment through the
 * shared victory harness (`src/test/hangarWarWinHarness.ts`) and asserting the
 * whole player-visible chain:
 *
 * - `rapid` is owned in the captured save (`hangar.unlockedWeapons`);
 * - it renders as a named owned row in `buildHangarUnlockRows`;
 * - it is offered by `buildHangarWeaponOptions`;
 * - it survives `resolveActiveLoadout` once equipped;
 * - the capture writes **no** save-schema change (an existing payload holding
 *   `rapid` renders identically without migration);
 * - the economy is untouched (no price, no `minRing`, no rescue/aggression
 *   number changes).
 *
 * The win runs the shipped mini-boss victory path, so the capture is resolved
 * through `resolveHexCapture` in `PlayScene` exactly as it is in the game — a
 * regression that drops the grant, breaks the derivation or reprices the tree
 * fails here.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FRONTIER_TUNING,
  ringAggressionBudget,
} from '../core/hangarWar/hexDefence';
import { createRingState } from '../core/hangarWar/hexRing';
import {
  STARTING_WEAPON_STRENGTH_WEIGHT,
  resolveActiveLoadout,
  resolvePlayerStrength,
} from '../core/hangarWar/hangarEconomy';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  parseHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../core/hangarWar/types';
import {
  GRANT_ONLY_MIN_RING,
  HANGAR_CATALOGUE,
  isPurchasableEntry,
} from '../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import {
  advanceGame,
  bootScene,
  stepGameUntil,
  type BootedGame,
} from '../test/gameHarness';
import {
  injectMiniBossCampaign,
  winLiveDeployment,
} from '../test/hangarWarWinHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';
import { buildHangarDeployment } from './hangarWar/hangarDeployment';
import {
  buildHangarUnlockRows,
  buildHangarWeaponOptions,
  toggleHangarWeapon,
} from './hangarWar/hangarScreen';

/** The captured hex and the weapon its boss (`iron-crusher`) demonstrates. */
const TARGET_HEX = 'hex-r1-3';
const GRANTED_WEAPON = 'rapid';

/** A fresh war with ring 1 materialised from the authored data. */
function ringPayload(): HangarWarPayload {
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
}

/** A detached copy of a payload, so a comparison never aliases live state. */
function clonePayload(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** Every owned state an owned level-bearing weapon row may report. */
const OWNED_WEAPON_ROW_STATES = [
  'owned',
  'upgradable',
  'upgrade-unaffordable',
  'capped',
] as const;

describe('hex-r1-3 end-to-end capture verification (AH-0MWWI3P85002GO2G)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    saveHangarWarPayload(ringPayload());
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  /**
   * Boots the real `PlayScene` and wins the `hex-r1-3` deployment through the
   * shared victory harness, returning the live scene.
   *
   * The compact campaign is injected **before** the deployment starts, exactly
   * as the shipped flow integration suite does, so the harness's victory walk
   * (real mini-boss defeat → death sweep → capture) finalises the run.
   */
  async function winHexR13(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);

    injectMiniBossCampaign(scene);
    const deployment = buildHangarDeployment(ringPayload(), {
      hexId: TARGET_HEX,
    });
    scene.scene.restart({ demo: false, hangarWar: deployment });
    await advanceGame(scene.game, 200);

    winLiveDeployment(scene);
    // The mini-boss death sweep's own completion finalises the run and
    // resolves the capture; step until it has landed.
    stepGameUntil(
      scene.game,
      `the ${TARGET_HEX} capture`,
      () => scene.getLastCapture() !== null,
      600,
    );
    return scene;
  }

  it('captures hex-r1-3 through the winning harness and owns rapid', async () => {
    const scene = await winHexR13();

    const capture = scene.getLastCapture();
    expect(capture).not.toBeNull();
    expect(capture!.ok).toBe(true);
    expect(capture!.reason).toBeNull();
    expect(capture!.grant).not.toBeNull();
    expect(capture!.grant!.grantId).toBe(GRANTED_WEAPON);
    // The authored id and the catalogue entry id agree, so the captured save
    // and the hangar tree describe the same weapon.
    expect(capture!.grant!.entryId).toBe(GRANTED_WEAPON);
    expect(capture!.grant!.kind).toBe('weapon');
    expect(capture!.grant!.weaponId).toBe(GRANTED_WEAPON);

    // The grant is persisted, not merely returned: the player owns `rapid`.
    const stored = loadHangarWarPayload();
    expect(stored).not.toBeNull();
    expect(stored!.hangar.unlockedWeapons).toContain(GRANTED_WEAPON);

    const hex = stored!.ring.hexes.find((state) => state.id === TARGET_HEX);
    expect(hex).toBeDefined();
    expect(hex!.held).toBe(true);
    expect(hex!.bossDefeated).toBe(true);
    expect(hex!.grantedWeapon).toBe(GRANTED_WEAPON);
  });

  it('renders rapid as a named owned unlock row and offers it in the weapon selector', async () => {
    await winHexR13();
    const stored = loadHangarWarPayload()!;

    const row = buildHangarUnlockRows(stored).find(
      (entry) => entry.id === GRANTED_WEAPON,
    );
    expect(row, `an unlock row for ${GRANTED_WEAPON}`).toBeDefined();
    expect(row!.kind).toBe('weapon');
    expect(row!.name.trim().length).toBeGreaterThan(0);
    // The row names the weapon and reads as owned/upgradeable — never a
    // purchase row for a weapon the fleet cannot buy.
    expect(row!.label).toContain(row!.name);
    expect(OWNED_WEAPON_ROW_STATES).toContain(row!.state);
    expect(isPurchasableEntry(
      HANGAR_CATALOGUE.find((entry) => entry.id === GRANTED_WEAPON)!,
    )).toBe(false);

    const option = buildHangarWeaponOptions(stored).find(
      (entry) => entry.id === GRANTED_WEAPON,
    );
    expect(option, `a weapon option for ${GRANTED_WEAPON}`).toBeDefined();
    expect(option!.name.trim().length).toBeGreaterThan(0);
    expect(option!.actionable).toBe(true);
  });

  it('equips rapid and it survives resolveActiveLoadout', async () => {
    await winHexR13();
    const stored = loadHangarWarPayload()!;

    const toggled = toggleHangarWeapon(stored, GRANTED_WEAPON);
    expect(toggled.ok).toBe(true);
    expect(toggled.payload.hangar.activeLoadout.startingWeapons).toContain(
      GRANTED_WEAPON,
    );
    // `resolveActiveLoadout` filters catalogue-unknown ids, so surviving here
    // proves the captured weapon can actually be deployed, not just displayed.
    expect(
      resolveActiveLoadout(toggled.payload.hangar).startingWeapons,
    ).toContain(GRANTED_WEAPON);
  });

  it('writes no save-schema change — an existing payload holding rapid renders identically without migration', async () => {
    await winHexR13();
    const stored = loadHangarWarPayload()!;

    // The capture lands on the shipped schema version — no bump.
    expect(stored.version).toBe(createDefaultPayload().version);

    // A real store round-trip accepts the captured save as-is: no migration
    // step, no dropped field, rapid still owned.
    const restored = parseHangarWarPayload(
      JSON.parse(JSON.stringify(stored)),
    );
    expect(restored, 'captured save must load').not.toBeNull();
    expect(restored!.version).toBe(stored.version);
    expect(restored!.hangar.unlockedWeapons).toContain(GRANTED_WEAPON);

    // An existing save that already holds `rapid` renders identically before
    // and after the round-trip, so the derivation needed no migration.
    const existing = clonePayload(createDefaultPayload(99));
    existing.hangar.unlockedWeapons = [
      ...existing.hangar.unlockedWeapons,
      GRANTED_WEAPON,
    ];
    const existingRestored = parseHangarWarPayload(
      JSON.parse(JSON.stringify(existing)),
    );
    expect(existingRestored).not.toBeNull();
    expect(existingRestored!.version).toBe(existing.version);
    expect(buildHangarUnlockRows(existingRestored!)).toEqual(
      buildHangarUnlockRows(existing),
    );
    expect(buildHangarWeaponOptions(existingRestored!)).toEqual(
      buildHangarWeaponOptions(existing),
    );
  });

  it('leaves the economy untouched — no price, no minRing and no rescue/aggression number', async () => {
    // Snapshot the whole authored economy before the capture. Owning a weapon
    // must never reprice the tree, move a ring gate or change a hull's lives.
    const catalogueBefore = JSON.parse(
      JSON.stringify(HANGAR_CATALOGUE),
    ) as unknown;

    await winHexR13();
    const stored = loadHangarWarPayload()!;

    // The derivation leaves `rapid` grant-only: no price and no purchasable
    // ring gate, so owning it never promotes it to sale.
    const rapid = HANGAR_CATALOGUE.find(
      (entry) => entry.id === GRANTED_WEAPON,
    )!;
    expect(rapid.price).toEqual({ minerals: 0, cores: 0 });
    expect(rapid.minRing).toBe(GRANT_ONLY_MIN_RING);

    // Nothing in the catalogue moved: price, minRing, hull lives and every
    // other authored number are byte-identical to the pre-capture snapshot.
    expect(JSON.parse(JSON.stringify(HANGAR_CATALOGUE))).toEqual(
      catalogueBefore,
    );

    // Isolate the ownership effect: the captured payload with `rapid` removed
    // differs only by that weapon. Strength (the rescue/defence number) and
    // the ring's aggression budget are unchanged by owning it.
    const withoutRapid = clonePayload(stored);
    withoutRapid.hangar.unlockedWeapons =
      withoutRapid.hangar.unlockedWeapons.filter(
        (id) => id !== GRANTED_WEAPON,
      );
    const strengthWith = resolvePlayerStrength(stored.hangar);
    const strengthWithout = resolvePlayerStrength(withoutRapid.hangar);
    expect(strengthWith).toBe(strengthWithout);
    // The economy's one weapon-strength weight is pinned at zero: an equipped
    // starting weapon (captured or not) never inflates the frontier.
    expect(STARTING_WEAPON_STRENGTH_WEIGHT).toBe(0);
    expect(
      ringAggressionBudget(
        strengthWith,
        stored.ring,
        DEFAULT_FRONTIER_TUNING,
      ),
    ).toBe(
      ringAggressionBudget(
        strengthWithout,
        withoutRapid.ring,
        DEFAULT_FRONTIER_TUNING,
      ),
    );

  });
});
