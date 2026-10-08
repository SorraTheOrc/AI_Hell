/**
 * Production telemetry consent prompt (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * Shown once, from the main menu, when the build is configured for
 * production remote telemetry and the player has not yet made a choice
 * (see `shouldPromptForTelemetryConsent`). The player can opt in ("Allow
 * telemetry") or decline ("No thanks"); either way the decision is persisted
 * via {@link setTelemetryConsent} and they are returned to the origin scene.
 *
 * The safe default is the focused control — declining — and ESC also
 * declines, so the prompt can never accidentally opt someone in. The choice
 * is always reversible from Settings.
 *
 * The privacy copy is the player-facing half of the policy documented in
 * `docs/TELEMETRY.md`: gameplay state/input/events only, no PII, used to
 * improve the game, and retained for a bounded period.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { setTelemetryConsent } from '../core/telemetryConsentStore';
import { FocusManager } from '../utils/focusManager';

/** Neon-cyan heading colour (GDD §7.1). */
const CONSENT_TEXT_COLOR = '#00ffff';
/** Secondary body colour. */
const CONSENT_BODY_COLOR = '#aabbcc';
/** Scene data passed by the caller (`{ origin }`). */
interface TelemetryConsentSceneData {
  origin?: string;
}

/**
 * Player-facing privacy summary shown on the consent screen (AC3). Kept in
 * sync with `docs/TELEMETRY.md`; the test suite asserts the key claims.
 */
export const TELEMETRY_PRIVACY_SUMMARY = [
  'AI HELL can collect anonymous gameplay data to help improve the game:',
  'your ship position and input, plus gameplay events (kills, pickups,',
  'waves). It never records names, emails, accounts, IP addresses or chat.',
  '',
  'Data is only collected if you opt in, is used solely to tune the game,',
  'and is retained for a bounded period before deletion. You can change',
  'this at any time in Settings.',
].join('\n');

export class TelemetryConsentScene extends Phaser.Scene {
  private origin = 'MenuScene';
  private focusManager = new FocusManager();
  private summaryText!: Phaser.GameObjects.Text;
  /** Focus labels in registration order (index 0 = safe default: decline). */
  private controlLabels: string[] = [];

  constructor() {
    super('TelemetryConsentScene');
  }

  create(data?: TelemetryConsentSceneData): void {
    this.origin = data?.origin ?? 'MenuScene';
    this.focusManager = new FocusManager();
    this.controlLabels = [];

    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);
    const panel = this.add.rectangle(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      GAME_WIDTH - 160,
      GAME_HEIGHT - 140,
      0x0a0f14,
    );
    panel.setStrokeStyle(2, 0x00ffff, 0.5);

    this.add
      .text(GAME_WIDTH / 2, 110, 'Help improve AI HELL?', {
        fontFamily: 'monospace',
        fontSize: '30px',
        color: CONSENT_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.summaryText = this.add
      .text(GAME_WIDTH / 2, 260, TELEMETRY_PRIVACY_SUMMARY, {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: CONSENT_BODY_COLOR,
        align: 'center',
        lineSpacing: 6,
        wordWrap: { width: GAME_WIDTH - 240 },
      })
      .setOrigin(0.5);

    // Safe default first: "No thanks" is focused (and ESC declines).
    const denyButton = this.add
      .text(GAME_WIDTH / 2 - 150, 430, 'No thanks', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: CONSENT_BODY_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    denyButton.setInteractive({ useHandCursor: true });
    denyButton.on('pointerdown', () => this.deny());

    const allowButton = this.add
      .text(GAME_WIDTH / 2 + 150, 430, 'Allow telemetry', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: CONSENT_TEXT_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    allowButton.setInteractive({ useHandCursor: true });
    allowButton.on('pointerdown', () => this.allow());

    this.focusManager.register(denyButton, () => this.deny());
    this.focusManager.register(allowButton, () => this.allow());
    this.focusManager.attachKeyboard(this);
    this.controlLabels = ['deny', 'allow'];

    // ESC always declines (the privacy-safe default).
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.deny();
    });

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  /** Opts in, persists the decision and returns to the origin scene. */
  allow(): void {
    setTelemetryConsent(true);
    this.scene.start(this.origin);
  }

  /** Declines, persists the decision and returns to the origin scene. */
  deny(): void {
    setTelemetryConsent(false);
    this.scene.start(this.origin);
  }

  /** The privacy summary currently displayed (test/inspection seam). */
  getPrivacySummary(): string {
    return this.summaryText.text;
  }

  /** Focus label of the currently focused control (test seam). */
  getFocusedLabel(): string {
    return this.controlLabels[this.focusManager.getFocusedIndex()] ?? '';
  }
}
