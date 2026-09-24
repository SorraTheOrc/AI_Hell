import './style.css';
import { bootGame } from './core/boot';

// Browser entry point: hydrate the CSV-backed config store, then boot the
// AI_Hell game (creates the Phaser canvas inside #game-container). Awaiting
// `loadConfigs()` first means persisted CSV tuning — e.g. a saved ship
// `controlScheme` — is live from the first frame, with no flash of the
// built-in default (AH-0MUESFKCD004SI1V). This is the web distribution model
// from GDD §6.3.
void bootGame();
