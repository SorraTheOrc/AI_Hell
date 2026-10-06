#!/usr/bin/env node
/**
 * Automated gameplay capture — spike (AH-0MUWMFF3C002WOBK).
 *
 * Boots AI_Hell in a **real rendering browser** (headless Chromium via
 * Playwright), plays a deterministic scripted segment with a real key
 * sequence, and writes a playable `.webm` locally — no manual screen
 * recording. See `docs/dev/gameplay-capture.md` for the recommended
 * approach, rejected alternatives and known limits.
 *
 * ## Pipeline (approach A: `captureStream` + `MediaRecorder`)
 *
 * 1. Start the Vite dev server programmatically (no browser is opened by
 *    the config's `server.open: true`).
 * 2. Launch headless Chromium with software WebGL enabled
 *    (`--enable-unsafe-swiftshader`); Phaser's `AUTO` renderer then gets a
 *    real WebGL context instead of silently degrading.
 * 3. Load the game, press **Enter** to activate the focused "Play Game"
 *    menu control, and wait `--warmup` ms for `PlayScene` to settle.
 * 4. Start `canvas.captureStream(60)` → `MediaRecorder` (VP9, falling back
 *    to VP8/WebM) inside the page.
 * 5. Replay the deterministic bot plan (`scripts/capture-bot.mjs`) as real
 *    Playwright keydown/keyup events.
 * 6. Stop the recorder, decode the produced WebM back through a `<video>`
 *    element and probe it (resolution, duration, non-black fraction,
 *    colour variety, frame-to-frame motion) so the clip's non-triviality
 *    is verifiable, not assumed.
 * 7. Stream the encoded chunks to Node via `exposeFunction` and write them
 *    to the output file.
 *
 * Output format is WebM/VP9. MP4 transcoding is intentionally **not** done
 * here: the SpikeBox Playwright build ships a minimal ffmpeg with no VP9
 * decoder — see the "Known limits" section of the doc.
 *
 * Usage:
 *
 *   npm run capture                       # defaults: 15 s, capture-output/gameplay-<ts>.webm
 *   npm run capture -- --duration 20000 --output clips/demo.webm --headed
 *
 * The tool is opt-in: it is only reachable through this script and does not
 * touch the shipped bundle or the vitest suite.
 */

import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_MIME_CANDIDATES,
  DEFAULT_CAPTURE_DURATION_MS,
  DEFAULT_WARMUP_MS,
  buildScriptedPlan,
  combineClipVerdict,
  evaluateAudioTrack,
  installGameAudioTap,
  isNonTrivialClip,
  planDurationMs,
  resolveCaptureMimeType,
} from './capture-bot.mjs';
import {
  formatAudioSummary,
  formatDuration,
  formatProgress,
  setupHint,
} from './capture-progress.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };
const INTER_STEP_MS = 30;

/** Progress heartbeat interval during recording, in milliseconds. */
const PROGRESS_INTERVAL_MS = 2_000;

/**
 * Bounded wait, in milliseconds, for the Enter gesture to resume the game's
 * shared `AudioContext` and for the page-side tap to see its master gain.
 * Audio stays optional: if the bound elapses the capture records video only
 * (AH-0MUWYQQYU001G6OG, AC4).
 */
const AUDIO_TAP_WAIT_MS = 3_000;

/**
 * Video-only `MediaRecorder` mime candidates, derived from the audio-capable
 * list by dropping the Opus pairing. Used when no game audio is available so
 * the recorder never advertises an audio codec it will not produce.
 */
const VIDEO_ONLY_MIME_CANDIDATES = Object.freeze(
  CAPTURE_MIME_CANDIDATES.map((type) => type.replace(',opus', '')),
);

/**
 * Raised when an opt-in capture dependency is missing, so `main()` can print
 * a short actionable message instead of a raw resolution/launch stack.
 */
export class CaptureSetupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CaptureSetupError';
  }
}

/**
 * Writes milestone lines and a single-line recording heartbeat to stderr,
 * keeping stdout reserved for the final report / `--json` payload.
 *
 * On a TTY the heartbeat overwrites itself in place; when redirected (logs,
 * CI) each heartbeat is appended on its own line.
 *
 * @param {NodeJS.WriteStream} [stream]
 */
