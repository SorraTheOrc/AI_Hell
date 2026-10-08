/**
 * Deterministic scripted player for the automated gameplay capture spike
 * (AH-0MUWMFF3C002WOBK).
 *
 * ## Why a scripted bot (and not a heuristic AI)
 *
 * The capture spike only needs a *non-trivial* gameplay segment: the ship
 * auto-fires, so steering it across the wave is enough to produce live
 * combat, explosions and pickups. A fixed, wall-clock-relative key
 * sequence is:
 *
 * - **reproducible** — the same plan is generated on every run (the game
 *   itself is not yet fully deterministic; see the determinism note in
 *   `docs/dev/gameplay-capture.md`);
 * - **tiny** — no reach into Phaser internals, no scene hooks, so the
 *   capture tool stays entirely opt-in and outside the shipped bundle;
 * - **testable** — plan construction is a pure function, unit-tested in
 *   `scripts/capture-gameplay.test.ts`.
 *
 * The plan is executed by `scripts/capture-gameplay.mjs`, which replays
 * each step as a real keydown/keyup pair through Playwright (trusted
 * browser input), while the canvas is recorded via
 * `canvas.captureStream(60)` → `MediaRecorder`.
 *
 * This module is plain ESM JavaScript so it can run under the project's
 * Node runtime without a TypeScript loader; `capture-bot.d.mts` supplies
 * the types used by the test suite.
 */

/** The four movement keys the bot uses (the ship auto-fires). */
export const MOVE_KEYS = Object.freeze([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

/** Default clip length in milliseconds (~15 s of gameplay). */
export const DEFAULT_CAPTURE_DURATION_MS = 15_000;

/** Default pause after pressing Enter, before recording, for PlayScene to settle. */
export const DEFAULT_WARMUP_MS = 2_000;

/**
 * A deterministic "sweep" figure: traverse the playfield left↔right with
 * small vertical bobs so the auto-fire tracks across wave formations and
 * the ship survives long enough to show explosions and pickups.
 *
 * Each entry holds one direction for `holdMs`; the ship's acceleration
 * model means short holds produce visible motion without hitting the walls.
 */
export const BASE_SWEEP_PATTERN = Object.freeze([
  { key: 'ArrowLeft', holdMs: 900 },
  { key: 'ArrowUp', holdMs: 250 },
  { key: 'ArrowRight', holdMs: 900 },
  { key: 'ArrowDown', holdMs: 250 },
  { key: 'ArrowLeft', holdMs: 700 },
  { key: 'ArrowDown', holdMs: 250 },
  { key: 'ArrowRight', holdMs: 700 },
  { key: 'ArrowUp', holdMs: 250 },
]);

/**
 * Builds a deterministic input plan that runs for approximately
 * `durationMs`: the base pattern is repeated (truncating the final step)
 * until the requested duration is covered.
 *
 * @param {number} [durationMs] — total hold time, in milliseconds.
 * @param {ReadonlyArray<{ key: string, holdMs: number }>} [pattern] — base pattern.
 * @returns {Array<{ key: string, holdMs: number }>} ordered plan.
 */
export function buildScriptedPlan(
  durationMs = DEFAULT_CAPTURE_DURATION_MS,
  pattern = BASE_SWEEP_PATTERN,
) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  if (!Array.isArray(pattern) || pattern.length === 0) return [];

  const plan = [];
  let remaining = Math.round(durationMs);
  let index = 0;

  while (remaining > 0) {
    const step = pattern[index % pattern.length];
    const holdMs = Math.min(step.holdMs, remaining);
    plan.push({ key: step.key, holdMs });
    remaining -= holdMs;
    index += 1;
  }

  return plan;
}

/**
 * Total hold time of a plan, in milliseconds.
 *
 * @param {ReadonlyArray<{ holdMs: number }>} plan
 * @returns {number}
 */
export function planDurationMs(plan) {
  return plan.reduce((total, step) => total + step.holdMs, 0);
}

/**
 * Decides whether a recorded clip is "non-trivial" enough for the spike's
 * acceptance criteria: it must be a decodable, non-black, moving image.
 *
 * This is a pure predicate over the in-browser probe stats produced by
 * `scripts/capture-gameplay.mjs`, so it can be unit-tested without a
 * browser. Thresholds are deliberately loose — the acceptance criterion is
 * "actual gameplay/VFX, not a black or static frame" — while still
 * rejecting an empty recording, a blank canvas and a frozen frame.
 *
 * @param {{ bytes?: number, width?: number, height?: number, nonBlackFraction?: number, uniqueColours?: number, motion?: number }} probe
 * @returns {{ nonTrivial: boolean, reasons: string[] }}
 */
export function isNonTrivialClip(probe) {
  const reasons = [];
  const bytes = Number(probe?.bytes ?? 0);
  const width = Number(probe?.width ?? 0);
  const height = Number(probe?.height ?? 0);
  const nonBlackFraction = Number(probe?.nonBlackFraction ?? 0);
  const uniqueColours = Number(probe?.uniqueColours ?? 0);
  const motion = Number(probe?.motion ?? 0);

  if (bytes <= 0) reasons.push('empty recording (0 bytes)');
  if (width <= 0 || height <= 0) reasons.push('no decodable video frames');
  if (nonBlackFraction < 0.002) reasons.push('frame is essentially black');
  if (uniqueColours < 8) reasons.push('too few distinct colours (static/black)');
  if (motion < 0.0005) reasons.push('sampled frames are static (no motion)');

  return { nonTrivial: reasons.length === 0, reasons };
}

/**
 * MediaRecorder WebM mime candidates in preference order: VP9 video with
 * Opus audio is richest, then VP8 video with Opus audio, then a bare WebM
 * container with no codec preference. `resolveCaptureMimeType` returns the
 * first candidate the browser reports as supported.
 */
export const CAPTURE_MIME_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]);

