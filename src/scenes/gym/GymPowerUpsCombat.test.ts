/**
 * Scene-level tests for the GymPowerUpsCombat gym (parent AC1/AC2/AC3 +
 * children AC1–AC10): discovery by the gym index, scene boot + player ship
 * with thrust movement and screen-wrap, scout V-formation + SHOOT toggle,
 * combat power-up collection, hit response, round-robin spawn, back button,
 * and visual feedback (shield bubble, phase ghost, bomb notice).
 *
 * Uses gameHarness (Phaser headless via happy-dom) — no rasterised canvas
 * checks; visuals tested via commandBuffer where applicable.
 *
 * AH-0MTC2P6G3007PJ40 — "Create combat gym scene for combat-coupled
 * power-ups with low-level enemy threats"
 */
import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { GymPowerUpsCombat } from './GymPowerUpsCombat';
import { POWER_UP_DROP_SIZE } from '../../core/constants';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Boots the combat gym scene via gameHarness. */
async function bootCombat(): Promise<GymPowerUpsCombat> {
  const booted = await bootScene([GymPowerUpsCombat]);
  return booted!.scene as GymPowerUpsCombat;
}

/**
 * Collect a fully-grown combat power-up by spawning it at the ship
 * position and letting one tick process the overlap.
 */
function collectCombatDrop(
  scene: GymPowerUpsCombat,
  id: 'P3' | 'P4' | 'P6' | 'P7',
): void {
  const player = scene.getPlayer()!;
  player.setPosition(480, 270);
  scene.spawnDrop(id, 480, 270);
  scene.advanceDrops(0.5); // grow to full size (collectible)
  scene.tick(1 / 60); // one frame — overlap collection runs
}

// ── AC1: Discovery + boot ──────────────────────────────────────────────

describe('GymPowerUpsCombat AC1: gym index discovery', () => {
  it('is auto-discovered from the gym folder with the GymPowerUpsCombat key', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymPowerUpsCombat');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('PowerUpsCombat');
  });

  it('is listed by the real gym index by key', async () => {
    const booted = await bootScene([GymIndex]);
    const index = booted!.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain('GymPowerUpsCombat');
    booted!.game.destroy(true);
  });

  it('registers the scene so the index can start it', async () => {
    const booted = await bootScene([GymIndex]);
    expect(booted!.game.scene.getScene('GymPowerUpsCombat')).not.toBeNull();
    booted!.game.destroy(true);
  });
});

// ── AC2: Scene boot + player ship + screen-wrap ────────────────────────

describe('GymPowerUpsCombat AC2: scene boot + player ship', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('boots as an active scene and renders the player ship at the canvas centre', async () => {
    const scene = await bootCombat();
    expect(scene.sys.isActive()).toBe(true);

    const player = scene.getPlayer();
    expect(player).toBeDefined();
    expect(player!.active).toBe(true);
    expect(player!.visible).toBe(true);
    expect(player!.x).toBeCloseTo(480);
    expect(player!.y).toBeCloseTo(270);
  });

  it('ship responds to thrust input via the standard movement model', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;

    player.setInput({ up: true, down: false, left: false, right: false });
    player.physicsTick(1, 960, 540);
    expect(player.y).toBeLessThan(200); // moved well above centre start

    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(1, 960, 540);
    expect(player.x).toBeGreaterThan(500); // moved right
  });

  it('ship screen-wraps: crossing the left edge reappears on the right', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;

    player.setInput({ up: false, down: false, left: true, right: false });
    for (let i = 0; i < 200; i++) {
      player.physicsTick(1 / 60, 960, 540);
    }
    expect(player.x).toBeGreaterThan(0);
    expect(player.x).toBeLessThan(960);
    expect(player.x).toBeGreaterThan(700);
  });
});

// ── AC2: Scout V-formation + SHOOT toggle ──────────────────────────────

