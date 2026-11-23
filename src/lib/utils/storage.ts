import type {
  AppearedRecord,
  BookmarkExclusion,
  BookmarkOrderMode,
  KeptShellRecord,
  CreatedRecord,
  PeerRemovalRecord,
  DataType,
  SyncPacket,
  FirstSyncChoice,
  FolderDeleteRecord,
  FolderMoveRecord,
  FolderRenameRecord,
  MoveRecord,
  TitleRecord,
  RemoteExtensionEntry,
  RemoteSessionEntry,
  SyncExtension,
  SyncSettings,
  SyncState,
  SyncReport,
  AutosavedSession,
  Tombstone,
  SettingsBackup,
  BackendConfig,
} from "@/lib/types";
import { browser } from "@/lib/utils/ext";
import { BACKEND_LABEL } from "@/lib/constants";
import { setCompatMode } from "@/lib/compat/protocol";
import { inferStore, storeUrlFor } from "@/lib/utils/extensions-match";
import { canonicalUrlKey } from "@/lib/utils/url";
import { passphraseViolatesPolicy, MIN_PASSPHRASE_LENGTH, encrypt, decrypt } from "@/lib/crypto/encryption";
import { sanitizeExclusions } from "@/lib/utils/bookmark-exclusions";
import { withChecksum, verifyChecksum } from "@/lib/utils/checksum";

// ─── Device name detection ─────────────────────────────────────────────────

/** The operating system, as a word a person would use for their own machine. */
export function detectDeviceOs(): string {
  const ua = navigator.userAgent;

  // OS detection. ORDER MATTERS, and it used to be wrong in both directions: an Android
  // user agent contains "Linux" and an iPhone's contains "Mac OS X", so those two were
  // caught by the desktop branch above them and no device ever identified as Android or
  // iOS. The mobile platforms have to be tested FIRST, because they are the specific case.
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  // "Windows NT 10.0" is sent by BOTH Windows 10 and Windows 11 — Microsoft never bumped
  // it — so calling it Windows 11 was simply wrong for every Windows 10 user, in a label
  // they see next to their device. Telling them apart needs an async high-entropy
  // client-hint this sync function can't make.
  if (ua.includes("Windows NT 10.0")) return "Windows 10/11";
  if (ua.includes("Windows NT 6.3")) return "Windows 8.1";
  if (ua.includes("Windows NT 6.1")) return "Windows 7";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS X")) return "Mac";
  if (ua.includes("Linux")) return "Linux";
  return "Device";
}

/** The browser, prefixed with the separator the label used to be built from. */
function detectDeviceBrowserSuffix(): string {
  const ua = navigator.userAgent;
  if ((navigator as any).brave) return " · Brave";
  if (ua.includes("Edg/")) return " · Edge";
  // QuarkPC sends Chrome's user agent plus its own token. Without this it reads
  // "Chromium" on a machine its owner calls 夸克浏览器 (field report, 2026-11-08).
  if (ua.includes("QuarkPC/")) return " · 夸克浏览器";
  // "Chrome/" is in every Chromium build's user agent, Helium's, Vivaldi's and
  // ungoogled-chromium's included, so it proves the engine and nothing more. Calling that
  // Chrome named a fresh Helium "Linux · Chrome" (2026-11-05).
  if (ua.includes("Chrome")) return " · Chromium";
  if (ua.includes("Firefox")) return " · Firefox";
  return "";
}

/**
 * `<OS> · <browser>` — the FULL description of this browser, for places that want to
 * name what a device runs rather than what its owner calls it (the device list's
 * secondary line, the popup's peer rows).
 *
 * NOT the stored `device_label`. See defaultDeviceLabel() for why those two are different
 * things, and cleanDeviceLabel() for the mess that came of conflating them.
 */
export function detectDeviceName(): string {
  return `${detectDeviceOs()}${detectDeviceBrowserSuffix()}`;
}

/** The eight-hex id older builds appended to the stored label. */
const AUTO_SHORT_ID = /\s*[·•]\s*([0-9a-f]{8})$/i;
/** The browser token older builds appended to the stored label. */
const AUTO_BROWSER = /\s*[·•]\s*(?:Edge|Chromium|Firefox|Brave|Safari|夸克浏览器)$/i;

/**
 * Strip the machine-generated suffixes out of a stored device label.
 *
 * `device_label` is meant to hold the name the USER chose — "Mac mini M4pro", "Macbook",
 * "办公室那台". Older builds instead stored `<OS> · <browser> · <short id>`, which put a
 * string nobody typed into an editable field. The reported symptom was exactly that:
 * the field read `Mac · Edge · 451dbeb9`, the owner edited only the first word, and every
 * restore point from then on was called `Macbook · Edge · 451dbeb9` — one name that is
 * half a person's word and half a machine's.
 *
 * Stripping is idempotent and never empties the label: a name that is nothing but
 * suffixes falls back to the plain OS name at the call site. A user's own "Mac · Office"
 * is left alone — "Office" is not a browser token, and there is no id after it.
 *
 * The trailing token is only taken for an id when it IS this device's short id, or when
 * it cannot be anything else (eight hex chars with at least one letter). That keeps a
 * hand-written "工作机 · 20240101" from losing its date: all-digit tokens are only ever
 * stripped on an exact match with the device id.
 *
 * The browser token is stripped ONLY as part of that machine pattern — after an id came
 * off the same string. On its own, "<name> · Edge" is somebody's own name: a Macbook
 * whose owner wrote "Macbook · Edge" (they run Edge; the browser is the distinguishing
 * half on a machine that has three of them) is not a leftover to be cleaned. Stripping it
 * was the third report of the same symptom: the extension quietly renamed the computer,
 * and since a restore point is named after its device, every point saved afterwards
 * carried the name the owner had not chosen — "the restore point names changed by
 * themselves". A label the user typed is data, not a migration to finish.
 */
export function cleanDeviceLabel(raw: string | null | undefined, deviceId?: string): string {
  const original = (raw ?? "").trim();
  if (!original) return "";
  const ownShort = shortDeviceId(deviceId).toLowerCase();
  let out = original;
  // Three passes: the id comes off the end first, which exposes the browser token that
  // was sitting in front of it.
  for (let i = 0; i < 3; i++) {
    let strippedId = false;
    const withoutId = out.replace(AUTO_SHORT_ID, (match, token: string) => {
      const low = token.toLowerCase();
      const isOwn = !!ownShort && low === ownShort;
      const unmistakable = /[a-f]/.test(low); // eight digits alone could be a date
      if (!isOwn && !unmistakable) return match;
      strippedId = true;
      return "";
    });
    // A browser word is machine-written only when the machine id was there too.
    const next = (strippedId ? withoutId.replace(AUTO_BROWSER, "") : withoutId).trim();
    if (!next || next === out) break;
    out = next;
  }
  return out || original;
}

/** First 8 hex chars of a device id: enough to tell two installs apart, adds no data
 *  about the machine beyond the random id the extension already mints for itself. */
export function shortDeviceId(deviceId: string | undefined): string {
  return (deviceId ?? "").replace(/-/g, "").slice(0, 8);
}

/**
 * Default label for a freshly minted device identity: the plain OS name — `Mac`,
 * `Windows 10/11`, `Android`.
 *
 * It used to be `<OS> · <browser> · <short id>`, which is the WRONG thing to put in a
 * field the user is invited to edit: the machine's half of the string survived every
 * edit and ended up glued to the user's half (`Macbook · Edge · 451dbeb9`, reported three
 * times). The two halves are different data and are now stored and shown separately:
 *
 *   - `device_label` — the user's words, and nothing else. This is what travels in a
 *     packet and what a restore point is named after.
 *   - the browser and the 8-char id — derived at DISPLAY time from `device_browser` and
 *     `device_id`, so they can never be edited into a name and never go stale.
 *
 * Two installs of the same OS still tell apart, because the extra id is shown next to
 * the name wherever two devices are listed.
 */
export function defaultDeviceLabel(): string {
  return detectDeviceOs();
}

// ─── Default Settings ──────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: SyncSettings = {
  // Intentionally EMPTY: the real identity is minted and persisted by getSettings().
  // This used to be a module-load `crypto.randomUUID()`, which meant every extension
  // context — service worker, popup, options, onboarding — carried its own different
  // default, and nothing ever wrote it down. See getSettings().
  device_id: "",
  // Just the OS. The browser and the short id are shown next to this name, not inside it.
  device_label: detectDeviceOs(),
  // Bookmarks only by default. The extension list is fingerprint-grade data and
  // history/tabs are sensitive, so those are opt-in (turned on in onboarding/settings).
  enabled_types: ["bookmarks"],
  backends: [],
  active_backend: null,
  sync_interval_seconds: 60,
  conflict_strategy: "lww",
  // Per-type overrides start empty: the global strategy above is the whole answer until
  // somebody asks for a different one on a specific type.
  conflict_strategies: {},
  // Peers' recorded moves win, which is what makes two browsers converge on one order.
  bookmark_order_mode: "lww",
  // A merge that removes a meaningful number of bookmarks here gets a restore point first.
  auto_restore_point: true,
  // Keep recent open-tab sessions locally so a crash does not lose the window.
  session_autosave_enabled: true,
  history_days_limit: 30,
  bulk_delete_percent: 60,
  excluded_bookmarks: [],
  auto_sync: true,
  sync_on_change: true,
  notifications_enabled: true,
  debug_mode: false,
  encryption_enabled: false,
  onboarding_completed: false,
  // Local change guard (lib/sync/change-guard.ts). On by default: it only holds publishing
  // when this device's bookmarks keep changing by a large amount across cycles, never a
  // single ordinary edit. guard_cap is the absolute floor (entries/cycle) before the
  // 30%-of-tree check; both are overridable in Settings → Advanced.
  guard_enabled: true,
  guard_cap: 20,
  // AI helper: OFF until the user opts in. No default endpoint and no default key, so a
  // fresh install cannot send a request even if a button is pressed before setup.
  ai_enabled: false,
  ai_base_url: "",
  ai_api_key: "",
  ai_model: "",
};

export const DEFAULT_STATE: SyncState = {
  status: "idle",
  last_sync: null,
  last_error: null,
  failed_types: [],
  pending_conflicts: [],
  sync_counts: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
  sync_totals: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
  sync_cycles: 0,
  bytes_transferred: 0,
  sync_report: null,
  recovery_notice: null,
  guard_notice: null,
};

// ─── Keys ──────────────────────────────────────────────────────────────────

