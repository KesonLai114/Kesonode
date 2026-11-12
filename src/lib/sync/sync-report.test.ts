import { describe, it, expect } from "vitest";
import {
  SNAPSHOT_MIN_REMOVALS,
  buildSyncReport,
  buildTypeReport,
  flattenBookmarkTree,
  flattenHistory,
  isDangerousRemoval,
  previewBookmarkChanges,
} from "@/lib/sync/sync-report";
import type { BookmarkPayload, SyncBookmark, SyncHistoryItem, SyncSession } from "@/lib/types";

function link(
  title: string,
  url: string,
  dateAdded = 1000,
  id = `p-${url}`
): SyncBookmark {
  return { id, parentId: null, title, url, dateAdded };
}

function folder(title: string, children: SyncBookmark[]): SyncBookmark {
  return { id: `f-${title}`, parentId: null, title, dateAdded: 1, children };
}

function tree(roots: SyncBookmark[]): SyncBookmark[] {
  return [{ id: "0", parentId: null, title: "", dateAdded: 0, children: roots }];
}

function payload(barChildren: SyncBookmark[], extra: Partial<BookmarkPayload> = {}): BookmarkPayload {
  return { tree: tree(barChildren), tombstones: [], ...extra };
}

describe("flattenBookmarkTree", () => {
  it("keys by canonical URL and carries the folder path", () => {
    const flat = flattenBookmarkTree(
      tree([folder("Work", [link("Docs", "https://example.com/docs")])])
    );

    expect([...flat.keys()]).toEqual(["https://example.com/docs"]);
    expect(flat.get("https://example.com/docs")).toMatchObject({
      title: "Docs",
      folder: "Work",
    });
  });

  it("collapses a duplicate URL to its first placement", () => {
    const flat = flattenBookmarkTree(
      tree([
        link("First", "https://dup.com"),
        folder("Later", [link("Second", "https://dup.com/")]),
      ])
    );

    expect(flat.size).toBe(1);
    expect(flat.get("https://dup.com/")?.title).toBe("First");
  });
});

describe("flattenHistory", () => {
  it("one row per URL, newest occurrence wins nothing but order does not matter", () => {
    const items: SyncHistoryItem[] = [
      { url: "https://a.com", title: "A", lastVisitTime: 2, visitCount: 1 },
      { url: "https://a.com/", title: "A again", lastVisitTime: 5, visitCount: 2 },
      { url: "https://b.com", title: "B", lastVisitTime: 1, visitCount: 1 },
    ];

    const flat = flattenHistory(items);
    expect(flat.size).toBe(2);
    expect(flat.get("https://a.com/")?.title).toBe("A");
  });
});

describe("isDangerousRemoval", () => {
  it("needs both an absolute floor and a share of the tree", () => {
    expect(isDangerousRemoval(0, 1000)).toBe(false);
    expect(isDangerousRemoval(SNAPSHOT_MIN_REMOVALS - 1, 500)).toBe(false);
    // Five from a hundred is ordinary tidying; the ratio floor is ten.
    expect(isDangerousRemoval(5, 100)).toBe(false);
    expect(isDangerousRemoval(10, 100)).toBe(true);
  });

  it("does not snapshot five removals in a tiny tree", () => {
    expect(isDangerousRemoval(1, 5)).toBe(false);
    expect(isDangerousRemoval(5, 5)).toBe(true);
  });
});

describe("previewBookmarkChanges", () => {
  it("counts arrivals, departures and moves against the local tree", () => {
    const local = payload([
      link("Keep", "https://keep.com", 100),
      link("Move", "https://move.com", 100),
      link("Gone", "https://gone.com", 100),
    ]);
    const peer = payload(
      [folder("Other", [link("Move", "https://move.com", 100), link("New", "https://new.com", 100)])],
      { tombstones: [{ url: "https://gone.com", deletedAt: 200 }] }
    );

    const preview = previewBookmarkChanges(local, [peer]);
    expect(preview).toMatchObject({
      added: 1,
      removed: 1,
      moved: 1,
      localTotal: 3,
      peerTotal: 2,
    });
    expect(preview.removedSample).toEqual([{ title: "Gone", url: "https://gone.com/" }]);
  });

  it("ignores a tombstone older than the local copy", () => {
    const local = payload([link("Kept", "https://kept.com", 500)]);
    const peer = payload([], { tombstones: [{ url: "https://kept.com", deletedAt: 400 }] });

    expect(previewBookmarkChanges(local, [peer]).removed).toBe(0);
  });

  it("caps the sample it reads from other devices' files", () => {
    const local = payload(
      Array.from({ length: 20 }, (_, i) => link(`Gone ${i}`, `https://gone${i}.com`, 100))
    );
    const peer = payload(
      [],
      {
        tombstones: Array.from({ length: 20 }, (_, i) => ({
          url: `https://gone${i}.com`,
          deletedAt: 200,
        })),
      }
    );

    const preview = previewBookmarkChanges(local, [peer], { sampleSize: 3 });
    expect(preview.removed).toBe(20);
    expect(preview.removedSample).toHaveLength(3);
  });

  it("clips a long title and URL before they enter the receipt ring", () => {
    const longTitle = "T".repeat(500);
    const longUrl = `https://example.com/${"u".repeat(800)}`;
    const local = payload([link(longTitle, longUrl, 100)]);
    const peer = payload([], { tombstones: [{ url: longUrl, deletedAt: 200 }] });

    const [sample] = previewBookmarkChanges(local, [peer]).removedSample;
    expect(sample.title).toHaveLength(120);
    expect(sample.title.endsWith("…")).toBe(true);
    expect(sample.url).toHaveLength(300);
    expect(sample.url.endsWith("…")).toBe(true);
  });

  it("does not predict a removal when the strategy never deletes local bookmarks", () => {
    const local = payload([link("Kept", "https://kept.com", 100)]);
    const peer = payload([], { tombstones: [{ url: "https://kept.com", deletedAt: 200 }] });

    const preview = previewBookmarkChanges(local, [peer], { preferLocal: true });
    expect(preview.removed).toBe(0);
    expect(preview.removedSample).toEqual([]);
    expect(preview.localTotal).toBe(1);
  });

  it("accepts the legacy bare-array payload as a tree with no tombstones", () => {
    const preview = previewBookmarkChanges([link("A", "https://a.com")], [
      [link("A", "https://a.com"), link("B", "https://b.com")],
    ]);

    expect(preview.added).toBe(1);
    expect(preview.removed).toBe(0);
  });
});

