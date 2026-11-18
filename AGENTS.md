## Global agent guidance

Read the global agent instructions at `~/.pi/agent/AGENTS.md` — they define the core principles, the Worklog (wl) work-item workflow, and the coding disciplines that apply to every project.

## Project-specific guidance

(project-specific rules are added by the project owner here, never by copying the global file)

## Game Architecture Conventions

### Gym↔game parity

Gyms are the canonical parity reference for the game. Any gameplay behaviour
change must be applied consistently to the corresponding gym scene(s) and the
game, unless a documented reason exists to diverge.

- **In scope (gyms):** every gym scene in `src/scenes/gym/`, including the
  generic base `src/scenes/gym/core/GymFormationScene.ts`.
- **In scope (game):** the shipped `PlayScene` and the shared core in
  `src/scenes/core/` (`CombatCoreScene`, `CombatScene`, the shared helpers
  alongside them and the spawn-transit seam
  `src/scenes/core/spawnTransit.ts`).

An enabled gameplay object must run the **same code** in a gym and in the game;
the only legitimate difference is a disabled feature, never a divergent copy.
Shared behaviour therefore lives once — in the shared core (`src/scenes/core/`)
and shared dispatchers — and is consumed by both the game and the gyms. When
changing a player, enemy, projectile, power-up or drop behaviour, update the gym
scene(s) that exercise it and `PlayScene` in the same change. If a gym must
intentionally diverge, record the reason in the work item and, where it is not
obvious, in a code comment next to the divergence.

The per-gym parity matrix in [`docs/GYM_PARITY.md`](./docs/GYM_PARITY.md)
records, for every gym scene, the shipped objects it runs, its spawn seam,
whether it inherits the shipped start-of-wave/combat code and every retained
divergence with its reason. The shared wormhole-transit destination rule
(`resolveSpawnTransitTarget` in `src/scenes/core/spawnTransit.ts`) is consumed
by the game and every gym that spawns enemies — orbital entities target their
live formation slot, autonomous movers are exempt and everything else targets
its grid slot — so spawn targeting cannot drift between a gym and the game.

The repo-wide duplicate-body guard in
`src/scenes/core/CombatScene.equivalence.test.ts` and the gym-parity docs
assertion enforce this rule automatically; see
[docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md](./docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md)
§5.1 for the full convention. (Tracked by AH-0MUGZDTFX004RBD1.)