// The single source of truth for every chrome.storage.local key. Exported so the
// UI reads/writes go through KEYS.* instead of re-typing raw "konode_*" strings
// (a mistyped/legacy literal is what left the options "missing extensions" list
// silently empty).
export const KEYS = {
  SETTINGS: "konode_settings",
  STATE: "konode_state",
  AUDIT_LOG: "konode_audit",
  BOOKMARK_CACHE: "konode_bm_cache",
  BOOKMARK_TOMBSTONES: "konode_bm_tombstones",
  BOOKMARK_MOVES: "konode_bm_moves",
  BOOKMARK_FOLDER_MOVES: "konode_bm_folder_moves",
  // folderMoveKey → the `at` this device CONFIRMED the tree matches that record at. The
  // log alone cannot tell "folded in after the folder landed" from "folded in for a move
  // that never happened" — the second is what an older build left behind, and without this
  // marker it stays "already done" (the comparison is strictly newer-than) forever.
  BOOKMARK_FOLDER_MOVES_VERIFIED: "konode_bm_folder_moves_ok",
  BOOKMARK_TITLES: "konode_bm_titles",
  BOOKMARK_FOLDER_RENAMES: "konode_bm_folder_renames",
  BOOKMARK_FOLDER_DELETES: "konode_bm_folder_deletes",
  BOOKMARK_APPEARED: "konode_bm_appeared",
  BOOKMARK_KEPT_SHELLS: "konode_bm_kept_shells",
  BOOKMARK_CREATED: "konode_bm_created",
  BOOKMARK_PEER_REMOVED: "konode_bm_peer_removed",
  // Superseded by the backend-side `konode_snap_index.json`, which every device can
  // read. Kept only so the one-time migration in sync/snapshots.ts can drain the
  // counts this device recorded before dropping the key.
  LEGACY_SNAPSHOTS: "konode_bm_snapshots",
  // Device-local copy of the annotations for restore points THIS install created or
  // renamed. A rate-limited WebDAV server can refuse the shared index for hours; the
  // copy keeps names, counts and device info visible here without ever writing a file
  // we could not read. Never exported to the backend.
  SNAPSHOT_LOCAL: "konode_snap_local",
  // "Keep forever" requests the storage refused (Nutstore 403). Retried as soon as the
  // backend answers again. Device-local only; never published in a SyncPacket.
  SNAPSHOT_PENDING_PIN: "konode_snap_pending_pin",
  // The last shared snapshot index this device managed to READ. A rate-limited storage
  // refuses the index for whole windows, and without a copy the restore points lose the
  // device that saved them and their bookmark count — the list then shows bare
  // "Bookmark restore point" rows for points that are perfectly well described in the
  // file. A READ-ONLY fallback: it is never written back to the backend, so it cannot
  // resurrect a stale index over a newer one.
  SNAPSHOT_SHARED_CACHE: "konode_snap_shared_cache",
  // Peer packets already downloaded, keyed by their file name and version, so an
  // unchanged peer file can be merged again without another round trip to the storage.
  // Device-local working state; never travels in a SyncPacket.
  PEER_PACKET_CACHE: "konode_peer_packet_cache",
  HIST_IMPORTED: "konode_hist_imported",
  HIST_REJECTED: "konode_hist_rejected",
  HIST_VISITTIME_OK: "konode_hist_visittime_ok",
  TABS_SINGLE_OPEN: "konode_tabs_single_open",
  REMOTE_SESSIONS: "konode_remote_sessions",
  REMOTE_EXTENSIONS: "konode_remote_extensions",
  UPLOAD_CHECKSUMS: "konode_upload_checksums",
  RESOLVED_CONFLICTS: "konode_resolved_conflicts",
  CONFLICT_PACKETS: "konode_conflict_packets",
  RECOVERY_SNAPSHOT: "konode_recovery_snap",
  BULK_DELETE_APPROVAL: "konode_bulk_delete_ok",
  LIST_FAILURE_NOTED: "konode_list_fail_noted",
  // Per-install first-sync decision. Deliberately NOT part of SettingsBackup: a device
  // restored from another browser's config MUST make its own choice, not inherit one.
  // Never travels in a SyncPacket.
  FIRST_SYNC: "konode_first_sync",
  // The last bookmark-baseline marker this device read, so Activity can still name it
  // inside a rate-limit window. Read-only cache: the shared file stays the source of truth.
  BASELINE_CACHE: "konode_baseline_cache",
  // Which baseline generation THIS device has already applied. Per-install working state:
  // a settings import that mints a new identity must not inherit "already aligned", or the
  // browser would keep a tree that was never replaced. Never travels in a SyncPacket.
  BASELINE_ADOPTED: "konode_baseline_adopted",
  // Once per incident: the user was told that the storage no longer holds the bookmark
  // baseline this browser set. The condition is re-read on every page load, so the note
  // would otherwise fill the Activity log (200 entries) with the same sentence.
  BASELINE_STALE_NOTED: "konode_baseline_stale_noted",
  // Local change guard (lib/sync/change-guard.ts): the last bookmark tree this device
  // published, and a once-per-incident latch for its restore point. Both are per-install
  // working state and never travel in a SyncPacket.
  GUARD_STATE: "konode_guard_state",
  GUARD_SNAPSHOT: "konode_guard_snap",
  // Once per dangerous-merge episode: the pre-apply restore point the sync takes before
  // folding in a bulk deletion. Same reasoning as GUARD_SNAPSHOT — the same peer tombstones
  // are re-evaluated every cycle, and a point per minute would evict the ring it is meant
  // to protect. Cleared by the first cycle that removes nothing large.
  DANGER_SNAPSHOT: "konode_danger_snap",
  // The user's one-shot "don't show the coexist tip again" for the local change guard.
  // Set by the popup, read there; the guard itself never touches it.
  GUARD_WARNED: "konode_guard_warned",
  SYNC_LOCK: "konode_sync_lock",
  // Automatic sync is parked until this timestamp after the storage meters us (429, or
  // Nutstore's 403). Device-local working state only; never travels in a SyncPacket.
  SYNC_COOLDOWN_UNTIL: "konode_sync_cooldown_until",
  // The last failure automatic sync ran into, how many cycles in a row said the same
  // thing, and when it may try again. Separate from the cooldown above: that one is a
  // known-length window, this one is "the same error, again". Device-local only.
  SYNC_FAILURE: "konode_sync_failure",
  GDRIVE_SESSION: "konode_gdrive_session",
  GDRIVE_FOLDER: "konode_gdrive_folder",
  ONBOARDING_DRAFT: "konode_onboarding_draft",
  // The one-time rating card (lib/rate-prompt.ts). Two keys because two contexts write:
  // the service worker counts into PROGRESS, the popup records the answer in ANSWERED.
  RATE_PROGRESS: "konode_rate_progress",
  RATE_ANSWERED: "konode_rate_answered",
  // Receipts for recent syncs, newest first, capped in lib/sync/sync-report.ts. Device-
  // local: what THIS device saw change is not something a peer needs.
  SYNC_REPORTS: "konode_sync_reports",
  // Device-local ring of recent open-tab sessions (lib/session-autosave.ts). Never part of
  // a SyncPacket; the synced sessions file is a separate, explicitly enabled thing.
  SESSION_AUTOSAVE: "konode_session_autosave",
  // Set by the settings page just before the extension replaces its own files and
  // restarts. The page that started the upgrade is gone when the new version comes up,
  // so the service worker reads this and opens the settings page again — otherwise the
  // upgrade ends with the user's screen empty and no sign it worked. Device-local, and
  // cleared as soon as it has been read.
  UPGRADE_PENDING: "konode_upgrade_pending",
} as const;

// ─── Generic Helpers ───────────────────────────────────────────────────────

async function get<T>(key: string, fallback: T): Promise<T> {
  const result = await browser.storage.local.get(key);
  return (result[key] as T) ?? fallback;
}

async function set(key: string, value: unknown): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

// ─── Serialized read-modify-write ──────────────────────────────────────────
// `chrome.storage.local` has no atomic update, so every get → mutate → set pair is
// a lost-update race. Bookmark bursts make that concrete: Chrome fires one
// `onRemoved` per removed node, so deleting five selected bookmarks starts five
// overlapping recordRemovedTombstones() runs that all read the SAME list and then
// clobber one another. Deletions were silently lost and the bookmarks came back
// from a peer on the next merge — the deletion-propagation model's whole point.
//
// `updateKey` chains updates per key, so each one observes every write before it.
// This guards a single JS context, which is where the bursts happen: the bookmark
// listeners and the sync engine all live in the service worker.

const updateChains = new Map<string, Promise<unknown>>();

export function updateKey<T>(key: string, mutate: (current: T) => T, fallback: T): Promise<T> {
  const run = async (): Promise<T> => {
    const next = mutate(await get<T>(key, fallback));
    await set(key, next);
    return next;
  };
  // Continue on both settle paths, so one failed update can't wedge the key.
  const chained = (updateChains.get(key) ?? Promise.resolve()).then(run, run);
  updateChains.set(key, chained.catch(() => {}));
  return chained;
}

// ─── Settings ──────────────────────────────────────────────────────────────

/**
 * Settings, with a STABLE device identity guaranteed.
 *
 * Every synced file is named `konode_<type>_<device_id>.json`, so the id must never
 * change: a new one means a fresh set of files on the backend while the old ones linger as
 * orphans forever. It used to be a module-load `crypto.randomUUID()` in DEFAULT_SETTINGS
 * that this function merged in but never PERSISTED — so until something happened to call
 * saveSettings(), the answer differed per extension context (each has its own module
 * instance) and per worker wake.
 *
 * That is not cosmetic. `konode_upload_checksums` is a separate key, so a device_id that
 * changed while those survived left the NEW identity's file unwritten for any payload
 * static enough not to change on its own — which is exactly the installed-extension list.
 * It matches a field report where two devices each had an extensions file that was never
 * uploaded and an orphan file from a third id sitting next to them.
 *
 * Minted through the serialized `updateKey`, so two contexts reading at the same moment
 * cannot mint two different ids.
 */
/**
 * An active backend with no config row cannot be reached by anything.
 *
 * `active_backend` names the backend; `backends` holds the row that says how to talk to
 * it. The engine looks the row up by that name, and with no row it answers "no backend
 * configured" on every cycle, forever, while the Storage tab shows the provider as ACTIVE
 * and signed in. Reported from a device that switched from Koofr to Google Drive: the
 * OAuth consent succeeded, the refresh token was stored, and every sync after it logged
 * "Active backend config not found".
 *
 * The Storage tab was creating that row only for WebDAV providers, because those have
 * fields to fill in and the row came along with the first one. Drive has no fields at all
 * beyond an optional folder id, so nothing ever created it. That is fixed where it
 * happened, and repaired here as well, for two reasons: a profile already in this state
 * cannot fix itself, and the row carries no user data, so filling in a missing one is
 * the same thing the setup wizard does rather than a guess.
 *
 * Pure, and applied on read rather than written back, so it costs one array lookup and
 * persists on the next save like any other change.
 */
export function ensureActiveBackendConfig(settings: SyncSettings): SyncSettings {
  const type = settings.active_backend;
  if (!type || settings.backends.some((b) => b.type === type)) return settings;
  return {
    ...settings,
    backends: [...settings.backends, { type, label: BACKEND_LABEL[type], enabled: true }],
  };
}

export async function getSettings(): Promise<SyncSettings> {
  // Fallback `{}`, NOT DEFAULT_SETTINGS: "nothing stored" has to be distinguishable so we
  // know to mint an identity, and the defaults get merged over it either way.
  const stored = await get<Partial<SyncSettings>>(KEYS.SETTINGS, {});
  if (stored.device_id) {
    const merged = { ...DEFAULT_SETTINGS, ...stored };
    // Older builds stored `<OS> · <browser> · <short id>` as the label. Hand the user
    // back their own words, and write the cleaned value once so every context (worker,
    // popup, options) agrees instead of each re-deriving it on every read.
    const clean = cleanDeviceLabel(merged.device_label, merged.device_id) || detectDeviceOs();
    if (clean !== merged.device_label) {
      merged.device_label = clean;
      // Re-derive inside the update rather than writing `clean` blindly: if the user
      // renamed the device between the read above and this write, their new name wins.
      const settled = await updateKey<Partial<SyncSettings>>(
        KEYS.SETTINGS,
        (cur) => {
          const now = cleanDeviceLabel(cur.device_label, cur.device_id);
          return now === cur.device_label ? cur : { ...cur, device_label: now || detectDeviceOs() };
        },
        {}
      );
      return ensureActiveBackendConfig({ ...DEFAULT_SETTINGS, ...settled });
    }
    return ensureActiveBackendConfig(merged);
  }
  const settled = await updateKey<Partial<SyncSettings>>(
    KEYS.SETTINGS,
    (cur) => {
      if (cur.device_id) return cur;
      const device_id = crypto.randomUUID();
      // Keep a label the user already chose; otherwise give this identity a default
      // that cannot collide with another machine of the same make.
      return {
        ...cur,
        device_id,
        device_label: cleanDeviceLabel(cur.device_label, device_id) || defaultDeviceLabel(),
      };
    },
    {}
  );
  return ensureActiveBackendConfig({ ...DEFAULT_SETTINGS, ...settled });
}

/**
 * The bookmarks this device keeps out of sync (#54), straight from the stored settings.
 *
 * Not through getSettings(): the bookmark listeners ask on every event, and getSettings()
 * mints a device id when there is none, which is no business of a bookmark recorder.
 */
export async function getBookmarkExclusions(): Promise<BookmarkExclusion[]> {
  const stored = await get<Partial<SyncSettings>>(KEYS.SETTINGS, {});
  return sanitizeExclusions(stored.excluded_bookmarks);
}

/**
 * The order mode, straight from stored settings, for the bookmark publisher. Like the
 * exclusions reader above this avoids getSettings() (which mints a device id). An absent
 * or unrecognized value is the historical default, "lww".
 */
export async function getBookmarkOrderMode(): Promise<BookmarkOrderMode> {
  const stored = await get<Partial<SyncSettings>>(KEYS.SETTINGS, {});
  const mode = stored.bookmark_order_mode;
  return mode === "keep-local" || mode === "browser" ? mode : "lww";
}

