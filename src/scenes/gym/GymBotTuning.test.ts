/**
 * AH-0MV4D7LAD009XYR0 — bot-tuning gym scene.
 *
 * Verifies the scene is discoverable, that its panel exposes one control per
 * tunable, that the bot actually plays the generated level, and that the
 * Save / Save As / Load wiring persists and restores configurations.
 *
 * ## Deterministic boot (AH-0MVF1M4PB0080GEP)
 *
 * Every scene here boots through {@link bootScene} (deterministic boot is
 * now the default) and its live loop is stopped before the tuning scene is
 * restarted, so no wall-clock frames drain between `create()` and a test's
 * first assertion. The legacy real-time boot waited 150 ms + 200 ms of
 * wall-clock while the rAF loop ran an unpredictable
 * number of frames; under full-suite test-slot contention that both shifted
 * the bot's start state and stretched `has the bot play the generated random
 * level`'s 300-frame synchronous drain past Vitest's 5 s timeout (it failed
 * at 6079 ms). Fixed-delta stepping makes the bot's start state identical on
 * every run, and the play assertion exits as soon as the bot demonstrably
 * fires (the 300-frame budget stays as the hard bound), so the synchronous
 * work no longer scales with host load. See `src/test/gameHarness.ts`
 * (AH-0MUHA0MMP001DZ5C).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { ViteDevServer } from 'vite';

import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import {
  BOT_TUNING_CONFIG_SELECT_ID,
  BOT_TUNING_EXPORT_ID,
  BOT_TUNING_PANEL_ID,
  BOT_TUNING_SAVE_AS_ID,
  BOT_TUNING_SAVE_AS_INPUT_ID,
  BOT_TUNING_SAVE_ID,
  BOT_TUNING_SAVE_TO_REPO_ID,
  BOT_TUNING_SLIDER_ATTR,
  BOT_TUNING_SLIDER_VALUE_ATTR,
  BOT_TUNING_STATUS_ID,
  BOT_TUNING_TOGGLE_ATTR,
  GYM_BOT_TUNING_SCENE_KEY,
  GymBotTuning,
  type GymBotTuningData,
} from './GymBotTuning';
import {
  BOT_TUNING_NUMERIC_FIELDS,
  BOT_TUNING_TOGGLES,
} from '../../ai/tuningFields';
import {
  COMPETENT_BOT_TUNABLES,
  buildBotWorld,
  createCompetentBotBrain,
} from '../../ai/framework';
import { buildBotSnapshot } from '../../ai/botSnapshot';
import { createSeededRng } from '../../core/rng';
import { computeSpawns } from '../../waves/AsteroidSpawner';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import { evaluateDirection } from '../../ai/framework/competent';
import {
  bullet,
  DEFAULT_THRUSTER_CONFIG,
  makeThrusterSnapshot,
} from '../../ai/framework/testFixtures';
import {
  listBotTuningNames,
  resetBotTuningStore,
  serialiseBotTuningState,
} from '../../core/botTuningStore';
import { BOT_TUNING_FILE_PATH } from '../../core/botTuningSchema';
import { botTuningPlugin } from '../../../vite/plugins/botTuningPlugin';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import {
  GYM_TOOLTIP_CLASS,
  GYM_TOOLTIP_VISIBLE_CLASS,
} from '../../utils/gymTooltip';
import { GYM_LEVEL_MINERAL_SEED_COUNT } from './GymLevel';
import { Diver } from '../../entities/Diver';
import { Harvester } from '../../entities/Harvester';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';

/** A single-group, non-firing scout wave. */
function scoutWave(count: number): WaveDefinition {
  return {
    groups: [
      {
        enemyKey: 'scout',
        formation: 'v',
        count,
        spacingX: 30,
        spacingY: 26,
        startX: 200,
        startY: 150,
      },
    ],
    shootEnabled: false,
  };
}

/** Wraps waves in a level definition. */
function makeLevel(name: string, waves: WaveDefinition[]): LevelDefinition {
  return { level: 1, name, waves };
}

// ── Dev write-back harness (AH-0MVBJ0DUI009B6AM) ────────────────────

const writeBackServers: Server[] = [];
const writeBackRoots: string[] = [];

