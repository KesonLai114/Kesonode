import { describe, it, expect, vi, afterEach } from "vitest";
import {
  importBookmarks, exportBookmarkPayload, resetDeletionLog, resetMoveStormForTest, noteRecordedMove,
  isMoveSuppressed,
} from "@/lib/handlers/bookmarks-handler";
import { setMoves, setFolderMoves, getMoves } from "@/lib/utils/storage";
import type { BookmarkPayload, FolderMoveRecord, SyncBookmark } from "@/lib/types";

/**
 * ORDER CONVERGENCE — does a receiver end up with the arrangement the source holds?
 *
 * Every earlier round of this work proved a narrower claim: "the records are published",
 * "the release is capped", "the worker restart loses nothing". None of those is the property
 * the user sees. What they see is two bookmark bars, and the only question is whether the
 * items sit in the same relative order on both. These tests assert exactly that, end to end:
 * a source tree, a receiver tree, and the order the receiver holds after the sync.
 *
 * The receiver is deliberately one that has ALREADY drifted. A device that is in the
 * source's order needs no sync; the field report was two browsers that had drifted apart
 * and then one of them had its bar rewritten by its own browser sync.
 */

function peerPayload(bar: SyncBookmark[], extra: Partial<BookmarkPayload> = {}): BookmarkPayload {
  return {
    tree: [{
      id: "0", parentId: null, title: "", dateAdded: 0,
      children: [
        { id: "1", parentId: "0", title: "Bookmarks bar", dateAdded: 0, children: bar },
        { id: "2", parentId: "0", title: "Other bookmarks", dateAdded: 0, children: [] },
        { id: "3", parentId: "0", title: "Other bookmarks 2", dateAdded: 0, children: [] },
      ],
    }],
    tombstones: [],
    ...extra,
  };
}
const folder = (title: string): SyncBookmark => ({ id: `rf-${title}`, parentId: "1", title, dateAdded: 1, children: [] });
const link = (title: string, url: string): SyncBookmark => ({ id: `ru-${title}`, parentId: "1", title, url, dateAdded: 1 });
const key = (n: { url?: string; title: string }): string => (n.url ? `u:${n.url}` : `f:${n.title}`);
const keys = (bar: SyncBookmark[]): string[] => bar.map(key);

/** The folder records a settled release derives from `bar` — see canonicalFolderRecord. */
function folderRecords(bar: SyncBookmark[], at: number, only?: (n: SyncBookmark) => boolean): FolderMoveRecord[] {
  const out: FolderMoveRecord[] = [];
  bar.forEach((n, i) => {
    if (n.url || (only && !only(n))) return;
    out.push({
      path: ["bar", n.title], index: i, at,
      ...(i > 0 ? { prev: key(bar[i - 1]) } : {}),
      ...(i < bar.length - 1 ? { next: key(bar[i + 1]) } : {}),
    });
  });
  return out;
}
const urlRecords = (bar: SyncBookmark[], at: number): Array<{ url: string; at: number }> =>
  bar.filter((n) => n.url).map((n) => ({ url: n.url as string, at }));
/** A COMPLETE record set: every sibling of `bar`, canonical anchors, as a release sends it. */
const everyRecord = (bar: SyncBookmark[], at: number): Partial<BookmarkPayload> =>
  ({ folderMoves: folderRecords(bar, at), moves: urlRecords(bar, at) });

/** Seed the local bar in the given arrangement. Folders get one bookmark each, as in a real bar. */
async function seedLocal(bar: SyncBookmark[]): Promise<void> {
  for (const n of bar) {
    if (n.url) await chrome.bookmarks.create({ parentId: "1", title: n.title, url: n.url });
    else {
      const f = await chrome.bookmarks.create({ parentId: "1", title: n.title });
      await chrome.bookmarks.create({ parentId: f.id, title: `${n.title}-bm`, url: `https://inside.${n.title}.example/` });
    }
  }
}
async function emptyBar(): Promise<void> {
  for (const c of await chrome.bookmarks.getChildren("1")) await chrome.bookmarks.removeTree(c.id);
}
/** The local bar as comparable keys, folders and bookmarks alike. */
async function localBar(): Promise<string[]> {
  return (await chrome.bookmarks.getChildren("1")).map((c) => (c.url ? `u:${c.url}` : `f:${c.title}`));
}
function perms<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}

