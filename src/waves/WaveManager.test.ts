/**
 * Unit tests for the WaveManager and level definitions
 * (AH-0MU72ZK3P006CH9G — child 3).
 *
 * Covers the GDD §3.2 level structure, wave/level progression, spawn
 * planning, enemy-fire gating, and the boss trigger. All assertions are
 * on observable behaviour through the public API — no source inspection.
 */

import { describe, expect, it } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  LEVELS,
  LEVEL_COUNT,
  enemyCountForLevel,
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
} from './Formations';
import { WaveManager, type WaveEvent } from './WaveManager';

/** Kills every enemy in the active wave; returns the final event. */
function clearWave(wm: WaveManager): WaveEvent {
  for (let i = 0; i < 1000; i++) {
    const event = wm.onEnemyDestroyed();
    if (event !== 'continue') return event;
  }
  throw new Error('clearWave did not terminate');
}

/** Clears waves until the level ends; returns `levelCleared`/`bossTriggered`. */
function clearLevel(wm: WaveManager): WaveEvent {
  for (let i = 0; i < 100; i++) {
    const event = clearWave(wm);
    if (event === 'levelCleared' || event === 'bossTriggered') return event;
  }
  throw new Error('clearLevel did not terminate');
}

/** Builds a minimal custom wave from one group. */
function wave(
  enemyKey: string,
  formation: WaveDefinition['groups'][number]['formation'],
  count: number,
  shootEnabled = false,
  startX = 200,
  startY = 200,
): WaveDefinition {
  return {
    shootEnabled,
    groups: [
      {
        enemyKey,
        formation,
        count,
        spacingX: 20,
        spacingY: 20,
        startX,
        startY,
      },
    ],
  };
}

/** Builds a minimal custom level. */
function level(
  n: number,
  name: string,
  waves: WaveDefinition[],
): LevelDefinition {
  return { level: n, name, waves };
}

describe('Level definitions — GDD §3.2 structure (AH-0MU72ZK3P006CH9G)', () => {
  it('AC1 — defines exactly 5 sequential levels', () => {
    expect(LEVEL_COUNT).toBe(5);
    expect(LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5]);
    expect(getLevelDefinition(1)?.name).toBe('Entry');
    expect(getLevelDefinition(5)?.name).toBe('Predictable Death');
    expect(getLevelDefinition(6)).toBeNull();
  });

  it('AC1 — Level 1 uses a single enemy type with no enemy fire', () => {
    const l1 = getLevelDefinition(1)!;
    const keys = new Set(
      l1.waves.flatMap((w) => w.groups.map((g) => g.enemyKey)),
    );
    expect(keys.size).toBe(1);
    expect(l1.waves.every((w) => w.shootEnabled === false)).toBe(true);
  });

  it('AC1 — Level 2 has mixed single-enemy waves (one group, >1 archetype), no fire', () => {
    const l2 = getLevelDefinition(2)!;
    // "Single-enemy waves": each wave spawns one archetype.
    expect(l2.waves.every((w) => w.groups.length === 1)).toBe(true);
    const keys = new Set(
      l2.waves.flatMap((w) => w.groups.map((g) => g.enemyKey)),
    );
    expect(keys.size).toBeGreaterThan(1);
    expect(l2.waves.every((w) => w.shootEnabled === false)).toBe(true);
  });

  it('AC1 — Level 3 uses mixed pairs (≥2 archetypes per wave), no fire', () => {
    const l3 = getLevelDefinition(3)!;
    expect(l3.waves.length).toBeGreaterThan(0);
    for (const w of l3.waves) {
      expect(w.groups.length).toBeGreaterThanOrEqual(2);
      const keys = new Set(w.groups.map((g) => g.enemyKey));
      expect(keys.size).toBeGreaterThanOrEqual(2);
      expect(w.shootEnabled).toBe(false);
    }
  });

  it('AC1 — Levels 1–3 never arm enemy fire; Levels 4–5 always do', () => {
    for (const n of [1, 2, 3]) {
      const def = getLevelDefinition(n)!;
      expect(def.waves.every((w) => w.shootEnabled === false)).toBe(true);
    }
    for (const n of [4, 5]) {
      const def = getLevelDefinition(n)!;
      expect(def.waves.length).toBeGreaterThan(0);
      expect(def.waves.every((w) => w.shootEnabled === true)).toBe(true);
    }
  });

  it('AC3/AC4 — Level 5 has fewer enemies than Level 4 (and earlier levels)', () => {
    expect(enemyCountForLevel(5)).toBeLessThan(enemyCountForLevel(4));
    expect(enemyCountForLevel(5)).toBeLessThan(enemyCountForLevel(3));
    expect(enemyCountForLevel(5)).toBeGreaterThan(0);
  });

  it('boundary — unknown levels report zero enemies and no definition', () => {
    expect(getLevelDefinition(0)).toBeNull();
    expect(getLevelDefinition(6)).toBeNull();
    expect(enemyCountForLevel(0)).toBe(0);
    expect(enemyCountForLevel(6)).toBe(0);
  });
});

