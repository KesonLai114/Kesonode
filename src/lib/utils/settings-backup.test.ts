import { describe, it, expect } from "vitest";
import { browser } from "@/lib/utils/ext";
import {
  KEYS,
  DEFAULT_SETTINGS,
  saveSettings,
  exportSettingsBackup,
  importSettingsBackup,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  SUPPORTED_BACKUP_VERSIONS,
  BACKUP_MIGRATIONS,
  BACKUP_SETTINGS_FIELDS,
  SETTINGS_BACKUP_SCHEMA,
  migrateBackupDocument,
} from "@/lib/utils/storage";
import { withChecksum } from "@/lib/utils/checksum";

/**
 * A new unpacked folder means a new extension ID in Chromium, which means an empty
 * chrome.storage.local. These tests play both installations in turn: seed the old one,
 * export, wipe storage, import into the "new" one.
 */
async function seedOldInstall(): Promise<void> {
  await saveSettings({
    device_id: "device-from-old-id",
    device_label: "Old laptop",
    active_backend: "webdav",
    backends: [{
      type: "webdav",
      label: "pCloud",
      enabled: true,
      webdav: { url: "https://dav.example", username: "me", password: "secret" },
    }],
    encryption_enabled: true,
    encryption_passphrase: "correct horse battery staple",
    compat_mode: "isolated",
    onboarding_completed: true,
  });
  await browser.storage.local.set({
    [KEYS.GDRIVE_SESSION]: {
      access_token: "access", refresh_token: "refresh", expires_at: 0,
      email: "me@example.com", displayName: "Me", savedAt: 0,
    },
    [KEYS.GDRIVE_FOLDER]: { id: "folder-1", name: "Konode" },
    // Per-install working state. It must NOT be carried over: a fresh device that
    // claims it already merged these tombstones would silently drop peer deletions.
    [KEYS.BOOKMARK_TOMBSTONES]: [{ id: "bm-1", timestamp: 1 }],
    [KEYS.SYNC_LOCK]: { acquiredAt: Date.now() },
  });
}

