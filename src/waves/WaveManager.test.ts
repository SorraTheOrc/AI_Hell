/**
 * Unit tests for the WaveManager and level definitions
 * (AH-0MU72ZK3P006CH9G — child 3).
 *
 * Covers the GDD §3.2 level structure, wave/level progression, spawn
 * planning, enemy-fire gating, and the boss trigger. All assertions are
 * on observable behaviour through the public API — no source inspection.
 */

import { describe, expect, it, vi } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import type { EnemyConfig } from '../core/configTypes';
import {
  LEVELS,
  LEVEL_COUNT,
  enemyCountForLevel,
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
  type WaveGroup,
} from './Formations';
import {
  WaveManager,
  planGroupSpawns,
  validateWaveGroups,
  wavePlannedSpawnCount,
  type WaveEvent,
} from './WaveManager';
import { auditCampaignVariety, waveArchetypes } from './campaignVariety';

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
  it('AC1 — defines exactly 10 sequential levels', () => {
    expect(LEVEL_COUNT).toBe(10);
    expect(LEVELS.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(getLevelDefinition(1)?.name).toBe('Entry');
    expect(getLevelDefinition(5)?.name).toBe('Predictable Death');
    expect(getLevelDefinition(10)?.name).toBe('The Gauntlet');
    expect(getLevelDefinition(11)).toBeNull();
  });

  it('AC1 — Level 1 keeps its Scout identity: scouts in every wave, scout-dominant, no enemy fire', () => {
    const l1 = getLevelDefinition(1)!;

    // Q2 = a on the parent item (AH-0MVI5XXOU00954EA): the producer chose
    // "preserve the dominant archetype, add variety around it". Level 1 keeps
    // its documented scout-led identity (GDD §3.2 "Entry — single enemy type,
    // simple V-formation waves") but may gain secondary archetypes. Purity
    // (`Set(['scout'])`) would delete that intent, so this pin asserts
    // identity instead: scouts must appear in every wave and remain the
    // level's dominant archetype by spawned weight.
    for (const [index, wave] of l1.waves.entries()) {
      expect(
        waveArchetypes(wave),
        `Level 1 wave ${index + 1} loses the scout identity`,
      ).toContain('scout');
    }
    const [audit] = auditCampaignVariety([l1]).levels;
    expect(audit.dominantArchetype, 'Level 1 dominant archetype').toBe(
      'scout',
    );

    expect(l1.waves.every((w) => w.shootEnabled === false)).toBe(true);
    // Wave 1's hand-authored Scout V-formation is the onboarding anchor and is
    // retained exactly.
    const wave1 = l1.waves[0];
    const wave1Scout = wave1.groups.find((g) => g.enemyKey === 'scout');
    expect(wave1Scout, 'Level 1 wave 1 Scout V-formation').toMatchObject({
      enemyKey: 'scout',
      formation: 'v',
    });
  });

  it('AC1 — Level 2 has mixed single-enemy waves (one group, >1 archetype), no fire', () => {
    const l2 = getLevelDefinition(2)!;
    // Q2 = a on AH-0MVI5XXOU00954EA: the structural identity is one group per
    // wave (one enemyKey per group), not archetype purity across the level.
    // The level must still show more than one archetype overall.
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
    // Q2 = a on AH-0MVI5XXOU00954EA: keep the mixed-pair structure (≥2
    // archetypes per wave); the pin does not require any specific archetype
    // to dominate or exclude others.
    expect(l3.waves.length).toBeGreaterThan(0);
    for (const w of l3.waves) {
      expect(w.groups.length).toBeGreaterThanOrEqual(2);
      const keys = new Set(w.groups.map((g) => g.enemyKey));
      expect(keys.size).toBeGreaterThanOrEqual(2);
      expect(w.shootEnabled).toBe(false);
    }
  });

  it('AC1 — Levels 1–3 never arm enemy fire; Levels 4–10 always do', () => {
    for (const n of [1, 2, 3]) {
      const def = getLevelDefinition(n)!;
      expect(def.waves.every((w) => w.shootEnabled === false)).toBe(true);
    }
    for (const n of [4, 5, 6, 7, 8, 9, 10]) {
      const def = getLevelDefinition(n)!;
      expect(def.waves.length).toBeGreaterThan(0);
      expect(def.waves.every((w) => w.shootEnabled === true)).toBe(true);
    }
  });

  it('AC3/AC4 — Level 5 remains the sparse memorisable-pattern level', () => {
    expect(enemyCountForLevel(5)).toBeLessThan(enemyCountForLevel(4));
    expect(enemyCountForLevel(5)).toBeLessThan(enemyCountForLevel(3));
    expect(enemyCountForLevel(5)).toBeGreaterThan(0);
  });

  it('AC3/AC4 — the ten-level campaign finale is denser than the onboarding levels', () => {
    // The old "final sparse level" assertion now describes Level 5's design
    // (Predictable Death); the new finale (Level 10) closes the campaign with
    // the densest composition (AH-0MV39AGIM007RGVF).
    expect(enemyCountForLevel(LEVEL_COUNT)).toBeGreaterThan(
      enemyCountForLevel(1),
    );
    expect(enemyCountForLevel(LEVEL_COUNT)).toBeGreaterThanOrEqual(
      enemyCountForLevel(5),
    );
  });

  it('boundary — unknown levels report zero enemies and no definition', () => {
    expect(getLevelDefinition(0)).toBeNull();
    expect(getLevelDefinition(LEVEL_COUNT + 1)).toBeNull();
    expect(enemyCountForLevel(0)).toBe(0);
    expect(enemyCountForLevel(LEVEL_COUNT + 1)).toBe(0);
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
    expect(wm.levelCount).toBe(LEVELS.length);
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

  it('AC2 — the full campaign auto-advances through all 10 levels', () => {
    const wm = new WaveManager();
    wm.beginGame();

    for (let n = 1; n <= LEVEL_COUNT; n++) {
      expect(wm.level).toBe(n);
      const event = clearLevel(wm);
      if (n < LEVEL_COUNT) {
        expect(event).toBe('levelCleared');
        expect(wm.level).toBe(n + 1);
      } else {
        expect(event).toBe('bossTriggered');
      }
    }
  });

  it('AC5 — clearing the final level triggers the boss, and the boss is inactive until beginBoss', () => {
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

describe('WaveManager — globalWaveIndex accessor (AH-0MUDYS2SZ004H123)', () => {
  it('globalWaveIndex is 0 before beginGame is called', () => {
    const wm = new WaveManager();
    expect(wm.globalWaveIndex).toBe(0);
  });

  it('globalWaveIndex is 0 after beginGame at Level 1 Wave 1', () => {
    const wm = new WaveManager();
    wm.beginGame();
    expect(wm.globalWaveIndex).toBe(0);
  });

  it('globalWaveIndex increments through waves within a level', () => {
    // Level 2 has 3 waves.
    const wm = new WaveManager();
    wm.beginGame();
    expect(wm.globalWaveIndex).toBe(0); // L1 W1
    clearWave(wm); // L1 W1 → L1 W2
    expect(wm.globalWaveIndex).toBe(1);
    clearWave(wm); // L1 W2 → L2 W1
    expect(wm.globalWaveIndex).toBe(2);
  });

  it('globalWaveIndex increments correctly across levels', () => {
    // Level 1 has 10 waves, Level 2 has 10 waves.
    const wm = new WaveManager();
    wm.beginGame();
    // Clear Level 1 (10 waves) → L2 W1, globalWaveIndex = 10.
    expect(clearLevel(wm)).toBe('levelCleared');
    expect(wm.globalWaveIndex).toBe(10);
    clearWave(wm); // L2 W1 → L2 W2, globalWaveIndex = 11
    expect(wm.globalWaveIndex).toBe(11);
    clearWave(wm); // L2 W2 → L2 W3, globalWaveIndex = 12
    expect(wm.globalWaveIndex).toBe(12);
    clearWave(wm); // L2 W3 → L3 W1, globalWaveIndex = 13
    expect(wm.globalWaveIndex).toBe(13);
  });

  it('globalWaveIndex for the full campaign — last regular wave is index 99', () => {
    const wm = new WaveManager();
    wm.beginGame();
    // Clear all 10 levels (the expanded campaign has 10 waves per level,
    // 10 levels = 100 regular waves; AH-0MVCYANT6003SG5C).
    for (let level = 1; level <= LEVEL_COUNT; level++) {
      const levelStartGWI = wm.globalWaveIndex;
      const waveCount = wm.waveCount;
      for (let w = 0; w < waveCount; w++) {
        if (level < LEVEL_COUNT) {
          expect(wm.globalWaveIndex).toBe(levelStartGWI + w);
        }
        clearWave(wm);
      }
    }
    // After clearing Level 10's final wave, the boss should trigger.
    expect(wm.bossTriggered).toBe(true);
    expect(wm.globalWaveIndex).toBe(99);
  });

  it('globalWaveIndex is 0 during a boss encounter', () => {
    const wm = new WaveManager([level(5, 'Final', [wave('phaser', 'orbital', 1)])]);
    wm.beginGame();
    clearLevel(wm);
    expect(wm.bossTriggered).toBe(true);
    expect(wm.globalWaveIndex).toBe(0);
    wm.beginBoss();
    expect(wm.bossActive).toBe(true);
    expect(wm.globalWaveIndex).toBe(0);
    wm.onBossDefeated();
    expect(wm.bossDefeated).toBe(true);
    expect(wm.globalWaveIndex).toBe(0);
  });
});

describe('WaveManager — dynamic spawn registration (generic seam)', () => {
  // The dynamic-spawn seam is retained for any future dynamically spawned
  // enemies. Asteroids are NOT registered through it (AH-0MUJM746P000QAEO):
  // they do not gate wave completion. These tests exercise the seam itself.
  it('registerDynamicSpawn increments the alive count by the supplied amount', () => {
    // A `single` group represents exactly one entity, so its count must be 1.
    const wm = new WaveManager([level(1, 'Test', [wave('asteroid', 'single', 1)])]);
    wm.beginGame();
    const before = wm.enemiesAlive;
    wm.registerDynamicSpawn(2);
    expect(wm.enemiesAlive).toBe(before + 2);
  });

  it('unregisterDynamicSpawn decrements the alive count by the supplied amount', () => {
    // A `single` group represents exactly one entity, so its count must be 1.
    const wm = new WaveManager([level(1, 'Test', [wave('asteroid', 'single', 1)])]);
    wm.beginGame();
    wm.registerDynamicSpawn(2);
    wm.unregisterDynamicSpawn(1);
    expect(wm.enemiesAlive).toBe(1 /* initial 1 */ + 2 - 1);
  });

  it('unregisterDynamicSpawn never drives the count below zero', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'v', 2)])]);
    wm.beginGame();
    wm.unregisterDynamicSpawn(99);
    expect(wm.enemiesAlive).toBe(0);
  });

  it('registerDynamicSpawn is a safe no-op before beginGame', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'v', 2)])]);
    expect(wm.enemiesAlive).toBe(0);
    wm.registerDynamicSpawn(5);
    expect(wm.enemiesAlive).toBe(0);
  });

  it('a full registered-child chain keeps enemiesAlive correct and does not clear early', () => {
    // Two waves so the chain wipe emits a 'waveCleared' boundary
    // instead of the final-level boss trigger.
    const defs = [
      level(1, 'Test', [
        wave('scout', 'single', 1, false),
        wave('scout', 'v', 1, false),
      ]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();
    expect(wm.waveNumber).toBe(1);
    expect(wm.enemiesAlive).toBe(1);

    // Destroy the original and register its 2 children.
    wm.registerDynamicSpawn(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(2);

    // Destroy the first child and register its 2 children.
    wm.registerDynamicSpawn(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(3);

    // Destroy the second child and register its 2 children.
    wm.registerDynamicSpawn(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(4);

    // Destroy the 4 children one by one — each stays 'continue'
    // while children remain alive (the wave does not clear early).
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(3);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(1);

    // 7th destruction wipes the wave and advances to wave 2.
    expect(wm.onEnemyDestroyed()).toBe('waveCleared');
    expect(wm.waveNumber).toBe(2);
    expect(wm.enemiesAlive).toBe(1);
  });

  it('a registered child keeps the wave alive until every original AND child is destroyed', () => {
    const defs = [level(1, 'Test', [wave('scout', 'single', 1, false)])];
    const wm = new WaveManager(defs);
    wm.beginGame();

    // Original destroyed, but 2 registered children still alive.
    wm.registerDynamicSpawn(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(2);

    // A child destroyed but one remains.
    expect(wm.onEnemyDestroyed()).toBe('continue');

    // Final child destroyed → the wave is finally wiped (final level -> boss).
    expect(wm.onEnemyDestroyed()).toBe('bossTriggered');
  });
});

describe('WaveManager — carry-over adoption (AH-0MUNS3ZQ1002DJ9S)', () => {
  it('AC1 — adoptCarriedSurvivors increments the alive count by the supplied amount', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'v', 2)])]);
    wm.beginGame();
    const before = wm.enemiesAlive;
    wm.adoptCarriedSurvivors(3);
    expect(wm.enemiesAlive).toBe(before + 3);
  });

  it('AC3 — adopted survivors are decremented by onEnemyDestroyed like any other enemy', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'single', 1)])]);
    wm.beginGame();
    expect(wm.enemiesAlive).toBe(1);
    wm.adoptCarriedSurvivors(2);
    expect(wm.enemiesAlive).toBe(3);

    // Each destroyed survivor decrements the counter normally.
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(2);
    expect(wm.onEnemyDestroyed()).toBe('continue');
    expect(wm.enemiesAlive).toBe(1);
  });

  it('AC3 — the wave clears only once the adopted survivors AND fresh spawns are destroyed', () => {
    const defs = [
      level(1, 'Test', [
        wave('scout', 'single', 1, false),
        wave('scout', 'single', 1, false),
      ]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();
    expect(wm.enemiesAlive).toBe(1);

    // Simulate a timeout: force the wave to advance, then adopt 2 survivors.
    expect(wm.onEnemyDestroyed()).toBe('waveCleared');
    expect(wm.waveNumber).toBe(2);
    expect(wm.enemiesAlive).toBe(1);
    wm.adoptCarriedSurvivors(2);
    expect(wm.enemiesAlive).toBe(3); // 1 fresh spawn + 2 carried survivors

    // The fresh spawn dies — the wave must NOT clear while survivors remain.
    expect(wm.onEnemyDestroyed()).toBe('continue');
    // One survivor dies — still not clear.
    expect(wm.onEnemyDestroyed()).toBe('continue');
    // The last survivor dies — the wave finally clears.
    expect(wm.onEnemyDestroyed()).toBe('bossTriggered');
  });

  it('AC2 — adoptCarriedSurvivors is a safe no-op before beginGame', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'v', 2)])]);
    expect(wm.enemiesAlive).toBe(0);
    wm.adoptCarriedSurvivors(5);
    expect(wm.enemiesAlive).toBe(0);
  });

  it('AC2 — adoptCarriedSurvivors is a no-op during the boss encounter', () => {
    const wm = new WaveManager([level(1, 'Test', [wave('scout', 'single', 1)])]);
    wm.beginGame();
    expect(wm.onEnemyDestroyed()).toBe('bossTriggered');
    wm.beginBoss();
    const before = wm.enemiesAlive;
    wm.adoptCarriedSurvivors(4);
    expect(wm.enemiesAlive).toBe(before);
  });
});

