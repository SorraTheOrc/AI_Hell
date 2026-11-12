/**
 * Docs guard for the automated-balancing (batch evaluation) framework
 * (AH-0MV81Z2EJ006HD5T, epic AH-0MV1DLUZ8009OCJW AC6).
 *
 * The batch contract lives in `docs/BALANCING.md`: how to run a batch, the
 * CLI flags, the shared statistics schema and how to interpret the
 * distributions, the fidelity boundary and the reproducibility story. This
 * guard fails if that document — or the key content the acceptance criteria
 * require — is removed or weakened, and it pins the cross-links from
 * `docs/EVALUATION.md` and the README.
 *
 * Like the sibling docs guards (`evaluationDocs.test.ts`,
 * `actionIntensityDocs.test.ts`), this is a deliberate docs grep: it asserts
 * the canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');
const EVALUATION_PATH = path.resolve(process.cwd(), 'docs/EVALUATION.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const WORK_ITEM_ID = 'AH-0MV81Z2EJ006HD5T';
const EPIC_ID = 'AH-0MV1DLUZ8009OCJW';

describe('Automated balancing is documented (AH-0MV81Z2EJ006HD5T)', () => {
  it('the BALANCING.md document exists (epic AC6)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('covers the required sections (how to run, schema, boundary, reproducibility)', () => {
    for (const heading of [
      '## Quick start',
      '## Statistics schema',
      '## Interpreting a distribution',
      '## Config-driven simulation',
      '## Determinism and reproducibility',
      '## Fidelity boundary and limitations',
      '## Testing',
      '## Related work',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('documents how to run a batch and its CLI flags (epic AC2/AC6)', () => {
    for (const symbol of [
      'npm run evaluate -- --batch',
      '--games',
      '--policies',
      '--out',
      '--json',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('names the batch artifacts', () => {
    for (const artifact of [
      'balance-report.json',
      'balance-report.txt',
      'runs.jsonl',
    ]) {
      expect(doc).toContain(artifact);
    }
  });

  it('documents the versioned, shared statistics schema without weakening it', () => {
    for (const symbol of [
      'BALANCE_STATISTICS_SCHEMA_VERSION',
      'BalanceRunStats',
      'BalanceAggregate',
      'DistributionStats',
    ]) {
      expect(doc).toContain(symbol);
    }
    for (const field of [
      'schemaVersion',
      'mineralsCollected',
      'upgradesSelected',
      'enemiesKilledByArchetype',
      'asteroidsDestroyed',
      'powerUpsCollected',
      'avoidableHits',
      'survivalSeconds',
      'waveReached',
      'levelReached',
    ]) {
      expect(doc).toContain(field);
    }
  });

  it('documents the distribution interpretation (count, mean, median, min, max, stdDev)', () => {
    for (const stat of ['count', 'mean', 'median', 'min', 'max', 'stdDev']) {
      expect(doc).toContain(stat);
    }
    // Reading guidance, not just symbols.
    expect(doc).toMatch(/median/);
    expect(doc).toMatch(/variance|outliers|standard deviation/);
  });

  it('explains the reproducibility guarantee and the fidelity boundary', () => {
    expect(doc).toMatch(/byte-identical|byte-stable/);
    expect(doc).toMatch(/not Phaser|closed-loop headless/);
    expect(doc).toMatch(/seed/i);
  });

  it('references the work item and its parent epic', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain(EPIC_ID);
  });

  it('documents the human-play balance report (AH-0MV7WVEWL005XEMN)', () => {
    for (const symbol of [
      "'human'",
      'extractHumanBalanceStats',
      'balance-stats.json',
      'human-balance-report.json',
      'npm run record',
      '--human',
      'dev-tooling only',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('is cross-linked from the README and EVALUATION.md', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const evaluation = fs.readFileSync(EVALUATION_PATH, 'utf8');
    expect(readme).toContain('docs/BALANCING.md');
    expect(evaluation).toContain('BALANCING.md');
  });
});

describe('Tuning loop is documented (AH-0MV8Q5EYE001R715)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('documents the one-command loop with its worked example (parent AC7)', () => {
    expect(doc).toContain('## Tuning loop (baseline → edit → re-run → compare)');
    expect(doc).toContain('node scripts/evaluate.mjs --tune --set enemy-configs.csv boss.health=6 --games 100');
  });

  it('documents the tune flags and artifacts', () => {
    for (const symbol of ['--tune', '--set <file> <assignment>', '--threshold', '--keep-edit']) {
      expect(doc).toContain(symbol);
    }
    for (const artifact of ['tune-baseline-report.json', 'tune-candidate-report.json', 'tune-comparison.json', 'tune-comparison.txt']) {
      expect(doc).toContain(artifact);
    }
  });

  it('documents the guards (same-sweep, determinism, checkout hygiene)', () => {
    expect(doc).toMatch(/Same-sweep guard/);
    expect(doc).toMatch(/byte-identical/);
    expect(doc).toMatch(/checkout hygiene|Checkout hygiene/);
  });

  it('documents the fail-fast input validation and its exit code (AH-0MVSE18XX006ZG5I)', () => {
    expect(doc).toContain('AH-0MVSE18XX006ZG5I');
    expect(doc).toMatch(/Fail-fast input validation/);
    expect(doc).toContain('output directory not writable');
    expect(doc).toContain('tune CSV not readable');
    // The guarantee that makes it fail *fast*: before the core boots or a sweep runs.
    expect(doc).toMatch(/before the SSR core\s+boots or any sweep runs/);
    expect(doc).toMatch(/exit code `2`/);
    // The reason a plain mkdir is insufficient is part of the contract.
    expect(doc).toMatch(/existing.*read-only\s+directory|read-only\s+directory/i);
  });

  it('documents the pseudo-filesystem guard for --out (AH-0MVWLQQKB0075A1U)', () => {
    expect(doc).toContain('AH-0MVWLQQKB0075A1U');
    expect(doc).toMatch(/pseudo-filesystem/i);
    expect(doc).toContain('unsupported filesystem type 0x');
    expect(doc).toContain('procfs');
    expect(doc).toContain('statfsSync');
    // The documented negative probe must be named as the reason.
    expect(doc).toContain('/proc/nope/x');
    // Fail-open is part of the guarantee (no regression on normal filesystems).
    expect(doc).toMatch(/fail-open/i);
  });

  it('documents the crash-safe edit journal and its repair path (AH-0MVSE1A7O002PXAO)', () => {
    expect(doc).toContain('AH-0MVSE1A7O002PXAO');
    expect(doc).toMatch(/Crash-safe edit journal/);
    expect(doc).toContain('.tune-journal');
    // The automatic recovery path (next invocation) and the manual one.
    expect(doc).toMatch(/reconciles a stale journal/);
    expect(doc).toContain('jq -r .originalBase64');
    expect(doc).toContain('base64 -d');
    // Git-ignored, so a crashed run leaves no worktree change.
    expect(doc).toContain('src/data/*.tune-journal');
    // An abort before the edit lands reconciles the journal it wrote itself
    // (AH-0MW251IE0006K5DS).
    expect(doc).toMatch(/reconciles the journal it wrote/);
  });

  it('documents the per-run progress and the opt-in watchdog (AH-0MVSE1OPF008G1SB)', () => {
    expect(doc).toContain('AH-0MVSE1OPF008G1SB');
    expect(doc).toMatch(/Progress output and the runtime bound/);
    expect(doc).toContain('[tune] baseline 1/2 seed=1 policy=competent');
    // The guarantee: progress is on stderr, stdout parity is preserved.
    expect(doc).toMatch(/reports its progress on \*\*stderr\*\*/);
    expect(doc).toMatch(/stdout keeps exactly the report/);
    // The flag surface and its default.
    expect(doc).toContain('--watchdog <secs>');
    expect(doc).toMatch(/default `0` = off/);
    // The distinct exit code and the accepted limitation.
    expect(doc).toContain('124');
    expect(doc).toContain('tune watchdog expired after');
    expect(doc).toMatch(/blocking\* synchronous sweep that never yields|cannot be interrupted/);
  });

  it('names the tune-loop safety test files (AH-0MVSE1PG7006XBZ9)', () => {
    for (const file of [
      'scripts/evaluate-failfast.test.ts',
      'scripts/csvEditJournal.test.ts',
      'scripts/evaluate-tune-progress.test.ts',
      'scripts/tune-verify.e2e.test.ts',
    ]) {
      expect(doc).toContain(file);
    }
  });

  it('is cross-linked from the README and EVALUATION.md flags', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const evaluation = fs.readFileSync(EVALUATION_PATH, 'utf8');
    expect(readme).toMatch(/tuning loop/i);
    expect(evaluation).toContain('--tune');
  });
});

