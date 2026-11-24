/**
 * Matchup impact-state encounter feedback contract tests
 * (AH-0MWL88W8E0074Z8Z, **TEST-FIRST** — Phase 3 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC9).
 *
 * The presentation half of producer decision Q1 = A + B is not only a cue and
 * a flash: the encounter itself must *react* differently. An `effective` shot
 * makes the boss/mini-boss visibly flinch (a bounded kick + a silhouette
 * flash); a `resisted` shot must **never** flinch — it reads as *wrong tool*,
 * not as a broken gun. The first resisted hit of an encounter also raises a
 * one-shot `RESISTED` tag, with a small bar pip on every resisted hit after it.
 *
 * This suite pins all three through **published reaction state** on the
 * encounter (never a pixel diff), driven through the real shared damage path
 * (`PlayScene._damageMiniBoss` / `_damageBoss` → the shared matchup charge).
 *
 * ## Red-before / green-after
 *
 * Every behavioural case is authored red against pre-change HEAD: the boss
 * reaction/tag state does not exist yet, so the cases are wrapped in Vitest's
 * `it.fails` (the repo's red-first convention — see
 * `src/scenes/core/hexMatchupDamageSources.test.ts`). The implementation item
 * (AH-0MWL88YYO0053DWH) **flips every `it.fails` back to a plain `it`** once
 * the reaction lands. The neutral case is a deliberate **scope guard**: it is
 * already correct on HEAD by construction and must stay green after the
 * presentation lands, so it is a plain `it`.
 *
 * ## Pinned contract (AH-0MWL88YYO0053DWH must match exactly)
 *
 * On `Boss` (inherited by `MiniBoss`):
 *
 * - `getLastHitReaction()` → `{ state, reacted, tag } | null` — the most recent
 *   connected shot's presentation reaction (`null` before any hit).
 *   - `effective` → `reacted: true`;
 *   - `resisted` → `reacted: false`;
 *   - `neutral` → no flinch.
 * - `getResistedTagState()` → `'none' | 'tag' | 'pip'`:
 *   - `'none'` before any resisted hit of the encounter;
 *   - `'tag'` on the **first** resisted hit only;
 *   - `'pip'` on every resisted hit after it.
 *
 * The tag is keyed on the **connected shot**, not on a damage instance: the
 * resisted ledger pays one hit point per *two* shots, so the very first
 * resisted shot deals zero damage and must still raise the tag.
 *
 * ## How the verdict reaches the encounter
 *
 * The suite fights `hex-r1-4`, whose authored data is pinned so a ring
 * re-authoring that changes it fails loudly rather than silently weakening the
 * test: `ricochet` is a weakness (`effective`), `cannon` is a strength
 * (`resisted`) and `spread` is neither (`neutral`). The verdict therefore comes
 * from the real authored data through the deployment, not from a synthetic
 * lookup.
 *
 * @module scenes/core/impactStateFeedback.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { createRingState } from '../../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  saveHangarWarPayload,
} from '../../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { Boss } from '../../entities/Boss';
import { MiniBoss, type MiniBossConfig } from '../../entities/MiniBoss';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import type { WeaponId } from '../../utils/weapons';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from '../hangarWar/hangarDeployment';

/** The three presentation states (mirrors `HexMatchupVerdict`). */
type ImpactFeedbackState = 'neutral' | 'effective' | 'resisted';

/** The encounter-scoped RESISTED tag state. */
type ResistedTagState = 'none' | 'tag' | 'pip';

/** The published reaction to the most recent connected shot. */
interface BossHitReaction {
  state: ImpactFeedbackState;
  reacted: boolean;
  tag: ResistedTagState;
}

/** The not-yet-published reaction state on `Boss`/`MiniBoss`. */
interface BossReactionView {
  getLastHitReaction?: () => BossHitReaction | null;
  getResistedTagState?: () => ResistedTagState;
}

/**
 * The authored facts this suite relies on, pinned so a re-authoring fails
 * loudly: `hex-r1-4` weaknesses `ricochet` (effective), strengths `cannon`
 * (resisted), `spread` neutral.
 */
