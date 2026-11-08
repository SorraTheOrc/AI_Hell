/**
 * Gym index — dev-mode entry scene (AC2/AC3/AC4).
 *
 * Discovers every gym scene under `src/scenes/gym/` via `import.meta.glob`.
 * The index renders three columns left-to-right (AH-0MV13G5EV008D41E):
 *
 * - **scenes** — plain scene entries; filtered to exclude enemy archetypes
 *   (`GymFodderEnemies`, `GymBoss`, `GymCentipede`) which are surfaced in
 *   the ENEMIES column instead;
 * - **ENEMIES** — a single "Fodder Enemies" row booting the reusable
 *   `GymFodderEnemies` scene bare (its in-panel dropdown selects the
 *   archetype — including the Centipede chain, AH-0MV4ZOIZR0086T66) plus
 *   the dedicated multi-phase `GymBoss` "Boss" row and the dedicated
 *   config-driven `GymMiniBoss` "Mini-Boss" row (AH-0MVCRAYSH0014BQJ);
 * - **Dev Utilities** — tooling scenes such as the difficulty-curve
 *   sequencer, booted directly via `sceneKey`.
 *
 * A new `Gym<Name>.ts` file dropped into the folder appears automatically;
 * the EnemyConfig archetypes are discovered *inside* `GymFodderEnemies`'s
 * panel from the config store, so a Save As entry needs no index change.
 * The Centipede chain is not a CSV config (it is a wave opt-in), so it is
 * surfaced as a dedicated option inside `GymFodderEnemies`'s dropdown
 * rather than a separate ENEMIES row (AH-0MV4ZOIZR0086T66). `GymBoss` and
 * `GymMiniBoss` are excluded from the plain scene list because both are
 * surfaced as dedicated ENEMIES rows.
 *
 * ### Collapsible groups (AH-0MW6OIQAA001YVGA)
 *
 * There are more plain scenes than fit between the title and the bottom
 * hint, so a column that overflows its flat capacity renders **collapsible
 * groups** instead of one long list: one focusable header row per category
 * (with a `▸`/`▾` expand indicator) and, when a group is expanded, its
 * member rows directly below it. Groups are an accordion — at most one group
 * expanded per column, all collapsed on create, and expansion is not
 * persisted. Grouping is data-driven (`./gymIndexGroups`) with an **Other**
 * fallback, so a new `Gym<Name>.ts` still appears without an index edit.
 *
 * The mechanism is column-agnostic: the short ENEMIES (3 rows) and Dev
 * Utilities (1 row) columns stay flat because they fit, and a column that
 * outgrows the screen in future groups automatically. Row pitch comes from
 * the same fit maths, so every rendered row stays between the title and the
 * bottom hint.
 *
 * Keyboard navigation (AH-0MUDZFBYY008P7ZE, AH-0MV1BKZ0J00946EX) is
 * provided by the shared {@link FocusManager}. The index opts in to its
 * **grid** navigation model over the *visible* rows only: the first row is
 * focused by default, **Left / Right** move focus between the three columns
 * (wrapping at both ends, and clamping to a shorter column's last valid row),
 * **Up / Down** move within the current column (wrapping top ↔ bottom), and
 * **Tab / Shift+Tab** keep their linear reading-order cycling. Enter/Space
 * launch a focused member, or toggle a focused group header, through the same
 * code path as a pointer click. Collapsed members are never rendered, so
 * they are never focusable. Pointer handlers and ESC-to-menu remain
 * unchanged (keyboard support is additive).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  discoverGymScenes,
  GymSceneEntry,
  loadGymSceneModules,
  sceneClassFromModule,
} from '../utils/gymDiscovery';
import { FocusManager } from '../utils/focusManager';
import { addBackToMenuOnEsc } from '../utils/gymNavigation';
import {
  buildColumnRows,
  columnRowY,
  type GymIndexGroup,
  type GymIndexGroupMember,
  type GymIndexRow,
  type GymIndexRowKind,
  groupGymScenes,
} from './gymIndexGroups';

/** Index title text (asserted by tests). */
export const GYM_INDEX_TITLE = 'GYM INDEX';
/** Bottom hint line (advertises the keyboard controls). */
export const GYM_INDEX_HINT =
  '←/→ column · ↑/↓ row · enter/space select or expand · tab cycles · ESC menu';

