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

  it('is cross-linked from the README', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('docs/BOT_FRAMEWORK.md');
  });
});