async function quiet(): Promise<void> {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetDeletionLog();
  await resetMoveStormForTest();
  await chrome.storage.local.clear();
});

describe("order convergence — what the receiver actually ends up holding", () => {
  it("lands a whole sibling set on a receiver that had drifted, whatever either arrangement", async () => {
    await quiet();
    // Two folders of mixed siblings, source and receiver both drawn from every arrangement:
    // all 2,640 pairs below. (Before the settle pass 60 of 952 five-sibling pairs and 28% of
    // the six-sibling space landed a third arrangement; the full spaces take minutes.)
    const five = perms([folder("F1"), link("U1", "https://u1.example/"), link("U2", "https://u2.example/"), folder("F2"), link("U3", "https://u3.example/")]);
    const six = perms([folder("F1"), folder("F2"), link("U1", "https://u1.example/"), folder("F3"), link("U2", "https://u2.example/"), link("U3", "https://u3.example/")]);
    const failures: string[] = [];
    let cases = 0;
    for (const [all, receiverStride, sourceStride] of [[five, 3, 4], [six, 9, 40]] as const) {
      for (let r = 0; r < all.length; r += receiverStride) {
        const receiver = all[r];
        await emptyBar();
        await chrome.storage.local.clear();
        await seedLocal(receiver);
        for (let s = 0; s < all.length; s += sourceStride) {
          const source = all[s];
          if (source === receiver) continue;
          await chrome.storage.local.clear();
          await importBookmarks(peerPayload(source, everyRecord(source, Date.now() + 60_000)), "merge", "lww");
          const got = await localBar();
          cases++;
          if (got.join("|") !== keys(source).join("|")) {
            failures.push(`${keys(receiver).join(",")} -> ${keys(source).join(",")} got ${got.join(",")}`);
          }
          await emptyBar();
          await seedLocal(receiver);
        }
      }
    }
    expect(failures.slice(0, 8)).toEqual([]);
    expect(cases).toBeGreaterThan(2000);
  });

  it("moves nothing under keep-local, and nothing for a placement this device changed later", async () => {
    await quiet();
    const A = folder("A"), B = folder("B");
    await seedLocal([A, B]);
    const at = Date.now() + 60_000;
    await importBookmarks(peerPayload([B, A], everyRecord([B, A], at)), "merge", "lww", 60, 0, undefined, "keep-local");
    expect(await localBar()).toEqual(["f:A", "f:B"]);
    // The user dragged on THIS device after the peer's records: the newer intent is local.
    await setFolderMoves([
      { path: ["bar", "A"], index: 0, at: at + 5_000, next: "f:B" },
      { path: ["bar", "B"], index: 1, at: at + 5_000, prev: "f:A" },
    ]);
    await importBookmarks(peerPayload([B, A], everyRecord([B, A], at)), "merge", "lww");
    expect(await localBar()).toEqual(["f:A", "f:B"]);
  });

  it("a bookmark already in place is not counted as moved", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const items = ["a", "b", "c", "d"].map((n) => link(n.toUpperCase(), `https://${n}.example/`));
    await seedLocal(items); // A B C D
    const source = [items[1], items[0], items[3], items[2]]; // B A D C
    await importBookmarks(peerPayload(source, { moves: urlRecords(source, Date.now() + 60_000) }), "merge", "lww");
    expect(await localBar()).toEqual(keys(source));
    expect(info.mock.calls.map((c) => String(c[1])).join("\n")).toMatch(/moved 2 \//);
  });
});

