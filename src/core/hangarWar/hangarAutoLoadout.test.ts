/**
 * Auto-loadout selector — red-first contract tests (AH-0MWOWDBD90045VK0).
 *
 * The first test-first slice of the auto-loadout epic (parent
 * AH-0MWOROJYT004WPSD, AC1/AC2/AC3/AC8/AC9): these specs pin the **pure**
 * selector contract BEFORE the selector exists. The implementation feature
 * (AH-0MWOWDNW7001C5X6, "Pure boss-aware auto-loadout selector") must satisfy
 * exactly the contract below; the sibling red-first pattern of
 * AH-0MWHF6X9N0082BRO / AH-0MWI5A6ZH00947X9 applies.
 *
 * ## RED by design
 *
 * `src/core/hangarWar/hangarAutoLoadout.ts` does not exist yet. Every spec
 * loads it through a **non-literal** specifier ({@link AUTO_LOADOUT_MODULE}),
 * so TypeScript does not resolve the missing module at type-check time while
 * Vitest still resolves it at runtime. The suite therefore fails with a
 * module-not-found error from the loader — the intended red — and goes green
 * only when the implementation child lands the module. No production code is
 * added in this slice.
 *
 * ## The contract these tests pin
 *
 * A new pure module `src/core/hangarWar/hangarAutoLoadout.ts`, no Phaser,
 * scene or DOM import, exporting:
 *
 * ```ts
 * export type WeaponBehaviourFamily =
 *   | 'spread' | 'beam' | 'bounce' | 'split' | 'orbit' | 'aoe' | 'plain';
 *
 * export function weaponBehaviourFamily(weaponId: WeaponId): WeaponBehaviourFamily;
 *
 * export function selectAutoLoadout(
 *   payload: HangarWarPayload,
 *   target: MatchupDefinition | null | undefined,
 *   catalogue?: readonly HangarEntry[],   // defaults to HANGAR_CATALOGUE
 * ): AutoLoadoutSuggestion;
 * ```
 *
 * `AutoLoadoutSuggestion` is plain data:
 *
 * - `picks` — the preference-ordered suggestion, one row per selected weapon
 *   **and** per auto-granted power-up:
 *   `{ kind, id, family, matchup, level, defensive, reason }`, where
 *   `kind: 'weapon' | 'power-up'`, `id` is the catalogue entry id for a weapon
 *   and the power-up id for a granted row, `family`/`matchup` are `null` for
 *   power-ups, `level` is the permanent level (`1` when never upgraded),
 *   `defensive` is `UPGRADE_STAT_BUCKETS[id] === 'armour'` for a granted
 *   power-up (and `false` for a weapon), and
 *   `reason: 'strong' | 'defensive-power-up' | 'highest-level' | 'granted'`.
 * - `startingWeapons` — the catalogue entry ids to write into
 *   `hangar.activeLoadout.startingWeapons`, in `picks` order.
 * - `grantedPowerUps` — the power-up picks (the rows the deployment grants).
 * - `slots` — `{ cap, powerUps, weapons, used }`: `cap` is
 *   `POWER_UP_SLOT_CAP`, `powerUps` is the granted power-up row count,
 *   `weapons` is the remaining weapon budget (`cap - powerUps`, never
 *   negative) and `used` is `startingWeapons.length + powerUps`.
 *
 * The rule (producer Q3 = "A then C"):
 *
 * 1. **Variety cap** — at most one weapon per behaviour family, families keyed
 *    on the shipped `WeaponDefinition` descriptors
 *    (`src/utils/weapons.ts`): `aoe` → `aoe`, `orbit` → `orbit`,
 *    `splits` → `split`, `bounce` → `bounce`, `hitscan` → `beam`, two or more
 *    distinct `offsets` → `spread`, anything else → `plain`.
 * 2. **Weak weapons are never selected** — `resolveBossMatchup(...) === 'weak'`
 *    is dropped from every step, never forced in by the fill step.
 * 3. **Strong first** — an owned weapon whose matchup is `strong` is selected
 *    before any neutral weapon (catalogue order breaks ties), up to the
 *    weapon budget.
 * 4. **Then at least one defensive power-up the deployment will auto-grant** —
 *    the owned level-bearing power-up rows (`hangarPermanentLevels`), the same
 *    rows `buildHangarDeployment` grants, ordered defensives first.
 * 5. **Then the highest permanent level** — the remaining neutral owned
 *    weapons fill the budget by descending permanent weapon level, catalogue
 *    order breaking ties.
 * 6. **Budget** — the selector reserves slots for every granted power-up row
 *    (`weapons = cap - powerUps`) and never exceeds `POWER_UP_SLOT_CAP`, so
 *    the suggestion can never present more counted kinds than the run grants.
 *    When the owned power-ups alone fill the cap, no weapon is selected.
 *
 * Ownership comes from the pure economy (`ownsEntry`), matchup verdicts from
 * `resolveBossMatchup`, permanent levels from `hangarPermanentLevels` and the
 * cap from `POWER_UP_SLOT_CAP` — no second rule of any of them.
 *
 * The suggestion is a **full replacement** derived from ownership, levels and
 * the target only: `activeLoadout` is not an input. That is what makes
 * re-applying it idempotent (AC8) and lets the "apply suggested buildout"
 * action target any loadout. The auto-fit-when-empty trigger is the scene's
 * concern (later slice), not this selector's.
 *
 * Shipped data drives the cases (`HANGAR_CATALOGUE`, `HEX_RING_DEFINITIONS`,
 * `WEAPON_CATALOGUE`, `POWER_UP_CATALOGUE`); one small injected catalogue
 * covers the family and defensive-budget cases that the shipped tree does not
 * contain yet.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../constants';
import { UPGRADE_STAT_BUCKETS } from './hangarEconomy';
import { createSampleHangarWarPayload } from './fixtures';
import {
  HANGAR_CATALOGUE,
  type HangarEntry,
  type StartingWeaponDefinition,
} from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { buildHangarDeployment } from '../../scenes/hangarWar/hangarDeployment';
import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';
import type { HangarState, HangarWarPayload } from './types';
import type { BossMatchup, MatchupDefinition } from './weaponMatchup';

// ── The pinned selector surface (declared here, implemented in C2) ───

/** The behaviour families the variety cap keys on (shipped descriptors). */
type WeaponBehaviourFamily =
  | 'spread'
  | 'beam'
  | 'bounce'
  | 'split'
  | 'orbit'
  | 'aoe'
  | 'plain';

