/**
 * Shared collector-drone lifecycle pass tests (parent AH-0MV9G113S009B37I,
 * child AH-0MVBMPZS90038715).
 *
 * These tests exercise the **shared pass** — the place where the live mineral
 * field, the ship position, the hold sink and the destruction drop meet the
 * {@link MysteryUfoDrone} entity. The drone's own state machine is covered by
 * `src/entities/MysteryUfoDrone.test.ts`; here we pin the pass-owned
 * behaviour: field feeding, payout routing, teardown and the enemy-only
 * destruction drop.
 *
 * Every assertion reads observable behaviour through the pass API (returned
 * drone list, sink calls, dropped minerals) — no source-grepping and no
 * re-implementation of production logic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { MINERAL_REDROP_SCATTER_RADIUS } from '../../core/constants';
import { resolvePowerUpAtLevel } from '../../powerups/powerUpLevels';
import { Mineral } from '../../entities/Mineral';
import { MysteryUfoDrone } from '../../entities/MysteryUfoDrone';
import { bootScene, BootedGame } from '../../test/gameHarness';
import {
  captureUfoLifecycleFeedback,
  expectUfoDestructionLifecycle,
  expectUfoPayoutLifecycle,
  getDroneVfxCounts,
  installUfoCueRecorder,
  resetDroneVfxCounts,
  UFO_DESTRUCTION_CUE_SEQUENCE,
  UFO_PAYOUT_CUE_SEQUENCE,
  UFO_WARBLE_ONLY_SEQUENCE,
  type UfoCueRecorder,
} from '../../test/collectorDroneFixtures';
import {
  DRONE_DESTRUCTION_BONUS_PER_LEVEL,
  destroyedDroneDropCount,
  hitDrone,
  spawnDrone,
  tickDrones,
  type DroneMineralSink,
} from './combatDrone';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('CombatDroneHarness');
  }
}

/** Level-0 resolved tuning from the shared curve (parent AC3 defaults). */
function levelZeroConfig(): {
  lifetime: number;
  capacity: number;
  collectorRadius: number;
} {
  const stats = resolvePowerUpAtLevel('mystery_ufo', 0);
  return {
    lifetime: stats.mysteryUfoLifetime ?? 5,
    capacity: stats.mysteryUfoCapacity ?? 10,
    collectorRadius: stats.mysteryUfoRadius ?? 20,
  };
}

/** Recording hold sink so payout routing can be asserted exactly. */
function makeSink(): DroneMineralSink & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    addMinerals: (amount: number) => calls.push(amount),
  };
}

