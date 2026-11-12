import type { CleanupReport, DeadLink, DuplicateGroup } from "@/lib/types";
import type { FlatBookmark } from "@/lib/handlers/reading-list-handler";
import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * Duplicate cleanup and an OPT-IN dead-link check.
 *
 * Neither ever runs on its own: duplicates are found here, shown with their folders and
 * dates, and only the ids the user confirms are removed. The network check is separate
 * for the obvious reason — probing hundreds of bookmarks is a request burst against
 * third-party sites and a slow operation, so it is a button, not a background task.
 */

/** Same canonical URL saved more than once, ignoring case and trailing-slash differences. */
export function findDuplicateGroups(items: FlatBookmark[]): DuplicateGroup[] {
  const byKey = new Map<string, FlatBookmark[]>();
  for (const item of items) {
    if (!item.url) continue;
    const key = canonicalUrlKey(item.url);
    const list = byKey.get(key) ?? [];
    list.push(item);
    byKey.set(key, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [url, list] of byKey) {
    if (list.length < 2) continue;
    groups.push({
      url,
      items: list.map((i) => ({
        id: i.id,
        title: i.title,
        folder: i.folder,
        dateAdded: i.dateAdded,
      })),
    });
  }
  return groups.sort((a, b) => b.items.length - a.items.length || a.url.localeCompare(b.url));
}

/**
 * Which ids to remove from each group, keeping one copy.
 *
 * "oldest" keeps the earliest `dateAdded` — the copy most likely to carry the position
 * and folder the user chose first. Ties break by id so the plan is deterministic.
 */
export function duplicateRemovalPlan(
  groups: DuplicateGroup[],
  keep: "oldest" | "newest" = "oldest"
): string[] {
  const out: string[] = [];
  for (const group of groups) {
    const ordered = [...group.items].sort((a, b) => {
      if (a.dateAdded !== b.dateAdded) {
        return keep === "oldest" ? a.dateAdded - b.dateAdded : b.dateAdded - a.dateAdded;
      }
      return a.id.localeCompare(b.id);
    });
    for (const item of ordered.slice(1)) out.push(item.id);
  }
  return out;
}

export interface DeadLinkOptions {
  timeoutMs?: number;
  concurrency?: number;
  /**
   * Stop starting new probes after this many milliseconds. The check runs inside an MV3
   * service worker, which the browser may terminate mid-event; a fixed link cap alone
   * could still take ten minutes on slow hosts.
   */
  maxDurationMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * How many links one run may probe. The opt-in check is a burst against third-party
 * sites, so the cap is deliberate; the report says what it left unchecked.
 */
export const MAX_DEAD_LINK_PROBES = 300;

/**
 * Only a definitive "this page does not exist" counts as dead.
 *
 * 401/403 mean the page is there behind a login or a bot wall; 429 and 5xx are the
 * server asking us to come back later. Reporting those as dead made "remove selected"
 * delete perfectly good bookmarks, which is the one unrecoverable mistake here.
 */
const DEAD_STATUSES = new Set([404, 410]);

function isHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function probe(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ dead: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetchImpl(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    // Plenty of servers answer HEAD with "not allowed" while serving the page fine.
    if (response.status === 405 || response.status === 501) {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: { Range: "bytes=0-0" },
        signal: controller.signal,
      });
    }
    return { dead: DEAD_STATUSES.has(response.status), status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A timeout/abort is a "could not check", not proof the page is gone.
    return { dead: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeadLinkScan {
  dead: DeadLink[];
  /** Links actually probed. The receipt reports this rather than the whole tree. */
  checked: number;
  /** http(s) links the run did not reach (cap or time limit). */
  unchecked: number;
}

/**
 * Check links in small batches. Returns only the ones that answered with an error.
 *
 * A link that times out is not reported: on a flaky connection every slow host would
 * become a "dead link", and deleting on that basis is the one unrecoverable mistake this
 * feature could make.
 */
export async function checkDeadLinks(
  items: FlatBookmark[],
  opts: DeadLinkOptions = {}
): Promise<DeadLinkScan> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const concurrency = Math.max(1, Math.min(10, opts.concurrency ?? 4));
  const maxDurationMs = Math.max(1, opts.maxDurationMs ?? 4 * 60_000);
  const httpItems = items.filter((i) => isHttp(i.url));
  const candidates = httpItems.slice(0, MAX_DEAD_LINK_PROBES);
  const startedAt = Date.now();
  const dead: DeadLink[] = [];
  let checked = 0;

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      if (Date.now() - startedAt >= maxDurationMs) return;
      const item = candidates[cursor++];
      const result = await probe(item.url, fetchImpl, timeoutMs);
      checked++;
      if (result.dead) {
        dead.push({
          id: item.id,
          title: item.title,
          url: item.url,
          ...(result.status !== undefined ? { status: result.status } : {}),
          ...(result.error ? { error: result.error } : {}),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    dead: dead.sort((a, b) => a.title.localeCompare(b.title)),
    checked,
    unchecked: httpItems.length - checked,
  };
}

export function buildCleanupReport(
  items: FlatBookmark[],
  scan: DeadLinkScan | null
): CleanupReport {
  return {
    duplicates: findDuplicateGroups(items),
    dead: scan?.dead ?? [],
    scanned: items.length,
    dead_checked: scan !== null,
    ...(scan ? { dead_probed: scan.checked, dead_unchecked: scan.unchecked } : {}),
  };
}