/** Why a pick is in the suggestion (the documented preference order). */
type AutoLoadoutReason =
  | 'strong'
  | 'defensive-power-up'
  | 'highest-level'
  | 'granted';

/** One preference-ordered suggestion row (a weapon or an auto-granted power-up). */
interface AutoLoadoutPick {
  /** Whether the row is an equipped weapon or an auto-granted power-up. */
  readonly kind: 'weapon' | 'power-up';
  /** Catalogue entry id for a weapon; power-up id for a granted row. */
  readonly id: string;
  /** Behaviour family (weapons only; `null` for power-ups). */
  readonly family: WeaponBehaviourFamily | null;
  /** Boss matchup verdict (weapons only; `null` for power-ups). */
  readonly matchup: BossMatchup | null;
  /** Permanent level (`1` when never upgraded). */
  readonly level: number;
  /** True for a granted power-up in the shipped `armour` bucket. */
  readonly defensive: boolean;
  /** Which preference step produced the row. */
  readonly reason: AutoLoadoutReason;
}

/** The shared six-slot budget the suggestion agrees with. */
interface AutoLoadoutSlots {
  /** `POWER_UP_SLOT_CAP`. */
  readonly cap: number;
  /** Granted power-up rows. */
  readonly powerUps: number;
  /** Remaining weapon budget (`cap - powerUps`). */
  readonly weapons: number;
  /** `startingWeapons.length + powerUps`, never above `cap`. */
  readonly used: number;
}

