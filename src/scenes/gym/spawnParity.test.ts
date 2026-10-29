/**
 * Gym↔game **spawn / fire / march** parity tests for the *level-launch* path
 * (AH-0MVRMHJZS001Z6CX — the test-first half of the parent bug
 * AH-0MVP5IGX5005XTVV).
 *
 * ## Why this file exists
 *
 * `GymLevel` — and therefore `GymBotTuning` through inheritance — carries its
 * own inline wave-spawn implementation. It had drifted from the shipped
 * `PlayScene` in three observable ways:
 *
 * 1. **Orbital transit destination.** `PlayScene._spawnEnemy` resolves an
 *    orbital entity's wormhole-transit destination through the entity's live
 *    `formationSlot()` seam (AH-0MVEXVME1004SIIS), so a Phaser emerges
 *    straight onto the point it will orbit on. `GymLevel` resolved the straight
 *    grid line instead, so Phasers transited a line and snapped onto the ring
 *    when the spawn window ended.
 * 2. **Fire hand-off.** `PlayScene` copies the wave's `shootEnabled` onto every
 *    spawned entity; `GymLevel` did not, so launched campaign waves (Levels
 *    4+) were silently non-threatening in the gym.
 * 3. **March block.** `PlayScene` drives a rigid `marchState` block (step,
 *    reverse, drop); `GymLevel` only had horizontal `driftX`, so launched
 *    march waves rendered as a static line.
 *
 * ## Red-before / green-after (repo convention)
 *
 * Every assertion in this file **failed on the pre-fix HEAD** and was written
 * as Vitest `it.fails(...)` — the repo's red-before/green-after convention (cf.
 * the header of `levelParity.test.ts` and the "per-level kill-drop chance"
 * precedent in `PlayScene.test.ts`, AH-0MVLJF4DI000BKMQ). The red state is
 * recorded in AH-0MVRMHJZS001Z6CX's comment with the exact failing output;
 * the fix items have now flipped every marker to a plain `it`, so a regression
 * fails loudly:
 *
 * - shared transit seam: AH-0MVRMHQC9003VDNN
 * - `GymLevel` / `GymBotTuning` behaviour fix: AH-0MVRMHSKH0066J9B (this item)
 *
 * While the red-before assertions existed, `it.fails` kept the *rest* of the
 * suite green (AC5) and made an unexpected pass fail loudly, so the fix could
 * not land without flipping the markers.
 *
 * ## No divergent copy
 *
 * Both scenes are booted through the shared `bootScene` harness
 * (`src/test/gameHarness.ts`) and driven with an identical fixed-dt step
 * sequence. The wave is authored once and handed to both scenes; a fixed run
 * seed (`PlayScene.setRunSeed` / the `GymLevelData.seed` seam) removes every
 * `Math.random` input the two scenes share. No expectation re-implements the
 * transit/orbit/march/fire policy: each expected value is read from the same
 * object the game reads (the live `formationSlot()`, the entities' own march
 * positions and the bullet objects the dispatcher produced).
 *
 * @module scenes/gym/spawnParity (AH-0MVRMHJZS001Z6CX)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/enemyConfig';
import { RULES_STORAGE_KEY } from '../../core/rules';
import {
  resetConfigStore,
  seedConfigStore,
} from '../../core/configStore';
import { resetBotTuningStore } from '../../core/botTuningStore';
import type { EnemyEntity } from '../../entities/enemyFactory';
import { PHASER_ORBITAL_RADIUS, PhaserEntity } from '../../entities/Phaser';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';
import {
  ENEMY_GROWTH_DURATION,
  WORMHOLE_OPEN_DURATION,
  getSpawnState,
  type SpawnAnimatable,
} from '../../vfx/wormholeSpawn';
import { DEFAULT_MARCH_DROP } from '../core/marchFormation';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import {
  GYM_BOT_TUNING_SCENE_KEY,
  GymBotTuning,
} from './GymBotTuning';
import { GYM_LEVEL_SCENE_KEY, GymLevel } from './GymLevel';

// ── Shared fixture ──────────────────────────────────────────────────

/** Fixed run seed — both scenes see the same RNG stream (no `Math.random`). */
const PARITY_SEED = 0x5eed1234;

