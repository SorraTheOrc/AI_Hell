/**
 * Unit tests for the dev-gated recorder scenarios (AH-0MUWZ5HCV0034H44).
 *
 * The parser is pure: it turns a URL search string into the scenario the game
 * should apply (or `null`). These tests pin the supported encodings, the hit
 * clamping and the no-op behaviour for absent/unknown scenarios, without
 * booting Phaser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEV_BOSS_DEFAULT_HITS,
  DEV_SCENARIO_BOSS,
  clearDevScenarioHandle,
  installDevScenarioHandle,
  resolveDevScenario,
} from './devScenario';

afterEach(() => {
  vi.unstubAllEnvs();
  clearDevScenarioHandle();
});

describe('resolveDevScenario', () => {
  it('resolves the recorded four-hit boss scenario', () => {
    expect(resolveDevScenario('?scenario=boss-four-hits')).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
  });

  it('accepts a search string without a leading question mark', () => {
    expect(resolveDevScenario('scenario=boss-four-hits')).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
  });

  it('defaults the tunable boss scenario to four hits', () => {
    expect(resolveDevScenario('?scenario=boss')).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
  });

  it('honours a bossHits override', () => {
    expect(resolveDevScenario('?scenario=boss&bossHits=12')).toEqual({
      kind: 'boss',
      bossHitsRemaining: 12,
    });
  });

  it('floors a fractional hit count', () => {
    expect(resolveDevScenario('?scenario=boss&bossHits=3.9')?.bossHitsRemaining).toBe(3);
  });

  it('clamps a non-positive hit count to one', () => {
    expect(resolveDevScenario('?scenario=boss&bossHits=0')?.bossHitsRemaining).toBe(1);
    expect(resolveDevScenario('?scenario=boss&bossHits=-40')?.bossHitsRemaining).toBe(1);
  });

  it('falls back to the default for a non-numeric hit count', () => {
    expect(
      resolveDevScenario('?scenario=boss&bossHits=soon')?.bossHitsRemaining,
    ).toBe(DEV_BOSS_DEFAULT_HITS);
  });

  it('is case- and whitespace-insensitive on the scenario name', () => {
    expect(resolveDevScenario('?scenario=BOSS')).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
    expect(resolveDevScenario('?scenario=%20boss-four-hits%20')?.kind).toBe('boss');
  });

  it('returns null when no scenario is requested', () => {
    expect(resolveDevScenario('')).toBeNull();
    expect(resolveDevScenario('?')).toBeNull();
    expect(resolveDevScenario('?foo=bar')).toBeNull();
  });

  it('returns null for an unknown scenario (a typo never changes a normal run)', () => {
    expect(resolveDevScenario('?scenario=nope')).toBeNull();
    expect(resolveDevScenario('?scenario=')).toBeNull();
  });

  it('does not confuse a different parameter carrying the same value', () => {
    expect(resolveDevScenario(`?other=${DEV_SCENARIO_BOSS}`)).toBeNull();
  });
});

describe('dev scenario handle', () => {
  it('installs and clears the page-side release handle in a dev build', () => {
    let resumed = 0;
    installDevScenarioHandle({
      hitsRemaining: 4,
      resume: () => {
        resumed += 1;
      },
    });

    expect(window.__aiHellScenario?.hitsRemaining).toBe(4);
    window.__aiHellScenario?.resume();
    expect(resumed).toBe(1);

    clearDevScenarioHandle();
    expect(window.__aiHellScenario).toBeUndefined();
  });

  it('never writes the global in a production build', () => {
    vi.stubEnv('DEV', false);
    installDevScenarioHandle({ hitsRemaining: 4, resume: () => undefined });
    expect(window.__aiHellScenario).toBeUndefined();
  });
});