export function createReporter(stream = process.stderr) {
  const interactive = Boolean(stream.isTTY);
  let progressOpen = false;

  const closeProgressLine = () => {
    if (progressOpen) {
      stream.write('\n');
      progressOpen = false;
    }
  };

  return {
    /** Milestone / status line (always newline-terminated). */
    step(message) {
      closeProgressLine();
      stream.write(`[capture] ${message}\n`);
    },
    /** Recording heartbeat: overwritten in place on a TTY, appended otherwise. */
    progress(message) {
      if (interactive) {
        stream.write(`\r${message}`);
        progressOpen = true;
      } else {
        stream.write(`${message}\n`);
      }
    },
    /** Ends any open heartbeat line so later output starts cleanly. */
    done() {
      closeProgressLine();
    },
  };
}

/**
 * Loads Playwright lazily so a missing devDependency yields an actionable
 * setup hint instead of a raw `ERR_MODULE_NOT_FOUND` stack
 * (AH-0MUWTNPY8003GGAA).
 */
async function loadChromium() {
  try {
    const playwright = await import('playwright');
    return playwright.chromium;
  } catch (error) {
    throw new CaptureSetupError(setupHint('playwright'), { cause: error });
  }
}

/** Converts a missing-Chromium launch failure into an actionable error. */
function asSetupError(error) {
  const text = String(error?.message ?? error);
  if (/executable doesn'?t exist|playwright install|browser.*not found/i.test(text)) {
    return new CaptureSetupError(
      `${setupHint('the Playwright Chromium browser')}\n\n${text}`,
      { cause: error },
    );
  }
  return error;
}

/** Parses `process.argv`-style flags into an options object. */
export function parseCaptureArgs(argv = process.argv.slice(2)) {
  const options = {
    durationMs: DEFAULT_CAPTURE_DURATION_MS,
    warmupMs: DEFAULT_WARMUP_MS,
    output: null,
    port: 0,
    headed: false,
    keepServer: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--duration':
        options.durationMs = Number(next());
        break;
      case '--warmup':
        options.warmupMs = Number(next());
        break;
      case '--output':
        options.output = next();
        break;
      case '--port':
        options.port = Number(next());
        break;
      case '--headed':
        options.headed = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--keep-server':
        options.keepServer = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/** Resolves the output path, defaulting to `capture-output/gameplay-<ts>.webm`. */
function resolveOutputPath(requested) {
  if (!requested) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return resolve(REPO_ROOT, 'capture-output', `gameplay-${stamp}.webm`);
  }
  return isAbsolute(requested) ? requested : resolve(process.cwd(), requested);
}

/**
 * Waits (bounded) for the game's shared `AudioContext` to be resumed by the
 * Enter gesture and for the page-side tap to have seen the master gain, then
 * returns how many audio tracks the tap currently exposes.
 *
 * Both waits are best-effort: when the bound elapses the capture continues
 * with a video-only stream rather than failing (AH-0MUWYQQYU001G6OG, AC4).
 *
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function waitForGameAudio(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  try {
    await page.waitForFunction(
      () => {
        const tap = window.__aiHellAudioTap;
        return (
          !!tap &&
          typeof tap.isContextRunning === 'function' &&
          tap.isContextRunning()
        );
      },
      { timeout: remaining() },
    );
  } catch {
    /* Autoplay-blocked or no audio device: fall through to video-only. */
  }

  try {
    await page.waitForFunction(
      () => {
        const tap = window.__aiHellAudioTap;
        return (
          !!tap &&
          typeof tap.audioTrackCount === 'function' &&
          tap.audioTrackCount() > 0
        );
      },
      { timeout: remaining() },
    );
  } catch {
    /* No tapped audio: fall through to video-only. */
  }

  return page.evaluate(() => {
    const tap = window.__aiHellAudioTap;
    return tap && typeof tap.audioTrackCount === 'function'
      ? tap.audioTrackCount()
      : 0;
  });
}

/**
 * Reports which mime candidates the page supports, then resolves the capture
 * mime through the pure `resolveCaptureMimeType` preference order: VP9+Opus,
 * then VP8+Opus, then a plain WebM container. When no game audio is available
 * the video-only candidate list is used instead so the recorded container
 * never claims an Opus track it will not contain (AH-0MUWYQQYU001G6OG, AC3).
 *
 * @param {import('playwright').Page} page
 * @param {boolean} hasAudio
 * @returns {Promise<string | null>}
 */
async function resolvePageCaptureMimeType(page, hasAudio) {
  const candidates = hasAudio
    ? CAPTURE_MIME_CANDIDATES
    : VIDEO_ONLY_MIME_CANDIDATES;
  const supported = await page.evaluate(
    (types) =>
      types.filter((type) => {
        try {
          return MediaRecorder.isTypeSupported(type);
        } catch {
          return false;
        }
      }),
    [...candidates],
  );
  return resolveCaptureMimeType((type) => supported.includes(type));
}

