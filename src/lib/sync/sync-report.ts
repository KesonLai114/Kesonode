import type {
  BookmarkPayload,
  DataType,
  SyncBookmark,
  SyncHistoryItem,
  SyncReport,
  SyncTypeReport,
  Tombstone,
} from "@/lib/types";
import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * A receipt for one data type, plus the merge preview that decided whether it needed one.
 *
 * Two questions the old sync could not answer: "did this cycle change anything here?" and
 * "is this about to remove more than I expect?". Both are answered before and after the
 * merge from the same flattened view, so the receipt cannot disagree with the preview the
 * user was shown.
 */

/** A bookmark/history entry as the comparison sees it. */
export interface FlatItem {
  key: string;
  title: string;
  folder: string;
  dateAdded: number;
}

/** How many items a merge would add, remove or move before it is applied. */
export interface ChangePreview {
  added: number;
  removed: number;
  moved: number;
  localTotal: number;
  peerTotal: number;
  /** A sample of the bookmarks that would be removed, for the confirmation line. */
  removedSample: Array<{ title: string; url: string }>;
}

/** A removal of at least this many bookmarks is worth a restore point and a sentence. */
export const SNAPSHOT_MIN_REMOVALS = 5;

/** ...or this share of the local tree, whichever is smaller. */
export const SNAPSHOT_REMOVAL_RATIO = 0.1;

/**
 * Whether a merge's removals are large enough to snapshot first.
 *
 * Both halves must hold: a handful of ordinary deletions (say, four in a 30-bookmark
 * tree) is not an incident, and a fifth of a five-bookmark tree is not one either. The
 * larger of an absolute floor and a share of the tree keeps the ring for genuine bulk
 * changes instead of spending it on everyday tidying.
 */
export function isDangerousRemoval(removed: number, localTotal: number): boolean {
  if (removed <= 0) return false;
  const floor = Math.max(
    SNAPSHOT_MIN_REMOVALS,
    Math.ceil(localTotal * SNAPSHOT_REMOVAL_RATIO)
  );
  return removed >= floor;
}

// ─── Flattening ────────────────────────────────────────────────────────────

function bookmarkRoots(tree: SyncBookmark[]): SyncBookmark[] {
  return tree[0]?.children ?? tree;
}

/**
 * One entry per URL, with the folder path that identifies its placement.
 *
 * Duplicates inside one tree collapse to the first occurrence, which is also how the
 * merge treats them (it keys presence by URL). Root titles are kept as-is: this is a
 * local comparison, not the cross-device identity `bookmarkContent` builds.
 */
export function flattenBookmarkTree(tree: SyncBookmark[]): Map<string, FlatItem> {
  const out = new Map<string, FlatItem>();
  const walk = (nodes: SyncBookmark[] | undefined, path: string[]): void => {
    for (const node of nodes ?? []) {
      if (node.url) {
        const key = canonicalUrlKey(node.url);
        if (!out.has(key)) {
          out.set(key, {
            key,
            title: node.title ?? "",
            folder: path.join(" / "),
            dateAdded: node.dateAdded ?? 0,
          });
        }
        continue;
      }
      walk(node.children, [...path, node.title ?? ""]);
    }
  };
  walk(bookmarkRoots(tree), []);
  return out;
}

export function flattenHistory(items: SyncHistoryItem[]): Map<string, FlatItem> {
  const out = new Map<string, FlatItem>();
  for (const item of items) {
    if (!item.url) continue;
    const key = canonicalUrlKey(item.url);
    if (!out.has(key)) {
      out.set(key, {
        key,
        title: item.title ?? "",
        folder: "",
        dateAdded: item.lastVisitTime ?? 0,
      });
    }
  }
  return out;
}

/** The comparison view for a type, or null when the type has no item identity. */
export function flattenPayload(dataType: DataType, payload: unknown): Map<string, FlatItem> | null {
  if (dataType === "bookmarks") {
    const tree = Array.isArray(payload)
      ? (payload as SyncBookmark[])
      : ((payload as BookmarkPayload | null)?.tree ?? []);
    return flattenBookmarkTree(tree);
  }
  if (dataType === "history") {
    return Array.isArray(payload) ? flattenHistory(payload as SyncHistoryItem[]) : new Map();
  }
  return null;
}

/** The deletion log of a bookmark payload, tolerating the legacy bare-array form. */
export function payloadTombstones(payload: unknown): Tombstone[] {
  if (Array.isArray(payload)) return [];
  return (payload as BookmarkPayload | null)?.tombstones ?? [];
}

// ─── Preview ───────────────────────────────────────────────────────────────

// The sample is shown in a receipt that lives in storage for 30 cycles; a bookmark title
// or URL can be arbitrarily long (a data: URL is a real case), so both are clipped.
const SAMPLE_TITLE_MAX = 120;
const SAMPLE_URL_MAX = 300;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * What folding these peer payloads in would do here, before anything is written.
 *
 * Bookmark merges are additive plus tombstones, so "removed" means "a peer's deletion
 * covers a bookmark this device holds, and nothing newer kept it here". The sample is
 * capped AND clipped: it is read from a packet, and a bookmark can be a megabyte-long
 * data: URL that has no business being copied into the receipt ring.
 *
 * `preferLocal` is the one strategy that provably never deletes a local bookmark, so it
 * zeroes `removed` — without it the preview would warn about a deletion the merge will
 * refuse, and the engine would save a restore point for nothing.
 */