/** The selector's plain-data suggestion. */
interface AutoLoadoutSuggestion {
  /** Catalogue entry ids to equip (in `picks` order, no duplicates). */
  readonly startingWeapons: readonly string[];
  /** The auto-granted power-up rows (the deployment's grant list). */
  readonly grantedPowerUps: readonly AutoLoadoutPick[];
  /** The shared-slot accounting. */
  readonly slots: AutoLoadoutSlots;
  /** The preference-ordered suggestion (weapons and granted power-ups). */
  readonly picks: readonly AutoLoadoutPick[];
}

/** The `src/core/hangarWar/hangarAutoLoadout.ts` surface this suite pins. */
interface AutoLoadoutContract {
  weaponBehaviourFamily(weaponId: WeaponId): WeaponBehaviourFamily;
  selectAutoLoadout(
    payload: HangarWarPayload,
    target: MatchupDefinition | null | undefined,
    catalogue?: readonly HangarEntry[],
  ): AutoLoadoutSuggestion;
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const AUTO_LOADOUT_MODULE = './hangarAutoLoadout';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function autoLoadout(): Promise<AutoLoadoutContract> {
  return (await import(AUTO_LOADOUT_MODULE)) as AutoLoadoutContract;
}

/** The selector source the purity/export scans read. */
const SELECTOR_SOURCE = path.join(
  process.cwd(),
  'src/core/hangarWar/hangarAutoLoadout.ts',
);

// ── Shipped-data helpers ─────────────────────────────────────────────

/** A shipped ring hex by id (the authored strengths/weaknesses are the target). */
function targetOf(id: string): MatchupDefinition {
  const hex = HEX_RING_DEFINITIONS.find((candidate) => candidate.id === id);
  if (hex === undefined) throw new Error(`expected an authored hex ${id}`);
  return { strengths: hex.strengths, weaknesses: hex.weaknesses };
}

/** Overrides for a deterministic sample payload (empty loadout by default). */
interface PayloadOverrides {
  /** Owned catalogue entry ids (`hangar.unlockedWeapons`). */
  readonly weapons?: readonly string[];
  /** Owned level-bearing power-up ids (`hangar.unlockedPowerUps`). */
  readonly powerUps?: readonly string[];
  /** Permanent weapon level rows. */
  readonly weaponLevels?: ReadonlyArray<{ readonly id: WeaponId; readonly level: number }>;
  /** Permanent power-up level rows. */
  readonly powerUpLevels?: ReadonlyArray<{ readonly id: PowerUpId; readonly level: number }>;
  /** The already-equipped starting weapons (the selector ignores them). */
  readonly loadout?: readonly string[];
}

/**
 * A fresh, deterministic payload whose hangar carries exactly the requested
 * ownership, permanent levels and (by default empty) loadout. The ring is the
 * shared sample ring; the selector reads the target definition directly.
 */
function payloadOf(overrides: PayloadOverrides = {}): HangarWarPayload {
  const base = createSampleHangarWarPayload(20261120);
  const hangar: HangarState = {
    ...base.hangar,
    unlockedWeapons: [...(overrides.weapons ?? ['spread'])],
    unlockedPowerUps: [...(overrides.powerUps ?? [])],
    activeLoadout: {
      startingWeapons: [...(overrides.loadout ?? [])],
      modifiers: [],
    },
  };
  if (overrides.weaponLevels !== undefined) {
    hangar.weaponLevels = overrides.weaponLevels.map((row) => ({ ...row }));
  }
  if (overrides.powerUpLevels !== undefined) {
    hangar.powerUpLevels = overrides.powerUpLevels.map((row) => ({ ...row }));
  }
  return { ...base, hangar };
}

/**
 * A synthetic starting-weapon entry pointing at a shipped weapon, so a case
 * can own weapons the shipped tree does not sell yet (Options, Nova, …).
 */
function injectedWeapon(id: string, weaponId: WeaponId): StartingWeaponDefinition {
  return {
    id,
    kind: 'weapon',
    name: `Injected ${weaponId}`,
    description: `Test-only starting weapon for ${weaponId}.`,
    price: { minerals: 0, cores: 0 },
    minRing: 1,
    starter: false,
    weaponId,
  };
}

/** Weapon picks only (the rows that consume weapon slots). */
function weaponPicks(suggestion: AutoLoadoutSuggestion): AutoLoadoutPick[] {
  return suggestion.picks.filter((pick) => pick.kind === 'weapon');
}

/** Power-up picks only (the rows the deployment auto-grants). */
function powerUpPicks(suggestion: AutoLoadoutSuggestion): AutoLoadoutPick[] {
  return suggestion.picks.filter((pick) => pick.kind === 'power-up');
}

// ── Module surface, purity and single-sourcing (AC1/AC7) ─────────────

describe('auto-loadout selector — module surface and purity', () => {
  it('exports the pure selector and the shipped-family helper', async () => {
    const { selectAutoLoadout, weaponBehaviourFamily } = await autoLoadout();
    expect(typeof selectAutoLoadout).toBe('function');
    expect(typeof weaponBehaviourFamily).toBe('function');
  });

  it('imports no Phaser, scene or DOM surface and no ambient clock/randomness', async () => {
    // The selector is a shared pure rule (parent AC7): it must be importable
    // from a gym and the game alike, so scene/Phaser/DOM imports are forbidden
    // and so are wall-clock/unseeded-random decisions (parent AC8).
    const source = fs.readFileSync(SELECTOR_SOURCE, 'utf8');
    expect(source).not.toMatch(/from\s+['"]phaser['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*scenes\//);
    expect(source).not.toMatch(/\bwindow\b|\bdocument\b|\blocalStorage\b/);
    expect(source).not.toMatch(/Math\.random|Date\.now|performance\.now/);
  });

  it('reuses the shipped rules instead of restating them (AC7)', () => {
    const source = fs.readFileSync(SELECTOR_SOURCE, 'utf8');
    // One matchup rule, one ownership rule, one level normaliser, one cap.
    expect(source).toMatch(/weaponMatchup/);
    expect(source).toMatch(/hangarEconomy/);
    expect(source).toMatch(/POWER_UP_SLOT_CAP/);
    expect(source).not.toMatch(/function\s+resolveBossMatchup/);
  });
});

// ── Behaviour families keyed on the shipped descriptors (AC3) ───────

describe('weaponBehaviourFamily — keyed on the shipped weapon descriptors', () => {
  it('maps every family on the shipped roster', async () => {
    const { weaponBehaviourFamily } = await autoLoadout();
    const expected: ReadonlyArray<[WeaponId, WeaponBehaviourFamily]> = [
      ['spread', 'spread'],
      ['wave_laser', 'beam'],
      ['ricochet', 'bounce'],
      ['cluster', 'split'],
      ['options', 'orbit'],
      ['nova', 'aoe'],
      ['mortar', 'aoe'],
      ['arc', 'aoe'],
      ['cannon', 'plain'],
      ['dual', 'plain'],
      ['rapid', 'plain'],
      ['rear_guard', 'plain'],
      ['heavy_slug', 'plain'],
    ];
    for (const [weaponId, family] of expected) {
      expect(weaponBehaviourFamily(weaponId), weaponId).toBe(family);
    }
  });

  it('descriptor-driven: the whole AoE roster is one family and the side-by-side Dual is plain', async () => {
    const { weaponBehaviourFamily } = await autoLoadout();
    // `dual` carries two offsets at the same angle (a side-by-side pair), which
    // is not the Spread fan — the family rule keys distinct offset **angles**.
    expect(weaponBehaviourFamily('dual')).toBe('plain');
    expect(weaponBehaviourFamily('spread')).toBe('spread');
    expect(weaponBehaviourFamily('broadside')).toBe('spread');
  });
});

// ── Strong weapons are auto-equipped (AC2) ───────────────────────────

describe('selectAutoLoadout — strong weapons', () => {
  it('equips an owned strong weapon for an empty loadout', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet'],
    });
    // hex-r1-2 is weak to the Wave Laser and strong against the Spread Cannon.
    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));

    expect(suggestion.startingWeapons).toContain('wave_laser');
    expect(suggestion.startingWeapons).not.toContain('spread');
    const strong = suggestion.picks.find(
      (pick) => pick.kind === 'weapon' && pick.id === 'wave_laser',
    );
    expect(strong).toMatchObject({
      kind: 'weapon',
      matchup: 'strong',
      family: 'beam',
      reason: 'strong',
    });
    expect(suggestion.picks[0]?.reason).toBe('strong');
  });

  it('selects the strong weapon ahead of neutral owned weapons', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
    });
    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));
    const weapons = weaponPicks(suggestion);

    expect(weapons[0]?.id).toBe('wave_laser');
    expect(weapons[0]?.reason).toBe('strong');
    expect(weapons.map((pick) => pick.id)).toEqual(
      expect.arrayContaining(['ricochet', 'cluster']),
    );
  });
});

