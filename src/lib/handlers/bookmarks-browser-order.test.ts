import { describe, it, expect, vi, afterEach } from "vitest";
import {
  importBookmarks, exportBookmarkPayload, resetDeletionLog,
  noteRecordedMove, isMoveSuppressed, resetMoveStormForTest, forgetMoveStormCacheForTest,
} from "@/lib/handlers/bookmarks-handler";
import { KEYS, setMoves, setFolderMoves } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// Two mechanisms for coexisting with a browser's built-in bookmark sync:
//   A) order mode "browser": Kesonode publishes no placement records and applies none —
//      the browser owns ordering, contents still flow through Kesonode.
//   B) move-storm suppression: a programmatic burst is held while hot, then published
//      once as the settled order. The state survives an MV3 worker restart.

function payload(barChildren: SyncBookmark[], tombstones: BookmarkPayload["tombstones"] = []): BookmarkPayload {
  return {
    tree: [{
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: barChildren },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
        { id: "3", parentId: "0", title: "Mobile bookmarks", dateAdded: 0, children: [] },
      ],
    }],
    tombstones,
  };
}
const link = (title: string, url: string): SyncBookmark => ({ id: `r-${url}`, parentId: "1", title, url, dateAdded: 1 });

/** A payload that will actually be uploaded. A snapshot export must not release order. */
const forSync = { forSync: true } as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await resetMoveStormForTest();
  resetDeletionLog();
  await chrome.storage.local.clear();
});

describe("order mode 'browser' — publishing side", () => {
  it("sends no URL or folder moves while contents still flow", async () => {
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { bookmark_order_mode: "browser" } });
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: Date.now() }]);
    await setFolderMoves([{ path: ["bar", "Folder"], index: 0, at: Date.now() }]);

    const out = await exportBookmarkPayload(forSync);
    expect(out.moves).toEqual([]);
    expect(out.folderMoves ?? []).toEqual([]);
    const urls: string[] = [];
    const walk = (n: SyncBookmark) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
    out.tree.forEach(walk);
    expect(urls).toContain("https://x.com");
  });

  it("still publishes moves under the default lww mode", async () => {
    const at = Date.now();
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at }]);
    const out = await exportBookmarkPayload(forSync);
    expect((out.moves ?? []).map((m) => m.url)).toEqual(["https://x.com"]);
  });
});

describe("order mode 'browser' — receiving side", () => {
  it("refuses a peer's reorder but still merges adds and deletes", async () => {
    const wdt = await chrome.bookmarks.create({ parentId: "1", title: "WDT" });
    await chrome.bookmarks.create({ parentId: wdt.id, title: "X", url: "https://x.com" });
    await chrome.bookmarks.create({ parentId: "1", title: "Z", url: "https://z.com" });

    const future = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([link("X", "https://x.com"), link("Y", "https://y.com")], [
        { url: "https://z.com", deletedAt: future },
      ]),
      moves: [{ url: "https://x.com", at: future }],
    };
    await importBookmarks(p, "merge", "lww", 100, 0, undefined, "browser");

    expect((await chrome.bookmarks.getChildren(wdt.id)).map((c) => c.url)).toEqual(["https://x.com"]);
    const urls: string[] = [];
    const walk = (n: chrome.bookmarks.BookmarkTreeNode) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
    (await chrome.bookmarks.getTree()).forEach(walk);
    expect(urls).toEqual(["https://x.com", "https://y.com"]);
  });
});

