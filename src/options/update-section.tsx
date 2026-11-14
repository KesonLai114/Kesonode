/**
 * Settings → Advanced → Software update.
 *
 * A locally loaded extension cannot replace its own code on its own — the package
 * directory is read-only and MV3 forbids executing code that isn't part of the package.
 * What it CAN do, on Chromium, is ask the user for permission to write to the folder it
 * was loaded from, and then put the new version there and reload itself. That is the
 * one-click upgrade, and it is what this section is built around.
 *
 * On Firefox there is no `showDirectoryPicker()`, so the browser can never grant that
 * permission. There the section falls back to what it always did: check the release
 * feed, validate the zip, and hand over the companion script that unpacks outside the
 * browser. The final "load unpacked" step stays in the browser's own UI — that
 * confirmation is a browser requirement, not a missing feature here.
 */

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  CheckCircle2,
  Download,
  FileArchive,
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
  inspectUpgradePackage,
  type BadReason,
  type PackageTarget,
  type UpgradeInspection,
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

type CheckState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; release: LatestRelease }
  | { kind: "failed" };

type InspectState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: UpgradeInspection };

type FolderState =
  | { kind: "unsupported" }
  | { kind: "none" }
  | { kind: "bound"; name: string }
  | { kind: "picking" };

type InstallState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; version: string }
  | { kind: "failed"; reason: string };

function targetLabel(target: PackageTarget): string {
  // Product names, deliberately not translated.
  return target === "firefox" ? "Firefox" : target === "chromium" ? "Chromium" : "—";
}