describe('WaveManager — declared vs planned spawn count (AH-0MUJKJ8OO007TBSS)', () => {
  it('AC2 — a single-formation group with count > 1 declares exactly what it spawns', () => {
    // Two waves so clearing the first emits `waveCleared` rather than the
    // final-level boss trigger.
    const defs = [
      level(1, 'Test', [
        wave('asteroid', 'single', 5, false),
        wave('scout', 'v', 1, false),
      ]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();

    const spawns = wm.planSpawns();
    expect(spawns).toHaveLength(1);
    expect(wm.waveEnemyCount()).toBe(spawns.length);
    expect(wm.enemiesAlive).toBe(spawns.length);
  });

  it('AC1 — an over-declared single group cannot stall or clear a wave early', () => {
    const defs = [
      level(1, 'Test', [
        wave('asteroid', 'single', 5, false),
        wave('scout', 'v', 1, false),
      ]),
    ];
    const wm = new WaveManager(defs);
    wm.beginGame();

    // Exactly one enemy was spawned, so one destruction clears the wave.
    expect(wm.onEnemyDestroyed()).toBe('waveCleared');
    expect(wm.waveNumber).toBe(2);
  });

  it('AC2 — validateWaveGroups names the offending single group and its count', () => {
    const groups = wave('asteroid', 'single', 5).groups;
    const errors = validateWaveGroups(groups);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ index: 0, enemyKey: 'asteroid', count: 5 });
    expect(errors[0].message).toContain('asteroid');
    expect(errors[0].message).toContain('single');
    expect(errors[0].message).toContain('5');
  });

  it('AC2 — validateWaveGroups accepts a single group with count 1', () => {
    expect(validateWaveGroups(wave('boss', 'single', 1).groups)).toEqual([]);
  });

  it('AC3 — every built-in campaign wave is valid and declares its planned size', () => {
    for (const levelDef of LEVELS) {
      for (const w of levelDef.waves) {
        expect(validateWaveGroups(w.groups)).toEqual([]);
        const declared = w.groups.reduce((sum, g) => sum + g.count, 0);
        expect(wavePlannedSpawnCount(w.groups)).toBe(declared);
      }
    }
  });
});