export async function saveSettings(partial: Partial<SyncSettings>): Promise<SyncSettings> {
  // Read-modify-write of the WHOLE settings object, so two contexts saving at the same
  // moment (options changing the passphrase while the popup disconnects a backend) used
  // to drop one of the two changes. Runs under the same key lock as everything else.
  // getSettings() is called first, not inside: it may itself take that lock to mint the
  // device identity, and waiting for it from within the update would deadlock.
  await getSettings();
  const next = await updateKey<SyncSettings>(KEYS.SETTINGS, (stored) => {
    const merged = ensureActiveBackendConfig({ ...DEFAULT_SETTINGS, ...stored, ...partial });
    // One choke point for the label, so the machine halves can never be written back in:
    // a name pasted from an old build's Activity log, or typed with a trailing "· Edge",
    // is stored as the words alone. The browser and the id are shown next to it.
    if (partial.device_label !== undefined) {
      merged.device_label = cleanDeviceLabel(partial.device_label, merged.device_id) || defaultDeviceLabel();
    }
    // 口令强度兜底：即使绕过 UI 直接发消息，启用 E2EE 时也不允许过短口令（离线可暴力）。
    if (passphraseViolatesPolicy(merged)) {
      throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters when E2EE is enabled.`);
    }
    return merged;
  }, DEFAULT_SETTINGS);
  // A mode change has to take effect in THIS worker, not after the next service-worker
  // wake: the naming helpers the backends use read the active mode at call time.
  setCompatMode(next.compat_mode);
  return next;
}

// ─── Settings backup ───────────────────────────────────────────────────────

/**
 * Carry configuration across an extension-ID change.
 *
 * chrome.storage.local is isolated per extension ID. An unpacked build with no pinned
 * manifest `key` derives its ID from the folder it was loaded from, so moving to a new
 * version folder gives Chrome a brand-new (empty) storage area. These two functions are
 * the bridge: export from the old ID, import into the new one. They are also the recovery
 * path for a new browser profile or a reinstall.
 *
 * ONLY configuration travels. Tombstones, the bookmark cache, conflict packets, upload
 * checksums and the sync lock describe what THIS install has already merged; replaying
 * them onto a fresh install would make a device that has seen nothing claim it had seen
 * everything. The synced data itself lives in the user's backend and is not in this file.
 */
export const SETTINGS_BACKUP_FORMAT = "kesonode-settings";

/**
 * The version this build WRITES.
 *
 * v2 does not change what a setting means; it changes what a file is allowed to contain.
 * v1 carried every credential in plain text, so a reader that accepts one must keep the
 * "this file has secrets" confirmation. v2 says what happened to them (`credentials`):
 * left out, encrypted, or present because the user chose an encrypted export. A v1-era
 * build refuses v2 outright, which is what stops it from importing a redacted file and
 * overwriting a live password with an empty string.
 */
export const SETTINGS_BACKUP_VERSION = 2;

/** Versions this build can READ. Unknown versions are refused, never guessed at. */
export const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [1, SETTINGS_BACKUP_VERSION];

export type BackupDocument = Record<string, unknown>;
export type BackupMigration = (doc: BackupDocument) => BackupDocument;

/**
 * One link per old version, each producing the next.
 *
 * v1 → v2 is the same document with its secrets accounted for: every v1 file holds them,
 * so it reads as `included`. Nothing else moved, which is why there is no shape to rewrite.
 */
export const BACKUP_MIGRATIONS: Readonly<Record<number, BackupMigration>> = {
  1: (doc) => ({ ...doc, version: 2, credentials: "included" }),
};

/**
 * Bring a document up to `current` through the chain. Pure and parameterised so the
 * mechanism can be tested with a synthetic chain before a v2 exists. A missing link is
 * an error rather than a silent skip: reading a file under rules that do not apply is
 * worse than refusing it.
 */
export function migrateBackupDocument(
  doc: BackupDocument,
  from: number,
  current: number,
  migrations: Readonly<Record<number, BackupMigration>>
): BackupDocument {
  let result = doc;
  for (let version = from; version < current; version++) {
    const migrate = migrations[version];
    if (!migrate) {
      throw new Error(
        `No settings backup migration from format version ${version}. ` +
          "Refusing to read this file under rules that may not apply."
      );
    }
    result = migrate(result);
  }
  return result;
}

const SETTINGS_BACKUP_KEYS = [KEYS.GDRIVE_SESSION, KEYS.GDRIVE_FOLDER] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── The single source of truth for what travels in a settings backup ───────
//
// The old whitelist was derived from Object.keys(DEFAULT_SETTINGS) plus two hand-added
// optional fields. Any new setting that existed only in SyncSettings was therefore
// EXPORTED but silently DROPPED on import. Typing this as Record<keyof SyncSettings, …>
// makes adding a setting a compile error until it gets a validator here; export and
// import both read this one table, so they cannot disagree about what is portable.

export interface BackupField {
  validate: (value: unknown) => boolean;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isPositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const oneOf = (values: readonly string[]) => (v: unknown): boolean =>
  typeof v === "string" && values.includes(v);
const arrayOf = (check: (v: unknown) => boolean) => (v: unknown): boolean =>
  Array.isArray(v) && v.every(check);

const DATA_TYPES: readonly string[] = ["bookmarks", "history", "sessions", "extensions"];
const BACKEND_TYPES: readonly string[] = ["gdrive", "webdav", "github"];
const CONFLICT_STRATEGIES: readonly string[] = ["lww", "prefer-local", "prefer-remote", "manual"];
const COMPAT_MODES: readonly string[] = ["upstream", "isolated", "standalone"];

// A device id becomes a file name on the backend; a sub-path becomes extra path segments.
// Both arrive from an untrusted backup, so neither may carry traversal ("..", separators,
// backslashes) or a non-http scheme that would send authenticated requests elsewhere.
const isSafeDeviceId = (v: unknown): v is string =>
  isString(v) && v.length > 0 && /^[A-Za-z0-9-]+$/.test(v);
const isSafeSubPath = (v: unknown): boolean =>
  v === undefined
  || (isString(v) && !v.startsWith("/") && !v.includes("\\") && !v.includes("\0")
    && v.split("/").every((seg) => seg !== ".." && seg !== "."));
const backendTargetSafe = (b: Record<string, unknown>): boolean => {
  const w = isRecord(b.webdav) ? b.webdav : null;
  const g = isRecord(b.github) ? b.github : null;
  if (w && !isSafeSubPath(w.path)) return false;
  if (g && !isSafeSubPath(g.path)) return false;
  if (w && isString(w.url) && w.url !== "") {
    try {
      const protocol = new URL(w.url).protocol;
      if (protocol !== "http:" && protocol !== "https:") return false;
    } catch {
      return false;
    }
  }
  return true;
};

export const SETTINGS_BACKUP_SCHEMA: Record<keyof SyncSettings, BackupField> = {
  device_id: { validate: isSafeDeviceId },
  device_label: { validate: isString },
  enabled_types: { validate: arrayOf(oneOf(DATA_TYPES)) },
  backends: { validate: arrayOf((b) => isRecord(b) && oneOf(BACKEND_TYPES)(b.type) && backendTargetSafe(b)) },
  active_backend: { validate: (v) => v === null || oneOf(BACKEND_TYPES)(v) },
  sync_interval_seconds: { validate: isPositiveNumber },
  conflict_strategy: { validate: oneOf(CONFLICT_STRATEGIES) },
  conflict_strategies: {
    validate: (v) =>
      isRecord(v) &&
      Object.entries(v).every(([type, strategy]) =>
        DATA_TYPES.includes(type) && oneOf(CONFLICT_STRATEGIES)(strategy),
      ),
  },
  bookmark_order_mode: { validate: oneOf(["lww", "keep-local", "browser"]) },
  auto_restore_point: { validate: isBoolean },
  session_autosave_enabled: { validate: isBoolean },
  history_days_limit: { validate: isPositiveNumber },
  bulk_delete_percent: { validate: (v) => isPositiveNumber(v) && v <= 100 },
  excluded_bookmarks: { validate: (v) => Array.isArray(v) },
  auto_sync: { validate: isBoolean },
  sync_on_change: { validate: isBoolean },
  notifications_enabled: { validate: isBoolean },
  debug_mode: { validate: isBoolean },
  encryption_enabled: { validate: isBoolean },
  encryption_passphrase: { validate: isString },
  onboarding_completed: { validate: isBoolean },
  compat_mode: { validate: oneOf(COMPAT_MODES) },
  guard_enabled: { validate: isBoolean },
  // Capped so a typo can't disable the guard entirely: a cap of 0 would hold every cycle,
  // so the lower bound is 1; the upper bound keeps it from swallowing a whole large tree.
  guard_cap: { validate: (v) => isPositiveNumber(v) && v <= 1000 },
  // The AI key is validated here only so it can be restored from an (encrypted) backup
  // that explicitly carries it. exportSettingsBackup removes it from EVERY exported file;
  // see the delete below. The base URL is validated on use by aiEndpoint() instead.
  ai_enabled: { validate: isBoolean },
  ai_base_url: { validate: isString },
  ai_api_key: { validate: isString },
  ai_model: { validate: isString },
};

export const BACKUP_SETTINGS_FIELDS = Object.keys(SETTINGS_BACKUP_SCHEMA) as (keyof SyncSettings)[];

/** Strip everything that authenticates: password, token, refresh token, passphrase. */
function withoutSecrets(backend: BackendConfig): BackendConfig {
  return {
    ...backend,
    ...(backend.webdav ? { webdav: { ...backend.webdav, password: "" } } : {}),
    ...(backend.github ? { github: { ...backend.github, token: undefined } } : {}),
  };
}

export interface ExportSettingsOptions {
  /**
   * Write the secrets into the file. There is no default: a caller that wants them must
   * say so, and is expected to encrypt the result with `encryptSettingsBackup` before it
   * reaches disk. This function never encrypts, so a plaintext file holding credentials
   * cannot be produced by forgetting a step.
   */
  includeCredentials?: boolean;
}

/**
 * The configuration as a restorable document.
 *
 * By DEFAULT the file carries no secrets at all. It still describes the whole setup —
 * servers, folders, repositories, schedules, preferences, the device identity — so a
 * restore recreates the configuration; what it cannot do is sign in, and the import path
 * asks for the pieces it is missing (or keeps the ones this install already holds).
 * Credentials are only ever written when the caller explicitly asks, and then into a
 * file that is encrypted before download.
 */
export async function exportSettingsBackup(
  extensionVersion: string,
  options: ExportSettingsOptions = {},
): Promise<SettingsBackup> {
  const raw = await browser.storage.local.get([...SETTINGS_BACKUP_KEYS]);
  // getSettings() merges the defaults and mints the device id if this install somehow
  // never had one, so the file is always a complete, restorable configuration. Export
  // exactly the schema's fields: no per-install working state, and no field the importer
  // would not know how to restore.
  const current = await getSettings();
  const portable: Record<string, unknown> = {};
  for (const field of BACKUP_SETTINGS_FIELDS) {
    const value = current[field];
    if (value !== undefined) portable[field] = value;
  }
  // The AI key is NOT a Kesonode credential and is never portable, not even in the
  // encrypted "include credentials" file. A settings export is a file people move
  // between machines and sometimes paste into an issue; an LLM API key must not travel
  // with it. On import the absent field means "keep what this install has".
  delete portable.ai_api_key;

  if (!options.includeCredentials) {
    // Missing, not empty: the importer's rule for an absent field is "keep what this
    // install has", which is what lets someone re-import their own safe backup without
    // being signed out of every account.
    delete portable.encryption_passphrase;
    portable.backends = ((portable.backends as BackendConfig[] | undefined) ?? []).map(withoutSecrets);
    return withChecksum({
      format: SETTINGS_BACKUP_FORMAT,
      version: SETTINGS_BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      extensionVersion,
      credentials: "redacted",
      keys: { settings: portable as unknown as SyncSettings },
    });
  }

  const keys: NonNullable<SettingsBackup["keys"]> = { settings: portable as unknown as SyncSettings };
  // Stored verbatim: a future session shape must not need a new backup format.
  if (raw[KEYS.GDRIVE_SESSION] !== undefined) keys.gdriveSession = raw[KEYS.GDRIVE_SESSION];
  if (raw[KEYS.GDRIVE_FOLDER] !== undefined) keys.gdriveFolder = raw[KEYS.GDRIVE_FOLDER];
  return withChecksum({
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    extensionVersion,
    credentials: "included",
    keys,
  });
}

/**
 * Shrink a credentials-bearing backup into one that holds none in the clear.
 *
 * The whole `keys` object is encrypted (AES-256-GCM, salt + IV + ciphertext, base64, the
 * same frozen derivation the synced data uses). Everything the envelope must say without
 * decrypting — format, version, timestamps — stays outside; anything naming a server, an
 * account, a token or the passphrase moves inside. The checksum is over the ciphertext,
 * so damage is still detected before a password is asked for.
 */
export async function encryptSettingsBackup(
  backup: SettingsBackup,
  password: string,
): Promise<SettingsBackup> {
  if (!backup.keys) throw new Error("This settings backup has no contents to encrypt.");
  const ciphertext = await encrypt(JSON.stringify(backup.keys), password);
  return withChecksum({
    format: SETTINGS_BACKUP_FORMAT,
    version: SETTINGS_BACKUP_VERSION,
    exportedAt: backup.exportedAt,
    extensionVersion: backup.extensionVersion,
    credentials: "encrypted",
    ciphertext,
  });
}

/**
 * Open an encrypted backup into the document the importer understands.
 *
 * A wrong password and a damaged ciphertext are indistinguishable to AES-GCM's
 * authentication tag; saying so is the honest answer rather than guessing which it was.
 * The page calls this before showing the import risks, because those are read from the
 * decrypted settings — an encrypted file cannot be described without its password.
 */
export async function openSettingsBackup(input: unknown, password: string): Promise<SettingsBackup> {
  if (!isRecord(input) || input.format !== SETTINGS_BACKUP_FORMAT) {
    throw new Error("This is not a Kesonode settings backup.");
  }
  if (input.credentials !== "encrypted" || typeof input.ciphertext !== "string") {
    throw new Error("This settings backup is not encrypted.");
  }
  if (typeof input.version !== "number" || !SUPPORTED_BACKUP_VERSIONS.includes(input.version)) {
    throw new Error("This settings backup was written in a format this build cannot read.");
  }
  await verifyChecksum(input);
  let keys: unknown;
  try {
    keys = JSON.parse(await decrypt(input.ciphertext, password));
  } catch {
    throw new Error("That password did not open the backup, or the file is damaged. Check the password and try again.");
  }
  if (!isRecord(keys) || !isRecord(keys.settings)) {
    throw new Error("The decrypted settings backup is malformed.");
  }
  return {
    format: SETTINGS_BACKUP_FORMAT,
    version: input.version,
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : new Date().toISOString(),
    extensionVersion: typeof input.extensionVersion === "string" ? input.extensionVersion : "",
    credentials: "included",
    keys: keys as NonNullable<SettingsBackup["keys"]>,
  };
}

async function readBackup(input: unknown): Promise<SettingsBackup> {
  if (!isRecord(input) || input.format !== SETTINGS_BACKUP_FORMAT) {
    throw new Error("This is not a Kesonode settings backup.");
  }
  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("This is not a Kesonode settings backup.");
  }
  if (!SUPPORTED_BACKUP_VERSIONS.includes(version)) {
    if (version > SETTINGS_BACKUP_VERSION) {
      throw new Error(
        `This settings backup was written by a newer Kesonode (format version ${version}). ` +
          `Update Kesonode to import it; this build reads ${SUPPORTED_BACKUP_VERSIONS.join(", ")}.`
      );
    }
    throw new Error(
      `Unsupported settings backup format version ${version}. ` +
        `This build reads ${SUPPORTED_BACKUP_VERSIONS.join(", ")}.`
    );
  }
  // After the version gate, so a newer file is reported as newer rather than as damaged.
  // A missing checksum means a file written before the field existed: still readable.
  await verifyChecksum(input);
  // The UI opens an encrypted file with its password (`openSettingsBackup`) and sends the
  // result here. Refusing the sealed form keeps this path from ever needing a password,
  // and from accidentally treating ciphertext as an empty configuration.
  if (input.credentials === "encrypted") {
    throw new Error("This settings backup is encrypted. Open it with its password before importing.");
  }
  const doc = migrateBackupDocument(input, version, SETTINGS_BACKUP_VERSION, BACKUP_MIGRATIONS);
  const keys = doc.keys;
  const settings = isRecord(keys) ? keys.settings : undefined;
  if (!isRecord(settings)) throw new Error("The settings backup has no settings.");
  // device_id names the konode_<type>_<device_id>.json files in the backend. Losing it
  // would make the restored device publish as a stranger and re-merge everything.
  if (typeof settings.device_id !== "string" || !settings.device_id) {
    throw new Error("The settings backup has no device ID.");
  }
  return doc as unknown as SettingsBackup;
}

export interface ImportSettingsOptions {
  /**
   * The file came from a DIFFERENT browser or device. Mint a fresh identity instead of
   * copying the old one. Left false (the historical behaviour) only for restoring the
   * SAME device after an extension-ID change or a reinstall.
   */
  asNewDevice?: boolean;
  /**
   * The E2EE passphrase the user typed at import, for a REDACTED backup (which by design
   * carries none). E2EE cannot be enabled here without one, so the caller collects it
   * before asking the worker to write anything.
   */
  e2eePassphrase?: string;
}

/**
 * Fill the secrets a redacted backup deliberately left out from the ones this install
 * already holds, so someone re-importing their own safe backup is not signed out of every
 * account. A backend whose server or account changed keeps nothing: the stored password
 * belonged to the old one.
 */
function keepLocalCredentials(incoming: BackendConfig[], current: BackendConfig[]): BackendConfig[] {
  return incoming.map((backend) => {
    const previous = current.find((b) => b.type === backend.type);
    if (!previous) return backend;
    if (backend.webdav && previous.webdav
      && !backend.webdav.password
      && backend.webdav.url === previous.webdav.url
      && backend.webdav.username === previous.webdav.username) {
      return { ...backend, webdav: { ...backend.webdav, password: previous.webdav.password } };
    }
    if (backend.github && previous.github && !backend.github.token
      && backend.github.repo === previous.github.repo) {
      return { ...backend, github: { ...backend.github, token: previous.github.token } };
    }
    return backend;
  });
}

export async function importSettingsBackup(
  input: unknown, options: ImportSettingsOptions = {},
): Promise<SyncSettings> {
  const backup = await readBackup(input);
  const keys = backup.keys as NonNullable<SettingsBackup["keys"]>;
  const raw = keys.settings as unknown as Record<string, unknown>;
  const redacted = backup.credentials === "redacted";
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>;

  const partial: Record<string, unknown> = {};
  for (const field of BACKUP_SETTINGS_FIELDS) {
    // Missing: a backup written by an OLDER version. Keep this install's value, which
    // is a default on a fresh install — that is what makes old files restorable. A
    // redacted file relies on this too: its credentials are absent on purpose.
    if (!(field in raw)) continue;
    const value = raw[field];
    if (SETTINGS_BACKUP_SCHEMA[field].validate(value)) {
      partial[field] = value;
    } else {
      // Present but unusable: fall back to the default rather than trusting the file.
      // An optional field with no default keeps this install's value instead.
      const fallback = defaults[field];
      if (fallback !== undefined) partial[field] = fallback;
    }
  }
  // Two fields the sync engine iterates without checking. A wrong shape here would break
  // every sync, so make sure they end up valid even when absent or malformed.
  if (!Array.isArray(partial.enabled_types)) partial.enabled_types = DEFAULT_SETTINGS.enabled_types;
  if (!Array.isArray(partial.backends)) partial.backends = DEFAULT_SETTINGS.backends;
  partial.excluded_bookmarks = sanitizeExclusions(partial.excluded_bookmarks);
  // An imported configuration is by definition already set up. Without this the wizard
  // would open on top of restored accounts and ask for them a second time.
  partial.onboarding_completed = true;

  const current = await getSettings();
  if (redacted) {
    // Credentials in this file are placeholders. Whatever this install already holds for
    // the same server/account is kept; a first-time restore simply has none, and the UI
    // tells the user which account to sign in to again.
    partial.backends = keepLocalCredentials(partial.backends as BackendConfig[], current.backends);
    if (options.e2eePassphrase !== undefined) partial.encryption_passphrase = options.e2eePassphrase;
  }

  // Enabling E2EE without a passphrase would make this device publish plaintext while its
  // peers write ciphertext — the "plaintext downgrade" the whole encryption guard exists
  // to prevent. Refused BEFORE saveSettings, so a rejected import writes nothing.
  const passphrase = partial.encryption_passphrase ?? current.encryption_passphrase;
  const encryptionEnabled = partial.encryption_enabled ?? current.encryption_enabled;
  if (encryptionEnabled && !passphrase) {
    throw new Error(
      "This backup enables end-to-end encryption but does not include the passphrase. " +
        "Enter your passphrase to import this configuration."
    );
  }

  // device_id names this install's `konode_<type>_<device_id>.json` files in the shared
  // backend. Copying a config to another browser must NOT copy the id: both installs
  // would then write the same file, each overwriting the other's upload, and the device
  // list would show them as one device. Mint a new id and a label derived from THIS
  // browser, while leaving every account, token, passphrase and preference untouched.
  // The same-device upgrade/reinstall path opts out with { asNewDevice: false }.
  if (options.asNewDevice) {
    const device_id = crypto.randomUUID();
    partial.device_id = device_id;
    // A fresh identity gets this browser's own default name — never the backup's label,
    // which names the machine the backup came from. The old build's suffixed form is
    // stripped first, so importing an old backup doesn't paste `Mac · Edge · 451dbeb9`
    // into the new device's name.
    partial.device_label = defaultDeviceLabel();
    // Upload checksums are keyed by data type and do NOT travel in a backup, so they still
    // describe what the PREVIOUS identity published. A payload that happens to be
    // unchanged (an extension list, a quiet history window) would then be skipped as
    // "already uploaded" and the new id's file would never be written — the orphaned-file
    // symptom getSettings() warns about. One re-upload per type costs little; a missing
    // file costs the device its place in the group.
    await browser.storage.local.remove(KEYS.UPLOAD_CHECKSUMS);
    // "Already aligned with the group baseline" names the OLD identity's tree. This
    // browser now publishes as someone else, so let it check the shared marker again.
    await browser.storage.local.remove([KEYS.BASELINE_ADOPTED, KEYS.BASELINE_CACHE, KEYS.BASELINE_STALE_NOTED]);
  }

  const updated = await saveSettings(partial as Partial<SyncSettings>);

  // The Drive refresh token is device-local too, and is what makes "sign in again"
  // unnecessary after the restore. Clear anything left behind by the previous config
  // when the backup has no session, so a stale account cannot linger — but a redacted
  // backup has no session BY DESIGN, so an import must not sign this device out.
  const writes: Record<string, unknown> = {};
  if (!redacted) {
    if (isRecord(keys.gdriveSession)) writes[KEYS.GDRIVE_SESSION] = keys.gdriveSession;
    if (keys.gdriveFolder !== undefined) writes[KEYS.GDRIVE_FOLDER] = keys.gdriveFolder;
  }
  // 口令强度兜底（同 saveSettings）：导入启用了 E2EE 但口令过短的备份同样拒绝，
  // 防止社工构造弱口令备份绕过 UI 校验。
  if (passphraseViolatesPolicy(updated)) {
    throw new Error(`Import refused: with E2EE enabled the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  if (Object.keys(writes).length) await browser.storage.local.set(writes);
  if (!redacted) {
    if (!(KEYS.GDRIVE_SESSION in writes)) await browser.storage.local.remove(KEYS.GDRIVE_SESSION);
    if (!(KEYS.GDRIVE_FOLDER in writes)) await browser.storage.local.remove(KEYS.GDRIVE_FOLDER);
  }

  return updated;
}

/**
 * The connection target of a backend, independent of its credentials: the server/account/
 * folder that data would actually be written to. Two backends of the same TYPE can point
 * at different servers, so a type-only comparison misses a redirect.
 */
function backendEndpoint(backend: unknown): string | null {
  const bo = isRecord(backend) ? backend : null;
  if (!bo || typeof bo.type !== "string") return null;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (bo.type === "webdav") {
    const w = isRecord(bo.webdav) ? bo.webdav : null;
    return `webdav|${s(w?.url)}|${s(w?.username)}|${s(w?.path)}`;
  }
  if (bo.type === "github") {
    const g = isRecord(bo.github) ? bo.github : null;
    return `github|${s(g?.repo)}|${s(g?.branch)}|${s(g?.path)}`;
  }
  if (bo.type === "gdrive") {
    const d = isRecord(bo.gdrive) ? bo.gdrive : null;
    return `gdrive|${s(d?.folderId)}`;
  }
  return bo.type;
}

/**
 * Detect the settings-backup import changes that an attacker would abuse to exfiltrate
 * data: turning E2EE off, redirecting the backend to a server they control, or carrying
 * plaintext credentials. The IMPORT_SETTINGS handler refuses any of these unless the
 * message carries an explicit `confirmImport` flag set by a user who has been shown the
 * risk. An empty result means the import is benign (e.g. restoring one's own backup with
 * identical settings).
 */
export function importSettingsRisks(current: SyncSettings, input: unknown): string[] {
  const risks: string[] = [];
  if (!input || typeof input !== "object") return risks;
  const rec = input as Record<string, unknown>;
  const keyRec = rec.keys && typeof rec.keys === "object" ? (rec.keys as Record<string, unknown>) : undefined;
  const inRec = keyRec?.settings && typeof keyRec.settings === "object"
    ? (keyRec.settings as Record<string, unknown>)
    : undefined;

  if (inRec && current.encryption_enabled && inRec.encryption_enabled === false) {
    risks.push("disables-e2ee");
  }
  if (typeof inRec?.active_backend === "string" && inRec.active_backend !== current.active_backend) {
    risks.push("changes-backend");
  }
  // Same type but a different server/account/folder is still a redirect: a crafted backup
  // that keeps active_backend:"webdav" while pointing webdav.url at an attacker host must
  // not import silently.
  if (!risks.includes("changes-backend") && inRec) {
    const activeType = typeof inRec.active_backend === "string" ? inRec.active_backend : current.active_backend;
    const curSig = backendEndpoint(current.backends?.find((b) => b.type === activeType));
    const inBackends = Array.isArray(inRec.backends) ? inRec.backends : [];
    const inSig = backendEndpoint(inBackends.find((b) => isRecord(b) && b.type === activeType));
    if (curSig !== null && (inSig === null || inSig !== curSig)) risks.push("changes-backend");
  }
  if (Array.isArray(inRec?.backends) && inRec.backends.some((b) => {
    const bo = b && typeof b === "object" ? (b as Record<string, unknown>) : null;
    const wo = bo?.webdav && typeof bo.webdav === "object" ? (bo.webdav as Record<string, unknown>) : null;
    const go = bo?.github && typeof bo.github === "object" ? (bo.github as Record<string, unknown>) : null;
    return (typeof wo?.password === "string" && wo.password !== "")
      || (typeof go?.token === "string" && go.token !== "");
  })) {
    risks.push("has-credentials");
  }
  if (keyRec?.gdriveSession) risks.push("has-gdrive-session");
  return risks;
}

// ─── State ─────────────────────────────────────────────────────────────────

export async function getState(): Promise<SyncState> {
  const state = await get<SyncState>(KEYS.STATE, DEFAULT_STATE);
  // The head card reads state.sync_report directly; a malformed one must not reach it.
  return isSyncReport(state.sync_report) ? state : { ...state, sync_report: null };
}

export function setState(partial: Partial<SyncState> | ((current: SyncState) => Partial<SyncState>)): Promise<SyncState> {
  return updateKey<SyncState>(KEYS.STATE, (current) => ({
    ...current,
    ...(typeof partial === "function" ? partial(current) : partial),
  }), DEFAULT_STATE);
}

// ─── Sync receipts ─────────────────────────────────────────────────────────

/** How many receipts Activity keeps. Enough to see a pattern, small enough to stay free. */
export const MAX_SYNC_REPORTS = 30;

const isSyncTypeReport = (value: unknown): boolean =>
  isRecord(value)
  && typeof value.data_type === "string"
  && typeof value.added === "number"
  && typeof value.removed === "number";

// The Activity card calls .toLocaleString() on the totals and maps the type rows, so a
// receipt missing those fields must be dropped here rather than crash the whole page.
const isSyncReport = (value: unknown): value is SyncReport =>
  isRecord(value)
  && typeof value.at === "string"
  && typeof value.duration_ms === "number"
  && typeof value.added === "number"
  && typeof value.removed === "number"
  && typeof value.total_before === "number"
  && typeof value.total_after === "number"
  && typeof value.dangerous === "boolean"
  && Array.isArray(value.types)
  && value.types.every(isSyncTypeReport);

const isAutosavedSession = (value: unknown): value is AutosavedSession =>
  isRecord(value)
  && typeof value.id === "string"
  && typeof value.saved_at === "string"
  && Array.isArray(value.tabs);

export async function getSyncReports(): Promise<SyncReport[]> {
  const raw = await get<unknown>(KEYS.SYNC_REPORTS, []);
  // Storage is shared with older builds and partially written imports; a single bad
  // entry must not take the whole Activity list (and its previews) down with it.
  return Array.isArray(raw) ? raw.filter(isSyncReport) : [];
}

/**
 * Append a receipt, newest first.
 *
 * Uses `updateKey` because a manual sync and an automatic one can overlap at the storage
 * level even though the engine serializes the work; a plain read-then-write here would
 * drop whichever finished first.
 */
export async function appendSyncReport(report: SyncReport): Promise<void> {
  await updateKey<SyncReport[]>(
    KEYS.SYNC_REPORTS,
    (current) => [report, ...current].slice(0, MAX_SYNC_REPORTS),
    []
  );
}

/**
 * Drop every receipt, including the one the state still points at — otherwise Activity's
 * "last cycle" card would resurrect the newest receipt from the state after a clear.
 */
export async function clearSyncReports(): Promise<void> {
  await updateKey<SyncReport[]>(KEYS.SYNC_REPORTS, () => [], []);
  await setState({ sync_report: null });
}

// ─── Autosaved sessions ────────────────────────────────────────────────────

export async function getAutosavedSessions(): Promise<AutosavedSession[]> {
  const raw = await get<unknown>(KEYS.SESSION_AUTOSAVE, []);
  return Array.isArray(raw) ? raw.filter(isAutosavedSession) : [];
}

export async function setAutosavedSessions(list: AutosavedSession[]): Promise<void> {
  // updateKey, not set: an autosave can land while a prune or restore is mid-write, and a
  // plain read-then-write here would drop whichever finished first.
  await updateKey<AutosavedSession[]>(KEYS.SESSION_AUTOSAVE, () => list, []);
}

// ─── First-sync direction ─────────────────────────────────────────────────

/**
 * Whether this install has already answered the "which side wins" question, and what it
 * chose. Per-install working state: it is NOT in SETTINGS_BACKUP_KEYS, so importing a
 * config from another browser leaves a fresh install undecided, which is exactly the
 * point — that device has its own bookmarks and its own decision to make.
 */
export interface FirstSyncRecord {
  done: boolean;
  choice?: FirstSyncChoice;
  at?: string;
}

export async function getFirstSync(): Promise<FirstSyncRecord | null> {
  return get<FirstSyncRecord | null>(KEYS.FIRST_SYNC, null);
}

export async function setFirstSync(record: FirstSyncRecord): Promise<void> {
  await set(KEYS.FIRST_SYNC, record);
}

// ─── Audit Log ─────────────────────────────────────────────────────────────

/**
 * `level` says what an entry MEANS; `ok` says only whether it went well.
 *
 * Two states were being asked to carry a three-state idea. logger has five levels but
 * flattened them onto `ok` at write time — warn and error both wrote `ok: false` — so a
 * warning and a failure were identical in STORAGE, not merely rendered alike. The
 * information was gone before the UI ever saw it, and since almost every deliberate
 * "we're not syncing this" path is a warn, a normal import painted the log red. A field
 * report put it at 176 of 188 entries flagged as errors, nearly all of them benign.
 *
 * Optional on purpose: entries already on users' devices have no `level`, and the renderer
 * falls back to `ok` for those. `ok` is still written, so nothing that reads it breaks.
 */
export type AuditLevel = "ok" | "notice" | "error";

export interface AuditEntry {
  timestamp: string;
  action: string;
  detail?: string;
  ok: boolean;
  level?: AuditLevel;
  /** How many times this line was written, when more than once (see appendAudit). */
  count?: number;
  /** When it was written last, when more than once. `timestamp` stays the first time. */
  last?: string;
}

const AUDIT_CAP = 200;

/**
 * A warning or error written again within this long of its last time is the same condition
 * still going on, not a new one.
 *
 * Most of what reaches the log as a warning is a state, re-checked every sync: a permission
 * taken away, a peer whose passphrase differs, a file that will not download, a server that
 * redirects. Each wrote a line per cycle for as long as it lasted, and a passphrase mismatch
 * one per peer per data type, so three peers filled all 200 entries in about 17 minutes and
 * evicted the very event that explained them. An hour is several syncs at the longest
 * interval (600s), so a condition that is still there keeps its one entry, and one that
 * comes back after the browser was closed for the evening gets a new one.
 */
const AUDIT_REPEAT_MS = 60 * 60 * 1000;

export async function appendAudit(entry: AuditEntry): Promise<void> {
  // Serialized: the logger calls this without awaiting, so a sync emits several
  // overlapping appends and a plain get→set pair dropped all but the last.
  await updateKey<AuditEntry[]>(KEYS.AUDIT_LOG, (log) => {
    // Only warnings and errors fold. Events and Debug-mode lines are a timeline, where the
    // same words at two different moments are two different things to see.
    if (entry.level === "notice" || entry.level === "error") {
      // The newest entry with the same words, reached across other warnings and errors only.
      // Those are the rest of the same cycles (three peers each on the wrong passphrase
      // interleave), but an event in between means something happened: a merge, a restore,
      // the folder readable again. Folding across it would put the repeat before the thing
      // it came after, so the event ends the run and the warning starts a new entry. The
      // folded entry keeps its place, so the log reads in the order things began.
      let i = -1;
      for (let k = 0; k < log.length; k++) {
        const e = log[k];
        if (e.level === entry.level && e.action === entry.action && e.detail === entry.detail) { i = k; break; }
        if ((e.level ?? (e.ok ? "ok" : "error")) === "ok") break;
      }
      const prev = i >= 0 ? log[i] : undefined;
      const at = Date.parse(entry.timestamp);
      const seen = prev ? Date.parse(prev.last ?? prev.timestamp) : NaN;
      if (prev && at - seen <= AUDIT_REPEAT_MS) {
        const next = [...log];
        next[i] = { ...prev, count: (prev.count ?? 1) + 1, last: at >= seen ? entry.timestamp : prev.last };
        return next;
      }
    }
    return [entry, ...log].slice(0, AUDIT_CAP);
  }, []);
}

// ─── Caches ────────────────────────────────────────────────────────────────

export async function getBookmarkCache<T>(): Promise<T | null> {
  return get<T | null>(KEYS.BOOKMARK_CACHE, null);
}

export async function setBookmarkCache<T>(data: T): Promise<void> {
  await set(KEYS.BOOKMARK_CACHE, data);
}

export async function getTombstones(): Promise<Tombstone[]> {
  return get<Tombstone[]>(KEYS.BOOKMARK_TOMBSTONES, []);
}

export async function setTombstones(list: Tombstone[]): Promise<void> {
  await set(KEYS.BOOKMARK_TOMBSTONES, list);
}

// Per-URL "last (re)placed at" log, so bookmark MOVES propagate with LWW
// (folders carry no identity; a move keeps the URL but changes its parent).
export async function getMoves(): Promise<MoveRecord[]> {
  return get<MoveRecord[]>(KEYS.BOOKMARK_MOVES, []);
}

export async function setMoves(list: MoveRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_MOVES, list);
}

// Per-path "folder last repositioned at" log, so a folder reordered among its
// siblings propagates with LWW (a folder has no URL, so the URL move-log above
// can't describe it — see FolderMoveRecord).
export async function getFolderMoves(): Promise<FolderMoveRecord[]> {
  return get<FolderMoveRecord[]>(KEYS.BOOKMARK_FOLDER_MOVES, []);
}

export async function setFolderMoves(list: FolderMoveRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_FOLDER_MOVES, list);
}

// Serialized read-modify-write for the three change logs (see `updateKey`). Every
// caller that APPENDS to a log — the bookmark listeners, which run unawaited and in
// bursts — must go through these, not a get/set pair, or concurrent events overwrite
// each other and the deletion/move is silently lost. `setX` remains for callers that
// replace the whole log wholesale (the merge, restore, tests).

export function updateTombstones(mutate: (current: Tombstone[]) => Tombstone[]): Promise<Tombstone[]> {
  return updateKey<Tombstone[]>(KEYS.BOOKMARK_TOMBSTONES, mutate, []);
}

export function updateMoves(mutate: (current: MoveRecord[]) => MoveRecord[]): Promise<MoveRecord[]> {
  return updateKey<MoveRecord[]>(KEYS.BOOKMARK_MOVES, mutate, []);
}

export function updateFolderMoves(
  mutate: (current: FolderMoveRecord[]) => FolderMoveRecord[]
): Promise<FolderMoveRecord[]> {
  return updateKey<FolderMoveRecord[]>(KEYS.BOOKMARK_FOLDER_MOVES, mutate, []);
}

/**
 * The folder placements this device has CONFIRMED the tree holds, by folderMoveKey → `at`.
 *
 * The folder-move log says an intent was folded in; it cannot say whether the fold came
 * after the folder actually landed. This map is that second half, and it is what lets the
 * merge re-check a record the log calls done when the tree plainly disagrees with it — the
 * state an older build left behind when it marked a move done without carrying it out.
 * Written only where the merge verified the placement (or where a baseline replace made
 * the tree itself the truth), so a record kept this way is never replayed.
 */
export async function getFolderMovesVerified(): Promise<Record<string, number>> {
  return get<Record<string, number>>(KEYS.BOOKMARK_FOLDER_MOVES_VERIFIED, {});
}

export function updateFolderMovesVerified(
  mutate: (current: Record<string, number>) => Record<string, number>
): Promise<Record<string, number>> {
  return updateKey<Record<string, number>>(KEYS.BOOKMARK_FOLDER_MOVES_VERIFIED, mutate, {});
}

export async function getTitles(): Promise<TitleRecord[]> {
  return get<TitleRecord[]>(KEYS.BOOKMARK_TITLES, []);
}
export async function setTitles(list: TitleRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_TITLES, list);
}
export function updateTitles(
  mutate: (current: TitleRecord[]) => TitleRecord[]
): Promise<TitleRecord[]> {
  return updateKey<TitleRecord[]>(KEYS.BOOKMARK_TITLES, mutate, []);
}

