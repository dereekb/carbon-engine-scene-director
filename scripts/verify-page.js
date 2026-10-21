/**
 * Drives the real page in headless Chromium through the hub's tools, against
 * a running tools-core. Headless Chromium here usually has no WebGPU adapter,
 * so this checks everything except drawing: boot, the hub link, SOF builds
 * from real EVE data, scene edits, and IndexedDB storage. With a GPU it also
 * saves a screenshot to .scratch/verify.png.
 *
 *   node scripts/verify-page.js [--tools-core http://127.0.0.1:5510] [--headed]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { Hub } from "../src/hub/hub.js";
import { DEFAULT_TOOLS_CORE, ToolsCore } from "../src/hub/toolsCore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };

const toolsCore = new ToolsCore({ url: option("--tools-core", DEFAULT_TOOLS_CORE) });
const status = await toolsCore.Status();
if (!status.reachable)
{
  console.error(status.error);
  process.exit(1);
}

const hub = await new Hub({ port: 0, toolsCore, log: () => {} }).Start();
const browser = await chromium.launch({ headless: !process.argv.includes("--headed"), args: [ "--enable-unsafe-webgpu", "--enable-features=Vulkan" ] });
const results = [];
let failed = 0;

async function Check(label, action)
{
  try
  {
    const detail = await action();
    results.push(`ok    ${label}${detail ? ` - ${detail}` : ""}`);
  }
  catch (error)
  {
    failed += 1;
    results.push(`FAIL  ${label} - ${error.message}`);
  }
}

function Expect(condition, message)
{
  if (!condition) throw new Error(message);
}

try
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(hub.url);
  await Check("the tab connects to the hub", async () =>
  {
    for (let attempt = 0; attempt < 100 && (await hub.Call("viewer_status")).connectedTabs === 0; attempt++) await new Promise(done => setTimeout(done, 200));
    Expect((await hub.Call("viewer_status")).connectedTabs === 1, "no tab after 20 s");
  });

  const state = await hub.Call("get_state");
  const rendering = state.renderer.available;
  results.push(`info  renderer: ${rendering ? state.renderer.adapter : `unavailable (${state.renderer.reason})`}; EVE build ${status.build}`);

  await Check("search_hulls finds frigates", async () =>
  {
    const found = await hub.Call("search_hulls", { query: "f1_t1", limit: 5 });
    Expect(found.names.includes("af1_t1"), `got ${found.names}`);
    return `${found.total} matches`;
  });

  await Check("load_scene builds valid ships and reports the bad one", async () =>
  {
    const result = await hub.Call("load_scene", { scene: {
      name: "verify",
      ships: [
        { id: "punisher", dna: "af1_t1:amarrbase:amarr", position: [ 0, 0, 0 ] },
        { id: "rifter", dna: "mf1_t1:minmatarbase:minmatar", position: [ 2500, 0, 0 ], rotation: [ 180, 0, 0 ] },
        { id: "bogus", dna: "nosuchhull:amarrbase:amarr", position: [ 0, 2000, 0 ] }
      ]
    } });
    const byId = Object.fromEntries(result.ships.map(ship => [ ship.id, ship ]));
    const good = rendering ? "ready" : "validated";
    Expect(byId.punisher.status === good && byId.rifter.status === good, JSON.stringify(result.ships));
    Expect(byId.bogus.status === "failed" && /hull/iu.test(byId.bogus.error), `bogus: ${JSON.stringify(byId.bogus)}`);
    return `punisher ${byId.punisher.status}, rifter ${byId.rifter.status}, bogus failed: ${byId.bogus.error}`;
  });

  await Check("patch_scene moves, removes and renames without rebuilding", async () =>
  {
    const result = await hub.Call("patch_scene", { operations: [
      { op: "update_ship", id: "rifter", set: { position: [ 4000, 0, 0 ] } },
      { op: "remove_ship", id: "bogus" },
      { op: "rename", name: "verify-2" }
    ] });
    Expect(result.changes.moved === 1 && result.changes.removed === 1 && result.changes.added === 0 && result.changes.rebuilt === 0, JSON.stringify(result.changes));
    const distance = (await hub.Call("get_state")).distances[0];
    Expect(Math.abs(distance.centreToCentre - 4000) < 300, JSON.stringify(distance));
    return `centre-to-centre ${distance.centreToCentre} m`;
  });

  await Check("an invalid patch is refused with its problems", async () =>
  {
    try
    {
      await hub.Call("patch_scene", { operations: [ { op: "update_ship", id: "nobody", set: {} } ] });
    }
    catch (error)
    {
      Expect(/no ship "nobody"/u.test(`${error.message} ${(error.details?.problems ?? []).join(" ")}`), error.message);
      return "refused";
    }
    throw new Error("the patch was accepted");
  });

  await Check("save, list, open and delete round-trip through IndexedDB", async () =>
  {
    await hub.Call("save_scene", { name: "verify-saved" });
    Expect((await hub.Call("list_scenes")).some(entry => entry.name === "verify-saved"), "not listed");
    await hub.Call("load_scene", { scene: { name: "empty", ships: [] } });
    const opened = await hub.Call("open_scene", { name: "verify-saved" });
    Expect(opened.scene.ships.length === 2, `opened ${opened.scene.ships.length} ships`);
    Expect((await hub.Call("delete_scene", { name: "verify-saved" })).deleted === true, "not deleted");
  });

  await Check("the working scene survives a reload", async () =>
  {
    await page.reload();
    for (let attempt = 0; attempt < 100; attempt++)
    {
      const tabs = (await hub.Call("viewer_status")).connectedTabs;
      const scene = tabs ? await hub.Call("get_scene").catch(() => null) : null;
      if (scene?.name === "verify-saved") return "restored";
      await new Promise(done => setTimeout(done, 200));
    }
    throw new Error("the reloaded tab did not restore verify-saved");
  });

  if (rendering)
  {
    await Check("screenshot returns a PNG", async () =>
    {
      const shot = await hub.Call("screenshot", { maxWidth: 960 });
      await mkdir(path.join(root, ".scratch"), { recursive: true });
      await writeFile(path.join(root, ".scratch/verify.png"), Buffer.from(shot.image.data, "base64"));
      return `${shot.width}x${shot.height} -> .scratch/verify.png`;
    });
  }

  const errors = await hub.Call("page_log", { level: "error", limit: 20 });
  const unexpected = errors.filter(entry => !/bogus|nosuchhull|renderer unavailable/u.test(entry.message));
  results.push(`info  page errors: ${errors.length} (${unexpected.length} unexpected)`);
  for (const entry of unexpected.slice(0, 8)) results.push(`        ${entry.message.split("\n")[0].slice(0, 200)}`);
}
finally
{
  await browser.close();
  await hub.Stop();
}

console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
