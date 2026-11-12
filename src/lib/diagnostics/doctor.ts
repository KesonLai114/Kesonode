import type {
  DataType,
  DoctorCheck,
  DoctorReport,
  SyncReport,
  SyncSettings,
  SyncState,
} from "@/lib/types";
import { MIN_PASSPHRASE_LENGTH } from "@/lib/crypto/encryption";

/**
 * A plain-language health check and a copyable, redacted diagnostic bundle.
 *
 * The bundle is what a bug report actually needs: versions, backend TYPE, which permissions
 * are held, the last error, the settings that change sync behaviour. It deliberately never
 * contains a passphrase, a token, a password, a cookie, or a storage URL with credentials
 * in it — a user pasting this into an issue is the intended use, so it must be safe by
 * construction rather than by asking them to read it first.
 */

export interface DoctorInput {
  version: string;
  settings: SyncSettings;
  state: SyncState;
  availability: Record<string, { state: string; permission?: string }>;
  snapshotCount?: number;
  now?: number;
}

const SECRET_KEY = /passphrase|password|token|secret|authorization|cookie|session|api[-_]?key|refresh|username|email/i;

/**
 * Recursively replace secret-looking values, and scrub credentials out of URLs.
 *
 * Two mechanisms because they cover different leaks: key names catch structured settings
 * (`encryption_passphrase`, `github.token`), and the URL scrub catches a WebDAV address
 * that carries `user:pass@host` as one opaque string.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      url.username = url.username ? "[redacted]" : "";
      url.password = url.password ? "[redacted]" : "";
      // Query strings routinely carry tokens in WebDAV/OAuth URLs; the scheme and host are
      // what a diagnosis needs.
      url.search = url.search ? "?[redacted]" : "";
      url.hash = "";
      return url.toString();
    } catch {
      return value;
    }
  }
  return value;
}

const TEXT_URL = /https?:\/\/[^\s"'<>]+/gi;
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const INLINE_SECRET =
  /\b(access_token|refresh_token|api[-_]?key|passphrase|password|token|secret)\s*[:=]\s*[^\s,;]+/gi;

/**
 * Scrub secrets out of free text (an error message), not just out of whole URL values.
 *
 * Backend errors are prose that often embeds a URL with credentials in it, and `redact`
 * only sees a string as a URL when the WHOLE value is one. This walks the text instead:
 * every URL inside it goes through `redact`, an Authorization header is replaced, and a
 * `token=…` / `password: …` fragment is cut. Diagnostics are meant to be pasted into a
 * public issue, so the text has to be safe on its own.
 */
export function redactText(value: string): string {
  return value
    .replace(TEXT_URL, (url) => String(redact(url)))
    .replace(AUTH_HEADER, "$1 [redacted]")
    .replace(INLINE_SECRET, "$1=[redacted]");
}

/** The notice without its list of bookmark titles, which has no place in a shared bundle. */
function withoutSample<T extends object>(notice: T | null | undefined): Omit<T, "sample"> | null {
  if (!notice) return null;
  const rest = { ...notice };
  delete (rest as { sample?: unknown }).sample;
  return rest;
}

function redactReport(report: SyncReport): SyncReport {
  return {
    ...report,
    ...(report.errors ? { errors: report.errors.map(redactText) } : {}),
    types: report.types.map((row) =>
      row.preview ? { ...row, preview: { ...row.preview, sample: [] } } : row
    ),
  };
}

function check(id: string, status: DoctorCheck["status"], detail?: string): DoctorCheck {
  return detail ? { id, status, detail } : { id, status };
}

