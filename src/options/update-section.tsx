/**
 * Settings → Advanced → Software update.
 *
 * A locally loaded extension cannot replace its own files, so this section never claims
 * to install anything. It does three things the browser CAN do: check the release feed on
 * demand, validate the zip the user picked, and hand them the companion script that does
 * the unpacking outside the browser. The final "load unpacked" step stays in the browser's
 * own UI — that confirmation is a browser requirement, not a missing feature here.
 */

import { useState, type ChangeEvent } from "react";
import {
  CheckCircle2,
  Download,
  FileArchive,
  RefreshCw,
  Terminal,
  XCircle,
} from "lucide-react";
import { browser, currentStore } from "@/lib/utils/ext";
import { t } from "@/lib/utils/i18n";
import {
  compareVersions,
  inspectUpgradePackage,
  type BadReason,
  type PackageTarget,
  type UpgradeInspection,
} from "@/lib/utils/upgrade-package";
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

type CheckState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; release: LatestRelease }
  | { kind: "failed" };

type InspectState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "result"; result: UpgradeInspection };

function targetLabel(target: PackageTarget): string {
  // Product names, deliberately not translated.
  return target === "firefox" ? "Firefox" : target === "chromium" ? "Chromium" : "—";
}

export function UpdateSection() {
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [inspect, setInspect] = useState<InspectState>({ kind: "idle" });
  const [script, setScript] = useState<"idle" | "ok" | "failed">("idle");

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
    const result = await inspectUpgradePackage(file, {
      currentVersion: CURRENT_VERSION,
      currentTarget: RUNNING_TARGET,
    });
    setInspect({ kind: "result", result });
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