describe('Campaign-by-default batch is documented (AH-0MVD1RK2V009J5D2)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('documents the campaign batch default with a --skirmish opt-out (AC1/AC2)', () => {
    expect(doc).toContain('AH-0MVD1RK2V009J5D2');
    expect(doc).toContain('--skirmish');
    expect(doc).toMatch(/full shipped campaign|whole shipped campaign/);
    expect(doc).toMatch(/Q3=b/);
  });

  it('documents the finite, higher batch tick budget and the early exits (AC3)', () => {
    expect(doc).toContain('18000');
    expect(doc).toMatch(/gameComplete/);
    expect(doc).toMatch(/finite/);
  });

  it('documents the comparability note: skirmish-scoped single-run evaluation (AC5)', () => {
    expect(doc).toMatch(/Comparability note/);
    expect(doc).toMatch(/skirmish/);
    expect(doc).toMatch(/config\.campaign/);
  });
});

describe('Level-scaling curves and evidence are documented (AH-0MVHT1M6O003PU7P)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('documents the scaling curve section with the level 1–10 table', () => {
    expect(doc).toContain('## Level-scaling curves and evidence (AH-0MVHT1M6O003PU7P)');
    expect(doc).toContain('### Scaling table (levels 1–10)');
    // The table's endpoints are the tuning contract: 1.00× → 2.00× counts,
    // 0.09 → 0.025 per-kill drop chance (halved from 0.18/0.05 by
    // AH-0MW10ZVLH005IJRM), level 1 = the identity.
    expect(doc).toContain('| 1 | 1.000× | 0.0900 |');
    expect(doc).toContain('| 5 | 1.444× | 0.0611 |');
    expect(doc).toContain('| 10 | 2.000× | 0.0250 |');
    expect(doc).toContain('src/core/levelScaling.ts');
    expect(doc).toContain('applyEnemyCountScaling');
    expect(doc).toContain('powerUpDropChance');
  });

  it('documents the asteroid Extra Life roll as off at every level (AH-0MW10ZVLH005IJRM)', () => {
    // The asteroid column is 0 at every level, so the table can never show a
    // live rock-drops-lives chance while the shipped default is off.
    expect(doc).toContain('| 1 | 1.000× | 0.0900 | 1.000 | 0 |');
    expect(doc).toContain('| 10 | 2.000× | 0.0250 | 0.278 | 0 |');
    expect(doc).toMatch(/asteroid Extra Life[^\n]*(off|0)/i);
  });

  it('documents the baseline vs post-change evidence with commands and seed set', () => {
    expect(doc).toContain('### Evidence: same-seed baseline vs post-change batches');
    expect(doc).toContain('--scale-levels off');
    expect(doc).toContain('--scale-levels on');
    expect(doc).toContain('--games 100');
    expect(doc).toMatch(/seed set \(1–100\)/);
    expect(doc).toMatch(/competent/);
    expect(doc).toMatch(/ec0ccc7b/);
  });

  it('records the per-level metrics the parent AC requires', () => {
    for (const metric of [
      'powerUpsCollected',
      'enemiesKilledByArchetype',
      'avoidableHits',
      'survivalSeconds',
      'levelReached',
      'Power-ups per kill',
    ]) {
      expect(doc).toContain(metric);
    }
    // The supply-per-kill result is quoted for level 5 and level 10.
    expect(doc).toContain('0.0432');
    expect(doc).toContain('0.0055');
  });

  it('concludes with falls in supply and no regression in playability checks', () => {
    expect(doc).toMatch(/per kill falls|supply per kill falls|supply per kill/i);
    expect(doc).toMatch(/no crash|did not crash|without a crash/);
    expect(doc).toMatch(/levelReached/);
    expect(doc).toMatch(/formation gyms/i);
  });
});

