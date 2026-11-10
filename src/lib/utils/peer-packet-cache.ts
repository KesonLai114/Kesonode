/**
 * Peer packets this device has already downloaded, kept so an UNCHANGED peer file can
 * be merged again without asking the storage for it a second time.
 *
 * Why this exists. A sync cycle fetched every peer's file for every data type, every
 * minute, even when nothing had changed on the other side. Three devices on a free
 * Nutstore account (600 WebDAV requests per 30 minutes, counted across every app using
 * the account) put that at roughly 1300 requests per window — so the account was
 * permanently over its quota, and every request came back 403. The 403 then looked like
 * "this device has no name" and "this restore point has no device", which is the bug
 * this cache is one half of the fix for.
 *
 * What it does NOT change. The peer payload is merged exactly as it was before, from
 * the very same bytes — the merge, the conflict resolution, the bulk-delete guard and
 * the change guard all still run on every cycle. Only the network round trip is skipped.
 *
 * When it is safe. A cached packet is reused only when the storage's listing says the
 * file is the SAME file: same modification time AND same size. A file that changed on
 * the other side gets a new mtime (and usually a new size), so it is fetched again. The
 * listing has to carry a modification time at all — a backend that reports none (the
 * GitHub contents API) never reuses anything, and the cache costs it nothing.
 *
 * Local working state only. Nothing here reaches the backend, so the frozen wire
 * contract is untouched, and a stale entry is only ever a wasted download.
 */

import { browser } from "@/lib/utils/ext";
import { logger } from "@/lib/utils/logger";
import { KEYS } from "@/lib/utils/storage";
import type { SyncPacket } from "@/lib/types";

// How many peer packets to keep. A peer publishes one file per data type, so a couple
// of devices with four types each already fill this; the rest are re-downloaded.
const MAX_ENTRIES = 24;
// A ceiling on the cached bytes. Bookmark trees are the big ones (a peer with a few
// thousand bookmarks is a few hundred KB); history can be megabytes. Past this the
// oldest entries are dropped instead of letting local storage grow without bound.
const MAX_BYTES = 4 * 1024 * 1024;

export interface PeerPacketCacheEntry {
  /**
   * The version of the file this packet came from: `"<mtime>"` or `"<mtime>:<size>"`.
   * Empty when the storage's listing carries no modification time — such an entry is
   * never reused, it is only kept so a later listing WITH a time can be compared.
   */
  version: string;
  /**
   * WHICH storage this came from — host, folder and account. A packet is only reused
   * inside the storage it was read from.
   *
   * Without this the cache would be a cross-account leak waiting to happen: file names
   * are `konode_<type>_<device_id>.json` and a device_id can legitimately appear in two
   * accounts (a config restored with "keep this device's identity", or a folder copied
   * between servers). Switching the active backend would then merge the OLD account's
   * bookmarks and history into the new one, silently, with the bytes of a file that
   * happens to share a name and a modification time.
   */
  scope: string;
  /** Serialized size, measured once when the entry is stored (see MAX_BYTES). */
  bytes?: number;
  packet: SyncPacket;
  at: number;
}

type PeerPacketMap = Record<string, PeerPacketCacheEntry>;

/**
 * The version string of a file, from what the storage's listing said about it.
 *
 * `null` for the modification time means the listing carries no time at all, so there
 * is nothing to compare and nothing may be reused. The size is a second, independent
 * signal: two different files can share a second-resolution mtime, and a peer that
 * republishes in the same second would otherwise be served the previous bytes.
 */
export function peerFileVersion(modified: number | null, size?: number | null): string {
  if (modified == null) return "";
  return size == null ? `m${modified}` : `m${modified}s${size}`;
}

async function readMap(): Promise<PeerPacketMap> {
  try {
    const r = await browser.storage.local.get(KEYS.PEER_PACKET_CACHE);
    const v = r[KEYS.PEER_PACKET_CACHE];
    return v && typeof v === "object" && !Array.isArray(v) ? v as PeerPacketMap : {};
  } catch (err) {
    logger.warn("peerPacketCache", `Could not read the local peer-packet cache: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * The cached packet for this file, when the file is still the version we downloaded
 * AND it came from the same storage.
 *
 * `scope` is what keeps one account's bytes out of another account's sync — see the
 * note on PeerPacketCacheEntry.scope. An empty scope never matches anything.
 */
export async function cachedPeerPacket(name: string, version: string, scope: string): Promise<SyncPacket | null> {
  if (!version || !scope) return null;
  const map = await readMap();
  const hit = map[name];
  if (!hit || hit.version !== version || hit.scope !== scope) return null;
  return hit.packet ?? null;
}

/**
 * Remember the packets downloaded in ONE cycle, in one write.
 *
 * Batched on purpose: a cycle can download a dozen files, and a read-modify-write of a
 * multi-megabyte cache per file was more work than the downloads it was trying to save.
 *
 * Best effort: a cache that cannot be written is a file that gets downloaded again.
 */
export async function rememberPeerPackets(
  scope: string,
  entries: readonly { name: string; version: string; packet: SyncPacket }[],
): Promise<void> {
  if (!scope || entries.length === 0) return;
  try {
    const map = await readMap();
    const now = Date.now();
    // `now + i` keeps the batch in the order it was downloaded: every entry of one cycle
    // shares a millisecond, and a stable sort on equal keys would keep the FIRST files
    // and silently drop the last ones when the batch alone exceeds MAX_ENTRIES.
    entries.forEach((e, i) => {
      if (!e.version) return;
      map[e.name] = {
        version: e.version,
        scope,
        bytes: JSON.stringify(e.packet ?? {}).length,
        packet: e.packet,
        at: now + i,
      };
    });
    // Newest first, then keep until either limit is reached.
    const sorted = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_ENTRIES);
    let bytes = 0;
    const kept: PeerPacketMap = {};
    for (const [key, entry] of sorted) {
      const size = entry.bytes ?? JSON.stringify(entry.packet ?? {}).length;
      // Always keep at least one, or a single oversized file would empty the cache.
      if (bytes + size > MAX_BYTES && Object.keys(kept).length > 0) break;
      bytes += size;
      kept[key] = entry;
    }
    await browser.storage.local.set({ [KEYS.PEER_PACKET_CACHE]: kept });
  } catch (err) {
    logger.warn("peerPacketCache", `Could not save the local peer-packet cache: ${err instanceof Error ? err.message : err}`);
  }
}

/** Drop everything. Used when the local identity changes: the files are new names. */
export async function clearPeerPacketCache(): Promise<void> {
  try {
    await browser.storage.local.remove(KEYS.PEER_PACKET_CACHE);
  } catch {
    /* nothing to clean up */
  }
}
