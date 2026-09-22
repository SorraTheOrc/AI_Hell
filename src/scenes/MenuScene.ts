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
 *
 * Keyboard navigation (AH-0MU9LKQEP008LCX9-C2) is provided by a shared
 * {@link FocusManager}: Play Game is focused by default, Tab and the arrow
 * keys cycle focus among the three controls (wrapping), and Enter/Space
 * activate the focused control. Pointer handlers are unchanged (keyboard
 * support is additive).
 *
 * Styling follows the neon-cyan / dark background palette from the GDD
 * colour scheme (§7.1).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { FocusManager } from '../utils/focusManager';

/** Neon-cyan colour for menu text (GDD §7.1 art direction). */
const MENU_TEXT_COLOR = '#00ffff';
/** Secondary text colour for the dev tool button. */
const DEV_TEXT_COLOR = '#888888';

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

  constructor() {
    super('MenuScene');
  }

  create(): void {
    this.focusManager = new FocusManager();
    this.controls = [];

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
      260,
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
      this.scene.start('PlayScene');
    });

    this.controls.push({ label: '▶  Play Game', text: playButton });

    // ── Settings button ───────────────────────────────────────
    // Opens the same settings screen as the pause menu, before starting a
    // game (parent AH-0MU9LPZ0G0015292 AC6). Initialising the audio
    // context on the gesture keeps GDD §6.7 autoplay compliance intact.
    const settingsButton = this.add.text(
      GAME_WIDTH / 2,
      320,
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

    // ── Gym Scene Index button (dev tool) ────────────────────────
    const devButton = this.add.text(
      GAME_WIDTH / 2,
      390,
      '⚙  Gym Scene Index (dev)',
      {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: DEV_TEXT_COLOR,
        backgroundColor: '#1a1a1a',
        padding: { x: 12, y: 6 },
      },
    ).setOrigin(0.5);
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
      this.scene.start('PlayScene');
    });
    this.focusManager.register(settingsButton, () => {
      resumeAudioContext(this.sound);
      this.scene.start('SettingsScene', { origin: 'MenuScene' });
    });
    this.focusManager.register(devButton, () => {
      this.scene.start('GymIndex');
    });
    this.focusManager.attachKeyboard(this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  // ── Public query helpers (unit-testable) ───────────────────────

  /** Display label of the currently focused control ('' when none). */
  getFocusedLabel(): string {
    const index = this.focusManager.getFocusedIndex();
    return this.controls[index]?.label ?? '';
  }
}
