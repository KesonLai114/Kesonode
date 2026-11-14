import { useEffect, useState, useCallback, useRef } from "react";
import type { SyncState, SyncSettings, DataType, SyncExtension, RemoteSessionEntry, SearchHit, ReadingListItem } from "@/lib/types";
import { providerFromConfig, providerById, providerLabel } from "@/lib/storage-providers";
import { sendMessage, request } from "@/lib/utils/messaging";
import { browser, currentStore } from "@/lib/utils/ext";
import { missingLocally, installOrSearchUrl } from "@/lib/utils/extensions-match";
import { KEYS, getSettings, getState, normalizeRemoteSessions, normalizeRemoteExtensions, getRateProgress, getRateAnswered, setRateAnswered, getGuardWarned, setGuardWarned } from "@/lib/utils/storage";
import { rateCardDue, stateNeedsUser } from "@/lib/rate-prompt";
import { openTabUrls, tabsToRestore } from "@/lib/session-restore";
import { reviewPageFor } from "@/lib/store-review";
import { STATE_UPDATE } from "@/lib/constants";
import { streamState, streamInputFor, streamColor, streamLabelKey } from "@/popup/stream-state";
import { groupConflictsByDevice } from "@/popup/conflict-groups";
import { AiPanel } from "@/popup/ai-panel";
import { t, plural, catalogueLocale } from "@/lib/utils/i18n";
import { relativeTime } from "@/lib/device-activity";
import { dataTypeApiPresent, hasPermission } from "@/lib/utils/capabilities";
import { isSafeBookmarkUrl } from "@/lib/utils/url";
import {
  RefreshCw, Settings, Bookmark, Clock, Globe,
  AlertCircle, Loader2, ChevronRight,
  Wifi, Puzzle, ExternalLink, GitMerge, RotateCcw, Star,
  Search, X, BookmarkPlus, Check, Undo2,
} from "lucide-react";

// ─── Constants ────────────────────────────────────────────────────────────

// Shown in the popup footer so a user running several Kesonode copies side by side can
// tell them apart at a glance (the extension list in the browser only shows the name).
// Read defensively for the same reason as REVIEW_PAGE below: a popup page kept alive
// across an extension reload can find `browser.runtime` gone, and a version string is
// not worth a crashed popup.
const APP_VERSION = (() => {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return "";
  }
})();

// Icons are static; the labels are looked up per render so they follow the browser's
// language. Same for STATUS_CONFIG below: the colour classes stay in the table, the
// wording moves out of it.
const DATA_TYPE_META: Record<DataType, { icon: typeof Bookmark }> = {
  bookmarks:  { icon: Bookmark },
  history:    { icon: Clock    },
  sessions:   { icon: Globe    },
  extensions: { icon: Puzzle   },
};

// Literal keys on purpose: the i18n catalogue test only sees a message that is asked for
// by name, so building `popup_source_${source}` here would hide three real strings from it.
const SOURCE_LABEL: Record<"bookmark" | "history" | "reading", string> = {
  bookmark: "popup_source_bookmark",
  history:  "popup_source_history",
  reading:  "popup_source_reading",
};

const STATUS_CONFIG = {
  idle:     { color: "text-sk-muted",  dot: "bg-sk-subtle", ring: "border-sk-subtle" },
  syncing:  { color: "text-sk-warn",   dot: "bg-sk-warn",   ring: "border-sk-warn"   },
  success:  { color: "text-sk-text",   dot: "bg-sk-signal", ring: "border-sk-signal" },
  error:    { color: "text-sk-danger", dot: "bg-sk-danger", ring: "border-sk-danger" },
  conflict: { color: "text-sk-warn",   dot: "bg-sk-warn",   ring: "border-sk-warn"   },
};

const SYNC_ORDER: DataType[] = ["bookmarks", "history", "sessions", "extensions"];

/**
 * A session larger than this asks before it opens.
 *
 * The count sits beside the button, and still a reviewer pressed Restore on a 142-tab
 * session and closed them one by one (appinn, 2026-09-10). One click should not be able to
 * bury a window. Below this a restore is still a single click, which is what it is for.
 */
const RESTORE_CONFIRM_TABS = 20;

// Where this install can be rated. Null on a build no store knows, and then the rating
// card never shows (see lib/rate-prompt.ts for when it does).
// `reviewPageFor` answers null for a self-built package, so this value is only ever null
// here. The id is passed for a future store listing; read it defensively because the
// popup page can be alive from a *previous* load after the extension is reloaded or
// updated (1.5.2 ships without a manifest key on purpose), at which point
// `browser.runtime` can be undefined and this module-top-level call would throw.
const REVIEW_PAGE = reviewPageFor(browser.runtime?.id ?? "");

// ─── App ──────────────────────────────────────────────────────────────────