// ── Range-based spawn positioning (AH-0MUKIBAY60075GH5) ─────────────

describe('planGroupSpawns — range-based positioning (AH-0MUKIBAY60075GH5)', () => {
  /** A wave group with explicit scalar base and optional range overrides. */
  function rangedGroup(
    overrides: Partial<{
      enemyKey: string;
      startX: number;
      startY: number;
      startXMin: number;
      startXMax: number;
      startYMin: number;
      startYMax: number;
    }> = {},
  ): WaveGroup {
    return {
      enemyKey: 'scout',
      formation: 'single',
      count: 1,
      spacingX: 20,
      spacingY: 20,
      startX: overrides.startX ?? 100,
      startY: overrides.startY ?? 200,
      startXMin: overrides.startXMin,
      startXMax: overrides.startXMax,
      startYMin: overrides.startYMin,
      startYMax: overrides.startYMax,
    };
  }

  /** Resolver that returns the scout seed with the supplied range fields. */
  function configWith(
    overrides: Partial<Pick<EnemyConfig, 'startX' | 'startY' | 'startXMin' | 'startXMax' | 'startYMin' | 'startYMax'>>,
  ): (key: string) => EnemyConfig {
    return () => ({ ...DEFAULT_ENEMY_CONFIGS.scout, ...overrides });
  }

  it('degenerate config range keeps the group scalar base (no randomness)', () => {
    const rng = vi.fn(() => 0.5);
    const spawns = planGroupSpawns(
      [rangedGroup({ startX: 123, startY: 234 })],
      false,
      rng,
      configWith({ startXMin: 240, startXMax: 240, startYMin: 270, startYMax: 270 }),
    );
    expect(spawns[0]).toMatchObject({ x: 123, y: 234, startX: 123, startY: 234 });
    expect(rng).not.toHaveBeenCalled();
  });

  it('picks a base within an archetype range using the injected RNG', () => {
    const spawns = planGroupSpawns(
      [rangedGroup({ startX: 0, startY: 0 })],
      false,
      () => 0.5,
      configWith({ startXMin: 100, startXMax: 300, startYMin: 200, startYMax: 400 }),
    );
    expect(spawns[0].startX).toBe(200);
    expect(spawns[0].startY).toBe(300);
    expect(spawns[0]).toMatchObject({ x: 200, y: 300 });
  });

  it('spans the full configured band across the RNG domain', () => {
    const cfg = configWith({ startXMin: 100, startXMax: 300, startYMin: 200, startYMax: 400 });
    for (const [r, expectedX, expectedY] of [
      [0, 100, 200],
      [1, 300, 400],
      [0.25, 150, 250],
      [0.75, 250, 350],
    ] as const) {
      const spawns = planGroupSpawns([rangedGroup({ startX: 0, startY: 0 })], false, () => r, cfg);
      expect(spawns[0].startX).toBe(expectedX);
      expect(spawns[0].startY).toBe(expectedY);
    }
  });

  it('a per-group range overrides the archetype range (WG4)', () => {
    const spawns = planGroupSpawns(
      [rangedGroup({ startX: 0, startY: 0, startXMin: 10, startXMax: 30, startYMin: 40, startYMax: 60 })],
      false,
      () => 0.5,
      configWith({ startXMin: 100, startXMax: 300, startYMin: 200, startYMax: 400 }),
    );
    expect(spawns[0].startX).toBe(20);
    expect(spawns[0].startY).toBe(50);
  });

  it('adds formation offsets on top of the resolved base', () => {
    const group: WaveGroup = {
      ...rangedGroup({ startX: 0, startY: 0 }),
      formation: 'v',
      count: 3,
      spacingX: 10,
      spacingY: 10,
    };
    const spawns = planGroupSpawns(
      [group],
      false,
      () => 0.5,
      configWith({ startXMin: 0, startXMax: 100, startYMin: 0, startYMax: 100 }),
    );
    expect(spawns).toHaveLength(3);
    // The apex sits on the resolved base, wings are offset from it.
    expect(spawns[0]).toMatchObject({ x: 50, y: 50 });
    expect(spawns.some((s) => s.x !== 50 || s.y !== 50)).toBe(true);
  });

  it('normalises a reversed archetype range (min > max)', () => {
    const spawns = planGroupSpawns(
      [rangedGroup({ startX: 0, startY: 0 })],
      false,
      () => 0.5,
      configWith({ startXMin: 300, startXMax: 100, startYMin: 400, startYMax: 200 }),
    );
    expect(spawns[0].startX).toBe(200);
    expect(spawns[0].startY).toBe(300);
  });

  it('each group in a wave gets its own independent random base', () => {
    // Two axes per group: group 1 draws 0, group 2 draws 1.
    const draws = [0.0, 0.0, 1.0, 1.0];
    let i = 0;
    const spawns = planGroupSpawns(
      [
        rangedGroup({ startX: 0, startY: 0 }),
        rangedGroup({ startX: 0, startY: 0 }),
      ],
      false,
      () => draws[i++] ?? 0,
      configWith({ startXMin: 0, startXMax: 100, startYMin: 0, startYMax: 100 }),
    );
    expect(spawns[0].startX).toBe(0);
    expect(spawns[1].startX).toBe(100);
  });
});