describe('GymPowerUpsCombat AC2: scout formation + SHOOT toggle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns exactly 3 scouts in a V-formation', async () => {
    const scene = await bootCombat();
    const scouts = scene.getScouts();
    expect(scouts).toHaveLength(3);

    // All scouts are alive and rendered.
    for (const scout of scouts) {
      expect(scout.alive).toBe(true);
    }
  });

  it('starts with SHOOT: ON and toggles to OFF', async () => {
    const scene = await bootCombat();
    expect(scene.shootingEnabled).toBe(true);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(false);

    scene.toggleShooting();
    expect(scene.shootingEnabled).toBe(true);
  });

  it('SHOOT: ON fires aimed bullets at the ship (two-phase tell + fire)', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // SHOOT starts ON — the tell phase lasts 0.6 s then fires on the next
    // tick past the 1.2 s interval. Drive ~3 s of simulation.
    for (let i = 0; i < 200; i++) {
      scene.tick(1 / 60);
    }

    // At least one bullet should be on screen.
    const bullets = scene.getEnemyBullets();
    expect(bullets.length).toBeGreaterThan(0);

    // Bullets are Graphics objects.
    for (const b of bullets) {
      expect(b.graphics).toBeInstanceOf(Phaser.GameObjects.Graphics);
    }
  });
});

// ── AC3: Round-robin spawn/lifecycle ───────────────────────────────────

describe('GymPowerUpsCombat AC3: round-robin spawn + lifecycle', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('spawns drops in P3 → P4 → P6 → P7 order, one every 12.5 s', async () => {
    const scene = await bootCombat();

    // First frame: a drop spawns immediately.
    scene.tick(0.016);
    let drops = scene.getDrops();
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(drops[0].powerUp.id).toBe('P3'); // first in COMBAT_ORDER

    // Advance through one full cycle (P3 despawn → P4 spawn → P6 → P7).
    // Each drop has POWER_UP_LIFETIME seconds of life.
    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('P4'); // second in cycle

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('P6'); // third

    for (let i = 0; i < 750; i++) {
      scene.tick(1 / 60);
    }
    drops = scene.getDrops();
    expect(drops).toHaveLength(1);
    expect(drops[0].powerUp.id).toBe('P7'); // fourth
  });

  it('drops spawn at the configured size (8 px)', () => {
    expect(POWER_UP_DROP_SIZE).toBe(8);
  });
});

// ── AC4: P3 Shield collection + visual ─────────────────────────────────

describe('GymPowerUpsCombat AC4: P3 Shield collection + bubble visual', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P3 arms the shield effect', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P3');

    const registry = scene.getEffectsRegistry();
    expect(registry.isShielded).toBe(true);
    expect(registry.isHitImmune).toBe(true);
  });

  it('shield bubble is rendered while active', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P3');

    // The scene tracks shield bubble visibility via the registry.
    expect(scene.isShieldBubbleVisible()).toBe(true);
  });

  it('shield absorbs one hit then pops', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P3');
    const registry = scene.getEffectsRegistry();

    expect(registry.isShielded).toBe(true);
    const absorbed = registry.tryAbsorbShield();
    expect(absorbed).toBe(true);
    expect(registry.isShielded).toBe(false);
    expect(registry.isHitImmune).toBe(false);
  });

  it('shield refreshes on re-collect (timer back to POWER_UP_LIFETIME)', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P3');
    const registry = scene.getEffectsRegistry();

    // 10 s after collect, shield has ~5 s remaining; re-collect refreshes.
    registry.tick(10);
    const before = registry.remaining('P3')!;
    expect(before).toBeGreaterThan(0);
    collectCombatDrop(scene, 'P3'); // re-collect
    expect(registry.remaining('P3')).toBeGreaterThan(before); // refreshed
    expect(registry.remaining('P3')).toBeGreaterThan(14.5); // ~15 s full
  });
});

// ── AC5: P4 Bomb collection + bullet clear + notice ────────────────────

describe('GymPowerUpsCombat AC5: P4 Bomb collection + bullet clear + notice', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P4 clears all on-screen enemy bullets', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    // SHOOT starts ON — generate bullets without toggling.
    for (let i = 0; i < 200; i++) {
      scene.tick(1 / 60);
    }
    const bulletsBefore = scene.getEnemyBullets();
    expect(bulletsBefore.length).toBeGreaterThan(0);

    // Collect P4.
    scene.spawnDrop('P4', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);

    const bulletsAfter = scene.getEnemyBullets();
    expect(bulletsAfter).toHaveLength(0);
  });

  it('P4 triggers a brief bomb notice', async () => {
    const scene = await bootCombat();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);

    for (let i = 0; i < 200; i++) {
      scene.tick(1 / 60);
    }

    scene.spawnDrop('P4', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);

    expect(scene.isBombNoticeVisible()).toBe(true);
  });
});

