// ─── Kesonode Service Worker (MV3) ─────────────────────────────────────────
// Handles: alarm-based polling, bookmark listeners, message routing

import type { ExtensionMessage, ExtensionResponse, SyncState, SyncBookmark } from "@/lib/types";
import { getSettings, getState, setState, saveSettings, clearStaleSyncLock, setBulkDeleteApproval, KEYS, exportSettingsBackup, importSettingsBackup, importSettingsRisks, syncCooldownRemaining, syncBackoffRemaining, getSyncReports, clearSyncReports, getAutosavedSessions } from "@/lib/utils/storage";
import { SyncEngine, explainSyncFailure } from "@/lib/sync/sync-engine";
import { registerBookmarkListeners, recordExclusionRelease, exportBookmarkPayload } from "@/lib/handlers/bookmarks-handler";
import { listAllBookmarks, listReadingList, addToReadingList, removeFromReadingList, READING_LIST_FOLDER } from "@/lib/handlers/reading-list-handler";
import { searchDocs, omniboxSuggestions, escapeOmniboxText, type SearchDoc } from "@/lib/search";
import { checkDeadLinks, buildCleanupReport } from "@/lib/cleanup";
import { exportResult } from "@/lib/exporters";
import { buildDoctorReport } from "@/lib/diagnostics/doctor";
import { createBackend } from "@/lib/backends/abstract-backend";
import { logger, setLoggerDebug } from "@/lib/utils/logger";
import { BADGE_COLORS, BADGE_TEXT, STATE_UPDATE } from "@/lib/constants";
import { browser } from "@/lib/utils/ext";
import { ensureSyncAlarm, SYNC_ALARM, BOOKMARK_ALARM } from "@/lib/utils/alarms";
import { eventPresent, missingPermissionsFor, dataTypeAvailability } from "@/lib/utils/capabilities";
import { clearExpiredDraft } from "@/lib/onboarding-draft";
import { openConflictFromNotification } from "@/lib/sync/conflict-resolver";

// ─── State ────────────────────────────────────────────────────────────────

let syncEngine: SyncEngine | null = null;
let bookmarkDebounce: ReturnType<typeof setTimeout> | null = null;
let bookmarkGeneration = 0;
let bookmarkSyncRunning = false;
let bookmarkAlarmWork: Promise<void> = Promise.resolve();
const BOOKMARK_DEBOUNCE_MS = 1000; // coalesce bursts (a folder delete fires many events)
const BOOKMARK_RETRY_MINUTES = 0.5;

// ─── Init ─────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = await getSettings();
  setLoggerDebug(settings.debug_mode);

  // ── Recover the stranded "syncing" state and the sync lock it left behind ──
  // Both halves of one interruption, and the LOCK is the evidence: a timestamp means a
  // sync was running when this worker's predecessor was torn down, whether or not the
  // status write made it out. MV3 runs one worker at a time, so on a fresh worker
  // nothing can still hold it.
  //
  // This recovery is routine, NOT history, and it used to write an audited EVENT on
  // every wake. A sync that outran the 60-second alarm — the shape a rate-limited cycle
  // takes, because every refused request is retried with backoff — woke the worker once a
  // minute and logged this line once a minute: 120 of the 200 entries in one field report
  // were this single sentence. That is exactly the condition that hides the 403s the
  // popup sends people into Activity to read. Console only, like every other routine
  // operational detail (see logger.ts).
  const currentState = await getState();
  const hadStaleLock = await clearStaleSyncLock();
  if (currentState.status === "syncing") {
    const repaired = await setState({ status: "idle", last_error: null });
    logger.info("ServiceWorker", "Reset stuck syncing state");
    // Tell any ALREADY-OPEN popup. It reads the state once on mount, so without this it
    // sat on "Syncing…" with the Sync-now button disabled for its whole lifetime — the
    // repair happened in storage where nobody was looking.
    broadcastState(repaired);
  }
  if (hadStaleLock) {
    logger.info("ServiceWorker", "Cleared a sync lock left by an interrupted sync");
  }

  // A setup abandoned more than a day ago can still hold a GitHub token or a WebDAV password
  // the user never finished connecting (#38). The wizard drops an expired draft when it
  // opens, but after an abandoned setup nothing may open it again.
  if (await clearExpiredDraft().catch(() => false)) {
    logger.info("ServiceWorker", "Dropped an unfinished setup older than a day");
  }

  // ── Migration: drop the legacy "tabs" data type (folded into "sessions") ──
  // "tabs" is no longer part of DataType, so compare as plain strings.
  if ((settings.enabled_types as string[]).includes("tabs")) {
    const cleaned = settings.enabled_types.filter((t) => (t as string) !== "tabs");
    await saveSettings({ enabled_types: cleaned });
    settings.enabled_types = cleaned;
    logger.event("ServiceWorker", "Migrated: removed legacy 'tabs' data type");
  }

  syncEngine = new SyncEngine(settings, broadcastState);

  // Bookmark listeners are registered once at the top level (see bottom of file),
  // not here — init() re-runs on every SW wake and would stack duplicate listeners.

  // NOT forced: init() runs on every worker wake, and re-creating the alarm each time
  // reset its next fire and starved the periodic pull. See ensureSyncAlarm.
  if (settings.auto_sync) {
    await ensureSyncAlarm(settings.sync_interval_seconds);
  } else {
    // An alarm outlives the worker, and the setting can be turned off without the save
    // that clears it reaching the browser (a failed clear, a settings blob written by an
    // older build). Removing it here is what makes "automatic sync is off" true after a
    // restart rather than merely "we stopped creating new ones".
    await browser.alarms.clear(SYNC_ALARM);
  }
  if (!settings.sync_on_change || !settings.enabled_types.includes("bookmarks")) {
    await updateBookmarkAlarm();
  }

  logger.info("ServiceWorker", "Initialized");
}