/** Scene key of the reusable fodder-enemy gym (formerly `GymEnemies`). */
export const FODDER_ENEMIES_SCENE_KEY = 'GymFodderEnemies';
/** Label of the single fodder-enemy row in the ENEMIES column. */
export const FODDER_ENEMIES_LABEL = 'Fodder Enemies';
/** Scene key of the dedicated multi-phase boss (the real Central AI). */
export const BOSS_SCENE_KEY = 'GymBoss';
/** Label of the dedicated boss row in the ENEMIES column. */
export const BOSS_SCENE_LABEL = 'Boss';
/** Scene key of the dedicated config-driven mini-boss gym scene. */
export const MINI_BOSS_SCENE_KEY = 'GymMiniBoss';
/** Label of the dedicated mini-boss row in the ENEMIES column. */
export const MINI_BOSS_SCENE_LABEL = 'Mini-Boss';
/** Scene key of the dedicated centipede chain gym scene. The scene is
 * excluded from the plain-scenes column (it is an enemy archetype) and is
 * reachable as a dedicated option inside `GymFodderEnemies`'s dropdown rather
 * than a separate ENEMIES row (AH-0MV4ZOIZR0086T66). */
export const CENTIPEDE_SCENE_KEY = 'GymCentipede';
/** Label used for the Centipede inside `GymFodderEnemies`'s enemy selector. */
export const CENTIPEDE_LABEL = 'Centipede';

/**
 * Scene keys surfaced in the far-right **Dev Utilities** column rather than
 * the plain scene list (AH-0MUGXDVPH005TIZL). Each row boots its scene
 * directly via `sceneKey`, mirroring the dedicated `GymBoss` row.
 */
export const DEV_UTILITY_SCENE_KEYS = ['GymCurveSequencer'] as const;
/** Membership set for {@link DEV_UTILITY_SCENE_KEYS}. */
const DEV_UTILITY_SCENE_KEY_SET: ReadonlySet<string> = new Set(DEV_UTILITY_SCENE_KEYS);

/**
 * Column X positions as fractions of `GAME_WIDTH`, ordered left-to-right:
 * scenes | ENEMIES | Dev Utilities (AH-0MV13G5EV008D41E; the Bosses column
 * was retired and its dedicated row moved into ENEMIES).
 */
export const GYM_INDEX_COLUMN_X = {
  scenes: 0.25,
  enemies: 0.55,
  devUtilities: 0.85,
} as const;

/** Identifier of one index column (mirrors {@link GYM_INDEX_COLUMN_X} keys). */
export type GymIndexColumnId = keyof typeof GYM_INDEX_COLUMN_X;

/** Column ids in reading order (left → right). */
const COLUMN_ORDER: readonly GymIndexColumnId[] = ['scenes', 'enemies', 'devUtilities'];

/** Header label for the middle ENEMIES column (kept uppercase). */
export const GYM_INDEX_ENEMIES_HEADER = 'ENEMIES';
/** Header label for the far-right Dev Utilities column. */
export const GYM_INDEX_DEV_UTILITIES_HEADER = 'Dev Utilities';

/** Y of the per-column header text (ENEMIES / Dev Utilities). */
const COLUMN_HEADER_Y = 150 - 18;

const TITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '28px',
  color: '#00ffff',
};
const ENTRY_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '18px',
  color: '#00ff00',
  backgroundColor: '#1a1a1a',
  padding: { x: 10, y: 6 },
};
/**
 * Group header style: same box metrics as a member row (so the column stays
 * aligned) with a tinted background — the focus manager recolours the text,
 * so the tint has to live on the background to survive a focus change.
 */
const GROUP_HEADER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  ...ENTRY_STYLE,
  color: '#55ccff',
  backgroundColor: '#233a55',
};
const COLUMN_HEADER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#888888',
};
const HINT_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#555555',
};

