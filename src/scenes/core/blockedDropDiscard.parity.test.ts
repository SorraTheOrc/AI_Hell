/**
 * Gym↔game parity for the **blocked-drop stick-then-throw discard**
 * (AH-0MW3H05GY009AU0C, parent AH-0MW0UAQ23005AC9L).
 *
 * ## Why this file exists
 *
 * The rule — a drop the six-slot collection gate refuses sticks to the ship
 * for 1.5 s, is then thrown in a random direction and is destroyed at the
 * screen edge — lives once in the shared stepper
 * (`src/scenes/core/blockedDropDiscard.ts`) and is advanced from the shared
 * `CombatCoreScene._advanceDropLifecycles` template method. Every scene that
 * spawns drops must therefore reach **the same** advance:
 *
 * - `PlayScene`, `GymFormationScene`, `GymPowerUpsUtility`,
 *   `GymPowerUpsCombat` and `GymLevel` run the complete shared per-frame
 *   sequence (`_updateDropLayer`);
 * - `GymWeapons`, `GymWeaponLeveling` and `GymPowerUpLeveling` run the split
 *   magnet → lifecycle → collect sequence, whose lifecycle step is the same
 *   shared template method.
 *
 * Each case below boots the **real** scene, fills the shared six-slot pool
 * through the real player stores, places an unheld non-exempt drop on the
 * ship through that scene's own public spawn seam, and then drives that
 * scene's own per-frame step (`tick`). No assertion reads a scene-local
 * counter or a private field: the stick window, the throw and the edge
 * retirement are all observed on the drop the shared stepper owns.
 *
 * ## Q2a — the stick is explicit, not a Magnet side effect
 *
 * The parity loop records the scene's live Magnet stacks (0 in every case —
 * nothing grants Magnet) and still observes the drop following the ship for
 * the whole window. The dedicated Q2a case compares the game and a gym to
 * prove the behaviour is identical in both.
 *
 * @module scenes/core/blockedDropDiscard.parity (AH-0MW3H05GY009AU0C)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';

import {
  createReusableBoot,
  type ReusableBoot,
} from '../../test/gameHarness';
import {
  BLOCKED_DROP_STICK_SECONDS,
  BLOCKED_DROP_THROW_SPEED,
} from '../../core/constants';
import type { Player } from '../../entities/Player';
import { resolvePlayerSlotState } from '../../powerups/slots';
import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { PlayScene } from '../PlayScene';
import { GymFodderEnemies } from '../gym/GymFodderEnemies';
import { GymLevel } from '../gym/GymLevel';
import { GymPowerUpLeveling } from '../gym/GymPowerUpLeveling';
import { GymPowerUpsCombat } from '../gym/GymPowerUpsCombat';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';
import { GymWeaponLeveling } from '../gym/GymWeaponLeveling';
import { GymWeapons } from '../gym/GymWeapons';
import { isDiscarding, type BlockedDiscardState } from './blockedDropDiscard';

// Eight real Phaser scenes are booted in this file (sequentially, on one
// reused game shell); the default 5 s per-test timeout is not enough under
// host load.
vi.setConfig({ testTimeout: 180000 });

/** One deterministic simulation slice (seconds). */
const SLICE = 0.1;
/** The first refused frame (one 60 fps frame). */
const FRAME = 1 / 60;

/** The four power-ups + two weapons that fill the shared six-slot pool. */
const POWER_UP_FILL: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
];
const WEAPON_FILL: readonly WeaponId[] = ['spread', 'dual'];
/** Six power-ups only — used by the weapon-drop gyms so a weapon stays unheld. */
const SIX_POWER_UP_FILL: readonly PowerUpId[] = [
  ...POWER_UP_FILL,
  'magnet',
  'mineral_scoop',
];

/** The structural drop shape the shared stepper owns. */
interface ParityDrop {
  x: number;
  y: number;
  graphics: { setPosition(x: number, y: number): void; destroy(): void };
  blockedDiscard?: BlockedDiscardState;
}

/** Which kinds fill the pool for a consumer (the drop must stay unheld). */
type PoolFill = 'powerUpDrop' | 'weaponDrop';

