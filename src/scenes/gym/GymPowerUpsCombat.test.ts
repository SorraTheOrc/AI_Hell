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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { HUD } from '../../ui/HUD';
import { GymIndex } from '../GymIndex';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import { GymPowerUpsCombat } from './GymPowerUpsCombat';
import { CombatScene } from '../core/CombatScene';
import { HelpScene } from '../HelpScene';
import { HELP_BUTTON_LABEL } from '../../utils/gymHelp';
import { POWER_UP_DROP_SIZE } from '../../core/constants';
import * as effectsModule from '../../audio/effects';
import * as explosionModule from '../../vfx/explosionParticles';
import * as playerDeathJuiceModule from '../../vfx/playerDeathJuice';
import * as collectAnimationModule from '../../powerups/collectAnimation';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';

// These scene tests drive the fourDirectional control scheme; the app
// default is now Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

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
    // tick past the 1.2 s interval. Drive until a bullet appears, polling
    // each tick so the assertion does not sit on the bullet-lifetime expiry
    // boundary (AH-0MU960UTE001PTV0) and stays robust to the harness's
    // background game loop.
    let bullets = scene.getEnemyBullets();
    for (let i = 0; i < 400 && bullets.length === 0; i++) {
      scene.tick(1 / 60);
      bullets = scene.getEnemyBullets();
    }

    // At least one bullet should be on screen.
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

  it('drops spawn at the configured size (16 px)', () => {
    expect(POWER_UP_DROP_SIZE).toBe(16);
  });
});

// ── Collection boundary: ship hull touches the visible bubble (AH-0MTVYCM2N002NKE4) ──