// MV3 tears the worker down when idle and recreates it on the next event. Every
// entry point (alarm, message, bookmark change) awaits this so it never races a
// not-yet-created syncEngine — the bug that made sync only work with the worker
// inspector held open. Cached so init() runs once per worker lifetime.
let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = init().catch((err) => {
      logger.error("ServiceWorker.init", err);
      initPromise = null; // let the next event retry
    });
  }
  return initPromise;
}

// ─── Badge ────────────────────────────────────────────────────────────────

/** The toolbar badge is decoration, and not every browser has one to draw on — mobile
 *  builds in particular. A throw here used to travel up through `broadcastState`, which
 *  is called from the sync path, so a missing badge could take a working sync down with
 *  it. Nothing about the sync depends on this succeeding. */
function updateBadge(status: string): void {
  const key = status as keyof typeof BADGE_COLORS;
  const failed = (e: unknown): void => {
    logger.debug("updateBadge", `This browser wouldn't take a toolbar badge: ${e instanceof Error ? e.message : e}`);
  };
  try {
    void Promise.resolve(browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS[key] ?? BADGE_COLORS.idle })).catch(failed);
    void Promise.resolve(browser.action.setBadgeText({ text: BADGE_TEXT[key] ?? "" })).catch(failed);
  } catch (e) {
    failed(e);
  }
}

/** Update the toolbar and push the state to any open popup/options view.
 *  chrome.extension.getViews doesn't exist in an MV3 service worker, so just broadcast —
 *  sendMessage rejects when no view is listening, which is expected; swallow it. */
function broadcastState(state: SyncState): void {
  updateBadge(state.status);
  browser.runtime.sendMessage({ type: STATE_UPDATE, payload: state }).catch(() => {});
}

// ─── Bookmark Listener ────────────────────────────────────────────────────

/** Serialize read/create/clear: a burst must not postpone an existing alarm, and an
 * event arriving during clear() must recreate the backstop AFTER that clear finishes. */
function updateBookmarkAlarm(completedGeneration?: number): Promise<void> {
  const work = bookmarkAlarmWork.then(async () => {
    const settings = await getSettings();
    if (!settings.sync_on_change || !settings.enabled_types.includes("bookmarks")) {
      if (bookmarkDebounce) clearTimeout(bookmarkDebounce);
      bookmarkDebounce = null;
      await browser.alarms.clear(BOOKMARK_ALARM);
      return;
    }
    if (completedGeneration !== undefined && completedGeneration === bookmarkGeneration) {
      await browser.alarms.clear(BOOKMARK_ALARM);
      return;
    }

    const alarm = await browser.alarms.get(BOOKMARK_ALARM);
    const now = Date.now();
    const remaining = Math.max(await syncCooldownRemaining(now), await syncBackoffRemaining(now));
    // A periodic alarm survives both worker eviction and repeated busy/failed attempts.
    // Move it only to respect a protection window, never just because another edit came in.
    if (!alarm || alarm.periodInMinutes !== BOOKMARK_RETRY_MINUTES ||
        (remaining > 0 && alarm.scheduledTime < now + remaining)) {
      await browser.alarms.create(BOOKMARK_ALARM, {
        when: now + Math.max(BOOKMARK_RETRY_MINUTES * 60_000, remaining),
        periodInMinutes: BOOKMARK_RETRY_MINUTES,
      });
    }
  });
  bookmarkAlarmWork = work.catch((err) => logger.error("BookmarkAlarm", err));
  return bookmarkAlarmWork;
}

/** Both the fast timer and the durable alarm acknowledge exactly the same outcomes. */
async function syncChangedBookmarks(): Promise<void> {
  if (bookmarkDebounce) clearTimeout(bookmarkDebounce);
  bookmarkDebounce = null;
  if (bookmarkSyncRunning) return;
  bookmarkSyncRunning = true;
  try {
    await ensureInit();
    // Also upgrades a legacy one-shot alarm before doing anything that may fail.
    await updateBookmarkAlarm();
    const settings = await getSettings();
    if (!settings.sync_on_change || !settings.enabled_types.includes("bookmarks")) return;
    const generation = bookmarkGeneration;
    const before = await getState();
    if (before.first_sync_pending) {
      await updateBookmarkAlarm(generation); // the direction card, not a timer, owns this
      return;
    }
    if (!syncEngine || syncEngine.isSyncing) return;

    const outcome = await syncEngine.sync(["bookmarks"]);
    if (outcome === "first-sync-pending") {
      await updateBookmarkAlarm(generation);
    } else if (outcome === "ran") {
      const after = await getState();
      // `ran` includes failures. A per-bookmark failure or guard hold needs another
      // attempt; an unrelated warning/log (e.g. retention) does not. The counter also
      // proves bookmarks completed when a later, cycle-wide operation reported an error.
      const failed = after.failed_types?.includes("bookmarks") ||
        (after.status === "error" && !after.failed_types?.length &&
          after.sync_counts.bookmarks <= before.sync_counts.bookmarks);
      await updateBookmarkAlarm(!failed && !after.guard_notice ? generation : undefined);
    } else {
      // Includes cooling-down/backing-off: read their persisted deadlines, without force.
      await updateBookmarkAlarm();
    }
  } catch (err) {
    logger.error("BookmarkSync", err);
    await updateBookmarkAlarm();
  } finally {
    bookmarkSyncRunning = false;
  }
}

