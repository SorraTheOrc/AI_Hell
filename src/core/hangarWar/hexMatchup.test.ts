/**
 * Hex matchup rule + resisted-credit ledger tests (AH-0MWL88F1G0025IQ1,
 * **TEST-FIRST** — Phase 1 of 5 of AH-0MWL5376H001WJFZ).
 *
 * These tests pin the contract of the pure, headless matchup core that makes a
 * hex's authored `strengths`/`weaknesses` mechanically load-bearing (parent
 * decisions Q1 = A + B, Q3 = ×2 / ×0.5, Q4 = the authored lists stay
 * authoritative behind an injectable lookup).
 *
 * The module under test (`./hexMatchup`) does **not exist yet**: this is the
 * red half of the tracer bullet, and the implementation item
 * (AH-0MWL88JJM004ORZS) lands it and flips every `it.fails` below back to a
 * plain `it` (the repo's red-before/green-after convention — see
 * `src/core/levelScaling.test.ts`). Loading the module through a **non-literal**
 * dynamic import keeps the suite compiling on pre-change HEAD: a static
 * `import './hexMatchup'` would fail `tsc --noEmit` and therefore the build.
 *
 * ## Pinned contract (AH-0MWL88JJM004ORZS must match exactly)
 *
 * `src/core/hangarWar/hexMatchup.ts` — Phaser-free, scene-free, DOM-free:
 *
 * - `type HexMatchupVerdict = 'effective' | 'neutral' | 'resisted'`.
 * - `type WeaponVerdictLookup = Readonly<Record<string, HexMatchupVerdict>>` —
 *   the **injectable verdict lookup**: canonical weapon id → verdict. It is
 *   data, not behaviour, so a later damage-type table can back it without
 *   editing the combat seam (parent AC14).
 * - `normaliseMatchupWeaponId(id)` — resolves an authored or catalogue spelling
 *   to its canonical catalogue id through the shared capture-cycle alias
 *   (`resolveGrantAlias`, so `waveLaser` → `wave_laser`); a blank/non-string id
 *   resolves to `null`. **One** alias table, never two.
 * - `resolveHexMatchup(weaponId, lookup)` — the **only** place the
 *   advantage/handicap is decided. Returns the lookup's verdict for the
 *   **normalised** weapon id, `'neutral'` when the id is absent from the lookup
 *   (an unknown weapon id or an unauthored hex), and `'neutral'` for a
 *   `null`/`undefined` weapon id or lookup. It never scans the authored lists
 *   and never consults the catalogue, so a synthetic lookup fully replaces the
 *   authored data (AC14).
 * - `buildAuthoredVerdictLookup(strengths, weaknesses)` — builds the lookup
 *   from a hex's authored lists, normalising every entry: a `weaknesses` entry
 *   is `'effective'` (the boss is weak → the weapon counters it) and a
 *   `strengths` entry is `'resisted'` (the boss resists it). Tolerant of a
 *   missing/malformed list (empty lookup) — the validator, not this builder,
 *   rejects bad authored data.
 * - The **resisted-credit ledger** (approach A's rounding rule, Q3 = ×0.5):
 *   a pure, deterministic per-target/per-weapon parity ledger with no I/O and
 *   no new RNG:
 *   - `createMatchupLedger()` — a fresh, empty ledger.
 *   - `creditResistedHit(ledger, targetId, weaponId)` — records one connected
 *     resisted shot and returns the hit points to apply: `0` on the first of a
 *     pair, `1` on the second (exactly **one hit point per two connected
 *     shots**, the credit accruing to the second shot). Keyed per target **and**
 *     per weapon, so two weapons or two targets never share a pair.
 *   - `forgetTarget(ledger, targetId)` — drops every weapon's credit for a
 *     target when it dies, so a respawned/reused target starts a fresh pair.
 *
 * The suite is **deliberately decoupled from the authored ring table**: this
 * file never imports `src/data/hexRingDefinitions.ts` and every lookup below is
 * synthetic, proving the rule reads no authored storage (parent AC14).
 */

import { describe, expect, it } from 'vitest';

/** The matchup verdict for a weapon against one hex's boss. */
type HexMatchupVerdict = 'effective' | 'neutral' | 'resisted';

