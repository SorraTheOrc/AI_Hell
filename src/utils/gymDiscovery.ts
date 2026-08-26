/**
 * Gym scene discovery — directory-dynamic index of gym scenes (AC3/AC4).
 *
 * The gym index enumerates scenes by reading `src/scenes/gym/` via Vite's
 * `import.meta.glob` (a build-time directory read — works in the dev
 * server, `vite preview`, and Vitest). Nothing is hard-coded: dropping a
 * new `Gym<Name>.ts` file into the folder makes it appear on the index
 * without editing any scene registry.
 *
 * Convention (`Gym<Name>.ts`, class + scene key `Gym<Name>`):
 *
 * - `src/scenes/gym/GymPlayer.ts` → key `GymPlayer`, label `Player`
 * - `src/scenes/gym/GymScout.ts`  → key `GymScout`,  label `Scout`
 *
 * `.test.ts` files are excluded from the list, and the index scene itself
 * lives outside the folder (`src/scenes/GymIndex.ts`) so it is naturally
 * excluded from discovery.
 */

/** A discovered gym scene: its key (== class name), display label, and class. */
export interface GymSceneEntry {
  /** Scene key == class name, e.g. `GymScout`. */
  key: string;
  /** Display label (key with the leading `Gym` stripped), e.g. `Scout`. */
  label: string;
  /** The scene class (the module's default export). */
  module: unknown;
}

/** True when the module path is a unit-test file (excluded from the index). */
export function isTestModulePath(path: string): boolean {
  return path.endsWith('.test.ts');
}

/**
 * Derives the scene key from a module path, e.g.
 * `/src/scenes/gym/GymScout.ts` → `GymScout`.
 */
export function sceneKeyFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.ts$/, '');
}

/** Derives the display label from a scene key, stripping the leading `Gym` (e.g. `GymScout` → `Scout`). */
export function displayLabelFromKey(key: string): string {
  return key.startsWith('Gym') ? key.slice(3) : key;
}

/**
 * Filters `.test.ts` files, derives each scene's key + label from its
 * module path, and sorts the result alphabetically by label.
 *
 * Pure and unit-testable — the caller supplies the `import.meta.glob`
 * result (`path → module`).
 */
export function discoverGymScenes(modules: Record<string, unknown>): GymSceneEntry[] {
  return Object.entries(modules)
    .filter(([path]) => !isTestModulePath(path))
    .map(([path, module]) => {
      const key = sceneKeyFromPath(path);
      return { key, label: displayLabelFromKey(key), module };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Loads every module in `src/scenes/gym/` eagerly (Vite build-time glob).
 * Keys are file paths; values are the modules' namespace objects (gym
 * scenes export their class as a **named** export matching the filename,
 * e.g. `GymScout.ts` → `{ GymScout, SCOUT_FORMATION_COUNT, ... }`). The
 * scene class is recovered by name via `sceneClassFromModule`. The index
 * scene lives outside the folder, so it is never matched here.
 *
 * `.test.ts` files are excluded **at the pattern level** (negative glob)
 * so Vitest's runtime never enters the browser bundle — bundling test
 * modules eagerly crashed `npm run dev` (Vitest's initSuite executing
 * client-side). The runtime `isTestModulePath` filter remains as a
 * defensive second layer.
 */
export function loadGymSceneModules(): Record<string, unknown> {
  return import.meta.glob(
    ['../scenes/gym/*.ts', '!../scenes/gym/*.test.ts'],
    { eager: true },
  );
}

/**
 * Recovers the scene class from a discovered module namespace: the named
 * export whose key matches the scene key (convention: class name == file
 * name, e.g. `GymScout.ts` exports `class GymScout`). Returns the class
 * when present, otherwise `undefined`.
 */
export function sceneClassFromModule(
  module: unknown,
  key: string,
): unknown {
  if (typeof module !== 'object' || module === null) return undefined;
  const named = (module as Record<string, unknown>)[key];
  return typeof named === 'function' ? named : undefined;
}