export async function getFolderRenames(): Promise<FolderRenameRecord[]> {
  return get<FolderRenameRecord[]>(KEYS.BOOKMARK_FOLDER_RENAMES, []);
}
export async function setFolderRenames(list: FolderRenameRecord[]): Promise<void> {
  await set(KEYS.BOOKMARK_FOLDER_RENAMES, list);
}
export function updateFolderRenames(
  mutate: (current: FolderRenameRecord[]) => FolderRenameRecord[]
): Promise<FolderRenameRecord[]> {
  return updateKey<FolderRenameRecord[]>(KEYS.BOOKMARK_FOLDER_RENAMES, mutate, []);
}

// Folders THIS device deleted, path-keyed (see FolderDeleteRecord). Only our own are kept:
// a peer's arrive in its packet and are read from there, because the one question they
// answer is whether that peer meant to delete the folder its tombstones just emptied.
export async function getFolderDeletes(): Promise<FolderDeleteRecord[]> {
  return get<FolderDeleteRecord[]>(KEYS.BOOKMARK_FOLDER_DELETES, []);
}
export function updateFolderDeletes(
  mutate: (current: FolderDeleteRecord[]) => FolderDeleteRecord[]
): Promise<FolderDeleteRecord[]> {
  return updateKey<FolderDeleteRecord[]>(KEYS.BOOKMARK_FOLDER_DELETES, mutate, []);
}

