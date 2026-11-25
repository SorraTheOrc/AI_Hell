/**
 * Elite (anomaly) reward and death-cue resolution
 * (AH-0MWU666IS008JOR3, parent AH-0MWL7P1AO003LKXT).
 *
 * An elite must pay off visibly: it always drops from the shared power-up pool
 * (never the ordinary falling per-kill roll), it carries a guaranteed mineral
 * bump whose size rises through the campaign, and its death plays a cue
 * distinct from an ordinary hull-destruction boom.
 *
 * ## Reward contract
 *
 * - **Guaranteed drop.** `guaranteedDrop` is the constant `true`: the kill seam
 *   bypasses the per-kill chance roll and draws one id from the shared,
 *   slot-gated pool. Nothing here picks the id — that stays in the one shared
 *   drop seam, so the elite cannot drift from the ordinary pool.
 * - **Mineral bump.** {@link eliteMineralBump} interpolates the authored
 *   `2–4` range with the **existing** level-scaling curve
 *   (`levelScalingProgress`), so level 1 pays 2 and the campaign maximum pays
 *   4. It is a pure function of the level, so the same seed + wave always pays
 *   the same reward (parent AC8) and it needs no RNG draw.
 * - **Distinct death cue.** {@link playEliteDeathCue} dispatches the audio
 *   layer's elite alias ({@link playEliteDeathSound}) instead of the ordinary
 *   destruction cue. It is **gated on the shared SFX settings** — a muted
 *   player or a zero master volume dispatches nothing — and then routed
 *   through the shared playback provider, so the master volume still applies.
 *
 * `resolveEliteReward` is pure; only the cue helper touches the audio/settings
 * seams, and it degrades to a safe no-op without audio like every other cue.
 *
 * @module src/core/eliteReward
 */

import { playEliteDeathSound } from '../audio/effects';
import { levelScalingProgress } from './levelScaling';
import { DEFAULT_RULES, type GameRules } from './rules';
import { loadSettings, type SettingsRecord } from './settingsStore';

/** Smallest guaranteed mineral bump an elite pays (level 1). */
export const ELITE_MINERAL_BUMP_MIN = 2;

/** Largest guaranteed mineral bump an elite pays (campaign maximum). */
export const ELITE_MINERAL_BUMP_MAX = 4;

/** The reward resolved for one destroyed elite. */
export interface EliteReward {
  /**
   * Always `true`: an elite bypasses the ordinary per-kill chance roll and
   * draws from the shared pool. Expressing the guarantee as data (rather than
   * an implicit scene rule) is what the kill seam reads.
   */
  readonly guaranteedDrop: true;
  /** Guaranteed minerals the wreck pays on top of its ordinary re-drop. */
  readonly mineralBump: number;
}

/**
 * The guaranteed mineral bump for an elite killed at `level`.
 *
 * Interpolates {@link ELITE_MINERAL_BUMP_MIN} → {@link ELITE_MINERAL_BUMP_MAX}
 * with the shared level-scaling progress, rounded to a whole number and
 * clamped to the authored range. Level 1 is the minimum (the onboarding level
 * never spawns an elite, so this is also the neutral value) and the campaign
 * maximum is the maximum; the curve is monotonically non-decreasing.
 *
 * @param level — the live campaign level (clamped by the shared curve).
 * @param rules — rules supplying the scaling span; defaults to
 *   {@link DEFAULT_RULES}.
 * @returns An integer in `[ELITE_MINERAL_BUMP_MIN, ELITE_MINERAL_BUMP_MAX]`.
 */
export function eliteMineralBump(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): number {
  const t = levelScalingProgress(level, rules);
  const bump = Math.round(
    ELITE_MINERAL_BUMP_MIN +
      (ELITE_MINERAL_BUMP_MAX - ELITE_MINERAL_BUMP_MIN) * t,
  );
  return Math.min(ELITE_MINERAL_BUMP_MAX, Math.max(ELITE_MINERAL_BUMP_MIN, bump));
}

/**
 * Resolves the complete reward for one destroyed elite.
 *
 * @param level — the live campaign level.
 * @param rules — rules supplying the scaling span; defaults to
 *   {@link DEFAULT_RULES}.
 */
export function resolveEliteReward(
  level: number,
  rules: GameRules = DEFAULT_RULES,
): EliteReward {
  return { guaranteedDrop: true, mineralBump: eliteMineralBump(level, rules) };
}

/** The SFX settings slice the elite death cue honours. */
export type EliteCueSettings = Pick<SettingsRecord, 'sfxMuted' | 'sfxVolume'>;

/**
 * Whether the shared SFX settings allow the elite death cue to be dispatched.
 *
 * The playback provider also applies the master gain, but an explicit gate
 * here means a muted/zero-volume player never dispatches the extra cue at all
 * (and a test can pin the shared-settings contract without pixel/audio
 * inspection). A missing/non-finite volume is treated as silent only when it
 * is exactly `0`; the provider remains the authority for partial volumes.
 *
 * @param settings — the shared settings record (defaults to the persisted
 *   store via {@link loadSettings}).
 */
export function isEliteDeathCueEnabled(
  settings: EliteCueSettings = loadSettings(),
): boolean {
  if (settings.sfxMuted) return false;
  return !(settings.sfxVolume <= 0);
}

/**
 * Plays the elite's **distinct** death cue when the shared SFX settings allow
 * it.
 *
 * Returns whether a cue was dispatched, so the kill seam and tests can observe
 * the decision without inspecting the audio provider. Safe no-op without audio
 * (headless tests, autoplay-blocked browsers) through the shared cue layer.
 *
 * @param settings — the shared settings record (defaults to the persisted
 *   store via {@link loadSettings}).
 * @returns `true` when the cue was dispatched, `false` when the settings
 *   silenced it.
 */
export function playEliteDeathCue(
  settings: EliteCueSettings = loadSettings(),
): boolean {
  if (!isEliteDeathCueEnabled(settings)) return false;
  playEliteDeathSound();
  return true;
}
