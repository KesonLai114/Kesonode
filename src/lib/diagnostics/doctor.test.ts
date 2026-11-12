import { describe, it, expect } from "vitest";
import { buildDoctorReport, doctorNeedsAttention, redact, redactText } from "@/lib/diagnostics/doctor";
import { DEFAULT_SETTINGS } from "@/lib/utils/storage";
import type { SyncReport, SyncSettings, SyncState } from "@/lib/types";

function settings(over: Partial<SyncSettings> = {}): SyncSettings {
  return {
    ...DEFAULT_SETTINGS,
    device_id: "dev-1",
    active_backend: "github",
    enabled_types: ["bookmarks"],
    backends: [{ type: "github", label: "GitHub", enabled: true, github: { repo: "me/backup" } }],
    ...over,
  };
}

function state(over: Partial<SyncState> = {}): SyncState {
  return {
    status: "idle",
    last_sync: new Date(Date.now() - 30_000).toISOString(),
    last_error: null,
    pending_conflicts: [],
    failed_types: [],
    sync_counts: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
    sync_totals: { bookmarks: 0, history: 0, sessions: 0, extensions: 0 },
    sync_cycles: 1,
    bytes_transferred: 0,
    sync_report: null,
    recovery_notice: null,
    guard_notice: null,
    ...over,
  };
}

const READY = {
  bookmarks: { state: "ready" },
  history: { state: "ready" },
  sessions: { state: "ready" },
  extensions: { state: "ready" },
};

describe("redact", () => {
  it("replaces values under secret-looking keys, at any depth", () => {
    expect(
      redact({
        encryption_passphrase: "hunter2",
        github: { token: "ghp_secret", owner: "me" },
        nested: [{ api_key: "k" }],
      })
    ).toEqual({
      encryption_passphrase: "[redacted]",
      github: { token: "[redacted]", owner: "me" },
      nested: [{ api_key: "[redacted]" }],
    });
  });

  it("strips credentials, query and fragment from a storage URL", () => {
    const url = redact("https://user:pass@example.com/dav?token=abc#frag");
    expect(url).toBe("https://%5Bredacted%5D:%5Bredacted%5D@example.com/dav?[redacted]");
    expect(String(url)).not.toContain("pass");
    expect(String(url)).not.toContain("abc");
  });

  it("stops at a depth instead of recursing forever", () => {
    let value: Record<string, unknown> = { end: true };
    for (let i = 0; i < 12; i++) value = { next: value };
    expect(JSON.stringify(redact(value))).toContain("[depth]");
  });
});

describe("redactText", () => {
  it("scrubs a URL embedded in an error message", () => {
    const text = redactText("GET https://alice:swordfish@dav.example.com/x?token=abc failed");
    expect(text).not.toContain("alice");
    expect(text).not.toContain("swordfish");
    expect(text).not.toContain("abc");
    expect(text).toContain("dav.example.com");
  });

  it("replaces an authorization header and an inline secret", () => {
    const text = redactText("401 with Bearer ghp_secret; password: hunter2");
    expect(text).not.toContain("ghp_secret");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("Bearer [redacted]");
  });

  it("leaves ordinary prose alone", () => {
    expect(redactText("Quota exceeded after 3 attempts")).toBe("Quota exceeded after 3 attempts");
  });
});

