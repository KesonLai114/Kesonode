import { afterEach, describe, it, expect, vi } from "vitest";
import { createSnapshot, listSnapshots, restoreSnapshot, pruneSnapshots, deleteSnapshot, renameSnapshot, setSnapshotPinned, flushPendingPins, snapshotDisplayName, snapshotIsUnnamed } from "@/lib/sync/snapshots";
import { HttpError } from "@/lib/utils/retry";
import { DEFAULT_SETTINGS, KEYS, shortDeviceId } from "@/lib/utils/storage";
import { t } from "@/lib/utils/i18n";
import type { IBackend, SnapshotMeta, SyncSettings } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

afterEach(() => vi.restoreAllMocks());

// A minimal in-memory backend exposing just the named-file ops snapshots use.
class FileFake {
  blobs = new Map<string, string>();
  putFile(n: string, c: string): Promise<void> { this.blobs.set(n, c); return Promise.resolve(); }
  getFile(n: string): Promise<string | null> { return Promise.resolve(this.blobs.get(n) ?? null); }
  listFiles(p: string): Promise<string[]> { return Promise.resolve([...this.blobs.keys()].filter((k) => k.startsWith(p))); }
  deleteFile(n: string): Promise<void> { this.blobs.delete(n); return Promise.resolve(); }
}
const asBackend = (f: FileFake) => f as unknown as IBackend;

const INDEX_NAME = "konode_snap_index.json";

// Wipe device-local storage while leaving the backend intact — i.e. "the same
// account seen from a second device". Every cross-device assertion below runs
// after this, because the bug it guards was exactly a local-only index.
async function otherDevice(): Promise<void> {
  // Called with no keys the fake returns the whole store; chrome's own types don't
  // model that overload, hence the cast.
  const getAll = chrome.storage.local.get as unknown as () => Promise<Record<string, unknown>>;
  for (const k of Object.keys(await getAll())) await chrome.storage.local.remove(k);
}

async function localUrls(): Promise<string[]> {
  const tree = await chrome.bookmarks.getTree();
  const urls: string[] = [];
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
  tree.forEach(walk);
  return urls.sort();
}

const settings = (over: Partial<SyncSettings> = {}): SyncSettings => ({ ...DEFAULT_SETTINGS, ...over });
const e2ee = (pass = "correct horse battery") =>
  settings({ encryption_enabled: true, encryption_passphrase: pass });

const seedFiles = (backend: FileFake, n: number, base = 1_700_000_000_000): string[] => {
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const name = `konode_snap_bookmarks_${base + i}.json`;
    backend.blobs.set(name, "{}");
    names.push(name);
  }
  return names;
};

describe("snapshots — restore", () => {
  it("round-trips a bookmark deleted after the snapshot", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "C", url: "https://c.com/" });

    const backend = new FileFake();
    const meta = await createSnapshot(asBackend(backend), settings());
    expect(meta.count).toBe(3);

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    const b = bar.children!.find((c) => c.url === "https://b.com/")!;
    await chrome.bookmarks.remove(b.id);
    expect(await localUrls()).toEqual(["https://a.com/", "https://c.com/"]);

    const restored = await restoreSnapshot(asBackend(backend), meta.name, settings());
    expect(restored).toBe(1);
    expect(await localUrls()).toEqual(["https://a.com/", "https://b.com/", "https://c.com/"]);
  });

  // The filename is the timestamp, so back-to-back snapshots used to land on the
  // same name and the second silently replaced the first.
  it("does not overwrite a snapshot taken in the same millisecond", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());
    const second = await createSnapshot(asBackend(backend), settings());

    expect(second.name).not.toBe(first.name);
    expect(backend.blobs.has(first.name)).toBe(true);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(2);
  });

  it("encrypts the snapshot and restores with the passphrase (wrong one throws)", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Secret", url: "https://secret.example/" });
    const backend = new FileFake();
    const meta = await createSnapshot(asBackend(backend), e2ee());

    expect(backend.blobs.get(meta.name)).not.toContain("secret.example");

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    await chrome.bookmarks.remove(bar.children!.find((c) => c.url === "https://secret.example/")!.id);

    await expect(restoreSnapshot(asBackend(backend), meta.name, e2ee("wrong"))).rejects.toThrow();

    expect(await restoreSnapshot(asBackend(backend), meta.name, e2ee())).toBe(1);
    expect(await localUrls()).toContain("https://secret.example/");
  });
});

// The reported bug: the count index was device-local, so the bookmark count showed
// on the machine that took the snapshot and nowhere else.
describe("snapshots — counts across devices", () => {
  it("shows the count on a device that never took the snapshot", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), settings());

    await otherDevice();

    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(m.name);
    expect(list[0].count).toBe(2);
  });

  it("keeps both devices' counts when each takes its own snapshot", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());

    await otherDevice();
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const second = await createSnapshot(asBackend(backend), settings());

    await otherDevice(); // a third device, holding nothing of its own
    const byName = new Map((await listSnapshots(asBackend(backend), settings())).map((m) => [m.name, m.count]));
    expect(byName.get(first.name)).toBe(1);  // not clobbered by the second write
    expect(byName.get(second.name)).toBe(2);
  });

  it("carries counts across devices without putting them in plaintext", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), e2ee());

    // Neither the filename nor the index blob may spell out the count.
    expect(m.name).not.toMatch(/_1\.json$/);
    expect(backend.blobs.get(INDEX_NAME)).not.toContain("count");

    await otherDevice();
    const list = await listSnapshots(asBackend(backend), e2ee());
    expect(list[0].count).toBe(1);
  });

  it("still lists restore points when the index can't be decrypted", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), e2ee());

    await otherDevice();
    // Passphrase not entered on this device yet: the count is unknown, but losing
    // the annotation must not hide a restore point the user can still restore.
    const list = await listSnapshots(asBackend(backend), settings({ encryption_enabled: true }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(m.name);
    expect(list[0].count).toBeUndefined();
  });

  it("drops index entries whose snapshot file is gone", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const backend = new FileFake();
    const m = await createSnapshot(asBackend(backend), settings());

    backend.blobs.delete(m.name); // deleted by another device
    await otherDevice();

    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(0);
  });
});