describe('Campaign fidelity boundary is documented (AH-0MVD1RO7D000AC4X)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('names what a campaign batch now models: the shared sequencer, all three generation modes and the shared hold-full choice flow (AC1)', () => {
    // Modelled: the shared wave/level sequencer drives every campaign wave
    // (fixed / curve / dynamic), and the shared choice flow makes the
    // upgrade picks — so the three fields carry real values.
    expect(doc).toMatch(/shared sequencer|shared campaign sequencer|buildSequencedLevels/);
    expect(doc).toContain('`fixed`');
    expect(doc).toContain('`curve`');
    expect(doc).toContain('`dynamic`');
    expect(doc).toMatch(/hold-full upgrade-choice flow/);
    for (const field of ['waveReached', 'levelReached', 'upgradesSelected']) {
      expect(doc).toContain(field);
    }
    expect(doc).toMatch(/non-zero/);
  });

  it('names what remains simplified, so consumers do not over-read the report (AC1)', () => {
    expect(doc).toMatch(/no boss|boss\/mini-boss|boss encounter/i);
    expect(doc).toMatch(/mini-boss/i);
    expect(doc).toMatch(/VFX/i);
    expect(doc).toMatch(/formation movement/i);
    expect(doc).toMatch(/rendering/i);
  });

  it('explains how to read the per-wave / per-level campaign distributions (AC2)', () => {
    expect(doc).toMatch(/within-level|within the level|within its level/);
    expect(doc).toMatch(/reading the campaign distributions|per-wave|waveReached/);
  });
});

