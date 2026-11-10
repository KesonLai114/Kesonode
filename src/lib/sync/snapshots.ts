// Bookmark snapshots (restore points). A snapshot is a timestamped copy of the
// bookmark tree written to the backend as `konode_snap_bookmarks_<epochms>.json` —
// a name downloadAll's `konode_<type>_` filter never matches, so restore points are
// invisible to normal sync. When E2EE is on the payload is encrypted like a packet.
//
// Kesonode adds `konode_snap_kept_<epochms>.json` for a restore point the user wants to
// keep forever. Retention walks ONLY the rolling prefixes, so a kept point cannot be pruned
// by this build, an older Kesonode, or upstream Konode: "forever" must not depend on every
// device being able to read (or decrypt) the shared index. The frozen upstream names are
// untouched — this is a new file kind in the same folder, one downloadAll never matches.
//
// Kesonode also adds `konode_snap_manual_<epochms>.json` for a point the USER asked for.
// The ten-slot ring exists to bound what the automatic safety net costs, and it was
// evicting the one thing it must not: a backup someone took on purpose before an upgrade
// or a cleanup. Ten incidents in a week — a browser with its own bookmark sync turned on
// will produce exactly that — and the manually saved point was gone, silently, because
// "rotate the newest ten" cannot tell the two apart. Same trick as `kept`: the distinction
// lives in the FILENAME, so retention, an unreadable index and every device (including
// ones running an older build) agree about it without reading a single annotation.
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
import { KEYS, shortDeviceId } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { t } from "@/lib/utils/i18n";
import { UPSTREAM_PROTOCOL, snapshotFileName, snapshotTimestamp } from "@/lib/compat/protocol";
import { HttpError } from "@/lib/utils/retry";
import { rememberPeerLabels } from "@/lib/utils/peer-labels";

// Restore points are shared upstream data, so their names stay in the upstream namespace
// in every compat mode. The names come from the frozen contract, not from local copy.
const PREFIX = UPSTREAM_PROTOCOL.snapshotFilePrefix;
const INDEX_NAME = UPSTREAM_PROTOCOL.snapshotIndexName;
const MAX_SNAPSHOTS = 10;
/** Points the user asked for, kept in their own ring. Bounded so the folder cannot grow
 *  without limit, generous enough that nobody reaches it by hand. */
const MAX_MANUAL_SNAPSHOTS = 10;

// Kesonode-only. Keeping a point forever is a property of its FILE NAME, not of the index:
// `pruneSnapshots` lists the other prefixes separately, so nothing that walks the ring can
// reach it.
const KEPT_PREFIX = "konode_snap_kept_";
// Kesonode-only, and the same reasoning as KEPT_PREFIX: what a point is worth to the user
// cannot be stored only in a shared index that a metered storage refuses for whole windows,
// and it must be readable by a device that has never written that index.
const MANUAL_PREFIX = "konode_snap_manual_";
const MAX_LOCAL_ANNOTATIONS = 50;

// ─── "Keep forever" requests the storage refused ───────────────────────────
//
// A kept point IS its FILE NAME, so honoring the click takes a PUT and a DELETE.
// Nutstore answers its frequency cap with 403 on writes too, and one refused write
// used to fail the whole click with a wall of text while the point stayed in the
// rolling ten where retention could still prune it. Keep the intent locally instead,
// show it at once, and finish the rename as soon as the storage answers again.

type PendingPin = { name: string; pinned: boolean };

async function readPendingPins(): Promise<PendingPin[]> {
  try {
    const r = await browser.storage.local.get(KEYS.SNAPSHOT_PENDING_PIN);
    const v = r[KEYS.SNAPSHOT_PENDING_PIN];
    return Array.isArray(v)
      ? v.filter((p): p is PendingPin => !!p && typeof p.name === "string" && typeof p.pinned === "boolean")
      : [];
  } catch {
    return [];
  }
}

async function writePendingPins(list: PendingPin[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.SNAPSHOT_PENDING_PIN]: list.slice(-MAX_LOCAL_ANNOTATIONS) });
}

