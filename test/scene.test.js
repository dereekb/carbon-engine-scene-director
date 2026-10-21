import assert from "node:assert/strict";
import { test } from "node:test";

import { applySceneOperations, DEFAULT_UNIVERSE, diffScenes, normalizeScene, SceneError } from "../src/shared/scene.js";

const duel = {
  name: "duel",
  ships: [
    { id: "a", dna: "af1_t1:amarrbase:amarr", position: [ 0, 0, 0 ] },
    { id: "b", dna: "mf1_t1:minmatarbase:minmatar", position: [ 3000, 0, 0 ], rotation: [ 180, 0, 0 ], team: "blue" }
  ]
};

test("a minimal document gets defaults", () =>
{
  const { scene, warnings } = normalizeScene({ ships: [ { id: "x", dna: "af1_t1:amarrbase:amarr" } ] });
  assert.equal(scene.schema, "cjs-scene/1");
  assert.equal(scene.environment.universe, DEFAULT_UNIVERSE);
  assert.deepEqual(scene.ships[0].position, [ 0, 0, 0 ]);
  assert.deepEqual(scene.ships[0].rotation, [ 0, 0, 0 ]);
  assert.equal(scene.camera.target, null);
  assert.deepEqual(warnings, []);
});

test("every problem is reported together", () =>
{
  assert.throws(() => normalizeScene({
    schema: "other/2",
    ships: [
      { id: "a", dna: "not-dna" },
      { id: "a", dna: "af1_t1:amarrbase:amarr", position: [ 1, 2 ] }
    ],
    camera: { target: "missing", pitch: 120 }
  }), error =>
  {
    assert.ok(error instanceof SceneError);
    const text = error.problems.join("\n");
    for (const expected of [ "schema", "not hull:faction:race", "used more than once", "position", "pitch", "camera.target" ])
    {
      assert.match(text, new RegExp(expected));
    }
    return true;
  });
});

test("unknown keys warn and are dropped; reserved keys are kept with a warning", () =>
{
  const { scene, warnings } = normalizeScene({
    colour: "red",
    timeline: [ { at: 1 } ],
    ships: [ { id: "a", dna: "af1_t1:amarrbase:amarr", speed: 3, orders: [ { orbit: "b" } ] } ]
  });
  assert.equal(scene.colour, undefined);
  assert.equal(scene.ships[0].speed, undefined);
  assert.deepEqual(scene.ships[0].orders, [ { orbit: "b" } ]);
  assert.deepEqual(scene.timeline, [ { at: 1 } ]);
  assert.equal(warnings.length, 4);
});

test("operations edit a copy and validate the result", () =>
{
  const { scene } = normalizeScene(duel);
  const { scene: next } = applySceneOperations(scene, [
    { op: "update_ship", id: "a", set: { position: [ 10, 0, 0 ] } },
    { op: "add_ship", ship: { id: "c", dna: "cf1_t1:caldaribase:caldari" } },
    { op: "remove_ship", id: "b" },
    { op: "set_camera", camera: { target: "c", distance: 900 } },
    { op: "rename", name: "trio" }
  ]);
  assert.deepEqual(scene.ships.map(ship => ship.id), [ "a", "b" ], "input untouched");
  assert.deepEqual(next.ships.map(ship => ship.id), [ "a", "c" ]);
  assert.deepEqual(next.ships[0].position, [ 10, 0, 0 ]);
  assert.equal(next.camera.target, "c");
  assert.equal(next.camera.yaw, 45, "unmentioned camera fields keep their value");
  assert.equal(next.name, "trio");
});

test("removing the camera's target clears it; bad operations all report", () =>
{
  const { scene } = normalizeScene({ ...duel, camera: { target: "b" } });
  assert.equal(applySceneOperations(scene, [ { op: "remove_ship", id: "b" } ]).scene.camera.target, null);
  assert.throws(() => applySceneOperations(scene, [
    { op: "remove_ship", id: "zz" },
    { op: "update_ship", id: "a", set: { id: "q" } },
    { op: "explode" }
  ]), error => error.problems.length === 3);
});

test("the diff names exactly the work to do", () =>
{
  const { scene: before } = normalizeScene(duel);
  const { scene: after } = applySceneOperations(before, [
    { op: "update_ship", id: "a", set: { dna: "af1_t1:amarrnavy:amarr" } },
    { op: "update_ship", id: "b", set: { position: [ 1, 1, 1 ], name: "Rifter" } },
    { op: "add_ship", ship: { id: "c", dna: "cf1_t1:caldaribase:caldari" } }
  ]);
  const diff = diffScenes(before, after);
  assert.deepEqual(diff.rebuilt.map(ship => ship.id), [ "a" ]);
  assert.deepEqual(diff.moved.map(ship => ship.id), [ "b" ]);
  assert.deepEqual(diff.relabelled.map(ship => ship.id), [ "b" ]);
  assert.deepEqual(diff.added.map(ship => ship.id), [ "c" ]);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.environment, false);
  assert.deepEqual(diffScenes(null, before).added.map(ship => ship.id), [ "a", "b" ], "a first load adds everything");
});
