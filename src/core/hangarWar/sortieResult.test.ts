/**
 * The post-battle **sortie results** view contract (TEST-FIRST,
 * AH-0MWMGPPIR009DOKR, parent AH-0MWMFGXD6005WTMN).
 *
 * **TEST-FIRST.** This suite pins the pure "result for view" builder **before**
 * it exists: the builder item (child 2) creates `src/core/hangarWar/sortieResult.ts`
 * and flips every `it.fails` here back to `it`, so a leftover `it.fails` after
 * that lands fails loudly (the repo's red-before/green-after convention — see
 * `src/core/levelScaling.test.ts` and the TEST-FIRST block in
 * `src/scenes/HexMapScene.test.ts`).
 *
 * The module is loaded through a **non-literal** dynamic import on purpose: a
 * static `import './sortieResult'` would fail `tsc --noEmit` (and therefore the
 * build) on pre-change HEAD, when the module does not exist yet. The local
 * interfaces below are the contract the implementation must satisfy; the real
 * module's types are structurally compatible with them.
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
 *   readonly title: string;              // 'SORTIE RESULTS'
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
 * `win-bonus` on a victory, and `strengths`, `weaknesses`, `grant-missed`,
 * `forfeited` on a defeat. **No row is emitted for a reward that was not
 * paid** — a `null`/zero reward contributes no line.
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
  | 'weaknesses'
  | 'grant-missed'
  | 'forfeited';

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

  it.fails('puts the outcome and score row first', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(winningRecord());

    expect(view.title).toBe('SORTIE RESULTS');
    expect(view.outcome).toBe('VICTORY');
    expect(view.hexId).toBe('hex-r2-3');
    expect(view.rows.length).toBeGreaterThan(0);
    expect(view.rows[0].key).toBe('outcome');
    expect(view.rows[0].text).toBe('VICTORY · SCORE 1200');
  });

  it.fails('itemises every reward that was actually paid, in draw order', async () => {
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
      'SALVAGE BANKED: +120 MINERALS, +1 CORE',
    );
    expect(rowText(view, 'grant')).toBe('GRANT CLAIMED: wave_laser');
    expect(rowText(view, 'special')).toBe('SPECIAL REWARD: Juggernaut Hull');
    expect(rowText(view, 'contract')).toBe(
      'CONTRACT BONUS: +60 MINERALS, +1 CORE',
    );
    expect(rowText(view, 'cache')).toBe('CACHE PAYOUT: +140 MINERALS');
    expect(rowText(view, 'win-bonus')).toBe(
      'WIN BONUS BANKED: +250 MINERALS',
    );
  });

  it.fails('emits no row for a reward that was not paid', async () => {
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
    expect(view.rows[0].text).toBe('VICTORY · SCORE 1200');
  });

  it.fails('pays the win bonus its own row even with no capture record at all', async () => {
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
      'WIN BONUS BANKED: +250 MINERALS',
    );
  });

  // ── The defeat view ───────────────────────────────────────────────

  it.fails('shows the target hex boss intel, the unclaimed grant and the forfeited salvage', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(losingRecord());

    expect(view.title).toBe('SORTIE RESULTS');
    expect(view.outcome).toBe('DEFEAT');
    expect(view.hexId).toBe('hex-r1-3');
    expect(view.rows[0].key).toBe('outcome');
    expect(view.rows[0].text).toBe('DEFEAT · SCORE 42');
    expect(rowKeys(view)).toEqual([
      'outcome',
      'strengths',
      'weaknesses',
      'grant-missed',
      'forfeited',
    ]);
    // The authored `HEX_RING_DEFINITIONS` row for `hex-r1-3`.
    expect(rowText(view, 'strengths')).toBe('STRONG AGAINST: rapid');
    expect(rowText(view, 'weaknesses')).toBe('WEAK AGAINST: mortar');
    expect(rowText(view, 'grant-missed')).toBe('GRANT NOT CLAIMED: rapid');
    expect(rowText(view, 'forfeited')).toBe(
      'SALVAGE FORFEITED: 30 MINERALS, 2 CORES',
    );
  });

  it.fails('omits the forfeited row when the loss forfeited nothing', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(
      losingRecord({ forfeited: { minerals: 0, cores: 0 } }),
    );

    expect(rowKeys(view)).toEqual([
      'outcome',
      'strengths',
      'weaknesses',
      'grant-missed',
    ]);
  });

  it.fails('carries no intel rows for a hex the authored table does not name', async () => {
    const { buildSortieResultView } = await sortieResult();
    const view = buildSortieResultView(
      losingRecord({ hexId: 'hex-not-authored' }),
    );

    expect(view.outcome).toBe('DEFEAT');
    expect(view.hexId).toBe('hex-not-authored');
    expect(rowKeys(view)).toEqual(['outcome', 'forfeited']);
  });

  it.fails('reads the target hex from the injected definitions, never a hard-coded table', async () => {
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
      'STRONG AGAINST: injected-strength',
    );
    expect(rowText(view, 'weaknesses')).toBe(
      'WEAK AGAINST: injected-weakness',
    );
    expect(rowText(view, 'grant-missed')).toBe(
      'GRANT NOT CLAIMED: injected-grant',
    );
  });
});