function onBookmarkChange(): void {
  bookmarkGeneration++;
  void updateBookmarkAlarm();

  // One-second debounce stays the fast path; only real bookmark events re-arm it.
  if (bookmarkDebounce) clearTimeout(bookmarkDebounce);
  bookmarkDebounce = setTimeout(() => {
    bookmarkDebounce = null;
    void syncChangedBookmarks();
  }, BOOKMARK_DEBOUNCE_MS);
}

// ─── Message Handler ──────────────────────────────────────────────────────

// Return a Promise for the async response. The polyfill (and Firefox natively)
// resolve the sender's sendMessage promise with the value this resolves to —
// unlike raw Chrome's sendResponse + `return true`, which the polyfill ignores.
/**
 * The sentence a failed handler answers with.
 *
 * Every handler's failure arrives here, which makes it the one place that can name a
 * request that never left the browser. Settings showed the bare "NetworkError when
 * attempting to fetch resource" for the device list AND for the restore points, on the one
 * screen someone opens when something is wrong, and told them to check the connection when
 * the connection was fine and the host permission was gone. See explainSyncFailure.
 *
 * Reading the settings can itself fail, and losing the real error to a diagnostic that
 * could not be produced would be worse than the raw message.
 */
async function describeFailure(err: unknown): Promise<string> {
  try {
    const s = await getSettings();
    return await explainSyncFailure(err, s.backends.find((b) => b.type === s.active_backend));
  } catch {
    return err instanceof Error ? err.message : "Unknown error";
  }
}

browser.runtime.onMessage.addListener(((message: ExtensionMessage, sender): Promise<ExtensionResponse> => {
  // 仅接受来自本扩展自身的消息（options / popup / 本扩展页面）。即使将来开启
  // externally_connectable，也绝不向外部扩展或网页暴露同步、凭据等敏感操作。
  //
  // `browser.runtime` is optional-chained because this worker can outlive an extension
  // update by a few milliseconds, during which the runtime API object is gone. Reading
  // `.id` off it threw out of the listener, and the page that sent the message reported
  // it as "Uncaught TypeError: Cannot read properties of undefined (reading 'id')".
  if (!sender?.id || sender.id !== browser.runtime?.id) {
    return Promise.resolve({ type: "ERROR", payload: "Message rejected: untrusted sender." });
  }
  return handleMessage(message).catch(async (err): Promise<ExtensionResponse> => ({
    type: "ERROR",
    payload: await describeFailure(err),
  }));
}) as Parameters<typeof browser.runtime.onMessage.addListener>[0]);

/** The restore-point list, plus `partial` when it could only be built from this device's
 *  own record of what exists (see SyncEngine.getSnapshotList). */
async function snapshotsReply(engine: SyncEngine): Promise<ExtensionResponse> {
  const { list, partial } = await engine.getSnapshotList();
  return { type: "SNAPSHOTS", payload: list, ...(partial ? { partial: true } : {}) };
}

/** 90 days of history is what the search window offers; older entries are not worth a burst. */
const SEARCH_HISTORY_DAYS = 90;

/**
 * Everything the popup and the address bar can search, read fresh from the browser.
 *
 * Bookmarks are one getTree() call and the reading list is a folder inside them, so a URL
 * in `Kesonode Reading List` is tagged `reading` rather than fetched twice. History is
 * optional: without its permission the exception is a type not searched, not a failure.
 */
async function gatherSearchDocs(): Promise<SearchDoc[]> {
  const docs: SearchDoc[] = [];
  try {
    for (const b of await listAllBookmarks()) {
      docs.push({
        source: b.folder.split(" / ").includes(READING_LIST_FOLDER) ? "reading" : "bookmark",
        title: b.title,
        url: b.url,
        folder: b.folder,
        id: b.id,
        at: b.dateAdded,
      });
    }
  } catch (err) {
    logger.warn("Search", `Could not read bookmarks: ${err instanceof Error ? err.message : err}`);
  }
  try {
    const items = await browser.history.search({
      text: "",
      startTime: Date.now() - SEARCH_HISTORY_DAYS * 24 * 60 * 60 * 1000,
      maxResults: 500,
    });
    for (const item of items) {
      if (!item.url) continue;
      docs.push({
        source: "history",
        title: item.title ?? "",
        url: item.url,
        at: item.lastVisitTime,
      });
    }
  } catch {
    // No history permission on this device, or no history API at all.
  }
  return docs;
}

