/**
 * Docs guard for multi-scene capture (AH-0MVFC748B00472MB, parent
 * AH-0MUX2NLFZ00128WC AC5/AC6).
 *
 * `npm run capture:scenes` is only discoverable through the developer docs, so
 * the config schema, entry point, fade behaviour, output naming and `--json`
 * contract have to stay documented and in step with the code. This guard fails
 * if that documentation is removed or weakened, or if the documented scene
 * registry / fade duration drifts from `scripts/capture-scenes.mjs`.
 *
 * Like the sibling `promoCompileDocs.test.ts` / `actionIntensityDocs.test.ts`,
 * this is a deliberate docs grep: it asserts the canonical documentation text,
 * and the numbers/keys are imported from the module rather than hard-coded so
 * a code change fails the doc instead of silently diverging.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PARAMETERISED_GYM_SCENE_KEYS,
  SCENE_CONFIG_ERROR_CODES,
  SCENE_FADE_MS,
  SCENE_SETUP_COMMON_FIELDS,
  SCENE_SETUP_TARGET_EXTRA_FIELDS,
  WATCHABLE_GYM_SCENE_KEYS,
  parseSceneConfig,
} from '../scripts/capture-scenes.mjs';

const DOC_PATH = path.resolve(process.cwd(), 'docs/dev/gameplay-capture.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const PACKAGE_PATH = path.resolve(process.cwd(), 'package.json');

const captureDoc = fs.existsSync(DOC_PATH)
  ? fs.readFileSync(DOC_PATH, 'utf8')
  : '';
const readme = fs.existsSync(README_PATH)
  ? fs.readFileSync(README_PATH, 'utf8')
  : '';
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as {
  scripts: Record<string, string>;
};

describe('Multi-scene capture is documented (AH-0MVFC748B00472MB)', () => {
  it('documents the entry point and config schema (AC5)', () => {
    expect(captureDoc).toMatch(/## Multi-scene capture \(`capture:scenes`\)/);
    expect(captureDoc).toContain('npm run capture:scenes -- --config');
    // The npm entry point the docs promise actually exists.
    expect(pkg.scripts['capture:scenes']).toBeDefined();
    expect(pkg.scripts['capture:scenes']).toContain(
      'scripts/capture-gameplay.mjs',
    );
    // Every config field is documented with a worked JSON example.
    for (const field of ['target', 'playMs', 'captureMs', 'label']) {
      expect(captureDoc).toContain(`\`${field}\``);
    }
    expect(captureDoc).toMatch(/```json[\s\S]*"scenes"[\s\S]*```/);
  });

  it('keeps the documented scene registry in step with the code (AC5)', () => {
    for (const key of WATCHABLE_GYM_SCENE_KEYS) {
      expect(captureDoc).toContain(key);
    }
    // The parameterised scenes are documented as rejected, not capturable.
    for (const key of PARAMETERISED_GYM_SCENE_KEYS) {
      expect(captureDoc).toContain(key);
    }
    expect(captureDoc).toContain('unsupported-target');
  });

  it('documents the fade and timing contract (AC5)', () => {
    expect(captureDoc).toContain(`${SCENE_FADE_MS} ms`);
    expect(captureDoc).toMatch(/0\.25 s/);
    expect(captureDoc).toMatch(/fade to black/i);
    expect(captureDoc).toMatch(/fade from black/i);
  });

  it('documents the single-output and --json contract (AC5)', () => {
    expect(captureDoc).toContain('capture-output/scenes-<ISO-timestamp>.webm');
    expect(captureDoc).toContain('960×540');
    for (const field of [
      'outputPath',
      'sceneCount',
      'fadeMs',
      'totalMs',
      'startMs',
      'endMs',
      'fadeVerified',
    ]) {
      // The keys appear both in prose (backticked) and in the `--json`
      // example (double-quoted), so either spelling satisfies the guard.
      expect(captureDoc).toMatch(new RegExp(`["\`]${field}[\"\`]`));
    }
  });

  it('is cross-linked from the README (AC6)', () => {    expect(readme).toContain('capture:scenes');
    expect(readme).toContain('--config');
    expect(readme).toContain(
      'docs/dev/gameplay-capture.md#multi-scene-capture-capturescenes',
    );
    expect(readme).toContain('0.25 s');
  });

  it('documents the one-scene-at-a-time guarantee (AH-0MVNWJ5FH006QD8V)', () => {
    // The scene-stacking fix must stay documented so a future capture-scene
    // author knows that stopping every other scene is intentional.
    expect(captureDoc).toMatch(/exactly one scene is running/i);
    expect(captureDoc).toMatch(/registration order/);
    expect(captureDoc).toMatch(/Scenes are stopped, not slept/);
  });

  it('documents every setup field the parser accepts (two-way parity)', () => {
    const fields = new Set<string>([
      ...SCENE_SETUP_COMMON_FIELDS,
      ...Object.values(SCENE_SETUP_TARGET_EXTRA_FIELDS).flat(),
    ]);
    for (const field of fields) {
      expect(captureDoc).toContain(`\`${field}\``);
    }
    // The nested player fields are documented too.
    expect(captureDoc).toContain('`player.weapons`');
    expect(captureDoc).toContain('`player.timedWeapons`');
  });

  it('documents every setup error code the parser can raise', () => {
    for (const code of [
      'unknown-setup-field',
      'invalid-setup-type',
      'unknown-enemy-key',
      'unknown-formation-kind',
      'unknown-weapon-id',
      'unknown-power-up-id',
      'invalid-level-index',
      'invalid-wave-index',
      'missing-setup-parameter',
      'setup-not-supported',
      'invalid-seed',
    ]) {
      expect(Object.values(SCENE_CONFIG_ERROR_CODES)).toContain(code);
      expect(captureDoc).toContain(`\`${code}\``);
    }
  });

  it('ships a documented setup example that the parser accepts', () => {
    // Extract the setup-bearing JSON block from the docs and validate it, so
    // the worked example cannot drift away from the schema.
    const blocks = [...captureDoc.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    const setupBlock = blocks.find((block) => block.includes('"setup"'));
    expect(setupBlock).toBeDefined();
    const parsed = parseSceneConfig(JSON.parse(setupBlock as string));
    expect(parsed.length).toBeGreaterThan(0);
    const level = parsed.find((scene) => scene.target === 'GymLevel');
    expect(level?.setup?.level?.level).toBe(4);
    expect(level?.setup?.seed).toBe(42);
  });

  it('keeps examples/scenes.json valid and setup-bearing', () => {
    const examplePath = path.resolve(process.cwd(), 'examples/scenes.json');
    const parsed = parseSceneConfig(fs.readFileSync(examplePath, 'utf8'));
    const withSetup = parsed.filter((scene) => scene.setup !== undefined);
    expect(withSetup.length).toBeGreaterThanOrEqual(1);
    expect(withSetup.some((scene) => scene.target === 'GymLevel')).toBe(true);
    expect(withSetup.some((scene) => scene.target === 'GymFodderEnemies')).toBe(true);
  });
});
