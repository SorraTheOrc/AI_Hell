/**
 * Gym ↔ game matchup parity
 * (AH-0MWL893J6006IFU9, **TEST-FIRST** — Phase 4 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC11).
 *
 * The producer decision Q1 = A + B makes one rule (the hex matchup verdict) and
 * one feedback family (damage, cue, impact spec) the whole encounter's language.
 * A gym is only a parity surface if it shows the **same** language: this suite
 * pins that the shipped game path (`PlayScene` over the shared `CombatScene`
 * seam) and `GymMiniBoss`'s deployed (HEX) encounter produce an identical
 * entity → state → damage / cue / spec mapping for the three verdicts, and that
 * the gym can toggle them.
 *
 * ## Red-before / green-after
 *
 * The three-verdict toggle and the live gym-path parity do not exist on
 * pre-change HEAD, so those cases are wrapped in Vitest's `it.fails` — the
 * repo's red-first convention (`src/scenes/core/hexMatchupDamageSources.test.ts`,
 * `src/vfx/impactStateFeedback.test.ts`). AH-0MWL8965R008K588 flips each
 * `it.fails` back to a plain `it` when the gym toggle lands; a leftover
 * `it.fails` then fails the suite. The **seam-provenance** case is a scope
 * guard rather than a red-first claim — it is already correct on HEAD by
 * construction (both scenes inherit the shared core) and must stay green once
 * the toggle lands.
 *
 * ## Pinned contract (AH-0MWL8965R008K588 must match exactly)
 *
 * `src/scenes/gym/GymMiniBoss.ts` publishes:
 *
 * - `GYM_MINI_BOSS_MATCHUP_STATES = ['effective', 'neutral', 'resisted'] as
 *   const` — the verdicts a tester can force.
 * - `selectGymMiniBossMatchupState(state)` / `getGymMiniBossMatchupState()` —
 *   the toggle. `null` restores the encounter's authored behaviour (the HEX
 *   profile's lookup); a selected verdict **overrides** it for **every**
 *   weapon, so the tester can watch any shot in any state.
 * - With HEX mode on, the override reaches the shared seam only through
 *   `getMatchupLookup()` (a return value), never by re-deriving the verdict or
 *   copying the charge/cue/spec code — one rule, one seam (AGENTS.md gym↔game
 *   parity).
 *
 * ## How the parity is observed
 *
 * Both paths are **booted and fired at**: the same hex
 * (`MINI_BOSS_GYM_HEX_ID`) supplies both lookups (the deployment's
 * `buildHexBossProfile` and the gym's `MINI_BOSS_GYM_HEX_PROFILE`, both from
 * the authored ring data), and the same three weapons are fired through each
 * scene's real collision pass. Damage is the number of `takeDamage()` calls,
 * the cue is the dispatched `playWeaponImpactCue` name and the spec is the
 * `spawnBulletImpact` shape/colour — the same observables the Phase 3 suite
 * pins. The authored facts the case relies on are pinned so a ring re-authoring
 * fails loudly rather than silently weakening the test:
 *
 * - `spread` is a weakness of `hex-r1-6` → **effective**;
 * - `arc` is a strength of `hex-r1-6` → **resisted** (it carries an `impactFx`
 *   like the other two, so the neutral/state spec comparison is meaningful);
 * - `cannon` is neither → **neutral**.
 *
 * @module scenes/gym/gymMatchupParity.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import * as bulletImpactModule from '../../vfx/bulletImpact';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { createRingState } from '../../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  saveHangarWarPayload,
} from '../../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import {
  buildAuthoredVerdictLookup,
  resolveHexMatchup,
} from '../../core/hangarWar/hexMatchup';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import type { FormationOffset } from '../../utils/formations';
import {
  MATCHUP_EFFECTIVE_IMPACT_FX,
  MATCHUP_RESISTED_IMPACT_FX,
  WEAPON_CATALOGUE,
  resolveImpactStateFx,
  type WeaponId,
} from '../../utils/weapons';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import { CombatScene } from '../core/CombatScene';
import { buildHangarDeployment } from '../hangarWar/hangarDeployment';
import { GymFormationScene } from './core/GymFormationScene';
import * as gymModule from './GymMiniBoss';
import {
  GymMiniBoss,
  MINI_BOSS_GYM_HEX_ID,
  MINI_BOSS_GYM_HEX_PROFILE,
  selectGymMiniBossHexProfile,
} from './GymMiniBoss';

// The Player's auto-fire reads the control scheme; the app default is
// Asteroids, so seed fourDirectional exactly as the other PlayScene suites.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/** The three verdicts in the order the gym toggle must publish them. */
const STATES = ['effective', 'neutral', 'resisted'] as const;
type MatchupState = (typeof STATES)[number];

