/**
 * Wave-announcement naming tests for the elite
 * (AH-0MWU666IS008JOR3 AC6; folded test child AH-0MWU65X6C007JBTL).
 *
 * The opening cue must name the elite so the player can prioritise it, and an
 * elite-free wave must keep today's label byte-for-byte. These tests drive the
 * pure composer with a stub archetype resolver, so they do not depend on the
 * CSV-backed store.
 */

import { describe, expect, it } from 'vitest';

import type { EnemyConfig } from '../core/configTypes';
import {
  ELITE_ANNOUNCEMENT_MARKER,
  ELITE_ANNOUNCEMENT_SEPARATOR,
  composeWaveAnnouncement,
  resolveEliteWaveAnnouncement,
} from './eliteAnnounce';

/** Minimal config stub for the announcement resolver. */
function config(
  key: string,
  displayName: string,
  eliteBehaviour?: EnemyConfig['eliteBehaviour'],
): EnemyConfig {
  return { key, displayName, eliteBehaviour } as EnemyConfig;
}

describe('resolveEliteWaveAnnouncement', () => {
  it('returns null for a wave with no elite spawn', () => {
    expect(
      resolveEliteWaveAnnouncement([
        { enemyKey: 'scout' },
        { enemyKey: 'diver' },
      ]),
    ).toBeNull();
  });

  it('names the flagged spawn with its archetype and bounded behaviour', () => {
    const announcement = resolveEliteWaveAnnouncement(
      [{ enemyKey: 'scout', elite: true }],
      () => config('scout', 'Scout', 'splitter'),
    );
    expect(announcement).not.toBeNull();
    expect(announcement!.enemyKey).toBe('scout');
    expect(announcement!.displayName).toBe('Scout');
    expect(announcement!.behaviour).toBe('splitter');
    expect(announcement!.label).toBe(
      `${ELITE_ANNOUNCEMENT_MARKER} Scout (splitter)`,
    );
  });

  it('names only the elite, never an ordinary spawn of the same archetype', () => {
    const announcement = resolveEliteWaveAnnouncement(
      [{ enemyKey: 'scout' }, { enemyKey: 'scout', elite: true }],
      () => config('scout', 'Scout', 'volatile'),
    );
    expect(announcement!.enemyKey).toBe('scout');
    expect(announcement!.behaviour).toBe('volatile');
  });

  it('falls back to the archetype key when the display name is blank', () => {
    const announcement = resolveEliteWaveAnnouncement(
      [{ enemyKey: 'scout', elite: true }],
      () => config('scout', '   ', 'reinforced'),
    );
    expect(announcement!.displayName).toBe('scout');
  });

  it('returns null when the flagged archetype has no elite behaviour', () => {
    expect(
      resolveEliteWaveAnnouncement(
        [{ enemyKey: 'scout', elite: true }],
        () => config('scout', 'Scout'),
      ),
    ).toBeNull();
  });

  it('is independent of spawn order', () => {
    const spawns = [
      { enemyKey: 'diver' },
      { enemyKey: 'scout', elite: true },
    ];
    const forward = resolveEliteWaveAnnouncement(spawns, () =>
      config('scout', 'Scout', 'splitter'),
    );
    const reversed = resolveEliteWaveAnnouncement(
      [...spawns].reverse(),
      () => config('scout', 'Scout', 'splitter'),
    );
    expect(forward).toEqual(reversed);
  });
});

describe('composeWaveAnnouncement', () => {
  it('returns the base label unchanged for an elite-free wave', () => {
    const base = 'Level 2: The Belt, Wave: 1 of 2';
    expect(composeWaveAnnouncement(base, null)).toBe(base);
  });

  it('appends the elite phrase after the progress label', () => {
    const base = 'Level 2: The Belt, Wave: 1 of 2';
    const announcement = resolveEliteWaveAnnouncement(
      [{ enemyKey: 'scout', elite: true }],
      () => config('scout', 'Scout', 'splitter'),
    );
    expect(composeWaveAnnouncement(base, announcement)).toBe(
      `${base}${ELITE_ANNOUNCEMENT_SEPARATOR}${ELITE_ANNOUNCEMENT_MARKER} Scout (splitter)`,
    );
  });
});