/** One drop-spawning scene the shared stepper must reach. */
interface Consumer {
  /** Human label naming the scene and the shared step it consumes. */
  readonly label: string;
  /** Scene classes to register for this consumer's boot. */
  readonly scenes: (typeof Phaser.Scene)[];
  /** Kinds that fill the shared six-slot pool. */
  readonly fill: PoolFill;
  /** Neutralise optional threats so only the drop path is exercised. */
  prepare?(scene: Phaser.Scene): void;
  /** Places an unheld, non-exempt drop through the scene's own spawn seam. */
  spawn(scene: Phaser.Scene, x: number, y: number): ParityDrop;
  /** The scene's own live-drop accessor (never a test-owned field). */
  live(scene: Phaser.Scene): ParityDrop[];
  /** One real per-frame simulation step of that scene. */
  tick(scene: Phaser.Scene, dt: number): void;
}

/** What one consumer's run observed (the parity comparison reads these). */
interface ParityObservation {
  readonly label: string;
  /** Live Magnet stacks at the moment the drop was refused. */
  readonly magnetStacks: number;
  /** Accumulated stick time when the shared stepper launched the drop. */
  readonly stickSecondsAtLaunch: number;
  /** Whether the launched drop was retired at a screen edge. */
  readonly removedAtEdge: boolean;
}

/**
 * The eight consumers of the shared drop path.
 *
 * `GymFormationScene` is the generic base; `GymFodderEnemies` is one concrete
 * formation gym, so the inherited `_updateDropLayer` wiring is exercised
 * exactly as every other formation gym runs it.
 */
const CONSUMERS: readonly Consumer[] = [
  {
    label: 'PlayScene (_updateDropLayer)',
    scenes: [PlayScene, GameOverScene, MenuScene, MineralChoiceScene],
    fill: 'powerUpDrop',
    prepare: (scene) => (scene as PlayScene).setAsteroidSpawnerEnabled(false),
    spawn: (scene, x, y) =>
      (scene as PlayScene).spawnPowerUpDrop('teleport', x, y)!,
    live: (scene) => (scene as PlayScene).getDrops(),
    tick: (scene, dt) => (scene as PlayScene).tick(dt),
  },
  {
    label: 'GymFormationScene (_updateDropLayer, via GymFodderEnemies)',
    scenes: [GymFodderEnemies],
    fill: 'powerUpDrop',
    spawn: (scene, x, y) =>
      (scene as GymFodderEnemies).spawnPowerUpDrop('teleport', x, y)!,
    live: (scene) => (scene as GymFodderEnemies).getPowerUpDrops(),
    tick: (scene, dt) => (scene as GymFodderEnemies).tick(dt),
  },
  {
    label: 'GymPowerUpsUtility (_updateDropLayer)',
    scenes: [GymPowerUpsUtility],
    fill: 'powerUpDrop',
    spawn: (scene, x, y) =>
      (scene as GymPowerUpsUtility).spawnDrop('teleport', x, y),
    live: (scene) => (scene as GymPowerUpsUtility).getDrops(),
    tick: (scene, dt) => (scene as GymPowerUpsUtility).tick(dt),
  },
  {
    label: 'GymPowerUpsCombat (_updateDropLayer)',
    scenes: [GymPowerUpsCombat],
    fill: 'powerUpDrop',
    prepare: (scene) => {
      const gym = scene as GymPowerUpsCombat;
      if (gym.shootingEnabled) gym.toggleShooting();
    },
    spawn: (scene, x, y) =>
      (scene as GymPowerUpsCombat).spawnDrop('teleport', x, y),
    live: (scene) => (scene as GymPowerUpsCombat).getDrops(),
    tick: (scene, dt) => (scene as GymPowerUpsCombat).tick(dt),
  },
  {
    label: 'GymLevel (_updateDropLayer)',
    scenes: [GymLevel],
    fill: 'powerUpDrop',
    prepare: (scene) => (scene as GymLevel).setAsteroidSpawnerEnabled(false),
    spawn: (scene, x, y) =>
      (scene as GymLevel).spawnSupplyDrop('teleport', x, y),
    live: (scene) => (scene as GymLevel).getDrops(),
    tick: (scene, dt) => (scene as GymLevel).tick(dt),
  },
  {
    label: 'GymWeapons (split magnet → lifecycle → collect)',
    scenes: [GymWeapons],
    fill: 'weaponDrop',
    spawn: (scene, x, y) => (scene as GymWeapons).spawnDrop('spread', x, y),
    live: (scene) => (scene as GymWeapons).getDrops(),
    tick: (scene, dt) => (scene as GymWeapons).tick(dt),
  },
  {
    label: 'GymWeaponLeveling (split magnet → lifecycle → collect)',
    scenes: [GymWeaponLeveling],
    fill: 'weaponDrop',
    spawn: (scene, x, y) =>
      (scene as GymWeaponLeveling).spawnDrop('spread', x, y),
    live: (scene) => (scene as GymWeaponLeveling).getDrops(),
    tick: (scene, dt) => (scene as GymWeaponLeveling).tick(dt),
  },
  {
    label: 'GymPowerUpLeveling (split magnet → lifecycle → collect)',
    scenes: [GymPowerUpLeveling],
    fill: 'powerUpDrop',
    spawn: (scene, x, y) =>
      (scene as GymPowerUpLeveling).spawnDrop('teleport', x, y),
    live: (scene) => (scene as GymPowerUpLeveling).getDrops(),
    tick: (scene, dt) => (scene as GymPowerUpLeveling).tick(dt),
  },
];

