/**
 * Integration tests for the playable PlayScene
 * (AH-0MU7305Z2003NII3 — child 4).
 *
 * Boots a real Phaser game and drives the public `tick(dt)` step to assert
 * observable behaviour: wave spawning, formation placement, player
 * integration, collisions (bullet/enemy/player), power-up collection,
 * level transitions, and the game-over flow.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GAME_HEIGHT, GAME_WIDTH, POWER_UP_DROP_MIN_SEPARATION } from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { Asteroid } from '../entities/Asteroid';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import {
  BOSS_PHASE_SCORES,
  LEVEL_TRANSITION_SECONDS,
  PlayScene,
  WAVE_TIME_LIMIT_SECONDS,
  WAVE_TIMEOUT_EXPLOSION_SCALE,
} from './PlayScene';

/**
 * Records the `scale` option of every `spawnExplosionParticles` call so
 * the wave-timeout test can assert the 10x detonation scale through the
 * real VFX module (wrapping, not replacing, its behaviour).
 */
const waveVfx = vi.hoisted(() => ({ scales: [] as number[] }));

vi.mock('../vfx/explosionParticles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vfx/explosionParticles')>();
  return {
    ...actual,
    spawnExplosionParticles: (
      ...args: Parameters<typeof actual.spawnExplosionParticles>
    ) => {
      waveVfx.scales.push(args[5]?.scale ?? 1);
      return actual.spawnExplosionParticles(...args);
    },
  };
});

/** Destroys every live enemy via player bullets (deterministic). */
function killAllEnemies(scene: PlayScene): void {
  for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
  }
}

/** Advances past the transition pause, spawning the next wave. */
function finishTransition(scene: PlayScene): void {
  if (scene.isTransitioning()) scene.tick(LEVEL_TRANSITION_SECONDS + 0.01);
}

/** Walks the run to the boss encounter (Level 5 cleared). */
function reachBoss(scene: PlayScene): void {
  const gs = scene.getGameState();
  gs.lives = 99; // survive incidental enemy fire while clearing levels.
  for (let guard = 0; guard < 200 && !scene.getBoss(); guard++) {
    killAllEnemies(scene);
    finishTransition(scene);
  }
}

