// The bookmark baseline must survive a reload — and when the storage loses the marker
// file, the Settings card must say so instead of going back to "not set".
//
// One Chromium profile with the extension loaded, the local WebDAV server as the storage,
// and the extension's own messages. Nothing is staged: the marker is written to the
// server by the extension and read back from it.
//
// The loss is the interesting half. A storage that answers "there is no marker" used to
// erase this device's own record of what it had set, so a reload showed "Not set" —
// the setting looked like it had never been made, with nothing in Activity to say why.
// The card now keeps the baseline and names the condition.
//
// Every string is read from the extension with chrome.i18n, because the page speaks the
// browser's own locale and this pass must not care which one that is.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebdav } from "./lib/webdav-server.mjs";
import { buildWith, launchPeer, settingsFor } from "./lib/peer.mjs";

const repo = resolve(import.meta.dirname, "../..");
const dist = join(repo, "dist");

const failures = [];
function check(name, ok, detail = "") {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

const work = await mkdtemp(join(tmpdir(), "kesonode-baseline-"));
const dav = await startWebdav();
const extDir = await buildWith(dist, join(work, "ext"), []);
const peer = await launchPeer({
  extDir,
  profileDir: join(work, "profile"),
  davOrigin: dav.origin,
  id: "5a1d59ee",
  label: "Device A",
  enabledTypes: ["bookmarks"],
  settings: settingsFor(dav.origin, "5a1d59ee", "Device A", ["bookmarks"]),
});

const MARKER = "/konode/konode_baseline.json";

/** The baseline card as the user reads it: the value line and the notes under it. */
const readCard = (page) => page.evaluate(() => {
  const label = chrome.i18n.getMessage("opt_baseline_label");
  const section = [...document.querySelectorAll(".settings-section")].find((s) =>
    (s.querySelector(".settings-card-head")?.textContent ?? "").trim().startsWith(label));
  if (!section) return null;
  const value = section.querySelector(".row-label");
  const notes = value?.parentElement
    ? [...value.parentElement.querySelectorAll(":scope > .row-desc")].map((n) => n.textContent.trim())
    : [];
  const buttons = [...section.querySelectorAll("button")].map((b) => b.textContent.trim());
  return { value: (value?.textContent ?? "").trim(), notes, buttons };
});

/** The strings this pass compares against, in whatever locale the browser is in. */
const strings = (page) => page.evaluate(() => ({
  label: chrome.i18n.getMessage("opt_baseline_label"),
  set: chrome.i18n.getMessage("opt_baseline_set"),
  none: chrome.i18n.getMessage("opt_baseline_none"),
  stale: chrome.i18n.getMessage("opt_baseline_stale"),
  mine: chrome.i18n.getMessage("opt_baseline_mine").split("$")[0].trim(),
}));

try {
  const control = await peer.context.newPage();
  await control.goto(`chrome-extension://${peer.extensionId}/popup.html`);
  const send = (type, payload) =>
    control.evaluate(
      ([t, p]) => chrome.runtime.sendMessage(p === null ? { type: t } : { type: t, payload: p }),
      [type, payload ?? null]
    );

  // A browser with something to be the baseline for.
  await peer.worker.evaluate(async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Local", url: "https://local.example/" });
  });

  const set = await send("SET_BASELINE");
  check("the baseline is set", set?.type === "BASELINE", JSON.stringify(set));
  check("the storage holds the marker", dav.files.has(MARKER), dav.names().join(", "));

  const read = await send("GET_BASELINE");
  check("the baseline reads back from the storage", read?.payload?.marker?.device_id === "5a1d59ee",
    JSON.stringify(read?.payload));
  check("a baseline the storage holds is not stale", read?.payload?.stale !== true);

  // The options page, the way the user reads it.
  const page = await peer.context.newPage();
  await page.goto(`chrome-extension://${peer.extensionId}/options.html#device`);
  await page.waitForSelector(".settings-section");
  await page.waitForTimeout(800);
  const s = await strings(page);
  const shown = await readCard(page);
  check("the card names this browser as the baseline",
    !!shown && shown.value.startsWith(s.mine), JSON.stringify(shown));
  check("the card does not say the baseline is not set",
    !!shown && !shown.value.includes(s.none), JSON.stringify(shown));

  // ─── The storage loses the marker ─────────────────────────────────────────
  dav.files.delete(MARKER);

  // A reload is the user's own test: does the setting survive it?
  await page.reload();
  await page.waitForSelector(".settings-section");
  await page.waitForTimeout(1200);
  const afterReload = await readCard(page);
  check("the baseline survives a reload the storage cannot answer",
    !!afterReload && afterReload.value.startsWith(s.mine), JSON.stringify(afterReload));
  check("the card says the storage has no marker",
    !!afterReload && afterReload.notes.some((n) => n.includes(s.stale)), JSON.stringify(afterReload));
  check("the card does not say the baseline is not set",
    !!afterReload && !afterReload.value.includes(s.none), JSON.stringify(afterReload));
  check("the card offers to set the baseline again",
    !!afterReload && afterReload.buttons.some((b) => b.includes(s.set)), JSON.stringify(afterReload?.buttons));

  const after = await send("GET_BASELINE");
  check("the answer keeps the baseline and flags it as stale",
    after?.payload?.marker?.device_id === "5a1d59ee" && after?.payload?.stale === true,
    JSON.stringify(after?.payload));

  const audit = await peer.audit();
  check("Activity says the storage lost the marker",
    audit.some((e) => String(e.detail ?? "").includes("no longer holds the bookmark baseline")),
    JSON.stringify(audit.slice(0, 3)));

  // ─── And setting it again puts it back ────────────────────────────────────
  const setButton = page.locator(".settings-section").filter({ hasText: s.label })
    .getByRole("button", { name: s.set });
  await setButton.first().click();
  await page.waitForTimeout(400);
  await setButton.last().click();
  await page.waitForTimeout(2500);
  check("setting it again writes the marker back", dav.files.has(MARKER), dav.names().join(", "));
  const again = await send("GET_BASELINE");
  check("the storage holds it again", again?.payload?.marker?.device_id === "5a1d59ee"
    && again?.payload?.stale !== true, JSON.stringify(again?.payload));
} finally {
  await peer.close();
  await dav.close();
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log("\nbaseline: all checks passed");
