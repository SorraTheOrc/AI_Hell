#!/usr/bin/env node
/**
 * Generate the committed weapon-catalogue seed CSVs
 * (`src/data/weapons.csv` + `src/data/weapon-patterns.csv`).
 *
 * The seed is derived from the shipped `WEAPON_CATALOGUE` through the CSV
 * codec's own serialiser, so it can never become a hand-typed second copy of
 * the catalogue: every cell is produced by `serializeWeaponCatalogue`, the
 * same write path the dev tuning panel uses. Run
 * `npm run generate:weapon-csv-seed` after a catalogue change and commit the
 * result; `src/data/weaponsCsvSeed.test.ts` fails if the committed files drift
 * from this generator's output.
 *
 * The generator is a one-off authoring tool, not a runtime path — the game
 * reads the committed files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const dataDir = path.join(repoRoot, 'src/data');

/** The two committed seed files, as repository-relative paths. */
const WEAPON_SEED_FILES = {
  weapons: 'src/data/weapons.csv',
  patterns: 'src/data/weapon-patterns.csv',
};

const server = await createServer({
  root: repoRoot,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true },
});

try {
  const weaponsModule = await server.ssrLoadModule('/src/utils/weapons.ts');
  const csvModule = await server.ssrLoadModule('/src/core/csv.ts');

  const { weaponsCsv, patternsCsv } = csvModule.serializeWeaponCatalogue(
    weaponsModule.WEAPON_CATALOGUE,
  );

  // The committed files keep the repository's trailing-newline convention;
  // `parseCsvRows` skips the resulting empty final line.
  fs.writeFileSync(path.join(dataDir, 'weapons.csv'), `${weaponsCsv}\n`);
  fs.writeFileSync(path.join(dataDir, 'weapon-patterns.csv'), `${patternsCsv}\n`);

  console.log(
    `Wrote ${WEAPON_SEED_FILES.weapons} and ${WEAPON_SEED_FILES.patterns} ` +
      `from ${Object.keys(weaponsModule.WEAPON_CATALOGUE).length} catalogue weapons.`,
  );
} finally {
  await server.close();
}