// The second bug: prune walked the device-local index, so two devices each holding
// fewer than the cap between them pruned nothing and the folder grew unbounded.
describe("snapshots — prune", () => {
  it("prunes to the newest 10 from the backend list alone, with no local index", async () => {
    const backend = new FileFake();
    seedFiles(backend, 12);

    const kept = await pruneSnapshots(asBackend(backend));

    expect(kept).toHaveLength(10);
    const remaining = await listSnapshots(asBackend(backend), settings());
    expect(remaining).toHaveLength(10);
    expect(remaining.map((m) => m.timestamp).sort((a, b) => a - b)[0]).toBe(1_700_000_000_002);
  });

  it("prunes files this device never created", async () => {
    const backend = new FileFake();
    seedFiles(backend, 11);        // all written by other devices
    await otherDevice();           // nothing local at all

    await pruneSnapshots(asBackend(backend));

    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(10);
  });

  it("keeps everything while at or under the cap", async () => {
    const backend = new FileFake();
    seedFiles(backend, 10);
    expect(await pruneSnapshots(asBackend(backend))).toHaveLength(10);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(10);
  });

  it.each(["auto", "manual"] as const)("retains %s files and annotations when pruning deletes fail", async (origin) => {
    const backend = new FileFake();
    const prefix = origin === "manual" ? "konode_snap_manual_" : "konode_snap_bookmarks_";
    const metas = Array.from({ length: 12 }, (_, i) => ({
      name: `${prefix}${1_700_000_000_000 + i}.json`, timestamp: 1_700_000_000_000 + i,
      count: 20 + i, label: `Saved ${i}`, device_label: "Peer",
    }));
    for (const meta of metas) backend.blobs.set(meta.name, "{}");
    backend.blobs.set(INDEX_NAME, indexFile(metas));
    const remove = backend.deleteFile.bind(backend);
    vi.spyOn(backend, "deleteFile").mockImplementation((n) => {
      if (metas.slice(0, 2).some((m) => m.name === n)) return Promise.reject(new HttpError(423));
      return remove(n);
    });
    const warn = vi.spyOn(logger, "warn");

    const keep = await pruneSnapshots(asBackend(backend));

    expect(keep).toHaveLength(12);
    expect(keep).toContain(metas[0].name);
    expect(keep).toContain(metas[1].name);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Snapshots", expect.stringMatching(/Could not prune 2.*annotations/));

    await createSnapshot(asBackend(backend), settings(), { origin });

    const published: SnapshotMeta[] = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload);
    for (const meta of metas.slice(0, 2)) {
      expect(backend.blobs.has(meta.name)).toBe(true);
      expect(published.find((m) => m.name === meta.name)).toEqual(meta);
    }
    // The next oldest really was deleted, so only that annotation may be removed.
    expect(backend.blobs.has(metas[2].name)).toBe(false);
    expect(published.some((m) => m.name === metas[2].name)).toBe(false);
    await otherDevice();
    const shown = await listSnapshots(asBackend(backend), settings());
    expect(shown.find((m) => m.name === metas[0].name)).toMatchObject(metas[0]);
  });

  it("ignores files that aren't restore points", async () => {
    const backend = new FileFake();
    seedFiles(backend, 3);
    backend.blobs.set("konode_snap_bookmarks_notanumber.json", "{}");

    await pruneSnapshots(asBackend(backend));

    expect(backend.blobs.has("konode_snap_bookmarks_notanumber.json")).toBe(true);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(3);
  });

  // A week of incidents is enough to turn the ten-slot ring over, and before this the
  // ring did not care who had saved a point: the backup someone took on purpose before an
  // upgrade was evicted by automatic ones, silently, with nothing left to restore.
  it("does not let automatic points evict the ones saved by hand", async () => {
    const backend = new FileFake();
    const mine = "konode_snap_manual_1700000000000.json";
    backend.blobs.set(mine, "{}");
    seedFiles(backend, 12, 1_700_000_100_000); // a dozen newer automatic points

    await pruneSnapshots(asBackend(backend));

    expect(backend.blobs.has(mine)).toBe(true);
    expect([...backend.blobs.keys()].filter((n) => n.startsWith("konode_snap_bookmarks_")))
      .toHaveLength(10);
    expect(await listSnapshots(asBackend(backend), settings())).toHaveLength(11);
  });

  it("rotates the by-hand points against themselves", async () => {
    const backend = new FileFake();
    for (let i = 0; i < 12; i++) {
      backend.blobs.set(`konode_snap_manual_${1_700_000_000_000 + i}.json`, "{}");
    }

    await pruneSnapshots(asBackend(backend));

    const left = [...backend.blobs.keys()].filter((n) => n.startsWith("konode_snap_manual_"));
    expect(left).toHaveLength(10);
    // The two oldest went, which is the same rule the automatic ring follows.
    expect(left).not.toContain("konode_snap_manual_1700000000000.json");
  });

  it("writes a point the user saved under its own prefix, and it restores", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const saved = await createSnapshot(asBackend(backend), settings(), { origin: "manual" });
    const auto = await createSnapshot(asBackend(backend), settings(), { origin: "auto" });

    expect(saved.name).toMatch(/^konode_snap_manual_/);
    expect(auto.name).toMatch(/^konode_snap_bookmarks_/);
    expect(backend.blobs.has(saved.name)).toBe(true);

    const bar = (await chrome.bookmarks.getTree())[0].children!.find((c) => c.id === "1")!;
    await chrome.bookmarks.remove(bar.children!.find((c) => c.url === "https://a.com/")!.id);
    expect(await restoreSnapshot(asBackend(backend), saved.name, settings())).toBe(1);
    expect(await localUrls()).toContain("https://a.com/");
  });
});

describe("snapshots — delete", () => {
  it("removes the file and its index entry, leaving the rest intact", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const first = await createSnapshot(asBackend(backend), settings());
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.com/" });
    const second = await createSnapshot(asBackend(backend), settings());

    await deleteSnapshot(asBackend(backend), settings(), first.name);

    expect(backend.blobs.has(first.name)).toBe(false);
    await otherDevice();
    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(second.name);
    expect(list[0].count).toBe(2); // the survivor keeps its count
  });

  it("refuses a name that isn't a restore point", async () => {
    const backend = new FileFake();
    backend.blobs.set("konode_bookmarks_device.json", "{}");

    await expect(deleteSnapshot(asBackend(backend), settings(), "konode_bookmarks_device.json"))
      .rejects.toThrow(/Not a restore point/);
    expect(backend.blobs.has("konode_bookmarks_device.json")).toBe(true);
  });
});

