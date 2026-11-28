/**
 * The post-battle **sortie results** view contract (TEST-FIRST,
 * AH-0MWMGPPIR009DOKR, parent AH-0MWMFGXD6005WTMN).
 *
 * **TEST-FIRST.** This suite pinned the pure "result for view" builder
 * **before** it existed (AH-0MWMGPPIR009DOKR). The builder item
 * (AH-0MWMGPQUE0064AFH, child 2) created
 * `src/core/hangarWar/sortieResult.ts` and flipped every `it.fails` here back
 * to `it` (the repo's red-before/green-after convention — see
 * `src/core/levelScaling.test.ts` and the TEST-FIRST block in
 * `src/scenes/HexMapScene.test.ts`). The suite deliberately keeps its own
 * structural interfaces and a non-literal dynamic import, so it stays a
 * **contract** the module must satisfy rather than a mirror of its exported
 * types: a builder that drifts from this shape fails here.
 *
 * ## Pinned contract (child 2 must match exactly)
 *
 * `src/core/hangarWar/sortieResult.ts` — Phaser-free, pure, no I/O:
 *
 * ```ts
 * export type SortieCaptureRecord = Pick<HexCaptureResult,
 *   'bankedDelta' | 'grant' | 'specialReward' | 'contractBonus'
 *   | 'cachePayout' | 'ringSecured' | 'ringAdvanced'>;
 *
 * export interface SortieResultRecord {
 *   readonly hexId: string | null;      // the hex the deployment targeted
 *   readonly won: boolean;
 *   readonly score: number;
 *   readonly winBonusMinerals: number;  // 0 when no fixed win bonus was paid
 *   readonly capture: SortieCaptureRecord | null; // the win path's own record
 *   readonly forfeited: SalvageAmounts | null;    // the loss path's own record
 * }
 *
 * export interface SortieResultRow {
 *   readonly key: SortieResultRowKey;
 *   readonly text: string;  // the whole rendered line
 * }
 *
 * export interface SortieResultView {
 *   readonly title: string;              // 'Sortie results'
 *   readonly outcome: 'VICTORY' | 'DEFEAT';
 *   readonly hexId: string | null;
 *   readonly rows: readonly SortieResultRow[];
 * }
 *
 * export function buildSortieResultView(
 *   record: SortieResultRecord,
 *   definitions?: readonly HexRingDefinition[],
 * ): SortieResultView;
 * ```
 *
 * **Order.** The outcome + score row is always `rows[0]`. Every later row
 * follows the draw order `salvage`, `grant`, `special`, `contract`, `cache`,
 * `win-bonus` on a victory, and `strengths`, `weaknesses` on a defeat. **No
 * row is emitted for a reward that was not paid** — a `null`/zero reward
 * contributes no line. A defeat draws no row for what was not claimed or
 * forfeited.
 *
 * **No re-derivation.** Every figure is read from the carried record (or, for
 * the defeat intel, from the authored `HEX_RING_DEFINITIONS` row the record's
 * `hexId` names). The builder never computes a reward or a weakness itself.
 *
 * @module core/hangarWar/sortieResult.test
 */

import { describe, expect, it } from 'vitest';

import { HANGAR_CATALOGUE, type HullDefinition } from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { HexRingDefinition } from './hexRing';

/** A banked/paid salvage amount (structurally `SalvageAmounts`). */
interface SalvageAmountsLike {
  minerals: number;
  cores: number;
}

/** The capture-cycle fields the results view reads. */
interface SortieCaptureLike {
  bankedDelta: SalvageAmountsLike;
  grant: {
    grantId: string;
    entryId: string;
    kind: string;
    weaponId: string | null;
  } | null;
  specialReward: {
    hexId: string;
    boss: string;
    hullId: string;
    hull: HullDefinition;
    startingLives: number;
    baseDefence: number;
    bonusStartingLives: number;
  } | null;
  contractBonus: SalvageAmountsLike | null;
  cachePayout: SalvageAmountsLike | null;
  ringSecured: boolean;
  ringAdvanced: boolean;
}

/** The sortie result the deployment→map handoff carries. */
interface SortieResultRecordLike {
  hexId: string | null;
  won: boolean;
  score: number;
  winBonusMinerals: number;
  capture: SortieCaptureLike | null;
  forfeited: SalvageAmountsLike | null;
}

/** Every row key the contract can emit. */
type SortieResultRowKey =
  | 'outcome'
  | 'salvage'
  | 'grant'
  | 'special'
  | 'contract'
  | 'cache'
  | 'win-bonus'
  | 'strengths'
  | 'weaknesses';