async function queuePendingPin(name: string, pinned: boolean): Promise<void> {
  const rest = (await readPendingPins()).filter((p) => p.name !== name);
  await writePendingPins([...rest, { name, pinned }]);
}

async function clearPendingPin(name: string): Promise<void> {
  const list = await readPendingPins();
  if (list.some((p) => p.name === name)) await writePendingPins(list.filter((p) => p.name !== name));
}

/** A metered or offline server saying "not now", as opposed to a bad request of ours. */
function isStorageRefusal(err: unknown): boolean {
  if (err instanceof HttpError) return [401, 403, 408, 423, 429].includes(err.status) || err.status >= 500;
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
}

class SnapshotNotFoundError extends Error {
  constructor() { super("Restore point not found on the backend."); }
}

/**
 * Finish queued renames. Stops at the first storage that still refuses, so a
 * rate-limited account is not hit with another round of requests on this cycle.
 */
export async function flushPendingPins(backend: IBackend, settings: SyncSettings): Promise<void> {
  for (const p of await readPendingPins()) {
    let done: boolean;
    try {
      done = await setSnapshotPinned(backend, settings, p.name, p.pinned);
    } catch (err) {
      if (tsFromName(p.name) == null || err instanceof SnapshotNotFoundError) {
        await clearPendingPin(p.name);
        continue;
      }
      // An unknown failure is not proof that the point is gone. Keep the intent (and
      // its retention protection), and avoid another round of requests this cycle.
      logger.warn("Snapshots", `Could not finish the pending change for ${p.name}; keeping it for retry (${err instanceof Error ? err.message : err})`);
      break;
    }
    if (!done) break;
  }
}

/** Annotations this device knows about, kept in chrome.storage.local. The shared index
 *  is authoritative when it can be read; when it cannot (Nutstore's 403 frequency cap,
 *  an encrypted index with no passphrase here), mergeIndex writes NOTHING, so a point
 *  saved during that window has no name, device or count anywhere else. Keeping a local
 *  copy means the list can still say which device saved it. Nothing here reaches the
 *  backend, so the frozen wire contract is untouched. */
type LocalIndex = Record<string, SnapshotMeta>;

async function readLocalIndex(): Promise<LocalIndex> {
  try {
    const r = await browser.storage.local.get(KEYS.SNAPSHOT_LOCAL);
    const v = r[KEYS.SNAPSHOT_LOCAL];
    return v && typeof v === "object" && !Array.isArray(v) ? v as LocalIndex : {};
  } catch {
    return {};
  }
}

async function writeLocalIndex(idx: LocalIndex): Promise<void> {
  const entries = Object.entries(idx)
    .filter(([, m]) => m && typeof m.name === "string")
    .sort((a, b) => (b[1].timestamp ?? 0) - (a[1].timestamp ?? 0))
    .slice(0, MAX_LOCAL_ANNOTATIONS);
  await browser.storage.local.set({ [KEYS.SNAPSHOT_LOCAL]: Object.fromEntries(entries) });
}

async function rememberLocal(meta: SnapshotMeta): Promise<void> {
  const idx = await readLocalIndex();
  idx[meta.name] = { ...(idx[meta.name] ?? {}), ...meta };
  await writeLocalIndex(idx);
}

async function moveLocal(from: string, to: string): Promise<void> {
  const idx = await readLocalIndex();
  if (!idx[from]) return;
  idx[to] = { ...idx[from], name: to };
  delete idx[from];
  await writeLocalIndex(idx);
}

async function forgetLocal(name: string): Promise<void> {
  const idx = await readLocalIndex();
  if (!(name in idx)) return;
  delete idx[name];
  await writeLocalIndex(idx);
}

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

/** Which ring a point belongs to. `pinned` wins: a kept point is outside retention. */
type SnapshotKind = { pinned?: boolean; manual?: boolean };

const nameFor = (ts: number, kind: SnapshotKind = {}): string =>
  kind.pinned ? `${KEPT_PREFIX}${ts}.json`
    : kind.manual ? `${MANUAL_PREFIX}${ts}.json`
      : snapshotFileName(ts);

