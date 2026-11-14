/**
 * One place to turn an AI failure into a user-facing sentence.
 *
 * The AI module throws CODES, never provider messages: an error body can echo the prompt,
 * the API key or account details, and must not be put on screen or into a log.
 * i18n.test.ts only sees keys written as literals, so the runtime lookup is spelled out
 * here rather than hidden behind a template string.
 */

import { AiError, type AiErrorCode } from "@/lib/ai-assistant";
import { t } from "@/lib/utils/i18n";

const AI_ERROR_KEYS: Record<AiErrorCode, string> = {
  disabled: "ai_err_config",
  config: "ai_err_config",
  endpoint_scheme: "ai_err_endpoint_scheme",
  endpoint_credentials: "ai_err_endpoint_credentials",
  permission: "ai_err_permission",
  network: "ai_err_request",
  http: "ai_err_request",
  auth: "ai_err_auth",
  notfound: "ai_err_notfound",
  rate: "ai_err_rate",
  provider: "ai_err_provider",
  timeout: "ai_err_request",
  cancelled: "ai_err_cancelled",
  format: "ai_err_format",
  empty: "ai_err_format",
  snapshot: "ai_err_snapshot",
};

export function aiErrorMessage(err: unknown): string {
  const code: AiErrorCode = err instanceof AiError ? err.code : "network";
  return t(AI_ERROR_KEYS[code]);
}

/** A user cancel is not a failure: callers clear the spinner and show nothing. */
export function isAiCancelled(err: unknown): boolean {
  return err instanceof AiError && err.code === "cancelled";
}
