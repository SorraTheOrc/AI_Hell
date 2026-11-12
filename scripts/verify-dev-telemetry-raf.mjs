/**
 * Dev-mode demo run with a `requestAnimationFrame` handler-duration assertion
 * (AH-0MWDGQ1YD007V7DO, parent AH-0MWDFAJAC005R3NI; run from the repository
 * root: `node scripts/verify-dev-telemetry-raf.mjs`).
 *
 * The parent bug stalled the gameplay frame loop with dev-telemetry
 * serialisation *inside* the rAF handler (observed 135–139 ms violations that
 * grew with the session). The fix defers part build+send off the rAF/update
 * task, so a dev demo run with the dev recorder and streaming upload enabled
 * must show **no couple-of-hundreds-of-ms rAF handler violation**.
 *
 * This harness is the operational half of that assertion: a stock
 * `npm run dev` server (dev recorder + streaming upload on by default), the
 * dev-gated **boss scenario** (`?scenario=boss&bossHits=1`) completing a real
 * boss run to victory through the normal `_finishRun(true)` path, while
 * an injected rAF wrapper times every handler invocation the page runs during
 * the run. The assertion fails the run (exit 1) when any handler takes
 * ≥ 200 ms — the couple-of-hundreds-of-ms bar the acceptance criteria name —
 * and always reports the observed maximum and the violation count.
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const { chromium } = await import('playwright');

const ROOT = process.cwd();
const DEV_PORT = 5211;
const DEV_LOG = '/tmp/verify-raf-server.log';
const RAF_VIOLATION_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envWithoutTelemetry() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITE_TELEMETRY_')) delete env[key];
  return env;
}

async function waitForHttp(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const out = createWriteStream(DEV_LOG, { flags: 'w' });
const server = spawn('npm', ['run', 'dev', '--', '--port', String(DEV_PORT), '--strictPort', '--open=false'], {
  cwd: ROOT,
  env: envWithoutTelemetry(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(out);
server.stderr.pipe(out);

const result = { phase: 'dev-demo-raf', ok: false, checks: {} };
let browser;
try {
  await waitForHttp(`http://127.0.0.1:${DEV_PORT}/`, 180_000);
  result.checks.devServerStarted = true;

  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling'],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();

  const uploads = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/telemetry/upload')) uploads.push({ method: request.method() });
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/telemetry/upload')) {
      const entry = uploads[uploads.length - 1];
      if (entry) entry.status = response.status();
    }
  });
  page.on('pageerror', (error) => console.log('pageerror:', error.message));

  // Wrap the global rAF before any page script runs, so the game loop (Phaser)
  // is measured through the same seam the bug stalled.
  await page.addInitScript(({ threshold }) => {
    const native = window.requestAnimationFrame.bind(window);
    const stats = (window.__aiHellRafStats = {
      threshold,
      count: 0,
      max: 0,
      violations: 0,
      totalMs: 0,
    });
    window.requestAnimationFrame = (callback) =>
      native((ts) => {
        const start = performance.now();
        try {
          callback(ts);
        } finally {
          const duration = performance.now() - start;
          stats.count += 1;
          stats.totalMs += duration;
          if (duration > stats.max) stats.max = duration;
          if (duration >= stats.threshold) stats.violations += 1;
        }
      });
  }, { threshold: RAF_VIOLATION_MS });

  await page.goto(`http://127.0.0.1:${DEV_PORT}/?scenario=boss&bossHits=1&seed=424242`, {
    waitUntil: 'load',
    timeout: 90_000,
  });
  await page.waitForSelector('#game-container canvas', { timeout: 30_000 });

  // The boss scenario is a jump scenario: Play Game (Enter) starts the
  // PlayScene, which drops straight into the boss encounter and freezes it
  // behind `window.__aiHellScenario` (see `captureStartKeys('scenario')`).
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Boolean(window.__aiHellScenario), undefined, { timeout: 30_000 });
  await page.waitForTimeout(1_500);

  // Reset the stats so the assertion covers the demo run itself, not the
  // module-load/boot work (shader compilation, first-frame setup) that also
  // runs inside rAF callbacks before the scenario starts.
  await page.evaluate(() => {
    const stats = window.__aiHellRafStats;
    stats.count = 0;
    stats.max = 0;
    stats.violations = 0;
    stats.totalMs = 0;
  });
  await page.evaluate(() => window.__aiHellScenario?.resume());
  await page.waitForFunction(() => window.__aiHellRunState?.ended === true, undefined, { timeout: 120_000 });

  result.checks.runEnd = await page.evaluate(() => window.__aiHellRunState);
  result.checks.uploadRequests = uploads;
  result.checks.rafHandlers = await page.evaluate(() => {
    const stats = window.__aiHellRafStats;
    return {
      threshold: stats.threshold,
      count: stats.count,
      max: Number(stats.max.toFixed(3)),
      mean: stats.count > 0 ? Number((stats.totalMs / stats.count).toFixed(3)) : null,
      violations: stats.violations,
    };
  });

  const raf = result.checks.rafHandlers;
  result.checks.allPassed =
    result.checks.runEnd?.ended === true &&
    result.checks.runEnd?.won === true &&
    uploads.length > 0 &&
    uploads.every((upload) => upload.status === 200) &&
    raf !== null &&
    raf.violations === 0 &&
    raf.max < RAF_VIOLATION_MS;
  result.ok = result.checks.allPassed;

  await context.close();
} catch (error) {
  result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    server.kill('SIGTERM');
  } catch {
    /* best effort */
  }
  out.end();
}

console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