/** An injectable verdict lookup: canonical weapon id → verdict. */
type WeaponVerdictLookup = Readonly<Record<string, HexMatchupVerdict>>;

/**
 * The `src/core/hangarWar/hexMatchup.ts` surface this suite pins. The ledger
 * is opaque to the tests — only the credited hit points are observable.
 */
interface MatchupLedgerContract {
  /** Opaque ledger shape owned by the module; the tests only pass it around. */
  readonly __opaque?: never;
}

interface HexMatchupContract {
  normaliseMatchupWeaponId(weaponId: unknown): string | null;
  resolveHexMatchup(
    weaponId: string | null | undefined,
    lookup: WeaponVerdictLookup | null | undefined,
  ): HexMatchupVerdict;
  buildAuthoredVerdictLookup(
    strengths: readonly string[] | null | undefined,
    weaknesses: readonly string[] | null | undefined,
  ): WeaponVerdictLookup;
  createMatchupLedger(): MatchupLedgerContract;
  creditResistedHit(
    ledger: MatchupLedgerContract,
    targetId: string,
    weaponId: string,
  ): 0 | 1;
  forgetTarget(ledger: MatchupLedgerContract, targetId: string): void;
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const HEX_MATCHUP_MODULE = './hexMatchup';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function hexMatchup(): Promise<HexMatchupContract> {
  return (await import(HEX_MATCHUP_MODULE)) as unknown as HexMatchupContract;
}

describe('normaliseMatchupWeaponId', () => {
  it.fails(
    'normalises the ring spelling waveLaser to the catalogue id wave_laser (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { normaliseMatchupWeaponId } = await hexMatchup();
      expect(normaliseMatchupWeaponId('waveLaser')).toBe('wave_laser');
    },
  );

  it.fails(
    'leaves an already-canonical catalogue id unchanged (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { normaliseMatchupWeaponId } = await hexMatchup();
      expect(normaliseMatchupWeaponId('nova')).toBe('nova');
    },
  );

  it.fails(
    'resolves a blank, null, undefined or non-string id to null (total) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { normaliseMatchupWeaponId } = await hexMatchup();
      expect(normaliseMatchupWeaponId('   ')).toBeNull();
      expect(normaliseMatchupWeaponId('')).toBeNull();
      expect(normaliseMatchupWeaponId(null)).toBeNull();
      expect(normaliseMatchupWeaponId(undefined)).toBeNull();
      expect(normaliseMatchupWeaponId(42)).toBeNull();
    },
  );
});

describe('resolveHexMatchup', () => {
  it.fails(
    'returns effective for a weapon the supplied lookup marks effective (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      expect(
        resolveHexMatchup('nova', { nova: 'effective' }),
      ).toBe('effective');
    },
  );

  it.fails(
    'returns resisted for a weapon the supplied lookup marks resisted (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      expect(
        resolveHexMatchup('cannon', { cannon: 'resisted' }),
      ).toBe('resisted');
    },
  );

  it.fails(
    'returns neutral for a weapon absent from the lookup (an unknown weapon id) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      expect(
        resolveHexMatchup('not-a-weapon', { nova: 'effective' }),
      ).toBe('neutral');
    },
  );

  it.fails(
    'returns neutral for null and undefined weapon ids (total) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      const lookup: WeaponVerdictLookup = { nova: 'effective' };
      expect(resolveHexMatchup(null, lookup)).toBe('neutral');
      expect(resolveHexMatchup(undefined, lookup)).toBe('neutral');
    },
  );

  it.fails(
    'returns neutral for a null, undefined or empty lookup (an unauthored hex) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      expect(resolveHexMatchup('nova', undefined)).toBe('neutral');
      expect(resolveHexMatchup('nova', null)).toBe('neutral');
      expect(resolveHexMatchup('nova', {})).toBe('neutral');
    },
  );

  it.fails(
    'normalises the queried weapon id through the shared alias before looking it up (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      expect(
        resolveHexMatchup('waveLaser', { wave_laser: 'resisted' }),
      ).toBe('resisted');
    },
  );

  it.fails(
    'resolves a fully synthetic lookup with no authored data (AC14: the rule is decoupled from the lists storage) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { resolveHexMatchup } = await hexMatchup();
      // Synthetic ids that exist in no catalogue and no authored list: the
      // resolver must trust the lookup alone, never the catalogue.
      const synthetic: WeaponVerdictLookup = {
        'synthetic-blaster': 'effective',
        'synthetic-hammer': 'resisted',
      };
      expect(resolveHexMatchup('synthetic-blaster', synthetic)).toBe(
        'effective',
      );
      expect(resolveHexMatchup('synthetic-hammer', synthetic)).toBe(
        'resisted',
      );
      expect(resolveHexMatchup('synthetic-other', synthetic)).toBe('neutral');
    },
  );
});

