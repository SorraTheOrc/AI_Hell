import { Game } from './Game';
import { loadConfigs } from './configStore';

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
 */
export async function bootGame(): Promise<Game> {
  await loadConfigs();
  return new Game();
}
