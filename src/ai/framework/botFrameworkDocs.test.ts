/**
 * Docs guard for the bot framework (AC7).
 *
 * The framework's extension contract lives in `docs/BOT_FRAMEWORK.md`: the
 * overview, how goals/behaviours are structured, the commitment rules, and a
 * worked "add a goal" example. This guard fails if that document — or the key
 * content the acceptance criteria require — is removed or weakened.
 *
 * Like the sibling docs guards (`aoeDocs.test.ts`, `gymParityDocs.test.ts`,
 * `actionIntensityDocs.test.ts`), this is a deliberate docs grep: it asserts
 * the canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/BOT_FRAMEWORK.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const WORK_ITEM_ID = 'AH-0MUY08WKB002N1N6';
const EPIC_ID = 'AH-0MUY089KR003F8S4';

describe('Bot framework is documented (AH-0MUY08WKB002N1N6)', () => {
  it('the framework document exists (AC7)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('documents the retired wallMargin without advertising it as a tunable (AH-0MVT2W3RS009ZB2X)', () => {
    // The retirement is explained (the edges are a wrap, not a wall) but the
    // live tuning table no longer offers the knob.
    expect(doc).toMatch(/`wallMargin` retired/i);
    const tuning = doc.slice(doc.indexOf('## 12. Tuning the bot live'));
    expect(tuning).not.toMatch(/wallMargin/i);
  });

  it('documents the wrap-aware (torus) model (AH-0MVMISF0Q00314LG)', () => {
    expect(doc).toContain('### 9.11 Wrap-aware (torus) model');
    expect(doc).toContain('src/utils/wrapGeometry.ts');
    expect(doc).toContain('src/ai/framework/wrapGeometry.ts');
    expect(doc).toContain('chooseWrappedRoute');
    expect(doc).toMatch(/near-tie hysteresis/i);
    expect(doc).toMatch(/wrap, not a wall/i);
  });

  it('documents the framework overview and all four pieces (AC1–AC7)', () => {
    for (const heading of [
      '## 1. Why a framework',
      '## 2. World model',
      '## 3. Goals and behaviours',
      '## 4. Commitment / hysteresis',
      '## 5. Brain / policy',
      '## 6. Determinism',
      '## 7. Legacy adapter',
      '## 8. Adding a goal and behaviour',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('names the framework API goals/behaviours plug into (AC1–AC4)', () => {
    for (const symbol of [
      'BotBrain',
      'BotPolicy',
      'buildBotWorld',
      'selectCommittedGoal',
      'BOT_COMMITMENT_TUNABLES',
      'createLegacyBotPolicy',
      'BotGoal',
      'BotBehaviour',
      'createGoalRegistry',
      'createBehaviourRegistry',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('explains the commitment release rules and the registry contract', () => {
    expect(doc).toMatch(/invalid/);
    expect(doc).toMatch(/achieved/);
    expect(doc).toMatch(/switchMargin/);
    expect(doc).toMatch(/minCommitSeconds/);
    expect(doc).toMatch(/without an edit to the core|no core file changes|No core file changes/i);
  });

  it('references the work item and its parent epic', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain(EPIC_ID);
  });

  it('documents the bot-tuning gym (AH-0MV4D7LAD009XYR0)', () => {
    expect(doc).toContain('## 12. Tuning the bot live (the bot-tuning gym)');
    for (const symbol of [
      'GymBotTuning',
      'src/ai/tuningFields.ts',
      'src/core/botTuningStore.ts',
      'src/utils/randomLevel.ts',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('is cross-linked from the README', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('docs/BOT_FRAMEWORK.md');
  });

  it('documents the class-shaped hazard motion model (AH-0MWLUIOH9001XBJ3)', () => {
    // The epic's user-facing contract: a reader can explain, per movement
    // class, how the bot predicts a hazard, what the knobs do and what the
    // disabled path guarantees. Pinned here so the model cannot be
    // undocumented silently.
    expect(doc).toContain('### 9.10 Predictive hazard avoidance');
    for (const symbol of [
      'advanceHazardMotion',
      'predictMinimumSeparation',
      'hazardMotionModelEnabled',
      'hazardClassHorizonScale',
      'hazardMotionSweep.test.ts',
      'botSteering.integration.test.ts',
    ]) {
      expect(doc).toContain(symbol);
    }
    // One table row per implemented movement class.
    for (const movementClass of ['`chaser`', '`diver`', '`patroller`', '`formation`', '`roamer`']) {
      expect(doc).toContain(movementClass);
    }
    // The disabled/unknown/stationary fallbacks are bit-identical to the
    // pre-motion-model predictor.
    expect(doc).toMatch(/disabled-path guarantee/i);
    expect(doc).toMatch(/bit-for-bit/);
  });

  it('documents the aim solve, the adaptive aim-error knobs and the accuracy harness (AH-0MWR05J320041SAA · AC7)', () => {
    // Section 9.8 must describe the shipped solve: the tracked-estimate
    // precedence, the class-sampled intercept and the adaptive aim error.
    expect(doc).toContain('### 9.8 Rotation skills (AH-0MV1DUSM2005HL98)');
    for (const symbol of [
      'interceptPoint',
      'aimLeadFromTracker',
      'advanceHazardMotion',
      'aimErrorRad',
      'aimErrorDecay',
      'aimErrorResetDistance',
      'aimErrorRad = 0',
    ]) {
      expect(doc).toContain(symbol);
    }
    // The tracked → snapshot → current-position precedence is named.
    expect(doc).toMatch(/bot-side tracker/i);
    expect(doc).toMatch(/repositioning move/i);
    // The accuracy harness is documented with its location, seeds and metrics.
    for (const symbol of [
      'src/ai/eval/aimAccuracy.test.ts',
      'src/ai/eval/aimAccuracy.baseline.json',
      'aimErrorRad = 0',
      'mean miss distance',
      'aimLeadFromTracker: false',
    ]) {
      expect(doc).toContain(symbol);
    }
    // The recorded before/after pooled numbers are in the document.
    expect(doc).toContain('0.5624');
    expect(doc).toContain('0.5099');
  });
});
