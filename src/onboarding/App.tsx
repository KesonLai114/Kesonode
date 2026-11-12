import { useState, useEffect, useRef, Fragment } from "react";
import { sendMessage, request } from "@/lib/utils/messaging";
import { browser } from "@/lib/utils/ext";
import { t, tParts, plural } from "@/lib/utils/i18n";
import { interactiveSignIn, isDriveAuthAvailable, getStoredGDriveUser } from "@/lib/backends/gdrive-oauth";
import { loadDraft, saveDraft, clearDraft, type DraftStep } from "@/lib/onboarding-draft";

// Some engines (notably iOS WebKit, e.g. Orion) don't support interactive Google
// sign-in; gate the Drive option so users aren't sent into a dead end.
const DRIVE_AVAILABLE = isDriveAuthAvailable();
import type { BackendType, BookmarkExclusion, DataType, FirstSyncChoice, SyncSettings } from "@/lib/types";
import { BookmarkExclusionTree } from "@/lib/ui/bookmark-exclusion-tree";
import {
  allDataTypeAvailability, ensurePermissionWatched, unsupportedReason,
  permissionsToEnable, tabGroupsAskable, missingPermissionsFor, type Availability,
} from "@/lib/utils/capabilities";
import {
  importSettingsBackupFromFile, isEncryptedSettingsBackup, missingImportedCredentials,
  redactedBackupNeedsPassphrase,
} from "@/lib/utils/settings-import";
import { openSettingsBackup } from "@/lib/utils/storage";
import { BACKEND_LABEL } from "@/lib/constants";
import { describePermission } from "@/lib/permission-copy";
import {
  Bookmark,
  Clock, Puzzle, Globe, CheckCircle2, ArrowRight,
  Loader2, XCircle, Eye, EyeOff, Lock, Key, GitMerge,
} from "lucide-react";
// Kesonode brand mark — the glyph only; the container supplies the blue tile.
// Mirrors the sync arrows + node in public/icons/icon.svg.
function BrandMark({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="48 48 160 160" fill="none" aria-hidden="true">
      <g stroke={color} strokeWidth={22} strokeLinecap="round" fill="none">
        <path d="M69.73 106.79 A62 62 0 0 1 186.27 106.79" />
        <path d="M186.27 149.21 A62 62 0 0 1 69.73 149.21" />
      </g>
      <path d="M198.49 102.34 L193.11 125.59 L174.05 111.24 Z" fill={color} />
      <path d="M57.51 153.66 L62.89 130.41 L81.95 144.76 Z" fill={color} />
      <rect x="111" y="111" width="34" height="34" rx="10" fill={color} />
    </svg>
  );
}

import { generateRecoveryKey, MIN_PASSPHRASE_LENGTH } from "@/lib/crypto/encryption";
import {
  providerCards, providerById, providerLabel, nextcloudUrl, pcloudRegionOf, webdavUrlForCard,
  providerFromConfig, type ProviderId,
} from "@/lib/storage-providers";
import { ProviderLogo } from "@/lib/provider-logos";

// ─── Steps ────────────────────────────────────────────────────────────────

type Step =
  | "welcome" | "backend" | "data" | "encrypt" | "syncing" | "done" | "permissions" | "imported"
  // Asked only when the storage already holds another device's bookmarks: the sync is
  // paused until this is answered, so it belongs in the wizard the user is already in.
  | "direction"
  // Shown instead of the wizard when this install is ALREADY set up. See REASON below.
  | "manage";

const STEPS: Step[] = ["welcome", "backend", "data", "encrypt", "done"];
const SETUP_STEPS: readonly Step[] = ["welcome", "backend", "data", "encrypt"];

/**
 * Which page this open is for.
 *
 * Three arrivals, three very different jobs:
 *
 * - `install` — nothing configured yet, walk the wizard.
 * - `update` — a version may need permissions re-granted (see service-worker.ts). This
 *   mode is READ-ONLY with respect to settings: it must never write them, because the
 *   wizard's state is empty and finishing it would replace a real setup with defaults.
 * - `manage` — an install that is already set up. It has no reason to run the wizard, and
 *   running it used to be actively destructive: `finish()` overwrites `backends` with the
 *   single card picked on screen and `enabled_types` with the wizard's defaults, so
 *   reloading a finished tab, or revisiting a bookmarked onboarding.html, silently
 *   replaced a working multi-backend setup with a one-backend, bookmarks-only one.
 *
 * `reason=reconfigure` is the one deliberate way back into the wizard once set up: the
 * manage page's own button, behind a confirmation that says what will be replaced.
 */
const REASON = typeof window !== "undefined"
  ? new URLSearchParams(window.location.search).get("reason")
  : null;
const PERMISSION_MODE = REASON === "permissions";
const RECONFIGURE = REASON === "reconfigure";

// Icon for the live sync-progress list (#3) — matches the data-types step. The label is
// the shared `datatype_*` message, looked up at render.
const TYPE_META: Record<"bookmarks" | "extensions" | "history" | "sessions", { Icon: typeof Bookmark }> = {
  bookmarks:  { Icon: Bookmark },
  extensions: { Icon: Puzzle   },
  history:    { Icon: Clock    },
  sessions:   { Icon: Globe    },
};

/**
 * The three answers to "which side wins", worded by the shared `opt_first_sync_*`
 * messages. The consequences are severe — one of them clears this browser's bookmarks —
 * so the text lives in one place and is not reworded per screen.
 * Merge is first because it is the recommendation and the one that deletes nothing.
 */
const DIRECTION_OPTIONS: ReadonlyArray<{ choice: FirstSyncChoice; label: string; desc: string }> = [
  { choice: "merge",  label: "opt_first_sync_merge",  desc: "opt_first_sync_merge_desc"  },
  { choice: "remote", label: "opt_first_sync_remote", desc: "opt_first_sync_remote_desc" },
  { choice: "local",  label: "opt_first_sync_local",  desc: "opt_first_sync_local_desc"  },
];

// ─── App ──────────────────────────────────────────────────────────────────

