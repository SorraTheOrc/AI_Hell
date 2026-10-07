/**
 * GymMinerals tests (AH-0MUBVGI62004ED9Q).
 *
 * Covers the asteroids-only mineral gym launching from the index convention
 * and the 100-mineral seeding applied to the gym scenes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GymMinerals } from './GymMinerals';
import { GymEnemies } from './GymEnemies';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import type { ChoiceContext, ChoiceOption } from '../../powerups/choice';
import type { FormationSceneBullet } from './core/GymFormationScene';
import { Asteroid } from '../../entities/Asteroid';
import { DEFAULT_MINERAL_HOLD_CAPACITY } from '../../core/rules';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';

/** Live asteroid entities of the given tier in a mineral gym. */
function liveAsteroids(scene: GymMinerals): Asteroid[] {
  return scene.formationEntities.filter(
    (e): e is Asteroid => e instanceof Asteroid && e.alive,
  );
}

/** Empties the player-bullet list so only the test's bullet can hit a target. */
function clearPlayerBullets(scene: GymMinerals): void {
  (scene as unknown as { playerBullets: unknown[] }).playerBullets.length = 0;
}

/** Removes every live mineral from the field (via the public collect seam). */
function clearMinerals(scene: GymMinerals): void {
  for (const mineral of scene.getMinerals()) mineral.handleOverlap('player');
  scene.tick(0.016);
}

