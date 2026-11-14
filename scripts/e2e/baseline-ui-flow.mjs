// The user's own sequence, through the UI and nothing else:
//   Settings → Device → "Set this browser as baseline" → confirm → "Save changes" → F5.
// A report said the card comes back as "Not set" after the reload even on the fixed build.
// This pass exists to either reproduce that or prove it does not happen here, and to dump
// what the storage actually holds at each step when it does.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

const work = await mkdtemp(join(tmpdir(), "kesonode-ui-flow-"));
const dav = await startWebdav();
// E2E_EXT_ZIP=<a shipped package> runs the same pass against that release instead of the
// working tree's dist/, which is how a report of "still broken" is told apart from a build
// that simply predates the fix.
const shipped = process.env.E2E_EXT_ZIP;
const extDir = shipped
  ? (await mkdir(join(work, "ext"), { recursive: true }), execFileSync("unzip", ["-q", shipped, "-d", join(work, "ext")]), join(work, "ext"))
  : await buildWith(dist, join(work, "ext"), []);
const peer = await launchPeer({
  extDir,
  profileDir: join(work, "profile"),
  davOrigin: dav.origin,
  id: "7c2b41aa",
  label: "Device A",
  enabledTypes: ["bookmarks"],
  settings: settingsFor(dav.origin, "7c2b41aa", "Device A", ["bookmarks"]),
});

const MARKER = "/konode/konode_baseline.json";

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
  const msg = [...section.querySelectorAll(".row-desc")].map((n) => n.textContent.trim());
  return { value: (value?.textContent ?? "").trim(), notes, buttons, all: msg };
});

const strings = (page) => page.evaluate(() => ({
  label: chrome.i18n.getMessage("opt_baseline_label"),
  set: chrome.i18n.getMessage("opt_baseline_set"),
  none: chrome.i18n.getMessage("opt_baseline_none"),
  stale: chrome.i18n.getMessage("opt_baseline_stale"),
  mine: chrome.i18n.getMessage("opt_baseline_mine").split("$")[0].trim(),
  setConfirm: chrome.i18n.getMessage("opt_baseline_set_confirm"),
  savePending: chrome.i18n.getMessage("opt_baseline_save_pending"),
  save: chrome.i18n.getMessage("opt_save_changes"),
  saved: chrome.i18n.getMessage("opt_saved"),
}));

const local = () => peer.worker.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return {
    cache: all.konode_baseline_cache ?? null,
    adopted: all.konode_baseline_adopted ?? null,
    device_id: all.konode_settings?.device_id ?? null,
    first_sync_done: all.konode_first_sync?.done ?? null,
  };
});

try {
  console.log(`  build: ${shipped ?? dist}`);
  await peer.worker.evaluate(async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Local", url: "https://local.example/" });
  });

  const page = await peer.context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`  [page error] ${m.text()}`);
  });
  await page.goto(`chrome-extension://${peer.extensionId}/options.html#device`);
  await page.waitForSelector(".settings-section");
  await page.waitForTimeout(1000);
  const s = await strings(page);
  console.log("  strings:", JSON.stringify(s));

  // ─── Step 1: set the baseline through the card, exactly as the user does ──
  const section = page.locator(".settings-section").filter({ hasText: s.label }).first();
  const setButton = section.getByRole("button", { name: s.set }).first();
  await setButton.click();
  await page.waitForTimeout(400);

  if (process.env.E2E_SCENARIO === "save-without-confirm") {
    // The reported sequence taken literally: "click set, then click Save". The first click
    // only opens the confirmation, whose action carries the SAME label, and the page's
    // Save button sits right below — so a user can believe Save committed the choice.
    console.log("  confirm row:", JSON.stringify(await readCard(page)));
    await page.getByRole("button", { name: s.save }).first().click();
    await page.waitForTimeout(2000);
    const saved = await readCard(page);
    console.log("  after save :", JSON.stringify(saved));
    console.log("  marker now :", dav.files.has(MARKER));
    check("saving explains that the baseline confirmation is still open",
      !!saved && saved.all.some((n) => n.includes(s.savePending)), JSON.stringify(saved));
    await page.reload();
    await page.waitForSelector(".settings-section");
    await page.waitForTimeout(2000);
    console.log("  after reload:", JSON.stringify(await readCard(page)));
    console.log("  marker now :", dav.files.has(MARKER));
    process.exit(dav.files.has(MARKER) ? 1 : 0);
  }

  // The confirm row replaces the buttons. Its action has its own label: the two steps
  // used to read identically, which is how "click set, then click Save" ended up setting
  // nothing while looking done.
  await section.getByRole("button", { name: s.setConfirm }).last().click();
  await page.waitForTimeout(4000);
  const afterSet = await readCard(page);
  console.log("  after set  :", JSON.stringify(afterSet));
  console.log("  storage    :", JSON.stringify(await local()));
  console.log("  marker file:", dav.files.has(MARKER));
  check("the card shows this browser as the baseline after setting",
    !!afterSet && afterSet.value.startsWith(s.mine), JSON.stringify(afterSet));
  check("the storage holds the marker after setting", dav.files.has(MARKER));

  // ─── Step 2: "Save changes" on the same page ──────────────────────────────
  const save = page.getByRole("button", { name: s.save }).first();
  await save.click();
  await page.waitForTimeout(2500);
  const afterSave = await readCard(page);
  console.log("  after save :", JSON.stringify(afterSave));
  console.log("  storage    :", JSON.stringify(await local()));
  console.log("  marker file:", dav.files.has(MARKER));
  check("the card still names the baseline after saving settings",
    !!afterSave && afterSave.value.startsWith(s.mine), JSON.stringify(afterSave));
  check("the marker is still on the storage after saving settings", dav.files.has(MARKER));

  // ─── Step 3: F5 ──────────────────────────────────────────────────────────
  await page.reload();
  await page.waitForSelector(".settings-section");
  await page.waitForTimeout(2500);
  const afterReload = await readCard(page);
  console.log("  after reload:", JSON.stringify(afterReload));
  console.log("  storage     :", JSON.stringify(await local()));
  console.log("  marker file :", dav.files.has(MARKER));
  check("the baseline survives the reload", !!afterReload && afterReload.value.startsWith(s.mine),
    JSON.stringify(afterReload));
  check("the card does not fall back to 'not set'",
    !!afterReload && !afterReload.value.includes(s.none), JSON.stringify(afterReload));

  const audit = await peer.audit();
  console.log("  audit      :", JSON.stringify(audit.slice(0, 6)));
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
console.log("\nbaseline-ui-flow: all checks passed");