describe("snapshots — legacy index migration", () => {
  it("publishes the old device-local counts instead of discarding them", async () => {
    const backend = new FileFake();
    const [a, b] = seedFiles(backend, 2);
    await chrome.storage.local.set({
      [KEYS.LEGACY_SNAPSHOTS]: [
        { name: a, timestamp: 1_700_000_000_000, count: 41 },
        { name: b, timestamp: 1_700_000_000_001, count: 61 },
      ],
    });

    const list = await listSnapshots(asBackend(backend), settings());
    expect(list.map((m) => m.count)).toEqual([61, 41]); // newest first

    // Drained: the legacy key is gone and the counts now live on the backend.
    expect((await chrome.storage.local.get(KEYS.LEGACY_SNAPSHOTS))[KEYS.LEGACY_SNAPSHOTS]).toBeUndefined();
    await otherDevice();
    expect((await listSnapshots(asBackend(backend), settings())).map((m) => m.count)).toEqual([61, 41]);
  });

  it("is a no-op when there is nothing to migrate", async () => {
    const backend = new FileFake();
    seedFiles(backend, 1);
    const list = await listSnapshots(asBackend(backend), settings());
    expect(list).toHaveLength(1);
    expect(list[0].count).toBeUndefined();
    expect(backend.blobs.has(INDEX_NAME)).toBe(false); // no pointless index write
  });
});

describe("snapshots — an unreadable shared index is never overwritten", () => {
  // The index is only an ANNOTATION: the backend file list is what says which restore
  // points exist. So a lost count is cosmetic, while overwriting an index we couldn't
  // read destroys every other device's counts — or downgrades the group's encrypted
  // index to plaintext, the very thing the sync engine's applyRemote refuses.

  it("does not decrypt or rewrite an encrypted index when E2EE is OFF here", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    // Device 1 has E2EE on and publishes an encrypted index.
    await createSnapshot(asBackend(backend), e2ee());
    const encrypted = backend.blobs.get(INDEX_NAME)!;
    expect(JSON.parse(encrypted).encrypted).toBe(true);

    // Device 2: E2EE turned OFF, but the passphrase still lingers in settings — which
    // is exactly what the sync engine calls a C1 downgrade.
    await otherDevice();
    const lingering = settings({ encryption_enabled: false, encryption_passphrase: "correct horse battery" });
    await createSnapshot(asBackend(backend), lingering);

    // The index must be untouched — NOT rewritten in plaintext.
    expect(backend.blobs.get(INDEX_NAME)).toBe(encrypted);
  });

  it("does not rewrite an index it cannot decrypt (wrong passphrase)", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), e2ee("the real passphrase"));
    const before = backend.blobs.get(INDEX_NAME)!;

    await otherDevice();
    await createSnapshot(asBackend(backend), e2ee("a different passphrase"));

    expect(backend.blobs.get(INDEX_NAME)).toBe(before);
  });

  it("does not wipe other devices' counts when the index read fails transiently", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), settings());
    const before = backend.blobs.get(INDEX_NAME)!;
    expect(JSON.parse(before).payload).toContain("count");

    // A 500 from the backend is NOT "there is no index".
    await otherDevice();
    const flaky = new FileFake();
    flaky.blobs = backend.blobs;
    flaky.getFile = (n: string) =>
      n === INDEX_NAME ? Promise.reject(new Error("HTTP 500")) : Promise.resolve(flaky.blobs.get(n) ?? null);

    await createSnapshot(asBackend(flaky), settings());

    expect(flaky.blobs.get(INDEX_NAME)).toBe(before);
  });

  it("keeps the legacy counts when they could not be published", async () => {
    const backend = new FileFake();
    const [name] = seedFiles(backend, 1);
    // An encrypted index this device can't read (E2EE off, passphrase lingering).
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    await createSnapshot(asBackend(backend), e2ee());
    await otherDevice();
    await chrome.storage.local.set({ [KEYS.LEGACY_SNAPSHOTS]: [{ name, timestamp: 1, count: 42 }] });

    await listSnapshots(asBackend(backend), settings({ encryption_passphrase: "correct horse battery" }));

    // The legacy key must SURVIVE — these counts exist nowhere else, and dropping it
    // after a failed publish deleted them for good.
    expect((await chrome.storage.local.get(KEYS.LEGACY_SNAPSHOTS))[KEYS.LEGACY_SNAPSHOTS]).toBeDefined();
  });

  it("still replaces an index that is garbage for every device", async () => {
    // Unparseable is not "unreadable by me" — nothing is lost by rewriting it, and
    // otherwise a corrupt index could never self-heal.
    const backend = new FileFake();
    backend.blobs.set(INDEX_NAME, "}{ not json");
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });

    const meta = await createSnapshot(asBackend(backend), settings());

    const idx = JSON.parse(backend.blobs.get(INDEX_NAME)!);
    expect(idx.encrypted).toBe(false);
    expect(JSON.parse(idx.payload).map((m: { name: string }) => m.name)).toEqual([meta.name]);
  });

  it("still lists the restore points when the index is unreadable (counts only are lost)", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.com/" });
    const meta = await createSnapshot(asBackend(backend), e2ee());

    await otherDevice();
    const list = await listSnapshots(asBackend(backend), settings()); // no passphrase here

    expect(list.map((m) => m.name)).toEqual([meta.name]);
    expect(list[0].count).toBeUndefined();
  });
});

describe("restoreSnapshot only accepts one of our own filenames", () => {
  it("refuses a name that is not a restore point", async () => {
    // `deleteSnapshot` has always checked this and `restoreSnapshot` did not, though both
    // hand the string to the backend as a path component. Nothing can pass a bad one
    // today, since the UI lists only names that already matched the pattern — but two
    // functions taking the same argument to the same place should not disagree about
    // whether it needs checking.
    const backend = new FileFake();
    await expect(
      restoreSnapshot(asBackend(backend), "../../konode_settings.json", settings())
    ).rejects.toThrow(/not a restore point/i);
  });

  it("still restores a real one", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const meta = await createSnapshot(asBackend(backend), settings());
    await chrome.bookmarks.removeTree("1");

    expect(await restoreSnapshot(asBackend(backend), meta.name, settings())).toBeGreaterThan(0);
  });

  it("accepts a kept-forever name too", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const meta = await createSnapshot(asBackend(backend), settings(), { pinned: true });
    await chrome.bookmarks.removeTree("1");

    expect(await restoreSnapshot(asBackend(backend), meta.name, settings())).toBeGreaterThan(0);
  });
});

