/**
 * Per-cue concurrent-voice limiter (AH-0MVH8RQR7007QG8E).
 *
 * Dense firefights and mass kills can dispatch dozens of identical weapon /
 * explosion cues in the same instant, which clips the mix and overloads the
 * audio generator. This module owns a single, pure policy: each **cue** (a
 * distinct sound) may have at most {@link MAX_CONCURRENT_CUE_VOICES} live
 * voices within a {@link CUE_VOICE_WINDOW_MS} window. Requests beyond the cap
 * are dropped; the cue becomes audible again once earlier voices age out.
 *
 * The policy is time-injectable so it is unit-testable and deterministic, and
 * it is applied once at the shared `playCue` funnel in `audio/effects.ts`, so
 * the game and every gym are covered by the same limit.
 *
 * @module audio/cueVoiceLimiter
 */

/** Maximum concurrently playing voices for any one cue. */
export const MAX_CONCURRENT_CUE_VOICES = 4;

/**
 * How long (ms) a dispatched voice occupies its cue's budget. Covers the
 * attack + body of the short baked cues (below the 187.5 ms 16th-note spacing, so consecutive scheduled accents never collide) without holding the slot long enough
 * to silence a sustained firefight.
 */
export const CUE_VOICE_WINDOW_MS = 150;

/** The limiter policy surface (pure, injectable clock). */
export interface CueVoiceLimiter {
  /**
   * Whether one more voice of `cue` may play now.
   *
   * @param cue - The cue identifier (one distinct sound).
   * @returns True when the voice is admitted; false when the cap is reached.
   */
  allow(cue: string): boolean;
  /** Clears all recorded voices (scene teardown / tests). */
  reset(): void;
  /** Number of voices currently occupying `cue`'s budget. */
  activeVoices(cue: string): number;
}

/**
 * Creates a limiter.
 *
 * @param maxVoices - Per-cue concurrent cap (defaults to the shipped value).
 * @param windowMs - Voice occupancy window in ms (defaults to shipped value).
 * @param now - Millisecond clock (injectable for deterministic tests).
 */
export function createCueVoiceLimiter(
  maxVoices: number = MAX_CONCURRENT_CUE_VOICES,
  windowMs: number = CUE_VOICE_WINDOW_MS,
  now: () => number = () => Date.now(),
): CueVoiceLimiter {
  const cap = Math.max(1, Math.floor(maxVoices));
  const window = Math.max(0, windowMs);
  const voices = new Map<string, number[]>();

  const live = (cue: string, at: number): number[] => {
    const times = voices.get(cue) ?? [];
    // A zero-width window means "no memory": every request is independent.
    const kept = window === 0 ? [] : times.filter((ts) => at - ts < window);
    if (kept.length === 0) voices.delete(cue);
    else voices.set(cue, kept);
    return kept;
  };

  return {
    allow(cue: string): boolean {
      const at = now();
      const current = live(cue, at);
      if (current.length >= cap) return false;
      current.push(at);
      voices.set(cue, current);
      return true;
    },
    reset(): void {
      voices.clear();
    },
    activeVoices(cue: string): number {
      return live(cue, now()).length;
    },
  };
}

/**
 * The shared limiter used by `audio/effects.ts` for every cue dispatch.
 * Exported so tests can reset it between cases.
 */
export const cueVoiceLimiter = createCueVoiceLimiter();
