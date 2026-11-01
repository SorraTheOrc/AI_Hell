/**
 * Docs guard for the promo scenario catalogue and capture workflow
 * (AH-0MVSDMET30022L5C, child of AH-0MVI5XI73000ZVYA; parent AC6).
 *
 * This is a deliberate docs grep, matching the existing
 * `src/waves/campaignVarietyDocs.test.ts` and `src/waveBalanceDocs.test.ts`
 * precedent: the deliverable of the documentation item *is* the prose, so the
 * guard fails when the published catalogue drifts from the shared registry or
 * the documented workflow flags disappear. It does not assert scenario
 * behaviour — that is covered by `scripts/capture-scenarios.test.ts` and
 * `src/waves/promoScenario.survival.test.ts`.
 *
 * The catalogue table in `docs/dev/gameplay-capture.md` is compared
 * **cell-by-cell** against `CAPTURE_SCENARIOS` (the single source of truth), so
 * an added, renamed or re-presetted promo scenario cannot land without the
 * documentation moving with it. The README and the capture CLI `--help` are
 * checked for the three workflow flags a producer needs
 * (`--list-scenarios`, `--scenario`, `--all-scenarios`) and the bot-flown
 * lifecycle.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { cliSpawnEnv } from '../../scripts/cliChildEnv';
import { listCaptureScenarios } from '../../scripts/capture-scenarios.mjs';

const README = path.resolve(process.cwd(), 'README.md');
const CAPTURE_GUIDE = path.resolve(process.cwd(), 'docs/dev/gameplay-capture.md');

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/** A promo registry entry, narrowed to the fields the docs publish. */
interface PromoEntry {
  readonly name: string;
  readonly effect: string;
  readonly preset: string;
  readonly categories: readonly string[];
}

const PROMOS = listCaptureScenarios().filter(
  (scenario) => scenario.kind === 'promo',
) as unknown as PromoEntry[];

/** The guide's promo catalogue section (between its heading and the next one). */
function promoSection(guide: string): string {
  const start = guide.indexOf("### Promo scenarios (`kind: 'promo'`)");
  expect(start, 'the guide has a Promo scenarios section').toBeGreaterThan(-1);
  const end = guide.indexOf('### Promo scenario wave definitions', start);
  expect(end, 'the Promo scenarios section is followed by the wave section')
    .toBeGreaterThan(start);
  return guide.slice(start, end);
}

/**
 * The published catalogue rows, keyed by `scenario`.
 *
 * One row is `| `name` | effect | `preset` | categories |` — the same four
 * facts the registry carries, in the order a producer reads them.
 */
function catalogueRows(section: string): Map<
  string,
  { effect: string; preset: string; categories: string[] }
> {
  const rows = new Map<
    string,
    { effect: string; preset: string; categories: string[] }
  >();
  const pattern = /^\| `([^`]+)` \| (.+) \| `([^`]+)` \| (.+) \|$/;
  for (const line of section.split('\n')) {
    const match = pattern.exec(line);
    if (match === null) continue;
    const [, name, effect, preset, categories] = match;
    // The catalogue table only: skip its header row and any other table in the
    // section whose effect cell carries markup instead of one-line prose.
    if (name === 'scenario' || effect.includes('`')) continue;
    rows.set(name, {
      effect: effect.trim(),
      preset: preset.trim(),
      categories: categories.split(',').map((value) => value.trim()),
    });
  }
  return rows;
}

describe('Promo scenario documentation (AH-0MVSDMET30022L5C)', () => {
  const guide = read(CAPTURE_GUIDE);
  const readme = read(README);
  const section = promoSection(guide);

  it('publishes the whole registry catalogue, in order (AC1)', () => {
    expect(PROMOS.length).toBeGreaterThanOrEqual(10);
    const rows = catalogueRows(section);
    expect([...rows.keys()]).toEqual(PROMOS.map((promo) => promo.name));
  });

  it('lists each scenario with its effect, preset and categories (AC1)', () => {
    const rows = catalogueRows(section);
    for (const promo of PROMOS) {
      const row = rows.get(promo.name);
      expect(row, `catalogue row for ${promo.name}`).toBeDefined();
      expect(row?.effect, `effect of ${promo.name}`).toBe(promo.effect);
      expect(row?.preset, `preset of ${promo.name}`).toBe(promo.preset);
      expect(row?.categories, `categories of ${promo.name}`).toEqual([
        ...promo.categories,
      ]);
    }
  });

  it('documents the bot-flight lifecycle and a runnable example (AC1)', () => {
    // Normalise wrapping so assertions survive the guide's prose line breaks.
    const prose = section.replace(/\s+/g, ' ');
    expect(prose).toContain('bot-flown');
    expect(prose).toContain('no page-side freeze/release step');
    expect(section).toContain('npm run capture -- --scenario promo-blitz-hook');
    expect(section).toContain('npm run capture -- --list-scenarios');
    expect(section).toContain('--all-scenarios');
    // The hook ordering rationale (parent AC3) must stay visible to authors.
    expect(section).toContain('promo-blitz-hook');
    expect(prose).toContain('dead air');
  });

  it('the README describes the promo workflow and links the catalogue (AC2)', () => {
    for (const phrase of [
      '--list-scenarios',
      '--all-scenarios',
      '--scenario promo-blitz-hook',
      'bot-flown',
      'docs/dev/gameplay-capture.md#promo-scenarios-kind-promo',
    ]) {
      expect(readme, `README mentions ${phrase}`).toContain(phrase);
    }
  });

  it('the capture --help text covers the promo workflow (AC2)', { timeout: 60_000 }, () => {
    // A listing/help invocation is pure: `main()` returns before any Vite or
    // Chromium start, so this stays a fast subprocess test (the 60 s bound is
    // headroom for spawning under full-suite load, per the capture CLI's
    // documented spawn-test budget).
    const help = execFileSync(
      process.execPath,
      [path.resolve(process.cwd(), 'scripts/capture-gameplay.mjs'), '--help'],
      { encoding: 'utf8', timeout: 30_000, env: cliSpawnEnv() },
    );
    for (const phrase of [
      '--list-scenarios',
      '--all-scenarios',
      'promo-blitz-hook',
      'bot-flown',
      'docs/dev/gameplay-capture.md',
    ]) {
      expect(help, `--help mentions ${phrase}`).toContain(phrase);
    }
  });
});
