/**
 * Settings → Advanced → Software update.
 *
 * One button is the whole feature. On Chromium it does everything the platform allows
 * in a single press: bind the install folder the first time (the browser's own dialog),
 * let the user pick the zip they downloaded, verify it, write the new version into that
 * folder and restart the extension. On Firefox there is no `showDirectoryPicker()`, so
 * the same button hands over the companion script instead.
 *
 * The old shape of this section was a six-button wizard: check, download, bind, unbind,
 * import, upgrade, download script. Every one of those steps was real, but they were
 * presented as six decisions when there is only one thing a user wants to decide —
 * "do I want the new version, yes or no". Everything that is a diagnostic or a repair
 * tool now lives behind "Advanced options".
 *
 * Two platform rules shape the order inside `startUpgrade()`:
 *
 *  - `showDirectoryPicker()` needs a live user gesture, so the folder is resolved
 *    BEFORE any network work and before the file dialog is opened.
 *  - A plain `<input type="file">` can be clicked programmatically, so the zip dialog
 *    comes second without needing a second gesture.
 */

import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FolderOpen,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { browser, currentStore } from "@/lib/utils/ext";
import { t } from "@/lib/utils/i18n";
import {
  compareVersions,
  extractPackage,
  packageIssueKind,
  type BadReason,
  type PackageTarget,
} from "@/lib/utils/upgrade-package";
import {
  ensureWritePermission,
  forgetInstallFolder,
  loadInstallFolder,
  pickInstallFolder,
  saveInstallFolder,
  supportsFolderWrite,
} from "@/lib/utils/install-dir";
import { applyPackageToFolder, type ApplyFailure } from "@/lib/utils/apply-package";
import { KEYS } from "@/lib/utils/storage";
import { checkLatestRelease, type LatestRelease } from "@/lib/utils/release-check";

const CURRENT_VERSION = browser.runtime.getManifest().version;
const RUNNING_TARGET: PackageTarget = currentStore() === "firefox" ? "firefox" : "chromium";

/**
 * i18n.test.ts only sees keys written as literals. Naming the four reason keys here keeps
 * the runtime-built `t(BAD_REASON_KEYS[reason])` visible to that audit instead of adding
 * an exception to the test.
 */
const BAD_REASON_KEYS: Record<BadReason, string> = {
  zip: "opt_update_bad_zip",
  unsafe: "opt_update_bad_unsafe",
  browser: "opt_update_bad_browser",
  version: "opt_update_bad_version",
};

const APPLY_FAILURE_KEYS: Record<ApplyFailure, string> = {
  not_installed: "opt_update_err_not_installed",
  key_mismatch: "opt_update_err_key_mismatch",
  read: "opt_update_err_read",
  write: "opt_update_err_write",
};

/**
 * The failure to report when the code somehow produces no failure at all.
 *
 * It is a named constant rather than a literal inside the `t()` call because that call
 * is scanned for message keys, and a bare "write" in there reads as a message named
 * "write".
 */
const FALLBACK_FAILURE: ApplyFailure = "write";

/** The single action, from the press of the button to the reload. */
type FlowState =
  | { kind: "idle" }
  /** First run only: the browser is asking which folder Kesonode was loaded from. */
  | { kind: "wait-folder" }
  /** The zip picker is open (or was cancelled; pressing the button again reopens it). */
  | { kind: "wait-package" }
  | { kind: "busy" }
  | { kind: "done"; version: string }
  /** The package is sound but not newer — information, not an error. */
  | { kind: "no-change" }
  | { kind: "bad"; message: string };

type CheckState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; release: LatestRelease }
  | { kind: "failed" };

type FolderState =
  | { kind: "unsupported" }
  | { kind: "none" }
  | { kind: "bound"; name: string }
  | { kind: "picking" };

const ADVANCED_LINK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--text-link)",
  fontFamily: "var(--font)",
  fontSize: "var(--fs-xs)",
  cursor: "pointer",
};

