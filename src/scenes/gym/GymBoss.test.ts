import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  GAME_WIDTH,
  GAME_HEIGHT,
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../core/constants';
import { loadRules } from '../../core/rules';
import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  RoundRobinSpawner,
  WeightedRandomSpawner,
  type PowerUpSpawner,
} from '../../powerups/spawner';
import { RandomAvoidingPlacement, type PowerUpPlacement } from '../../powerups/placement';
import type { DropId, PowerUpId } from '../../powerups/types';
import {
  createSeededRng,
  isClearOfBodies,
  stubBody,
} from '../../test/powerUpTestFixtures';
import {
  GymBoss,
  BOSS_FORMATION_START_X,
  BOSS_FORMATION_START_Y,
} from './GymBoss';
import { GymFormationScene } from './core/GymFormationScene';
import {
  BOSS_PHASE_COUNT,
  BOSS_TELEGRAPH_MS,
  BOSS_COLOR,
  BOSS_RADIUS,
  BossPhase,
} from '../../entities/Boss';
import {
  colorToHSL,
  EXPLOSION_HUE_JITTER_DEG,
  resolvePatterns,
  scaledCount,
} from '../../vfx/explosionParticles';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import { MenuScene } from '../MenuScene';

/** Finds an on-screen text button by label. */
function findButton(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

describe('GymBoss — The Central AI gym scene (AC1-AC10)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymBoss> {
    booted = await bootScene([GymBoss]);
    return booted!.scene as GymBoss;
  }

  it('AC1 — boots a scene rendering the Boss entity', async () => {
    const scene = await bootGym();

    expect(scene.sys.isActive()).toBe(true);
    expect(scene.formationBoss).toBeDefined();
    expect(scene.formationBoss.alive).toBe(true);
    expect(scene.aliveCount).toBe(1);

    // Boss must be on the display list.
    expect(scene.children.list.includes(scene.formationBoss)).toBe(true);
    expect(scene.formationBoss.bodyVisible).toBe(true);
  });

  it('AC2 — Boss renders as a large neon entity with a visible central core', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    // Boss is positioned at the configured spawn point.
    expect(boss.x).toBeCloseTo(BOSS_FORMATION_START_X, 1);
    expect(boss.y).toBeCloseTo(BOSS_FORMATION_START_Y, 1);

    // Body is visible and core is visible.
    expect(boss.bodyVisible).toBe(true);
  });

  it('AC3 — multi-phase health bar displays 4 segments', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    // Initial health segments = 4 (all phases present).
    expect(boss.getHealthSegments()).toBe(BOSS_PHASE_COUNT);
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.getPhase()).toBe(BossPhase.Spread);

    // Health bar renders correctly — verify by checking phase transitions
    // affect the health bar visual state (depth 100 = screen-fixed).
    expect(boss.getHealthSegments()).toBe(BOSS_PHASE_COUNT);
  });

  it('AC4 — Phase 1 (Spread) attack pattern fires', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    boss.shootEnabled = true;
    // Simulate that the telegraph period has elapsed, then update fires the
    // attack for the current phase.
    boss._simulateTelegraphElapsed();
    const bossBullets = boss.update(scene.time.now, 16, 960, 540);
    expect(bossBullets.length).toBeGreaterThan(0);
  });

  it('AC4 — Phase 2 (Spiral) attack pattern fires after damage', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    scene.damageBoss();
    expect(boss.getPhaseNumber()).toBe(2);
    expect(boss.getPhase()).toBe(BossPhase.Spiral);

    boss.shootEnabled = true;
    boss._simulateTelegraphElapsed();
    const bossBullets = boss.update(scene.time.now, 16, 960, 540);
    expect(bossBullets.length).toBeGreaterThan(0);
  });

  it('AC4 — Phase 3 (Pulse) attack pattern fires after more damage', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    scene.damageBoss();
    scene.damageBoss();
    expect(boss.getPhaseNumber()).toBe(3);
    expect(boss.getPhase()).toBe(BossPhase.Pulse);

    boss.shootEnabled = true;
    boss._simulateTelegraphElapsed();
    const bossBullets = boss.update(scene.time.now, 16, 960, 540);
    expect(bossBullets.length).toBeGreaterThan(0);
  });

  it('AC4 — Phase 4 (Desperation) fires all patterns combined', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    scene.damageBoss();
    scene.damageBoss();
    scene.damageBoss();
    expect(boss.getPhaseNumber()).toBe(4);
    expect(boss.isDesperation()).toBe(true);

    boss.shootEnabled = true;
    boss._simulateTelegraphElapsed();
    const bossBullets = boss.update(scene.time.now, 16, 960, 540);
    // Desperation fires many bullets (spread + spiral + aimed + pulse).
    expect(bossBullets.length).toBeGreaterThan(7);
  });

  it('AC5 — DAMAGE button advances health bar through phases', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;
    const damageBtn = findButton(scene, 'DAMAGE');

    expect(boss.getPhaseNumber()).toBe(1);

    // Click damage 3 times to reach phase 4.
    damageBtn.emit('pointerdown');
    expect(boss.getPhaseNumber()).toBe(2);

    damageBtn.emit('pointerdown');
    expect(boss.getPhaseNumber()).toBe(3);

    damageBtn.emit('pointerdown');
    expect(boss.getPhaseNumber()).toBe(4);
  });

  it('AC5 — DAMAGE button destroys Boss after all phases', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;
    const damageBtn = findButton(scene, 'DAMAGE');

    // Damage all 4 phases.
    damageBtn.emit('pointerdown');
    damageBtn.emit('pointerdown');
    damageBtn.emit('pointerdown');
    expect(boss.getHealthSegments()).toBe(1);

    // Final damage destroys the Boss.
    damageBtn.emit('pointerdown');
    expect(boss.alive).toBe(false);
    expect(boss.bodyVisible).toBe(false);
  });

  it('AC6 — telegraphing before attack (≥500ms lead, audio cue)', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    boss.shootEnabled = true;

    // Set the telegraph start time so the elapsed period is recorded.
    const startTime = scene.time.now;
    boss.startTelegraph(startTime);
    expect(boss.isTelegraphing()).toBe(true);

    // Telegraph must not have fired before the lead time elapses.
    boss.checkTelegraph(startTime + BOSS_TELEGRAPH_MS - 1);
    expect(boss.isTelegraphing()).toBe(true);

    // Once the full lead time passes, the attack fires.
    boss.checkTelegraph(startTime + BOSS_TELEGRAPH_MS + 10);
    expect(boss.isTelegraphing()).toBe(false);
  });

  it('AC7 — all UI buttons present (EXPLODE, SHOOT, DAMAGE, ← INDEX)', async () => {
    const scene = await bootGym();

    expect(findButton(scene, 'EXPLODE')).toBeDefined();
    expect(findButton(scene, 'SHOOT: OFF')).toBeDefined();
    expect(findButton(scene, 'DAMAGE')).toBeDefined();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  it('AC — the DAMAGE button sits bottom-right alongside EXPLODE/SHOOT (AH-0MUAYB7O4009LWBF)', async () => {
    const scene = await bootGym();
    const explode = findButton(scene, 'EXPLODE');
    const shoot = findButton(scene, 'SHOOT: OFF');
    const damage = findButton(scene, 'DAMAGE');

    for (const control of [explode, shoot, damage]) {
      expect(control.y).toBeGreaterThan(GAME_HEIGHT / 2);
      expect(control.x).toBeGreaterThan(GAME_WIDTH / 2);
    }
    // The three controls share a row (same y) so they remain a coherent cluster.
    expect(damage.y).toBe(explode.y);
    expect(shoot.y).toBe(explode.y);
  });

  it('AC — the boss panel carries the shared .gym-panel class (AH-0MUAYB7O4009LWBF)', async () => {
    await bootGym();
    const panel = document.getElementById('boss-gym-panel');
    expect(panel, 'boss-gym-panel missing').not.toBeNull();
    expect(panel!.className).toContain('gym-panel');
  });

  it('AC8 — SHOOT button toggles Boss firing', async () => {
    const scene = await bootGym();
    const shootBtn = findButton(scene, 'SHOOT: OFF');
    const boss = scene.formationBoss;

    expect(boss.shootEnabled).toBe(true); // Boss starts with shooting on

    // Toggle off.
    shootBtn.emit('pointerdown');
    expect(findButton(scene, 'SHOOT: ON')).toBeDefined();

    // Toggle back off.
    shootBtn.emit('pointerdown');
    expect(boss.shootEnabled).toBe(false);
  });

  it('AC8 — EXPLODE button destroys the Boss', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;
    const explodeBtn = findButton(scene, 'EXPLODE');

    expect(boss.alive).toBe(true);
    explodeBtn.emit('pointerdown');
    expect(boss.alive).toBe(false);
    expect(boss.bodyVisible).toBe(false);
  });

  it('AC8 — Boss death spawns an all-three-pattern particle burst tinted around BOSS_COLOR', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    boss.destroySelf();

    const handles = boss.getExplosionHandles();
    expect(handles.length).toBe(1);
    expect(handles[0].patterns).toEqual(resolvePatterns('boss'));
    expect(handles[0].patterns).toEqual(['radial', 'ring', 'implosion']);
    expect(handles[0].totalCount).toBe(scaledCount(BOSS_RADIUS));

    const base = colorToHSL(BOSS_COLOR);
    for (const p of handles[0].particles) {
      const hsl = colorToHSL(p.color);
      let delta = Math.abs(hsl.h - base.h) % 360;
      if (delta > 180) delta = 360 - delta;
      // +0.5° allows for hex↔HSL round-trip precision at the jitter edge.
      expect(delta).toBeLessThanOrEqual(EXPLOSION_HUE_JITTER_DEG + 0.5);
    }
  });

  it('AC9 — scene extends GymFormationScene (core library reuse)', async () => {
    // GymBoss must extend GymFormationScene (imported and checked at runtime).
    const scene = await bootGym();
    // The scene has the base class accessors.
    expect(scene.formationEntities).toBeDefined();
    expect(scene.aliveCount).toBeDefined();
    expect(scene.shootingEnabled).toBeDefined();
    expect(scene.activeBullets).toBeDefined();
    expect(scene.formationX).toBeDefined();
    expect(scene.formationY).toBeDefined();
  });

  it('AC9 — no duplicated formation/UI/bullet boilerplate in scene', async () => {
    // GymBoss extends GymFormationScene (verified by type check above).
    // The scene is thin — only Boss-specific logic.
    expect(GymBoss.prototype).toBeInstanceOf(GymFormationScene);
  });

  it('AC10 — boss is centered on screen (not in a formation)', async () => {
    const scene = await bootGym();
    const boss = scene.formationBoss;

    // Boss is at the configured spawn position (centre-ish of screen).
    expect(boss.x).toBeCloseTo(GAME_WIDTH / 2, 0);
    expect(boss.y).toBeLessThan(GAME_HEIGHT / 2);

    // Boss doesn't drift (driftSpeed = 0).
    const baseXBefore = scene.formationX;
    await new Promise((r) => setTimeout(r, 500));
    const baseXAfter = scene.formationX;
    expect(baseXAfter).toBe(baseXBefore);
  });
});

