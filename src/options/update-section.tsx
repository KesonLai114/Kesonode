/**
 * Settings → Advanced → Software update.
 *
 * One button is the whole feature. On Chromium the first dialog is the one people expect
 * — pick the zip you downloaded. The package is verified, and on an already-bound install
 * the upgrade writes and restarts with nothing else to do. Only on the first run (or when
 * the browser dropped the folder grant) does the SAME button become the next step: choose
 * the folder Kesonode was loaded from, then everything finishes automatically. On Firefox
 * there is no `showDirectoryPicker()`, so the button hands over the companion script.
 *
 * The old shape of this section was a six-button wizard: check, download, bind, unbind,
 * import, upgrade, download script. Every one of those steps was real, but they were
 * presented as six decisions when there is only one thing a user wants to decide —
 * "do I want the new version, yes or no". Everything that is a diagnostic or a repair
 * tool now lives behind "Advanced options".
 *
 * Two platform rules shape the order here:
 *
 *  - Both dialogs need a live user gesture. `showDirectoryPicker()` throws a SecurityError
 *    without one, and Chrome will not open a file picker at the end of a long async chain.
 *    Each dialog is therefore opened SYNCHRONOUSLY in the click that asks for it.
 *  - The zip comes first. Opening the folder dialog before the package made the first run
 *    look broken: the browser's "where should this site save changes" dialog greys out
 *    every .zip, so users thought they could not pick the new version at all. The folder
 *    dialog now appears only after a package has actually been chosen and verified.
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
  type ExtractedPackage,
  type PackageTarget,
} from "@/lib/utils/upgrade-package";
import {
  ensureWritePermission,
  forgetInstallFolder,
  loadInstallFolder,
  pickInstallFolder,
  saveInstallFolder,
  supportsFolderWrite,
  type DirectoryHandleLike,
} from "@/lib/utils/install-dir";
import { applyPackageToFolder, type ApplyFailure, type ApplyProgress } from "@/lib/utils/apply-package";
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
  /** The zip picker is open (or was cancelled; pressing the button again reopens it). */
  | { kind: "wait-package" }
  /**
   * The package passed every check, but there is no writable folder yet. The main button
   * becomes the next step: one more click supplies the gesture the folder picker needs.
   * Keeping the package here means cancelling that dialog does not lose the chosen zip.
   */
  | { kind: "need-folder"; package: ExtractedPackage }
  | { kind: "busy"; progress?: ApplyProgress }
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
   * Step 1. This MUST stay synchronous: Chrome only opens a file picker while the
   * click that requested it is still active. Awaiting anything first can silently
   * leave the user looking at a button that appears to do nothing.
   */
  const startUpgrade = () => {
    if (!canWriteFolder) {
      void downloadScript();
      return;
    }
    setFlow({ kind: "wait-package" });
    fileRef.current?.click();
  };

  /**
   * Write a verified package into the bound folder, then restart the extension.
   *
   * `applyPackageToFolder` reports its progress back so the button can show a bar
   * instead of an indeterminate spinner. The callback is throttled: a release has
   * hundreds of files, and re-rendering on every single one would compete with the
   * writes we are trying to finish.
   */
  const finishInstall = async (handle: DirectoryHandleLike, pkg: ExtractedPackage) => {
    let lastReported = -1;
    const onProgress = (p: ApplyProgress) => {
      const step = Math.max(1, Math.ceil((p.total || 1) / 20));
      if (p.phase !== "cleanup" && p.done !== p.total && p.done - lastReported < step) return;
      lastReported = p.done;
      setFlow((prev) => (prev.kind === "busy" ? { kind: "busy", progress: p } : prev));
    };
    const outcome = await applyPackageToFolder(handle, pkg, onProgress);
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
    setFlow({ kind: "done", version: outcome.version ?? pkg.version });
    setTimeout(() => browser.runtime.reload(), 400);
  };

  /**
   * Step 2, first run only. Also synchronous at the call site: `showDirectoryPicker()`
   * needs the gesture from THIS click, so the promise is created here and the async
   * continuation waits for it afterwards.
   */
  const grantFolderAndInstall = () => {
    if (flow.kind !== "need-folder") return;
    const pkg = flow.package;
    const pending = pickInstallFolder();
    void (async () => {
      setFlow({ kind: "busy" });
      try {
        const handle = await pending;
        await saveInstallFolder(handle);
        setFolder({ kind: "bound", name: handle.name });
        if (!(await ensureWritePermission(handle))) {
          setFlow({ kind: "bad", message: t("opt_update_err_no_permission") });
          return;
        }
        await finishInstall(handle, pkg);
      } catch (error) {
        // Only a cancelled picker (AbortError) deserves a quiet retry. Anything else
        // is a real failure and must not be reported as "pick a folder again".
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        setFlow(
          cancelled
            ? { kind: "need-folder", package: pkg }
            : { kind: "bad", message: error instanceof Error ? error.message : String(error) }
        );
      }
    })();
  };

  /** Verify the chosen zip in one pass — no separate "import" step. */
  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file twice still fires onChange.
    event.target.value = "";
    if (!file) return;
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
      if (handle && (await ensureWritePermission(handle))) {
        await finishInstall(handle, extracted.package);
        return;
      }
      // No remembered folder, or the browser revoked the grant. Asking for a folder
      // needs a fresh gesture, so hand control back to the (same) main button.
      setFlow({ kind: "need-folder", package: extracted.package });
    } catch (error) {
      setFlow({
        kind: "bad",
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
      case "wait-package":
        return t("opt_update_wait_package");
      case "need-folder":
        return t("opt_update_wait_folder");
      case "busy":
        if (flow.progress) {
          const p = flow.progress;
          if (p.phase === "backup") return t("opt_update_phase_backup", [String(p.done), String(p.total)]);
          if (p.phase === "write") return t("opt_update_phase_write", [String(p.done), String(p.total)]);
          return t("opt_update_phase_cleanup");
        }
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
    if (flow.kind === "need-folder") return t("opt_update_pick_folder_go");
    return t("opt_update_install_go");
  };

  const primaryIcon = () => {
    if (flow.kind === "done" || (!canWriteFolder && script === "ok")) {
      return <CheckCircle2 size={14} />;
    }
    if (flow.kind === "bad") return <XCircle size={14} />;
    if (flow.kind === "need-folder") return <FolderOpen size={14} />;
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
              {flow.kind === "need-folder" && (
                <span
                  style={{
                    marginLeft: 8,
                    fontFamily: "var(--font-mono)",
                    whiteSpace: "nowrap",
                  }}
                >
                  v{flow.package.version}
                </span>
              )}
            </div>
            {flow.kind === "busy" && flow.progress && (
              <div
                style={{
                  marginTop: 8,
                  height: 6,
                  background: "var(--bg-secondary, #e6e6ef)",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.round(
                      (flow.progress.done / Math.max(1, flow.progress.total)) * 100
                    )}%`,
                    background: "var(--accent, #6c5ce7)",
                    transition: "width 120ms linear",
                  }}
                />
              </div>
            )}
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
          onClick={flow.kind === "need-folder" ? grantFolderAndInstall : startUpgrade}
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
