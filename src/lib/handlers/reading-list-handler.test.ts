import { describe, it, expect } from "vitest";
import {
  READING_LIST_FOLDER,
  addToReadingList,
  findReadingListFolder,
  flattenLocalBookmarks,
  listAllBookmarks,
  listReadingList,
  removeFromReadingList,
} from "@/lib/handlers/reading-list-handler";

// The reading list is an ordinary bookmark folder, so these drive the same in-memory
// chrome.bookmarks fake as the merge tests: what actually matters is that a saved page is
// a real bookmark, in one place, and that a second save is not a second copy.

describe("addToReadingList", () => {
  it("creates the folder under Other bookmarks and saves the page there", async () => {
    await addToReadingList("https://example.com/article", "An article");

    const tree = await chrome.bookmarks.getTree();
    const folder = findReadingListFolder(tree[0].children ?? []);
    expect(folder?.title).toBe(READING_LIST_FOLDER);
    expect(folder?.parentId).toBe("2"); // Other bookmarks, not the toolbar

    const items = await listReadingList();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ url: "https://example.com/article", title: "An article" });
    expect(items[0].folder).toBe(READING_LIST_FOLDER);
  });

  it("is a no-op for a page that is already there, trailing slash included", async () => {
    await addToReadingList("https://example.com/");
    const again = await addToReadingList("https://example.com", "Added twice");

    expect(again.added).toBe(false);
    expect(await listReadingList()).toHaveLength(1);

    const underOther = await chrome.bookmarks.getChildren("2");
    expect(underOther.filter((n) => n.title === READING_LIST_FOLDER)).toHaveLength(1);
  });

  it("defaults the title to the URL when the page has none", async () => {
    await addToReadingList("https://example.com/untitled");
    expect((await listReadingList())[0].title).toBe("https://example.com/untitled");
  });

  it("refuses a URL the browser would execute", async () => {
    await expect(addToReadingList("javascript:alert(1)")).rejects.toThrow();
    expect(await listReadingList()).toEqual([]);
  });

  it("falls back to the first writable root when Other bookmarks does not exist", async () => {
    (chrome.bookmarks as unknown as { __setRoots(roots: Array<{ id: string; title: string }>): void })
      .__setRoots([{ id: "10", title: "Bookmarks bar" }]);
    await addToReadingList("https://example.com/only-root");

    const folder = findReadingListFolder((await chrome.bookmarks.getTree())[0].children ?? []);
    expect(folder?.parentId).toBe("10");
  });
});

describe("listReadingList", () => {
  it("finds a folder nested under another folder", async () => {
    const parent = await chrome.bookmarks.create({ parentId: "2", title: "Imported" });
    const list = await chrome.bookmarks.create({ parentId: parent.id, title: READING_LIST_FOLDER });
    await chrome.bookmarks.create({ parentId: list.id, title: "Nested", url: "https://nested.example/" });

    expect(findReadingListFolder((await chrome.bookmarks.getTree())[0].children ?? [])?.id).toBe(list.id);
    expect((await listReadingList()).map((i) => i.url)).toEqual(["https://nested.example/"]);
  });

  it("returns nothing when there is no folder yet", async () => {
    expect(await listReadingList()).toEqual([]);
  });

  it("walks subfolders inside the list and keeps their path", async () => {
    const list = await chrome.bookmarks.create({ parentId: "2", title: READING_LIST_FOLDER });
    const sub = await chrome.bookmarks.create({ parentId: list.id, title: "Later" });
    await chrome.bookmarks.create({ parentId: sub.id, title: "Deep", url: "https://deep.example/" });

    expect((await listReadingList())[0].folder).toBe(`${READING_LIST_FOLDER} / Later`);
  });
});

describe("removeFromReadingList", () => {
  it("removes that bookmark only", async () => {
    await addToReadingList("https://keep.example/");
    await addToReadingList("https://remove.example/");
    const target = (await listReadingList()).find((i) => i.url === "https://remove.example/")!;

    await removeFromReadingList(target.id);
    expect((await listReadingList()).map((i) => i.url)).toEqual(["https://keep.example/"]);
  });
});

describe("flattenLocalBookmarks", () => {
  it("includes every bookmark on the device with its root and folder path", async () => {
    await chrome.bookmarks.create({ parentId: "1", title: "Work", url: "https://work.example/" });
    const folder = await chrome.bookmarks.create({ parentId: "2", title: "Reading" });
    await chrome.bookmarks.create({ parentId: folder.id, title: "Book", url: "https://book.example/" });

    const flat = await listAllBookmarks();
    expect(flat.find((b) => b.url === "https://work.example/")?.folder).toBe("Bookmarks bar");
    expect(flat.find((b) => b.url === "https://book.example/")?.folder).toBe("Other bookmarks / Reading");
  });

  it("returns [] from an empty tree rather than throwing", async () => {
    expect(flattenLocalBookmarks([])).toEqual([]);
  });
});
