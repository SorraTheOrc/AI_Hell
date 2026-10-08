/**
 * Main menu scene (GDD §5.1 — Main menu).
 *
 * The boot scene that greets the player with buttons:
 * - **Play Game** — starts a new game session at Level 1 and initializes
 *   the Phaser Audio context (Web Audio autoplay policy compliance, GDD §6.7).
 * - **Settings** — opens the shared settings screen (audio + controls)
 *   before starting a session (parent AH-0MU9LPZ0G0015292).
 * - **Gym Scene Index** — navigates to the existing `GymIndex` dev scene
 *   for testing individual gym components.
 * - **GitHub** — footer link (bottom-left) that opens the project's source
 *   repository in a new browser tab (AH-0MUZI83EO003WVTG).
 *
 * Keyboard navigation (AH-0MU9LKQEP008LCX9-C2) is provided by a shared
 * {@link FocusManager}: Play Game is focused by default, Tab and the arrow
 * keys cycle focus among the controls (wrapping), and Enter/Space
 * activate the focused control. Pointer handlers are unchanged (keyboard
 * support is additive).
 *
 * Styling follows the neon-cyan / dark background palette from the GDD
 * colour scheme (§7.1).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH, GITHUB_REPO_URL } from '../core/constants';
import { FocusManager } from '../utils/focusManager';
import { installGameAudio } from '../audio/effects';
import { loadTelemetryConsent } from '../core/telemetryConsentStore';
import {
  resolveTelemetryConfig,
  shouldPromptForTelemetryConsent,
  type TelemetryConsentState,
  type TelemetryEnv,
} from '../telemetry';

/** Neon-cyan colour for menu text (GDD §7.1 art direction). */
const MENU_TEXT_COLOR = '#00ffff';
/** Secondary text colour for the dev tool button. */
const DEV_TEXT_COLOR = '#888888';

/** Display label for the footer GitHub link (AH-0MUZI83EO003WVTG). */
const GITHUB_LINK_LABEL = '🐙  GitHub';

/**
 * Re-exported so tests and callers can assert the link target against the
 * single source of truth (AH-0MUZI83EO003WVTG AC4).
 */
export { GITHUB_REPO_URL };

/**
 * Idle time (ms) before the attract/demo run starts on its own (Q4a/Q4b,
 * AH-0MUX4966Z0009P9Q). Single-source tunable: the menu schedules its timer
 * from this value and resets it on any input.
 */
export const ATTRACT_IDLE_TIMEOUT_MS = 15000;

/**
 * Whether the production telemetry consent prompt should be shown before
 * the menu (AH-0MUY08Y9P005ER7A, AC1). Injectable for tests; production
 * callers use the live environment and persisted consent state.
 */
export function shouldShowTelemetryConsentPrompt(
  env: TelemetryEnv = import.meta.env,
  state: TelemetryConsentState = loadTelemetryConsent(),
): boolean {
  return shouldPromptForTelemetryConsent(resolveTelemetryConfig(env), state);
}

/**
 * Resumes the Web Audio context if it is suspended (autoplay policy
 * compliance, GDD §6.7). No-op for sound managers without a WebAudio
 * context (HTML5 / NoAudio fallbacks). Returns true when a resume was
 * issued.
 */
export function resumeAudioContext(
  sound: Phaser.Sound.BaseSoundManager,
): boolean {
  const mgr = sound as unknown as {
    context?: { state?: string; resume?: () => void };
  };
  const ctx = mgr.context;
  if (ctx?.state === 'suspended' && typeof ctx.resume === 'function') {
    ctx.resume();
    return true;
  }
  return false;
}

/**
 * Main menu scene — the entry point for the playable game.
 */
export class MenuScene extends Phaser.Scene {
  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  /** The focusable controls in focus order (label + text object). */
  private controls: { label: string; text: Phaser.GameObjects.Text }[] = [];

