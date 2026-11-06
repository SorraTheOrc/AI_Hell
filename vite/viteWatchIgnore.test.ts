/**
 * Regression guard: AI_Hell's local Vite watcher-ignore list must cover
 * `.worklog/**` (the ENOSPC failure mode) plus the core dev-output trees, and
 * the checked-in `vite.config.ts` must wire that list into `server.watch`.
 *
 * AI_Hell has no `core` submodule, so it duplicates the core
 * `DEV_WATCH_IGNORE_PATTERNS` list locally (`vite/watchIgnore.ts`). This guard
 * fails loudly if the local list drifts away from the patterns the core
 * template guarantees (MS-0MVBEQ6MC004WRI0, parent MS-0MV8M9IAF000KPNY).
 *
 * Static assertions only — no dev-server startup here (the in-process
 * `server.watcher.getWatched()` smoke lives once, in tce-main-street).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEV_WATCH_IGNORE_PATTERNS } from './watchIgnore';

const REPO_ROOT = process.cwd();
const CONFIG_PATH = path.join(REPO_ROOT, 'vite.config.ts');

describe('vite watch-ignore ENOSPC guard', () => {
  it('the local ignore list covers .worklog (the ENOSPC failure mode)', () => {
    expect(DEV_WATCH_IGNORE_PATTERNS).toContain('**/.worklog/**');
  });

  it('the local ignore list keeps the core dev-output coverage', () => {
    expect(DEV_WATCH_IGNORE_PATTERNS).toContain('**/data/**');
    expect(DEV_WATCH_IGNORE_PATTERNS).toContain('**/tmp/**');
    expect(DEV_WATCH_IGNORE_PATTERNS).toContain('**/results/**');
    expect(DEV_WATCH_IGNORE_PATTERNS).toContain('**/dist/**');
  });

  it('vite.config.ts wires the local list into server.watch.ignored', () => {
    const src = fs.readFileSync(CONFIG_PATH, 'utf-8');
    expect(src).toMatch(
      /import \{[^}]*DEV_WATCH_IGNORE_PATTERNS[^}]*\} from '\.\/vite\/watchIgnore'/,
    );
    expect(src).toContain('ignored: [...DEV_WATCH_IGNORE_PATTERNS]');
  });
});