describe('WaveManager — lifecycle & spawn planning (AH-0MU72ZK3P006CH9G)', () => {
  it('AC1 — beginGame starts at Level 1, Wave 1 with the wave enemy count', () => {
    const wm = new WaveManager();
    expect(wm.started).toBe(false);
    expect(wm.currentWave()).toBeNull();
    expect(wm.planSpawns()).toEqual([]);

    wm.beginGame();
    expect(wm.started).toBe(true);
    expect(wm.level).toBe(1);
    expect(wm.levelName).toBe('Entry');
    expect(wm.waveNumber).toBe(1);
    expect(wm.waveCount).toBe(LEVELS[0].waves.length);
    expect(wm.enemiesAlive).toBe(wm.waveEnemyCount());
    expect(wm.enemiesAlive).toBeGreaterThan(0);
  });

  it('AC1 — planSpawns returns one positioned spawn per enemy in the wave', () => {
    const wm = new WaveManager();
    wm.beginGame();

    const spawns = wm.planSpawns();
    expect(spawns).toHaveLength(wm.waveEnemyCount());

    // Every spawn is on-screen and has a unique position (no overlap).
    const seen = new Set<string>();
    for (const s of spawns) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThanOrEqual(GAME_WIDTH);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y).toBeLessThanOrEqual(GAME_HEIGHT);
      seen.add(`${s.x},${s.y}`);
    }
    expect(seen.size).toBe(spawns.length);

    // Every spawn archetype is one of the active wave's groups.
    const wave = wm.currentWave()!;
    const keys = new Set(wave.groups.map((g) => g.enemyKey));
    expect(spawns.every((s) => keys.has(s.enemyKey))).toBe(true);
  });

  it('AC1 — spawn positions honour the formation geometry (single-entity anchor)', () => {
    const defs = [level(1, 'Test', [wave('scout', 'single', 1, false, 123, 234)])];
    const wm = new WaveManager(defs);
    wm.beginGame();

    const spawns = wm.planSpawns();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ enemyKey: 'scout', x: 123, y: 234 });
  });

  it('AC1 — spawn positions walk the formation offsets (V apex at base)', () => {
    const defs = [level(1, 'Test', [wave('scout', 'v', 3, false, 100, 150)])];
    const wm = new WaveManager(defs);
    wm.beginGame();

    const spawns = wm.planSpawns();
    expect(spawns).toHaveLength(3);
    // Apex (offset row 0, col 0) sits exactly at the formation base.
    expect(spawns[0]).toMatchObject({ x: 100, y: 150 });
    // Remaining two wing slots are offset from the base.
    expect(spawns[1].x === 100 && spawns[1].y === 150).toBe(false);
  });

  it('AC1/AC3 — spawns carry the wave fire flag (Levels 1–3 silent, 4–5 armed)', () => {
    const defs = [
      level(1, 'Silent', [wave('scout', 'v', 2, false)]),
      level(2, 'Armed', [wave('diver', 'diver', 2, true)]),
    ];
    const wm = new WaveManager(defs);

    wm.beginGame();
    expect(wm.planSpawns().every((s) => s.shootEnabled === false)).toBe(true);

    // Clear level 1 → level 2.
    expect(clearLevel(wm)).toBe('levelCleared');
    expect(wm.planSpawns().every((s) => s.shootEnabled === true)).toBe(true);
  });
});