async function doctorReply(): Promise<ExtensionResponse> {
  const settings = await getSettings();
  const state = await getState();
  const availability: Record<string, { state: string; permission?: string }> = {};
  for (const type of ["bookmarks", "history", "sessions", "extensions"] as const) {
    const a = await dataTypeAvailability(type);
    availability[type] = a;
  }
  let snapshotCount: number | undefined;
  try {
    snapshotCount = (await syncEngine?.getSnapshotList())?.list.length;
  } catch {
    // The snapshot list needs a backend; the doctor is still useful without it.
  }
  return {
    type: "DOCTOR",
    payload: buildDoctorReport({
      version: browser.runtime.getManifest().version,
      settings,
      state,
      availability,
      ...(snapshotCount !== undefined ? { snapshotCount } : {}),
    }),
  };
}

/** The bookmark tree in the shape the exporters read (same source as a restore point). */
async function bookmarkExportTree(): Promise<SyncBookmark[]> {
  return (await exportBookmarkPayload()).tree;
}

async function handleMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  await ensureInit();
  switch (message.type) {
    case "SYNC_NOW": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      // Await the sync so the pending message response keeps the MV3 worker alive
      // for its whole duration — otherwise a mid-sync suspension can skip the
      // lock's finally and strand the persisted lock until its TTL (C2).
      // A manual press is never gated by the rate-limit cooldown: it is the user's
      // way to try again (and to resume automatic sync once a cycle gets through).
      const outcome = await syncEngine.sync(
        message.payload?.data_type ? [message.payload.data_type] : undefined,
        { force: true }
      );
      // Don't answer OK for a sync that never started. This used to be a blanket OK, so
      // a stranded lock made "Sync now" a no-op that reported success.
      if (outcome === "no-backend") {
        return { type: "ERROR", payload: "No storage backend is set up yet." };
      }
      if (outcome === "already-running") {
        return { type: "ERROR", payload: "A sync is already running — try again in a moment." };
      }
      // Every data type switched off. Saying OK here is what let the popup answer "Synced"
      // to a button press that synced nothing.
      if (outcome === "nothing-enabled") {
        return { type: "ERROR", payload: "No data types are turned on, so there is nothing to sync. Turn one on in Data Types." };
      }
      // A pending direction is not an engine failure, but it is not a completed sync
      // either: runSync() returns before syncAllTypes(), so NOTHING was merged or
      // published. Answering OK here made "Sync now" look successful while the
      // bookmarks stayed exactly as they were — the report that led to this fix.
      // The state banner still carries the onboarding link; this response only stops
      // the button from claiming a sync that never ran.
      if (outcome === "first-sync-pending") {
        return {
          type: "ERROR",
          payload: "Waiting for you to choose a sync direction. No bookmarks were changed; open the Kesonode popup and choose how to merge them.",
        };
      }
      return { type: "OK" };
    }

    case "GET_STATE": {
      const state = await getState();
      return { type: "STATE", payload: state };
    }

    case "GET_SYNC_SCHEDULE": {
      // `scheduledTime` is the browser's own answer, so it already accounts for a periodic
      // alarm that has not been recreated since the interval last changed. Older engines
      // (and a cleared alarm) simply answer undefined: no time to promise.
      const alarm = await browser.alarms.get(SYNC_ALARM);
      const now = Date.now();
      // The alarm's time does not move when a cooldown/backoff parks automatic syncs, so
      // the periodic answer alone promised a cycle that this worker will skip. Report the
      // later of the two: the next cycle that will actually run without a manual press.
      const paused = Math.max(await syncCooldownRemaining(now), await syncBackoffRemaining(now));
      return {
        type: "SYNC_SCHEDULE",
        payload: { next_at: alarm?.scheduledTime ?? null, paused_until: paused > 0 ? now + paused : null },
      };
    }

    case "GET_SETTINGS": {
      const settings = await getSettings();
      return { type: "SETTINGS", payload: settings };
    }

    case "SAVE_SETTINGS": {
      // Unticking a box puts a folder back into the sync, and nothing inside it was
      // recorded while it was out (#54). Telling what came back needs the rules as they
      // stand BEFORE the write, so they are read here rather than after it. The same read
      // tells whether encryption is being turned ON below.
      const previous = await getSettings();
      const wasExcluding = "excluded_bookmarks" in message.payload
        ? previous.excluded_bookmarks ?? []
        : null;
      const updated = await saveSettings(message.payload);
      if (wasExcluding) {
        // Never at the cost of the save itself: the settings are already written, and a
        // browser with no bookmarks API throws in here rather than returning nothing.
        try {
          await recordExclusionRelease(wasExcluding, updated.excluded_bookmarks ?? []);
        } catch (err) {
          logger.error("recordExclusionRelease", err);
        }
      }
      setLoggerDebug(updated.debug_mode);

      // The read-only page is uploaded in plaintext by design (a phone cannot decrypt it),
      // so it must not survive the moment this device starts encrypting everything else.
      // Best effort: the backend may be unreachable, and that must not fail the save.
      if (!previous.encryption_enabled && updated.encryption_enabled) {
        try {
          await syncEngine?.removeViewHtml();
          logger.event("Encryption", "Removed the published read-only page from storage");
        } catch (err) {
          logger.debug("Encryption", `No published read-only page to remove: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Reinit engine with new settings (awaited: an encryption/passphrase change
      // clears the upload checksums so the next sync re-uploads in the new form).
      await syncEngine?.updateSettings(updated);
      if (!updated.sync_on_change || !updated.enabled_types.includes("bookmarks")) {
        await updateBookmarkAlarm();
      }

      // Reconfigure alarm if interval changed
      if ("sync_interval_seconds" in message.payload || "auto_sync" in message.payload) {
        if (updated.auto_sync) {
          // FORCED: a real interval change is the one case that must restart the timer.
          await ensureSyncAlarm(updated.sync_interval_seconds, true);
        } else {
          await browser.alarms.clear(SYNC_ALARM);
        }
      }

      return { type: "OK" };
    }

    case "EXPORT_SETTINGS": {
      const includeCredentials =
        (message as { payload?: { includeCredentials?: boolean } }).payload?.includeCredentials === true;
      return {
        type: "SETTINGS_BACKUP",
        payload: await exportSettingsBackup(browser.runtime.getManifest().version, { includeCredentials }),
      };
    }

    case "IMPORT_SETTINGS": {
      // A settings-backup import can silently turn E2EE off, point the backend at a
      // server the attacker controls, or carry plaintext credentials. Refuse any of
      // those unless the message carries an explicit `confirmImport` flag the UI sets
      // only after showing the user the risk. This is defence-in-depth: the UI entry
      // point is the same place, but this guards against it being bypassed.
      if (!(message as { confirmImport?: boolean }).confirmImport) {
        const risks = importSettingsRisks(await getSettings(), message.payload);
        if (risks.length) {
          throw new Error("IMPORT_SETTINGS_NEEDS_CONFIRM:" + risks.join(","));
        }
      }
      const updated = await importSettingsBackup(message.payload, {
        asNewDevice: (message as { asNewDevice?: boolean }).asNewDevice === true,
        e2eePassphrase:
          typeof (message as { e2eePassphrase?: unknown }).e2eePassphrase === "string"
            ? (message as { e2eePassphrase: string }).e2eePassphrase
            : undefined,
      });
      setLoggerDebug(updated.debug_mode);
      await syncEngine?.updateSettings(updated);
      if (!updated.sync_on_change || !updated.enabled_types.includes("bookmarks")) {
        await updateBookmarkAlarm();
      }
      if (updated.auto_sync) {
        await ensureSyncAlarm(updated.sync_interval_seconds, true);
      } else {
        await browser.alarms.clear(SYNC_ALARM);
      }
      return { type: "OK" };
    }

    case "TEST_BACKEND": {
      // Test the config the options page is SHOWING, not the last one saved: the button
      // sits under the inputs it checks, and reading the saved copy meant a corrected URL
      // still reported the old one's error until Save was pressed.
      const typed = message.payload.config;
      const config = typed && typed.type === message.payload.backend
        ? typed
        : (await getSettings()).backends.find((b) => b.type === message.payload.backend);
      if (!config) return { type: "ERROR", payload: "Backend not configured" };

      const backend = createBackend(config);
      const result = await backend.testConnection();
      return { type: "TEST_RESULT", payload: result };
    }

    case "RESOLVE_CONFLICT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.resolveConflict(message.payload.id, message.payload.resolution);
      return { type: "OK" };
    }

    case "FIRST_SYNC_CHOICE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      // Awaited: the pending message response is what keeps the MV3 worker alive through
      // the replace/delete and the sync that publishes the answer.
      await syncEngine.chooseFirstSync(message.payload.choice, browser.runtime.getManifest().version);
      return { type: "OK" };
    }

    case "GET_BASELINE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return { type: "BASELINE", payload: await syncEngine.getBaselineInfo() };
    }

    case "SET_BASELINE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const baseline = await syncEngine.setBaseline(browser.runtime.getManifest().version);
      // A marker whose tree is not on the storage yet leaves every other device waiting a
      // whole interval. Publishing is best-effort: the marker is already written, and the
      // next ordinary cycle would upload the tree anyway.
      try {
        await syncEngine.sync(["bookmarks"], { force: true, mergeBookmarks: false });
      } catch (err) {
        logger.warn("Baseline", `The baseline is set, but publishing this tree failed: ${err instanceof Error ? err.message : err}`);
      }
      return {
        type: "BASELINE",
        payload: { ...baseline, set_with_version: baseline.marker.app_version, cached: false },
      };
    }

    case "CLEAR_BASELINE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.clearBaseline();
      return { type: "BASELINE", payload: { marker: null, adopted_at: null, cached: false } };
    }

    case "GET_CONFLICT_DIFF": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return { type: "CONFLICT_DIFF", payload: await syncEngine.conflictDiff(message.payload.id) };
    }

    case "RESTORE_SESSION": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.restoreSession(message.payload?.id);
      return { type: "OK" };
    }

    case "CLEAR_AUDIT_LOG": {
      // Clears the local audit log (Settings → Activity). Named CLEAR_HISTORY until
      // 1.0.3 — it never touched browsing history, only this log.
      await browser.storage.local.set({ [KEYS.AUDIT_LOG]: [] });
      return { type: "OK" };
    }

    case "CLEAR_SYNC_REPORTS": {
      await clearSyncReports();
      return { type: "OK" };
    }

    case "CREATE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.snapshotNow({ origin: "manual", pinned: message.payload?.pinned === true });
      return snapshotsReply(syncEngine);
    }

    case "RENAME_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.renameSnapshot(message.payload.name, message.payload.label);
      return snapshotsReply(syncEngine);
    }

    case "PIN_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.pinSnapshot(message.payload.name, message.payload.pinned);
      return snapshotsReply(syncEngine);
    }

    case "LIST_DEVICES": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return { type: "DEVICES", payload: await syncEngine.listDevices() };
    }

    case "FORGET_DEVICE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const removed = await syncEngine.forgetDevice(message.payload.device_id);
      return { type: "DEVICE_FORGOTTEN", payload: { removed } };
    }

    case "APPROVE_BULK_DELETE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      // Arm the latch, then sync immediately. The approval is consumed by the next
      // bookmark merge, and making the user wait out the sync interval to see anything
      // happen would read as a dead button. Bookmarks only: nothing else is involved.
      const pending = message.payload?.blocked ?? 0;
      if (!Number.isFinite(pending) || pending <= 0) {
        return { type: "ERROR", payload: "There is no blocked deletion to apply." };
      }
      await setBulkDeleteApproval(pending);
      const outcome = await syncEngine.sync(["bookmarks"], { force: true });
      if (outcome === "no-backend") {
        await setBulkDeleteApproval(0);
        return { type: "ERROR", payload: "No storage backend is set up yet." };
      }
      // A sync already in flight read the approval at ITS start, which was before this
      // click, so it cannot see this one. The next cycle picks it up. The approval stands
      // rather than being thrown away with the error, so say which cycle it lands on.
      if (outcome === "already-running") {
        return { type: "ERROR", payload: "A sync is already running. The deletion will be applied on the next sync." };
      }
      return { type: "OK" };
    }

    case "LIST_SNAPSHOTS": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      return snapshotsReply(syncEngine);
    }

    case "RESTORE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const restored = await syncEngine.restoreFromSnapshot(message.payload.name);
      return { type: "SNAPSHOT_RESTORED", payload: { restored } };
    }

    case "DELETE_SNAPSHOT": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.removeSnapshot(message.payload.name);
      return snapshotsReply(syncEngine);
    }

    case "SEARCH": {
      const hits = searchDocs(
        await gatherSearchDocs(),
        message.payload?.query ?? "",
        message.payload?.limit
      );
      return { type: "SEARCH_RESULTS", payload: hits };
    }

    case "READING_LIST_ADD": {
      const result = await addToReadingList(message.payload.url, message.payload.title);
      return { type: "READING_LIST_ADDED", payload: result };
    }

    case "READING_LIST_LIST": {
      return { type: "READING_LIST", payload: await listReadingList() };
    }

    case "READING_LIST_REMOVE": {
      await removeFromReadingList(message.payload.id);
      return { type: "READING_LIST", payload: await listReadingList() };
    }

    case "CLEANUP_SCAN": {
      const items = await listAllBookmarks();
      const scan = message.payload?.dead_links ? await checkDeadLinks(items) : null;
      return { type: "CLEANUP_REPORT", payload: buildCleanupReport(items, scan) };
    }

    case "CLEANUP_APPLY": {
      // Only ids the user confirmed. A removal here is an ordinary bookmark deletion, so
      // the listener records a tombstone and the change syncs normally.
      let removed = 0;
      for (const id of message.payload.ids ?? []) {
        try {
          await browser.bookmarks.remove(id);
          removed++;
        } catch (err) {
          logger.warn("Cleanup", `Could not remove bookmark ${id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return { type: "CLEANUP_APPLIED", payload: { removed } };
    }

    case "EXPORT_BOOKMARKS": {
      const settings = await getSettings();
      const result = exportResult(message.payload.format, await bookmarkExportTree(), {
        deviceLabel: settings.device_label,
      });
      let uploaded = false;
      // Uploading only makes sense for the read-only page: that is the file a phone can
      // open from the same storage without importing anything.
      if (message.payload.upload && message.payload.format === "view") {
        if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
        await syncEngine.uploadViewHtml(result.content);
        uploaded = true;
      }
      return { type: "EXPORT_FILE", payload: { ...result, ...(uploaded ? { uploaded } : {}) } };
    }

    case "REMOVE_VIEW_FILE": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      await syncEngine.removeViewHtml();
      return { type: "OK" };
    }

    case "RUN_DOCTOR":
      return doctorReply();

    case "GET_SYNC_REPORTS":
      return { type: "SYNC_REPORTS", payload: await getSyncReports() };

    case "LIST_AUTOSAVED_SESSIONS":
      return { type: "AUTOSAVED_SESSIONS", payload: await getAutosavedSessions() };

    case "RESTORE_SESSION_TABS": {
      if (!syncEngine) return { type: "ERROR", payload: "Engine not initialized" };
      const opened = await syncEngine.restoreSessionTabs(message.payload.urls ?? []);
      if (!opened) return { type: "ERROR", payload: "Nothing selected could be opened." };
      return { type: "OK" };
    }

    default:
      return { type: "ERROR", payload: "Unknown message type" };
  }
}

// ─── Alarm Handler ────────────────────────────────────────────────────────

/**
 * Attach one top-level listener, and survive a browser that hasn't got the event.
 *
 * Every registration in this file runs at module scope, because MV3 requires listeners to
 * be attached on every worker load. That makes the file one long fuse: the FIRST missing
 * event throws, and everything below it never runs, including `ensureInit()` at the very
 * bottom. The result is an extension that started, registered some of its listeners, and
 * looks alive. Kesonode has already been bitten by exactly this once, through the bookmark
 * listeners on a browser with no bookmarks API.
 *
 * Not hypothetical beyond that either: Orion implements roughly 70% of the extension APIs,
 * so "this engine is missing an event we assumed" is a normal Tuesday, not an edge case.
 * A missing event costs the feature that needs it. It must not cost the ones that don't.
 */
function on(ns: string, event: string, register: () => void): void {
  if (!eventPresent(ns, event)) {
    logger.info("ServiceWorker", `This browser has no ${ns}.${event} — that listener is not registered`);
    return;
  }
  try {
    register();
  } catch (e) {
    logger.warn("ServiceWorker", `Registering ${ns}.${event} failed: ${e instanceof Error ? e.message : e}`);
  }
}

on("alarms", "onAlarm", () => browser.alarms.onAlarm.addListener(async (alarm) => {
  // Before anything else: an update that has been waiting for a sync to end. This is the
  // idle moment it was waiting for, and taking it here bounds the wait to one interval.
  if (applyPendingUpdate()) return;
  if (alarm.name === BOOKMARK_ALARM) {
    await syncChangedBookmarks();
    return;
  }
  await ensureInit();
  if (!syncEngine) return;
  if (alarm.name === SYNC_ALARM) {
    // Re-read the setting rather than trusting that nobody could have turned it off: an
    // alarm clear can lose a race with an event the browser already delivered, and a
    // leftover alarm is exactly what init() above repairs. Without this check, "turn off
    // automatic sync" left a device still syncing once a minute until its next restart.
    const settings = await getSettings();
    if (!settings.auto_sync) {
      await browser.alarms.clear(SYNC_ALARM);
      return;
    }
    // The direction card, not a timer, owns the decision while first-sync is pending.
    // The bookmark-change path already skips in this state; without the same guard here,
    // every periodic tick runs sync(), which broadcasts syncing→idle and makes an open
    // popup flicker while the user is still choosing which side wins. Keep the alarm so
    // sync resumes automatically once the card is answered.
    const before = await getState();
    if (before.first_sync_pending) return;
    logger.info("Alarm", "Periodic sync triggered");
    await syncEngine.sync();
  }
}));

// ─── Updates ──────────────────────────────────────────────────────────────

/**
 * A downloaded update that is waiting for a sync to finish.
 *
 * Chrome holds an update back while the extension is running and fires
 * `runtime.onUpdateAvailable` to say so; `runtime.reload()` is how an extension answers
 * "go ahead now". Without that answer the update waits for whenever the browser is next
 * restarted, which for someone who never closes it is a long time. That is the shape of
 * the version spread in the Web Store stats: no permission changed between 1.1.0 and here,
 * so nothing is being held for approval, people are simply still running what they had.
 *
 * A worker-local flag on purpose. If the worker is suspended before the sync ends, the
 * flag goes with it, and the update lands the way it would have anyway. Nothing is lost
 * by forgetting it.
 */
let updateWaiting = false;

/**
 * Apply a pending update if this is a safe moment, and say whether it was taken.
 *
 * Never mid-sync: `reload()` tears the worker down, and a sync killed between taking the
 * persisted lock and releasing it strands that lock for its whole TTL, which turns every
 * sync on this device away in the meantime. One interval of waiting is cheaper than that.
 */
function applyPendingUpdate(): boolean {
  if (!updateWaiting || syncEngine?.isSyncing) return false;
  logger.event("Update", "Applying the update that was downloaded earlier");
  browser.runtime.reload();
  return true;
}

on("runtime", "onUpdateAvailable", () => browser.runtime.onUpdateAvailable.addListener((details) => {
  updateWaiting = true;
  logger.event("Update", `Version ${details?.version ?? "unknown"} is ready to install`);
  // Straight away when nothing is in flight; otherwise the next alarm takes it.
  if (!applyPendingUpdate()) {
    logger.info("Update", "A sync is running, so the update waits for it to finish");
  }
}));

// ─── Lifecycle ────────────────────────────────────────────────────────────

on("runtime", "onInstalled", () => browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    logger.event("Install", "First install, opening onboarding");
    browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });
  }
  await ensureInit();
  if (details.reason === "update") {
    // A self-upgrade: the extension has just replaced its own files. The page that
    // started it was closed by the restart, so open the settings page again — otherwise
    // the upgrade ends with the user's screen empty and nothing saying it worked.
    let reopened = false;
    try {
      const pending = await browser.storage.local.get(KEYS.UPGRADE_PENDING);
      if (pending[KEYS.UPGRADE_PENDING]) {
        await browser.storage.local.remove(KEYS.UPGRADE_PENDING);
        logger.event("Update", "Self-upgrade finished, reopening the settings page");
        await browser.runtime.openOptionsPage();
        reopened = true;
      }
    } catch (err) {
      logger.warn("Update", `Could not reopen the settings page after the upgrade: ${err instanceof Error ? err.message : err}`);
    }
    // A new version may need an optional permission, or an imported WebDAV config may
    // have brought a host permission nobody granted. Nothing in a worker can ask for it:
    // permissions.request() needs a user gesture, so open a page with one real button.
    // The settings page is a page with buttons too, but the onboarding page explains
    // what is missing, so it stays the one that is opened — unless the upgrade just
    // happened, in which case the user is already looking at the settings.
    if (reopened) return;
    try {
      const settings = await getSettings();
      const missing = await missingPermissionsFor(settings);
      if (missing.permissions.length || missing.origins.length) {
        logger.event("Update", "Opening the permission guide for permissions this setup still needs");
        browser.tabs.create({ url: browser.runtime.getURL("onboarding.html?reason=permissions") });
      }
    } catch (err) {
      logger.warn("Update", `Could not check permissions after the update: ${err instanceof Error ? err.message : err}`);
    }
  }
}));

