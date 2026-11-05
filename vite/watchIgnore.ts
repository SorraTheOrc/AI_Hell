/**
 * Vite file-watcher ignore patterns for AI_Hell (MS-0MVBEQ6MC004WRI0).
 *
 * Canonical single source of truth: the core scaffold's
 * `DEV_WATCH_IGNORE_PATTERNS` in
 * `Tableau-Card-Engine/scripts/vite-transcript-plugin.ts`. AI_Hell has no
 * `core` submodule, so this local list mirrors it; the
 * `vite/viteWatchIgnore.test.ts` guard pins the `.worklog` coverage so drift
 * is caught instead of silently weakening the guard.
 *
 * Why: the Vite/Vitest file watcher recursively traverses
 * `.worklog/worktrees/**` (AI_Hell already carries 9 worktree checkouts plus
 * a nested ToneForge checkout). Under 10+ concurrent worktrees the host
 * `fs.inotify.max_user_watches` budget (typically 8192) is exhausted and the
 * dev server crashes with
 * `ENOSPC: System limit for number of file watchers reached`.
 *
 * The dev-output trees are excluded too: writes into them during a dev
 * session create permanently-retained per-file watchers (unbounded memory
 * growth). The committed config CSVs under `src/data/` are served by the
 * `configCsvPlugin` middleware, not by the watcher, so excluding the data
 * tree does not affect the CSV read/write endpoints.
 */
export const DEV_WATCH_IGNORE_PATTERNS: readonly string[] = [
  // Mirrors the core list.
  '**/data/**',
  '**/tmp/**',
  '**/results/**',
  '**/dist/**',
  '**/dist-electron/**',
  // Worktree checkouts created by the implement/plan/audit skills.
  '**/.worklog/**',
  // AI_Hell-specific generated run artefacts (all .gitignored; see .gitignore
  // for their producers: capture, record, evaluate, perf:measure).
  '**/capture-output/**',
  '**/recordings/**',
  '**/eval-output/**',
  '**/perf-output/**',
] as const;