/**
 * Runs the whole capture. Exported so an integration harness (or a future
 * CLI wrapper) can drive it without spawning a process.
 */
export async function runCapture(
  options = parseCaptureArgs(),
  reporter = createReporter(),
) {
  const outputPath = resolveOutputPath(options.output);
  const plan = buildScriptedPlan(options.durationMs);

  let server;
  let browser;

  try {
    reporter.step('Starting Vite dev server…');
    server = await createServer({
      root: REPO_ROOT,
      logLevel: 'warn',
      server: { port: options.port, strictPort: false, open: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    const port =
      address && typeof address === 'object' ? address.port : options.port;
    const url = `http://127.0.0.1:${port}/`;

    reporter.step('Launching headless Chromium…');
    const chromium = await loadChromium();
    try {
      browser = await chromium.launch({
        headless: !options.headed,
        args: [
          '--no-sandbox',
          // Phaser.AUTO picks WebGL; headless Chromium needs this flag to use
          // the software (SwiftShader) WebGL backend.
          '--enable-unsafe-swiftshader',
        ],
      });
    } catch (error) {
      throw asSetupError(error);
    }

    const page = await browser.newPage({ viewport: VIEWPORT });

    // Install the page-side Web Audio tap *before* any game script runs, so
    // the wrapper is in place when the game first connects its master gain to
    // the shared context.destination (AH-0MUWYQQYU001G6OG).
    await page.addInitScript(installGameAudioTap);

    // Stream encoded chunks to Node as they are produced (avoids one huge
    // base64 return value over the CDP bridge).
    const chunks = [];
    await page.exposeFunction('__aiHellCaptureChunk', (base64) => {
      chunks.push(Buffer.from(base64, 'base64'));
    });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    reporter.step(`Loading ${url}…`);
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForSelector('#game-container canvas', { timeout: 20_000 });
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector('#game-container canvas');
        return !!canvas && canvas.width === 960 && canvas.height === 540;
      },
      { timeout: 20_000 },
    );

    // Enter activates the focused "Play Game" control in MenuScene.
    reporter.step('Starting PlayScene (Enter)…');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(options.warmupMs);

    // The Enter gesture resumes the shared context; wait (bounded) for the
    // tap to see it and expose an audio track, then record audio if present.
    const audioTrackCount = await waitForGameAudio(page, AUDIO_TAP_WAIT_MS);
    const hasAudio = audioTrackCount > 0;
    reporter.step(
      hasAudio
        ? `Game audio tap ready (${audioTrackCount} track(s)).`
        : 'No game audio detected; recording video only.',
    );
    const mimeType = await resolvePageCaptureMimeType(page, hasAudio);
    if (!mimeType) throw new Error('no supported WebM MediaRecorder codec');

    reporter.step(
      `Recording ${formatDuration(planDurationMs(plan))} of scripted gameplay…`,
    );
    await startRecording(page, mimeType);

    // The recording spans the plan plus one inter-step gap after each step.
    const recordingMs = planDurationMs(plan) + plan.length * INTER_STEP_MS;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    let lastReportedMs = -1;
    for (const step of plan) {
      await page.keyboard.down(step.key);
      await page.waitForTimeout(step.holdMs);
      await page.keyboard.up(step.key);
      await page.waitForTimeout(INTER_STEP_MS);
      const elapsed = Date.now() - startedAt;
      if (elapsed - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = elapsed;
        lastReportedMs = elapsed;
        reporter.progress(formatProgress(elapsed, recordingMs));
      }
    }
    // Guarantee a final 100% heartbeat when the loop did not already reach it.
    if (lastReportedMs < recordingMs) {
      reporter.progress(formatProgress(recordingMs, recordingMs));
    }

    reporter.step('Encoding and probing the clip…');
    const probe = await stopRecordingAndProbe(page, planDurationMs(plan) + 500);

    const video = Buffer.concat(chunks);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, video);

    const videoVerdict = isNonTrivialClip({ ...probe, bytes: video.length });
    const audioVerdict = evaluateAudioTrack({
      trackCount: probe.audioTrackCount,
      peak: probe.audioPeak,
      rms: probe.audioRms,
      decodeError: probe.audioDecodeError,
    });
    const verdict = combineClipVerdict(videoVerdict, audioVerdict);
    return {
      output: outputPath,
      bytes: video.length,
      durationMs: planDurationMs(plan),
      renderer: probe.renderer,
      ...probe,
      audioVerdict,
      ...verdict,
      pageErrors,
    };
  } finally {
    reporter.done();
    if (browser && !options.keepServer) await browser.close().catch(() => {});
    if (server && !options.keepServer) await server.close().catch(() => {});
  }
}

