# Run sheet: fleet personalities S8 and the dbxpc checks

Temporary handoff branch `handoff/fleet-personalities-s8`, cut 2026-10-23 on the Mac from develop `a42c51e`. It
carries only this folder: `RUN.md` (what to do on dbxpc) and `plan.md` (a copy of the fleet personalities plan, S1-S8,
from the Mac's `~/.claude/plans/i-want-to-be-reactive-twilight.md`). **Do the work on develop. Never merge this
branch.**

Why: the last steps need tools-core, the SDE and a real-GPU Windows Chrome, which only dbxpc has. The Mac's queue item
(`finish-fleet-personalities-s8-real-gpu-evidence-and-the-dbxpc-verify-page-run`) is pinned to dbxpc so the Mac loop
leaves it alone; dbxpc doesn't see that queue, so this sheet stands in for it.

## Start

```sh
git fetch origin
git switch handoff/fleet-personalities-s8
cp -r .dbx-claude/handoff/fleet-personalities-s8 /tmp/fleet-personalities-s8
git switch develop && git pull --ff-only   # must contain c154540 (S7) and a42c51e
```

Read `/tmp/fleet-personalities-s8/plan.md` (Design, Surface, S7, S8, Verification), then fetch the refs (they ship
in the repo: `dbx-claude-ref <name>`, or read `.dbx-claude/refs/<name>/REF.md`):

- `sd-personalities`: Status, and "The brain on the page (S7, `fleet-commanders.ts`)"
- `sd-combat`: "Verify-page (K2)", "Verify-page (K3)", "Real-GPU evidence (K3)" (the dbxpc setup the logi and combat
  runs used: a private hub on 5521, drivers in `.scratch/combat-gpu/`)
- `sd-fleets`: doc `targets` (live calls, free fire)
- `sd-dev-env`: tools-core, the SDE, the hub, verify-page, real-GPU checks

Build with `dbx-claude-build` `project: scene-director`, and bring tools-core up per `sd-dev-env`.

## Where develop stands

S1-S7 are done and committed: S1 `fb0f033` live calls, S2 `8e948ed` the fleet flies on, S3 `fa64ab7` the document,
S4 `c560d8b` the hub library, S5 `74d0ea4` the pure policy, S6 `3f375c2` reactions and free fire, S7 `c154540` the FC
brain on the page. Node tests were green at S7 (scene 840, viewer 482, scene-director 173).

Since then, `a42c51e` (fix(viewer): timeline replays keyed on scene ticks) keys pilot delays, called targets, free fire
and prop-mod hashes on `Director.SeedTick` (ticks since the last load), not the world's absolute tick. That bears on
step 2's "same seed twice" check: compare decision ticks relative to the load.

Done on the Mac, don't repeat: the plan's seven Follow-ups are filed (fleet_picture tool, manual handover lever,
advisor mode, tackle / ewar by role, disengage / warp-out, per-squad split calls, designated backup lists). Logi
auto-repair is skipped (it shipped in `4488cc2`).

## 1. verify-page on dbxpc

```sh
npx nx run scene-director:verify-page -- --only "personality|called|FC|free fire"
```

None of these has run on tools-core yet. In `apps/scene-director/src/verify-page.ts` (line numbers at `a42c51e`):

- ~2238 S7 `personality: the FC brain calls the nearest hostile as its FC; a model call takes the lever, a dead FC
  hands over, set_fleet_personality hands it back`: blue Punishers bfc / p1 / p2 on a custom `verify` personality
  (ability 1, 4 s handover, hold stance) vs red Punishers k1 / k2 at 2.5 km; death explode; the reds engage bfc after
  a cease_fire on b.
- ~2194 S6 `free fire: members with no call pick the nearest hostile in reach ...`: its Punishers need r1 inside
  optimal + falloff at ~3 km. If the default guns reach less, move the ships closer.
- ~1973 S2 `a moving FC dies and its fleet flies on: the heir inherits its order`.
- ~2025-2191 the `called` checks, changed by S1 to read get_state's live `targets` (the document keeps none).

Fix what fails, in the page code or in the check. Then re-run the plan's wider set unchanged as a regression pass:
`--only "personality|called|fleet|FC"`, plus the combat and warp-in checks.

Record dated evidence (date, SDE build, headless) in the style of `sd-combat`'s existing sections:

- `sd-combat` Verify-page (K3): replace "(added 2026-10-23, not yet run on tools-core)" on the moving-FC check with
  its result; the `called` checks' results too
- `sd-fleets` doc `targets`: the free-fire check
- `sd-personalities`: the personality check (drop "not yet run on tools-core" from Status)

## 2. End to end over MCP

Use the hub's tools from a Claude Code session on dbxpc (`.mcp.json` points at the built CLI):

1. `stage_engagement { sides: [{ composition: "tfis", personality: "brawler" }, { ships: [{ hull: "Ferox", count:
   10 }], personality: "sniper" }] }` at about 20 km.
2. `get_state`: `fleets[].fc.decisions` shows `order_fleet` calls with `by` = the FC; members are on the calls; kills
   advance.
3. Kill an FC: its fleet keeps moving; `fc.state` is `handover` with `takesOverIn` scaled by the successor's ability;
   then calls resume.
4. A model's `order_fleet` targets makes `fc.manual` `["call", "free-fire"]`; `set_fleet_personality` hands it back.
5. Same seed twice: identical decision ticks (relative to the load, see `a42c51e` above).

## 3. S8 real GPU

Use the windows-chrome skill to drive a real Chrome tab: the same brawler TFIs vs sniper Ferox fight, drawn. Capture
focus fire, an FC kill and the handover, and fps, with screenshots. Keep the drivers and artifacts in
`.scratch/personalities-gpu/` (gitignored). Then, in `sd-personalities`:

- add a `## Real-GPU evidence` section (dated, machine, GPU, resolution, SDE build, the screenshot file names and what
  each shows, fps, `gpuErrors`, `page_log`), like `sd-combat`'s Real-GPU evidence (K3);
- Status: S8 in, the plan delivered.

## While you're there: known S7 limits

Look at each one. Fix it if it's a real defect, otherwise write it down in `sd-personalities`.

- **Leaderless is sticky**: it holds until a load or a commander edit, even when a capable ship joins later.
- **The gate gives up after 20 ticks**, even on a long warp-in: unsettled ships then count, and the brain idles while
  the FC is still away.
- **`fc.ship` during an explode handover** already shows the designate, before it takes command.

## Landing

- Commit on develop through `dbx-claude-commit`. Evidence only: `docs(viewer): fleet personalities real-GPU evidence`
  (like `1396e8b`). A page or check fix: `fix(viewer): ...`, with the refs it changes in the same commit. `feat` and
  `fix` commits need the ref impact declared first (`dbx-claude-log` `refImpact`).
- Push develop to origin.
- Delete this branch: `git push origin --delete handoff/fleet-personalities-s8 && git branch -D
  handoff/fleet-personalities-s8`.
- Tell the user it landed, so they can close the Mac queue item.