// ── Weak weapons are never selected (AC2/AC3) ────────────────────────

describe('selectAutoLoadout — weak weapons', () => {
  it('never selects an owned weak weapon, however many slots are free', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    // hex-r1-2 resists the Spread Cannon; no power-ups, so six slots are free.
    const suggestion = selectAutoLoadout(
      payloadOf({ weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'] }),
      targetOf('hex-r1-2'),
    );

    expect(suggestion.startingWeapons).not.toContain('spread');
    expect(
      suggestion.picks.some((pick) => pick.id === 'spread'),
    ).toBe(false);
  });

  it('never lets the fill step force a weak weapon into the suggestion', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    // Only a weak weapon and a neutral one are owned: the fill step must take
    // the neutral one and leave the weak one out.
    const suggestion = selectAutoLoadout(
      payloadOf({ weapons: ['spread', 'ricochet'] }),
      targetOf('hex-r1-2'),
    );

    expect(suggestion.startingWeapons).toEqual(['ricochet']);
    expect(suggestion.slots.used).toBe(1);
  });

  it('suggests no weapon when the only owned weapon is weak', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const suggestion = selectAutoLoadout(
      payloadOf({ weapons: ['spread'] }),
      targetOf('hex-r1-2'),
    );

    expect(suggestion.startingWeapons).toEqual([]);
    expect(weaponPicks(suggestion)).toEqual([]);
  });
});