  /** Idle-attract timer; rescheduled on any input and cleared on shutdown. */
  private attractTimer: Phaser.Time.TimerEvent | null = null;

  /**
   * Active idle timeout (ms). Seeded from {@link ATTRACT_IDLE_TIMEOUT_MS} and
   * preserved across input resets, so a configured value sticks.
   */
  private attractTimeoutMs = ATTRACT_IDLE_TIMEOUT_MS;

  constructor() {
    super('MenuScene');
  }

  create(): void {
    this.focusManager = new FocusManager();
    this.controls = [];

    // Production telemetry is opt-in (AH-0MUY08Y9P005ER7A, AC1): ask once,
    // before the menu, when the build records to a remote sink and the player
    // has not decided yet. On any other build this is a single no-op check.
    if (shouldShowTelemetryConsentPrompt()) {
      this.scene.start('TelemetryConsentScene', { origin: 'MenuScene' });
      return;
    }

    // Pin the shared SFX playback layer to Phaser's audio context and warm
    // the baked ToneForge asset cache (AH-0MUTYV92Y000WJ8Z) so exactly one
    // AudioContext exists and gameplay cues are audible from the first shot.
    installGameAudio(this.sound);

    // ── Background ───────────────────────────────────────────────
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // ── Title ────────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 120, 'AI HELL', {
      fontFamily: 'monospace',
      fontSize: '48px',
      color: MENU_TEXT_COLOR,
    }).setOrigin(0.5);

    // ── Play Game button ─────────────────────────────────────────
    const playButton = this.add.text(
      GAME_WIDTH / 2,
      220,
      '▶  Play Game',
      {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: MENU_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      },
    ).setOrigin(0.5);
    playButton.setInteractive({ useHandCursor: true });

    playButton.on('pointerover', () => {
      playButton.setStyle({ color: '#88ffff' });
    });
    playButton.on('pointerout', () => {
      playButton.setStyle({ color: MENU_TEXT_COLOR });
    });

    playButton.on('pointerdown', () => {
      // Initialise the Web Audio context on user gesture (autoplay policy).
      resumeAudioContext(this.sound);
      // Explicit non-demo payload: Phaser only rewrites `settings.data` for a
      // truthy `data`, so a no-argument start after a demo would reuse the
      // stale `{ demo: true }` payload and leave the bot in control
      // (AH-0MUY4881P007FJ8R).
      this.scene.start('PlayScene', { demo: false });
    });

    this.controls.push({ label: '▶  Play Game', text: playButton });

    // ── Watch Demo button (attract/demo mode) ────────────────────
    // Starts the shipped bot-driven demo (AH-0MUX4966Z0009P9Q AC1/AC2).
    // Initialising the audio context on the gesture keeps GDD §6.7 intact.
    const demoButton = this.add.text(
      GAME_WIDTH / 2,
      265,
      '👁  Watch Demo',
      {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: MENU_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 14, y: 7 },
      },
    ).setOrigin(0.5);
    demoButton.setInteractive({ useHandCursor: true });

    demoButton.on('pointerover', () => {
      demoButton.setStyle({ color: '#88ffff' });
    });
    demoButton.on('pointerout', () => {
      demoButton.setStyle({ color: MENU_TEXT_COLOR });
    });

    demoButton.on('pointerdown', () => {
      resumeAudioContext(this.sound);
      this.startDemo();
    });

    this.controls.push({ label: '👁  Watch Demo', text: demoButton });

    // ── Settings button ───────────────────────────────────────
    // Opens the same settings screen as the pause menu, before starting a
    // game (parent AH-0MU9LPZ0G0015292 AC6). Initialising the audio
    // context on the gesture keeps GDD §6.7 autoplay compliance intact.
    const settingsButton = this.add.text(
      GAME_WIDTH / 2,
      315,
      '⚙  Settings',
      {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: MENU_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 14, y: 7 },
      },
    ).setOrigin(0.5);
    settingsButton.setInteractive({ useHandCursor: true });

    settingsButton.on('pointerover', () => {
      settingsButton.setStyle({ color: '#88ffff' });
    });
    settingsButton.on('pointerout', () => {
      settingsButton.setStyle({ color: MENU_TEXT_COLOR });
    });

    settingsButton.on('pointerdown', () => {
      resumeAudioContext(this.sound);
      this.scene.start('SettingsScene', { origin: 'MenuScene' });
    });

    this.controls.push({ label: '⚙  Settings', text: settingsButton });

    // ── Leaderboard button ───────────────────────────────────────
    // Opens the shared, full leaderboard view (AH-0MU9LJ52C00613RX).
    const leaderboardButton = this.add.text(
      GAME_WIDTH / 2,
      365,
      '🏆  Leaderboard',
      {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: MENU_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 14, y: 7 },
      },
    ).setOrigin(0.5);
    leaderboardButton.setInteractive({ useHandCursor: true });

    leaderboardButton.on('pointerover', () => {
      leaderboardButton.setStyle({ color: '#88ffff' });
    });
    leaderboardButton.on('pointerout', () => {
      leaderboardButton.setStyle({ color: MENU_TEXT_COLOR });
    });

    leaderboardButton.on('pointerdown', () => {
      this.scene.start('LeaderboardScene');
    });

    this.controls.push({ label: '🏆  Leaderboard', text: leaderboardButton });

    // ── GitHub link (footer, bottom-left) ────────────────────────
    // Opens the project's source repository in a new tab
    // (AH-0MUZI83EO003WVTG). Mirrors the Gym Scene Index dev button's
    // bottom-corner offset on the opposite side, and joins the Tab cycle
    // after Leaderboard.
    const githubButton = this.add.text(
      16,
      GAME_HEIGHT - 12,
      GITHUB_LINK_LABEL,
      {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: MENU_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 12, y: 6 },
      },
    ).setOrigin(0, 1);
    githubButton.setInteractive({ useHandCursor: true });

    githubButton.on('pointerover', () => {
      githubButton.setStyle({ color: '#88ffff' });
    });
    githubButton.on('pointerout', () => {
      githubButton.setStyle({ color: MENU_TEXT_COLOR });
    });

    githubButton.on('pointerdown', () => {
      this.openGithubRepo();
    });

    this.controls.push({ label: GITHUB_LINK_LABEL, text: githubButton });

    // ── Gym Scene Index button (dev tool) ────────────────────────
    const devButton = this.add.text(
      GAME_WIDTH - 16,
      GAME_HEIGHT - 12,
      '⚙  Gym Scene Index (dev)',
      {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: DEV_TEXT_COLOR,
        backgroundColor: '#1a1a1a',
        padding: { x: 12, y: 6 },
      },
    ).setOrigin(1, 1);
    devButton.setInteractive({ useHandCursor: true });

    devButton.on('pointerover', () => {
      devButton.setStyle({ color: '#aaaaaa' });
    });
    devButton.on('pointerout', () => {
      devButton.setStyle({ color: DEV_TEXT_COLOR });
    });

    devButton.on('pointerdown', () => {
      this.scene.start('GymIndex');
    });

    this.controls.push({ label: '⚙  Gym Scene Index (dev)', text: devButton });

    // ── Subtitle ─────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 450, 'Defeat 5 levels then the Central AI', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#444444',
    }).setOrigin(0.5);

    // ── Keyboard focus (AH-0MU9LKQEP008LCX9-C2) ──────────────────
    // Register controls in visual order; the first (Play Game) is focused
    // by default. The action callbacks mirror the pointerdown handlers so
    // activation behaves identically for keyboard and pointer input. The
    // shared FocusManager owns Tab / arrow cycling and Enter / Space
    // activation — the scene contains no ad-hoc key routing.
    this.focusManager.register(playButton, () => {
      resumeAudioContext(this.sound);
      // Explicit non-demo payload (see the pointerdown handler above) so a
      // normal start after a demo never inherits `{ demo: true }`.
      this.scene.start('PlayScene', { demo: false });
    });
    this.focusManager.register(demoButton, () => {
      resumeAudioContext(this.sound);
      this.startDemo();
    });
    this.focusManager.register(settingsButton, () => {
      resumeAudioContext(this.sound);
      this.scene.start('SettingsScene', { origin: 'MenuScene' });
    });
    this.focusManager.register(leaderboardButton, () => {
      this.scene.start('LeaderboardScene');
    });
    this.focusManager.register(githubButton, () => {
      this.openGithubRepo();
    });
    this.focusManager.register(devButton, () => {
      this.scene.start('GymIndex');
    });
    this.focusManager.attachKeyboard(this);

    // ── Idle attract timer (AC1/AC4) ─────────────────────────────
    // Start the demo after a period of inactivity; any keyboard or pointer
    // input resets the countdown. `scheduleAttractTimer` is the single entry
    // point, so the timeout lives in one place.
    this.scheduleAttractTimer();
    this.input.keyboard?.on('keydown', () => this.scheduleAttractTimer());
    this.input.on('pointerdown', () => this.scheduleAttractTimer());

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
      // Drop the pending attract timer; the scene clock is also torn down, but
      // clearing it keeps the intent explicit (never fires off-menu, AC4).
      this.attractTimer?.remove(false);
      this.attractTimer = null;
    });
  }

  /**
   * Opens the project's GitHub repository in a new browser tab
   * (AH-0MUZI83EO003WVTG AC2/AC3). Called synchronously from both the
   * pointer and keyboard handlers so the browser treats the call as a user
   * gesture and does not block the popup. `noopener,noreferrer` drops the
   * `window.opener` reference on the opened page (tab-nabbing protection).
   */
  openGithubRepo(): void {
    window.open(GITHUB_REPO_URL, '_blank', 'noopener,noreferrer');
  }

  // ── Public query helpers (unit-testable) ───────────────────────

  /** Display label of the currently focused control ('' when none). */
  getFocusedLabel(): string {
    const index = this.focusManager.getFocusedIndex();
    return this.controls[index]?.label ?? '';
  }

  /**
   * Starts the bot-driven attract/demo run (AC2). The `{ demo: true }` flag
   * is the only difference from a normal start, so the engine owns all demo
   * behaviour.
   *
   * Scene-start data contract (AH-0MUY4881P007FJ8R): every *normal* start
   * must pass an explicit non-demo payload (`{ demo: false }`). Phaser's
   * `Systems.start(data)` only writes `settings.data` for a truthy `data`, so
   * a no-argument `scene.start('PlayScene')` reuses this demo payload and
   * re-enables the bot. See {@link PlayScene.init}.
   *
   * `demoDwellMs` optionally overrides the demo game-over dwell forwarded to
   * `GameOverScene` (AH-0MUXZ4CAE008QRFZ). Production calls it with no
   * argument and uses the single-source default; exposed so tests can drive a
   * short dwell without wall-clock waits (mirrors `scheduleAttractTimer`).
   */
  startDemo(demoDwellMs?: number): void {
    this.scene.start('PlayScene', { demo: true, demoDwellMs });
  }

  /**
   * (Re)schedules the idle-attract timer (AC1/AC4). Called on create and on
   * any input so the countdown restarts; the default timeout is the
   * single-source {@link ATTRACT_IDLE_TIMEOUT_MS}. Exposed so tests can drive
   * a short timeout without wall-clock waits.
   */
  scheduleAttractTimer(timeoutMs: number = this.attractTimeoutMs): void {
    this.attractTimeoutMs = timeoutMs;
    this.attractTimer?.remove(false);
    this.attractTimer = this.time.delayedCall(timeoutMs, () => {
      // Guard: only start while this menu is still the active scene (AC4).
      if (this.sys.isActive()) this.startDemo();
    });
  }
}
