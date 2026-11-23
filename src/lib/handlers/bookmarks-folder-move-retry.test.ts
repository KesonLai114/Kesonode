import { describe, it, expect, vi, afterEach } from "vitest";
import {
  importBookmarks, resetDeletionLog,
} from "@/lib/handlers/bookmarks-handler";
import { KEYS, getFolderMoves, setFolderMoves } from "@/lib/utils/storage";
import type { BookmarkPayload, SyncBookmark } from "@/lib/types";

/**
 * A peer's folder-reposition record must stay retryable until the merge actually
 * established it. The LWW log is strictly newer-than: a record sitting in the local
 * log reads as "already done" and is never applied again. So a record that could NOT
 * be applied (its target folder not present yet) must NOT be folded into that log —
 * otherwise a later sync with the same timestamp can never place the folder.
 *
 * This is the folder counterpart of the URL-move `placed` filter in importBookmarks;
 * folders were missing it. Reproduces the field report where a peer reordered folders
 * yet the receiver's visible order never changed.
 */

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

const FOLDER_PATH = ["bar", "Docs"];

async function seedFolder(title: string): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const f = await chrome.bookmarks.create({ parentId: "1", title });
  await chrome.bookmarks.create({ parentId: f.id, title, url: `https://${title.toLowerCase()}.example/` });
  return f;
}

async function folderOrder(): Promise<string[]> {
  return (await chrome.bookmarks.getChildren("1")).filter((c) => !c.url).map((c) => c.title);
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetDeletionLog();
  await chrome.storage.local.clear();
});

describe("folder reposition retry — a failed reposition must not be swallowed", () => {
  it("retries a peer's folder move whose target folder arrived on a later sync", async () => {
    // Local: A, B. No "Docs" folder yet.
    await seedFolder("A");
    await seedFolder("B");

    const at = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: FOLDER_PATH, index: 0, at, prev: "f:A" }],
    };

    // First sync: the peer says "put Docs after A", but Docs does not exist here.
    // The merge cannot resolve the path, so nothing is repositioned.
    await importBookmarks(p, "merge", "lww");
    expect(await folderOrder()).toEqual(["A", "B"]);

    // Docs arrives locally afterwards (added by the user or another sync path).
    await seedFolder("Docs");

    // Second sync: the SAME peer record is still the newest intent. It must now land.
    await importBookmarks(p, "merge", "lww");

    expect(await folderOrder()).toEqual(["A", "Docs", "B"]);
  });

  it("does not park a failed folder move in the local LWW log", async () => {
    await seedFolder("A");
    const at = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: ["bar", "Missing"], index: 0, at }],
    };

    await importBookmarks(p, "merge", "lww");

    const logged = await getFolderMoves();
    expect(logged.some((r) => r.at === at)).toBe(false);
  });

  it("keeps folding a folder move that the merge DID establish", async () => {
    await seedFolder("A");
    await seedFolder("Docs");
    const at = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: FOLDER_PATH, index: 0, at }],
    };

    await importBookmarks(p, "merge", "lww");

    expect(await folderOrder()).toEqual(["Docs", "A"]);
    const logged = await getFolderMoves();
    expect(logged.some((r) => r.at === at)).toBe(true);
  });

  it("baseline replace still folds the designated tree's folder moves as done", async () => {
    await seedFolder("A");
    // Baseline alignment imports with strategy "replace" — its records are the truth
    // and must land in the log so stale records are not replayed. Guard that path.
    const at = Date.now() + 60_000;
    await setFolderMoves([]);
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: FOLDER_PATH, index: 0, at }],
    };
    await importBookmarks(p, "replace", "lww");
    const logged = await getFolderMoves();
    expect(logged.some((r) => r.at === at)).toBe(true);
    expect(KEYS.BOOKMARK_FOLDER_MOVES).toBeTruthy();
  });
});
