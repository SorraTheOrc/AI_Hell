/**
 * Single reusable enemy gym scene (AH-0MTHG5B83007W4W4).
 *
 * Parameterized by an `EnemyConfig` key via `init({ enemyKey })`. Resolves
 * the active config through `loadEnemyConfig(enemyKey)` — so an empty or
 * corrupt storage entry falls back to seed defaults without throwing — and
 * derives every formation property + entity/shot behaviour from the config
 * and its registries (`FORMATION_BUILDERS`, `createEnemyFromConfig`).
 *
 * Score: the scene reuses `GymFormationScene` for drift, HUD, bullets,
 * player, and combat. GymIndex discovery requires no extra registration;
 * this file lives under `src/scenes/gym/GymEnemies.ts` so the glob picks
 * it up automatically as `GymEnemies`.
 */

import Phaser from 'phaser';

import { loadEnemyConfig } from '../../core/enemyConfig';
import type { EnemyConfig } from '../../core/enemyConfig';
import type { FormationOffset } from '../../utils/formations';
import { getFormationBuilder } from '../../utils/formations';
import { PLAYER_SPAWN } from '../../core/constants';
import { createEnemyFromConfig, type EnemyEntity } from '../../entities/enemyFactory';
import type { FormationSceneBullet } from './core/GymFormationScene';
import { GymFormationScene, type EnemyFormationConfig } from './core/GymFormationScene';

export const GYM_ENEMIES_DEFAULT_KEY = 'scout';

type GymEnemiesBullet = FormationSceneBullet;

function enemyConfigToFormationConfig(enemyKey: string): EnemyFormationConfig<EnemyEntity, GymEnemiesBullet> {
  const cfg: EnemyConfig = loadEnemyConfig(enemyKey ?? GYM_ENEMIES_DEFAULT_KEY);
  const key = cfg.key || enemyKey || GYM_ENEMIES_DEFAULT_KEY;
  const builder = getFormationBuilder(cfg.formationKind);

  // Map shotPattern to bullet collection via the entity's shot seam.
  // Each entity type exposes a distinct tryFire* method; dispatch by key
  // with a graceful fallback for custom Save As enemies (unknown keys map
  // to Scout inside createEnemyFromConfig, so `scout` branch covers them).
  const collectBullets = (entity: EnemyEntity, now: number): GymEnemiesBullet[] => {
    // Access via duck-typing so we don't need exhaustive type casts.
    const e = entity as unknown as Record<string, unknown>;
    switch (key) {
      case 'scout': {
        const m = e['tryFireAimedBullet'] as ((now: number) => unknown) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
      case 'diver': {
        const m = e['tryFireSpreadBurst'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'tank': {
        const m = e['tryFireRadialBurst'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'phaser': {
        const m = e['tryFireRadialBullets'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'swarm': {
        const m = e['tryFireBurstBullet'] as ((now: number) => GymEnemiesBullet | null) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
      default: {
        // Custom Save As keys — Scout fallback entity
        const m = e['tryFireAimedBullet'] as ((now: number) => unknown) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
    }
  };

  return {
    sceneKey: 'GymEnemies',
    buildOffsets: builder,
    count: cfg.count,
    spacingX: cfg.spacingX,
    spacingY: cfg.spacingY,
    driftSpeed: cfg.driftSpeed,
    startX: cfg.startX,
    startY: cfg.startY,
    statusLabel: cfg.displayName.toLowerCase(),
    hintText: `${cfg.displayName} — ${cfg.formationKind} formation (config-driven)`,
    player: { ...PLAYER_SPAWN },
    createEntity: (scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) =>
      createEnemyFromConfig(scene, cfg, x, y, offset),
    collectBullets,
  };
}

export class GymEnemies extends GymFormationScene<EnemyEntity, GymEnemiesBullet> {
  private pendingKey: string = GYM_ENEMIES_DEFAULT_KEY;

  constructor() {
    // Seed with a default config; real active config is installed in init()
    // before create() runs, so even a corrupt key produces a valid scene.
    super(enemyConfigToFormationConfig(GYM_ENEMIES_DEFAULT_KEY));
  }

  init(data?: { enemyKey?: string }): void {
    const key = data?.enemyKey ?? GYM_ENEMIES_DEFAULT_KEY;
    this.pendingKey = key;
    const next = enemyConfigToFormationConfig(key);
    this.config = next;
    // GymFormationScene stores startX/Y into formationBaseX/Y in the
    // constructor; override them now so create() spawns at the correct
    // position even when the key changes between boots.
    this.formationBaseX = next.startX;
    this.formationBaseY = next.startY;
  }

  // Keep formationScouts-style compatibility for GymEnemies callers if needed.
  get formationEnemies(): EnemyEntity[] {
    return this.formationEntities;
  }

  /** Active config key this instance is running (post-init). */
  get activeEnemyKey(): string {
    return this.pendingKey;
  }
}
