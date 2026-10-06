# AI Hell ToneForge recipes

Game-specific [ToneForge](../../../ToneForge) recipes for the AI Hell SFX
palette. This directory is the authoring home for the game's audio cues; it is
consumed by the deterministic WAV build pipeline
(`scripts/build-audio.sh` — see [Deterministic WAV build pipeline]):
every cue is rendered from a data-only recipe with a reserved seed and baked
into `public/audio/sfx/`.

This work is part of **Switch game audio from procedural Web Audio to
ToneForge (AH-0MUTUOB7X007PR9J)** and implements **Author game-specific
ToneForge recipes (AH-0MUTYV8480019Z51)**. The authoritative cue catalogue is
[`docs/AUDIO_TONEFORGE_CUE_MAPPING.md`](../../../docs/AUDIO_TONEFORGE_CUE_MAPPING.md).

## Layout

```text
audio/toneforge/
├── recipes/                       # data-only ToneGraph YAML, one per cue slug
│   └── aihell-*.yaml
├── presets/                       # composite stack/sequence JSON
│   ├── aihell-player-hull-breach.stack.json
│   ├── aihell-victory-fanfare.sequence.json
│   └── aihell-defeat-sting.sequence.json
└── README.md                      # this file
```

No files inside the sibling `../ToneForge` checkout are edited. Recipes are made
resolvable to a fresh `tf` process through ToneForge's **external recipe
directory** mechanism (`TONEFORGE_RECIPE_DIR`).

## Rendering a recipe

```bash
# Point the CLI at this directory; every aihell-*.yaml is discovered.
export TONEFORGE_RECIPE_DIR="$PWD/audio/toneforge/recipes"

# Render a single cue at its reserved seed.
tf generate --recipe aihell-cannon-fire --seed 32210 --output /tmp/cannon-fire.wav

# Render the multi-seed pitch-jitter variants (explosions).
tf generate --recipe aihell-enemy-destruction --seed-range 32110:32112 --output /tmp/enemy-destruction/
```

Composite cues are also available as stack/sequence presets composed from
existing ToneForge primitives:

```bash
tf stack render    --preset audio/toneforge/presets/aihell-player-hull-breach.stack.json --seed 32120
tf sequence generate --preset audio/toneforge/presets/aihell-victory-fanfare.sequence.json --seed 32240
tf sequence generate --preset audio/toneforge/presets/aihell-defeat-sting.sequence.json --seed 32241
```

Every recipe declares its full render length in `meta.duration`, so no external
duration argument is required.

## Recipes

Seed block **32100–32199** is reserved for game-specific recipes. One-shots use
a single seed; cues whose original character used per-invocation pitch jitter
(`EXPLOSION_PITCH_JITTER` ±15 %) use a **seed range** so repeated kills still
vary (the recipe declares `startFreq`/`endFreq` parameters whose values are
derived from the render seed).

