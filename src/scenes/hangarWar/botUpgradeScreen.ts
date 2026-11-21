/**
 * Bot-upgrade screen — the shared model and one renderer for strengthening the
 * defending bot of a held hex (parent AH-0MWH48IEG00929GQ, "Strengthen a hexes
 * defence").
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § *Strengthen
 * a hex's defence* — the held hex's `UPGRADE DEFENCES` action opens **a version
 * of the player-ship upgrade scene (the hangar)** scoped to the hex's
 * defending bot: the same screen pattern, a different purchase target
 * (producer Q4).
 *
 * ## Pure model, one renderer
 *
 * Every decision (the fit rule, the per-level price, the purchase) comes from
 * the pure `src/core/hangarWar/botUpgrade` module. This module only shapes the
 * rows into a screen model (`buildBotUpgradeScreenModel`) and draws it
 * (`renderBotUpgradeScreen`). The game's `BotUpgradeScene` renders the same
 * pair, so a gym (or a future surface) cannot drift from it — the same
 * model/renderer split as `hangarScreen.ts` (`AGENTS.md` gym↔game parity).
 *
 * ## No second fit rule
 *
 * The screen never re-derives a verdict: each row carries its `fit`, `reason`
 * and price from `botUpgradeRows`, and the rendered label is the core's own
 * `botUpgradeRowLabel`. Only presentation (colours, focus, layout) lives here.
 *
 * @module src/scenes/hangarWar/botUpgradeScreen
 */

import Phaser from 'phaser';

import { GAME_WIDTH } from '../../core/constants';
import { FocusManager } from '../../utils/focusManager';
import {
  botLoadoutRows,
  botUpgradeRowLabel,
  botUpgradeRows,
  botSlotLabel,
  type BotUpgradeRow,
} from '../../core/hangarWar/botUpgrade';
import type { HangarWarPayload, HexDefender } from '../../core/hangarWar/types';
import type { HangarEntry } from '../../data/hangarCatalogue';

/** The screen title. */
export const BOT_UPGRADE_SCREEN_TITLE = 'UPGRADE DEFENCES';

/** The footer hint. */
export const BOT_UPGRADE_SCREEN_HINT =
  '↑/↓ SELECT · ENTER SEND · ESC BACK TO MAP';

/** The back row's key (the one row the screen always offers). */
export const BOT_UPGRADE_BACK_KEY = 'back';

/** The pure screen model. */
export interface BotUpgradeScreenModel {
  /** The screen title. */
  readonly title: string;
  /** The focused hex's identity line (`HEX hex-r1-1 · HELD`). */
  readonly hexLine: string;
  /** The bot's hull and slot usage line (`BOT hull-2 · SLOTS 2/6`). */
  readonly botLine: string;
  /** The bot's stored rating line (`DEFENCE RATING 9`). */
  readonly ratingLine: string;
  /** The bot's carried loadout line (`LOADOUT spread L2, ...`). */
  readonly loadoutLine: string;
  /** The fleet's banked salvage line (`BANKED 240 MIN + 3 CORES`). */
  readonly salvageLine: string;
  /** The offered catalogue rows, in catalogue order. */
  readonly rows: readonly BotUpgradeRow[];
  /** The `◀ HEX MAP` back row. */
  readonly backRow: BotUpgradeBackRow;
  /** The rows the shared `FocusManager` registers, in reading order. */
  readonly focusOrder: readonly string[];
  /** A transient purchase message (a send confirmation or a refusal). */
  readonly message: string | null;
}

/** The back row shape. */
export interface BotUpgradeBackRow {
  /** Row key (`back`). */
  readonly key: string;
  /** Rendered text. */
  readonly label: string;
  /** Always true: the map is always one activation away. */
  readonly actionable: boolean;
}

