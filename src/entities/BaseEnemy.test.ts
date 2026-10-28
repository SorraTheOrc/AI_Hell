/**
 * BaseEnemy force-field contract tests (AH-0MVM8GTG7002IRTL, epic
 * AH-0MVJ8W4GE007OMNT AC2).
 *
 * **TEST-FIRST → IMPLEMENTED.** This suite pinned the enemy force-field
 * surface **before** it was implemented by the entity force-field layer
 * (AH-0MVM8GUZG008AWSU) via Vitest's `it.fails` (the repo's
 * red-before/green-after convention). The implementation item has flipped
 * every `it.fails` back to `it`, so the suite now runs against the real
 * surface.
 *
 * The `forceFieldHits` config field and the `forceFieldHits` /
 * `hasForceField` / `lastHitAbsorbed` / `forceFieldBroken` accessors are
 * declared locally (interfaces below) so this file type-checks while the
 * entity still lacks them — exactly the pattern used by
 * `src/core/enemyForceField.test.ts`.
 *
 * ## Pinned contract (AH-0MVM8GUZG008AWSU must match exactly)
 *
 * `BaseEnemyConfig` gains an optional `forceFieldHits` (remaining force-field
 * hits at spawn, default `0` = unshielded — a backwards-compatible default
 * that keeps every existing enemy byte-for-byte today's behaviour). The
 * effective hit count is resolved by the pure helper
 * `enemyForceFieldHits(level, config)` (AH-0MVM8GRQ8006HGPK) and threaded by
 * the spawn path (`enemyFactory`, pinned in `enemyFactory.test.ts`).
 *
 * `BaseEnemy` holds the field state and routes **every** damage instance
 * through the existing shared `takeDamage()` seam — no parallel damage path:
 *
 * - `forceFieldHits` — the remaining field hits (read-only; `0` when
 *   unshielded). Never negative.
 * - `hasForceField` — `forceFieldHits > 0`.
 * - `takeDamage()` while the field is up decrements the **field** and leaves
 *   `health` **unchanged**, reports the hit as absorbed (`lastHitAbsorbed`
 *   becomes true) and never destroys the enemy. It still returns the
 *   remaining **hull** health, so today's callers (and existing tests) are
 *   unchanged.
 * - The break — the field reaching 0 — is signalled **exactly once**: the
 *   hit that spends the last field hit is the last absorbed hit
 *   (`lastHitAbsorbed === true`), `forceFieldBroken` latches true at that
 *   moment and never flips back, and no later hit is ever absorbed again.
 * - After the break the next hit decrements `health` as today: the 1-HP
 *   majority dies on that hit; the 5-HP Harvester still needs 5
 *   (pinned in `Harvester.test.ts`).
 * - An enemy constructed with **no** field hits behaves exactly as before:
 *   `hasForceField`/`forceFieldBroken` are false, every `takeDamage()`
 *   reports a hull hit and `health` is the only thing a ram or bullet
 *   touches for unshielded enemies.
 * - A `takeDamage()` against an already-destroyed enemy stays a no-op
 *   returning `0`.
 *
 * @module entities/BaseEnemy.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../audio/effects';
import { bootScene, BootedGame } from '../test/gameHarness';
import { BaseEnemy, BaseEnemyConfig } from './BaseEnemy';
import type { FormationOffset } from '../utils/formations';

class HarnessScene extends Phaser.Scene {
  constructor() {
    super('BaseEnemyFieldHarness');
  }
}

/** Minimal concrete BaseEnemy used to exercise the shared field API. */
class TestEnemy extends BaseEnemy {
  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed for the field contract.
  }

  /**
   * Real subclasses attach the shared graphics layers after drawing their
   * body; the harness enemy does the same so the force-field bubble layer is
   * exercised exactly as in the game and the gyms.
   */
  attachSharedGraphics(): void {
    this.addSharedGraphics();
  }
}

/**
 * The BaseEnemy force-field surface this suite pins (declared locally,
 * test-first — see `src/core/enemyForceField.test.ts` for the pattern).
 */
interface ForceFieldEnemyContract {
  readonly forceFieldHits: number;
  readonly hasForceField: boolean;
  readonly lastHitAbsorbed: boolean;
  readonly forceFieldBroken: boolean;
  /** Whether the shared force-field bubble is currently drawn (AC3). */
  readonly forceFieldBubbleVisible: boolean;
}

/** The BaseEnemyConfig extension the entity layer must implement. */
interface ForceFieldEnemyConfig extends BaseEnemyConfig {
  /** Remaining force-field hits at spawn (default `0` = unshielded). */
  forceFieldHits?: number;
}

const OFFSET: FormationOffset = { row: 0, col: 0 };

/** Builds an enemy with the supplied hull health and field hits. */
function makeEnemy(
  scene: Phaser.Scene,
  health: number,
  forceFieldHits?: number,
): TestEnemy {
  const config: ForceFieldEnemyConfig = {
    formationOffset: OFFSET,
    size: 16,
    color: 0x00ff00,
    health,
    forceFieldHits,
  };
  return new TestEnemy(scene, 100, 100, config);
}