describe('GymMinerals', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('seeds 100 random minerals on create', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;

    expect(scene.getSeededMineralCount()).toBe(100);
    // The field starts densely populated (some may be collected by the
    // running demo loop before the assertion).
    expect(scene.getMinerals().length).toBeGreaterThan(80);
    expect(scene.getMineralHold()).toBeGreaterThanOrEqual(0);
    expect(scene.getMineralCapacity()).toBe(DEFAULT_MINERAL_HOLD_CAPACITY);
    expect(scene.getMineralCapacity()).toBe(5);
  });

  it('shows the mineral hold bar on the HUD', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;

    const bar = scene.getHUD()?.getMineralBarState();
    expect(bar?.visible).toBe(true);
    expect(bar?.total).toBeGreaterThan(0);
    expect(bar?.filled).toBeGreaterThanOrEqual(0);
    expect(bar?.filled).toBeLessThanOrEqual(bar!.total);
    // The bar reflects the same authoritative hold the gym tracks.
    expect(scene.getHUD()?.getMineralStoreValue().capacity).toBe(
      scene.getMineralCapacity(),
    );
  });

  it('the player collects an overlapping mineral into the hold', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    const player = scene.getPlayer()!;
    const mineral = scene.getMinerals()[0];

    mineral.setPosition(player.x, player.y);
    scene.tick(0.016);

    expect(scene.getMineralHold()).toBeGreaterThanOrEqual(1);
  });

  it('AC5 — the shared P10 scoop pulls an in-range mineral toward the ship', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    const player = scene.getPlayer()!;
    const registry = scene.getEffectsRegistry();
    // Two permanent scoop stacks → radius 1×20×(1+0.5×2) = 40 px.
    registry.applyCollect('P10', true);
    registry.applyCollect('P10', true);

    const mineral = scene.getMinerals()[0];
    mineral.setPosition(player.x + 30, player.y);
    const before = mineral.x;
    scene.tick(0.1); // ~12 px of pull at MAGNET_ATTRACTION_SPEED

    expect(mineral.x).toBeLessThan(before);
    expect(mineral.x).toBeCloseTo(player.x + 30 - 12, 0);
  });

  it('P6 phase blocks mineral collection and resumes on expiry (Q7)', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    const player = scene.getPlayer()!;
    const mineral = scene.getMinerals()[0];

    // Park the mineral on the ship and phase the player.
    mineral.setPosition(player.x, player.y);
    const holdBefore = scene.getMineralHold();
    scene.getEffectsRegistry().applyPhaseShift();
    scene.tick(0.016);

    // While phased the mineral is not collected and stays on the field.
    expect(scene.getMineralHold()).toBe(holdBefore);
    expect(scene.getMinerals()).toContain(mineral);

    // Advance past the 1.5 s phase: collection resumes immediately.
    for (let i = 0; i < 100; i += 1) scene.tick(0.016);
    expect(scene.getMineralHold()).toBeGreaterThan(holdBefore);
  });

  it('is discovered by the gym index as "Minerals"', () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymMinerals.ts': { GymMinerals },
    });
    expect(entries.map((e) => e.key)).toContain('GymMinerals');
    expect(entries.map((e) => e.label)).toContain('Minerals');
  });

  it('existing gym scenes are seeded with 100 minerals too', async () => {
    booted = await bootScene([GymEnemies, MineralChoiceScene]);
    const scene = booted.scene as GymEnemies;

    expect(scene.getSeededMineralCount()).toBe(100);
    expect(scene.getMinerals().length).toBeGreaterThan(80);
  });

  it('a destroyed small asteroid drops exactly one mineral at its position (AC1)', async () => {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    // Complete the wormhole spawn animation so the asteroids are collidable.
    scene.finishSpawnAnimations();
    scene.tick(0.001);
    clearMinerals(scene);
    expect(scene.getMinerals()).toHaveLength(0);

    // Large → no direct drop (it splits into two mediums instead).
    const large = liveAsteroids(scene).find(
      (a) => a.getSizeTier() === 'large',
    )!;
    clearPlayerBullets(scene);
    scene.spawnPlayerBullet(large.x, large.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getMinerals()).toHaveLength(0);

    // Medium → no direct drop either (it splits into two smalls).
    const medium = liveAsteroids(scene).find(
      (a) => a.getSizeTier() === 'medium',
    )!;
    clearPlayerBullets(scene);
    scene.spawnPlayerBullet(medium.x, medium.y, 0, 0);
    scene.tick(0.016);
    expect(scene.getMinerals()).toHaveLength(0);

    // Small → exactly one mineral at the death position.
    const small = liveAsteroids(scene).find(
      (a) => a.getSizeTier() === 'small',
    )!;
    // Remove every other live asteroid so the bullet can only hit the target
    // (siblings spawn on top of each other in the split chain).
    for (const other of liveAsteroids(scene)) {
      if (other !== small) other.destroySelf();
    }
    const sx = small.x;
    const sy = small.y;
    clearPlayerBullets(scene);
    scene.spawnPlayerBullet(small.x, small.y, 0, 0);
    scene.tick(0.016);

    const minerals = scene.getMinerals();
    expect(minerals).toHaveLength(1);
    // The drop is at the death site; the asteroid advances one tick before the
    // collision resolves, so allow for that single-tick drift.
    expect(Math.hypot(minerals[0].x - sx, minerals[0].y - sy)).toBeLessThanOrEqual(2);
  });
});

/**
 * Hold-full choice → P7 teleport and P3/P6 hit-gating in the minerals gym
 * (AH-0MUHMXWGC0058BO4 · AC1/AC2/AC3/AC4).
 *
 * The minerals gym omits the opt-in field power-up layer, so it is the
 * regression surface for "rewards granted by the hold-full choice must
 * actually work".
 */