/** Simulated milliseconds both scenes are advanced after `create()` (aligned). */
const SETUP_MS = 200;

/** Fixed simulation step (~60 fps) used to drive both scenes in lock-step. */
const FRAME_MS = 1000 / 60;

/** The wave group currently under test (read back for its authored base). */
interface ParityWave {
  level: LevelDefinition;
  wave: WaveDefinition;
  group: WaveDefinition['groups'][number];
}

/** A single-wave level at level 1 (identity scaling) built from `group`. */
function parityWave(group: WaveDefinition['groups'][number]): ParityWave {
  const wave: WaveDefinition = { groups: [group], shootEnabled: false };
  return {
    level: { level: 1, name: 'Spawn parity probe', waves: [wave] },
    wave,
    group,
  };
}

/**
 * A ring of orbital Phasers. Kept near the top of the field so the game's
 * player-avoiding portal placement leaves the formation anchor unchanged
 * (gyms have no ship, so the game and the gym then share one formation base).
 */
function orbitalProbe(count = 6): ParityWave {
  return parityWave({
    enemyKey: 'phaser',
    formation: 'orbital',
    count,
    spacingX: 40,
    spacingY: 40,
    startX: GAME_WIDTH * 0.5,
    startY: GAME_HEIGHT * 0.35,
  });
}

/**
 * A launched firing wave. `shootEnabled` is part of the wave definition —
 * exactly the hand-off the gym was missing — never set on an entity by the
 * test. Campaign Levels 4+ carry the same flag (`src/waves/Formations.ts`,
 * `openFire(...)`).
 */
function firingProbe(): ParityWave {
  const probe = parityWave({
    enemyKey: 'scout',
    formation: 'v',
    count: 3,
    spacingX: 26,
    spacingY: 26,
    startX: GAME_WIDTH * 0.5,
    startY: GAME_HEIGHT * 0.25,
  });
  probe.wave.shootEnabled = true;
  return probe;
}

/**
 * A launched march block, spawned close to the right arena edge so the first
 * edge reversal (and its drop) is reached within a few simulated seconds,
 * safely inside the shared 30 s wave window.
 */
function marchProbe(): ParityWave {
  return parityWave({
    enemyKey: 'march',
    formation: 'march',
    count: 3,
    spacingX: 40,
    spacingY: 40,
    startX: GAME_WIDTH - 180,
    startY: GAME_HEIGHT * 0.22,
  });
}

// ── Boot helpers ────────────────────────────────────────────────────

interface SceneBoot<TScene> {
  game: BootedGame['game'];
  scene: TScene;
}

let boots: BootedGame[] = [];
let restores: Array<() => void> = [];

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  resetConfigStore();
  seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS));
  resetBotTuningStore();
});

afterEach(() => {
  for (const restore of restores) restore();
  restores = [];
  for (const booted of boots) booted.game.destroy(true);
  boots = [];
  document.body.innerHTML = '';
  window.localStorage.clear();
});

/**
 * Disables the ship's auto-fire through the same test seam the PlayScene
 * suite uses. Without it the player would thin the formation mid-measurement
 * (which would feed back into the march speed-up and the fire cadence).
 */
function disableAutoFire(scene: GymLevel | PlayScene | GymBotTuning): void {
  const isolated = scene as unknown as { autoFireEnabled(): boolean };
  const original = isolated.autoFireEnabled;
  isolated.autoFireEnabled = () => false;
  restores.push(() => {
    isolated.autoFireEnabled = original;
  });
}

/** Boots the level gym with the parity wave and aligns it to `SETUP_MS`. */
async function bootGymLevel(data: { level: LevelDefinition; seed?: number }): Promise<SceneBoot<GymLevel>> {
  const booted = await bootScene([GymLevel], 'gym-container');
  boots.push(booted);
  booted.game.loop.stop();
  booted.game.scene.start(GYM_LEVEL_SCENE_KEY, data);
  await advanceGame(booted.game, SETUP_MS);
  const scene = booted.game.scene.getScene(GYM_LEVEL_SCENE_KEY) as GymLevel;
  scene.setAsteroidSpawnerEnabled(false);
  disableAutoFire(scene);
  return { game: booted.game, scene };
}