// Bookmarks that arrived here carrying an older `dateAdded` than the moment they appeared,
// which is what a browser's own bookmark import does (see AppearedRecord). Local-only.
export async function getAppeared(): Promise<AppearedRecord[]> {
  return get<AppearedRecord[]>(KEYS.BOOKMARK_APPEARED, []);
}
export function updateAppeared(
  mutate: (current: AppearedRecord[]) => AppearedRecord[]
): Promise<AppearedRecord[]> {
  return updateKey<AppearedRecord[]>(KEYS.BOOKMARK_APPEARED, mutate, []);
}

// Empty folders a merge left standing here (see KeptShellRecord). Local-only.
export async function getKeptShells(): Promise<KeptShellRecord[]> {
  return get<KeptShellRecord[]>(KEYS.BOOKMARK_KEPT_SHELLS, []);
}
export function updateKeptShells(
  mutate: (current: KeptShellRecord[]) => KeptShellRecord[]
): Promise<KeptShellRecord[]> {
  return updateKey<KeptShellRecord[]>(KEYS.BOOKMARK_KEPT_SHELLS, mutate, []);
}

// Bookmarks a merge created here, and what the browser made of them (see CreatedRecord).
// Local-only.
export async function getCreated(): Promise<CreatedRecord[]> {
  return get<CreatedRecord[]>(KEYS.BOOKMARK_CREATED, []);
}
export function updateCreated(
  mutate: (current: CreatedRecord[]) => CreatedRecord[]
): Promise<CreatedRecord[]> {
  return updateKey<CreatedRecord[]>(KEYS.BOOKMARK_CREATED, mutate, []);
}

