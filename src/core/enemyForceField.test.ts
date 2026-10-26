/**
 * Contract tests for the enemy force-field resolver (AH-0MVM8GQKI006B50M).
 *
 * **TEST-FIRST.** This suite was authored before `src/core/enemyForceField.ts`
 * existed, wrapped in Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts` and AH-0MVLJCYGW001TRB3) to
 * stay green on pre-change HEAD, and **flipped back to `it` by the
 * implementation item (AH-0MVM8GRQ8006HGPK)** once the module landed.
 * A leftover `it.fails` here fails the suite.
 *
 * The module is loaded through a non-literal dynamic import on purpose: a
 * static `import './enemyForceField'` would fail `tsc --noEmit` (and therefore
 * the build) if the module is ever removed again.
 *
 * ## Pinned contract (AH-0MVM8GRQ8006HGPK must match exactly)
 *
 * `src/core/enemyForceField.ts` — Phaser-free, pure, deterministic, no I/O:
 *
 * - `enemyForceFieldHits(level, config)` — the number of force-field hits an
 *   enemy of the supplied archetype carries at campaign `level`:
 *   `clamp(round(lerp(forceFieldStartHits @ forceFieldStartLevel →
 *   forceFieldMaxHits @ 10)), 0, 5)`.
 * - `forceFieldStartLevel` is the first level at which the archetype is
 *   shielded; `0` means **never shielded** (every level resolves to `0`).
 * - Below `forceFieldStartLevel` the field is `0`, so level 1 is untouched for
 *   every shipped archetype.
 * - At `forceFieldStartLevel` the value is exactly `forceFieldStartHits`; at
 *   the campaign maximum (10) it is exactly `forceFieldMaxHits`. In between the
 *   curve is linear and rounded **half up** (`Math.round`), hence monotonically
 *   non-decreasing.
 * - The result is always clamped to `[0, 5]`, whatever the authored
 *   `forceFieldMaxHits` (e.g. `9` never yields more than `5`).
 * - `level` is resolved like `clampLevel` from `src/core/levelScaling.ts`:
 *   fractional levels round first (`Math.round`), `NaN`/non-numeric resolve to
 *   level 1 and `±Infinity` to the campaign ends. Output is never `NaN`.
 * - The supplied config is never mutated.
 *
 * @module core/enemyForceField.test
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ENEMY_CONFIGS } from './enemyConfig';

/** The three `EnemyConfig` fields the resolver reads (declared test-first). */
interface ForceFieldConfig {
  forceFieldStartLevel: number;
  forceFieldStartHits: number;
  forceFieldMaxHits: number;
}

/** The `src/core/enemyForceField.ts` surface this suite pins. */
interface EnemyForceFieldContract {
  enemyForceFieldHits(level: number, config: ForceFieldConfig): number;
}

/**
 * Non-literal specifier so TypeScript does not resolve the (not yet existing)
 * module at type-check time. Vitest still resolves it at runtime.
 */
const ENEMY_FORCE_FIELD_MODULE = './enemyForceField';

/** Loads the module under test; throws (⇒ expected red) on pre-change HEAD. */
async function enemyForceField(): Promise<EnemyForceFieldContract> {
  return (await import(ENEMY_FORCE_FIELD_MODULE)) as EnemyForceFieldContract;
}

/** Builds a force-field config with the supplied three-field curve. */
function curve(
  forceFieldStartLevel: number,
  forceFieldStartHits: number,
  forceFieldMaxHits: number,
): ForceFieldConfig {
  return { forceFieldStartLevel, forceFieldStartHits, forceFieldMaxHits };
}

/** The far end of the campaign — the anchor for `forceFieldMaxHits`. */
const CAMPAIGN_MAX_LEVEL = 10;

/** The documented upper bound on a field's absorbable hits. */
const FORCE_FIELD_HIT_CAP = 5;