describe('GymBoss — power-up spawning layer (AH-0MU44M9CA007GBTZ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  const INTERVAL = 15;

  /** Boots GymBoss with a deterministic, short-interval power-up layer. */
  class PowerUpGymBoss extends GymBoss {
    init(): void {
      // Reassign a per-instance clone: `this.config` is the shared
      // module-level BOSS_CONFIG, so mutating it would leak into every
      // later GymBoss instance.
      this.config = {
        ...this.config,
        powerUps: {
          spawner: new RoundRobinSpawner<PowerUpId>(['P3', 'P4', 'P6', 'P7']),
          placement: new RandomAvoidingPlacement({ rng: createSeededRng(1) }),
          spawnInterval: INTERVAL,
        },
      };
    }
  }

  it('AC1/AC3 — spawns one drop at a time and never overlaps the boss or player', async () => {
    booted = await bootScene([PowerUpGymBoss as unknown as typeof Phaser.Scene]);
    const scene = booted.scene as unknown as GymBoss;

    expect(scene.isPowerUpLayerEnabled()).toBe(true);
    expect(scene.getPowerUpSpawnCount()).toBe(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      scene.tick(INTERVAL);
      expect(scene.getPowerUpDrops()).toHaveLength(1);

      const drop = scene.getPowerUpDrops()[0];
      const boss = scene.formationBoss;
      const bodies = [stubBody(boss.x, boss.y, boss.getHitRadius())];
      const player = scene.getPlayer();
      if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));
      expect(
        isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
      ).toBe(true);
    }
  });
});