/**
 * Installs the captureStream/MediaRecorder pipeline on the game canvas.
 *
 * The recorder stream muxes the canvas video tracks with any audio tracks the
 * page-side tap exposed on the game's shared context, and the caller supplies
 * a mime already resolved by `resolveCaptureMimeType`. When the tap found no
 * audio the stream is video-only and the caller picks a video-only mime, so
 * the pipeline never throws on the no-audio path (AH-0MUWYQQYU001G6OG).
 *
 * @param {import('playwright').Page} page
 * @param {string} mimeType
 */
async function startRecording(page, mimeType) {
  await page.evaluate((resolvedMimeType) => {
    // eslint-disable-next-line no-undef -- injected by Playwright exposeFunction
    const captureChunk = window.__aiHellCaptureChunk;
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) throw new Error('game canvas not found');

    const tap = window.__aiHellAudioTap;
    const audioTracks =
      tap && typeof tap.getAudioTracks === 'function'
        ? tap.getAudioTracks()
        : [];

    const canvasStream = canvas.captureStream(60);
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioTracks,
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: resolvedMimeType,
      videoBitsPerSecond: 8_000_000,
    });

    const chunks = [];
    recorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;
      chunks.push(event.data);
      const bytes = new Uint8Array(await event.data.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + 0x8000),
        );
      }
      await captureChunk(btoa(binary));
    };

    window.__aiHellCapture = {
      recorder,
      chunks,
      mimeType: resolvedMimeType,
      audioTrackCount: audioTracks.length,
    };
    recorder.start(1000);
  }, mimeType);
}

/**
 * Stops the recorder, then decodes the produced WebM back through a
 * `<video>` element and samples several frames for verifiable stats.
 */
