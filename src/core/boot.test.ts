/**
 * Boot-path regression tests (AH-0MUESFKCD004SI1V).
 *
 * The defect: `loadConfigs()` existed and was tested, but was never invoked
 * on the runtime boot path, so a ship `controlScheme` saved from the gym
 * reverted to the built-in default on a `npm run dev` restart. These tests
 * assert the boot wrapper hydrates the CSV-backed registry **before** the
 * Phaser game is constructed (so scenes read the persisted value), and that
 * a failed CSV fetch still boots with defaults (AC4).
 *
 * `Game` is mocked so the test observes *when* construction happens relative
 * to hydration without booting a real Phaser instance.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';

vi.mock('./Game', () => ({
  Game: vi.fn(),
}));

import { bootGame } from './boot';
import { Game } from './Game';
import { loadShipConfig, resetConfigStore } from './configStore';
import { DEFAULT_CONFIG } from './configDefaults';

const ENEMY_FILE = 'src/data/enemy-configs.csv';
const SHIP_FILE = 'src/data/ship-config.csv';

const ENEMY_HEADER =
  'key,displayName,formationKind,count,spacingX,spacingY,driftSpeed,startX,startY,size,color,bulletColor,bulletSize,shotPattern,fireInterval,bulletSpeed,bulletLifetime,burstCount,shotProbability';

function enemyCsvFixture(): string {
  return `${ENEMY_HEADER}\nscout,Scout,v,6,26,22,40,240,270,16,0x00ff00,0xff4444,3,aimed,1200,200,1.5,1,1\n`;
}

function shipCsvFixture(controlScheme: string): string {
  return (
    'thrustAcceleration,maxSpeed,shipSize,thrustFlameLength,shipColor,thrustFlameColor,thrustFlameInnerColor,frictionDeceleration,controlScheme,asteroidsRotationSpeed\n' +
    `300,175,20,0.75,0x00ffff,0xff8c00,0xffff00,100,${controlScheme},3\n`
  );
}

/** Minimal fetch mock serving the two committed CSV files. */
function servingCsvs(shipCsv: string) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(ENEMY_FILE)) {
      return new Response(enemyCsvFixture(), { status: 200 });
    }
    if (url.endsWith(SHIP_FILE)) {
      return new Response(shipCsv, { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  });
}

/** Capture `loadShipConfig()` at the exact moment `Game` is constructed. */
function captureSchemeAtConstruction(): () => string | undefined {
  let scheme: string | undefined;
  // A regular (non-arrow) function so `new Game()` remains constructible.
  (Game as unknown as Mock).mockImplementation(function (this: unknown) {
    scheme = loadShipConfig().controlScheme;
    return {};
  });
  return () => scheme;
}

beforeEach(() => {
  resetConfigStore();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv('DEV', true);
  (Game as unknown as Mock).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetConfigStore();
});

describe('bootGame — config hydration before scene boot (AH-0MUESFKCD004SI1V)', () => {
  it('hydrates the registry from the CSV before constructing the game', async () => {
    vi.stubGlobal('fetch', servingCsvs(shipCsvFixture('asteroids')));
    const schemeAtConstruction = captureSchemeAtConstruction();

    await bootGame();

    expect(Game).toHaveBeenCalledTimes(1);
    // At Game construction the registry already reflects the CSV, not
    // DEFAULT_CONFIG — this is the regression the fix addresses.
    expect(schemeAtConstruction()).toBe('asteroids');
  });

  it('defers game construction until async hydration completes', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        await pending;
        const url = typeof input === 'string' ? input : input.toString();
        return new Response(
          url.endsWith(SHIP_FILE) ? shipCsvFixture('asteroids') : enemyCsvFixture(),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);
    captureSchemeAtConstruction();

    const booted = bootGame();
    // Hydration is still in flight: no Game may exist yet.
    expect(Game).not.toHaveBeenCalled();

    release!();
    await booted;
    expect(Game).toHaveBeenCalledTimes(1);
  });

  it('still boots with built-in defaults when the CSV fetch fails (AC4)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const schemeAtConstruction = captureSchemeAtConstruction();

    await expect(bootGame()).resolves.toBeDefined();
    expect(Game).toHaveBeenCalledTimes(1);
    expect(schemeAtConstruction()).toBe(DEFAULT_CONFIG.controlScheme);
  });
});