// What peers' deletions removed here lately, for the mass-delete guard's window (see
// PeerRemovalRecord). Local-only.
export async function getPeerRemovals(): Promise<PeerRemovalRecord[]> {
  return get<PeerRemovalRecord[]>(KEYS.BOOKMARK_PEER_REMOVED, []);
}
export function updatePeerRemovals(
  mutate: (current: PeerRemovalRecord[]) => PeerRemovalRecord[]
): Promise<PeerRemovalRecord[]> {
  return updateKey<PeerRemovalRecord[]>(KEYS.BOOKMARK_PEER_REMOVED, mutate, []);
}

// ─── Imported history (CO-6) ─────────────────────────────────────────────────
// URLs this device RECEIVED via history import (not genuinely visited here).
// Excluded from this device's export so imported entries don't get re-published
// as native visits and resurrect across the device mesh forever.

const HIST_IMPORTED_CAP = 20_000;
const HIST_REJECTED_CAP = 5_000;
/**
 * How long a URL this browser refused stays refused.
 *
 * Nothing remembered a rejection, so every cycle re-attempted every URL the browser will
 * never accept — and wrote a warning for each one. Measured on a reported first sync: with
 * nothing at all to do, a cycle still made 100 addUrl calls, took 100 rejections, and did
 * 100 whole-array rewrites of the 200-entry audit log. The log therefore turned over
 * completely every two cycles, which is why a user's Activity read 176 errors out of 188.
 *
 * Not forever, though: a rejection can be transient (a locked Places database, a
 * momentarily malformed entry), so this expires and the URL gets one more chance a week
 * later instead of one a minute.
 */
const HIST_REJECT_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Canonical URL → the local last-visit time that OUR OWN import produced for it.
 *
 * Read it as "suppress until": while the page's local last-visit time is still this
 * value, every visit we hold for it arrived from a peer, so publishing it would be
 * claiming someone else's browsing as ours (CO-6). The moment the user genuinely
 * navigates there, the local time moves past the stamp and the page becomes ours to
 * publish.
 *
 * This replaces a plain `string[]`. The list could only answer "did this ever arrive
 * here", which is not the question — it conflated "arrived here" with "never visited
 * here", so a page stopped being published FOREVER once any peer had sent it.
 */
export type ImportedHistoryStamps = Record<string, number>;

/**
 * The legacy `string[]` becomes a map stamped with the current time — i.e. "suppressed as
 * of now". That keeps today's behaviour exactly (nothing suddenly re-floods the mesh on
 * upgrade) while making every one of those pages publishable again the next time the user
 * actually visits it.
 */
function asStampMap(current: unknown, stamp: number): ImportedHistoryStamps {
  if (Array.isArray(current)) {
    const migrated: ImportedHistoryStamps = {};
    for (const u of current as string[]) {
      if (typeof u === "string") migrated[canonicalUrlKey(u)] = stamp;
    }
    return migrated;
  }
  return { ...((current as ImportedHistoryStamps) ?? {}) };
}

export async function getImportedHistoryStamps(): Promise<ImportedHistoryStamps> {
  const raw = await get<unknown>(KEYS.HIST_IMPORTED, {});
  if (!Array.isArray(raw)) return (raw as ImportedHistoryStamps) ?? {};
  // Legacy shape — convert once and write it back, so the stamp is fixed at the upgrade
  // moment instead of drifting forward on every read (which would suppress the pages
  // permanently, the very bug this replaces).
  return updateKey<ImportedHistoryStamps>(
    KEYS.HIST_IMPORTED,
    (cur) => asStampMap(cur, Date.now()),
    {}
  );
}

/** Record that these URLs' newest local visit came from an import made at `stamp`. */
export async function recordImportedHistory(urls: string[], stamp: number): Promise<void> {
  if (!urls.length) return;
  await updateKey<ImportedHistoryStamps>(KEYS.HIST_IMPORTED, (current) => {
    const map = asStampMap(current, stamp);
    for (const u of urls) map[canonicalUrlKey(u)] = stamp;
    const keys = Object.keys(map);
    if (keys.length <= HIST_IMPORTED_CAP) return map;
    // Cap to bound storage, evicting the OLDEST imports first. Dropping an entry makes
    // that page publishable again, so at worst a very old imported URL circulates once
    // more — it can't perpetually resurrect, because the receiving side only adds a visit
    // for a time genuinely newer than its own.
    keys.sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0));
    for (const k of keys.slice(0, keys.length - HIST_IMPORTED_CAP)) delete map[k];
    return map;
  }, {});
}

/** Canonical URL → when this browser last refused to store it. */
export async function getRejectedHistoryUrls(): Promise<Record<string, number>> {
  const raw = await get<Record<string, number>>(KEYS.HIST_REJECTED, {});
  return raw ?? {};
}

/** Note that the browser refused these, so the next cycles don't try them all again. */
export async function recordRejectedHistoryUrls(urls: string[], at: number): Promise<void> {
  if (!urls.length) return;
  await updateKey<Record<string, number>>(KEYS.HIST_REJECTED, (current) => {
    const map = { ...(current ?? {}) };
    for (const u of urls) map[canonicalUrlKey(u)] = at;
    const keys = Object.keys(map);
    if (keys.length <= HIST_REJECTED_CAP) return map;
    keys.sort((a, b) => (map[a] ?? 0) - (map[b] ?? 0));
    for (const k of keys.slice(0, keys.length - HIST_REJECTED_CAP)) delete map[k];
    return map;
  }, {});
}

/**
 * Whether this browser's history.addUrl accepts a `visitTime`, once we've found out.
 * Persisted rather than kept in memory so an MV3 worker restart doesn't re-probe, and so
 * the answer can't leak between tests.
 */
export async function getVisitTimeSupport(): Promise<boolean | null> {
  const v = await get<boolean | null>(KEYS.HIST_VISITTIME_OK, null);
  return typeof v === "boolean" ? v : null;
}
export async function setVisitTimeSupport(ok: boolean): Promise<void> {
  await set(KEYS.HIST_VISITTIME_OK, ok);
}

/**
 * Whether this browser allows only ONE programmatic tab/window open per user gesture,
 * once a restore has found out. WebKit (Orion) does: the first `tabs.create` after the
 * click goes through and everything after it is silently swallowed, which is why a
 * 10-tab session restored as 1 tab in the field.
 *
 * Persisted for the same reasons as `visitTime` above, plus one specific to this case:
 * the answer can only be learned by SPENDING the gesture, so a worker restart must not
 * throw it away and make the user pay for the lesson twice.
 */
export async function getSingleTabOpenLimit(): Promise<boolean | null> {
  const v = await get<boolean | null>(KEYS.TABS_SINGLE_OPEN, null);
  return typeof v === "boolean" ? v : null;
}
export async function setSingleTabOpenLimit(limited: boolean): Promise<void> {
  await set(KEYS.TABS_SINGLE_OPEN, limited);
}

/** Forget every recorded rejection, e.g. once we learn WE were the cause. */
export async function clearRejectedHistoryUrls(): Promise<void> {
  await set(KEYS.HIST_REJECTED, {});
}

/** True while the rejection is still fresh enough to trust. */
export function rejectionStillHolds(at: number | undefined, now: number): boolean {
  return at !== undefined && now - at < HIST_REJECT_RETRY_MS;
}

/** These pages have since been visited here for real — they're ours to publish now. */
export async function releaseImportedHistory(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const drop = new Set(urls.map(canonicalUrlKey));
  await updateKey<ImportedHistoryStamps>(KEYS.HIST_IMPORTED, (current) => {
    const map = asStampMap(current, Date.now());
    for (const k of Object.keys(map)) if (drop.has(k)) delete map[k];
    return map;
  }, {});
}

// ─── Last resolved Drive folder ──────────────────────────────────────────────
// Drive FINDS its folder by lookup instead of taking it from config, so the engine's
// destination tag — which is built from the config — cannot see when that folder changes.
// Remembering the last one lets the Drive backend flush the upload checksums exactly when
// the destination really moved. See GDriveBackend.noteResolvedFolder.

export async function getLastDriveFolder(): Promise<string | null> {
  return get<string | null>(KEYS.GDRIVE_FOLDER, null);
}

export async function setLastDriveFolder(id: string): Promise<void> {
  await set(KEYS.GDRIVE_FOLDER, id);
}

// ─── Recovery-snapshot latch ─────────────────────────────────────────────────
// The mass-delete guard re-evaluates the SAME peer deletions on every merge (a
// peer's tombstones live for 90 days and the local bookmarks are still there,
// because we refused to remove them), so "blocked → save a restore point" fired
// on every sync. With a 10-slot snapshot ring and a 60s interval that evicted
// every pre-incident restore point in ~10 minutes — destroying exactly the
// history the user would want to recover from.
//
// So: one restore point per INCIDENT. Latched after a successful recovery
// snapshot, cleared by the first bookmark sync that blocks nothing. A failed
// write leaves the latch clear so the next cycle retries.

export async function getRecoverySnapshotTaken(): Promise<boolean> {
  return get<boolean>(KEYS.RECOVERY_SNAPSHOT, false);
}

export async function setRecoverySnapshotTaken(taken: boolean): Promise<void> {
  await set(KEYS.RECOVERY_SNAPSHOT, taken);
}

// ─── Local change guard state ────────────────────────────────────────────────
// The baseline is the canonical form of the last bookmark tree this device published.
// It is deliberately NOT in the settings backup: replaying it onto a fresh install
// would make a device that has never published anything claim it already had.
// Mirrored by (rather than imported from) lib/sync/change-guard.ts, which imports
// this module — keeping the shape here means the storage layer has no dependency back
// into the sync layer.

export interface StoredGuardState {
  /** Canonical bookmark entries as seen on the previous sync cycle. */
  lastEntries: string[] | null;
  /** Consecutive cycles in which the tree changed by more than the cap. */
  unstableRounds: number;
}

const EMPTY_GUARD_STATE: StoredGuardState = {
  lastEntries: null,
  unstableRounds: 0,
};

export async function getGuardState(): Promise<StoredGuardState> {
  const stored = await get<Partial<StoredGuardState> | null>(KEYS.GUARD_STATE, null);
  // A partly-written state, or one left by a build with a different shape, is no
  // previous tree at all. Starting over is safe: the next cycle re-establishes it.
  if (!stored || !Array.isArray(stored.lastEntries)) return { ...EMPTY_GUARD_STATE };
  return {
    lastEntries: stored.lastEntries,
    unstableRounds: typeof stored.unstableRounds === "number" && Number.isFinite(stored.unstableRounds)
      ? stored.unstableRounds : 0,
  };
}

export async function setGuardState(state: StoredGuardState): Promise<void> {
  await set(KEYS.GUARD_STATE, state);
}

// One restore point per held-drift incident. Same shape and reason as the mass-delete
// latch above: a tree that keeps drifting is re-evaluated on every single cycle.
export async function getGuardSnapshotTaken(): Promise<boolean> {
  return get<boolean>(KEYS.GUARD_SNAPSHOT, false);
}

export async function setGuardSnapshotTaken(taken: boolean): Promise<void> {
  await set(KEYS.GUARD_SNAPSHOT, taken);
}

// One pre-apply restore point per dangerous-merge episode. A peer's tombstones are
// re-evaluated on every cycle until they are applied, so without this the same incident
// would leave a point a minute; the first cycle that removes nothing large clears it.
//
// The stored value is the episode's snapshot NAME, not just a boolean: later cycles of
// the same incident re-attach it to their receipt, so Activity's Undo button stays put
// while the deletion keeps repeating instead of vanishing after the first cycle.
export async function getDangerSnapshotName(): Promise<string | null> {
  const stored = await get<string | boolean | null>(KEYS.DANGER_SNAPSHOT, null);
  return typeof stored === "string" && stored ? stored : null;
}

