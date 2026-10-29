/**
 * Probe source selection + streamed probe for long gameplay clips
 * (AH-0MVNT28SJ008ZHDB, parent AH-0MVN06MS9007LRKE, parent AC3/AC6).
 *
 * `stopRecordingAndProbe` used to build `new Blob(chunks)` from the page's
 * retained prefix and hand the whole lot to `decodeAudioData` plus a
 * `<video>` object URL: for a 30-minute clip that is materialising the
 * recording in the renderer again. This module replaces that for large clips
 * with a **streamed probe**: the capture's Vite dev server already serves the
 * repository root (and `capture-output/` lives under it), so the `<video>`
 * can stream the written output file over HTTP with range requests and the
 * audio peak/RMS can be measured from a bounded prefix of the file.
 *
 * The probe **contract is unchanged** for every clip (parent AC3):
 * `durationSeconds`, `videoWidth`/`videoHeight`, `nonBlackFraction`, colour
 * variety, `motion`, `audioPeak`, `audioRms`, `audioDecodeError`,
 * `audioTrackCount` and the `sampleProbes` used by the multi-scene fade
 * verification (parent AC6). The streamed path adds two **additive** fields
 * reporting the audio measurement honestly (parent AC4): `audioProbeBytes`
 * (bytes of the file the peak/RMS were measured from) and `audioProbeCapped`
 * (true when the measurement came from a bounded prefix rather than the whole
 * recording). A capped or failed decode is reported explicitly — via
 * `audioDecodeError` and/or those fields — never silently passed.
 *
 * Source selection is a pure decision (`chooseProbeSource`) so it is
 * hermetically testable and both capture paths share one policy: at or below
 * the documented in-page threshold the clip fits entirely in the retained
 * page prefix and keeps the **byte-identical in-page Blob path**; above it,
 * the probe reads the streamed file over the capture dev server's HTTP URL.
 * The threshold and the audio-prefix cap both default to
 * `CAPTURE_PROBE_PREFIX_BUDGET_BYTES` (the same budget the page retention is
 * bounded by), so a clip the retention can fully hold is never streamed and a
 * clip it cannot is never silently measured from a truncated in-page prefix.
 *
 * `probeRecordingInPage` is **self-contained** exactly like
 * `installRecorderChunkRetention` (`scripts/capture-recorder-page.mjs`):
 * Playwright serialises it into the page, so it reads its environment from
 * the `scope` argument (defaults to `globalThis`) and cannot reference any
 * module binding at runtime. The hermetic unit tests drive it with a fake
 * scope/document — no browser, no Vite server (parent AC6).
 *
 * This module is plain ESM JavaScript with node built-ins only (plus the
 * shared capture constants) so the capture tool runs without a TypeScript
 * loader; `capture-probe.d.mts` supplies the types.
 */

import { formatByteSize } from './capture-diagnostics.mjs';
import { CAPTURE_PROBE_PREFIX_BUDGET_BYTES } from './capture-run-lifecycle.mjs';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Documented in-page probe threshold, in bytes. A clip at or below this size
 * is fully retained by the page-side controller (AH-0MVNT274M009XRJ1) and is
 * probed in-page for byte-identical behaviour; a larger clip is probed from
 * the streamed output file over the capture dev server's HTTP URL.
 *
 * Pinned to `CAPTURE_PROBE_PREFIX_BUDGET_BYTES` so the threshold always
 * matches what the page retention can actually hold.
 */
export const CAPTURE_PROBE_STREAM_THRESHOLD_BYTES = CAPTURE_PROBE_PREFIX_BUDGET_BYTES;

/**
 * Documented audio measurement cap, in bytes: the streamed probe measures
 * `audioPeak`/`audioRms` from a bounded **prefix** of the file (never the
 * whole long recording), and reports the bounds via the additive
 * `audioProbeBytes`/`audioProbeCapped` fields. Defaults to the shared
 * `CAPTURE_PROBE_PREFIX_BUDGET_BYTES` (the same prefix the page retention
 * keeps), so short-streamed audio is only ever re-read up to what the
 * in-page path could already decode.
 */
export const CAPTURE_PROBE_AUDIO_PREFIX_BYTES = CAPTURE_PROBE_PREFIX_BUDGET_BYTES;