/** Boots the bot-tuning gym (a `GymLevel` subclass) with the same wave. */
async function bootGymBotTuning(data: {
  level: LevelDefinition;
  seed?: number;
}): Promise<SceneBoot<GymBotTuning>> {
  const booted = await bootScene([GymBotTuning], 'bot-tuning-container');
  boots.push(booted);
  booted.game.loop.stop();
  booted.game.scene.start(GYM_BOT_TUNING_SCENE_KEY, data);
  await advanceGame(booted.game, SETUP_MS);
  const scene = booted.game.scene.getScene(
    GYM_BOT_TUNING_SCENE_KEY,
  ) as GymBotTuning;
  scene.setAsteroidSpawnerEnabled(false);
  disableAutoFire(scene);
  return { game: booted.game, scene };
}

/** Boots the shipped game scene with the same wave and aligned setup time. */
async function bootPlayScene(level: LevelDefinition): Promise<SceneBoot<PlayScene>> {
  // The shipped default sequences the campaign; opt out so the probe level is
  // the one `create()` plays.
  localStorage.setItem(
    RULES_STORAGE_KEY,
    JSON.stringify({ sequencedWavesEnabled: false }),
  );
  const booted = await bootScene(
    [PlayScene, GameOverScene, MenuScene],
    'play-container',
  );
  boots.push(booted);
  const scene = booted.scene as PlayScene;
  // Fixed run seed: the game's RNG-driven seams (drops/hazard/portal ties)
  // see one deterministic stream, matching the gym's seeded seam.
  scene.setRunSeed(PARITY_SEED);
  scene.getWaveManager().setLevels([level]);
  scene.setAsteroidSpawnerEnabled(false);
  scene.scene.restart();
  // `restart()` is queued; the same fixed-dt settle the gym receives makes the
  // two scenes' per-create tick counts identical (drift, orbit phase, march
  // accumulator and spawn window all advance by the same number of steps).
  await advanceGame(booted.game, SETUP_MS);
  scene.setAsteroidSpawnerEnabled(false);
  disableAutoFire(scene);
  return { game: booted.game, scene };
}

/**
 * Drives every supplied game by the identical fixed-dt sequence, so both
 * scenes observe the same `delta` and the same absolute `scene.time.now`
 * timestamp on every tick.
 */
function createLockStep(games: BootedGame['game'][]): { tick(): number } {
  for (const game of games) game.loop.stop();
  // Anchor to the real clock: the value must be later than every game's boot
  // timestamp so the Phaser scene clock never runs backwards.
  let time = window.performance.now();
  return {
    tick() {
      time += FRAME_MS;
      for (const game of games) game.step(time, FRAME_MS);
      return time;
    },
  };
}

// ── Observation helpers ─────────────────────────────────────────────

/** Live Phasers in spawn order (the order both scenes spawned them in). */
function livePhasers(scene: GymLevel | PlayScene): PhaserEntity[] {
  return scene
    .getEnemies()
    .filter((enemy): enemy is PhaserEntity => enemy instanceof PhaserEntity && enemy.alive);
}

/** The live per-frame transit destination of a spawning Phaser. */
function spawnDestination(entity: PhaserEntity): { x: number; y: number } | undefined {
  return getSpawnState(entity as unknown as SpawnAnimatable)?.destFn?.();
}

/**
 * True when the points are not all collinear (a ring is not, a straight grid
 * line is). Used to reject the pre-fix "transit along the grid line" path.
 */
function hasNonCollinearPoint(points: readonly { x: number; y: number }[]): boolean {
  if (points.length < 3) return false;
  const [a, b] = points;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  return points
    .slice(2)
    .some((p) => Math.abs(abx * (p.y - a.y) - aby * (p.x - a.x)) > 1);
}

/**
 * Reconstructs a march block's live base position from its members: every
 * member sits at `base + offset × spacing` (plus the Scout body's shared
 * visual wiggle, which is identical for every member and cancels in the
 * mean). Reading it from the entities keeps the test free of any copy of the
 * march policy.
 */
