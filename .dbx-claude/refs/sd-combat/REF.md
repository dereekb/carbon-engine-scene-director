# Combat: locks, turret hits, damage, kills, explosions

> Fetch before touching `packages/scene/src/lib/combat/`, anything that locks, rolls a shot, applies damage or kills a
> ship, the document's `combat`, or the `engage` / `cease_fire` tools. Turrets, targets and the shot hook this builds
> on: `sd-weapons`; dogma, activation (`ModuleCycle`) and the page's damage model: `sd-fittings`; the parks:
> `sd-destiny`.

**Status (2026-10-23)**: the combat-rules plan
(`~/.claude/plans/combat-rules-locks-turret-hits-through-getaccuracy-damage-into-the-fit-s-damage.md`) lands in three
slices. **K1 is in**: the runtime-free rules in `packages/scene` (below), the document's `combat` and `set_combat`, and
`ship_stats`' turret numbers. **K2** (next) runs them in the page: `ShipLocks`, the lock gate on turrets, `CombatRules`
rolling each shot through Destiny's `GetAccuracy`, damage into `DamageModel`, passive shield recharge, `engage` /
`cease_fire`, get_state's locks and combat reports, deaths as `flag`. **K3**: deaths that explode (the client's
explosion) and leave both parks, the live fleet view, the real-GPU fight. Until K2 the page does not read `combat` and
every shot still draws as a hit.

## Files (K1)

| File | Holds |
|---|---|
| `combat/accuracy.ts` | `turretHitChance` (Destiny's guards), `NO_FALLOFF_METRES` (1), `rollShot`, `HIT_RESULTS` / `hitResultOf`, `ShotResult`, `WRECKING_ROLL` (0.01), `WRECKING_QUALITY` (3), `QUALITY_OFFSET` (0.49), `vortonApplication` |
| `combat/damage.ts` | `DamageVector`, `NO_DAMAGE`, `shotDamage`, `damageTotal`, `applyLayeredDamage` (pure), `passiveRecharge` (the closed form) |
| `combat/locks.ts` | `lockTime`, `LOCK_TIME_CONSTANT` (40000), `pilotLockLimit`, `shipLockLimit`, the two Target Management skills |
| `combat/random.ts` | `combatRoll(seed, key)`, `combatHash` (cyrb53), `combatPick`, `combatShuffle`, `CombatRollKey` |
| `combat/weapon-numbers.ts` | `TurretCombatNumbers`, `turretCombatNumbersOf(ship, bundle, key)`, `ShipWeapons`, `shipWeaponsOf`, `TURRET_COMBAT_ATTRIBUTES`, `NO_CHARGE_DAMAGE_NOTE` |
| `combat/explosions.ts` | `SHIP_EXPLOSIONS`, `SHIP_EXPLOSION_TIMINGS` (captured), `explosionDurationBound`, `shipExplosionOf`, `MAX_LOCAL_BLASTS` (8), `EXPLOSION_REFERENCE_RADII` |
| `combat/document.ts` | `SceneCombat`, `COMBAT_DEATH_MODES`, `DEFAULT_COMBAT_SEED` (1), `DEFAULT_COMBAT_DEATH` (`explode`), `normalizeSceneCombat`, `sceneCombatOf`, `COMBAT_OPERATIONS` / `applyCombatOperation` (`set_combat`) |
| `combat/commands.ts` | `normalizeEngageCommand` (`{ selection, target, modules = ["turret"] }`, a celestial refused), `normalizeCeaseFireCommand` (`{ selection, unlock }`) |
| `combat/kill.ts` | `ShotOutcome`, `ShipKill`, `ShipKillReport`: the plain data the page will report and the timeline, time control and automatic camera read |
| `hub/ship-stats-tool.ts` | turret rows' `damage` / `volley` / `dps` / `tracking` / `signatureResolution` / `explosion` / `spool`, and `weapons` on the stats |

## EVE's rules (checked 2026-10-23)

Sources: EVE's developer docs "useful formulae", EVE University "Lock time", "Turret mechanics", "Missile mechanics",
the Entropic Disintegrator and Vorton Projector pages; Destiny's `GetAccuracy`
(`../carbonenginejs/server/destiny/CjsBallparkController.js`).

### Locks

- **Lock time** = `40000 / (scanResolution(mm) × asinh(signatureRadius(m))²)` s: the shooter's live scan resolution
  (564, Signature Analysis V) and the target's live signature (552 with an MWD's bloom, painters). Max skills: Rifter →
  Punisher 2.617 s, Punisher → Rifter 2.770, Ferox → Rifter 9.09, Megathron → Rifter 14.30, Rifter → Megathron 1.10.