// ── Variety: at most one weapon per behaviour family (AC3) ──────────

describe('selectAutoLoadout — variety cap', () => {
  it('keeps at most one weapon per behaviour family across strong and fill', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const catalogue: HangarEntry[] = [
      ...HANGAR_CATALOGUE,
      injectedWeapon('options', 'options'),
      injectedWeapon('nova', 'nova'),
      injectedWeapon('mortar', 'mortar'),
    ];
    const payload = payloadOf({
      // Sprd (weak) + one per remaining family, including two AoE entries.
      weapons: [
        'spread',
        'wave_laser',
        'ricochet',
        'cluster',
        'options',
        'nova',
        'mortar',
      ],
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'), catalogue);
    const weapons = weaponPicks(suggestion);
    const families = weapons.map((pick) => pick.family);

    expect(families).toHaveLength(new Set(families).size);
    expect(new Set(families)).toEqual(
      new Set(['beam', 'bounce', 'split', 'orbit', 'aoe']),
    );
    expect(weapons.map((pick) => pick.id)).not.toContain('spread');
  });

  it('keeps the first catalogue entry when two entries share a family', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    // Two AoE entries owned; only the catalogue-first may be picked.
    const catalogue: HangarEntry[] = [
      injectedWeapon('test-nova', 'nova'),
      injectedWeapon('test-mortar', 'mortar'),
    ];
    const payload = payloadOf({ weapons: ['test-nova', 'test-mortar'] });
    const suggestion = selectAutoLoadout(
      payload,
      { strengths: [], weaknesses: [] },
      catalogue,
    );

    expect(weaponPicks(suggestion).map((pick) => pick.id)).toEqual(['test-nova']);
  });
});

// ── Preference order: strong → defensive power-up → highest level (AC3) ──

