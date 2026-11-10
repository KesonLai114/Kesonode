import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { FirstSyncChoice } from "@/lib/types";
import { request } from "@/lib/utils/messaging";
import { t } from "@/lib/utils/i18n";

/**
 * Settings → Activity: which side wins when a device that already has bookmarks first
 * joins a sync group that also has some.
 *
 * Shown even when nothing is pending, because it is also the manual "choose the sync
 * direction again" entry point: a device restored from a config backup, or one that
 * drifted apart after a storage outage, should not have to wait for another first sync.
 * The three answers are the same ones the popup offers during a pending first sync.
 */
export function FirstSyncSection({ pending, onResolved }: {
  pending: boolean;
  /** Re-read the state once an answer went through, so a pending banner goes away. */
  onResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<FirstSyncChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (choice: FirstSyncChoice) => {
    if (busy) return;
    setBusy(choice);
    setError(null);
    try {
      const sent = await request({ type: "FIRST_SYNC_CHOICE", payload: { choice } });
      // "Use the remote copy" can legitimately fail: an encrypted peer we cannot read,
      // or a storage that dropped the file. Leaving that on the card is the whole point.
      if (!sent.ok) setError(sent.error);
      await onResolved();
    } finally {
      setBusy(null);
    }
  };

  const options: Array<{ choice: FirstSyncChoice; label: string; desc: string }> = [
    { choice: "merge", label: t("opt_first_sync_merge"), desc: t("opt_first_sync_merge_desc") },
    { choice: "remote", label: t("opt_first_sync_remote"), desc: t("opt_first_sync_remote_desc") },
    { choice: "local", label: t("opt_first_sync_local"), desc: t("opt_first_sync_local_desc") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-card-head">
        {t("opt_first_sync_head")}
        <span className="head-sub">{t("opt_first_sync_head_sub")}</span>
      </div>
      {pending && (
        <div className="settings-row">
          <div className="settings-row-left">
            <div className="row-desc">{t("opt_first_sync_pending")}</div>
          </div>
        </div>
      )}
      {options.map((o) => (
        <div key={o.choice} className="settings-row">
          <div className="settings-row-left">
            <div className="row-label">{o.label}</div>
            <div className="row-desc">{o.desc}</div>
          </div>
          <button
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() => void choose(o.choice)}
          >
            {busy === o.choice && <Loader2 size={12} className="spin" />}
            {busy === o.choice ? t("opt_first_sync_busy") : o.label}
          </button>
        </div>
      ))}
      {error && (
        <div className="error-row" role="alert"><AlertTriangle size={12} /> {error}</div>
      )}
    </div>
  );
}