// ── 10-wave mini-boss gating verification harness (AH-0MVCRAHWO0007US2) ──
//
// Test-first verification for the expanded campaign (epic AH-0MVCC8XSS007P01Z):
// WaveManager must identify each level's 10th wave as its mini-boss encounter
// and hold the level until that mini-boss is defeated, while the final boss
// still triggers after Level 10 (item AH-0MVCRAV3B0069AIJ).
//
// The mini-boss wave is flagged `miniBoss: true` on the 10th `WaveDefinition`
// and the manager exposes the encounter through its per-level mini-boss
// accessors (`miniBossTriggered`/`miniBossActive`/`miniBossDefeated`, named in
// AH-0MVCRAV3B0069AIJ AC1). The gating tests below pin the manager's
// state-machine semantics with custom 10-wave levels and are GREEN since the
// gating landed (AH-0MVCRAV3B0069AIJ). The shipped-campaign test
// (`LEVELS` exposing exactly 10 waves per level) still runs under
// `it.fails(...)`: it depends on the 10-wave **data** (`Formations.ts`
// `LEVELS`), whose deliverable was re-landed by AH-0MVCYANT6003SG5C, so the
// pin now runs as a plain `it` and hard-gates the shipped shape.
describe('WaveManager — 10-wave mini-boss gating harness (AH-0MVCRAHWO0007US2)', () => {
  /**
   * A 10-wave level whose 10th wave is flagged as the mini-boss encounter.
   */
  function tenWaveMiniBossLevel(n: number, name: string): LevelDefinition {
    const waves: WaveDefinition[] = [];
    for (let w = 1; w <= 9; w++) {
      waves.push(wave('scout', 'v', 2, n >= 4));
    }
    waves.push({
      ...wave('raider', 'single', 1, n >= 4),
      miniBoss: true,
    });
    return level(n, name, waves);
  }

  it('AC1/AC4 — the shipped campaign exposes exactly 10 waves per level', () => {
    const wm = new WaveManager();
    wm.beginGame();
    for (let n = 1; n <= LEVEL_COUNT; n++) {
      expect(wm.waveCount, `L${n} exposed wave count`).toBe(10);
      if (n < LEVEL_COUNT) {
        expect(clearLevel(wm)).toBe('levelCleared');
      }
    }
  });

  it('AC4 — a level advances only after its wave-10 mini-boss is wiped', () => {
    const wm = new WaveManager([
      tenWaveMiniBossLevel(1, 'Entry'),
      tenWaveMiniBossLevel(2, 'Descent'),
    ]);
    wm.beginGame();

    // The 8 leading regular waves each wipe cleanly within Level 1.
    for (let w = 0; w < 8; w++) {
      expect(clearWave(wm), `wave ${w + 1} must clear`).toBe('waveCleared');
      expect(wm.level, `L1 must not advance on wave ${w + 1}`).toBe(1);
    }

    // Wiping the 9th regular wave brings the wave-10 mini-boss current; the
    // manager exposes the encounter and still holds the level.
    void clearWave(wm);
    expect(wm.waveNumber).toBe(10);
    expect(wm.miniBossTriggered, 'wave-10 mini-boss must be flagged').toBe(true);
    expect(wm.miniBossActive, 'wave-10 mini-boss must be active').toBe(true);
    expect(wm.level).toBe(1);

    // Defeating the mini-boss is what advances the level.
    expect(clearWave(wm)).toBe('levelCleared');
    expect(wm.level).toBe(2);
    expect(wm.miniBossDefeated, 'defeated flag must latch').toBe(true);
  });

  it('AC4 — the final boss still triggers after Level 10\'s mini-boss is defeated', () => {
    const wm = new WaveManager([tenWaveMiniBossLevel(10, 'The Gauntlet')]);
    wm.beginGame();

    for (let w = 0; w < 8; w++) {
      expect(clearWave(wm), `wave ${w + 1} must clear`).toBe('waveCleared');
    }
    void clearWave(wm); // wave 9 → wave 10 (the mini-boss)

    expect(wm.miniBossActive, 'Level-10 mini-boss must be active').toBe(true);
    expect(wm.bossTriggered, 'final boss is not due while the mini-boss is up').toBe(false);

    // Defeating the Level-10 mini-boss triggers the final boss, exactly as
    // the pre-mini-boss campaign did after clearing Level 10.
    expect(clearWave(wm)).toBe('bossTriggered');
    expect(wm.bossTriggered).toBe(true);
    expect(wm.miniBossDefeated, 'L10 mini-boss defeat must latch').toBe(true);
  });

  // AC5 — the extra gating edge cases pinned by AH-0MVCRAV3B0069AIJ.
  it('AC5 — a wave-10 that is NOT flagged miniBoss never hangs and clears normally', () => {
    // Ten regular waves; the 10th carries no mini-boss marker. The gating is
    // flag-driven, so the unmarked last wave must progress exactly like any
    // other wave (waveCleared → levelCleared) and never hang the run.
    const plainTen = (): LevelDefinition =>
      level(1, 'Plain', [
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('scout', 'v', 2),
        wave('raider', 'single', 1),
      ]);
    // Two levels so the first level's unmarked wave-10 clear emits
    // `levelCleared` (not the final-level `bossTriggered`).
    const wm = new WaveManager([plainTen(), { ...plainTen(), level: 2, name: 'Second' }]);
    wm.beginGame();

    for (let w = 0; w < 8; w++) {
      expect(clearWave(wm)).toBe('waveCleared');
    }
    expect(wm.waveNumber).toBe(9);
    expect(wm.miniBossTriggered).toBe(false);
    expect(wm.miniBossActive).toBe(false);

    // The 10th unmarked wave is a regular wave: wiping it clears the level.
    expect(clearWave(wm)).toBe('waveCleared');
    expect(wm.waveNumber).toBe(10);
    expect(wm.miniBossActive).toBe(false);
    expect(clearWave(wm)).toBe('levelCleared');
    expect(wm.miniBossDefeated).toBe(false);
  });

  it('AC5 — the mini-boss encounter resets per level (each level owns its own)', () => {
    const wm = new WaveManager([
      tenWaveMiniBossLevel(1, 'Entry'),
      tenWaveMiniBossLevel(2, 'Descent'),
    ]);
    wm.beginGame();

    // Clear L1 waves 1-9, then the L1 mini-boss → L2 wave 1.
    for (let w = 0; w < 9; w++) {
      expect(clearWave(wm)).toBe('waveCleared');
    }
    expect(wm.miniBossActive).toBe(true);
    expect(clearWave(wm)).toBe('levelCleared');

    // L2 wave 1 is current; L1's defeated flag may still latch, but
    // triggered/active must describe the CURRENT level (L2 wave 1 → no).
    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    expect(wm.miniBossTriggered).toBe(false);
    expect(wm.miniBossActive).toBe(false);

    // L2's mini-boss is its own encounter.
    for (let w = 0; w < 8; w++) {
      expect(clearWave(wm)).toBe('waveCleared');
    }
    void clearWave(wm);
    expect(wm.miniBossActive).toBe(true);
    expect(wm.level).toBe(2);
  });
});

