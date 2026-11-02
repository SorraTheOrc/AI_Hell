/**
 * Catalogue-wide weapon feel guard (AH-0MVV0WMD8007LOVT, parent
 * AH-0MVMJMCQK004BE9T — AC1 / AC6 / AC8 / parent AC11 test half).
 *
 * Makes "a weapon shipped with no feel package" a **build failure** instead of
 * a player complaint. For every one of the 16 `WEAPON_CATALOGUE` ids the guard
 * asserts that the shared seams actually resolve:
 *
 * 1. a **fire cue** — `playWeaponFireSound(id)` dispatches exactly one
 *    playback whose asset resolves through `getCueAsset(cue)` in
 *    `CUE_MANIFEST` (AC1a),
 * 2. a **launch flash** — the definition declares `muzzleFlash` in the
 *    weapon's own family colour, with a positive radius and duration (AC3), so
 *    the shared `CombatCoreScene._autoFire` → `spawnMuzzleFlash` path fires,
 * 3. **connect feedback** — an `impactFx` whose `cue` is registered in the
 *    player impact-cue registry, or — for the AOE family only — a documented
 *    exemption in {@link AOE_IMPACT_FEEDBACK} whose cue is the one the shared
 *    AOE seam (`CombatScene.spawnAoeEffectVfx` / `spawnAoeDetonationVfx`)
 *    actually plays (AC4).
 *
 * The AOE exemption is **data with a written reason**, never a call-site
 * special case (parent Constraint), and the pure {@link missingFeelMetadata}
 * predicate is asserted directly against synthetic definitions so a future
 * 17th weapon cannot slip through (AC7b).
 *
 * This is a test/verification item: the only production change is exporting
 * the impact-cue registry/predicate from `src/audio/effects.ts` (AC5) so the
 * guard asserts registry membership instead of duplicating the list.
 *
 * Audio is a headless no-op with no audio context: the playback layer is
 * driven through the shared recording `SfxSoundProvider` double.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as effectsModule from '../audio/effects';
import {
  PLAYER_WEAPON_IMPACT_CUES,
  isPlayerWeaponImpactCue,
} from '../audio/effects';
import { CUE_MANIFEST, assetUrlFor, getCueAsset } from '../audio/cueManifest';
import {
  CUE_VOICE_WINDOW_MS,
  MAX_CONCURRENT_CUE_VOICES,
} from '../audio/cueVoiceLimiter';
import { HOLD_FULL_FIRE_VOLUME_SCALE } from '../core/rules';
import { EffectsRegistry } from '../powerups/effects';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { RecordingSfxProvider } from '../test/audioTestDouble';
import {
  BULLET_COLORS,
  WEAPON_CATALOGUE,
  type WeaponDefinition,
  type WeaponId,
} from './weapons';
import { CombatScene } from '../scenes/core/CombatScene';

// ── The guard's data ────────────────────────────────────────────────

/** Every catalogue id, in catalogue order (16 today). */
const CATALOGUE_IDS = Object.keys(WEAPON_CATALOGUE) as WeaponId[];

/**
 * The cue each weapon's fire must dispatch, asserted through the one shared
 * `playWeaponFireSound` switch (AC1a). This is the full 16-id table — not the
 * 11-entry subset the older `effects.test.ts` case list covered.
 */
const FIRE_CUE_BY_WEAPON: Record<WeaponId, string> = {
  cannon: 'playCannonFireSound',
  spread: 'playSpreadFireSound',
  dual: 'playDualFireSound',
  rapid: 'playRapidFireSound',
  wave_laser: 'playWaveLaserFireSound',
  ricochet: 'playRicochetFireSound',
  cluster: 'playClusterFireSound',
  options: 'playOptionsFireSound',
  nova: 'playNovaFireSound',
  mortar: 'playMortarFireSound',
  arc: 'playArcFireSound',
  rear_guard: 'playRearGuardFireSound',
  broadside: 'playBroadsideFireSound',
  railgun: 'playRailgunFireSound',
  shard_swarm: 'playShardSwarmFireSound',
  heavy_slug: 'playHeavySlugFireSound',
};

/** The shared AOE seam method that owns a weapon's connect cue. */
type AoeSeamMethod = 'spawnAoeEffectVfx' | 'spawnAoeDetonationVfx';

/** A documented AOE-family exemption from the per-shot `impactFx` contract. */
interface AoeImpactFeedback {
  /** The shared AOE seam method that plays the cue(s). */
  readonly seam: AoeSeamMethod;
  /** The cue export name(s) that seam plays on a connect. */
  readonly cues: readonly string[];
  /** Why this weapon legitimately has no per-shot `impactFx`. */
  readonly reason: string;
}