on("runtime", "onStartup", () => browser.runtime.onStartup.addListener(async () => {
  await ensureInit();
}));

// ─── Notifications ────────────────────────────────────────────────────────

// The conflict toast asks the user to open Kesonode, so its click does. See
// openConflictFromNotification for where it lands on each browser.
on("notifications", "onClicked", () => browser.notifications.onClicked.addListener((id) => {
  void openConflictFromNotification(id).catch((e) => logger.error("notifications.onClicked", e));
}));

// Register bookmark-change listeners once, synchronously, at the top level —
// MV3 requires event listeners to be attached on every worker load, and doing
// it here (not in init()) avoids stacking duplicate listeners across wakes.
registerBookmarkListeners(onBookmarkChange);

// ─── Address-bar search ───────────────────────────────────────────────────

/**
 * "kesonode <words>" in the address bar.
 *
 * Optional API (absent on some engines), so it is looked up rather than assumed; the
 * third-party typing path stays in the popup either way. Suggestions carry the URL as
 * their content, which is what the browser navigates to when the row is accepted.
 */
interface OmniboxApi {
  setDefaultSuggestion(suggestion: { description: string }): void;
  onInputChanged: {
    addListener(cb: (text: string, suggest: (items: Array<{ content: string; description: string }>) => void) => void): void;
  };
  onInputEntered: { addListener(cb: (text: string) => void): void };
}
const omniboxApi = (browser as unknown as { omnibox?: OmniboxApi }).omnibox;
try {
  // The browser shows this as the "tab to search" hint, so it follows the UI language.
  omniboxApi?.setDefaultSuggestion({ description: browser.i18n.getMessage("omnibox_default") });
} catch {
  // Cosmetic only; the suggestions below still work without it.
}