/**
 * A clickable row rendered in the ENEMIES or Dev Utilities column.
 *
 * Two flavours are merged here:
 * - **config rows** carry `enemyKey` and boot `GymFodderEnemies` with
 *   `{ enemyKey }` (kept for completeness/deep links);
 * - **scene rows** carry `sceneKey` and boot that scene directly (the
 *   reusable `GymFodderEnemies` row, the dedicated `GymBoss` row and the
 *   Dev Utilities tooling scenes are surfaced this way).
 */
export interface EnemyColumnEntry {
  /** Unique row key: scene key for scene rows, `GymFodderEnemies:<configKey>` for config rows. */
  key: string;
  /** Human label shown on the index. */
  label: string;
  /** Enemy config key for rows routed to `GymFodderEnemies` as `{ enemyKey }`. */
  enemyKey?: string;
  /** Dedicated scene key for rows that boot a scene directly (e.g. `GymBoss`). */
  sceneKey?: string;
}

/** One visible index row (group header or member) in reading order. */
export interface GymIndexVisibleRow {
  /** Column the row belongs to. */
  columnId: GymIndexColumnId;
  /** Header or member row. */
  kind: GymIndexRowKind;
  /** Owning group id (`''` for flat columns' rows). */
  groupId: string;
  /** Row label (indicator-prefixed group title, or the scene label). */
  label: string;
  /** Scene key for member rows. */
  sceneKey?: string;
}

/** A column row before rendering: its label, activation and scene routing. */
interface ColumnSource extends GymIndexGroupMember {
  /** Boots the row's scene (shared by pointer and keyboard). */
  activate: () => void;
  /** Enemy config key for rows routed to `GymFodderEnemies` as `{ enemyKey }`. */
  enemyKey?: string;
  /** Scene key exposed as row data (and used by direct-boot rows). */
  sceneKey?: string;
}

export class GymIndex extends Phaser.Scene {
  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  /** Focusable rows in reading order (label + text object). */
  private controls: { label: string; text: Phaser.GameObjects.Text }[] = [];

  private entries: GymSceneEntry[] = [];
  private enemyEntries: EnemyColumnEntry[] = [];
  private devEntries: EnemyColumnEntry[] = [];

  /** The single expanded group per column (accordion; reset on create). */
  private expandedGroups: Partial<Record<GymIndexColumnId, string | null>> = {};

  /** Rendered rows per column, in visual order (aligned with the controls). */
  private renderedRows: Partial<Record<GymIndexColumnId, GymIndexRow<ColumnSource>[]>> = {};

  /** Focus-control indices per column, aligned with {@link renderedRows}. */
  private renderedColumns: Partial<Record<GymIndexColumnId, number[]>> = {};

  constructor() {
    super({ key: 'GymIndex' });
  }