describe('selectAutoLoadout — preference order', () => {
  it('orders strong, then a defensive power-up, then the highest permanent level', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['bomb', 'magnet'],
      weaponLevels: [
        { id: 'ricochet', level: 3 },
        { id: 'cluster', level: 1 },
      ],
      powerUpLevels: [
        { id: 'magnet', level: 2 },
        { id: 'bomb', level: 1 },
      ],
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));
    const reasons = suggestion.picks.map((pick) => pick.reason);

    // Strong first; the defensive power-up before any level-based fill; then
    // the fill ordered by descending permanent level.
    expect(reasons[0]).toBe('strong');
    expect(reasons).toContain('defensive-power-up');
    expect(reasons.indexOf('defensive-power-up')).toBeLessThan(
      reasons.indexOf('highest-level'),
    );
    const fills = suggestion.picks.filter(
      (pick) => pick.reason === 'highest-level',
    );
    expect(fills.map((pick) => pick.id)).toEqual(['ricochet', 'cluster']);
    expect(fills.map((pick) => pick.level)).toEqual([3, 1]);
    expect(suggestion.grantedPowerUps[0]).toMatchObject({
      kind: 'power-up',
      id: 'bomb',
      defensive: true,
      reason: 'defensive-power-up',
    });
  });

  it('classifies defensiveness through the shipped armour bucket', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet'],
      powerUps: ['bomb', 'smart_bomb', 'magnet', 'speed_boost'],
      powerUpLevels: [
        { id: 'bomb', level: 1 },
        { id: 'smart_bomb', level: 1 },
        { id: 'magnet', level: 2 },
        { id: 'speed_boost', level: 1 },
      ],
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));
    for (const pick of powerUpPicks(suggestion)) {
      expect(pick.defensive, pick.id).toBe(
        UPGRADE_STAT_BUCKETS[pick.id] === 'armour',
      );
    }
    expect(
      powerUpPicks(suggestion).filter((pick) => pick.defensive).length,
    ).toBeGreaterThan(0);
  });

  it('falls back to strong then highest level when no defensive power-up is owned', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['magnet'],
      weaponLevels: [{ id: 'cluster', level: 2 }],
      powerUpLevels: [{ id: 'magnet', level: 1 }],
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));

    expect(suggestion.picks.map((pick) => pick.reason)).not.toContain(
      'defensive-power-up',
    );
    expect(suggestion.picks[0]?.reason).toBe('strong');
    const fills = suggestion.picks.filter(
      (pick) => pick.reason === 'highest-level',
    );
    expect(fills[0]?.id).toBe('cluster');
    expect(fills[0]?.level).toBe(2);
  });
});

// ── Slot budget: never above POWER_UP_SLOT_CAP (AC3) ─────────────────