describe("buildTypeReport", () => {
  const value = {
    dataType: "bookmarks" as const,
    peers: 2,
    uploaded: true,
    held: false,
  };

  it("diffs the before and after views", () => {
    const before = payload([
      link("Stay", "https://stay.com", 1),
      link("Rename", "https://rename.com", 1),
      link("Leave", "https://leave.com", 1),
    ]);
    const after = payload([
      folder("New folder", [link("Stay", "https://stay.com", 1), link("Arrive", "https://arrive.com", 1)]),
      link("Renamed", "https://rename.com", 1),
    ]);

    const report = buildTypeReport({ ...value, before, after });
    expect(report).toMatchObject({
      data_type: "bookmarks",
      peers: 2,
      local_before: 3,
      local_after: 3,
      added: 1,
      removed: 1,
      moved: 1,
      retitled: 1,
      uploaded: true,
      held: false,
    });
  });

  it("keeps the pre-apply preview on the receipt", () => {
    const before = payload([link("Gone", "https://gone.com")]);
    const preview = previewBookmarkChanges(before, [payload([], { tombstones: [{ url: "https://gone.com", deletedAt: 2000 }] })]);

    const report = buildTypeReport({ ...value, before, after: payload([]), preview });
    expect(report.preview).toEqual({
      added: 0,
      removed: 1,
      moved: 0,
      local_total: 1,
      peer_total: 0,
      sample: [{ title: "Gone", url: "https://gone.com/" }],
    });
  });

  it("reports payload sizes for types without item identity", () => {
    const session = {
      id: "s1",
      device_id: "dev",
      savedAt: "2026-01-01T00:00:00.000Z",
      tabs: [
        { url: "https://a.com", pinned: false },
        { url: "https://b.com", pinned: true },
      ],
    } as SyncSession;
    const report = buildTypeReport({
      dataType: "sessions",
      peers: 1,
      before: session,
      after: session,
      uploaded: false,
      held: false,
      beforeTotal: 2,
      afterTotal: 2,
    });

    expect(report.local_before).toBe(2);
    expect(report.local_after).toBe(2);
    expect(report.added).toBe(0);
  });
});

describe("buildSyncReport", () => {
  it("folds the rows into totals and flags a dangerous bookmark removal", () => {
    const bookmarkRow = buildTypeReport({
      dataType: "bookmarks",
      peers: 1,
      before: payload(Array.from({ length: 100 }, (_, i) => link(`B${i}`, `https://b${i}.com`))),
      after: payload(Array.from({ length: 80 }, (_, i) => link(`B${i}`, `https://b${i}.com`))),
      uploaded: true,
      held: false,
      snapshot: "restore-point-1",
    });
    const historyRow = buildTypeReport({
      dataType: "history",
      peers: 1,
      before: [] as SyncHistoryItem[],
      after: [{ url: "https://h.com", title: "H", lastVisitTime: 1 }],
      uploaded: false,
      held: false,
    });

    const report = buildSyncReport([bookmarkRow, historyRow], 1500, ["history: one peer failed"]);
    expect(report).toMatchObject({
      duration_ms: 1500,
      added: 1,
      removed: 20,
      total_before: 100,
      total_after: 81,
      dangerous: true,
      snapshot: "restore-point-1",
      errors: ["history: one peer failed"],
    });
    expect(report.types).toHaveLength(2);
  });

  it("keeps the snapshot optional when no type took one", () => {
    const report = buildSyncReport([], 0);
    expect(report.snapshot).toBeUndefined();
    expect(report.errors).toBeUndefined();
    expect(report.dangerous).toBe(false);
  });
});