// The address bar fires on every keystroke, and each call re-reads the whole bookmark
// tree plus a slice of history. A short debounce keeps that off the typing path, and the
// sequence number stops an older scan from overwriting a newer one's suggestions.
const OMNIBOX_DEBOUNCE_MS = 180;
let omniboxSeq = 0;
let omniboxTimer: ReturnType<typeof setTimeout> | undefined;

on("omnibox", "onInputChanged", () => {
  omniboxApi?.onInputChanged.addListener((text, suggest) => {
    const query = (text ?? "").trim();
    const seq = ++omniboxSeq;
    if (omniboxTimer) clearTimeout(omniboxTimer);
    if (query.length < 2) {
      suggest([]);
      return;
    }
    omniboxTimer = setTimeout(() => {
      void (async () => {
        try {
          const hits = omniboxSuggestions(await gatherSearchDocs(), query);
          if (seq !== omniboxSeq) return;
          suggest(hits.map((hit) => ({
            content: hit.url,
            description: `${escapeOmniboxText(hit.title)} — ${escapeOmniboxText(hit.url)}`,
          })));
        } catch {
          if (seq === omniboxSeq) suggest([]);
        }
      })();
    }, OMNIBOX_DEBOUNCE_MS);
  });
});

on("omnibox", "onInputEntered", () => {
  omniboxApi?.onInputEntered.addListener((text) => {
    const value = (text ?? "").trim();
    if (!value) return;
    // A selected suggestion passes its URL straight through. Enter on the raw query (no
    // suggestion picked) used to do nothing; open the best match instead. Only http(s)
    // URLs are ever launched, so a javascript:/chrome: bookmark can't run from here.
    if (/^https?:\/\//i.test(value)) {
      void browser.tabs.create({ url: value }).catch(() => {});
      return;
    }
    void (async () => {
      try {
        const hits = omniboxSuggestions(await gatherSearchDocs(), value);
        const url = hits.find((h) => /^https?:\/\//i.test(h.url))?.url;
        if (url) await browser.tabs.create({ url });
      } catch { /* nothing to open */ }
    })();
  });
});

// Init on load (handles MV3 service worker wake-ups)
void ensureInit();