describe('enemy force-field resolver (test-first contract, AH-0MVM8GQKI006B50M)', () => {
  // ── Level 1 is untouched (AC1) ────────────────────────────────────

  it('leaves every shipped archetype unshielded at level 1', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    for (const [key, seed] of Object.entries(DEFAULT_ENEMY_CONFIGS)) {
      // The seed spreads to the resolver's three-field view; the archetype's
      // other config fields are irrelevant to the curve.
      const config = seed as unknown as ForceFieldConfig;
      expect(enemyForceFieldHits(1, config), key).toBe(0);
    }
  });

  it('returns zero for every level below the archetype start level', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    for (const startLevel of [2, 3, 5]) {
      const config = curve(startLevel, 2, 5);
      for (let level = 1; level < startLevel; level += 1) {
        expect(
          enemyForceFieldHits(level, config),
          `start level ${startLevel}, level ${level}`,
        ).toBe(0);
      }
    }
  });

  it('treats forceFieldStartLevel 0 as never shielded at any level', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    const config = curve(0, 3, 5);
    for (let level = 1; level <= CAMPAIGN_MAX_LEVEL; level += 1) {
      expect(enemyForceFieldHits(level, config), `level ${level}`).toBe(0);
    }
    expect(enemyForceFieldHits(Number.POSITIVE_INFINITY, config)).toBe(0);
  });

  // ── The two curve anchors ─────────────────────────────────────────

  it('equals forceFieldStartHits exactly at the start level', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    expect(enemyForceFieldHits(3, curve(3, 2, 5))).toBe(2);
    expect(enemyForceFieldHits(2, curve(2, 1, 4))).toBe(1);
    // A start level at the campaign maximum anchors both ends there.
    expect(enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, curve(10, 3, 3))).toBe(3);
  });

  it('reaches forceFieldMaxHits at the campaign maximum level', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    expect(enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, curve(2, 1, 4))).toBe(4);
    expect(enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, curve(4, 2, 5))).toBe(5);
    expect(enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, curve(2, 1, 1))).toBe(1);
  });

  // ── Ramp shape and rounding ───────────────────────────────────────

  it('never decreases field strength between the start level and the maximum', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    const curves = [curve(2, 1, 5), curve(3, 2, 4), curve(2, 1, 1), curve(5, 1, 2)];
    for (const config of curves) {
      const label = `start ${config.forceFieldStartLevel}: ` +
        `${config.forceFieldStartHits} → ${config.forceFieldMaxHits}`;
      let previous = 0;
      for (let level = 1; level <= CAMPAIGN_MAX_LEVEL; level += 1) {
        const hits = enemyForceFieldHits(level, config);
        expect(hits, `${label} at level ${level}`).toBeGreaterThanOrEqual(previous);
        previous = hits;
      }
    }
  });

  it('rounds the interpolated hit count half-up', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    // 1 hit @ L2 → 2 hits @ L10: L6 interpolates to exactly 1.5 → 2,
    // L5 to 1.375 → 1 and L9 to 1.875 → 2.
    const config = curve(2, 1, 2);
    expect(enemyForceFieldHits(5, config)).toBe(1);
    expect(enemyForceFieldHits(6, config)).toBe(2);
    expect(enemyForceFieldHits(9, config)).toBe(2);
  });

  // ── Clamping ──────────────────────────────────────────────────────

  it('clamps field strength to the documented zero-to-five range', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    // An over-authored maximum is capped, never exceeded.
    const overCap = curve(2, 1, 9);
    for (let level = 1; level <= CAMPAIGN_MAX_LEVEL; level += 1) {
      expect(
        enemyForceFieldHits(level, overCap),
        `over-cap config at level ${level}`,
      ).toBeLessThanOrEqual(FORCE_FIELD_HIT_CAP);
    }
    expect(enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, overCap)).toBe(FORCE_FIELD_HIT_CAP);

    // A negative authored start clamps at zero (never a negative field).
    const negative = curve(2, -2, 3);
    for (let level = 1; level <= CAMPAIGN_MAX_LEVEL; level += 1) {
      expect(
        enemyForceFieldHits(level, negative),
        `negative config at level ${level}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Purity and input resolution ───────────────────────────────────

  it('is deterministic and never mutates the supplied config', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    const config = Object.freeze(curve(3, 2, 5));
    const first = enemyForceFieldHits(7, config);
    const second = enemyForceFieldHits(7, config);
    expect(second).toBe(first);
    // A frozen config would throw on a write, and the values are unchanged.
    expect({ ...config }).toEqual(curve(3, 2, 5));
  });

  it('resolves non-finite and non-numeric levels to a campaign end', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    const config = curve(3, 2, 5);
    const levelOne = enemyForceFieldHits(1, config);
    const levelMax = enemyForceFieldHits(CAMPAIGN_MAX_LEVEL, config);
    expect(enemyForceFieldHits(Number.NaN, config)).toBe(levelOne);
    expect(enemyForceFieldHits('abc' as unknown as number, config)).toBe(levelOne);
    expect(enemyForceFieldHits(Number.NEGATIVE_INFINITY, config)).toBe(levelOne);
    expect(enemyForceFieldHits(Number.POSITIVE_INFINITY, config)).toBe(levelMax);
    // Never NaN, whatever the caller passes.
    expect(Number.isFinite(levelMax)).toBe(true);
  });

  it('rounds a fractional level before evaluating the curve', async () => {
    const { enemyForceFieldHits } = await enemyForceField();
    const config = curve(3, 1, 5);
    expect(enemyForceFieldHits(5.4, config)).toBe(enemyForceFieldHits(5, config));
    expect(enemyForceFieldHits(5.5, config)).toBe(enemyForceFieldHits(6, config));
    // 1.4 rounds down to the untouched level 1.
    expect(enemyForceFieldHits(1.4, config)).toBe(0);
  });
});