describe("snapshots — device, name and keeping forever", () => {
  const mine = () => settings({ device_label: "Macmini M4pro" });

  it("uses one rule for the default name and never stores it as a user label", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const s = settings({
      device_label: "Macmini M4pro",
      device_id: "b3f1c2d4-0000-4000-8000-000000000001",
    });
    const meta = await createSnapshot(asBackend(backend), s, { origin: "manual" });

    // The default name is computed when the row is drawn. Freezing it into the shared
    // index is what made the rule drift across releases and languages.
    expect(meta.label).toBeUndefined();
    expect(snapshotIsUnnamed(meta)).toBe(true);
    expect(snapshotDisplayName(meta)).toBe(
      `${t("opt_snap_unknown")} · Macmini M4pro · b3f1c2d4`
    );

    // A name the user actually chose always wins.
    const named = { ...meta, label: "  改版前  " };
    expect(snapshotDisplayName(named)).toBe("改版前");

    // An automatic label written by an older build is still recognised as unnamed,
    // so the corrected rule reaches points those builds already saved. The suffix is a
    // literal here: it was dropped from the catalogues when default names stopped being
    // stored, and this is only a fixture for data such a build could have written.
    const legacy = {
      ...meta,
      label: `Macmini M4pro ${shortDeviceId(meta.device_id)} restore point`,
    };
    expect(snapshotIsUnnamed(legacy)).toBe(true);
    expect(snapshotDisplayName(legacy)).toBe(
      `${t("opt_snap_unknown")} · Macmini M4pro · b3f1c2d4`
    );

    // No device info in the index: the bare, still meaningful fallback.
    expect(snapshotDisplayName({})).toBe(t("opt_snap_unknown"));
  });

  it("records which device saved a point and the name the user gave it", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), mine(), { origin: "manual" });
    expect(created.device_label).toBe("Macmini M4pro");
    expect(created.origin).toBe("manual");

    await renameSnapshot(asBackend(backend), mine(), created.name, "  改版前  ");
    await otherDevice();

    const list = await listSnapshots(asBackend(backend), mine());
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("改版前"); // trimmed
    expect(list[0].device_label).toBe("Macmini M4pro");
    expect(list[0].count).toBe(1); // the annotation survived the rename
  });

  it("keeps a name when another device writes a point of its own", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const first = await createSnapshot(asBackend(backend), mine());
    await renameSnapshot(asBackend(backend), mine(), first.name, "Before cleanup");

    await otherDevice();
    const second = await createSnapshot(asBackend(backend), settings({ device_label: "Laptop" }), { origin: "auto" });

    const byName = new Map((await listSnapshots(asBackend(backend), mine())).map((m) => [m.name, m]));
    expect(byName.get(first.name)?.label).toBe("Before cleanup");
    expect(byName.get(second.name)?.origin).toBe("auto");
    expect(byName.get(second.name)?.device_label).toBe("Laptop");
  });

  it("a kept-forever point is outside the rolling ten and survives pruning", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const kept = await createSnapshot(asBackend(backend), mine(), { pinned: true });
    expect(kept.name).toMatch(/^konode_snap_kept_/);

    seedFiles(backend, 12); // twelve ordinary points, all older
    await pruneSnapshots(asBackend(backend));

    expect(backend.blobs.has(kept.name)).toBe(true);
    const list = await listSnapshots(asBackend(backend), mine());
    expect(list).toHaveLength(11); // 10 rolling + the kept one
    expect(list.find((m) => m.name === kept.name)?.pinned).toBe(true);
  });

  it("pinning an existing point moves the file and carries its name and count over", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), mine());
    await renameSnapshot(asBackend(backend), mine(), created.name, "Before cleanup");

    await setSnapshotPinned(asBackend(backend), mine(), created.name, true);
    expect(backend.blobs.has(created.name)).toBe(false);
    const kept = (await listSnapshots(asBackend(backend), mine())).find((m) => m.pinned)!;
    expect(kept.name).not.toBe(created.name);
    expect(kept.label).toBe("Before cleanup");
    expect(kept.count).toBe(1);
    expect(backend.blobs.get(kept.name)).toBeDefined();

    await setSnapshotPinned(asBackend(backend), mine(), kept.name, false);
    const back = await listSnapshots(asBackend(backend), mine());
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe(created.name);
    expect(back[0].pinned).toBeUndefined();
    expect(back[0].label).toBe("Before cleanup");
  });

  it("deleting a kept point does not drop the other kept points from the index", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const a = await createSnapshot(asBackend(backend), mine(), { pinned: true });
    const b = await createSnapshot(asBackend(backend), mine(), { pinned: true });

    await deleteSnapshot(asBackend(backend), mine(), a.name);

    const list = await listSnapshots(asBackend(backend), mine());
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(b.name);
    expect(list[0].count).toBe(1);
  });

  it("reads an index written before these fields existed, deriving 'kept' from the filename", async () => {
    const backend = new FileFake();
    const name = "konode_snap_kept_1700000000000.json";
    backend.blobs.set(name, "{}");
    backend.blobs.set(INDEX_NAME, JSON.stringify({
      version: "1.0", encrypted: false,
      payload: JSON.stringify([{ name, timestamp: 1_700_000_000_000, count: 7 }]),
    }));

    const list = await listSnapshots(asBackend(backend), mine());
    expect(list).toHaveLength(1);
    expect(list[0].pinned).toBe(true);
    expect(list[0].count).toBe(7);
    expect(list[0].device_label).toBeUndefined();
  });

  it("never overwrites an index it cannot read, even when renaming or pinning locally", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), e2ee("the real passphrase"));
    const before = backend.blobs.get(INDEX_NAME)!;

    await otherDevice();
    const wrong = e2ee("a different passphrase");
    // A refused index is never rewritten. Renaming and pinning now act on the LOCAL
    // annotation / the file name instead of failing with "cannot be read here".
    await renameSnapshot(asBackend(backend), wrong, created.name, "Local name");
    expect((await listSnapshots(asBackend(backend), wrong))[0].label).toBe("Local name");
    await setSnapshotPinned(asBackend(backend), wrong, created.name, true);

    expect(backend.blobs.get(INDEX_NAME)).toBe(before);
    expect(backend.blobs.has(created.name)).toBe(false); // moved to the kept prefix
    const kept = (await listSnapshots(asBackend(backend), wrong)).find((m) => m.pinned)!;
    expect(kept.label).toBe("Local name");
  });
});

// Nutstore answers its WebDAV frequency cap with 403, sometimes for hours. The shared
// index is then unreadable AND unwritable — the state that made every default-name
// change look like it never shipped.
class ForbiddenIndexFake extends FileFake {
  getFile(n: string): Promise<string | null> {
    if (n === INDEX_NAME) return Promise.reject(new Error("WebDAV GET failed: 403"));
    return super.getFile(n);
  }
}

/**
 * A backend that can report a version and refuses a write that names a stale one, like
 * WebDAV's `If-Match` or GitHub's `sha`. `interfere` runs ONCE, immediately before a
 * conditional write: it models the other device landing its own write in exactly the
 * window a plain read-merge-write cannot survive.
 */
class VersionedFake extends FileFake {
  private versions = new Map<string, number>();
  writes = 0;
  writeAttempts = 0;
  interfere: (() => void) | null = null;

  /** The version this backend currently reports, so a caller can hand it out. */
  private versionOf(n: string): string | null {
    return this.blobs.has(n) ? `v${this.versions.get(n) ?? 0}` : null;
  }

