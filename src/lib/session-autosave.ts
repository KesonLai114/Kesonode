import type { AutosavedSession, SyncSession } from "@/lib/types";
import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * A small local ring of recent open-tab sessions.
 *
 * This exists for the gap between two synced sessions: a browser crash, a window closed
 * by mistake, or simply two sync intervals. It is deliberately separate from the synced
 * sessions file — that one is opt-in and shared, while this is device-local, bounded, and
 * never leaves the browser.
 */

export const MAX_AUTOSAVED_SESSIONS = 20;

/** FNV-1a over the tab URLs; enough to spot an unchanged window without storing a copy. */
function signatureOf(urls: string[]): string {
  let hash = 0x811c9dc5;
  for (const url of urls) {
    for (let i = 0; i < url.length; i++) {
      hash ^= url.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x0a;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${urls.length}-${hash.toString(16).padStart(8, "0")}`;
}

export function autosavedFrom(
  session: SyncSession,
  now = Date.now()
): AutosavedSession {
  const urls = session.tabs.map((t) => canonicalUrlKey(t.url));
  return {
    id: `${now}-${signatureOf(urls)}`,
    saved_at: new Date(now).toISOString(),
    ...(session.label ? { label: session.label } : {}),
    signature: signatureOf(urls),
    tabs: session.tabs.map((t) => ({
      url: t.url,
      ...(t.title ? { title: t.title } : {}),
      pinned: t.pinned,
    })),
  };
}

/**
 * Add a snapshot to the ring, newest first.
 *
 * An identical window does not add a row: 20 entries of the same tabs would push every
 * genuinely different window out of the ring within a few minutes of idle syncing.
 */
export function rememberAutosave(
  current: AutosavedSession[],
  session: SyncSession,
  now = Date.now()
): AutosavedSession[] {
  if (session.tabs.length === 0) return current;
  const next = autosavedFrom(session, now);
  const existing = current.find((entry) => entry.signature === next.signature);
  if (existing) {
    // The same window is still open. Refresh its timestamp and move it to the front so
    // "restore the last session" follows what was actually seen last, not when the
    // signature first appeared.
    return [
      { ...existing, saved_at: next.saved_at },
      ...current.filter((entry) => entry !== existing),
    ];
  }
  return [next, ...current].slice(0, MAX_AUTOSAVED_SESSIONS);
}

/** Filter the ring the same way the global search filters everything else. */
export function searchAutosaved(
  list: AutosavedSession[],
  query: string
): AutosavedSession[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return list;
  return list.filter((entry) => {
    const haystack = [entry.label ?? "", ...entry.tabs.map((t) => `${t.title ?? ""} ${t.url}`)]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