/** Coerces a byte count to a finite non-negative integer (0 when invalid). */
const toFiniteBytes = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
};

/**
 * Chooses the probe source for a clip of `bytes` recorded bytes.
 *
 * Pure and deterministic so both capture paths share one policy and the
 * hermetically tested decision exactly matches production (parent AC6):
 * a clip **above** the in-page threshold probes the streamed file over HTTP
 * (the page could only hold a truncated prefix of it); a clip **at or below**
 * the threshold keeps the existing in-page Blob probe, byte-identical.
 *
 * @param {{ bytes?: number, threshold?: number }} [options]
 * @returns {{
 *   source: 'in-page' | 'stream',
 *   bytes: number,
 *   threshold: number,
 *   reason: string,
 * }}
 */
export function chooseProbeSource(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const bytes = toFiniteBytes(opts.bytes);
  const requested = Number(opts.threshold);
  const threshold =
    Number.isFinite(requested) && requested > 0
      ? Math.trunc(requested)
      : CAPTURE_PROBE_STREAM_THRESHOLD_BYTES;

  if (bytes > threshold) {
    return {
      source: 'stream',
      bytes,
      threshold,
      reason:
        `clip is ${bytes} B (${formatByteSize(bytes)}), above the in-page `
        + `probe threshold of ${threshold} B (${formatByteSize(threshold)}) — `
        + 'probing the streamed output file over the capture server HTTP URL',
    };
  }
  return {
    source: 'in-page',
    bytes,
    threshold,
    reason:
      `clip is ${bytes} B (${formatByteSize(bytes)}), at or below the in-page `
      + `probe threshold of ${threshold} B (${formatByteSize(threshold)}) — ` +
      'probing the retained page prefix (byte-identical in-page Blob path)',
  };
}

/**
 * Resolves the bounded audio prefix the streamed probe measures peak/RMS from
 * (parent AC4). Always starts at byte 0 so the WebM header and first segment
 * are decoded; when the file exceeds `capBytes` the prefix is capped and the
 * result reports it (`capped: true`) so the caller can surface the bound.
 *
 * @param {{ bytes?: number, capBytes?: number }} [options]
 * @returns {{
 *   start: number,
 *   end: number | null,
 *   length: number,
 *   capped: boolean,
 *   capBytes: number,
 *   header: string | null,
 * }}
 */
export function resolveAudioProbeRange(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const bytes = toFiniteBytes(opts.bytes);
  const requested = Number(opts.capBytes);
  const capBytes =
    Number.isFinite(requested) && requested > 0
      ? Math.trunc(requested)
      : CAPTURE_PROBE_AUDIO_PREFIX_BYTES;
  const length = Math.min(bytes, capBytes);
  return {
    start: 0,
    end: length > 0 ? length - 1 : null,
    length,
    capped: bytes > capBytes,
    capBytes,
    header: length > 0 ? `bytes=0-${length - 1}` : null,
  };
}

/**
 * Builds the HTTP URL for a clip file served by the capture's Vite dev
 * server. The server serves the repository root, so any file whose path
 * resolves inside `repoRoot` can be range-streamed into a `<video>` element
 * (sirv answers byte-range requests). Returns `{ ok: false, reason }` when
 * the file is not servable (not under the root, or no valid http(s) base
 * URL) so the caller can fall back to the in-page path instead of
 * guessing the URL.
 *
 * @param {{
 *   baseUrl?: string,
 *   repoRoot?: string,
 *   filePath?: string,
 *   cacheBust?: number | string,
 * }} [options]
 * @returns {{
 *   ok: true,
 *   url: string,
 *   relativePath: string,
 *   reason: string,
 * } | {
 *   ok: false,
 *   url: null,
 *   relativePath: string,
 *   reason: string,
 * }}
 */