/**
 * Picks the richest WebM mime type that pairs a video codec with Opus audio,
 * so the recorded clip carries an audio track (AH-0MUWTNPYJ0031FQE).
 *
 * Candidates are tried richest-first: VP9+Opus, then VP8+Opus, then a plain
 * `video/webm` container as the last resort. Returns `null` when the probe
 * rejects every candidate (no WebM recording is possible) or when no probe
 * is supplied.
 *
 * @param {(mimeType: string) => boolean} isSupported
 *   Predicate standing in for `MediaRecorder.isTypeSupported`.
 * @returns {string | null}
 */
export function resolveCaptureMimeType(isSupported) {
  if (typeof isSupported !== 'function') return null;

  for (const mimeType of CAPTURE_MIME_CANDIDATES) {
    try {
      if (isSupported(mimeType)) return mimeType;
    } catch {
      // A throwing probe counts as "unsupported"; keep looking.
    }
  }

  return null;
}

/**
 * Peak-amplitude floor (fraction of full scale) below which a track is
 * treated as silent.
 *
 * AI_Hell's early levels are deliberately sparse: level 1 opens with almost
 * no enemies, so long stretches of near-silence are punctuated by short,
 * quiet SFX bursts. Over a whole clip that makes the RMS tiny even though
 * the clip is audibly non-silent, so the primary gate is the *peak*: any low
 * but non-zero peak above this floor passes. The floor sits well above the
 * recorder's noise floor and far below full scale, so it rejects only
 * genuine digital silence.
 */
export const AUDIO_SILENCE_PEAK_FLOOR = 0.005;

/**
 * Companion RMS floor (fraction of full scale), lower than the peak floor,
 * used to catch a sustained quiet signal that never develops a sharp peak. A
 * track is non-silent when *either* floor is cleared.
 */
export const AUDIO_SILENCE_RMS_FLOOR = 0.0005;

/**
 * Evaluates the audio half of a recorded clip from the in-page probe stats
 * produced by `scripts/capture-gameplay.mjs`.
 *
 * A track is non-silent only when it exists *and* its peak or RMS clears the
 * corresponding documented floor; a missing probe is treated as "no audio
 * track".
 *
 * When the probe reports a `decodeError` (the in-page
 * `AudioContext.decodeAudioData` fallback could not decode the recorded
 * WebM/Opus), the track is never reported as non-silent — an unmeasured
 * track must not silently pass — and the decode failure is surfaced as an
 * explicit reason (AH-0MUWYQRAS0054VO5, AC4).
 *
 * @param {{ trackCount?: number, peak?: number, rms?: number, decodeError?: string }} [audio]
 * @returns {{ hasAudioTrack: boolean, nonSilent: boolean, reasons: string[] }}
 */
export function evaluateAudioTrack(audio) {
  const trackCount = Number(audio?.trackCount ?? 0);
  const peak = Number(audio?.peak ?? 0);
  const rms = Number(audio?.rms ?? 0);
  const decodeError =
    typeof audio?.decodeError === 'string' && audio.decodeError
      ? audio.decodeError
      : '';

  const hasAudioTrack = Number.isFinite(trackCount) && trackCount > 0;
  const abovePeakFloor =
    Number.isFinite(peak) && peak > AUDIO_SILENCE_PEAK_FLOOR;
  const aboveRmsFloor = Number.isFinite(rms) && rms > AUDIO_SILENCE_RMS_FLOOR;
  const nonSilent =
    hasAudioTrack && !decodeError && (abovePeakFloor || aboveRmsFloor);

  const reasons = [];
  if (!hasAudioTrack) {
    reasons.push('no audio track in the recording');
  } else if (decodeError) {
    reasons.push(
      `audio track could not be decoded (${decodeError}); its level is unverified`,
    );
  } else if (!nonSilent) {
    reasons.push('audio track is silent (peak and RMS at or below the floor)');
  }

  return { hasAudioTrack, nonSilent, reasons };
}