export function UpdateSection() {
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [script, setScript] = useState<"idle" | "ok" | "failed">("idle");
  const [folder, setFolder] = useState<FolderState>({ kind: "none" });
  const [advanced, setAdvanced] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const canWriteFolder = supportsFolderWrite();

  useEffect(() => {
    if (!canWriteFolder) {
      setFolder({ kind: "unsupported" });
      return;
    }
    let cancelled = false;
    loadInstallFolder().then((handle) => {
      if (cancelled) return;
      setFolder(handle ? { kind: "bound", name: handle.name } : { kind: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFolder]);

  const runCheck = async () => {
    setCheck({ kind: "busy" });
    try {
      setCheck({ kind: "done", release: await checkLatestRelease(RUNNING_TARGET) });
    } catch {
      setCheck({ kind: "failed" });
    }
  };

  const downloadScript = async () => {
    try {
      const ua = navigator.userAgent;
      const windows = /Windows/i.test(ua);
      const mac = /Mac/i.test(ua);
      const source = windows ? "upgrade/upgrade.bat" : "upgrade/upgrade.sh";
      const filename = windows
        ? "Kesonode-upgrade.bat"
        : mac
        ? "Kesonode-upgrade.command"
        : "Kesonode-upgrade.sh";
      const response = await fetch(browser.runtime.getURL(source));
      if (!response.ok) throw new Error(`script ${response.status}`);
      const url = URL.createObjectURL(await response.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Chrome may still be starting the download when click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setScript("ok");
    } catch {
      setScript("failed");
    }
  };

  /**
   * The one click. Folder first, because the directory picker is the only step here
   * that needs a live user gesture; the zip dialog and the file writes do not.
   */
  const startUpgrade = async () => {
    if (!canWriteFolder) {
      await downloadScript();
      return;
    }
    setFlow({ kind: folder.kind === "bound" ? "wait-package" : "wait-folder" });
    try {
      let handle = await loadInstallFolder();
      if (!handle) {
        setFlow({ kind: "wait-folder" });
        handle = await pickInstallFolder();
        await saveInstallFolder(handle);
        setFolder({ kind: "bound", name: handle.name });
      }
      if (!(await ensureWritePermission(handle))) {
        setFlow({ kind: "bad", message: t("opt_update_err_no_permission") });
        return;
      }
      setFlow({ kind: "wait-package" });
      fileRef.current?.click();
    } catch {
      // The user closed the folder picker: that is a decision, not a failure. Nothing
      // has been written, so going back to idle is the whole undo.
      setFlow({ kind: "idle" });
    }
  };

  /** Verify and install the chosen zip in one pass — no separate "import" step. */
  const installFile = async (file: File) => {
    setFlow({ kind: "busy" });
    try {
      const extracted = await extractPackage(file, {
        currentVersion: CURRENT_VERSION,
        currentTarget: RUNNING_TARGET,
      });
      if (!extracted.ok) {
        setFlow(
          packageIssueKind(extracted.reason) === "no-change"
            ? { kind: "no-change" }
            : {
                kind: "bad",
                message: t("opt_update_package_bad", t(BAD_REASON_KEYS[extracted.reason])),
              }
        );
        return;
      }
      const handle = await loadInstallFolder();
      if (!handle) {
        setFlow({ kind: "bad", message: t("opt_update_err_no_folder") });
        return;
      }
      const outcome = await applyPackageToFolder(handle, extracted.package);
      if (!outcome.ok) {
        setFlow({
          kind: "bad",
          message: t(APPLY_FAILURE_KEYS[outcome.failure ?? FALLBACK_FAILURE]),
        });
        return;
      }
      // The extension is about to restart, and this page goes with it. The flag tells
      // the service worker to open the settings page again, so the user lands on the
      // new version instead of on nothing.
      await browser.storage.local.set({ [KEYS.UPGRADE_PENDING]: true });
      setFlow({ kind: "done", version: outcome.version ?? extracted.package.version });
      setTimeout(() => browser.runtime.reload(), 400);
    } catch (error) {
      setFlow({
        kind: "bad",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file twice still fires onChange.
    event.target.value = "";
    if (!file) return;
    await installFile(file);
  };

  const bindFolder = async () => {
    setFolder({ kind: "picking" });
    try {
      const handle = await pickInstallFolder();
      await saveInstallFolder(handle);
      setFolder({ kind: "bound", name: handle.name });
    } catch {
      setFolder({ kind: "none" });
    }
  };

  const unbindFolder = async () => {
    await forgetInstallFolder();
    setFolder({ kind: "none" });
  };

  const statusText = (): string => {
    switch (flow.kind) {
      case "wait-folder":
        return t("opt_update_wait_folder");
      case "wait-package":
        return t("opt_update_wait_package");
      case "busy":
        return t("opt_update_install_busy");
      case "done":
        return t("opt_update_install_done", flow.version);
      case "no-change":
        return t("opt_update_bad_version");
      case "bad":
        return flow.message;
      default:
        if (!canWriteFolder) {
          return script === "failed" ? t("opt_update_failed") : t("opt_update_dir_unsupported");
        }
        return t("opt_update_package_desc");
    }
  };

  const statusColor = (): string | undefined => {
    if (flow.kind === "bad") return "var(--danger)";
    if (flow.kind === "done") return "var(--accent)";
    return undefined;
  };

  const primaryLabel = (): string => {
    if (!canWriteFolder) return t("opt_update_script_download");
    if (flow.kind === "busy") return t("opt_update_install_busy");
    return t("opt_update_install_go");
  };

  const primaryIcon = () => {
    if (flow.kind === "done" || (!canWriteFolder && script === "ok")) {
      return <CheckCircle2 size={14} />;
    }
    if (flow.kind === "bad") return <XCircle size={14} />;
    return canWriteFolder ? <RefreshCw size={14} /> : <Download size={14} />;
  };

  const checkDescription = () => {
    if (check.kind === "failed") return t("opt_update_check_unavailable");
    if (check.kind === "done") {
      return compareVersions(check.release.version, CURRENT_VERSION) > 0
        ? t("opt_update_available", check.release.version)
        : t("opt_update_up_to_date", check.release.version);
    }
    return t("opt_update_check_desc");
  };

  const folderDescription = () => {
    if (folder.kind === "unsupported") return t("opt_update_dir_unsupported");
    if (folder.kind === "picking") return t("opt_update_dir_picking");
    if (folder.kind === "bound") return t("opt_update_dir_bound", folder.name);
    return t("opt_update_dir_none");
  };

  const newerRelease =
    check.kind === "done" && compareVersions(check.release.version, CURRENT_VERSION) > 0
      ? check.release
      : null;

  return (
    <div className="settings-section">
      <div className="settings-card-head">
        {t("opt_update_section")}
        <span className="head-sub">{t("opt_update_section_sub")}</span>
      </div>

      {/* The whole feature: one button, and one status line that explains it. */}
      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">
              {t("opt_update_install_label")}
              <span
                style={{
                  marginLeft: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-xs)",
                  fontWeight: 400,
                  color: "var(--text-secondary)",
                }}
              >
                v{CURRENT_VERSION}
              </span>
            </div>
            <div className="row-desc" style={{ color: statusColor() }}>
              {statusText()}
            </div>
            <div className="row-desc" style={{ marginTop: 10 }}>
              <button
                type="button"
                style={ADVANCED_LINK}
                onClick={() => setAdvanced(!advanced)}
                aria-expanded={advanced}
              >
                {advanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {t("opt_update_advanced")}
              </button>
            </div>
          </div>
        </div>
        <button
          className="btn-save"
          onClick={startUpgrade}
          disabled={flow.kind === "busy"}
        >
          {primaryIcon()}
          {primaryLabel()}
        </button>
      </div>

      {/* Diagnostics and repair tools. They are real, but they are not the upgrade. */}
      {advanced && (
        <>
          <div className="settings-row">
            <div className="settings-row-left">
              <div>
                <div className="row-label">{t("opt_update_check_label")}</div>
                <div className="row-desc">{checkDescription()}</div>
              </div>
            </div>
            <button
              className="btn-secondary"
              onClick={runCheck}
              disabled={check.kind === "busy"}
            >
              <RefreshCw size={12} />
              {check.kind === "busy" ? t("opt_update_checking") : t("opt_update_check")}
            </button>
          </div>

          {newerRelease && (
            <div className="settings-row">
              <div className="settings-row-left">
                <div>
                  <div className="row-label">
                    {newerRelease.assetName ?? t("opt_update_download")}
                  </div>
                  <div className="row-desc">{newerRelease.pageUrl}</div>
                </div>
              </div>
              <a
                className="btn-secondary"
                href={newerRelease.downloadUrl ?? newerRelease.pageUrl}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={12} /> {t("opt_update_download")}
              </a>
            </div>
          )}

          {canWriteFolder && (
            <div className="settings-row">
              <div className="settings-row-left">
                <div>
                  <div className="row-label">{t("opt_update_dir_label")}</div>
                  <div className="row-desc">{folderDescription()}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {folder.kind === "bound" && (
                  <button className="btn-secondary" onClick={unbindFolder}>
                    {t("opt_update_dir_unbind")}
                  </button>
                )}
                <button
                  className="btn-secondary"
                  onClick={bindFolder}
                  disabled={folder.kind === "picking"}
                >
                  <FolderOpen size={12} />
                  {folder.kind === "bound"
                    ? t("opt_update_dir_rebind")
                    : t("opt_update_dir_pick")}
                </button>
              </div>
            </div>
          )}

          <div className="settings-row">
            <div className="settings-row-left">
              <div>
                <div className="row-label">{t("opt_update_script_label")}</div>
                <div className="row-desc">
                  {script === "failed" ? t("opt_update_failed") : t("opt_update_script_desc")}
                </div>
              </div>
            </div>
            <button className="btn-secondary" onClick={downloadScript}>
              {script === "ok" ? <CheckCircle2 size={12} /> : <Terminal size={12} />}
              {t("opt_update_script_download")}
            </button>
          </div>

          <div
            className="settings-row"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className="row-desc" style={{ whiteSpace: "pre-line" }}>
              {t("opt_update_steps")}
            </div>
          </div>
        </>
      )}

      {/* One hidden input, always mounted: the main button clicks it programmatically. */}
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        style={{ display: "none" }}
        onChange={onFileChange}
      />
    </div>
  );
}