  create(): void {
    // Fresh focus registry + collapsed groups on every create() so a
    // restarted scene neither accumulates stale controls nor remembers an
    // expanded group (expanded state is deliberately not persisted).
    this.focusManager = new FocusManager();
    this.controls = [];
    this.expandedGroups = {};
    this.renderedRows = {};
    this.renderedColumns = {};

    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    // Genuine scene entries (GymPlayer, etc.). Filter out GymFodderEnemies —
    // it is no longer listed as a bare scene; a single ENEMIES row boots it.
    // Filter out GymBoss — the real boss is surfaced as a dedicated row in
    // the ENEMIES column instead of the plain scene list (AH-0MUAYB28C004KK7X).
    // Filter out GymMiniBoss — the config-driven mini-boss family is likewise
    // surfaced as a dedicated ENEMIES row (AH-0MVCRAYSH0014BQJ).
    // Filter out GymCentipede — the centipede chain is an enemy archetype;
    // it is surfaced as a dedicated option inside GymFodderEnemies's
    // dropdown rather than as a bare plain-scene entry (AH-0MV4ZOIZR0086T66).
    const all = discoverGymScenes(loadGymSceneModules());

    // Far-right Dev Utilities column — tooling scenes categorised away from
    // the plain scene list, each booted directly via `sceneKey`
    // (AH-0MUGXDVPH005TIZL).
    this.devEntries = all
      .filter((e) => DEV_UTILITY_SCENE_KEY_SET.has(e.key))
      .map((e) => ({ key: e.key, label: e.label, sceneKey: e.key }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));

    this.entries = all.filter(
      (e) =>
        e.key !== FODDER_ENEMIES_SCENE_KEY &&
        e.key !== BOSS_SCENE_KEY &&
        e.key !== MINI_BOSS_SCENE_KEY &&
        e.key !== CENTIPEDE_SCENE_KEY &&
        !DEV_UTILITY_SCENE_KEY_SET.has(e.key),
    );

    // Register every discovered scene so `scene.start(key)` works for each
    // index row (plain scenes, Dev Utilities, the reusable fodder gym and the
    // dedicated boss). The fodder and boss scenes are not in the plain list
    // but are booted directly by their ENEMIES rows.
    for (const entry of all) {
      if (!this.scene.manager.getScene(entry.key)) {
        const sceneClass = sceneClassFromModule(entry.module, entry.key);
        if (sceneClass) this.scene.add(entry.key, sceneClass as typeof Phaser.Scene);
      }
    }

    // Middle ENEMIES column (AH-0MV13G5EV008D41E): the single reusable fodder
    // gym (booted bare; its dropdown selects the archetype — including the
    // Centipede chain, AH-0MV4ZOIZR0086T66) followed by the dedicated
    // multi-phase `GymBoss` scene. Per-config rows, the `boss` "Boss Swarm"
    // row and the Bosses column were retired.
    this.enemyEntries = [
      {
        key: FODDER_ENEMIES_SCENE_KEY,
        label: FODDER_ENEMIES_LABEL,
        sceneKey: FODDER_ENEMIES_SCENE_KEY,
      },
      {
        key: BOSS_SCENE_KEY,
        label: BOSS_SCENE_LABEL,
        sceneKey: BOSS_SCENE_KEY,
      },
      {
        key: MINI_BOSS_SCENE_KEY,
        label: MINI_BOSS_SCENE_LABEL,
        sceneKey: MINI_BOSS_SCENE_KEY,
      },
    ];

    // Render the index. Rebuilding goes through the same path on every
    // expand/collapse toggle, so a toggle can never leave a stale control
    // registered (collapsed members must not be focusable).
    this.renderIndex();

    // Tear the keyboard listener down on scene shutdown so a restart does
    // not leak it. Registered once, outside the re-render path.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * Renders (or re-renders) the whole index: title, grouped columns, hint and
   * focus wiring. Called from `create()` and from every expand/collapse
   * toggle, so hidden members are never registered as focus controls.
   *
   * @param focus — optional group header to focus after the re-render (the
   *   header the user just toggled, via pointer or Enter/Space).
   */
  private renderIndex(focus?: { columnId: GymIndexColumnId; groupId: string }): void {
    // A rebuild replaces the focus registry wholesale: detach the previous
    // keyboard listener first, then start a fresh manager.
    this.focusManager.shutdown();
    this.focusManager = new FocusManager();
    this.controls = [];
    this.renderedRows = {};
    this.renderedColumns = {};

    // Drop the previous render (rows, headers, title, hint) so repeated
    // toggles do not accumulate display objects.
    this.children.removeAll(true);

    // ── Title ────────────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 90, GYM_INDEX_TITLE, TITLE_STYLE).setOrigin(0.5);

    // ── Grouped three-column layout ────────────────────────────────
    // Columns are distributed left-to-right across the width. The plain
    // scenes column has no column header; ENEMIES and Dev Utilities keep
    // theirs. Every column goes through the same row builder, so the short
    // columns stay flat and only an overflowing column groups.
    this.renderedColumns.scenes = this.renderColumn(
      'scenes',
      this.entries.map((entry) => ({
        key: entry.key,
        label: entry.label,
        sceneKey: entry.key,
        activate: () => this.scene.start(entry.key),
      })),
      GYM_INDEX_COLUMN_X.scenes,
    );
    this.renderedColumns.enemies = this.renderColumn(
      'enemies',
      this.enemyEntries.map((entry) => this.columnSourceFromEntry(entry)),
      GYM_INDEX_COLUMN_X.enemies,
      GYM_INDEX_ENEMIES_HEADER,
    );
    this.renderedColumns.devUtilities = this.renderColumn(
      'devUtilities',
      this.devEntries.map((entry) => this.columnSourceFromEntry(entry)),
      GYM_INDEX_COLUMN_X.devUtilities,
      GYM_INDEX_DEV_UTILITIES_HEADER,
    );

    // ── Keyboard focus (AH-0MUDZFBYY008P7ZE) ─────────────────────────
    // The shared FocusManager owns Tab / arrow cycling and Enter / Space
    // activation. Rows are registered in reading order (visible plain-scene
    // rows → ENEMIES → Dev Utilities), so the first row is the first group
    // header when the scenes column groups. Grid mode makes Left/Right move
    // between the three columns and Up/Down move within a column
    // (AH-0MV1BKZ0J00946EX); Tab stays linear. Pointer handlers stay
    // unchanged — keyboard support is additive.
    this.focusManager.attachKeyboard(this, {
      navigation: 'grid',
      columns: COLUMN_ORDER.map((columnId) => this.renderedColumns[columnId] ?? []),
    });

    // ── Hint ─────────────────────────────────────────────────────────
    this.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 16, GYM_INDEX_HINT, HINT_STYLE)
      .setOrigin(0.5);

    if (focus) this.focusGroupHeader(focus.columnId, focus.groupId);
  }

