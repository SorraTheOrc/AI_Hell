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
 * The second half pins the **enriched promo scenario contract**
 * (AH-0MVSDM30G0092WYC, test-first slice of parent AH-0MVI5XI73000ZVYA's AC5):
 * the richer entry schema, the `kind: 'promo'` resolver union member, the
 * module-load fail-fast guard and the dev-only gating. Those assertions are
 * authored RED under Vitest's `it.fails` (the repo's red-before/green-after
 * convention) and are green only after the scaffold item lands — see the
 * section banner below.
 *
 * @vitest-environment node
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliSpawnEnv } from './cliChildEnv';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('gives every entry a non-empty name and a frozen, non-empty one-line effect', () => {
    expect(CAPTURE_SCENARIOS.length).toBeGreaterThan(0);
    for (const scenario of CAPTURE_SCENARIOS) {
      expect(Object.isFrozen(scenario)).toBe(true);
      expect(typeof scenario.name).toBe('string');
      expect(scenario.name.trim()).not.toBe('');
      expect(scenario.name).not.toContain('\n');
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
    ], { encoding: 'utf8', env: cliSpawnEnv() });

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

// ── Enriched promo scenario contract (AH-0MVSDM30G0092WYC, test-first) ─────
//
// **TEST-FIRST — RED until the scaffold lands.** Authored before the promo
// schema exists (parent AH-0MVI5XI73000ZVYA, AC5). Every genuinely-red
// assertion is wrapped in Vitest's `it.fails` (the repo's red-before/green-
// after convention — see `src/core/csv.test.ts`), so the suite stays green on
// pre-change HEAD; the scaffold item **AH-0MVM4ED003C8ZC** ("Enriched scenario
// registry schema and resolver") flips each `it.fails` back to `it`. A leftover
// `it.fails` fails the suite (an unexpected pass), so the flip is deliberate.
//
// The contract pinned here — the scaffold must match it exactly:
//
// 1. Every registry entry declares `kind`, one of `'boss' | 'defeat' | 'promo'`.
//    The existing three keep their names and effects; `boss`/`boss-four-hits`
//    are `kind: 'boss'` and `defeat` is `kind: 'defeat'`.
// 2. A `kind: 'promo'` entry additionally carries a non-empty `preset`
//    (bot-tuning preset name), a non-empty `promoLevel` (a level reference in
//    the promo wave module) and a non-empty `categories` array drawn from the
//    editorial vocabulary `['weapons', 'pickups', 'enemies', 'boss']`, plus an
//    optional integer `seed` (uint32) for deterministic capture.
// 3. `resolveDevScenario('?scenario=<promo>')` returns exactly
//    `{ kind: 'promo', preset, promoLevel, categories, seed? }`, resolved from
//    the registry entry rather than a hardcoded name list, so registry ↔
//    resolver parity cannot drift; an unregistered name returns `null`.
// 4. A promo entry that violates (2) fails fast at module load, mirroring the
//    existing registry-drift guard.
// 5. `resolveEnabledDevScenario` is the single runtime gate: it returns the
//    resolved scenario only when `import.meta.env.DEV` is true and `null`
//    otherwise, so a promo URL is inert in a production build.
//
// The promo fixtures are injected with `vi.doMock` + `vi.resetModules` (the
// repo's module-substitution convention, see `src/core/botTuningStore.test.ts`)
// so the union member is pinned against a known promo entry before the
// catalogue item registers real ones. A mock that silently failed to apply is
// caught by the green `fails fast at module load when a resolver name is no
// longer registered` test below.

/** Editorial category vocabulary a promo entry may evidence (name-only). */
const EDITORIAL_CATEGORIES = ['weapons', 'pickups', 'enemies', 'boss'];

/** Entry kinds the enriched registry may declare. */
const ENTRY_KINDS = ['boss', 'defeat', 'promo'];

/** One fixture registry entry (raw shape, so absent fields can be modelled). */
type FixtureEntry = Record<string, unknown>;

/** A registered promo fixture carrying the full metadata contract + a seed. */
const PROMO_WITH_SEED: FixtureEntry = {
  name: 'promo-fixture-hook',
  effect: 'Fixture promo: dense horde opened with a weapons-heavy preset.',
  kind: 'promo',
  preset: 'aggressive-hunter',
  promoLevel: 'promo-fixture-hook',
  seed: 12_345,
  categories: ['weapons', 'enemies'],
};

/** A registered promo fixture that omits the optional `seed`. */
const PROMO_WITHOUT_SEED: FixtureEntry = {
  name: 'promo-fixture-seedless',
  effect: 'Fixture promo without a seed: deterministic from the default RNG.',
  kind: 'promo',
  preset: 'cautious-collector',
  promoLevel: 'promo-fixture-seedless',
  categories: ['pickups', 'boss'],
};

/** Today's three scenarios in the intended enriched shape. */
const LEGACY_FIXTURES: FixtureEntry[] = CAPTURE_SCENARIOS.map((scenario) => ({
  name: scenario.name,
  effect: scenario.effect,
  kind: scenario.name === 'defeat' ? 'defeat' : 'boss',
}));

/** The fixture registry the promo parity/gating tests inject. */
const PROMO_REGISTRY: FixtureEntry[] = [
  ...LEGACY_FIXTURES,
  PROMO_WITH_SEED,
  PROMO_WITHOUT_SEED,
];

/** The surface this contract expects `src/core/devScenario` to expose. */
interface PromoContractModule {
  readonly resolveDevScenario: (search: string) => unknown;
  readonly resolveEnabledDevScenario: (search: string) => unknown;
  readonly isDevScenarioEnabled: () => boolean;
}

/** Reads a registry entry as an untyped record (the fields may not exist yet). */
function fieldsOf(entry: unknown): Record<string, unknown> {
  return entry as Record<string, unknown>;
}

/** Returns `entry` without `field` (models a missing required property). */
function withoutField(entry: FixtureEntry, field: string): FixtureEntry {
  const copy = { ...entry };
  delete copy[field];
  return copy;
}

/**
 * Asserts the promo metadata contract (2) on one entry. Shared by the fixture
 * entries and the live registry, so the rule is stated once.
 */
function assertPromoMetadata(entry: FixtureEntry): void {
  const label = String(entry['name']);
  for (const field of ['preset', 'promoLevel']) {
    expect(typeof entry[field], `${label} ${field} must be a string`).toBe(
      'string',
    );
    expect(
      String(entry[field]).trim(),
      `${label} ${field} must be non-empty`,
    ).not.toBe('');
  }

  const categories = entry['categories'];
  expect(Array.isArray(categories), `${label} categories must be an array`).toBe(
    true,
  );
  expect(
    (categories as unknown[]).length,
    `${label} must evidence at least one category`,
  ).toBeGreaterThan(0);
  for (const category of categories as unknown[]) {
    expect(
      EDITORIAL_CATEGORIES,
      `${label} category ${String(category)} must be editorial`,
    ).toContain(category);
  }

  const seed = entry['seed'];
  if (seed !== undefined) {
    expect(typeof seed, `${label} seed must be a number`).toBe('number');
    expect(Number.isInteger(seed), `${label} seed must be an integer`).toBe(
      true,
    );
    expect(seed as number, `${label} seed must be a uint32`).toBeGreaterThanOrEqual(0);
    expect(seed as number, `${label} seed must be a uint32`).toBeLessThanOrEqual(
      0xffffffff,
    );
  }
}

/** The exact resolved promo union member for a fixture entry. */
function expectedPromo(entry: FixtureEntry): Record<string, unknown> {
  const seed = entry['seed'];
  return {
    kind: 'promo',
    preset: entry['preset'],
    promoLevel: entry['promoLevel'],
    categories: entry['categories'],
    ...(seed === undefined ? {} : { seed }),
  };
}

/**
 * Loads a fresh `devScenario` module over a fixture registry.
 *
 * `vi.resetModules()` + `vi.doMock` is the repo's module-substitution
 * convention (`src/core/botTuningStore.test.ts`): the resolver re-evaluates
 * against the injection, and the `finally` drops the mock so later dynamic
 * imports see the real registry again.
 */
async function loadResolverWithRegistry(
  entries: readonly FixtureEntry[],
): Promise<PromoContractModule> {
  vi.resetModules();
  vi.doMock('./capture-scenarios.mjs', () => ({
    CAPTURE_SCENARIOS: entries,
    isRegisteredScenario: (value: unknown) =>
      typeof value === 'string'
      && entries.some((entry) => entry.name === value.trim().toLowerCase()),
    listCaptureScenarios: () => entries.map((entry) => ({ ...entry })),
  }));
  try {
    return (await import(
      '../src/core/devScenario'
    )) as unknown as PromoContractModule;
  } finally {
    vi.doUnmock('./capture-scenarios.mjs');
  }
}

afterEach(() => {
  vi.doUnmock('./capture-scenarios.mjs');
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('enriched registry entry contract (AH-0MVSDM30G0092WYC, AC1)', () => {
  it.fails('declares a known kind on every registered entry', () => {
    for (const scenario of CAPTURE_SCENARIOS) {
      expect(
        ENTRY_KINDS,
        `entry ${scenario.name} must declare a kind`,
      ).toContain(fieldsOf(scenario)['kind']);
    }
  });

  it.fails('keeps the existing three scenarios with their names and kinds', () => {
    expect(
      CAPTURE_SCENARIOS.map((scenario) => {
        const entry = fieldsOf(scenario);
        return { name: entry['name'], kind: entry['kind'] };
      }),
    ).toEqual([
      { name: 'boss', kind: 'boss' },
      { name: 'boss-four-hits', kind: 'boss' },
      { name: 'defeat', kind: 'defeat' },
    ]);
  });

  it('gives every promo-kind entry non-empty preset/promoLevel, categories and an optional uint32 seed', () => {
    // The fixture registry keeps this rule non-vacuous before the catalogue
    // item registers real promo entries; the live registry is held to the
    // same rule so an authored entry cannot skip the metadata.
    const fixturePromos = PROMO_REGISTRY.filter(
      (entry) => entry['kind'] === 'promo',
    );
    expect(fixturePromos.length).toBe(2);
    for (const entry of fixturePromos) assertPromoMetadata(entry);

    for (const scenario of CAPTURE_SCENARIOS) {
      const entry = fieldsOf(scenario);
      if (entry['kind'] !== 'promo') continue;
      assertPromoMetadata(entry);
    }
  });
});

describe('promo resolution parity (AH-0MVSDM30G0092WYC, AC2)', () => {
  it.fails('resolves a registered promo scenario to the promo union member', async () => {
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    expect(
      resolver.resolveDevScenario(`?scenario=${String(PROMO_WITH_SEED['name'])}`),
    ).toEqual(expectedPromo(PROMO_WITH_SEED));
  });

  it.fails('omits the optional seed when the registry entry declares none', async () => {
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    const resolved = resolver.resolveDevScenario(
      `?scenario=${String(PROMO_WITHOUT_SEED['name'])}`,
    ) as Record<string, unknown> | null;
    expect(resolved).toEqual(expectedPromo(PROMO_WITHOUT_SEED));
    expect(resolved !== null && 'seed' in resolved).toBe(false);
  });

  it('returns null for an unregistered, blank or absent scenario', async () => {
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    expect(resolver.resolveDevScenario('?scenario=not-a-scenario')).toBeNull();
    expect(resolver.resolveDevScenario('?scenario=')).toBeNull();
    expect(resolver.resolveDevScenario('')).toBeNull();
  });

  it('keeps the boss and defeat scenarios resolving exactly as before', async () => {
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    expect(resolver.resolveDevScenario(`?scenario=${DEV_SCENARIO_BOSS}`)).toEqual(
      { kind: 'boss', bossHitsRemaining: DEV_BOSS_DEFAULT_HITS },
    );
    expect(
      resolver.resolveDevScenario(`?scenario=${DEV_SCENARIO_BOSS_FOUR_HITS}`),
    ).toEqual({ kind: 'boss', bossHitsRemaining: DEV_BOSS_DEFAULT_HITS });
    expect(
      resolver.resolveDevScenario(`?scenario=${DEV_SCENARIO_DEFEAT}`),
    ).toEqual({ kind: 'defeat' });
  });

  it('fails fast at module load when a resolver name is no longer registered', async () => {
    // Doubles as the module-mock sentinel: if the injection did not apply,
    // the real registry would still hold `boss` and this assertion would fail.
    const registryWithoutBoss = PROMO_REGISTRY.filter(
      (entry) => entry['name'] !== 'boss',
    );
    await expect(loadResolverWithRegistry(registryWithoutBoss)).rejects.toThrow(
      /not in CAPTURE_SCENARIOS/,
    );
  });

  // One expected-fail per malformed promo entry, so a partial scaffold cannot
  // hide an unvalidated field behind a single loop's first failure.
  const BROKEN_PROMO_ENTRIES: { label: string; entry: FixtureEntry; pattern: RegExp }[] = [
    {
      label: 'a missing preset',
      entry: withoutField(PROMO_WITH_SEED, 'preset'),
      pattern: /preset/,
    },
    {
      label: 'a blank promoLevel',
      entry: { ...PROMO_WITH_SEED, promoLevel: '   ' },
      pattern: /promoLevel/,
    },
    {
      label: 'a missing categories array',
      entry: withoutField(PROMO_WITH_SEED, 'categories'),
      pattern: /categor/i,
    },
    {
      label: 'an unknown editorial category',
      entry: { ...PROMO_WITH_SEED, categories: ['weapons', 'cutscenes'] },
      pattern: /categor/i,
    },
    {
      label: 'a non-integer seed',
      entry: { ...PROMO_WITH_SEED, seed: 1.5 },
      pattern: /seed/,
    },
  ];

  for (const { label, entry, pattern } of BROKEN_PROMO_ENTRIES) {
    it.fails(
      `fails fast at module load for a promo entry with ${label}`,
      async () => {
        await expect(
          loadResolverWithRegistry([...LEGACY_FIXTURES, entry]),
        ).rejects.toThrow(pattern);
      },
    );
  }
});

describe('promo dev gating (AH-0MVSDM30G0092WYC, AC3)', () => {
  const search = `?scenario=${String(PROMO_WITH_SEED['name'])}`;

  it.fails('resolves a promo scenario only when import.meta.env.DEV is true', async () => {
    vi.stubEnv('DEV', true);
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    expect(resolver.isDevScenarioEnabled()).toBe(true);
    expect(resolver.resolveEnabledDevScenario(search)).toEqual(
      expectedPromo(PROMO_WITH_SEED),
    );
  });

  it.fails('is inert for a promo scenario when import.meta.env.DEV is false', async () => {
    vi.stubEnv('DEV', false);
    const resolver = await loadResolverWithRegistry(PROMO_REGISTRY);
    expect(resolver.isDevScenarioEnabled()).toBe(false);
    expect(resolver.resolveEnabledDevScenario(search)).toBeNull();
  });
});