/**
 * AOE-family exemption, encoded as **data with a reason** (parent Constraint;
 * AC4/AC7c). `nova` fires an `onFire` ring and `mortar` an `onRandom` blast —
 * neither launches a per-shot bullet that could carry an `impactFx`, so their
 * connect feedback is the cue the shared AOE seam plays with the VFX:
 *
 * - `nova` — the ring expansion calls `playNovaImpactSound` from
 *   `spawnAoeEffectVfx`;
 * - `mortar` — the blast calls `playMortarImpactSound` (shell lands) then
 *   `playMortarDetonationSound` (boom) from `spawnAoeDetonationVfx`.
 */
const AOE_IMPACT_FEEDBACK: Readonly<Record<string, AoeImpactFeedback>> = {
  nova: {
    seam: 'spawnAoeEffectVfx',
    cues: ['playNovaImpactSound'],
    reason:
      'Nova fires an onFire ring at the ship and spawns no travelling ' +
      'projectile, so there is no per-shot impact point to attach an ' +
      '`impactFx` to; the shockwave connect is the baked nova impact cue ' +
      'played by the shared AOE VFX seam as the ring expands.',
  },
  mortar: {
    seam: 'spawnAoeDetonationVfx',
    cues: ['playMortarImpactSound', 'playMortarDetonationSound'],
    reason:
      'Mortar resolves an onRandom blast with no travelling projectile, so ' +
      'there is no per-shot impact point to attach an `impactFx` to; the ' +
      'connect is the shell-landing crack plus the detonation boom played by ' +
      'the shared AOE detonation seam.',
  },
};

/** The feel fields the guard judges (structural subset, so synthetic defs work). */
type FeelCandidate = Pick<WeaponDefinition, 'id' | 'muzzleFlash' | 'impactFx'>;

/**
 * The guard's pure predicate: the feel metadata `def` is **missing**, as a
 * list of human-readable reasons (empty = complete). Exposed at module scope so
 * AC7b can assert it rejects synthetic definitions directly.
 */
function missingFeelMetadata(def: FeelCandidate): string[] {
  const missing: string[] = [];
  const familyColor = BULLET_COLORS[def.id];

  const flash = def.muzzleFlash;
  if (flash === undefined) {
    missing.push('muzzleFlash');
  } else {
    if (flash.color !== familyColor) missing.push('muzzleFlash colour');
    if (!(flash.radius > 0)) missing.push('muzzleFlash radius');
    if (!(flash.duration > 0)) missing.push('muzzleFlash duration');
  }

  const fx = def.impactFx;
  if (fx === undefined) {
    // The AOE family is exempt only when the exemption is documented data.
    if (AOE_IMPACT_FEEDBACK[def.id] === undefined) missing.push('impactFx');
    return missing;
  }
  if (fx.color !== familyColor) missing.push('impactFx colour');
  if (!(fx.radius > 0)) missing.push('impactFx radius');
  if (!(fx.duration > 0)) missing.push('impactFx duration');
  if (!isPlayerWeaponImpactCue(fx.cue)) missing.push('impactFx cue');
  return missing;
}

/** The baked URL(s) a cue may legitimately resolve to (multi-seed cues vary). */
function allowedUrls(cue: string): string[] {
  const entry = getCueAsset(cue);
  if (entry === undefined) throw new Error(`cue ${cue} is not in CUE_MANIFEST`);
  return entry.seeds.length > 0
    ? entry.seeds.map((seed) => `audio/sfx/${entry.recipe}.${seed}.wav`)
    : [assetUrlFor(entry)];
}

// ── 1. Fire-cue dispatch for every catalogue weapon (AC1 + AC2) ─────

describe('catalogue-wide fire cues (AC1/AC2)', () => {
  let recording: RecordingSfxProvider;

  beforeEach(() => {
    recording = new RecordingSfxProvider();
    effectsModule.setSfxSoundProvider(recording);
  });

  afterEach(() => {
    effectsModule._resetAudioContextForTests();
  });

  it('covers all 16 catalogue ids with one asserted cue each', () => {
    expect(CATALOGUE_IDS).toHaveLength(16);
    expect(Object.keys(FIRE_CUE_BY_WEAPON).sort()).toEqual([...CATALOGUE_IDS].sort());
  });

  it('every catalogue weapon dispatches exactly one manifest-mapped fire cue', () => {
    for (const id of CATALOGUE_IDS) {
      const cue = FIRE_CUE_BY_WEAPON[id];
      recording.plays.length = 0;

      effectsModule.playWeaponFireSound(id);

      expect(recording.plays.length, `${id} should play exactly one cue`).toBe(1);
      expect(
        allowedUrls(cue),
        `${id} should resolve ${cue} through CUE_MANIFEST`,
      ).toContain(recording.plays[0].url);
    }
  });

  it('the reduced-volume metronome path plays the identical asset for every weapon (AC2)', () => {
    for (const id of CATALOGUE_IDS) {
      recording.plays.length = 0;

      effectsModule.playWeaponFireSound(id);
      effectsModule.playWeaponFireSound(id, {
        volume: HOLD_FULL_FIRE_VOLUME_SCALE,
      });

      expect(recording.plays, `${id} should play twice`).toHaveLength(2);
      expect(recording.plays[1].url, `${id} must not drift between paths`).toBe(
        recording.plays[0].url,
      );
      expect(recording.plays[1].volume, `${id} reduced volume`).toBe(
        HOLD_FULL_FIRE_VOLUME_SCALE,
      );
    }
  });

  it('an id with no baked fire cue stays a silent no-op (AC7a)', () => {
    expect(() =>
      effectsModule.playWeaponFireSound('not-a-catalogue-weapon' as never),
    ).not.toThrow();
    expect(recording.plays).toHaveLength(0);
  });
});