export function UpdateSection() {
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [inspect, setInspect] = useState<InspectState>({ kind: "idle" });
  const [script, setScript] = useState<"idle" | "ok" | "failed">("idle");
  const [folder, setFolder] = useState<FolderState>({ kind: "none" });
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  /** The file the user picked, kept so the upgrade can read it again when it runs. */
  const [packageFile, setPackageFile] = useState<File | null>(null);

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

  const pickPackage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the input so picking the same file twice still fires onChange.
    event.target.value = "";
    if (!file) return;
    setInspect({ kind: "busy" });
    setPackageFile(file);
    const result = await inspectUpgradePackage(file, {
      currentVersion: CURRENT_VERSION,
      currentTarget: RUNNING_TARGET,
    });
    setInspect({ kind: "result", result });
  };

  const bindFolder = async () => {
    setFolder({ kind: "picking" });
    try {
      const handle = await pickInstallFolder();
      await saveInstallFolder(handle);
      setFolder({ kind: "bound", name: handle.name });
    } catch {
      // The user closed the picker: that is a decision, not a failure to report.
      setFolder({ kind: "none" });
    }
  };

  const unbindFolder = async () => {
    await forgetInstallFolder();
    setFolder({ kind: "none" });
  };

  const runInstall = useCallback(async () => {
    if (!packageFile) return;
    setInstall({ kind: "busy" });
    try {
      const handle = await loadInstallFolder();
      if (!handle) {
        setInstall({ kind: "failed", reason: t("opt_update_err_no_folder") });
        return;
      }
      if (!(await ensureWritePermission(handle))) {
        setInstall({ kind: "failed", reason: t("opt_update_err_no_permission") });
        return;
      }
      const extracted = await extractPackage(packageFile, {
        currentVersion: CURRENT_VERSION,
        currentTarget: RUNNING_TARGET,
      });
      if (!extracted.ok) {
        setInstall({ kind: "failed", reason: t(BAD_REASON_KEYS[extracted.reason]) });
        return;
      }
      const outcome = await applyPackageToFolder(handle, extracted.package);
      if (!outcome.ok) {
        setInstall({
          kind: "failed",
          reason: t(APPLY_FAILURE_KEYS[outcome.failure ?? FALLBACK_FAILURE]),
        });
        return;
      }
      // The extension is about to restart, and this page goes with it. The flag tells
      // the service worker to open the settings page again, so the user lands on the
      // new version instead of on nothing.
      await browser.storage.local.set({ [KEYS.UPGRADE_PENDING]: true });
      setInstall({ kind: "done", version: outcome.version ?? extracted.package.version });
      setTimeout(() => browser.runtime.reload(), 400);
    } catch (error) {
      setInstall({
        kind: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }, [packageFile]);

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

  const checkDescription = () => {
    if (check.kind === "failed") return t("opt_update_failed");
    if (check.kind === "done") {
      return compareVersions(check.release.version, CURRENT_VERSION) > 0
        ? t("opt_update_available", check.release.version)
        : t("opt_update_up_to_date", check.release.version);
    }
    return t("opt_update_check_desc");
  };

  const packageDescription = () => {
    if (inspect.kind === "idle") return t("opt_update_package_desc");
    if (inspect.kind === "busy") return t("opt_update_checking");
    if (!inspect.result.ok) {
      return t("opt_update_package_bad", t(BAD_REASON_KEYS[inspect.result.reason]));
    }
    return t("opt_update_package_ok", [
      inspect.result.version,
      targetLabel(inspect.result.target),
      String(inspect.result.entries),
    ]);
  };

  const folderDescription = () => {
    if (folder.kind === "unsupported") return t("opt_update_dir_unsupported");
    if (folder.kind === "picking") return t("opt_update_dir_picking");
    if (folder.kind === "bound") return t("opt_update_dir_bound", folder.name);
    return t("opt_update_dir_none");
  };

  const installDescription = () => {
    if (install.kind === "done") return t("opt_update_install_done", install.version);
    if (install.kind === "failed") return install.reason;
    if (install.kind === "busy") return t("opt_update_install_busy");
    if (!packageFile) return t("opt_update_install_need_pkg");
    if (folder.kind !== "bound") return t("opt_update_install_need_dir");
    return t("opt_update_install_desc");
  };

  const newerRelease =
    check.kind === "done" && compareVersions(check.release.version, CURRENT_VERSION) > 0
      ? check.release
      : null;

  const packageReady =
    inspect.kind === "result" && inspect.result.ok && packageFile !== null;
  const canInstall = packageReady && folder.kind === "bound" && install.kind !== "busy";

  return (
    <div className="settings-section">
      <div className="settings-card-head">
        {t("opt_update_section")}
        <span className="head-sub">{t("opt_update_section_sub")}</span>
      </div>

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("opt_update_check_label")}</div>
            <div className="row-desc">{checkDescription()}</div>
          </div>
        </div>
        <button className="btn-secondary" onClick={runCheck} disabled={check.kind === "busy"}>
          <RefreshCw size={12} />
          {check.kind === "busy" ? t("opt_update_checking") : t("opt_update_check")}
        </button>
      </div>

      {newerRelease && (
        <div className="settings-row">
          <div className="settings-row-left">
            <div>
              <div className="row-label">{newerRelease.assetName ?? t("opt_update_download")}</div>
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
        <>
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
                {folder.kind === "bound" ? t("opt_update_dir_rebind") : t("opt_update_dir_pick")}
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-left">
              <div>
                <div className="row-label">{t("opt_update_install_label")}</div>
                <div className="row-desc">{installDescription()}</div>
              </div>
            </div>
            <button className="btn-secondary" onClick={runInstall} disabled={!canInstall}>
              {install.kind === "done" ? (
                <CheckCircle2 size={12} />
              ) : install.kind === "failed" ? (
                <XCircle size={12} />
              ) : (
                <RefreshCw size={12} />
              )}
              {install.kind === "busy" ? t("opt_update_install_busy") : t("opt_update_install_go")}
            </button>
          </div>
        </>
      )}

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("opt_update_package_label")}</div>
            <div className="row-desc">{packageDescription()}</div>
          </div>
        </div>
        <label className="btn-secondary" style={{ cursor: "pointer" }}>
          {inspect.kind === "result" && inspect.result.ok ? (
            <><CheckCircle2 size={12} /> {t("opt_update_package_pick")}</>
          ) : inspect.kind === "result" ? (
            <><XCircle size={12} /> {t("opt_update_package_pick")}</>
          ) : (
            <><FileArchive size={12} /> {t("opt_update_package_pick")}</>
          )}
          <input
            type="file"
            accept=".zip,application/zip"
            style={{ display: "none" }}
            onChange={pickPackage}
          />
        </label>
      </div>

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

      {/* Always visible: a user who downloads the script without importing the zip first
          still needs to know what the browser will ask them to do. */}
      <div className="settings-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div className="row-desc" style={{ whiteSpace: "pre-line" }}>
          {t("opt_update_steps")}
        </div>
      </div>
    </div>
  );
}
