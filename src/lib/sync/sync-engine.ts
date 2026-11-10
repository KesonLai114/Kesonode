import type { SyncSettings, SyncState, DataType, SyncPacket, SyncSession, SyncExtension, ConflictItem, BackendConfig,
  DeviceInfo, DeviceBrowser, ConflictDiff, ListedFile, BookmarkPayload, FirstSyncChoice,
} from "@/lib/types";
import { createBackend } from "@/lib/backends/abstract-backend";
import { normalizeRepoSlug } from "@/lib/backends/github-backend";
import { createSnapshot as writeSnapshot, listSnapshots as readSnapshots, knownSnapshots, restoreSnapshot as applySnapshot, deleteSnapshot as dropSnapshot, renameSnapshot as renameSnapshotFile, setSnapshotPinned as pinSnapshotFile, flushPendingPins, type SnapshotMeta, type CreateSnapshotOptions } from "@/lib/sync/snapshots";
import {
  bookmarkContent, exportBookmarkPayload, importBookmarks, peerTreeAsMerged, type BulkDeleteBlock,
} from "@/lib/handlers/bookmarks-handler";
import { diffBookmarks, diffHistory } from "./conflict-diff";
import { exportSession, importSession } from "@/lib/handlers/tabs-handler";
import { exportHistory, importHistory, buildLocalHistoryIndex } from "@/lib/handlers/history-handler";
import { exportExtensions } from "@/lib/handlers/extensions-handler";
import { dataTypeAvailability, unsupportedReason, hasPermission } from "@/lib/utils/capabilities";
import { detectBrowser, readDeviceBrowser } from "@/lib/utils/browser-identity";
import { readPeerLabels, rememberPeerLabels } from "@/lib/utils/peer-labels";
import { HttpError, rateLimitMessage } from "@/lib/utils/retry";
import {
  getState,
  setState,
  getRemoteSessions,
  setRemoteSession,
  setRemoteExtensions,
  getLastUploadChecksum,
  setLastUploadChecksum,
  clearUploadChecksums,
  getResolvedConflicts,
  setResolvedConflict,
  getConflictPacket,
  putConflictPacket,
  pruneConflictPackets,
  getRecoverySnapshotTaken,
  setRecoverySnapshotTaken,
  getBulkDeleteApproval,
  getTombstones,
  setBulkDeleteApproval,
  getListFailureNoted,
  setListFailureNoted,
  getGuardSnapshotTaken,
  setGuardSnapshotTaken,
  acquireSyncLock,
  releaseSyncLock,
  syncCooldownRemaining,
  startSyncCooldown,
  clearSyncCooldown,
  SYNC_COOLDOWN_MS,
  dropRemoteDevice,
  getRemoteDeviceIds,
  dropRemoteDevices,
  getFirstSync,
  setFirstSync,
  resetBookmarkMergeState,
} from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import { noteCleanSync } from "@/lib/rate-prompt";
import { PERMISSION_LOST_PREFIX } from "@/lib/constants";
import { encrypt, decrypt, sha256, verifyPassphrase } from "@/lib/crypto/encryption";
import {
  CURRENT_PACKET_VERSION,
  assertSupportedPacketVersion,
  deviceFilePattern,
  folderPath,
  getCompatMode,
  listPrefixes,
  packetFileName,
  peerDeviceIdFromName,
  isPeerFileName,
  readPrefixes,
  setCompatMode,
} from "@/lib/compat/protocol";
import { ConflictResolver, notifyConflict, notifyFirstSync, orderPeersByTime } from "./conflict-resolver";
import { evaluateLocalDrift, GUARD_ABSOLUTE_FLOOR } from "./change-guard";

// How long the persisted sync lock stays valid before it's treated as stale, so a
// crashed/suspended sync self-heals. Only governs cross-instance recovery speed:
// within a live worker `isSyncing` already prevents a double-run, so this can be
// short. 2 min comfortably covers a retry-heavy multi-type sync.
const SYNC_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * The data types a conflict can exist for.
 *
 * `manual` asks which side to keep, which only means something where the two sides are
 * competing versions of one thing. Bookmarks and history are. Sessions and extensions are
 * per-device display caches keyed by `device_id`, one entry per peer: another machine's
 * open tabs are not a rival version of ours, and both lists are kept side by side rather
 * than resolved. They went through the same gate anyway, so on `manual` the import that
 * fills those caches never ran. No peer's session was ever stored, "missing on this
 * device" never changed, and every sync reported success while it happened.
 */
const CONFLICTABLE_TYPES = new Set<DataType>(["bookmarks", "history"]);

/**
 * The data types whose IMPORT writes to the local store, and so the only ones whose payload
 * has to be read a second time after the merge.
 *
 * `syncType` builds the payload twice: once before the fold to decide the flow, once after
 * it to publish what the fold produced. For bookmarks and history that second read is the
 * whole point, since `importBookmarks` rewrites the tree and `importHistory` adds visits,
 * which makes the pre-merge payload stale the moment a peer is folded in. Sessions and
 * extensions do not work that way: `applyRemote` files the peer's copy in a device-keyed
 * cache for the popup and nothing local moves, so rebuilding spends a second
 * `management.getAll()` or tab query to produce a byte-identical payload.
 *
 * Found with `management` revoked, where the doubling was audible: the "extension list
 * isn't published this sync" warning arrived TWICE per cycle, filling a 200-entry log in
 * about 100 minutes at the default interval.
 *
 * Deliberately its own set rather than a reuse of CONFLICTABLE_TYPES, which holds the same
 * two members today for an unrelated reason. One asks "can two versions of this compete",
 * the other "does folding a peer in change what we hold"; a future data type could easily
 * answer them differently.
 */
const MERGE_MUTATES_LOCAL = new Set<DataType>(["bookmarks", "history"]);

/**
 * The queued conflicts that can still exist, given the gate above.
 *
 * Pure and exported for the same reason `statusAfterSync` is: it decides what the user
 * sees, so it is worth testing without a sync around it. A device on `manual` that ran an
 * older build can be carrying conflicts for sessions or extensions, which went through the
 * same gate before it was narrowed. Nothing re-queues or clears those now, so without this
 * the popup would go on asking which of two devices' tab lists to keep, forever.
 */
export function conflictsThatCanExist(list: ConflictItem[]): ConflictItem[] {
  return list.filter((c) => CONFLICTABLE_TYPES.has(c.data_type));
}

/**
 * The queued conflicts still worth asking about, which is the above plus the strategy.
 *
 * Only `manual` asks. Every other strategy answers in the merge itself, so a card left
 * over from a spell on `manual` is putting a question the engine has stopped putting: the
 * sync that just ran already folded those peers in. The cards outlive the setting that
 * made them, and nothing else clears them, so the popup would go on offering a choice
 * whose outcome was decided a minute ago.
 *
 * Applied at the END of a sync rather than when the setting is saved, so a conflict only
 * disappears once the merge that replaces it has actually run.
 */
export function conflictsStillOpen(
  list: ConflictItem[],
  strategy: SyncSettings["conflict_strategy"]
): ConflictItem[] {
  return strategy === "manual" ? conflictsThatCanExist(list) : [];
}

/**
 * A peer's encrypted data can't be read with this device's passphrase — the
 * passphrases don't match (or none is set). Thrown so the sync surfaces a clear,
 * user-visible error instead of silently skipping the peer and diverging forever.
 */
export class PassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassphraseError";
  }
}

/**
 * E2EE is off/unset on THIS device, but a peer's file is end-to-end encrypted — so
 * the group is encrypted and this device is the odd one out. Surfaced as a non-fatal
 * nudge (recorded by the syncType fold, shown after our own upload) on the device
 * that can actually fix it, rather than silently staying out of the encrypted group.
 * The mirror case (we're encrypted, a peer is plaintext) is handled in the fold by
 * skipping the plaintext peer silently — it's usually a stale/orphan file and not
 * this device's problem, so it must not warn forever.
 */
export class EncryptionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionMismatchError";
  }
}

/**
 * Whether `sync()` actually did anything. It used to return void, so a caller couldn't
 * tell a completed sync from one that bailed at the door — and the SYNC_NOW handler
 * answered a blanket `OK` either way, which is how a stranded lock turned the manual
 * "Sync now" button into a silent no-op that looked like success.
 *
 * `ran` covers a sync that failed too: the failure is recorded in the state, which is a
 * different thing from never having started.
 */
export type SyncOutcome = "ran" | "no-backend" | "already-running" | "nothing-enabled" | "cooling-down"
  | "first-sync-pending";

/**
 * The status a finished sync should report. `sync()` used to hard-code
 * `problems ? "error" : "success"`, which OVERWROTE the "conflict" status that syncType
 * had just set — so the popup header read "Synced" and the toolbar showed nothing while
 * unresolved conflicts sat waiting for a decision.
 *
 * Errors outrank conflicts: an error may mean nothing synced at all.
 */
/**
 * The origins a backend has to be able to reach.
 *
 * Mirrors `host_permissions` / `optional_host_permissions` in the manifest, per backend,
 * because a device only needs the ones its OWN backend uses: requiring GitHub's host of a
 * Drive user would be wrong in the other direction. WebDAV's is the user's own server, so
 * it comes from the config rather than from the manifest.
 */
export function backendOrigins(cfg: BackendConfig | undefined): string[] {
  if (!cfg) return [];
  switch (cfg.type) {
    case "webdav": {
      if (!cfg.webdav?.url) return [];
      try { return [new URL(cfg.webdav.url).origin + "/*"]; } catch { return []; }
    }
    case "gdrive":
      return ["https://www.googleapis.com/*", "https://oauth2.googleapis.com/*"];
    case "github":
      return ["https://api.github.com/*"];
    default:
      return [];
  }
}

/** The storage as a sentence can name it: the WebDAV host, or the service. */
export function storageName(cfg: BackendConfig | undefined): string {
  switch (cfg?.type) {
    case "webdav":
      try { return new URL(cfg.webdav!.url).host; } catch { return "your storage"; }
    case "gdrive":
      return "Google Drive";
    case "github":
      return "GitHub";
    default:
      return "your storage";
  }
}

/**
 * Say why a sync failed, when a bare failure does not.
 *
 * "NetworkError when attempting to fetch resource" is what a withdrawn HOST permission
 * looks like from inside a fetch: the request never leaves the browser, so there is no
 * status code and nothing that names the server. On Firefox those toggles sit in
 * about:addons directly under the data type ones, a couple of clicks from anyone reading
 * about what an add-on can see, and the data types say when theirs is gone while the
 * storage said only this. Reported from a device that had just turned them all off.
 *
 * Asked only AFTER a failure, never before it. A permission model read wrongly can then
 * only make an error message worse; it can never stop a sync that would have worked.
 */
export async function explainSyncFailure(err: unknown, cfg: BackendConfig | undefined): Promise<string> {
  const msg = err instanceof Error ? err.message : "Unknown error";
  if (err instanceof HttpError && err.status === 429) return rateLimitMessage(storageName(cfg));
  // Only for the failure shape a blocked request actually has. An HttpError carries a
  // status, which means the request did leave and the permission is not the story.
  if (err instanceof HttpError || !/network|failed to fetch|load failed/i.test(msg)) return msg;

  const origins = backendOrigins(cfg);
  if (!origins.length || (await hasPermission({ origins }))) return msg;

  const where = cfg?.type === "webdav" && cfg.webdav?.url
    ? (() => { try { return new URL(cfg.webdav!.url).host; } catch { return "your storage"; } })()
    : "your storage provider";
  // Cause and cure FIRST, original last. The popup clamps this to two lines, and it was
  // clamping away the half that says what to do about it.
  return `${PERMISSION_LOST_PREFIX}${where}. Open Settings → Storage and press Save to grant it again. The request never left the browser: ${msg}`;
}

export function statusAfterSync(problems: number, pendingConflicts: number): SyncState["status"] {
  if (problems > 0) return "error";
  if (pendingConflicts > 0) return "conflict";
  return "success";
}

// ─── Sync Engine ─────────────────────────────────────────────────────────

/**
 * Bump this whenever a field is added to the packet ENVELOPE (anything outside `payload`).
 *
 * The upload check compares a checksum of the payload, so a change to the envelope does not
 * look like a change at all: adding `device_label` left every existing file on the backend
 * without one, forever, because nothing about the bookmark tree had changed. The device
 * list then showed "Unnamed device" for machines that were perfectly well named.
 *
 * Folding this into the tag means one re-upload per device per bump, which is exactly the
 * cost of the change. Same mechanism the encryption form and the destination already use.
 */
// env3: `device_browser` (#10).
const PACKET_ENVELOPE = "env3";

