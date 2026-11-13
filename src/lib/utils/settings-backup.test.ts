import { describe, it, expect } from "vitest";
import { browser } from "@/lib/utils/ext";
import {
  KEYS,
  DEFAULT_SETTINGS,
  saveSettings,
  exportSettingsBackup,
  encryptSettingsBackup,
  openSettingsBackup,
  importSettingsBackup,
  importSettingsRisks,
  getSettings,
  SETTINGS_BACKUP_FORMAT,
  SETTINGS_BACKUP_VERSION,
  SUPPORTED_BACKUP_VERSIONS,
  BACKUP_MIGRATIONS,
  BACKUP_SETTINGS_FIELDS,
  SETTINGS_BACKUP_SCHEMA,
  migrateBackupDocument,
  detectDeviceOs,
} from "@/lib/utils/storage";
import { withChecksum } from "@/lib/utils/checksum";
import type { SettingsBackup } from "@/lib/types";

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
    // Keyed by data type only, so it describes what THIS identity last published.
    [KEYS.UPLOAD_CHECKSUMS]: { bookmarks: "a".repeat(64), extensions: "b".repeat(64) },
  });
}

function keysOf(backup: SettingsBackup): NonNullable<SettingsBackup["keys"]> {
  if (!backup.keys) throw new Error("test expected a backup with contents");
  return backup.keys;
}