describe('GymMinerals — hold-full rewards are functional', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Clears the seeded minerals so a stationary player never fills the hold. */
  function clearMinerals(scene: GymMinerals): void {
    (scene as unknown as { minerals: unknown[] }).minerals.length = 0;
  }

  /** Parks a stationary enemy bullet on the player's current position. */
  function placeEnemyBulletOnPlayer(scene: GymMinerals): void {
    const player = scene.getPlayer()!;
    const graphics = scene.add.graphics();
    graphics.setPosition(player.x, player.y);
    (scene as unknown as { bullets: FormationSceneBullet[] }).bullets.push({
      graphics,
      vx: 0,
      vy: 0,
      lifetime: 999,
      elapsed: 0,
    });
  }

  /** Grants one effect through the hold-full choice path. */
  function grantViaChoice(scene: GymMinerals, option: ChoiceOption): void {
    scene.setMineralChoiceStrategy({ choose: () => [option] });
    scene.openMineralChoice();
    scene.selectMineralChoice(0);
  }

  async function bootMinerals(): Promise<GymMinerals> {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    const scene = booted.scene as GymMinerals;
    clearMinerals(scene);
    // A stationary ship must not auto-fire a bullet that could intercept the
    // parked enemy bullet before it reaches the player.
    vi.spyOn(scene.getPlayer()!, 'tryFire').mockReturnValue([]);
    return scene;
  }

  it('the hold-full choice displays and applies the same option (AC1)', async () => {
    const scene = await bootMinerals();
    const offered: ChoiceOption[] = [
      { id: 'dual', name: 'Dual Shot', kind: 'weapon' },
      { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
      { id: 'P9', name: 'Magnet', kind: 'powerup' },
    ];
    scene.setMineralChoiceStrategy({ choose: () => offered });
    const drawn = scene.openMineralChoice();

    await new Promise((resolve) => setTimeout(resolve, 80));
    const overlay = booted!.game.scene.getScene(
      'MineralChoiceScene',
    ) as MineralChoiceScene;
    expect(overlay.getOptions()).toEqual(drawn);

    overlay.select(0);
    expect(scene.getPlayer()!.hasWeapon('dual')).toBe(true);
  });

  it('the hold-full choice receives the player permanent weapon levels (AC1/AC2)', async () => {
    const scene = await bootMinerals();
    const player = scene.getPlayer()!;
    // Permanent grants only: a field pickup's temporary level is not priced.
    player.equipWeapon('spread', true);
    player.equipWeapon('spread', true);
    player.equipWeapon('rapid', true);

    let captured: ChoiceContext | undefined;
    scene.setMineralChoiceStrategy({
      choose: (_count, _rng, context) => {
        captured = context;
        return [{ id: 'spread', name: 'Spread Shot', kind: 'weapon' }];
      },
    });
    scene.openMineralChoice();

    expect(captured?.weaponLevels).toEqual([
      { id: 'spread', level: 2 },
      { id: 'rapid', level: 1 },
    ]);
  });

  it('AC2 — P7 granted by the choice teleports on S/↓ and grants P6', async () => {
    const scene = await bootMinerals();
    const player = scene.getPlayer()!;
    grantViaChoice(scene, { id: 'P7', name: 'Teleport', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.hasTeleport()).toBe(true);

    // Move off the grid-centre fallback so the safe-spot search must pick a
    // genuinely different landing position.
    player.setPosition(300, 400);
    const beforeX = player.x;
    const beforeY = player.y;

    // Press S (JustDown) and advance one deterministic tick.
    const key = (
      scene as unknown as { teleportKey: Phaser.Input.Keyboard.Key | null }
    ).teleportKey;
    expect(key).not.toBeNull();
    (key as unknown as { _justDown: boolean })._justDown = true;
    scene.tick(0.016);

    expect(registry.hasTeleport()).toBe(false);
    expect(registry.isPhased).toBe(true);
    expect(Math.hypot(player.x - beforeX, player.y - beforeY)).toBeGreaterThan(0);
  });

  it('AC3 — P6 Protects against enemy bullets in the minerals gym', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P6', name: 'Phase Shift', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.updateDanger(true, 0.016)).toBe(true);
    expect(registry.isPhased).toBe(true);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.isPlayerInvulnerable()).toBe(false);
  });

  it('AC3 — P6 phase also passes the player through enemy bodies', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P6', name: 'Phase Shift', kind: 'powerup' });
    expect(scene.getEffectsRegistry().updateDanger(true, 0.016)).toBe(true);
    expect(scene.getEffectsRegistry().isPhased).toBe(true);

    const target = scene.formationEntities.find((e) => e.alive)!;
    const player = scene.getPlayer()!;
    player.setPosition(target.x, target.y);
    scene.tick(0.016);

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(target.alive).toBe(true);
  });

  it('AC4 — P3 absorbs the first hit, then the next hit registers', async () => {
    const scene = await bootMinerals();
    grantViaChoice(scene, { id: 'P3', name: 'Shield', kind: 'powerup' });

    const registry = scene.getEffectsRegistry();
    expect(registry.isShielded).toBe(true);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(0);
    expect(registry.isShielded).toBe(false);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // Wait out the invulnerability window, then the next hit lands.
    for (let i = 0; i < 20; i += 1) scene.tick(0.2); // 4 s
    expect(scene.isPlayerInvulnerable()).toBe(false);

    placeEnemyBulletOnPlayer(scene);
    scene.tick(0.05);
    expect(scene.getPlayerHitCount()).toBe(1);
  });
});

