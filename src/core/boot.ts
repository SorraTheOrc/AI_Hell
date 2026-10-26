import { Game } from './Game';
import { loadConfigs } from './configStore';
import { registerCaptureDirector } from './captureDirector';

/**
 * Application boot wrapper (AH-0MUESFKCD004SI1V).
 *
 * Hydrates the CSV-backed config store **before** the Phaser game — and thus
 * before any scene — is constructed, so the first frame already reflects the
 * persisted `src/data/*.csv` values. This is what makes a saved ship
 * `controlScheme` survive a `npm run dev` restart: without this await the
 * registry still holds `DEFAULT_CONFIG` when the first scene reads
 * `loadShipConfig()`.
 *
 * `loadConfigs()` never throws — a failed fetch/read falls back to the
 * built-in defaults — so the game always boots (AC4).
 *
 * After construction the dev-only capture director
 * (`window.__aiHellCaptureDirector`, AH-0MVFC6WPS004UOLO) is registered on
 * the running game, so the multi-scene capture tool can switch gym scenes
 * inside the already-running page without a reload. The registration is
 * itself dev-gated (`import.meta.env.DEV`), so a production build never
 * writes the global.
 */
export async function bootGame(): Promise<Game> {
  await loadConfigs();
  const game = new Game();
  registerCaptureDirector(game);
  return game;
}