const HEX_ID = 'hex-r1-4';
const EFFECTIVE_WEAPON: WeaponId = 'ricochet';
const RESISTED_WEAPON: WeaponId = 'cannon';
const NEUTRAL_WEAPON: WeaponId = 'spread';

/** Private scene seams these tests drive (the same seams the shipped suites use). */
interface SceneSeams {
  spawned: unknown[];
  playerBullets: unknown[];
  miniBoss: MiniBoss | null;
  boss: Boss | null;
  autoFireEnabled(): boolean;
  _resolvePlayerBulletsVsEnemies(): void;
  miniBossConfigFor(level: number): MiniBossConfig;
  spawnBoss(): void;
}

/** A fresh war with the hex's ring materialised from the authored data. */
function payloadFor(hexId: string): HangarWarPayload {
  const match = /^hex-r(\d+)-/.exec(hexId);
  const ringIndex = match ? Number(match[1]) : 1;
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

/** A deployment at `hexId`, seeding the run deterministically. */
function deploymentFor(hexId: string): HangarWarDeployment {
  return buildHangarDeployment(payloadFor(hexId), { hexId, seed: 7 });
}

/** The most recent reaction, or `null` while the export does not exist yet. */
function lastReaction(boss: Boss): BossHitReaction | null {
  return (boss as unknown as BossReactionView).getLastHitReaction?.() ?? null;
}

/** The RESISTED tag state, or `undefined` while the export does not exist yet. */
function resistedTag(boss: Boss): ResistedTagState | undefined {
  return (boss as unknown as BossReactionView).getResistedTagState?.();
}

// ── Harness ─────────────────────────────────────────────────────────

beforeEach(() => {
  // The Player's auto-fire reads the control scheme; the app default is
  // Asteroids, so seed fourDirectional exactly as the other PlayScene suites.
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

describe('matchup impact-state encounter feedback (AC9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots `PlayScene` running the deployment for `hexId`, then isolates the
   * encounter: the wave enemies and any auto-fired bullets are cleared so only
   * the encounter this test injects can take the shot.
   */
  async function bootIsolated(hexId: string): Promise<PlayScene> {
    if (booted) {
      booted.game.destroy(true);
      booted = null;
    }
    saveHangarWarPayload(payloadFor(hexId));
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({ demo: false, hangarWar: deploymentFor(hexId) });
    await advanceGame(scene.game, 200);
    const seams = scene as unknown as SceneSeams;
    seams.spawned.length = 0;
    seams.playerBullets.length = 0;
    seams.autoFireEnabled = () => false;
    return scene;
  }

  /** Injects a mini-boss built from the run's own (hex-profiled) configuration. */
  function addMiniBoss(scene: PlayScene, level = 3): MiniBoss {
    const seams = scene as unknown as SceneSeams;
    const miniBoss = new MiniBoss(scene, seams.miniBossConfigFor(level));
    seams.miniBoss = miniBoss;
    return miniBoss;
  }

  /** Fires one ordinary-bullet shot carrying `weaponId` at `(x, y)`. */
  function fireBullet(
    scene: PlayScene,
    x: number,
    y: number,
    weaponId: WeaponId,
  ): void {
    const bullet = scene.spawnPlayerBullet(x, y, 0, 0);
    (bullet as unknown as { weaponId?: string }).weaponId = weaponId;
    (scene as unknown as SceneSeams)._resolvePlayerBulletsVsEnemies();
  }

  // ────────────────────────────────────────────────────────────────
  // AC9 — the flinch asymmetry
  // ────────────────────────────────────────────────────────────────

  it.fails(
    'AC9 — an effective hit makes the mini-boss react (flinch)',
    async () => {
      const scene = await bootIsolated(HEX_ID);
      const miniBoss = addMiniBoss(scene);
      fireBullet(scene, miniBoss.x, miniBoss.y, EFFECTIVE_WEAPON);

      const reaction = lastReaction(miniBoss);
      expect(reaction?.state).toBe('effective');
      expect(reaction?.reacted).toBe(true);
    },
  );

  it.fails(
    'AC9 — a resisted hit shows no reaction (never a flinch)',
    async () => {
      const scene = await bootIsolated(HEX_ID);
      const miniBoss = addMiniBoss(scene);
      fireBullet(scene, miniBoss.x, miniBoss.y, RESISTED_WEAPON);

      const reaction = lastReaction(miniBoss);
      expect(reaction?.state).toBe('resisted');
      expect(reaction?.reacted).toBe(false);
    },
  );

  it.fails(
    'AC9 — the final boss inherits the same effective/resisted flinch asymmetry',
    async () => {
      const effectiveScene = await bootIsolated(HEX_ID);
      (effectiveScene as unknown as SceneSeams).spawnBoss();
      const effectiveBoss = (effectiveScene as unknown as SceneSeams).boss!;
      fireBullet(
        effectiveScene,
        effectiveBoss.x,
        effectiveBoss.y,
        EFFECTIVE_WEAPON,
      );
      const effectiveReaction = lastReaction(effectiveBoss);
      expect(effectiveReaction?.state).toBe('effective');
      expect(effectiveReaction?.reacted).toBe(true);

      const resistedScene = await bootIsolated(HEX_ID);
      (resistedScene as unknown as SceneSeams).spawnBoss();
      const resistedBoss = (resistedScene as unknown as SceneSeams).boss!;
      fireBullet(
        resistedScene,
        resistedBoss.x,
        resistedBoss.y,
        RESISTED_WEAPON,
      );
      const resistedReaction = lastReaction(resistedBoss);
      expect(resistedReaction?.state).toBe('resisted');
      expect(resistedReaction?.reacted).toBe(false);
    },
  );

  // ────────────────────────────────────────────────────────────────
  // The one-shot RESISTED tag
  // ────────────────────────────────────────────────────────────────

  it.fails(
    'AC9 — the RESISTED tag fires once per encounter, then a bar pip thereafter',
    async () => {
      const scene = await bootIsolated(HEX_ID);
      const miniBoss = addMiniBoss(scene);

      // The first resisted shot of the encounter deals **zero** damage through
      // the ledger and must still raise the tag.
      const states: (ResistedTagState | undefined)[] = [];
      for (let shot = 0; shot < 3; shot += 1) {
        fireBullet(scene, miniBoss.x, miniBoss.y, RESISTED_WEAPON);
        states.push(resistedTag(miniBoss));
      }

      // One tag, then pips — never the tag again.
      expect(states).toEqual(['tag', 'pip', 'pip']);
      expect(states.filter((state) => state === 'tag')).toHaveLength(1);
    },
  );

  it.fails(
    'AC9 — a neutral hit neither raises the RESISTED tag nor changes it',
    async () => {
      const scene = await bootIsolated(HEX_ID);
      const miniBoss = addMiniBoss(scene);

      expect(resistedTag(miniBoss)).toBe('none');
      fireBullet(scene, miniBoss.x, miniBoss.y, NEUTRAL_WEAPON);
      expect(resistedTag(miniBoss)).toBe('none');
    },
  );

  // ────────────────────────────────────────────────────────────────
  // Scope guard — neutral is unchanged
  // ────────────────────────────────────────────────────────────────

  it('scope guard — a neutral hit neither flinches nor raises a tag', async () => {
    const scene = await bootIsolated(HEX_ID);
    const miniBoss = addMiniBoss(scene);
    fireBullet(scene, miniBoss.x, miniBoss.y, NEUTRAL_WEAPON);

    // Safe accessors: on pre-change HEAD the reaction API is absent, so the
    // neutral “no reaction” outcome is vacuously true and must stay true after
    // the presentation lands.
    expect(lastReaction(miniBoss)?.reacted ?? false).toBe(false);
    expect(resistedTag(miniBoss) ?? 'none').toBe('none');
  });
});
