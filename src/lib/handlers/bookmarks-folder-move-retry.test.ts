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

  /**
   * A peer's records chain: each one anchors to the folder another one moves. The list is
   * in the order the peer's browser fired the drag events, which is NOT the order the
   * folders sit in (a multi-select drag reports its items in whatever order it likes). One
   * sweep then lands only the links whose anchor already sits where it says; the rest act
   * on a folder that has not moved yet, compute the position it holds right now, and do
   * nothing. Marking those "placed" froze the peer's reorder half-applied forever.
   */
  it("converges when the peer's records anchor to each other in reverse order", async () => {
    let i = 0;
    const seed = async (title: string): Promise<void> => {
      const f = await chrome.bookmarks.create({ parentId: "1", title });
      await chrome.bookmarks.create({ parentId: f.id, title: `bm${i++}`, url: `https://bm${i}.example/` });
    };
    for (const t of ["动漫", "other", "anime", "Real", "PT", "软件"]) await seed(t);

    // Local:   动漫, other, anime, Real, PT, 软件
    // Peer:    动漫, anime, Real, PT, 软件, other
    const at = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [
        { path: ["bar", "软件"], index: 5, at, prev: "f:PT" },
        { path: ["bar", "PT"], index: 4, at, prev: "f:Real" },
        { path: ["bar", "Real"], index: 3, at, prev: "f:anime" },
        { path: ["bar", "anime"], index: 2, at, prev: "f:动漫" },
      ],
    };

    await importBookmarks(p, "merge", "lww");

    expect(await folderOrder()).toEqual(["动漫", "anime", "Real", "PT", "软件", "other"]);
  });

  /**
   * The log records an INTENT, not a fact. A record folded in earlier (by an older build,
   * or by a sweep that could not carry it out) must not read as "already done" when the
   * tree plainly disagrees with it — otherwise the wrong order is permanent.
   */
  it("re-applies a record already in the log when the tree does not match it", async () => {
    let i = 0;
    const seed = async (title: string): Promise<void> => {
      const f = await chrome.bookmarks.create({ parentId: "1", title });
      await chrome.bookmarks.create({ parentId: f.id, title: `bm${i++}`, url: `https://bm${i}.example/` });
    };
    for (const t of ["A", "B", "Docs"]) await seed(t); // A, B, Docs

    const at = Date.now() + 60_000;
    // Already in the local log at the same instant — as a previous, failed sweep left it.
    await setFolderMoves([{ path: FOLDER_PATH, index: 1, at, prev: "f:A" }]);
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [{ path: FOLDER_PATH, index: 1, at, prev: "f:A" }],
    };

    await importBookmarks(p, "merge", "lww");

    expect(await folderOrder()).toEqual(["A", "Docs", "B"]);
  });

  /**
   * Two devices reordered the same parent in ways that cannot both hold (A after B here,
   * B after A there). No sweep satisfies both, so the sweeps would move a folder on every
   * sync forever. It must stop at one arrangement and fold the records, not churn.
   */
  it("settles instead of moving folders on every sync when two records contradict", async () => {
    let i = 0;
    const seed = async (title: string): Promise<void> => {
      const f = await chrome.bookmarks.create({ parentId: "1", title });
      await chrome.bookmarks.create({ parentId: f.id, title: `bm${i++}`, url: `https://bm${i}.example/` });
    };
    for (const t of ["A", "B"]) await seed(t);

    const at = Date.now() + 60_000;
    const p: BookmarkPayload = {
      ...payload([]),
      folderMoves: [
        { path: ["bar", "A"], index: 1, at, prev: "f:B" },
        { path: ["bar", "B"], index: 1, at, prev: "f:A" },
      ],
    };

    await importBookmarks(p, "merge", "lww");
    const first = await folderOrder();
    expect(first.sort()).toEqual(["A", "B"]);

    await importBookmarks(p, "merge", "lww");
    expect(await folderOrder()).toEqual(first);
  });

  /**
   * Field regression (v1.5.27): a log of contradictory folder moves (A after B, B after
   * A, plus several more) used to churn 1376 `bookmarks.move` calls in ONE merge —
   * 40 sweeps × 2 applyFolderRepositions calls × ~17 records — which crashed Quark.
   * A chain settles in at most one landed move per record, so a hard budget must cap
   * the whole merge no matter how the records fight.
   */
  it("never storms the browser: a contradictory log gets a hard move budget", async () => {
    let i = 0;
    const seed = async (title: string): Promise<void> => {
      const f = await chrome.bookmarks.create({ parentId: "1", title });
      await chrome.bookmarks.create({ parentId: f.id, title: `bm${i++}`, url: `https://bm${i}.example/` });
    };
    const titles = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const t of titles) await seed(t);

    const at = Date.now() + 60_000;
    // Pairs that contradict each other: A after B AND B after A, etc. No arrangement
    // satisfies all of them, so a naive sweep loop moves folders forever.
    const folderMoves = titles.flatMap((t, idx) => {
      const other = titles[(idx + 1) % titles.length];
      return [{ path: ["bar", t], index: idx, at, prev: `f:${other}` }];
    });
    const p: BookmarkPayload = { ...payload([]), folderMoves };

    const moveSpy = vi.spyOn(chrome.bookmarks, "move");
    await importBookmarks(p, "merge", "lww");

    // Budget is records + 2, capped at 24. A storm would be in the hundreds. Allow
    // one extra because moveToIndex can issue a second corrective move per landing.
    const hardCeiling = (folderMoves.length + 2) * 2;
    expect(moveSpy.mock.calls.length).toBeLessThanOrEqual(hardCeiling);

    // And a subsequent sync with the same log must not storm again — the settled
    // records are confirmed so the equal-timestamp self-heal stops replaying them.
    moveSpy.mockClear();
    await importBookmarks(p, "merge", "lww");
    expect(moveSpy.mock.calls.length).toBeLessThanOrEqual(hardCeiling);
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