- **Range**: `maxTargetRange` (76, Long Range Targeting V), surface to surface: Rifter 28,125 m, Punisher 31,250,
  Ferox 93,750, Megathron 108,750.
- **Count**: `min(maxLockedTargets (192), the pilot's 2 + Target Management + Advanced Target Management levels)`: 12
  for the max-skills pilot; Rifter 4, Ferox 8, Megathron 7.
- Entering warp breaks every lock both ways.

### Hit chance and the damage roll

- Chance = `0.5 ^ ((ω × sigRes / (tracking × S))² + (max(0, d − optimal) / falloff)²)`: ω the angular velocity
  (transversal ÷ centre distance, rad/s), sigRes the turret's `optimalSigRadius` (620: 40,000 on every turret), S the
  target's signature, d the surface distance. Destiny's `GetAccuracy(src, dst, optimal, falloff, tracking, signature,
  optimalSigRadius)` computes exactly this from `mNewPos` / `mNewVel` (numeric arguments return `[accuracy,
  surfaceDistance, angularVelocity]`), and answers 0 for falloff 0, tracking 0, signature 0, optimal < 0, or the same
  ball. The page (K2) uses it on the master park; `turretHitChance` is the spec'd twin.
- Worked (Rifter's 200mm AutoCannon II: tracking 393.75, optimal 750, falloff 9,675, on a Punisher, sig 37): 0.875 at
  rest 5 km off; 0.0625 at optimal + 2 × falloff; 1 within optimal at rest; ≈ 0.48 orbiting at ~1 km at 400 m/s.
- **The roll**: one uniform r in [0, 1) per shot; a hit when r < chance; r < 0.01 wrecks at 3 × base; otherwise quality
  r + 0.49 (0.50 to 1.49). Tiers (the client's combat log): grazes 0.5–0.625, glances off –0.75, hits –1.0, penetrates
  –1.25, smashes –1.49, wrecks 3.0. `ShotResult` adds `misses` and `overkill` (the target was already dead).
- **Entropic disintegrators** (`targetDisintegratorAttack`, no falloff attribute on the effect): no falloff, so Destiny
  gets `NO_FALLOFF_METRES` (attribute 158's 1 m default; never 0) and their chance is ~0 past optimal (their reach).
  They spool by `damageMultiplierBonusPerCycle` (2733: 0.07) per consecutive cycle, up to `damageMultiplierBonusMax`
  (2734: 2.125); the spool resets on a stop or a new target.
- **Vorton projectors** (`ChainLightning`: no tracking, no falloff) apply like missiles: base × `min(1, S / E, (S / E ×
  Ve / Vt) ^ drf)`, E `aoeCloudSize` (654), Ve `aoeVelocity` (653), drf 1353, Vt the target's speed; no roll, no
  wrecking, reach = optimal. Arcs: the existing L2 follow-up.

### Damage per shot

- Per type (EM 114, thermal 118, kinetic 117, explosive 116 on the charge): `damageMultiplier (64, the module,
  evaluated) × the charge's damage × quality × (1 + spool)`. No charge, no damage (`NO_CHARGE_DAMAGE_NOTE`); default
  fits always load one, and a fit's empty guns take one from cargo (`loadCargoCharges`, the hub's `ship_stats` too).
- `turretCombatNumbersOf` reads the module's default effect's attribute ids (duration, range, `falloffAttributeID`,
  `trackingSpeedAttributeID`), never attribute 158 blindly. Kind: `vorton` when the effect has no tracking attribute
  and the module carries 654; `disintegrator` when the module carries 2733; else `tracking`.
- Fixture check (`weapon-numbers.spec.ts`, max skills, `dogma-3632936.json`):

  | Default fit | Per gun per shot | Cycle | Paper DPS | Tracking | Optimal + falloff | Sig | Scan res | HP (sh / ar / st) |
  |---|---|---|---|---|---|---|---|---|
  | Rifter, 3 × 200mm AutoCannon II, EMP S | 65.75 (EM 49.31, kin 5.48, exp 10.96) | 1.6875 s | 116.9 | 393.75 | 750 + 9,675 | 35 | 825 | 562.5 / 562.5 / 437.5 |
  | Punisher, 4 × Small Focused Pulse Laser II, Multifrequency S | 68.31 | 2.52 s | 108.4 | 307.81 | 3,938 + 3,125 | 37 | 800 | 437.5 / 625 / 562.5 |
  | Ferox, 6 × 250mm Railgun II, Antimatter Charge M | 197.81 | 4.194 s | 283.0 | 7.38 | 30,375 + 16,875 | 325 | 243.75 | 6,562.5 / 4,375 / 5,000 |
  | Megathron, 7 × Neutron Blaster Cannon II, Antimatter Charge L | 334.72 | 4.2525 s | 551.0 | 8.93 | 4,500 + 12,500 | 380 | 155 | 8,662.5 / 8,937.5 / 10,312.5 |
  | Vedmak, 1 × Heavy Entropic Disintegrator II, Baryon Exotic Plasma M | 588.23 (spool 0) | 3.96 s | 148.5 | 52.5 | 32,897 + none | 110 | 375 | 1,000 / 4,125 / 2,500 |
  | Stormbringer, 1 × Medium Vorton Projector II, ElectroPunch Ultra M | 1,481.95 | 8.1 s | 183.0 | none | 33,000 + none (explosion 107.25 m, 118.1 m/s, drf 0.5) | 130 | 341.25 | 5,000 / 750 / 1,500 |

### Applying damage and passive shield recharge

- **Layers** (`applyLayeredDamage`, pure): shield, then armor, then structure. A layer takes `Σ raw_t × resonance_t`;
  when that exceeds its HP it absorbs the share `hp / effective` of the raw damage and goes to 0, and the rest of the
  raw damage (`× (1 − share)`) moves to the next layer at its resonances. Structure at 0 is death.
- **Shields recharge** on the capacitor's curve, `dS/dt = 10 × Smax / τ × (√s − s)` (τ `shieldRechargeRate`, 479; peak
  at 25 %, 2.5 × Smax / τ): `passiveRecharge` is the closed form `(1 + (√s₀ − 1) e^(−5t/τ))²` (a Rifter's τ 468.75 s:
  3 HP/s at its peak). Armor and structure do not regenerate. The viewer's `CapacitorFractionAfter` is the same formula;
  K2 makes it call `passiveRecharge` so there is one.

## The keyed RNG and determinism

- `combatRoll(seed, { ship, module, activation, cycle, target })` = cyrb53 of `` `${seed}|${ship}|${module}|${activation}|${cycle}|${target}` ``
  over 2⁵³. `activation` counts the module's activations since the load (a second engagement does not replay the
  first's rolls), `cycle` the cycle within it.
- **Keyed, not a stream**: module events reach the page in `ShipModules` map order, which depends on when each ship's
  fit resolved; a keyed roll is the same whatever the order and however many unrelated ships exist. The time-control
  entry snapshots only the seed.
- The page (K2) applies a boundary's shots sorted by (`at`, ship id, module key), so which shot kills is deterministic;
  shield recharge runs once per boundary before the shots.
- Explosion variants and local-blast subsets are keyed `(seed, "explosion|<ship>")` (`combatPick`, `combatShuffle`).
- `random.spec.ts`: same key same roll, every field changes it, 100,000 keys mean 0.5 ± 0.005 and deciles 10 % ± 0.5 %.

## The document's `combat`

`{ "seed"?: <integer 0 … 2³² − 1>, "death"?: "explode" | "flag" }`, top level, omitted when empty; defaults seed 1,
death `explode` (`sceneCombatOf`). Unknown keys warn and are dropped; `null` is absent. `{ op: "set_combat", seed?,
death? }` merges, `null` resets a field. `diffScenes` flags `combat`. **Kills are live state** like HP, locks and
targets: the document stays the setup, `load_scene` / `open_scene` revive everyone, `remove_ship` keeps an aftermath.

## The client's death explosion (`shipExplosionOf`)

Files `res:/fisfx/explosion/ecx_*.black` (68 under the folder in the 3632936 res index, captured in
`explosions.spec.ts`): an `EveEffectRoot2` whose effect child is an `EveChildExplosion` (local blast variants, a
shared part, a `globalExplosion` container, timing values). The client picks one through its explosion buckets
(`explosionBucketID`), which the public SDE drops (follow-up); the table instead:

| Hull | File (`ecx_<name>.black`) |
|---|---|
| titan (group 30) | `titan_<amarr / caldari / gallente / minmatar / angel>_explosive_01a` by DNA race, else `generic_explosive_long_01a` |
| Triglavian (raceID 135 or DNA race) | `triglavian_explosive_tgdn01_t1` for dreadnoughts (group 485), else `triglavian_explosive_01a` |
| jove / drifter DNA race | `drifter_cruiser_explosive_01a` for M, else `drifter_explosive_01a` |
| sleeper DNA race | `sleeper_explosive_01a` |
| S (rigSize 1) | `generic_explosive_short_01a`, `_01b` |
| M (2) | `generic_explosive_01a`, `_01b`, `_01c` |
| L, XL (3, 4) | `generic_explosive_long_01a`, `_01b`, `_01c` |

- Size from the hull's rigSize (1547), else the SOF class's, else S; the variant `combatPick(seed, "explosion|<ship>")`.
- **`lingerSeconds`** (how long the ball stays, K3) = ceil of the duration bound with `MAX_LOCAL_BLASTS` blasts, from
  the runtime's `CalculateExplosionTimes`: `max(localDelay + localDuration + S, globalDelay + S + globalDuration)`,
  `S = interval × (1 − factor^N) / (1 − factor)` (`triFloatRandom01` ≤ 1): short 01a 16 s, generic 01a 21, long 01a
  52, titan amarr 44. The timing values are captured in `SHIP_EXPLOSION_TIMINGS` (tools-core `?format=json`, build
  3632936). The Triglavian dreadnought file has the older single `localExplosion` / `globalExplosions` members: K3
  checks the runtime plays it.
- **`referenceRadius`** (the hull radius the authored size suits; the page scales by `max(1, radius / reference)`):
  S 40 m, M 150, L 450, XL 1,500 per file to start; K3's GPU check tunes and pins them.

## Tools

- **`ship_stats`** (K1): turret rows in `fit.modules` carry `damage` (per shot by type, before quality), `volley`,
  `dps`, `tracking`, `signatureResolution`, and `explosion` / `spool`; `stats`, `withPropMod` and `withActive.stats`
  carry `weapons: { turrets, volley, dps, damage }` (DPS by type; a siege module in `active` raises it). Spec:
  `ship-stats-tool.spec.ts` (a default-fit Rifter text gives the table's numbers; a TFI's empty guns load Barrage L).
- **`patch_scene`**: `set_combat`.
- `engage` / `cease_fire` and get_state's locks, combat and kills land with K2 (`commands.ts` already validates them).

## Test data

The dogma fixture (`sd-fittings`) carries every default weapon and charge. Explosion timing: `curl
"http://127.0.0.1:5510/eve/3632936/res/fisfx/explosion/ecx_<name>.black?format=json"`, the `EveChildExplosion`'s
scalar members; the folder list from the res index (`resfileindex`). Re-capture both when CCP ships new explosions.