function marchBase(
  entities: readonly EnemyEntity[],
  spacingX: number,
  spacingY: number,
): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const entity of entities) {
    const offset = entity.offset;
    x += entity.x - offset.col * spacingX;
    y += entity.y - offset.row * spacingY;
  }
  return { x: x / entities.length, y: y / entities.length };
}

/** Live march members in spawn order. */
function liveMarch(scene: GymLevel | PlayScene): EnemyEntity[] {
  return scene.getEnemies().filter((enemy) => enemy.alive);
}

/** One frame's sampled march base, in step-event form. */
interface MarchSample {
  frame: number;
  x: number;
  y: number;
  /** Horizontal step applied this frame (0 when the block did not step). */
  stepDir: 1 | -1 | 0;
}

// ── AC1 — orbital spawn transit ─────────────────────────────────────

describe('GymLevel × PlayScene — orbital spawn transit parity (AH-0MVRMHJZS001Z6CX)', () => {
  it(
    'AC1 (red-before) — every frame of the spawn window transits each Phaser to its live formationSlot(), not the grid line',
    async () => {
      const probe = orbitalProbe(6);
      const gym = await bootGymLevel({ level: probe.level, seed: PARITY_SEED });
      const play = await bootPlayScene(probe.level);

      expect(livePhasers(gym.scene)).toHaveLength(6);
      expect(livePhasers(play.scene)).toHaveLength(6);

      const stepper = createLockStep([gym.game, play.game]);
      const spawnWindowSeconds = WORMHOLE_OPEN_DURATION + ENEMY_GROWTH_DURATION;
      const maxFrames = Math.ceil(spawnWindowSeconds / (FRAME_MS / 1000)) + 10;
      let observedFrames = 0;

      for (let frame = 0; frame < maxFrames; frame += 1) {
        const gymPhasers = livePhasers(gym.scene);
        const playPhasers = livePhasers(play.scene);
        expect(gymPhasers, `frame ${frame}: live Phaser count`).toHaveLength(6);
        expect(playPhasers, `frame ${frame}: live Phaser count`).toHaveLength(6);

        // The spawn window ends when the shared animation clears the state.
        if (getSpawnState(gymPhasers[0] as unknown as SpawnAnimatable) === null) {
          break;
        }

        // The gym's live formation base: the same drift the destination
        // resolver consumes (gyms have no player-avoiding portal shift, and
        // the probe sits far from the game's ship).
        const baseX = probe.group.startX + gym.scene.getFormationDriftX();
        const baseY = probe.group.startY;
        const gymDestinations: Array<{ x: number; y: number }> = [];

        for (let i = 0; i < gymPhasers.length; i += 1) {
          const phaser = gymPhasers[i];
          const destination = spawnDestination(phaser);
          expect(
            destination,
            `frame ${frame}: Phaser ${i} has no live transit destination`,
          ).toBeDefined();

          // AC1 — the destination IS the entity's live orbital slot.
          const slot = phaser.formationSlot(baseX, baseY);
          expect(destination!.x, `frame ${frame}: Phaser ${i} transit x`).toBeCloseTo(
            slot.x,
            6,
          );
          expect(destination!.y, `frame ${frame}: Phaser ${i} transit y`).toBeCloseTo(
            slot.y,
            6,
          );
          // ...which lies on the orbital ring around the formation base.
          expect(
            Math.hypot(destination!.x - baseX, destination!.y - baseY),
            `frame ${frame}: Phaser ${i} is off the orbital ring`,
          ).toBeCloseTo(PHASER_ORBITAL_RADIUS, 3);

          // Cross-scene: the same seeded wave driven through PlayScene resolves
          // the same target. The 2 px tolerance absorbs the independent scene
          // clocks (a one-frame phase delta is < 1 px on the 80 px ring); the
          // pre-fix grid-line divergence is tens of px.
          const playDestination = spawnDestination(playPhasers[i]);
          expect(
            playDestination,
            `frame ${frame}: PlayScene Phaser ${i} has no transit destination`,
          ).toBeDefined();
          expect(
            Math.abs(destination!.x - playDestination!.x),
            `frame ${frame}: Phaser ${i} gym/game transit x`,
          ).toBeLessThan(2);
          expect(
            Math.abs(destination!.y - playDestination!.y),
            `frame ${frame}: Phaser ${i} gym/game transit y`,
          ).toBeLessThan(2);

          gymDestinations.push(destination!);
        }

        // "No frame may place the Phaser on the straight grid line": a grid
        // line is collinear, an orbital ring is not.
        expect(
          hasNonCollinearPoint(gymDestinations),
          `frame ${frame}: destinations are collinear (straight grid line, not the ring)`,
        ).toBe(true);

        observedFrames += 1;
        stepper.tick();
      }

      expect(observedFrames, 'full spawn window observed').toBeGreaterThan(100);

      // End of the window: the Phasers land exactly on their live slots (no
      // snap), in the gym and in the game.
      gym.scene.finishSpawnAnimations();
      play.scene.finishSpawnAnimations();
      const baseX = probe.group.startX + gym.scene.getFormationDriftX();
      const baseY = probe.group.startY;
      const gymLanded = livePhasers(gym.scene);
      const playLanded = livePhasers(play.scene);
      expect(gymLanded).toHaveLength(6);
      expect(playLanded).toHaveLength(6);
      for (let i = 0; i < gymLanded.length; i += 1) {
        const slot = gymLanded[i].formationSlot(baseX, baseY);
        expect(gymLanded[i].x, `landing x (Phaser ${i})`).toBeCloseTo(slot.x, 3);
        expect(gymLanded[i].y, `landing y (Phaser ${i})`).toBeCloseTo(slot.y, 3);
        expect(
          Math.abs(gymLanded[i].x - playLanded[i].x),
          `gym/game landing x (Phaser ${i})`,
        ).toBeLessThan(2);
        expect(
          Math.abs(gymLanded[i].y - playLanded[i].y),
          `gym/game landing y (Phaser ${i})`,
        ).toBeLessThan(2);
      }
    },
  );
});