/** A temp project root whose committed baseline is the current store Export. */
function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'gym-bot-tuning-writeback-'));
  const filePath = join(root, BOT_TUNING_FILE_PATH);
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, `${serialiseBotTuningState()}\n`);
  writeBackRoots.push(root);
  return root;
}

/** Runs the dev-only bot-tuning endpoint against `root`; returns its base URL. */
function startBotTuningServer(root: string): Promise<string> {
  const plugin = botTuningPlugin({ root });
  let middleware: ((req: unknown, res: unknown, next: () => void) => void) | null =
    null;
  const configureServer = plugin.configureServer as
    | ((server: ViteDevServer) => void)
    | undefined;
  configureServer?.({
    config: { command: 'serve', mode: 'development' },
    middlewares: {
      use: (fn: (req: unknown, res: unknown, next: () => void) => void) => {
        middleware = fn;
      },
    },
  } as unknown as ViteDevServer);

  const httpServer = createServer((req, res) => {
    if (!middleware) {
      res.statusCode = 404;
      res.end();
      return;
    }
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  writeBackServers.push(httpServer);

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port =
        typeof address === 'object' && address !== null ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * Route the store's fetches through the plugin server with Node's HTTP
 * client, skipping the happy-dom browser fetch (whose same-origin policy
 * rejects cross-origin 127.0.0.1 requests from the `localhost:3000`
 * document). The middleware and the file I/O are still exercised for real.
 */
function installFetchBridge(baseUrl: string): void {
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) => {
      const urlObj = new URL(String(input), baseUrl);
      return new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          urlObj,
          {
            method: init?.method ?? 'GET',
            headers: init?.headers as Record<string, string> | undefined,
          },
          (res: IncomingMessage) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const headers = new Headers();
              for (const [key, value] of Object.entries(res.headers)) {
                if (value !== undefined) headers.set(key, String(value));
              }
              resolve(
                new Response(Buffer.concat(chunks).toString('utf8'), {
                  status: res.statusCode ?? 500,
                  headers,
                }),
              );
            });
          },
        );
        req.on('error', reject);
        if (init?.body) req.write(String(init.body));
        req.end();
      });
    },
  );
}

function readWrittenBaseline(root: string): string {
  return readFileSync(join(root, BOT_TUNING_FILE_PATH), 'utf8');
}

/** Waits for Phaser scene transitions to settle. */

