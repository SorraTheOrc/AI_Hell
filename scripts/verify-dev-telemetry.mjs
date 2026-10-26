/**
 * End-to-end acceptance harness for the dev-mode telemetry upload flow
 * (AH-0MVBMRRJA006MM5A, parent AH-0MVBHRLY8004BGDN).
 *
 * Run from the repository root:
 *
 * ```bash
 * node scripts/verify-dev-telemetry.mjs dev    # dev happy path + opt-out
 * npm run build && node scripts/verify-dev-telemetry.mjs prod
 * ```
 *
 * Phase `dev`:
 *  1. Start a stock `npm run dev` (no VITE_TELEMETRY_* env vars).
 *  2. Play a run to completion with Playwright using the dev defeat scenario,
 *     which ends through the normal `_finishRun(false)` path.
 *  3. Assert `recordings/session-*.jsonl` appears, the dev server logs the
 *     background evaluation, and `eval-output/uploaded/<stamp>/human-balance-report.json`
 *     (+ companions) appear.
 *  4. Re-run with the "share with dev server" setting OFF and assert no new
 *     recording file, no upload request and an untouched sink.
 *
 * Phase `prod`:
 *  5. Assert the production bundle contains no upload endpoint marker and that
 *     `vite preview` does not serve the upload endpoint.
 *
 * The JSON report it prints is the acceptance evidence; see
 * `docs/TELEMETRY.md` for the flow it verifies. Server logs are written to
 * `/tmp/verify-*-server.log`.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = await import('playwright');

const ROOT = process.cwd();
const SETTINGS_KEY = 'ai_hell_settings';
const UPLOAD_PATH = '/api/telemetry/upload';
const DEV_PORT = 5199;
const PREVIEW_PORT = 5198;
const DEV_LOG = '/tmp/verify-dev-server.log';
const PREVIEW_LOG = '/tmp/verify-preview-server.log';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordings() {
  const dir = join(ROOT, 'recordings');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^session-.+\.jsonl$/.test(f))
    .sort();
}

function envWithoutTelemetry() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_TELEMETRY_')) delete env[key];
  }
  return env;
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  let lastError = 'no attempt';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function startServer(command, args, logPath) {
  const out = createWriteStream(logPath, { flags: 'w' });
  const proc = spawn(command, args, {
    cwd: ROOT,
    env: envWithoutTelemetry(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);
  return { proc, out };
}

async function stopServer(server) {
  if (!server) return;
  try {
    server.proc.kill('SIGTERM');
    await sleep(1000);
    if (!server.proc.killed) server.proc.kill('SIGKILL');
  } catch {
    /* best effort */
  }
  server.out.end();
}

/** Plays one defeat-scenario run and returns the observations. */
async function playRun(browser, { shareTelemetryDev }) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  if (shareTelemetryDev !== undefined) {
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [SETTINGS_KEY, JSON.stringify({ shareTelemetryDev })],
    );
  }
  const page = await context.newPage();
  const uploads = [];
  const consoleLines = [];
  page.on('request', (request) => {
    if (request.url().includes(UPLOAD_PATH)) {
      uploads.push({ method: request.method(), url: request.url() });
    }
  });
  page.on('response', (response) => {
    if (response.url().includes(UPLOAD_PATH)) {
      const entry = uploads[uploads.length - 1];
      if (entry) entry.status = response.status();
    }
  });
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));

  await page.goto(`http://127.0.0.1:${DEV_PORT}/?scenario=defeat&seed=424242`, {
    waitUntil: 'load',
    timeout: 90_000,
  });
  await page.waitForSelector('#game-container canvas', { timeout: 30_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Boolean(window.__aiHellScenario), undefined, {
    timeout: 30_000,
  });
  // Let the recorder observe a handful of ticks before the defeat.
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.__aiHellScenario?.resume());
  await page.waitForFunction(() => window.__aiHellRunState?.ended === true, undefined, {
    timeout: 60_000,
  });
  const sink = await page.evaluate(() => {
    const accessor = globalThis.__aiHellTelemetry;
    if (!accessor || typeof accessor.read !== 'function') return null;
    const content = accessor.read();
    return typeof content === 'string' && content.length > 0 ? content : null;
  });
  const storedSettings = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_KEY);
  return { context, page, uploads, consoleLines, sink, storedSettings };
}

async function waitForNewRecording(before, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const added = recordings().filter((f) => !before.includes(f));
    if (added.length > 0) return added;
    await sleep(500);
  }
  return [];
}

async function waitForEvalArtifacts(recordingName, timeoutMs) {
  const stamp = recordingName.replace(/\.jsonl$/, '');
  const dir = join(ROOT, 'eval-output', 'uploaded', stamp);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const report = join(dir, 'human-balance-report.json');
    if (existsSync(report) && existsSync(join(dir, 'evaluation.log'))) {
      return {
        dir,
        files: readdirSync(dir).sort(),
        report: JSON.parse(readFileSync(report, 'utf8')),
      };
    }
    await sleep(1000);
  }
  return null;
}