/** Optional model-building knobs. */
export interface BotUpgradeScreenOptions {
  /** The catalogue to offer (defaults to the shipped catalogue). */
  readonly catalogue?: readonly HangarEntry[];
  /** A transient purchase message to render, or `null`. */
  readonly message?: string | null;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** The defender who owns `hexId`, or `null` when the hex is not held. */function defenderFor(
  payload: HangarWarPayload,
  hexId: string,
): HexDefender | null {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  if (hex === undefined || hex.held !== true) return null;
  return hex.defender ?? null;
}

/** The bot's carried loadout as one readable line. */
function loadoutLine(defender: HexDefender): string {
  const rows = botLoadoutRows(defender);
  const parts: string[] = [];
  for (const row of rows.weapons) parts.push(`${row.id} L${row.level}`);
  for (const row of rows.powerUps) parts.push(`${row.id} L${row.level}`);
  return parts.length === 0 ? 'LOADOUT none' : `LOADOUT ${parts.join(', ')}`;
}

/** A readable two-currency wallet line. */
function salvageLine(payload: HangarWarPayload): string {
  return `BANKED ${toCount(payload.hangar.bankedMinerals)} MIN + ${toCount(
    payload.hangar.bankedCores,
  )} CORES`;
}

/**
 * Builds the bot-upgrade screen model for `hexId`.
 *
 * @param payload — the war payload (read only).
 * @param hexId — the held hex whose defender is upgraded.
 * @param options — catalogue/message overrides.
 * @returns the model, or `null` when the hex is not held / has no defender.
 */
export function buildBotUpgradeScreenModel(
  payload: HangarWarPayload,
  hexId: string,
  options: BotUpgradeScreenOptions = {},
): BotUpgradeScreenModel | null {
  const defender = defenderFor(payload, hexId);
  if (defender === null) return null;
  const rows = botUpgradeRows(payload, hexId, {
    catalogue: options.catalogue,
  });
  const backRow: BotUpgradeBackRow = {
    key: BOT_UPGRADE_BACK_KEY,
    label: '◀ HEX MAP',
    actionable: true,
  };
  const focusOrder = [
    ...rows.filter((row) => row.actionable).map((row) => row.key),
    backRow.key,
  ];
  return {
    title: BOT_UPGRADE_SCREEN_TITLE,
    hexLine: `HEX ${hexId.toUpperCase()} · HELD`,
    botLine: `BOT ${defender.hullId} · SLOTS ${botSlotLabel(defender)}`,
    ratingLine: `DEFENCE RATING ${toCount(defender.defenceRating)}`,
    loadoutLine: loadoutLine(defender),
    salvageLine: salvageLine(payload),
    rows,
    backRow,
    focusOrder,
    message: options.message ?? null,
  };
}

/** The actions a rendered bot-upgrade screen invokes. */
export interface BotUpgradeScreenHandlers {
  /** Buy the catalogue entry (`bot-upgrade:<entryId>` rows). */
  onPurchase(entryId: string): void;
  /** Return to the hex map (the `◀ HEX MAP` row). */
  onBack(): void;
}

/** One rendered row, exposed for tests and screen queries. */
export interface BotUpgradeScreenRow {
  /** Row key (matches {@link BotUpgradeScreenModel.focusOrder}). */
  readonly key: string;
  /** Rendered text. */
  readonly label: string;
  /** Whether the row can be activated. */
  readonly actionable: boolean;
  /** The Phaser text object rendering the row. */
  readonly text: Phaser.GameObjects.Text;
}

/** The handle returned by {@link renderBotUpgradeScreen}. */
export interface BotUpgradeScreenView {
  /** The model rendered. */
  readonly model: BotUpgradeScreenModel;
  /** Every rendered row, in reading order. */
  readonly rows: readonly BotUpgradeScreenRow[];
  /** The focused row key, or `null` when nothing is focusable. */
  getFocusedKey(): string | null;
  /** Moves focus to `key` when it is focusable. */
  focusRow(key: string): boolean;
  /** Activates the focused row (what Enter/Space does). */
  activateFocused(): void;
  /** Destroys the rendered objects and detaches the keyboard listener. */
  destroy(): void;
}

/** Neon colours reused across rows (GDD §7.1, shared with `hangarScreen`). */
const ROW_COLOR = '#00ff88';
const DISABLED_COLOR = '#555555';
const HEADING_COLOR = '#00ffff';
const TEXT_COLOR = '#88ffff';

/** Layout constants (single-source so the game and any parity surface match). */
const LEFT_X = 60;
const TITLE_Y = 30;
const LINE_STEP = 20;
const LINE_START_Y = 72;
const ROW_START_Y = 196;
const ROW_STEP = 18;
export const BOT_UPGRADE_ROW_STEP = ROW_STEP;

/** The Y of catalogue row `index` (single-sourced with the renderer). */
export function botUpgradeRowY(index: number): number {
  return ROW_START_Y + index * ROW_STEP;
}

/**
 * Renders the bot-upgrade screen model and wires its actionable rows to the
 * shared `FocusManager`.
 *
 * @param scene — the scene that owns the rendered objects.
 * @param model — the model to render.
 * @param handlers — the actions the rows invoke (omitted → a read-only render).
 * @returns the view handle.
 */
export function renderBotUpgradeScreen(
  scene: Phaser.Scene,
  model: BotUpgradeScreenModel,
  handlers?: Partial<BotUpgradeScreenHandlers>,
): BotUpgradeScreenView {
  const objects: Phaser.GameObjects.Text[] = [];
  const rows: BotUpgradeScreenRow[] = [];
  const focusable: Array<{ key: string; action: () => void }> = [];
  const focusManager = new FocusManager();

  const add = (
    x: number,
    y: number,
    text: string,
    size: string,
    color: string,
  ): Phaser.GameObjects.Text => {
    const object = scene.add.text(x, y, text, {
      fontFamily: 'monospace',
      fontSize: size,
      color,
    });
    objects.push(object);
    return object;
  };

  add(GAME_WIDTH / 2, TITLE_Y, model.title, '22px', HEADING_COLOR).setOrigin(
    0.5,
    0,
  );
  let line = LINE_START_Y;
  for (const text of [
    model.hexLine,
    model.botLine,
    model.ratingLine,
    model.loadoutLine,
    model.salvageLine,
  ]) {
    add(LEFT_X, line, text, '14px', TEXT_COLOR);
    line += LINE_STEP;
  }
  if (model.message !== null && model.message !== '') {
    add(LEFT_X, line, model.message, '14px', HEADING_COLOR);
    line += LINE_STEP;
  }

  add(LEFT_X, ROW_START_Y - 6, 'SEND AN UPGRADE', '14px', HEADING_COLOR);

  const addRow = (
    y: number,
    key: string,
    label: string,
    actionable: boolean,
    action: (() => void) | undefined,
  ): void => {
    const interactive = actionable && action !== undefined;
    const text = scene.add.text(LEFT_X, y, label, {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: interactive ? ROW_COLOR : DISABLED_COLOR,
    });
    objects.push(text);
    rows.push({ key, label, actionable: interactive, text });
    if (!interactive || !action) return;
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => text.setStyle({ color: '#ffffff' }));
    text.on('pointerout', () => text.setStyle({ color: ROW_COLOR }));
    text.on('pointerdown', action);
    focusManager.register(text, action);
    focusable.push({ key, action });
  };

