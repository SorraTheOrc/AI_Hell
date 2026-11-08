/**
 * Gym Index grouping & column layout (AH-0MW6OIQAA001YVGA) — pure helpers.
 *
 * The dev-mode Gym Index discovers every `Gym<Name>.ts` scene under
 * `src/scenes/gym/`. There are more plain scenes than fit between the title
 * and the bottom hint on a 540 px canvas, so the left column renders
 * **collapsible groups**: one focusable header row per category and, when a
 * group is expanded, its member rows directly below it.
 *
 * Everything in this module is pure and unit-testable so the index scene
 * only has to render what these helpers return:
 *
 * - {@link GYM_INDEX_GROUP_DEFINITIONS} — the ordered category map (group id,
 *   title and the scene keys it owns). Keys are scene keys (stable identity),
 *   so a renamed category never strands a scene silently — unknown keys fall
 *   into the {@link GYM_INDEX_OTHER_GROUP_ID} **Other** fallback instead.
 * - {@link groupGymScenes} — turns discovered entries into ordered groups.
 * - {@link buildColumnRows} — turns one column's entries into the rows to
 *   render: flat while the column fits, grouped headers + the expanded
 *   group's members once it does not. Column-agnostic, so a column that
 *   outgrows the screen in future groups automatically.
 * - {@link columnRowPitch} / {@link columnRowY} — the vertical fit maths that
 *   keeps every rendered row between the title and the bottom hint.
 *
 * Discovery itself stays directory-driven: a new `Gym<Name>.ts` file appears
 * in a sensible group automatically, or in **Other** when unmapped — no index
 * edit required.
 */

import { GAME_HEIGHT } from '../core/constants';

/** Minimum shape {@link groupGymScenes} needs from a discovered entry. */
export interface GymIndexGroupMember {
  /** Scene key (== class name), e.g. `GymPlayer`. */
  key: string;
  /** Display label (scene key with the leading `Gym` stripped). */
  label: string;
}

/** One rendered group: a header plus the discovered member entries. */
export interface GymIndexGroup<T extends GymIndexGroupMember = GymIndexGroupMember> {
  /** Stable group id (see {@link GYM_INDEX_GROUP_DEFINITIONS}). */
  id: string;
  /** Header text shown on the index. */
  title: string;
  /** Discovered entries in this group, in discovery (alphabetical) order. */
  members: T[];
}

/** A category definition in the ordered group map. */
export interface GymIndexGroupDefinition {
  /** Stable group id. */
  id: string;
  /** Header text shown on the index. */
  title: string;
  /** Scene keys owned by this group (scene key, not label). */
  keys: readonly string[];
}

/** Group id used as the fallback for discovered scenes not in the map. */
export const GYM_INDEX_OTHER_GROUP_ID = 'other';
/** Header text for the fallback group. */
export const GYM_INDEX_OTHER_GROUP_TITLE = 'Other';

/**
 * The ordered category map. Groups render in this order; the **Other**
 * fallback always renders last.
 *
 * `Player` and `Worlds` are deliberately split (the intake brief proposed a
 * single 7-scene `Combat` category) so that an expanded group still fits
 * between the title and the bottom hint — see the work item's *Risks &
 * assumptions*.
 */
export const GYM_INDEX_GROUP_DEFINITIONS: readonly GymIndexGroupDefinition[] = [
  {
    id: 'playerAndCombat',
    title: 'Player & Combat',
    keys: ['GymPlayer', 'GymRhythm', 'GymPerformance', 'GymAsteroidStress'],
  },
  {
    id: 'worlds',
    title: 'Worlds',
    keys: ['GymLevel', 'GymHexWar', 'GymHangar'],
  },
  {
    id: 'powerUps',
    title: 'Power-ups',
    keys: ['GymPowerUpLeveling', 'GymPowerUpsCombat', 'GymPowerUpsUtility'],
  },
  {
    id: 'weapons',
    title: 'Weapons',
    keys: ['GymWeapons', 'GymWeaponLeveling', 'GymWeaponTuning'],
  },
  {
    id: 'tuning',
    title: 'Tuning',
    keys: ['GymBotTuning', 'GymRechargeTuning'],
  },
  {
    id: 'minerals',
    title: 'Minerals',
    keys: ['GymMinerals'],
  },
];

