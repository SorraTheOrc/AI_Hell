/**
 * Optional side-by-side video plan for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC4).
 *
 * The harness does **not** re-implement video capture: the existing
 * `scripts/capture-gameplay.mjs` tool records a real browser gameplay clip.
 * This module builds the exact commands that pair a recorded human clip with
 * the captured bot/demo clip and composite them side by side with `ffmpeg`
 * (`hstack`), so the operator gets a reproducible visual comparison without
 * new capture infrastructure. It is a pure planner — the commands are
 * returned (and written to a script by the CLI), never executed here.
 *
 * The always-on, dependency-free companion is the ghost-overlay SVG produced
 * by {@link ./engine.compareRecordings}, which needs no browser or encoder.
 *
 * @module src/ai/eval/video
 */

/** Defaults for the composited side-by-side clip. */
export const SIDE_BY_SIDE_DEFAULTS = Object.freeze({
  width: 960,
  height: 540,
  fps: 60,
});

/** Options for {@link buildSideBySideCapturePlan}. */
export interface SideBySidePlanOptions {
  /** Directory the artifacts are written to (relative or absolute). */
  readonly outputDir: string;
  /** Path to a recorded human clip (left). When omitted, a placeholder remains. */
  readonly humanVideo?: string;
  /** Override the bot capture output path (defaults under `outputDir`). */
  readonly botVideo?: string;
  /** Frame width of *each* panel. Defaults to 960. */
  readonly width?: number;
  /** Frame height of each panel. Defaults to 540. */
  readonly height?: number;
  /** Output frame rate. Defaults to 60. */
  readonly fps?: number;
}

/** A ready-to-run side-by-side capture/composite plan. */
export interface SideBySidePlan {
  /** Command that captures the bot/demo clip with the existing tooling. */
  readonly botCaptureCommand: string;
  /** The human clip path, or `null` when none was supplied. */
  readonly humanVideo: string | null;
  /** The captured bot clip path. */
  readonly botVideo: string;
  /** `ffmpeg` command that stacks the two clips horizontally. */
  readonly composeCommand: string;
  /** Operator notes / caveats (e.g. a missing human clip). */
  readonly notes: readonly string[];
}

/** Joins a directory and a file name without importing `node:path`. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Normalises a positive integer option, else `fallback`. */
function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.trunc(value as number)
    : fallback;
}

/**
 * Builds the side-by-side capture plan (AC4).
 *
 * The bot clip uses the existing `capture-gameplay.mjs` tool (the shipped
 * in-game demo), and the heuristic double-quotes shell paths so the emitted
 * command is copy-pasteable.
 */
export function buildSideBySideCapturePlan(
  options: SideBySidePlanOptions,
): SideBySidePlan {
  const width = positiveInt(options.width, SIDE_BY_SIDE_DEFAULTS.width);
  const height = positiveInt(options.height, SIDE_BY_SIDE_DEFAULTS.height);
  const fps = positiveInt(options.fps, SIDE_BY_SIDE_DEFAULTS.fps);
  const botVideo = options.botVideo ?? joinPath(options.outputDir, 'bot.webm');
  const humanVideo = options.humanVideo ?? null;
  const output = joinPath(options.outputDir, 'side-by-side.mp4');

  const botCaptureCommand =
    `node scripts/capture-gameplay.mjs --output "${botVideo}" --duration ${Math.round(
      (width / SIDE_BY_SIDE_DEFAULTS.width) * 15000,
    )}`;

  const composeCommand = humanVideo
    ? `ffmpeg -y -i "${botVideo}" -i "${humanVideo}" ` +
      `-filter_complex "[0:v]scale=${width}:${height}[a];[1:v]scale=${width}:${height}[b];` +
      `[a][b]hstack=inputs=2[v]" -map "[v]" -r ${fps} "${output}"`
    : `ffmpeg -y -i "${botVideo}" -i "<human.webm>" ` +
      `-filter_complex "[0:v]scale=${width}:${height}[a];[1:v]scale=${width}:${height}[b];` +
      `[a][b]hstack=inputs=2[v]" -map "[v]" -r ${fps} "${output}"`;

  const notes = [
    'Capture the human clip with the existing `npm run record` tool, then pass it via --human.',
    'Requires ffmpeg on PATH (video compositing is intentionally out of scope for the harness runtime).',
  ];
  if (!humanVideo) {
    notes.push('No human clip supplied: the compose command contains a <human.webm> placeholder.');
  }

  return { botCaptureCommand, humanVideo, botVideo, composeCommand, notes };
}
