/**
 * Settings → AI assistant.
 *
 * The feature is OPT-IN and bring-your-own-key: no endpoint is built in, nothing is sent
 * until the user fills in a URL and key, turns the switch on, and presses a button. Every
 * button that can make a request asks for the endpoint's host permission as the FIRST
 * await of its click handler — permissions.request() needs the user gesture (see #17 and
 * the bookmark dead-link check). The request itself is a plain fetch in this page, so the
 * MV3 service worker (which the browser may suspend at any moment) is never involved.
 *
 * The organisation plan is a PLAN. Nothing is written to the bookmark tree until the user
 * ticks rows and presses Apply, and Apply takes a pinned restore point first.
 */

import { useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  Sparkles,
} from "lucide-react";
import {
  aiConfigReady,
  aiOrigin,
  callModel,
  planRemovals,
  sanitizeAiBookmarks,
  suggestOrganization,
  type AiConfig,
  type AiOrganizationPlan,
} from "@/lib/ai-assistant";
import {
  applyOrganizationPlan,
  collectAiBookmarks,
  type AiBookmarkSnapshot,
} from "@/lib/ai-bookmarks";
import { aiErrorMessage, isAiCancelled } from "@/lib/ai-errors";
import type { SyncSettings } from "@/lib/types";
import { ensurePermission } from "@/lib/utils/capabilities";
import { t } from "@/lib/utils/i18n";

interface AiSectionProps {
  settings: SyncSettings;
  onChange: (partial: Partial<SyncSettings>) => void;
}

/** Must be the first await in a click handler: the browser only shows the prompt then. */
async function grantOrigin(baseUrl: string): Promise<boolean> {
  const origin = aiOrigin(baseUrl);
  if (!origin) return false;
  const outcome = await ensurePermission({ origins: [`${origin}/*`] });
  return outcome === "granted";
}

function toConfig(settings: SyncSettings): AiConfig {
  return {
    enabled: true,
    baseUrl: settings.ai_base_url ?? "",
    apiKey: settings.ai_api_key ?? "",
    model: settings.ai_model ?? "",
  };
}

function titleById(snapshot: AiBookmarkSnapshot | null, id: string): string {
  return snapshot?.bookmarks.find((b) => b.id === id)?.title ?? id;
}

