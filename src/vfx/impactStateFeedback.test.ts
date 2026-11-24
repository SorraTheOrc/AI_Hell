/**
 * Matchup impact-state presentation contract tests
 * (AH-0MWL88W8E0074Z8Z, **TEST-FIRST** — Phase 3 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC7, AC8).
 *
 * This suite pins what an `effective` and a `resisted` shot **look and sound**
 * like *before* the presentation exists — the B half of producer decision
 * Q1 = A + B. The resisted state must read as *wrong tool*, never as *broken
 * gun*, so every assertion is on a **published mapping** (a cue name, a
 * playback rate, an impact-spec shape/colour discriminator), never on a pixel
 * diff or a drawn command buffer.
 *
 * ## Red-before / green-after
 *
 * Every behavioural case is authored red against pre-change HEAD: the state
 * cue/spec resolvers and the two dedicated state cues do not exist yet, so the
 * cases are wrapped in Vitest's `it.fails` (the repo's red-first convention —
 * see `src/vfx/orbitalStrike.test.ts` and
 * `src/scenes/core/hexMatchupDamageSources.test.ts`). The implementation item
 * (AH-0MWL88YYO0053DWH) **flips every `it.fails` back to a plain `it`** once
 * the presentation lands; a leftover `it.fails` then fails the suite, so this
 * is a real target rather than a permanent exemption.
 *
 * The resolvers are reached through **non-literal typed views** of the existing
 * modules (the exports do not exist yet, and a static import of a missing
 * symbol would fail `tsc --noEmit` and therefore the build). The helpers below
 * fail with the missing export named, so the red run reports *what* is absent.
 *
 * ## Pinned contract (AH-0MWL88YYO0053DWH must match exactly)
 *
 * `src/audio/effects.ts`
 *
 * - `ImpactFeedbackState = 'neutral' | 'effective' | 'resisted'`.
 * - `MATCHUP_IMPACT_STATE_CUES` — a published mapping for the two non-neutral
 *   states, each `{ cue: string; rate: number }`:
 *   - `effective.cue` and `resisted.cue` are **different** cue names from each
 *     other **and** from the weapon's own neutral cue;
 *   - `effective.rate` and `resisted.rate` are **different** from each other
 *     **and** from neutral's unity rate `1`.
 * - `resolveImpactStateCue(state, weaponCue)` — returns the state's
 *   `{ cue, rate }`; `neutral` returns `{ cue: weaponCue, rate: 1 }`.
 * - `playMatchupEffectiveImpactSound` / `playMatchupResistedImpactSound` —
 *   baked cue functions, registered in `PLAYER_WEAPON_IMPACT_CUES` (so
 *   `playWeaponImpactCue` dispatches them) and each playing at its mapped
 *   rate.
 *
 * `src/utils/weapons.ts`
 *
 * - `ImpactFxShape = 'circle' | 'shard' | 'spall'` — an optional `shape`
 *   discriminator on `ImpactFxSpec` (absent ⇒ `'circle'`, so every shipped
 *   per-weapon spec is unchanged).
 * - `MATCHUP_EFFECTIVE_IMPACT_FX` / `MATCHUP_RESISTED_IMPACT_FX` — published
 *   specs differing in **shape as well as colour**.
 * - `resolveImpactStateFx(base, state)` — `neutral` returns `base`
 *   **byte-identically**; `effective`/`resisted` return their published spec.
 *
 * ## Distinguishable with colour removed
 *
 * The three states must stay separable for a colour-blind player: distinct
 * **shape** (circle vs shard vs spall) and distinct **pitch** (rate 1 vs the
 * effective/resisted rates). That is what the "colour removed" cases assert.
 *
 * @module vfx/impactStateFeedback.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as effectsModule from '../audio/effects';
import * as weaponsModule from '../utils/weapons';
import { RecordingSfxProvider } from '../test/audioTestDouble';
import type { ImpactFxSpec } from '../utils/weapons';

/**
 * The three presentation states. Kept as a local alias so this suite compiles
 * before the type is exported; it mirrors `HexMatchupVerdict` structurally.
 */