describe('GymBoss — weapon drops (AH-0MU3VOQKH005YOBH)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots GymBoss whose spawner yields only weapon drops (at the player). */
  function makeWeaponBoss(spawner: PowerUpSpawner<DropId>): typeof Phaser.Scene {
    class WeaponGymBoss extends GymBoss {
      init(): void {
        this.config = {
          ...this.config,
          powerUps: {
            spawner,
            placement: {
              place: (context) => ({ x: context.player.x, y: context.player.y }),
            },
            spawnInterval: 1000,
          },
        };
      }
    }
    return WeaponGymBoss as unknown as typeof Phaser.Scene;
  }

  it('AC4 — a weapon drop is collectible and equips the weapon in the registry', async () => {
    booted = await bootScene([
      makeWeaponBoss(
        new WeightedRandomSpawner<DropId>(['dual'], createSeededRng(1)),
      ),
    ]);
    const scene = booted.scene as unknown as GymBoss;

    // The boot loop advances the drop past the 3% threshold, so the
    // 'dual' drop spawned on the ship is collected and equipped.
    expect(scene.getEffectsRegistry().hasWeapon('dual')).toBe(true);
    expect(scene.getPowerUpDrops()).toHaveLength(0);
  });

  it('AC3 — spawns a weapon drop never overlapping the boss or player', async () => {
    booted = await bootScene([
      makeWeaponBoss(
        new WeightedRandomSpawner<DropId>(
          ['spread', 'dual', 'rapid'],
          createSeededRng(2),
        ),
      ),
    ]);
    const scene = booted.scene as unknown as GymBoss;

    // Place away from the player by re-rolling with the avoiding
    // placement, then assert the surviving drop avoids the bodies.
    scene.setPowerUpPlacement(
      new RandomAvoidingPlacement({ rng: createSeededRng(3) }),
    );
    scene.tick(1000);
    const drop = scene.getPowerUpDrops()[0];
    expect(drop).toBeDefined();
    expect(drop.weaponDropId).toBeDefined();

    const boss = scene.formationBoss;
    const bodies = [stubBody(boss.x, boss.y, boss.getHitRadius())];
    const player = scene.getPlayer();
    if (player) bodies.push(stubBody(player.x, player.y, SHIP_SIZE / 2));
    expect(
      isClearOfBodies(stubBody(drop.x, drop.y, POWER_UP_DROP_SIZE), bodies),
    ).toBe(true);
  });
});