export function AiSection({ settings, onChange }: AiSectionProps) {
  const [busy, setBusy] = useState<"" | "test" | "plan" | "apply">("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [plan, setPlan] = useState<AiOrganizationPlan | null>(null);
  const [snapshot, setSnapshot] = useState<AiBookmarkSnapshot | null>(null);
  const [selectedMoves, setSelectedMoves] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [keepers, setKeepers] = useState<Map<string, string>>(new Map());
  const [coverage, setCoverage] = useState<{ sent: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const enabled = settings.ai_enabled === true;
  const config = toConfig(settings);

  const onTest = async () => {
    setMessage(null);
    // Synchronous, so an unconfigured form says so before any permission prompt.
    if (!aiConfigReady(config)) {
      setMessage({ kind: "error", text: t("ai_err_config") });
      return;
    }
    setBusy("test");
    const granted = await grantOrigin(config.baseUrl);
    if (!granted) {
      setMessage({ kind: "error", text: t("ai_err_permission") });
      setBusy("");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // A one-word ping: the answer is discarded, we only need a 200 and a content field.
      await callModel(config, [{ role: "user", content: "Reply with the single word OK." }], { signal: controller.signal });
      setMessage({ kind: "ok", text: t("ai_status_ok") });
    } catch (err) {
      if (!isAiCancelled(err)) setMessage({ kind: "error", text: aiErrorMessage(err) });
    }
    abortRef.current = null;
    setBusy("");
  };

  const onPlan = async () => {
    setMessage(null);
    if (!aiConfigReady(config)) {
      setMessage({ kind: "error", text: t("ai_err_config") });
      return;
    }
    setBusy("plan");
    const granted = await grantOrigin(config.baseUrl);
    if (!granted) {
      setMessage({ kind: "error", text: t("ai_err_permission") });
      setBusy("");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const snap = await collectAiBookmarks();
      // Only the bookmarks filed directly in a root need filing: the ones already in a
      // folder were put there by hand, and asking about them is noise. It also keeps
      // the list short enough that the ceiling rarely bites.
      const loose = snap.bookmarks.filter((b) => !b.folder.includes(" / "));
      const items = sanitizeAiBookmarks(loose);
      const result = await suggestOrganization(config, items, snap.folders, { signal: controller.signal });
      setSnapshot(snap);
      setPlan(result);
      setSelectedMoves(new Set());
      setSelectedGroups(new Set());
      setKeepers(new Map());
      setCoverage(items.length < loose.length
        ? { sent: items.length, total: loose.length }
        : null);
      if (!result.moves.length && !result.duplicates.length) {
        setMessage({ kind: "ok", text: t("ai_organize_empty") });
      }
    } catch (err) {
      if (!isAiCancelled(err)) setMessage({ kind: "error", text: aiErrorMessage(err) });
    }
    abortRef.current = null;
    setBusy("");
  };

  const onApply = async () => {
    if (!plan || !snapshot) return;
    setMessage(null);
    setBusy("apply");
    const removeIds = planRemovals(plan.duplicates, selectedGroups, keepers);
    try {
      await applyOrganizationPlan(
        plan,
        { moveIds: [...selectedMoves], removeIds },
        snapshot.folderIds,
      );
      setPlan(null);
      setSnapshot(null);
      setSelectedMoves(new Set());
      setSelectedGroups(new Set());
      setKeepers(new Map());
      setCoverage(null);
      setMessage({ kind: "ok", text: t("ai_organize_applied") });
    } catch (err) {
      setMessage({ kind: "error", text: aiErrorMessage(err) });
    }
    setBusy("");
  };

  const toggleMove = (id: string) => {
    setSelectedMoves((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleGroup = (key: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectionCount = selectedMoves.size + selectedGroups.size;

  return (
    <div className="settings-section">
      <div className="settings-card-head">{t("ai_head")}</div>

      <div className="config-hint">
        <Info size={14} />
        <div>{t("ai_privacy_notice")}</div>
      </div>

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("ai_enable")}</div>
            <div className="row-desc">{t("ai_enable_desc")}</div>
          </div>
        </div>
        <label className="toggle-wrap">
          <input
            type="checkbox"
            className="toggle-input"
            checked={enabled}
            onChange={(e) => onChange({ ai_enabled: e.target.checked })}
          />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
        </label>
      </div>

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("ai_base_url")}</div>
            <div className="row-desc">{t("ai_base_url_desc")}</div>
          </div>
        </div>
        <input
          className="field-input-inline"
          dir="auto"
          type="url"
          spellCheck={false}
          value={settings.ai_base_url ?? ""}
          placeholder="https://api.deepseek.com/v1"
          onChange={(e) => onChange({ ai_base_url: e.target.value })}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("ai_api_key")}</div>
            <div className="row-desc">{t("ai_api_key_desc")}</div>
          </div>
        </div>
        <input
          className="field-input-inline mono"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={settings.ai_api_key ?? ""}
          onChange={(e) => onChange({ ai_api_key: e.target.value })}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-left">
          <div>
            <div className="row-label">{t("ai_model")}</div>
            <div className="row-desc">{t("ai_model_desc")}</div>
          </div>
        </div>
        <input
          className="field-input-inline"
          dir="auto"
          type="text"
          spellCheck={false}
          value={settings.ai_model ?? ""}
          placeholder="deepseek-chat"
          onChange={(e) => onChange({ ai_model: e.target.value })}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-left" />
        <button className="btn-secondary" onClick={onTest} disabled={busy !== ""}>
          {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t("ai_save_test")}
        </button>
        {busy === "test" && (
          <button className="btn-secondary" onClick={() => abortRef.current?.abort()}>
            {t("opt_cancel")}
          </button>
        )}
      </div>

      {message && (
        <div className={`config-hint`} style={{ color: message.kind === "error" ? "var(--danger)" : undefined }}>
          {message.kind === "error" ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
          <div>{message.text}</div>
        </div>
      )}

      <div className="settings-card-head">{t("ai_organize_section")}</div>
      <div className="config-hint">
        <Info size={14} />
        <div>{t("ai_organize_desc")}</div>
      </div>
      <div className="settings-row">
        <div className="settings-row-left" />
        <button className="btn-secondary" onClick={onPlan} disabled={busy !== "" || !enabled}>
          {busy === "plan" ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {t("ai_organize_run")}
        </button>
        {busy === "plan" && (
          <button className="btn-secondary" onClick={() => abortRef.current?.abort()}>
            {t("opt_cancel")}
          </button>
        )}
      </div>

      {coverage && (
        <div className="config-hint">
          <Info size={14} />
          <div>{t("ai_coverage_hint", [String(coverage.sent), String(coverage.total)])}</div>
        </div>
      )}

      {plan && snapshot && (
        <>
          {plan.moves.length > 0 && (
            <div className="settings-card-head">{t("ai_organize_moves")}</div>
          )}
          {plan.moves.map((m) => (
            <label key={m.id} className="settings-row" style={{ cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={selectedMoves.has(m.id)}
                onChange={() => toggleMove(m.id)}
              />
              <div className="settings-row-left">
                <div>
                  <div className="row-label">{titleById(snapshot, m.id)}</div>
                  <div className="row-desc">{m.folder}{m.reason ? ` · ${m.reason}` : ""}</div>
                </div>
              </div>
            </label>
          ))}
          {plan.duplicates.length > 0 && (
            <div className="settings-card-head">{t("ai_organize_duplicates")}</div>
          )}
          {plan.duplicates.map((g) => {
            const key = g.ids.join("|");
            const keeper = keepers.get(key) ?? g.ids[0];
            return (
              <div key={key} className="settings-row">
                <input
                  id={`ai-dup-${key}`}
                  type="checkbox"
                  checked={selectedGroups.has(key)}
                  onChange={() => toggleGroup(key)}
                />
                <label htmlFor={`ai-dup-${key}`} className="settings-row-left" style={{ cursor: "pointer" }}>
                  <div>
                    <div className="row-label">{g.ids.map((id) => titleById(snapshot, id)).join(" · ")}</div>
                    <div className="row-desc">{g.reason}</div>
                  </div>
                </label>
                <select
                  className="field-input-inline"
                  value={keeper}
                  aria-label={t("ai_organize_keep")}
                  onChange={(e) => setKeepers((prev) => new Map(prev).set(key, e.target.value))}
                >
                  {g.ids.map((id) => (
                    <option key={id} value={id}>{t("ai_organize_keep")}: {titleById(snapshot, id)}</option>
                  ))}
                </select>
              </div>
            );
          })}
          <div className="settings-row">
            <div className="settings-row-left">
              <div className="row-desc">{selectionCount}</div>
            </div>
            <button
              className="btn-secondary"
              onClick={onApply}
              disabled={busy !== "" || selectionCount === 0}
            >
              {busy === "apply" ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              {t("ai_organize_apply")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