export async function getDangerSnapshotTaken(): Promise<boolean> {
  const stored = await get<string | boolean | null>(KEYS.DANGER_SNAPSHOT, null);
  // A bare `true` is a latch left by an older build; the name is unrecoverable but the
  // episode is still open, so it must keep suppressing fresh points.
  return stored === true || (typeof stored === "string" && stored.length > 0);
}

export async function setDangerSnapshotName(name: string): Promise<void> {
  await set(KEYS.DANGER_SNAPSHOT, name);
}

export async function setDangerSnapshotTaken(taken: boolean): Promise<void> {
  await set(KEYS.DANGER_SNAPSHOT, taken ? true : null);
}

// The popup's one-time "you appear to be running Kesonode alongside the browser's own
// bookmark sync" tip is dismissible. Persisted (not in konode_state) so closing the
// popup doesn't bring it back, and NOT in the settings backup (it is a one-off UI choice).
export async function getGuardWarned(): Promise<boolean> {
  return get<boolean>(KEYS.GUARD_WARNED, false);
}
export async function setGuardWarned(warned: boolean): Promise<void> {
  await set(KEYS.GUARD_WARNED, warned);
}

// The user's one-shot "yes, apply that deletion" from Settings → Activity.
//
// The percentage slider cannot express this. It tops out at 95%, so a peer clearing
// nearly its whole tree stays blocked at every setting and the warning never clears
// (#18) — and even where raising it does work, it permanently weakens the guard to wave
// through a single event that has already happened.
//
// So the approval is a latch, not a threshold: set from the UI, then read and cleared by
// the sync engine at the top of the NEXT sync, which hands the value to every bookmark
// merge that sync runs. One cycle, whatever that cycle manages to do with it. The restore
// point is already on the backend before the button can exist, which is what makes saying
// yes cheap.
//
// The read-and-clear belongs to the sync rather than to the merge that spends it. Letting
// the merge clear it meant a cycle that never reached an over-cap merge left it armed with
// nothing to spend it on, and it stayed armed until an unrelated deletion happened to fit
// under it — applied silently, with no restore point and nothing in the log.
//
// It stores the SIZE that was approved rather than a bare true, and a merge honours it
// only for a deletion that size or smaller. A plain boolean would wave through whatever
// arrived in the meantime, so approving "48 of your 49" could have cashed out against a
// different and much larger deletion. 0 means none.

export async function getBulkDeleteApproval(): Promise<number> {
  return get<number>(KEYS.BULK_DELETE_APPROVAL, 0);
}

export async function setBulkDeleteApproval(maxBlocked: number): Promise<void> {
  await set(KEYS.BULK_DELETE_APPROVAL, maxBlocked);
}

// Whether the Activity log already carries "couldn't list the sync folder" for the
// failure now in progress.
//
// Same shape as the recovery latch above, and for the same reason. The folder listing is
// re-checked every sync, so a listing that keeps failing is one condition, not one per
// cycle, and `logger.warn` is retained: reporting it every time wrote a kept entry a
// minute and turned the 200-entry ring over in about three hours, evicting the very
// warnings the popup banner sends people to read. That is #20 in a different place.
// Written once when the listing starts failing, cleared when it works again.

export async function getListFailureNoted(): Promise<boolean> {
  return get<boolean>(KEYS.LIST_FAILURE_NOTED, false);
}

export async function setListFailureNoted(noted: boolean): Promise<void> {
  await set(KEYS.LIST_FAILURE_NOTED, noted);
}

// The baseline marker is re-read on every page load, so "the storage no longer holds the
// marker this browser set" is one condition, not one per read. Same latch shape as the
// listing failure above: written once, cleared when the storage has the marker again.

export async function getBaselineStaleNoted(): Promise<boolean> {
  return get<boolean>(KEYS.BASELINE_STALE_NOTED, false);
}

export async function setBaselineStaleNoted(noted: boolean): Promise<void> {
  await set(KEYS.BASELINE_STALE_NOTED, noted);
}

// ─── Sync lock (CO-4) ─────────────────────────────────────────────────────────
// A persisted, TTL'd lock so a sync interrupted by an MV3 worker suspension can't
// leave a later wake double-running (belt-and-braces with the in-memory isSyncing,
// which only guards within a single worker instance). A stale lock (older than the
// TTL) is ignored, so a crashed sync self-heals rather than blocking forever.

// ─── Rate-limit cooldown ────────────────────────────────────────────────────

/**
 * How long automatic sync stays parked after a storage meters us.
 *
 * Nutstore counts 600 WebDAV requests per 30 minutes across EVERY app on the account
 * and answers 403 once the window is gone. Polling every minute through that window
 * spends the next window before it opens, so the advice to "wait for the window to
 * pass" could never actually work (QuarkPC field report, 2026-11-08). One window is
 * enough: the first cycle after it expires tries again, and "Sync now" is never gated.
 */
export const SYNC_COOLDOWN_MS = 30 * 60 * 1000;

/** Milliseconds left in the cooldown; 0 when there is none or it has passed. */
export async function syncCooldownRemaining(now = Date.now()): Promise<number> {
  const until = await get<number>(KEYS.SYNC_COOLDOWN_UNTIL, 0);
  return Math.max(0, until - now);
}

/** Start a cooldown without extending one that is already running. */
export async function startSyncCooldown(now = Date.now()): Promise<boolean> {
  if (await syncCooldownRemaining(now) > 0) return false;
  await set(KEYS.SYNC_COOLDOWN_UNTIL, now + SYNC_COOLDOWN_MS);
  return true;
}

export async function clearSyncCooldown(): Promise<void> {
  await set(KEYS.SYNC_COOLDOWN_UNTIL, 0);
}

// ─── Repeated-failure backoff ───────────────────────────────────────────────
//
// A rate limit has a known shape and gets the 30-minute cooldown above. A WRONG password
// does not: it repeats identically every cycle for as long as nobody fixes it. Retrying
// is still the right thing to do — that is how a credential the user has since corrected
// gets noticed — but doing it every single minute rewrote the status, appended a kept
// line to the 200-entry Activity log, and re-broadcast to any open popup, all saying the
// same sentence. Left alone for an afternoon the log was nothing but copies of that one
// line, which is the exact condition that hides the entries the popup sends people in to
// read (#20 in yet another place).
//
// So the same failure in consecutive cycles buys a growing pause. The identity of "the
// same failure" is the message text itself, deliberately: no attempt is made to guess
// whether an error is "permanent", because a guess that is wrong either hides a real
// problem behind a pause or keeps the storm going. A different error starts over at once,
// and the first occurrence never pauses anything — one failure is a dropped connection,
// not a pattern.
//
// Cleared by a clean cycle, by "Sync now", and by saving settings (the user may just have
// fixed the thing that was wrong).

export const SYNC_BACKOFF_BASE_MS = 2 * 60 * 1000;
export const SYNC_BACKOFF_MAX_MS = 15 * 60 * 1000;

export interface SyncFailureState {
  /** Consecutive cycles that recorded this exact message. 0 after a clean cycle. */
  streak: number;
  message: string | null;
  /** Timestamp automatic sync may try again. 0 means "no pause". */
  until: number;
}

const NO_FAILURE: SyncFailureState = { streak: 0, message: null, until: 0 };

export async function getSyncFailureState(): Promise<SyncFailureState> {
  return { ...NO_FAILURE, ...(await get<Partial<SyncFailureState>>(KEYS.SYNC_FAILURE, {})) };
}

/** Milliseconds until automatic sync may try again after a repeated failure. */
export async function syncBackoffRemaining(now = Date.now()): Promise<number> {
  const { until } = await getSyncFailureState();
  return Math.max(0, until - now);
}

/** Record one failed cycle and return the state it produced. */
export async function noteSyncFailure(
  message: string,
  now = Date.now()
): Promise<SyncFailureState> {
  const prev = await getSyncFailureState();
  const streak = prev.message === message ? prev.streak + 1 : 1;
  const pause = streak < 2
    ? 0
    : Math.min(SYNC_BACKOFF_BASE_MS * 2 ** (streak - 2), SYNC_BACKOFF_MAX_MS);
  const next: SyncFailureState = { streak, message, until: pause ? now + pause : 0 };
  await set(KEYS.SYNC_FAILURE, next);
  return next;
}

/** Forget the streak. Cheap to call on every clean cycle: it writes only when set. */
export async function clearSyncFailure(): Promise<void> {
  const prev = await getSyncFailureState();
  if (prev.streak === 0 && prev.until === 0 && prev.message === null) return;
  await set(KEYS.SYNC_FAILURE, { ...NO_FAILURE });
}

export async function acquireSyncLock(ttlMs: number): Promise<boolean> {
  let acquired = false;
  await updateKey<number>(KEYS.SYNC_LOCK, (lockedAt) => {
    const now = Date.now();
    if (lockedAt && now - lockedAt < ttlMs) return lockedAt;
    acquired = true;
    return now;
  }, 0);
  return acquired;
}

export async function releaseSyncLock(): Promise<void> {
  await updateKey<number>(KEYS.SYNC_LOCK, () => 0, 0);
}

/**
 * Drop a lock left behind by a worker that died mid-sync, reporting whether one was
 * actually held. Called from the service worker's startup recovery.
 *
 * On a fresh worker any lock is stale BY DEFINITION: MV3 runs one worker at a time and
 * tears the entire JS context down, so nothing can still be holding it — which is also
 * why this doesn't consult the TTL. Without it the lock sat there for its full 2 minutes
 * while every sync returned early, including the manual "Sync now", and still reported
 * success.
 */
export async function clearStaleSyncLock(): Promise<boolean> {
  const lockedAt = await get<number>(KEYS.SYNC_LOCK, 0);
  if (!lockedAt) return false;
  await set(KEYS.SYNC_LOCK, 0);
  return true;
}

// ─── Remote sessions (one per peer device) ──────────────────────────────────

/**
 * Normalizes the `konode_remote_sessions` value into an array, newest first.
 * Accepts the current device-keyed map, the legacy single-object shape, and
 * empty/undefined. Pure so the popup can use it synchronously after a
 * `chrome.storage.local.get` callback.
 */
export function normalizeRemoteSessions(raw: unknown): RemoteSessionEntry[] {
  if (!raw || typeof raw !== "object") return [];
  // A session is a peer packet's content, so every part of it can be malformed. `tabs`
  // must be a non-empty ARRAY of objects: a string also has a `length`, and a null entry
  // reaches `t.url` in the popup's row and in the restore path.
  const usable = (e: unknown): e is RemoteSessionEntry => {
    const s = (e as { session?: { tabs?: unknown } } | null | undefined)?.session;
    return !!s && Array.isArray(s.tabs) && s.tabs.length > 0
      && s.tabs.every((t) => !!t && typeof t === "object");
  };
  // Legacy single-object shape: { device_id, timestamp, session }
  if ("session" in (raw as Record<string, unknown>)) {
    const entry = raw as RemoteSessionEntry;
    return usable(entry) ? [entry] : [];
  }
  // Current map shape: { [device_id]: RemoteSessionEntry }
  // The timestamps are coalesced because they come from a peer's packet, which nothing
  // validates them in: one entry with a missing timestamp threw a TypeError out of this
  // sort, and the popup lost the whole session list to it.
  return Object.values(raw as Record<string, RemoteSessionEntry>)
    .filter(usable)
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
}

export async function getRemoteSessions(): Promise<RemoteSessionEntry[]> {
  const r = await browser.storage.local.get(KEYS.REMOTE_SESSIONS);
  return normalizeRemoteSessions(r[KEYS.REMOTE_SESSIONS]);
}

/** Upserts one peer's session into the device-keyed map. See `upsertRemoteEntry`. */
export async function setRemoteSession(entry: RemoteSessionEntry): Promise<void> {
  await updateKey<Record<string, RemoteSessionEntry>>(
    KEYS.REMOTE_SESSIONS,
    (cur) => upsertRemoteEntry(cur, entry, "session"),
    {}
  );
}

// ─── Remote extensions (aggregated across all peers) ────────────────────────

/** The device-keyed peer cache each data type fills. The other two types have none. */
const REMOTE_CACHE_KEY: Partial<Record<DataType, string>> = {
  sessions: KEYS.REMOTE_SESSIONS,
  extensions: KEYS.REMOTE_EXTENSIONS,
};

/** Removes device ids from one device-keyed cache value, tolerating the legacy shape. */
function withoutDevices(
  current: Record<string, unknown> | undefined,
  deviceIds: string[]
): Record<string, unknown> {
  // The legacy single-object shape has no id key to delete; clear it outright when it is
  // one of the devices being dropped.
  if (current && typeof current === "object" && "device_id" in current) {
    const id = (current as { device_id?: string }).device_id;
    return id && deviceIds.includes(id) ? {} : current;
  }
  const next = { ...(current ?? {}) };
  for (const id of deviceIds) delete next[id];
  return next;
}

