// The group's bookmark baseline, as one small shared file.
//
// A first-sync "use this browser's copy" answer used to delete every peer's bookmark
// file and nothing else. Those devices re-upload their own trees on their next cycle, the
// union came back, and the answer had no lasting effect. This marker is what makes the
// answer travel: the chosen device names itself here, and every other device replaces its
// tree with that device's published copy once, then merges both ways again.
//
// Kesonode-only, like the kept/manual restore-point prefixes: no peer-packet prefix
// matches it, so other devices (including upstream) simply never download it. It is
// encrypted whenever E2EE is on, so a device name is not the one readable field on the
// storage.

import { encrypt, decrypt } from "@/lib/crypto/encryption";
import { browser } from "@/lib/utils/ext";
import { KEYS } from "@/lib/utils/storage";
import { logger } from "@/lib/utils/logger";
import type { IBackend, SyncSettings } from "@/lib/types";

export const BASELINE_FILE = "konode_baseline.json";

export interface BaselineMarker {
  version: 1;
  device_id: string;
  device_label?: string;
  /** ISO time the baseline was designated. Also the generation id: a device applies a
   *  marker it has not applied before, and re-designating mints a new one. */
  at: string;
  /** Checksum of the tree the baseline device published for this marker. Followers wait
   *  for this exact packet instead of applying whatever copy happens to be in the folder:
   *  the baseline device may not have uploaded its current tree yet when the marker lands,
   *  and adopting the stale one would mark the device aligned with the wrong tree.
   *  Optional because a marker written by an earlier build carries no checksum. */
  checksum?: string;
}

export interface BaselineAdopted {
  device_id: string;
  at: string;
}

export interface BaselineRead {
  marker: BaselineMarker | null;
  /** The file exists but this device cannot make sense of it (wrong passphrase, E2EE
   *  disagreement, invalid payload). Not the same as "no baseline": do not clear a cache. */
  unreadable: boolean;
}

interface BaselineFile {
  version: "1.0";
  encrypted: boolean;
  payload: string;
}

const e2eeActive = (s: SyncSettings): boolean =>
  !!s.encryption_enabled && !!s.encryption_passphrase;

/** Throws only when the backend itself failed. An absent or unreadable marker is data. */
export async function readBaselineMarker(
  backend: IBackend, settings: SyncSettings,
): Promise<BaselineRead> {
  const raw = await backend.getFile(BASELINE_FILE);
  if (!raw) return { marker: null, unreadable: false };

  let file: BaselineFile;
  try {
    file = JSON.parse(raw) as BaselineFile;
  } catch {
    logger.warn("Baseline", "The bookmark baseline file is not valid JSON; ignoring it");
    return { marker: null, unreadable: true };
  }

  let plain = file.payload;
  if (file.encrypted) {
    if (!e2eeActive(settings)) {
      logger.warn("Baseline", "The bookmark baseline is encrypted but E2EE is off here; ignoring it");
      return { marker: null, unreadable: true };
    }
    try {
      plain = await decrypt(file.payload, settings.encryption_passphrase as string);
    } catch {
      logger.warn("Baseline", "The bookmark baseline won't decrypt with this passphrase; ignoring it");
      return { marker: null, unreadable: true };
    }
  }

  try {
    const value = JSON.parse(plain) as Partial<BaselineMarker>;
    if (typeof value.device_id !== "string" || !value.device_id.trim()
        || typeof value.at !== "string" || !value.at.trim()) {
      logger.warn("Baseline", "The bookmark baseline file has no device or time; ignoring it");
      return { marker: null, unreadable: true };
    }
    return {
      marker: {
        version: 1,
        device_id: value.device_id,
        ...(typeof value.device_label === "string" && value.device_label.trim()
          ? { device_label: value.device_label } : {}),
        ...(typeof value.checksum === "string" && value.checksum.trim()
          ? { checksum: value.checksum } : {}),
        at: value.at,
      },
      unreadable: false,
    };
  } catch {
    logger.warn("Baseline", "The bookmark baseline payload is not valid JSON; ignoring it");
    return { marker: null, unreadable: true };
  }
}

export async function writeBaselineMarker(
  backend: IBackend, settings: SyncSettings, marker: BaselineMarker,
): Promise<void> {
  const plain = JSON.stringify(marker);
  const useE2ee = e2eeActive(settings);
  const file: BaselineFile = {
    version: "1.0",
    encrypted: useE2ee,
    payload: useE2ee
      ? await encrypt(plain, settings.encryption_passphrase as string)
      : plain,
  };
  await backend.putFile(BASELINE_FILE, JSON.stringify(file));
}

export async function deleteBaselineMarker(backend: IBackend): Promise<void> {
  await backend.deleteFile(BASELINE_FILE);
}

// ─── Device-local cache and "already applied" record ────────────────────────

export async function getCachedBaseline(): Promise<BaselineMarker | null> {
  try {
    const r = await browser.storage.local.get(KEYS.BASELINE_CACHE);
    const v = r[KEYS.BASELINE_CACHE] as BaselineMarker | null | undefined;
    return v && typeof v.device_id === "string" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function setCachedBaseline(marker: BaselineMarker | null): Promise<void> {
  try {
    if (marker) await browser.storage.local.set({ [KEYS.BASELINE_CACHE]: marker });
    else await browser.storage.local.remove(KEYS.BASELINE_CACHE);
  } catch {
    // Display-only.
  }
}

export async function getAdoptedBaseline(): Promise<BaselineAdopted | null> {
  try {
    const r = await browser.storage.local.get(KEYS.BASELINE_ADOPTED);
    const v = r[KEYS.BASELINE_ADOPTED] as BaselineAdopted | null | undefined;
    return v && typeof v.device_id === "string" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function setAdoptedBaseline(value: BaselineAdopted | null): Promise<void> {
  try {
    if (value) await browser.storage.local.set({ [KEYS.BASELINE_ADOPTED]: value });
    else await browser.storage.local.remove(KEYS.BASELINE_ADOPTED);
  } catch {
    // The next cycle re-applies the same marker; replacement is idempotent.
  }
}