export function buildProbeFileUrl(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl.trim() : '';
  const repoRoot = typeof opts.repoRoot === 'string' ? opts.repoRoot : '';
  const filePath = typeof opts.filePath === 'string' ? opts.filePath : '';

  const fail = (reason) => ({
    ok: false,
    url: null,
    relativePath: '',
    reason,
  });
  if (!baseUrl) return fail('no capture dev server base URL is available');
  if (!filePath) return fail('no clip file path was supplied');
  if (!repoRoot) return fail('no repository root was supplied');

  let origin;
  try {
    origin = new URL(baseUrl);
  } catch {
    return fail(`the capture dev server base URL "${baseUrl}" is not a valid URL`);
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    return fail(
      `the capture dev server base URL "${baseUrl}" is not http(s)`,
    );
  }

  const resolvedFile = resolve(filePath);
  const resolvedRoot = resolve(repoRoot);
  const rawRelative = relative(resolvedRoot, resolvedFile);
  if (
    !rawRelative ||
    rawRelative.startsWith('..') ||
    isAbsolute(rawRelative)
  ) {
    return fail(
      `the clip path ${filePath} is outside the served repository root ${repoRoot}`,
    );
  }

  const relativePath = rawRelative.split(/[\\/]/).join('/');
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = new URL(encoded, origin);
  const cacheBust = opts.cacheBust;
  if (cacheBust !== undefined && cacheBust !== null) {
    url.searchParams.set('v', String(cacheBust));
  }
  return {
    ok: true,
    url: url.href,
    relativePath,
    reason: `serving ${relativePath} over the capture dev server`,
  };
}

/**
 * The page-side probe routine (self-contained — see the module doc). Reads
 * the capture state left by `startRecording` (`window.__aiHellCapture`) and
 * its environment from `scope`:
 *
 * - `source: 'in-page'` — builds `new Blob(retainedChunks())` exactly like
 *   the legacy probe: object URL for the `<video>`, whole-Blob
 *   `decodeAudioData`, `probe.bytes === blob.size`. Byte-identical values.
 * - `source: 'stream'` — points the `<video>` at `options.videoUrl` (the
 *   clip served over the capture dev server, built by `buildProbeFileUrl`,
 *   range-streamed by the browser) and measures audio from a bounded prefix
 *   (`options.audioRange.header`), reporting `audioProbeCapped`/
 *   `audioProbeBytes`; `probe.bytes` is `options.sourceBytes` (the on-disk
 *   size, which the caller reports from the chunk sink).
 *
 * The frame sampling, duration trick and `sampleProbes` collection are the
 * **same code** for both paths, so verdicts cannot diverge (parent AC3/AC6).
 *
 * @param {object} [options]
 * @param {string} [options.source] — `'stream'` or `'in-page'`.
 * @param {string} [options.videoUrl] — served URL of the streamed file.
 * @param {number} [options.sourceBytes] — on-disk bytes (streamed path).
 * @param {object|null} [options.audioRange] — resolved by
 *   `resolveAudioProbeRange`; its `header` drives the ranged audio fetch.
 * @param {number} [options.fallbackMs] — fallback duration when the debug
 *   seek-to-end trick cannot compute one.
 * @param {number[]|null} [options.sampleTimes] — explicit video offsets (ms)
 *   to probe, returned as `sampleProbes` for the multi-scene fade check.
 * @param {object} [scope] — the page global (defaults to `globalThis`).
 * @returns {Promise<{ probe: object }>}
 */