export class SyncEngine {
  public isSyncing = false;
  // Asked once per engine: the answer cannot change while the browser runs.
  private browserIdentity: Promise<DeviceBrowser | null> | undefined;
  private resolver: ConflictResolver;
  // Peers we couldn't safely consume this sync because they disagree on encryption
  // (plaintext peer while we encrypt, encrypted peer we can't decrypt, or a wrong
  // passphrase). Keyed by device_id so the same peer isn't reported once per data
  // type. Non-fatal: we skip merging that peer but still upload our own file, so the
  // group self-heals once every device uses the same E2EE setting + passphrase.
  private encryptionWarnings = new Map<string, string>();
  /**
   * The data types behind this cycle's problems, for the popup's stream colours.
   *
   * Every problem the engine can attribute to a type adds itself here: a permission that
   * is gone, a `syncType` that threw, a peer we could not decrypt. What stays out is a
   * failure with no type to blame (the backend refused the connection, the setup is
   * incomplete), and the popup reads an empty set as "all of them", which is what that
   * kind of failure actually means.
   */
  private failedTypes = new Set<DataType>();
  /**
   * Types already warned about for a missing optional permission. The condition lasts
   * until the user grants it, so warning every cycle only grew the log's ×N counter
   * (×1276 over one night in a QuarkPC field report) and rewrote the same error. One
   * warning per incident, cleared as soon as the type is usable again.
   */
  private permissionWarned = new Set<DataType>();
  // The storage metered us this cycle; a clean cycle must not clear the cooldown it set.
  private rateLimitedThisSync = false;
  // Bytes moved over the wire this sync (peer payloads pulled + our packets pushed),
  // accumulated across data types and folded into the cumulative `bytes_transferred`
  // stat at the end. Reset per sync so it's a per-run tally, not a running double-count.
  private bytesThisSync = 0;
  // The other devices whose files this sync read, across every type. Only the rating
  // card asks (lib/rate-prompt.ts): a sync with no other device has nothing to show yet.
  private peersThisSync = new Set<string>();
  // Set once the rating card has counted all the syncs it needs, so the rest of this
  // worker's life does not even read the counter.
  private rateCountDone = false;
  // Types whose own file is missing from the folder this sync, so the upload must go out
  // even though the local checksum record says this content already went. Rebuilt every
  // sync by `findOwnMissingFiles` and consumed by `uploadIfChanged`.
  private ownFilesMissing = new Set<DataType>();
  // What the mass-delete guard refused this sync, and which peer asked (recovery
  // signal). Non-null → an unusual deletion was blocked; sync() saves an auto-snapshot
  // and flags state.recovery_notice so the popup can surface it and Settings → Activity
  // can offer to apply it.
  //
  // Two devices can each ask on the same cycle, and what is kept is the LARGEST single
  // block, not a running sum. Summing them broke the notice both ways: `blocked` was a
  // total while `cap` and `localTotal` came from whichever peer happened to be last, so
  // two peers asking for 48 each out of one 49-bookmark tree read as "96 of your 49" —
  // and the Apply button then armed an approval for 96, a ceiling larger than either
  // deletion the user had actually been shown. One block, and the numbers describing it,
  // always belong together.
  private bulkBlockedThisSync:
    | (BulkDeleteBlock & { device_id?: string; device_label?: string | null })
    | null = null;
  /** Local change guard: true → this cycle must NOT publish our bookmark file. Reset at
   * the top of sync(), read by uploadIfChanged, the one gate every upload path uses. */
  private guardHoldThisSync = false;
  /** The banner the popup shows while that hold is in effect. */
  private guardNoticeThisSync: SyncState["guard_notice"] = null;
  /** Set when a held drift streak ended this cycle, so a one-time "resumed" log line fires. */
  private guardClearedThisSync = false;
  /**
   * The user's approval for a blocked deletion, read once per sync and cleared as it is
   * read, then handed to every bookmark merge this sync runs.
   *
   * The lifetime is the point. The approval used to live in storage until a merge that
   * went over the cap consumed it, which sounds like "one incident" and is not: a sync
   * that never reached such a merge left it armed with nothing to spend it on. Arm it,
   * lose the backend for that cycle, and it sat there until some unrelated peer deletion
   * happened to fit under it — applied silently, no restore point, nothing in the log.
   *
   * Read-and-clear at the top of the sync gives it exactly one cycle, whatever happens
   * inside that cycle. It also fixes the multi-peer case for free: every merge in the
   * sync sees the same value, so two peers each asking for a deletion the user approved
   * both go through, instead of the first one consuming the latch and the second being
   * blocked again. If the sync then fails before the merge, the approval is spent for
   * nothing and the user clicks again — the guard re-blocks, so the card comes back.
   * Losing an approval is recoverable in one click; leaving one armed is not.
   */
  private bulkApprovedThisSync = 0;
  // Canonical URL -> local last-visit time, built at most once per sync and shared by
  // every peer's history import. Null until a history import needs it, so a cycle that
  // syncs no history never pays for it. See `buildLocalHistoryIndex`.
  private historyIndexThisSync: Map<string, number> | null = null;

  constructor(
    private settings: SyncSettings,
    private onStateChange: (state: SyncState) => void
  ) {
    this.resolver = new ConflictResolver(settings.conflict_strategy);
    // Settings are the source of truth for the namespace this device writes. An old
    // settings blob has no compat_mode, which resolves to "upstream".
    setCompatMode(settings.compat_mode);
  }

  async updateSettings(settings: SyncSettings): Promise<void> {
    // Encryption state/passphrase change → forget the last-upload checksums so the
    // next sync re-uploads every type in the new encryption form. The checksum is
    // over the plaintext payload, so without this, toggling E2EE on wouldn't change
    // the checksum and the device's own file would stay plaintext on the backend
    // forever (peers then keep seeing it as an unencrypted device).
    const encChanged =
      this.settings.encryption_enabled !== settings.encryption_enabled ||
      this.settings.encryption_passphrase !== settings.encryption_passphrase;
    this.settings = settings;
    this.resolver.updateStrategy(settings.conflict_strategy);
    setCompatMode(settings.compat_mode);
    if (encChanged) await clearUploadChecksums();
  }

  /**
   * Is end-to-end encryption ACTUALLY active here — enabled AND a passphrase set?
   *
   * Not the same as "a passphrase exists": turning E2EE off keeps the passphrase in
   * settings. Conflating the two is what let the snapshot index be read as encrypted and
   * then rewritten in PLAINTEXT on shared storage. This expression was inlined in five
   * places; one accessor so the copies can't drift apart again.
   */
  private get e2eeActive(): boolean {
    return !!this.settings.encryption_enabled && !!this.settings.encryption_passphrase;
  }