export function previewBookmarkChanges(
  localPayload: unknown,
  peerPayloads: unknown[],
  opts: { sampleSize?: number; preferLocal?: boolean } = {}
): ChangePreview {
  const local = flattenBookmarkTree(
    Array.isArray(localPayload)
      ? (localPayload as SyncBookmark[])
      : ((localPayload as BookmarkPayload | null)?.tree ?? [])
  );
  const peerUrls = new Map<string, FlatItem>();
  const tombstones = new Map<string, number>();
  for (const payload of peerPayloads) {
    for (const [key, item] of flattenBookmarkTree(
      Array.isArray(payload)
        ? (payload as SyncBookmark[])
        : ((payload as BookmarkPayload | null)?.tree ?? [])
    )) {
      if (!peerUrls.has(key)) peerUrls.set(key, item);
    }
    for (const t of payloadTombstones(payload)) {
      const key = canonicalUrlKey(t.url);
      tombstones.set(key, Math.max(tombstones.get(key) ?? 0, t.deletedAt));
    }
  }

  let added = 0;
  for (const key of peerUrls.keys()) if (!local.has(key)) added++;

  const removedSample: Array<{ title: string; url: string }> = [];
  let removed = 0;
  if (!opts.preferLocal) {
    for (const [key, item] of local) {
      const deletedAt = tombstones.get(key);
      if (deletedAt === undefined || deletedAt < item.dateAdded) continue;
      removed++;
      if (removedSample.length < (opts.sampleSize ?? 5)) {
        removedSample.push({
          title: clip(item.title, SAMPLE_TITLE_MAX),
          url: clip(key, SAMPLE_URL_MAX),
        });
      }
    }
  }

  let moved = 0;
  for (const [key, peer] of peerUrls) {
    const here = local.get(key);
    if (here && here.folder !== peer.folder) moved++;
  }

  return {
    added,
    removed,
    moved,
    localTotal: local.size,
    peerTotal: peerUrls.size,
    removedSample,
  };
}

// ─── Receipts ──────────────────────────────────────────────────────────────

export interface TypeReportInput {
  dataType: DataType;
  peers: number;
  before: unknown;
  after: unknown;
  uploaded: boolean;
  held: boolean;
  snapshot?: string;
  /** Item totals for types without item identity (sessions/extensions). */
  beforeTotal?: number;
  afterTotal?: number;
  /** The pre-apply preview, when one was measured (bookmarks). */
  preview?: ChangePreview;
}

/** Compare the pre-merge and post-merge views into the row Activity shows. */
export function buildTypeReport(input: TypeReportInput): SyncTypeReport {
  const preview = input.preview
    ? {
        added: input.preview.added,
        removed: input.preview.removed,
        moved: input.preview.moved,
        local_total: input.preview.localTotal,
        peer_total: input.preview.peerTotal,
        sample: input.preview.removedSample,
      }
    : undefined;
  const before = flattenPayload(input.dataType, input.before);
  const after = flattenPayload(input.dataType, input.after);
  if (!before || !after) {
    return {
      data_type: input.dataType,
      peers: input.peers,
      local_before: input.beforeTotal ?? 0,
      local_after: input.afterTotal ?? 0,
      added: 0,
      removed: 0,
      moved: 0,
      retitled: 0,
      uploaded: input.uploaded,
      held: input.held,
      ...(input.snapshot ? { snapshot: input.snapshot } : {}),
      ...(preview ? { preview } : {}),
    };
  }

  let added = 0;
  let removed = 0;
  let moved = 0;
  let retitled = 0;
  for (const [key, item] of after) {
    const old = before.get(key);
    if (!old) {
      added++;
      continue;
    }
    if (old.folder !== item.folder) moved++;
    if (old.title !== item.title) retitled++;
  }
  for (const key of before.keys()) if (!after.has(key)) removed++;

  return {
    data_type: input.dataType,
    peers: input.peers,
    local_before: before.size,
    local_after: after.size,
    added,
    removed,
    moved,
    retitled,
    uploaded: input.uploaded,
    held: input.held,
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** Fold the per-type rows into the cycle's receipt. */
export function buildSyncReport(
  types: SyncTypeReport[],
  durationMs: number,
  errors: string[] = []
): SyncReport {
  const added = types.reduce((n, t) => n + t.added, 0);
  const removed = types.reduce((n, t) => n + t.removed, 0);
  const totalBefore = types.reduce((n, t) => n + t.local_before, 0);
  const totalAfter = types.reduce((n, t) => n + t.local_after, 0);
  // "Dangerous" describes an APPLIED change, not a preview: if a merge removed this many
  // bookmarks, the receipt says so even when the pre-apply snapshot was disabled.
  const dangerous = isDangerousRemoval(
    types.find((t) => t.data_type === "bookmarks")?.removed ?? 0,
    types.find((t) => t.data_type === "bookmarks")?.local_before ?? 0
  );
  const snapshots = types.map((t) => t.snapshot).filter((s): s is string => !!s);
  return {
    at: new Date().toISOString(),
    duration_ms: Math.max(0, Math.round(durationMs)),
    types,
    added,
    removed,
    total_before: totalBefore,
    total_after: totalAfter,
    dangerous,
    ...(snapshots.length ? { snapshot: snapshots[snapshots.length - 1] } : {}),
    ...(errors.length ? { errors } : {}),
  };
}

/** A one-line summary, used in logs and by the popup. */
export function summarizeSyncReport(report: SyncReport): string {
  const parts = report.types
    .filter((t) => t.added || t.removed || t.moved || t.retitled)
    .map((t) => `${t.data_type} +${t.added}/-${t.removed}`);
  return parts.length ? parts.join(", ") : "nothing changed";
}