| Recipe (`audio/toneforge/recipes/`) | Cue | Audible character | Reserved seed(s) |
|-------------------------------------|-----|-------------------|------------------|
| `aihell-enemy-spawn.yaml` | `playSpawnSound` | Rising square blip 220→880 Hz, 0.18 s | 32101 |
| `aihell-enemy-destruction.yaml` | `playDestructionSound` | Descending saw 440→60 Hz, 0.28 s (pitch jitter) | 32110–32112 |
| `aihell-player-hull-breach.yaml` | `playPlayerDestructionSound` | Layered saw thump 120→32 Hz + triangle body 260→42 Hz + HP noise tail | 32120 |
| `aihell-bullet-destruction.yaml` | `playBulletDestructionSound` | Square tick 1400→900 Hz, 0.07 s | 32130 |
| `aihell-tank-advance.yaml` | `playTankAdvanceCue` | Rising saw whine 150→320 Hz + square sub 75→160 Hz, 0.6 s | 32140 |
| `aihell-tank-fire.yaml` | `playTankFireSound` | Saw + sine cannon thump 90→28 Hz | 32141 |
| `aihell-pickup-spawn.yaml` | `playPowerUpSpawnSound` | Bright ascending sine blip 440→1760 Hz | 32150 |
| `aihell-pickup-despawn.yaml` | `playPowerUpDespawnSound` | Short descending sine blip 880→220 Hz | 32151 |
| `aihell-pickup-pop.yaml` | `playPowerUpCollectPopSound` | Saw drop 600→100 Hz + HP noise transient | 32152 |
| `aihell-swarm-burst.yaml` | `playSwarmBurstSound` | Saw buzz 120→80 Hz + sine whoosh 200→600 Hz | 32160 |
| `aihell-phaser-advance.yaml` | `playPhaserAdvanceCue` | Rising sine 660→880 Hz, 0.6 s | 32170 |
| `aihell-phaser-fire.yaml` | `playPhaserFireSound` | Triangle drop 1000→500 Hz | 32171 |
| `aihell-scout-advance.yaml` | `playScoutAdvanceCue` | Rising sine 880→1320 Hz, 0.6 s | 32180 |
| `aihell-diver-dive-start.yaml` | `playDiverDiveStartSound` | Rising saw 150→600 Hz + bandpass noise | 32190 |
| `aihell-diver-dive-loop.yaml` | `playDiveSound` | Loopable bandpass noise sweep 300→900 Hz, 2 s | 32191 |
| `aihell-diver-fire.yaml` | `playDiverFireSound` | Saw drop 280→120 Hz | 32192 |
| `aihell-diver-destruction.yaml` | `playDiverDestructionSound` | Descending saw 280→40 Hz + sine undertone (pitch jitter) | 32193–32195 |
| `aihell-boss-fire.yaml` | `playBossFireSound` | Saw 200→50 Hz + low sine undertone | 32200 |
| `aihell-cannon-fire.yaml` | `playCannonFireSound` | Square tick 800→400 Hz, 0.08 s | 32210 |
| `aihell-spread-fire.yaml` | `playSpreadFireSound` | Triangle 600→1200→800 Hz | 32211 |
| `aihell-dual-fire.yaml` | `playDualFireSound` | Saw drop 900→300 Hz + offset sine tick | 32212 |
| `aihell-rapid-fire.yaml` | `playRapidFireSound` | Triangle rise 500→900 Hz | 32213 |
| `aihell-nova-fire.yaml` | `playNovaFireSound` | Saw thump 160→40 Hz + rising triangle ring 300→1800 Hz | 32214 |
| `aihell-mortar-fire.yaml` | `playMortarFireSound` | Muffled triangle 220→90 Hz + barrel tick | 32215 |
| `aihell-mortar-detonation.yaml` | `playMortarDetonationSound` | Heavy saw 180→40 Hz + LP noise wash | 32216 |
| `aihell-arc-fire.yaml` | `playArcFireSound` | Square zap 1400→500→1120 Hz + HP crackle | 32217 |
| `aihell-pickup-spread.yaml` | `playSpreadPickupSound` | Triangle 500→1500→800 Hz | 32220 |
| `aihell-pickup-dual.yaml` | `playDualPickupSound` | Two saw drops 1000→500 / 1200→700 Hz | 32221 |
| `aihell-pickup-rapid.yaml` | `playRapidPickupSound` | Triangle rise 400→1600 Hz | 32222 |
| `aihell-pickup-reset.yaml` | `playResetPickupSound` | Sine fall 900→300 Hz | 32223 |
| `aihell-pickup-speed.yaml` | `playSpeedBoostCollectSound` | Square rise 600→1800 Hz | 32224 |
| `aihell-pickup-extralife.yaml` | `playExtraLifeCollectSound` | Two warm sine chimes 440→880 / 660→990 Hz | 32225 |
| `aihell-pickup-magnet.yaml` | `playMagnetCollectSound` | Square pulse 180→90→180 Hz + sine undertone | 32226 |
| `aihell-phase-shift.yaml` | `playPhaseShiftSound` | Triangle chirp 320→1560 Hz + bandpass noise swing 600→3200 Hz | 32230 |
| `aihell-victory-fanfare.yaml` | `playVictoryFanfareSound` | Two-phrase fanfare: arpeggio + cadence + chord + bass + sparkle + shimmer | 32240 |
| `aihell-defeat-sting.yaml` | `playDefeatStingSound` | Five-note descent + sinking drone + LP rumble tail | 32241 |
| `aihell-thruster-hum.yaml` | `updateThrusterSound` | Continuous triangle 60 Hz + sine 35 Hz + BP noise 700–1100 Hz (runtime shim) | 32250 |
| `aihell-boss-spawn.yaml` | `playBossSpawnSound` | Rising sine 80→220 Hz, 0.45 s | 32201 |
| `aihell-boss-phase-transition.yaml` | `playBossPhaseTransitionSound` | Square rise 220→880 Hz | 32202 |
| `aihell-boss-destruction.yaml` | `playBossDestructionSound` | Descending saw 180→20 Hz, 0.6 s | 32203 |
| `aihell-boss-phase-cue.yaml` | `playBossPhaseCue` | Per-phase square rise (four variants) | 32204–32207 |

### Pitch-jitter variants

`aihell-enemy-destruction` (32110–32112), `aihell-diver-destruction`
(32193–32195) and `aihell-boss-phase-cue` (32204–32207) declare free
parameters (`startFreq`, `endFreq`) whose values are derived from the render
seed, so each seed in the range produces a distinct WAV. The build pipeline
renders the whole range and selects among the variants at runtime, preserving
the original per-invocation pitch variation.

### Composite cues

`aihell-player-hull-breach`, `aihell-victory-fanfare` and
`aihell-defeat-sting` are authored as **self-contained multi-voice ToneGraph
recipes** (in `recipes/`) so the build pipeline can render them directly with
`tf generate --recipe <slug>`. The matching files in `presets/` additionally
record how the same cue can be composed from existing ToneForge primitives via
`tf stack render` / `tf sequence generate`. Composites whose voices are
layered (thump + body + tail) or sequenced (fanfare) are expressed as gated
voices inside one recipe rather than as many one-note recipes, keeping the
render pipeline single-pass and deterministic.

## Determinism

ToneForge recipes are seed-deterministic: the same recipe rendered twice at the
same seed produces byte-identical WAV bytes. Every recipe here was verified
this way (SHA-256 equality across two renders) during authoring; the build
pipeline (`scripts/build-audio.sh`) re-verifies reproducibility by comparing
the recorded checksum manifest.

## Related work items

- Parent epic: Switch game audio from procedural Web Audio to ToneForge (AH-0MUTUOB7X007PR9J)
- Cue catalogue: Cue-to-recipe mapping and unused-cue audit (AH-0MUTYV7SQ005HURT)
- Build pipeline: Deterministic WAV build pipeline (AH-0MUTYV8FU007X7JD)
- Runtime playback: Rewrite effects.ts to Phaser playback (AH-0MUTYV92Y000WJ8Z)
