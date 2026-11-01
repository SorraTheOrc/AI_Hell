#!/usr/bin/env node
/**
 * Generate the per-wave generation-mode ledger published in the Game Design
 * Document (AH-0MVSE7GWU0074H5I).
 *
 * The ledger is derived from the shipped default difficulty curve through the
 * Vite module graph, so it can never become a hand-maintained second copy of
 * the mode data. The generated block is delimited by
 * `<!-- MODE_LEDGER_START -->` / `<!-- MODE_LEDGER_END -->` in
 * `docs/Game Design Document.md`; run `npm run generate:mode-ledger` after a
 * config or role change and commit the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const docPath = path.join(repoRoot, 'docs/Game Design Document.md');

const server = await createServer({
  root: repoRoot,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true },
});

try {
  const ledgerModule = await server.ssrLoadModule('/src/waves/modeLedger.ts');
  const generated = ledgerModule.renderModeLedgerBlock();
  const doc = fs.readFileSync(docPath, 'utf8');
  const existing = ledgerModule.extractModeLedgerBlock(doc);

  if (existing === null) {
    console.error(
      `No ${ledgerModule.MODE_LEDGER_START} / ${ledgerModule.MODE_LEDGER_END} markers found in ${docPath}.`,
    );
    process.exitCode = 1;
  } else if (existing === generated) {
    console.log('Mode ledger already up to date.');
  } else {
    fs.writeFileSync(docPath, doc.replace(existing, generated));
    console.log(`Updated the mode ledger in ${docPath}.`);
  }
} finally {
  await server.close();
}
