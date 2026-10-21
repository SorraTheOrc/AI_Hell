/**
 * Demo-bot victory variant of the dev-mode telemetry acceptance run
 * (AH-0MVBMRRJA006MM5A evidence; run from the repository root:
 * `node scripts/verify-dev-telemetry-demo.mjs`): a stock `npm run dev` server, the in-game
 * demo bot ("Watch Demo") completing a real boss run to victory through the
 * normal `_finishRun(true)` path, uploading and evaluating automatically.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { chromium } = await import('playwright');

const ROOT = process.cwd();
const DEV_PORT = 5199;
const UPLOAD_PATH = '/api/telemetry/upload';
const DEV_LOG = '/tmp/verify-demo-server.log';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function recordings() {
  const dir = join(ROOT, 'recordings');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^session-.+\.jsonl$/.test(f)).sort();
}

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

const result = { phase: 'dev-demo-victory', ok: false, checks: {} };
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
    if (request.url().includes(UPLOAD_PATH)) uploads.push({ method: request.method() });
  });
  page.on('response', (response) => {
    if (response.url().includes(UPLOAD_PATH)) {
      const entry = uploads[uploads.length - 1];
      if (entry) entry.status = response.status();
    }
  });
  page.on('pageerror', (error) => console.log('pageerror:', error.message));

  const before = recordings();
  await page.goto(`http://127.0.0.1:${DEV_PORT}/?scenario=boss&bossHits=1&seed=424242`, {
    waitUntil: 'load',
    timeout: 90_000,
  });
  await page.waitForSelector('#game-container canvas', { timeout: 30_000 });
  // "Watch Demo" (Tab then Enter), as `npm run record -- --bot` does.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => Boolean(window.__aiHellScenario), undefined, { timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await page.evaluate(() => window.__aiHellScenario?.resume());
  await page.waitForFunction(() => window.__aiHellRunState?.ended === true, undefined, { timeout: 120_000 });
  result.checks.runEnd = await page.evaluate(() => window.__aiHellRunState);
  result.checks.uploadRequests = uploads;

  const start = Date.now();
  let added = [];
  while (Date.now() - start < 120_000) {
    added = recordings().filter((f) => !before.includes(f));
    if (added.length > 0) break;
    await sleep(500);
  }
  result.checks.recordings = added;
  if (added.length > 0) {
    const file = join(ROOT, 'recordings', added[added.length - 1]);
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    const kinds = {};
    for (const line of lines) {
      try {
        const kind = JSON.parse(line).kind;
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      } catch {
        kinds.unparseable = (kinds.unparseable ?? 0) + 1;
      }
    }
    result.checks.recording = { file: added[added.length - 1], bytes: statSync(file).size, lines: lines.length, kinds };
    const stamp = added[added.length - 1].replace(/\.jsonl$/, '');
    const dir = join(ROOT, 'eval-output', 'uploaded', stamp);
    const evalStart = Date.now();
    while (Date.now() - evalStart < 420_000) {
      if (existsSync(join(dir, 'human-balance-report.json')) && existsSync(join(dir, 'evaluation.log'))) break;
      await sleep(1000);
    }
    result.checks.evaluation = existsSync(join(dir, 'human-balance-report.json'))
      ? { dir, files: readdirSync(dir).sort() }
      : null;
  }
  await sleep(2000);
  const log = existsSync(DEV_LOG) ? readFileSync(DEV_LOG, 'utf8') : '';
  result.checks.evaluationLogLines = log
    .split('\n')
    .filter((line) => line.includes('[telemetry-evaluation]'));
  result.checks.allPassed =
    result.checks.runEnd?.ended === true &&
    result.checks.runEnd?.won === true &&
    uploads.length > 0 &&
    uploads.every((u) => u.status === 200) &&
    result.checks.recordings.length > 0 &&
    result.checks.recording?.kinds?.tick > 0 &&
    Boolean(result.checks.evaluation?.files?.includes('human-balance-report.json'));
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
