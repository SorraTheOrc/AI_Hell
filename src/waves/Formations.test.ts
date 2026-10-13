/**
 * WaveGroup spawn-range fields (AH-0MUKCLXLW0032R67, child
 * AH-0MUKI94IK009UZL2).
 *
 * The range fields are optional per-group overrides of the enemy archetype's
 * configured spawn range. These tests lock in backward compatibility: the
 * built-in campaign omits them (WG3) and adding them never perturbs the
 * declared/planned spawn accounting.
 */

import { describe, it, expect } from 'vitest';

import { LEVELS, LEVEL_COUNT, enemyCountForLevel, getLevelDefinition } from './Formations';
import type { LevelDefinition, WaveDefinition, WaveGroup } from './Formations';
import { STRIKE_SPAWN_START_WAVE } from './StrikeSpawner';
import { validateWaveGroups, wavePlannedSpawnCount } from './WaveManager';

describe('WaveGroup spawn-range fields (WG1–WG3)', () => {
  it('built-in campaign groups omit the optional range fields (WG3 backward compat)', () => {
    for (const level of LEVELS) {
      for (const wave of level.waves) {
        for (const g of wave.groups) {
          expect(g.startXMin, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startXMax, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startYMin, `${level.name}/${g.enemyKey}`).toBeUndefined();
          expect(g.startYMax, `${level.name}/${g.enemyKey}`).toBeUndefined();
        }
      }
    }
  });

  it('accepts a group carrying per-group range overrides (WG1/WG2)', () => {
    const g: WaveGroup = {
      enemyKey: 'scout',
      formation: 'v',
      count: 3,
      spacingX: 28,
      spacingY: 22,
      startX: 200,
      startY: 300,
      startXMin: 120,
      startXMax: 320,
      startYMin: 200,
      startYMax: 400,
    };
    // The new fields are carried verbatim.
    expect(g.startXMin).toBe(120);
    expect(g.startXMax).toBe(320);
    expect(g.startYMin).toBe(200);
    expect(g.startYMax).toBe(400);
    // Spawn accounting is unaffected by the range fields.
    expect(wavePlannedSpawnCount([g])).toBe(wavePlannedSpawnCount([{ ...g, startXMin: undefined, startXMax: undefined, startYMin: undefined, startYMax: undefined }]));
    expect(validateWaveGroups([g])).toEqual([]);
  });

  it('enemyCountForLevel is unchanged for every built-in level', () => {
    // A regression guard: the optional range fields must not alter counting.
    expect(LEVELS.map((l) => enemyCountForLevel(l.level))).toEqual(
      LEVELS.map((l) => l.waves.reduce((s, w) => s + wavePlannedSpawnCount(w.groups), 0)),
    );
  });
});

// ── Levels 6–10: classic-arcade campaign (AH-0MV396OK0001FX14) ───────

/** Every distinct enemy key appearing as a wave group in a level. */
function groupKeys(level: LevelDefinition): Set<string> {
  return new Set(level.waves.flatMap((w) => w.groups.map((g) => g.enemyKey)));
}

/** True when any wave in the level opts into the named spawner flag. */
function optsIn(level: LevelDefinition, flag: keyof WaveDefinition): boolean {
  return level.waves.some((w) => w[flag] === true);
}

/**
 * A level's dominant movement signature derived from its authored data: the
 * spawner opt-in flags plus the formation kinds present. Two adjacent levels
 * sharing a signature would mean the campaign repeats a movement style.
 */
function styleSignature(level: LevelDefinition): string {
  const tokens: string[] = [];
  if (optsIn(level, 'centipede')) tokens.push('chain');
  if (optsIn(level, 'ghosts')) tokens.push('pursuit');
  if (optsIn(level, 'horde')) tokens.push('horde');
  if (optsIn(level, 'laneTraffic')) tokens.push('lanes');
  const formations = new Set(
    level.waves.flatMap((w) => w.groups.map((g) => g.formation)),
  );
  for (const formation of ['march', 'orbital', 'diver', 'swarm', 'rect', 'v'] as const) {
    if (formations.has(formation)) tokens.push(formation);
  }
  return tokens.join('+');
}

