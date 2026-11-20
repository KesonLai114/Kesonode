import { describe, it, expect, vi, afterEach } from "vitest";
import {
  importBookmarks, exportBookmarkPayload, resetDeletionLog,
  noteRecordedMove, isMoveSuppressed, resetMoveStormForTest,
} from "@/lib/handlers/bookmarks-handler";
import { KEYS, setMoves, setFolderMoves } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

// Two mechanisms for coexisting with a browser's built-in bookmark sync:
//   A) order mode "browser": Kesonode publishes no placement records and applies none —
//      the browser owns ordering, contents still flow through Kesonode.
//   B) move-storm suppression: a programmatic burst (957 moves in 0.5s) is withheld from
//      the outgoing packet so it can't propagate as this device's own intent.

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

afterEach(async () => {
  vi.restoreAllMocks();
  resetMoveStormForTest();
  resetDeletionLog();
  await chrome.storage.local.clear();
});

describe("order mode 'browser' — publishing side", () => {
  it("sends no URL or folder moves while contents still flow", async () => {
    await chrome.storage.local.set({ [KEYS.SETTINGS]: { bookmark_order_mode: "browser" } });
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at: Date.now() }]);
    await setFolderMoves([{ path: ["bookmarks_bar", "Folder"], index: 0, at: Date.now() }]);

    const out = await exportBookmarkPayload();
    expect(out.moves).toEqual([]);
    expect(out.folderMoves ?? []).toEqual([]);
    // The bookmark's content is still published.
    const urls: string[] = [];
    const walk = (n: SyncBookmark) => { if (n.url) urls.push(n.url); n.children?.forEach(walk); };
    out.tree.forEach(walk);
    expect(urls).toContain("https://x.com");
  });

  it("still publishes moves under the default lww mode", async () => {
    const at = Date.now();
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await setMoves([{ url: "https://x.com", at }]);
    const out = await exportBookmarkPayload();
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
  it("does not suppress an ordinary handful of moves", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (let i = 0; i < 24; i++) noteRecordedMove("url");
    const now = Date.now();
    expect(isMoveSuppressed(now)).toBe(false);
  });

  it("marks a storm span and extends it to placements arriving after detection", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const start = Date.now();
    // 24 moves: below threshold, not yet suppressed.
    for (let i = 0; i < 24; i++) noteRecordedMove("url");
    expect(isMoveSuppressed(start)).toBe(false);
    // The 25th crosses the threshold; the window's first record becomes suspect.
    noteRecordedMove("url");
    expect(isMoveSuppressed(start)).toBe(true);
    // Hundreds more land in the same burst — every one must stay inside the span.
    const late = Date.now();
    for (let i = 0; i < 900; i++) noteRecordedMove("url");
    expect(isMoveSuppressed(late)).toBe(true);
    expect(isMoveSuppressed(Date.now())).toBe(true);
  });

  it("withholds storm-stamped records from the published packet", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    await chrome.bookmarks.create({ parentId: "1", title: "X", url: "https://x.com" });
    await chrome.bookmarks.create({ parentId: "1", title: "Y", url: "https://y.com" });
    const stormAt = Date.now();
    for (let i = 0; i < 60; i++) noteRecordedMove("url");
    await setMoves([
      { url: "https://x.com", at: stormAt },
      { url: "https://y.com", at: stormAt },
    ]);
    const out = await exportBookmarkPayload();
    expect(out.moves).toEqual([]);
  });
});