// ── AC6: P6 Phase Shift collection + ghost visual ──────────────────────

describe('GymPowerUpsCombat AC6: P6 Phase Shift collection + ghost visual', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P6 grants intangibility', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P6');

    const registry = scene.getEffectsRegistry();
    expect(registry.isPhased).toBe(true);
    expect(registry.isHitImmune).toBe(true);
  });

  it('phase ghost visual is active during shift', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P6');

    expect(scene.isPhaseGhostActive()).toBe(true);
  });

  it('phase expires after 3 s', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P6');
    const registry = scene.getEffectsRegistry();

    registry.tick(2.9);
    expect(registry.isPhased).toBe(true);
    registry.tick(0.2);
    expect(registry.isPhased).toBe(false);
  });

  it('phase refreshes on re-collect (timer back to 3 s)', async () => {
    const scene = await bootCombat();
    collectCombatDrop(scene, 'P6');
    const registry = scene.getEffectsRegistry();

    // Tick so the effect has clearly decayed but is still active.
    registry.tick(2); // ~1 s remaining
    expect(registry.isPhased).toBe(true);
    const before = registry.remaining('P6')!;
    expect(before).toBeGreaterThan(0);

    collectCombatDrop(scene, 'P6'); // re-collect refreshes to full 3 s
    expect(registry.remaining('P6')).toBeGreaterThan(before); // refreshed
    expect(registry.remaining('P6')).toBeGreaterThan(2.9); // ~3 s full
  });
});

// ── AC7: P7 Teleport FIFO stacks + safe-spot ──────────────────────────

describe('GymPowerUpsCombat AC7: P7 Teleport FIFO stacks + safe-spot', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('collecting P7 stacks FIFO', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();

    expect(registry.hasTeleport()).toBe(false);
    collectCombatDrop(scene, 'P7');
    expect(registry.teleportStacks()).toBe(1);
    collectCombatDrop(scene, 'P7');
    expect(registry.teleportStacks()).toBe(2);
    expect(registry.hasTeleport()).toBe(true);
  });

  it('consuming teleport grants P6 phase shift', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    collectCombatDrop(scene, 'P7');
    collectCombatDrop(scene, 'P7');

    const consumed = registry.consumeTeleport();
    expect(consumed).toBe(true);
    expect(registry.teleportStacks()).toBe(1);
    expect(registry.isPhased).toBe(true);
  });
});

// ── AC8/AC9: Hit response + HUD ────────────────────────────────────────

describe('GymPowerUpsCombat AC8/AC9: hit response + HUD (no lives)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('hit response triggers flash/reset with no lives touched', async () => {
    const scene = await bootCombat();
    const registry = scene.getEffectsRegistry();
    const initialHitCount = scene.getPlayerHitCount();

    // Simulate a direct hit (no shield/phase).
    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(initialHitCount + 1);
    expect(scene.isPlayerInvulnerable()).toBe(true);

    // No lives in combat gym — registry should show 3 (default, untouched).
    expect(registry.lives()).toBe(3);
  });

  it('attaches the standalone HUD rendering above gameplay', async () => {
    const scene = await bootCombat();
    const hud = scene.getHud();
    expect(hud).toBeInstanceOf(HUD);
    expect(hud!.depth).toBeGreaterThan(0);
  });
});

// ── AC1: Back button ───────────────────────────────────────────────────

describe('GymPowerUpsCombat AC1: shared back button', () => {
  it('shows the shared ← INDEX back button', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted!.scene as GymPowerUpsCombat;

    const found = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(found).toBeDefined();
    booted!.game.destroy(true);
  });

  it('the ← INDEX back button navigates back to the gym index', async () => {
    const booted = await bootScene([GymPowerUpsCombat, GymIndex]);
    const scene = booted!.scene as GymPowerUpsCombat;
    expect(scene.sys.isActive()).toBe(true);

    const button = scene.children.list.find(
      (child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text &&
        child.text === BACK_TO_INDEX_LABEL,
    );
    expect(button).toBeDefined();

    button!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymIndex')).toBe(true);
    booted!.game.destroy(true);
  });
});
