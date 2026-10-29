/**
 * Docs guard for the resumed-hold semantics (parent AH-0MVSSSFXK005ZW8O,
 * AC5; docs item AH-0MVT1E0SZ0030Q8Z).
 *
 * Continue restores the checkpoint's hold capacity **first**, then clamps the
 * saved mineral count into `[0, capacity]` and clears overflow. That is a
 * deliberate, chosen semantic — a saved surplus is discarded rather than
 * carried into the next hold — so it must be discoverable by producers and
 * agents and must not silently regress into the reported double hold-full.
 *
 * Like the sibling `powerUpSlotsDocs.test.ts` and friends, this is a
 * deliberate docs grep: it asserts the canonical documentation (the AC), not
 * runtime behaviour. Runtime behaviour is covered by the sibling regression
 * and restore-seam tests; the cross-checks below pin the doc prose to the
 * shipped constants, schema version and restore seam so the two cannot drift.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CHECKPOINT_VERSION, parseCheckpoint } from './core/checkpointStore';
import { MineralHold } from './core/mineralHold';
import { DEFAULT_MINERAL_HOLD_CAPACITY } from './core/rules';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/** The GDD §4.4.1 hold section (up to §4.4.2). */
function holdSection(gdd: string): string {
  const start = gdd.indexOf('#### 4.4.1 Minerals, the Ship');
  expect(start, 'the GDD has the §4.4.1 hold section').toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.2', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

/** The `ai_hell_checkpoint` row of the §6.6 save-data table. */
function checkpointRow(gdd: string): string {
  const start = gdd.indexOf('| `ai_hell_checkpoint` |');
  expect(start, 'the GDD §6.6 has an ai_hell_checkpoint row').toBeGreaterThan(-1);
  const end = gdd.indexOf('\n', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

describe('the resumed-hold semantics are documented (AH-0MVT1E0SZ0030Q8Z)', () => {
  const gdd = read(GDD_PATH);

  it('§4.4.1 states that Continue restores the capacity first and then clamps the store', () => {
    const section = holdSection(gdd);
    expect(section).toMatch(/On Continue/i);
    expect(section).toMatch(/capacity is restored \*\*first\*\*/i);
    expect(section).toMatch(/clamp(ed|s)? into `\[0, capacity\]`/i);
    expect(section).toMatch(/overflow cleared|overflow[^.]*clear/i);
  });

  it('§4.4.1 states the restored hold is never over-capacity and the next choice needs a refill', () => {
    const section = holdSection(gdd);
    expect(section).toMatch(/never over-capacity/i);
    expect(section).toMatch(
      /next hold-full choice arrives only once the \*\*restored\*\* hold has actually been filled/i,
    );
    expect(section).toMatch(/HUD bar never exceeds 100%/i);
  });

  it('§4.4.1 states the legacy checkpoint default (first-hold capacity, still clamped)', () => {
    const section = holdSection(gdd);
    expect(section).toMatch(/legacy checkpoint/i);
    expect(section).toMatch(/resumes at the first-hold capacity/i);
    expect(section).toMatch(/over-capacity minerals are still clamped/i);
  });

  it('§4.4.1 names the shared restore seam the prose describes', () => {
    const section = holdSection(gdd);
    expect(section).toContain('MineralHold.restore');
    expect(section).toContain('GameState.restoreHold');
    expect(section).toContain('PlayScene._restoreCheckpoint()');
  });

  it('§6.6 lists the persisted hold capacity alongside the saved minerals', () => {
    const row = checkpointRow(gdd);
    expect(row).toMatch(/lives, score, minerals, the \*\*ship's hold capacity\*\*/i);
  });

  it('§6.6 records the schema bump and the legacy v1 default', () => {
    const row = checkpointRow(gdd);
    expect(row).toMatch(/schema \*\*v2\*\*/i);
    expect(row).toMatch(/legacy v1/i);
    expect(row).toMatch(/no capacity field and resumes at the first-hold capacity/i);
    expect(row).toMatch(/clamps the saved mineral count into `\[0, capacity\]`/i);
  });

  it('the documented schema version is the shipped constant', () => {
    expect(CHECKPOINT_VERSION).toBe(2);
    expect(checkpointRow(gdd)).toContain(`schema **v${CHECKPOINT_VERSION}**`);
  });

  it('the documented legacy default is the shipped first-hold capacity', () => {
    // A legacy payload without the capacity field resumes at the canonical
    // first-hold capacity — pin the prose to the constant, not a literal.
    expect(DEFAULT_MINERAL_HOLD_CAPACITY).toBe(5);
    const legacy = parseCheckpoint({ level: 2, wave: 1, lives: 3, score: 0, minerals: 20 });
    expect(legacy?.mineralHoldCapacity).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(holdSection(gdd)).toContain('first-hold capacity');
  });

  it('the documented restore behaviour matches the shared hold model', () => {
    // Legacy checkpoint: no capacity, an over-capacity saved count.
    const legacyHold = new MineralHold({ capacity: DEFAULT_MINERAL_HOLD_CAPACITY });
    legacyHold.restore({ store: 20 });
    expect(legacyHold.store).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(legacyHold.overflow).toBe(0);

    // Resumed checkpoint: the earned capacity is applied first, then the store
    // is clamped into it — capacity is not re-derived from the saved count.
    const resumed = new MineralHold({ capacity: DEFAULT_MINERAL_HOLD_CAPACITY });
    resumed.restore({ capacity: 40, store: 20 });
    expect(resumed.capacity).toBe(40);
    expect(resumed.store).toBe(20);
    expect(resumed.overflow).toBe(0);
    expect(resumed.isFull).toBe(false);
  });
});
