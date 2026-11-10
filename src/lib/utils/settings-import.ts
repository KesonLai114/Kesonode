/**
 * Importing an exported settings backup, shared by Settings and the setup wizard.
 *
 * The wizard used to offer no way in: someone reinstalling the extension had to close
 * the first-run page, find Settings → Advanced and import there. Both entry points now
 * run the SAME conversation, so a backup restored on a fresh install gets the same
 * "new device?" question, the same warnings about a changed backend or plaintext
 * credentials, and the same WebDAV host-permission check as one restored in Settings.
 *
 * The worker still validates the backup and decides what to write; this module only
 * drives the message round-trip and the questions the UI must ask first.
 */

import { request } from "@/lib/utils/messaging";
import { t } from "@/lib/utils/i18n";
import { getSettings } from "@/lib/utils/storage";
import { hasPermission } from "@/lib/utils/capabilities";

export type ImportOutcome =
  | { ok: true; hostOrigin: string | null }
  | { ok: false; reason: "cancelled" | "failed"; error?: string };

const CONFIRM_PREFIX = "IMPORT_SETTINGS_NEEDS_CONFIRM:";

const RISK_MESSAGES: Record<string, string> = {
  "disables-e2ee": "import_risk_disables_e2ee",
  "changes-backend": "import_risk_changes_backend",
  "has-credentials": "import_risk_has_credentials",
  "has-gdrive-session": "import_risk_has_gdrive_session",
};

/**
 * `parsed` is the untrusted JSON the user picked. `ask` is a synchronous confirm dialog
 * supplied by the caller, so the module stays usable from either page.
 *
 * Returns the WebDAV origin that still needs granting when there is one; the caller
 * decides how to ask for it (a click keeps the user gesture `permissions.request` needs).
 */
export async function importSettingsBackupFromFile(
  parsed: unknown,
  ask: (message: string) => boolean,
): Promise<ImportOutcome> {
  if (!ask(t("import_confirm_overwrite"))) return { ok: false, reason: "cancelled" };

  // A backup carries the SOURCE device's id and name. Copying it to another browser
  // must not make both installs write the same file and appear as one device.
  const asNewDevice = ask(t("import_confirm_new_device"));
  const send = (confirmImport: boolean) =>
    request({ type: "IMPORT_SETTINGS", payload: parsed, confirmImport, asNewDevice });

  let sent = await send(false);
  if (!sent.ok && sent.error.startsWith(CONFIRM_PREFIX)) {
    const list = sent.error.slice(CONFIRM_PREFIX.length).split(",")
      .map((code) => `· ${RISK_MESSAGES[code] ? t(RISK_MESSAGES[code]) : code}`)
      .join("\n");
    if (!ask(t("import_risk_header", list))) return { ok: false, reason: "cancelled" };
    sent = await send(true);
  }
  if (!sent.ok) return { ok: false, reason: "failed", error: sent.error };

  // An imported WebDAV backend has no host permission on a fresh install, so the next
  // sync would fail with "Failed to fetch" and no prompt. Report the exact origin.
  const cfg = await getSettings();
  const url = cfg.backends.find((b) => b.type === "webdav")?.webdav?.url;
  let hostOrigin: string | null = null;
  if (url) {
    try {
      const origin = new URL(url).origin + "/*";
      if (!(await hasPermission({ origins: [origin] }))) hostOrigin = origin;
    } catch {
      // Storage reports a malformed address; there is no permission to request for it.
    }
  }
  return { ok: true, hostOrigin };
}