describe('shared collector-drone pass', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  function makeDrone(
    scene: Phaser.Scene,
    drones: MysteryUfoDrone[],
    sink: DroneMineralSink,
    overrides: Partial<{
      x: number;
      y: number;
      lifetime: number;
      capacity: number;
      collectorRadius: number;
      homeX: number;
      homeY: number;
    }> = {},
  ): MysteryUfoDrone {
    return spawnDrone(
      scene,
      {
        x: 100,
        y: 100,
        ...levelZeroConfig(),
        ...overrides,
      },
      drones,
      sink,
    );
  }

  function makeMineral(scene: Phaser.Scene, x: number, y: number): Mineral {
    return new Mineral(scene, { x, y });
  }

  // ── Spawn ────────────────────────────────────────────────────────

  it('spawns the drone into the scene list and its resolved level tuning', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());

    expect(drones).toEqual([drone]);
    expect(drone).toBeInstanceOf(MysteryUfoDrone);
    expect(scene.children.exists(drone)).toBe(true);
    expect(drone.x).toBe(100);
    expect(drone.y).toBe(100);
    expect(drone.lifetimeSeconds).toBe(5);
    expect(drone.capacity).toBe(10);
    expect(drone.collectorRadius).toBe(20);
  });

  // ── Field feeding: seek → collect ────────────────────────────────

  it('feeds the live field so the drone seeks the nearest live mineral', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());
    const near = makeMineral(scene, 150, 100);
    const far = makeMineral(scene, 500, 100);

    tickDrones(drones, {
      dt: 0.1,
      minerals: [far, near],
      player: { x: 100, y: 100 },
    });

    expect(drone.seekTargetX).toBe(near.x);
    expect(drone.seekTargetY).toBe(near.y);
    // Steered toward the near target at the cruise speed (120 px/s × 0.1 s).
    expect(drone.x).toBeCloseTo(112, 5);
    expect(drone.y).toBeCloseTo(100, 5);
  });

  it('vacuums minerals whose centre enters the collector radius', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());
    const inside = makeMineral(scene, 115, 100); // 15 px < 20 px radius
    const outside = makeMineral(scene, 130, 100); // 30 px

    tickDrones(drones, {
      dt: 0.01,
      minerals: [inside, outside],
      player: { x: 100, y: 100 },
    });

    expect(drone.heldMinerals).toBe(1);
    // The vacuumed mineral is marked dead so the shared mineral pass removes
    // it from the field on the same frame; the outside one survives.
    expect(inside.alive).toBe(false);
    expect(inside.visible).toBe(false);
    expect(outside.alive).toBe(true);
  });

  it('clears its target and holds station on an empty field', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());

    tickDrones(drones, { dt: 0.5, minerals: [], player: { x: 100, y: 100 } });

    expect(drone.seekTargetX).toBeNull();
    expect(drone.seekTargetY).toBeNull();
    expect(drone.x).toBe(100);
    expect(drone.y).toBe(100);
    expect(drone.heldMinerals).toBe(0);
  });

  // ── Payout routing ───────────────────────────────────────────────

  it('pays the held minerals into the supplied hold sink exactly once', async () => {
    const scene = await boot();
    let drones: MysteryUfoDrone[] = [];
    const sink = makeSink();
    const drone = makeDrone(scene, drones, sink, { capacity: 1 });
    // One mineral in radius: the first tick fills the hold and begins RETURN.
    const mineral = makeMineral(scene, 110, 100);

    drones = tickDrones(drones, {
      dt: 0.01,
      minerals: [mineral],
      player: { x: 100, y: 100 },
    });
    expect(sink.calls).toEqual([]);

    // Home defaults to the spawn position, so the next tick arrives and pays.
    drones = tickDrones(drones, {
      dt: 0.01,
      minerals: [],
      player: { x: 100, y: 100 },
    });
    expect(sink.calls).toEqual([1]);

    // The paid-out drone is gone from the list and never pays again.
    expect(drones).toHaveLength(0);
    drones = tickDrones(drones, {
      dt: 1,
      minerals: [],
      player: { x: 100, y: 100 },
    });
    expect(sink.calls).toEqual([1]);
    expect(drone.alive).toBe(false);
  });

  it('tracks the live ship position as the return target', async () => {
    const scene = await boot();
    let drones: MysteryUfoDrone[] = [];
    const sink = makeSink();
    makeDrone(scene, drones, sink, { capacity: 1 });
    const mineral = makeMineral(scene, 110, 100);

    drones = tickDrones(drones, {
      dt: 0.01,
      minerals: [mineral],
      player: { x: 100, y: 400 },
    });

    // Return leg steers to the ship, not the spawn point.
    for (let i = 0; i < 1000 && drones.length > 0; i += 1) {
      drones = tickDrones(drones, {
        dt: 1 / 60,
        minerals: [],
        player: { x: 100, y: 400 },
      });
    }

    expect(sink.calls).toEqual([1]);
  });

  // ── Teardown ─────────────────────────────────────────────────────

  it('removes and destroys drones that have finished their sortie', async () => {
    const scene = await boot();
    let drones: MysteryUfoDrone[] = [];
    const sink = makeSink();
    const done = makeDrone(scene, drones, sink, { capacity: 1 });
    const mineral = makeMineral(scene, 110, 100);
    drones = tickDrones(drones, {
      dt: 0.01,
      minerals: [mineral],
      player: { x: 100, y: 100 },
    });
    drones = tickDrones(drones, {
      dt: 0.01,
      minerals: [],
      player: { x: 100, y: 100 },
    });

    expect(drones).toHaveLength(0);
    expect(scene.children.exists(done)).toBe(false);
  });

  // ── Destruction contract ─────────────────────────────────────────

  it('computes the destruction spill as held minerals plus 2 × level', () => {
    expect(DRONE_DESTRUCTION_BONUS_PER_LEVEL).toBe(2);
    expect(destroyedDroneDropCount(3, 2)).toBe(7);
    expect(destroyedDroneDropCount(0, 3)).toBe(6);
    expect(destroyedDroneDropCount(0, 0)).toBe(0);
    // A negative level can never reduce the spill below the held minerals.
    expect(destroyedDroneDropCount(2, -5)).toBe(2);
  });

  it('an enemy bullet destroys the drone and drops held minerals + 2 × level at the crash site', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());
    const mineral = makeMineral(scene, 110, 100);
    tickDrones(drones, {
      dt: 0.01,
      minerals: [mineral],
      player: { x: 100, y: 100 },
    });
    expect(drone.heldMinerals).toBe(1);
    const crashX = drone.x;
    const crashY = drone.y;

    const drops = hitDrone(scene, drone, 'enemy-bullet', 3);

    // Held 1 + 2 × level 3 = 7 collectable minerals at the crash site.
    expect(drops).toHaveLength(7);
    expect(drone.destroyed).toBe(true);
    expect(drone.alive).toBe(false);
    for (const drop of drops) {
      expect(drop).toBeInstanceOf(Mineral);
      expect(drop.alive).toBe(true);
      expect(
        Math.hypot(drop.x - crashX, drop.y - crashY),
      ).toBeLessThanOrEqual(MINERAL_REDROP_SCATTER_RADIUS);
    }

    // A second hit (of either kind) can never spill a second time.
    expect(hitDrone(scene, drone, 'enemy-bullet', 3)).toEqual([]);
    expect(hitDrone(scene, drone, 'enemy-body', 3)).toEqual([]);
  });

  it('an enemy body collision destroys the drone exactly like a bullet', async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());

    const drops = hitDrone(scene, drone, 'enemy-body', 0);

    // Level 0 with an empty hold spills nothing, but the drone is destroyed.
    expect(drops).toEqual([]);
    expect(drone.destroyed).toBe(true);
    expect(drone.alive).toBe(false);
  });

  it("cannot be destroyed by the player's own fire", async () => {
    const scene = await boot();
    const drones: MysteryUfoDrone[] = [];
    const drone = makeDrone(scene, drones, makeSink());
    const mineral = makeMineral(scene, 110, 100);
    tickDrones(drones, {
      dt: 0.01,
      minerals: [mineral],
      player: { x: 100, y: 100 },
    });

    expect(hitDrone(scene, drone, 'player-bullet', 5)).toEqual([]);
    expect(drone.destroyed).toBe(false);
    expect(drone.alive).toBe(true);
    expect(drone.heldMinerals).toBe(1);

    // It keeps flying: the next tick still sees it in the list.
    const kept = tickDrones(drones, {
      dt: 0.01,
      minerals: [],
      player: { x: 100, y: 100 },
    });
    expect(kept).toEqual([drone]);
  });

  // ── UFO feel verification seams (AH-0MVSAJJ8F000ZD5Q) ────────────
  //
  // The feel slices assert their target sequence through the shared helpers:
  // `expectUfoPayoutLifecycle(feedback, { cues: … })` and
  // `expectUfoDestructionLifecycle(feedback, { cues: …, vfx: { … } })`. The
  // warble slice lands the start/stop prefix; the terminal-feedback slice
  // (below) adds the one-shot cues and the destruction burst.

  // ── UFO feel: sortie-long warble (AH-0MVSAJR6W001CE8M) ─────────
  //
  // The warble starts exactly once at the shared spawn and stops on every
  // terminal path: return-leg begin, payout, destruction and teardown. The
  // terminal one-shot cues (reward/destroy/tinkle) land in
  // AH-0MVSAJVHF007QO6V below; these cases assert the warble's own
  // start→stop contract.

  describe('UFO feel: sortie-long warble', () => {
    let recorder: UfoCueRecorder;

    beforeEach(() => {
      recorder = installUfoCueRecorder();
      resetDroneVfxCounts();
    });

    afterEach(() => {
      recorder.dispose();
      resetDroneVfxCounts();
    });

    it('starts the warble exactly once at spawn and keeps it through seek and collect', async () => {
      const scene = await boot();
      let drones: MysteryUfoDrone[] = [];
      makeDrone(scene, drones, makeSink());

      // The shared spawn path is the only start point.
      expect(recorder.ufoEventNames()).toEqual(['warble-start']);

      // Seek on an empty field, then collect a mineral: still one voice.
      const mineral = makeMineral(scene, 115, 100);
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [],
        player: { x: 100, y: 100 },
      });
      expect(drones[0].droneState).toBe('seek');
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      expect(drones[0].droneState).toBe('collect');

      expect(recorder.ufoEventNames()).toEqual(['warble-start']);
    });

    it('stops the warble when the return leg begins and never restarts it on payout', async () => {
      const scene = await boot();
      let drones: MysteryUfoDrone[] = [];
      const sink = makeSink();
      makeDrone(scene, drones, sink, { capacity: 1 });
      const mineral = makeMineral(scene, 110, 100);

      // First tick: vacuums the mineral, hold is full, RETURN begins.
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      expect(drones[0].droneState).toBe('return');
      expect(recorder.ufoEventNames()).toEqual([
        'warble-start',
        'warble-stop',
      ]);

      // Next tick arrives and pays out: the warble is not restarted, the
      // reward fanfare voices the credit (terminal-feedback slice).
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [],
        player: { x: 100, y: 100 },
      });
      expect(sink.calls).toEqual([1]);
      expect(drones).toHaveLength(0);

      // Repeated ticks on the empty list add no cue events at all.
      for (let i = 0; i < 5; i += 1) {
        drones = tickDrones(drones, {
          dt: 0.01,
          minerals: [],
          player: { x: 100, y: 100 },
        });
      }
      expect(recorder.ufoEventNames()).toEqual([
        'warble-start',
        'warble-stop',
        'reward',
      ]);
    });

    it('stops the warble on mid-sortie enemy destruction and leaves it stopped on the removal tick', async () => {
      const scene = await boot();
      let drones: MysteryUfoDrone[] = [];
      const drone = makeDrone(scene, drones, makeSink());
      const mineral = makeMineral(scene, 110, 100);
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      expect(drone.droneState).toBe('collect');
      expect(recorder.ufoEventNames()).toEqual(['warble-start']);

      // Destroyed by an enemy bullet before the return leg begins.
      hitDrone(scene, drone, 'enemy-bullet', 1);
      expect(recorder.ufoEventNames()).toEqual([
        'warble-start',
        'warble-stop',
        'destroy',
        'tinkle',
      ]);

      // The removal tick must not start it again or double-stop it.
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [],
        player: { x: 100, y: 100 },
      });
      expect(drones).toHaveLength(0);
      expect(recorder.ufoEventNames()).toEqual([
        'warble-start',
        'warble-stop',
        'destroy',
        'tinkle',
      ]);
    });
  });

  describe('UFO feel: payout and destruction terminals (AH-0MVSAJVHF007QO6V)', () => {
    let recorder: UfoCueRecorder;

    beforeEach(() => {
      recorder = installUfoCueRecorder();
      resetDroneVfxCounts();
    });

    afterEach(() => {
      recorder.dispose();
      resetDroneVfxCounts();
    });

    /**
     * The burst Graphics the shared explosion VFX spawns at `(x, y)` — it
     * renders at depth 5, above the depth-2 saucer and mineral field.
     */
    function burstsAt(
      scene: Phaser.Scene,
      x: number,
      y: number,
    ): Phaser.GameObjects.Graphics[] {
      return scene.children.list.filter(
        (child): child is Phaser.GameObjects.Graphics =>
          child instanceof Phaser.GameObjects.Graphics &&
          child.depth === 5 &&
          Math.abs(child.x - x) < 0.001 &&
          Math.abs(child.y - y) < 0.001,
      );
    }

    it('plays the reward fanfare exactly once, at the payout, not on return-leg begin', async () => {
      const scene = await boot();
      let drones: MysteryUfoDrone[] = [];
      const sink = makeSink();
      makeDrone(scene, drones, sink, { capacity: 1 });
      const mineral = makeMineral(scene, 110, 100);

      // Collect → hold full → RETURN begins. The warble is released here and
      // the fanfare must NOT play yet: the payout has not been credited.
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      expect(drones[0].droneState).toBe('return');
      expect(recorder.ufoEventNames()).toEqual(['warble-start', 'warble-stop']);

      // Arrival credits the hold and voices exactly one fanfare.
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [],
        player: { x: 100, y: 100 },
      });
      expect(sink.calls).toEqual([1]);
      expect(drones).toHaveLength(0);

      // Repeated ticks can never replay it: the drone is gone.
      for (let i = 0; i < 5; i += 1) {
        tickDrones(drones, { dt: 0.5, minerals: [], player: { x: 100, y: 100 } });
      }

      expectUfoPayoutLifecycle(captureUfoLifecycleFeedback(recorder), {
        cues: UFO_PAYOUT_CUE_SEQUENCE,
      });
    });

    it('stays silent when the sortie pays out an empty hold', async () => {
      const scene = await boot();
      let drones: MysteryUfoDrone[] = [];
      const sink = makeSink();
      // Lifetime expires on the first tick with nothing collected.
      makeDrone(scene, drones, sink, { lifetime: 0.05 });

      drones = tickDrones(drones, {
        dt: 0.1,
        minerals: [],
        player: { x: 100, y: 100 },
      });
      expect(drones[0].droneState).toBe('return');
      drones = tickDrones(drones, {
        dt: 0.01,
        minerals: [],
        player: { x: 100, y: 100 },
      });

      // Nothing was credited, so there is no reward to celebrate.
      expect(sink.calls).toEqual([]);
      expect(drones).toHaveLength(0);
      expectUfoPayoutLifecycle(captureUfoLifecycleFeedback(recorder), {
        cues: UFO_WARBLE_ONLY_SEQUENCE,
      });
    });

    it('plays the explosion cue, spawns the burst at the crash site and tinkles the spill exactly once', async () => {
      const scene = await boot();
      const drones: MysteryUfoDrone[] = [];
      const drone = makeDrone(scene, drones, makeSink());
      const mineral = makeMineral(scene, 110, 100);
      tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      expect(drone.heldMinerals).toBe(1);
      const crashX = drone.x;
      const crashY = drone.y;

      const drops = hitDrone(scene, drone, 'enemy-bullet', 1);
      expect(drops).toHaveLength(1 + 2 * 1);
      // The shared explosion VFX bursts where the saucer died.
      expect(burstsAt(scene, crashX, crashY)).toHaveLength(1);

      // A second hit of either kind adds no cue, burst or tinkle.
      expect(hitDrone(scene, drone, 'enemy-bullet', 1)).toEqual([]);
      expect(hitDrone(scene, drone, 'enemy-body', 1)).toEqual([]);
      expect(burstsAt(scene, crashX, crashY)).toHaveLength(1);

      expectUfoDestructionLifecycle(captureUfoLifecycleFeedback(recorder), {
        cues: UFO_DESTRUCTION_CUE_SEQUENCE,
        vfx: { destruction: 1 },
      });
    });

    it('plays the explosion but no mineral tinkle when the spill is empty', async () => {
      const scene = await boot();
      const drones: MysteryUfoDrone[] = [];
      const drone = makeDrone(scene, drones, makeSink());

      // Level 0 with an empty hold spills nothing: the explosion still fires,
      // but there are no dropped minerals for the tinkle to voice.
      const drops = hitDrone(scene, drone, 'enemy-body', 0);
      expect(drops).toEqual([]);
      expect(recorder.ufoEventNames()).toEqual([
        'warble-start',
        'warble-stop',
        'destroy',
      ]);
      expect(getDroneVfxCounts().destruction).toBe(1);
    });

    it("produces no terminal feedback for the player's own fire", async () => {
      const scene = await boot();
      const drones: MysteryUfoDrone[] = [];
      const drone = makeDrone(scene, drones, makeSink());
      const mineral = makeMineral(scene, 110, 100);
      tickDrones(drones, {
        dt: 0.01,
        minerals: [mineral],
        player: { x: 100, y: 100 },
      });
      const crashX = drone.x;
      const crashY = drone.y;

      expect(hitDrone(scene, drone, 'player-bullet', 5)).toEqual([]);
      // The drone survives, the warble keeps playing, nothing bursts.
      expect(drone.alive).toBe(true);
      expect(recorder.ufoEventNames()).toEqual(['warble-start']);
      expect(getDroneVfxCounts().destruction).toBe(0);
      expect(burstsAt(scene, crashX, crashY)).toHaveLength(0);

      // The enemy hit that finally kills it still speaks exactly once.
      expect(hitDrone(scene, drone, 'enemy-bullet', 1)).toHaveLength(3);
      expectUfoDestructionLifecycle(captureUfoLifecycleFeedback(recorder), {
        cues: UFO_DESTRUCTION_CUE_SEQUENCE,
        vfx: { destruction: 1 },
      });
    });
  });
});
