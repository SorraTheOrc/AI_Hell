/**
 * Bot-upgrade scene — the player-facing surface for spending banked salvage on
 * the bot defending a held hex (parent AH-0MWH48IEG00929GQ, "Strengthen a
 * hexes defence").
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § *Strengthen
 * a hex's defence*. The held hex's `UPGRADE DEFENCES` action (`HexMapScene` →
 * `hexMap.ts`) opens this scene for that hex's defender.
 *
 * **The scene is a view, not a rule.** The rows, the fit verdicts, the prices
 * and the purchase all come from the pure `src/core/hangarWar/botUpgrade`
 * module; the pure model/renderer pair lives in
 * `./hangarWar/botUpgradeScreen`. This scene only loads the payload, presents
 * the model and **persists** a purchase through the same versioned store the
 * hangar uses — so a bot purchase lands in the one `ai_hell_hangar_war` key and
 * survives between sorties (the defender's additive permanent-upgrade fields,
 * field-presence parse). A fallen hex destroys the bot and its upgrades through
 * the existing `applyDefence` path; nothing new is built for that here.
 *
 * @module src/scenes/BotUpgradeScene
 */

import Phaser from 'phaser';

import {
  loadHangarWarPayload,
  saveHangarWarPayload,
  createDefaultPayload,
} from '../core/hangarWar/hangarWarStore';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../core/hangarWar/types';
import {
  botPriceLabel,
  buyBotUpgrade,
} from '../core/hangarWar/botUpgrade';
import { findHangarEntry } from '../core/hangarWar/hangarEconomy';
import { HANGAR_CATALOGUE } from '../data/hangarCatalogue';
import type { HangarEntry } from '../data/hangarCatalogue';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import { HEX_MAP_SCENE_KEY } from './HexMapScene';
import {
  buildBotUpgradeScreenModel,
  renderBotUpgradeScreen,
  type BotUpgradeScreenView,
} from './hangarWar/botUpgradeScreen';

/** Scene key (matches the class name, per the scene convention). */
export const BOT_UPGRADE_SCENE_KEY = 'BotUpgradeScene';

/** Launch data accepted by {@link BotUpgradeScene}. */
export interface BotUpgradeSceneData {
  /**
   * The war payload the map handed over (one war state across both screens).
   * Omitted → the versioned store's payload.
   */
  payload?: HangarWarPayload;
  /**
   * Storage adapter. Omitted → the store's `localStorage` adapter; `null` →
   * in-memory only (a test that must not touch storage).
   */
  storage?: HangarWarStorage | null;
  /** The held hex whose defender is upgraded (required). */
  hexId: string;
  /** The catalogue to offer (defaults to the shipped catalogue). */
  catalogue?: readonly HangarEntry[];

  /**
   * A transient message carried in (e.g. a refused purchase re-rendered after
   * a scene restart). `null`/omitted renders none.
   */
  message?: string | null;
}

/** The bot-upgrade screen. */
export class BotUpgradeScene extends Phaser.Scene {
  /** The payload currently shown. */
  private payload: HangarWarPayload = createDefaultPayload(0);

  /** Injected storage adapter, or `undefined` for the store's default. */
  private storage: HangarWarStorage | null | undefined;

  /** The held hex whose defender is upgraded. */
  private hexId = '';

  /** The catalogue offered. */
  private catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE;

  /** A transient purchase message, or `null`. */
  private message: string | null = null;

  /** The rendered screen (rebuilt after every purchase). */
  private view: BotUpgradeScreenView | null = null;

  constructor() {
    super(BOT_UPGRADE_SCENE_KEY);
  }

  init(data?: BotUpgradeSceneData | null): void {
    this.storage = data?.storage;
    this.hexId = data?.hexId ?? '';
    this.catalogue = data?.catalogue ?? HANGAR_CATALOGUE;
    this.message = data?.message ?? null;
    if (data?.payload !== undefined) {
      this.payload = data.payload;
    } else {
      const loaded = this.loadPayload();
      this.payload = loaded;
    }
  }

  create(): void {
    this.build();
    addBackToMenuOnEsc(this);
  }

  /** The payload currently shown (a detached copy handed over by the map). */
  getPayload(): HangarWarPayload {
    return this.payload;
  }

  /** The rendered screen view, or `null` before `create`/after an exit. */
  getView(): BotUpgradeScreenView | null {
    return this.view;
  }

  /** Loads the stored payload, or a fresh default war when there is none. */
  private loadPayload(): HangarWarPayload {
    const stored =
      this.storage === undefined
        ? loadHangarWarPayload()
        : loadHangarWarPayload(this.storage);
    return stored ?? createDefaultPayload(0);
  }

  /** Persists the current payload through the versioned store. */
  private persist(): void {
    if (this.storage === null) return;
    if (this.storage === undefined) {
      saveHangarWarPayload(this.payload);
    } else {
      saveHangarWarPayload(this.payload, this.storage);
    }
  }

  /** (Re)renders the screen from the current payload. */
  private build(): void {
    this.view?.destroy();
    this.view = null;
    const model = buildBotUpgradeScreenModel(this.payload, this.hexId, {
      catalogue: this.catalogue,
      message: this.message,
    });
    if (model === null) {
      // The hex is no longer held (a defence tick fell between screens), so
      // there is nothing to upgrade: return to the map.
      this.openMap();
      return;
    }
    this.view = renderBotUpgradeScreen(this, model, {
      onPurchase: (entryId) => this.purchase(entryId),
      onBack: () => this.openMap(),
    });
  }

  /**
   * Buys one catalogue entry for the defender and persists the result.
   *
   * A refused purchase (slot-full, capped, already carried, gated or
   * unaffordable) leaves the payload unchanged, so a stale screen can never
   * spend salvage the pure rule did not authorise. The wallet deduction, the
   * applied upgrade and the recomputed `defenceRating` all land in the **same**
   * persisted payload, so they can never be written separately.
   *
   * @param entryId — the catalogue entry to send.
   * @returns true when the purchase happened and was persisted.
   */
  purchase(entryId: string): boolean {
    const result = buyBotUpgrade(this.payload, this.hexId, entryId, {
      catalogue: this.catalogue,
    });
    if (result.ok) {
      this.payload = result.payload;
      this.persist();
      const entry = findHangarEntry(entryId, this.catalogue);
      const name = entry?.name.toUpperCase() ?? entryId.toUpperCase();
      this.message = `SENT ${name} · ${botPriceLabel(result.spent)} · DEFENCE ${
        result.defenceRating
      }`;
    } else {
      this.message = `CANCELLED · ${(result.reason ?? 'refused').toUpperCase()}`;
    }
    this.build();
    return result.ok;
  }

  /** Returns to the hex map, carrying the (possibly upgraded) payload. */
  openMap(): void {
    this.scene.start(HEX_MAP_SCENE_KEY, {
      payload: this.payload,
      storage: this.storage,
    });
  }
}