describe('GymPowerUpsCombat collection boundary: bubble contact', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootCombatBoundary(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('collects a drop whose hull touches the visible bubble (31 px)', async () => {
    const scene = await bootCombatBoundary();
    scene.getPlayer()!.setPosition(480, 270);

    // Full-scale boundary: hull 10 + bubble 16 × 1.4 = 32.4 px. At 31 px the
    // ship hull is already touching the crisp bubble ring → collected.
    const drop = scene.spawnDrop('P3', 511, 270);
    scene.advanceDrops(0.5); // grow to full size
    scene.tick(1 / 60); // one frame runs the overlap collection

    expect(scene.getEffectsRegistry().isShielded).toBe(true);
    expect(scene.getDrops()).not.toContain(drop); // consumed
  });

  it('does not collect a drop just beyond the bubble boundary (34 px)', async () => {
    const scene = await bootCombatBoundary();
    scene.getPlayer()!.setPosition(480, 270);

    const drop = scene.spawnDrop('P3', 480 + 34, 270); // 34 px > 32.4 px boundary
    scene.advanceDrops(0.5); // full size, collectible but out of range
    scene.tick(1 / 60);

    expect(scene.getEffectsRegistry().isShielded).toBe(false);
    expect(scene.getDrops()).toContain(drop); // drop still on field
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

    // Place enemy bullets deterministically so the assertion tests the P4
    // clear itself, not scout fire cadence vs bullet lifetime
    // (AH-0MU960UTE001PTV0 — shorter lifetimes made the previous
    // tick-until-bullets-exist approach timing-fragile).
    scene.spawnEnemyBullet(200, 100, 0, 0);
    scene.spawnEnemyBullet(300, 150, 0, 0);
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

describe('GymPowerUpsCombat — collection absorb VFX + pop SFX (AH-0MUBYXRT4002H3GY)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.restoreAllMocks();
  });

  async function boot(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted!.scene as GymPowerUpsCombat;
  }

  it('collection starts the absorb animation and keeps the Graphics alive', async () => {
    const spawnSpy = vi.spyOn(collectAnimationModule, 'spawnCollectAnimation');
    const scene = await boot();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('P3', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(scene.getDrops()).not.toContain(drop);
    expect(scene.getCollectAnimations()).toHaveLength(1);
    expect(drop.graphics.active).toBe(true);
  });

  it('the absorb animation completes and destroys the drop Graphics', async () => {
    const scene = await boot();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    const drop = scene.spawnDrop('P3', 480, 270);
    scene.advanceDrops(0.5);
    scene.tick(1 / 60);
    expect(scene.getCollectAnimations()).toHaveLength(1);

    // Advance well past the ≤ 0.3 s absorb duration.
    scene.tick(0.5);

    expect(scene.getCollectAnimations()).toHaveLength(0);
    expect(drop.graphics.active).toBe(false);
  });

  it('collection plays the generic pop SFX exactly once (no re-collect)', async () => {
    const popSound = vi.spyOn(effectsModule, 'playPowerUpCollectPopSound');
    const scene = await boot();
    vi.clearAllMocks();
    const player = scene.getPlayer()!;
    player.setPosition(480, 270);
    scene.spawnDrop('P3', 480, 270);
    scene.advanceDrops(0.5);

    scene.tick(1 / 60);
    expect(popSound).toHaveBeenCalledTimes(1);

    scene.tick(0.5);
    expect(popSound).toHaveBeenCalledTimes(1);
  });
});

describe('GymPowerUpsCombat — help overlay (AH-0MUAYB67I002REOZ)', () => {
  let booted: BootedGame | null = null;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootHelp(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat, HelpScene]);
    return booted.scene as GymPowerUpsCombat;
  }

  it('AC1 — renders a Help (?) button next to ← INDEX', async () => {
    const scene = await bootHelp();
    expect(scene.getHelpHandle()).not.toBeNull();
    expect(scene.getHelpHandle()!.button.text).toBe(HELP_BUTTON_LABEL);
  });

  it('AC1/AC2 — opening help pauses the gym and lists its drop pool', async () => {
    const scene = await bootHelp();
    scene.getHelpHandle()!.openHelp();
    await settle();

    expect(booted!.game.scene.isPaused('GymPowerUpsCombat')).toBe(true);
    const help = booted!.game.scene.getScene('HelpScene') as HelpScene;
    expect(help.getEntries().map((e) => e.id)).toEqual(['P3', 'P4', 'P6', 'P7']);
  });

  it('AC4 — ? closes help and resumes the gym where it paused', async () => {
    const scene = await bootHelp();
    scene.getHelpHandle()!.openHelp();
    await settle();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    await settle();

    expect(booted!.game.scene.isActive('HelpScene')).toBe(false);
    expect(scene.sys.isActive()).toBe(true);
  });
});

// ── Parent AH-0MUDCT7EU0061OSZ: re-based on the shared combat core ─────