describe("move-storm publish suppression", () => {
  it("does not suppress an ordinary handful of moves", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 24; i++) await noteRecordedMove("url");
    expect(isMoveSuppressed(Date.now())).toBe(false);
  });

  it("marks a storm span and extends it to placements arriving after detection", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const start = Date.now();
    for (let i = 0; i < 24; i++) await noteRecordedMove("url");
    expect(isMoveSuppressed(start)).toBe(false);
    await noteRecordedMove("url");
    expect(isMoveSuppressed(start)).toBe(true);
    const late = Date.now();
    for (let i = 0; i < 900; i++) await noteRecordedMove("url");
    expect(isMoveSuppressed(late)).toBe(true);
    expect(isMoveSuppressed(Date.now())).toBe(true);
  });

  it("withholds storm-stamped records from the published packet", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await chrome.bookmarks.create({ parentId: "1", title: "Y", url: "https://y.com" });
    const stormAt = Date.now();
    for (let i = 0; i < 60; i++) await noteRecordedMove("url");
    await setMoves([
      { url: "https://x.com", at: stormAt },
      { url: "https://y.com", at: stormAt },
    ]);
    const out = await exportBookmarkPayload(forSync);
    expect(out.moves).toEqual([]);
  });

  it("publishes the settled order once after a hot burst goes quiet", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: now }]);
    await setFolderMoves([{ path: ["bar", "Folder"], index: 0, at: now }]);

    for (let i = 0; i < 60; i++) await noteRecordedMove("folder");
    const hot = await exportBookmarkPayload(forSync);
    expect(hot.moves).toEqual([]);
    expect(hot.folderMoves ?? []).toEqual([]);

    now += 5_000;
    const settled = await exportBookmarkPayload(forSync);
    expect(settled.moves?.map((m) => m.url)).toEqual(["https://x.com"]);
    expect(settled.folderMoves?.map((m) => m.path)).toEqual([["bar", "Folder"]]);
    expect(settled.moves?.[0].at).toBe(now);

    const later = await exportBookmarkPayload(forSync);
    expect(later.moves?.[0].at).toBe(now);
    expect(later.folderMoves?.[0].at).toBe(now);
  });

  it("recomputes folder anchors from the final tree instead of replaying stale event anchors", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await chrome.bookmarks.create({ parentId: "1", title: "Folder" });
    await chrome.bookmarks.create({ parentId: "1", title: "Y", url: "https://y.com" });
    await setMoves([{ url: "https://x.com", at: now }]);
    // An intermediate onMoved callback thought the folder was first and X was absent.
    await setFolderMoves([{
      path: ["bar", "Folder"], index: 0, at: now,
      prev: "u:https://gone.example/", next: "u:https://never.example/",
    }]);
    for (let i = 0; i < 60; i++) await noteRecordedMove("folder");

    now += 5_000;
    const out = await exportBookmarkPayload(forSync);
    expect(out.folderMoves).toHaveLength(1);
    expect(out.folderMoves?.[0]).toMatchObject({
      index: 1,
      prev: "u:https://x.com",
      next: "u:https://y.com",
      at: now,
    });
  });

  it("keeps a worker restart from leaking a hot burst", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: now }]);
    for (let i = 0; i < 60; i++) await noteRecordedMove("folder");

    // MV3 recycles the worker: only the in-memory cache is gone.
    forgetMoveStormCacheForTest();
    const hot = await exportBookmarkPayload(forSync);
    expect(hot.moves).toEqual([]);

    now += 5_000;
    const settled = await exportBookmarkPayload(forSync);
    expect(settled.moves?.map((m) => m.url)).toEqual(["https://x.com"]);
  });

  it("does not let a later storm re-suppress the first storm's released records", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: now }]);

    const first = now;
    for (let i = 0; i < 25; i++) await noteRecordedMove("folder");
    now += 5_000;
    await exportBookmarkPayload(forSync); // releases the first span

    // A single manual drag between the two storms must stay publishable.
    const manual = now;
    await noteRecordedMove("url");
    expect(isMoveSuppressed(manual)).toBe(false);

    now += 60_000;
    for (let i = 0; i < 25; i++) await noteRecordedMove("folder");
    expect(isMoveSuppressed(first)).toBe(false);
    expect(isMoveSuppressed(manual)).toBe(false);
  });

  it("a snapshot export never re-stamps placement history", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: now }]);
    for (let i = 0; i < 60; i++) await noteRecordedMove("folder");

    now += 5_000;
    const snapshot = await exportBookmarkPayload(); // restore point / search, NOT a sync
    expect(snapshot.moves).toEqual([]);
    expect(isMoveSuppressed(now - 5_000)).toBe(true);
  });

  it("browser mode drops the held windows so a later lww switch cannot replay them", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { bookmark_order_mode: "browser" } });
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: now }]);
    for (let i = 0; i < 60; i++) await noteRecordedMove("folder");

    now += 5_000;
    const out = await exportBookmarkPayload(forSync);
    expect(out.moves).toEqual([]);
    expect(isMoveSuppressed(now - 5_000)).toBe(false);
  });
});