// ── AC2 — post-spawn fire cadence ───────────────────────────────────

interface FireRecord {
  /** Absolute scene clock timestamp of the tick the bullet first appeared. */
  at: number;
  /** Bullet speed (px/s) — the magnitude the shared dispatcher produced. */
  speed: number;
}

/** Tracks bullets by object identity so expiry cannot hide a fired shot. */
function collectNewBullets<TBullet extends { vx: number; vy: number }>(
  live: readonly TBullet[],
  seen: Set<TBullet>,
  out: FireRecord[],
  at: number,
): void {
  for (const bullet of live) {
    if (seen.has(bullet)) continue;
    seen.add(bullet);
    out.push({ at, speed: Math.hypot(bullet.vx, bullet.vy) });
  }
}

describe('GymLevel × PlayScene — launched-wave fire cadence parity (AH-0MVRMHJZS001Z6CX)', () => {
  it(
    'AC2 (red-before) — a wave with shootEnabled: true fires the same bullets at the same ticks and speed in the gym as in the game',
    async () => {
      const probe = firingProbe();
      const gym = await bootGymLevel({ level: probe.level, seed: PARITY_SEED });
      const play = await bootPlayScene(probe.level);

      // Complete the spawn window in both scenes so the measurement is the
      // *post-spawn* cadence the AC describes (the shared spawn animation
      // suppresses fire while an enemy is growing).
      gym.scene.finishSpawnAnimations();
      play.scene.finishSpawnAnimations();

      const stepper = createLockStep([gym.game, play.game]);
      const gymShots: FireRecord[] = [];
      const playShots: FireRecord[] = [];
      const gymSeen = new Set<{ vx: number; vy: number }>();
      const playSeen = new Set<{ vx: number; vy: number }>();

      for (let frame = 0; frame < 300; frame += 1) {
        const at = stepper.tick();
        collectNewBullets(gym.scene.getEnemyBullets(), gymSeen, gymShots, at);
        collectNewBullets(play.scene.getEnemyBullets(), playSeen, playShots, at);
      }

      // The gym must actually be threatened by a firing wave (pre-fix: 0).
      expect(
        gymShots.length,
        'GymLevel fired the wave’s shootEnabled bullets',
      ).toBeGreaterThan(0);

      // Same number of bullets...
      expect(gymShots.length, 'bullet count').toBe(playShots.length);
      // ...at the same scene-clock ticks...
      expect(
        gymShots.map((shot) => shot.at),
        'bullet spawn ticks (scene.time.now)',
      ).toEqual(playShots.map((shot) => shot.at));
      // ...with the same speed.
      for (let i = 0; i < gymShots.length; i += 1) {
        expect(gymShots[i].speed, `bullet ${i} speed`).toBeCloseTo(
          playShots[i].speed,
          6,
        );
      }

      // And the flag flows from the wave definition, not from the test: every
      // spawned entity carries the wave's `shootEnabled`.
      for (const enemy of gym.scene.getEnemies().filter((e) => e.alive)) {
        expect(enemy.shootEnabled, 'gym entity shootEnabled').toBe(true);
      }
      for (const enemy of play.scene.getEnemies().filter((e) => e.alive)) {
        expect(enemy.shootEnabled, 'game entity shootEnabled').toBe(true);
      }
    },
  );
});

