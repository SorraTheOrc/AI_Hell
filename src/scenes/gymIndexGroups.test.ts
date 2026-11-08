/**
 * Unit tests for the pure Gym Index grouping helpers
 * (AH-0MW6OIQAA001YVGA, AC2/AC5/AC1).
 *
 * These are pure-function tests (no Phaser boot): they cover the ordered
 * category map and its **Other** fallback, totality over the discovered plain
 * scenes, the flat-vs-grouped column decision (column-agnostic, so a future
 * oversized column groups automatically) and the vertical fit maths.
 */
import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT } from '../core/constants';
import {
  GYM_INDEX_GROUP_DEFINITIONS,
  GYM_INDEX_OTHER_GROUP_ID,
  GYM_INDEX_OTHER_GROUP_TITLE,
  GYM_INDEX_ROW_BOTTOM_Y,
  GYM_INDEX_ROW_HEIGHT,
  GYM_INDEX_ROW_MIN_PITCH,
  GYM_INDEX_ROW_START_Y,
  GYM_INDEX_MAX_FLAT_ROWS,
  GYM_INDEX_SCENE_GROUP,
  GymIndexGroupMember,
  buildColumnRows,
  columnRowPitch,
  columnRowY,
  groupGymScenes,
  groupHeaderLabel,
  groupIdForScene,
} from './gymIndexGroups';

/** The 16 plain scenes discovered today, alphabetically by label (as discovery returns them). */
const DISCOVERED_KEYS = [
  'GymAsteroidStress',
  'GymBotTuning',
  'GymHangar',
  'GymHexWar',
  'GymLevel',
  'GymMinerals',
  'GymPerformance',
  'GymPlayer',
  'GymPowerUpLeveling',
  'GymPowerUpsCombat',
  'GymPowerUpsUtility',
  'GymRechargeTuning',
  'GymRhythm',
  'GymWeaponLeveling',
  'GymWeapons',
  'GymWeaponTuning',
];