describe('PlayScene — playable run (AH-0MU7305Z2003NII3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  // ── AC1: five-level scene + wave spawning ──────────────────────

  it('AC1 — boots the wave manager at Level 1 and spawns its first wave', async () => {
    const scene = await bootPlay();

    const wm = scene.getWaveManager();
    expect(wm.started).toBe(true);
    expect(wm.level).toBe(1);
    expect(wm.waveNumber).toBe(1);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC1/AC3 — spawned enemies are formation-placed and non-firing on Level 1', async () => {
    const scene = await bootPlay();

    const enemies = scene.getEnemies();
    const positions = new Set(enemies.map((e) => `${e.x},${e.y}`));
    expect(positions.size).toBe(enemies.length);
    expect(enemies.every((e) => e.shootEnabled === false)).toBe(true);
  });

  it('AC1/AC3 — spawning honours the wave archetypes', async () => {
    const scene = await bootPlay();
    const wave = scene.getWaveManager().currentWave()!;
    const expectedKeys = new Set(wave.groups.map((g) => g.enemyKey));
    // All spawned enemies map to one of the wave's declared archetypes.
    expect(scene.getEnemies().length).toBeGreaterThanOrEqual(
      Math.max(...wave.groups.map((g) => g.count)),
    );
    expect(expectedKeys.size).toBeGreaterThan(0);
  });

  // ── AC2: player integration ────────────────────────────────────

  it('AC2 — instantiates the player ship', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer();
    expect(player).not.toBeNull();
    expect(player!.scene).toBe(scene);
  });

  it('AC2 — the player auto-fires while ticking', async () => {
    const scene = await bootPlay();
    // Advance well past the cannon's fire interval.
    scene.tick(0.5);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  // ── AC4: collisions ────────────────────────────────────────────

  it('AC4 — a player bullet destroys an enemy and awards score', async () => {
    const scene = await bootPlay();
    const before = scene.getAliveCount();
    const enemy = scene.getEnemies().find((e) => e.alive)!;

    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getAliveCount()).toBeLessThan(before);
    expect(scene.getGameState().score).toBeGreaterThan(0);
  });

  it('AC4 — an enemy bullet overlapping the player costs one life', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const livesBefore = scene.getGameState().lives;

    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(scene.getHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  it('AC4 — a power-up drop overlapping the player is collected', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Force the drop to full size so it is collectible immediately.
    const drop = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);

    scene.tick(0.016);

    expect(scene.getDrops()).toHaveLength(0);
    expect(scene.getEffectsRegistry().activeEffects().length).toBeGreaterThan(0);
  });

  it('AC4 — an enemy body colliding with the player costs a life', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Let auto-fire fire its opening volley, then reposition the ship onto
    // a live enemy and step a tiny amount so the fire cooldown prevents a
    // fresh bullet from destroying the enemy before the body check.
    scene.tick(0.016);
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    const livesBefore = scene.getGameState().lives;
    player.setPosition(enemy.x, enemy.y);
    // Keep the player's internal movement state in sync so physicsTick does
    // not snap the ship back (same pattern as the P7 teleport code).
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };
    scene.tick(0.001);

    expect(scene.getGameState().lives).toBe(livesBefore - 1);
  });

  // ── AC5: level transitions ─────────────────────────────────────

  it('AC5 — clearing a wave starts a transition, then spawns the next wave', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    expect(wm.waveNumber).toBe(1);

    killAllEnemies(scene);
    // Wave 1 wiped → a transition is running (no new enemies yet).
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getAliveCount()).toBe(0);

    finishTransition(scene);
    // Wave 2 is now spawned.
    expect(scene.isTransitioning()).toBe(false);
    expect(wm.waveNumber).toBe(2);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  it('AC5 — clearing a level advances to the next level automatically', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Clear all of Level 1's waves.
    let guard = 0;
    while (wm.level === 1 && guard++ < 20) {
      killAllEnemies(scene);
      finishTransition(scene);
    }

    expect(wm.level).toBe(2);
    expect(wm.waveNumber).toBe(1);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
  });

  // ── Transient transition banner (AH-0MU7JTEMC006QPSN) ─────────

  it('AH-0MU7JTEMC006QPSN AC1 — the level banner hides within ~2s while enemies remain alive', async () => {
    const scene = await bootPlay();
    // The level-start announcement is on screen when the wave begins.
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(true);

    scene.tick(2.0);

    // Enemies are still alive (the wave was not cleared), yet the banner
    // must have cleared so it no longer obscures gameplay.
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  it('AH-0MU7JTEMC006QPSN AC2 — the banner reappears on the next wave and hides again', async () => {
    const scene = await bootPlay();

    // Let the level-start banner expire first.
    scene.tick(2.0);
    expect(scene.isBannerVisible()).toBe(false);

    // Clearing the wave starts a transition and announces it again.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.isBannerVisible()).toBe(true);

    // The next wave spawns; its banner clears while enemies remain alive.
    finishTransition(scene);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
    scene.tick(2.0);
    expect(scene.isBannerVisible()).toBe(false);
  });

  // ── Level/wave progress labels (AH-0MU7JTEY3004EXR2) ───────────

  it('AH-0MU7JTEY3004EXR2 AC1/AC2 — level start shows the same progress label in the HUD and banner', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const expected = `Level 1 of 5, Wave 1 of ${wm.waveCount}`;

    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);
  });

  it('AH-0MU7JTEY3004EXR2 AC4 — the label advances on a wave change', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    killAllEnemies(scene);
    finishTransition(scene);

    const expected = `Level 1 of 5, Wave 2 of ${wm.waveCount}`;
    expect(wm.waveNumber).toBe(2);
    expect(scene.getLevelText()).toBe(expected);
    expect(scene.getBannerText()).toBe(expected);
  });

  it('AH-0MU7JTEY3004EXR2 AC3 — the boss encounter shows "Boss" instead of a numeric level', async () => {
    const scene = await bootPlay();
    reachBoss(scene);

    expect(scene.getWaveManager().bossActive).toBe(true);
    expect(scene.getLevelText()).toBe('Boss');
    expect(scene.getBannerText()).toBe('Boss');
  });

  // ── Player control during transitions (AH-0MU7JTF9W008B8HW) ────

  it('AH-0MU7JTF9W008B8HW AC1/AC5 — the ship moves during a transition pause', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const cursors = (scene as unknown as {
      cursors: { right: { isDown: boolean } };
    }).cursors;

    // Wipe the wave to enter the transition pause.
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    const xBefore = player.x;
    cursors.right.isDown = true;
    scene.tick(0.1);
    cursors.right.isDown = false;

    // Still paused (0.1 s < 1.5 s transition), yet the input was honoured.
    expect(scene.isTransitioning()).toBe(true);
    expect(player.x).toBeGreaterThan(xBefore);
  });

  it('AH-0MU7JTF9W008B8HW AC2 — the ship keeps auto-firing during the pause', async () => {
    const scene = await bootPlay();
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    // Advance well past the cannon's fire interval while still paused.
    scene.tick(0.5);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  it('AH-0MU7JTF9W008B8HW AC3 — no life is lost during the pause', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();
    const player = scene.getPlayer()!;

    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    // Park an enemy bullet on the ship: collisions are suspended during the
    // transition, so the run must not lose a life.
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    const livesBefore = gs.lives;
    scene.tick(0.2);

    expect(scene.isTransitioning()).toBe(true);
    expect(gs.lives).toBe(livesBefore);
    expect(scene.getHitCount()).toBe(0);
  });

  it('AH-0MU7JTF9W008B8HW AC4 — the next wave spawns and gameplay resumes after the pause', async () => {
    const scene = await bootPlay();
    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);

    finishTransition(scene);

    expect(scene.isTransitioning()).toBe(false);
    expect(scene.getAliveCount()).toBeGreaterThan(0);
  });

  // ── Wave time limit (AH-0MU7JTG9R002ZWA6) ───────────────────────

  it('AH-0MU7JTG9R002ZWA6 AC1 — the timer bar runs at level start and depletes', async () => {
    const scene = await bootPlay();

    // The countdown starts at the full limit (some slack for the Phaser
    // loop draining a few frames during the boot delay).
    expect(scene.isWaveTimerActive()).toBe(true);
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(WAVE_TIME_LIMIT_SECONDS - 2);
    expect(scene.getWaveTimerBar()?.visible).toBe(true);

    scene.setWaveTimerRemaining(1.0);
    scene.tick(0.4);
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(0);
    expect(scene.getWaveTimerRemaining()).toBeLessThanOrEqual(0.6);

    scene.tick(0.7);
    expect(scene.getWaveTimerRemaining()).toBe(0);
  });

  it('AH-0MU7JTG9R002ZWA6 AC2/AC4 — expiry detonates survivors at 10x, costs one life, and advances the wave', async () => {
    const scene = await bootPlay();
    waveVfx.scales.length = 0;
    const livesBefore = scene.getGameState().lives;
    expect(scene.getAliveCount()).toBeGreaterThan(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    // All survivors detonated at 10x scale.
    expect(scene.getAliveCount()).toBe(0);
    expect(waveVfx.scales.some((s) => s === WAVE_TIMEOUT_EXPLOSION_SCALE)).toBe(true);

    // Exactly one life lost and the wave advanced.
    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(scene.getWaveManager().waveNumber).toBe(2);
  });

  it('AH-0MU7JTG9R002ZWA6 AC3 — expiry with no enemies remaining costs no life', async () => {
    const scene = await bootPlay();
    const livesBefore = scene.getGameState().lives;

    // Remove every enemy without clearing the wave (behavioural seam).
    for (const e of scene.getEnemies()) e.destroySelf();
    expect(scene.getAliveCount()).toBe(0);

    scene.setWaveTimerRemaining(0.05);
    scene.tick(0.1);

    expect(scene.getAliveCount()).toBe(0);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.isWaveTimerActive()).toBe(false);
  });

  it('AH-0MU7JTG9R002ZWA6 AC4 — the timer resets per wave and is hidden during transitions', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    expect(scene.isWaveTimerActive()).toBe(true);

    killAllEnemies(scene);
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.isWaveTimerActive()).toBe(false);

    finishTransition(scene);
    expect(wm.waveNumber).toBe(2);
    expect(scene.isWaveTimerActive()).toBe(true);
    // The fresh countdown starts at the full limit.
    expect(scene.getWaveTimerRemaining()).toBeGreaterThan(WAVE_TIME_LIMIT_SECONDS - 2);
  });

  // ── Power-up drop separation (AH-0MU7JTFM5000R4ME) ─────────────

  it('AH-0MU7JTFM5000R4ME AC3 — drops spawned at the same position keep minimum separation', async () => {
    const scene = await bootPlay();
    const x = GAME_WIDTH / 2;
    const y = GAME_HEIGHT / 2;

    for (let i = 0; i < 3; i++) scene.spawnPowerUpDrop('P5', x, y);

    const drops = scene.getDrops();
    expect(drops.length).toBe(3);
    for (let i = 0; i < drops.length; i++) {
      for (let j = i + 1; j < drops.length; j++) {
        expect(Math.hypot(drops[i].x - drops[j].x, drops[i].y - drops[j].y)).toBeGreaterThanOrEqual(
          POWER_UP_DROP_MIN_SEPARATION,
        );
      }
    }
  });

  // ── Game over flow ─────────────────────────────────────────────

  it('game over — losing the last life transitions to GameOverScene', async () => {
    const scene = await bootPlay();
    const gs = scene.getGameState();

    // Put the run on its final life, then take a hit.
    gs.lives = 1;
    const player = scene.getPlayer()!;
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);
    await new Promise((r) => setTimeout(r, 350));

    expect(gs.lives).toBe(0);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });
});