describe('WaveManager — progression (AH-0MU72ZK3P006CH9G)', () => {
  it('AC2 — clearing a wave emits waveCleared and makes the next wave current', () => {
    // Two-wave custom level for a deterministic wave boundary.
    const defs = [
      level(1, 'Test', [
        wave('scout', 'v', 2, false),
        wave('diver', 'diver', 3, false),
      ]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();
    expect(wm.waveNumber).toBe(1);
    expect(wm.enemiesAlive).toBe(2);

    // First kill leaves one alive.
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(1);

    // Second kill wipes the wave → waveCleared, wave 2 loaded.
    expect(wm.onEnemyDestroyed()).toBe('waveCleared');
    expect(wm.waveNumber).toBe(2);
    expect(wm.enemiesAlive).toBe(3);
    expect(wm.currentWave()!.groups[0].enemyKey).toBe('diver');
  });

  it('AC2 — clearing a level emits levelCleared and advances to the next level', () => {
    const defs = [
      level(1, 'First', [wave('scout', 'v', 2)]),
      level(2, 'Second', [wave('diver', 'diver', 4)]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();

    expect(clearLevel(wm)).toBe('levelCleared');
    expect(wm.level).toBe(2);
    expect(wm.levelName).toBe('Second');
    expect(wm.waveNumber).toBe(1);
    expect(wm.enemiesAlive).toBe(4);
  });

  it('AC2 — the full campaign auto-advances through all 5 levels', () => {
    const wm = new WaveManager();
    wm.beginGame();

    for (let n = 1; n <= 5; n++) {
      expect(wm.level).toBe(n);
      const event = clearLevel(wm);
      if (n < 5) {
        expect(event).toBe('levelCleared');
        expect(wm.level).toBe(n + 1);
      } else {
        expect(event).toBe('bossTriggered');
      }
    }
  });

  it('AC5 — clearing Level 5 triggers the boss, and the boss is inactive until beginBoss', () => {
    // One level only → its clear is the final-level clear.
    const wm = new WaveManager([level(5, 'Final', [wave('phaser', 'orbital', 2, true)])]);
    wm.beginGame();

    expect(clearLevel(wm)).toBe('bossTriggered');
    expect(wm.bossTriggered).toBe(true);
    expect(wm.bossActive).toBe(false);
    // No regular wave remains to spawn.
    expect(wm.currentWave()).toBeNull();
    expect(wm.planSpawns()).toEqual([]);

    wm.beginBoss();
    expect(wm.bossActive).toBe(true);
    expect(wm.currentWave()).toBeNull();
  });

  it('AC5 — onBossDefeated completes the run', () => {
    const wm = new WaveManager([level(1, 'Final', [wave('boss', 'single', 1, true)])]);
    wm.beginGame();
    clearLevel(wm);
    wm.beginBoss();
    expect(wm.bossDefeated).toBe(false);

    expect(wm.onBossDefeated()).toBe('gameComplete');
    expect(wm.bossDefeated).toBe(true);
    expect(wm.bossActive).toBe(false);

    // Further destruction calls stay complete (no re-trigger).
    expect(wm.onEnemyDestroyed()).toBe('gameComplete');
  });

  it('AC2 — reset() returns the manager to its initial state', () => {
    const wm = new WaveManager();
    wm.beginGame();
    clearLevel(wm);
    expect(wm.level).toBe(2);

    wm.reset();
    expect(wm.started).toBe(false);
    expect(wm.currentWave()).toBeNull();
    expect(wm.planSpawns()).toEqual([]);

    wm.beginGame();
    expect(wm.level).toBe(1);
    expect(wm.waveNumber).toBe(1);
  });

  it('— onEnemyDestroyed before beginGame is a safe no-op', () => {
    const wm = new WaveManager();
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.started).toBe(false);
  });
});