describe("settings backup", () => {
  it("exports configuration and credentials, but no per-install working state", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");

    expect(backup.format).toBe("kesonode-settings");
    expect(backup.version).toBe(1);
    expect(backup.extensionVersion).toBe("1.5.2");
    expect(backup.keys.settings.device_id).toBe("device-from-old-id");
    expect(backup.keys.settings.encryption_passphrase).toBe("correct horse battery staple");
    expect(backup.keys.gdriveSession).toMatchObject({ refresh_token: "refresh" });
    expect(backup.keys.gdriveFolder).toMatchObject({ id: "folder-1" });
    expect(Object.keys(backup.keys).sort()).toEqual(
      ["gdriveFolder", "gdriveSession", "settings"]
    );
  });

  it("restores a fresh install without losing the device ID or making the wizard reopen", async () => {
    await seedOldInstall();
    // A real upgrade round-trips through a file on disk, not a live object.
    const file = JSON.parse(JSON.stringify(await exportSettingsBackup("1.5.2")));
    await browser.storage.local.clear();

    const restored = await importSettingsBackup(file);

    expect(restored.device_id).toBe("device-from-old-id");
    expect(restored.device_label).toBe("Old laptop");
    expect(restored.active_backend).toBe("webdav");
    expect(restored.backends[0].webdav?.password).toBe("secret");
    expect(restored.encryption_enabled).toBe(true);
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
    expect(restored.compat_mode).toBe("isolated");
    expect(restored.onboarding_completed).toBe(true);

    const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
    expect(session.refresh_token).toBe("refresh");
    const folder = (await browser.storage.local.get(KEYS.GDRIVE_FOLDER))[KEYS.GDRIVE_FOLDER];
    expect(folder.id).toBe("folder-1");

    const tombstones = (await browser.storage.local.get(KEYS.BOOKMARK_TOMBSTONES))[KEYS.BOOKMARK_TOMBSTONES];
    const lock = (await browser.storage.local.get(KEYS.SYNC_LOCK))[KEYS.SYNC_LOCK];
    expect(tombstones).toBeUndefined();
    expect(lock).toBeUndefined();
  });

  it("importing onto a DIFFERENT device mints a new identity but keeps every account", async () => {
    await seedOldInstall();
    const file = JSON.parse(JSON.stringify(await exportSettingsBackup("1.5.2")));
    await browser.storage.local.clear();

    const restored = await importSettingsBackup(file, { asNewDevice: true });

    // Two browsers writing konode_<type>_<the same id>.json would overwrite one
    // another and appear as a single device in the device list.
    expect(restored.device_id).not.toBe("device-from-old-id");
    expect(restored.device_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(restored.device_label).not.toBe("Old laptop");
    expect(restored.device_label).toMatch(/ · [0-9a-f]{8}$/);
    // Configuration, credentials and the setup flag are unaffected by the new identity.
    expect(restored.active_backend).toBe("webdav");
    expect(restored.backends[0].webdav?.password).toBe("secret");
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
    expect(restored.compat_mode).toBe("isolated");
    expect(restored.onboarding_completed).toBe(true);
    const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
    expect(session.refresh_token).toBe("refresh");
  });

  it("refuses a foreign file, a future version, and one with no device ID", async () => {
    await expect(importSettingsBackup(null)).rejects.toThrow();
    await expect(importSettingsBackup({ version: "1.0", data: {} })).rejects.toThrow();
    await expect(importSettingsBackup({
      format: "kesonode-settings", version: 2,
      keys: { settings: { device_id: "x" } },
    })).rejects.toThrow();
    await expect(importSettingsBackup({
      format: "kesonode-settings", version: 1,
      keys: { settings: {} },
    })).rejects.toThrow();
    // Nothing was written by a rejected import.
    expect((await browser.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS]).toBeUndefined();
  });

  it("drops unknown fields and repairs a broken array rather than trusting the file", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    (backup.keys.settings as unknown as Record<string, unknown>).injected = "not a setting";
    (backup.keys.settings as unknown as Record<string, unknown>).enabled_types = "not-an-array";

    // A checksum has no secret, so it can be recomputed after an edit. Re-sign this
    // hand-edited file to exercise the whitelist/validator path; real damage (without
    // re-signing) is covered by the checksum tests below.
    const restored = await importSettingsBackup(
      await withChecksum(backup as unknown as Record<string, unknown>)
    );

    expect((restored as unknown as Record<string, unknown>).injected).toBeUndefined();
    expect(restored.enabled_types).toEqual(["bookmarks"]);
  });

  it("restores a backup written by an older version using this version's defaults", async () => {
    await browser.storage.local.clear();
    const legacy = {
      format: "kesonode-settings",
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      extensionVersion: "1.5.2",
      keys: { settings: { device_id: "legacy-device", backends: [], active_backend: null } },
    };

    const restored = await importSettingsBackup(legacy);

    expect(restored.device_id).toBe("legacy-device");
    expect(restored.sync_interval_seconds).toBe(60);
    expect(restored.enabled_types).toEqual(["bookmarks"]);
    expect(restored.onboarding_completed).toBe(true);
    // No session in the backup: a stale one must not survive an import over existing data.
    await browser.storage.local.set({ [KEYS.GDRIVE_SESSION]: { refresh_token: "stale" } });
    await importSettingsBackup(legacy);
    expect((await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION]).toBeUndefined();
  });
});

/**
 * Compatibility matrix. One LITERAL file per release that ever wrote a settings backup,
 * credentials replaced. Deliberately not produced by the current export: if it were, a
 * change to the export shape could never be caught. APPEND an entry whenever a release
 * changes the format; never edit an existing one.
 */