export async function probeRecordingInPage(options = {}, scope = globalThis) {
  const opts = options && typeof options === 'object' ? options : {};
  const page = scope && typeof scope === 'object' ? scope : globalThis;
  const doc = page.document;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('probeRecordingInPage requires a document');
  }
  const capture = page.__aiHellCapture;
  if (!capture) throw new Error('capture pipeline was never started');

  const mode = opts.source === 'stream' ? 'stream' : 'in-page';
  const mimeType =
    typeof capture.mimeType === 'string' ? capture.mimeType : 'video/webm';
  const audioTrackCount = Math.max(0, Number(capture.audioTrackCount) || 0);
  const fallbackMs = Number(opts.fallbackMs);
  const sampleTimes = Array.isArray(opts.sampleTimes) ? opts.sampleTimes : null;
  const audioRange =
    opts.audioRange && typeof opts.audioRange === 'object'
      ? opts.audioRange
      : null;
  const retention = capture.retention;

  // ---- resolve the video/audio source --------------------------------
  let objectUrl = '';
  let videoUrl = '';
  let inPageBlob = null;
  let sourceBytes = Math.max(0, Number(opts.sourceBytes) || 0);
  if (mode === 'stream') {
    videoUrl = typeof opts.videoUrl === 'string' ? opts.videoUrl : '';
    if (!videoUrl) {
      throw new Error(
        'the streamed probe requires a probeUrl built from the capture dev server URL',
      );
    }
  } else {
    const retained =
      retention && typeof retention.retainedChunks === 'function'
        ? retention.retainedChunks()
        : Array.isArray(capture.chunks)
          ? capture.chunks
          : [];
    inPageBlob = new page.Blob(Array.isArray(retained) ? retained : [], {
      type: mimeType,
    });
    sourceBytes = inPageBlob.size;
    objectUrl = page.URL.createObjectURL(inPageBlob);
    videoUrl = objectUrl;
  }

  // ---- audio: whole Blob (in-page) or bounded HTTP prefix (streamed) ----
  let audioPeak = 0;
  let audioRms = 0;
  let audioDecodeError = '';
  let audioProbeBytes = 0;
  let audioProbeCapped = false;
  const AudioContextCtor = page.AudioContext || page.webkitAudioContext;
  if (audioTrackCount > 0 && !AudioContextCtor) {
    audioDecodeError = 'AudioContext is unavailable for decoding';
  } else if (audioTrackCount > 0) {
    // Report the bounds of the measurement openly (parent AC4): the byte
    // count and whether the decode was capped to the prefix.
    if (mode === 'stream') {
      audioProbeBytes = Math.max(0, Number(audioRange && audioRange.length) || 0);
      audioProbeCapped = audioRange && audioRange.capped === true;
    } else {
      audioProbeBytes = inPageBlob ? inPageBlob.size : 0;
    }

    // The audio source promise: the whole retained Blob when the clip fits
    // in-page, or a ranged fetch of the first `audioRange.length` bytes.
    let audioBufferPromise = null;
    if (mode === 'stream') {
      const header =
        audioRange && typeof audioRange.header === 'string'
          ? audioRange.header
          : '';
      audioBufferPromise = Promise.resolve()
        .then(() =>
          page.fetch(
            videoUrl,
            header ? { headers: { Range: header } } : undefined,
          ),
        )
        .then((response) => {
          // A non-2xx/206 response means the probe cannot measure audio from
          // the prefix; surface it as a decode failure rather than passing.
          if (!response || (typeof response.ok === 'boolean' && !response.ok)) {
            throw new Error(
              `audio prefix request failed (${response && response.status ? response.status : 'no status'})`,
            );
          }
          return response.arrayBuffer();
        });
    } else {
      if (!inPageBlob || typeof inPageBlob.arrayBuffer !== 'function') {
        audioDecodeError = 'retained recording Blob is unavailable for decoding';
      } else {
        audioBufferPromise = inPageBlob.arrayBuffer();
      }
    }

    if (audioBufferPromise) {
      // Decode the (possibly bounded) Opus track and measure its peak/RMS so
      // the clip's audio is verifiable without auditioning it
      // (AH-0MUWYQRAS0054VO5, AC1/AC2). The recording destination renders
      // without any system audio device, but decoding can still fail (an
      // unsupported codec, a truncated file, a failed ranged read); that
      // fallback is reported explicitly rather than silently passing (AC4).
      const sharedTap = page.__aiHellAudioTap;
      const sharedContexts =
        sharedTap && typeof sharedTap.contexts === 'function'
          ? sharedTap.contexts()
          : [];
      let decodeContext = sharedContexts[0] || null;
      const ownsDecodeContext = !decodeContext;
      try {
        if (!decodeContext) decodeContext = new AudioContextCtor();
        const decoded = await decodeContext.decodeAudioData(
          await audioBufferPromise,
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
  }

  // ---- the video element and frame sampling (shared by both paths) ----
  const video = doc.createElement('video');
  video.src = videoUrl;
  video.muted = true;
  video.playsInline = true;

  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out loading recorded video')),
      15_000,
    );
    video.addEventListener(
      'loadeddata',
      () => {
        clearTimeout(timeout);
        resolvePromise();
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
  // to the end and computes it from the last frame (over HTTP the browser
  // range-requests the file's tail for this).
  if (!Number.isFinite(video.duration)) {
    await new Promise((resolvePromise) => {
      const done = () => resolvePromise();
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

  // Effective frame rate (AH-0MVTI3O650064IM7): a CPU-starved page renders far
  // below the display rate, and Phaser caps its delta, so game time crawls and
  // scripted pay-offs cannot happen inside their windows. Counting decoded
  // frames over the clip's duration makes that starvation visible in the
  // payload (and lets the verdict reject such a take) instead of shipping a
  // stalled recording that passes every other probe.
  const readDecodedFrames = () => {
    try {
      if (typeof video.getVideoPlaybackQuality === 'function') {
        const quality = video.getVideoPlaybackQuality();
        const total = Number(quality?.totalVideoFrames);
        if (Number.isFinite(total) && total > 0) return total;
      }
      const legacy = Number(video.webkitDecodedFrameCount);
      if (Number.isFinite(legacy) && legacy > 0) return legacy;
    } catch {
      /* an unreadable quality metric only means "fps unknown" */
    }
    return 0;
  };
  let frameCount = readDecodedFrames();

  const full = doc.createElement('canvas');
  full.width = width || 960;
  full.height = height || 540;
  const fullCtx = full.getContext('2d', { willReadFrequently: true });

  const thumb = doc.createElement('canvas');
  thumb.width = 48;
  thumb.height = 27;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

  const fractions = [0.1, 0.3, 0.5, 0.7, 0.9];
  let nonBlackTotal = 0;
  const colours = new Set();
  const lumaFrames = [];

  for (const fraction of fractions) {
    const seeked = new Promise((resolvePromise) => {
      const done = () => resolvePromise();
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

  // Explicit time-offset probes (AH-0MVFC70GT000B96J, AC3): seek to each
  // requested video offset and measure its darkness so the driver can
  // verify the page-side fades landed in the recording. Runs unchanged on
  // the streamed source (parent AC5).
  const sampleProbes = [];
  if (Array.isArray(sampleTimes) && sampleTimes.length > 0) {
    for (const timeMs of sampleTimes) {
      const timeSeconds = timeMs / 1000;
      if (timeSeconds <= 0 || timeSeconds >= durationSeconds - 0.03) continue;
      const seeked = new Promise((resolvePromise) => {
        const done = () => resolvePromise();
        video.addEventListener('seeked', done, { once: true });
        setTimeout(done, 2_000);
      });
      try {
        video.currentTime = timeSeconds;
      } catch {
        /* ignore seek failures and sample the current frame */
      }
      await seeked;

      fullCtx.drawImage(video, 0, 0, full.width, full.height);
      const pixels = fullCtx.getImageData(
        0,
        0,
        full.width,
        full.height,
      ).data;
      let nonBlack = 0;
      let lumaSum = 0;
      const pixelCount = full.width * full.height;
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma > 16) nonBlack += 1;
        lumaSum += luma;
      }
      sampleProbes.push({
        timeMs,
        nonBlackFraction: nonBlack / pixelCount,
        meanLuma: lumaSum / pixelCount / 255,
      });
    }
  }

  // Re-read after the end seek: the frame counter is monotonic and the last
  // read is the most complete one.
  frameCount = Math.max(frameCount, readDecodedFrames());
  const effectiveFps =
    frameCount > 0 && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? frameCount / durationSeconds
      : null;

  if (objectUrl) page.URL.revokeObjectURL(objectUrl);
  delete page.__aiHellCapture;

  const probe = {
    width,
    height,
    durationSeconds,
    // Decoded frames and their rate over the clip: `null` when the browser
    // exposes no frame count (the verdict then simply does not judge it).
    frameCount,
    effectiveFps,
    nonBlackFraction: nonBlackTotal / fractions.length,
    uniqueColours: colours.size,
    motion,
    // The size of the source the probe measured: the retained Blob (in-page)
    // or the streamed file (on-disk bytes from the chunk sink). The caller
    // reports the clip's on-disk size from the sink (`bytesWritten`) rather
    // than relying on this (AH-0MVNT274M009XRJ1).
    bytes: sourceBytes,
    mimeType,
    audioTrackCount,
    audioPeak,
    audioRms,
    audioDecodeError,
    // Additive report of the audio measurement's bounds (parent AC4): how
    // many bytes of the recording the peak/RMS came from, and whether the
    // decode was capped to the bounded prefix.
    audioProbeBytes,
    audioProbeCapped,
    sampleProbes,
    renderer: (() => {
      const canvas = doc.querySelector('#game-container canvas');
      const gl =
        canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
      return gl ? gl.getParameter(gl.RENDERER) : 'unknown';
    })(),
  };

  return { probe };
}
