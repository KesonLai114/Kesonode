// A baseline device keeps working. The bookmark baseline must still reach the devices
// that sync later.
//
// The marker names the exact copy to adopt by checksum. The baseline device publishes
// its bookmarks under its own file name, so every later edit REPLACES that file — and
// the marker, written once, still names the copy that was there when the baseline was
// set. A device that syncs after that edit looks for a file that no longer exists, so
// it waits. And it waits forever: the marker is only written when the baseline is
// DESIGNATED, so nothing ever updates the copy it names.
//
// This pass is about that: A takes the baseline, A edits, and B — which has never
// synced — must still end up holding A's bookmarks.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebdav } from "./lib/webdav-server.mjs";
import { launchPeer, settingsFor } from "./lib/peer.mjs";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "dist");
const headless = !process.env.E2E_HEADFUL;

const failures = [];
let scene = "";
function check(name, ok, detail = "") {
  if (!ok) failures.push(`${scene} → ${name}${detail ? `: ${detail}` : ""}`);
  console.log(`   ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}
const show = (xs) => JSON.stringify(xs);
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function bar(peer) {
  return peer.worker.evaluate(async () => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    const barId = roots[0]?.id;
    const out = [];
    for (const k of await chrome.bookmarks.getChildren(barId)) {
      if (k.url) { out.push(k.title); continue; }
      const inner = await chrome.bookmarks.getChildren(k.id);
      out.push(`[${k.title}] ${inner.map((c) => c.title).sort().join(",")}`);
    }
    return out.sort();
  });
}

async function seedFolder(peer, title, entries) {
  await peer.worker.evaluate(async ([name, list]) => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    const f = await chrome.bookmarks.create({ parentId: roots[0].id, title: name });
    for (const [t, url] of list) await chrome.bookmarks.create({ parentId: f.id, title: t, url });
  }, [title, entries]);
}

async function seedBookmark(peer, title, url) {
  await peer.worker.evaluate(async ([t, u]) => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    await chrome.bookmarks.create({ parentId: roots[0].id, title: t, url: u });
  }, [title, url]);
}

async function main() {
  await stat(join(dist, "manifest.json")).catch(() => {
    throw new Error("dist/ is not built — run `npm run build` first");
  });

  const work = await mkdtemp(join(tmpdir(), "konode-e2e-moving-"));
  const dav = await startWebdav();
  const peers = [];

  try {
    const open = async (label) => {
      const peer = await launchPeer({
        extDir: dist,
        profileDir: join(work, `mv-${label}`),
        davOrigin: dav.origin,
        id: `moving-${label}`,
        label,
        headless,
        settings: settingsFor(dav.origin, `moving-${label}`, label, ["bookmarks"]),
      });
      peers.push(peer);
      const page = await peer.context.newPage();
      await page.goto(`chrome-extension://${peer.extensionId}/popup.html`);
      peer.send = (type) => page.evaluate((t) => chrome.runtime.sendMessage({ type: t }), type);
      return peer;
    };

    const a = await open("A");
    const b = await open("B");

    scene = "A is the baseline";
    console.log(`\n▸ ${scene}: A takes the baseline`);
    await seedFolder(a, "Work", [
      ["a1", "https://a.example/1"],
      ["a2", "https://a.example/2"],
    ]);
    await a.send("SET_BASELINE");
    check("the marker names A", dav.files.has("/konode/konode_baseline.json"), dav.names().join(", "));

    scene = "A keeps working";
    console.log(`\n▸ ${scene}: A edits and publishes again`);
    await seedBookmark(a, "a3", "https://a.example/3");
    await a.sync();
    await pause(200);
    check("A holds three bookmarks", show(await bar(a)) === show(["[Work] a1,a2", "a3"]),
      show(await bar(a)));
    const marker = JSON.parse(dav.files.get("/konode/konode_baseline.json").toString());
    const pinned = JSON.parse(marker.payload).checksum;
    const packet = JSON.parse(dav.files.get("/konode/konode_bookmarks_moving-A.json").toString());
    check("the copy the marker names is the copy on the storage",
      pinned === packet.checksum, `${pinned} vs ${packet.checksum}`);

    scene = "B syncs later";
    console.log(`\n▸ ${scene}: B, holding a bookmark of its own, syncs for the first time`);
    await seedBookmark(b, "b1", "https://b.example/1");
    await b.sync();
    await pause(200);
    // The baseline REPLACES this device's tree once. A plain merge would keep b1 and
    // add A's bookmarks beside it, which is not what the baseline means.
    check("B's tree is replaced by A's tree — its own bookmark is gone",
      show(await bar(b)) === show(["[Work] a1,a2", "a3"]), show(await bar(b)));

    const baseline = await b.send("GET_BASELINE");
    check("B is recorded as aligned with the baseline",
      baseline?.payload?.adopted_at === JSON.parse(marker.payload).at,
      show(baseline?.payload));

    // And it is not a question of waiting: a second cycle must not be what fixes it.
    await b.sync();
    await pause(200);
    check("B still holds A's bookmarks after a second cycle",
      show(await bar(b)) === show(["[Work] a1,a2", "a3"]), show(await bar(b)));

    const waiting = (await b.audit()).filter((e) => e.action === "Baseline").map((e) => e.detail ?? "");
    check("B's log says it is still waiting for the baseline",
      waiting.length === 0 || !waiting.some((d) => /not published the designated/.test(d)),
      show(waiting));
  } finally {
    await Promise.all(peers.map((p) => p.close()));
    await dav.close();
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  console.log("");
  if (failures.length) {
    console.log(`${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("every check passed — a baseline device that keeps working still reaches");
  console.log("the devices that sync after it.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
