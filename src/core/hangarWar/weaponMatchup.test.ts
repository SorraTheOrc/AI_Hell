/**
 * Weapon-vs-boss display matchup tests (AH-0MWMT4NJV001PX8Y).
 *
 * The resolver answers the **display** question — "is this weapon strong,
 * weak or neutral against this hex's boss?" — for the pre-battle config
 * screen. It is pure and total: it never throws, and it normalises the
 * ring/catalogue spelling through the shared capture-cycle alias, so a
 * catalogue weapon and an authored boss list can never disagree.
 *
 * The rule is player-centric (parent assumption A2): a weapon the boss is
 * **weak** against counters it (`strong`); a weapon the boss is **strong**
 * against is resisted (`weak`). The authored data below is the real ring table
 * where a test pins the alias, so a change in the shipped spellings fails
 * here.
 */

import { describe, expect, it } from 'vitest';

import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { HexRingDefinition } from './hexRing';
import { resolveBossMatchup } from './weaponMatchup';

/** Only the two authored lists the resolver reads (a hex definition stand-in). */
type AuthoredLists = Pick<HexRingDefinition, 'strengths' | 'weaknesses'>;

/** A minimal authored definition: the boss's strengths and weaknesses. */
function authored(
  strengths: readonly string[],
  weaknesses: readonly string[],
): AuthoredLists {
  return { strengths, weaknesses };
}

/** The shipped hex whose authored weaknesses list spells the laser `waveLaser`. */
function aliasHex(): HexRingDefinition {
  const hex = HEX_RING_DEFINITIONS.find((candidate) =>
    candidate.weaknesses.includes('waveLaser'),
  );
  if (hex === undefined) {
    throw new Error('expected an authored hex weak to `waveLaser`');
  }
  return hex;
}

describe('resolveBossMatchup', () => {
  it('marks a weapon the boss is weak against as strong', () => {
    expect(
      resolveBossMatchup('nova', authored(['cannon'], ['nova', 'arc'])),
    ).toBe('strong');
  });

  it('marks a weapon the boss is strong against as weak', () => {
    expect(
      resolveBossMatchup('cannon', authored(['cannon', 'dual'], ['nova'])),
    ).toBe('weak');
  });

  it('marks any other weapon as neutral', () => {
    expect(
      resolveBossMatchup('spread', authored(['cannon'], ['nova'])),
    ).toBe('neutral');
  });

  it('normalises the ring spelling against a catalogue weapon id', () => {
    // The catalogue spells the weapon `wave_laser`; the boss list `waveLaser`.
    expect(
      resolveBossMatchup('wave_laser', authored([], ['waveLaser'])),
    ).toBe('strong');
  });

  it('normalises a ring-spelled weapon against a catalogue-spelled list', () => {
    expect(
      resolveBossMatchup('waveLaser', authored([], ['wave_laser'])),
    ).toBe('strong');
  });

  it('normalises the alias in both directions for a resisted weapon', () => {
    expect(resolveBossMatchup('waveLaser', authored(['wave_laser'], []))).toBe(
      'weak',
    );
  });

  it('resolves a real authored hex through the shared alias', () => {
    // The shipped ring data is the source of truth for the spelling: a
    // catalogue id must match it without a second alias table.
    expect(resolveBossMatchup('wave_laser', aliasHex())).toBe('strong');
    expect(resolveBossMatchup('waveLaser', aliasHex())).toBe('strong');
  });

  it('prefers strong when a weapon appears in both authored lists', () => {
    // Documented tie-break (item notes): the weakness/`strong` verdict wins.
    expect(
      resolveBossMatchup('nova', authored(['nova'], ['nova'])),
    ).toBe('strong');
  });

  it('returns neutral for an unknown weapon id', () => {
    expect(
      resolveBossMatchup('not-a-weapon', authored(['cannon'], ['nova'])),
    ).toBe('neutral');
  });

  it('returns neutral for null, undefined or blank weapon ids', () => {
    const hex = authored(['cannon'], ['nova']);
    expect(resolveBossMatchup(null, hex)).toBe('neutral');
    expect(resolveBossMatchup(undefined, hex)).toBe('neutral');
    expect(resolveBossMatchup('   ', hex)).toBe('neutral');
  });

  it('returns neutral for an unauthored or unknown hex definition', () => {
    expect(resolveBossMatchup('nova', undefined)).toBe('neutral');
    expect(resolveBossMatchup('nova', null)).toBe('neutral');
    expect(
      resolveBossMatchup('nova', {} as unknown as AuthoredLists),
    ).toBe('neutral');
    expect(
      resolveBossMatchup('nova', {
        strengths: 'nova',
        weaknesses: 42,
      } as unknown as AuthoredLists),
    ).toBe('neutral');
  });
});