// ── 2. Muzzle flash + connect feedback metadata (AC3/AC4/AC6) ───────

describe('catalogue-wide launch flash and connect feedback (AC3/AC4/AC6)', () => {
  it('every catalogue weapon declares a complete feel package', () => {
    for (const id of CATALOGUE_IDS) {
      expect(
        missingFeelMetadata(WEAPON_CATALOGUE[id]),
        `${id} feel package`,
      ).toEqual([]);
    }
  });

  it('every launch flash is coloured in the weapon’s own family (AC3)', () => {
    for (const id of CATALOGUE_IDS) {
      const flash = WEAPON_CATALOGUE[id].muzzleFlash;
      expect(flash, `${id} muzzleFlash`).toBeDefined();
      expect(flash?.color, `${id} launch colour`).toBe(BULLET_COLORS[id]);
      expect(flash?.radius ?? 0, `${id} launch radius`).toBeGreaterThan(0);
      expect(flash?.duration ?? 0, `${id} launch duration`).toBeGreaterThan(0);
    }
  });

  it('every non-AOE weapon registers a colour-matched impact cue (AC4)', () => {
    for (const id of CATALOGUE_IDS) {
      if (AOE_IMPACT_FEEDBACK[id] !== undefined) continue;
      const fx = WEAPON_CATALOGUE[id].impactFx;
      expect(fx, `${id} impactFx`).toBeDefined();
      expect(fx?.color, `${id} impact colour`).toBe(BULLET_COLORS[id]);
      expect(fx?.radius ?? 0, `${id} impact radius`).toBeGreaterThan(0);
      expect(fx?.duration ?? 0, `${id} impact duration`).toBeGreaterThan(0);
      expect(isPlayerWeaponImpactCue(fx?.cue ?? ''), `${id} impact cue`).toBe(true);
    }
  });

  it('the AOE exemption covers exactly the weapons with no per-shot impactFx (AC4)', () => {
    const withoutImpactFx = CATALOGUE_IDS.filter(
      (id) => WEAPON_CATALOGUE[id].impactFx === undefined,
    );
    expect(Object.keys(AOE_IMPACT_FEEDBACK).sort()).toEqual(
      [...withoutImpactFx].sort(),
    );
    for (const [id, exemption] of Object.entries(AOE_IMPACT_FEEDBACK)) {
      expect(exemption.reason.trim().length, `${id} exemption reason`).toBeGreaterThan(0);
      expect(exemption.cues.length, `${id} exemption cues`).toBeGreaterThan(0);
      for (const cue of exemption.cues) {
        expect(getCueAsset(cue), `${id} ${cue} asset`).toBeDefined();
      }
    }
  });

  it('the new weapons stay inside the shipped density/legibility budget (AC6)', () => {
    const NEW_WEAPONS: readonly WeaponId[] = [
      'shard_swarm',
      'rear_guard',
      'broadside',
      'heavy_slug',
    ];
    for (const id of NEW_WEAPONS) {
      const def = WEAPON_CATALOGUE[id];
      expect(def.muzzleFlash?.radius ?? 0, `${id} launch radius`).toBeLessThanOrEqual(12);
      expect(def.impactFx?.radius ?? 0, `${id} impact radius`).toBeLessThanOrEqual(12);
      expect(def.muzzleFlash?.duration ?? 0, `${id} launch duration`).toBeLessThanOrEqual(0.16);
      expect(def.impactFx?.duration ?? 0, `${id} impact duration`).toBeLessThanOrEqual(0.16);
    }
  });

  it('no new throttling logic was introduced — the shipped limiter is unchanged (AC6)', () => {
    expect(MAX_CONCURRENT_CUE_VOICES).toBe(4);
    expect(CUE_VOICE_WINDOW_MS).toBe(150);
  });
});

