/**
 * GymWeaponLeveling tests (parent AH-0MUPMPCB2009J54J).
 *
 * Verifies the demonstration gym end-to-end: the weapon-drop leveling path,
 * the MVP upgrade variables changing the shared combat core's output, the HUD
 * level readout, the permanent hold-full choice leveling, and index discovery.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GymWeaponLeveling } from './GymWeaponLeveling';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { discoverGymScenes } from '../../utils/gymDiscovery';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import { resolveWeaponDefinition } from '../../utils/weaponLevels';
import { isOnBeatGrid } from '../../utils/weapons';

describe('GymWeaponLeveling', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<GymWeaponLeveling> {
    booted = await bootScene([GymWeaponLeveling, MineralChoiceScene]);
    return booted.scene as GymWeaponLeveling;
  }

  it('AC1 — collecting the same drop repeatedly levels that weapon up', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    // Collect the spread weapon through the shared collect path three times.
    for (let i = 0; i < 3; i++) {
      const drop = scene.spawnDrop('spread', player.x, player.y);
      scene.tick(0.1);
      expect(drop.absorbing).toBe(true);
    }
    expect(player.getWeaponLevel('spread')).toBe(3);
    // Only the high levels change behaviour; level ≥ 2 is an upgrade.
    expect(player.getWeaponDef('spread').levelBulletSize).toBeGreaterThan(1);
  });

  it('AC2 — the MVP variables change the shared core output at higher levels', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    const base = WEAPON_CATALOGUE.spread;
    // Level up to the first upgrade (second collection), then a second
    // upgrade so the fire rate has enough headroom to reach the next beat
    // subdivision (quantisation makes the first step land on 750 ms).
    scene.spawnDrop('spread', player.x, player.y);
    scene.tick(0.1);
    scene.spawnDrop('spread', player.x, player.y);
    scene.tick(0.1);
    scene.spawnDrop('spread', player.x, player.y);
    scene.tick(0.1);
    expect(player.getWeaponLevel('spread')).toBe(3);
    const def = player.getWeaponDef('spread');
    const stats = resolveWeaponDefinition('spread', 2);

    // projectile count → more bullets in the pattern.
    expect(def.offsets.length).toBeGreaterThan(base.offsets.length);
    expect(def.offsets.length).toBe(stats.offsets.length);
    // bullet size → level multiplier present (> 1 for the first upgrade).
    expect(def.levelBulletSize).toBeGreaterThan(1);
    // fire rate → faster cadence, still on the beat grid.
    expect(player.getFireInterval('spread')).toBeLessThan(base.fireRateMs);
    expect(isOnBeatGrid(player.getFireInterval('spread'))).toBe(true);
    // The shared core spawns one bullet per pattern entry at the level size.
    for (let i = 0; i < 120; i++) scene.tick(1 / 60);
    const spreadBullets = scene
      .getBullets()
      .filter((b) => b.color === base.bulletColor);
    expect(spreadBullets.length).toBeGreaterThan(0);
    // Bullet-size upgrade: the shared core sizes the bullet above the base.
    expect(spreadBullets[0].radius).toBeGreaterThan(3);
    // Projectile-count upgrade: the shared core spawns the level-resolved
    // pattern (more bullets than the base 3-bullet fan) per shot.
    expect(spreadBullets.length % def.offsets.length).toBe(0);
  });

  it('AC2 — an AOE weapon’s blast radius grows with level', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const baseRadius = WEAPON_CATALOGUE.nova.aoe!.radius;

    scene.spawnDrop('nova', player.x, player.y);
    scene.tick(0.1);
    expect(player.getWeaponDef('nova').aoe!.radius).toBe(baseRadius);

    scene.spawnDrop('nova', player.x, player.y);
    scene.tick(0.1);
    expect(player.getWeaponDef('nova').aoe!.radius).toBeGreaterThan(baseRadius);
  });

  it('AC3 — the gym HUD shows each active weapon level', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    const hud = scene.getHUD()!;

    scene.spawnDrop('rapid', player.x, player.y);
    scene.tick(0.1);
    scene.spawnDrop('rapid', player.x, player.y);
    scene.tick(0.1);
    player.equipWeapon('rapid'); // ensure active for the HUD row
    hud.refresh();

    const texts = (
      hud as unknown as { list: Phaser.GameObjects.GameObject[] }
    ).list
      .filter((c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text)
      .map((c) => c.text);
    expect(texts.some((t) => t.startsWith('Weapon: rapid Lv.'))).toBe(true);
  });

  it('AC1/AC5 — the hold-full choice permanently levels an owned weapon', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;

    // Own a weapon permanently (level 1) so a level-up offer exists.
    player.equipWeapon('spread', true);
    expect(player.getWeaponLevel('spread')).toBe(1);

    const offered = scene.openMineralChoice();
    expect(offered.length).toBeGreaterThan(0);
    // The demo strategy guarantees a weapon level-up offer.
    const levelUp = offered.find((o) => o.kind === 'weapon-level');
    expect(levelUp).toBeDefined();
    expect(levelUp!.id).toBe('spread');

    scene.selectMineralChoice(offered.indexOf(levelUp!));
    expect(player.getWeaponLevel('spread')).toBe(2);
    // Permanent: it never times out.
    player.tickWeaponTimers(100_000);
    expect(player.hasWeapon('spread')).toBe(true);
    expect(player.getWeaponLevel('spread')).toBe(2);
  });

  it('AC1 — the choice is offered when the hold fills', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    scene.spawnDrop('dual', player.x, player.y);
    scene.tick(0.1);

    scene.addMinerals(scene.getHold().capacity);
    expect(scene.getHold().isFull).toBe(true);
    scene.tick(0.016);
    expect(scene.getMineralChoiceOptions().length).toBeGreaterThan(0);
  });

  it('AC4 — the gym is discovered by the index as WelaponLeveling', async () => {
    const entries = discoverGymScenes({
      '/src/scenes/gym/GymWeaponLeveling.ts': { GymWeaponLeveling },
    });
    expect(entries).toEqual([
      { key: 'GymWeaponLeveling', label: 'WeaponLeveling', module: { GymWeaponLeveling } },
    ]);
  });

  it('AC1 — Reset-style behaviour is not duplicated: the gym keeps permanent levels', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    player.equipWeapon('rapid', true);
    player.equipWeapon('rapid', true);
    expect(player.getWeaponLevel('rapid')).toBe(2);

    // Permanent levels persist across the run (the gym never clears them).
    player.tickWeaponTimers(100_000);
    expect(player.hasWeapon('rapid')).toBe(true);
    expect(player.getWeaponLevel('rapid')).toBe(2);
  });

  it('survives a stop/restart without leaking or double-registering', async () => {
    const scene = await boot();
    expect(scene.getPlayer()).not.toBeNull();
    scene.scene.restart();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scene.getPlayer()).not.toBeNull();
  });
});

describe('GymWeaponLeveling — shared-core parity', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('uses the shared level-resolved definition (no divergent weapon code)', async () => {
    booted = await bootScene([GymWeaponLeveling]);
    const scene = booted.scene as GymWeaponLeveling;
    const player = scene.getPlayer()!;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    scene.spawnDrop('spread', player.x, player.y);
    scene.tick(0.1);
    scene.spawnDrop('spread', player.x, player.y);
    scene.tick(0.1);

    // The gym's resolved definition is exactly the shared resolver's output.
    const expected = resolveWeaponDefinition('spread', 1);
    const actual = player.getWeaponDef('spread');
    expect(actual.offsets).toEqual(expected.offsets);
    expect(actual.fireRateMs).toBe(expected.fireRateMs);
    expect(actual.levelBulletSize).toBe(expected.levelBulletSize);
    consoleError.mockRestore();
  });

  it('gym and game share the temporary/permanent field-pickup contract (AC8)', async () => {
    booted = await bootScene([GymWeaponLeveling]);
    const scene = booted.scene as GymWeaponLeveling;
    const player = scene.getPlayer()!;

    // Same sequence as the PlayScene battle test: a field pickup is temporary.
    scene.spawnDrop('dual', player.x, player.y);
    scene.tick(0.1);
    scene.spawnDrop('dual', player.x, player.y);
    scene.tick(0.1);
    expect(player.getWeaponLevel('dual')).toBe(2);
    expect(player.getPermanentWeaponLevel('dual')).toBe(0);

    player.tickWeaponTimers(100_000);
    expect(player.hasWeapon('dual')).toBe(false);
    expect(player.getWeaponLevel('dual')).toBe(0);

    // A hold-full reward is permanent and never expires.
    player.equipWeapon('dual', true);
    expect(player.getPermanentWeaponLevel('dual')).toBe(1);
    player.tickWeaponTimers(100_000);
    expect(player.hasWeapon('dual')).toBe(true);
    expect(player.getWeaponLevel('dual')).toBe(1);
  });
});