/**
 * Upserts one peer's entry into a device-keyed cache value, keeping the NEWER of the two
 * and tolerating the legacy shape.
 *
 * Both setters used to be a raw get-then-set across an `await`, which is the lost-update
 * race `updateKey` exists for. Sessions and extensions are imported independently, so two
 * peers landing at the same moment each built their map from the value BEFORE the other's
 * write, and one peer's entry was gone. Gone for good, too: the packet it came from is
 * unchanged, so `uploadIfChanged` on that peer never sends it again and nothing here
 * re-reads it. That is what made a frozen peer list permanent instead of something the
 * next sync fixed.
 *
 * The timestamp check is the other half. Peer files arrive in whatever order the backend
 * lists them, and a folder can hold more than one file for one device, so writing
 * unconditionally lets an older list win. Keep the newer packet whichever order it turns up
 * in, by the same clock the engine orders peers by, compared as the string it already is.
 */
function upsertRemoteEntry<T extends { device_id: string; timestamp: string }>(
  current: Record<string, T> | undefined,
  entry: T,
  payloadField: keyof T & string
): Record<string, T> {
  // The legacy single-object shape IS one peer's entry, recognized by its payload field.
  // Replace it rather than nesting the new entry inside it.
  const map: Record<string, T> =
    current && typeof current === "object" && !(payloadField in current) ? { ...current } : {};
  const held: T | undefined = map[entry.device_id];
  // A held entry that CAN be ordered is never displaced by one that cannot. Nothing
  // validates a peer packet's timestamp — `normalizeRemoteSessions` above coalesces a
  // missing one because a real packet arrived without it — and `held.timestamp >= entry
  // .timestamp` is false whenever the right side is undefined, so the malformed entry
  // used to win every time. Worse than the one bad write: the entry it left behind had no
  // timestamp either, so from then on nothing could be ordered against it and a stale file
  // could take that device's slot, which is the case this check exists to prevent.
  //
  // A held entry with no timestamp is still replaced, so one bad packet cannot pin a
  // device's cache forever.
  if (held?.timestamp && (!entry.timestamp || held.timestamp >= entry.timestamp)) return map;
  map[entry.device_id] = entry;
  return map;
}

/**
 * Forget one device in both device-keyed caches.
 *
 * Local only: these are this device's view of its peers. Without it, the popup keeps
 * listing a session and an extension set for a device whose files are gone. Being local is
 * also why it isn't enough on its own — every OTHER device has the same two caches and
 * never saw the click, which is what `dropRemoteDevices` exists to settle.
 */
export async function dropRemoteDevice(deviceId: string): Promise<void> {
  for (const key of [KEYS.REMOTE_SESSIONS, KEYS.REMOTE_EXTENSIONS]) {
    await updateKey<Record<string, unknown>>(key, (c) => withoutDevices(c, [deviceId]), {});
  }
}

/**
 * The peer device ids this device currently caches for a type ([] for a type with no cache).
 */
export async function getRemoteDeviceIds(dataType: DataType): Promise<string[]> {
  const key = REMOTE_CACHE_KEY[dataType];
  if (!key) return [];
  const raw = (await browser.storage.local.get(key))[key];
  if (!raw || typeof raw !== "object") return [];
  // The legacy single-object shape carries its one id in a field, not in the keys.
  if ("device_id" in (raw as Record<string, unknown>)) {
    const id = (raw as { device_id?: string }).device_id;
    return id ? [id] : [];
  }
  return Object.keys(raw as Record<string, unknown>);
}

/**
 * Drop devices from ONE type's cache.
 *
 * Deliberately not `dropRemoteDevice`, which clears both: a missing
 * `konode_sessions_<id>.json` says nothing about that device's extension list, and
 * throwing away a cache we were never told about would be its own version of this bug.
 */
export async function dropRemoteDevices(dataType: DataType, deviceIds: string[]): Promise<void> {
  const key = REMOTE_CACHE_KEY[dataType];
  if (!key || deviceIds.length === 0) return;
  await updateKey<Record<string, unknown>>(key, (c) => withoutDevices(c, deviceIds), {});
}

/**
 * Normalizes the `konode_remote_extensions` value into a **deduped union** of every
 * peer device's installed-extension list (first occurrence per id wins). Accepts the
 * current device-keyed map, the legacy single-object shape, and empty/undefined.
 * Pure so the popup can use it synchronously after a `chrome.storage.local.get`.
 */
export function normalizeRemoteExtensions(raw: unknown): SyncExtension[] {
  if (!raw || typeof raw !== "object") return [];
  const entries: RemoteExtensionEntry[] =
    "extensions" in (raw as Record<string, unknown>)
      ? [raw as RemoteExtensionEntry] // legacy single-object shape
      : Object.values(raw as Record<string, RemoteExtensionEntry>); // device-keyed map
  const byId = new Map<string, SyncExtension>();
  for (const entry of entries) {
    for (const ext of entry?.extensions ?? []) {
      // Rebuild storeUrl locally rather than trusting the peer's value. The whole
      // entry is persisted verbatim from a peer's packet — which, with E2EE off,
      // anyone with backend write access can forge — and the popup opens storeUrl
      // in a tab / the options page links to it. A forged storeUrl is a phishing
      // vector; storeUrlFor() pins the host to the Web Store (chrome, by id) or
      // Firefox Add-ons (firefox, by name search), so at worst a bogus value yields
      // a dead but same-host link. Also stamp the inferred source store.
      if (ext?.id && !byId.has(ext.id)) {
        const store = inferStore(ext);
        byId.set(ext.id, { ...ext, store, storeUrl: storeUrlFor({ id: ext.id, name: ext.name, store }) });
      }
    }
  }
  return [...byId.values()];
}

/** Upserts one peer's extension list into the device-keyed map. See `upsertRemoteEntry`. */
export async function setRemoteExtensions(entry: RemoteExtensionEntry): Promise<void> {
  await updateKey<Record<string, RemoteExtensionEntry>>(
    KEYS.REMOTE_EXTENSIONS,
    (cur) => upsertRemoteEntry(cur, entry, "extensions"),
    {}
  );
}

// ─── Upload de-dup (skip re-uploading unchanged data) ───────────────────────

/** Checksum of the payload this device last uploaded for a data type, if any. */
export async function getLastUploadChecksum(dataType: DataType): Promise<string | null> {
  const r = await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
  return (r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string> | undefined)?.[dataType] ?? null;
}

export async function setLastUploadChecksum(dataType: DataType, checksum: string): Promise<void> {
  const r = await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
  const map = { ...((r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string>) ?? {}), [dataType]: checksum };
  await set(KEYS.UPLOAD_CHECKSUMS, map);
}

/**
 * Forget ONE data type's "last uploaded" checksum so the next sync re-publishes it.
 *
 * For changes that only concern one type. Clearing the whole key (see
 * `clearUploadChecksums`) makes every other type upload again too, which for history
 * can be megabytes — on a metered storage that is the difference between a small
 * publish and a quota window spent on files that did not change.
 */
export async function clearUploadChecksum(dataType: DataType): Promise<void> {
  const r = await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS);
  const map = r[KEYS.UPLOAD_CHECKSUMS] as Record<string, string> | undefined;
  if (!map || !(dataType in map)) return;
  const next = { ...map };
  delete next[dataType];
  await set(KEYS.UPLOAD_CHECKSUMS, next);
}

/**
 * Forget every "last uploaded" checksum so the next sync re-uploads all data types.
 * Called when encryption is toggled or the passphrase changes: the checksum is over
 * the *plaintext* payload, so an encryption change alone wouldn't otherwise trigger a
 * re-upload — the device's own file would keep sitting on the backend in its previous
 * (e.g. plaintext) form even though E2EE is now on.
 */
export async function clearUploadChecksums(): Promise<void> {
  await browser.storage.local.remove(KEYS.UPLOAD_CHECKSUMS);
}

/**
 * Forget everything the bookmark MERGE has learned locally, after the user replaced the
 * whole tree with a peer's ("sync direction → use the remote copy").
 *
 * `importBookmarks(..., "replace")` folds the peer's tombstones/moves/rename logs into
 * this device BEFORE clearing the tree. Leaving those behind would make the very next
 * merge apply the peer's old deletions to the tree we just imported, so "use the remote
 * copy" would quietly not be the remote copy. These keys are all reconstructible working
 * state; the next sync rebuilds what it needs.
 *
 * Placement records are the exception. They are LWW markers meaning "this placement is
 * already done": the merge only applies a peer reorder when its timestamp is NEWER than
 * the local record. Clearing them after the replace empties that defence, so the very
 * next cycle replays the imported tree's own stale move/folder-move records against it
 * and can move folders away from the copy the user designated as the baseline. Callers
 * that used `getMoves()`/`getFolderMoves()` to fold the designated packet in keep those
 * two keys with `keepPlacement: true`.
 */
export async function resetBookmarkMergeState(options: { keepPlacement?: boolean } = {}): Promise<void> {
  await browser.storage.local.remove([
    KEYS.BOOKMARK_CACHE,
    KEYS.BOOKMARK_TOMBSTONES,
    ...(options.keepPlacement ? [] : [KEYS.BOOKMARK_MOVES, KEYS.BOOKMARK_FOLDER_MOVES]),
    KEYS.BOOKMARK_TITLES,
    KEYS.BOOKMARK_FOLDER_RENAMES,
    KEYS.BOOKMARK_FOLDER_DELETES,
    KEYS.BOOKMARK_APPEARED,
    KEYS.BOOKMARK_KEPT_SHELLS,
    KEYS.BOOKMARK_CREATED,
    KEYS.BOOKMARK_PEER_REMOVED,
    KEYS.GUARD_STATE,
    KEYS.GUARD_SNAPSHOT,
    KEYS.DANGER_SNAPSHOT,
    KEYS.RESOLVED_CONFLICTS,
    KEYS.CONFLICT_PACKETS,
    KEYS.UPLOAD_CHECKSUMS,
  ]);
}

// ─── Pending-conflict packets (parked OUTSIDE konode_state) ─────────────────
// The raw peer packet is what "use remote" needs in order to decrypt, verify and apply
// the version the user picked — so it has to be kept. It just must not live in
// `konode_state`: every setState() rewrites that whole object (several times per sync)
// and every STATE_UPDATE broadcasts it to the popup, so a few hundred KB of bookmark
// tree per conflict turned routine status updates into megabytes of churn.
//
// Keyed by conflict id. The popup only ever renders a conflict's `id` and `data_type`,
// so nothing else needs the bulk.

export async function getConflictPacket(id: string): Promise<SyncPacket | null> {
  const map = await get<Record<string, SyncPacket>>(KEYS.CONFLICT_PACKETS, {});
  return map[id] ?? null;
}

export async function putConflictPacket(id: string, packet: SyncPacket): Promise<void> {
  await updateKey<Record<string, SyncPacket>>(
    KEYS.CONFLICT_PACKETS, (cur) => ({ ...cur, [id]: packet }), {}
  );
}

/** Keep only the packets still backing a pending conflict. Called whenever the pending
 *  list changes, so it covers both resolve-cleanup and any orphan left by an earlier
 *  interruption — the packets are the largest thing this extension stores per conflict. */
export async function pruneConflictPackets(keepIds: string[]): Promise<void> {
  const keep = new Set(keepIds);
  await updateKey<Record<string, SyncPacket>>(KEYS.CONFLICT_PACKETS, (cur) => {
    const next: Record<string, SyncPacket> = {};
    for (const [id, p] of Object.entries(cur)) if (keep.has(id)) next[id] = p;
    return next;
  }, {});
}

// ─── Resolved manual conflicts (make a resolution sticky) ───────────────────
// Under the `manual` strategy the engine queues a conflict per diverging peer.
// Resolving one (keep-local OR keep-remote) doesn't change the *peer's* file on
// the backend, so it still diverges from ours next cycle — without this record the
// same conflict re-queues and re-notifies forever. We remember the peer CHECKSUM we
// resolved against, keyed by `${data_type}:${device_id}`; the queue loop skips a peer
// whose current checksum still matches. If the peer's data genuinely changes later,
// its checksum changes, this record no longer matches, and a fresh conflict surfaces.
// Bounded by peer-count × data-types (tiny), so no GC needed.

export async function getResolvedConflicts(): Promise<Record<string, string>> {
  return get<Record<string, string>>(KEYS.RESOLVED_CONFLICTS, {});
}

export async function setResolvedConflict(key: string, checksum: string): Promise<void> {
  const map = { ...(await getResolvedConflicts()), [key]: checksum };
  await set(KEYS.RESOLVED_CONFLICTS, map);
}

// ─── Rating card ────────────────────────────────────────────────────────────
// See lib/rate-prompt.ts for what these mean and when the card shows.

export interface RateProgress {
  /** ISO-8601 of the first sync that counted. */
  first_at: string;
  /** Syncs that counted, up to the threshold: counting stops there. */
  syncs: number;
}

export async function getRateProgress(): Promise<RateProgress | null> {
  const v = await get<RateProgress | null>(KEYS.RATE_PROGRESS, null);
  return v && typeof v.first_at === "string" && typeof v.syncs === "number" ? v : null;
}
export async function setRateProgress(p: RateProgress): Promise<void> {
  await set(KEYS.RATE_PROGRESS, p);
}

export async function getRateAnswered(): Promise<string | null> {
  const v = await get<string | null>(KEYS.RATE_ANSWERED, null);
  return typeof v === "string" ? v : null;
}
export async function setRateAnswered(at: string): Promise<void> {
  await set(KEYS.RATE_ANSWERED, at);
}