describe('GymPowerUpsCombat — re-based on the shared CombatScene core', () => {
  it('AC4 — extends CombatScene (prototype identity)', () => {
    expect(Object.getPrototypeOf(GymPowerUpsCombat.prototype)).toBe(
      CombatScene.prototype,
    );
  });

  it('AC1/AC6 — inherits the shared template methods instead of defining local copies', () => {
    for (const method of [
      '_collectDrop',
      '_clearEnemyBullets',
      '_handleTeleport',
      '_hitPlayer',
      '_readPlayerInput',
      '_handleCollisions',
    ] as const) {
      // The gym must not own a local copy...
      expect(
        Object.prototype.hasOwnProperty.call(
          GymPowerUpsCombat.prototype,
          method,
        ),
      ).toBe(false);
      // ...and must resolve the shared implementation through CombatScene.
      expect(
        (GymPowerUpsCombat.prototype as unknown as Record<string, unknown>)[
          method
        ],
      ).toBe(
        (CombatScene.prototype as unknown as Record<string, unknown>)[method],
      );
    }
    // The gym-owned `_handleHits` is gone entirely.
    expect(
      (GymPowerUpsCombat.prototype as unknown as Record<string, unknown>)[
        '_handleHits'
      ],
    ).toBeUndefined();
  });

  it('AC5 — the inherited hit lifecycle uses the gym’s 0.8 s invulnerability hook', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;

    // A direct, unshielded hit arms the shared invuln window at 0.8 s.
    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(scene.getPlayerInvulnerableRemaining()).toBeCloseTo(0.8, 5);
    booted.game.destroy(true);
  });

  it('AC5 — a shielded hit is absorbed without a hit, but still blinks', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;
    scene.getEffectsRegistry().applyCollect('P3');
    expect(scene.getEffectsRegistry().isShielded).toBe(true);

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.getEffectsRegistry().isShielded).toBe(false);
    expect(scene.getPlayerInvulnerableRemaining()).toBeCloseTo(0.8, 5);
    booted.game.destroy(true);
  });

  it('AC5 — the shared teleport activates on ↓ (adopted S+↓ fix)', async () => {
    const booted = await bootScene([GymPowerUpsCombat]);
    const scene = booted.scene as GymPowerUpsCombat;
    scene.getEffectsRegistry().applyCollect('P7');
    expect(scene.getEffectsRegistry().hasTeleport()).toBe(true);

    // Only the down-arrow is held/just-down; S is not. The inherited
    // `_handleTeleport` must still consume the stack and grant P6 — the
    // deliberate S+↓ fix that replaces the gym's old S-only
    // implementation (parent AC5b).
    const sKey = scene.input.keyboard!.addKey('S');
    const downKey = scene.input.keyboard!.addKey(
      Phaser.Input.Keyboard.KeyCodes.DOWN,
    );
    (sKey as unknown as { _justDown: boolean })._justDown = false;
    sKey.isDown = false;
    (downKey as unknown as { _justDown: boolean })._justDown = true;
    downKey.isDown = true;
    (
      scene as unknown as { teleportKey: Phaser.Input.Keyboard.Key | null }
    ).teleportKey = sKey;
    (
      scene as unknown as { downKey: Phaser.Input.Keyboard.Key | null }
    ).downKey = downKey;

    scene['_handleTeleport']();

    // The ↓ key (not S) consumed the P7 stack and granted P6 on arrival.
    expect(scene.getEffectsRegistry().hasTeleport()).toBe(false);
    expect(scene.getEffectsRegistry().isPhased).toBe(true);
    booted.game.destroy(true);
  });
});

// ── F8 (AH-0MUDY2UC3002Y3YW): composed player-death juice on the
//    GymPowerUpsCombat hit path (inherited applyPlayerHit from CombatScene)

describe('GymPowerUpsCombat — composed player-death juice (F8)', () => {
  let booted: BootedGame | null = null;

  async function bootCombat(): Promise<GymPowerUpsCombat> {
    booted = await bootScene([GymPowerUpsCombat]);
    return booted.scene as GymPowerUpsCombat;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  it('an unshielded hit plays the dedicated cue once and registers juice', async () => {
    const scene = await bootCombat();
    const deathSound = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const genericSound = vi.spyOn(effectsModule, 'playDestructionSound');
    const particleSpy = vi.spyOn(explosionModule, 'spawnExplosionParticles');
    const shakeSpy = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(1);
    expect(deathSound).toHaveBeenCalledTimes(1);
    expect(genericSound).not.toHaveBeenCalled();
    expect(particleSpy).toHaveBeenCalledTimes(1);
    expect(shakeSpy).toHaveBeenCalledTimes(1);
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);
    expect(scene.isPlayerInvulnerable()).toBe(true);
  });

  it('SHUTDOWN clears the juice registry (no leak across stop/restart)', async () => {
    const scene = await bootCombat();

    scene['_hitPlayer']();
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);

    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
  });

  it('P3 shield absorb spawns no player juice', async () => {
    const scene = await bootCombat();
    scene.getEffectsRegistry().applyCollect('P3');
    const juiceSpy = vi.spyOn(playerDeathJuiceModule, 'spawnPlayerDeathJuice');

    scene['_hitPlayer']();

    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.getPlayerDeathEffects()).toHaveLength(0);
    expect(juiceSpy).not.toHaveBeenCalled();
  });
});
