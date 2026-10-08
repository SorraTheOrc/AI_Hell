/**
 * Docs guard for content-adaptive configuration
 * (AH-0MUY08X98002TRHT, AC6).
 *
 * The "how to teach the bot about new content" guide lives in
 * `docs/BOT_FRAMEWORK.md` section 11. This guard fails if that section — or
 * the key content the acceptance criteria require — is removed or weakened.
 *
 * Like the sibling docs guards, this is a deliberate docs grep: it asserts the
 * canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/BOT_FRAMEWORK.md');
const WORK_ITEM_ID = 'AH-0MUY08X98002TRHT';

describe('content-adaptive configuration is documented (AH-0MUY08X98002TRHT)', () => {
  it('the framework document exists (AC6)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('documents how to teach the bot about new content (AC6)', () => {
    for (const heading of [
      '## 11. Teaching the bot about new content',
      '### 11.1 Enemy archetype profiles',
      '### 11.2 Power-up / weapon drop profiles',
      '### 11.3 Registering synthetic or custom content',
      '### 11.4 Unknown content',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('names the content API and profile fields (AC1/AC2)', () => {
    for (const symbol of [
      'EnemyContentProfile',
      'DropContentProfile',
      'BotContent',
      'createBotContent',
      'createCompetentBotBrain',
      'COMPETENT_BOT_CONTENT',
      'asteroidLike',
      'threat',
      'engagementRange',
      'aim',
      'value',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('documents the unknown-content default (AC4)', () => {
    expect(doc).toMatch(/DEFAULT_ENEMY_PROFILE/);
    expect(doc).toMatch(/DEFAULT_DROP_PROFILE/);
    expect(doc).toMatch(/unknown/i);
  });

  it('references the work item', () => {
    expect(doc).toContain(WORK_ITEM_ID);
  });
});