describe('buildAuthoredVerdictLookup', () => {
  it.fails(
    'maps a weakness entry to effective and a strength entry to resisted (player-centric) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { buildAuthoredVerdictLookup } = await hexMatchup();
      const lookup = buildAuthoredVerdictLookup(['cannon', 'dual'], ['nova']);
      expect(lookup).toEqual({ cannon: 'resisted', dual: 'resisted', nova: 'effective' });
    },
  );

  it.fails(
    'normalises authored spellings to catalogue ids (waveLaser → wave_laser) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { buildAuthoredVerdictLookup } = await hexMatchup();
      const lookup = buildAuthoredVerdictLookup([], ['waveLaser']);
      expect(lookup).toEqual({ wave_laser: 'effective' });
    },
  );

  it.fails(
    'is tolerant of missing or malformed lists (empty lookup) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { buildAuthoredVerdictLookup } = await hexMatchup();
      expect(buildAuthoredVerdictLookup(null, undefined)).toEqual({});
      expect(
        buildAuthoredVerdictLookup(
          ['cannon', 42, '', null] as unknown as string[],
          'nova' as unknown as string[],
        ),
      ).toEqual({ cannon: 'resisted' });
    },
  );
});

describe('resisted-credit ledger (the ×0.5 tie rule)', () => {
  it.fails(
    'grants one hit point per two connected shots, credited to the second of each pair (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { createMatchupLedger, creditResistedHit } = await hexMatchup();
      const ledger = createMatchupLedger();
      const credits = [1, 2, 3, 4, 5, 6].map(() =>
        creditResistedHit(ledger, 'boss-1', 'cannon'),
      );
      expect(credits).toEqual([0, 1, 0, 1, 0, 1]);
    },
  );

  it.fails(
    'tracks each weapon independently, so weapons never share a pair (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { createMatchupLedger, creditResistedHit } = await hexMatchup();
      const ledger = createMatchupLedger();
      // Cannon's first shot (0), dual's first shot (0), then each second (1).
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(0);
      expect(creditResistedHit(ledger, 'boss-1', 'dual')).toBe(0);
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(1);
      expect(creditResistedHit(ledger, 'boss-1', 'dual')).toBe(1);
    },
  );

  it.fails(
    'tracks each target independently, so targets never share a pair (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { createMatchupLedger, creditResistedHit } = await hexMatchup();
      const ledger = createMatchupLedger();
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(0);
      expect(creditResistedHit(ledger, 'boss-2', 'cannon')).toBe(0);
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(1);
      expect(creditResistedHit(ledger, 'boss-2', 'cannon')).toBe(1);
    },
  );

  it.fails(
    'resets a target\'s credit when it dies, so the next target starts a fresh pair (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { createMatchupLedger, creditResistedHit, forgetTarget } =
        await hexMatchup();
      const ledger = createMatchupLedger();
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(0);
      forgetTarget(ledger, 'boss-1');
      // Credit was forgotten: the next hit is again the first of a pair.
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(0);
      expect(creditResistedHit(ledger, 'boss-1', 'cannon')).toBe(1);
    },
  );

  it.fails(
    'is deterministic: two independent ledgers with the same hits agree (no RNG) (RED-first: flips to `it` once AH-0MWL88JJM004ORZS lands hexMatchup)',
    async () => {
      const { createMatchupLedger, creditResistedHit } = await hexMatchup();
      const run = (): number[] => {
        const ledger = createMatchupLedger();
        return Array.from({ length: 8 }, () =>
          creditResistedHit(ledger, 'boss-1', 'railgun'),
        );
      };
      expect(run()).toEqual(run());
    },
  );
});