describe('GymBotTuning — AI bot tuning gym (AH-0MV4D7LAD009XYR0)', () => {
  let booted: BootedGame | null = null;

  const tick = () => advanceGame(booted!.game, 200);

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    resetBotTuningStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    for (const s of writeBackServers.splice(0)) s.close();
    for (const root of writeBackRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function bootTuning(data?: GymBotTuningData): Promise<GymBotTuning> {
    // Deterministic boot (fixed-delta steps, no wall-clock settle) and a
    // stopped live loop: `SceneManager.start` runs `init()` + `create()`
    // synchronously, so the restarted scene's generated level (and its first
    // wave) exists the moment this resolves — no frame drain can shift it.
    booted = await bootScene([GymBotTuning]);
    booted.game.loop.stop();
    const manager = booted.game.scene;
    manager.start(GYM_BOT_TUNING_SCENE_KEY, data);
    return manager.getScene(GYM_BOT_TUNING_SCENE_KEY) as GymBotTuning;
  }

  it('is discovered by the gym index glob', () => {
    const keys = discoverGymScenes(loadGymSceneModules()).map((entry) => entry.key);
    expect(keys).toContain(GYM_BOT_TUNING_SCENE_KEY);
  });

  it('builds a panel with one control per declared tunable', async () => {
    await bootTuning({ seed: 101 });

    const panel = document.getElementById(BOT_TUNING_PANEL_ID);
    expect(panel).not.toBeNull();

    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      expect(
        panel!.querySelector(`input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`),
      ).not.toBeNull();
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      expect(
        panel!.querySelector(`input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`),
      ).not.toBeNull();
    }

    const select = document.getElementById(BOT_TUNING_CONFIG_SELECT_ID) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain('Default');
  });

  it('has the bot play the generated random level', async () => {
    const scene = await bootTuning({ seed: 4242 });
    booted!.game.loop.stop();

    expect(scene.getEnemies().length).toBeGreaterThan(0);
    const startX = scene.getShip()!.getMovementState().x;
    const startY = scene.getShip()!.getMovementState().y;

    // Stop as soon as the bot demonstrably fires: the assertion is satisfied
    // by either observable, and draining all 300 frames synchronously pushed
    // the test past Vitest's 5 s timeout on a contended test slot
    // (AH-0MVF1M4PB0080GEP). The 300-frame budget remains the hard bound.
    let fired = false;
    for (let i = 0; i < 300 && !fired; i += 1) {
      scene.tick(1 / 60);
      if (scene.getPlayerBullets().length > 0) fired = true;
    }

    const end = scene.getShip()!.getMovementState();
    const moved = Math.hypot(end.x - startX, end.y - startY) > 5;
    // The bot drives the ship through the shared seam and auto-fires.
    expect(moved || fired).toBe(true);
  });

  it('applies a slider change live and updates its readout', async () => {
    const scene = await bootTuning({ seed: 7 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '900';
    input.dispatchEvent(new Event('input'));

    const output = document.querySelector<HTMLElement>(
      `output[${BOT_TUNING_SLIDER_VALUE_ATTR}="powerUpSeekRange"]`,
    )!;
    expect(output.textContent).toBe('900');
    // The scene keeps running after the live rebuild.
    expect(scene.getShip()).not.toBeNull();
    expect(() => scene.tick(1 / 60)).not.toThrow();
  });

  it('Save As persists a named configuration and Load restores it', async () => {
    await bootTuning({ seed: 9 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '750';
    input.dispatchEvent(new Event('input'));

    const nameInput = document.getElementById(BOT_TUNING_SAVE_AS_INPUT_ID) as HTMLInputElement;
    nameInput.value = 'PowerUp-Rush';
    document
      .getElementById(BOT_TUNING_SAVE_AS_ID)!
      .dispatchEvent(new MouseEvent('click'));

    expect(listBotTuningNames()).toContain('PowerUp-Rush');
    const select = document.getElementById(BOT_TUNING_CONFIG_SELECT_ID) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain('PowerUp-Rush');

    // Change the slider, then load the saved config back.
    input.value = '100';
    input.dispatchEvent(new Event('input'));
    select.value = 'PowerUp-Rush';
    select.dispatchEvent(new Event('change'));

    expect(input.value).toBe('750');
  });

  // ── AC11 — shared supply layer (producer-audit fix) ─────────────

  it('seeds the shared mineral field and exposes the live supplies to the bot snapshot', async () => {
    const scene = await bootTuning({ seed: 2024 });
    booted!.game.loop.stop();

    // The inherited `GymLevel` supply layer seeded the game's mineral field.
    expect(scene.getSeededMineralCount()).toBe(GYM_LEVEL_MINERAL_SEED_COUNT);
    expect(scene.getMinerals().length).toBeGreaterThan(0);

    // The bot snapshot sees the live minerals and drops, so its
    // `collect-mineral` / `collect-powerup` / `secure-life` goals can fire.
    const snapshot = scene.getBotSnapshot();
    expect(snapshot.minerals.length).toBeGreaterThan(0);
    expect(snapshot.drops.length).toBeGreaterThan(0);
  });

  it('carries the live ship thruster config into the bot snapshot (AH-0MV85WFWD0029DL7)', async () => {
    const scene = await bootTuning({ seed: 303 });
    booted!.game.loop.stop();

    const snapshot = scene.getBotSnapshot();
    // The gym's player satisfies the `BotPlayerSource` seam, so the snapshot
    // player carries the ship's effective thruster physics unchanged.
    expect(snapshot.player!.thruster).toEqual(
      scene.getShip()!.getThrusterConfig(),
    );
  });

  it('applies a slider override that wins over the live ship config via resolveCompetentTunables (AH-0MV85WH2V005NZTX)', async () => {
    const scene = await bootTuning({ seed: 505 });
    booted!.game.loop.stop();

    // The gym's snapshot player carries the *live* ship config.
    const live = scene.getBotSnapshot().player!.thruster!;
    expect(live.maxSpeed).toBe(175);

    // With the sliders untouched the applied tunables equal the compiled
    // defaults, so the panelless bot is a pure fallback: the live config wins
    // at decision time (never authoritative).
    expect(scene.getAppliedBotTunables().playerSpeed).toBe(
      COMPETENT_BOT_TUNABLES.playerSpeed,
    );

    // The designer drags the playerSpeed slider to an explicit override; the
    // gym rebuilds the live brain, exactly as PlayScene rebuilds the demo
    // brain from the persisted store.
    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="playerSpeed"]`,
    )!;
    input.value = '250';
    input.dispatchEvent(new Event('input'));

    const applied = scene.getAppliedBotTunables();
    expect(applied.playerSpeed).toBe(250);

    // The override reaches the decision layer through resolveCompetentTunables
    // — the same seam PlayScene uses — and wins over the live ship config: a
    // trailing 100 px/s shot on the +x bearing clears at the live 150 cap (75
    // px > threat radius 55) but is intercepted at the 250 override.
    const world = buildBotWorld(
      makeThrusterSnapshot(
        { ...DEFAULT_THRUSTER_CONFIG, maxSpeed: 150 },
        {
          player: { x: 480, y: 270, vx: 0, vy: 0 },
          enemyBullets: [bullet(600, 270, 100, 0)],
        },
      ),
    );
    // Sanity: the same snapshot with the compiled defaults (live 150 wins)
    // stays clear, proving the override — not the live config — changed the
    // outcome.
    expect(evaluateDirection(1, 0, world, COMPETENT_BOT_TUNABLES)).toEqual({
      safe: true,
      clearance: 75,
    });
    expect(evaluateDirection(1, 0, world, applied)).toEqual({
      safe: false,
      clearance: 0,
    });
  });

  it('leaves minerals behind when an enemy is destroyed through the shared combat path', async () => {
    const scene = await bootTuning({
      seed: 5,
      level: makeLevel('Single', [scoutWave(1)]),
    });
    booted!.game.loop.stop();

    const enemies = scene.getEnemies();
    expect(enemies).toHaveLength(1);
    const before = new Set(scene.getMinerals());

    // Force the shared kill-drop rule to draw its additive bonus so the
    // non-asteroid enemy deterministically leaves one mineral; then kill it
    // through the shared collision path (a player bullet).
    scene.setSupplyRng(() => 0.99);
    // Enemies enter through the wormhole spawn animation (AH-0MV8BSMXC0097KLW)
    // and are protected while emerging — settle it before the kill shot.
    scene.finishSpawnAnimations();
    scene.getShip()!.respawn(20, 20);
    scene.spawnPlayerBullet(enemies[0].x, enemies[0].y, 0, 0, 0x00ffff, 10);
    scene.tick(1 / 60);

    expect(scene.getEnemies().filter((enemy) => enemy.alive)).toHaveLength(0);
    const added = scene.getMinerals().filter((mineral) => !before.has(mineral));
    expect(added.length).toBeGreaterThanOrEqual(1);
  });

  it('spawns and collects a weapon drop through the shared drop layer', async () => {
    const scene = await bootTuning({ seed: 11 });
    booted!.game.loop.stop();

    const ship = scene.getShip()!;
    expect(ship.hasWeapon('rapid')).toBe(false);

    ship.respawn(300, 300);
    const drop = scene.spawnSupplyDrop('rapid', 300, 300);
    expect(scene.getDrops()).toContain(drop);

    scene.tick(1 / 60);
    // The shared `_collectDrop` path equipped the weapon.
    expect(ship.hasWeapon('rapid')).toBe(true);
  });

  it('collects a mineral into the shared hold', async () => {
    const scene = await bootTuning({ seed: 3 });
    booted!.game.loop.stop();

    const ship = scene.getShip()!;
    const mineral = scene.getMinerals()[0];
    const before = new Set(scene.getMinerals());

    ship.respawn(mineral.x, mineral.y);
    scene.tick(1 / 60);

    const after = scene.getMinerals();
    expect(after.length).toBeLessThan(before.size);
  });

  // ── Live-aim & mineral-seek regressions (AH-0MV5SDMMF008O55Q) ──────

  /**
   * Test-first reconciliation (AH-0MV5SDMMF008O55Q): these regressions were
   * written red-first under Vitest's `it.fails(...)` and the adoption item
   * AH-0MV5SDNI2008RWQ2 removed the expected-failure wrapper once `GymLevel`
   * adopted the shared live-targeting helper — they are now hard gates.
   */

  it('AH-0MV5SDMMF008O55Q — a Diver\'s aim target tracks the live player in bot-tuning gym', async () => {
    const scene = await bootTuning({
      seed: 42,
      level: makeLevel('Aim', [
        {
          groups: [
            {
              enemyKey: 'diver',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });
    booted!.game.loop.stop();

    const diver = scene.getEnemies().find(
      (e): e is Diver => e instanceof Diver,
    );
    expect(diver, 'Diver not spawned').toBeDefined();

    const ship = scene.getShip()!;

    // The aim push runs at the start of `tick`, before the bot drives the
    // ship that frame, so capture the ship position first. The aim target
    // must equal the ship position at the moment of the push.
    const beforeX = ship.x;
    const beforeY = ship.y;

    // Advance one frame — this is where the live-aim push must fire.
    scene.tick(1 / 60);

    // After the push, the Diver\'s aimTarget equals the ship position at push
    // time, NOT the bottom-centre default.
    const aim = diver!.aimTarget;
    expect(aim.x).toBeCloseTo(beforeX, 5);
    expect(aim.y).toBeCloseTo(beforeY, 5);
  });

  it('AH-0MV5SDMMF008O55Q — a Harvester receives the live mineral field in bot-tuning gym', async () => {
    const scene = await bootTuning({
      seed: 123,
      level: makeLevel('Seek', [
        {
          groups: [
            {
              enemyKey: 'harvester',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });
    booted!.game.loop.stop();

    const harvester = scene.getEnemies().find(
      (e): e is Harvester => e instanceof Harvester,
    );
    expect(harvester, 'Harvester not spawned').toBeDefined();

    const minerals = scene.getMinerals();
    expect(minerals.length, 'no minerals seeded').toBeGreaterThan(0);

    // Advance one frame — the mineral-seek push must fire.
    scene.tick(1 / 60);

    // The Harvester must have selected a live mineral as its target.
    expect(harvester!.seekTargetX).not.toBeNull();
    expect(harvester!.seekTargetY).not.toBeNull();
  });

  // ── Per-parameter tooltips (AH-0MV4XGXVL001GSB2) ────────────────

  // ── Config export (AH-0MV6MFDYG001E6PL) ──────────────────────────

  it('Export downloads the persisted store state as JSON (AH-0MV6MFDYG001E6PL)', async () => {
    await bootTuning({ seed: 42 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '825';
    input.dispatchEvent(new Event('input'));
    const nameInput = document.getElementById(BOT_TUNING_SAVE_AS_INPUT_ID) as HTMLInputElement;
    nameInput.value = 'Exportable';
    document.getElementById(BOT_TUNING_SAVE_AS_ID)!.dispatchEvent(new MouseEvent('click'));

    // Capture the Blob the Export button hands to a download link.
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    document
      .getElementById(BOT_TUNING_EXPORT_ID)!
      .dispatchEvent(new MouseEvent('click'));
    await tick();

    expect(clickSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
    const blob = createSpy.mock.calls[0][0] as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.current).toBe('Exportable');
    const exported = parsed.configs.find(
      (config: { name: string }) => config.name === 'Exportable',
    );
    expect(exported.values.competent['powerUpSeekRange']).toBe(825);
  });

  // ── Dev write-back (AH-0MVBJ0DUI009B6AM) ────────────────────────

  it('Save to repo persists the current tuning through the dev endpoint (AC4)', async () => {
    vi.stubEnv('DEV', true);
    const root = makeTempRepo();
    installFetchBridge(await startBotTuningServer(root));
    await bootTuning({ seed: 808 });

    // Tune, then Save the current configuration so the store holds the value.
    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="mineralSeekRange"]`,
    )!;
    input.value = '875';
    input.dispatchEvent(new Event('input'));
    document
      .getElementById(BOT_TUNING_SAVE_ID)!
      .dispatchEvent(new MouseEvent('click'));

    document
      .getElementById(BOT_TUNING_SAVE_TO_REPO_ID)!
      .dispatchEvent(new MouseEvent('click'));

    const status = document.getElementById(BOT_TUNING_STATUS_ID)!;
    await vi.waitFor(() => expect(status.textContent).toContain('Saved to'));

    // A real file write: the committed baseline now holds the store Export.
    const written = readWrittenBaseline(root);
    expect(written).toBe(`${serialiseBotTuningState()}\n`);
    const parsed = JSON.parse(written) as {
      configs: Array<{ name: string; values: { competent: Record<string, number> } }>;
    };
    expect(parsed.configs[0].values.competent['mineralSeekRange']).toBe(875);
  });

  it('Save to repo reports the failure reason when the write is rejected (AC4)', async () => {
    vi.stubEnv('DEV', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, errors: ['baseline is read-only'] }), {
          status: 400,
        }),
      ),
    );
    await bootTuning({ seed: 809 });

    document
      .getElementById(BOT_TUNING_SAVE_TO_REPO_ID)!
      .dispatchEvent(new MouseEvent('click'));

    const status = document.getElementById(BOT_TUNING_STATUS_ID)!;
    await vi.waitFor(() =>
      expect(status.textContent).toContain('baseline is read-only'),
    );
  });

  it('Save to repo is disabled outside dev and never issues a write (AC3/AC4)', async () => {
    vi.stubEnv('DEV', false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await bootTuning({ seed: 810 });

    const button = document.getElementById(
      BOT_TUNING_SAVE_TO_REPO_ID,
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);

    button.dispatchEvent(new MouseEvent('click'));
    await advanceGame(booted!.game, 40);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.getElementById(BOT_TUNING_STATUS_ID)!.textContent).not.toContain(
      'Saved to',
    );
  });

  it('associates every slider and toggle with a tooltip holding its description', async () => {

    await bootTuning({ seed: 77 });

    const panel = document.getElementById(BOT_TUNING_PANEL_ID)!;
    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      const input = panel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`,
      )!;
      assertTooltip(input, field.description, field.key);
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      const input = panel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`,
      )!;
      assertTooltip(input, toggle.description, toggle.key);
    }
  });

  it('reveals the tooltip on hover and keyboard focus, hidden by default', async () => {
    await bootTuning({ seed: 78 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    const tooltip = document.getElementById(input.getAttribute('aria-describedby')!)!;

    // Hidden until the designer hovers or focuses the control.
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
    input.dispatchEvent(new Event('pointerenter'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);
    input.dispatchEvent(new Event('pointerleave'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);

    // Keyboard users get the same help without a mouse.
    input.dispatchEvent(new Event('focus'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);
    input.dispatchEvent(new Event('blur'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
  });

  /**
   * Asserts `control` is wired to a `.gym-tooltip` via `aria-describedby`
   * and that the tooltip text is exactly the spec's description.
   */
  function assertTooltip(
    control: HTMLInputElement,
    expectedText: string,
    key: string,
  ): void {
    const describedBy = control.getAttribute('aria-describedby');
    expect(describedBy, `${key} aria-describedby`).toBeTruthy();
    const tooltip = document.getElementById(describedBy!);
    expect(tooltip, `${key} tooltip exists`).not.toBeNull();
    expect(tooltip!.classList.contains(GYM_TOOLTIP_CLASS), `${key} class`).toBe(true);
    expect(tooltip!.textContent, `${key} text`).toBe(expectedText);
  }
});

/**
 * AH-0MV9AWR7A0084XJ0 — the tuning gym now plays the demo's scenario
 * pressures: the shared scheduled asteroid hazard and the shared timed-wave
 * window (inherited from `GymLevel`). The bot snapshot therefore carries live
 * wave pressure and asteroid hazards, and given equivalent snapshots the gym
 * bot and the shipped demo bot make the same decision.
 */
describe('GymBotTuning — demo scenario parity (asteroids + timed waves, AH-0MV9AWR7A0084XJ0)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    resetBotTuningStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function bootTuning(data?: GymBotTuningData): Promise<GymBotTuning> {
    booted = await bootScene([GymBotTuning]);
    booted.game.loop.stop();
    const manager = booted.game.scene;
    manager.start(GYM_BOT_TUNING_SCENE_KEY, data);
    return manager.getScene(GYM_BOT_TUNING_SCENE_KEY) as GymBotTuning;
  }

  /** Sets the wave clock to `elapsed` seconds into the active wave. */
  function setElapsed(scene: GymBotTuning, elapsed: number): void {
    scene.setWaveTimeoutRemaining(WAVE_TIME_LIMIT_SECONDS - elapsed);
  }

  it('AC2 — plans the seed-derived asteroid schedule for the wave', async () => {
    const seed = 777;
    const scene = await bootTuning({ seed });

    expect(scene.getPendingAsteroidSpawns()).toEqual(
      computeSpawns(
        0,
        GAME_WIDTH,
        GAME_HEIGHT,
        WAVE_TIME_LIMIT_SECONDS,
        createSeededRng(seed + 1),
      ),
    );
  });

  it('AC2 — the bot snapshot carries live timed-wave pressure, not an inactive stub', async () => {
    const scene = await bootTuning({ seed: 808 });
    setElapsed(scene, 12);

    const snapshot = scene.getBotSnapshot();
    expect(snapshot.wave).not.toBeNull();
    expect(snapshot.wave!.active).toBe(true);
    expect(snapshot.wave!.timeLimit).toBe(WAVE_TIME_LIMIT_SECONDS);
    expect(snapshot.wave!.timeRemaining).toBeCloseTo(
      WAVE_TIME_LIMIT_SECONDS - 12,
      3,
    );
    // The derived world view exposes the pressure the wave-clear behaviours
    // consume (`enemyWavePressurePort` / `waveClearBoost`).
    const pressure = buildBotWorld(snapshot).wavePressure;
    expect(pressure).toBeGreaterThan(0.3);
    expect(pressure).toBeLessThan(0.5);
  });

  it('AC1/AC2 — the bot snapshot carries a live scheduled asteroid', async () => {
    const scene = await bootTuning({ seed: 909 });
    const first = scene.getPendingAsteroidSpawns()[0];
    setElapsed(scene, first.timeSeconds + 1e-6);
    scene.tick(0.001);

    const asteroids = scene.getAsteroids();
    expect(asteroids).toHaveLength(1);
    const snapshot = scene.getBotSnapshot();
    const hazard = snapshot.enemies.find((enemy) => enemy.archetype === 'asteroid');
    expect(hazard).toBeDefined();
    expect(hazard!.alive).toBe(true);
    // The bot's world model partitions it as an asteroid hazard (not an enemy
    // formation to clear).
    expect(buildBotWorld(snapshot).liveAsteroids).toHaveLength(1);
  });

  it('AC3 — equivalent snapshots yield the same decision from the demo and gym bot stacks', async () => {
    const seed = 606;
    const scene = await bootTuning({ seed });
    setElapsed(scene, 9);
    scene.tick(1 / 60);

    const gymSnapshot = scene.getBotSnapshot();
    const ship = scene.getShip()!;
    // The shipped demo builds its snapshot from the same live state through
    // the same public getters; this stub is the demo-shaped source.
    const demoSnapshot = buildBotSnapshot({
      getPlayer: () => ship,
      getBoss: () => null,
      getBossPhase: () => 0,
      getEnemies: () => scene.getEnemies(),
      getEnemyBullets: () => scene.getEnemyBullets(),
      getPlayerBullets: () => scene.getPlayerBullets(),
      getDrops: () => scene.getDrops(),
      getMinerals: () => scene.getMinerals(),
      getAliveCount: () =>
        scene.getEnemies().filter((enemy) => enemy.alive).length,
      getWaveState: () => scene.getWaveState(),
      getRunSeed: () => seed,
      getLives: () => 3,
      getLivesCap: () => 5,
    });

    // No scenario-derived field is lost in the gym snapshot ...
    expect(demoSnapshot).toEqual(gymSnapshot);
    // ... and the same tuning therefore decides identically on both.
    const dt = 1 / 60;
    const gymBot = createCompetentBotBrain({
      tunables: scene.getAppliedBotTunables(),
    });
    const demoBot = createCompetentBotBrain({
      tunables: scene.getAppliedBotTunables(),
    });
    expect(gymBot.decide(gymSnapshot, dt)).toEqual(
      demoBot.decide(demoSnapshot, dt),
    );
  });
});