export default function OnboardingApp() {
  // Seeded from the entry mode rather than always "welcome". The update page used to
  // paint the welcome card — device-name field and all — for the one frame before its
  // effect switched to the permission step, and a restored draft did the same to a user
  // halfway through setup. A step that depends only on the URL needs no effect to reach.
  const [step, setStep] = useState<Step>(PERMISSION_MODE ? "permissions" : "welcome");
  // The first page can restore a previously exported backup instead of walking through
  // setup, and an update can open this page only to re-grant permissions.
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  // A picked file that cannot be applied yet: an encrypted backup needs its password,
  // and a redacted one that enables E2EE needs the passphrase it deliberately left out.
  const [pendingBackup, setPendingBackup] = useState<{ doc: unknown; needs: "password" | "passphrase" } | null>(null);
  const [pendingSecret, setPendingSecret] = useState("");
  const [pendingShowSecret, setPendingShowSecret] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  // A redacted backup restores no secrets. Naming them is the only useful thing left to
  // say — a first sync would fail on the account, not on the data.
  const [importedMissing, setImportedMissing] = useState<BackendType[] | null>(null);
  const [missingPerms, setMissingPerms] = useState<{ permissions: string[]; origins: string[] }>({ permissions: [], origins: [] });
  // The stored setup, when this install is already configured — the manage page renders
  // from it and never writes to it. Separate from `current` reads elsewhere because this
  // one is a snapshot taken at open, not something the wizard is editing.
  const [configured, setConfigured] = useState<SyncSettings | null>(null);
  const [configuredMissing, setConfiguredMissing] = useState<{ permissions: string[]; origins: string[] } | null>(null);
  const [permissionPhase, setPermissionPhase] = useState<"checking" | "needed" | "done" | "failed">("checking");
  const [permBusy, setPermBusy] = useState(false);
  const [permSlowHere, setPermSlowHere] = useState(false);
  // Pre-filled from the auto-detected name, so this is a field to correct rather than a
  // question to answer. Left alone it costs the user nothing.
  const [deviceLabel, setDeviceLabel] = useState("");
  // Selected storage-provider card. `backend` + the effective WebDAV URL are derived
  // from it below (several cards map to the WebDAV backend).
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [saving, setSaving] = useState(false);
  // Finish is waiting on the browser's permission prompt, and whether that wait has run
  // long enough to suggest there is no prompt at all (see ensurePermissionWatched).
  const [awaitingPerm, setAwaitingPerm] = useState(false);
  const [permSlow, setPermSlow] = useState(false);
  // Each Finish press takes a number. A prompt that never answered may still answer after
  // the user has pressed again, and only the latest press may carry on from there.
  const finishSeq = useRef(0);

  // Google Drive
  const [gdriveUser, setGdriveUser] = useState<{ email: string; displayName: string } | null>(null);
  const [gdriveConnecting, setGdriveConnecting] = useState(false);
  const [gdriveError, setGdriveError] = useState<string | null>(null);

  // GitHub
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubUser, setGithubUser] = useState<{ login: string } | null>(null);
  const [githubChecking, setGithubChecking] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  // Latest-wins guard + debounce timer for the token check. See scheduleVerify.
  const verifySeq = useRef(0);
  const verifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WebDAV
  const [webdavUrl, setWebdavUrl] = useState("");
  const [webdavUser, setWebdavUser] = useState("");
  const [webdavPass, setWebdavPass] = useState("");
  const [ncHost, setNcHost] = useState(""); // Nextcloud/ownCloud server host
  const [showPass, setShowPass] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Data types
  const [dataTypes, setDataTypes] = useState({
    bookmarks: true,
    extensions: false, // opt-in: the extension list is fingerprint-grade data
    history: false,
    sessions: false,
  });
  // Bookmarks this device keeps out of sync (#54), offered here because the first sync is
  // the one that would otherwise push an extension's whole folder to every device.
  const [exclusions, setExclusions] = useState<BookmarkExclusion[]>([]);
  const [excludeOpen, setExcludeOpen] = useState(false);

  /**
   * What this browser can actually sync — see lib/utils/capabilities.
   *
   * Empty until the check resolves, and `unsupported` is the only state the wizard acts
   * on, so the brief unknown window can only ever leave a row enabled a moment longer
   * than it should. Nothing is switched OFF on a guess.
   */
  const [availability, setAvailability] = useState<Partial<Record<DataType, Availability>>>({});
  const unavailable = (key: DataType): boolean => availability[key]?.state === "unsupported";

  // Whether Open tabs may ask for `tabGroups` in the same request (#11). Read now, because
  // the Finish click has to reach permissions.request() before it awaits anything.
  const [askTabGroups, setAskTabGroups] = useState(false);

  useEffect(() => {
    void (async () => {
      setAvailability(await allDataTypeAvailability());
    })();
    void tabGroupsAskable().then(setAskTabGroups);
  }, []);

  // Whether the draft has been read back yet (#38). Nothing is written until it has, or the
  // wizard's blank first render would overwrite the very answers it is about to restore.
  const [restored, setRestored] = useState(false);
  // Set once the settings are saved. From then on the draft is only ever removed: a save
  // still waiting out its debounce would otherwise land after the removal and put the
  // credentials back for a setup that has already finished.
  const draftClosed = useRef(false);

  // Bookmarks ships on by default, so on a browser with no bookmarks API the wizard would
  // otherwise finish with a data type that cannot produce a single byte, and the progress
  // step would sit there waiting for a count that never moves. Run again once the draft is
  // back, because a restored choice must not switch a type on that this browser lacks.
  useEffect(() => {
    setDataTypes((p) => {
      const off = (Object.keys(p) as DataType[]).filter((k) => p[k] && availability[k]?.state === "unsupported");
      return off.length ? { ...p, ...Object.fromEntries(off.map((k) => [k, false])) } : p;
    });
  }, [availability, restored]);

  const toggleData = (key: keyof typeof dataTypes) => {
    if (unavailable(key)) return;
    setDataTypes((p) => ({ ...p, [key]: !p[key] }));
  };

  // Derived from the selected provider card.
  const backend: BackendType | null = provider ? providerById(provider).backend : null;
  const effectiveWebdavUrl = provider === "nextcloud" ? nextcloudUrl(ncHost, webdavUser) : webdavUrl;

  /**
   * The storage this install is actually using, named the way the user picked it.
   *
   * `active_backend` is an enum ("webdav"); the card they chose says "Koofr". A summary
   * page that answers "WebDAV" to "where is my data" is technically true and useless.
   */
  const activeBackendLabel = (s: SyncSettings): string => {
    const b = s.backends.find((x) => x.type === s.active_backend);
    if (b?.type === "webdav") {
      const pid = providerFromConfig("webdav", b.webdav?.url, b.webdav?.username);
      return pid ? providerLabel(providerById(pid)) : "WebDAV";
    }
    if (b?.type === "gdrive") return "Google Drive";
    if (b?.type === "github") return "GitHub";
    return s.active_backend ?? "—";
  };

  // Per-card WebDAV credentials, remembered while the wizard is open. The fields are
  // shared by every WebDAV card, so switching swaps them rather than wiping them —
  // clicking another card and back must not throw away what was already typed.
  const credStash = useRef<Partial<Record<ProviderId, { user: string; pass: string; host: string; url: string }>>>({});

  // Pick a provider card → for WebDAV presets, fill/clear the server URL.
  const pickProvider = (id: ProviderId) => {
    if (provider === id) return;
    const prev = provider;
    setProvider(id);

    if (prev && providerById(prev).backend === "webdav") {
      credStash.current[prev] = { user: webdavUser, pass: webdavPass, host: ncHost, url: webdavUrl };
    }

    const p = providerById(id);
    if (p.backend === "webdav") {
      // This card's own values, not the previous card's — a different account.
      const kept = credStash.current[id] ?? { user: "", pass: "", host: "", url: "" };
      setWebdavUser(kept.user); setWebdavPass(kept.pass); setNcHost(kept.host);
      setWebdavUrl(webdavUrlForCard(id, kept.url));
    }
  };

  const hintStyle = { fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.4 };

  /**
   * Forget the `?reason=` this page was opened with.
   *
   * The entry mode is read from the URL, so a tab that finished setup while still carrying
   * `reason=reconfigure` would open the WIZARD again on reload — and finishing that a
   * second time replaces the setup it just saved. Dropping the marker makes the next load
   * arrive as "already set up", which is what it is. A page that refuses replaceState
   * keeps its URL; the risk then is one more confirmation, not a silent overwrite.
   */
  const clearEntryReason = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("reason");
      window.history.replaceState(null, "", url.toString());
    } catch { /* see above */ }
  };

  // Sentences whose middle is a separate element: the URL is monospace, the emphasised
  // word is bold, and the storage provider's name must not be translated. `tParts` splits
  // the translated string at its placeholder, so word order stays the translator's call.
  const syncingTo = (url: string) => {
    const [before, after] = tParts("provider_syncing_to");
    return <>{before}<code>{url}</code>{after}</>;
  };
  // The pCloud hint names the region that is actually selected ("Pick the EU region if
  // that is where your account lives"), so it needs the label of the chosen one rather
  // than a generic sentence. A card is always picked with a region already set —
  // `webdavUrlForCard` seeds the first one — so the fallback is only a belt.
  const pcloudRegionLabel = (p: { regions?: { id: string; label: string }[] }, url: string) =>
    p.regions?.find((r) => pcloudRegionOf(url) === r.id)?.label ?? p.regions?.[0]?.label ?? "";

  const plaintextNote = tParts("onb_plaintext_note");
  const doneNote = tParts("onb_done_subtitle");

  // Shared WebDAV username + password inputs (stacked). Used by every WebDAV card.
  const webdavCreds = () => (
    <>
      <input style={S.input} placeholder={t("onb_webdav_user_placeholder")} autoComplete="off"
        value={webdavUser} onChange={(e) => setWebdavUser(e.target.value)} />
      <div style={{ position: "relative" }}>
        <input style={{ ...S.input, width: "100%", paddingRight: 32 }}
          type={showPass ? "text" : "password"} placeholder={t("onb_webdav_pass_placeholder")}
          value={webdavPass} onChange={(e) => setWebdavPass(e.target.value)} />
        <button style={S.eyeBtn} onClick={() => setShowPass((v) => !v)}>
          {showPass ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </div>
    </>
  );

  // Encryption choice (made consciously on the "encrypt" step)
  const [encEnabled, setEncEnabled] = useState(false);
  const [encPass, setEncPass] = useState("");
  // #2 double-entry: a mistyped passphrase makes E2EE data unrecoverable, so a
  // manually-typed passphrase must be confirmed. A generated key (exact) skips it.
  const [encConfirm, setEncConfirm] = useState("");
  const [encGenerated, setEncGenerated] = useState("");
  const [showEncPass, setShowEncPass] = useState(false);
  const [showEncConfirm, setShowEncConfirm] = useState(false);
  // Set once the user hits Finish with E2EE on but the passphrase not (correctly)
  // filled — drives the red border + inline error (clears itself as they fix it).
  const [encTouched, setEncTouched] = useState(false);
  // Note: no copy-passphrase button here (unlike Settings). Onboarding is where the
  // passphrase is first CONFIRMED by re-typing; a copy button would let the user
  // paste it into the confirm field and defeat the double-entry check. Settings —
  // where the passphrase is already set — keeps copy for saving/rotating it.

  // #3: post-finish live sync progress. STATE_UPDATE only fires at sync start/end,
  // so we poll GET_STATE and light up each enabled type as its sync_counts entry
  // climbs past the baseline captured when the user hit Finish.
  const [syncCounts, setSyncCounts] = useState<Record<string, number>>({});
  // Item counts for the progress rows. `sync_counts` decides DONE (it ticks once per
  // completed type), but printing it showed "1, 2, 3" where the user expects how much
  // data moved. A type that has not finished its first sync yet has no total — the row
  // simply shows no number.
  const [syncTotals, setSyncTotals] = useState<Record<string, number>>({});
  // A restored backup still owes this browser its first sync, and the optional
  // permissions it needs may be granted one screen later.
  const importedSyncPending = useRef(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncTimedOut, setSyncTimedOut] = useState(false);
  const baselineRef = useRef<Record<string, number>>({});
  // A finished install reaches the direction step from the popup's notice, so `finish()`
  // never ran and no baseline was captured. The progress step would then compare against
  // `{}` — every type with any earlier sync would read as "already done" before the answer
  // had even been applied. Seeded at the click instead (see applyDirection).
  const needsBaselineBeforeAnswer = useRef(false);
  const enabledTypes = (["bookmarks", "extensions", "history", "sessions"] as const).filter((k) => dataTypes[k]);
  // Everything off is not a setup: it saves an empty `enabled_types`, and the first sync
  // then fails before it reaches the backend. The step that owns the choice refuses to
  // move on instead, and says why.
  const anyTypeOn = enabledTypes.length > 0;

  // The first sync is a question, not a transfer. When the storage already holds another
  // device's bookmarks, the worker pauses the sync and waits for a direction; that used to
  // surface only in Settings → Activity, so setup finished with nothing synced and no
  // visible next step. The question is asked HERE instead, and `firstSyncPeers` is the
  // count it reports (null until the probe has run).
  const [firstSyncPeers, setFirstSyncPeers] = useState<number | null>(null);
  const [directionChoice, setDirectionChoice] = useState<FirstSyncChoice>("merge");
  const [directionBusy, setDirectionBusy] = useState(false);
  const [directionError, setDirectionError] = useState<string | null>(null);

  // E2EE validation (a generated key is exact, so it skips the double-entry confirm).
  const confirmNeeded = encEnabled && encPass.length > 0 && encPass !== encGenerated;
  const passMissing = encEnabled && !encPass;
  const confirmMismatch = confirmNeeded && encConfirm !== encPass;
  // Strength floor for a manually-typed passphrase (a generated key is long by
  // construction): synced blobs sit on third-party storage and can be brute-forced
  // offline, so a short passphrase would hollow out the E2EE promise.
  const passTooShort = confirmNeeded && encPass.length < MIN_PASSPHRASE_LENGTH;

  // Pick up where the wizard was (#38): the draft if there is one, the Drive session if a
  // sign-in already completed, and otherwise the name the extension detected for this
  // device, so the field starts filled.
  // A version update opens this page just to re-grant permissions. Ask what the CURRENT
  // setup needs, not what the manifest declares: the request is built from the answer.
  useEffect(() => {
    if (!PERMISSION_MODE) return;
    setStep("permissions");
    void (async () => {
      const res = await request({ type: "GET_SETTINGS" });
      if (!res.ok || res.res.type !== "SETTINGS") { setPermissionPhase("failed"); return; }
      const missing = await missingPermissionsFor(res.res.payload);
      setMissingPerms(missing);
      setPermissionPhase(missing.permissions.length || missing.origins.length ? "needed" : "done");
    })();
  }, []);

  useEffect(() => {
    if (PERMISSION_MODE) { setRestored(true); return; }
    void (async () => {
      try {
        const [res, draft, driveUser, stateRes] = await Promise.all([
          request({ type: "GET_SETTINGS" }),
          loadDraft().catch(() => null),
          getStoredGDriveUser().catch(() => null),
          request({ type: "GET_STATE" }),
        ]);
        const settings = res.ok && res.res.type === "SETTINGS" ? res.res.payload : null;
        const detected = settings?.device_label ?? "";
        // interactiveSignIn stores the session as it completes, so a sign-in that finished
        // before the page went away is still here. The wizard used to know about it only
        // from its own state, showed a signed-in user as signed out, and sent them back
        // through Google's consent: on a phone, the same trip that lost the page.
        if (driveUser) setGdriveUser(driveUser);

        // Already set up, and nobody asked to reconfigure. Show what is stored instead of
        // the wizard. This is the guard that keeps a reloaded tab, a bookmark, or a link
        // from walking a finished install through `finish()` — which would replace the
        // backend list and the enabled data types with this page's empty defaults.
        //
        // The one exception is an unanswered first-sync question: the sync can find peers
        // after the wizard has closed, and the popup's notice lands here. This is the
        // only surface that asks it, so showing "already set up" would leave it unanswerable.
        const pending = stateRes.ok && stateRes.res.type === "STATE"
          ? stateRes.res.payload.first_sync_pending : null;
        if (settings?.onboarding_completed && !RECONFIGURE && pending) {
          setConfigured(settings);
          setDeviceLabel(detected);
          setFirstSyncPeers(pending.peer_count);
          // No `finish()` on this path, so the progress screen needs a baseline taken at
          // the click (see applyDirection).
          needsBaselineBeforeAnswer.current = true;
          const on = settings.enabled_types ?? ["bookmarks"];
          setDataTypes({
            bookmarks: on.includes("bookmarks"),
            extensions: on.includes("extensions"),
            history: on.includes("history"),
            sessions: on.includes("sessions"),
          });
          setStep("direction");
          return;
        }
        if (settings?.onboarding_completed && !RECONFIGURE) {
          setConfigured(settings);
          setDeviceLabel(detected);
          setStep("manage");
          // A summary page that cannot read the permission state must still render: an
          // answer of "none missing" would be a lie, so the row shows the spinner and a
          // failed read leaves it there rather than claiming everything is granted.
          setConfiguredMissing(
            await missingPermissionsFor(settings).catch(() => null),
          );
          return;
        }

        if (!draft) {
          setDeviceLabel(detected);
          // Reloading this page mid-setup is ordinary (a crash, a closed window). The
          // settings are already saved by then, so the one thing still open can be the
          // unanswered first-sync question — and showing "welcome" to an install that
          // finished while the sync waits for that answer is a dead end.
          if (pending) {
            setFirstSyncPeers(pending.peer_count);
            // Take the types that are actually ON, so the progress step after the answer
            // waits for the same ones the worker is going to sync. Bookmarks is the
            // fallback when the settings read failed — the question is about bookmarks.
            const on = settings?.enabled_types ?? ["bookmarks"];
            setDataTypes({
              bookmarks: on.includes("bookmarks"),
              extensions: on.includes("extensions"),
              history: on.includes("history"),
              sessions: on.includes("sessions"),
            });
            setStep("direction");
          }
          return;
        }
        setDeviceLabel(draft.deviceLabel || detected);
        // Set directly, not through pickProvider, which would swap these very fields out.
        setProvider(draft.provider);
        setGithubToken(draft.githubToken);
        setGithubRepo(draft.githubRepo);
        setGithubBranch(draft.githubBranch);
        setWebdavUrl(draft.webdavUrl);
        setWebdavUser(draft.webdavUser);
        setWebdavPass(draft.webdavPass);
        setNcHost(draft.ncHost);
        setDataTypes(draft.dataTypes);
        setExclusions(draft.bookmarkExclusions);
        setExcludeOpen(draft.bookmarkExclusions.length > 0);
        setStep(draft.step);
        // The token was checked before the reload, but only the check sets who it belongs
        // to, and Continue waits for that.
        if (draft.provider === "github" && draft.githubToken) scheduleVerify(draft.githubToken);
      } finally {
        setRestored(true);
      }
    })();
    // Mount only: this reads back what the rest of the wizard then owns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the draft as the answers change, from the moment it has been read back until the
  // settings are saved. Debounced, since the text fields change on every keystroke.
  useEffect(() => {
    if (!restored || !(["welcome", "backend", "data", "encrypt"] as string[]).includes(step)) return;
    const id = setTimeout(() => {
      if (draftClosed.current) return;
      void saveDraft({
        step: step as DraftStep, deviceLabel, provider,
        githubToken, githubRepo, githubBranch,
        webdavUrl, webdavUser, webdavPass, ncHost,
        dataTypes, bookmarkExclusions: exclusions,
      }).catch(() => { /* a draft that cannot be written costs a retype, nothing more */ });
    }, 300);
    return () => clearTimeout(id);
  }, [restored, step, deviceLabel, provider, githubToken, githubRepo, githubBranch,
    webdavUrl, webdavUser, webdavPass, ncHost, dataTypes, exclusions]);

  useEffect(() => {
    if (step !== "syncing") return;
    let cancelled = false;
    let elapsed = 0;
    const POLL_MS = 600;
    const TIMEOUT_MS = 20000;
    const id = setInterval(async () => {
      const res = await request({ type: "GET_STATE" });
      if (cancelled || !res.ok || res.res.type !== "STATE") return;
      const st = res.res.payload;
      setSyncCounts(st.sync_counts);
      setSyncTotals(st.sync_totals ?? {});
      // Nothing is merged and no counter moves while this is set, so the old behaviour
      // was a spinner that ran into the 20-second timeout and then told the user to go
      // and find the answer in Settings. Ask it here, in the window they are already in.
      if (st.first_sync_pending) {
        clearInterval(id);
        setFirstSyncPeers(st.first_sync_pending.peer_count);
        setDirectionError(null);
        setStep("direction");
        return;
      }
      if (st.status === "error" && st.last_error) {
        clearInterval(id);
        setSyncError(st.last_error);
        return;
      }
      const base = baselineRef.current;
      const allDone = enabledTypes.every((t) => (st.sync_counts[t] ?? 0) > (base[t] ?? 0));
      if (allDone) {
        clearInterval(id);
        setTimeout(() => { if (!cancelled) setStep("done"); }, 500);
        return;
      }
      elapsed += POLL_MS;
      if (elapsed >= TIMEOUT_MS) {
        clearInterval(id);
        setSyncTimedOut(true);
      }
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [step]);

  const next = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  };

  /**
   * Run the first sync right after a settings backup is restored.
   *
   * The import path used to stop on a "restored" screen. The backend and credentials were
   * saved, but nothing was merged or published — and on a browser that already has
   * bookmarks the next cycle parks on the "which side wins" question, which only THIS page
   * and the popup can ask. Bookmark changes refuse to sync while it waits, so two installs
   * with identical settings sat there without exchanging a single bookmark. The question
   * is part of setup, and setup is still on screen: run the sync and let the direction
   * step ask it now.
   */
  const startImportedSync = async (enabled: readonly string[] | undefined) => {
    const on = enabled ?? ["bookmarks"];
    // The progress step waits for the types that are actually ON. It reads `dataTypes`,
    // so seed it from the imported settings rather than this page's empty defaults.
    setDataTypes({
      bookmarks: on.includes("bookmarks"),
      extensions: on.includes("extensions"),
      history: on.includes("history"),
      sessions: on.includes("sessions"),
    });
    const st = await request({ type: "GET_STATE" });
    const state = st.ok && st.res.type === "STATE" ? st.res.payload : null;
    baselineRef.current = state ? { ...state.sync_counts } : {};
    setSyncCounts(baselineRef.current);
    setSyncTotals(state?.sync_totals ?? {});
    setSyncError(null);
    setSyncTimedOut(false);
    setStep("syncing");
    void sendMessage({ type: "SYNC_NOW" }).catch(() => {});
  };

  /** Restore a settings backup from the FIRST page, so a reinstall never has to close
   *  the wizard and hunt for Settings → Advanced. */
  const importBackup = async (file: File) => {
    setImporting(true);
    setImportError(null);
    setImportedMissing(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (isEncryptedSettingsBackup(parsed)) {
        setPendingBackup({ doc: parsed, needs: "password" });
        setPendingSecret("");
        setPendingShowSecret(false);
        setPendingError(null);
        return;
      }
      // Asked before the overwrite questions: the worker refuses this import anyway, and
      // refusing after every question is answered is worse than asking up front.
      if (await redactedBackupNeedsPassphrase(parsed)) {
        setPendingBackup({ doc: parsed, needs: "passphrase" });
        setPendingSecret("");
        setPendingShowSecret(false);
        setPendingError(null);
        return;
      }
      await applyImportedBackup(parsed, {});
    } catch (err) {
      setImportError(t("onb_import_failed", err instanceof Error ? err.message : String(err)));
    } finally {
      setImporting(false);
    }
  };

  const submitPendingBackup = async () => {
    if (!pendingBackup) return;
    setPendingError(null);
    if (pendingBackup.needs === "passphrase") {
      if (!pendingSecret) { setPendingError(t("opt_cfg_import_need_passphrase")); return; }
      if (pendingSecret.length < MIN_PASSPHRASE_LENGTH) {
        setPendingError(t("opt_cfg_import_pass_short", String(MIN_PASSPHRASE_LENGTH)));
        return;
      }
      const doc = pendingBackup.doc;
      const passphrase = pendingSecret;
      setPendingBackup(null);
      setPendingSecret("");
      setImporting(true);
      try {
        await applyImportedBackup(doc, { e2eePassphrase: passphrase });
      } catch (err) {
        setImportError(t("onb_import_failed", err instanceof Error ? err.message : String(err)));
      } finally {
        setImporting(false);
      }
      return;
    }
    setPendingBusy(true);
    try {
      const doc = await openSettingsBackup(pendingBackup.doc, pendingSecret);
      setPendingBackup(null);
      setPendingSecret("");
      setImporting(true);
      await applyImportedBackup(doc, {});
    } catch (err) {
      // A wrong password and a damaged file are the same failure to AES-GCM; the helper's
      // sentence covers both and stays in the panel until it is answered.
      setPendingError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingBusy(false);
      setImporting(false);
    }
  };

  const applyImportedBackup = async (
    doc: unknown,
    options: { e2eePassphrase?: string },
  ) => {
    const outcome = await importSettingsBackupFromFile(doc, (message) => window.confirm(message), options);
    if (!outcome.ok) {
      if (outcome.reason === "failed") setImportError(t("onb_import_failed", outcome.error ?? ""));
      return;
    }
    // The worker already saved the imported settings. Mark setup done explicitly (a
    // backup taken mid-setup may carry false), and drop the draft with its credentials.
    await request({ type: "SAVE_SETTINGS", payload: { onboarding_completed: true } });
    draftClosed.current = true;
    clearEntryReason();
    await clearDraft().catch(() => {});
    // An imported setup may enable history/tabs/extensions that this browser has never
    // granted, and a WebDAV server whose host permission was never requested. Check the
    // settings as they stand now, with the reported origin as a belt.
    const after = await request({ type: "GET_SETTINGS" });
    const imported = after.ok && after.res.type === "SETTINGS" ? after.res.payload : null;
    // A redacted backup carries no secrets by design, so a fresh restore has no account
    // to sync with. Say which one and send the user to Settings instead of running a sync
    // that can only fail — and instead of a permission prompt for a backend not yet usable.
    const missingCredentials = await missingImportedCredentials();
    if (missingCredentials.length) {
      setImportedMissing(missingCredentials);
      setStep("imported");
      return;
    }
    const missing: { permissions: string[]; origins: string[] } = imported
      ? await missingPermissionsFor(imported)
      : { permissions: [], origins: [] };
    if (outcome.hostOrigin && !missing.origins.includes(outcome.hostOrigin)) {
      missing.origins.push(outcome.hostOrigin);
    }
    const enabled = imported?.enabled_types ?? [];
    // Nothing turned on is a valid configuration, and a sync of nothing would sit on the
    // progress screen until it timed out. The plain "restored" screen is the right end
    // for that case; anything else owes this browser a first sync (see startImportedSync).
    if (!enabled.length) {
      setStep("imported");
      return;
    }
    importedSyncPending.current = true;
    if (missing.permissions.length || missing.origins.length) {
      setMissingPerms(missing);
      setPermissionPhase("needed");
      setStep("permissions");
    } else {
      importedSyncPending.current = false;
      await startImportedSync(enabled);
    }
  };

  /** The browser only grants permissions from a user gesture, so this page — not the
   *  worker — is where the request happens. Nothing is awaited before the request. */
  const grantMissing = async () => {
    setPermBusy(true);
    setPermSlowHere(false);
    const outcome = await ensurePermissionWatched(
      {
        ...(missingPerms.permissions.length ? { permissions: missingPerms.permissions } : {}),
        ...(missingPerms.origins.length ? { origins: missingPerms.origins } : {}),
      },
      () => setPermSlowHere(true),
    );
    setPermBusy(false);
    setPermSlowHere(false);
    setPermissionPhase(outcome === "granted" ? "done" : "failed");
    // A restored backup gets its first sync on the screen where setup is finished, not a
    // "Close" button that leaves the direction question to the popup. The re-grant flow
    // (PERMISSION_MODE) never sets this flag: that install already syncs.
    if (outcome === "granted" && importedSyncPending.current) {
      importedSyncPending.current = false;
      const s = await request({ type: "GET_SETTINGS" });
      const enabled = s.ok && s.res.type === "SETTINGS" ? s.res.payload.enabled_types : undefined;
      await startImportedSync(enabled);
    }
  };

  const canProceedBackend = () => {
    if (!provider) return false;
    if (provider === "gdrive") return !!gdriveUser;
    if (provider === "github") return !!githubUser && !!githubRepo;
    if (provider === "nextcloud") return !!(ncHost && webdavUser && webdavPass);
    return !!(effectiveWebdavUrl && webdavUser && webdavPass);
  };

  /**
   * The optional permissions this setup will ask for.
   *
   * Shared by the Finish click and the notice above it, so the list a user reads before
   * pressing the button is literally the list the button requests. Two copies of this
   * logic is how a screen ends up promising fewer permissions than it takes.
   *
   * Types this browser doesn't implement are left out: asking for `history` on a browser
   * with no history API can only fail, and one unobtainable permission drags the whole
   * combined request down with it — which is how a Fennec user ended up being told their
   * WEBDAV permission was refused.
   */
  const plannedPermissions = (): string[] => {
    const out: string[] = [];
    for (const type of ["history", "sessions", "extensions"] as const) {
      if (dataTypes[type] && availability[type]?.state !== "unsupported") {
        out.push(...permissionsToEnable(type, askTabGroups));
      }
    }
    return out;
  };

  /** The WebDAV origin this setup needs, or null when the address cannot be parsed. */
  const webdavOrigin = (url: string): string | null => {
    try {
      return new URL(url).origin + "/*";
    } catch {
      return null;
    }
  };

  /** The host permission this setup will ask for. Empty for a backend that needs none. */
  const plannedOrigins = (): string[] => {
    if (backend !== "webdav") return [];
    const origin = webdavOrigin(effectiveWebdavUrl);
    return origin ? [origin] : [];
  };

  // Read once per render for the notice above Finish. Narrower than what `finish()`
  // sends on purpose: a permission already held resolves without a dialog, and listing it
  // would promise a prompt that never appears — which reads as "it ignored my click".
  const upcomingPermissions = (["history", "sessions", "extensions"] as const)
    .filter((type) => dataTypes[type] && availability[type]?.state === "needs-permission")
    .flatMap((type) => permissionsToEnable(type, askTabGroups));
  const upcomingOrigins = plannedOrigins();

  const finish = async () => {
    setSetupError(null);

    // E2EE chosen but the passphrase is empty / not confirmed — surface it (red
    // border + inline error) instead of silently doing nothing on click.
    if (passMissing || passTooShort || confirmMismatch) {
      setEncTouched(true);
      return;
    }

    // Nothing to sync. Finishing anyway saved an empty `enabled_types` and then watched
    // the first sync fail before it reached the backend, so the "all set" screen followed
    // an error the user never saw. Send them back to the step that owns the choice.
    if (!enabledTypes.length) {
      setSetupError(t("onb_err_no_types"));
      setStep("data");
      return;
    }

    // Request every optional permission this setup needs in ONE call, while we
    // still have the click's user gesture. A SECOND permissions.request() after an
    // await can be rejected for lacking a user gesture, which stranded WebDAV users
    // who also enabled an optional data type (origin request, then perms request).
    // The chosen data types (history/tabs/management) and — for WebDAV — the server
    // origin (an arbitrary host not in host_permissions) go in the same request.
    const optPerms = plannedPermissions();
    const origins = plannedOrigins();
    if (backend === "webdav" && origins.length === 0) {
      setSetupError(t("onb_err_bad_webdav_url"));
      return;
    }

    const seq = ++finishSeq.current;
    if (optPerms.length || origins.length) {
      setPermSlow(false);
      setAwaitingPerm(true);
      setSaving(true);
      const outcome = await ensurePermissionWatched(
        {
          ...(optPerms.length ? { permissions: optPerms } : {}),
          ...(origins.length ? { origins } : {}),
        },
        // Give the button back with the hint, so a press after granting the permissions
        // in the browser's settings can go through.
        () => { if (seq === finishSeq.current) { setPermSlow(true); setSaving(false); } },
      );
      if (seq !== finishSeq.current) return;
      setAwaitingPerm(false);
      setPermSlow(false);
      setSaving(false);
      if (outcome !== "granted") {
        // Two different situations, and telling them apart is the whole point. On a
        // browser that can't show the prompt at all (Firefox for Android), "please
        // allow it" is advice for a dialog that will never appear — the permission has
        // to be granted from the browser's own add-on settings instead.
        setSetupError(
          outcome === "cannot-prompt"
            ? t("onb_err_perms_no_prompt")
            : t(origins.length ? "onb_err_perms_webdav" : "onb_err_perms_types")
        );
        return;
      }
    }

    setSaving(true);
    try {
      // Never return silently here: the button reset itself, nothing was saved, and the
      // user was given no reason at all.
      const res = await request({ type: "GET_SETTINGS" });
      if (!res.ok || res.res.type !== "SETTINGS") {
        setSetupError(res.ok ? t("onb_err_read_settings") : res.error);
        return;
      }
      const current: SyncSettings = res.res.payload;

      const backends = [];
      if (backend === "gdrive") {
        // The session (incl. refresh token) was already persisted by connectGDrive.
        backends.push({ type: "gdrive" as const, label: "Google Drive", enabled: true, gdrive: {} });
      } else if (backend === "github") {
        backends.push({
          type: "github" as const, label: "GitHub", enabled: true,
          github: { token: githubToken, repo: githubRepo, branch: githubBranch.trim() || "main" },
        });
      } else if (backend === "webdav") {
        backends.push({
          type: "webdav" as const, label: "WebDAV", enabled: true,
          webdav: { url: effectiveWebdavUrl, username: webdavUser, password: webdavPass },
        });
      }

      const enabled_types = (Object.keys(dataTypes) as Array<keyof typeof dataTypes>)
        .filter((k) => dataTypes[k]) as SyncSettings["enabled_types"];

      const saved = await request({
        type: "SAVE_SETTINGS",
        payload: {
          ...current, active_backend: backend, backends, enabled_types,
          excluded_bookmarks: exclusions,
          // Blank falls back to what was detected: an unnamed device is worse than a
          // generically named one, and the field is optional by design.
          device_label: deviceLabel.trim() || current.device_label,
          encryption_enabled: encEnabled,
          encryption_passphrase: encEnabled ? encPass : undefined,
          onboarding_completed: true,
        },
      });
      if (!saved.ok) {
        setSetupError(t("onb_err_save", saved.error));
        return;
      }
      // Everything in the draft is in the settings now, the credentials included, so the
      // copy goes: a token left behind there is one the user no longer knows about.
      draftClosed.current = true;
      clearEntryReason();
      await clearDraft().catch(() => {});

      // Capture pre-sync counts, show the live progress step, then start the first
      // sync WITHOUT awaiting — the "syncing" step polls GET_STATE and moves to
      // "done" when every enabled type's count has climbed (or surfaces an error).
      // Only a baseline for the progress step — an unreadable one is not worth blocking
      // the setup over, it just means the first counts start from zero.
      const stRes = await request({ type: "GET_STATE" });
      baselineRef.current = stRes.ok && stRes.res.type === "STATE" ? { ...stRes.res.payload.sync_counts } : {};
      setSyncCounts(baselineRef.current);
      setSyncError(null);
      setSyncTimedOut(false);
      setStep("syncing");
      void sendMessage({ type: "SYNC_NOW" }).catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  /**
   * Answer the first-sync question here, then let the progress step finish.
   *
   * Applying the answer already publishes this device's bookmarks — that is why the click
   * returns only once the upload is done — so the counters climb for bookmarks by
   * themselves. Any other enabled type still needs its own pass, hence the second
   * SYNC_NOW. The baseline is left alone on purpose: it was taken before either call, so
   * every type's tick still means "this one actually moved".
   */
  const applyDirection = async () => {
    if (directionBusy) return;
    setDirectionBusy(true);
    setDirectionError(null);
    try {
      // Only on the entry that skipped `finish()`: take the pre-answer counts now. Nothing
      // is merged and no counter moves while the question is pending, so this is the same
      // number `finish()` would have recorded — it just has to exist before the answer's
      // own upload starts moving `sync_counts`.
      if (needsBaselineBeforeAnswer.current) {
        const st = await request({ type: "GET_STATE" });
        if (st.ok && st.res.type === "STATE") {
          // Only a read that succeeded is a baseline; keeping the flag on failure lets a
          // retry after a failed answer try again instead of starting from `{}`.
          needsBaselineBeforeAnswer.current = false;
          baselineRef.current = { ...st.res.payload.sync_counts };
          setSyncCounts(baselineRef.current);
        }
      }
      const sent = await request({ type: "FIRST_SYNC_CHOICE", payload: { choice: directionChoice } });
      if (!sent.ok) {
        // "Use the remote copy" can legitimately fail — an encrypted peer this device
        // cannot read, or a storage that dropped the file. Keep the question on screen
        // with the reason instead of moving on as if it had been applied.
        setDirectionError(sent.error);
        return;
      }
      setSyncError(null);
      setSyncTimedOut(false);
      setStep("syncing");
      void sendMessage({ type: "SYNC_NOW" }).catch(() => {});
    } finally {
      setDirectionBusy(false);
    }
  };

  // ─── Google OAuth ──────────────────────────────────────────────────────

  const connectGDrive = () => {
    setGdriveConnecting(true); setGdriveError(null);
    void (async () => {
      try {
        // PKCE auth-code consent → stores a refresh token (see lib/backends/gdrive-oauth).
        const s = await interactiveSignIn();
        setGdriveUser({ email: s.email, displayName: s.displayName });
      } catch (err) {
        setGdriveError(err instanceof Error ? err.message : t("onb_signin_failed"));
      } finally {
        setGdriveConnecting(false);
      }
    })();
  };

  // ─── GitHub token verify ───────────────────────────────────────────────

  /**
   * Check the token, debounced and latest-wins.
   *
   * This used to run on EVERY keystroke: no debounce, so typing a 40-character token
   * fired up to 40 requests at GitHub (each carrying a partial token), and no ordering
   * guard, so a slow response for a partial token could land after the good one and blank
   * the result — leaving "Continue" disabled with a perfectly valid token pasted in. A
   * failure also set no error state at all, so the step became a dead end with nothing on
   * screen to explain it (unlike the Drive path, which does surface its error).
   */
  const scheduleVerify = (token: string): void => {
    if (verifyTimer.current) clearTimeout(verifyTimer.current);
    setGithubError(null);
    if (token.trim().length < 10) {
      setGithubUser(null);
      setGithubChecking(false);
      return;
    }
    setGithubChecking(true);
    verifyTimer.current = setTimeout(() => { void verifyToken(token.trim()); }, 500);
  };

  const verifyToken = async (token: string) => {
    const seq = ++verifySeq.current;
    const stale = (): boolean => seq !== verifySeq.current;
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (stale()) return; // a newer keystroke already superseded this check
      if (res.ok) {
        const d = await res.json();
        setGithubUser({ login: d.login });
        setGithubError(null);
      } else {
        setGithubUser(null);
        setGithubError(
          res.status === 401
            ? t("onb_github_401")
            : t("onb_github_http", String(res.status))
        );
      }
    } catch {
      if (stale()) return;
      setGithubUser(null);
      setGithubError(t("onb_github_unreachable"));
    } finally {
      if (!stale()) setGithubChecking(false);
    }
  };

  // Don't leave a pending check to fire into an unmounted tree.
  useEffect(() => () => { if (verifyTimer.current) clearTimeout(verifyTimer.current); }, []);

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="onb-root" style={S.root}>
      <style>{CSS}</style>

      {/* One file picker for every screen that offers a backup import (welcome and the
          update permission page), so neither has to send the user into Settings. */}
      <input ref={importRef} type="file" accept="application/json,.json" style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importBackup(file);
        }} />

      {/* A backup that cannot be opened without a secret. One panel for both screens that
          import, and for both kinds of secret, because the file picker that got here is
          the same in every case. */}
      {pendingBackup && (
        <div style={S.scrim} role="dialog" aria-modal="true">
          <div className="onb-card" style={{ ...S.card, padding: 24, maxWidth: 420 }}>
            <h1 style={{ ...S.h1, fontSize: 20 }}>
              {pendingBackup.needs === "password" ? t("opt_cfg_import_pw_label") : t("opt_cfg_import_pass_label")}
            </h1>
            <p style={{ ...S.subtitle, marginBottom: 16 }}>
              {pendingBackup.needs === "password" ? t("opt_cfg_import_pw_desc") : t("opt_cfg_import_pass_desc")}
            </p>
            <div style={{ position: "relative" }}>
              <input
                style={{ ...S.input, paddingRight: 32 }} type={pendingShowSecret ? "text" : "password"} autoComplete="off" autoFocus
                placeholder={pendingBackup.needs === "password" ? t("opt_cfg_import_pw_ph") : t("opt_cfg_import_pass_ph")}
                value={pendingSecret}
                onChange={(e) => { setPendingSecret(e.target.value); setPendingError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void submitPendingBackup(); }}
              />
              <button type="button" style={S.eyeBtn} onClick={() => setPendingShowSecret((v) => !v)}
                title={t(pendingShowSecret ? "common_hide" : "common_show")}>
                {pendingShowSecret ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {pendingError && <div style={{ ...S.errorRow, marginTop: 10 }}><XCircle size={12} /> {pendingError}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              <button
                style={{ ...S.btnSecondary, flex: 1, justifyContent: "center" }}
                onClick={() => { setPendingBackup(null); setPendingSecret(""); setPendingError(null); }}
                disabled={pendingBusy}
              >
                {t("opt_cancel")}
              </button>
              <button
                style={{ ...S.btnPrimary, flex: 1 }}
                onClick={() => void submitPendingBackup()}
                disabled={pendingBusy || !pendingSecret}
              >
                {pendingBusy ? <Loader2 size={16} className="spin" /> : null} {t("opt_cfg_import_open_btn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Progress. A count and the dots, then the way out: closing the tab is how people
          leave a setup they cannot finish right now, and saying so costs one line where
          saying nothing left them reloading the page to see whether anything stuck. */}
      {SETUP_STEPS.includes(step) && (
        <div style={S.progress}>
          <span style={S.progressLabel}>
            {t("onb_step_progress", [String(SETUP_STEPS.indexOf(step) + 1), String(SETUP_STEPS.length)])}
          </span>
          <div style={S.dots} aria-hidden="true">
            {SETUP_STEPS.map((s, i) => (
              <div key={s} style={{
                ...S.dot,
                background: SETUP_STEPS.indexOf(step) >= i ? "var(--accent)" : "var(--border)",
              }} />
            ))}
          </div>
          <button type="button" style={S.laterBtn} onClick={() => window.close()}>
            {t("onb_later")}
          </button>
        </div>
      )}

      {/* ── Welcome ── */}
      {step === "welcome" && (
        <div className="onb-card" style={S.card}>
          <div style={S.logoWrap}>
            <BrandMark size={32} color="white" />
          </div>
          <h1 style={S.h1}>{t("onb_welcome_title")}</h1>
          <p style={S.subtitle}>{t("onb_welcome_subtitle")}</p>
          <div style={S.featureList}>
            {[
              ["🔒", "onb_feature_storage"],
              ["⚡", "onb_feature_instant"],
              ["🌐", "onb_feature_browsers"],
              ["📦", "onb_feature_providers"],
            ].map(([icon, key]) => (
              <div key={key} style={S.featureRow}>
                <span>{icon}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>{t(key)}</span>
              </div>
            ))}
          </div>
          {/* The device-name field used to be here as well as on the sync step. Two inputs
              for one setting read as "it didn't save", and the sync step is where the name
              has context: it is how this device shows up in the session list beside the
              data types it is sharing. It lives there only now. */}
          {/* A reinstall should not have to close the wizard and hunt through Settings. */}
          <div style={{ ...S.featureList, gap: 8, marginBottom: 20, padding: 14,
                        borderRadius: 14, border: "1px solid var(--border)" }}>
            <div style={S.backendName}>{t("onb_import_title")}</div>
            <div style={S.backendDesc}>{t("onb_import_desc")}</div>
            <button style={{ ...S.btnSecondary, width: "100%", justifyContent: "center" }}
              disabled={importing} onClick={() => importRef.current?.click()}>
              {importing && <Loader2 size={14} className="spin" />}
              {importing ? t("onb_import_busy") : t("onb_import_button")}
            </button>
            {importError && <div style={S.errorRow}><XCircle size={12} /> {importError}</div>}
          </div>
          <button style={S.btnPrimary} onClick={next}>
            {t("onb_get_started")} <ArrowRight size={16} />
          </button>
        </div>
      )}

      {/* ── Backend ── */}
      {step === "backend" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t("onb_backend_title")}</h1>
          <p style={S.subtitle}>{t("onb_backend_subtitle")}</p>

          <div style={S.backendList}>
            {providerCards(t("locale_bcp47")).map((p) => {
              const on = provider === p.id;
              // No Google sign-in here at all (Firefox for Android has no identity API): said on
              // the card itself, as the unsupported Bookmarks row is, not only once it is picked.
              const driveOff = p.id === "gdrive" && !DRIVE_AVAILABLE;
              return (
                <div
                  key={p.id}
                  style={{ ...S.backendCard, ...(on ? S.backendSelected : {}), ...(driveOff ? { opacity: 0.55 } : {}) }}
                  role="button" tabIndex={0} aria-pressed={on} aria-label={t("onb_use_provider", providerLabel(p))}
                  onClick={() => pickProvider(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickProvider(p.id); } }}
                >
                  <div style={S.backendHeader}>
                    <ProviderLogo id={p.id} size={18} color={on ? "var(--text-primary)" : "var(--text-secondary)"} />
                    <div>
                      <div style={S.backendName}>{providerLabel(p)}</div>
                      <div style={S.backendDesc}>{driveOff ? t("onb_drive_unavailable") : t(p.descKey)}</div>
                    </div>
                    <div style={{ ...S.radio, ...(on ? S.radioChecked : {}) }} />
                  </div>

                  {/* Google Drive */}
                  {on && p.id === "gdrive" && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      {gdriveUser ? (
                        <div style={S.verifiedRow}>
                          <CheckCircle2 size={14} color="var(--success)" />
                          <span style={{ color: "var(--success)", fontSize: 14 }}>
                            {gdriveUser.displayName} ({gdriveUser.email})
                          </span>
                        </div>
                      ) : !DRIVE_AVAILABLE ? (
                        <div style={S.errorRow}>
                          <XCircle size={12} /> {t("onb_drive_unavailable")}
                        </div>
                      ) : (
                        <>
                          <button style={S.btnGoogle} onClick={(e) => { e.stopPropagation(); connectGDrive(); }} disabled={gdriveConnecting}>
                            {gdriveConnecting ? <Loader2 size={14} className="spin" /> : (
                              <svg width="14" height="14" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                              </svg>
                            )}
                            {gdriveConnecting ? t("onb_connecting") : t("onb_sign_in_google")}
                          </button>
                          {gdriveError && <div style={S.errorRow}><XCircle size={12} /> {gdriveError}</div>}
                        </>
                      )}
                    </div>
                  )}

                  {/* Koofr / Fastmail / Nutstore: any preset with a fixed endpoint, keyed on
                      `fixedUrl` so a new one cannot be left without its fields again. */}
                  {on && p.fixedUrl && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      <div style={hintStyle}>{syncingTo(p.fixedUrl!)}{p.noteKey ? ` ${t(p.noteKey)}` : null}</div>
                      {webdavCreds()}
                    </div>
                  )}

                  {/* pCloud (EU/US) */}
                  {on && p.id === "pcloud" && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 6 }}>
                        {p.regions!.map((r) => {
                          const sel = pcloudRegionOf(webdavUrl) === r.id;
                          return (
                            <button key={r.id} type="button" onClick={() => setWebdavUrl(r.url)}
                              style={{ flex: 1, padding: "8px 0", borderRadius: 8, cursor: "pointer",
                                border: sel ? "1px solid var(--accent)" : "1px solid var(--border-input)",
                                background: sel ? "var(--accent-solid)" : "var(--bg-input)",
                                color: sel ? "var(--on-accent)" : "var(--text-secondary)",
                                fontFamily: "var(--font)", fontSize: 13, fontWeight: sel ? 600 : 400 }}>
                              {r.label}
                            </button>
                          );
                        })}
                      </div>
                      <div style={hintStyle}>
                        {syncingTo(webdavUrl)}{" "}
                        {p.noteKey ? t(p.noteKey, pcloudRegionLabel(p, webdavUrl)) : null}
                      </div>
                      {webdavCreds()}
                    </div>
                  )}

                  {/* Nextcloud / ownCloud (per-user host) */}
                  {on && p.id === "nextcloud" && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      <input style={S.input} placeholder="cloud.example.com" /* an example host, the same in every language */
                        value={ncHost} onChange={(e) => setNcHost(e.target.value)} />
                      {webdavCreds()}
                      <div style={hintStyle}>
                        {effectiveWebdavUrl
                          ? <>{syncingTo(effectiveWebdavUrl)} {p.noteKey ? t(p.noteKey) : null}</>
                          : p.noteKey ? t(p.noteKey) : null}
                      </div>
                    </div>
                  )}

                  {/* WebDAV (custom URL) */}
                  {on && p.id === "webdav" && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      <input style={S.input} placeholder="https://host/remote.php/dav/files/user/"
                        value={webdavUrl} onChange={(e) => setWebdavUrl(e.target.value)} />
                      {webdavCreds()}
                    </div>
                  )}

                  {/* GitHub (only — the backend is pinned to api.github.com) */}
                  {on && p.id === "github" && (
                    <div style={S.authPanel} onClick={(e) => e.stopPropagation()}>
                      <div style={{ position: "relative" }}>
                        <input
                          style={{ ...S.input, fontFamily: "monospace", paddingRight: 32 }}
                          type={showToken ? "text" : "password"}
                          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                          value={githubToken}
                          onChange={(e) => { setGithubToken(e.target.value); scheduleVerify(e.target.value); }}
                        />
                        <button style={S.eyeBtn} onClick={() => setShowToken(v => !v)}>
                          {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </div>
                      {githubChecking && (
                        <div style={S.verifyRow}><Loader2 size={12} className="spin" /> {t("onb_verifying")}</div>
                      )}
                      {githubUser && !githubChecking && (
                        <div style={{ ...S.verifyRow, color: "var(--success)" }}>
                          <CheckCircle2 size={12} /> @{githubUser.login}
                        </div>
                      )}
                      {githubError && !githubChecking && (
                        <div style={{ ...S.verifyRow, color: "var(--danger)" }} role="alert">
                          <XCircle size={12} /> {githubError}
                        </div>
                      )}
                      <input style={{ ...S.input, fontFamily: "monospace" }}
                        placeholder="username/kesonode-sync"
                        value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} />
                      <input style={{ ...S.input, fontFamily: "monospace" }}
                        placeholder={t("onb_github_branch_placeholder")}
                        value={githubBranch} onChange={(e) => setGithubBranch(e.target.value)} />
                      <a
                        href="https://github.com/settings/personal-access-tokens/new"
                        target="_blank" rel="noreferrer"
                        style={{ fontSize: 12, color: "var(--text-link)", textDecoration: "none", marginTop: 4, display: "inline-block" }}
                      >
                        {t("onb_github_token_link")}
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => { setSetupError(null); setStep("welcome"); }}>{t("common_back")}</button>
            <button
              style={{ ...S.btnPrimary, flex: 1, opacity: canProceedBackend() ? 1 : 0.45, cursor: canProceedBackend() ? "pointer" : "not-allowed" }}
              onClick={next}
              disabled={!canProceedBackend()}
            >
              {t("common_continue")} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* ── Data Types ── */}
      {step === "data" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t("onb_data_title")}</h1>
          <p style={S.subtitle}>{t("onb_data_subtitle")}</p>

          <div style={S.dataList}>
            {([
              { key: "bookmarks",  Icon: Bookmark },
              { key: "extensions", Icon: Puzzle   },
              { key: "history",    Icon: Clock    },
              { key: "sessions",   Icon: Globe    },
            ] as const).map(({ key, Icon }) => {
              const label = t(`datatype_${key}`);
              // The same description Settings shows. The wizard used to have its own,
              // terser copy, and it drifted: it promised "Last 30 days" when the limit is
              // a setting, and called sessions "tab groups", which is a Chrome feature
              // Kesonode does not sync.
              const desc = t(`datatype_${key}_desc`);
              // A type this browser has no API for. Shown rather than hidden, with the
              // reason: a row that quietly disappears reads as a missing feature, and the
              // one thing this user needs to know is that it's the browser, not Kesonode.
              const off = unavailable(key);
              return (
              <Fragment key={key}>
              <label
                style={{ ...S.dataRow, ...(off ? { opacity: 0.55, cursor: "not-allowed" } : null) }}
                role="switch"
                aria-checked={dataTypes[key]}
                aria-disabled={off}
                aria-label={label}
                tabIndex={off ? -1 : 0}
                onClick={() => toggleData(key)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleData(key); } }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Icon size={16} style={{ flexShrink: 0 }} color={dataTypes[key] ? "var(--accent)" : "var(--text-secondary)"} />
                  <div>
                    <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{label}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {off ? unsupportedReason(key) : desc}
                    </div>
                  </div>
                </div>
                {!off && (
                  <div style={{
                    ...S.toggleTrack,
                    background: dataTypes[key] ? "var(--accent)" : "var(--toggle-off)",
                  }}>
                    <div style={{
                      ...S.toggleThumb,
                      transform: dataTypes[key] ? "translateX(16px)" : "translateX(0)",
                    }} />
                  </div>
                )}
              </label>
              {/* Under Bookmarks, while it is on: the first sync is the one that would push an
                  extension's whole folder to every device, so this is the moment to say no
                  to it (#54). Outside the row's label, which toggles the type on a click. */}
              {key === "bookmarks" && !off && dataTypes.bookmarks && (
                <div style={S.excludeBox}>
                  <label style={S.excludeToggle}>
                    <input
                      type="checkbox" checked={excludeOpen}
                      style={{ margin: "2px 0 0", accentColor: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                      onChange={(e) => {
                        setExcludeOpen(e.target.checked);
                        if (!e.target.checked) setExclusions([]);
                      }}
                    />
                    <span>
                      <span style={{ display: "block", fontSize: 13, color: "var(--text-primary)" }}>{t("bm_exclude_label")}</span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--text-secondary)" }}>{t("bm_exclude_desc")}</span>
                    </span>
                  </label>
                  {excludeOpen && (
                    <div style={{ marginTop: 10 }}>
                      <BookmarkExclusionTree value={exclusions} onChange={setExclusions} />
                    </div>
                  )}
                </div>
              )}
              </Fragment>
              );
            })}
          </div>

          {/* Here rather than on a step of its own. Which types this device syncs and what
              this device is called are the same kind of setting, and the auto-detected name
              is only good enough while you have one machine: two Windows laptops both on
              Brave are both "Windows 10/11 · Brave", and then the popup's session list and
              any future device management can't tell them apart. */}
          <div style={{ marginTop: 20 }}>
            <div style={S.backendName}>{t("onb_device_name_label")}</div>
            <div style={{ ...S.backendDesc, marginBottom: 8 }}>{t("onb_device_name_desc")}</div>
            <input
              style={S.input}
              dir="auto"
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value)}
              placeholder={t("onb_device_name_placeholder")}
              aria-label={t("onb_device_name_label")}
            />
          </div>

          {!anyTypeOn && (
            <div style={{ ...S.errorRow, marginTop: 12 }}><XCircle size={12} /> {t("onb_err_no_types")}</div>
          )}
          {setupError && (
            <div style={{ ...S.errorRow, marginTop: 12, marginBottom: 12 }}><XCircle size={12} /> {setupError}</div>
          )}
          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => { setSetupError(null); setStep("backend"); }}>{t("common_back")}</button>
            <button
              style={{ ...S.btnPrimary, flex: 1, opacity: anyTypeOn ? 1 : 0.45, cursor: anyTypeOn ? "pointer" : "not-allowed" }}
              onClick={() => setStep("encrypt")}
              disabled={!anyTypeOn}
            >
              {t("common_continue")} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {step === "encrypt" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t("onb_encrypt_title")}</h1>
          <p style={S.subtitle}>{t("onb_encrypt_subtitle")}</p>

          <label
            style={{ ...S.dataRow, marginBottom: 12 }}
            role="switch"
            aria-checked={encEnabled}
            aria-label={t("common_e2ee")}
            tabIndex={0}
            onClick={() => setEncEnabled((v) => !v)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEncEnabled((v) => !v); } }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Lock size={16} color={encEnabled ? "var(--accent)" : "var(--text-secondary)"} />
              <div>
                <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{t("common_e2ee")}</div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("onb_e2ee_desc")}</div>
              </div>
            </div>
            <div style={{ ...S.toggleTrack, background: encEnabled ? "var(--accent)" : "var(--toggle-off)" }}>
              <div style={{ ...S.toggleThumb, transform: encEnabled ? "translateX(16px)" : "translateX(0)" }} />
            </div>
          </label>

          {encEnabled ? (
            <div style={{ marginBottom: 12 }}>
              <div style={{ position: "relative" }}>
                <input
                  style={{ ...S.input, width: "100%", paddingRight: 34, ...(encTouched && passMissing ? { borderColor: "var(--danger)" } : {}) }}
                  type={showEncPass ? "text" : "password"}
                  placeholder={t("onb_pass_placeholder")}
                  value={encPass}
                  onChange={(e) => setEncPass(e.target.value)}
                  aria-invalid={encTouched && passMissing}
                />
                <div style={S.inputBtnGroup}>
                  <button type="button" style={S.iconBtn} onClick={() => setShowEncPass(v => !v)} title={t(showEncPass ? "common_hide" : "common_show")}>
                    {showEncPass ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              {encTouched && passMissing && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                  {t("onb_pass_missing")}
                </div>
              )}
              {passTooShort && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                  {t("onb_pass_too_short", String(MIN_PASSPHRASE_LENGTH))}
                </div>
              )}
              {confirmNeeded && (
                <>
                  <div style={{ position: "relative", marginTop: 8 }}>
                    <input
                      style={{ ...S.input, paddingRight: 34, ...((encTouched || encConfirm.length > 0) && confirmMismatch ? { borderColor: "var(--danger)" } : {}) }}
                      type={showEncConfirm ? "text" : "password"}
                      placeholder={t("onb_pass_confirm_placeholder")}
                      value={encConfirm}
                      onChange={(e) => setEncConfirm(e.target.value)}
                      aria-invalid={(encTouched || encConfirm.length > 0) && confirmMismatch}
                    />
                    <div style={S.inputBtnGroup}>
                      <button type="button" style={S.iconBtn} onClick={() => setShowEncConfirm((v) => !v)} title={t(showEncConfirm ? "common_hide" : "common_show")}>
                        {showEncConfirm ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                  {(encTouched || encConfirm.length > 0) && confirmMismatch && (
                    <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>
                      {t(encConfirm.length === 0 ? "onb_pass_confirm_missing" : "onb_pass_mismatch")}
                    </div>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => { const k = generateRecoveryKey(); setEncPass(k); setEncGenerated(k); setEncConfirm(""); setShowEncPass(true); }}
                style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                <Key size={12} /> {t("common_generate_key")}
              </button>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
                <b>{t("onb_save_passphrase_lead")}</b> {t("onb_save_passphrase_rest")}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              {plaintextNote[0]}<b>{t("onb_plaintext_word")}</b>{plaintextNote[1]}
            </div>
          )}

          {/* Say what this button is about to ask for. The permission request fires on
              the click, so this is the last moment the user can see it coming: an
              unexplained browser dialog straight after "Finish & Sync" is how a setup
              ends with a declined permission and a data type that silently never syncs. */}
          {(upcomingPermissions.length > 0 || upcomingOrigins.length > 0) && (
            <div style={S.permPreview}>
              <div style={S.permPreviewLead}>{t("onb_perm_upcoming")}</div>
              {upcomingPermissions.map((p) => {
                const copy = describePermission(p);
                return (
                  <div key={p} style={S.permPreviewRow} title={p}>
                    <CheckCircle2 size={12} color="var(--text-secondary)" />
                    <span>{copy ? t(copy.nameKey) : p}</span>
                  </div>
                );
              })}
              {upcomingOrigins.map((o) => (
                <div key={o} style={{ ...S.permPreviewRow, alignItems: "flex-start" }} title={o}>
                  <Globe size={12} color="var(--text-secondary)" style={{ marginTop: 3, flexShrink: 0 }} />
                  <span>
                    {t("perm_host_label")}
                    <code style={S.permCode}>{o}</code>
                  </span>
                </div>
              ))}
            </div>
          )}

          {setupError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {setupError}</div>
          )}
          {permSlow && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              {t("onb_perm_prompt_slow")}
            </div>
          )}
          <div style={S.navRow}>
            <button style={S.btnSecondary} onClick={() => { finishSeq.current++; setAwaitingPerm(false); setPermSlow(false); setSaving(false); setSetupError(null); setStep("data"); }}>{t("common_back")}</button>
            <button style={{ ...S.btnPrimary, flex: 1 }} onClick={finish} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              {awaitingPerm && saving ? t("onb_waiting_permission") : saving ? t("onb_setting_up") : t("onb_finish_sync")}
            </button>
          </div>
        </div>
      )}

      {/* ── First sync: which side wins ── */}
      {step === "direction" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t("opt_first_sync_head")}</h1>
          <p style={S.subtitle}>{t("onb_direction_subtitle")}</p>

          {firstSyncPeers !== null && firstSyncPeers > 0 && (
            <div style={{ ...hintStyle, marginBottom: 12 }}>
              {plural("onb_direction_peers", firstSyncPeers, [String(firstSyncPeers)])}
            </div>
          )}

          <div style={S.backendList} role="radiogroup" aria-label={t("opt_first_sync_head")}>
            {DIRECTION_OPTIONS.map((o) => {
              const on = directionChoice === o.choice;
              return (
                <div
                  key={o.choice}
                  style={{ ...S.backendCard, ...(on ? S.backendSelected : {}) }}
                  role="radio"
                  aria-checked={on}
                  tabIndex={0}
                  onClick={() => setDirectionChoice(o.choice)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") { e.preventDefault(); setDirectionChoice(o.choice); }
                  }}
                >
                  <div style={S.backendHeader}>
                    <div>
                      <div style={S.backendName}>{t(o.label)}</div>
                      <div style={S.backendDesc}>{t(o.desc)}</div>
                    </div>
                    <div style={{ ...S.radio, ...(on ? S.radioChecked : {}) }} />
                  </div>
                </div>
              );
            })}
          </div>

          {directionError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }} role="alert">
              <XCircle size={12} /> {directionError}
            </div>
          )}

          <div style={S.navRow}>
            {/* The hint below says the window can be closed; a button that does it is
                what people actually find. Nothing has been changed yet, so leaving is
                always safe, and the popup keeps offering the question. */}
            <button style={S.btnSecondary} onClick={() => window.close()}>{t("onb_later")}</button>
            <button style={{ ...S.btnPrimary, flex: 1 }} disabled={directionBusy} onClick={() => void applyDirection()}>
              {directionBusy
                ? <><Loader2 size={16} className="spin" /> {t("opt_first_sync_busy")}</>
                : <><GitMerge size={16} /> {t("onb_direction_apply")}</>}
            </button>
          </div>
          <div style={{ ...hintStyle, marginTop: 12, textAlign: "center" }}>{t("onb_direction_hint")}</div>
        </div>
      )}

      {/* ── Syncing (live progress) ── */}
      {step === "syncing" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t(syncError ? "onb_sync_error_title" : "onb_sync_title")}</h1>
          <p style={S.subtitle}>{t(syncError ? "onb_sync_error_subtitle" : "onb_sync_subtitle")}</p>

          <div style={S.dataList}>
            {enabledTypes.map((key) => {
              const done = (syncCounts[key] ?? 0) > (baselineRef.current[key] ?? 0);
              const { Icon } = TYPE_META[key];
              return (
                <div key={key} style={{ ...S.dataRow, cursor: "default" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Icon size={16} color={done ? "var(--accent)" : "var(--text-secondary)"} />
                    <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{t(`datatype_${key}`)}</div>
                  </div>
                  {/* The count is the only evidence the user gets that anything is
                      happening: a spinner for twenty seconds on a large history is
                      indistinguishable from a hung page. Items, not syncs — "3" next to
                      Bookmarks said nothing about whether the bookmarks moved. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {(syncTotals[key] ?? 0) > 0 && (
                      <span style={S.count}>{syncTotals[key].toLocaleString()}</span>
                    )}
                    {done ? (
                      <CheckCircle2 size={16} color="var(--accent)" />
                    ) : syncError ? (
                      <XCircle size={16} color="var(--text-disabled)" />
                    ) : (
                      <Loader2 size={16} className="spin" color="var(--text-secondary)" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {syncError && (
            <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {syncError}</div>
          )}
          {syncTimedOut && !syncError && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>
              {t("onb_sync_timeout")}
            </div>
          )}

          {(syncError || syncTimedOut) && (
            <div style={S.navRow}>
              {syncError && (
                <button style={{ ...S.btnPrimary, flex: 1 }} onClick={() => browser.runtime.openOptionsPage()}>
                  {t("common_open_settings")}
                </button>
              )}
              <button
                style={syncError ? S.btnSecondary : { ...S.btnPrimary, flex: 1 }}
                onClick={() => setStep("done")}
              >
                {t(syncError ? "onb_finish_anyway" : "onb_finish")} <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Done ── */}
      {step === "done" && (
        <div className="onb-card" style={{ ...S.card, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <h1 style={S.h1}>{t("onb_done_title")}</h1>
          <p style={S.subtitle}>
            {doneNote[0]}
            <strong>{provider ? providerLabel(providerById(provider)) : configured ? activeBackendLabel(configured) : backend === "gdrive" ? "Google Drive" : backend === "github" ? "GitHub" : "WebDAV"}</strong>
            {doneNote[1]}
          </p>
          {/* What actually happened, instead of three fixed ticks that were true before
              the first byte moved. The counts are the same ones the progress step watched,
              so a type that timed out still shows what it had uploaded. */}
          {enabledTypes.length > 0 && (
            <div style={{ ...S.dataList, textAlign: "left" }}>
              <div style={S.summaryHead}>{t("onb_done_summary")}</div>
              {enabledTypes.map((key) => {
                const { Icon } = TYPE_META[key];
                return (
                  <div key={key} style={{ ...S.dataRow, cursor: "default" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <Icon size={16} color="var(--accent)" />
                      <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{t(`datatype_${key}`)}</div>
                    </div>
                    <span style={S.count}>{(syncCounts[key] ?? 0).toLocaleString()}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* A sync product whose user never installs it twice does nothing. This is the
              only screen that knows the storage they just chose, so it is the only one
              that can say "do the same thing over there". */}
          <div style={S.multiBox}>
            <div style={S.backendName}>{t("onb_done_multi_title")}</div>
            <div style={{ ...S.backendDesc, lineHeight: 1.5 }}>{t("onb_done_multi_body")}</div>
          </div>

          <button style={S.btnPrimary} onClick={() => window.close()}>
            {t("common_close")} <ArrowRight size={16} />
          </button>
          <button
            style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
            onClick={() => browser.runtime.openOptionsPage()}
          >
            {t("common_open_settings")}
          </button>
        </div>
      )}

      {/* ── After an update: re-grant permissions ── */}
      {step === "permissions" && (
        <div className="onb-card" style={S.card}>
          <h1 style={S.h1}>{t("onb_perm_title")}</h1>
          <p style={S.subtitle}>{t("onb_perm_desc")}</p>
          {permissionPhase === "checking" && (
            <div style={S.featureRow}><Loader2 size={14} className="spin" /> {t("onb_perm_checking")}</div>
          )}
          {(permissionPhase === "needed" || permissionPhase === "failed") && (
            <>
              {/* Named the way the rest of the product names them, with what each one is
                  for. The identifier is kept as a tooltip rather than deleted: it is the
                  word the browser's own settings screen shows, so it is what the user will
                  be looking for when they go to grant it by hand (the only route on a
                  browser that cannot prompt). */}
              <div style={{ ...S.featureList, marginBottom: 14 }}>
                {missingPerms.permissions.map((p) => {
                  const copy = describePermission(p);
                  return (
                    <div key={p} style={{ ...S.featureRow, alignItems: "flex-start" }} title={p}>
                      <Key size={14} color="var(--text-secondary)" style={{ marginTop: 3, flexShrink: 0 }} />
                      <div>
                        <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{copy ? t(copy.nameKey) : p}</div>
                        {copy?.purposeKey && (
                          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                            {t(copy.purposeKey)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {missingPerms.origins.map((o) => (
                  <div key={o} style={{ ...S.featureRow, alignItems: "flex-start" }} title={o}>
                    <Globe size={14} color="var(--text-secondary)" style={{ marginTop: 3, flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{t("perm_host_label")}</div>
                      <code style={S.permCode}>{o}</code>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ ...S.backendDesc, marginBottom: 16, lineHeight: 1.5 }}>{t("perm_denied_note")}</div>
              {permissionPhase === "failed" && (
                <div style={{ ...S.errorRow, marginBottom: 12 }}><XCircle size={12} /> {t("onb_perm_denied")}</div>
              )}
              {permSlowHere && <div style={S.backendDesc}>{t("onb_err_perms_no_prompt")}</div>}
              <button style={S.btnPrimary} disabled={permBusy} onClick={() => void grantMissing()}>
                {permBusy ? <Loader2 size={16} className="spin" /> : <Key size={16} />} {t("onb_perm_grant")}
              </button>
            </>
          )}
          {permissionPhase === "done" && (
            <>
              <div style={{ ...S.featureRow, marginBottom: 18 }}>
                <CheckCircle2 size={16} color="var(--success)" /> {t("onb_perm_granted")}
              </div>
              <button style={S.btnPrimary} onClick={() => window.close()}>
                {t("common_close")} <ArrowRight size={16} />
              </button>
              <button style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
                onClick={() => browser.runtime.openOptionsPage()}>{t("common_open_settings")}</button>
            </>
          )}
          {/* An update is exactly when someone may be restoring a backup: keep the same
              option on THIS first page too, instead of sending them into Settings. */}
          <button style={{ ...S.btnSecondary, marginTop: 12, width: "100%", justifyContent: "center" }}
            disabled={importing} onClick={() => importRef.current?.click()}>
            {importing && <Loader2 size={14} className="spin" />}
            {t("onb_import_button")}
          </button>
          {importError && <div style={{ ...S.errorRow, marginTop: 8 }}><XCircle size={12} /> {importError}</div>}
        </div>
      )}

      {/* ── Already set up: show what is stored, change nothing ── */}
      {step === "manage" && configured && (
        <div className="onb-card" style={S.card}>
          <div style={S.logoWrap}>
            <BrandMark size={32} color="white" />
          </div>
          <h1 style={S.h1}>{t("onb_manage_title")}</h1>
          <p style={S.subtitle}>{t("onb_manage_sub")}</p>

          <div style={{ ...S.dataList, marginBottom: 20 }}>
            <div style={{ ...S.dataRow, cursor: "default" }}>
              <span style={S.backendDesc}>{t("opt_nav_backend")}</span>
              <span style={S.manageValue}>{activeBackendLabel(configured)}</span>
            </div>
            <div style={{ ...S.dataRow, cursor: "default", alignItems: "flex-start" }}>
              <span style={S.backendDesc}>{t("opt_nav_data")}</span>
              <span style={{ ...S.manageValue, maxWidth: "62%", textAlign: "right", lineHeight: 1.5 }}>
                {configured.enabled_types.length
                  ? configured.enabled_types.map((k) => t(`datatype_${k}`)).join(" · ")
                  : "—"}
              </span>
            </div>
            <div style={{ ...S.dataRow, cursor: "default" }}>
              <span style={S.backendDesc}>{t("common_e2ee")}</span>
              <span style={S.manageValue}>
                {configured.encryption_enabled ? "AES-256-GCM" : t("opt_unencrypted")}
              </span>
            </div>
            <div style={{ ...S.dataRow, cursor: "default" }}>
              <span style={S.backendDesc}>{t("opt_nav_device")}</span>
              <span style={S.manageValue} dir="auto">{configured.device_label || "—"}</span>
            </div>
            <div style={{ ...S.dataRow, cursor: "default", alignItems: "center" }}>
              <span style={S.backendDesc}>{t("onb_manage_perms_label")}</span>
              {configuredMissing === null ? (
                <Loader2 size={14} className="spin" color="var(--text-secondary)" />
              ) : configuredMissing.permissions.length || configuredMissing.origins.length ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ ...S.manageValue, color: "var(--danger)" }}>
                    {t("onb_manage_perms_missing", String(configuredMissing.permissions.length + configuredMissing.origins.length))}
                  </span>
                  <button
                    type="button"
                    style={S.linkBtn}
                    onClick={() => {
                      setMissingPerms(configuredMissing);
                      setPermissionPhase("needed");
                      setStep("permissions");
                    }}
                  >
                    {t("onb_perm_grant")}
                  </button>
                </div>
              ) : (
                <span style={{ ...S.manageValue, color: "var(--success)" }}>
                  <CheckCircle2 size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                  {t("onb_manage_perms_ok")}
                </span>
              )}
            </div>
          </div>

          <button style={S.btnPrimary} onClick={() => browser.runtime.openOptionsPage()}>
            {t("common_open_settings")} <ArrowRight size={16} />
          </button>
          {/* The only way back into the wizard once set up. Confirmed first, because
              finishing it replaces the storage, the data types and the device name. */}
          <button
            style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
            onClick={() => {
              if (!window.confirm(t("onb_manage_reconfigure_confirm"))) return;
              // Mark the URL, so a reload halfway through the wizard comes back to the
              // wizard rather than to this page.
              try {
                const url = new URL(window.location.href);
                url.searchParams.set("reason", "reconfigure");
                window.history.replaceState(null, "", url.toString());
              } catch { /* a page that refuses replaceState still works; it just reloads to manage */ }
              setConfigured(null);
              setStep("welcome");
            }}
          >
            {t("onb_manage_reconfigure")}
          </button>
          <button style={{ ...S.linkBtn, marginTop: 12, alignSelf: "center" }} onClick={() => window.close()}>
            {t("common_close")}
          </button>
        </div>
      )}

      {/* ── Backup restored, no setup needed ── */}
      {step === "imported" && (
        <div className="onb-card" style={{ ...S.card, textAlign: "center" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h1 style={S.h1}>{t("onb_import_done_title")}</h1>
          <p style={S.subtitle}>{t("onb_import_done_desc")}</p>
          {importedMissing && importedMissing.length > 0 && (
            <div style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px",
              marginBottom: 16, textAlign: "left", fontSize: 13, color: "var(--danger)",
            }}>
              {t("opt_cfg_import_missing", importedMissing.map((b) => BACKEND_LABEL[b]).join(", "))}
            </div>
          )}
          <button style={S.btnPrimary} onClick={() => browser.runtime.openOptionsPage()}>
            {t("common_open_settings")} <ArrowRight size={16} />
          </button>
          <button style={{ ...S.btnSecondary, marginTop: 8, width: "100%", justifyContent: "center" }}
            onClick={() => window.close()}>{t("common_close")}</button>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", background: "var(--bg)",
    display: "flex", flexDirection: "column", alignItems: "center",
    fontFamily: "-apple-system, 'Google Sans', BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  progress: {
    width: "100%", maxWidth: 480,
    display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
    marginBottom: 12, padding: "0 2px",
  },
  progressLabel: { fontSize: 12, color: "var(--text-secondary)", flexShrink: 0 },
  dots: { display: "flex", gap: 6 },
  laterBtn: {
    background: "none", border: "none", padding: 0, flexShrink: 0,
    fontFamily: "inherit", fontSize: 12, color: "var(--text-secondary)",
    cursor: "pointer", textDecoration: "underline",
  },
  dot: { width: 24, height: 4, borderRadius: 2, transition: "background .2s" },
  scrim: {
    position: "fixed", inset: 0, zIndex: 50,
    background: "rgba(17, 21, 26, 0.45)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
  },
  card: {
    width: "100%", maxWidth: 480,
    background: "var(--bg-card)",
    borderRadius: 20,
    boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 12px 28px -8px rgba(17,21,26,.12), 0 0 0 1px rgba(17,21,26,.05)",
  },
  logoWrap: {
    width: 56, height: 56, borderRadius: 16,
    background: "var(--brand-tile)",
    display: "flex", alignItems: "center", justifyContent: "center",
    marginBottom: 22,
    boxShadow: "0 6px 16px -4px rgba(37,99,235,.42)",
  },
  h1: { fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text-primary)", margin: "0 0 8px" },
  subtitle: { fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 24px" },
  featureList: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 28 },
  featureRow: { display: "flex", alignItems: "center", gap: 10, textAlign: "left" },
  btnPrimary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", height: 44, padding: "0 20px", borderRadius: 14, border: "none",
    background: "var(--accent-solid)", color: "var(--on-accent)",
    fontSize: 14, fontWeight: 600, cursor: "pointer",
    fontFamily: "inherit", transition: "background .15s, box-shadow .15s",
    boxShadow: "0 1px 2px rgba(37,99,235,.30)",
  },
  btnSecondary: {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, flexShrink: 0,
    height: 44, padding: "0 18px", borderRadius: 14,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 14, fontWeight: 500, color: "var(--text-secondary)", cursor: "pointer", fontFamily: "inherit",
  },
  btnGoogle: {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    width: "100%", height: 40, padding: "0 14px", borderRadius: 12,
    border: "1px solid var(--border-input)", background: "var(--bg-card)",
    fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
    color: "var(--text-primary)",
  },
  backendList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 0 0 1px rgba(17,21,26,.07)" },
  backendCard: {
    padding: "14px 16px", cursor: "pointer",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", transition: "background .1s",
  },
  backendSelected: { background: "var(--bg-card-sel)" },
  backendHeader: { display: "flex", alignItems: "flex-start", gap: 10 },
  backendName: { fontSize: 14, fontWeight: 500, color: "var(--text-primary)", marginBottom: 2 },
  backendDesc: { fontSize: 12, color: "var(--text-secondary)" },
  radio: {
    width: 16, height: 16, borderRadius: "50%",
    border: "2px solid var(--border-input)", marginLeft: "auto", marginTop: 2, flexShrink: 0,
    background: "var(--bg-card)",
  },
  radioChecked: {
    borderColor: "var(--accent)",
    background: "radial-gradient(circle at center, var(--accent) 38%, transparent 42%)",
  },
  authPanel: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 },
  input: {
    width: "100%", padding: "10px 12px",
    background: "var(--bg-input)", border: "1px solid var(--border-input)",
    borderRadius: 12, fontSize: 14, color: "var(--text-primary)", outline: "none",
    fontFamily: "inherit",
  },
  eyeBtn: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)",
    display: "flex", alignItems: "center",
  },
  inputBtnGroup: {
    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
    display: "flex", alignItems: "center", gap: 2,
  },
  iconBtn: {
    background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)",
    display: "flex", alignItems: "center", padding: 4, borderRadius: 8,
  },
  verifiedRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 12 },
  verifyRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)" },
  errorRow: { display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--danger)" },
  dataList: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 24,
    borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 2px rgba(17,21,26,.04), 0 0 0 1px rgba(17,21,26,.07)" },
  excludeBox: {
    padding: "12px 16px 14px 44px", borderBottom: "1px solid var(--border)", background: "var(--bg-card)",
  },
  excludeToggle: { display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" },
  dataRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 16px", borderBottom: "1px solid var(--border)",
    background: "var(--bg-card)", cursor: "pointer", transition: "background .1s",
  },
  toggleTrack: { width: 34, height: 18, borderRadius: 10, position: "relative", transition: "background .2s", flexShrink: 0 },
  toggleThumb: {
    position: "absolute", top: 2, left: 2, width: 14, height: 14,
    background: "white", borderRadius: "50%", transition: "transform .18s",
    boxShadow: "0 1px 2px rgba(0,0,0,.2)",
  },
  navRow: { display: "flex", alignItems: "stretch", gap: 12, marginTop: 20 },
  // What the Finish button is about to ask the browser for, in the user's words.
  permPreview: {
    border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px",
    marginBottom: 14, display: "flex", flexDirection: "column", gap: 8,
  },
  permPreviewLead: { fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 },
  permPreviewRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-primary)" },
  permCode: {
    display: "block", fontFamily: "monospace", fontSize: 11, color: "var(--text-secondary)",
    wordBreak: "break-all", marginTop: 2,
  },
  count: { fontSize: 12, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" },
  summaryHead: {
    padding: "10px 16px", borderBottom: "1px solid var(--border)",
    fontSize: 12, color: "var(--text-secondary)",
  },
  multiBox: {
    border: "1px solid var(--border)", borderRadius: 14, padding: "14px 16px",
    marginBottom: 20, textAlign: "left",
  },
  manageValue: { fontSize: 13, color: "var(--text-primary)" },
  linkBtn: {
    background: "none", border: "none", padding: 0, fontFamily: "inherit",
    fontSize: 12, color: "var(--accent)", cursor: "pointer",
  },
};

const CSS = `
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 400; font-display: swap; src: url('/fonts/inter-400.woff2') format('woff2'); }
  @font-face { font-family: 'Inter'; font-style: normal; font-weight: 500; font-display: swap; src: url('/fonts/inter-500.woff2') format('woff2'); }
  /* Color tokens live in src/theme.css (imported by main.tsx), shared with the
     options page. */
  html, body, #root { margin: 0; padding: 0; background: var(--bg); font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  * { box-sizing: border-box; }
  /* Page and card padding live here, not in the inline styles, so the phone breakpoint
     below can actually reach them: an inline padding declaration beats any class. 36px
     inside a 360px viewport left roughly 256px for a provider card with a logo, a name,
     a description and a radio — and this wizard runs on Firefox for Android and Orion. */
  .onb-root { padding: 40px 16px 60px; }
  .onb-card { padding: 36px 36px 30px; }
  @media (max-width: 520px) {
    .onb-root { padding: 20px 12px 40px; }
    .onb-card { padding: 24px 18px 20px; border-radius: 16px; }
  }
  .spin { animation: spin .8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  button:hover { opacity: .9; }
`;