type ImpactFeedbackState = 'neutral' | 'effective' | 'resisted';

/** The published impact-shape discriminator (absent ⇒ `'circle'`). */
type ImpactFxShape = 'circle' | 'shard' | 'spall';

/** One state's resolved cue + playback rate. */
interface ImpactStateCue {
  /** The cue name dispatched through `playWeaponImpactCue`. */
  cue: string;
  /** Playback-rate multiplier relative to the baked asset (>1 bright, <1 dull). */
  rate: number;
}

/**
 * The state→cue surface `src/audio/effects.ts` must publish (not yet present).
 */
interface ImpactStateCueModule {
  MATCHUP_IMPACT_STATE_CUES?: {
    effective: ImpactStateCue;
    resisted: ImpactStateCue;
  };
  resolveImpactStateCue?: (
    state: ImpactFeedbackState,
    weaponCue: string,
  ) => ImpactStateCue;
}

/** `ImpactFxSpec` plus the not-yet-published `shape` discriminator. */
interface ImpactFxSpecView extends ImpactFxSpec {
  shape?: ImpactFxShape;
}

/**
 * The state→spec surface `src/utils/weapons.ts` must publish (not yet present).
 */
interface ImpactStateFxModule {
  MATCHUP_EFFECTIVE_IMPACT_FX?: ImpactFxSpecView;
  MATCHUP_RESISTED_IMPACT_FX?: ImpactFxSpecView;
  resolveImpactStateFx?: (
    base: ImpactFxSpec,
    state: ImpactFeedbackState,
  ) => ImpactFxSpecView;
}

const audio = effectsModule as unknown as typeof effectsModule &
  ImpactStateCueModule;
const weapons = weaponsModule as unknown as typeof weaponsModule &
  ImpactStateFxModule;

const REPO_ROOT = process.cwd();
const CUE_MAPPING_DOC = 'docs/AUDIO_TONEFORGE_CUE_MAPPING.md';

/** The weapon's own neutral cue — the baseline every state cue must differ from. */
const NEUTRAL_WEAPON_CUE = weaponsModule.WEAPON_CATALOGUE.cannon.impactFx!.cue;

const STATES: readonly ImpactFeedbackState[] = [
  'neutral',
  'effective',
  'resisted',
];

/** Fails with the missing export named when `MATCHUP_IMPACT_STATE_CUES` is absent. */
function requireStateCueMapping(): NonNullable<
  ImpactStateCueModule['MATCHUP_IMPACT_STATE_CUES']
> {
  const mapping = audio.MATCHUP_IMPACT_STATE_CUES;
  if (mapping === undefined) {
    throw new Error(
      'Missing MATCHUP_IMPACT_STATE_CUES in src/audio/effects.ts — the ' +
        'published effective/resisted state→cue mapping does not exist yet.',
    );
  }
  return mapping;
}

/** Fails with the missing export named when `resolveImpactStateCue` is absent. */
function resolveStateCue(
  state: ImpactFeedbackState,
  weaponCue = NEUTRAL_WEAPON_CUE,
): ImpactStateCue {
  const resolve = audio.resolveImpactStateCue;
  if (typeof resolve !== 'function') {
    throw new Error(
      'Missing resolveImpactStateCue(state, weaponCue) in ' +
        'src/audio/effects.ts — the state→cue resolver does not exist yet.',
    );
  }
  return resolve.call(audio, state, weaponCue);
}

/** Fails with the missing export named when `resolveImpactStateFx` is absent. */
function resolveStateFx(
  state: ImpactFeedbackState,
  base: ImpactFxSpec = weaponsModule.WEAPON_CATALOGUE.cannon.impactFx!,
): ImpactFxSpecView {
  const resolve = weapons.resolveImpactStateFx;
  if (typeof resolve !== 'function') {
    throw new Error(
      'Missing resolveImpactStateFx(base, state) in src/utils/weapons.ts — ' +
        'the state→impact-spec resolver does not exist yet.',
    );
  }
  return resolve.call(weapons, base, state);
}