describe("settings backup", () => {
  it("exports the configuration WITHOUT credentials by default", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2");
    const keys = keysOf(backup);

    expect(backup.format).toBe("kesonode-settings");
    expect(backup.version).toBe(SETTINGS_BACKUP_VERSION);
    expect(backup.credentials).toBe("redacted");
    expect(backup.extensionVersion).toBe("1.5.2");
    expect(keys.settings.device_id).toBe("device-from-old-id");
    // Nothing that authenticates is in the file. A WebDAV password stays an empty
    // string (the backend record has to remain valid); an import treats both an absent
    // passphrase and an empty password as "keep what this install holds".
    expect(keys.settings.encryption_passphrase).toBeUndefined();
    expect(keys.settings.backends[0].webdav?.password).toBe("");
    expect(keys.gdriveSession).toBeUndefined();
    expect(keys.gdriveFolder).toBeUndefined();
    expect(JSON.stringify(backup)).not.toContain("secret");
    expect(JSON.stringify(backup)).not.toContain("correct horse");
    expect(JSON.stringify(backup)).not.toContain("refresh");
  });

  it("includes credentials only when asked", async () => {
    await seedOldInstall();
    const backup = await exportSettingsBackup("1.5.2", { includeCredentials: true });
    const keys = keysOf(backup);

    expect(backup.credentials).toBe("included");
    expect(keys.settings.device_id).toBe("device-from-old-id");
    expect(keys.settings.encryption_passphrase).toBe("correct horse battery staple");
    expect(keys.settings.backends[0].webdav?.password).toBe("secret");
    expect(keys.gdriveSession).toMatchObject({ refresh_token: "refresh" });
    expect(keys.gdriveFolder).toMatchObject({ id: "folder-1" });
    expect(Object.keys(keys).sort()).toEqual(
      ["gdriveFolder", "gdriveSession", "settings"]
    );
  });

  it("does not describe a redacted file as carrying plaintext credentials", async () => {
    await seedOldInstall();
    const redacted = await exportSettingsBackup("1.5.2");
    const risks = importSettingsRisks(await getSettings(), redacted);
    expect(risks).not.toContain("has-credentials");
    expect(risks).not.toContain("has-gdrive-session");
  });

  it("restores a fresh install from a credentials-bearing backup", async () => {
    await seedOldInstall();
    // A real upgrade round-trips through a file on disk, not a live object.
    const file = JSON.parse(JSON.stringify(
      await exportSettingsBackup("1.5.2", { includeCredentials: true }),
    ));
    await browser.storage.local.clear();
    // The browser kept syncing under the SAME identity after the export was written.
    await browser.storage.local.set({
      [KEYS.UPLOAD_CHECKSUMS]: { bookmarks: "a".repeat(64), extensions: "b".repeat(64) },
    });

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
    // Same machine, same device_id: the checksums still describe the files this
    // installation published, so a quiet type can keep skipping its re-upload.
    expect((await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS))[KEYS.UPLOAD_CHECKSUMS])
      .toMatchObject({ bookmarks: "a".repeat(64) });
  });

  it("keeps this install's matching credentials when a redacted file is re-imported", async () => {
    await seedOldInstall();
    const file = JSON.parse(JSON.stringify(await exportSettingsBackup("1.5.2")));

    // Same machine: the password in storage belongs to the same server and account, so
    // re-importing one's own safe backup must not sign this install out.
    const restored = await importSettingsBackup(file);

    expect(restored.backends[0].webdav?.password).toBe("secret");
    expect(restored.encryption_enabled).toBe(true);
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
    // The file carried no session, but it also cannot say "sign out": a redacted import
    // leaves the existing one alone.
    const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
    expect(session.refresh_token).toBe("refresh");
  });

  it("does not keep a password for a different server or account", async () => {
    await seedOldInstall();
    const file = JSON.parse(JSON.stringify(await exportSettingsBackup("1.5.2")));
    const keys = keysOf(file as SettingsBackup);
    keys.settings.backends[0].webdav!.url = "https://other.example";
    keys.settings.backends[0].webdav!.username = "someone-else";
    (file as { checksum?: string }).checksum = undefined;

    const restored = await importSettingsBackup(
      await withChecksum(file as unknown as Record<string, unknown>),
    );

    expect(restored.backends[0].webdav?.password).toBe("");
  });

  it("refuses a redacted backup that enables E2EE unless the passphrase is supplied", async () => {
    await seedOldInstall();
    const file = JSON.parse(JSON.stringify(await exportSettingsBackup("1.5.2")));
    await browser.storage.local.clear();

    await expect(importSettingsBackup(file)).rejects.toThrow(/does not include the passphrase/);
    // The refusal happens before saveSettings: this install may have minted an identity
    // on read, but it holds neither the passphrase nor a backend from the refused file.
    const stored = (await browser.storage.local.get(KEYS.SETTINGS))[KEYS.SETTINGS] as
      | { encryption_passphrase?: string; backends?: unknown[] }
      | undefined;
    expect(stored?.encryption_passphrase).toBeUndefined();
    expect(stored?.backends).toBeUndefined();

    const restored = await importSettingsBackup(file, {
      e2eePassphrase: "correct horse battery staple",
    });
    expect(restored.encryption_enabled).toBe(true);
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
  });

  it("importing onto a DIFFERENT device mints a new identity but keeps every account", async () => {
    await seedOldInstall();
    const file = JSON.parse(JSON.stringify(
      await exportSettingsBackup("1.5.2", { includeCredentials: true }),
    ));
    await browser.storage.local.clear();
    // This browser had already synced under its own earlier identity before the import.
    await browser.storage.local.set({
      [KEYS.UPLOAD_CHECKSUMS]: { bookmarks: "c".repeat(64), extensions: "d".repeat(64) },
    });

    const restored = await importSettingsBackup(file, { asNewDevice: true });

    // Two browsers writing konode_<type>_<the same id>.json would overwrite one
    // another and appear as a single device in the device list.
    expect(restored.device_id).not.toBe("device-from-old-id");
    expect(restored.device_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(restored.device_label).not.toBe("Old laptop");
    // This browser's own name, and ONLY that: the browser and the 8-char id used to be
    // glued onto the stored label, which put a machine half inside a field the user is
    // asked to edit. They are shown next to the name now, never stored in it.
    expect(restored.device_label).not.toMatch(/[0-9a-f]{8}$/i);
    expect(restored.device_label).toBe(detectDeviceOs());
    // Configuration, credentials and the setup flag are unaffected by the new identity.
    expect(restored.active_backend).toBe("webdav");
    expect(restored.backends[0].webdav?.password).toBe("secret");
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
    expect(restored.compat_mode).toBe("isolated");
    expect(restored.onboarding_completed).toBe(true);
    const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
    expect(session.refresh_token).toBe("refresh");
    // The old checksums describe konode_<type>_<old id>.json. Carried over, an unchanged
    // payload would be skipped as "already uploaded" and the new id would never publish
    // a file — the browser would stay invisible to the group.
    expect((await browser.storage.local.get(KEYS.UPLOAD_CHECKSUMS))[KEYS.UPLOAD_CHECKSUMS])
      .toBeUndefined();
  });

  it("refuses a foreign file, a future version, and one with no device ID", async () => {
    await expect(importSettingsBackup(null)).rejects.toThrow();
    await expect(importSettingsBackup({ version: "1.0", data: {} })).rejects.toThrow();
    await expect(importSettingsBackup({
      format: "kesonode-settings", version: 99,
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
    const backup = await exportSettingsBackup("1.5.2", { includeCredentials: true });
    (backup.keys!.settings as unknown as Record<string, unknown>).injected = "not a setting";
    (backup.keys!.settings as unknown as Record<string, unknown>).enabled_types = "not-an-array";

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

describe("encrypted settings backup", () => {
  it("seals every identifier, token and passphrase inside the ciphertext", async () => {
    await seedOldInstall();
    const plain = await exportSettingsBackup("1.5.2", { includeCredentials: true });
    const sealed = await encryptSettingsBackup(plain, "a long export password");

    expect(sealed.credentials).toBe("encrypted");
    expect(sealed.version).toBe(SETTINGS_BACKUP_VERSION);
    expect(typeof sealed.ciphertext).toBe("string");
    expect(sealed.keys).toBeUndefined();
    const json = JSON.stringify(sealed);
    // The envelope says what the file IS, never what it holds: a server address or an
    // account name is as identifying as the password next to it.
    expect(json).not.toContain("dav.example");
    expect(json).not.toContain("me@example.com");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("correct horse");
  });

  it("opens with the right password and restores everything", async () => {
    await seedOldInstall();
    const sealed = await encryptSettingsBackup(
      await exportSettingsBackup("1.5.2", { includeCredentials: true }),
      "a long export password",
    );
    const file = JSON.parse(JSON.stringify(sealed));
    await browser.storage.local.clear();

    // The worker refuses the sealed form: only the page (which shows the risks from the
    // decrypted contents) is allowed to open it first.
    await expect(importSettingsBackup(file)).rejects.toThrow(/encrypted/);

    const opened = await openSettingsBackup(file, "a long export password");
    expect(opened.credentials).toBe("included");
    const restored = await importSettingsBackup(opened);
    expect(restored.device_id).toBe("device-from-old-id");
    expect(restored.backends[0].webdav?.password).toBe("secret");
    expect(restored.encryption_passphrase).toBe("correct horse battery staple");
    const session = (await browser.storage.local.get(KEYS.GDRIVE_SESSION))[KEYS.GDRIVE_SESSION];
    expect(session.refresh_token).toBe("refresh");
  });

  it("refuses the wrong password", async () => {
    await seedOldInstall();
    const sealed = await encryptSettingsBackup(
      await exportSettingsBackup("1.5.2", { includeCredentials: true }),
      "a long export password",
    );

    await expect(openSettingsBackup(sealed, "the wrong password"))
      .rejects.toThrow(/did not open the backup/);
  });

  it("detects damage before asking for a password", async () => {
    await seedOldInstall();
    const sealed = await encryptSettingsBackup(
      await exportSettingsBackup("1.5.2", { includeCredentials: true }),
      "a long export password",
    );
    (sealed as unknown as Record<string, unknown>).ciphertext = "AAAA";
    await expect(openSettingsBackup(sealed, "a long export password")).rejects.toThrow(/checksum/i);
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
    const redacted = await exportSettingsBackup("1.5.2");
    expect(Object.keys(redacted).sort()).toEqual(
      ["checksum", "credentials", "exportedAt", "extensionVersion", "format", "keys", "version"]
    );
    expect(redacted.format).toBe(SETTINGS_BACKUP_FORMAT);
    expect(redacted.version).toBe(SETTINGS_BACKUP_VERSION);
    // The safe form carries the settings and nothing else.
    expect(Object.keys(keysOf(redacted))).toEqual(["settings"]);

    const included = await exportSettingsBackup("1.5.2", { includeCredentials: true });
    expect(Object.keys(keysOf(included)).sort()).toEqual(
      ["gdriveFolder", "gdriveSession", "settings"]
    );
    const exported = Object.keys(keysOf(included).settings as unknown as Record<string, unknown>);
    expect(exported.every((k) => (BACKUP_SETTINGS_FIELDS as string[]).includes(k))).toBe(true);
    // Every setting travels except the AI key. It is deliberately stripped from BOTH
    // export forms in exportSettingsBackup(): a settings backup is a file people move
    // between machines, and a bring-your-own-key LLM credential must not travel with it.
    const neverExported = ["ai_api_key"];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (neverExported.includes(key)) continue;
      expect(exported).toContain(key);
    }
    for (const key of neverExported) {
      expect(exported).not.toContain(key);
      expect(Object.keys(keysOf(redacted).settings as unknown as Record<string, unknown>))
        .not.toContain(key);
    }
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

  it("reads a v1 file as carrying credentials, so the plaintext warning still applies", () => {
    // The migration is what keeps the historical file meaningful: a v1 file holds its
    // secrets, so an import still asks before taking someone else's credentials.
    const migrated = BACKUP_MIGRATIONS[1]({ version: 1 });
    expect(migrated.version).toBe(2);
    expect(migrated.credentials).toBe("included");
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
    const backup = await exportSettingsBackup("1.5.2", { includeCredentials: true });
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
    const backup = await exportSettingsBackup("1.5.2", { includeCredentials: true });
    await browser.storage.local.clear();
    (backup.keys!.settings as unknown as Record<string, unknown>).device_label = "tampered";
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
