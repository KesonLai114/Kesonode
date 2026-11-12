import type { ReadingListItem } from "@/lib/types";
import { browser } from "@/lib/utils/ext";
import { canonicalUrlKey, isSafeBookmarkUrl } from "@/lib/utils/url";
import { defaultOtherRootId, rootKindOf } from "@/lib/utils/bookmark-roots";

/**
 * The reading list is an ORDINARY bookmark folder called `Kesonode Reading List`.
 *
 * That is the whole design decision: a new data type would need a new file, a new
 * encryption path and a new merge, while a folder rides the bookmark sync that already
 * works on every browser, survives restore points, and is visible in the browser's own
 * bookmark manager. The folder name is not translated, precisely because it is an
 * identity that travels between devices.
 */
export const READING_LIST_FOLDER = "Kesonode Reading List";

export interface FlatBookmark {
  id: string;
  title: string;
  url: string;
  folder: string;
  dateAdded: number;
}

function api(): typeof browser.bookmarks | undefined {
  try {
    return browser.bookmarks;
  } catch {
    return undefined;
  }
}

export function isReadingListFolder(node: { title?: string; url?: string }): boolean {
  return !node.url && (node.title ?? "").trim() === READING_LIST_FOLDER;
}

/** The reading-list folder in a bookmark tree, or undefined. */
export function findReadingListFolder(
  nodes: chrome.bookmarks.BookmarkTreeNode[]
): chrome.bookmarks.BookmarkTreeNode | undefined {
  for (const node of nodes) {
    if (isReadingListFolder(node)) return node;
    const found = findReadingListFolder(node.children ?? []);
    if (found) return found;
  }
  return undefined;
}

function relativeFolder(rootTitle: string, path: string[]): string {
  return [rootTitle, ...path].filter(Boolean).join(" / ");
}

/** Every bookmark in the tree, with a folder path, for search and cleanup. */
export function flattenLocalBookmarks(
  roots: chrome.bookmarks.BookmarkTreeNode[]
): FlatBookmark[] {
  const out: FlatBookmark[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], rootTitle: string, path: string[]): void => {
    for (const node of nodes) {
      if (node.url) {
        out.push({
          id: node.id,
          title: node.title ?? "",
          url: node.url,
          folder: relativeFolder(rootTitle, path),
          dateAdded: node.dateAdded ?? 0,
        });
      } else {
        walk(node.children ?? [], rootTitle, [...path, node.title ?? ""]);
      }
    }
  };
  for (const root of roots) walk(root.children ?? [], root.title ?? "", []);
  return out;
}

export async function listAllBookmarks(): Promise<FlatBookmark[]> {
  const bookmarks = api();
  if (!bookmarks) return [];
  const tree = await bookmarks.getTree();
  return flattenLocalBookmarks(tree[0]?.children ?? []);
}

export async function listReadingList(): Promise<ReadingListItem[]> {
  const bookmarks = api();
  if (!bookmarks) return [];
  const tree = await bookmarks.getTree();
  const folder = findReadingListFolder(tree[0]?.children ?? []);
  if (!folder) return [];
  const out: ReadingListItem[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]): void => {
    for (const node of nodes) {
      if (node.url) {
        out.push({
          id: node.id,
          title: node.title ?? "",
          url: node.url,
          dateAdded: node.dateAdded ?? 0,
          folder: relativeFolder(READING_LIST_FOLDER, path),
        });
      } else {
        walk(node.children ?? [], [...path, node.title ?? ""]);
      }
    }
  };
  walk(folder.children ?? [], []);
  return out.sort((a, b) => b.dateAdded - a.dateAdded);
}

async function createReadingListFolder(roots: chrome.bookmarks.BookmarkTreeNode[]): Promise<string> {
  const bookmarks = api();
  if (!bookmarks) throw new Error("This browser has no bookmarks API.");
  // "Other bookmarks" is the quiet place for a list the user did not put on the toolbar,
  // and it exists on every engine. Fall back to the first writable-looking root.
  const otherId = defaultOtherRootId(roots);
  const parentId =
    otherId ??
    roots.find((r) => !r.unmodifiable && rootKindOf(r) !== "managed")?.id ??
    roots[0]?.id;
  if (!parentId) throw new Error("No bookmark folder to create the reading list in.");
  const folder = await bookmarks.create({ parentId, title: READING_LIST_FOLDER });
  return folder.id;
}

/**
 * Add a page to the list. Returns the existing row when the URL is already there, so a
 * second click is a no-op rather than a duplicate the cleanup screen then offers to remove.
 */
export async function addToReadingList(
  url: string,
  title?: string
): Promise<{ added: boolean; id?: string }> {
  if (!isSafeBookmarkUrl(url)) throw new Error("This page cannot be saved to the reading list.");
  const bookmarks = api();
  if (!bookmarks) throw new Error("This browser has no bookmarks API.");
  const existing = await listReadingList();
  const key = canonicalUrlKey(url);
  const match = existing.find((item) => canonicalUrlKey(item.url) === key);
  if (match) return { added: false, id: match.id };

  const tree = await bookmarks.getTree();
  const roots = tree[0]?.children ?? [];
  const folderId = findReadingListFolder(roots)?.id ?? (await createReadingListFolder(roots));
  const created = await bookmarks.create({
    parentId: folderId,
    title: title?.trim() || url,
    url,
  });
  return { added: true, id: created.id };
}

export async function removeFromReadingList(id: string): Promise<void> {
  const bookmarks = api();
  if (!bookmarks) throw new Error("This browser has no bookmarks API.");
  await bookmarks.remove(id);
}