/** The impact-spec shape with the documented default applied. */
function shapeOf(spec: ImpactFxSpecView): ImpactFxShape {
  return spec.shape ?? 'circle';
}

const readDoc = (relativePath: string): string =>
  fs.readFileSync(path.resolve(REPO_ROOT, relativePath), 'utf8');

// ── State → cue (AC7) ────────────────────────────────────────────────

describe('matchup state → impact cue (AC7)', () => {
  let recording: RecordingSfxProvider;

  beforeEach(() => {
    recording = new RecordingSfxProvider();
    effectsModule.setSfxSoundProvider(recording);
  });

  afterEach(() => {
    effectsModule._resetAudioContextForTests();
  });

  it.fails(
    'AC7 — effective and resisted map to a different cue at a different playback rate than neutral',
    () => {
      const mapping = requireStateCueMapping();

      // The mapping itself is published for the two non-neutral states.
      expect(mapping.effective.cue).not.toBe(NEUTRAL_WEAPON_CUE);
      expect(mapping.resisted.cue).not.toBe(NEUTRAL_WEAPON_CUE);
      expect(mapping.effective.cue).not.toBe(mapping.resisted.cue);

      // Neutral is the weapon's own cue at unity rate.
      const neutral = resolveStateCue('neutral');
      expect(neutral.cue).toBe(NEUTRAL_WEAPON_CUE);
      expect(neutral.rate).toBe(1);

      // Both non-neutral states differ in cue *and* playback rate.
      const effective = resolveStateCue('effective');
      const resisted = resolveStateCue('resisted');
      expect(effective.cue).not.toBe(neutral.cue);
      expect(resisted.cue).not.toBe(neutral.cue);
      expect(effective.rate).not.toBe(neutral.rate);
      expect(resisted.rate).not.toBe(neutral.rate);
      expect(effective.rate).not.toBe(resisted.rate);
    },
  );

  it.fails(
    'AC7 — every mapped state cue is registered in PLAYER_WEAPON_IMPACT_CUES',
    () => {
      for (const state of ['effective', 'resisted'] as const) {
        const { cue } = resolveStateCue(state);
        expect(
          Object.prototype.hasOwnProperty.call(
            effectsModule.PLAYER_WEAPON_IMPACT_CUES,
            cue,
          ),
          `${state} cue "${cue}" is not registered in PLAYER_WEAPON_IMPACT_CUES`,
        ).toBe(true);
        // And the exported dispatcher resolves it.
        expect(effectsModule.isPlayerWeaponImpactCue(cue)).toBe(true);
      }
    },
  );

  it.fails(
    'AC7 — every mapped state cue is documented in the ToneForge cue map',
    () => {
      const doc = readDoc(CUE_MAPPING_DOC);
      for (const state of ['effective', 'resisted'] as const) {
        const { cue } = resolveStateCue(state);
        expect(
          doc,
          `${state} cue "${cue}" has no row in ${CUE_MAPPING_DOC}`,
        ).toContain(`\`${cue}\``);
      }
    },
  );

  it.fails(
    'AC7 — no state is silent: every state dispatches a playable baked cue',
    () => {
      // The three states resolve to three *playable* cues; a resolved cue that
      // produces no playback is a silent state.
      for (const state of STATES) {
        const { cue } = resolveStateCue(state);
        recording.plays.length = 0;
        effectsModule.playWeaponImpactCue(cue);
        expect(
          recording.plays.length,
          `${state} resolved to "${cue}" but played nothing`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.fails(
    'AC7 — the three states stay distinguishable with colour removed (distinct pitch)',
    () => {
      const neutral = resolveStateCue('neutral');
      const effective = resolveStateCue('effective');
      const resisted = resolveStateCue('resisted');
      const distinctRates = new Set([
        neutral.rate,
        effective.rate,
        resisted.rate,
      ]);
      // Three different playback rates: the pitch cue alone separates the states.
      expect(distinctRates.size).toBe(3);

      // The dedicated cues actually play at their mapped rate (the mapping and
      // the baked cue cannot drift apart).
      for (const [state, resolved] of [
        ['effective', effective],
        ['resisted', resisted],
      ] as const) {
        expect(
          Object.prototype.hasOwnProperty.call(
            effectsModule.PLAYER_WEAPON_IMPACT_CUES,
            resolved.cue,
          ),
          `${state} cue "${resolved.cue}" is not dispatutable`,
        ).toBe(true);
        recording.plays.length = 0;
        effectsModule.playWeaponImpactCue(resolved.cue);
        expect(
          recording.plays[0]?.rate,
          `${state} cue "${resolved.cue}" did not play at its mapped rate`,
        ).toBe(resolved.rate);
      }
    },
  );
});

// ── State → impact spec (AC8) ────────────────────────────────────────

describe('matchup state → impact spec (AC8)', () => {
  it.fails(
    'AC8 — effective and resisted map to different specs differing in shape as well as colour',
    () => {
      expect(
        weapons.MATCHUP_EFFECTIVE_IMPACT_FX,
        'Missing MATCHUP_EFFECTIVE_IMPACT_FX in src/utils/weapons.ts',
      ).toBeDefined();
      expect(
        weapons.MATCHUP_RESISTED_IMPACT_FX,
        'Missing MATCHUP_RESISTED_IMPACT_FX in src/utils/weapons.ts',
      ).toBeDefined();

      const effective = resolveStateFx('effective');
      const resisted = resolveStateFx('resisted');

      // Not a colour-only difference: the shape discriminator must differ too.
      expect(shapeOf(effective)).not.toBe(shapeOf(resisted));
      expect(effective.color).not.toBe(resisted.color);

      // Both must be real ImpactFxSpecs (colour + radius + duration + cue).
      for (const spec of [effective, resisted]) {
        expect(typeof spec.color).toBe('number');
        expect(spec.radius).toBeGreaterThan(0);
        expect(spec.duration).toBeGreaterThan(0);
        expect(typeof spec.cue).toBe('string');
        expect(spec.cue.length).toBeGreaterThan(0);
      }
    },
  );

  it.fails(
    'AC8 — the neutral spec is byte-identical to today’s per-weapon impactFx',
    () => {
      const ids = [
        'cannon',
        'spread',
        'ricochet',
        'wave_laser',
        'heavy_slug',
      ] as const;
      for (const id of ids) {
        const base = weaponsModule.WEAPON_CATALOGUE[id].impactFx!;
        const neutral = resolveStateFx('neutral', base);
        // Byte-identical: no added `shape` (or any other) field and no
        // reordered/renamed values — neutral must ship exactly today's spec.
        expect(JSON.stringify(neutral), `${id} neutral spec changed`).toBe(
          JSON.stringify(base),
        );
      }
    },
  );

  it.fails(
    'AC8 — the three states stay distinguishable with colour removed (distinct shape)',
    () => {
      const neutral = resolveStateFx('neutral');
      const effective = resolveStateFx('effective');
      const resisted = resolveStateFx('resisted');
      const distinctShapes = new Set([
        shapeOf(neutral),
        shapeOf(effective),
        shapeOf(resisted),
      ]);
      // circle (neutral) vs shard (effective) vs spall (resisted).
      expect(distinctShapes.size).toBe(3);
    },
  );

  it.fails(
    'AC8 — the state spec carries the same cue the state→cue mapping resolves',
    () => {
      // No drift between the two halves: the spec's cue is exactly the cue the
      // mapping says to play, so the VFX and SFX of a state cannot disagree.
      for (const state of ['effective', 'resisted'] as const) {
        const spec = resolveStateFx(state);
        const cue = resolveStateCue(state);
        expect(
          spec.cue,
          `${state} spec cue and state cue disagree`,
        ).toBe(cue.cue);
      }
    },
  );
});