/** Synthetic discovered entries: labels are the scene key with `Gym` stripped. */
function discoveredEntries(keys: readonly string[] = DISCOVERED_KEYS): GymIndexGroupMember[] {
  return [...keys]
    .map((key) => ({ key, label: key.replace(/^Gym/, '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

describe('gymIndexGroups — category map (AC2)', () => {
  it('maps every known plain gym scene exactly once, by scene key', () => {
    const mappedKeys = GYM_INDEX_GROUP_DEFINITIONS.flatMap((g) => [...g.keys]);

    expect(mappedKeys).toHaveLength(DISCOVERED_KEYS.length);
    expect(new Set(mappedKeys).size).toBe(mappedKeys.length);
    expect([...mappedKeys].sort()).toEqual([...DISCOVERED_KEYS].sort());

    // The exported key → group map mirrors the definitions.
    for (const definition of GYM_INDEX_GROUP_DEFINITIONS) {
      for (const key of definition.keys) {
        expect(GYM_INDEX_SCENE_GROUP[key]).toBe(definition.id);
      }
    }
  });

  it('orders groups per the documented category order', () => {
    expect(GYM_INDEX_GROUP_DEFINITIONS.map((g) => g.title)).toEqual([
      'Player & Combat',
      'Worlds',
      'Power-ups',
      'Weapons',
      'Tuning',
      'Minerals',
    ]);
  });

  it('assigns each scene to its documented group', () => {
    expect(groupIdForScene('GymPlayer')).toBe('playerAndCombat');
    expect(groupIdForScene('GymRhythm')).toBe('playerAndCombat');
    expect(groupIdForScene('GymPerformance')).toBe('playerAndCombat');
    expect(groupIdForScene('GymAsteroidStress')).toBe('playerAndCombat');
    expect(groupIdForScene('GymLevel')).toBe('worlds');
    expect(groupIdForScene('GymHexWar')).toBe('worlds');
    expect(groupIdForScene('GymHangar')).toBe('worlds');
    expect(groupIdForScene('GymPowerUpLeveling')).toBe('powerUps');
    expect(groupIdForScene('GymPowerUpsCombat')).toBe('powerUps');
    expect(groupIdForScene('GymPowerUpsUtility')).toBe('powerUps');
    expect(groupIdForScene('GymWeapons')).toBe('weapons');
    expect(groupIdForScene('GymWeaponLeveling')).toBe('weapons');
    expect(groupIdForScene('GymWeaponTuning')).toBe('weapons');
    expect(groupIdForScene('GymBotTuning')).toBe('tuning');
    expect(groupIdForScene('GymRechargeTuning')).toBe('tuning');
    expect(groupIdForScene('GymMinerals')).toBe('minerals');
  });

  it('falls back to Other for a scene the map does not know', () => {
    expect(groupIdForScene('GymBrandNew')).toBe(GYM_INDEX_OTHER_GROUP_ID);
  });
});

describe('gymIndexGroups — grouping (AC2)', () => {
  it('groups every discovered scene into exactly one group, in category order', () => {
    const entries = discoveredEntries();
    const groups = groupGymScenes(entries);

    expect(groups.map((g) => g.title)).toEqual([
      'Player & Combat',
      'Worlds',
      'Power-ups',
      'Weapons',
      'Tuning',
      'Minerals',
    ]);

    const groupedKeys = groups.flatMap((g) => g.members.map((m) => m.key));
    expect(groupedKeys).toHaveLength(entries.length);
    expect([...groupedKeys].sort()).toEqual([...DISCOVERED_KEYS].sort());
    // Totality: no entry appears twice.
    expect(new Set(groupedKeys).size).toBe(entries.length);
  });

  it('keeps the discovered (alphabetical) order inside a group', () => {
    const groups = groupGymScenes(discoveredEntries());
    const playerAndCombat = groups.find((g) => g.id === 'playerAndCombat');

    expect(playerAndCombat?.members.map((m) => m.label)).toEqual([
      'AsteroidStress',
      'Performance',
      'Player',
      'Rhythm',
    ]);
  });

  it('renders Other last for unmapped scenes', () => {
    const groups = groupGymScenes([...discoveredEntries(), { key: 'GymBrandNew', label: 'BrandNew' }]);

    expect(groups.map((g) => g.title)).toEqual([
      'Player & Combat',
      'Worlds',
      'Power-ups',
      'Weapons',
      'Tuning',
      'Minerals',
      GYM_INDEX_OTHER_GROUP_TITLE,
    ]);
    expect(groups[groups.length - 1].members.map((m) => m.key)).toEqual(['GymBrandNew']);
  });

  it('omits empty groups so no header floats alone', () => {
    const groups = groupGymScenes([{ key: 'GymMinerals', label: 'Minerals' }]);

    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('minerals');
  });
});

describe('gymIndexGroups — column rows (AC3/AC5)', () => {
  it('renders a short column flat, with no group headers', () => {
    const entries = [
      { key: 'GymFodderEnemies', label: 'Fodder Enemies' },
      { key: 'GymBoss', label: 'Boss' },
      { key: 'GymMiniBoss', label: 'Mini-Boss' },
    ];
    const { grouped, rows } = buildColumnRows(entries);

    expect(grouped).toBe(false);
    expect(rows.map((r) => r.kind)).toEqual(['member', 'member', 'member']);
    expect(rows.map((r) => r.label)).toEqual(['Fodder Enemies', 'Boss', 'Mini-Boss']);
    expect(rows.every((r) => r.sceneKey !== undefined)).toBe(true);
  });

  it('groups a column that outgrows the screen (column-agnostic, AC5)', () => {
    // An oversized synthetic column: every row would overflow the band, so the
    // shared helper switches to headers without the caller knowing why.
    const oversized: GymIndexGroupMember[] = Array.from({ length: 20 }, (_, i) => ({
      key: `GymSynthetic${i}`,
      label: `Synthetic${i}`,
    }));
    const { grouped, rows } = buildColumnRows(oversized);

    expect(GYM_INDEX_MAX_FLAT_ROWS).toBeLessThan(oversized.length);
    expect(grouped).toBe(true);
    expect(rows.filter((r) => r.kind === 'header')).toHaveLength(1);
    expect(rows[0].groupId).toBe(GYM_INDEX_OTHER_GROUP_ID);
  });

  it('emits one collapsed header per group and no members when nothing is expanded', () => {
    const { grouped, rows } = buildColumnRows(discoveredEntries());

    expect(grouped).toBe(true);
    expect(rows.map((r) => r.kind)).toEqual(Array(6).fill('header'));
    expect(rows.map((r) => r.label)).toEqual([
      groupHeaderLabel('Player & Combat', false),
      groupHeaderLabel('Worlds', false),
      groupHeaderLabel('Power-ups', false),
      groupHeaderLabel('Weapons', false),
      groupHeaderLabel('Tuning', false),
      groupHeaderLabel('Minerals', false),
    ]);
    expect(rows.every((r) => r.expanded === false)).toBe(true);
  });

  it('reveals the expanded group members directly below its header (accordion)', () => {
    const { rows } = buildColumnRows(discoveredEntries(), { expandedGroupId: 'worlds' });

    expect(rows.map((r) => `${r.kind}:${r.label}`)).toEqual([
      `header:${groupHeaderLabel('Player & Combat', false)}`,
      `header:${groupHeaderLabel('Worlds', true)}`,
      'member:Hangar',
      'member:HexWar',
      'member:Level',
      `header:${groupHeaderLabel('Power-ups', false)}`,
      `header:${groupHeaderLabel('Weapons', false)}`,
      `header:${groupHeaderLabel('Tuning', false)}`,
      `header:${groupHeaderLabel('Minerals', false)}`,
    ]);
    expect(rows.filter((r) => r.kind === 'member').every((r) => r.groupId === 'worlds')).toBe(true);
  });

  it('never emits members of a collapsed group (single expanded group only)', () => {
    const { rows } = buildColumnRows(discoveredEntries(), { expandedGroupId: 'minerals' });
    const members = rows.filter((r) => r.kind === 'member');

    expect(members.map((r) => r.label)).toEqual(['Minerals']);
    expect(members.every((r) => r.groupId === 'minerals')).toBe(true);
  });

  it('honours an explicit flat capacity override', () => {
    const entries = discoveredEntries().slice(0, 4);

    expect(buildColumnRows(entries, { maxFlatRows: 4 }).grouped).toBe(false);
    expect(buildColumnRows(entries, { maxFlatRows: 3 }).grouped).toBe(true);
  });
});

describe('gymIndexGroups — vertical fit (AC1)', () => {
  it('keeps every row of a maximally filled column inside the title-to-hint band', () => {
    const rowCount = GYM_INDEX_MAX_FLAT_ROWS;
    const halfRow = GYM_INDEX_ROW_HEIGHT / 2;
    const hintTop = GAME_HEIGHT - 16 - 7; // hint centre y=524, ~14 px tall

    for (let index = 0; index < rowCount; index++) {
      const y = columnRowY(index, rowCount);
      expect(y - halfRow).toBeGreaterThanOrEqual(0);
      expect(y + halfRow).toBeLessThanOrEqual(hintTop);
      expect(y).toBeLessThanOrEqual(GYM_INDEX_ROW_BOTTOM_Y);
    }
    expect(columnRowY(0, rowCount)).toBe(GYM_INDEX_ROW_START_Y);
  });

  it('never overlaps neighbouring rows', () => {
    for (let rowCount = 1; rowCount <= GYM_INDEX_MAX_FLAT_ROWS; rowCount++) {
      const pitch = columnRowPitch(rowCount);
      expect(pitch).toBeGreaterThanOrEqual(GYM_INDEX_ROW_MIN_PITCH);
      expect(pitch).toBeGreaterThanOrEqual(GYM_INDEX_ROW_HEIGHT);
    }
  });

  it('uses the preferred pitch for a short column and centres nothing off-screen', () => {
    expect(columnRowPitch(1)).toBe(columnRowPitch(2));
    expect(columnRowY(0, 1)).toBe(GYM_INDEX_ROW_START_Y);
    expect(columnRowY(2, 3) - columnRowY(1, 3)).toBe(columnRowPitch(3));
  });

  it('fits the largest expanded group (6 headers + 4 members) inside the band', () => {
    const { rows } = buildColumnRows(discoveredEntries(), { expandedGroupId: 'playerAndCombat' });
    expect(rows).toHaveLength(10);

    const halfRow = GYM_INDEX_ROW_HEIGHT / 2;
    const hintTop = GAME_HEIGHT - 16 - 7;
    const lastY = columnRowY(rows.length - 1, rows.length);
    expect(lastY + halfRow).toBeLessThanOrEqual(hintTop);
  });
});