  /**
   * Why this peer's packet can't be consumed here, decided WITHOUT decrypting anything.
   *
   * Two of the three encryption disagreements are visible from the packet's `encrypted`
   * flag alone, and both used to be detected only inside applyRemote — which the `manual`
   * strategy never calls. So a device on `manual` was never told it had dropped out of the
   * encrypted group, and it queued conflicts for peers whose data it could not read.
   *
   *   "silent"  we encrypt, the peer doesn't. Usually a stale/orphan file from a removed
   *             device, and not this device's problem — it must not warn forever.
   *   a message the peer encrypts and we don't: the group is encrypted and we're the odd
   *             one out. Surfaced on the device that can actually fix it.
   *   null      nothing detectable from here.
   *
   * The third case — encrypted peer, WRONG passphrase — needs an actual decrypt (a 600k
   * PBKDF2), so it is deliberately not probed here. On the auto path applyRemote still
   * catches it; on the manual path it surfaces when the user picks "Use remote", which the
   * popup now reports instead of swallowing.
   */
  private encryptionBarrier(packet: SyncPacket): "silent" | string | null {
    if (this.e2eeActive && !packet.encrypted) return "silent";
    if (packet.encrypted && !this.e2eeActive) {
      return (
        "Some of your devices are end-to-end encrypted. Enable E2EE with the same " +
        "passphrase here (Settings → Advanced) to sync with them."
      );
    }
    return null;
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────

  async sync(types?: DataType[], options: { force?: boolean } = {}): Promise<SyncOutcome> {
    if (this.isSyncing) {
      logger.warn("SyncEngine", "Already syncing, skipping");
      return "already-running";
    }
    // Claim the in-memory guard SYNCHRONOUSLY, before any await, so a tight
    // double-trigger can't both pass the check above and double-run one data type.
    // (It used to be set only after `await acquireSyncLock`, leaving that window
    // open.) Reset on every early return below so a no-op sync doesn't wedge it on.
    this.isSyncing = true;

    // A metered server keeps refusing requests for a whole window (Nutstore: 30 min),
    // so polling every minute through it spends the NEXT window before it opens and
    // "wait for the window to pass" can never work. Only automatic sync is parked:
    // "Sync now" passes force and always runs.
    if (!options.force) {
      const remaining = await syncCooldownRemaining();
      if (remaining > 0) {
        logger.info("SyncEngine", `Automatic sync paused for another ${Math.ceil(remaining / 60000)} min after a rate limit`);
        this.isSyncing = false;
        return "cooling-down";
      }
    }

    if (!this.settings.active_backend) {
      // Console only. This is every device before setup finishes, with the alarm already
      // running, so as a warning it opened a new device's Activity log, once a minute for
      // as long as setup stayed open, which can now be a day.
      logger.info("SyncEngine", "No active backend configured");
      this.isSyncing = false;
      return "no-backend";
    }

    const backendConfig = this.settings.backends.find(
      (b) => b.type === this.settings.active_backend
    );
    if (!backendConfig) {
      logger.warn("SyncEngine", "Active backend config not found");
      this.isSyncing = false;
      return "no-backend";
    }

    // Every data type can be switched off, including the last one, and with none left the
    // loop below ran over an empty list and finished with no problems to report. So the
    // sync reported SUCCESS and the popup said "Synced" while Kesonode moved nothing at all,
    // once a minute, after a round trip to the user's storage to accomplish it. Reported
    // from a device on 2026-08-28, and the same shape as the other three "reported success
    // while it happened" bugs in this release.
    //
    // Not an error: nothing turned on is a setting, not a fault. "Ready" is the honest
    // word for configured with nothing to do, and a pending conflict keeps the status it
    // earned, since it stays answerable whatever is switched on.
    //
    // Returned BEFORE the lock and before createBackend, so an install with everything off
    // makes no network request at all.
    const typesToSync = types ?? this.settings.enabled_types;
    if (typesToSync.length === 0) {
      logger.info("SyncEngine", "No data types are turned on, so there is nothing to sync");
      const prev = await getState();
      const status = prev.pending_conflicts.length > 0 ? "conflict" : "idle";
      // Only when that is news. Every alarm used to write the same status back and broadcast
      // it, which rewrote the state and woke an open popup once a minute to say nothing had
      // changed (checklist O). The first cycle after everything was switched off still moves
      // "Synced" or an old error to "Ready".
      if (prev.status !== status) this.onStateChange(await setState({ status }));
      this.isSyncing = false;
      return "nothing-enabled";
    }

    // Cross-instance guard (CO-4): a persisted TTL lock so a sync interrupted by an
    // MV3 worker suspension can't have a later wake double-run. A stale lock is
    // ignored, so a crashed sync self-heals. isSyncing (above) guards within one
    // worker instance; this guards across suspend/recreate.
    if (!(await acquireSyncLock(SYNC_LOCK_TTL_MS))) {
      logger.warn("SyncEngine", "Another sync holds the lock, skipping");
      this.isSyncing = false;
      return "already-running";
    }

    // NOTHING may await between taking the lock above and the try below, because only the
    // try has the `finally` that gives the lock back. `finishSync` documents the same
    // hazard at the other end of the sync, where a throw from `disconnect()` used to
    // strand `isSyncing` on for the worker's whole lifetime; this is the mirror of it.
    // The per-sync fields are plain assignments, and `createBackend` is a synchronous
    // factory over a config we just found in settings, so the window holds no await at all.
    this.encryptionWarnings.clear();
    this.failedTypes.clear();
    this.rateLimitedThisSync = false;
    this.bytesThisSync = 0;
    this.peersThisSync.clear();
    this.bulkBlockedThisSync = null;
    this.historyIndexThisSync = null;
    this.guardHoldThisSync = false;
    this.guardNoticeThisSync = null;
    this.guardClearedThisSync = false;
    const backend = createBackend(backendConfig);

    try {
      // Read and cleared together, before the sync can do anything with it: from here on
      // the approval is spent whatever this cycle makes of it. See `bulkApprovedThisSync`.
      // Inside the try, so a storage read that fails gives the lock back like any other
      // failure rather than holding it for the full TTL.
      this.bulkApprovedThisSync = await getBulkDeleteApproval();
      if (this.bulkApprovedThisSync > 0) await setBulkDeleteApproval(0);
      const state = await setState({ status: "syncing", last_error: null, recovery_notice: null, guard_notice: null });
      this.onStateChange(state);

      await backend.connect();

      // Ask BEFORE anything is merged or published. A device that already has its own
      // bookmarks must not have a peer's tree folded in (or its own tree published) until
      // the user says which side wins. Inside the try, so the lock is always given back;
      // idempotent, so the next alarm does not rewrite the state and wake the popup again.
      const firstSyncPeers = await this.detectFirstSync(backend, typesToSync).catch((err) => {
        // The question is an addition to syncing, not a precondition for it: a probe
        // that cannot run must fall through to the ordinary merge, never fail a cycle.
        logger.info("FirstSync", `Direction check could not run, continuing with the normal merge: ${err instanceof Error ? err.message : err}`);
        return null;
      });
      if (firstSyncPeers !== null) {
        const prev = await getState();
        if (!prev.first_sync_pending) {
          const pending = await setState({
            status: "idle",
            first_sync_pending: { at: new Date().toISOString(), peer_count: firstSyncPeers },
          });
          this.onStateChange(pending);
          if (this.settings.notifications_enabled) notifyFirstSync();
          logger.event("FirstSync", `Waiting for a sync direction: this device has bookmarks and ${firstSyncPeers} peer(s) already have some`);
        }
        return "first-sync-pending";
      }

      const typeErrors = await this.syncAllTypes(typesToSync, backend, state);

      // The storage refused us for quota reasons. Nothing here threw — the refusals
      // were handled where they happened (a peer file skipped, an index left alone) —
      // so without this the cycle would report success and the next minute would do
      // exactly the same thing, spending the window's quota again. The warning on the
      // backend is what says it; this is where it is acted on.
      if (backend.rateLimited) await this.noteRateLimit();

      // A device that disagrees on encryption isn't a hard failure — we still synced
      // and re-uploaded our own (correctly-encrypted) data, so the group self-heals
      // once it's aligned. Surface it as a visible error message so the user fixes
      // the misconfig, but only after the upload has happened (never before — that's
      // what used to deadlock the group into mutually-stale plaintext files).
      const recovery = await this.recordBlockedDeletion(
        this.bulkBlockedThisSync,
        typesToSync.includes("bookmarks"),
      );
      const guardNotice = await this.recordGuardIncident(
        this.guardNoticeThisSync,
        typesToSync.includes("bookmarks"),
        this.guardClearedThisSync,
      );

      // Encryption disagreements and per-type failures share one surface: both mean
      // "the sync ran and published what it could, but something needs the user's
      // attention". Neither aborts the cycle.
      // Each distinct message once. The encryption ones are kept per peer but name no
      // device, so a folder with two encrypted peers printed the same sentence twice.
      const problems = [...new Set([...this.encryptionWarnings.values(), ...typeErrors])];

      // A backend deliberately skips a peer whose file it cannot read (one bad file must
      // not stop the whole merge), but that used to look like a CLEAN sync: we published
      // our own packet and reported success with fewer devices than the folder holds —
      // the exact "both browsers mind their own business" report. Surface it as an error.
      const unreadable = [...new Set(backend.failedPeers ?? [])];
      if (unreadable.length) {
        problems.push(
          `Couldn't read ${unreadable.length} device file(s) from the storage (${unreadable.slice(0, 2).join(", ")}${unreadable.length > 2 ? ", …" : ""}). Their data was NOT merged this sync — check that the storage is reachable; Settings → Activity shows the HTTP status for each file.`
        );
      }
      const prevState = await getState();
      // Drop a queued conflict for a type that cannot have one. Before CONFLICTABLE_TYPES
      // narrowed the gate, sessions and extensions went through it like bookmarks, so a
      // device on `manual` can be carrying conflicts about a peer's open tabs. Nothing
      // would ever re-queue or clear those now, so the banner would ask the user to choose
      // between two devices' tab lists for good. Cleared on the first sync after the
      // upgrade instead, along with any packet parked behind them.
      // The other way to be left holding one is to leave `manual`: every other strategy
      // answers in the merge, so this very sync folded those peers in and the cards are
      // now asking about something already decided. See conflictsStillOpen.
      const manual = this.settings.conflict_strategy === "manual";
      const conflicts = conflictsStillOpen(prevState.pending_conflicts, this.settings.conflict_strategy);
      const stale = prevState.pending_conflicts.length - conflicts.length;
      if (stale > 0) {
        await pruneConflictPackets(conflicts.map((c) => c.id));
        logger.event(
          "SyncEngine",
          manual
            ? `Dropped ${stale} pending conflict(s) for a data type that can't have one (sessions and extensions are per-device lists, not competing versions)`
            : `Dropped ${stale} pending conflict(s): conflict resolution is no longer set to Manual, so this sync resolved them itself`
        );
      }
      const newState = await setState({
        // Read AFTER the fold, so it sees any conflict syncType just queued.
        status: statusAfterSync(problems.length, conflicts.length),
        last_sync: new Date().toISOString(),
        last_error: problems.length ? problems.join(" ") : null,
        failed_types: [...this.failedTypes],
        bytes_transferred: prevState.bytes_transferred + this.bytesThisSync,
        recovery_notice: recovery,
        guard_notice: guardNotice,
        ...(stale > 0 ? { pending_conflicts: conflicts } : {}),
      });
      this.onStateChange(newState);
      logger.info("SyncEngine", problems.length ? `Sync complete with ${problems.length} problem(s)` : "Sync complete");
      // A cycle that got through unmetered means the window has passed, so automatic
      // sync resumes on its normal interval right away instead of waiting out the rest.
      if (!this.rateLimitedThisSync) await clearSyncCooldown();
      // A "keep forever" the storage refused during a 403 window gets its file renamed
      // on the first cycle that reaches the backend again, without waiting for Settings.
      try {
        await flushPendingPins(backend, this.settings);
      } catch (e) {
        logger.warn("SyncEngine", `Could not finish queued restore-point renames: ${e instanceof Error ? e.message : e}`);
      }
      // `noteCleanSync` never throws, so it cannot turn this sync into a failed one.
      if (!this.rateCountDone && newState.status === "success" && !recovery && !guardNotice && this.peersThisSync.size > 0) {
        this.rateCountDone = await noteCleanSync();
      }

    } catch (err) {
      await this.noteRateLimit(err);
      const msg = await explainSyncFailure(err, backendConfig);
      // No `failed_types` here on purpose, cleared rather than collected: a sync that died
      // before or around the per-type loop (the backend refused, the config is gone) has
      // stalled every stream, and that is exactly what an empty list tells the popup.
      const newState = await setState({ status: "error", last_error: msg, failed_types: [] });
      this.onStateChange(newState);
      // The EXPLAINED message, not the raw error. The Activity log is where someone goes
      // to find out what happened, and it was the one place still showing a bare
      // "NetworkError when attempting to fetch resource" once per minute.
      logger.error("SyncEngine.sync", msg);
    } finally {
      await this.finishSync(backend);
    }
    // Reached whether the sync succeeded or was recorded as an error — either way it
    // ran, which is what the caller needs to distinguish from bailing at the door.
    return "ran";
  }

  /**
   * Park automatic sync for one window when the storage meters us.
   *
   * A 429, or Nutstore's 403 standing in for one, means the server will keep refusing
   * until its window rolls over. Retrying every minute spends that window's quota too,
   * which is why the advice to "wait for the window to pass" never worked. One notice
   * per cooldown, and a manual "Sync now" is never gated.
   *
   * Called with NO argument it means the BACKEND said so (`backend.rateLimited`) rather
   * than an exception arriving here. That distinction is the whole point. Most refusals
   * never reach this function at all: one unreadable peer file is skipped so the other
   * peers still merge, the device list falls back to a cached name, the shared snapshot
   * index is left alone rather than overwritten. Each of those handled the refusal
   * exactly as it should — and each of them then let the NEXT minute do the same thing.
   * A refusal that is only logged is a refusal that is repeated, and on a free Nutstore
   * account (600 requests per 30 minutes, counted across every other app using it) that
   * is how an account ends up permanently over its quota.
   */
  private async noteRateLimit(err?: unknown): Promise<void> {
    if (err !== undefined) {
      if (!(err instanceof HttpError) || (err.status !== 429 && !err.rateLimited)) return;
    }
    this.rateLimitedThisSync = true;
    if (!(await startSyncCooldown())) return;
    logger.warn("SyncEngine", `Automatic sync paused for ${SYNC_COOLDOWN_MS / 60000} minutes: the storage is refusing requests for a rate-limit window. "Sync now" still works; raise Sync interval in Settings → Device so the next window stays clear.`);
  }

  /**
   * Tear-down after a sync, in the only order that cannot strand anything.
   *
   * The `finally` block used to start with `await backend.disconnect()`, so a throw from
   * it skipped everything after: `isSyncing` stayed on for the rest of the worker's
   * lifetime (every later sync answering "already running") and the persisted lock sat
   * there until its TTL. The in-memory guard is cleared FIRST and synchronously — it
   * cannot fail — and the two awaits are isolated so neither can strand the other.
   *
   * No backend's `disconnect()` can throw today, so this is hardening rather than a live
   * bug. It costs nothing, and the previous ordering only looked safe by accident.
   */
  private async finishSync(backend: ReturnType<typeof createBackend>): Promise<void> {
    this.isSyncing = false;
    try {
      await releaseSyncLock();
    } catch (e) {
      logger.warn("SyncEngine", `Releasing the sync lock failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await backend.disconnect();
    } catch (e) {
      logger.warn("SyncEngine", `Backend disconnect failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Sync every requested data type, isolating failures. One type must not take the
   * others down with it — the same principle the peer fold and the encryption warnings
   * already follow. Returns one message per failed type; `sync()` surfaces them.
   *
   * This was a bare loop whose throw propagated straight out of `sync()`, so a single
   * failing type aborted every type AFTER it and skipped the post-loop work entirely.
   * Concretely: revoking the optional `history` (or `management`) permission in
   * chrome://extensions makes the export throw, which silently stopped BOOKMARKS from
   * syncing and meant the mass-delete recovery snapshot never ran. Which types survived
   * was arbitrary too — `enabled_types` is appended to as the user toggles, so it is not
   * a fixed order.
   */
  private async syncAllTypes(
    types: DataType[],
    backend: ReturnType<typeof createBackend>,
    state: SyncState
  ): Promise<string[]> {
    const errors: string[] = [];

    // Sort out the types whose API isn't there BEFORE anything else touches them — and
    // note that "isn't there" has two very different meanings that need opposite handling.
    //
    // The browser DOESN'T IMPLEMENT IT. "Firefox for Android has no bookmarks API" is a
    // standing fact about the device, not something that went wrong this cycle. Recording
    // it in `last_error` would pin the extension to a red error state forever, every
    // minute, for a condition the user cannot fix, while burying the real failures
    // underneath it. Skipped quietly; Settings is where it's explained, next to the toggle.
    //
    // The PERMISSION IS GONE. The type is switched on, the browser can do it, and the
    // optional permission has simply not been granted (or was revoked in the browser's own
    // extension settings, which no extension is told about). That IS the user's to fix, and
    // staying quiet about it would be worse than the raw crash it replaces: the type would
    // sit there enabled and never sync a thing. So it's reported, and it says how to fix it.
    //
    // Getting these two backwards is exactly the bug a user hit on 1.2.0: history and
    // extensions were enabled with their permissions missing, so every cycle logged a raw
    // "undefined is not an object (evaluating 'u.history.search')" and nothing said why.
    const runnable: DataType[] = [];
    for (const t of types) {
      const state = await dataTypeAvailability(t);
      if (state.state === "ready") {
        this.permissionWarned.delete(t);
        runnable.push(t);
      } else if (state.state === "unsupported") {
        this.permissionWarned.delete(t);
        logger.info("SyncEngine", `Skipping ${t}: ${unsupportedReason(t)}`);
      } else {
        // "any more" was a guess: on QuarkPC the permission was never granted at all,
        // and no amount of toggling produced a prompt. Name the button that re-asks,
        // and warn ONCE per incident rather than every minute for as long as it lasts.
        const msg = `${t}: Kesonode doesn't have the "${state.permission}" permission, so this can't sync. Open Settings → Data Types and press "Grant access"; if no prompt appears, grant it in your browser's extension settings.`;
        if (!this.permissionWarned.has(t)) {
          this.permissionWarned.add(t);
          logger.warn("SyncEngine", msg);
        }
        errors.push(msg);
        this.failedTypes.add(t);
      }
    }

    await this.findOwnMissingFiles(backend, runnable);
    for (const dataType of runnable) {
      try {
        await this.syncType(dataType, backend, state);
      } catch (err) {
        await this.noteRateLimit(err);
        // syncType already logged it — just collect the message.
        // A rate limit is said without the type: it is one fact about the storage, so every
        // type hitting it folds into a single sentence instead of one per type.
        if (err instanceof HttpError && err.status === 429) {
          const cfg = this.settings.backends.find((b) => b.type === this.settings.active_backend);
          errors.push(rateLimitMessage(storageName(cfg)));
        } else {
          errors.push(`${dataType}: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.failedTypes.add(dataType);
      }
    }
    return errors;
  }

  /**
   * Put back anything of OURS that has gone missing from the folder.
   *
   * `uploadIfChanged` skips an upload when the LOCAL checksum record says this exact
   * content already went out. That record lives on this device, so it knows nothing about
   * the file being deleted at the other end — and then a payload that does not change on
   * its own is never re-uploaded. The installed-extension list is exactly that: it can sit
   * unchanged for months.
   *
   * Three ways that happens, all real:
   *  - another device used "Forget this device" on us,
   *  - the user tidied the folder by hand at their storage provider (which we have
   *    actively suggested as a workaround),
   *  - the provider lost a file.
   *
   * In every case the device carries on syncing and quietly stops publishing, which is the
   * same silent shape as the device_id bug fixed earlier: present, working, invisible.
   *
   * This only MARKS the type; `uploadIfChanged` does the re-upload and logs it. That split
   * matters, because it is not this pass's business whether an upload happens at all: an
   * EMPTY payload is deliberately never uploaded (`isPayloadEmpty`), so clearing its
   * checksum here produced a file that stayed missing, was noticed missing again on the
   * next cycle, and warned once a minute forever. Real case: a browser whose only open tab
   * is the extension page has no syncable session, so its sessions file could never come
   * back after another device used Forget on it. Marking instead means a type that is never
   * uploaded is never announced — and the type that this feature exists for (the
   * installed-extension list, unchanged for months) still goes out on the same cycle.
   *
   * One listing per sync, not per type. Never fatal: if the listing fails we simply do not
   * know, and a sync that works is worth more than this check.
   */
  private async findOwnMissingFiles(
    backend: ReturnType<typeof createBackend>,
    types: DataType[]
  ): Promise<void> {
    this.ownFilesMissing = new Set();
    let names: string[];
    try {
      names = (await Promise.all(listPrefixes().map((p) => backend.listFiles(p)))).flat();
    } catch (err) {
      // Still not fatal, but no longer silent. Saying nothing left this safety net switched
      // off while the Activity log showed a clean sync, so a device whose own file had been
      // deleted from the folder looked perfectly healthy for as long as the listing kept
      // failing. That is precisely the situation the check exists to end.
      //
      // Once per incident, though, not once per cycle. The listing is re-checked every
      // sync, so a folder that cannot be read is ONE condition however long it lasts, and
      // `warn` is retained: a kept entry a minute turns the 200-entry log over in about
      // three hours and evicts whatever the user was sent there to read. Same trade, and
      // the same latch shape, as the blocked-deletion warning above (#20).
      const detail = `Couldn't list the sync folder, so this sync can't tell whether our own files are still there: ${err instanceof Error ? err.message : err}`;
      if (await getListFailureNoted()) logger.info("findOwnMissingFiles", detail);
      else {
        logger.warn("findOwnMissingFiles", detail);
        await setListFailureNoted(true);
      }
      return;
    }
    // Reading first so an ordinary sync writes nothing: the latch is clear almost always,
    // and this runs on every cycle.
    if (await getListFailureNoted()) {
      await setListFailureNoted(false);
      logger.event("findOwnMissingFiles", "The sync folder can be listed again.");
    }
    const present = new Set(names);
    for (const dataType of types) {
      if (present.has(packetFileName(dataType, this.settings.device_id))) continue;
      // Nothing recorded means we have never uploaded this type, so there is nothing that
      // has gone missing — leave the normal first-upload path to handle it.
      if ((await getLastUploadChecksum(dataType)) === null) continue;
      this.ownFilesMissing.add(dataType);
    }
  }

  /**
   * The mass-delete guard refused a peer's deletions this sync — the tree is still
   * intact, so preserve it as a restore point and flag the event for the popup
   * ("unusual deletion blocked", with a pointer to Settings → Activity).
   *
   * At most ONE restore point per incident. The guard re-evaluates the same peer
   * deletions on every merge (their tombstones live for 90 days and the local
   * bookmarks are still present, because we refused to remove them), so this used to
   * write a snapshot on every cycle — and with a 10-slot ring on a 60s interval that
   * evicted every pre-incident restore point within ~10 minutes, destroying exactly
   * the history the user would recover from. Repeat syncs can't add value anyway: the
   * deletions stay blocked, so the tree they'd capture is the same one.
   *
   * The latch clears on the first sync that merged bookmarks and blocked nothing — a
   * later block is then a NEW incident and earns its own restore point. `syncedBookmarks`
   * gates that: a sync that never touched bookmarks proves nothing about the guard.
   *
   * The notice itself is returned on every blocked sync (not just the first), so the
   * banner keeps showing while the situation persists.
   */
  private async recordBlockedDeletion(
    blocked: (BulkDeleteBlock & { device_id?: string; device_label?: string | null }) | null,
    syncedBookmarks: boolean
  ): Promise<SyncState["recovery_notice"]> {
    if (!blocked) {
      if (syncedBookmarks && (await getRecoverySnapshotTaken())) {
        await setRecoverySnapshotTaken(false);
      }
      return null;
    }
    // One read, two decisions. The latch means "this incident is already on the
    // record", which is true of the restore point and of the Activity-log warning
    // alike, so they belong behind the same test rather than two drifting ones.
    const alreadyRecorded = await getRecoverySnapshotTaken();
    if (!alreadyRecorded) {
      // THE retained warning for a blocked deletion, written once per incident. The
      // merge only logs to the console, because it re-evaluates the same peer
      // deletions on every cycle and writing this from there filled the log with one
      // identical pair a minute (#20). Naming the peer and the total is what makes it
      // actionable rather than alarming (#18).
      const who = blocked.device_label ? ` asked for by ${blocked.device_label}` : "";
      // A piece under the cap on its own is held back for what came before it (#41), and
      // the line has to say so, or "10 of your 40, cap 30" reads as the guard misfiring.
      const recent = blocked.recent
        ? `, counting the ${blocked.recent} that other devices removed here in the last day`
        : "";
      logger.warn(
        "mergeBookmarks",
        `Blocked a deletion of ${blocked.blocked} of your ${blocked.localTotal} bookmarks` +
          `${who} (cap ${blocked.cap}, ${blocked.pct}% of the tree${recent}). Nothing was removed and a ` +
          "restore point was saved. Apply it or keep them in Settings → Activity."
      );
      try {
        await this.snapshotNow({ origin: "auto" });
        await setRecoverySnapshotTaken(true);
      } catch (e) {
        // Leave the latch clear so the next cycle retries the write — a failed
        // snapshot must not count as "this incident is covered". The warning above
        // then repeats on the retry, which is the right trade: a backend that cannot
        // hold the restore point is worth saying twice, and it is not the steady state.
        logger.warn("SyncEngine", `Recovery snapshot failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return {
      at: new Date().toISOString(),
      blocked: blocked.blocked,
      cap: blocked.cap,
      local_total: blocked.localTotal,
      recent: blocked.recent,
      sample: blocked.sample,
      device_id: blocked.device_id,
      device_label: blocked.device_label ?? null,
    };
  }

  /**
   * One restore point and one retained warning per held-drift incident.
   *
   * A tree that keeps drifting is re-evaluated every cycle, so without the latch this
   * would evict the 10-slot snapshot ring in minutes — exactly why the mass-delete
   * guard's latch exists. The guard never changes the tree, so the restore point is a
   * precaution, not a repair: it is there in case the source of the drift is hostile.
   */
  private async recordGuardIncident(
    notice: SyncState["guard_notice"],
    syncedBookmarks: boolean,
    cleared = false
  ): Promise<SyncState["guard_notice"]> {
    if (!notice) {
      if (syncedBookmarks && (await getGuardSnapshotTaken())) {
        await setGuardSnapshotTaken(false);
      }
      // The hold just lifted on its own: one quiet cycle cleared the streak. A short, ok-level
      // line so the user can see in Settings → Activity that publishing is flowing again — not
      // a warning, because nothing was wrong that needed action.
      if (cleared) {
        logger.event("changeGuard", "Publishing resumed: this device's bookmark tree settled after the local change guard held it. Nothing was lost.");
      }
      return null;
    }
    if (!(await getGuardSnapshotTaken())) {
      logger.warn(
        "changeGuard",
        `Paused publishing this device's bookmarks: ${notice.changed} entries changed since ` +
          `the last cycle (cap ${notice.cap}, ${notice.unstableRounds} cycles in a row). ` +
          "Nothing was removed or reverted, and a restore point was saved. " +
          "Publishing resumes on its own once the tree stops changing. " +
          "If you did not make this change, check whether your browser's own bookmark " +
          "sync is running alongside Kesonode. See Settings → Activity."
      );
      try {
        await this.snapshotNow();
        await setGuardSnapshotTaken(true);
      } catch (e) {
        logger.warn("SyncEngine", `Guard recovery snapshot failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return notice;
  }

  // ─── Snapshots (restore points) ───────────────────────────────────────

  private activeBackendConfig(): BackendConfig | null {
    return this.settings.backends.find((b) => b.type === this.settings.active_backend) ?? null;
  }

  private async withBackend<T>(fn: (b: ReturnType<typeof createBackend>) => Promise<T>): Promise<T> {
    const cfg = this.activeBackendConfig();
    if (!cfg) throw new Error("No active backend configured");
    const backend = createBackend(cfg);
    await backend.connect();
    try { return await fn(backend); }
    finally { await backend.disconnect(); }
  }

  /**
   * Every device with files in the sync folder.
   *
   * Deliberately cheap. The inventory comes from the file listing, and then ONE file per
   * device is fetched for its name: the smallest type that device has, because a history
   * packet can be megabytes and a device list has no business downloading it. The last upload
   * comes from the listing's modification times where the backend has them, and from that
   * one packet's timestamp where it does not (GitHub). The name and the timestamp sit outside
   * the encrypted payload, so this works with E2EE on and without the passphrase.
   *
   * An unreadable file costs that device its name, not the whole list: the same rule as
   * downloadAll, and for the same reason.
   */
  /**
   * The device list as this device already knows it, with no request to the backend.
   *
   * This device comes first and is always present — its own packets are never
   * downloaded, so it is exactly the row a "peer names only" list would be missing.
   * Everything else comes from the names learned on earlier syncs.
   */
  private async knownDevices(): Promise<DeviceInfo[]> {
    const known = await readPeerLabels();
    const selfId = this.settings.device_id;
    const peers: DeviceInfo[] = Object.entries(known)
      .filter(([device_id]) => device_id !== selfId)
      .map(([device_id, rec]) => ({
        device_id,
        label: rec.label,
        lastSeen: null,
        browser: rec.browser ?? null,
        types: [] as DataType[],
        isSelf: false,
      }));
    if (selfId) {
      peers.unshift({
        device_id: selfId,
        label: this.settings.device_label || null,
        lastSeen: null,
        browser: null,
        types: [...this.settings.enabled_types],
        isSelf: true,
      });
    }
    return peers;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const cfg = this.activeBackendConfig();
    if (!cfg) return [];
    // A cooldown means the storage is refusing every request in this window. Opening
    // Settings → Activity during one used to show a wall of 403 text where the device
    // list belongs, and each attempt spent quota the next window needs. The local view
    // is the same list the fallback below shows, for free.
    if ((await syncCooldownRemaining()) > 0) return this.knownDevices();
    return this.withBackend(async (b) => {
      // Names learned from packets this device has already downloaded. A packet we can
      // read now wins; the cache is only there for a failed read or an old packet that
      // never carried a name.
      const known = await readPeerLabels();
      const learned: { device_id: string; device_label: string }[] = [];
      // Where the listing carries modification times, a device's last upload is the newest of
      // them across its files (#30). The packet read below still names the device, but its
      // timestamp is only the date of whichever file was cheapest to read, and an extension
      // list unchanged for days froze the row of a device that uploads bookmarks every minute.
      // One listing per readable namespace: isolated mode still sees upstream peers.
      const listed: ListedFile[] = [];
      try {
        for (const prefix of listPrefixes()) {
          const part = b.listFilesWithTimes
            ? await b.listFilesWithTimes(prefix)
            : (await b.listFiles(prefix)).map((name) => ({ name, modified: null }));
          listed.push(...part);
        }
      } catch (err) {
        // The folder itself can't be listed — almost always a rate-limited window.
        // Showing an error and an EMPTY list is the worst possible answer here: the
        // devices are all still there, still named, and the names this device learned
        // earlier are exactly what the list is for. So show them, and park the sync.
        logger.warn("listDevices", `Couldn't list the sync folder (${err instanceof Error ? err.message : err}); showing the devices this device knows about`);
        if (b.rateLimited) await this.noteRateLimit();
        return this.knownDevices();
      }
      const deviceFiles = new Map<string, Map<DataType, string>>();
      const newestUpload = new Map<string, number>();
      const pattern = deviceFilePattern();
      for (const { name, modified } of listed) {
        // Snapshot files live alongside these and are not per-device, so match the four
        // data types by name rather than accepting anything with an id in it.
        const m = pattern.exec(name);
        if (!m) continue;
        const deviceId = m[2];
        let perType = deviceFiles.get(deviceId);
        if (!perType) { perType = new Map(); deviceFiles.set(deviceId, perType); }
        // Remember the ACTUAL file name: in isolated mode a peer may live under either
        // prefix, and rebuilding the name would look in the wrong namespace.
        perType.set(m[1] as DataType, name);
        if (modified !== null) newestUpload.set(deviceId, Math.max(newestUpload.get(deviceId) ?? 0, modified));
      }

      // Smallest first: an extension list is a few KB, a session a few more, a bookmark
      // tree tens, history can be megabytes.
      const CHEAPEST: DataType[] = ["extensions", "sessions", "bookmarks", "history"];
      const out: DeviceInfo[] = [];
      for (const [device_id, files] of deviceFiles) {
        const isSelf = device_id === this.settings.device_id;
        let label: string | null = null;
        let lastSeen: string | null = null;
        let browserInfo: DeviceBrowser | null = null;

        // ── The name learned on an earlier sync comes FIRST ──────────────────
        // It is what the last successful read saw, and asking the storage again
        // costs a request that a metered account counts — one per device per cycle.
        // That is not a small thing: three devices, four data types, a minute apart,
        // is enough to blow through Nutstore's free 600-requests-per-30-minutes
        // quota on its own, and every request after that came back 403.
        //
        // A peer that renames itself re-uploads (the name rides on the upload tag),
        // so the next successful sync refreshes this copy anyway — and the device
        // list is re-read when a sync finishes, which is when it changes.
        const cached = known[device_id];
        if (!isSelf && cached) {
          label = cached.label;
          browserInfo = cached.browser ?? null;
        }

        if (!label) {
          // The smallest file is often the OLDEST: an extension list that never changes was
          // written by whichever build first set the device up, before packets carried a
          // name. Try the next smallest before calling the device unnamed. A history packet
          // can be megabytes, so it is read only when it is the device's only file (#30).
          const candidates = CHEAPEST.filter((t) => files.has(t));
          const small = candidates.filter((t) => t !== "history");
          for (const type of small.length ? small : candidates) {
            // The storage is metering us: every further request in this window is
            // refused and every one of them spends quota the next window needs. Stop
            // here and let the names we already have do the talking.
            if (b.rateLimited) break;
            const name = files.get(type);
            if (!name) continue;
            let p: Partial<SyncPacket>;
            try {
              const raw = await b.getFile(name);
              if (raw === null) {
                // The listing named this file a moment ago, so a null here is a real fetch
                // problem, not an old peer. Try the device's OTHER files before giving up:
                // one refused extensions file must not cost a named device its name when
                // its bookmarks file is perfectly readable.
                logger.warn("listDevices", `${name} is in the folder listing but came back empty; trying another file`);
                continue;
              }
              p = JSON.parse(raw) as Partial<SyncPacket>;
            } catch (err) {
              logger.warn("listDevices", `Couldn't read ${name} (${err instanceof Error ? err.message : err}); trying another file`);
              continue;
            }
            if (!lastSeen) lastSeen = p.timestamp ?? null;
            browserInfo ??= readDeviceBrowser(p.device_browser);
            if (p.device_label) {
              label = p.device_label;
              learned.push({ device_id, device_label: label });
              break;
            }
          }
        }
        // Nothing readable on the backend (or a pre-name build): use the name learned on
        // an earlier sync instead of calling a machine we know "Unnamed device".
        if (!label && !isSelf) {
          label = known[device_id]?.label ?? null;
          if (label) logger.info("listDevices", `${device_id.slice(0, 8)} is named from the local cache; its files could not be read this time`);
        }
        if (!label && !isSelf) {
          logger.info("listDevices", `${device_id.slice(0, 8)} has no device name in any of its files; it will once that device syncs on a build that sends one`);
        }
        // This device's name lives here, in settings, and is always the freshest thing we
        // have: the list reads a packet off the backend, which can be days old or written
        // by a build that never sent a name. What the user typed in Settings → Device is
        // the answer for this machine, whatever its files happen to say.
        if (isSelf) label = this.settings.device_label || null;
        const uploadedAt = newestUpload.get(device_id);
        if (uploadedAt !== undefined) lastSeen = new Date(uploadedAt).toISOString();
        out.push({
          device_id, label, lastSeen,
          browser: browserInfo,
          types: [...files.keys()].sort(),
          isSelf,
        });
      }
      // A refusal anywhere in this listing means the account is over its quota, and the
      // next minute's listing would be refused too. Park automatic sync, exactly as a
      // refused sync does.
      if (b.rateLimited) await this.noteRateLimit();
      // This device first, then the rest newest-seen first; nameless ones sink to the end.
      out.sort((a, c) => {
        if (a.isSelf !== c.isSelf) return a.isSelf ? -1 : 1;
        return (c.lastSeen ?? "").localeCompare(a.lastSeen ?? "");
      });
      // The list is a reader too: a name it found is worth keeping for the next time
      // the backend refuses every file. No-op when nothing changed.
      await rememberPeerLabels(learned);
      return out;
    });
  }

  /**
   * Delete another device's files from the shared folder.
   *
   * This removes NO bookmarks from any browser. The merge is additive, so whatever that
   * device contributed was folded into the others long ago; all this stops is a machine
   * that is gone from going on offering its old state forever. A device that is still
   * running will upload itself again on its next sync, which the UI says out loud.
   *
   * Refuses to target this device. Doing that would delete our own contribution from every
   * peer's view, and it is not what anyone means by "forget a device"; resetting this
   * device is a different action.
   */
  async forgetDevice(deviceId: string): Promise<number> {
    if (deviceId === this.settings.device_id) {
      throw new Error("That's this device. Use Reset to disconnect this one instead.");
    }
    const removed = await this.withBackend(async (b) => {
      let n = 0;
      for (const t of ["bookmarks", "history", "sessions", "extensions"] as DataType[]) {
        // Both namespaces when isolated, so forgetting a device leaves no stale peer file.
        for (const prefix of readPrefixes()) {
          try { await b.deleteFile(`${prefix}${t}_${deviceId}.json`); n++; }
          catch { /* not every device syncs every type; a missing file is the normal case */ }
        }
      }
      return n;
    });
    // Its cached session and extension list are local to us, so they have to go too or the
    // popup keeps listing a device the folder no longer has.
    await dropRemoteDevice(deviceId);
    logger.event("forgetDevice", `Removed ${removed} file(s) for a device that is no longer in use`);
    return removed;
  }

  // ─── First-sync direction ──────────────────────────────────────────────

  /**
   * Does this install need to answer "which side wins" before bookmarks are touched?
   *
   * Deliberately cheap and read-only: one file listing, no payload download, no decrypt.
   * Four things have to hold — it has not answered before, it has never published a
   * bookmark packet (so it really is new to this group), its own tree is not empty, and
   * at least one peer has a bookmark file in the folder.
   *
   * A FAILURE here must never park an ordinary sync. A WebDAV answering 503 to the
   * listing is a storage problem, not a reason to silently stop syncing while a card
   * waits for a click; fall through to the normal merge.
   */
  private async detectFirstSync(
    backend: ReturnType<typeof createBackend>,
    types: DataType[]
  ): Promise<number | null> {
    if (!types.includes("bookmarks")) return null;
    const record = await getFirstSync();
    if (record?.done) return null;
    if ((await getLastUploadChecksum("bookmarks")) !== null) return null;
    const local = await this.buildPayload("bookmarks");
    if (await this.isPayloadEmpty("bookmarks", local)) return null;

    let names: string[];
    try {
      names = (await Promise.all(listPrefixes("bookmarks").map((p) => backend.listFiles(p)))).flat();
    } catch (err) {
      logger.info(
        "FirstSync",
        `Couldn't list peer bookmark files, continuing with the normal merge: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
    const peers = new Set<string>();
    for (const name of names) {
      const id = peerDeviceIdFromName(name, "bookmarks");
      if (id && id !== this.settings.device_id) peers.add(id);
    }
    return peers.size || null;
  }

  /**
   * Apply the user's answer and publish immediately — an answer that waits out the sync
   * interval reads as a dead button. The two destructive answers get a restore point first.
   *
   * Nothing here invents a new shared file type: "remote" only rewrites THIS browser's
   * bookmarks, "local" only deletes peers' existing bookmark files, and both then publish
   * this device's ordinary v1.0 packet. The frozen wire contract is untouched.
   */
  async chooseFirstSync(choice: FirstSyncChoice): Promise<void> {
    if (this.isSyncing) throw new Error("A sync is already running — try again in a moment.");

    if (choice !== "merge") {
      try { await this.snapshotNow({ origin: "manual" }); }
      catch (err) {
        logger.warn("FirstSync", `Couldn't save a restore point before the ${choice} choice: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (choice === "remote") {
      const peers = orderPeersByTime(
        await this.withBackend((b) => b.downloadAll("bookmarks", this.settings.device_id))
      );
      if (!peers.length) {
        throw new Error("No other device's bookmarks could be read from the storage. Nothing was changed; try again once it is reachable.");
      }
      // openPacket() enforces the packet version, E2EE agreement and the SHA-256 checksum.
      const payload = await this.openPacket(peers[0]);
      await importBookmarks(payload, "replace", this.settings.conflict_strategy, this.settings.bulk_delete_percent, 0);
      // importBookmarks folds the peer's deletion/move/rename logs in BEFORE replacing
      // the tree. Dropping them is what makes "use the remote copy" actually stick:
      // otherwise the very next merge would re-apply that peer's old deletions.
      await resetBookmarkMergeState();
      await setState({ pending_conflicts: [] });
      logger.event("FirstSync", "Replaced this device's bookmarks with the newest peer's tree");
    } else if (choice === "local") {
      const { removed, failed } = await this.withBackend(async (b) => {
        const names = (await Promise.all(listPrefixes("bookmarks").map((p) => b.listFiles(p)))).flat();
        let removed = 0, failed = 0;
        for (const name of names) {
          const id = peerDeviceIdFromName(name, "bookmarks");
          if (!id || id === this.settings.device_id || !isPeerFileName(name, "bookmarks")) continue;
          try { await b.deleteFile(name); removed++; }
          catch (err) {
            failed++;
            logger.warn("FirstSync", `Couldn't remove ${name}: ${err instanceof Error ? err.message : err}`);
          }
        }
        return { removed, failed };
      });
      // A 503 must not look like a successful "reset". Nothing is marked done yet, so the
      // choice stays available for a retry. Files already removed will come back on their
      // own when their device next syncs, so a partial attempt is safe to repeat.
      if (failed > 0) {
        throw new Error(`${failed} device file(s) could not be removed from the storage (${removed} were removed). Check the connection and choose again; Settings → Activity has the details.`);
      }
      // The local tree did not change, so the upload checksum would otherwise still
      // match and our own file would never be (re)published.
      await clearUploadChecksums();
      logger.event("FirstSync", `Removed ${removed} peer bookmark file(s); this device's tree is now the only one offered`);
      logger.event("FirstSync", "To adopt this tree on the other devices, choose 'Use the remote copy' in their Settings → Activity; if their Kesonode is still running they will re-upload their own bookmarks instead");
    }

    await setFirstSync({ done: true, choice, at: new Date().toISOString() });
    const cleared = await setState({ first_sync_pending: null });
    this.onStateChange(cleared);
    await this.sync(["bookmarks"], { force: true });
  }

  /** Write a snapshot of the current bookmark tree to the backend. */
  async snapshotNow(opts: CreateSnapshotOptions = {}): Promise<SnapshotMeta> {
    return this.withBackend((b) => writeSnapshot(b, this.settings, opts));
  }

  /** Name (or un-name) one restore point, in the shared index. */
  async renameSnapshot(name: string, label: string): Promise<void> {
    await this.withBackend((b) => renameSnapshotFile(b, this.settings, name, label));
  }

  /** Keep one restore point forever, or put it back into the rolling ten. */
  async pinSnapshot(name: string, pinned: boolean): Promise<void> {
    await this.withBackend((b) => pinSnapshotFile(b, this.settings, name, pinned));
  }

  /** List the backend's bookmark restore points, newest first. */
  async getSnapshots(): Promise<SnapshotMeta[]> {
    const cfg = this.activeBackendConfig();
    if (!cfg) return [];
    // Same rule as the device list: during a cooldown every request is refused, so show
    // what this device already knows instead of an error the storage will repeat.
    if ((await syncCooldownRemaining()) > 0) return knownSnapshots();
    return this.withBackend(async (b) => {
      const list = await readSnapshots(b, this.settings);
      // A refusal here was handled INSIDE the snapshot reader — the restore points
      // themselves are fine, only their annotations are missing — so nothing would
      // ever reach the engine to say the account is over its quota. Say it here, or
      // the next minute asks the same questions and gets the same answer.
      if (b.rateLimited) await this.noteRateLimit();
      return list;
    });
  }

  /**
   * Restore a snapshot (re-adds missing bookmarks), then sync so peers get them.
   *
   * The sync is AWAITED, not detached. In MV3 it's the pending RESTORE_SNAPSHOT message
   * response that keeps the worker alive, so returning first — `void this.sync(...)` —
   * let the worker be suspended mid-upload: the user was told "restored N bookmarks"
   * while the peers got nothing, and the persisted lock was left for a later worker to
   * clear. This is the same rule the SYNC_NOW handler already spells out. The cost is a
   * slower response for a bookmarks-only sync, which is the right trade.
   */
  async restoreFromSnapshot(name: string): Promise<number> {
    const restored = await this.withBackend((b) => applySnapshot(b, name, this.settings));
    if (restored > 0) {
      const outcome = await this.sync(["bookmarks"]);
      if (outcome !== "ran") {
        // e.g. a periodic sync already holds the lock. The restore itself stands; the
        // next cycle publishes it. Worth a line so it isn't a silent gap.
        logger.warn(
          "SyncEngine",
          `Restored ${restored} bookmark(s) but couldn't publish yet (${outcome}) — the next sync will.`
        );
      }
    }
    return restored;
  }

  /** Delete one restore point from the backend. */
  async removeSnapshot(name: string): Promise<void> {
    await this.withBackend((b) => dropSnapshot(b, this.settings, name));
  }

  // ─── Per-type Sync ────────────────────────────────────────────────────

  /**
   * Drop cached peers whose file is no longer in the folder.
   *
   * `sessions` and `extensions` are device-keyed caches of what each peer last published,
   * and applyRemote only ever UPSERTS them — nothing ever removed an entry. So "forget this
   * device", which deletes that device's files, only ever tidied the cache on the machine
   * that clicked it (issue #14). Every other device went on offering the forgotten one's
   * session to restore, and went on counting its extensions in "missing on this device",
   * with nothing left in the folder to justify either.
   *
   * The folder is the authority, and the FILE LISTING is the signal — deliberately not the
   * packets `downloadAll` returned. A peer whose file is present but unreadable (HTTP
   * error, corrupt JSON, an encryption disagreement) is absent from `peers` too, so
   * pruning on that would delete a live device's session over a transient 500 and turn a
   * cosmetic bug into a destructive one. `listDevices` draws the same line for the same
   * reason: an unreadable file costs a device its name, not its existence.
   *
   * Cheap in the steady state: when every cached peer came back in `peers` there is
   * nothing to explain, so the listing is never fetched at all.
   */
  private async pruneVanishedPeers(
    dataType: DataType,
    backend: ReturnType<typeof createBackend>,
    peers: SyncPacket[]
  ): Promise<void> {
    const cached = await getRemoteDeviceIds(dataType);
    if (cached.length === 0) return;
    const arrived = new Set(peers.map((p) => p.device_id));
    const unexplained = cached.filter(
      (id) => id !== this.settings.device_id && !arrived.has(id)
    );
    if (unexplained.length === 0) return;

    let names: string[];
    try {
      names = (await Promise.all(listPrefixes(dataType).map((p) => backend.listFiles(p)))).flat();
    } catch (err) {
      // Not knowing what the folder holds is not evidence that anything left it, and an
      // emptied popup is the one outcome worth avoiding here. Say so and change nothing.
      logger.warn(
        "pruneVanishedPeers",
        `Couldn't list the ${dataType} files (${err instanceof Error ? err.message : err}), so no cached device was dropped`
      );
      return;
    }
    const present = new Set(
      names
        .map((n) => peerDeviceIdFromName(n, dataType))
        .filter((id): id is string => !!id)
    );
    const gone = unexplained.filter((id) => !present.has(id));
    if (gone.length === 0) return;

    await dropRemoteDevices(dataType, gone);
    // Worth an event: from the user's side a session or an extension set disappears from
    // the popup, and the reason (someone forgot that device) happened on another machine.
    logger.event(
      "pruneVanishedPeers",
      `Dropped the cached ${dataType} of ${gone.length} device(s) whose files are no longer in the sync folder`
    );
  }

  private async syncType(
    dataType: DataType,
    backend: ReturnType<typeof createBackend>,
    _state: SyncState
  ): Promise<void> {
    logger.info("SyncEngine", `Syncing: ${dataType}`);

    try {

      // 1. PULL every peer's file (excluding our own), so we converge against
      //    ALL devices in one cycle — not just the most recent one. Order
      //    newest-first by packet timestamp: backends list files in arbitrary
      //    order, but both the manual-conflict path and the newest→oldest fold
      //    below rely on peers[0] being the most recent.
      const peers = orderPeersByTime(
        await backend.downloadAll(dataType, this.settings.device_id)
      );
      // Count pulled bytes (the serialized peer payloads) toward the transfer stat.
      for (const p of peers) this.bytesThisSync += p.payload?.length ?? 0;
      for (const p of peers) this.peersThisSync.add(p.device_id);
      // Keep the names we actually saw. A later rate limit or unreadable packet then
      // costs nothing: the device list can still name the machine from this copy.
      await rememberPeerLabels(peers);

      // A device we hold a cached session / extension list for, that did NOT arrive here,
      // may simply be gone from the folder — someone forgot it on another machine. Runs
      // before the flow decision below because every branch of it can be the one that
      // matters: forgetting the ONLY other device leaves zero peers, and `manual` never
      // reaches applyRemote at all.
      await this.pruneVanishedPeers(dataType, backend, peers);

      // 2. Build local payload
      const localPayload = await this.buildPayload(dataType);
      const isEmpty = await this.isPayloadEmpty(dataType, localPayload);

      // 2b. Local change guard. Measured on the PRE-MERGE payload: peer changes folded
      // in below are already arbitrated by LWW and must never count as local churn.
      // Fail-open on any error here — a broken guard must not be able to stop syncing.
      if (dataType === "bookmarks") {
        try {
          const drift = await evaluateLocalDrift((localPayload as BookmarkPayload).tree, {
            enabled: this.settings.guard_enabled ?? true,
            floor: this.settings.guard_cap ?? GUARD_ABSOLUTE_FLOOR,
          });
          if (drift.cleared) this.guardClearedThisSync = true;
          if (drift.hold) {
            this.guardHoldThisSync = true;
            this.guardNoticeThisSync = {
              at: new Date().toISOString(),
              changed: drift.changed,
              cap: drift.cap,
              unstableRounds: drift.unstableRounds,
            };
            logger.warn(
              "changeGuard",
              `Holding this device's bookmark upload: ${drift.changed} entries changed since ` +
                `the last cycle (cap ${drift.cap}, ${drift.unstableRounds} consecutive cycles)`
            );
          }
        } catch (err) {
          logger.warn("changeGuard", `Skipped the local change guard this cycle: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Verbose troubleshooting line (only emitted when Debug mode is on).
      logger.debug("SyncEngine", `${dataType}: ${peers.length} peer(s), local ${isEmpty ? "empty" : "non-empty"}, strategy ${this.settings.conflict_strategy}`);

      // 3. Decide flow
      if (peers.length === 0) {
        // No peers yet — push our own data if we have any.
        if (!isEmpty) {
          await this.uploadIfChanged(backend, dataType, localPayload);
        } else {
          logger.info("SyncEngine", `${dataType}: nothing to sync`);
        }
      } else if (!isEmpty && this.settings.conflict_strategy === "manual" && CONFLICTABLE_TYPES.has(dataType)) {
        // Manual: queue a conflict for EACH diverging peer, not just the newest —
        // otherwise with 3+ devices the other peers' differences are never surfaced.
        // Dedupe by data_type + peer device so the same conflict doesn't pile up
        // every cycle while it sits unresolved.
        const localPacket = await this.buildPacket(dataType, localPayload);
        const currentState = await getState();
        const already = new Set(
          currentState.pending_conflicts.map((c) => `${c.data_type}:${c.device_id}`)
        );
        // Whether the two devices hold the same BOOKMARKS, rather than the same bytes (#34).
        // The checksum covers this device's ids, every dateAdded and the four per-device
        // logs, so it never matched and Manual asked about every pair of devices on first
        // contact. See bookmarkContent. History keeps the checksum: it has no such notion.
        const contentOf = async (payload: unknown) => sha256(bookmarkContent(payload));
        const localContent = dataType === "bookmarks" ? await contentOf(localPayload) : null;
        // Pending cards whose peer turns out to hold what we hold. Either answer to them
        // would change nothing, so they go, which is also what clears the cards this bug
        // raised before the upgrade.
        const settled = new Set<string>();
        // A resolution (keep-local OR keep-remote) doesn't rewrite the peer's file,
        // so the peer still diverges from us next cycle. Skip a peer we've already
        // resolved against *this exact content* so the same conflict doesn't re-queue and
        // re-notify forever: for bookmarks the content is what the peer HOLDS (#34), since
        // its checksum moves with every date and log entry; otherwise the checksum. A
        // genuine later change on the peer still surfaces a fresh conflict.
        const resolved = await getResolvedConflicts();
        const fresh: ConflictItem[] = [];
        for (const peer of peers) {
          const key = `${dataType}:${peer.device_id}`;
          if (already.has(key)) {
            // A card is already up for this peer. It stays unless the two now hold the same
            // bookmarks, which is only worth a decrypt when there is a card to take down.
            if (localContent && this.encryptionBarrier(peer) === null) {
              const same = await this.openPacket(peer)
                .then((p) => contentOf(p))
                .then((c) => c === localContent, () => false);
              if (same) settled.add(key);
            }
            continue;
          }
          if (resolved[key] === peer.checksum) continue;
          // Don't queue a conflict for a peer we couldn't consume even if the user picked
          // it. `manual` never reaches applyRemote, so this was the one path where an
          // encryption disagreement went completely unreported.
          const barrier = this.encryptionBarrier(peer);
          if (barrier === "silent") continue;
          if (barrier) {
            this.encryptionWarnings.set(peer.device_id, barrier);
            continue;
          }
          let peerContent: string | undefined;
          if (localContent) {
            try {
              peerContent = await contentOf(await this.openPacket(peer));
            } catch {
              // Unreadable here (a legacy peer without a verifier on another passphrase, a
              // corrupt file): the checksum decides, as it always did, and choosing that
              // peer's version reports the reason.
            }
            if (peerContent === localContent) continue;
            if (peerContent && resolved[key] === peerContent) continue;
          }
          const { conflict } = this.resolver.resolve(localPacket, peer);
          if (conflict) {
            if (peerContent) conflict.content_key = peerContent;
            fresh.push(conflict);
            // Park the raw peer packet OUTSIDE konode_state — "use remote" needs it to
            // decrypt and verify, but it must not ride along on every status broadcast.
            await putConflictPacket(conflict.id, peer);
          }
        }
        const pending = [
          ...currentState.pending_conflicts.filter((c) => !settled.has(`${c.data_type}:${c.device_id}`)),
          ...fresh,
        ];
        if (settled.size) {
          // Every card still up keeps its packet, the ones just queued included.
          await pruneConflictPackets(pending.map((c) => c.id));
          logger.event(
            "SyncEngine",
            `Dropped ${settled.size} pending ${dataType} conflict(s): those devices now hold the same bookmarks as this one`
          );
        }
        if (fresh.length || settled.size) {
          // The status at the end of the sync is sync()'s to set, from what is left pending.
          await setState({
            ...(fresh.length ? { status: "conflict" as const } : {}),
            pending_conflicts: pending,
          });
          if (fresh.length && this.settings.notifications_enabled) notifyConflict(dataType);
        }
        // Publish our own file anyway. `manual` gates what we IMPORT — it was never
        // meant to stop us EXPORTING: every device writes its own
        // konode_<type>_<device_id>.json, so an upload here cannot overwrite a peer's
        // data or pre-empt the user's choice. Without it, a device on `manual` with any
        // peer present never uploaded at all (the only other upload paths are "no peers
        // yet" and a keep-local resolution), so its changes reached no other device —
        // silently, while the sync reported success. Same principle as the E2EE-mismatch
        // path above: skip the merge, still publish, let the group converge.
        await this.uploadIfChanged(backend, dataType, localPayload);
      } else {
        // Auto-resolve across ALL peers. applyRemote is non-destructive for every
        // data type (bookmarks/history merge additively + tombstones; sessions/
        // extensions are stored for display/restore), so fold each peer in — this
        // is what makes 3+ devices converge in a single cycle. Per-strategy deletion
        // handling (lww/prefer-local/prefer-remote) lives inside the bookmark merge.
        //
        // NEWEST→OLDEST (peers is already sorted newest-first). This used to fold
        // oldest→newest "so any snapshot-style store ends on the most recent peer",
        // but that reason is gone: sessions/extensions are device-keyed upserts now
        // (one entry per peer, order-irrelevant) and history is additive + deduped. So
        // ordering only affects bookmarks — where oldest-first actively RESURRECTED
        // deleted bookmarks: a stale peer still holding X was folded in before the
        // newest peer's tombstone for X was known, and since importBookmarks persists
        // each peer's tombstones before merging its tree, the fresher deletion arrived
        // too late to suppress the add. Worse, the merge's own create() stamps a fresh
        // `dateAdded` (the API can't set it), which then reads as "the user just
        // re-added this" and beats the older tombstone — so X came back and this device
        // republished it to the whole mesh. Newest-first establishes the most recent
        // deletions and moves BEFORE older trees are folded in, which also saves the
        // redundant intermediate move an older peer's stale placement used to cause.
        for (const peer of peers) {
          // We're encrypted, this peer's file is plaintext. It's either a stale/orphan
          // file (a device that was removed → its file lingers forever) or a device
          // that simply hasn't enabled E2EE yet. Either way it's not something we merge
          // into our encrypted world, and it's NOT this device's actionable problem —
          // the plaintext device gets nudged to enable E2EE on its own sync. So skip
          // it SILENTLY: this is what stops an abandoned plaintext file from warning
          // forever. (The reverse — we're plaintext, a peer is encrypted — is surfaced
          // below as a non-fatal "enable E2EE here" nudge, on the device that can fix it.)
          if (this.encryptionBarrier(peer) === "silent") {
            logger.debug("SyncEngine", `Skipping plaintext peer ${peer.device_id} (E2EE on here): stale or unencrypted, not merged`);
            continue;
          }
          try {
            await this.applyRemote(dataType, peer, false);
          } catch (err) {
            // An encryption disagreement (plaintext peer while we encrypt, encrypted
            // peer we can't decrypt, or a wrong passphrase) must NOT be swallowed
            // silently — but it must NOT abort before our own upload either, or the
            // group deadlocks into mutually-stale files that never get re-encrypted.
            // So: skip merging this peer, record a per-device warning, keep folding
            // the rest, and let sync() upload our own file + surface the warning.
            if (err instanceof PassphraseError || err instanceof EncryptionMismatchError) {
              this.encryptionWarnings.set(peer.device_id, err.message);
              this.failedTypes.add(dataType);
              logger.warn("SyncEngine", `Encryption mismatch, skipping peer ${peer.device_id}: ${err.message}`);
              continue;
            }
            // One bad peer file (corrupt JSON, checksum mismatch, import error) must
            // not abort the whole sync — skip it and fold in the rest.
            logger.warn(
              "SyncEngine",
              `Skipping peer ${peer.device_id} for ${dataType}: ${err instanceof Error ? err.message : err}`
            );
          }
        }
        // Re-read only what the fold can have changed. For the rest `localPayload` IS
        // what a rebuild would return, and `isEmpty` its answer: `isPayloadEmpty` reads
        // storage only for bookmarks (the tombstone log), so reusing it for sessions and
        // extensions is the same computation, not an approximation. See
        // MERGE_MUTATES_LOCAL.
        const rebuild = MERGE_MUTATES_LOCAL.has(dataType);
        const merged = rebuild ? await this.buildPayload(dataType) : localPayload;
        const mergedEmpty = rebuild ? await this.isPayloadEmpty(dataType, merged) : isEmpty;
        if (!mergedEmpty) {
          await this.uploadIfChanged(backend, dataType, merged);
        }
      }

      // 4. Update sync count
      const currentState = await getState();
      await setState({
        sync_counts: {
          ...currentState.sync_counts,
          [dataType]: (currentState.sync_counts[dataType] ?? 0) + 1,
        },
      });
    } catch (err) {
      logger.error(`SyncEngine.syncType[${dataType}]`, err);
      throw err;
    }
  }

  // ─── Empty detection ──────────────────────────────────────────────────

  /**
   * "Empty" means there is nothing a peer could act on, so skipping the upload costs
   * the group nothing. It is NOT the same as "the tree has no bookmarks": for
   * bookmarks the payload is a `{ tree, tombstones }` envelope and the DELETION LOG
   * is content in its own right.
   *
   * Judging bookmarks on the tree alone meant that deleting every bookmark produced an
   * "empty" payload that was never uploaded — so the tombstones never left this device,
   * the deletion propagated to nobody, and our own stale remote file kept advertising
   * the entire old tree to every peer. Once the local tombstones aged out (90 days),
   * the whole tree came back.
   *
   * Which is why the deletion question is asked of the LOG WE HOLD and not of the payload:
   * since 1.3.2 a device publishes only the deletions it made itself, so a device whose
   * last bookmark was removed by a PEER's deletion has an empty tree and an empty
   * tombstone list to send, and skipping that upload leaves our old file advertising the
   * very tree that was just deleted. The empty payload is the retraction.
   */
  private async isPayloadEmpty(dataType: DataType, payload: unknown): Promise<boolean> {
    if (!payload) return true;
    switch (dataType) {
      case "bookmarks": {
        // Payload is a { tree, tombstones } envelope (or a legacy bare array).
        const bare = Array.isArray(payload);
        const tree = bare ? payload : ((payload as { tree?: unknown[] }).tree ?? []);
        const flat = this.flattenBookmarks(tree as Array<{ children?: unknown[]; url?: string }>);
        if (flat.some((n) => n.url)) return false;
        // No bookmarks left — but a deletion still has to reach the peers, and a device
        // that knows of one has something to say even when it publishes none of it.
        return (await getTombstones()).length === 0;
      }
      case "history":
        return !Array.isArray(payload) || payload.length === 0;
      case "sessions": {
        // A tab-less session is nothing a peer can restore (normalizeRemoteSessions
        // drops it anyway), and uploading one OVERWRITES this device's previously-good
        // session file for every peer. That is reachable, not theoretical: revoke the
        // optional `tabs` permission and tabs.query still resolves, but every tab comes
        // back without a url, so the export filters them all out and the session goes
        // empty. Skipping the upload leaves peers with the last session they can
        // actually restore.
        const tabs = (payload as { tabs?: unknown[] }).tabs;
        return !tabs?.length;
      }
      case "extensions":
        return !Array.isArray(payload) || payload.length === 0;
      default:
        return false;
    }
  }

  private flattenBookmarks(nodes: Array<{ children?: unknown[]; url?: string }>): Array<{ url?: string }> {
    const result: Array<{ url?: string }> = [];
    const walk = (n: { children?: unknown[]; url?: string }) => {
      result.push(n);
      (n.children as Array<{ children?: unknown[]; url?: string }>)?.forEach(walk);
    };
    nodes.forEach(walk);
    return result;
  }

  // ─── Payload Builders ─────────────────────────────────────────────────

  private async buildPayload(dataType: DataType): Promise<unknown> {
    switch (dataType) {
      case "bookmarks":
        return exportBookmarkPayload();
      case "sessions": {
        // Make the synced session deterministic: identical open tabs must yield
        // an identical payload (and checksum), otherwise a fresh UUID/timestamp
        // every cycle churns versions and causes LWW ping-pong between devices.
        const session = await exportSession();
        session.id = `session_${this.settings.device_id}`;
        session.device_id = this.settings.device_id;
        session.savedAt = "";
        // Carry the human-readable device name so peers can label the session
        // list. Stable per device, so the payload stays deterministic (no churn).
        session.label = this.settings.device_label;
        return session;
      }
      case "history":
        return exportHistory(this.settings.history_days_limit);
      case "extensions":
        return exportExtensions();
      default: {
        const _e: never = dataType;
        throw new Error(`Unknown data type: ${_e}`);
      }
    }
  }

  /**
   * A stable identity for the current upload DESTINATION — the backend type plus the
   * folder/repo/server it actually writes into.
   *
   * The dedup checksum below is over the PAYLOAD, so nothing about it changes when the
   * destination does. Without this, switching provider (or GitHub repo/branch/path, or
   * WebDAV server) left the previous checksum matching, `uploadIfChanged` skipped, and
   * the NEW destination silently stayed empty while the UI reported a clean sync — only
   * a later bookmark edit healed it, which on a stable tree can be days.
   *
   * The repo is normalized the same way the backend addresses it, so re-typing
   * `owner/repo` as a full GitHub URL isn't mistaken for a move. Tokens/passwords are
   * deliberately excluded: what matters is WHERE we write, and a secret has no business
   * being copied into a second storage key.
   */
  private destinationTag(): string {
    const cfg = this.activeBackendConfig();
    if (!cfg) return "none";
    switch (cfg.type) {
      case "gdrive":
        return `gdrive:${cfg.gdrive?.folderId ?? "default"}`;
      case "github": {
        const g = cfg.github;
        return `github:${normalizeRepoSlug(g?.repo)}@${g?.branch ?? "main"}/${g?.path ?? folderPath()}`;
      }
      case "webdav": {
        const w = cfg.webdav;
        return `webdav:${w?.username ?? ""}@${(w?.url ?? "").replace(/\/$/, "")}/${w?.path ?? folderPath()}`;
      }
      default: {
        const _e: never = cfg.type;
        return String(_e);
      }
    }
  }

  /**
   * The "what this device last uploaded" record for a data type. The plaintext
   * checksum alone isn't enough: the encryption FORM, the DESTINATION and the DEVICE
   * NAME all change what actually sits on the backend WITHOUT changing the payload, so
   * all three are folded in here. An old tag written by an earlier build matches
   * neither, so an existing install re-uploads once and then stabilizes — no need to
   * re-save settings.
   */
  private uploadTag(payloadChecksum: string, useE2ee: boolean): string {
    // Folding the mode in makes a switch re-upload once into the new namespace instead of
    // "unchanged since last upload" leaving the new prefix empty for days.
    const mode = getCompatMode();
    const suffix = mode === "upstream" ? "" : `|compat:${mode}`;
    // The name rides on the envelope, so renaming the device in Settings leaves the
    // payload untouched and used to leave every file on the backend with the OLD name
    // (or none at all, for a file written by a build that predates names) until some
    // bookmark happened to change. Settings → Activity then read that stale file and
    // called a machine the user had just named "Unnamed device". Folding the name in
    // costs exactly one re-upload per type per rename, which is what telling the other
    // devices takes. The length prefix keeps two names from ever building the same tag.
    const label = this.settings.device_label ?? "";
    return `${PACKET_ENVELOPE}|${this.destinationTag()}|${useE2ee ? "enc" : "plain"}|name:${label.length}:${label}:${payloadChecksum}${suffix}`;
  }

  /**
   * Upload only when the payload changed since our last successful upload. The
   * checksum is over the plaintext payload (stable for identical data, independent
   * of the packet's per-cycle timestamp), so a sync that finds nothing new doesn't
   * spam the backend with a fresh commit every interval — and can't race its own
   * write into a 409.
   */
  private async uploadIfChanged(
    backend: ReturnType<typeof createBackend>,
    dataType: DataType,
    payload: unknown
  ): Promise<void> {
    // The local change guard gates PUBLISHING only. Pulling and merging peers still ran
    // this cycle: receiving another device's changes is never dangerous, while
    // broadcasting a half-finished rewrite of our own tree is. This is the one gate
    // all three upload paths (no peers / manual / auto) go through.
    if (dataType === "bookmarks" && this.guardHoldThisSync) {
      logger.info("changeGuard", "bookmarks: publishing held by the local change guard this cycle");
      return;
    }
    // Compute the (cheap) plaintext checksum BEFORE building the full packet, so an
    // unchanged encrypted sync doesn't pay the expensive PBKDF2 for encrypt+verifier
    // on every idle interval — only when there's actually something to upload.
    // `uploadTag` folds in the encryption form + destination (see above).
    const tag = this.uploadTag(await sha256(JSON.stringify(payload)), this.e2eeActive);
    // Our file has gone from the folder (see findOwnMissingFiles), so "unchanged since our
    // last upload" is no reason to skip — there is nothing out there to be unchanged from.
    // Announced here rather than in the pre-pass so it is only ever said about an upload
    // that actually happens. Taken off the set so one sync cannot say it twice.
    const missing = this.ownFilesMissing.delete(dataType);
    if (missing) {
      logger.warn(
        "SyncEngine",
        `This device's ${dataType} file is no longer on the backend, so it will be uploaded again`
      );
    }
    if (!missing && (await getLastUploadChecksum(dataType)) === tag) {
      logger.info("SyncEngine", `${dataType}: unchanged since last upload, skipping`);
      return;
    }
    const packet = await this.buildPacket(dataType, payload);
    await backend.upload(packet);
    this.bytesThisSync += packet.payload?.length ?? 0; // pushed bytes → transfer stat
    await setLastUploadChecksum(dataType, tag);
  }

  private async buildPacket(dataType: DataType, payload: unknown): Promise<SyncPacket> {
    const payloadStr = JSON.stringify(payload);
    const useE2ee = this.e2eeActive;
    const browserInfo = await (this.browserIdentity ??= detectBrowser());
    return {
      version: CURRENT_PACKET_VERSION,
      device_id: this.settings.device_id,
      // Carried on every packet, not just the session one, so a device is nameable to its
      // peers even with Sessions turned off. Purely for display; nothing keys off it.
      device_label: this.settings.device_label,
      // Browser name and engine only, and left off entirely when unknown (see detectBrowser).
      ...(browserInfo ? { device_browser: browserInfo } : {}),
      timestamp: new Date().toISOString(),
      data_type: dataType,
      // SHA-256 over the plaintext, so identical content across devices still
      // matches even though each encrypted blob uses a fresh IV/salt.
      // Trade-off (accepted): with E2EE on, this is a plaintext-confirmation oracle
      // — an observer of the backend could confirm a *guessed* payload by hashing
      // it. Harmless in practice: bookmark/history payloads carry far too much
      // entropy to guess whole, and switching to HMAC(key, …) would break the
      // cross-device dedup (the per-blob PBKDF2 salt makes the AES key non-stable).
      checksum: await sha256(payloadStr),
      encrypted: useE2ee,
      payload: useE2ee
        ? await encrypt(payloadStr, this.settings.encryption_passphrase!)
        : payloadStr,
      // Deliberately NO passphrase `verifier`. Earlier builds attached
      // encrypt("konode-verify-v1") to every encrypted packet, but a known-plaintext
      // blob sitting on third-party storage is a purpose-built offline brute-force
      // oracle on the passphrase. A mismatched peer fails just as loudly via the
      // payload's GCM auth failure (applyRemote throws PassphraseError), so the
      // verifier added attack surface without adding signal. Verifiers on packets
      // from older builds are still CHECKED on download for the clearer error.
    };
  }

  // ─── Remote Apply ─────────────────────────────────────────────────────

  private async applyRemote(
    dataType: DataType,
    packet: SyncPacket,
    isLocalEmpty = false
  ): Promise<void> {
    const payload = await this.openPacket(packet);
    await this.applyPayload(dataType, payload, {
      device_id: packet.device_id,
      timestamp: packet.timestamp,
      // Outside the encrypted payload, so it reads even with E2EE on. It is what the
      // recovery notice shows instead of a truncated id when the guard blocks.
      device_label: packet.device_label ?? null,
    }, isLocalEmpty);
  }

  /**
   * A peer's packet, decrypted and verified, as the payload it carries.
   *
   * Everything applyRemote checks before importing, so the manual gate can read a peer
   * under exactly the same rules (#34): it has to see what a peer holds to know whether the
   * two devices disagree at all.
   */
  private async openPacket(packet: SyncPacket): Promise<unknown> {
    // Version first: a packet written under rules we don't know must not be interpreted
    // under the v1.0 ones, checksum or no checksum. Legacy packets with no version pass.
    assertSupportedPacketVersion(packet);
    // 畸形包防御：device_id 必须是非空字符串，否则后续 slice/比较抛错并使整轮同步失败。
    if (typeof packet.device_id !== "string" || packet.device_id.length === 0) {
      throw new Error("Malformed SyncPacket: device_id is missing or not a string.");
    }
    const localE2ee = this.e2eeActive;
    // Refuse to import a plaintext peer while E2EE is active here. The auto-merge
    // path already skips plaintext peers before calling applyRemote (they're stale/
    // orphan files), so this is the guard for the MANUAL resolve-remote path —
    // without it a manual "keep remote" could pull an unauthenticated plaintext
    // packet into an encrypted device, silently downgrading it. Mirrors the auto skip.
    if (!packet.encrypted && localE2ee) {
      throw new EncryptionMismatchError(
        `Device ${packet.device_id.slice(0, 8)}'s data is not end-to-end encrypted. ` +
          "Enable E2EE with the same passphrase there before merging it, so this device stays encrypted."
      );
    }
    let raw = packet.payload;
    if (packet.encrypted) {
      // Only participate in the encrypted group when E2EE is actually ACTIVE here
      // (enabled AND a passphrase set) — NOT merely when a passphrase lingers in
      // settings. A device that turned E2EE off keeps its passphrase, but it must
      // not silently decrypt an encrypted peer: doing so absorbed the group's data
      // and re-published it in plaintext, and hid the fact that this device had
      // dropped out of the encrypted group (C1). Surface it as an actionable nudge
      // on THIS device (the one that can fix it) instead of a silent partition.
      if (!localE2ee) {
        throw new EncryptionMismatchError(
          "Some of your devices are end-to-end encrypted. Enable E2EE with the same " +
            "passphrase here (Settings → Advanced) to sync with them."
        );
      }
      const pass = this.settings.encryption_passphrase!;
      // Check the peer's passphrase verifier first, so a mismatch is reported as a
      // clear "passphrases don't match" error rather than a silent decrypt skip.
      if (packet.verifier && !(await verifyPassphrase(pass, packet.verifier))) {
        throw new PassphraseError(
          `Your encryption passphrase doesn't match device ${packet.device_id.slice(0, 8)}. ` +
            "Use the same passphrase on all your devices (Settings → Advanced)."
        );
      }
      try {
        raw = await decrypt(packet.payload, pass);
      } catch {
        // No verifier on the packet (legacy) but decrypt failed — still a mismatch.
        throw new PassphraseError(
          "Could not decrypt a peer's synced data. Check that your encryption passphrase matches your other devices."
        );
      }
    }
    // Verify integrity before importing. Every packet is v1.0 with a SHA-256
    // checksum (64 hex chars); require one and reject anything without it, so a
    // tampered/corrupt file can't bypass verification by truncating or omitting
    // the checksum.
    const actual = await sha256(raw);
    if (packet.checksum?.length !== 64 || actual !== packet.checksum) {
      throw new Error("Sync packet checksum invalid or missing. Refusing to import unverified data.");
    }
    return JSON.parse(raw);
  }

  /** Applies an already-decrypted, already-parsed payload for a data type. */
  private async applyPayload(
    dataType: DataType,
    payload: unknown,
    meta: { device_id: string; timestamp: string; device_label?: string | null },
    isLocalEmpty: boolean
  ): Promise<void> {
    // Validate the parsed payload shape before handing untrusted remote data to
    // the Chrome APIs (a corrupt/tampered file must not crash or mis-import).
    if ((dataType === "history" || dataType === "extensions") && !Array.isArray(payload)) {
      throw new Error(`Invalid ${dataType} payload: expected an array.`);
    }
    if (dataType === "bookmarks" && !Array.isArray(payload) &&
        !Array.isArray((payload as { tree?: unknown }).tree)) {
      throw new Error("Invalid bookmarks payload: expected a tree or { tree, tombstones }.");
    }

    switch (dataType) {
      case "bookmarks":
        // Fresh device → replace; existing device → merge with deletion tracking.
        await importBookmarks(
          payload,
          isLocalEmpty ? "replace" : "merge",
          this.settings.conflict_strategy,
          this.settings.bulk_delete_percent,
          this.bulkApprovedThisSync,
          (info) => {
            // Largest single block wins, kept whole with the numbers that describe it.
            if (info.blocked > (this.bulkBlockedThisSync?.blocked ?? 0)) {
              this.bulkBlockedThisSync = {
                ...info,
                device_id: meta.device_id,
                device_label: meta.device_label ?? null,
              };
            }
          },
        );
        break;
      case "history":
        // One index per SYNC, not per peer. Building it reads the whole local history
        // (up to 100k rows) into a map, and this runs once per peer, so three other
        // devices meant three full scans a minute at the default interval. The import
        // writes every page it stores back into the map, so the peers folded after this
        // one still see an accurate answer.
        this.historyIndexThisSync ??= await buildLocalHistoryIndex();
        await importHistory(payload as never, this.historyIndexThisSync);
        break;
      case "sessions":
        // Peer maps are keyed by device_id — refuse to upsert under an empty key,
        // which would create a bogus peer entry the popup then lists.
        if (!meta.device_id) {
          logger.warn("applyRemote", "Skipping session with empty device_id");
          break;
        }
        // Persist the remote session, keyed by device_id, so every peer's session
        // survives (not just the newest) and the popup can list/restore each.
        await setRemoteSession({
          device_id: meta.device_id,
          timestamp: meta.timestamp,
          session: payload as SyncSession,
        });
        logger.info("applyRemote", `Stored remote session for ${meta.device_id}`);
        break;
      case "extensions": {
        if (!meta.device_id) {
          logger.warn("applyRemote", "Skipping extensions with empty device_id");
          break;
        }
        // Store per device (keyed by device_id) so the popup can union every peer's
        // list — "missing on this device" then reflects extensions installed on ANY
        // peer, not just the newest one.
        const extensions = (payload as SyncExtension[]) ?? [];
        await setRemoteExtensions({
          device_id: meta.device_id,
          timestamp: meta.timestamp,
          extensions,
        });
        logger.info(
          "applyRemote",
          `Stored remote extensions for ${meta.device_id} (${extensions.length} items)`
        );
        break;
      }
    }
  }

  // ─── Conflict Resolution ──────────────────────────────────────────────

  /** Resolves a queued manual conflict by applying the local or remote version. */
  async resolveConflict(id: string, resolution: "local" | "remote"): Promise<void> {
    const state = await getState();
    const conflict = state.pending_conflicts.find((c) => c.id === id);
    if (!conflict) {
      logger.warn("SyncEngine", `resolveConflict: ${id} not found`);
      return;
    }

    // The peer's raw packet lives in its own storage key, out of konode_state; a
    // conflict queued by an older build still carries it inline.
    const remotePacket = (await getConflictPacket(id)) ?? conflict.remote_packet ?? null;

    if (resolution === "remote") {
      // The packet is preferred: applyRemote decrypts and verifies the checksum.
      if (remotePacket) {
        await this.applyRemote(conflict.data_type, remotePacket, false);
      } else if (conflict.remote_version !== undefined) {
        // Oldest legacy shape: only the parsed payload was stored.
        await this.applyPayload(
          conflict.data_type,
          conflict.remote_version,
          { device_id: conflict.device_id, timestamp: conflict.timestamp },
          false
        );
      } else {
        // Nothing left to apply — don't silently drop the conflict as if we had.
        throw new Error(
          "That peer's data is no longer available to apply. Keep local, or sync again to re-check the peer."
        );
      }
    } else {
      // Keep local → make sure our version is the one on the backend.
      //
      // Once per CONTENT, not once per card. Manual raises a card per diverging peer, so
      // two other devices disagreeing about bookmarks is two cards, and answering both
      // with Keep local built the same packet twice and PUT the same file twice. Koofr
      // locks a file while a write to it is in flight and answers the second with 423, so
      // a burst of Keep local reached a user as "WebDAV PUT failed: 423" with the card
      // still standing. The repeat was never doing anything: the tag says what we last
      // put there, and if it matches, our version is already the one out there. Which is
      // the question this upload exists to answer.
      const cfg = this.settings.backends.find((b) => b.type === this.settings.active_backend);
      if (cfg) {
        const payload = await this.buildPayload(conflict.data_type);
        const tag = this.uploadTag(await sha256(JSON.stringify(payload)), this.e2eeActive);
        if ((await getLastUploadChecksum(conflict.data_type)) === tag) {
          logger.info(
            "SyncEngine",
            `${conflict.data_type}: already published this version, so keeping local needs no upload`
          );
        } else {
          const backend = createBackend(cfg);
          await backend.connect();
          try {
            const packet = await this.buildPacket(conflict.data_type, payload);
            await backend.upload(packet);
            // The same tag uploadIfChanged writes (encryption form + destination), so the
            // next periodic sync doesn't see a mismatch and re-upload needlessly.
            await setLastUploadChecksum(conflict.data_type, tag);
          } finally {
            await backend.disconnect();
          }
        }
      }
    }

    // Remember the peer content we just resolved against so the same conflict
    // doesn't re-queue every cycle (the resolution doesn't rewrite the peer's file,
    // so it keeps diverging from ours). Keyed by data_type:device_id → peer checksum.
    // What the peer's bookmarks held, when the card knows (#34): the checksum moves with every
    // date and log entry the peer writes, and the same question came back each time it did.
    const memo = conflict.content_key ?? remotePacket?.checksum;
    if (memo) {
      await setResolvedConflict(`${conflict.data_type}:${conflict.device_id}`, memo);
    }

    const remaining = state.pending_conflicts.filter((c) => c.id !== id);
    // Drop the packet we just consumed (and any orphan from an earlier interruption).
    await pruneConflictPackets(remaining.map((c) => c.id));
    const newState = await setState({
      pending_conflicts: remaining,
      status: remaining.length > 0 ? "conflict" : "idle",
    });
    this.onStateChange(newState);
    logger.event("SyncEngine", `Resolved conflict ${id} → ${resolution}`);
  }

  /**
   * What differs on one pending conflict (#35): what the peer has that this device does not,
   * and the reverse, for the Settings screen that asks the question.
   *
   * Read-only. Opens the same parked packet "Use remote" would apply, under the same rules
   * (decrypt, verify), and compares it with what this device would publish right now, so
   * the lists describe the choice as it stands when it is made, not as it stood when the
   * card was queued. A peer this device cannot read fails here with the same reason Use
   * remote would give.
   */
  async conflictDiff(id: string): Promise<ConflictDiff> {
    const state = await getState();
    const conflict = state.pending_conflicts.find((c) => c.id === id);
    if (!conflict) throw new Error("This conflict is no longer pending.");
    const { data_type: dataType } = conflict;
    if (dataType !== "bookmarks" && dataType !== "history") {
      throw new Error(`There is nothing to compare for ${dataType}.`);
    }
    const packet = (await getConflictPacket(id)) ?? conflict.remote_packet ?? null;
    const remote = packet ? await this.openPacket(packet) : conflict.remote_version;
    if (remote === undefined) {
      throw new Error("That device's data is no longer available here. Sync again to re-check it.");
    }
    const local = await this.buildPayload(dataType);
    return dataType === "bookmarks"
      ? diffBookmarks(local, await peerTreeAsMerged(remote))
      : diffHistory(local, remote);
  }

  // ─── Session restore ──────────────────────────────────────────────────

  /**
   * Opens the tabs from a stored peer session. Pass a session `id` to restore a
   * specific device; omit it to restore the most recent one (legacy behavior).
   */
  async restoreSession(sessionId?: string): Promise<void> {
    const entries = await getRemoteSessions();
    const entry = sessionId
      ? entries.find((e) => e.session.id === sessionId)
      : entries[0];
    if (!entry?.session?.tabs?.length) {
      logger.warn("SyncEngine", "restoreSession: no remote session available");
      return;
    }
    await importSession(entry.session);
  }
}