  /**
   * Renders one column: its optional column header plus the rows the shared
   * builder returns (flat while the column fits, grouped once it overflows).
   *
   * @returns the registered focus-control indices for this column, in visual
   *   order (empty when the column has no entries).
   */
  private renderColumn(
    columnId: GymIndexColumnId,
    sources: ColumnSource[],
    xFraction: number,
    columnHeaderText?: string,
  ): number[] {
    if (sources.length === 0) return [];

    const x = GAME_WIDTH * xFraction;
    if (columnHeaderText) {
      this.add.text(x, COLUMN_HEADER_Y, columnHeaderText, COLUMN_HEADER_STYLE).setOrigin(0.5);
    }

    const { rows } = buildColumnRows(sources, {
      expandedGroupId: this.expandedGroups[columnId] ?? null,
    });
    this.renderedRows[columnId] = rows;

    const column: number[] = [];
    rows.forEach((row, index) => {
      const style = row.kind === 'header' ? GROUP_HEADER_STYLE : ENTRY_STYLE;
      const text = this.add
        .text(x, columnRowY(index, rows.length), row.label, style)
        .setOrigin(0.5);

      if (row.kind === 'header') {
        column.push(
          this.registerRow(text, row.label, () => this.toggleGroup(columnId, row.groupId)),
        );
        return;
      }

      const source = row.entry as ColumnSource;
      if (source.enemyKey) text.setData('enemyKey', source.enemyKey);
      if (source.sceneKey) text.setData('sceneKey', source.sceneKey);
      column.push(this.registerRow(text, row.label, source.activate));
    });
    return column;
  }

  /** Maps an ENEMIES/Dev Utilities entry onto a column row source. */
  private columnSourceFromEntry(entry: EnemyColumnEntry): ColumnSource {
    return {
      key: entry.key,
      label: entry.label,
      sceneKey: entry.sceneKey,
      enemyKey: entry.enemyKey,
      activate: () => this.activateEntry(entry),
    };
  }

  // ── Group toggling ────────────────────────────────────────────────

  /**
   * Expands or collapses one group (accordion: expanding a group collapses
   * whichever group was expanded in the same column), then re-renders with
   * focus back on the toggled header.
   */
  private toggleGroup(columnId: GymIndexColumnId, groupId: string): void {
    const current = this.expandedGroups[columnId] ?? null;
    this.expandedGroups[columnId] = current === groupId ? null : groupId;
    this.renderIndex({ columnId, groupId });
  }