export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const { settings, state, availability } = input;
  const now = input.now ?? Date.now();
  const checks: DoctorCheck[] = [];

  const enabled = settings.enabled_types ?? [];
  const backendType = settings.active_backend;
  const backend = backendType ? settings.backends.find((b) => b.type === backendType) : undefined;

  checks.push(
    backendType
      ? check("backend-configured", backend ? "ok" : "error", backendType)
      : check("backend-configured", "error")
  );
  if (backend) {
    checks.push(check("backend-enabled", backend.enabled ? "ok" : "warn", backend.type));
  }
  checks.push(
    enabled.length
      ? check("types-enabled", "ok", enabled.join(", "))
      : check("types-enabled", "error")
  );

  for (const type of enabled) {
    const availabilityState = availability[type]?.state ?? "unknown";
    if (availabilityState === "ready") {
      checks.push(check(`permission-${type}`, "ok"));
    } else if (availabilityState === "needs-permission") {
      checks.push(check(`permission-${type}`, "error", availability[type]?.permission));
    } else {
      checks.push(check(`permission-${type}`, "info", availabilityState));
    }
  }

  if (settings.encryption_enabled) {
    const pass = settings.encryption_passphrase ?? "";
    checks.push(
      pass.length >= MIN_PASSPHRASE_LENGTH
        ? check("e2ee-passphrase", "ok")
        : check("e2ee-passphrase", "error", String(pass.length))
    );
  } else {
    checks.push(check("e2ee", "info"));
  }

  checks.push(
    state.pending_conflicts.length > 0
      ? check("conflicts", "warn", String(state.pending_conflicts.length))
      : check("conflicts", "ok")
  );
  // The error text is prose from a backend, and prose can carry a URL with credentials
  // in it. It is scrubbed once here and the same value is what the bundle shows.
  const lastError = state.last_error ? redactText(state.last_error) : null;
  checks.push(
    lastError
      ? check("last-error", "error", lastError.slice(0, 300))
      : check("last-error", "ok")
  );
  checks.push(
    (state.failed_types ?? []).length
      ? check("failed-types", "warn", (state.failed_types ?? []).join(", "))
      : check("failed-types", "ok")
  );

  const intervalMs = Math.max(60, settings.sync_interval_seconds || 60) * 1000;
  if (!state.last_sync) {
    checks.push(check("freshness", "info"));
  } else {
    const age = now - new Date(state.last_sync).getTime();
    checks.push(
      Number.isFinite(age) && age > intervalMs * 3
        ? check("freshness", "warn", String(Math.round(age / 60000)))
        : check("freshness", "ok")
    );
  }

  checks.push(
    settings.guard_enabled === false
      ? check("change-guard", "info")
      : check("change-guard", "ok", String(settings.guard_cap ?? 20))
  );
  if (input.snapshotCount !== undefined) {
    checks.push(
      input.snapshotCount > 0
        ? check("restore-points", "ok", String(input.snapshotCount))
        : check("restore-points", "info")
    );
  }
  checks.push(
    settings.device_id ? check("device-id", "ok") : check("device-id", "error")
  );

  const diagnostics = {
    generated_at: new Date(now).toISOString(),
    version: input.version,
    settings: redact(settings),
    state: redact({
      status: state.status,
      last_sync: state.last_sync,
      last_error: lastError,
      failed_types: state.failed_types,
      pending_conflicts: state.pending_conflicts.map((c) => ({
        data_type: c.data_type,
        device_id: c.device_id,
        device_label: c.device_label,
        timestamp: c.timestamp,
      })),
      sync_counts: state.sync_counts,
      sync_totals: state.sync_totals,
      bytes_transferred: state.bytes_transferred,
      // Both notices carry a `sample` of the user's bookmarks (#23); the counts and the
      // device name are what a diagnosis needs, the titles are private.
      recovery_notice: withoutSample(state.recovery_notice),
      guard_notice: withoutSample(state.guard_notice),
      sync_report: state.sync_report ? redactReport(state.sync_report) : null,
    }),
    availability,
  };

  const lines = [
    "Kesonode diagnostics",
    `version: ${input.version}`,
    `generated: ${new Date(now).toISOString()}`,
    "",
    ...checks.map((c) => `[${c.status}] ${c.id}${c.detail ? `: ${c.detail}` : ""}`),
    "",
    JSON.stringify(diagnostics, null, 2),
  ];

  return {
    generated_at: new Date(now).toISOString(),
    version: input.version,
    checks,
    text: lines.join("\n"),
  };
}

/** True when any check would stop a sync or needs the user to act. */
export function doctorNeedsAttention(report: DoctorReport): boolean {
  return report.checks.some((c) => c.status === "error" || c.status === "warn");
}

export const DOCTOR_TYPES: DataType[] = ["bookmarks", "history", "sessions", "extensions"];