  getFileVersion(n: string): Promise<string | null> {
    return Promise.resolve(this.versionOf(n));
  }

  /** Pretend another device wrote `content` (bypassing the condition). */
  applyElsewhere(n: string, content: string): void {
    this.versions.set(n, (this.versions.get(n) ?? 0) + 1);
    this.blobs.set(n, content);
  }

  putFileIfVersion(n: string, content: string, version: string | null): Promise<boolean> {
    this.writeAttempts++;
    if (this.interfere) {
      const run = this.interfere;
      this.interfere = null;
      run();
    }
    if (this.versionOf(n) !== version) return Promise.resolve(false);
    this.applyElsewhere(n, content);
    this.writes++;
    return Promise.resolve(true);
  }
}

/** The shared index as this module writes it: a plain (unencrypted) wrapper. */
const indexFile = (list: unknown[]): string =>
  JSON.stringify({ version: "1.0", encrypted: false, payload: JSON.stringify(list) });

describe("snapshots — shared index refused (Nutstore 403)", () => {
  const device = () => settings({
    device_label: "Macmini M4pro",
    device_id: "b3f1c2d4-0000-4000-8000-000000000001",
  });
  const expected = `${t("opt_snap_unknown")} · Macmini M4pro · b3f1c2d4`;

  it("still builds the default name from this device's own annotations", async () => {
    const backend = new ForbiddenIndexFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    await createSnapshot(asBackend(backend), device(), { origin: "manual" });

    // Nothing was written over an index we could not read.
    expect(backend.blobs.has(INDEX_NAME)).toBe(false);
    const list = await listSnapshots(asBackend(backend), device());
    expect(list).toHaveLength(1);
    expect(list[0].count).toBe(1);
    expect(snapshotDisplayName(list[0])).toBe(expected);

    // Renaming this device must not rename a point that is already on the backend.
    const renamedViewer = await listSnapshots(asBackend(backend), settings({
      device_label: "改名之后", device_id: "b3f1c2d4-0000-4000-8000-000000000001",
    }));
    expect(snapshotDisplayName(renamedViewer[0])).toBe(expected);

    // Another device has no local copy and no readable index. It must NOT borrow its
    // own identity to label somebody else's point: that guess silently relabelled
    // every older restore point after a device rename or a settings import. No
    // invented device info and no invented bookmark count.
    await otherDevice();
    const other = await listSnapshots(asBackend(backend), settings({
      device_label: "Laptop", device_id: "aaaaaaaa-0000-4000-8000-000000000002",
    }));
    expect(snapshotDisplayName(other[0])).toBe(t("opt_snap_unknown"));
    expect(other[0].device_label).toBeUndefined();
    expect(other[0].count).toBeUndefined();
  });

  it("lets the user rename and keep a point while the index is refused", async () => {
    const backend = new ForbiddenIndexFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), device(), { origin: "manual" });

    await renameSnapshot(asBackend(backend), device(), created.name, "  改版前  ");
    const named = await listSnapshots(asBackend(backend), device());
    expect(named[0].label).toBe("改版前");
    expect(snapshotDisplayName(named[0])).toBe("改版前");

    await renameSnapshot(asBackend(backend), device(), created.name, "");
    expect(snapshotDisplayName((await listSnapshots(asBackend(backend), device()))[0])).toBe(expected);

    await setSnapshotPinned(asBackend(backend), device(), created.name, true);
    const kept = (await listSnapshots(asBackend(backend), device())).find((m) => m.pinned)!;
    expect(kept).toBeDefined();
    expect(snapshotDisplayName(kept)).toBe(expected);
    expect(backend.blobs.has(INDEX_NAME)).toBe(false);
  });
});

describe("snapshots — a point keeps naming the device that took it", () => {
  const macbook = () => settings({
    device_label: "Macbook",
    device_id: "451dbeb9-0000-4000-8000-000000000001",
  });
  const tag = (device: string) => `${t("opt_snap_unknown")} · ${device} · 451dbeb9`;

  it("freezes the device into the point, so a later rename reaches only new points", async () => {
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const first = await createSnapshot(asBackend(backend), macbook());

    // The owner renames the computer in Settings — or an older build "cleaned" the name
    // it had stored. Either way, the point already taken keeps its own device.
    const renamed = settings({ device_label: "Studio", device_id: macbook().device_id });
    const second = await createSnapshot(asBackend(backend), renamed);

    const byName = new Map((await listSnapshots(asBackend(backend), renamed)).map((m) => [m.name, m]));
    expect(snapshotDisplayName(byName.get(first.name)!)).toBe(tag("Macbook"));
    expect(snapshotDisplayName(byName.get(second.name)!)).toBe(tag("Studio"));
  });

  it("keeps the frozen device even when the entry loses its device fields", async () => {
    // An index written by a build that only stores `label` — or a merge that dropped the
    // device fields — must not make the point borrow the viewer's identity.
    const backend = new FileFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const point = await createSnapshot(asBackend(backend), macbook());
    const stripped = { ...point, device_label: undefined, device_id: undefined };
    expect(snapshotDisplayName(stripped)).toBe(tag("Macbook"));
  });

  it("lets the user name a point after their own machine", async () => {
    // "Macbook 升级前" starts with the device label and is still a name a person chose;
    // treating that as an automatic name threw their words away and showed the default.
    const named = { label: "Macbook 升级前", device_label: "Macbook", device_id: macbook().device_id };
    expect(snapshotIsUnnamed(named)).toBe(false);
    expect(snapshotDisplayName(named)).toBe("Macbook 升级前");
  });
});