async function devPhase() {
  const result = { phase: 'dev', ok: false, checks: {} };
  const server = startServer('npm', ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort', '--open=false'], DEV_LOG);
  let browser;
  try {
    await waitForHttp(`http://127.0.0.1:${DEV_PORT}/`, 180_000);
    result.checks.devServerStarted = true;

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--enable-unsafe-swiftshader',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    // ── 1. Happy path (setting defaults to ON) ─────────────────────────
    const before = recordings();
    const happy = await playRun(browser, {});
    result.checks.runEnded = true;
    result.checks.happyUploadRequests = happy.uploads;
    result.checks.happySinkChars = happy.sink ? happy.sink.length : 0;
    result.checks.happyStoredSettings = happy.storedSettings;

    const added = await waitForNewRecording(before, 120_000);
    result.checks.happyRecordings = added;
    if (added.length > 0) {
      const file = join(ROOT, 'recordings', added[added.length - 1]);
      const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
      result.checks.happyRecordingLines = lines.length;
      result.checks.happyRecordingBytes = statSync(file).size;
      result.checks.happyRecordingKinds = [...new Set(lines.map((line) => {
        try { return JSON.parse(line).kind; } catch { return 'unparseable'; }
      }))];
      const evaluation = await waitForEvalArtifacts(added[added.length - 1], 420_000);
      result.checks.happyEvaluation = evaluation
        ? {
            dir: evaluation.dir,
            files: evaluation.files,
            reportKind: evaluation.report?.kind ?? null,
            reportPolicy: evaluation.report?.policy ?? null,
          }
        : null;
    }
    // Give the dev-server log a moment to flush the completion summary.
    await sleep(2000);
    const devLog = existsSync(DEV_LOG) ? readFileSync(DEV_LOG, 'utf8') : '';
    result.checks.evaluationLogLines = devLog
      .split('\n')
      .filter((line) => line.includes('[telemetry-evaluation]'))
      .slice(0, 20);
    result.checks.happyConsole = happy.consoleLines.slice(-8);
    await happy.context.close();

    // ── 2. Opt-out path (setting OFF) ─────────────────────────────────
    const beforeOptOut = recordings();
    const optOut = await playRun(browser, { shareTelemetryDev: false });
    await sleep(10_000);
    const addedOptOut = recordings().filter((f) => !beforeOptOut.includes(f));
    result.checks.optOutUploadRequests = optOut.uploads;
    result.checks.optOutNewRecordings = addedOptOut;
    result.checks.optOutSink = optOut.sink;
    result.checks.optOutStoredSettings = optOut.storedSettings;
    result.checks.optOutRunEnded = true;
    await optOut.context.close();

    result.checks.allPassed =
      result.checks.happyRecordings.length > 0 &&
      result.checks.happyUploadRequests.length > 0 &&
      result.checks.happyUploadRequests.every((upload) => upload.status === 200) &&
      Boolean(result.checks.happyEvaluation) &&
      result.checks.happyEvaluation.files.includes('human-balance-report.json') &&
      result.checks.evaluationLogLines.some((line) => line.includes('evaluation finished')) &&
      result.checks.happySinkChars > 0 &&
      result.checks.optOutUploadRequests.length === 0 &&
      result.checks.optOutNewRecordings.length === 0 &&
      (result.checks.optOutSink === null || result.checks.optOutSink === '');
    result.ok = result.checks.allPassed;
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
  }
  return result;
}

async function prodPhase() {
  const result = { phase: 'prod', ok: false, checks: {} };
  try {
    // 1. Bundle must not contain the dev upload endpoint.
    const distDir = join(ROOT, 'dist');
    if (!existsSync(distDir)) throw new Error('dist/ is missing — run `npm run build` first');
    const hits = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(js|mjs|html|css)$/.test(entry.name)) {
          const text = readFileSync(full, 'utf8');
          if (text.includes(UPLOAD_PATH)) hits.push(full.replace(ROOT + '/', ''));
        }
      }
    };
    walk(distDir);
    result.checks.bundleEndpointHits = hits;

    // 2. `vite preview` serves no upload endpoint.
    const server = startServer(
      'npx',
      ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
      PREVIEW_LOG,
    );
    try {
      await waitForHttp(`http://127.0.0.1:${PREVIEW_PORT}/`, 120_000);
      const body = '{"kind":"run_header","schemaVersion":1,"runSeed":1,"build":{"appVersion":"x","commit":"y"},"startedAt":0}\n';
      const post = await fetch(`http://127.0.0.1:${PREVIEW_PORT}${UPLOAD_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
      });
      const postText = await post.text();
      result.checks.previewPostStatus = post.status;
      result.checks.previewPostBodyPrefix = postText.slice(0, 120);
      result.checks.previewPostIsUploadJson =
        postText.includes('"storedPath"') || postText.includes('"recordCount"');
      const get = await fetch(`http://127.0.0.1:${PREVIEW_PORT}${UPLOAD_PATH}`);
      result.checks.previewGetStatus = get.status;
      result.checks.allPassed =
        hits.length === 0 &&
        post.status !== 200 &&
        result.checks.previewPostIsUploadJson === false;
      result.ok = result.checks.allPassed;
    } finally {
      await stopServer(server);
    }
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }
  return result;
}

const phase = process.argv[2] ?? 'dev';
const result = phase === 'prod' ? await prodPhase() : await devPhase();
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