  /** Focuses the rendered header of `groupId` in `columnId` (after re-render). */
  private focusGroupHeader(columnId: GymIndexColumnId, groupId: string): void {
    const rows = this.renderedRows[columnId] ?? [];
    const controls = this.renderedColumns[columnId] ?? [];
    const index = rows.findIndex((row) => row.kind === 'header' && row.groupId === groupId);
    if (index >= 0 && index < controls.length) {
      this.focusManager.setFocusedIndex(controls[index]);
    }
  }

  // ── Activation & focus helpers ────────────────────────────────────

  /**
   * Activation shared by pointer and keyboard for an ENEMIES/Dev Utilities
   * row: scene rows boot their `sceneKey` directly (including the bare
   * `GymFodderEnemies` and `GymBoss` rows), config rows boot
   * `GymFodderEnemies` with `{ enemyKey }`.
   */
  private activateEntry(entry: EnemyColumnEntry): void {
    if (entry.sceneKey) this.scene.start(entry.sceneKey);
    else this.scene.start(FODDER_ENEMIES_SCENE_KEY, { enemyKey: entry.enemyKey });
  }

  /**
   * Wires a row for pointer (`pointerdown`) and keyboard (FocusManager)
   * activation through the same callback, and records its label so
   * {@link getFocusedLabel} can report the focused row in tests.
   *
   * @returns the row's index in the focus manager, so the caller can build
   *   the grid columns.
   */
  private registerRow(
    row: Phaser.GameObjects.Text,
    label: string,
    activate: () => void,
  ): number {
    row.setInteractive({ useHandCursor: true });
    row.on('pointerdown', activate);
    const index = this.focusManager.register(row, activate);
    this.controls.push({ label, text: row });
    return index;
  }

  // ── Public test accessors ─────────────────────────────────────────

  /** Discovered gym scenes (left column; excludes GymFodderEnemies, GymBoss and Dev Utilities). */
  get listedScenes(): { key: string; label: string }[] {
    return this.entries.map((e) => ({ key: e.key, label: e.label }));
  }

  /** Ordered, category-grouped view of {@link listedScenes} (empty groups omitted). */
  get listedGroups(): { id: string; title: string; members: { key: string; label: string }[] }[] {
    return groupGymScenes(this.entries).map((group: GymIndexGroup<GymSceneEntry>) => ({
      id: group.id,
      title: group.title,
      members: group.members.map((entry) => ({ key: entry.key, label: entry.label })),
    }));
  }

  /**
   * Middle ENEMIES column rows: the single reusable fodder-enemy row
   * (booted bare; its dropdown selects the archetype, including the Centipede
   * chain) followed by the dedicated `GymBoss` row.
   */
  get listedEnemyScenes(): EnemyColumnEntry[] {
    return this.enemyEntries.map((e) => ({ ...e }));
  }

  /**
   * Far-right Dev Utilities column rows: tooling scenes (e.g.
   * `GymCurveSequencer`), each booted directly via `sceneKey`.
   */
  get listedDevUtilityScenes(): EnemyColumnEntry[] {
    return this.devEntries.map((e) => ({ ...e }));
  }

  /** Currently expanded group id for a column (`null` when all collapsed). */
  getExpandedGroup(columnId: GymIndexColumnId): string | null {
    return this.expandedGroups[columnId] ?? null;
  }

  /** Rows rendered per column (group headers + visible members only), in visual order. */
  getColumnRows(columnId: GymIndexColumnId): GymIndexVisibleRow[] {
    return (this.renderedRows[columnId] ?? []).map((row) => ({
      columnId,
      kind: row.kind,
      groupId: row.groupId,
      label: row.label,
      sceneKey: row.sceneKey,
    }));
  }

  /** Every rendered row in reading order (columns left → right, rows top → bottom). */
  get visibleRows(): GymIndexVisibleRow[] {
    return COLUMN_ORDER.flatMap((columnId) => this.getColumnRows(columnId));
  }

  /** Index of the currently focused row in reading order (−1 when none). */
  getFocusedIndex(): number {
    return this.focusManager.getFocusedIndex();
  }

  /** Total number of focusable rows registered across all columns. */
  getFocusControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** Display label of the currently focused row ('' when none). */
  getFocusedLabel(): string {
    const index = this.focusManager.getFocusedIndex();
    return this.controls[index]?.label ?? '';
  }
}
