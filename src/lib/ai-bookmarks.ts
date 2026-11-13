/**
 * Local bookmark reading/writing for the optional AI helper.
 *
 * Reading goes through the SAME exclusion rules as the sync export (#54): a bookmark the
 * user keeps out of sync must not be sent to a model either. That is the reason this file
 * does not simply call listAllBookmarks() — that helper deliberately walks the whole tree.
 *
 * Writing is the only part of the AI feature that changes user data. It is never automatic:
 * the caller shows a plan, the user picks rows, a restore point is taken FIRST, and only
 * then are ordinary bookmarks.move/remove calls issued. Those are normal bookmark edits,
 * so the existing sync listeners pick them up like any other edit; nothing here writes to
 * the sync packet or adds a field to the frozen wire format.
 */

import { AiError, type AiOrganizationPlan } from "@/lib/ai-assistant";
import type { FlatBookmark } from "@/lib/handlers/reading-list-handler";
import {
  partitionExcluded,
  rootKey,
  type ExclusionNode,
} from "@/lib/utils/bookmark-exclusions";
import type { RootLike } from "@/lib/utils/bookmark-roots";
import { browser } from "@/lib/utils/ext";
import { request } from "@/lib/utils/messaging";
import { getBookmarkExclusions } from "@/lib/utils/storage";

interface AiNode extends ExclusionNode {
  dateAdded?: number;
  folderType?: string;
  syncing?: boolean;
}

export interface AiBookmarkSnapshot {
  bookmarks: FlatBookmark[];
  /** Folder titles, the vocabulary suggestOrganization() is allowed to answer with. */
  folders: string[];
  /** First folder id for each title; a plan can only move into existing folders. */
  folderIds: Map<string, string>;
}

function toAiNode(node: chrome.bookmarks.BookmarkTreeNode): AiNode {
  const typed = node as chrome.bookmarks.BookmarkTreeNode & {
    folderType?: string;
    syncing?: boolean;
  };
  return {
    id: node.id,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded,
    folderType: typed.folderType,
    syncing: typed.syncing,
    children: node.children?.map(toAiNode),
  };
}

/** Read the local tree once, minus everything the user excluded from sync. */
export async function collectAiBookmarks(): Promise<AiBookmarkSnapshot> {
  const [raw, rules] = await Promise.all([
    browser.bookmarks.getTree(),
    getBookmarkExclusions(),
  ]);
  const nodes = raw.map(toAiNode);
  const realRoots = (raw[0]?.children ?? []) as (chrome.bookmarks.BookmarkTreeNode & {
    folderType?: string;
  })[];
  // rootKey() must see the REAL root node (folderType decides the root kind on Chromium
  // 134+); the converted node has it too, but the source array keeps the browser's own
  // shape and is the same object the merge reads.
  const part = partitionExcluded(nodes, rules, {
    byId: true,
    rootKeyOf: (root, i) => rootKey((realRoots[i] ?? root) as RootLike),
  });
  const roots = part.tree[0]?.children ? part.tree[0].children : part.tree;

  const bookmarks: FlatBookmark[] = [];
  const folders: string[] = [];
  const folderIds = new Map<string, string>();
  const walk = (list: AiNode[], rootTitle: string, path: string[]): void => {
    for (const node of list) {
      if (node.url) {
        bookmarks.push({
          id: node.id,
          title: node.title ?? "",
          url: node.url,
          folder: [rootTitle, ...path].filter(Boolean).join(" / "),
          dateAdded: node.dateAdded ?? 0,
        });
      } else {
        const name = (node.title ?? "").trim();
        if (name) {
          if (!folderIds.has(name)) {
            folderIds.set(name, node.id);
            folders.push(name);
          }
        }
        walk(node.children ?? [], rootTitle, [...path, node.title ?? ""]);
      }
    }
  };
  for (const root of roots) walk(root.children ?? [], root.title ?? "", []);
  return { bookmarks, folders, folderIds };
}

export interface AiApplySelection {
  /** Ids of the move rows the user ticked. */
  moveIds: string[];
  /** Ids to remove — always the non-kept members of a duplicate group. */
  removeIds: string[];
}

export interface AiApplyResult {
  moved: number;
  removed: number;
  restorePointCreated: boolean;
}

/**
 * Apply a reviewed plan. A restore point is taken BEFORE the first edit; if it cannot be
 * created we refuse to touch the tree, because "undo" is the whole safety story here.
 */
export async function applyOrganizationPlan(
  plan: AiOrganizationPlan,
  selection: AiApplySelection,
  folderIds: Map<string, string>,
): Promise<AiApplyResult> {
  const moves = plan.moves.filter((m) => selection.moveIds.includes(m.id));
  const removals = [...new Set(selection.removeIds)];
  if (!moves.length && !removals.length) {
    return { moved: 0, removed: 0, restorePointCreated: false };
  }

  // The first await of the whole operation is deliberately here, before any bookmark API
  // call: a failed restore point must leave the tree exactly as it was.
  const restore = await request({ type: "CREATE_SNAPSHOT", payload: { pinned: true } });
  if (!restore.ok || restore.res.type !== "SNAPSHOTS") throw new AiError("snapshot");

  let moved = 0;
  for (const move of moves) {
    const parentId = folderIds.get(move.folder);
    if (!parentId || parentId === move.id) continue;
    try {
      await browser.bookmarks.move(move.id, { parentId });
      moved++;
    } catch {
      // A bookmark deleted since the plan was made is not a reason to abort the rest.
    }
  }
  let removed = 0;
  for (const id of removals) {
    try {
      await browser.bookmarks.remove(id);
      removed++;
    } catch {
      // Same: a stale plan row is skipped, and the restore point still covers the rest.
    }
  }
  return { moved, removed, restorePointCreated: true };
}