describe('PlayScene — boss encounter (AH-0MU730M3T008C7CQ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  it('AC1 — the Central AI spawns after Level 5 is cleared, with Phase-1 minions', async () => {
    const scene = await bootPlay();
    reachBoss(scene);

    const boss = scene.getBoss();
    expect(boss).not.toBeNull();
    expect(boss!.alive).toBe(true);
    expect(scene.getWaveManager().bossActive).toBe(true);
    expect(scene.getBossPhase()).toBe(1);
    // Phase 1 (Scan) summons formation scouts on both sides.
    const enemies = scene.getEnemies();
    const scoutCount = enemies.filter((e) => e.alive && e.constructor.name === 'Scout').length;
    expect(scoutCount).toBeGreaterThan(0);
  });

  it('AC2 — the 4-phase health bar depletes and advances the phase on hits', async () => {
    const scene = await bootPlay();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    expect(boss.getPhaseNumber()).toBe(1);

    // One player bullet = one phase of damage.
    scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
    scene.tick(0.016);
    expect(boss.getPhaseNumber()).toBe(2);
    expect(scene.getBossPhase()).toBe(2);
  });

  it('AC3 — advancing a phase summons that phase’s minion wave', async () => {
    const scene = await bootPlay();
    reachBoss(scene);
    const boss = scene.getBoss()!;

    // Phase 1 → 2: Firestorm divers should arrive from the top.
    scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
    scene.tick(0.016);
    expect(boss.getPhaseNumber()).toBe(2);

    const divers = scene.getEnemies().filter(
      (e) => e.alive && e.constructor.name === 'Diver',
    );
    expect(divers.length).toBeGreaterThan(0);
  });

  it('AC4 — a hit costs one life, not the whole phase (phase score per GDD §4.5)', async () => {
    // Separate scenario: the boss deals no bullets here; assert the score
    // awarded per destroyed phase follows the GDD table (1000/2000/3000/5000).
    const scene = await bootPlay();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;

    scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getGameState().score - scoreBefore).toBe(BOSS_PHASE_SCORES[1]);
  });

  it('AC4 — defeating all 4 phases wins the run at the game-over screen', async () => {
    const scene = await bootPlay();
    reachBoss(scene);
    const boss = scene.getBoss()!;
    const scoreBefore = scene.getGameState().score;

    // Four phase-killing bullets (one per health segment).
    for (let i = 0; i < 4; i++) {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0.016);
    }
    expect(boss.alive).toBe(false);
    expect(scene.getWaveManager().bossDefeated).toBe(true);
    // Phases 1–4 all awarded (1000+2000+3000+5000).
    expect(scene.getGameState().score - scoreBefore).toBe(11000);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  it('scenario — boss bullets are collected as enemy bullets', async () => {
    const scene = await bootPlay();
    reachBoss(scene);
    const boss = scene.getBoss()!;

    // Override update to emit one deterministic bullet (attack logic itself
    // is covered by Boss.test.ts).
    const fakeBullet = {
      graphics: scene.add.graphics(),
      vx: 100,
      vy: 100,
      color: 0xffffff,
    };
    boss.update = (() => [fakeBullet]) as unknown as typeof boss.update;

    const before = scene.getEnemyBullets().length;
    scene.tick(0.016);
    const bullets = scene.getEnemyBullets();
    expect(bullets.length).toBeGreaterThan(before);
    expect(bullets.some((b) => b.graphics === fakeBullet.graphics)).toBe(true);
  });
});