describe("buildDoctorReport", () => {
  it("says ok for a configured, healthy device", () => {
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings(),
      state: state(),
      availability: READY,
      snapshotCount: 2,
      now: Date.now(),
    });

    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      "backend-configured": "ok",
      "types-enabled": "ok",
      "permission-bookmarks": "ok",
      conflicts: "ok",
      "last-error": "ok",
      freshness: "ok",
      "restore-points": "ok",
      "device-id": "ok",
    });
    expect(doctorNeedsAttention(report)).toBe(false);
  });

  it("reports the things that stop a sync as errors", () => {
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings({ active_backend: null, enabled_types: [] }),
      state: state({ last_error: "HTTP 401", failed_types: ["bookmarks"] }),
      availability: { bookmarks: { state: "needs-permission", permission: "bookmarks" } },
      now: Date.now(),
    });

    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId["backend-configured"].status).toBe("error");
    expect(byId["types-enabled"].status).toBe("error");
    expect(byId["last-error"]).toEqual({ id: "last-error", status: "error", detail: "HTTP 401" });
    expect(byId["failed-types"].detail).toBe("bookmarks");
    expect(doctorNeedsAttention(report)).toBe(true);
  });

  it("flags a missing permission with the permission it needs", () => {
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings({ enabled_types: ["bookmarks", "history"] }),
      state: state(),
      availability: { bookmarks: { state: "ready" }, history: { state: "needs-permission", permission: "history" } },
      now: Date.now(),
    });

    expect(report.checks.find((c) => c.id === "permission-history")).toEqual({
      id: "permission-history",
      status: "error",
      detail: "history",
    });
  });

  it("checks the passphrase length only when encryption is on", () => {
    const off = buildDoctorReport({
      version: "1.5.17",
      settings: settings({ encryption_enabled: false }),
      state: state(),
      availability: READY,
    });
    expect(off.checks.find((c) => c.id === "e2ee")?.status).toBe("info");

    const short = buildDoctorReport({
      version: "1.5.17",
      settings: settings({ encryption_enabled: true, encryption_passphrase: "short" }),
      state: state(),
      availability: READY,
    });
    expect(short.checks.find((c) => c.id === "e2ee-passphrase")?.status).toBe("error");
  });

  it("warns when the last sync is three intervals old", () => {
    const old = buildDoctorReport({
      version: "1.5.17",
      settings: settings({ sync_interval_seconds: 60 }),
      state: state({ last_sync: new Date(Date.now() - 5 * 60_000).toISOString() }),
      availability: READY,
      now: Date.now(),
    });
    expect(old.checks.find((c) => c.id === "freshness")?.status).toBe("warn");
  });

  it("reports the conflict count and truncates a huge error", () => {
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings(),
      state: state({
        pending_conflicts: [
          {
            id: "c1",
            data_type: "bookmarks",
            device_id: "peer",
            timestamp: "2026-01-01T00:00:00.000Z",
            resolved: false,
          },
        ],
        last_error: "x".repeat(1000),
      }),
      availability: READY,
      now: Date.now(),
    });

    expect(report.checks.find((c) => c.id === "conflicts")).toEqual({
      id: "conflicts",
      status: "warn",
      detail: "1",
    });
    expect(report.checks.find((c) => c.id === "last-error")?.detail).toHaveLength(300);
  });

  it("never puts a secret into the copyable text", () => {
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings({
        encryption_enabled: true,
        encryption_passphrase: "correct horse battery staple",
        backends: [
          {
            type: "webdav",
            label: "WebDAV",
            enabled: true,
            webdav: {
              url: "https://alice:swordfish@dav.example.com/remote.php/dav?token=abc",
              username: "alice",
              password: "swordfish",
            },
          },
        ],
      }),
      state: state(),
      availability: READY,
    });

    expect(report.text).toContain("Kesonode diagnostics");
    expect(report.text).toContain("1.5.17");
    for (const secret of ["correct horse battery staple", "swordfish", "abc"]) {
      expect(report.text).not.toContain(secret);
    }
  });

  it("scrubs the receipt's error text and the bookmark samples in notices", () => {
    const receipt: SyncReport = {
      at: "2026-01-01T00:00:00.000Z",
      duration_ms: 12,
      types: [
        {
          data_type: "bookmarks",
          peers: 1,
          local_before: 2,
          local_after: 1,
          added: 0,
          removed: 1,
          moved: 0,
          retitled: 0,
          uploaded: true,
          held: false,
          preview: {
            added: 0,
            removed: 1,
            moved: 0,
            local_total: 2,
            peer_total: 1,
            sample: [{ title: "Private title", url: "https://private.example/" }],
          },
        },
      ],
      added: 0,
      removed: 1,
      total_before: 2,
      total_after: 1,
      dangerous: false,
      errors: ["GET https://alice:swordfish@dav.example.com/x?token=abc failed with Bearer ghp_secret"],
    };
    const report = buildDoctorReport({
      version: "1.5.17",
      settings: settings(),
      state: state({
        last_error: "PUT https://alice:swordfish@dav.example.com/x?token=abc failed",
        sync_report: receipt,
        recovery_notice: {
          at: "2026-01-01T00:00:00.000Z",
          blocked: 2,
          sample: [{ title: "Secret bookmark", url: "https://secret.example/" }],
        },
      }),
      availability: READY,
    });

    expect(report.text).toContain("[redacted]");
    for (const secret of ["swordfish", "ghp_secret", "Private title", "Secret bookmark", "secret.example"]) {
      expect(report.text).not.toContain(secret);
    }
    // The counts survive; only the titles and URLs are removed.
    expect(report.text).toContain('"blocked": 2');
  });
});
