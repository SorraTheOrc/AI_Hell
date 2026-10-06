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
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CAPTURE_DURATION_MS,
  DEFAULT_WARMUP_MS,
  buildScriptedPlan,
  isNonTrivialClip,
  planDurationMs,
} from './capture-bot.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWPORT = { width: 960, height: 540 };
const INTER_STEP_MS = 30;

/** Parses `process.argv`-style flags into an options object. */
export function parseCaptureArgs(argv = process.argv.slice(2)) {
  const options = {
    durationMs: DEFAULT_CAPTURE_DURATION_MS,
    warmupMs: DEFAULT_WARMUP_MS,
    output: null,
    port: 0,
    headed: false,
    keepServer: false,
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
 * Runs the whole capture. Exported so an integration harness (or a future
 * CLI wrapper) can drive it without spawning a process.
 */
export async function runCapture(options = parseCaptureArgs()) {
  const outputPath = resolveOutputPath(options.output);
  const plan = buildScriptedPlan(options.durationMs);

  let server;
  let browser;

  try {
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

    browser = await chromium.launch({
      headless: !options.headed,
      args: [
        '--no-sandbox',
        // Phaser.AUTO picks WebGL; headless Chromium needs this flag to use
        // the software (SwiftShader) WebGL backend.
        '--enable-unsafe-swiftshader',
      ],
    });

    const page = await browser.newPage({ viewport: VIEWPORT });

    // Stream encoded chunks to Node as they are produced (avoids one huge
    // base64 return value over the CDP bridge).
    const chunks = [];
    await page.exposeFunction('__aiHellCaptureChunk', (base64) => {
      chunks.push(Buffer.from(base64, 'base64'));
    });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

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
    await page.keyboard.press('Enter');
    await page.waitForTimeout(options.warmupMs);

    await startRecording(page);

    for (const step of plan) {
      await page.keyboard.down(step.key);
      await page.waitForTimeout(step.holdMs);
      await page.keyboard.up(step.key);
      await page.waitForTimeout(INTER_STEP_MS);
    }

    const probe = await stopRecordingAndProbe(page, planDurationMs(plan) + 500);

    const video = Buffer.concat(chunks);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, video);

    const verdict = isNonTrivialClip({ ...probe, bytes: video.length });
    return {
      output: outputPath,
      bytes: video.length,
      durationMs: planDurationMs(plan),
      renderer: probe.renderer,
      ...probe,
      ...verdict,
      pageErrors,
    };
  } finally {
    if (browser && !options.keepServer) await browser.close().catch(() => {});
    if (server && !options.keepServer) await server.close().catch(() => {});
  }
}

/** Installs the captureStream/MediaRecorder pipeline on the game canvas. */
async function startRecording(page) {
  await page.evaluate(() => {
    // eslint-disable-next-line no-undef -- injected by Playwright exposeFunction
    const captureChunk = window.__aiHellCaptureChunk;
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) throw new Error('game canvas not found');

    const mimeType = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('no supported WebM MediaRecorder codec');

    const stream = canvas.captureStream(60);
    const recorder = new MediaRecorder(stream, {
      mimeType,
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

    window.__aiHellCapture = { recorder, chunks, mimeType };
    recorder.start(1000);
  });
}

/**
 * Stops the recorder, then decodes the produced WebM back through a
 * `<video>` element and samples several frames for verifiable stats.
 */
async function stopRecordingAndProbe(page, fallbackDurationMs) {
  return page.evaluate(async (fallbackMs) => {
    const capture = window.__aiHellCapture;
    if (!capture) throw new Error('capture pipeline was never started');

    const { recorder, chunks, mimeType } = capture;
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', resolve, { once: true });
    });
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
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
    `Non-trivial:${result.nonTrivial ? ' yes' : ` no (${result.reasons.join('; ')})`}`,
  ].join('\n');
}

async function main() {
  const options = parseCaptureArgs();
  if (options.help) {
    console.log(
      'Usage: node scripts/capture-gameplay.mjs [--duration ms] [--warmup ms] [--output path] [--port n] [--headed] [--keep-server]',
    );
    return;
  }

  const result = await runCapture(options);
  console.log(formatReport(result));
  if (result.pageErrors.length > 0) {
    console.warn(`Page errors (${result.pageErrors.length}):`);
    for (const error of result.pageErrors) console.warn(`  - ${error}`);
  }
  console.log(JSON.stringify(result, null, 2));

  if (!result.nonTrivial) {
    console.error('Capture produced a trivial clip; see reasons above.');
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