describe('Weapon fire output in the fidelity boundary is documented (AH-0MW5DVEPL0029S5C)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const boundary = doc.slice(
    doc.indexOf('## Fidelity boundary and limitations'),
    doc.indexOf('## Testing'),
  );

  it('moves weapon fire output from "simplified" to "modelled" (AC1)', () => {
    expect(boundary.length).toBeGreaterThan(0);
    expect(boundary).toMatch(/player weapon fire output/i);
    for (const lever of ['cadence', 'pattern', 'lifetime', 'size', 'damage', 'AOE']) {
      expect(boundary).toContain(lever);
    }
    // The ownership context and the shared resolvers are the authority, not a
    // fixed fire constant.
    expect(boundary).toContain('ownership context');
    expect(boundary).toContain('resolveWeaponDefinition');
    // The retired claim is replaced, not duplicated: no reader can still find
    // "the arena's auto-fire is fixed" in the boundary.
    expect(boundary).not.toMatch(/auto-fire is fixed/i);
  });

  it('keeps the explicit list of what the fire model still does not model (AC1)', () => {
    for (const gap of [
      'timed field-pickup weapons',
      'homing arcs',
      'chain jumps',
      'cluster split trajectories',
    ]) {
      expect(boundary).toContain(gap);
    }
  });
});

describe('Arena fire-model drift is documented (AH-0MWAPWS1W007LGGY)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');

  it('records the bisected drift commit and the kill-driven levelling mechanism', () => {
    // The drift is the arena's own fire-model fidelity change (bisected to
    // 6ecbab23, AH-0MW5DVAME0062GQO), so the boundary must name both the
    // finding's work item and the commit it was bisected to.
    expect(doc).toContain('AH-0MWAPWS1W007LGGY');
    expect(doc).toContain('AH-0MW5DVAME0062GQO');
    expect(doc).toMatch(/kill-driven/i);
    // The measured consequence for the ring-timing evidence.
    expect(doc).toMatch(/level 3/i);
    expect(doc).toMatch(/deliberate\s+deviation/i);
  });

  it('states that modelling more fire detail deepens the effect rather than removing it', () => {
    // Records why the "model the Wave Laser's hitscan ray" fix option was
    // rejected: it raises the arena's DPS, so the slice climbs further inside
    // the window.
    expect(doc).toMatch(/hitscan ray/i);
    expect(doc).toMatch(/raise\s+the arena's\s+DPS/i);
  });
});