/** Casts a real BaseEnemy to the pinned field surface. */
function fieldApi(enemy: TestEnemy): TestEnemy & ForceFieldEnemyContract {
  return enemy as TestEnemy & ForceFieldEnemyContract;
}

describe('BaseEnemy force-field contract (test-first, AH-0MVM8GTG7002IRTL)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  // ── Field surface (implemented by AH-0MVM8GUZG008AWSU) ───────────

  it(
    'exposes the remaining field hits an enemy was built with',
    async () => {
      const scene = await boot();
      const shielded = fieldApi(makeEnemy(scene, 1, 3));
      expect(shielded.forceFieldHits).toBe(3);
      expect(shielded.hasForceField).toBe(true);

      const unshielded = fieldApi(makeEnemy(scene, 1));
      expect(unshielded.forceFieldHits).toBe(0);
      expect(unshielded.hasForceField).toBe(false);
    },
  );

  it(
    'absorbs a hit while the field is up: field decrements, health is untouched, the hit reports as absorbed',
    async () => {
      const scene = await boot();
      const enemy = fieldApi(makeEnemy(scene, 5, 2));

      const remaining = enemy.takeDamage();

      // The field absorbed the hit: hull health unchanged, enemy alive.
      expect(enemy.forceFieldHits).toBe(1);
      expect(enemy.health).toBe(5);
      expect(enemy.alive).toBe(true);
      expect(enemy.lastHitAbsorbed).toBe(true);
      // `takeDamage()` still returns the remaining hull health, so today's
      // callers keep working unchanged.
      expect(remaining).toBe(5);
    },
  );

  it(
    'signals the break exactly once: the last field hit is absorbed, the latch flips once and never again',
    async () => {
      const scene = await boot();
      const enemy = fieldApi(makeEnemy(scene, 1, 2));

      // Hit 1 — absorbed, field still up.
      expect(enemy.takeDamage()).toBe(1);
      expect(enemy.forceFieldHits).toBe(1);
      expect(enemy.lastHitAbsorbed).toBe(true);
      expect(enemy.forceFieldBroken).toBe(false);
      expect(enemy.alive).toBe(true);

      // Hit 2 — the breaking hit: absorbed, field now 0, latch flips once.
      expect(enemy.takeDamage()).toBe(1);
      expect(enemy.forceFieldHits).toBe(0);
      expect(enemy.lastHitAbsorbed).toBe(true);
      expect(enemy.forceFieldBroken).toBe(true);
      expect(enemy.health).toBe(1);
      expect(enemy.alive).toBe(true);

      // Hit 3 — the field is down: the 1-HP hull dies on this hit, and the
      // hit is NOT reported as absorbed again.
      expect(enemy.takeDamage()).toBe(0);
      expect(enemy.lastHitAbsorbed).toBe(false);
      expect(enemy.forceFieldBroken).toBe(true);
      expect(enemy.alive).toBe(false);

      // A further hit against the destroyed enemy is a no-op, and never
      // reports an absorb.
      expect(enemy.takeDamage()).toBe(0);
      expect(enemy.lastHitAbsorbed).toBe(false);
    },
  );

  it(
    'absorbs exactly the number of field hits a shield carries — never more',
    async () => {
      const scene = await boot();
      const enemy = fieldApi(makeEnemy(scene, 1, 4));
      let absorbed = 0;

      for (let hit = 0; hit < 7; hit += 1) {
        enemy.takeDamage();
        if (enemy.lastHitAbsorbed) absorbed += 1;
      }

      // Exactly the four carried hits are absorbed; the rest hit the hull.
      expect(absorbed).toBe(4);
      expect(enemy.forceFieldHits).toBe(0);
      expect(enemy.alive).toBe(false);
    },
  );

  // ── Backwards-compatible default (guard, red today → stays green after) ──

  it(
    'an enemy constructed without a field behaves exactly as before',
    async () => {
    const scene = await boot();
    const enemy = fieldApi(makeEnemy(scene, 1));

    // No shield surface: every accessor is inert.
    expect(enemy.forceFieldHits).toBe(0);
    expect(enemy.hasForceField).toBe(false);
    expect(enemy.lastHitAbsorbed).toBe(false);
    expect(enemy.forceFieldBroken).toBe(false);

    // Health is still the only thing a hit touches: the 1-HP enemy dies on
    // the first hit, with no absorb report.
    expect(enemy.takeDamage()).toBe(0);
    expect(enemy.alive).toBe(false);
    expect(enemy.lastHitAbsorbed).toBe(false);

    // A multi-hull unshielded enemy takes exactly its health in hits.
    const tough = fieldApi(makeEnemy(scene, 3));
    for (let hit = 1; hit <= 2; hit += 1) {
      expect(tough.takeDamage()).toBe(3 - hit);
      expect(tough.alive).toBe(true);
      expect(tough.lastHitAbsorbed).toBe(false);
    }
    expect(tough.takeDamage()).toBe(0);
    expect(tough.alive).toBe(false);
  },
  );
});