// ── 3. Negative cases for the pure predicate (AC7b) ────────────────

describe('the guard rejects a future weapon that omits feel metadata (AC7b)', () => {
  it('rejects a synthetic definition with no launch flash and no impact feedback', () => {
    const missing = missingFeelMetadata({ id: 'shard_swarm' });
    expect(missing).toContain('muzzleFlash');
    expect(missing).toContain('impactFx');
  });

  it('rejects a synthetic definition with a launch flash but no impact feedback', () => {
    const missing = missingFeelMetadata({
      id: 'cannon',
      muzzleFlash: { color: BULLET_COLORS.cannon, radius: 7, duration: 0.12 },
    });
    expect(missing).toEqual(['impactFx']);
  });

  it('rejects an impact cue that is not in the player weapon impact registry', () => {
    const missing = missingFeelMetadata({
      id: 'cannon',
      muzzleFlash: { color: BULLET_COLORS.cannon, radius: 7, duration: 0.12 },
      impactFx: {
        color: BULLET_COLORS.cannon,
        radius: 9,
        duration: 0.16,
        cue: 'playNotARegisteredImpactSound',
      },
    });
    expect(missing).toContain('impactFx cue');
  });

  it('exposes the registry so the guard never duplicates the cue list (AC5)', () => {
    // Structural assertion: the guard resolves membership through the exported
    // predicate, and every registered cue resolves a manifest asset.
    for (const cue of Object.keys(PLAYER_WEAPON_IMPACT_CUES)) {
      expect(isPlayerWeaponImpactCue(cue), cue).toBe(true);
      expect(getCueAsset(cue), `${cue} asset`).toBeDefined();
    }
    expect(isPlayerWeaponImpactCue('playNovaImpactSound')).toBe(false);
  });
});

// ── 4. The AOE exemption is the cue the shared seam actually plays ──

/**
 * Minimal combat-scene stub exposing the two shared AOE VFX seams the
 * exemption names. No enemies, bullets or player are needed: the seam is the
 * connect path under test, and the scene runs the **real** `CombatScene`
 * implementations (never a copy), so the game and every gym share it.
 */
class FeelSeamScene extends CombatScene<never, never, never> {
  private readonly effects = new EffectsRegistry();

  constructor() {
    super({ key: 'WeaponFeelSeamScene' });
  }

  protected override getPlayer() {
    return null;
  }
  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected override getEnemyEntities(): readonly never[] {
    return [];
  }
  protected override getEnemyBullets(): readonly never[] {
    return [];
  }
  protected override setEnemyBullets(_bullets: never[]): void {
    // No enemy bullets in this stub.
  }

  runAoeEffectVfx(def: WeaponDefinition, x: number, y: number): void {
    this.spawnAoeEffectVfx(def, x, y);
  }
  runAoeDetonationVfx(def: WeaponDefinition, x: number, y: number): void {
    this.spawnAoeDetonationVfx(def, x, y);
  }
}

describe('the AOE exemption is played by the shared seam (AC4/AC7c)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<FeelSeamScene> {
    booted = await bootScene([FeelSeamScene]);
    return booted.scene as FeelSeamScene;
  }

  for (const [id, exemption] of Object.entries(AOE_IMPACT_FEEDBACK)) {
    it(`plays ${id}’s declared connect cue through ${exemption.seam}`, async () => {
      const scene = await boot();
      const spies = exemption.cues.map((cue) =>
        vi.spyOn(
          effectsModule as unknown as Record<string, () => void>,
          cue,
        ),
      );

      if (exemption.seam === 'spawnAoeEffectVfx') {
        scene.runAoeEffectVfx(WEAPON_CATALOGUE[id as WeaponId], 100, 100);
      } else {
        scene.runAoeDetonationVfx(WEAPON_CATALOGUE[id as WeaponId], 100, 100);
      }

      // The exemption is not silently skipped: the seam plays exactly the cue
      // the guard claims it plays (never a generic fallback).
      for (const [index, spy] of spies.entries()) {
        expect(spy, `${id} ${exemption.cues[index]}`).toHaveBeenCalledTimes(1);
      }
    });
  }

  it('never silently skips an exempted weapon (both seams are exercised)', () => {
    // The data-level guarantee: every exemption names a known seam and a
    // manifest-mapped cue, so the suite above cannot be vacuously skipped.
    for (const [id, exemption] of Object.entries(AOE_IMPACT_FEEDBACK)) {
      expect(['spawnAoeEffectVfx', 'spawnAoeDetonationVfx'], id).toContain(
        exemption.seam,
      );
      for (const cue of exemption.cues) {
        expect(CUE_MANIFEST.some((entry) => entry.cue === cue), `${id} ${cue}`).toBe(
          true,
        );
      }
    }
  });
});
