/**
 * Popup AI panel: natural-language bookmark search (P0) plus two one-tap explanations
 * of the sync receipt / pending conflicts (P2). All three use the same request helper.
 *
 * The local substring search above stays untouched and is always available; this panel is
 * an optional extra that is hidden when the feature is off. A failed AI call never changes
 * any bookmark and never replaces the local results.
 */

import { useRef, useState } from "react";
import { AlertCircle, Loader2, Sparkles, X } from "lucide-react";
import {
  aiConfigReady,
  aiOrigin,
  askBookmarks,
  candidatePool,
  CANDIDATE_BATCH,
  explainSync,
  MAX_BATCHES,
  syncExplanationContext,
  toAiBookmarks,
  type AiConfig,
  type AiSearchAnswer,
} from "@/lib/ai-assistant";
import { collectAiBookmarks } from "@/lib/ai-bookmarks";
import { aiErrorMessage, isAiCancelled } from "@/lib/ai-errors";
import type { FlatBookmark } from "@/lib/handlers/reading-list-handler";
import type { SyncSettings, SyncState } from "@/lib/types";
import { ensurePermission } from "@/lib/utils/capabilities";
import { t } from "@/lib/utils/i18n";

interface AiPanelProps {
  settings: SyncSettings;
  state: SyncState | null;
  onOpen: (url: string) => void;
}

/** Must be the first await in a click handler: permissions.request() needs the gesture. */
async function grantOrigin(baseUrl: string): Promise<boolean> {
  const origin = aiOrigin(baseUrl);
  if (!origin) return false;
  const outcome = await ensurePermission({ origins: [`${origin}/*`] });
  return outcome === "granted";
}

function configOf(settings: SyncSettings): AiConfig {
  return {
    enabled: true,
    baseUrl: settings.ai_base_url ?? "",
    apiKey: settings.ai_api_key ?? "",
    model: settings.ai_model ?? "",
  };
}