describe("settled release — the whole sibling set travels, not only what fired", () => {
  const forSync = { forSync: true } as const;
  const t0 = 1_700_000_000_000;

  /** Run a burst on a source tree and return what it publishes once the tree is quiet. */
  async function release(
    bar: SyncBookmark[], fired: (n: SyncBookmark) => boolean,
  ): Promise<BookmarkPayload> {
    await quiet();
    let now = t0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await seedLocal(bar);
    await setMoves(urlRecords(bar, t0).filter((r) => fired(bar.find((n) => n.url === r.url)!)));
    await setFolderMoves(folderRecords(bar, t0, (n) => !n.url && fired(n)));
    for (let i = 0; i < 25; i++) await noteRecordedMove("url");
    const hot = await exportBookmarkPayload(forSync);
    expect(hot.moves).toEqual([]);
    expect(hot.folderMoves ?? []).toEqual([]);
    now += 5_000;
    return exportBookmarkPayload(forSync);
  }

  it("publishes EVERY sibling of a touched folder, in sibling order", async () => {
    const bar = [link("A", "https://a.example/"), link("B", "https://b.example/"), folder("Folder"), link("C", "https://c.example/")];
    // The burst fired for B and the folder only; A and C never changed index.
    const out = await release(bar, (n) => n.title !== "A" && n.title !== "C");
    // The order of the URL records in the packet is storage order and carries no meaning:
    // the receiver walks the peer's TREE for it.
    expect(out.moves?.map((m) => [m.url, m.at]).sort()).toEqual([
      ["https://a.example/", t0 + 5_000], ["https://b.example/", t0 + 5_000], ["https://c.example/", t0 + 5_000],
    ]);
    expect(out.folderMoves?.map((m) => [m.path, m.index, m.prev, m.next])).toEqual([
      [["bar", "Folder"], 2, "u:https://b.example/", "u:https://c.example/"],
    ]);
  });

  it("end to end: the receiver ends in the source's order although only one item fired", async () => {
    const [A, B, C, D] = [folder("A"), folder("B"), folder("C"), folder("D")];
    const source = [D, A, B, C]; // the source's own sync moved D to the front
    const out = await release(source, (n) => n === D);

    // A receiver that had drifted to B, A, C, D.
    await emptyBar();
    await chrome.storage.local.clear();
    await resetMoveStormForTest();
    await seedLocal([B, A, C, D]);
    await importBookmarks(out, "merge", "lww");
    expect(await localBar()).toEqual(keys(source));
  });

  it("end to end: a mixed bar of a dozen siblings lands whole from a reversed receiver", async () => {
    const source = [
      folder("News"), link("u1", "https://u1.example/"), folder("Tools"), link("u2", "https://u2.example/"),
      link("u3", "https://u3.example/"), folder("Docs"), link("u4", "https://u4.example/"), folder("Mail"),
      link("u5", "https://u5.example/"), link("u6", "https://u6.example/"), folder("Read"), link("u7", "https://u7.example/"),
    ];
    const out = await release(source, (n) => ["News", "u2", "Docs", "Mail", "Read"].includes(n.title));

    await emptyBar();
    await chrome.storage.local.clear();
    await resetMoveStormForTest();
    await seedLocal([...source].reverse());
    await importBookmarks(out, "merge", "lww");
    expect(await localBar()).toEqual(keys(source));
  });

  it("drains a folder too large for one release as a PREFIX of its siblings", async () => {
    const bar = Array.from({ length: 70 }, (_, i) => link(`s${i}`, `https://s${i}.example/`));
    const first = await release(bar, () => true);
    expect(first.moves).toHaveLength(64);
    // Released oldest-first, so nothing was sent behind a neighbour that has not been sent.
    expect(first.moves?.every((m) => Number(m.url.match(/s(\d+)/)![1]) < 64)).toBe(true);

    vi.mocked(Date.now).mockReturnValue(t0 + 65_000);
    const second = await exportBookmarkPayload(forSync);
    expect(second.moves).toHaveLength(70);
    expect(second.moves?.filter((m) => m.at === t0 + 65_000)).toHaveLength(6);

    vi.mocked(Date.now).mockReturnValue(t0 + 125_000);
    expect((await exportBookmarkPayload(forSync)).moves?.every((m) => m.at !== t0 + 125_000)).toBe(true);
  });

  it("drops a held record whose bookmark is gone, instead of withholding it for a day", async () => {
    await quiet();
    let now = t0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await seedLocal([link("A", "https://a.example/")]);
    // The burst also swept a bookmark the browser's sync has since removed.
    await setMoves([{ url: "https://a.example/", at: now }, { url: "https://gone.example/", at: now }]);
    for (let i = 0; i < 25; i++) await noteRecordedMove("url");
    now += 5_000;
    const out = await exportBookmarkPayload(forSync);
    expect(out.moves?.map((m) => m.url)).toEqual(["https://a.example/"]);
    expect((await getMoves()).map((m) => m.url)).toEqual(["https://a.example/"]);
    // Nothing is held any more, so no later sync logs a withheld record.
    expect(isMoveSuppressed(t0)).toBe(false);
  });
});