// ── Force-field bubble lifecycle (AH-0MVM8GW7W004SI0E AC3) ─────────

describe('BaseEnemy force-field bubble lifecycle (AH-0MVM8GW7W004SI0E)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([HarnessScene]);
    return booted.scene;
  }

  /** Builds an enemy with the shared graphics layers attached, as shipped. */
  function makeAttachedEnemy(
    scene: Phaser.Scene,
    health: number,
    forceFieldHits?: number,
  ): TestEnemy & ForceFieldEnemyContract {
    const enemy = fieldApi(makeEnemy(scene, health, forceFieldHits));
    enemy.attachSharedGraphics();
    return enemy;
  }

  it('draws the shared bubble while the field is up and none for an unshielded enemy', async () => {
    const scene = await boot();

    const shielded = makeAttachedEnemy(scene, 1, 3);
    const unshielded = makeAttachedEnemy(scene, 1);

    expect(shielded.hasForceField).toBe(true);
    expect(shielded.forceFieldBubbleVisible).toBe(true);
    expect(unshielded.hasForceField).toBe(false);
    expect(unshielded.forceFieldBubbleVisible).toBe(false);
  });

  it('keeps the bubble while hits are absorbed and removes it on the breaking hit', async () => {
    const scene = await boot();
    const enemy = makeAttachedEnemy(scene, 1, 2);

    // Hit 1 — absorbed, field still up: the bubble stays.
    enemy.takeDamage();
    expect(enemy.forceFieldHits).toBe(1);
    expect(enemy.forceFieldBubbleVisible).toBe(true);

    // Hit 2 — the breaking hit: the bubble is cleared with the field.
    enemy.takeDamage();
    expect(enemy.forceFieldHits).toBe(0);
    expect(enemy.forceFieldBroken).toBe(true);
    expect(enemy.forceFieldBubbleVisible).toBe(false);
    // The hull is still intact — only the barrier broke.
    expect(enemy.alive).toBe(true);
    expect(enemy.health).toBe(1);
  });

  it('plays the distinct break cue and spawns the break flash exactly once, on the break', async () => {
    const scene = await boot();
    // 5-HP hull so the post-break hit below is non-lethal and cannot spawn a
    // destruction explosion (whose particles would add their own tween).
    const enemy = makeAttachedEnemy(scene, 5, 2);
    // Spy only after construction: the entity's own layers are created in the
    // constructor, so any cue/tween after this point is break feedback.
    const cueSpy = vi.spyOn(effectsModule, 'playEnemyForceFieldBreakSound');
    const tweenSpy = vi.spyOn(scene.tweens, 'add');
    const displayObjectsBefore = scene.children.list.length;

    // An absorbed (non-breaking) hit is silent on the break cue and spawns
    // no new display object (only the entity's own bubble layer redraws).
    enemy.takeDamage();
    expect(cueSpy).not.toHaveBeenCalled();
    expect(tweenSpy).not.toHaveBeenCalled();
    expect(scene.children.list.length).toBe(displayObjectsBefore);

    // The breaking hit fires the break feedback once: the shared flash is
    // spawned as a new display object and fades out via one tween.
    enemy.takeDamage();
    expect(cueSpy).toHaveBeenCalledTimes(1);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
    expect(scene.children.list.length).toBe(displayObjectsBefore + 1);

    // Later hull hits never repeat the break feedback.
    enemy.takeDamage();
    expect(cueSpy).toHaveBeenCalledTimes(1);
    expect(tweenSpy).toHaveBeenCalledTimes(1);
  });

  it('removes the bubble when the enemy is destroyed while still shielded', async () => {
    const scene = await boot();
    const enemy = makeAttachedEnemy(scene, 5, 2);

    expect(enemy.forceFieldBubbleVisible).toBe(true);
    enemy.destroySelf();
    expect(enemy.alive).toBe(false);
    expect(enemy.forceFieldBubbleVisible).toBe(false);
  });
});

// ── Wrap-awareness parameter (AH-0MVKXBQVT000B2WL) ─────────────────

/**
 * `wrapAware` is the single data-driven seam-awareness flag every later
 * gameplay slice reads (parent epic AH-0MV9G3DZ9003P7P8, AC1). The entity is
 * the one accessor scenes use, so no caller re-parses the raw config: absent
 * means wrap-aware (the backwards-compatible default), an explicit `false`
 * opts the classic archetypes out.
 */
describe('BaseEnemy wrap-awareness surface (AH-0MVKXBQVT000B2WL)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function makeWrapEnemy(wrapAware?: boolean): Promise<TestEnemy> {
    booted = await bootScene([HarnessScene]);
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      health: 1,
      wrapAware,
    };
    return new TestEnemy(booted.scene, 100, 100, config);
  }

  it('exposes wrapAware and defaults an absent flag to true', async () => {
    const enemy = await makeWrapEnemy();
    expect(enemy.wrapAware).toBe(true);
  });

  it('honours an explicit wrapAware=false for the excluded archetypes', async () => {
    const enemy = await makeWrapEnemy(false);
    expect(enemy.wrapAware).toBe(false);
  });
});
