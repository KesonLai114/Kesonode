// Bookmark snapshots (restore points). A snapshot is a timestamped copy of the
// bookmark tree written to the backend as `konode_snap_bookmarks_<epochms>.json` —
// a name downloadAll's `konode_<type>_` filter never matches, so restore points are
// invisible to normal sync. When E2EE is on the payload is encrypted like a packet.
//
// Kesonode adds `konode_snap_kept_<epochms>.json` for a restore point the user wants to
// keep forever. Retention walks ONLY the rolling prefix, so a kept point cannot be pruned
// by this build, an older Kesonode, or upstream Konode: "forever" must not depend on every
// device being able to read (or decrypt) the shared index. The frozen upstream names are
// untouched — this is a new file kind in the same folder, one downloadAll never matches.
//
// A small index file (`konode_snap_index.json`) carries the bookmark count per
// snapshot so the UI can show it without reading (and decrypting) every snapshot —
// and without leaking the count into the plaintext filename, which the storage
// provider can read. It lives on the backend so EVERY device sees the counts, not
// just the one that took the snapshot, and it is encrypted whenever E2EE is on.
// Kesonode also stores the device name, the name the user gave a restore point, and
// whether it was saved by hand or by the bulk-delete guard there. All three are
// OPTIONAL: an index written by upstream or by an older build carries none of them.
//
// The backend file LIST stays the source of truth for which snapshots exist; the
// index only annotates them. That split matters twice over: an index entry with no
// file behind it is dropped on read, and pruning works off the file list, so it is
// correct on a device that has never written the index.

import type { IBackend, SyncSettings, SyncBookmark, SnapshotMeta } from "@/lib/types";
export type { SnapshotMeta };
import { exportBookmarkPayload, restoreBookmarks, normalizePayload } from "@/lib/handlers/bookmarks-handler";
import { encrypt, decrypt } from "@/lib/crypto/encryption";
import { browser } from "@/lib/utils/ext";
import { KEYS } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { UPSTREAM_PROTOCOL, snapshotFileName, snapshotTimestamp } from "@/lib/compat/protocol";

// Restore points are shared upstream data, so their names stay in the upstream namespace
// in every compat mode. The names come from the frozen contract, not from local copy.
const PREFIX = UPSTREAM_PROTOCOL.snapshotFilePrefix;
const INDEX_NAME = UPSTREAM_PROTOCOL.snapshotIndexName;
const MAX_SNAPSHOTS = 10;

// Kesonode-only. Keeping a point forever is a property of its FILE NAME, not of the index:
// `pruneSnapshots` lists `PREFIX` only, so nothing that walks retention can reach it.
const KEPT_PREFIX = "konode_snap_kept_";

interface SnapshotFile {
  version: "1.0";
  created: string; // ISO-8601
  encrypted: boolean;
  payload: string; // JSON BookmarkPayload, optionally encrypted (salt+iv+ct base64)
}

interface IndexFile {
  version: "1.0";
  encrypted: boolean;
  payload: string; // JSON SnapshotMeta[], optionally encrypted
}

const nameFor = (ts: number, pinned = false): string =>
  pinned ? `${KEPT_PREFIX}${ts}.json` : snapshotFileName(ts);

const isPinnedName = (name: string): boolean => name.startsWith(KEPT_PREFIX);

function tsFromName(name: string): number | null {
  const rolling = snapshotTimestamp(name);
  if (rolling != null) return rolling;
  if (!isPinnedName(name)) return null;
  const m = /^(\d+)\.json$/.exec(name.slice(KEPT_PREFIX.length));
  return m ? Number(m[1]) : null;
}

/** Every restore point file, rolling and kept-forever. Both prefixes must be in any list
 *  passed to the index merge, or a kept point's name, count and device would be dropped
 *  by the very next index write on another device. */
async function allSnapshotNames(backend: IBackend): Promise<string[]> {
  const [rolling, kept] = await Promise.all([
    backend.listFiles(PREFIX), backend.listFiles(KEPT_PREFIX),
  ]);
  return [...rolling, ...kept];
}

function countUrls(tree: SyncBookmark[]): number {
  let n = 0;
  const walk = (nodes: SyncBookmark[]) => nodes.forEach((x) => { if (x.url) n++; if (x.children) walk(x.children); });
  walk(tree);
  return n;
}

/** Is end-to-end encryption ACTUALLY active here — enabled AND a passphrase set?
 *  Not the same as "a passphrase exists": turning E2EE off keeps the passphrase in
 *  settings, and treating that as "encrypted" is what let this module read the group's
 *  encrypted index and write it back in plaintext. Mirrors the sync engine's C1 guard. */
const e2eeActive = (s: SyncSettings): boolean =>
  !!s.encryption_enabled && !!s.encryption_passphrase;