describe('Levels 6–10 — classic-arcade campaign (AH-0MV396OK0001FX14)', () => {
  it('AC1 — defines exactly ten sequential levels', () => {
    expect(LEVEL_COUNT).toBe(10);
    expect(LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(LEVELS.map((l) => l.name)).toEqual([
      'Entry',
      'Descent',
      'The Core',
      'Firestorm',
      'Predictable Death',
      'Invasion',
      'Segmented Assault',
      'Gridlock',
      'Orbital Siege',
      'The Gauntlet',
    ]);
  });

  it('AC2 — Level 6 (Invasion) features the stepping march and the capturer', () => {
    const keys = groupKeys(getLevelDefinition(6)!);
    expect(keys).toContain('march');
    expect(keys).toContain('capturer');
    // The march uses its dedicated stepping formation (not a plain V).
    expect(
      getLevelDefinition(6)!.waves.some((w) =>
        w.groups.some((g) => g.enemyKey === 'march' && g.formation === 'march'),
      ),
    ).toBe(true);
  });

  it('AC3 — Level 7 (Segmented Assault) opts into the centipede and ghosts spawners', () => {
    const l7 = getLevelDefinition(7)!;
    expect(optsIn(l7, 'centipede')).toBe(true);
    expect(optsIn(l7, 'ghosts')).toBe(true);
  });

  it('AC4 — Level 8 (Gridlock) opts into lane traffic and the grunt horde, and features raiders', () => {
    const l8 = getLevelDefinition(8)!;
    expect(optsIn(l8, 'laneTraffic')).toBe(true);
    expect(optsIn(l8, 'horde')).toBe(true);
    expect(groupKeys(l8)).toContain('raider');
  });

  it('AC5 — Level 9 (Orbital Siege) features orbital Phasers and pursuing ghosts, with the strike plan active', () => {
    const l9 = getLevelDefinition(9)!;
    expect(groupKeys(l9)).toContain('phaser');
    expect(optsIn(l9, 'ghosts')).toBe(true);
    // The Missile-Command orbital-strike is a non-blocking hazard delivered by
    // the telegraphed strike plan, not a wave group (strikes must never gate
    // wave completion; see `waves/StrikeSpawner.ts`). The plan is active from
    // `STRIKE_SPAWN_START_WAVE` onward, and Level 9 starts well past it.
    const globalWaveIndexAtLevel9 = LEVELS
      .filter((l) => l.level < 9)
      .reduce((sum, l) => sum + l.waves.length, 0);
    expect(globalWaveIndexAtLevel9).toBeGreaterThanOrEqual(
      STRIKE_SPAWN_START_WAVE,
    );
  });

  it('AC6 — Level 10 (The Gauntlet) is a dense mixed finale', () => {
    const l10 = getLevelDefinition(10)!;
    expect(l10.waves.length).toBeGreaterThanOrEqual(2);
    for (const wave of l10.waves) {
      // Every wave mixes at least two kinds (player-targeters with others).
      const keys = new Set(wave.groups.map((g) => g.enemyKey));
      expect(keys.size, `wave with ${wave.groups.length} groups`).toBeGreaterThanOrEqual(2);
    }
    // Dense: several distinct archetypes across the level.
    expect(groupKeys(l10).size).toBeGreaterThanOrEqual(4);
  });

  it('AC7 — Levels 1–3 never fire; Levels 4–10 always fire', () => {
    for (const level of LEVELS) {
      const expected = level.level >= 4;
      expect(
        level.waves.every((w) => w.shootEnabled === expected),
        `Level ${level.level} (${level.name})`,
      ).toBe(true);
    }
  });

  it('AC9 — adjacent levels have distinct dominant movement/attack styles', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(
        styleSignature(LEVELS[i]),
        `Level ${LEVELS[i].level} vs ${LEVELS[i - 1].level}`,
      ).not.toBe(styleSignature(LEVELS[i - 1]));
    }
  });
});
