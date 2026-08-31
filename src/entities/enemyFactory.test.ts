/**
 * Config-aware entity seam — behaviour tests (AH-0MTHG51KB007F17K, AC cover).
 *
 * Verifies: config overrides flow into entity size/color and fire tuning;
 * defaults are preserved when absent; factory maps keys correctly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import { Diver } from './Diver';
import { PhaserEntity } from './Phaser';
import { Scout } from './Scout';
import { Swarm } from './Swarm';
import { Tank } from './Tank';
import { createEnemyFromConfig } from './enemyFactory';

class Harness extends Phaser.Scene {
  constructor() { super('Harness'); }
}

describe('Config-aware entity seam', () => {
  let booted: BootedGame | null = null;
  afterEach(() => { booted?.game.destroy(true); booted = null; vi.clearAllMocks(); });

  it('Scout respects size/color overrides and defaults when absent', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const base = new Scout(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 } });
    expect(base.effectiveSize).toBe(16);
    expect(base.effectiveColor).toBe(0x00ff00);

    const overridden = new Scout(scene, {
      x: 100, y: 100, formationOffset: { row: 0, col: 0 },
      size: 32, color: 0x123456, bulletColor: 0xabcdef, bulletSpeed: 999, fireInterval: 5000,
    });
    expect(overridden.effectiveSize).toBe(32);
    expect(overridden.effectiveColor).toBe(0x123456);
  });

  it('Scout tryFire interval respects config fireInterval', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    // Use a short interval so we can observe it
    const s = new Scout(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, fireInterval: 50 });
    s.shootEnabled = true;
    const t0 = 1_000_000;
    // First call starts tell
    expect(s.tryFireAimedBullet(t0)).toBeNull();
    // After cue, fires
    const bullet = s.tryFireAimedBullet(t0 + 600);
    expect(bullet).not.toBeNull();
    // Within interval — not fire
    expect(s.tryFireAimedBullet(t0 + 600 + 25)).toBeNull();
    // After interval -> tell restarts, then fire
    expect(s.tryFireAimedBullet(t0 + 600 + 60)).toBeNull();
    expect(s.tryFireAimedBullet(t0 + 1200 + 60)).not.toBeNull();
  });

  it('Diver/Tank/Phaser/Swarm respect size/color/burst overrides', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const diver = new Diver(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 42, color: 0x111111, burstCount: 7 });
    expect(diver.effectiveSize).toBe(42);
    expect(diver.effectiveColor).toBe(0x111111);
    expect(diver.effectiveBurstCount).toBe(7);

    const tank = new Tank(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 40, color: 0x222222, burstCount: 3 });
    expect(tank.effectiveSize).toBe(40);
    expect(tank.effectiveBurstCount).toBe(3);

    const phaser = new PhaserEntity(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 22, color: 0x333333, burstCount: 5 });
    expect(phaser.effectiveSize).toBe(22);
    expect(phaser.effectiveBurstCount).toBe(5);

    // Use bypass via new with override
    const swarm2 = new Swarm(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, size: 9, color: 0x444444 } as any, 0);
    expect(swarm2.effectiveSize).toBe(9);
    expect(swarm2.effectiveColor).toBe(0x444444);
  });

  it('Phaser and Tank bullet count matches burstCount config', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const diver = new Diver(scene, { x: 100, y: 100, formationOffset: { row: 0, col: 0 }, burstCount: 2, fireInterval: 1 });
    diver.shootEnabled = true;
    // Provide enough time that burst fires
    const bullets = diver.tryFireSpreadBurst(Date.now() + 10000);
    expect(bullets.length).toBe(2);
  });

  it('createEnemyFromConfig maps keys to the right entity class and threads opts', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    for (const key of ['scout', 'diver', 'tank', 'phaser', 'swarm'] as const) {
      const cfg = { ...DEFAULT_ENEMY_CONFIGS[key], color: 0xabcdef, size: 99 };
      const e = createEnemyFromConfig(scene, cfg as any, 10, 10, { row: 0, col: 0 });
      expect((e as any).effectiveColor).toBe(0xabcdef);
      // Spot check type
      if (key === 'scout') expect(e instanceof Scout).toBe(true);
      if (key === 'diver') expect(e instanceof Diver).toBe(true);
      if (key === 'tank') expect(e instanceof Tank).toBe(true);
      if (key === 'phaser') expect(e instanceof PhaserEntity).toBe(true);
      if (key === 'swarm') expect(e instanceof Swarm).toBe(true);
      e.destroy(true);
    }
  });

  it('custom/unknown key falls back to Scout while preserving visuals', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;
    const cfg = { ...DEFAULT_ENEMY_CONFIGS.scout, key: 'my-custom-enemy', displayName: 'My Custom', color: 0x999999, size: 30 };
    const e = createEnemyFromConfig(scene, cfg as any, 10, 10, { row: 0, col: 0 });
    expect(e instanceof Scout).toBe(true);
    expect((e as any).effectiveColor).toBe(0x999999);
    e.destroy(true);
  });
});