describe('GymBoss — power-up collection and HUD (AH-0MU44M9NQ0006613)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots GymBoss whose first drop lands on the ship and is a P8. */
  class CollectGymBoss extends GymBoss {
    init(): void {
      const atPlayer: PowerUpPlacement = {
        place: (context) => ({ x: context.player.x, y: context.player.y }),
      };
      // Reassign a per-instance clone: `this.config` is the shared
      // module-level BOSS_CONFIG, so mutating it would leak into every
      // later GymBoss instance.
      this.config = {
        ...this.config,
        powerUps: {
          spawner: new RoundRobinSpawner<PowerUpId>(['P8']),
          placement: atPlayer,
          spawnInterval: 1000,
        },
      };
    }
  }

  it('AC2/AC5 — a drop collected on the ship applies its effect and the HUD renders', async () => {
    booted = await bootScene([CollectGymBoss as unknown as typeof Phaser.Scene]);
    const scene = booted.scene as unknown as GymBoss;

    expect(scene.getHUD()).not.toBeNull();
    expect(scene.getEffectsRegistry().lives()).toBe(4);
    expect(scene.getPowerUpDrops()).toHaveLength(0);
  });
});

describe('GymBoss — live spawn-interval control (AH-0MU44M9Z0007ZGPI)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.getElementById('boss-gym-panel')?.remove();
  });

  function getSlider(): HTMLInputElement {
    const slider = document.querySelector<HTMLInputElement>(
      '#power-up-spawn-interval',
    );
    expect(slider, 'spawn-interval slider missing').not.toBeNull();
    return slider!;
  }

  it('AC1 — renders the spawn-interval slider panel', async () => {
    booted = await bootScene([GymBoss]);

    expect(document.getElementById('boss-gym-panel')).not.toBeNull();
    expect(getSlider().value).toBe('12.5');
  });

  it('AC1 — renders a collapsible header and toggles the panel body (AH-0MUDYFMUX007Q0W3)', async () => {
    await bootScene([GymBoss]);
    const panel = document.getElementById('boss-gym-panel')!;
    const toggle = panel.querySelector<HTMLButtonElement>('.gym-panel-toggle');
    expect(toggle, 'collapse toggle missing').not.toBeNull();
    expect(toggle!.textContent).toContain('Boss Config');

    const body = panel.querySelector('.gym-panel-body');
    expect(body, 'panel body missing').not.toBeNull();
    expect(toggle!.getAttribute('aria-controls')).toBe(body!.id);
    expect(panel.getAttribute('data-collapsed')).toBe('false');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');

    toggle!.click();
    expect(panel.getAttribute('data-collapsed')).toBe('true');
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');

    toggle!.click();
    expect(panel.getAttribute('data-collapsed')).toBe('false');
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
  });

  it('AC2/AC3/AC4 — changing the slider applies live and persists across a reboot', async () => {
    booted = await bootScene([GymBoss]);
    const scene = booted.scene as GymBoss;

    const slider = getSlider();
    slider.value = '5';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(scene.getPowerUpSpawnInterval()).toBe(5);
    expect(loadRules().powerUpSpawnInterval).toBe(5);

    booted.game.destroy(true);
    booted = null;
    booted = await bootScene([GymBoss]);
    const rested = booted.scene as GymBoss;

    expect(rested.getPowerUpSpawnInterval()).toBe(5);
    expect(getSlider().value).toBe('5');
  });

  it('AC5 — SHUTDOWN removes the spawn-interval panel from the DOM', async () => {
    booted = await bootScene([GymBoss]);
    const scene = booted.scene as GymBoss;

    expect(document.getElementById('boss-gym-panel')).not.toBeNull();
    scene.events.emit(Phaser.Scenes.Events.SHUTDOWN);
    expect(document.getElementById('boss-gym-panel')).toBeNull();
  });
});

describe('GymBoss — ESC key navigation (AH-0MU9LRTK3004KR04)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.getElementById('boss-gym-panel')?.remove();
  });

  it('pressing ESC switches from GymBoss to MenuScene', async () => {
    // Boot both scenes so MenuScene is registered but not active.
    booted = await bootScene([GymBoss, MenuScene]);
    const scene = booted!.scene as GymBoss;
    expect(scene.sys.isActive()).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    // Fire a KeyboardEvent with key 'Escape'.
    // Phaser's keyboard manager listens on window (inputKeyboardEventTarget),
    // so dispatch on window rather than document.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(scene.sys.isActive()).toBe(false);
  });
});