  model.rows.forEach((row, index) => {
    const action =
      row.actionable && handlers?.onPurchase
        ? () => handlers.onPurchase!(row.entryId)
        : undefined;
    addRow(
      botUpgradeRowY(index),
      row.key,
      botUpgradeRowLabel(row),
      row.actionable,
      action,
    );
  });

  const backY = botUpgradeRowY(model.rows.length) + 10;
  const backAction = handlers?.onBack
    ? () => handlers.onBack!()
    : undefined;
  addRow(
    backY,
    BOT_UPGRADE_BACK_KEY,
    model.backRow.label,
    model.backRow.actionable,
    backAction,
  );

  const focusedKey = (): string | null =>
    focusable[focusManager.getFocusedIndex()]?.key ?? null;
  const focusRow = (key: string): boolean => {
    const index = focusable.findIndex((row) => row.key === key);
    if (index < 0) return false;
    focusManager.setFocusedIndex(index);
    return true;
  };
  focusManager.attachKeyboard(scene);
  focusManager.setFocusedIndex(0);

  return {
    model,
    rows,
    getFocusedKey: focusedKey,
    focusRow,
    activateFocused(): void {
      focusManager.activateFocused();
    },
    destroy(): void {
      focusManager.shutdown();
      for (const object of objects) object.destroy();
      objects.length = 0;
    },
  };
}