// ── AC3 — march block ───────────────────────────────────────────────

describe('GymLevel × PlayScene — launched march block parity (AH-0MVRMHJZS001Z6CX)', () => {
  it(
    'AC3 (red-before) — an identical dt sequence produces the identical march base (step, edge reversal and drop) in the gym and the game',
    async () => {
      const probe = marchProbe();
      const gym = await bootGymLevel({ level: probe.level, seed: PARITY_SEED });
      const play = await bootPlayScene(probe.level);
      gym.scene.finishSpawnAnimations();
      play.scene.finishSpawnAnimations();

      const gymMembers = liveMarch(gym.scene);
      const playMembers = liveMarch(play.scene);
      expect(gymMembers, 'gym march members').toHaveLength(probe.group.count);
      expect(playMembers, 'game march members').toHaveLength(probe.group.count);

      // Same members, same per-member offsets (the block geometry).
      for (let i = 0; i < gymMembers.length; i += 1) {
        expect(gymMembers[i].offset, `member ${i} offset`).toEqual(
          playMembers[i].offset,
        );
      }

      const startGym = marchBase(
        gymMembers,
        probe.group.spacingX,
        probe.group.spacingY,
      );
      const startPlay = marchBase(
        playMembers,
        probe.group.spacingX,
        probe.group.spacingY,
      );

      // The block starts from the same base (the probe's portal placement is
      // anchor-preserving in both scenes, asserted by the shared start x).
      expect(Math.abs(startGym.x - startPlay.x), 'start base x').toBeLessThan(0.5);
      expect(Math.abs(startGym.y - startPlay.y), 'start base y').toBeLessThan(1e-6);

      const STEP_EVENT_THRESHOLD = 5; // px — a step is a 20 px jump; drift/wiggle is < 1 px
      const samples: { gym: MarchSample; play: MarchSample }[] = [];
      let previousGym = startGym;
      let previousPlay = startPlay;
      const stepper = createLockStep([gym.game, play.game]);

      for (let frame = 0; frame < 540; frame += 1) {
        stepper.tick();
        const gymBase = marchBase(
          liveMarch(gym.scene),
          probe.group.spacingX,
          probe.group.spacingY,
        );
        const playBase = marchBase(
          liveMarch(play.scene),
          probe.group.spacingX,
          probe.group.spacingY,
        );

        const gymDx = gymBase.x - previousGym.x;
        const playDx = playBase.x - previousPlay.x;
        const gymStep: MarchSample['stepDir'] =
          Math.abs(gymDx) >= STEP_EVENT_THRESHOLD
            ? gymDx > 0
              ? 1
              : -1
            : 0;
        const playStep: MarchSample['stepDir'] =
          Math.abs(playDx) >= STEP_EVENT_THRESHOLD
            ? playDx > 0
              ? 1
              : -1
            : 0;

        samples.push({
          gym: { frame, x: gymBase.x, y: gymBase.y, stepDir: gymStep },
          play: { frame, x: playBase.x, y: playBase.y, stepDir: playStep },
        });

        // Same base y every frame (a drop is a base-y change).
        expect(gymBase.y, `frame ${frame}: base y`).toBeCloseTo(playBase.y, 6);
        // Same x trajectory up to the fixed harness start offset (the mean
        // includes the Scout body's shared wiggle, which is identical in both
        // scenes and cancels in a displacement).
        expect(
          gymBase.x - startGym.x,
          `frame ${frame}: base x displacement`,
        ).toBeCloseTo(playBase.x - startPlay.x, 6);

        previousGym = gymBase;
        previousPlay = playBase;
      }

      // Same step events at the same frames (a direction reversal included).
      expect(
        samples.map((sample) => sample.gym.stepDir),
        'march step direction per frame',
      ).toEqual(samples.map((sample) => sample.play.stepDir));

      const stepFrames = samples.filter((sample) => sample.gym.stepDir !== 0);
      expect(stepFrames.length, 'the block stepped').toBeGreaterThan(3);

      // Direction sequence: right first, then a reversal to left.
      const directions = stepFrames.map((sample) => sample.gym.stepDir);
      expect(directions[0], 'initial march direction').toBe(1);
      const reversalIndex = directions.findIndex(
        (direction, index) => index > 0 && direction !== directions[index - 1],
      );
      expect(reversalIndex, 'at least one edge reversal').toBeGreaterThan(0);
      expect(directions[reversalIndex], 'direction after reversal').toBe(-1);

      // The reversal drops the block one fixed drop, in both scenes.
      const dropFrames = samples.filter((sample, index) => {
        if (index === 0) return false;
        return Math.abs(sample.gym.y - samples[index - 1].gym.y) > 1;
      });
      expect(dropFrames.length, 'at least one march drop').toBeGreaterThan(0);
      for (const sample of dropFrames) {
        const index = samples.indexOf(sample);
        const delta = sample.gym.y - samples[index - 1].gym.y;
        expect(delta, `frame ${sample.gym.frame}: drop size`).toBeCloseTo(
          DEFAULT_MARCH_DROP,
          6,
        );
        expect(
          sample.play.y - samples[index - 1].play.y,
          `frame ${sample.gym.frame}: game drop size`,
        ).toBeCloseTo(DEFAULT_MARCH_DROP, 6);
      }
    },
  );
});