const isPinnedName = (name: string): boolean => name.startsWith(KEPT_PREFIX);
const isManualName = (name: string): boolean => name.startsWith(MANUAL_PREFIX);

function tsFromName(name: string): number | null {
  const rolling = snapshotTimestamp(name);
  if (rolling != null) return rolling;
  const prefix = isPinnedName(name) ? KEPT_PREFIX : isManualName(name) ? MANUAL_PREFIX : null;
  if (!prefix) return null;
  const m = /^(\d+)\.json$/.exec(name.slice(prefix.length));
  return m ? Number(m[1]) : null;
}

/** Every restore point file: rolling, saved-by-hand, and kept-forever. All three prefixes
 *  must be in any list passed to the index merge, or a point's name, count and device
 *  would be dropped by the very next index write on another device. */
async function allSnapshotNames(backend: IBackend): Promise<string[]> {
  const [rolling, manual, kept] = await Promise.all([
    backend.listFiles(PREFIX), backend.listFiles(MANUAL_PREFIX), backend.listFiles(KEPT_PREFIX),
  ]);
  return [...rolling, ...manual, ...kept];
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
 * but E2EE off decrypted the group's index and the index write rewrote it in PLAINTEXT on
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
    if (!Array.isArray(list)) return []; // readable but not a list → garbage, safe to replace
    const metas = list as SnapshotMeta[];
    // Keep a copy of what we just read. The index is the ONLY place a restore point
    // says which device saved it and how many bookmarks it held, and a metered storage
    // refuses it for whole windows at a time. Without this copy, every restore point
    // the device could not re-read showed up as a bare "Bookmark restore point" — no
    // device, no count — even though the file was sitting right there in the folder.
    await writeSharedCache(metas);
    return metas;
  } catch {
    return []; // readable but not a list → garbage, safe to replace
  }
}

/**
 * The last shared index this device managed to READ.
 *
 * A local fallback for the display only. It is never written back to the backend, so it
 * cannot resurrect a stale index over a newer one — the shared file stays the single
 * source of truth, and this only fills the gap while that file is out of reach.
 */
async function readSharedCache(): Promise<SnapshotMeta[] | null> {
  try {
    const r = await browser.storage.local.get(KEYS.SNAPSHOT_SHARED_CACHE);
    const v = r[KEYS.SNAPSHOT_SHARED_CACHE];
    return Array.isArray(v) ? v as SnapshotMeta[] : null;
  } catch {
    return null;
  }
}

async function writeSharedCache(list: SnapshotMeta[]): Promise<void> {
  try {
    await browser.storage.local.set({
      [KEYS.SNAPSHOT_SHARED_CACHE]: list
        .filter((m) => m && typeof m.name === "string")
        .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
        .slice(0, MAX_LOCAL_ANNOTATIONS),
    });
  } catch {
    // Purely cosmetic: without the copy the list falls back to "Bookmark restore point".
  }
}

async function indexBody(settings: SyncSettings, list: SnapshotMeta[]): Promise<string> {
  const useE2ee = e2eeActive(settings);
  const plain = JSON.stringify(list);
  const file: IndexFile = {
    version: "1.0",
    encrypted: useE2ee,
    payload: useE2ee ? await encrypt(plain, settings.encryption_passphrase as string) : plain,
  };
  return JSON.stringify(file);
}

/** Fold annotations newest first. Listings may be cached on the backend instance
 *  (WebDAV), even when requested again after reading the index. A missing name is not
 *  proof of deletion: preserve unknown remote entries, dropping only names this operation
 *  successfully deleted. listSnapshots still filters the display by actual file names. */