describe('selectAutoLoadout — six-slot budget', () => {
  it('reserves slots for the auto-granted power-up levels', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['bomb', 'magnet'],
      powerUpLevels: [
        { id: 'bomb', level: 1 },
        { id: 'magnet', level: 1 },
      ],
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));

    expect(suggestion.slots).toEqual({
      cap: POWER_UP_SLOT_CAP,
      powerUps: 2,
      weapons: POWER_UP_SLOT_CAP - 2,
      used: 2 + suggestion.startingWeapons.length,
    });
    expect(weaponPicks(suggestion).length).toBeLessThanOrEqual(
      POWER_UP_SLOT_CAP - 2,
    );
    // The strong weapon is still inside the reserved budget.
    expect(suggestion.startingWeapons[0]).toBe('wave_laser');
  });

  it('never exceeds POWER_UP_SLOT_CAP when the owned power-ups alone fill it', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const owned: PowerUpId[] = [
      'bomb',
      'smart_bomb',
      'magnet',
      'speed_boost',
      'mineral_scoop',
      'frenzy',
      'chrono',
    ];
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet'],
      powerUps: owned,
      powerUpLevels: owned.map((id) => ({ id, level: 1 })),
    });

    const suggestion = selectAutoLoadout(payload, targetOf('hex-r1-2'));

    expect(suggestion.slots.cap).toBe(POWER_UP_SLOT_CAP);
    expect(suggestion.slots.powerUps).toBe(POWER_UP_SLOT_CAP);
    expect(suggestion.slots.weapons).toBe(0);
    expect(suggestion.slots.used).toBe(POWER_UP_SLOT_CAP);
    expect(weaponPicks(suggestion)).toEqual([]);
    // Reserving defensives first keeps at least one in the effective grant.
    expect(suggestion.grantedPowerUps.some((pick) => pick.defensive)).toBe(true);
  });

  it("agrees with buildHangarDeployment's grant list and never over-fills the run", async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['bomb', 'magnet'],
      powerUpLevels: [
        { id: 'bomb', level: 1 },
        { id: 'magnet', level: 2 },
      ],
    });
    const target = targetOf('hex-r1-2');

    const suggestion = selectAutoLoadout(payload, target);
    const applied: HangarWarPayload = {
      ...payload,
      hangar: {
        ...payload.hangar,
        activeLoadout: {
          ...payload.hangar.activeLoadout,
          startingWeapons: [...suggestion.startingWeapons],
        },
      },
    };
    const deployment = buildHangarDeployment(applied);

    expect(deployment.powerUpLevels).toHaveLength(suggestion.slots.powerUps);
    expect(
      deployment.startingWeapons.length + deployment.powerUpLevels.length,
    ).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect(suggestion.slots.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
  });
});

// ── Determinism, idempotence and purity (AC8) ────────────────────────

describe('selectAutoLoadout — determinism and idempotence', () => {
  it('returns identical output for identical inputs', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const target = targetOf('hex-r1-2');
    const first = selectAutoLoadout(
      payloadOf({ weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'] }),
      target,
    );
    const second = selectAutoLoadout(
      payloadOf({ weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'] }),
      target,
    );

    expect(second).toEqual(first);
  });

  it('is a fixed point when its suggestion is re-applied to the loadout', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const target = targetOf('hex-r1-2');
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['bomb'],
      powerUpLevels: [{ id: 'bomb', level: 1 }],
    });

    const first = selectAutoLoadout(payload, target);
    const reapplied: HangarWarPayload = {
      ...payload,
      hangar: {
        ...payload.hangar,
        activeLoadout: {
          ...payload.hangar.activeLoadout,
          startingWeapons: [...first.startingWeapons],
        },
      },
    };
    const second = selectAutoLoadout(reapplied, target);

    expect(second).toEqual(first);
    expect(new Set(second.startingWeapons).size).toBe(
      second.startingWeapons.length,
    );
  });

  it('ignores the owned-set order (catalogue order is the deterministic tie-break)', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const target = targetOf('hex-r1-2');
    const forward = selectAutoLoadout(
      payloadOf({ weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'] }),
      target,
    );
    const reversed = selectAutoLoadout(
      payloadOf({ weapons: ['cluster', 'ricochet', 'wave_laser', 'spread'] }),
      target,
    );

    expect(reversed).toEqual(forward);
  });

  it('does not mutate the payload it is given', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
      powerUps: ['bomb'],
      powerUpLevels: [{ id: 'bomb', level: 1 }],
    });
    const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

    selectAutoLoadout(payload, targetOf('hex-r1-2'));

    expect(payload).toEqual(before);
  });

  it('treats a missing target as neutral instead of throwing', async () => {
    const { selectAutoLoadout } = await autoLoadout();
    const payload = payloadOf({
      weapons: ['spread', 'wave_laser', 'ricochet'],
    });

    const suggestion = selectAutoLoadout(payload, null);

    expect(suggestion.startingWeapons).toEqual(
      expect.arrayContaining(['spread', 'wave_laser', 'ricochet']),
    );
    expect(
      suggestion.picks.every(
        (pick) => pick.kind === 'power-up' || pick.matchup === 'neutral',
      ),
    ).toBe(true);
    expect(
      suggestion.picks.every(
        (pick) => pick.kind === 'power-up' || pick.reason !== 'strong',
      ),
    ).toBe(true);
  });
});