describe("snapshots — the shared index is written under a condition", () => {
  // The index is the ONE file several devices write. Without a condition, two devices
  // taking a restore point at the same moment each merged into the list they had read,
  // and the later write silently dropped the earlier one's name and count — which, from
  // the outside, is what "my restore point lost its name again" looks like.
  const since = 1_700_000_000_000;

  it("merges again when another device wrote the index in between", async () => {
    await otherDevice();
    const backend = new VersionedFake();
    // A peer's restore point, already on the backend but not yet in the index.
    const peerPoint = `konode_snap_bookmarks_${since}.json`;
    backend.blobs.set(peerPoint, "{}");

    // The peer lands its annotation exactly in the window between our read and our write.
    backend.interfere = () => {
      backend.applyElsewhere(
        INDEX_NAME,
        indexFile([{ name: peerPoint, timestamp: since, count: 7, device_label: "Laptop" }]),
      );
    };

    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const mine = await createSnapshot(asBackend(backend), settings(), { origin: "manual" });

    expect(backend.writeAttempts).toBe(2); // the first was refused, the second landed
    const published = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload) as
      { name: string; count?: number }[];
    // BOTH annotations survive, which is the whole point.
    expect(published.map((m) => m.name).sort()).toEqual([mine.name, peerPoint].sort());
    expect(published.find((m) => m.name === peerPoint)!.count).toBe(7);
  });

  it("never falls back to an unconditional PUT when every CAS attempt loses", async () => {
    const backend = new VersionedFake();
    const [name] = seedFiles(backend, 1);
    let peerIndex = indexFile([{ name, timestamp: since, label: "Peer 0" }]);
    backend.blobs.set(INDEX_NAME, peerIndex);
    const interfere = () => {
      peerIndex = indexFile([{ name, timestamp: since, label: `Peer ${backend.writeAttempts}` }]);
      backend.applyElsewhere(INDEX_NAME, peerIndex);
      backend.interfere = interfere;
    };
    backend.interfere = interfere;
    const put = vi.spyOn(backend, "putFile");
    const warn = vi.spyOn(logger, "warn");

    const created = await createSnapshot(asBackend(backend), settings(), { origin: "manual" });

    expect(backend.writeAttempts).toBe(4);
    expect(backend.writes).toBe(0);
    expect(put.mock.calls.filter(([n]) => n === INDEX_NAME)).toEqual([]);
    expect(backend.blobs.get(INDEX_NAME)).toBe(peerIndex);
    expect(warn).toHaveBeenCalledWith("Snapshots", expect.stringMatching(/all 4 conditional.*untouched/));
    const local = (await chrome.storage.local.get(KEYS.SNAPSHOT_LOCAL))[KEYS.SNAPSHOT_LOCAL];
    expect(local[created.name]).toMatchObject(created);
  });

  it("retains legacy annotations when conditional retries are exhausted", async () => {
    const backend = new VersionedFake();
    const [name] = seedFiles(backend, 1);
    const legacy = [{ name, timestamp: since, count: 42 }];
    await chrome.storage.local.set({ [KEYS.LEGACY_SNAPSHOTS]: legacy });
    vi.spyOn(backend, "putFileIfVersion").mockResolvedValue(false);
    const put = vi.spyOn(backend, "putFile");

    await listSnapshots(asBackend(backend), settings());

    expect(put).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get(KEYS.LEGACY_SNAPSHOTS))[KEYS.LEGACY_SNAPSHOTS]).toEqual(legacy);
  });

  it.each([
    new HttpError(401), new HttpError(403), new HttpError(408), new HttpError(423),
    new HttpError(429), new HttpError(503), new TypeError("Failed to fetch"),
    new Error("Unexpected version lookup failure"),
  ])("leaves the index untouched when version lookup fails: %s", async (error) => {
    const backend = new VersionedFake();
    const [name] = seedFiles(backend, 1);
    const before = indexFile([{ name, timestamp: since, count: 7, label: "Peer annotation" }]);
    backend.blobs.set(INDEX_NAME, before);
    vi.spyOn(backend, "getFileVersion").mockRejectedValue(error);
    const put = vi.spyOn(backend, "putFile");
    const warn = vi.spyOn(logger, "warn");

    await createSnapshot(asBackend(backend), settings(), { origin: "manual" });

    expect(backend.blobs.get(INDEX_NAME)).toBe(before);
    expect(backend.writeAttempts).toBe(0);
    expect(put.mock.calls.filter(([n]) => n === INDEX_NAME)).toEqual([]);
    expect(warn).toHaveBeenCalledWith("Snapshots", expect.stringMatching(/version.*untouched/));
  });

  it.each([
    "This WebDAV server sends no ETag, so writes cannot be made conditional",
    "Drive returned no etag, so writes cannot be made conditional",
  ])("keeps the explicit no-ETag fallback: %s", async (message) => {
    const backend = new VersionedFake();
    const [name] = seedFiles(backend, 1);
    backend.blobs.set(INDEX_NAME, indexFile([{ name, timestamp: since, count: 7 }]));
    vi.spyOn(backend, "getFileVersion").mockRejectedValue(new Error(message));
    const put = vi.spyOn(backend, "putFile");

    const created = await createSnapshot(asBackend(backend), settings(), { origin: "manual" });

    const published: SnapshotMeta[] = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload);
    expect(published.find((m) => m.name === name)?.count).toBe(7);
    expect(published.find((m) => m.name === created.name)).toBeDefined();
    expect(put.mock.calls.filter(([n]) => n === INDEX_NAME)).toHaveLength(1);
    expect(backend.writeAttempts).toBe(0);
  });

  it("still writes the index for a storage that cannot report a version", async () => {
    await otherDevice();
    const backend = new FileFake(); // no getFileVersion / putFileIfVersion
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), settings(), { origin: "manual" });

    const published = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload) as { name: string }[];
    expect(published.map((m) => m.name)).toContain(created.name);
  });
});