/** The gym's not-yet-published toggle surface. */
interface GymMatchupToggleModule {
  GYM_MINI_BOSS_MATCHUP_STATES?: readonly MatchupState[];
  selectGymMiniBossMatchupState?: (
    state: MatchupState | null,
  ) => MatchupState | null;
  getGymMiniBossMatchupState?: () => MatchupState | null;
}

const gymToggle = gymModule as unknown as typeof gymModule &
  GymMatchupToggleModule;

/** The pieces of the toggle contract this suite drives. */
interface GymToggle {
  readonly states: readonly MatchupState[];
  select(state: MatchupState | null): MatchupState | null;
  get(): MatchupState | null;
}

/** Fails with the missing export named when the toggle is absent. */
function requireToggle(): GymToggle {
  const states = gymToggle.GYM_MINI_BOSS_MATCHUP_STATES;
  const select = gymToggle.selectGymMiniBossMatchupState;
  const get = gymToggle.getGymMiniBossMatchupState;
  if (states === undefined) {
    throw new Error(
      'Missing GYM_MINI_BOSS_MATCHUP_STATES in src/scenes/gym/GymMiniBoss.ts — ' +
        'the gym cannot demonstrate the three verdicts yet.',
    );
  }
  if (typeof select !== 'function' || typeof get !== 'function') {
    throw new Error(
      'Missing selectGymMiniBossMatchupState / getGymMiniBossMatchupState in ' +
        'src/scenes/gym/GymMiniBoss.ts — the gym verdict toggle does not ' +
        'exist yet.',
    );
  }
  return {
    states,
    select: (state) => select.call(gymToggle, state),
    get: () => get.call(gymToggle),
  };
}

/** The scene surface a fired shot needs (shared by both paths). */
interface MatchupShotScene {
  spawnPlayerBullet(
    x: number,
    y: number,
    vx: number,
    vy: number,
  ): { weaponId?: string; impactFx?: unknown };
  _resolvePlayerBulletsVsEnemies(): void;
}

/** What one connected shot did, as the parity assertion reads it. */
interface ShotObservation {
  /** Applied hit points — one `takeDamage()` call is one hit point. */
  readonly hits: number;
  /** The cue the shared impact seam dispatched. */
  readonly cue: string | undefined;
  /** The impact-spec shape drawn (absent ⇒ the neutral circle). */
  readonly shape: string | undefined;
  /** The impact-spec colour drawn. */
  readonly color: number | undefined;
}

/** A real multi-hit enemy that can be injected into the game's live list. */
class ParityTarget extends BaseEnemy {
  constructor(scene: Phaser.Scene, x: number, y: number, health = 40) {
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      health,
    };
    super(scene, x, y, config);
  }

  /** Static target: the shared formation-positioning step is a no-op. */
  applyFormationPosition(
    _x: number,
    _y: number,
    _dt: number,
    _spacingX = 0,
    _spacingY = 0,
  ): void {
    // Intentionally still: the parity case observes damage, not motion.
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // State, not pixels: this target exists to observe damage.
  }
}

/** The injected enemy-list entry `PlayScene` reads (its `spawned` shape). */
interface SpawnedEntry {
  entity: ParityTarget;
  enemyKey: string;
  startX: number;
  startY: number;
  spacingX: number;
  spacingY: number;
}