// ── AC4 — GymBotTuning (inherits GymLevel) ──────────────────────────

describe('GymBotTuning — inherits the level-gym spawn parity (AH-0MVRMHJZS001Z6CX)', () => {
  it(
    'AC4 (red-before) — the bot-tuning gym transits Phasers to their live formationSlot(), not the grid line',
    async () => {
      const probe = orbitalProbe(6);
      const tuning = await bootGymBotTuning({
        level: probe.level,
        seed: PARITY_SEED,
      });

      const stepper = createLockStep([tuning.game]);
      let observedFrames = 0;
      for (let frame = 0; frame < 60; frame += 1) {
        const phasers = livePhasers(tuning.scene);
        expect(phasers, `frame ${frame}: live Phaser count`).toHaveLength(6);
        if (getSpawnState(phasers[0] as unknown as SpawnAnimatable) === null) break;

        const baseX = probe.group.startX + tuning.scene.getFormationDriftX();
        const baseY = probe.group.startY;
        for (let i = 0; i < phasers.length; i += 1) {
          const destination = spawnDestination(phasers[i]);
          expect(
            destination,
            `frame ${frame}: GymBotTuning Phaser ${i} has no transit destination`,
          ).toBeDefined();
          const slot = phasers[i].formationSlot(baseX, baseY);
          expect(
            destination!.x,
            `frame ${frame}: GymBotTuning Phaser ${i} transit x`,
          ).toBeCloseTo(slot.x, 6);
          expect(
            destination!.y,
            `frame ${frame}: GymBotTuning Phaser ${i} transit y`,
          ).toBeCloseTo(slot.y, 6);
        }
        observedFrames += 1;
        stepper.tick();
      }
      expect(observedFrames, 'spawn window observed').toBeGreaterThan(30);
    },
  );
});