const HISTORICAL_BACKUPS: { release: string; file: unknown }[] = [
  {
    release: "1.5.2 (format v1)",
    file: {
      format: "kesonode-settings",
      version: 1,
      exportedAt: "2026-11-08T02:00:00.000Z",
      extensionVersion: "1.5.2",
      keys: {
        settings: {
          device_id: "b3f1c2d4-0000-4000-8000-000000000001",
          device_label: "Windows 10/11 · Chromium",
          enabled_types: ["bookmarks"],
          backends: [{
            type: "webdav", label: "pCloud", enabled: true,
            webdav: { url: "https://dav.example/dav/", username: "me", password: "REDACTED" },
          }],
          active_backend: "webdav",
          sync_interval_seconds: 60,
          conflict_strategy: "lww",
          history_days_limit: 30,
          bulk_delete_percent: 60,
          excluded_bookmarks: [],
          auto_sync: true,
          sync_on_change: true,
          notifications_enabled: true,
          debug_mode: false,
          encryption_enabled: true,
          encryption_passphrase: "REDACTED-PASSPHRASE",
          onboarding_completed: true,
          compat_mode: "upstream",
        },
        gdriveSession: {
          access_token: "REDACTED", refresh_token: "REDACTED", expires_at: 0,
          email: "me@example.com", displayName: "Me", savedAt: 0,
        },
        gdriveFolder: { id: "folder-1", name: "Konode" },
      },
    },
  },
];

function historicalFile(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(HISTORICAL_BACKUPS[0].file)) as Record<string, unknown>;
}

function historicalSettings(file: Record<string, unknown>): Record<string, unknown> {
  return (file.keys as Record<string, unknown>).settings as Record<string, unknown>;
}