export function AiPanel({ settings, state, onOpen }: AiPanelProps) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<AiSearchAnswer | null>(null);
  const [hits, setHits] = useState<FlatBookmark[]>([]);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<{ sent: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (settings.ai_enabled !== true) {
    // Nothing at all: the feature is off by default, and a line of text in every popup
    // for every user is noise, not information. Settings → AI assistant is where it
    // belongs, and the popup grows the panel the moment the switch is on.
    return null;
  }

  const run = async (kind: "ask" | "receipt" | "conflict") => {
    if (busy) return;
    setError(null);
    const config = configOf(settings);
    // Synchronous, so an unconfigured form says so before any permission prompt.
    if (!aiConfigReady(config)) {
      setError(t("ai_err_config"));
      return;
    }
    // The FIRST await of the click handler, before any bookmark read or storage access.
    const granted = await grantOrigin(settings.ai_base_url ?? "");
    if (!granted) {
      setError(t("ai_err_permission"));
      return;
    }
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (kind === "ask") {
        const snap = await collectAiBookmarks();
        // The candidates are chosen ON THIS DEVICE: what the question literally matches,
        // plus the most recently added bookmarks. Shipping the whole tree would be both
        // expensive and a much larger disclosure than the question needs — and a hard
        // cut to "the newest N" would exclude everything filed deeper.
        const pool = candidatePool(
          question,
          toAiBookmarks(snap.bookmarks),
          CANDIDATE_BATCH * MAX_BATCHES,
        );
        const result = await askBookmarks(config, question, pool, { signal: controller.signal });
        setAnswer(result);
        setHits(snap.bookmarks.filter((b) => result.ids.includes(b.id)));
        setExplanation(null);
        setCoverage(pool.length < snap.bookmarks.length
          ? { sent: pool.length, total: snap.bookmarks.length }
          : null);
      } else {
        const text = syncExplanationContext(state, kind);
        if (!text) {
          setError(t("ai_popup_no_report"));
          setBusy(false);
          abortRef.current = null;
          return;
        }
        const line = await explainSync(config, text, { signal: controller.signal });
        setExplanation(line);
        setAnswer(null);
        setHits([]);
        setCoverage(null);
      }
    } catch (err) {
      if (!isAiCancelled(err)) setError(aiErrorMessage(err));
    }
    abortRef.current = null;
    setBusy(false);
  };

  const clear = () => {
    setAnswer(null);
    setHits([]);
    setExplanation(null);
    setError(null);
    setCoverage(null);
  };

  return (
    <section className="mt-3">
      <div className="flex items-center gap-2 rounded-box border border-sk-hairline bg-sk-raised px-2.5 py-1.5">
        <Sparkles size={14} className="shrink-0 text-sk-subtle" />
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !busy && question.trim()) void run("ask"); }}
          placeholder={t("ai_popup_placeholder")}
          aria-label={t("ai_popup_placeholder")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-sk-text placeholder:text-sk-subtle focus:outline-none"
        />
        {busy && <Loader2 size={12} className="shrink-0 animate-spin text-sk-subtle" />}
        {busy && (
          <button
            onClick={() => abortRef.current?.abort()}
            aria-label={t("opt_cancel")}
            className="shrink-0 p-0.5 text-sk-subtle"
          >
            <X size={12} />
          </button>
        )}
        {!busy && (answer || explanation || error) && (
          <button onClick={clear} aria-label={t("popup_search_clear")} className="shrink-0 p-0.5 text-sk-subtle">
            <X size={12} />
          </button>
        )}
        <button
          onClick={() => void run("ask")}
          disabled={busy || !question.trim()}
          className="shrink-0 rounded-box border border-sk-hairline px-2 py-0.5 text-[12px] text-sk-muted disabled:opacity-60"
        >
          {t("ai_popup_ask")}
        </button>
      </div>

      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 px-1 text-[12px] text-sk-danger">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}

      {answer && (
        <div className="mt-1.5 space-y-0.5">
          <p className="px-1 py-1 text-[12px] text-sk-muted">{answer.explanation}</p>
          {coverage && (
            <p className="px-1 text-[11px] text-sk-subtle">
              {t("ai_coverage_hint", [String(coverage.sent), String(coverage.total)])}
            </p>
          )}
          {hits.length === 0 && (
            <p className="px-1 py-1 text-[12px] text-sk-subtle">{t("ai_popup_empty")}</p>
          )}
          {hits.map((hit) => (
            <button
              key={hit.id}
              onClick={() => onOpen(hit.url)}
              title={hit.url}
              className="flex w-full items-start gap-2 rounded-box px-1 py-1 text-left transition-colors hover:bg-sk-raised"
            >
              <span className="mt-0.5 shrink-0 rounded-sm border border-sk-hairline px-1 font-mono text-[10px] uppercase text-sk-subtle">
                AI
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-sk-text">{hit.title || hit.url}</span>
                <span className="block truncate text-[11px] text-sk-subtle">{hit.folder}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {explanation && (
        <p className="mt-1.5 rounded-box border border-sk-hairline bg-sk-raised px-2 py-1.5 text-[12px] leading-relaxed text-sk-text">
          {explanation}
        </p>
      )}

      <div className="mt-1.5 flex items-center gap-2 px-1">
        <button
          onClick={() => void run("receipt")}
          disabled={busy || !state?.sync_report}
          className="text-[12px] text-sk-subtle underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t("ai_popup_explain")}
        </button>
        <span className="text-[12px] text-sk-subtle">·</span>
        <button
          onClick={() => void run("conflict")}
          disabled={busy || !(state?.pending_conflicts?.length ?? 0)}
          className="text-[12px] text-sk-subtle underline-offset-2 hover:underline disabled:opacity-50"
        >
          {t("ai_popup_conflict")}
        </button>
      </div>
    </section>
  );
}
