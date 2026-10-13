/**
 * Hermetic tests for the shared dev-capture scenario registry
 * (AH-0MV6JGE9R005YOL1, foundation child of AH-0MUZM8ATZ002AKFP).
 *
 * The registry (`scripts/capture-scenarios.mjs`) is the single source of
 * truth for the implemented dev capture scenarios: the game resolver
 * (`src/core/devScenario.ts`) and the capture CLI both read it, so the list
 * cannot drift. These tests pin the registry contents (frozen, exactly the
 * three implemented scenario values, each with a one-line effect) and the
 * registry ↔ resolver parity: every registered name resolves through
 * `resolveDevScenario`, and every value the resolver knows is registered.
 * No browser (or Vite/Chromium) is booted: the module is plain ESM that also
 * imports under bare Node.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CAPTURE_SCENARIOS,
  isRegisteredScenario,
} from './capture-scenarios.mjs';
import {
  DEV_BOSS_DEFAULT_HITS,
  DEV_SCENARIO_BOSS,
  DEV_SCENARIO_BOSS_FOUR_HITS,
  DEV_SCENARIO_DEFEAT,
  resolveDevScenario,
} from '../src/core/devScenario';

/** The scenario names the resolver knows (its exported dev-gated values). */
const RESOLVER_NAMES = [
  DEV_SCENARIO_BOSS,
  DEV_SCENARIO_BOSS_FOUR_HITS,
  DEV_SCENARIO_DEFEAT,
];

describe('CAPTURE_SCENARIOS registry', () => {
  it('is frozen and holds exactly the implemented scenario values', () => {
    expect(Object.isFrozen(CAPTURE_SCENARIOS)).toBe(true);
    expect(CAPTURE_SCENARIOS.map((scenario) => scenario.name)).toEqual([
      'boss',
      'boss-four-hits',
      'defeat',
    ]);
  });

  it('registers every entry once', () => {
    const names = CAPTURE_SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every entry a frozen, non-empty one-line effect', () => {
    expect(CAPTURE_SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of CAPTURE_SCENARIOS) {
      expect(Object.isFrozen(scenario)).toBe(true);
      expect(typeof scenario.effect).toBe('string');
      expect(scenario.effect.trim()).not.toBe('');
      expect(scenario.effect).not.toContain('\n');
    }
  });

  it('does not depend on a DOM, a bundler or Node built-ins to import', () => {
    // The capture CLI runs this module under bare `node` (no Vite/TS loader),
    // so the browser-free constraint is asserted by importing it in a real
    // Node child process and reading a registered value back.
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/capture-scenarios.mjs'),
    ).href;
    const script = `import(${JSON.stringify(moduleUrl)}).then((m) => `
      + `process.stdout.write(String(m.CAPTURE_SCENARIOS.length)))`;
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
    ], { encoding: 'utf8' });

    expect(output.trim()).toBe(String(CAPTURE_SCENARIOS.length));
  });
});

describe('isRegisteredScenario', () => {
  it('recognises every registered name', () => {
    for (const { name } of CAPTURE_SCENARIOS) {
      expect(isRegisteredScenario(name)).toBe(true);
    }
  });

  it('is case- and whitespace-insensitive, matching the resolver', () => {
    expect(isRegisteredScenario('BOSS')).toBe(true);
    expect(isRegisteredScenario('  boss-four-hits ')).toBe(true);
  });

  it('rejects unknown, blank and non-string inputs', () => {
    expect(isRegisteredScenario('nope')).toBe(false);
    expect(isRegisteredScenario('')).toBe(false);
    expect(isRegisteredScenario(undefined)).toBe(false);
    expect(isRegisteredScenario(null)).toBe(false);
  });
});

describe('registry ↔ resolver parity', () => {
  it('resolves every registered scenario name through resolveDevScenario', () => {
    for (const { name } of CAPTURE_SCENARIOS) {
      expect(resolveDevScenario(`?scenario=${name}`)).not.toBeNull();
    }
  });

  it('registers every value the resolver knows', () => {
    for (const name of RESOLVER_NAMES) {
      expect(isRegisteredScenario(name)).toBe(true);
      expect(CAPTURE_SCENARIOS.map((scenario) => scenario.name)).toContain(
        name,
      );
    }
  });

  it('covers exactly the same name set as the resolver (no drift either way)', () => {
    expect(new Set(RESOLVER_NAMES)).toEqual(
      new Set(CAPTURE_SCENARIOS.map((scenario) => scenario.name)),
    );
  });

  it('maps each registered name to its expected scenario', () => {
    expect(resolveDevScenario(`?scenario=${DEV_SCENARIO_BOSS}`)).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
    expect(
      resolveDevScenario(`?scenario=${DEV_SCENARIO_BOSS_FOUR_HITS}`),
    ).toEqual({
      kind: 'boss',
      bossHitsRemaining: DEV_BOSS_DEFAULT_HITS,
    });
    expect(resolveDevScenario(`?scenario=${DEV_SCENARIO_DEFEAT}`)).toEqual({
      kind: 'defeat',
    });
  });
});