describe("settings backup compatibility matrix", () => {
  for (const { release, file } of HISTORICAL_BACKUPS) {
    it(`restores a literal file written by ${release}`, async () => {
      const restored = await importSettingsBackup(JSON.parse(JSON.stringify(file)));
      expect(restored.device_id).toBe("b3f1c2d4-0000-4000-8000-000000000001");
      expect(restored.active_backend).toBe("webdav");
      expect(restored.backends[0].webdav?.password).toBe("REDACTED");
      expect(restored.encryption_passphrase).toBe("REDACTED-PASSPHRASE");
      expect(restored.compat_mode).toBe("upstream");
      expect(restored.onboarding_completed).toBe(true);
      const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
      expect(session.refresh_token).toBe("REDACTED");
    });
  }

  it("keeps the envelope and the portable field set stable", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    expect(Object.keys(backup).sort()).toEqual(
      ["checksum", "exportedAt", "extensionVersion", "format", "keys", "version"]
    );
    expect(backup.format).toBe(SETTINGS_BACKUP_FORMAT);
    expect(backup.version).toBe(SETTINGS_BACKUP_VERSION);
    expect(Object.keys(backup.keys).sort()).toEqual(
      ["gdriveFolder", "gdriveSession", "settings"]
    );
    const exported = Object.keys(backup.keys.settings as unknown as Record<string, unknown>);
    expect(exported.every((k) => (BACKUP_SETTINGS_FIELDS as string[]).includes(k))).toBe(true);
    for (const key of Object.keys(DEFAULT_SETTINGS)) expect(exported).toContain(key);
  });

  it("the schema covers every setting, including the optional ones", () => {
    const fields = Object.keys(SETTINGS_BACKUP_SCHEMA);
    expect(fields.length).toBe(BACKUP_SETTINGS_FIELDS.length);
    expect(fields).toContain("encryption_passphrase");
    expect(fields).toContain("compat_mode");
    for (const key of Object.keys(DEFAULT_SETTINGS)) expect(fields).toContain(key);
  });

  it("refuses a future format version with an actionable error and writes nothing", async () => {
    const future = historicalFile();
    future.version = 99;
    await expect(importSettingsBackup(future)).rejects.toThrow(/newer Kesonode|Update Kesonode/);
    expect((await browser.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS]).toBeUndefined();
  });

  it("refuses malformed version values", async () => {
    for (const version of ["1", null, 1.5, -1, {}]) {
      const file = historicalFile();
      file.version = version;
      await expect(importSettingsBackup(file)).rejects.toThrow();
    }
  });

  it("repairs wrong types, enums and ranges instead of importing them", async () => {
    const file = historicalFile();
    const settings = historicalSettings(file);
    settings.sync_interval_seconds = "sixty";
    settings.conflict_strategy = "unknown-strategy";
    settings.bulk_delete_percent = 999;
    settings.active_backend = "dropbox";
    settings.debug_mode = "yes";
    settings.enabled_types = "bookmarks";
    settings.compat_mode = "not-a-mode";

    const restored = await importSettingsBackup(file);
    expect(restored.sync_interval_seconds).toBe(DEFAULT_SETTINGS.sync_interval_seconds);
    expect(restored.conflict_strategy).toBe(DEFAULT_SETTINGS.conflict_strategy);
    expect(restored.bulk_delete_percent).toBe(DEFAULT_SETTINGS.bulk_delete_percent);
    expect(restored.active_backend).toBeNull();
    expect(restored.debug_mode).toBe(false);
    expect(restored.enabled_types).toEqual(DEFAULT_SETTINGS.enabled_types);
    // Optional with no default: keep this install's value instead of trusting the file.
    expect(restored.compat_mode).toBeUndefined();
  });

  it("walks the migration chain one version at a time", () => {
    const seen: number[] = [];
    const result = migrateBackupDocument({ version: 1, marker: "original" }, 1, 4, {
      1: (d) => { seen.push(1); return { ...d, version: 2 }; },
      2: (d) => { seen.push(2); return { ...d, version: 3 }; },
      3: (d) => { seen.push(3); return { ...d, version: 4 }; },
    });
    expect(seen).toEqual([1, 2, 3]);
    expect(result.version).toBe(4);
    expect(result.marker).toBe("original");
  });

  it("refuses to guess when a migration link is missing", () => {
    expect(() => migrateBackupDocument({ version: 1 }, 1, 2, {})).toThrow(/migration/i);
  });

  it("every supported older version has a migration to the next one", () => {
    for (const version of SUPPORTED_BACKUP_VERSIONS) {
      expect(version).toBeLessThanOrEqual(SETTINGS_BACKUP_VERSION);
      for (let step = version; step < SETTINGS_BACKUP_VERSION; step++) {
        expect(BACKUP_MIGRATIONS[step]).toBeTypeOf("function");
      }
    }
  });

  it("exports a SHA-256 checksum that survives re-serialisation", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    expect(backup.checksum).toMatch(/^[0-9a-f]{64}$/);
    // A real file round-trips through disk, and a hand-edited one may reorder keys.
    const reordered: Record<string, unknown> = {};
    const source = backup as unknown as Record<string, unknown>;
    for (const key of Object.keys(source).reverse()) reordered[key] = source[key];
    const restored = await importSettingsBackup(reordered);
    expect(restored.device_id).toBe("device-from-old-id");
  });

  it("refuses a file damaged after its checksum was written, and writes nothing", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    await browser.storage.local.clear();
    (backup.keys.settings as unknown as Record<string, unknown>).device_label = "tampered";
    await expect(importSettingsBackup(backup)).rejects.toThrow(/checksum/i);
    expect((await browser.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS]).toBeUndefined();
  });

  it("refuses a malformed checksum", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    (backup as unknown as Record<string, unknown>).checksum = "nope";
    await expect(importSettingsBackup(backup)).rejects.toThrow(/malformed checksum/i);
  });

  it("still accepts a file with no checksum (written by an older build)", async () => {
    await browser.storage.local.clear();
    const restored = await importSettingsBackup({
      format: SETTINGS_BACKUP_FORMAT,
      version: SETTINGS_BACKUP_VERSION,
      keys: { settings: { device_id: "no-checksum-device" } },
    });
    expect(restored.device_id).toBe("no-checksum-device");
  });
});