/**
 * Read the shared index. Never throws, and distinguishes three outcomes:
 *
 *  - `[]`   — there is genuinely no index yet, or the file is garbage for EVERY device
 *             (unparseable JSON, payload that isn't a list). Safe to write a fresh one.
 *  - a list — readable.
 *  - `null` — the file exists and is perfectly valid for someone, we just can't read it
 *             (encrypted while E2EE is off here, wrong passphrase, transient backend
 *             error). The caller must NOT overwrite it.
 *
 * Collapsing all of these to `[]` caused two bugs. A device with a lingering passphrase
 * but E2EE off decrypted the group's index and `putIndex` rewrote it in PLAINTEXT on
 * shared storage — the exact downgrade `sync-engine`'s applyRemote refuses. And any
 * transient read failure made `mergeIndex` rewrite the index from scratch, discarding
 * every other device's bookmark counts.
 */
async function getIndex(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta[] | null> {
  let raw: string | null;
  try {
    raw = await backend.getFile(INDEX_NAME);
  } catch (e) {
    // A backend failure is not "there is no index".
    logger.warn("Snapshots", `Could not read the shared index: ${e instanceof Error ? e.message : e}`);
    return null;
  }
  if (!raw) return []; // no index yet

  let file: IndexFile;
  try {
    file = JSON.parse(raw) as IndexFile;
  } catch {
    logger.warn("Snapshots", "Shared index is not valid JSON, replacing it");
    return []; // garbage for everyone, so nothing is lost by replacing it
  }

  let plain = file.payload;
  if (file.encrypted) {
    if (!e2eeActive(settings)) {
      logger.warn("Snapshots", "Shared index is encrypted but E2EE is off here, leaving it alone");
      return null;
    }
    try {
      plain = await decrypt(file.payload, settings.encryption_passphrase as string);
    } catch {
      logger.warn("Snapshots", "Shared index won't decrypt with this passphrase, leaving it alone");
      return null;
    }
  }

  try {
    const list = JSON.parse(plain);
    return Array.isArray(list) ? (list as SnapshotMeta[]) : [];
  } catch {
    return []; // readable but not a list → garbage, safe to replace
  }
}

async function putIndex(backend: IBackend, settings: SyncSettings, list: SnapshotMeta[]): Promise<void> {
  const useE2ee = e2eeActive(settings);
  const plain = JSON.stringify(list);
  const file: IndexFile = {
    version: "1.0",
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  await backend.putFile(INDEX_NAME, JSON.stringify(file));
}

/** Merge entries into the shared index, keeping only those that still have a file on
 *  the backend. Read-merge-write rather than overwrite: two devices both taking
 *  snapshots must not drop each other's counts. `live` is the current file list.
 *
 *  Returns `null` — having written NOTHING — when the existing index can't be read
 *  (see getIndex). The index is only an annotation; the backend file list is what says
 *  which restore points exist. So losing a count is cosmetic, while overwriting data we
 *  couldn't read would destroy the other devices' counts or downgrade the group's
 *  encrypted index to plaintext. Bail instead. */
async function mergeIndex(
  backend: IBackend, settings: SyncSettings, add: SnapshotMeta[], live: string[],
): Promise<SnapshotMeta[] | null> {
  const remote = await getIndex(backend, settings);
  if (remote === null) {
    logger.warn("Snapshots", "Leaving the shared index untouched, only the counts are affected, the restore points themselves are fine");
    return null;
  }
  const byName = new Map<string, SnapshotMeta>();
  for (const m of [...remote, ...add]) byName.set(m.name, m); // `add` wins on conflict
  const alive = new Set(live);
  const merged = [...byName.values()]
    .filter((m) => alive.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp);
  await putIndex(backend, settings, merged);
  return merged;
}

export interface CreateSnapshotOptions {
  /** Keep this one forever: written under KEPT_PREFIX, outside the rolling retention. */
  pinned?: boolean;
  /** What asked for it. Shown beside the timestamp on every device. */
  origin?: "manual" | "auto";
}

/** Write a snapshot of the current bookmark tree, then prune the rolling points to N. */
export async function createSnapshot(
  backend: IBackend, settings: SyncSettings, opts: CreateSnapshotOptions = {},
): Promise<SnapshotMeta> {
  const payload = await exportBookmarkPayload();
  const count = countUrls(payload.tree);
  const plain = JSON.stringify(payload);
  const useE2ee = settings.encryption_enabled && !!settings.encryption_passphrase;
  const file: SnapshotFile = {
    version: "1.0",
    created: new Date().toISOString(),
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  // The filename carries the timestamp, so two snapshots in the same millisecond
  // would collide and the second would silently overwrite the first. Step past any
  // name already on the backend instead of losing a restore point.
  const taken = new Set(await allSnapshotNames(backend));
  const pinned = !!opts.pinned;
  let ts = Date.now();
  while (taken.has(nameFor(ts, pinned))) ts++;
  const name = nameFor(ts, pinned);
  await backend.putFile(name, JSON.stringify(file));
  const meta: SnapshotMeta = {
    name, timestamp: ts, count,
    device_label: settings.device_label || undefined,
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(pinned ? { pinned: true } : {}),
  };
  // Prune first so the index write reflects the post-prune file list in one pass.
  // Kept points are NOT in the rolling list, so they have to be added explicitly or
  // their annotations would be dropped from the shared index here.
  const rolling = await pruneSnapshots(backend);
  const kept = await backend.listFiles(KEPT_PREFIX);
  await mergeIndex(backend, settings, [meta], [...rolling, ...kept, name]);
  logger.event("Snapshots", `Created ${name} (${count} bookmarks)`);
  return meta;
}

/** One-time migration: counts used to live in a device-local index, so the counts for
 *  snapshots taken on THIS device exist nowhere else. Publish them to the shared index
 *  — otherwise upgrading would silently discard them — then drop the legacy key.
 *  Returns the merged index, or null when there was nothing to migrate. */
async function migrateLegacyIndex(
  backend: IBackend, settings: SyncSettings, live: string[],
): Promise<SnapshotMeta[] | null> {
  const r = await browser.storage.local.get(KEYS.LEGACY_SNAPSHOTS);
  const legacy = r[KEYS.LEGACY_SNAPSHOTS] as SnapshotMeta[] | undefined;
  if (legacy === undefined) return null;
  if (!Array.isArray(legacy) || !legacy.length) {
    await browser.storage.local.remove(KEYS.LEGACY_SNAPSHOTS); // nothing to carry over
    return null;
  }
  const merged = await mergeIndex(backend, settings, legacy, live);
  if (merged === null) {
    // The shared index couldn't be read, so nothing was published. KEEP the legacy
    // counts and retry later — dropping the key here deleted them for good, and these
    // counts exist nowhere else.
    logger.warn("Snapshots", "Keeping the legacy snapshot counts, the shared index could not be updated yet");
    return null;
  }
  await browser.storage.local.remove(KEYS.LEGACY_SNAPSHOTS);
  logger.event("Snapshots", `Published ${legacy.length} local snapshot count(s) to the shared index`);
  return merged;
}

/** List restore points on the backend, newest first, annotated with known counts and names. */
export async function listSnapshots(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta[]> {
  const names = await allSnapshotNames(backend);
  // An unreadable index costs the annotations, nothing more — the file list below is what
  // says which restore points exist, so the list still works.
  const idx = (await migrateLegacyIndex(backend, settings, names))
    ?? (await getIndex(backend, settings))
    ?? [];
  const byName = new Map(idx.map((m) => [m.name, m]));
  const metas: SnapshotMeta[] = [];
  for (const name of names) {
    const ts = tsFromName(name);
    if (ts == null) continue;
    // Trust the filename's timestamp AND its kept-forever mark over the index — the file
    // list is canonical, and an older build's index has no `pinned` field at all.
    const known = byName.get(name);
    const meta: SnapshotMeta = { ...(known ?? {}), name, timestamp: ts };
    if (isPinnedName(name)) meta.pinned = true;
    else delete meta.pinned;
    metas.push(meta);
  }
  return metas.sort((a, b) => b.timestamp - a.timestamp);
}

/** Restore a snapshot: re-add every bookmark it holds that's missing locally. */
export async function restoreSnapshot(backend: IBackend, name: string, settings: SyncSettings): Promise<number> {
  // Same guard `deleteSnapshot` has, and for the same reason: `name` reaches the backend
  // as a path component, so it has to be one of OUR filenames rather than any string that
  // arrived here. Nothing can currently pass a bad one, since the UI lists only names
  // this regex already accepted, but the two functions taking the same argument to the
  // same place should not disagree about whether it needs checking.
  if (tsFromName(name) == null) throw new Error("Not a restore point.");
  const raw = await backend.getFile(name);
  if (!raw) throw new Error("Snapshot not found on the backend.");
  const file = JSON.parse(raw) as SnapshotFile;
  let plain = file.payload;
  if (file.encrypted) {
    if (!settings.encryption_passphrase) throw new Error("This snapshot is encrypted. Set your passphrase first.");
    plain = await decrypt(file.payload, settings.encryption_passphrase);
  } else if (e2eeActive(settings)) {
    // 本机已开启端到端加密：拒绝恢复未加密的共享快照，避免向加密组注入未认证的明文数据
    // （与 sync-engine 的 openPacket 防降级守卫保持一致）。
    throw new Error(
      "This restore point is not encrypted, but end-to-end encryption is enabled on this device. " +
      "Restore is refused so encrypted devices do not silently accept unauthenticated data."
    );
  }
  const payload = normalizePayload(JSON.parse(plain));
  return restoreBookmarks(payload.tree);
}

/** Delete snapshot files beyond the newest MAX_SNAPSHOTS, and return the names that
 *  survived. Driven by the BACKEND FILE LIST, not a local index: the old version
 *  pruned whatever this device happened to have recorded, so two devices each
 *  holding fewer than the cap between them pruned nothing and the folder grew
 *  without limit. Ordering comes from the timestamp in the filename.
 *
 *  Only the ROLLING prefix is walked. `konode_snap_kept_*` is deliberately invisible
 *  here: those are the points the user asked to keep forever. */
export async function pruneSnapshots(backend: IBackend): Promise<string[]> {
  const named = (await backend.listFiles(PREFIX))
    .map((name) => ({ name, ts: tsFromName(name) }))
    .filter((x): x is { name: string; ts: number } => x.ts != null)
    .sort((a, b) => b.ts - a.ts);
  const keep = named.slice(0, MAX_SNAPSHOTS);
  for (const { name } of named.slice(MAX_SNAPSHOTS)) {
    try { await backend.deleteFile(name); } catch { /* best effort — retried next time */ }
  }
  return keep.map((x) => x.name);
}

/** Give one restore point a name the user chose. It lives in the shared index, so every
 *  device sees it; the snapshot file itself is never rewritten. An empty name clears it.
 *  An index we cannot read is NEVER replaced — that would erase every other device's
 *  names and counts (or downgrade the group's encrypted index to plaintext). */
export async function renameSnapshot(
  backend: IBackend, settings: SyncSettings, name: string, label: string,
): Promise<void> {
  if (tsFromName(name) == null) throw new Error("Not a restore point.");
  const live = await allSnapshotNames(backend);
  if (!live.includes(name)) throw new Error("Restore point not found on the backend.");
  const remote = await getIndex(backend, settings);
  if (remote === null) throw new Error("The shared restore-point index cannot be read here.");

  const byName = new Map(remote.map((m) => [m.name, m]));
  const ts = tsFromName(name)!;
  const next: SnapshotMeta = { ...(byName.get(name) ?? {}), name, timestamp: ts };
  const clean = label.trim().slice(0, 120);
  if (clean) next.label = clean;
  else delete next.label;
  byName.set(name, next);
  const alive = new Set(live);
  await putIndex(backend, settings, [...byName.values()]
    .filter((m) => alive.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp));
  logger.event("Snapshots", `Renamed ${name}`);
}

/** Keep a restore point forever, or put it back into the rolling ten. The mark is the
 *  FILE NAME: moving between the two prefixes is a read + write + delete of one file,
 *  done only when the user asks. The index read happens BEFORE the move, so an index we
 *  cannot read leaves both the file and everybody else's annotations untouched. */
export async function setSnapshotPinned(
  backend: IBackend, settings: SyncSettings, name: string, pinned: boolean,
): Promise<void> {
  const ts = tsFromName(name);
  if (ts == null) throw new Error("Not a restore point.");
  if (isPinnedName(name) === pinned) return; // already in the requested state

  const live = await allSnapshotNames(backend);
  if (!live.includes(name)) throw new Error("Restore point not found on the backend.");
  const raw = await backend.getFile(name);
  if (!raw) throw new Error("Restore point not found on the backend.");
  const target = nameFor(ts, pinned);
  if (live.includes(target)) throw new Error("A restore point with this timestamp already exists.");

  const remote = await getIndex(backend, settings);
  if (remote === null) throw new Error("The shared restore-point index cannot be read here.");

  await backend.putFile(target, raw);
  await backend.deleteFile(name);

  const byName = new Map(remote.map((m) => [m.name, m]));
  const next: SnapshotMeta = { ...(byName.get(name) ?? {}), name: target, timestamp: ts };
  if (pinned) next.pinned = true;
  else delete next.pinned;
  byName.delete(name);
  byName.set(target, next);
  const alive = new Set([...live.filter((n) => n !== name), target]);
  await putIndex(backend, settings, [...byName.values()]
    .filter((m) => alive.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp));
  logger.event("Snapshots", `${pinned ? "Kept" : "Returned"} ${target}`);
}

/** Delete one restore point, then drop it from the shared index. */
export async function deleteSnapshot(backend: IBackend, settings: SyncSettings, name: string): Promise<void> {
  if (tsFromName(name) == null) throw new Error("Not a restore point.");
  await backend.deleteFile(name);
  const live = await allSnapshotNames(backend);
  // mergeIndex drops entries with no file behind them, which now includes this one.
  await mergeIndex(backend, settings, [], live);
  logger.event("Snapshots", `Deleted ${name}`);
}
