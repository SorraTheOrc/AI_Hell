/**
 * Docs guard for the shared six-slot cap (parent AH-0MVLIJT3M005HPHF, AC7;
 * docs item AH-0MVNT31C50065EE0).
 *
 * The cap and its per-entry exemption flag must be discoverable by producers
 * and agents, and the shared-pool consequence (a weapon-heavy build can take
 * the pool before any power-up reward) must be recorded as *chosen* semantics
 * so it is never mistaken for a bug. This guard fails if that documentation is
 * removed or weakened, and cross-checks the documented exemptions against the
 * live catalogue so the prose cannot silently drift from the code.
 *
 * Like the sibling `powerUpLevelingDocs.test.ts` and
 * `choiceWeightingDocs.test.ts`, this is a deliberate docs grep: it asserts
 * the canonical documentation (the AC), not runtime behaviour. Runtime
 * accounting is covered by `src/powerups/slots.test.ts` and friends.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { POWER_UP_SLOT_CAP } from './core/constants';
import { SLOTS_FULL_EXEMPT_IDS } from './powerups/slots';
import { POWER_UP_CATALOGUE } from './powerups/types';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const BALANCING_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/** The GDD section that documents the cap (`§4.4` → before `§4.4.1`). */
function slotsSection(gdd: string): string {
  const start = gdd.indexOf('#### Permanent loadout slots');
  expect(start, 'the GDD has a "Permanent loadout slots" subsection').toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.1', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

/** The GDD §4.4.1 hold-full choice section (up to §4.4.2). */
function holdFullChoiceSection(gdd: string): string {
  const start = gdd.indexOf('#### 4.4.1 Minerals, the Ship');
  expect(start, 'the GDD has the §4.4.1 hold-full choice section').toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.2', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

/** The BALANCING section that records the cap (`### The six permanent loadout slots`). */
function balancingSection(balancing: string): string {
  const start = balancing.indexOf('### The six permanent loadout slots');
  expect(start, 'docs/BALANCING.md has a six permanent loadout slots section').toBeGreaterThan(-1);
  const end = balancing.indexOf('\n### ', start + 1);
  return balancing.slice(start, end === -1 ? undefined : end);
}

describe('the six-slot cap and exemption flag are documented (AH-0MVNT31C50065EE0)', () => {
  const gdd = read(GDD_PATH);
  const balancing = read(BALANCING_PATH);

  it('the documented cap is the shipped named constant', () => {
    // The cap is a named constant, not a magic number copied into prose.
    expect(POWER_UP_SLOT_CAP).toBe(6);
    expect(slotsSection(gdd)).toMatch(/POWER_UP_SLOT_CAP\s*=\s*6/);
    expect(slotsSection(gdd)).toContain('src/core/constants.ts');
  });

  it('the GDD records that the six slots are one pool shared by power-ups and weapons', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/shared/i);
    expect(section).toMatch(/power-up and weapon|weapon and power-up|power-up\*? and \*?weapon/i);
    expect(section).toMatch(/first six\s+distinct kinds|six distinct/i);
  });

  it('the GDD records that slots are derived from the existing permanent-grant stores (no new counter)', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/derived/i);
    expect(section).toContain('PowerUpLevelStore.getLevels()');
    expect(section).toContain('Player.getWeaponLevels()');
    expect(section).toMatch(/no second\s+slot\s+counter|no (second |new )?slot counter/i);
  });

  it('the GDD records that field pickups never consume a slot', () => {
    expect(slotsSection(gdd)).toMatch(/field pickups? never consume|never consumes? a slot/i);
  });

  it('the GDD records that the permanent cannon and reset are never counted', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/cannon/i);
    expect(section).toMatch(/reset/i);
    expect(section).toMatch(/never count|not counted|never granted/i);
  });

  it('the GDD documents availableWhenSlotsFull as a per-entry catalogue flag defaulting to false', () => {
    const section = slotsSection(gdd);
    expect(section).toContain('availableWhenSlotsFull');
    expect(section).toMatch(/default(s)? to `false`|default `false`|defaults to \*\*`false`\*\*|default \*\*`false`\*\*/);
    expect(section).toMatch(/per-entry|on the (power-up )?catalogue entry|PowerUpEntry/);
    expect(section).toMatch(/no `id === '…'`|data change|no special case/i);
  });

  it('the GDD names every catalogue entry that is exempt when the slots are full', () => {
    const section = slotsSection(gdd);
    // Cross-check the prose against the live catalogue: every flagged entry
    // must be named, so adding or removing a flag forces a docs update.
    expect(SLOTS_FULL_EXEMPT_IDS.length).toBeGreaterThan(0);
    for (const id of SLOTS_FULL_EXEMPT_IDS) {
      expect(section, `${id} is exempt but not documented`).toContain(
        POWER_UP_CATALOGUE[id].name,
      );
    }
  });

  it('the GDD §4.4.1 gates the hold-full choice at six filled slots', () => {
    const section = holdFullChoiceSection(gdd);
    expect(section).toMatch(/level-ups? of owned|owned (items?|kinds)/i);
    expect(section).toMatch(/availableWhenSlotsFull/);
    expect(section).toMatch(/seventh/i);
    expect(section).toMatch(/mini-boss/i);
    // The gate lives once in the shared builder, not in a scene.
    expect(section).toContain('buildChoiceCandidates');
  });

  it('the GDD records the parity note: the game and the gyms consume the same gate', () => {
    const section = slotsSection(gdd);
    expect(section).toContain('src/powerups/slots.ts');
    expect(section).toContain('drawNextDrop');
    expect(section).toMatch(/PlayScene/);
    expect(section).toMatch(/gym/i);
    expect(section).toMatch(/parity/i);
  });

  it('docs/BALANCING.md records the cap as the demand-side balance lever', () => {
    const section = balancingSection(balancing);
    expect(section).toContain('POWER_UP_SLOT_CAP');
    // Paired with the supply reduction it complements.
    expect(section).toContain('AH-0MVHT1M6O003PU7P');
    expect(section).toMatch(/supply/i);
    expect(section).toMatch(/demand/i);
  });

  it('docs/BALANCING.md records the shared-pool starvation consequence as intended (Q1 answer (c))', () => {
    const section = balancingSection(balancing);
    expect(section).toMatch(/weapon-heavy|weapon-first|weapon build/i);
    expect(section).toMatch(/starv|occupy|consum(e|ing) the pool/i);
    expect(section).toMatch(/intended|chosen|by design|not a bug/i);
    expect(section).toMatch(/Q1/);
    // The producer's answer: field pickups are excluded from the shared pool.
    expect(section).toMatch(/\(c\)|answer \(c\)|field pickups? are excluded/i);
  });
});