/** The live ship of a booted scene (every consumer creates one in `create`). */
function shipOf(scene: Phaser.Scene): Player {
  const player = (scene as unknown as { getPlayer(): Player | null }).getPlayer();
  if (!player) throw new Error('booted scene has no ship');
  return player;
}

/** The scene's live Magnet stack count (the Q2a premise). */
function magnetStacks(scene: Phaser.Scene): number {
  return (
    scene as unknown as {
      getEffectsRegistry(): { magnetEffectStacks(): number };
    }
  )
    .getEffectsRegistry()
    .magnetEffectStacks();
}

/**
 * Fills the shared six-slot pool through the real player stores, so the
 * drop's kind is neither held, exempt, nor slot-exempt and the collection
 * gate refuses it.
 */
function fillPool(player: Player, fill: PoolFill): void {
  const powerUps = fill === 'weaponDrop' ? SIX_POWER_UP_FILL : POWER_UP_FILL;
  for (const id of powerUps) player.getPowerUpLevelStore().collect(id, true);
  if (fill === 'powerUpDrop') {
    for (const id of WEAPON_FILL) player.equipWeapon(id, true);
  }
  const state = resolvePlayerSlotState(player);
  expect(state.free, 'the shared pool has no free slot').toBe(0);
  expect(state.isFull, 'the shared six-slot pool is full').toBe(true);
}

/**
 * Boots one consumer, refuses its drop at a full pool and drives the scene's
 * own per-frame step through the whole stick → throw → edge-retire sequence.
 */
