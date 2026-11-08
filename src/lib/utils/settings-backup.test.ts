import { describe, it, expect } from "vitest";
import { browser } from "@/lib/utils/ext";
import {
  KEYS,
  saveSettings,
  exportSettingsBackup,
  importSettingsBackup,
} from "@/lib/utils/storage";

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

    const restored = await importSettingsBackup(backup);

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