/** A fresh war with the requested ring materialised from the authored data. */
function payloadFor(hexId: string): HangarWarPayload {
  const match = /^hex-r(\d+)-/.exec(hexId);
  const ringIndex = match ? Number(match[1]) : 1;
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

/** Fires one shot of `weaponId` at `target` through the scene's collision pass. */
function fireShot(
  scene: MatchupShotScene,
  target: { x: number; y: number; takeDamage: () => unknown },
  weaponId: WeaponId,
): ShotObservation {
  const cueSpy = vi.spyOn(effectsModule, 'playWeaponImpactCue');
  const impactSpy = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');
  const damageSpy = vi.spyOn(target, 'takeDamage');

  const bullet = scene.spawnPlayerBullet(target.x, target.y, 0, 0);
  bullet.weaponId = weaponId;
  bullet.impactFx = WEAPON_CATALOGUE[weaponId].impactFx;
  scene._resolvePlayerBulletsVsEnemies();

  const lastImpact = impactSpy.mock.lastCall;
  const options = lastImpact?.[3] as
    | { shape?: string; color?: number }
    | undefined;
  const observation: ShotObservation = {
    hits: damageSpy.mock.calls.length,
    cue: cueSpy.mock.lastCall?.[0],
    shape: options?.shape,
    color: options?.color,
  };

  cueSpy.mockRestore();
  impactSpy.mockRestore();
  damageSpy.mockRestore();
  return observation;
}

describe('gym ↔ game matchup parity (AH-0MWL893J6006IFU9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
    selectGymMiniBossHexProfile(false);
    // Leave the module-level toggle in its authored state for the next suite.
    gymToggle.selectGymMiniBossMatchupState?.(null);
  });

  /** Boots `PlayScene` running the deployment for `hexId`. */
  async function bootGame(hexId: string): Promise<PlayScene> {
    if (booted) {
      booted.game.destroy(true);
      booted = null;
    }
    saveHangarWarPayload(payloadFor(hexId));
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({
      demo: false,
      hangarWar: buildHangarDeployment(payloadFor(hexId), {
        hexId,
        seed: 7,
      }),
    });
    await advanceGame(scene.game, 200);
    // No wave enemy, no auto-fire and no stray bullet may absorb the shot.
    const seams = scene as unknown as {
      spawned: unknown[];
      playerBullets: unknown[];
      autoFireEnabled(): boolean;
    };
    seams.spawned.length = 0;
    seams.playerBullets.length = 0;
    seams.autoFireEnabled = () => false;
    return scene;
  }

  /** Injects a multi-hit regular target into the game's live enemy list. */
  function addGameTarget(scene: PlayScene): ParityTarget {
    const target = new ParityTarget(scene, 120, 120, 40);
    (scene as unknown as { spawned: SpawnedEntry[] }).spawned.push({
      entity: target,
      enemyKey: 'parity-target',
      startX: 120,
      startY: 120,
      spacingX: 0,
      spacingY: 0,
    });
    return target;
  }

  /** Boots the gym's deployed (HEX) mini-boss encounter. */
  async function bootGym(): Promise<GymMiniBoss> {
    if (booted) {
      booted.game.destroy(true);
      booted = null;
    }
    selectGymMiniBossHexProfile(true);
    booted = await bootScene([GymMiniBoss]);
    return booted.scene as GymMiniBoss;
  }

  // ── AC11 — identical damage / cue / spec for every verdict ──────
  // ────────────────────────────────────────────────────────────────

  it(
    'AC11 — the game and the gym produce identical damage, cue and spec for all three verdicts',
    async () => {
      const hexId = MINI_BOSS_GYM_HEX_ID;
      // The authored verdicts this case relies on, pinned loudly.
      const expected = {
        spread: 'effective',
        arc: 'resisted',
        cannon: 'neutral',
      } as const;
      const lookup = MINI_BOSS_GYM_HEX_PROFILE.matchup;
      const definition = HEX_RING_DEFINITIONS.find(
        (candidate) => candidate.id === hexId,
      );
      expect(definition, `${hexId} is not authored`).toBeDefined();
      // The gym and the game read the same authored lookup for this hex.
      expect(lookup).toEqual(
        buildAuthoredVerdictLookup(
          definition!.strengths,
          definition!.weaknesses,
        ),
      );
      for (const weaponId of Object.keys(expected) as (keyof typeof expected)[]) {
        expect(
          resolveHexMatchup(weaponId, lookup),
          `${weaponId} verdict on ${hexId}`,
        ).toBe(expected[weaponId]);
      }

      // Game path: the shipped PlayScene over the shared CombatScene seam.
      const game = await bootGame(hexId);
      const gameTarget = addGameTarget(game);
      const gameShots: Record<string, ShotObservation[]> = {};
      for (const weaponId of Object.keys(expected) as WeaponId[]) {
        gameShots[weaponId] = [
          fireShot(game as unknown as MatchupShotScene, gameTarget, weaponId),
          fireShot(game as unknown as MatchupShotScene, gameTarget, weaponId),
        ];
      }

      // Gym path: the deployed encounter, the same hex, the same weapons.
      const gym = await bootGym();
      const gymTarget = gym.formationMiniBoss;
      const gymShots: Record<string, ShotObservation[]> = {};
      for (const weaponId of Object.keys(expected) as WeaponId[]) {
        gymShots[weaponId] = [
          fireShot(gym as unknown as MatchupShotScene, gymTarget, weaponId),
          fireShot(gym as unknown as MatchupShotScene, gymTarget, weaponId),
        ];
      }

      for (const weaponId of Object.keys(expected) as WeaponId[]) {
        // Field-for-field parity: the two paths are the same observable.
        expect(
          gymShots[weaponId],
          `${weaponId} (${expected[weaponId as keyof typeof expected]}) ` +
            'drifted between the game and the gym',
        ).toEqual(gameShots[weaponId]);
      }

      // And the shared observations are the published mapping's — so the two
      // paths cannot be identically wrong.
      const base = WEAPON_CATALOGUE.cannon.impactFx!;
      expect(gameShots.cannon[0]).toEqual({
        hits: 1,
        cue: base.cue,
        shape: undefined,
        color: base.color,
      });
      expect(gameShots.spread[0]).toEqual({
        hits: 2,
        cue: effectsModule.MATCHUP_IMPACT_STATE_CUES.effective.cue,
        shape: MATCHUP_EFFECTIVE_IMPACT_FX.shape,
        color: MATCHUP_EFFECTIVE_IMPACT_FX.color,
      });
      // Resisted pays one hit point per two connected shots (the ledger).
      expect(gameShots.arc).toEqual([
        {
          hits: 0,
          cue: effectsModule.MATCHUP_IMPACT_STATE_CUES.resisted.cue,
          shape: MATCHUP_RESISTED_IMPACT_FX.shape,
          color: MATCHUP_RESISTED_IMPACT_FX.color,
        },
        {
          hits: 1,
          cue: effectsModule.MATCHUP_IMPACT_STATE_CUES.resisted.cue,
          shape: MATCHUP_RESISTED_IMPACT_FX.shape,
          color: MATCHUP_RESISTED_IMPACT_FX.color,
        },
      ]);
    },
  );

  // Scope guard, not a red-first claim: both scenes already inherit the
  // shared seam on HEAD, and this pins that the toggle cannot be landed by
  // copying the charge/cue/spec code into the gym.
  it(
    'AC11 — neither path defines its own copy of the shared matchup seam',
    () => {
      const seamMethods = [
        'isMatchupEligible',
        'resolveMatchupImpactState',
        'resolveHitCharge',
        'resolveWeaponImpactFx',
        'resolveImpactFx',
      ] as const;
      const combat = CombatScene.prototype as unknown as Record<string, unknown>;

      // Both scenes run the shared core's code — the game and the gym cannot
      // fork the verdict, the charge, or the cue/spec mapping.
      for (const prototype of [
        PlayScene.prototype,
        GymMiniBoss.prototype,
      ] as const) {
        const proto = prototype as unknown as Record<string, unknown>;
        const name = prototype.constructor.name;
        for (const method of seamMethods) {
          expect(
            Object.prototype.hasOwnProperty.call(prototype, method),
            `${name} defines its own ${method}`,
          ).toBe(false);
          expect(
            proto[method],
            `${name}.${method} does not resolve to the shared CombatScene seam`,
          ).toBe(combat[method]);
        }
      }

      // The gym sits on the shared combat core (CombatScene), exactly like the
      // game's PlayScene.
      expect(Object.getPrototypeOf(GymFormationScene.prototype)).toBe(
        CombatScene.prototype,
      );
      expect(Object.getPrototypeOf(PlayScene.prototype)).toBe(
        CombatScene.prototype,
      );
    },
  );

  // ── AC11 — the gym's three-state toggle ─────────────────────────
  // ────────────────────────────────────────────────────────────────

  it(
    'AC11 — the gym toggles effective / neutral / resisted and shows the shared mapping',
    async () => {
      const toggle = requireToggle();
      expect([...toggle.states]).toEqual([...STATES]);

      const weaponId: WeaponId = 'cannon';
      const base = WEAPON_CATALOGUE[weaponId].impactFx!;
      // Two connected shots per state: effective 2/2, neutral 1/1, resisted 0/1.
      const expectedHits: Record<MatchupState, number> = {
        effective: 4,
        neutral: 2,
        resisted: 1,
      };

      for (const state of STATES) {
        expect(toggle.select(state)).toBe(state);
        expect(toggle.get()).toBe(state);

        // A fresh deployed encounter fights under the selected verdict.
        const gym = await bootGym();
        const target = gym.formationMiniBoss;
        const shots = [
          fireShot(gym as unknown as MatchupShotScene, target, weaponId),
          fireShot(gym as unknown as MatchupShotScene, target, weaponId),
        ];

        const totalHits = shots.reduce((total, shot) => total + shot.hits, 0);
        expect(totalHits, `${state} total hit points`).toBe(
          expectedHits[state],
        );

        // The same cue and spec the shared game path resolves for that state.
        const fx = resolveImpactStateFx(base, state)!;
        for (const shot of shots) {
          expect(shot.cue, `${state} cue`).toBe(
            effectsModule.resolveImpactStateCue(state, base.cue).cue,
          );
          expect(shot.shape ?? 'circle', `${state} spec shape`).toBe(
            fx.shape ?? 'circle',
          );
          expect(shot.color, `${state} spec colour`).toBe(fx.color);
        }
      }

      // `null` restores the encounter's authored behaviour.
      expect(toggle.select(null)).toBeNull();
      expect(toggle.get()).toBeNull();
    },
  );
});