export default function PopupApp() {
  const [state, setState]       = useState<SyncState | null>(null);
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [syncingType, setSyncingType]   = useState<DataType | null>(null);
  const [syncedTypes, setSyncedTypes]   = useState<Set<DataType>>(new Set());
  const [missingExtensions, setMissingExtensions] = useState<SyncExtension[]>([]);
  const [remoteSessions, setRemoteSessions] = useState<RemoteSessionEntry[]>([]);
  // What is open in this browser, so each session can say how much of it a restore would
  // still open (lib/session-restore). Undefined entries: no `tabs` permission to read them.
  const [openUrls, setOpenUrls] = useState<Array<string | undefined>>([]);
  const [loadError, setLoadError] = useState(false);
  // Why the last button press did nothing. Every one of these handlers used to
  // `await sendMessage(...)` and drop the answer, so an ERROR response — "a sync is
  // already running", a peer whose data can't be applied — looked like a dead button.
  const [actionError, setActionError] = useState<string | null>(null);
  // Which conflict button is in flight, as `${id}:${resolution}`: the resolution is part
  // of the key so the spinner lands on the button that was actually pressed.
  const [resolving, setResolving] = useState<string | null>(null);
  // The session whose Restore was pressed and now waits for "Open N tabs".
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  // The rating card has earned its one showing. Decided once, when the popup opens, from a
  // settled clean `success`; after that it can only be taken away: by either button, or by
  // anything appearing that needs the user (see `stateNeedsUser`).
  const [rateDue, setRateDue] = useState(false);
  // Whether the one-time "running alongside the browser's own sync" tip under the guard
  // banner has been dismissed. Persisted in storage; the banner still shows the short
  // "publishing paused" line even after this is true.
  const [guardWarned, setGuardWarnedState] = useState(false);

  // ── Search (P1) ──
  const [searchQuery, setSearchQuery] = useState("");
  // null = nothing typed yet; [] = typed but nothing found (distinct from "still looking").
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchSeq = useRef(0);

  // ── Reading list (P1) ──
  const [readingList, setReadingList] = useState<ReadingListItem[]>([]);
  const [readingLoaded, setReadingLoaded] = useState(false);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [readingBusy, setReadingBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Last-sync receipt / undo (P0) ──
  // Two steps because a restore replaces the whole local tree.
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoDone, setUndoDone] = useState(false);
  // A new receipt carries a new snapshot, so a confirmation armed for the previous one
  // (or a completed restore) must not carry over into it.
  const receiptKey = state?.sync_report?.at ?? null;
  useEffect(() => {
    setConfirmUndo(false);
    setUndoDone(false);
  }, [receiptKey]);

  // Track animation state separately from sync state
  const animTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevStatusRef = useRef<string>("__init__");

  const load = useCallback(async () => {
    try {
      // Read state + settings DIRECTLY from storage (authoritative + fast). The
      // GET_STATE/GET_SETTINGS messages only round-trip to read the same storage,
      // and on Firefox's non-persistent event page that round-trip can lag while
      // the worker cold-starts — long enough that the popup painted its initial
      // `settings === null` state as "No backend configured", then corrected when
      // the message resolved (the transient flash). Reading storage removes that
      // dependency; the flash is also gated below on `settingsLoaded`.
      const [st, se, rp, ra, gw] = await Promise.all([getState(), getSettings(), getRateProgress(), getRateAnswered(), getGuardWarned()]);
      setState(st);
      setSettings(se);
      setRateDue(st.status === "success" && !stateNeedsUser(st) && rateCardDue(rp, ra));
      setGuardWarnedState(gw);
      setLoadError(false);
    } catch (err) {
      console.error("Popup load error:", err);
      setLoadError(true);
    }
    // Still wake the background so it (re)inits alarms / clears a stuck "syncing",
    // but don't block the UI on it (fire-and-forget — cold event page is fine).
    // `sendMessage` is async, so a page kept alive across an extension reload rejects
    // here rather than throwing; without this handler that rejection was uncaught.
    void sendMessage({ type: "GET_STATE" }).catch(() => {});
  }, []);

  // Start the per-type animation
  const startAnimation = useCallback((enabledTypes: DataType[]) => {
    if (animTimerRef.current) clearInterval(animTimerRef.current);

    const types = SYNC_ORDER.filter((t) => enabledTypes.includes(t));
    if (!types.length) return;

    let idx = 0;
    setSyncingType(types[0]);
    setSyncedTypes(new Set());

    animTimerRef.current = setInterval(() => {
      idx++;
      if (idx < types.length) {
        setSyncedTypes((prev) => new Set([...prev, types[idx - 1]]));
        setSyncingType(types[idx]);
      } else {
        setSyncedTypes(new Set(types));
        setSyncingType(null);
        if (animTimerRef.current) clearInterval(animTimerRef.current);
      }
    }, 600);
  }, []);

  // Stop animation and mark all done
  const stopAnimation = useCallback(() => {
    if (animTimerRef.current) clearInterval(animTimerRef.current);
    setSyncingType(null);
    setSyncedTypes(new Set());
  }, []);

  /**
   * The two things this popup shows about its peers: each device's session, and the union
   * of their extension lists minus what is installed here.
   *
   * Read on mount AND again when a sync finishes, because a sync is what writes both of
   * them. The STATE_UPDATE handler only ever replaced the status, so a popup left open
   * across a sync went on showing the numbers from BEFORE it: a session that had just
   * arrived was not listed, and "missing on this device" was the pre-sync count. That
   * cannot leave a permanent gap, since the next open reads storage fresh, but it corrupts
   * any single measurement somebody takes while watching, which is how a bug report ends up
   * with a number nobody can reproduce.
   */
  const loadOpenTabs = useCallback(async () => {
    try {
      setOpenUrls(await openTabUrls(await browser.tabs.query({})));
    } catch {
      setOpenUrls([]); // no tabs API: every session tab counts as not open, as before
    }
  }, []);

  const loadPeerCaches = useCallback(async () => {
    try {
      const r = await browser.storage.local.get([KEYS.REMOTE_SESSIONS, KEYS.REMOTE_EXTENSIONS]);
      setRemoteSessions(normalizeRemoteSessions(r[KEYS.REMOTE_SESSIONS]));
      void loadOpenTabs();
      // Union of every peer device's extension list (deduped by id).
      const remote = normalizeRemoteExtensions(r[KEYS.REMOTE_EXTENSIONS]);
      // Three ways to arrive at "we cannot say what is missing here", and all three now
      // CLEAR the list rather than leave the last answer on screen: nothing cached from any
      // peer, no API, or the permission not granted. "management" is optional, so the last
      // two are different questions. A permission can be held on a browser that never
      // implemented the API, and then the call below is a TypeError inside a popup, where
      // nobody sees it.
      if (
        !remote.length ||
        !dataTypeApiPresent("extensions") ||
        !(await hasPermission({ permissions: ["management"] }))
      ) {
        setMissingExtensions([]);
        return;
      }
      const local = await browser.management.getAll();
      const here = currentStore();
      // Cross-store the same extension has different ids, so match on id (same
      // store) OR normalized name / homepage host. Otherwise every extension on a
      // different-browser peer would show as "missing" here.
      setMissingExtensions(missingLocally(remote, local, here));
    } catch (err) {
      // Both of these are peer data, so a malformed entry from another device must not take
      // the status, the buttons or Sync now down with it. It matters more now that they load
      // together: as two separate loaders, one failing left the other alone, and this keeps
      // that true.
      console.error("Popup peer-cache load error:", err);
    }
  }, [loadOpenTabs]);

  const loadReadingList = useCallback(async () => {
    const r = await request({ type: "READING_LIST_LIST" });
    if (r.ok && r.res.type === "READING_LIST") {
      setReadingList(r.res.payload);
      setReadingError(null);
    } else {
      // A failed load must not look like an empty list: say so, with the reason.
      setReadingError(r.ok ? "Unexpected reply from Kesonode." : r.error);
    }
    setReadingLoaded(true);
  }, []);

  useEffect(() => {
    load();
    void loadPeerCaches();
    void loadReadingList();

    return () => {
      if (animTimerRef.current) clearInterval(animTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [load, loadPeerCaches, loadReadingList]);

  // Runs as the query changes, debounced. A sequence number makes a slow answer for an
  // older query unable to overwrite the results of a newer one.
  useEffect(() => {
    const q = searchQuery.trim();
    const seq = ++searchSeq.current;
    if (!q) {
      setSearchResults(null);
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    const timer = setTimeout(async () => {
      const r = await request({ type: "SEARCH", payload: { query: q, limit: 8 } });
      if (seq !== searchSeq.current) return;
      setSearchResults(r.ok && r.res.type === "SEARCH_RESULTS" ? r.res.payload : []);
      setSearchBusy(false);
    }, 220);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // React to state changes — drive animation from status
  useEffect(() => {
    if (!state) return;

    const prevStatus = prevStatusRef.current;
    const currStatus = state.status;

    // On initial load (prevStatus is "idle" sentinel)
    if (prevStatus === "__init__") {
      prevStatusRef.current = currStatus;
      // If state was stuck as "syncing" (e.g. crashed mid-sync), reset animation
      if (currStatus !== "syncing") {
        stopAnimation();
      }
      return;
    }

    prevStatusRef.current = currStatus;

    // Sync just started
    if (currStatus === "syncing" && prevStatus !== "syncing") {
      const enabled = settings?.enabled_types ?? SYNC_ORDER;
      startAnimation(enabled);
    }

    // Sync just finished
    if (prevStatus === "syncing" && currStatus !== "syncing") {
      stopAnimation();
      setTimeout(() => setSyncedTypes(new Set()), 1500);
      // It just wrote the peer caches, so what is on screen is now the old answer.
      void loadPeerCaches();
    }
  }, [state?.status, settings?.enabled_types, startAnimation, stopAnimation, loadPeerCaches]);

  // Listen for real-time state updates from background
  useEffect(() => {
    const handler = (msg: { type: string; payload: SyncState }) => {
      if (msg.type === STATE_UPDATE) setState(msg.payload);
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  const handleSyncNow = async () => {
    setActionError(null);
    // The engine reports whether the sync actually started (a stranded lock used to make
    // this a no-op that answered OK). Success still arrives via STATE_UPDATE.
    const r = await request({ type: "SYNC_NOW" });
    if (!r.ok) setActionError(r.error);
  };

  const openOptions = () => browser.runtime.openOptionsPage();

  // Opened from a click, never from a lifecycle event — see `showSetupCard`.
  const openOnboarding = () =>
    void browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });

  // The audit log lives in Settings → Activity (a popup is too cramped to scan a
  // long history). The hash selects that tab on load.
  const openActivityLog = () =>
    void browser.tabs.create({ url: browser.runtime.getURL("options.html#activity") });

  // What differs on a conflict does not fit in 360px, so the card's Resolve button opens
  // the full list in Settings → Activity, where the same two answers are given (#35).
  const openConflicts = () =>
    void browser.tabs.create({ url: browser.runtime.getURL("options.html#activity") });

  const openDataTypes = () =>
    void browser.tabs.create({ url: browser.runtime.getURL("options.html#data") });

  const openAllMissing = () => {
    const here = currentStore();
    missingExtensions.forEach((ext) => {
      // Same-store → the direct listing; cross-store → a name search in THIS
      // browser's store (a peer's CWS id can't resolve on Firefox and vice-versa).
      browser.tabs.create({ url: installOrSearchUrl(ext, here), active: false });
    });
  };

  const openUrl = (url: string) => {
    if (isSafeBookmarkUrl(url)) void browser.tabs.create({ url });
  };

  /**
   * The pre-apply restore point is one click away, but restoring replaces the local tree,
   * so the first click only arms the button. `undoDone` keeps a successful restore from
   * being offered again for the same receipt.
   */
  const undoSync = async () => {
    const snapshot = state?.sync_report?.snapshot;
    if (!snapshot || undoing || undoDone) return;
    if (!confirmUndo) {
      setConfirmUndo(true);
      return;
    }
    setConfirmUndo(false);
    setUndoing(true);
    setActionError(null);
    const r = await request({ type: "RESTORE_SNAPSHOT", payload: { name: snapshot } });
    if (!r.ok) setActionError(r.error);
    else setUndoDone(true);
    setUndoing(false);
  };

  const saveCurrentTab = async () => {
    if (readingBusy) return;
    setReadingBusy(true);
    setActionError(null);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) {
        setActionError(t("popup_reading_no_tab"));
        return;
      }
      const r = await request({
        type: "READING_LIST_ADD",
        payload: { url: tab.url, title: tab.title },
      });
      if (!r.ok) {
        setActionError(r.error);
        return;
      }
      await loadReadingList();
      setJustSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 1600);
    } catch {
      setActionError(t("popup_reading_no_tab"));
    } finally {
      setReadingBusy(false);
    }
  };

  /**
   * Batch actions for AI search results. Both are deliberately sequential and quiet: the
   * popup is small, the list is at most eight rows, and a burst of parallel writes buys
   * nothing but a race in the reading-list folder.
   */
  const saveHitsToReadingList = async (items: { url: string; title: string }[]): Promise<number> => {
    let added = 0;
    for (const item of items) {
      const r = await request({
        type: "READING_LIST_ADD",
        payload: { url: item.url, title: item.title },
      });
      if (r.ok && r.res.type === "READING_LIST_ADDED" && r.res.payload.added) added += 1;
    }
    await loadReadingList();
    return added;
  };

  const openHitsInBackground = (urls: string[]) => {
    for (const url of urls) {
      if (isSafeBookmarkUrl(url)) void browser.tabs.create({ url, active: false });
    }
  };

  const removeReading = async (id: string) => {
    const r = await request({ type: "READING_LIST_REMOVE", payload: { id } });
    if (!r.ok) {
      setActionError(r.error);
      return;
    }
    if (r.res.type === "READING_LIST") setReadingList(r.res.payload);
  };

  /**
   * Resolving takes real time, so the click has to be visible while it does.
   *
   * Either answer is seconds of work, not a state flip: keep local exports the tree,
   * derives a key if E2EE is on (600k PBKDF2 rounds), and PUTs it; use remote decrypts and
   * merges. Nothing on screen said any of that was happening, so a press read as a press
   * that missed, and the natural response is to press it again. Reported from a device at
   * two to three seconds a click.
   *
   * Every button on every card is disabled while one is in flight, not just the one
   * pressed. Answering a second card mid-flight is what put two uploads of one file on the
   * wire at once, which is the 423 the same session hit. The UI is the right place to stop
   * that: the second click was never going to do anything useful anyway.
   */
  const resolveConflict = async (id: string, resolution: "local" | "remote") => {
    if (resolving) return;
    setActionError(null);
    setResolving(`${id}:${resolution}`);
    try {
      // "Use remote" can legitimately fail — an encrypted peer this device can't read, or
      // a packet that is no longer available. Silently reloading made the click look inert.
      const r = await request({ type: "RESOLVE_CONFLICT", payload: { id, resolution } });
      if (!r.ok) setActionError(r.error);
      await load();
    } finally {
      setResolving(null);
    }
  };

  /** `tabs`: how many of the session's tabs are not open here, which is what will open. */
  const restoreSession = async (id: string, tabs: number) => {
    if (tabs > RESTORE_CONFIRM_TABS && confirmRestore !== id) {
      setConfirmRestore(id);
      return;
    }
    setConfirmRestore(null);
    setActionError(null);
    const r = await request({ type: "RESTORE_SESSION", payload: { id } });
    if (!r.ok) setActionError(r.error);
    // The restored tabs are open now, so the session reads "All open" instead of offering
    // the same tabs again.
    await loadOpenTabs();
  };

  /** Either answer ends the card for good. Recorded before the store tab opens, because
   *  opening it closes the popup. */
  const answerRate = async (rate: boolean) => {
    setRateDue(false);
    await setRateAnswered(new Date().toISOString());
    if (rate && REVIEW_PAGE) void browser.tabs.create({ url: REVIEW_PAGE.url });
  };

  const status = state?.status ?? "idle";
  const statusCfg = STATUS_CONFIG[status];
  const isSyncing = status === "syncing";
  const settingsLoaded = settings !== null;
  const hasBackend = !!settings?.active_backend;
  /**
   * A first install that never saw the wizard.
   *
   * The service worker opens onboarding from `onInstalled`, and on WebKit (Orion) that
   * open is a no-op, so the wizard simply never appeared and setup had to be found by
   * opening Settings and knowing what to look for. This card is the way back in, and it
   * works there precisely because a popup click is a real user gesture, which is the one
   * thing WebKit does honour.
   *
   * It earns its place on every engine, though: the `onInstalled` tab is also gone for
   * good on Chrome if you close it, or never noticed if the install left you looking
   * somewhere else.
   */
  const showSetupCard = settingsLoaded && !settings?.onboarding_completed && !hasBackend;
  // Only treat "no backend" as real once settings have actually loaded — otherwise
  // the first paint (settings still null) flashes a false "No backend configured".
  // Suppressed while the setup card is up: on a fresh install both are true, and the
  // card already says the same thing in a more useful way.
  const showNoBackend = settingsLoaded && !hasBackend && !showSetupCard;
  // Relative, not the clock. "16:42" only answers "when" for someone who already knows
  // what time it is; the question behind it is "is this fresh", and after a gap long enough
  // to matter the digits stopped reading as a sync time at all. Same wording as the device
  // list uses ("3 hours ago"), so one phrase means one thing across the extension. It ages
  // with the STATE_UPDATE the status line already follows; the exact moment is a hover away.
  const lastSync = state?.last_sync ? relativeTime(state.last_sync, Date.now(), catalogueLocale()) : null;
  // What the last completed cycle actually changed here (P0 #1). Kept even after a later
  // cycle with no changes, so the line answers "what did the last sync do" rather than
  // disappearing the moment there was nothing to report.
  const syncReport = state?.sync_report ?? null;
  const receiptAge = syncReport ? relativeTime(syncReport.at, Date.now(), catalogueLocale()) : null;
  // Show the chosen provider's name (e.g. "Koofr"), not the raw backend type
  // ("webdav") — several providers map to the WebDAV backend.
  const backendLabel = (() => {
    if (!settings?.active_backend) return t("popup_backend_none");
    const dav = settings.backends.find((b) => b.type === "webdav")?.webdav;
    const pid = providerFromConfig(settings.active_backend, dav?.url, dav?.username);
    return pid ? providerLabel(providerById(pid)) : settings.active_backend;
  })();
  const pulsing = status === "syncing" || status === "success";
  const conflictGroups = groupConflictsByDevice(state?.pending_conflicts ?? []);
  // While the direction question is open a sync returns without doing anything, so the
  // primary button cannot be "Sync now": it looked like a press that missed, and pressing
  // it again was the only thing the popup offered. It becomes the way to answer instead.
  const firstSyncPending = !!state?.first_sync_pending;
  // Settings loaded and every data type switched off. `settingsLoaded` matters: before the
  // read lands, enabled_types is undefined and an empty list would be indistinguishable
  // from "we don't know yet".
  const nothingEnabled = settingsLoaded && (settings?.enabled_types?.length ?? 0) === 0;
  // Never during setup, never beside anything that needs the user. Once something does, the
  // card is gone for as long as this popup stays open: the retry that follows clears the
  // error for a moment, and the card must not come back in that gap.
  const rateBlocked = stateNeedsUser(state) || !!actionError || loadError;
  useEffect(() => {
    if (rateBlocked) setRateDue(false);
  }, [rateBlocked]);
  const showRateCard = !!REVIEW_PAGE && rateDue && !rateBlocked && hasBackend && !!settings?.onboarding_completed;

  return (
    <div className="flex max-h-[600px] w-[360px] flex-col bg-sk-bg text-sk-text">
      {/* Pinned top — header, status, banners and the primary action stay put while
          the body below scrolls. Chrome caps a popup at ~600px tall, so once the
          (expanded) content exceeds that, only the body region scrolls instead of
          the whole popup pushing its header off the top. */}
      <div className="shrink-0 px-4 pt-4">
      {/* ── Status + settings (the toolbar icon already identifies the popup,
            so the wordmark header is dropped; settings moves to the top-right) ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2 w-2 items-center justify-center">
            {pulsing && (
              <span className={`absolute h-2 w-2 rounded-full border-[1.5px] ${statusCfg.ring} animate-kesonode-pulse`} />
            )}
            <span className={`h-2 w-2 rounded-full ${statusCfg.dot}`} />
          </span>
          <span className={`text-sm font-medium ${statusCfg.color}`}>{t(`status_${status}`)}</span>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && (
            <span
              className="text-[12px] text-sk-muted"
              title={state?.last_sync ? new Date(state.last_sync).toLocaleString() : undefined}
            >
              {lastSync}
            </span>
          )}
          <button
            onClick={openOptions}
            aria-label={t("popup_settings_aria")}
            className="flex h-8 w-8 items-center justify-center rounded-icon text-sk-muted transition-colors hover:bg-sk-raised"
          >
            <Settings size={18} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* ── First-run setup ── */}
      {showSetupCard && (
        <div className="mt-3 rounded-box border border-sk-hairline bg-sk-raised px-3 py-3">
          <p className="text-[13px] font-medium text-sk-text">{t("popup_setup_title")}</p>
          <p className="mt-1 text-[12px] text-sk-muted">{t("popup_setup_body")}</p>
          <button
            onClick={openOnboarding}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-box bg-sk-signal px-3 py-2 text-[13px] font-medium text-sk-on-signal transition-opacity hover:opacity-90 active:scale-[0.99]"
          >
            {t("popup_setup_cta")}
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* ── Banners ── */}
      {(loadError || actionError || state?.last_error || state?.first_sync_pending || state?.recovery_notice || state?.guard_notice || (state?.pending_conflicts?.length ?? 0) > 0 || showNoBackend) && (
        <div className="mt-3 space-y-2">
          {/* With nothing turned on, the error the button gives back ends by telling you to
              turn one on in Data Types, and the popup cannot get you there. So the banner
              becomes the way there, the same shape the no-backend one already uses, rather
              than a sentence naming a screen you then have to go and find. Decided on the
              settings rather than on the text of the error: nothing else can fail while
              every data type is off, since the sync returns before it reaches the backend,
              and "go turn something on" is the right next step for any of it anyway. */}
          {actionError && (nothingEnabled ? (
            <button
              onClick={openDataTypes}
              className="flex w-full items-start gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 text-left transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              <span className="flex-1 text-[12px] text-sk-danger">{actionError}</span>
              <ChevronRight size={12} className="mt-0.5 shrink-0 text-sk-danger" />
            </button>
          ) : (
            <div className="flex items-start gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2" role="alert">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              <span className="text-[12px] text-sk-danger">{actionError}</span>
            </div>
          ))}
          {/* The three answers and their consequences need more room than 360px, so the
              popup points at the onboarding direction step, which is the only place the
              choice lives: it is answered once, on first sync, and never again. */}
          {state?.first_sync_pending && (
            <button
              onClick={openOnboarding}
              className="flex w-full items-center gap-2 rounded-box border border-sk-warn bg-sk-raised px-3 py-2 text-left transition-colors hover:bg-sk-tint"
            >
              <GitMerge size={12} className="shrink-0 text-sk-warn" />
              <span className="min-w-0 flex-1 text-[12px] text-sk-warn">{t("popup_first_sync_notice")}</span>
              <span className="shrink-0 text-[12px] text-sk-warn">{t("popup_first_sync_cta")} <ChevronRight size={12} className="inline" /></span>
            </button>
          )}
          {state?.recovery_notice && (
            <button
              onClick={openActivityLog}
              className="flex w-full items-start gap-2 rounded-box border border-sk-warn bg-sk-raised px-3 py-2 text-left transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-warn" />
              <span className="text-[12px] text-sk-warn">
                {t("popup_recovery_notice", String(state.recovery_notice.blocked))}
              </span>
            </button>
          )}
          {state?.guard_notice && (
            <div className="space-y-2">
              <button
                onClick={openActivityLog}
                className="flex w-full items-start gap-2 rounded-box border border-sk-warn bg-sk-raised px-3 py-2 text-left transition-colors hover:bg-sk-tint"
              >
                <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-warn" />
                <span className="text-[12px] text-sk-warn">
                  {t("popup_guard_notice", String(state.guard_notice.changed))}
                </span>
              </button>
              <div className="px-1 text-[11px] text-sk-warn">
                {t("popup_guard_detail", [
                  String(state.guard_notice.changed),
                  String(state.guard_notice.cap),
                  String(state.guard_notice.unstableRounds),
                ])}
              </div>
              {!guardWarned && (
                <div className="rounded-box border border-sk-warn bg-sk-raised px-3 py-2 text-[12px] text-sk-warn">
                  <div className="mb-2">{t("popup_guard_coexist")}</div>
                  <button
                    className="text-[11px] underline underline-offset-2 hover:text-sk-text"
                    onClick={async () => { await setGuardWarned(true); setGuardWarnedState(true); }}
                  >
                    {t("popup_guard_dismiss")}
                  </button>
                </div>
              )}
            </div>
          )}

          {loadError && (
            <button
              onClick={load}
              className="flex w-full items-center justify-center gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 text-[12px] text-sk-danger transition-colors hover:bg-sk-tint"
            >
              <AlertCircle size={12} /> {t("popup_load_error")}
            </button>
          )}

          {state?.last_error && (
            <div className="flex items-start gap-2 rounded-box border border-sk-hairline bg-sk-raised px-3 py-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0 text-sk-danger" />
              <span className="line-clamp-2 text-[12px] text-sk-danger">{state.last_error}</span>
            </div>
          )}

          {/* One card per DEVICE, one row per data type inside it. These sit in the pinned
              header, above the region that scrolls, so a card per peer per type squeezed
              the body to nothing at four of them and would have left nothing at six. The
              types keep separate buttons on purpose (see popup/conflict-groups), and the
              list has its own ceiling so the count of devices can no longer decide how
              much of the popup is left for everything else. */}
          {conflictGroups.length > 0 && (
            <div className="max-h-[200px] space-y-2 overflow-y-auto">
              {conflictGroups.map((group) => {
                const peerName = group[0].device_label ?? t("popup_unknown_device");
                return (
                <div key={group[0].device_id} className="rounded-box border border-sk-hairline bg-sk-raised px-3 py-2">
                  <div className="flex items-center gap-2">
                    <GitMerge size={12} className="shrink-0 text-sk-warn" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-sk-warn">
                      {group[0].device_label ? <bdi>{group[0].device_label}</bdi> : t("popup_unknown_device")}
                    </span>
                    {/* The way to see what the two buttons below are about (#35). */}
                    <button
                      onClick={openConflicts}
                      className="flex shrink-0 items-center gap-0.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                    >
                      {t("popup_conflict_resolve")} <ChevronRight size={12} />
                    </button>
                  </div>
                  {group.map((c) => {
                    const TypeIcon = DATA_TYPE_META[c.data_type].icon;
                    const typeLabel = t(`datatype_${c.data_type}`);
                    return (
                    <div key={c.id} className="mt-1.5 flex items-center gap-1.5">
                      {/* The type as its icon, the same one Active Streams uses for it a
                          section below. Spelled out, this column has to hold "Könyvjelzők"
                          and "Lesezeichen", which leaves the two buttons too narrow for
                          "Anderes übernehmen" and wraps them onto two lines: the row grows
                          back exactly as much as grouping saved. The name is on the tooltip
                          and read out to a screen reader. */}
                      <span className="flex shrink-0 items-center" title={typeLabel} aria-label={typeLabel}>
                        <TypeIcon size={12} className="text-sk-muted" />
                      </span>
                      {/* The spinner REPLACES the label rather than joining it: these two
                          buttons share about 270px, and "Anderes übernehmen" already
                          fills one of them. The labels name the choice, not the transport
                          ("local"/"remote" read as the storage), and each title says which
                          device it applies to because the heading can be truncated. */}
                      <button
                        title={t("popup_keep_local_title", [peerName])}
                        onClick={() => resolveConflict(c.id, "local")}
                        disabled={resolving !== null}
                        className="flex flex-1 items-center justify-center rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {resolving === `${c.id}:local`
                          ? <Loader2 size={12} className="animate-spin" />
                          : t("popup_keep_local")}
                      </button>
                      <button
                        title={t("popup_use_remote_title", [peerName])}
                        onClick={() => resolveConflict(c.id, "remote")}
                        disabled={resolving !== null}
                        className="flex flex-1 items-center justify-center rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {resolving === `${c.id}:remote`
                          ? <Loader2 size={12} className="animate-spin" />
                          : t("popup_use_remote")}
                      </button>
                    </div>
                    );
                  })}
                </div>
                );
              })}
            </div>
          )}

          {showNoBackend && (
            <button
              onClick={openOptions}
              className="flex w-full items-center justify-between rounded-box border border-sk-hairline bg-sk-raised px-3 py-2 transition-colors hover:bg-sk-tint"
            >
              <span className="flex items-center gap-2 text-sk-warn">
                <Wifi size={12} />
                <span className="text-[12px]">{t("popup_no_backend")}</span>
              </span>
              <ChevronRight size={12} className="text-sk-warn" />
            </button>
          )}
        </div>
      )}

      {/* ── Sync now ── */}
      <button
        onClick={firstSyncPending ? openOnboarding : handleSyncNow}
        disabled={isSyncing || !hasBackend}
        className={`mt-4 flex h-11 w-full select-none items-center justify-center gap-2 rounded-box text-sm font-medium transition-colors ${
          hasBackend
            ? "bg-sk-signal text-sk-on-signal hover:opacity-90 active:scale-[0.99]"
            : "cursor-not-allowed bg-sk-raised text-sk-subtle"
        } disabled:opacity-60`}
      >
        {isSyncing ? <Loader2 size={16} className="animate-spin" />
          : firstSyncPending ? <GitMerge size={16} strokeWidth={2} />
          : <RefreshCw size={16} strokeWidth={2} />}
        {isSyncing ? t("status_syncing") : firstSyncPending ? t("popup_first_sync_cta") : t("popup_sync_now")}
      </button>
      </div>

      {/* Scrollable body — the popup grows to fit this; when it would exceed
          Chrome's ~600px ceiling, this region scrolls and the header stays pinned. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {/* ── Active streams (live per-type status) ── */}
      <section className="mt-4">
        <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-sk-subtle">
          {t("popup_active_streams")}
        </h2>
        <div className="grid grid-cols-4 gap-2.5">
          {SYNC_ORDER.map((type) => {
            const Icon = DATA_TYPE_META[type].icon;
            const typeLabel = t(`datatype_${type}`);
            // Derived in one tested place — see popup/stream-state.ts. Inline, this
            // collapsed to blue/"synced" for every enabled type whenever a sync wasn't
            // running, including before the first one and right after a failure.
            const ss = streamState(
              streamInputFor(type, {
                state,
                enabledTypes: settings?.enabled_types,
                syncingType,
                syncedTypes,
              })
            );
            const iconColor = streamColor(ss);

            return (
              <div
                key={type}
                title={`${typeLabel}: ${t(streamLabelKey(ss))}`}
                aria-label={`${typeLabel}: ${t(streamLabelKey(ss))}`}
                className={`flex aspect-square items-center justify-center rounded-full border border-sk-hairline bg-sk-tint ${ss === "off" ? "opacity-40" : ""}`}
              >
                {ss === "syncing" ? (
                  <Loader2 size={22} className={`animate-spin ${iconColor}`} />
                ) : (
                  <Icon size={22} strokeWidth={1.75} className={iconColor} />
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── Last sync receipt, with the pre-apply restore point one click away (P0) ── */}
      {syncReport && (
        <section
          className={`mt-4 flex items-center gap-2 rounded-box border px-3 py-2 ${
            syncReport.dangerous ? "border-sk-warn" : "border-sk-hairline"
          } bg-sk-raised`}
        >
          <span className={`min-w-0 flex-1 text-[12px] ${syncReport.dangerous ? "text-sk-warn" : "text-sk-muted"}`}>
            {syncReport.dangerous
              ? t("popup_receipt_danger", String(syncReport.removed))
              : t("popup_receipt_line", [String(syncReport.added), String(syncReport.removed)])}
            {receiptAge && <span className="text-sk-subtle"> · {receiptAge}</span>}
          </span>
          {syncReport.snapshot && !undoDone && (
            <button
              onClick={undoSync}
              disabled={undoing}
              className="flex shrink-0 items-center gap-1.5 rounded-box border border-sk-hairline bg-sk-surface px-2 py-1 text-[12px] text-sk-muted transition-colors hover:text-sk-text disabled:cursor-not-allowed disabled:opacity-60"
            >
              {undoing ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />}
              {confirmUndo ? t("popup_receipt_undo_confirm") : t("popup_receipt_undo")}
            </button>
          )}
          {undoDone && <span className="shrink-0 text-[12px] text-sk-signal">{t("popup_receipt_undone")}</span>}
        </section>
      )}

      {/* ── Search across bookmarks, history and the reading list (P1) ── */}
      <section className="mt-4">
        <div className="flex items-center gap-2 rounded-box border border-sk-hairline bg-sk-raised px-2.5 py-1.5 focus-within:border-sk-subtle">
          <Search size={14} className="shrink-0 text-sk-subtle" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("popup_search_placeholder")}
            aria-label={t("popup_search_placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-sk-text placeholder:text-sk-subtle focus:outline-none"
          />
          {searchBusy && <Loader2 size={12} className="shrink-0 animate-spin text-sk-subtle" />}
          {!searchBusy && searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              aria-label={t("popup_search_clear")}
              className="shrink-0 rounded-icon p-0.5 text-sk-subtle transition-colors hover:text-sk-text"
            >
              <X size={12} />
            </button>
          )}
        </div>
        {searchResults !== null && (
          <div className="mt-1.5 space-y-0.5">
            {searchResults.length === 0 ? (
              <p className="px-1 py-1 text-[12px] text-sk-subtle">{t("popup_search_empty")}</p>
            ) : (
              searchResults.map((hit) => (
                <button
                  key={`${hit.source}:${hit.id ?? ""}:${hit.url}`}
                  onClick={() => openUrl(hit.url)}
                  title={hit.url}
                  className="flex w-full items-start gap-2 rounded-box px-1 py-1 text-left transition-colors hover:bg-sk-raised"
                >
                  <span className="mt-0.5 shrink-0 rounded-sm border border-sk-hairline px-1 font-mono text-[10px] uppercase text-sk-subtle">
                    {t(SOURCE_LABEL[hit.source])}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-sk-text">{hit.title || hit.url}</span>
                    {hit.folder && (
                      <span className="block truncate text-[11px] text-sk-subtle">{hit.folder}</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </section>

      {/* ── Optional AI panel (off unless enabled in Settings → AI assistant) ── */}
      {settings ? (
        <AiPanel
          settings={settings}
          state={state}
          onOpen={openUrl}
          onSaveAll={saveHitsToReadingList}
          onOpenAll={openHitsInBackground}
        />
      ) : null}

      {/* ── Reading list (P1) ── */}
      <section className="mt-4">
        <div className="flex items-center justify-between">
          <h2 className="pl-0.5 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-sk-subtle">
            {t("popup_reading_head")}
            {readingList.length > 0 && ` · ${readingList.length}`}
          </h2>
          <button
            onClick={saveCurrentTab}
            disabled={readingBusy}
            className="flex items-center gap-1.5 rounded-box border border-sk-hairline bg-sk-raised px-2 py-1 text-[12px] text-sk-muted transition-colors hover:text-sk-text disabled:cursor-not-allowed disabled:opacity-60"
          >
            {readingBusy ? <Loader2 size={12} className="animate-spin" />
              : justSaved ? <Check size={12} className="text-sk-signal" />
              : <BookmarkPlus size={12} />}
            {justSaved ? t("popup_reading_saved") : t("popup_reading_save")}
          </button>
        </div>
        {readingError ? (
          <p className="mt-1 flex items-start gap-1.5 px-1 text-[12px] text-sk-danger">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{t("popup_reading_error", readingError)}</span>
          </p>
        ) : readingLoaded && readingList.length === 0 ? (
          <p className="mt-1 px-1 text-[12px] text-sk-subtle">{t("popup_reading_empty")}</p>
        ) : readingList.length > 0 ? (
          <div className="mt-1 max-h-[132px] space-y-0.5 overflow-y-auto">
            {readingList.map((item) => (
              <div key={item.id} className="flex items-center gap-1.5">
                <button
                  onClick={() => openUrl(item.url)}
                  title={item.url}
                  className="min-w-0 flex-1 truncate rounded-box px-1 py-1 text-left text-[13px] text-sk-text transition-colors hover:bg-sk-raised hover:underline hover:underline-offset-2"
                >
                  {item.title || item.url}
                </button>
                <button
                  onClick={() => void removeReading(item.id)}
                  aria-label={t("popup_reading_remove")}
                  title={t("popup_reading_remove")}
                  className="shrink-0 rounded-icon p-1 text-sk-subtle transition-colors hover:text-sk-danger"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ── Missing extensions ── */}
      {missingExtensions.length > 0 && (
        <div className="flex items-center justify-between px-0.5 pb-0.5 pt-[12px]">
          <span className="text-[14px] font-medium text-sk-warn">
            {plural("popup_missing_extensions", missingExtensions.length)}
          </span>
          <button
            onClick={openAllMissing}
            className="inline-flex items-center gap-1.5 text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_open_all")}
            <ExternalLink size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ── Restore sessions (one per peer device) ── */}
      {remoteSessions.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-2 pl-0.5 font-mono text-[12px] font-medium uppercase tracking-[0.08em] text-sk-subtle">
            {t("popup_sessions_head")}
          </h2>
          <div className="space-y-1.5">
            {remoteSessions.map((entry) => {
              // The normaliser drops entries without a session, but this cache is a peer
              // packet's content: a hand-edited or half-written one must cost its own row,
              // not the whole popup (the first property read here is `session.id`).
              const session = entry?.session;
              if (!session || !Array.isArray(session.tabs)) return null;
              const total = session.tabs.length;
              const missing = tabsToRestore(session.tabs, openUrls).length;
              const openHere = total - missing;
              return (
              <div key={session.id} className="flex items-center gap-2 px-0.5 py-0.5">
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[14px]">{session.label ? <bdi>{session.label}</bdi> : t("popup_unknown_device")}</span>
                  <span className="block truncate font-mono text-[12px] text-sk-subtle">
                    {plural("popup_tabs", total)}
                    {openHere > 0 && ` · ${plural("popup_tabs_open_here", openHere)}`}
                    {entry.timestamp &&
                      ` · ${new Date(entry.timestamp).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`}
                  </span>
                </div>
                {confirmRestore === session.id && (
                  <button
                    onClick={() => setConfirmRestore(null)}
                    className="shrink-0 px-1.5 py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
                  >
                    {t("opt_cancel")}
                  </button>
                )}
                <button
                  onClick={() => restoreSession(session.id, missing)}
                  disabled={missing === 0}
                  className="flex shrink-0 items-center gap-1.5 rounded-box border border-sk-hairline bg-sk-raised px-2.5 py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text disabled:cursor-default disabled:opacity-60 disabled:hover:text-sk-muted"
                >
                  <RotateCcw size={12} />{" "}
                  {missing === 0
                    ? t("popup_restore_all_open")
                    : confirmRestore === session.id
                      ? plural("popup_restore_confirm", missing)
                      : t("popup_restore")}
                </button>
              </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Rating, once ── */}
      {showRateCard && (
        <div className="mt-4 rounded-box border border-sk-hairline bg-sk-raised px-3 py-3">
          <p className="text-[12px] text-sk-muted">{t("popup_rate_body")}</p>
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void answerRate(true)}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-box border border-sk-hairline bg-sk-surface py-1.5 text-[12px] text-sk-text transition-colors hover:bg-sk-tint"
            >
              <Star size={12} /> {t("popup_rate_yes")}
            </button>
            <button
              onClick={() => void answerRate(false)}
              className="flex flex-1 items-center justify-center rounded-box py-1.5 text-[12px] text-sk-muted transition-colors hover:text-sk-text"
            >
              {t("popup_rate_no")}
            </button>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="mt-3.5 flex items-end justify-between border-t border-sk-hairline pt-3.5">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-sk-muted">{t("popup_backend_label")}</span>
            <span className="text-xs">{backendLabel}</span>
          </div>
          {settings?.device_label && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-sk-muted">{t("popup_device_label")}</span>
              <bdi className="font-mono text-xs">{settings.device_label}</bdi>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={openOptions}
            className="text-[14px] font-medium text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_configure")}
          </button>
          <button
            onClick={openActivityLog}
            className="text-[12px] text-sk-muted hover:text-sk-text hover:underline hover:underline-offset-2"
          >
            {t("popup_activity_log")}
          </button>
          <span className="font-mono text-[11px] text-sk-subtle">v{APP_VERSION}</span>
        </div>
      </footer>
      </div>
    </div>
  );
}
