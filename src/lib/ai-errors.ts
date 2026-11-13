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
  permission: "ai_err_permission",
  network: "ai_err_request",
  http: "ai_err_request",
  timeout: "ai_err_request",
  format: "ai_err_format",
  empty: "ai_err_format",
  snapshot: "ai_err_snapshot",
};

export function aiErrorMessage(err: unknown): string {
  const code: AiErrorCode = err instanceof AiError ? err.code : "network";
  return t(AI_ERROR_KEYS[code]);
}
