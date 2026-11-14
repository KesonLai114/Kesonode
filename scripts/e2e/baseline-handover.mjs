// What happens when a SECOND browser takes the bookmark baseline away from the first.
//
// The question this pass answers: A is the baseline, then B sets itself as the baseline
// too. Does B replace A? And if it does, what do the devices hold afterwards?
//
// One WebDAV server, two Chromium profiles with the extension loaded, and the extension's
// own messages. The baseline is a single shared file, so a handover is one file being
// overwritten and every device noticing a new generation — which is exactly what has to
// be measured, because "B is the baseline now" and "A's tree was replaced" are different
// claims.
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

/** The bookmarks bar as a person would read it, sorted so an ORDER change is not a
 *  difference and a MISSING bookmark is. */
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

/** A folder on the bar with bookmarks in it. */
async function seedFolder(peer, title, entries) {
  return peer.worker.evaluate(async ([name, list]) => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    const f = await chrome.bookmarks.create({ parentId: roots[0].id, title: name });
    for (const [t, url] of list) await chrome.bookmarks.create({ parentId: f.id, title: t, url });
  }, [title, entries]);
}

/** A bookmark straight on the bar. */
async function seedBookmark(peer, title, url) {
  await peer.worker.evaluate(async ([t, u]) => {
    const roots = (await chrome.bookmarks.getTree())[0].children ?? [];
    await chrome.bookmarks.create({ parentId: roots[0].id, title: t, url: u });
  }, [title, url]);
}

/** Remove the node with this title, wherever it sits. */
async function removeByTitle(peer, title) {
  await peer.worker.evaluate(async (t) => {
    const flat = [];
    const walk = (n) => { flat.push(n); (n.children ?? []).forEach(walk); };
    (await chrome.bookmarks.getTree()).forEach(walk);
    const node = flat.find((n) => n.title === t && n.url);
    if (!node) throw new Error(`no bookmark titled ${t}`);
    await chrome.bookmarks.remove(node.id);
  }, title);
}

/** The extension's own message channel. The service worker does not hear its own
 *  sendMessage, so the message goes out of a page of the extension's origin — the popup,
 *  which is the lightest one that exists. */
const controls = new Map();
async function message(peer, type, payload = null) {
  let control = controls.get(peer.id);
  if (!control) {
    control = await peer.context.newPage();
    await control.goto(`chrome-extension://${peer.extensionId}/popup.html`);
    controls.set(peer.id, control);
  }
  return control.evaluate(
    ([t, p]) => chrome.runtime.sendMessage(p === null ? { type: t } : { type: t, payload: p }),
    [type, payload]
  );
}

/** The baseline as the extension itself reports it, on this device. */
const baselineOf = async (peer) => (await message(peer, "GET_BASELINE"))?.payload ?? null;

async function main() {
  await stat(join(dist, "manifest.json")).catch(() => {
    throw new Error("dist/ is not built — run `npm run build` first");
  });

  const work = await mkdtemp(join(tmpdir(), "konode-e2e-handover-"));
  const dav = await startWebdav();
  const peers = [];

  try {
    const open = async (label) => {
      const peer = await launchPeer({
        extDir: dist,
        profileDir: join(work, `ho-${label}`),
        davOrigin: dav.origin,
        id: `handover-${label}`,
        label,
        headless,
        settings: settingsFor(dav.origin, `handover-${label}`, label, ["bookmarks"]),
      });
      peers.push(peer);
      return peer;
    };

    const a = await open("A");
    const b = await open("B");

    await seedFolder(a, "Work", [
      ["a1", "https://a.example/1"],
      ["a2", "https://a.example/2"],
      ["a3", "https://a.example/3"],
    ]);
    await seedFolder(b, "Bown", [["b1", "https://b.example/1"]]);

    // ── 1. A takes the baseline ──────────────────────────────────────────────
    scene = "A baseline";
    console.log(`\n▸ ${scene}: A sets itself as the baseline`);
    await message(a, "SET_BASELINE");
    const aMarker = await baselineOf(a);
    check("the shared marker names A", aMarker?.marker?.device_id === "handover-A",
      show(aMarker?.marker));

    // ── 2. B follows A ───────────────────────────────────────────────────────
    scene = "B follows A";
    console.log(`\n▸ ${scene}: B syncs and takes A's tree`);
    await b.sync();
    await pause(200);
    check("B's tree is A's tree — its own bookmark is gone",
      show(await bar(b)) === show(["[Work] a1,a2,a3"]), show(await bar(b)));
    check("A still holds its own tree", show(await bar(a)) === show(["[Work] a1,a2,a3"]),
      show(await bar(a)));

    // ── 3. B changes something and takes the baseline ────────────────────────
    scene = "B takes over";
    console.log(`\n▸ ${scene}: B edits, then sets itself as the baseline`);
    await removeByTitle(b, "a2");
    await seedBookmark(b, "b2", "https://b.example/2");
    check("B's tree has moved on from A's", show(await bar(b)) === show(["[Work] a1,a3", "b2"]),
      show(await bar(b)));

    await message(b, "SET_BASELINE");
    const bMarker = await baselineOf(b);
    check("the shared marker now names B", bMarker?.marker?.device_id === "handover-B",
      show(bMarker?.marker));
    check("it is a NEW generation, not A's marker with a new name",
      bMarker?.marker?.at !== aMarker?.marker?.at, `${aMarker?.marker?.at} → ${bMarker?.marker?.at}`);
    check("A's own bookmark file was taken off the storage",
      !dav.names().some((n) => n.includes("handover-A")), dav.names().join(", "));

    // ── 4. A follows B ───────────────────────────────────────────────────────
    scene = "A follows B";
    console.log(`\n▸ ${scene}: A syncs and takes B's tree`);
    await a.sync();
    await pause(200);
    check("A's tree is B's tree — A's own bookmark is gone, B's is here",
      show(await bar(a)) === show(["[Work] a1,a3", "b2"]), show(await bar(a)));
    check("B is untouched by its own publish", show(await bar(b)) === show(["[Work] a1,a3", "b2"]),
      show(await bar(b)));

    const aAfter = await baselineOf(a);
    check("A's card points at B now", aAfter?.marker?.device_id === "handover-B", show(aAfter?.marker));
    check("and A does not call it stale — the storage holds it",
      aAfter?.stale !== true, show(aAfter));

    const aligned = (await a.audit()).filter((e) => e.action === "Baseline").map((e) => e.detail ?? "");
    check("A's Activity says it aligned with B",
      aligned.some((d) => d.includes("Aligned this browser's bookmarks with B")), show(aligned));
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
  console.log("every check passed — the second browser to take the baseline replaces the");
  console.log("first, and the first browser's tree is replaced by the new baseline's.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