async function driveConsumer(
  boot: ReusableBoot,
  consumer: Consumer,
): Promise<ParityObservation> {
  const label = consumer.label;
  const booted = await boot.boot(consumer.scenes);
  // Deterministic driving: the live loop never advances the scene behind the
  // test's explicit `tick(dt)` slices.
  booted.game.loop.stop();
  const scene = booted.scene;
  consumer.prepare?.(scene);

  const player = shipOf(scene);
  fillPool(player, consumer.fill);
  const magnet = magnetStacks(scene);

  // An unheld, non-exempt drop placed exactly on the ship.
  const drop = consumer.spawn(scene, player.x, player.y);

  // First refused frame: the shared collection seam starts the stick window
  // on this frame (producer Q1a) and snaps the drop onto the ship.
  consumer.tick(scene, FRAME);
  expect(drop.blockedDiscard, `${label}: the refused drop starts sticking`).toBeDefined();
  expect(isDiscarding(drop), `${label}: the drop is not thrown on the first frame`).toBe(false);
  expect(drop.x, `${label}: the sticking drop is snapped onto the ship (x)`).toBeCloseTo(
    player.x,
    6,
  );
  expect(drop.y, `${label}: the sticking drop is snapped onto the ship (y)`).toBeCloseTo(
    player.y,
    6,
  );

  // 1.4 s of dt slices inside the window: the drop follows the moving ship
  // every frame, with no Magnet stacks involved (producer Q2a).
  for (let i = 0; i < 14; i++) {
    player.setPosition(player.x + 2, player.y + 1);
    consumer.tick(scene, SLICE);
    expect(isDiscarding(drop), `${label}: still sticking inside the window`).toBe(false);
    expect(drop.x, `${label}: the sticking drop tracks the ship on x`).toBeCloseTo(player.x, 6);
    expect(drop.y, `${label}: the sticking drop tracks the ship on y`).toBeCloseTo(player.y, 6);
  }
  expect(drop.blockedDiscard?.stickSeconds, `${label}: 1.4 s accumulated`).toBeCloseTo(1.4, 6);

  // The 1.5 s window elapses: the shared stepper launches the drop.
  consumer.tick(scene, SLICE);
  expect(isDiscarding(drop), `${label}: the window elapses and throws the drop`).toBe(true);
  const stickSecondsAtLaunch = drop.blockedDiscard!.stickSeconds;

  // The throw travels in a straight line at the shared speed and ignores the
  // ship (the ship is moved far away before the first flight step).
  const launchX = drop.x;
  const launchY = drop.y;
  player.setPosition(40, 40);
  consumer.tick(scene, SLICE);
  const stepX = drop.x - launchX;
  const stepY = drop.y - launchY;
  const stepDistance = Math.hypot(stepX, stepY);
  expect(stepDistance, `${label}: the throw advances at the shared speed`).toBeCloseTo(
    BLOCKED_DROP_THROW_SPEED * SLICE,
    3,
  );
  const direction = { x: stepX / stepDistance, y: stepY / stepDistance };

  // Keep flying until the shared stepper retires the drop at a screen edge.
  const destroy = vi.spyOn(drop.graphics, 'destroy');
  let removed = false;
  for (let i = 0; i < 200 && !removed; i++) {
    const beforeX = drop.x;
    const beforeY = drop.y;
    consumer.tick(scene, SLICE);
    removed = !consumer.live(scene).includes(drop);
    if (!removed) {
      expect(drop.x - beforeX, `${label}: the throw is a straight line on x`).toBeCloseTo(
        direction.x * stepDistance,
        3,
      );
      expect(drop.y - beforeY, `${label}: the throw is a straight line on y`).toBeCloseTo(
        direction.y * stepDistance,
        3,
      );
    }
  }
  expect(removed, `${label}: a launched drop is removed at a screen edge`).toBe(true);
  expect(destroy, `${label}: the discarded Graphics is destroyed exactly once`).toHaveBeenCalledTimes(
    1,
  );

  return { label, magnetStacks: magnet, stickSecondsAtLaunch, removedAtEdge: removed };
}

describe('blocked-drop discard — game ↔ gym parity (AH-0MW3H05GY009AU0C)', () => {
  let boot: ReusableBoot;

  beforeEach(() => {
    localStorage.clear();
    boot = createReusableBoot();
  });

  afterEach(() => {
    boot.dispose();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('every consumer of the shared drop path reaches the discard advance: stick, throw and edge retirement', async () => {
    for (const consumer of CONSUMERS) {
      const observation = await driveConsumer(boot, consumer);
      expect(observation.removedAtEdge, `${observation.label}: retired at the edge`).toBe(true);
      expect(
        observation.stickSecondsAtLaunch,
        `${observation.label}: the shared 1.5 s window elapsed`,
      ).toBeGreaterThanOrEqual(BLOCKED_DROP_STICK_SECONDS);
    }
  });

  it('Q2a — a drop refused at a full pool sticks and is thrown without Magnet, identically in the game and in a gym', async () => {
    // The game and a gym that consumes the complete shared drop sequence.
    const play = CONSUMERS[0];
    const gym = CONSUMERS[3];
    expect(play.label).toContain('PlayScene');
    expect(gym.label).toContain('GymPowerUpsCombat');

    const gameObservation = await driveConsumer(boot, play);
    const gymObservation = await driveConsumer(boot, gym);

    // No Magnet was owned in either run, yet the drop stuck for the whole
    // window — the explicit stick, not `applyMagnetAttraction` (Q2a).
    expect(gameObservation.magnetStacks, 'PlayScene owns no Magnet').toBe(0);
    expect(gymObservation.magnetStacks, 'the gym owns no Magnet').toBe(0);
    expect(gameObservation.removedAtEdge, 'PlayScene retires the thrown drop').toBe(true);
    expect(gymObservation.removedAtEdge, 'the gym retires the thrown drop').toBe(true);

    // The shared stepper decides the window, so both scenes observe exactly
    // the same stick duration. (The throw *direction* is deliberately random
    // per scene from its own seeded stream, so it is not compared; the shared
    // throw speed is asserted inside `driveConsumer` for both.)
    expect(gymObservation.stickSecondsAtLaunch, 'the same stick window').toBeCloseTo(
      gameObservation.stickSecondsAtLaunch,
      6,
    );
  });
});