async function stopRecordingAndProbe(page, fallbackDurationMs) {
  return page.evaluate(async (fallbackMs) => {
    const capture = window.__aiHellCapture;
    if (!capture) throw new Error('capture pipeline was never started');

    const { recorder, chunks, mimeType, audioTrackCount } = capture;
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);

    // Decode the recorded blob's Opus track and measure its peak/RMS so the
    // clip's audio is verifiable without auditioning it
    // (AH-0MUWYQRAS0054VO5, AC1/AC2). The recording destination renders
    // without any system audio device, but decoding can still fail (an
    // unsupported codec, a truncated recording); that fallback is reported
    // explicitly rather than silently passing (AC4).
    let audioPeak = 0;
    let audioRms = 0;
    let audioDecodeError = '';
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (audioTrackCount > 0 && !AudioContextCtor) {
      audioDecodeError = 'AudioContext is unavailable for decoding';
    } else if (audioTrackCount > 0) {
      const sharedTap = window.__aiHellAudioTap;
      const sharedContexts =
        sharedTap && typeof sharedTap.contexts === 'function'
          ? sharedTap.contexts()
          : [];
      let decodeContext = sharedContexts[0] || null;
      const ownsDecodeContext = !decodeContext;
      try {
        if (!decodeContext) decodeContext = new AudioContextCtor();
        const decoded = await decodeContext.decodeAudioData(
          await blob.arrayBuffer(),
        );
        let sumSquares = 0;
        let sampleCount = 0;
        for (
          let channel = 0;
          channel < decoded.numberOfChannels;
          channel += 1
        ) {
          const samples = decoded.getChannelData(channel);
          for (let i = 0; i < samples.length; i += 1) {
            const magnitude = Math.abs(samples[i]);
            if (magnitude > audioPeak) audioPeak = magnitude;
            sumSquares += samples[i] * samples[i];
            sampleCount += 1;
          }
        }
        audioRms =
          sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
      } catch (error) {
        audioDecodeError =
          error && error.message ? error.message : String(error);
      } finally {
        if (
          ownsDecodeContext &&
          decodeContext &&
          typeof decodeContext.close === 'function'
        ) {
          try {
            await decodeContext.close();
          } catch {
            /* noop: closing a scratch decode context must not fail the capture */
          }
        }
      }
    }
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out loading recorded video')),
        15_000,
      );
      video.addEventListener(
        'loadeddata',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('recorded video failed to load'));
        },
        { once: true },
      );
    });

    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;

    // MediaRecorder WebM has no duration metadata until the browser seeks
    // to the end and computes it from the last frame.
    if (!Number.isFinite(video.duration)) {
      await new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('durationchange', () => {
          if (Number.isFinite(video.duration)) done();
        });
        try {
          video.currentTime = 1e101;
        } catch {
          done();
        }
        setTimeout(done, 3_000);
      });
    }
    const durationSeconds = Number.isFinite(video.duration)
      ? video.duration
      : fallbackMs / 1000;

    const full = document.createElement('canvas');
    full.width = width || 960;
    full.height = height || 540;
    const fullCtx = full.getContext('2d', { willReadFrequently: true });

    const thumb = document.createElement('canvas');
    thumb.width = 48;
    thumb.height = 27;
    const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

    const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
    let nonBlackTotal = 0;
    const colours = new Set();
    const lumaFrames = [];

    for (const fraction of fractions) {
      const seeked = new Promise((resolve) => {
        const done = () => resolve();
        video.addEventListener('seeked', done, { once: true });
        setTimeout(done, 2_000);
      });
      try {
        video.currentTime = Math.max(0, durationSeconds * fraction);
      } catch {
        /* ignore seek failures and sample the current frame */
      }
      await seeked;

      fullCtx.drawImage(video, 0, 0, full.width, full.height);
      const pixels = fullCtx.getImageData(0, 0, full.width, full.height).data;
      let nonBlack = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma > 16) nonBlack += 1;
        colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      }
      nonBlackTotal += nonBlack / (full.width * full.height);

      thumbCtx.drawImage(video, 0, 0, thumb.width, thumb.height);
      const thumbPixels = thumbCtx.getImageData(
        0,
        0,
        thumb.width,
        thumb.height,
      ).data;
      const frame = [];
      for (let i = 0; i < thumbPixels.length; i += 4) {
        frame.push(
          (0.2126 * thumbPixels[i] +
            0.7152 * thumbPixels[i + 1] +
            0.0722 * thumbPixels[i + 2]) /
            255,
        );
      }
      lumaFrames.push(frame);
    }

    let motion = 0;
    if (lumaFrames.length > 1) {
      let difference = 0;
      for (let f = 1; f < lumaFrames.length; f += 1) {
        const previous = lumaFrames[f - 1];
        const current = lumaFrames[f];
        let sum = 0;
        for (let p = 0; p < current.length; p += 1) {
          sum += Math.abs(current[p] - previous[p]);
        }
        difference += sum / current.length;
      }
      motion = difference / (lumaFrames.length - 1);
    }

    URL.revokeObjectURL(url);
    delete window.__aiHellCapture;

    return {
      width,
      height,
      durationSeconds,
      nonBlackFraction: nonBlackTotal / fractions.length,
      uniqueColours: colours.size,
      motion,
      bytes: blob.size,
      mimeType,
      audioTrackCount,
      audioPeak,
      audioRms,
      audioDecodeError,
      renderer: (() => {
        const canvas = document.querySelector('#game-container canvas');
        const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
        return gl ? gl.getParameter(gl.RENDERER) : 'unknown';
      })(),
    };
  }, fallbackDurationMs);
}

function formatReport(result) {
  return [
    'AI_Hell automated gameplay capture',
    '=================================',
    `Output:     ${result.output}`,
    `Size:       ${(result.bytes / 1024).toFixed(1)} KiB`,
    `Resolution: ${result.width}x${result.height} @ ${Math.round(result.durationSeconds * 1000)} ms`,
    `Renderer:   ${result.renderer}`,
    `Non-black:  ${(result.nonBlackFraction * 100).toFixed(2)}% of pixels`,
    `Colours:    ${result.uniqueColours} distinct (16-level buckets)`,
    `Motion:     ${result.motion.toFixed(4)} mean frame delta`,
    `Audio:      ${formatAudioSummary(result)}`,
    `Non-trivial:${result.nonTrivial ? ' yes' : ` no (${result.reasons.join('; ')})`}`,
  ].join('\n');
}

async function main() {
  const options = parseCaptureArgs();
  if (options.help) {
    console.log(
      'Usage: node scripts/capture-gameplay.mjs [--duration ms] [--warmup ms] [--output path] [--port n] [--headed] [--json] [--keep-server]',
    );
    return;
  }

  const result = await runCapture(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatReport(result));
    if (result.pageErrors.length > 0) {
      console.warn(`Page errors (${result.pageErrors.length}):`);
      for (const error of result.pageErrors) console.warn(`  - ${error}`);
    }
    console.log(JSON.stringify(result, null, 2));
  }

  if (!result.nonTrivial) {
    console.error('Capture produced a trivial clip; see reasons above.');
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (error instanceof CaptureSetupError) {
      console.error(`\n${error.message}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