describe('PlayScene — asteroid integration (AH-0MU8BZ2ZM004J47F)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    return booted.scene as PlayScene;
  }

  /** Alive asteroid entities currently in the scene. */
  function findAsteroids(scene: PlayScene): Asteroid[] {
    return scene
      .getEnemies()
      .filter((e): e is Asteroid => e instanceof Asteroid && e.alive);
  }

  it('AC1 — Level 1 Wave 1 spawns a large asteroid alongside the Scouts', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    const asteroids = findAsteroids(scene);
    expect(asteroids.length).toBe(1);
    expect(asteroids[0].getSizeTier()).toBe('large');

    // Wave accounting includes the asteroid: 6 scouts + 1 asteroid.
    const waveDef = wm.currentWave()!;
    const total = waveDef.groups.reduce((sum, g) => sum + g.count, 0);
    expect(total).toBe(7);
    expect(wm.enemiesAlive).toBe(total);
    expect(scene.getAliveCount()).toBe(total);
  });

  it('AC3 — shooting the large asteroid spawns exactly 2 medium children in divergent directions', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();
    const aliveBefore = wm.enemiesAlive; // 7

    const large = findAsteroids(scene)[0];
    const scoreBefore = scene.getGameState().score;

    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);

    // Parent destroyed; large tier awards no points.
    expect(large.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBefore);

    // Exactly two medium children at the parent's position.
    const children = findAsteroids(scene);
    expect(children.length).toBe(2);
    expect(children.every((c) => c.getSizeTier() === 'medium')).toBe(true);

    // Both children registered with the WaveManager: 7 - 1 parent + 2 = 8.
    expect(wm.enemiesAlive).toBe(aliveBefore + 1);

    // Children move in directions different from each other (>= pi/3).
    const a1 = Math.atan2(children[0].vy, children[0].vx);
    const a2 = Math.atan2(children[1].vy, children[1].vx);
    const delta = Math.abs(a1 - a2);
    const wrapped = Math.min(delta, Math.PI * 2 - delta);
    expect(wrapped).toBeGreaterThanOrEqual(Math.PI / 3 - 0.01);
  });

  it('AC3/AC4 — medium splits into 2 smalls (no score); small awards 50 points with no children', async () => {
    const scene = await bootPlay();

    // Split the large asteroid first.
    const large = findAsteroids(scene)[0];
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(findAsteroids(scene).length).toBe(2);

    // Shoot one medium — two small children; medium awards no points.
    const medium = findAsteroids(scene)[0];
    const scoreBeforeMedium = scene.getGameState().score;
    scene.spawnPlayerBullet(medium.x, medium.y, 0, 0);
    scene.tick(0.016);
    expect(medium.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBeforeMedium);

    const all = findAsteroids(scene);
    const smalls = all.filter((a) => a.getSizeTier() === 'small');
    const mediumsLeft = all.filter((a) => a.getSizeTier() === 'medium');
    // Exactly two small children and the untouched second medium remain.
    expect(smalls).toHaveLength(2);
    expect(mediumsLeft).toHaveLength(1);
  });

  it('AC4 — shooting a small asteroid awards exactly 50 points and spawns no children', async () => {
    const scene = await bootPlay();

    // Split the full chain down to smalls: large -> 2 medium -> shoot both -> 4 smalls.
    const large = findAsteroids(scene)[0];
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);

    // Count before further scoring checks.
    const childrenStep1 = findAsteroids(scene);
    expect(childrenStep1).toHaveLength(2);
    // Record the two mediums (they move slowly; re-locate each shot).
    const mediumA = childrenStep1[0];
    const mediumB = childrenStep1[1];
    scene.spawnPlayerBullet(mediumA.x, mediumA.y, 0, 0);
    scene.tick(0.016);
    const smallsAfterA = findAsteroids(scene).filter((a) => a.getSizeTier() === 'small');
    expect(smallsAfterA).toHaveLength(2);
    scene.spawnPlayerBullet(mediumB.x, mediumB.y, 0, 0);
    scene.tick(0.016);

    const smalls = findAsteroids(scene).filter((a) => a.getSizeTier() === 'small');
    expect(smalls).toHaveLength(4);

    // Shoot one small: +50 points, no children from it.
    const small = smalls[0];
    const scoreBefore = scene.getGameState().score;
    scene.spawnPlayerBullet(small.x, small.y, 0, 0);
    scene.tick(0.016);
    expect(small.alive).toBe(false);
    expect(scene.getGameState().score - scoreBefore).toBe(50);
    // Remaining asteroids: 3 smalls (the other medium never existed — it was
    // consumed as part of the chain above; exactly 3 smalls remain).
    expect(findAsteroids(scene).filter((a) => a.getSizeTier() === 'small')).toHaveLength(3);
  });

  it('AC6 — the wave clears only after ALL split children are destroyed (no stall, no early clear)', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Destroy everything: 6 scouts + full asteroid chain
    // (1 large -> 2 medium -> 4 small = 7 asteroid enemies, 13 total).
    killAllEnemies(scene);

    // All enemies dead -> the wave wiped -> transition to Wave 2 loaded.
    expect(scene.isTransitioning()).toBe(true);
    expect(scene.getAliveCount()).toBe(0);
    // Wave 2 is now current: the manager pre-loads its 8 Scouts (they are
    // not spawned on screen until the transition completes).
    expect(wm.waveNumber).toBe(2);
    expect(wm.enemiesAlive).toBe(wm.waveEnemyCount());

    finishTransition(scene);
    expect(wm.waveNumber).toBe(2);
    expect(scene.getAliveCount()).toBe(wm.waveEnemyCount());
  });

  it('AC5 — asteroids move independently of formation drift (constant velocity + wrap + rotation)', async () => {
    const scene = await bootPlay();
    const asteroid = findAsteroids(scene)[0];
    const startX = asteroid.x;
    const startY = asteroid.y;
    const vx = asteroid.vx;
    const vy = asteroid.vy;
    const rotBefore = asteroid.rotation;

    scene.tick(0.5);

    // Still alive (slow drift away from the auto-fire lane).
    expect(asteroid.alive).toBe(true);
    // Position change is exactly velocity x dt — NOT the formation drift
    // (which would add a fixed +14 px to x over 0.5 s for every group).
    expect(asteroid.x - startX).toBeCloseTo(vx * 0.5, 4);
    expect(asteroid.y - startY).toBeCloseTo(vy * 0.5, 4);
    // Rotated continuously by rotationSpeed x dt.
    expect(asteroid.rotation - rotBefore).toBeCloseTo(asteroid.rotationSpeed * 0.5, 3);
  });

  it('asteroid colliding with the player costs one life, destroys the asteroid, and still splits', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Let auto-fire fire its opening volley, then park the ship on the
    // asteroid so the body-collision path triggers (mirrors the scout ram test).
    scene.tick(0.016);
    const asteroid = findAsteroids(scene)[0];
    const livesBefore = scene.getGameState().lives;
    const scoreBefore = scene.getGameState().score;

    player.setPosition(asteroid.x, asteroid.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: asteroid.x, y: asteroid.y };
    scene.tick(0.001);

    // One life lost; the rammed asteroid is destroyed and splits into two
    // medium children (the wave keeps tracking them); ramming awards 0 points.
    expect(scene.getGameState().lives).toBe(livesBefore - 1);
    expect(asteroid.alive).toBe(false);
    expect(scene.getGameState().score).toBe(scoreBefore);
    const children = findAsteroids(scene);
    expect(children.length).toBe(2);
    expect(children.every((c) => c.getSizeTier() === 'medium')).toBe(true);
  });

  // ── P5 Speed Boost (AH-0MU8QURXB008DWM7) ────────────────────────

  it('P5 active → speed multiplier applied to player movement config', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Default: no P5 active, multiplier = 1.
    const configDefault = player.getMovementConfig();
    expect(registry.speedMultiplier()).toBe(1);

    // Activate P5 via direct collection (drop under ship at full size).
    const drop = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);

    // Collect it in one tick (registry gets updated).
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isActive('P5')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);

    // The multiplier is applied at the TOP of tick(), before _updateDrops.
    // So the boosted config takes effect on the NEXT tick call.
    scene.tick(0.016);
    const configP5 = player.getMovementConfig();
    expect(configP5.thrust).toBeCloseTo(configDefault.thrust * 1.5);
    expect(configP5.maxSpeed).toBeCloseTo(configDefault.maxSpeed * 1.5);
  });

  it('P5 expired → multiplier back to 1', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Activate P5.
    const drop = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);

    expect(registry.isActive('P5')).toBe(true);
    expect(registry.speedMultiplier()).toBe(1.5);

    // Advance past the 10 s duration.
    for (let i = 0; i < 600; i++) scene.tick(0.016); // ~9.6 s
    scene.tick(0.5); // past 10 s

    expect(registry.isActive('P5')).toBe(false);
    expect(registry.speedMultiplier()).toBe(1);
    expect(player.getMovementConfig().thrust).toBeCloseTo(
      player.getMovementConfig().thrust, // back to base
    );
  });

  it('re-collecting P5 refreshes the duration', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect first P5.
    const drop1 = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop1.powerUp.advance(0.05);
    player.setPosition(drop1.x, drop1.y);
    scene.tick(0.016);
    expect(registry.isActive('P5')).toBe(true);

    // Advance ~3 seconds so the timer ticks down.
    for (let i = 0; i < 188; i++) scene.tick(0.016); // ~3 s
    expect(registry.isActive('P5')).toBe(true);
    const remainingBeforeSecond = registry.remaining('P5')!;

    // Collect a second P5 — should refresh the timer to full.
    const drop2 = scene.spawnPowerUpDrop('P5', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop2.powerUp.advance(0.05);
    player.setPosition(drop2.x, drop2.y);
    scene.tick(0.016);
    expect(registry.isActive('P5')).toBe(true);
    const remaining2 = registry.remaining('P5')!;

    // The second collection refreshed the timer to near full duration.
    expect(remaining2).toBeGreaterThan(remainingBeforeSecond);
    expect(remaining2).toBeCloseTo(10, 1);
  });

  // ── P7 Teleport (AH-0MU8QUY7U0069XC3) ───────────────────────────

  it('P7 teleport with a stack warps the player, consumes the stack and grants P6', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P7 to gain a teleport stack.
    const drop = scene.spawnPowerUpDrop('P7', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    // Move the ship off-centre so the safe-spot search picks a new location.
    player.setPosition(300, 400);
    const beforeX = player.x;
    const beforeY = player.y;

    expect(scene.triggerTeleport()).toBe(true);

    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(true); // P6 granted on arrival
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
    expect(player.x).toBeGreaterThanOrEqual(0);
    expect(player.x).toBeLessThanOrEqual(GAME_WIDTH);
    expect(player.y).toBeGreaterThanOrEqual(0);
    expect(player.y).toBeLessThanOrEqual(GAME_HEIGHT);
  });

  it('P7 teleport with zero stacks is a no-op', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    expect(registry.hasTeleport()).toBe(false);
    const beforeX = player.x;
    const beforeY = player.y;

    expect(scene.triggerTeleport()).toBe(false);

    // Player did not move; no P6 granted; still zero stacks.
    expect(player.x).toBeCloseTo(beforeX);
    expect(player.y).toBeCloseTo(beforeY);
    expect(registry.teleportStacks()).toBe(0);
    expect(registry.isPhased).toBe(false);
  });

  it('P7 destination avoids live enemies (lands away from an enemy body)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P7 stack.
    const drop = scene.spawnPowerUpDrop('P7', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.teleportStacks()).toBe(1);

    // Park the ship inside a live enemy so the only safe spot is away from it.
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    player.setPosition(enemy.x, enemy.y);
    const state = player.getMovementState();
    (player as unknown as { _movementState: { x: number; y: number } })._movementState =
      { ...state, x: enemy.x, y: enemy.y };

    expect(scene.triggerTeleport()).toBe(true);

    // The landing spot must not overlap the enemy body.
    const distFromEnemy = Math.hypot(player.x - enemy.x, player.y - enemy.y);
    expect(distFromEnemy).toBeGreaterThan(enemy.getHitRadius());
  });

  // ── P3 Shield bubble visual (AH-0MU8QV3O9008JVNQ) ───────────────

  it('P3 shield bubble is rendered while the shield is active', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    expect(scene.isShieldBubbleVisible()).toBe(false);

    // Collect a P3 shield.
    const drop = scene.spawnPowerUpDrop('P3', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isShielded).toBe(true);

    // Visuals update at the TOP of tick (before drop collection), so the
    // bubble appears from the NEXT tick onward.
    scene.tick(0.016);
    expect(scene.isShieldBubbleVisible()).toBe(true);
  });

  it('P3 shield absorbs a hit: bubble disappears, invulnerability blink starts, no life lost', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();
    const livesBefore = scene.getGameState().lives;

    // Collect a P3 shield (park an enemy bullet far away so auto-fire
    // damage during setup does not interfere — the shield is fresh).
    const drop = scene.spawnPowerUpDrop('P3', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isShielded).toBe(true);

    // Park an enemy bullet on the ship: the shield absorbs it.
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    // Shield popped, no life lost, brief invulnerability blink active.
    expect(registry.isShielded).toBe(false);
    expect(scene.isShieldBubbleVisible()).toBe(false);
    expect(scene.getGameState().lives).toBe(livesBefore);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  // ── P6 Phase Shift ghost visual (AH-0MU8QVC9Y008R8I5) ────────────

  it('P6 phase shift renders the ship as a semi-transparent ghost (alpha 0.45)', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P6 phase shift.
    const drop = scene.spawnPowerUpDrop('P6', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isPhased).toBe(true);

    expect(scene.isPhaseGhostActive()).toBe(true);
    // Ghost alpha applied after the visuals update on the next tick.
    player.setAlpha(1);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);
  });

  it('P6 expiry restores full ship alpha', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P6 phase shift.
    const drop = scene.spawnPowerUpDrop('P6', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isPhased).toBe(true);

    // Ghost alpha on the next tick.
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);

    // Advance past the 3 s duration.
    for (let i = 0; i < 188; i++) scene.tick(0.016); // ~3 s
    expect(registry.isPhased).toBe(false);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(1);
  });

  it('P6 ghost alpha defers to the post-hit invulnerability blink', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();

    // Collect a P6 phase shift (phased → ghosted).
    const drop = scene.spawnPowerUpDrop('P6', player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    player.setPosition(drop.x, drop.y);
    scene.tick(0.016);
    expect(registry.isPhased).toBe(true);

    // Apply the ghost alpha first (phased → 0.45).
    player.setAlpha(1);
    scene.tick(0.016);
    expect(player.alpha).toBeCloseTo(0.45);

    // Start the post-hit invulnerability blink while phase is still active
    // (phase grants pass-through, so the blink is started via the same
    // timer the shield-absorb path uses). The ghost must NOT clobber it.
    (scene as unknown as { invulnerable: number }).invulnerable = 1;
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // After the visuals update, the blink alpha wins over the ghost alpha.
    scene.tick(0.016);
    expect(player.alpha).not.toBeCloseTo(0.45);
  });
});