describe('Weapon-trim measured before/after gate is documented (AH-0MVWAVM03002FLLL)', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf(
    '## Weapon 40 % trim / flattened curve — measured before/after gate',
  );
  const section = start >= 0 ? doc.slice(start) : '';
  const hasSection = section.length > 0;

  it('records the gate as its own section naming the item and both sides of the comparison (parent AC6)', () => {
    expect(hasSection).toBe(true);
    expect(section).toContain('AH-0MVWAVM03002FLLL');
    expect(section).toContain('AH-0MVRENEME004FS8T');
    // The weapon-fire model the re-run depends on, and this docs update.
    expect(section).toContain('AH-0MW1OLFM20060MOE');
    expect(section).toContain('AH-0MW5DVEPL0029S5C');
    // The before/after provenance: the two commits and the dated artefact paths.
    expect(section).toContain('47609296');
    expect(section).toContain('ffd79aa2');
    expect(section).toContain('eval-output/rerun-baseline-2026-11-07/');
    expect(section).toContain('eval-output/rerun-post-trim-2026-11-07/');
    expect(section).toContain('npm run evaluate -- --batch --games 100');
  });

  it('records the before/after/delta table for every required aggregate metric', () => {
    for (const metric of [
      'survivalSeconds',
      'waveReached',
      'levelReached',
      'upgradesSelected',
      'mineralsCollected',
      'avoidableHits',
    ]) {
      expect(section).toContain(metric);
    }
    // Same sweep, asserted from the report config block.
    expect(section).toMatch(/campaign mode/);
    expect(section).toMatch(/seeds `1\.\.100`/);
    expect(section).toContain('18000');
    // The re-run's measured deltas — not the old blind-harness zeroes.
    expect(section).toContain('| 8.11 | 8.09 |');
    expect(section).toContain('| 1.86 | 1.72 |');
  });

  it('states that weapon output is modelled and the re-run sees it (AC2/AC3)', () => {
    // The present-tense capability claim that replaced "the gate is blind".
    expect(section).toMatch(/now\s+\*{0,2}models weapon output/i);
    // The structural reason the numbers move: ownership context + shared catalogue.
    expect(section).toContain('ownership context');
    expect(section).toContain('WEAPON_CATALOGUE');
    // The measured evidence, not an inference: 69 / 100 per-run hashes move.
    expect(section).toMatch(/69\s*\/\s*100/);
    for (const hash of [
      'cc943ec4',
      'fc0af8b9',
      '919486c3',
      '4da435d2',
      '745a2844',
      'cfa0948f',
    ]) {
      expect(section).toContain(hash);
    }
    // The inverse contract now pins sensitivity, so the claim cannot rot.
    expect(section).toContain('src/ai/eval/arenaWeaponSensitivity.test.ts');
    // The carried-forward limitation and the follow-up provenance.
    expect(section).toMatch(/human play-check is required/i);
    expect(section).toContain('discovered-from:AH-0MVRENEME004FS8T');
    // The old claims are replaced, not left beside the new ones.
    expect(section).not.toContain('### Why the numbers cannot move');
    expect(section).not.toMatch(/cannot see weapon output/i);
    expect(section).not.toMatch(/blind to weapon-output levers/i);
    expect(section).not.toMatch(/does not model weapon output/i);
  });

  it('records the no-re-baseline decision with the per-band deltas as evidence (AC4)', () => {
    expect(section).toMatch(/deliberately NOT\s+re-baselined/);
    expect(section).toContain('validate-experience');
    expect(section).toMatch(/no band moved materially|no band left its tolerance/i);
    expect(section).toMatch(/in-band/);
  });
});