describe('GymMinerals — restart/teardown parity (AH-0MUII3FYN0072QRT, gap 10)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootMinerals(): Promise<GymMinerals> {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    return booted.scene as GymMinerals;
  }

  it('AC1 — a same-instance stop/restart clears permanent effects granted via the hold-full choice', async () => {
    const scene = await bootMinerals();
    const registry = scene.getEffectsRegistry();

    // The minerals gym has no field-drop layer, so this is the exact
    // stale-registry vector from gap 10: apply a permanent effect as the
    // hold-full choice does, then stop/restart the same instance.
    registry.applyCollect('P9', true);
    registry.applyWeapon('spread', true);
    registry.applyCollect('P7');
    expect(registry.magnetStacks()).toBe(1);
    expect(registry.activeWeapons()).toHaveLength(1);
    expect(registry.hasTeleport()).toBe(true);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(registry.magnetStacks()).toBe(0);
    expect(registry.activeWeapons()).toHaveLength(0);
    expect(registry.hasTeleport()).toBe(false);

    expect(() => scene.create()).not.toThrow();
    expect(scene.getEffectsRegistry()).toBe(registry);
    expect(registry.activeEffects()).toHaveLength(0);
    expect(registry.activeWeapons()).toHaveLength(0);
    expect(registry.magnetStacks()).toBe(0);
    expect(registry.hasTeleport()).toBe(false);
    // The mineral layer is re-seeded cleanly on the restart.
    expect(scene.getSeededMineralCount()).toBe(100);
  });
});

describe('GymMinerals — shared wave-timeout (AH-0MUNR5LM1004B223)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymMinerals> {
    booted = await bootScene([GymMinerals, MineralChoiceScene]);
    return booted.scene as GymMinerals;
  }

  it('AC1 — the minerals gym arms the shared wave-timeout on create', async () => {
    const scene = await boot();

    expect(scene.isWaveTimeoutActive()).toBe(true);
    expect(scene.getWaveTimeoutRemaining()).toBeGreaterThan(0);
    expect(scene.getWaveTimeoutRemaining()).toBeLessThanOrEqual(
      WAVE_TIME_LIMIT_SECONDS,
    );
  });

  it('AC2 — asteroids survive the timeout silently and the formation refreshes', async () => {
    const scene = await boot();
    const initial = liveAsteroids(scene);
    const before = initial.length;
    expect(before).toBeGreaterThan(0);

    scene.setWaveTimeoutRemaining(0.05);
    scene.tick(0.1);

    // Nothing detonates: the retired major-explosion cue never plays, and the
    // asteroids persist (carry-over, AH-0MUNS3ZQ1002DJ9S). The player's
    // continuous auto-fire may destroy some during the countdown, so assert
    // the field is not wiped by the timeout rather than tracking identities.
    expect(liveAsteroids(scene).length).toBeGreaterThan(0);
    expect(scene.isWaveTimeoutActive()).toBe(false);
    expect(scene.isRespawnCountdownActive()).toBe(true);

    // The shared 3 s countdown refreshes the field with a fresh formation
    // alongside the survivors and restarts the window.
    scene.tick(1);
    scene.tick(1);
    scene.tick(1);
    expect(scene.isRespawnCountdownActive()).toBe(false);
    expect(liveAsteroids(scene).length).toBeGreaterThanOrEqual(before);
    expect(scene.isWaveTimeoutActive()).toBe(true);
  });

  it('AC2 — a visible timer bar shows while the timeout counts down', async () => {
    const scene = await boot();
    scene.tick(0.016);

    expect(scene.getWaveTimeoutBar()?.visible).toBe(true);
  });
});