describe("snapshots — peer annotations survive stale listings", () => {
  it.each(["create", "rename", "pin", "delete", "migrate"] as const)(
    "%s preserves peers arriving before the index read and during a CAS retry",
    async (operation) => {
      const backend = new VersionedFake();
      const since = 1_700_000_000_000;
      const [name] = seedFiles(backend, 1, since);
      const original = { name, timestamp: since, label: "Original", count: 9 };
      const peers = [1, 2].map((offset) => ({
        name: `konode_snap_kept_${since + offset}.json`, timestamp: since + offset,
        count: 10 + offset, label: `Peer ${offset}`, device_label: "Other device",
      }));
      backend.blobs.set(INDEX_NAME, indexFile([original]));
      const get = backend.getFile.bind(backend);
      let indexReads = 0;
      const events: string[] = [];
      vi.spyOn(backend, "getFile").mockImplementation((n) => {
        if (n === INDEX_NAME) {
          events.push("read");
          if (++indexReads === 1) {
            backend.blobs.set(peers[0].name, "{}");
            backend.applyElsewhere(INDEX_NAME, indexFile([original, peers[0]]));
          }
        }
        return get(n);
      });
      // Like WebDAV's instance cache: peer writes do not invalidate this listing.
      // Local writes remain visible, but neither new peer is ever returned here.
      const list = backend.listFiles.bind(backend);
      const listing = vi.spyOn(backend, "listFiles").mockImplementation(async (prefix) => {
        events.push("list");
        return (await list(prefix)).filter((n) => !peers.some((p) => p.name === n));
      });
      backend.interfere = () => {
        backend.blobs.set(peers[1].name, "{}");
        backend.applyElsewhere(INDEX_NAME, indexFile([original, ...peers]));
      };

      if (operation === "create") await createSnapshot(asBackend(backend), settings(), { origin: "manual" });
      if (operation === "rename") await renameSnapshot(asBackend(backend), settings(), name, "Renamed");
      if (operation === "pin") await setSnapshotPinned(asBackend(backend), settings(), name, true);
      if (operation === "delete") await deleteSnapshot(asBackend(backend), settings(), name);
      if (operation === "migrate") {
        await chrome.storage.local.set({ [KEYS.LEGACY_SNAPSHOTS]: [original] });
        await listSnapshots(asBackend(backend), settings());
      }

      expect(backend.writeAttempts).toBe(2);
      expect(indexReads).toBe(2);
      for (let i = 0; i < events.length; i++) {
        if (events[i] === "read") expect(events.slice(i + 1, i + 4)).toEqual(["list", "list", "list"]);
      }
      const published: SnapshotMeta[] = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload);
      for (const peer of peers) expect(published.find((m) => m.name === peer.name)).toEqual(peer);
      if (operation === "rename") expect(published.find((m) => m.name === name)?.label).toBe("Renamed");
      if (operation === "pin" || operation === "delete") expect(published.some((m) => m.name === name)).toBe(false);
      if (operation === "pin") {
        expect(published.find((m) => m.name === `konode_snap_kept_${since}.json`))
          .toMatchObject({ pinned: true, count: 9, label: "Original" });
      }

      listing.mockRestore(); // A new device / instance finally gets a fresh listing.
      await otherDevice();
      const shown = await listSnapshots(asBackend(backend), settings());
      for (const peer of peers) expect(shown.find((m) => m.name === peer.name)).toMatchObject(peer);
    },
  );

  it("preserves a peer arriving between rename's listing and GET without conditional support", async () => {
    const backend = new FileFake();
    const [name] = seedFiles(backend, 1);
    const peer = { name: "konode_snap_manual_1700000000001.json", timestamp: 1_700_000_000_001, label: "New peer" };
    const get = backend.getFile.bind(backend);
    vi.spyOn(backend, "getFile").mockImplementation((n) => {
      if (n === INDEX_NAME) {
        backend.blobs.set(peer.name, "{}");
        backend.blobs.set(INDEX_NAME, indexFile([peer]));
      }
      return get(n);
    });

    await renameSnapshot(asBackend(backend), settings(), name, "Mine");

    const published: SnapshotMeta[] = JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload);
    expect(published).toContainEqual(peer);
    expect(published.find((m) => m.name === name)?.label).toBe("Mine");
  });

  it("keeps unknown remote metadata but still hides missing files from the display", async () => {
    const backend = new FileFake();
    const [name] = seedFiles(backend, 1);
    const missing = { name: "konode_snap_kept_1699999999999.json", timestamp: 1_699_999_999_999, label: "Unknown" };
    backend.blobs.set(INDEX_NAME, indexFile([missing]));

    await renameSnapshot(asBackend(backend), settings(), name, "Mine");

    expect(JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload)).toContainEqual(missing);
    expect((await listSnapshots(asBackend(backend), settings())).map((m) => m.name)).toEqual([name]);
  });
});

// Nutstore's frequency cap refuses WRITES too. "Keep forever" used to fail the whole
// click with a wall of 403 text because the mark is a file name (PUT + DELETE), while
// renaming a point has a local fallback and kept working.
class RefusingWritesFake extends FileFake {
  refuse = true;
  putFile(n: string, c: string): Promise<void> {
    if (this.refuse) return Promise.reject(new HttpError(403, "Forbidden (403)"));
    return super.putFile(n, c);
  }
  deleteFile(n: string): Promise<void> {
    if (this.refuse) return Promise.reject(new HttpError(403, "Forbidden (403)"));
    return super.deleteFile(n);
  }
}

class RefusingDeleteFake extends FileFake {
  refuse = true;
  deleteFile(n: string): Promise<void> {
    if (this.refuse) return Promise.reject(new HttpError(403, "Forbidden (403)"));
    return super.deleteFile(n);
  }
}