/** Scene key → owning group id (mapped groups only, no fallback entry). */
export const GYM_INDEX_SCENE_GROUP: Readonly<Record<string, string>> = Object.freeze(
  GYM_INDEX_GROUP_DEFINITIONS.reduce<Record<string, string>>((map, group) => {
    for (const key of group.keys) map[key] = group.id;
    return map;
  }, {}),
);

/**
 * Group id for a scene key — the mapped group, or the **Other** fallback for
 * keys the map does not know (a newly added gym scene).
 */
export function groupIdForScene(key: string): string {
  return GYM_INDEX_SCENE_GROUP[key] ?? GYM_INDEX_OTHER_GROUP_ID;
}

/**
 * Groups discovered entries by category.
 *
 * Groups are returned in {@link GYM_INDEX_GROUP_DEFINITIONS} order, followed
 * by the **Other** fallback when (and only when) it has members. Empty groups
 * are omitted so no header floats alone, and member order is preserved
 * (discovery sorts alphabetically by label).
 */
export function groupGymScenes<T extends GymIndexGroupMember>(
  entries: readonly T[],
): GymIndexGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const definition of GYM_INDEX_GROUP_DEFINITIONS) {
    buckets.set(definition.id, []);
  }
  const other: T[] = [];
  for (const entry of entries) {
    const bucket = buckets.get(groupIdForScene(entry.key));
    if (bucket) bucket.push(entry);
    else other.push(entry);
  }

  const groups: GymIndexGroup<T>[] = [];
  for (const definition of GYM_INDEX_GROUP_DEFINITIONS) {
    const members = buckets.get(definition.id) ?? [];
    if (members.length > 0) {
      groups.push({ id: definition.id, title: definition.title, members });
    }
  }
  if (other.length > 0) {
    groups.push({
      id: GYM_INDEX_OTHER_GROUP_ID,
      title: GYM_INDEX_OTHER_GROUP_TITLE,
      members: other,
    });
  }
  return groups;
}

// ── Collapsible header labels ─────────────────────────────────────────

/** Indicator prefix of a collapsed group header. */
export const GYM_INDEX_GROUP_COLLAPSED_INDICATOR = '▸';
/** Indicator prefix of an expanded group header. */
export const GYM_INDEX_GROUP_EXPANDED_INDICATOR = '▾';

/**
 * Header label with its expand indicator, e.g. `▸ Weapons` (collapsed) or
 * `▾ Weapons` (expanded). Tests and pointer/keyboard toggling key off it.
 */
export function groupHeaderLabel(title: string, expanded: boolean): string {
  return `${expanded ? GYM_INDEX_GROUP_EXPANDED_INDICATOR : GYM_INDEX_GROUP_COLLAPSED_INDICATOR} ${title}`;
}

// ── Column rows ───────────────────────────────────────────────────────

/** Kind of a rendered column row. */
export type GymIndexRowKind = 'header' | 'member';

/** One row a column renders (a group header or an expanded member). */
export interface GymIndexRow<T extends GymIndexGroupMember = GymIndexGroupMember> {
  /** Header or member row. */
  kind: GymIndexRowKind;
  /** Owning group id (members carry their group too). */
  groupId: string;
  /** Row label (indicator-prefixed group title, or the scene label). */
  label: string;
  /** Scene key for member rows (headers have none). */
  sceneKey?: string;
  /** Discovered entry for member rows (headers have none). */
  entry?: T;
  /** True only for an expanded header row. */
  expanded: boolean;
}

/** Options for {@link buildColumnRows}. */
export interface BuildColumnRowsOptions {
  /** The single expanded group id for this column (accordion), if any. */
  expandedGroupId?: string | null;
  /** Flat-row capacity per column; defaults to {@link GYM_INDEX_MAX_FLAT_ROWS}. */
  maxFlatRows?: number;
}

