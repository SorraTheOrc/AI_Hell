/**
 * BaseEnemy force-field contract tests (AH-0MVM8GTG7002IRTL, epic
 * AH-0MVJ8W4GE007OMNT AC2).
 *
 * **TEST-FIRST.** This suite pins the enemy force-field surface **before**
 * it is implemented by the entity force-field layer
 * (AH-0MVM8GUZG008AWSU). Every contract assertion is wrapped in Vitest's
 * `it.fails` (the repo's red-before/green-after convention — see
 * `src/core/levelScaling.test.ts` and AH-0MVM8GQKI006B50M), so the suite
 * stays green on pre-change HEAD where the field does not exist yet. **The
 * implementation item must flip every `it.fails` back to `it`** once the
 * surface lands; a leftover `it.fails` here fails the suite.
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

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

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

  // ── Field surface (red until AH-0MVM8GUZG008AWSU lands) ───────────

  it.fails(
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

  it.fails(
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

  it.fails(
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

  it.fails(
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

  it.fails(
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
