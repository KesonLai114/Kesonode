/**
 * What the OTHER devices are called, remembered on this device.
 *
 * A peer's name travels in the envelope of every sync packet, but the device list used
 * to depend on being able to download one of that peer's files AT THE MOMENT the page
 * opened. A WebDAV rate limit, a transient 500 or one unreadable file was enough for a
 * perfectly well-named machine to show up as "Unnamed device" — on both sides at once,
 * while bookmarks went on syncing normally. Worse, the loop gave up on the first file
 * that failed to read instead of trying the others.
 *
 * Every sync already downloads every peer's packet, so this keeps a small local copy of
 * `device_id → device_label` from that read. It is display-only: nothing keys off it, no
 * wire format changes, and a packet carrying a newer name always wins over the cache.
 * The cache never reaches the backend.
 */

import { browser } from "@/lib/utils/ext";
import { logger } from "@/lib/utils/logger";
import { cleanDeviceLabel } from "@/lib/utils/storage";
import type { DeviceBrowser } from "@/lib/types";

// A Kesonode-owned local key, deliberately NOT a `konode_*` one: the frozen upstream
// storage keys are wire-adjacent, this is a purely local display cache.
const KEY = "kesonode_peer_labels";
const MAX_DEVICES = 64;

interface PeerLabel {
  label: string;
  /** What the peer runs, from its own packets. Kept so the device list can show it
   *  without reading a file off the backend — which is the request that costs quota. */
  browser?: DeviceBrowser | null;
  at: number;
}

type PeerLabelMap = Record<string, PeerLabel>;

export async function readPeerLabels(): Promise<PeerLabelMap> {
  try {
    const r = await browser.storage.local.get(KEY);
    const raw = r[KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: PeerLabelMap = {};
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Partial<PeerLabel>;
      if (typeof rec.label === "string" && rec.label.trim()) {
        out[id] = {
          label: rec.label,
          browser: (rec.browser as DeviceBrowser | undefined) ?? null,
          at: typeof rec.at === "number" ? rec.at : 0,
        };
      }
    }
    return out;
  } catch (err) {
    logger.warn("peerLabels", `Could not read the local device-name cache: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * Learn names from packets we actually received. Called once per sync type and once
 * from the device list; a no-op when nothing changed, so an idle sync writes nothing.
 */
export async function rememberPeerLabels(
  packets: readonly {
    device_id?: string;
    device_label?: string | null;
    device_browser?: DeviceBrowser | null;
  }[],
): Promise<void> {
  const seen = new Map<string, { label: string; browser: DeviceBrowser | null }>();
  for (const p of packets) {
    const id = typeof p.device_id === "string" ? p.device_id : "";
    const raw = typeof p.device_label === "string" ? p.device_label.trim() : "";
    // Strip the `<browser> · <short id>` suffixes older builds glued onto the label, so a
    // peer's name is its OWN words too. Otherwise this cache would store
    // `Macbook · Edge · 451dbeb9` and every list that renders the id next to the name
    // would print `451dbeb9` twice.
    const label = raw ? cleanDeviceLabel(raw, id) : "";
    if (id && label) seen.set(id, { label, browser: p.device_browser ?? null });
  }
  if (seen.size === 0) return;

  const current = await readPeerLabels();
  let changed = false;
  for (const [id, entry] of seen) {
    if (current[id]?.label !== entry.label || (current[id]?.browser?.name ?? null) !== (entry.browser?.name ?? null)) {
      current[id] = { label: entry.label, browser: entry.browser, at: Date.now() };
      changed = true;
    }
  }
  if (!changed) return;

  const kept = Object.entries(current)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DEVICES);
  try {
    await browser.storage.local.set({ [KEY]: Object.fromEntries(kept) });
  } catch (err) {
    // Purely cosmetic: a name we cannot cache is one the list may have to re-read.
    logger.warn("peerLabels", `Could not save the local device-name cache: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Drop a device's cached name when its files are removed on purpose ("Forget").
 *
 * Without this the row comes back during a rate-limited window: the backend listing is
 * what normally decides which devices exist, and `knownDevices` falls back to this cache
 * when the listing is refused — naming a device the user just removed.
 */
export async function forgetPeerLabel(deviceId: string): Promise<void> {
  if (!deviceId) return;
  const current = await readPeerLabels();
  if (!(deviceId in current)) return;
  delete current[deviceId];
  try {
    await browser.storage.local.set({ [KEY]: current });
  } catch (err) {
    logger.warn("peerLabels", `Could not update the local device-name cache: ${err instanceof Error ? err.message : err}`);
  }
}