/**
 * Installs the page-side Web Audio tap used by the gameplay capture
 * (AH-0MUWYQQYU001G6OG, approach A1).
 *
 * The game owns a single shared `AudioContext` whose master SFX gain is
 * connected to `context.destination` (`src/audio/sfxPlayback.ts`). To capture
 * that output **without touching `src/` or the shipped bundle**, this
 * installer wraps `AudioNode.prototype.connect`: whenever a node is connected
 * to `context.destination`, the same source is *also* connected to a
 * `MediaStreamAudioDestinationNode` created on that same context. The capture
 * destination's audio track can then be muxed with the canvas video track.
 *
 * Only connections to `context.destination` are mirrored, so the tap cannot
 * feed back into itself and a node bridging several inputs is still tapped
 * once per context. The wrapper mirrors the original `connect` return value
 * and never throws — a tap failure must not break the game's own audio.
 *
 * The function is deliberately self-contained (it reads everything it needs
 * from `scope` and references no module bindings) so Playwright can serialise
 * it straight into `page.addInitScript`, and the very same shape lets the
 * unit tests drive it with a fake audio graph, with no browser required.
 *
 * @param {object} [scope] — global to install onto (defaults to `globalThis`).
 * @returns {{
 *   contexts: () => unknown[],
 *   captureDestinations: () => unknown[],
 *   getAudioTracks: () => unknown[],
 *   audioTrackCount: () => number,
 *   isContextRunning: () => boolean,
 * } | null} the installed tap, or `null` when there is no `AudioNode` to wrap.
 */
export function installGameAudioTap(scope = globalThis) {
  if (!scope || typeof scope !== 'object') return null;
  if (scope.__aiHellAudioTap) return scope.__aiHellAudioTap;

  const nodePrototype = scope.AudioNode && scope.AudioNode.prototype;
  if (!nodePrototype || typeof nodePrototype.connect !== 'function') return null;

  const originalConnect = nodePrototype.connect;
  const contexts = new Set();
  const captureByContext = new Map();

  const createCaptureDestination = (context) => {
    const existing = captureByContext.get(context);
    if (existing) return existing;

    let created = null;
    try {
      if (typeof context.createMediaStreamDestination === 'function') {
        created = context.createMediaStreamDestination();
      } else if (typeof scope.MediaStreamAudioDestinationNode === 'function') {
        created = new scope.MediaStreamAudioDestinationNode(context);
      }
    } catch {
      created = null;
    }

    if (created) captureByContext.set(context, created);
    return created;
  };

  nodePrototype.connect = function connect(destination, output, input) {
    if (this && this.context) contexts.add(this.context);

    const result = originalConnect.call(this, destination, output, input);

    try {
      const context = destination && destination.context;
      if (context && destination === context.destination) {
        contexts.add(context);
        const capture = createCaptureDestination(context);
        if (capture) originalConnect.call(this, capture, output, input);
      }
    } catch {
      // The tap is best-effort: it must never break the game's own audio.
    }

    return result;
  };

  const getAudioTracks = () => {
    const tracks = [];
    for (const capture of captureByContext.values()) {
      const stream = capture && capture.stream;
      if (stream && typeof stream.getAudioTracks === 'function') {
        tracks.push(...stream.getAudioTracks());
      }
    }
    return tracks;
  };

  const tap = {
    contexts: () => Array.from(contexts),
    captureDestinations: () => Array.from(captureByContext.values()),
    getAudioTracks,
    audioTrackCount: () => getAudioTracks().length,
    isContextRunning: () =>
      Array.from(contexts).some(
        (context) => context && context.state === 'running',
      ),
  };

  scope.__aiHellAudioTap = tap;
  return tap;
}

/**
 * Merges the existing video "non-trivial" verdict with the audio verdict so
 * a clip is accepted only when both halves pass.
 *
 * Reasons from both verdicts are concatenated so the human report and
 * `--json` payload explain every failing half; a missing verdict contributes
 * an explicit reason rather than silently passing.
 *
 * @param {{ nonTrivial?: boolean, reasons?: string[] }} [videoVerdict]
 * @param {{ hasAudioTrack?: boolean, nonSilent?: boolean, reasons?: string[] }} [audioVerdict]
 * @returns {{ nonTrivial: boolean, reasons: string[] }}
 */
export function combineClipVerdict(videoVerdict, audioVerdict) {
  const video = videoVerdict ?? {};
  const audio = audioVerdict ?? {};

  const reasons = [];
  if (Array.isArray(video.reasons)) reasons.push(...video.reasons);
  if (Array.isArray(audio.reasons)) reasons.push(...audio.reasons);
  if (!videoVerdict) reasons.push('missing video verdict');
  if (!audioVerdict) reasons.push('missing audio verdict');

  const nonTrivial =
    video.nonTrivial === true &&
    audio.hasAudioTrack === true &&
    audio.nonSilent === true;

  return { nonTrivial, reasons };
}
