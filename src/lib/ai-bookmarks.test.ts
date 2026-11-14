import { describe, it, expect } from "vitest";
import { applyOrganizationPlan, collectAiBookmarks } from "@/lib/ai-bookmarks";
import type { AiOrganizationPlan } from "@/lib/ai-assistant";
import { browser } from "@/lib/utils/ext";
import { KEYS } from "@/lib/utils/storage";

/**
 * The two boundaries this file guards:
 *  - a bookmark the user keeps out of sync must not be sent to a model either;
 *  - the restore point must exist BEFORE the first write, because "undo" is the whole
 *    safety story of the organisation plan.
 */

const plan = (moves: AiOrganizationPlan["moves"], duplicates: AiOrganizationPlan["duplicates"]): AiOrganizationPlan => ({
  moves,
  duplicates,
});

/** Where a bookmark sits now, which is what a move or a removal actually changes. */
async function parentOf(id: string): Promise<string | undefined> {
  const [node] = await browser.bookmarks.get(id);
  return node?.parentId;
}

describe("collectAiBookmarks", () => {
  it("leaves out the bookmarks the user keeps out of sync", async () => {
    const folder = await browser.bookmarks.create({ parentId: "1", title: "Secret" });
    await browser.bookmarks.create({ parentId: folder.id, title: "Hidden", url: "https://hidden.example/x" });
    await browser.bookmarks.create({ parentId: "1", title: "Visible", url: "https://visible.example/y" });
    await browser.storage.local.set({
      [KEYS.SETTINGS]: { excluded_bookmarks: [{ path: ["bar", "Secret"] }] },
    });

    const snap = await collectAiBookmarks();
    expect(snap.bookmarks.map((b) => b.title)).toEqual(["Visible"]);
  });

  it("names the folders a plan may file into, with their ids", async () => {
    const folder = await browser.bookmarks.create({ parentId: "1", title: "Work" });
    await browser.bookmarks.create({ parentId: folder.id, title: "Deep", url: "https://deep.example/" });

    const snap = await collectAiBookmarks();
    expect(snap.folders).toContain("Work");
    expect(snap.folderIds.get("Work")).toBe(folder.id);
    const deep = snap.bookmarks.find((b) => b.title === "Deep");
    expect(deep?.folder).toContain("Work");
  });
});

describe("applyOrganizationPlan", () => {
  it("refuses to touch the tree when the restore point cannot be taken", async () => {
    const folder = await browser.bookmarks.create({ parentId: "1", title: "Work" });
    const loose = await browser.bookmarks.create({ parentId: "1", title: "Loose", url: "https://loose.example/" });

    await expect(
      applyOrganizationPlan(
        plan([{ id: loose.id, folder: "Work", reason: "" }], []),
        { moveIds: [loose.id], removeIds: [] },
        new Map([["Work", folder.id]]),
        { createRestorePoint: async () => false },
      ),
    ).rejects.toMatchObject({ code: "snapshot" });

    expect(await parentOf(loose.id)).toBe("1");
  });

  it("moves and removes exactly what was selected, restore point first", async () => {
    const folder = await browser.bookmarks.create({ parentId: "1", title: "Work" });
    const keep = await browser.bookmarks.create({ parentId: "1", title: "Keep", url: "https://keep.example/" });
    const dup = await browser.bookmarks.create({ parentId: "1", title: "Dup", url: "https://dup.example/" });
    const loose = await browser.bookmarks.create({ parentId: "1", title: "Loose", url: "https://loose.example/" });

    let restoreTaken = false;
    const result = await applyOrganizationPlan(
      plan(
        [{ id: loose.id, folder: "Work", reason: "belongs there" }],
        [{ ids: [keep.id, dup.id], reason: "same page" }],
      ),
      { moveIds: [loose.id], removeIds: [dup.id] },
      new Map([["Work", folder.id]]),
      { createRestorePoint: async () => { restoreTaken = true; return true; } },
    );

    expect(result).toEqual({ moved: 1, removed: 1, restorePointCreated: true });
    expect(restoreTaken).toBe(true);
    expect(await parentOf(loose.id)).toBe(folder.id);
    expect(await browser.bookmarks.get(dup.id)).toEqual([]);
    expect(await browser.bookmarks.get(keep.id)).not.toEqual([]);
  });

  it("skips a row whose folder is unknown, and still applies the rest", async () => {
    const loose = await browser.bookmarks.create({ parentId: "1", title: "Loose", url: "https://loose.example/" });
    const other = await browser.bookmarks.create({ parentId: "1", title: "Other", url: "https://other.example/" });
    const folder = await browser.bookmarks.create({ parentId: "1", title: "Work" });

    const result = await applyOrganizationPlan(
      plan(
        [
          { id: loose.id, folder: "Nope", reason: "" },
          { id: other.id, folder: "Work", reason: "" },
        ],
        [],
      ),
      { moveIds: [loose.id, other.id], removeIds: [] },
      new Map([["Work", folder.id]]),
      { createRestorePoint: async () => true },
    );

    expect(result.moved).toBe(1);
    expect(await parentOf(other.id)).toBe(folder.id);
    expect(await parentOf(loose.id)).toBe("1");
  });

  it("does nothing at all when nothing was selected", async () => {
    let restoreTaken = false;
    const result = await applyOrganizationPlan(
      plan([{ id: "x", folder: "Work", reason: "" }], []),
      { moveIds: [], removeIds: [] },
      new Map(),
      { createRestorePoint: async () => { restoreTaken = true; return true; } },
    );
    expect(result).toEqual({ moved: 0, removed: 0, restorePointCreated: false });
    expect(restoreTaken).toBe(false);
  });
});
