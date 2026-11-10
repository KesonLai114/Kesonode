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
import { KEYS, shortDeviceId } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { t } from "@/lib/utils/i18n";
import { UPSTREAM_PROTOCOL, snapshotFileName, snapshotTimestamp } from "@/lib/compat/protocol";
import { HttpError } from "@/lib/utils/retry";

// Restore points are shared upstream data, so their names stay in the upstream namespace
// in every compat mode. The names come from the frozen contract, not from local copy.
const PREFIX = UPSTREAM_PROTOCOL.snapshotFilePrefix;
const INDEX_NAME = UPSTREAM_PROTOCOL.snapshotIndexName;
const MAX_SNAPSHOTS = 10;

// Kesonode-only. Keeping a point forever is a property of its FILE NAME, not of the index:
// `pruneSnapshots` lists `PREFIX` only, so nothing that walks retention can reach it.
const KEPT_PREFIX = "konode_snap_kept_";
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
  if (err instanceof HttpError) return err.status === 403 || err.status === 429 || err.status >= 500;
  return err instanceof TypeError && /fetch|network|load failed/i.test(err.message);
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
    } catch {
      // The point is gone or the name collides: it can never be moved, so drop it.
      await clearPendingPin(p.name);
      continue;
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

type SnapshotNameMeta = Pick<SnapshotMeta, "label" | "device_label" | "device_id">;

/**
 * The ONE place a restore point's visible name is decided.
 *
 * The rule: `Bookmark restore point · <device label> · <short id>` (localized prefix),
 * falling back to just `Bookmark restore point` when the shared index carries no device
 * info, and always overridden by a name the user actually chose.
 *
 * Default names are computed at DISPLAY time and are never written into the shared
 * index. That is the fix for this rule drifting again and again: older builds baked
 * `"<device> <short id> restore point"` into `label`, which (a) froze the wording in
 * whichever language happened to save it, (b) made an automatic name look like a
 * user's own, and (c) left the UI with a second, different fallback for points whose
 * index had no label. Changing the rule could never reach those points. Now there is
 * one function to change.
 */
export function snapshotDisplayName(meta: SnapshotNameMeta): string {
  const label = meta.label?.trim();
  if (label && !snapshotIsUnnamed(meta)) return label;
  const parts = [t("opt_snap_unknown")];
  const device = meta.device_label?.trim();
  const short = shortDeviceId(meta.device_id);
  if (device) parts.push(device);
  // A default device label minted by this build already ends in the short id.
  if (short && !device?.includes(short)) parts.push(short);
  return parts.join(" · ");
}

/** True when the row has no name the USER chose. Older builds persisted an automatic
 *  label (`"<device> <short id> restore point"`); those count as unnamed too, so a
 *  corrected rule also reaches points written by those builds. */
export function snapshotIsUnnamed(meta: SnapshotNameMeta): boolean {
  const label = meta.label?.trim();
  if (!label) return true;
  const short = shortDeviceId(meta.device_id);
  if (!short) return false;
  const device = meta.device_label?.trim();
  // Match on the full device label AND the 8-char id, not on a localized suffix: a
  // name the user typed ("Macmini 升级前还原点") must never be swallowed, and a point
  // saved under a different UI language has a different suffix anyway.
  return device ? label.startsWith(device) && label.includes(short) : label.startsWith(short);
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
    device_id: settings.device_id || undefined,
    // No `label`: only a name the user chooses is stored. The default name is built by
    // snapshotDisplayName() when the row is drawn, so one rule covers every point and
    // every language (see the comment above that function).
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(pinned ? { pinned: true } : {}),
  };
  // Prune first so the index write reflects the post-prune file list in one pass.
  // Kept points are NOT in the rolling list, so they have to be added explicitly or
  // their annotations would be dropped from the shared index here.
  const rolling = await pruneSnapshots(backend);
  const kept = await backend.listFiles(KEPT_PREFIX);
  await mergeIndex(backend, settings, [meta], [...rolling, ...kept, name]);
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
  // A "keep forever" the storage refused earlier gets its rename here, on the first
  // visit that can reach the backend again. Refusals are swallowed inside the flush.
  await flushPendingPins(backend, settings);
  const names = await allSnapshotNames(backend);
  // An unreadable index costs the annotations, nothing more — the file list below is what
  // says which restore points exist, so the list still works.
  const idx = (await migrateLegacyIndex(backend, settings, names))
    ?? (await getIndex(backend, settings))
    ?? [];
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

/** Delete snapshot files beyond the newest MAX_SNAPSHOTS, and return the names that
 *  survived. Driven by the BACKEND FILE LIST, not a local index: the old version
 *  pruned whatever this device happened to have recorded, so two devices each
 *  holding fewer than the cap between them pruned nothing and the folder grew
 *  without limit. Ordering comes from the timestamp in the filename.
 *
 *  Only the ROLLING prefix is walked. `konode_snap_kept_*` is deliberately invisible
 *  here: those are the points the user asked to keep forever. */
export async function pruneSnapshots(backend: IBackend): Promise<string[]> {
  // A point whose "keep forever" is still queued must not be pruned here: the storage
  // refused the rename, not the user's intent. Otherwise a click made during a 403
  // window could lose the very point it was meant to protect.
  const protectedNames = new Set((await readPendingPins()).filter((p) => p.pinned).map((p) => p.name));
  const named = (await backend.listFiles(PREFIX))
    .map((name) => ({ name, ts: tsFromName(name) }))
    .filter((x): x is { name: string; ts: number } => x.ts != null)
    .sort((a, b) => b.ts - a.ts);
  const keep = named.filter((x, i) => i < MAX_SNAPSHOTS || protectedNames.has(x.name));
  for (const x of named) {
    if (keep.includes(x)) continue;
    try { await backend.deleteFile(x.name); } catch { /* best effort — retried next time */ }
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
  const ts = tsFromName(name)!;
  const clean = label.trim().slice(0, 120);
  if (remote === null) {
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

  const byName = new Map(remote.map((m) => [m.name, m]));
  const next: SnapshotMeta = { ...(byName.get(name) ?? {}), name, timestamp: ts };
  if (clean) next.label = clean;
  else delete next.label;
  byName.set(name, next);
  const alive = new Set(live);
  await putIndex(backend, settings, [...byName.values()]
    .filter((m) => alive.has(m.name))
    .sort((a, b) => b.timestamp - a.timestamp));
  await rememberLocal(next);
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
  const live = await allSnapshotNames(backend);
  if (!live.includes(name) && !live.includes(target)) {
    throw new Error("Restore point not found on the backend.");
  }
  const remote = await getIndex(backend, settings);
  if (!live.includes(target)) {
    const raw = await backend.getFile(name);
    if (!raw) throw new Error("Restore point not found on the backend.");
    await backend.putFile(target, raw);
  }
  if (live.includes(name)) await backend.deleteFile(name);
  await moveLocal(name, target);
  if (remote === null) {
    logger.warn("Snapshots", `Shared index unreadable; kept ${target} on this device only`);
    return;
  }

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
    await moveSnapshotFile(backend, settings, name, nameFor(ts, pinned), pinned, ts);
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
  const live = await allSnapshotNames(backend);
  // mergeIndex drops entries with no file behind them, which now includes this one.
  await mergeIndex(backend, settings, [], live);
  logger.event("Snapshots", `Deleted ${name}`);
}