// ── Campaign injection origin (AH-0MVLJF30O000E3J3) ──────────────

describe('WaveManager — campaign injection origin (AH-0MVLJF30O000E3J3)', () => {
  it('reports the built-in default campaign as not injected', () => {
    expect(new WaveManager().hasInjectedLevels).toBe(false);
  });

  it('records a caller-supplied campaign as injected by default', () => {
    const wm = new WaveManager();
    wm.setLevels([level(1, 'Injected', [wave('scout', 'v', 3)])]);
    expect(wm.hasInjectedLevels).toBe(true);
  });

  it('records a scene-resolved campaign as not injected (setLevels option)', () => {
    const wm = new WaveManager();
    wm.setLevels(
      [level(1, 'Resolved', [wave('scout', 'v', 3)])],
      { injected: false },
    );
    expect(wm.hasInjectedLevels).toBe(false);
  });

  it('setLevels still adopts the new campaign and resets the run', () => {
    const wm = new WaveManager();
    wm.beginGame();
    expect(wm.level).toBe(1);

    wm.setLevels([level(7, 'Seventh', [wave('tank', 'rect', 4)])]);
    // Reset: not started, back at level 1 of the new (single-level) campaign.
    expect(wm.level).toBe(1);
    expect(wm.levelCount).toBe(1);
    expect(wm.started).toBe(false);

    wm.beginGame();
    expect(wm.levelName).toBe('Seventh');
    expect(wm.waveCount).toBe(1);
  });
});