function foldIndex(
  remote: SnapshotMeta[], add: SnapshotMeta[], live: string[], deleted: ReadonlySet<string> = new Set(),
): SnapshotMeta[] {
  const byName = new Map<string, SnapshotMeta>();
  for (const m of [...remote, ...add]) byName.set(m.name, m); // `add` wins on conflict
  const alive = new Set([...live, ...remote.map((m) => m.name), ...add.map((m) => m.name)]);
  return [...byName.values()]
    .filter((m) => alive.has(m.name) && !deleted.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Read-modify-write the shared index, and redo it when another device got there first.
 *
 * `update` receives what we read and a listing requested after that read on every attempt,
 * and returns the list to publish.
 *
 * This is the ONE file two devices write, and without a condition it lost a side whenever
 * they overlapped: both read the index, both merged their own change into what they had
 * read, and the later write's list did not contain the earlier one's entry. Nothing is
 * lost but annotations — a name, a count, "saved by" — which is also what a restore point
 * that lost its name looks like. Where the backend can report a version (ETag / blob SHA)
 * the write is made conditional on it, and a lost race is simply redone. Every attempt
 * keeps that condition; exhausting retries must never overwrite another device's work.
 *
 * Returns the published list, or null when nothing was written — the existing index or
 * its version could not be read, or contention exhausted the retries. Overwriting then
 * could destroy other devices' annotations or downgrade the group's encrypted index.
 */
async function updateIndex(
  backend: IBackend, settings: SyncSettings,
  update: (remote: SnapshotMeta[], live: string[]) => SnapshotMeta[],
): Promise<SnapshotMeta[] | null> {
  const canCondition = !!(backend.getFileVersion && backend.putFileIfVersion);
  const attempts = canCondition ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let conditional = canCondition;
    let version: string | null = null;
    if (conditional) {
      try {
        version = await backend.getFileVersion!(INDEX_NAME);
      } catch (e) {
        // Only the explicit no-ETag signal from WebDAV/Drive permits the legacy
        // fallback. HTTP/network failures (or unknown errors) cannot prove that this
        // backend lacks conditions, so leave the original index untouched.
        if (e instanceof HttpError || !(e instanceof Error) || !/\bno etag\b.*writes cannot be made conditional/i.test(e.message)) {
          logger.warn("Snapshots", `Could not read the shared index version; leaving the index untouched (${e instanceof Error ? e.message : e})`);
          return null;
        }
        conditional = false;
        logger.info("Snapshots", `Conditional index write unavailable (${e.message}); merging without it`);
      }
    }
    const remote = await getIndex(backend, settings);
    if (remote === null) return null;
    const merged = update(remote, await allSnapshotNames(backend));
    const body = await indexBody(settings, merged);
    if (conditional) {
      if (!(await backend.putFileIfVersion!(INDEX_NAME, body, version))) {
        logger.info("Snapshots", "Another device wrote the shared index first; merging again");
        continue;
      }
    } else {
      await backend.putFile(INDEX_NAME, body);
    }
    // What we just published is also what this device would show if the storage stopped
    // answering: the local copy of the index follows every write.
    await writeSharedCache(merged);
    return merged;
  }
  logger.warn("Snapshots", `Shared index changed during all ${attempts} conditional write attempts; leaving the remote index untouched`);
  return null;
}

async function mergeIndex(
  backend: IBackend, settings: SyncSettings, add: SnapshotMeta[], deleted: ReadonlySet<string> = new Set(),
): Promise<SnapshotMeta[] | null> {
  const merged = await updateIndex(backend, settings, (remote, live) => foldIndex(remote, add, live, deleted));
  if (merged === null) {
    logger.warn("Snapshots", "Leaving the shared index untouched, only the counts are affected, the restore points themselves are fine");
  }
  return merged;
}

export interface CreateSnapshotOptions {
  /** Keep this one forever: written under KEPT_PREFIX, outside every retention rule. */
  pinned?: boolean;
  /** What asked for it. Shown beside the timestamp on every device — and `manual` also
   *  decides which ring the point joins, so a backup the user took is not evicted by a
   *  run of automatic ones. */
  origin?: "manual" | "auto";
}

type SnapshotNameMeta = Pick<SnapshotMeta, "label" | "device_label" | "device_id" | "auto_name">;

/** `<device name> · <short id>` — the half of a default name that identifies the machine. */
function deviceTag(meta: SnapshotNameMeta): string {
  const parts: string[] = [];
  const device = meta.device_label?.trim();
  const short = shortDeviceId(meta.device_id);
  if (device) parts.push(device);
  // A default device label minted by this build already ends in the short id.
  if (short && !device?.includes(short)) parts.push(short);
  return parts.join(" · ");
}

/**
 * The ONE place a restore point's visible name is decided.
 *
 * The rule: `Bookmark restore point · <device label> · <short id>` (localized prefix),
 * falling back to just `Bookmark restore point` when the shared index carries no device
 * info, and always overridden by a name the user actually chose.
 *
 * The device half is read from `auto_name` — the tag frozen into the index on the day the
 * point was saved — and only from the live `device_label` for points saved before that
 * field existed. Re-deriving it from current settings is what renamed other people's
 * history: renaming the device (or the extension silently cleaning its name) rewrote the
 * label of points that had been sitting there for weeks, so one machine's restore points
 * were found under three different names. A restore point names the device that MADE it,
 * not the device that happens to be looking at it.
 *
 * Default names are still never written into `label`: that field means "the user named
 * this", and a machine-written string in it would (a) freeze the wording in whichever
 * language happened to save it, (b) make an automatic name look like the user's own, and
 * (c) leave the UI with a second, different fallback. One function, one rule.
 */
export function snapshotDisplayName(meta: SnapshotNameMeta): string {
  const label = meta.label?.trim();
  if (label && !snapshotIsUnnamed(meta)) return label;
  const tag = meta.auto_name?.trim() || deviceTag(meta);
  return tag ? `${t("opt_snap_unknown")} · ${tag}` : t("opt_snap_unknown");
}

/** True when the row has no name the USER chose. Older builds persisted an automatic
 *  label (`"<device> <short id> restore point"`); those count as unnamed too, so a
 *  corrected rule also reaches points written by those builds. */
export function snapshotIsUnnamed(meta: SnapshotNameMeta): boolean {
  const label = meta.label?.trim();
  if (!label) return true;
  const short = shortDeviceId(meta.device_id);
  if (!short) return false;
  // An 8-char device id inside a restore point's name means a machine wrote it: nobody
  // types one by hand. That covers every build that baked an automatic name into `label`.
  //
  // Deliberately NOT "starts with the device label": "Macbook 升级前" is exactly how
  // someone names a restore point they took before upgrading, and treating that as
  // machine-written silently threw their name away and showed the default instead —
  // which is also "the name changed by itself". Only the id is proof.
  return label.includes(short);
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
  const kind: SnapshotKind = { pinned, manual: !pinned && opts.origin === "manual" };
  let ts = Date.now();
  while (taken.has(nameFor(ts, kind))) ts++;
  const name = nameFor(ts, kind);
  await backend.putFile(name, JSON.stringify(file));
  const meta: SnapshotMeta = {
    name, timestamp: ts, count,
    device_label: settings.device_label || undefined,
    device_id: settings.device_id || undefined,
    // Frozen NOW, from the settings of the device that is taking this point. Everything
    // that later changes — the user renaming the computer, a settings import, a cleaner
    // with a different idea of what a device is called — must not reach this point.
    auto_name: deviceTag({ device_label: settings.device_label, device_id: settings.device_id }) || undefined,
    // No `label`: only a name the user chooses is stored. The default name is built by
    // snapshotDisplayName() when the row is drawn, so one rule covers every point and
    // every language (see the comment above that function).
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(pinned ? { pinned: true } : {}),
  };
  // Prune first, recording only successful deletes. An absent name in a cached
  // listing must never erase another device's newly published annotation.
  const deleted = new Set<string>();
  await pruneSnapshots(backend, deleted);
  await mergeIndex(backend, settings, [meta], deleted);
  // The merge writes NOTHING when the shared index is unreadable. Keep our own annotations
  // anyway, or this point would have no name, device or count anywhere at all.
  await rememberLocal(meta);
  logger.event("Snapshots", `Created ${name} (${count} bookmarks)`);
  return meta;
}

/** One-time migration: counts used to live in a device-local index, so the counts for
 *  snapshots taken on THIS device exist nowhere else. Publish them to the shared index
 *  — otherwise upgrading would silently discard them — then drop the legacy key.
 *  Returns the merged index, or null when there was nothing to migrate. */
async function migrateLegacyIndex(
  backend: IBackend, settings: SyncSettings,
): Promise<SnapshotMeta[] | null> {
  const r = await browser.storage.local.get(KEYS.LEGACY_SNAPSHOTS);
  const legacy = r[KEYS.LEGACY_SNAPSHOTS] as SnapshotMeta[] | undefined;
  if (legacy === undefined) return null;
  if (!Array.isArray(legacy) || !legacy.length) {
    await browser.storage.local.remove(KEYS.LEGACY_SNAPSHOTS); // nothing to carry over
    return null;
  }
  const merged = await mergeIndex(backend, settings, legacy);
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

/**
 * The restore points this device can describe WITHOUT the backend.
 *
 * Used when the storage cannot be asked — a rate-limit window refuses every request for
 * half an hour, and an empty list or a wall of 403 text is the worst possible answer:
 * the points are still there and this device already knows about some of them. The
 * shared ones come from the last index it managed to read, the rest from its own index.
 */
export async function knownSnapshots(): Promise<SnapshotMeta[]> {
  const local = await readLocalIndex();
  const shared = await readSharedCache();
  const byName = new Map<string, SnapshotMeta>();
  for (const m of [...(shared ?? []), ...Object.values(local)]) byName.set(m.name, m);
  return [...byName.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

/** List restore points on the backend, newest first, annotated with known counts and names. */
export async function listSnapshots(backend: IBackend, settings: SyncSettings): Promise<SnapshotMeta[]> {
  // A "keep forever" the storage refused earlier gets its rename here, on the first
  // visit that can reach the backend again. Refusals are swallowed inside the flush.
  await flushPendingPins(backend, settings);
  let names: string[];
  try {
    names = await allSnapshotNames(backend);
  } catch (err) {
    // The folder can't be listed right now — a rate-limited window, most of the time.
    // The restore points are still there and this device still knows some of them, so
    // show what is known instead of an empty list that reads like "you have no
    // backups". The names and counts of the ones this device made are in the local
    // index; the shared ones come from the last index this device managed to read.
    logger.warn("Snapshots", `Couldn't list the restore points (${err instanceof Error ? err.message : err}); showing the ones this device knows about`);
    return knownSnapshots();
  }
  // An unreadable index costs the annotations, nothing more — the file list below is what
  // says which restore points exist, so the list still works. And when the index itself
  // is out of reach, the last copy this device read fills in what it can: the device that
  // saved each point and how many bookmarks it held.
  const idx = (await migrateLegacyIndex(backend, settings))
    ?? (await getIndex(backend, settings))
    ?? (await readSharedCache())
    ?? [];
  // The index names the devices that saved these points. That is a second source of
  // device names, and it is often the only one that survives a window in which no peer
  // file could be read at all.
  await rememberPeerLabels(
    idx
      .filter((m) => m?.device_id && m?.device_label)
      .map((m) => ({ device_id: m.device_id as string, device_label: m.device_label as string })),
  );
  const byName = new Map(idx.map((m) => [m.name, m]));
  const local = await readLocalIndex();
  const live = new Set(names);
  const stale = Object.keys(local).filter((n) => !live.has(n));
  if (stale.length) {
    for (const n of stale) delete local[n];
    await writeLocalIndex(local);
  }
  // A queued "keep forever" has not been renamed yet, but the click already counted:
  // show it as kept here rather than leaving the button looking ignored for 30 minutes.
  const pendingPinned = new Set((await readPendingPins()).filter((p) => p.pinned).map((p) => p.name));
  const metas: SnapshotMeta[] = [];
  for (const name of names) {
    const ts = tsFromName(name);
    if (ts == null) continue;
    // Trust the filename's timestamp AND its kept-forever mark over the index — the file
    // list is canonical, and an older build's index has no `pinned` field at all.
    // The readable shared index wins; the local copy only fills in what a refused index
    // never let us publish.
    const known = byName.get(name);
    const meta: SnapshotMeta = { ...(local[name] ?? {}), ...(known ?? {}), name, timestamp: ts };
    // No annotation anywhere and the shared index is unreadable: leave the origin
    // UNKNOWN. Guessing "the device that happens to be viewing the list" used to relabel
    // every older point with the CURRENT device name — after a rename or a settings import
    // the user's restore points looked silently renamed. A readable index, and this
    // device's own local copy merged above, are the real answers; a guess is not one.
    if (isPinnedName(name) || pendingPinned.has(name)) meta.pinned = true;
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

/** Delete snapshot files beyond the cap, and return the names that survived.
 *
 *  TWO rings, walked separately. `konode_snap_bookmarks_*` is the automatic safety net
 *  (a blocked mass delete, a held drift): it rotates at MAX_SNAPSHOTS. `konode_snap_manual_*`
 *  holds what the user saved on purpose, and rotates only against ITSELF at
 *  MAX_MANUAL_SNAPSHOTS — so a week of incident points cannot evict the backup someone
 *  took before an upgrade. `konode_snap_kept_*` is untouched by both: that is "forever".
 *
 *  Driven by the BACKEND FILE LIST, not a local index: the old version pruned whatever
 *  this device happened to have recorded, so two devices each holding fewer than the cap
 *  between them pruned nothing and the folder grew without limit. Ordering comes from the
 *  timestamp in the filename, and the prefix from the file kind — never from an annotation
 *  this device may be unable to read. */
export async function pruneSnapshots(backend: IBackend, deleted?: Set<string>): Promise<string[]> {
  // A point whose "keep forever" is still queued must not be pruned here: the storage
  // refused the rename, not the user's intent. Otherwise a click made during a 403
  // window could lose the very point it was meant to protect.
  const protectedNames = new Set((await readPendingPins()).filter((p) => p.pinned).map((p) => p.name));
  const keep = [
    ...(await pruneRing(backend, PREFIX, MAX_SNAPSHOTS, protectedNames, deleted)),
    ...(await pruneRing(backend, MANUAL_PREFIX, MAX_MANUAL_SNAPSHOTS, protectedNames, deleted)),
  ];
  return keep;
}

/** Rotate one prefix down to `cap`, newest first, and return what is left. */
async function pruneRing(
  backend: IBackend, prefix: string, cap: number, protectedNames: Set<string>, deleted?: Set<string>,
): Promise<string[]> {
  const named = (await backend.listFiles(prefix))
    .map((name) => ({ name, ts: tsFromName(name) }))
    .filter((x): x is { name: string; ts: number } => x.ts != null)
    .sort((a, b) => b.ts - a.ts);
  const keep = named.filter((x, i) => i < cap || protectedNames.has(x.name));
  const keepSet = new Set(keep.map((x) => x.name));
  let failed = 0;
  for (const x of named) {
    if (keepSet.has(x.name)) continue;
    try {
      await backend.deleteFile(x.name);
      deleted?.add(x.name);
    } catch {
      keep.push(x); // The file and its annotations survive until a delete succeeds.
      failed++;
    }
  }
  if (failed) logger.warn("Snapshots", `Could not prune ${failed} restore point(s) from ${prefix}; keeping their files and annotations for retry`);
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
  const ts = tsFromName(name)!;
  const clean = label.trim().slice(0, 120);
  // Conditional where the backend allows it: a rename landing while another device takes
  // a restore point must not drop that point's annotation.
  const merged = await updateIndex(backend, settings, (remote, currentLive) => {
    const byName = new Map(remote.map((m) => [m.name, m]));
    const next: SnapshotMeta = { ...(byName.get(name) ?? {}), name, timestamp: ts };
    if (clean) next.label = clean;
    else delete next.label;
    return foldIndex(remote, [next], currentLive);
  });
  if (merged === null) {
    // A refused index is never overwritten. Keep the name on this device instead, so a
    // 403 does not make the pencil button fail with "cannot be read here".
    const local = await readLocalIndex();
    const next: SnapshotMeta = { ...(local[name] ?? {}), name, timestamp: ts };
    if (clean) next.label = clean;
    else delete next.label;
    local[name] = next;
    await writeLocalIndex(local);
    logger.warn("Snapshots", `Shared index unreadable; kept the name of ${name} on this device only`);
    return;
  }

  const mine = merged.find((m) => m.name === name);
  if (mine) await rememberLocal(mine);
  logger.event("Snapshots", `Renamed ${name}`);
}

/**
 * Move one point between the rolling and the kept-forever file names.
 *
 * Idempotent on purpose: an earlier attempt may have written the new file and been
 * refused only at the delete, so a target that already exists is FINISHED rather than
 * rejected. The shared index is best effort — one we cannot read is left untouched.
 */
async function moveSnapshotFile(
  backend: IBackend, settings: SyncSettings, name: string, target: string,
  pinned: boolean, ts: number,
): Promise<void> {
  // A cached listing cannot confirm absence. Read the actual files before declaring
  // an intent impossible, and tolerate a retry that already got past the copy.
  if (await backend.getFile(target) === null) {
    const source = await backend.getFile(name);
    if (source === null) throw new SnapshotNotFoundError();
    await backend.putFile(target, source);
    await backend.deleteFile(name);
  } else if (await backend.getFile(name) !== null) {
    // An earlier attempt copied it and was refused only at the delete. Deleting a
    // missing name instead would fail on every retry and never finish the move.
    await backend.deleteFile(name);
  }
  await moveLocal(name, target);

  const merged = await updateIndex(backend, settings, (remote, live) => {
    const byName = new Map(remote.map((m) => [m.name, m]));
    const next: SnapshotMeta = { ...(byName.get(target) ?? {}), ...(byName.get(name) ?? {}), name: target, timestamp: ts };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    return foldIndex(remote, [next], [...live, target], new Set([name]));
  });
  if (merged === null) {
    logger.warn("Snapshots", `Shared index unreadable; kept ${target} on this device only`);
    return;
  }
  logger.event("Snapshots", `${pinned ? "Kept" : "Returned"} ${target}`);
}

/** Keep a restore point forever, or put it back into the rolling ten.
 *
 *  Returns false only when the storage refused the write: the intent is queued locally
 *  and the list shows it as kept right away. A real error still throws, so a bad name or
 *  a missing file is never mistaken for a rate limit.
 */
export async function setSnapshotPinned(
  backend: IBackend, settings: SyncSettings, name: string, pinned: boolean,
): Promise<boolean> {
  const ts = tsFromName(name);
  if (ts == null) throw new Error("Not a restore point.");
  if (isPinnedName(name) === pinned) {
    await clearPendingPin(name);
    return true;
  }
  try {
    // A point put back from "forever" rejoins the AUTOMATIC ring rather than the by-hand
    // one: the button says "back into the rolling ten", and this device cannot tell
    // whether the user's own reason for saving it still stands. Restoring never touches
    // the file, so the cost of being wrong is a point 10 incidents away from pruning.
    await moveSnapshotFile(backend, settings, name, nameFor(ts, { pinned }), pinned, ts);
    await clearPendingPin(name);
    return true;
  } catch (err) {
    if (!isStorageRefusal(err)) throw err;
    await queuePendingPin(name, pinned);
    logger.warn("Snapshots", `Storage refused the change; ${name} is marked ${pinned ? "kept forever" : "rolling"} on this device and will be moved as soon as the storage answers again`);
    return false;
  }
}

/** Delete one restore point, then drop it from the shared index. */
export async function deleteSnapshot(backend: IBackend, settings: SyncSettings, name: string): Promise<void> {
  if (tsFromName(name) == null) throw new Error("Not a restore point.");
  await backend.deleteFile(name);
  await forgetLocal(name);
  // Only this successful deletion is authoritative, not omissions from a cached list.
  await mergeIndex(backend, settings, [], new Set([name]));
  logger.event("Snapshots", `Deleted ${name}`);
}
