/**
 * Docs guard for the structured competent bot (AH-0MUY08WX3000ZEVO, AC8).
 *
 * The competent decision model is documented in `docs/BOT_FRAMEWORK.md`
 * (section 9). This guard fails if that section — or the key content the
 * acceptance criteria require — is removed or weakened.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/BOT_FRAMEWORK.md');
const WORK_ITEM_ID = 'AH-0MUY08WX3000ZEVO';

describe('competent bot is documented (AH-0MUY08WX3000ZEVO)', () => {
  it('the framework document exists (AC8)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('documents the competent decision model (AC1–AC5)', () => {
    for (const heading of [
      '## 9. The structured competent bot',
      '### 9.1 Goals and priorities',
      '### 9.2 Behaviours',
      '### 9.3 Survival is a hard constraint',
      '### 9.4 Single-sourced tuning',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('names every competent goal and behaviour id', () => {
    for (const id of [
      'survive',
      'collect-mineral',
      'collect-powerup',
      'engage-enemy',
      'engage-asteroid',
      'reposition',
    ]) {
      expect(doc).toContain(id);
    }
  });

  it('names the competent API and single-source tunables', () => {
    for (const symbol of [
      'createCompetentBotBrain',
      'COMPETENT_BOT_TUNABLES',
      'planSteering',
      'engagementRange',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('records the priority order and the hard-constraint survival model', () => {
    expect(doc).toMatch(/minerals > power-ups > enemies > asteroids/);
    expect(doc).toMatch(/hard constraint/i);
    expect(doc).toMatch(/path-around|path around/i);
  });

  it('references the work item', () => {
    expect(doc).toContain(WORK_ITEM_ID);
  });
});