/** The rows one column should render, plus whether grouping kicked in. */
export interface GymIndexColumnRows<T extends GymIndexGroupMember = GymIndexGroupMember> {
  /** True when the column overflowed its flat capacity and renders headers. */
  grouped: boolean;
  /** Rows in visual order (top → bottom). */
  rows: GymIndexRow<T>[];
}

/**
 * Builds one column's rows.
 *
 * A column that fits its flat capacity renders its entries flat (no headers),
 * so the short ENEMIES and Dev Utilities columns stay exactly as they are.
 * A column that overflows renders one header per group plus the members of
 * the single expanded group (accordion: at most one group expanded per
 * column, hidden members are never emitted, so they are never focusable).
 */
export function buildColumnRows<T extends GymIndexGroupMember>(
  entries: readonly T[],
  options: BuildColumnRowsOptions = {},
): GymIndexColumnRows<T> {
  const maxFlatRows = options.maxFlatRows ?? GYM_INDEX_MAX_FLAT_ROWS;
  const expandedGroupId = options.expandedGroupId ?? null;

  if (entries.length <= maxFlatRows) {
    return {
      grouped: false,
      rows: entries.map((entry) => ({
        kind: 'member' as const,
        groupId: groupIdForScene(entry.key),
        label: entry.label,
        sceneKey: entry.key,
        entry,
        expanded: false,
      })),
    };
  }

  const rows: GymIndexRow<T>[] = [];
  for (const group of groupGymScenes(entries)) {
    const expanded = group.id === expandedGroupId;
    rows.push({
      kind: 'header',
      groupId: group.id,
      label: groupHeaderLabel(group.title, expanded),
      expanded,
    });
    if (!expanded) continue;
    for (const member of group.members) {
      rows.push({
        kind: 'member',
        groupId: group.id,
        label: member.label,
        sceneKey: member.key,
        entry: member,
        expanded: false,
      });
    }
  }
  return { grouped: true, rows };
}

// ── Vertical fit ──────────────────────────────────────────────────────

/** Centre Y of the first column row (below the title at y=90). */
export const GYM_INDEX_ROW_START_Y = 150;
/**
 * Centre Y of the last row that still clears the bottom hint (y=524, ~14 px
 * tall): 500 + the 30 px row box's half height (15) = 515 < 517.
 */
export const GYM_INDEX_ROW_BOTTOM_Y = GAME_HEIGHT - 40;
/** Reserved height of one row box (18 px text + 6 px vertical padding). */
export const GYM_INDEX_ROW_HEIGHT = 30;
/** Preferred vertical pitch between rows. */
export const GYM_INDEX_ROW_MAX_PITCH = 36;
/** Tightest pitch that still keeps neighbouring 30 px row boxes apart. */
export const GYM_INDEX_ROW_MIN_PITCH = GYM_INDEX_ROW_HEIGHT + 2;
/** How many flat rows fit between {@link GYM_INDEX_ROW_START_Y} and the bottom. */
export const GYM_INDEX_MAX_FLAT_ROWS =
  Math.floor((GYM_INDEX_ROW_BOTTOM_Y - GYM_INDEX_ROW_START_Y) / GYM_INDEX_ROW_MIN_PITCH) + 1;

/**
 * Vertical pitch for a column with `rowCount` rows: the preferred pitch when
 * it fits, otherwise tightened towards {@link GYM_INDEX_ROW_MIN_PITCH} so the
 * rows stay inside the band (a column with more rows than
 * {@link GYM_INDEX_MAX_FLAT_ROWS} is grouped before it ever gets here, so the
 * floor is normally never reached).
 */
export function columnRowPitch(rowCount: number): number {
  if (rowCount <= 1) return GYM_INDEX_ROW_MAX_PITCH;
  const span = GYM_INDEX_ROW_BOTTOM_Y - GYM_INDEX_ROW_START_Y;
  const fitted = span / (rowCount - 1);
  return Math.max(GYM_INDEX_ROW_MIN_PITCH, Math.min(GYM_INDEX_ROW_MAX_PITCH, fitted));
}

/** Centre Y of row `index` (0-based) in a column of `rowCount` rows. */
export function columnRowY(index: number, rowCount: number): number {
  return GYM_INDEX_ROW_START_Y + index * columnRowPitch(rowCount);
}