/** One rendered row. */
interface SortieResultRowLike {
  readonly key: SortieResultRowKey;
  readonly text: string;
}

/** The rendered results view. */
interface SortieResultViewLike {
  readonly title: string;
  readonly outcome: 'VICTORY' | 'DEFEAT';
  readonly hexId: string | null;
  readonly rows: readonly SortieResultRowLike[];
}

/** The `src/core/hangarWar/sortieResult.ts` surface this suite pins. */
interface SortieResultContract {
  buildSortieResultView(
    record: SortieResultRecordLike,
    definitions?: readonly HexRingDefinition[],
  ): SortieResultViewLike;
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const SORTIE_RESULT_MODULE = './sortieResult';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function sortieResult(): Promise<SortieResultContract> {
  return (await import(SORTIE_RESULT_MODULE)) as SortieResultContract;
}

/** The shipped `hull-3` catalogue row (the ring-2 special-mission reward). */
function juggernautHull(): HullDefinition {
  const hull = HANGAR_CATALOGUE.find((entry) => entry.id === 'hull-3');
  if (!hull || hull.kind !== 'hull') {
    throw new Error('the catalogue has no hull-3 hull');
  }
  return hull;
}

/** A capture record that paid every reward kind. */
function fullCapture(): SortieCaptureLike {
  return {
    bankedDelta: { minerals: 120, cores: 1 },
    grant: {
      grantId: 'waveLaser',
      entryId: 'wave_laser',
      kind: 'weapon',
      weaponId: 'wave_laser',
    },
    specialReward: {
      hexId: 'hex-r2-3',
      boss: 'the-void-marshall',
      hullId: 'hull-3',
      hull: juggernautHull(),
      startingLives: 5,
      baseDefence: 5,
      bonusStartingLives: 1,
    },
    contractBonus: { minerals: 60, cores: 1 },
    cachePayout: { minerals: 140, cores: 0 },
    ringSecured: true,
    ringAdvanced: true,
  };
}

/** A winning sortie record over `fullCapture()`. */
function winningRecord(
  overrides: Partial<SortieResultRecordLike> = {},
): SortieResultRecordLike {
  return {
    hexId: 'hex-r2-3',
    won: true,
    score: 1200,
    winBonusMinerals: 250,
    capture: fullCapture(),
    forfeited: null,
    ...overrides,
  };
}

/** A losing sortie at `hexId`, with the loss path's forfeited salvage. */
function losingRecord(
  overrides: Partial<SortieResultRecordLike> = {},
): SortieResultRecordLike {
  return {
    hexId: 'hex-r1-3',
    won: false,
    score: 42,
    winBonusMinerals: 0,
    capture: null,
    forfeited: { minerals: 30, cores: 2 },
    ...overrides,
  };
}

/** The rendered row keys, in draw order. */
function rowKeys(view: SortieResultViewLike): string[] {
  return view.rows.map((row) => row.key);
}

/** The rendered text of the row with `key`. */
function rowText(view: SortieResultViewLike, key: SortieResultRowKey): string {
  const row = view.rows.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no ${key} row: ${rowKeys(view).join(', ')}`);
  return row.text;
}

describe('sortie results view (test-first contract, AH-0MWMGPPIR009DOKR)', () => {
  // ── The victory view ──────────────────────────────────────────────

  it('puts the outcome and score row first', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(winningRecord());

    expect(view.title).toBe('Sortie results');
    expect(view.outcome).toBe('VICTORY');
    expect(view.hexId).toBe('hex-r2-3');
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows[0].key).toBe('outcome');
    expect(view.rows[0].text).toBe('Victory · score 1200');
  });

  it('itemises every reward that was actually paid, in draw order', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(winningRecord());

    expect(rowKeys(view)).toEqual([
      'outcome',
      'salvage',
      'grant',
      'special',
      'contract',
      'cache',
      'win-bonus',
    ]);
    expect(rowText(view, 'salvage')).toBe(
      'Salvage banked: +120 minerals, +1 core',
    );
    expect(rowText(view, 'grant')).toBe('Technology recovered: wave_laser');
    expect(rowText(view, 'special')).toBe('Special reward: Juggernaut Hull');
    expect(rowText(view, 'contract')).toBe(
      'Contract bonus: +60 minerals, +1 core',
    );
    expect(rowText(view, 'cache')).toBe('Cache payout: +140 minerals');
    expect(rowText(view, 'win-bonus')).toBe(
      'Win bonus banked: +250 minerals',
    );
  });

  it('emits no row for a reward that was not paid', async () => {
    const { buildSortieResultView } = await sortieResult();

    // Nothing banked and no optional reward: only the outcome row remains.
    const view = buildSortieResultView(
      winningRecord({
        capture: {
          bankedDelta: { minerals: 0, cores: 0 },
          grant: null,
          specialReward: null,
          contractBonus: null,
          cachePayout: null,
          ringSecured: false,
          ringAdvanced: false,
        },
        winBonusMinerals: 0,
      }),
    );

    expect(rowKeys(view)).toEqual(['outcome']);
    expect(view.rows[0].text).toBe('Victory · score 1200');
  });

  it('pays the win bonus its own row even with no capture record at all', async () => {
    // A hexless victory banks the fixed bonus with no capture cycle to run
    // (`PlayScene._resolveHangarWarCapture`), so the view must still announce
    // what was paid and nothing more.
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(
      winningRecord({ hexId: null, capture: null, winBonusMinerals: 250 }),
    );

    expect(view.outcome).toBe('VICTORY');
    expect(view.hexId).toBeNull();
    expect(rowKeys(view)).toEqual(['outcome', 'win-bonus']);
    expect(rowText(view, 'win-bonus')).toBe(
      'Win bonus banked: +250 minerals',
    );
  });

  // ── The defeat view ───────────────────────────────────────────────

  it('shows the target hex boss intel and no unclaimed grant or forfeited salvage', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(losingRecord());

    expect(view.title).toBe('Sortie results');
    expect(view.outcome).toBe('DEFEAT');
    expect(view.hexId).toBe('hex-r1-3');
    expect(view.rows[0].key).toBe('outcome');
    expect(view.rows[0].text).toBe('Defeat · score 42');
    expect(rowKeys(view)).toEqual(['outcome', 'strengths', 'weaknesses']);
    // The authored `HEX_RING_DEFINITIONS` row for `hex-r1-3`.
    expect(rowText(view, 'strengths')).toBe('Strong against: rapid');
    expect(rowText(view, 'weaknesses')).toBe('Weak against: mortar');
    // The removed claim/forfeit rows are gone, not merely reworded.
    expect(rowKeys(view)).not.toContain('grant-missed');
    expect(rowKeys(view)).not.toContain('forfeited');
  });

  it('never draws a forfeited row, whatever the loss forfeited', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(
      losingRecord({ forfeited: { minerals: 0, cores: 0 } }),
    );

    expect(rowKeys(view)).toEqual(['outcome', 'strengths', 'weaknesses']);
  });

  it('carries no intel rows for a hex the authored table does not name', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(
      losingRecord({ hexId: 'hex-not-authored' }),
    );

    expect(view.outcome).toBe('DEFEAT');
    expect(view.hexId).toBe('hex-not-authored');
    expect(rowKeys(view)).toEqual(['outcome']);
  });

  it('copies every authored strength and weakness, in order', async () => {
    const { buildSortieResultView } = await sortieResult();
    const authored = HEX_RING_DEFINITIONS.find((row) => row.id === 'hex-r1-3')!;
    const view = buildSortieResultView(losingRecord(), [
      {
        ...authored,
        strengths: ['rapid', 'arc'],
        weaknesses: ['mortar', 'nova'],
      },
    ]);

    expect(rowText(view, 'strengths')).toBe('Strong against: rapid, arc');
    expect(rowText(view, 'weaknesses')).toBe('Weak against: mortar, nova');
  });

  it('invents no intel for an authored hex with no strengths or weaknesses', async () => {
    // A defenceless hex is authored, not unknown: still no row is fabricated.
    const { buildSortieResultView } = await sortieResult();
    const authored = HEX_RING_DEFINITIONS.find((row) => row.id === 'hex-r1-3')!;
    const view = buildSortieResultView(losingRecord(), [
      { ...authored, strengths: [], weaknesses: [], grants: '' },
    ]);

    expect(rowKeys(view)).toEqual(['outcome']);
  });

  it('reads the target hex from the injected definitions, never a hard-coded table', async () => {
    const { buildSortieResultView } = await sortieResult();
    const authored = HEX_RING_DEFINITIONS.find((row) => row.id === 'hex-r1-3')!;
    const view = buildSortieResultView(losingRecord(), [
      {
        ...authored,
        strengths: ['injected-strength'],
        weaknesses: ['injected-weakness'],
        grants: 'injected-grant',
      },
    ]);

    expect(rowText(view, 'strengths')).toBe(
      'Strong against: injected-strength',
    );
    expect(rowText(view, 'weaknesses')).toBe(
      'Weak against: injected-weakness',
    );
  });

  // ── Every reward kind, present and absent ─────────────────────────

  /** A capture record that paid nothing at all. */
  function emptyCapture(): SortieCaptureLike {
    return {
      bankedDelta: { minerals: 0, cores: 0 },
      grant: null,
      specialReward: null,
      contractBonus: null,
      cachePayout: null,
      ringSecured: false,
      ringAdvanced: false,
    };
  }

  it('draws each victory reward on its own only when it was actually paid', async () => {
    const { buildSortieResultView } = await sortieResult();
    const paidEvery = fullCapture();

    const cases: Array<{
      name: string;
      capture: SortieCaptureLike;
      expected: string[];
    }> = [
      {
        name: 'salvage',
        capture: { ...emptyCapture(), bankedDelta: { minerals: 5, cores: 0 } },
        expected: ['salvage'],
      },
      {
        name: 'grant',
        capture: { ...emptyCapture(), grant: paidEvery.grant },
        expected: ['grant'],
      },
      {
        name: 'special',
        capture: { ...emptyCapture(), specialReward: paidEvery.specialReward },
        expected: ['special'],
      },
      {
        name: 'contract',
        capture: {
          ...emptyCapture(),
          contractBonus: { minerals: 60, cores: 0 },
        },
        expected: ['contract'],
      },
      {
        name: 'cache',
        capture: { ...emptyCapture(), cachePayout: { minerals: 0, cores: 2 } },
        expected: ['cache'],
      },
    ];

    for (const testCase of cases) {
      const view = buildSortieResultView(
        winningRecord({ capture: testCase.capture, winBonusMinerals: 0 }),
      );
      expect(rowKeys(view), testCase.name).toEqual([
        'outcome',
        ...testCase.expected,
      ]);
    }

    // …and each one drops out on its own once it was not paid.
    const unpayable: Array<{ name: string; drop: string }> = [
      { name: 'salvage', drop: 'salvage' },
      { name: 'grant', drop: 'grant' },
      { name: 'special', drop: 'special' },
      { name: 'contract', drop: 'contract' },
      { name: 'cache', drop: 'cache' },
      { name: 'win bonus', drop: 'win-bonus' },
    ];
    for (const testCase of unpayable) {
      const capture = { ...fullCapture() };
      if (testCase.drop === 'salvage') capture.bankedDelta = { minerals: 0, cores: 0 };
      if (testCase.drop === 'grant') capture.grant = null;
      if (testCase.drop === 'special') capture.specialReward = null;
      if (testCase.drop === 'contract') capture.contractBonus = null;
      if (testCase.drop === 'cache') capture.cachePayout = null;
      const view = buildSortieResultView(
        winningRecord({
          capture,
          winBonusMinerals: testCase.drop === 'win-bonus' ? 0 : 250,
        }),
      );
      expect(rowKeys(view), testCase.name).not.toContain(testCase.drop);
    }
  });

  // ── Purity ────────────────────────────────────────────────────────

  /** Recursively freezes `value` (and everything it holds). */
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value as object)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
    return value;
  }

  it('never mutates its inputs — a frozen record and table render normally', async () => {
    const { buildSortieResultView } = await sortieResult();
    const record = deepFreeze(winningRecord());
    const definitions = deepFreeze([...HEX_RING_DEFINITIONS]);

    // Strict mode throws on a write to a frozen object, so this also proves
    // the builder assigns nothing back to its arguments.
    const view = buildSortieResultView(record, definitions);

    expect(rowKeys(view)).toEqual([
      'outcome',
      'salvage',
      'grant',
      'special',
      'contract',
      'cache',
      'win-bonus',
    ]);
    expect(record).toEqual(winningRecord());
  });

  it('renders a frozen defeat record and table without mutating them', async () => {
    const { buildSortieResultView } = await sortieResult();
    const record = deepFreeze(losingRecord());
    const definitions = deepFreeze([...HEX_RING_DEFINITIONS]);

    const view = buildSortieResultView(record, definitions);

    expect(rowKeys(view)).toEqual([
      'outcome',
      'strengths',
      'weaknesses',
    ]);
    expect(record).toEqual(losingRecord());
  });
});