describe("snapshots — keep forever while the storage refuses writes", () => {
  it.each([new HttpError(401), new HttpError(408), new HttpError(423), new TypeError("Failed to fetch")])(
    "keeps a refused pin protected from pruning and completes it after recovery: %s",
    async (error) => {
      const backend = new FileFake();
      const [name] = seedFiles(backend, 1);
      const target = name.replace("bookmarks", "kept");
      backend.blobs.set(INDEX_NAME, indexFile([{ name, timestamp: 1_700_000_000_000, count: 7, label: "Protect me" }]));
      const put = backend.putFile.bind(backend);
      const refusal = vi.spyOn(backend, "putFile").mockRejectedValue(error);

      expect(await setSnapshotPinned(asBackend(backend), settings(), name, true)).toBe(false);
      await flushPendingPins(asBackend(backend), settings());
      const pending = (await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN];
      expect(pending).toEqual([{ name, pinned: true }]);
      seedFiles(backend, 12, 1_700_000_000_001);
      expect(await pruneSnapshots(asBackend(backend))).toContain(name);
      expect(backend.blobs.has(name)).toBe(true);

      refusal.mockImplementation(put);
      await flushPendingPins(asBackend(backend), settings());

      expect(backend.blobs.has(name)).toBe(false);
      expect(backend.blobs.has(target)).toBe(true);
      expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual([]);
      await otherDevice();
      expect((await listSnapshots(asBackend(backend), settings())).find((m) => m.name === target))
        .toMatchObject({ pinned: true, count: 7, label: "Protect me" });
    },
  );

  it.each([new Error("Unknown backend failure"), new HttpError(404), new HttpError(400)])(
    "does not discard queued intent on an unclassified error: %s",
    async (error) => {
      const backend = new FileFake();
      const [name, second] = seedFiles(backend, 2);
      const pending = [{ name, pinned: true }, { name: second, pinned: true }];
      await chrome.storage.local.set({ [KEYS.SNAPSHOT_PENDING_PIN]: pending });
      const get = vi.spyOn(backend, "getFile").mockRejectedValue(error);
      const warn = vi.spyOn(logger, "warn");

      await flushPendingPins(asBackend(backend), settings());

      expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual(pending);
      expect(get).toHaveBeenCalledTimes(1); // Stop, rather than spending another round on the second intent.
      expect(warn).toHaveBeenCalledWith("Snapshots", expect.stringMatching(/keeping it for retry/));
      seedFiles(backend, 12, 1_700_000_000_002);
      const kept = await pruneSnapshots(asBackend(backend));
      expect(kept).toContain(name);
      expect(kept).toContain(second);

      get.mockRestore();
      await flushPendingPins(asBackend(backend), settings());
      expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual([]);
      expect(backend.blobs.has(name.replace("bookmarks", "kept"))).toBe(true);
    },
  );

  it("clears only invalid names and snapshots confirmed absent at both source and target", async () => {
    const backend = new FileFake();
    const name = "konode_snap_bookmarks_1700000000000.json";
    const invalid = "../../not-a-snapshot.json";
    await chrome.storage.local.set({
      [KEYS.SNAPSHOT_PENDING_PIN]: [{ name: invalid, pinned: true }, { name, pinned: true }],
    });
    const get = vi.spyOn(backend, "getFile");
    const put = vi.spyOn(backend, "putFile");

    await flushPendingPins(asBackend(backend), settings());

    expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual([]);
    expect(get.mock.calls.map(([n]) => n)).toEqual([name.replace("bookmarks", "kept"), name]);
    expect(put).not.toHaveBeenCalled();
  });

  it("does not infer a missing snapshot from a stale empty listing", async () => {
    const backend = new FileFake();
    const [name] = seedFiles(backend, 1);
    vi.spyOn(backend, "listFiles").mockResolvedValue([]);
    await chrome.storage.local.set({ [KEYS.SNAPSHOT_PENDING_PIN]: [{ name, pinned: true }] });

    await flushPendingPins(asBackend(backend), settings());

    expect(backend.blobs.has(name.replace("bookmarks", "kept"))).toBe(true);
    expect(backend.blobs.has(name)).toBe(false);
    expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual([]);
  });

  it("finishes an already moved target without rewriting it or losing its annotations", async () => {
    const backend = new FileFake();
    const source = "konode_snap_bookmarks_1700000000000.json";
    const target = source.replace("bookmarks", "kept");
    const meta = { name: target, timestamp: 1_700_000_000_000, count: 7, label: "Already kept", pinned: true };
    backend.blobs.set(target, "original target payload");
    backend.blobs.set(INDEX_NAME, indexFile([meta]));
    await chrome.storage.local.set({ [KEYS.SNAPSHOT_PENDING_PIN]: [{ name: source, pinned: true }] });
    const put = vi.spyOn(backend, "putFile");

    await flushPendingPins(asBackend(backend), settings());

    expect(backend.blobs.get(target)).toBe("original target payload");
    expect(put.mock.calls.map(([n]) => n)).toEqual([INDEX_NAME]);
    expect(JSON.parse(JSON.parse(backend.blobs.get(INDEX_NAME)!).payload)).toEqual([meta]);
    expect((await chrome.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN))[KEYS.SNAPSHOT_PENDING_PIN]).toEqual([]);
  });

  it("shows the click as kept at once and finishes the rename when the storage answers", async () => {
    await otherDevice();
    const backend = new RefusingWritesFake();
    backend.refuse = false;
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), settings());
    backend.refuse = true;

    await expect(setSnapshotPinned(asBackend(backend), settings(), created.name, true)).resolves.toBe(false);
    expect(backend.blobs.has(created.name)).toBe(true);
    const during = await listSnapshots(asBackend(backend), settings());
    expect(during.find((m) => m.name === created.name)?.pinned).toBe(true);

    backend.refuse = false;
    await flushPendingPins(asBackend(backend), settings());
    expect(backend.blobs.has(created.name)).toBe(false);
    const kept = (await listSnapshots(asBackend(backend), settings())).find((m) => m.pinned);
    expect(kept?.name).toMatch(/^konode_snap_kept_/);
  });

  it("finishes an attempt whose write succeeded but delete was refused, without a duplicate", async () => {
    await otherDevice();
    const backend = new RefusingDeleteFake();
    backend.refuse = false;
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), settings());
    backend.refuse = true;

    await expect(setSnapshotPinned(asBackend(backend), settings(), created.name, true)).resolves.toBe(false);
    expect(backend.blobs.has(created.name)).toBe(true);
    expect([...backend.blobs.keys()].filter((n) => n.startsWith("konode_snap_kept_"))).toHaveLength(1);

    backend.refuse = false;
    await flushPendingPins(asBackend(backend), settings());
    expect(backend.blobs.has(created.name)).toBe(false);
    expect([...backend.blobs.keys()].filter((n) => n.startsWith("konode_snap_kept_"))).toHaveLength(1);
  });
});

// The reported bug: every restore point except the newest showed as a bare
// "Bookmark restore point", with no device and no count. The points were fine; the
// shared index that describes them was refused (Nutstore 403), and this device had
// thrown away the last copy it had read.
class RefuseAfterFirstReadFake extends FileFake {
  refuseIndex = false;
  refuseList = false;
  getFile(n: string): Promise<string | null> {
    if (n === INDEX_NAME && this.refuseIndex) return Promise.reject(new HttpError(403, "Forbidden (403)"));
    return super.getFile(n);
  }
  listFiles(p: string): Promise<string[]> {
    if (this.refuseList) return Promise.reject(new HttpError(403, "Forbidden (403)"));
    return super.listFiles(p);
  }
}

describe("snapshots — annotations survive a window in which the index is unreadable", () => {
  const me = () => settings({
    device_label: "Macbook",
    device_id: "451dbeb9-0000-4000-8000-000000000001",
  });

  it("keeps the device and the count from the last index it managed to read", async () => {
    await otherDevice();
    const backend = new RefuseAfterFirstReadFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    await chrome.bookmarks.create({ parentId: "1", title: "B", url: "https://b.example/" });
    const created = await createSnapshot(asBackend(backend), me());

    // Read the index once, successfully — this is the copy that must survive.
    const online = await listSnapshots(asBackend(backend), me());
    expect(online[0].count).toBe(2);
    expect(online[0].device_label).toBe("Macbook");

    // The quota window closes. The index is now refused; the local index is wiped so it
    // cannot be what answers (that is the "only the newest point is described" symptom).
    await chrome.storage.local.remove(KEYS.SNAPSHOT_LOCAL);
    backend.refuseIndex = true;

    const offline = await listSnapshots(asBackend(backend), me());
    const point = offline.find((m) => m.name === created.name)!;
    expect(point.device_label).toBe("Macbook");
    expect(point.count).toBe(2);
    expect(snapshotDisplayName(point)).toBe(`${t("opt_snap_unknown")} · Macbook · 451dbeb9`);
  });

  it("still lists the points this device knows when the whole folder is refused", async () => {
    await otherDevice();
    const backend = new RefuseAfterFirstReadFake();
    await chrome.bookmarks.create({ parentId: "1", title: "A", url: "https://a.example/" });
    const created = await createSnapshot(asBackend(backend), me());
    await listSnapshots(asBackend(backend), me());

    backend.refuseList = true;
    const offline = await listSnapshots(asBackend(backend), me());
    // An empty list would read as "you have no backups", which is the opposite of true.
    expect(offline.map((m) => m.name)).toContain(created.name);
  });
});
