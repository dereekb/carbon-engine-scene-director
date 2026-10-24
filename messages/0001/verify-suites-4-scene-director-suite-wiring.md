# Verify suites 4/6 — declare verify-page as a `dbx-claude-test` suite, with a default list and an area map

> Queue item: `verify-suites-4-4-declare-verify-page-as-a-dbx-claude-test-suite` (project `carbon-engine-scene-director`)

Part 4 of 6, in **carbon-engine-scene-director**. Needs every dbx-claude part to have landed:

- part 1 `~/.claude/plans/verify-suites-1-dbx-claude-test-custom-suites.md` (suites, jobs, TAP);
- part 2 `~/.claude/plans/verify-suites-2-suite-hint-and-redirect.md` (the Bash steer);
- part 5 `~/.claude/plans/verify-suites-5-close-out-required-tests.md` (required tests, close-out gate, owed list);
- part 6 `~/.claude/plans/verify-suites-6-test-area-hint.md` (the area hint).

It also needs part 3 (`~/.claude/plans/verify-suites-3-verify-page-tap.md`) to have landed here. This item was stored
`blocked`; part 6's last step sets it to pending.

## Why

So that every session and queue pane runs verify-page through `dbx-claude-test { suite: "verify-page", testName: "…" }`: a
background job with a parsed per-check verdict and live progress. A queue item's close-out then runs the verify checks its
work needs: the project default, plus what the item prescribes or its agent adds when the area hint fires. It never runs the
full 25–40 min suite on every commit.

## Steps

1. **Preconditions.**
   - The running dbx-claude knows `tests.suites` and `tests.closeOut`: the `dbx-claude-test` input schema has `suite`, and
     `dbx-claude-queue-add` has `requiredTests`. If not, follow part 6's handoff note on rebuilding/redeploying dbx-claude, or
     stop and say so.
   - `verify-page --tap` and the area prefixes exist (part 3).
2. **Suites** (`.dbx-claude/dbx-claude.json` `tests.suites`), per part 1's config contract:
   - `verify-page`:
     - project `scene-director`, target `verify-page`, `format: "tap"`;
     - `nameFlag: "--only"`, `extraArgs: ["--tap"]`;
     - `requires: ["tools-core"]`;
     - `exclusive: true` — the ref says never alongside other test suites;
     - `estimateMs` ≈ 40 min (the full run per `sd-dev-env`; history takes over), `timeoutMs` 60 min;
     - a `description`;
     - `paths`: the page / hub / scene source roots;
     - `guard: { mode: "hint", commands: ["dist/apps/scene-director/verify-page.js"] }`.
   - `verify-page-no-eve`: the same with `extraArgs: ["--tap", "--eve-data", "off"]`, no `requires` (runs on any machine),
     and a few-minute `estimateMs`.

   Confirm `queue.gitHandoff.machines` still lists dbxpc with `tools-core`: that is where owed checks go.
3. **Default list** (`tests.closeOut.default`, part 5): a short smoke filter that every page-touching item must pass.
   - Pick it from real labels: the connect check, an SOF build, a scene edit, a reload. Target a few minutes, measured.
   - Gate it with `when.paths` on `apps/viewer/src/`, `apps/scene-director/src/lib/hub/` and `packages/scene/src/`.
   - On a machine without tools-core it lands on the owed list. Decide with the numbers whether the default should also
     include a `verify-page-no-eve` entry, so the Mac proves what it can before the item closes.
4. **Area map** (`tests.closeOut.areas`, part 6): one area per verify-page prefix from part 3.
   - Each area gets a `description` (what changing it risks), the `paths` that own it, and `add: [{ suite: "verify-page",
     testName: "<prefix>:" }]`.
   - Take `paths` from the matching `sd-*` ref's `pathContains` triggers in this same marker. Merge prefixes that always
     travel together, e.g. `export:|record:`.
5. **Validate on this machine** (any machine works for these):
   - `dbx-claude-test { suite: "verify-page-no-eve" }` passes, with the per-check counts and the suite label in the job record.
   - `dbx-claude-test { suite: "verify-page", testName: "connects" }` without tools-core is refused with the dbxpc / handoff
     steer.
   - A raw `npx nx run scene-director:verify-page -- --only "x"` Bash attempt gets the one-time hint with the translated call.
   - Editing a file in a mapped area while holding a claimed item fires the area hint.
   - A close-out of a page-touching item on a machine without tools-core closes the item and lands the smoke filter on
     `owed-tests-dbxpc`.
6. **Docs.**
   - `sd-dev-env` ref, verify-page section:
     - run through `dbx-claude-test` (`suite` + `testName` as the `--only` filter; several batches in one wait with
       `suites: [...]`; the no-EVE suite for machines without tools-core);
     - the default list, the area map, and how an item adds checks;
     - mark the dbxpc `.scratch/movie-gpu/batch.mjs` / `chain.sh` runner as superseded.
   - Do NOT edit `CLAUDE.md` (its Commands line still names `npx nx run scene-director:verify-page`). Say in the close-out that
     it needs the user's go-ahead.
   - Rewrite the raw verify-page commands in this project's PENDING queue items. At planning time those were
     `stances-and-piloting-p6-dbxpc-evidence-verify-page-real-gpu-fps` and
     `finish-fleet-personalities-s8-real-gpu-evidence-and-the-dbxpc-verify-page-run`. Either rewrite them to the
     `dbx-claude-test` form, or move their `--only` filters into `requiredTests`, whichever reads better per item.
   - Leave `handed-off` items alone; the hint translates their commands anyway.
   - Declare the ref impact.
7. **dbxpc end to end.** The tools-core suite can only be proven on dbxpc:
   - a `dbx-claude-test { suite: "verify-page", testName: "connects|SOF" }` job;
   - a loop-pane run that detaches, parks at `awaiting-tests`, and is settled back to pending with the per-check note;
   - a close-out that runs an item's required checks and closes it on pass;
   - the `owed-tests-dbxpc` item draining.

   If this pane is not on dbxpc, file that remainder with
   `dbx-claude-queue-add { followupOf: <this item>, dataLocation: "dbxpc", … }` and close this item on steps 1–6.
