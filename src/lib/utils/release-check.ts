/**
 * Manual "check for updates" against the project's GitHub Releases.
 *
 * This is deliberately NOT a background check: Kesonode has no telemetry, and a version
 * probe should only leave the device when the user presses the button. Nothing but the
 * request itself is sent — no settings, no device id, no storage address. The manifest
 * already grants `https://api.github.com/*` for the GitHub sync backend, so this needs no
 * new permission. A failed or blocked request is expected in some networks; the UI falls
 * back to "import the zip you already downloaded" instead of treating it as an error state
 * the user must resolve.
 */

import type { PackageTarget } from "@/lib/utils/upgrade-package";

export const RELEASE_REPO = "KesonLai114/Kesonode";
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
export const RELEASE_PAGE = `https://github.com/${RELEASE_REPO}/releases/latest`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface LatestRelease {
  version: string;
  pageUrl: string;
  downloadUrl: string | null;
  assetName: string | null;
  publishedAt: string | null;
}

/** `v1.5.18` → `1.5.18`. Releases are tagged with the bare version in some tools. */
export function versionFromTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const version = tag.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
}

/** Pick the asset for the browser that is actually running. */
export function pickAsset(
  assets: unknown,
  target: PackageTarget
): ReleaseAsset | null {
  if (!Array.isArray(assets)) return null;
  const prefix = target === "firefox" ? "kesonode-firefox-" : "kesonode-chrome-";
  const typed = assets.filter(
    (a): a is ReleaseAsset =>
      typeof a?.name === "string" && typeof a?.browser_download_url === "string"
  );
  // `prefix` is one of two literals with no regex metacharacters, so it can be
  // interpolated as-is; only the version dots need escaping.
  const exact = new RegExp(`^${prefix}\\d+\\.\\d+\\.\\d+\\.zip$`);
  return (
    typed.find((a) => exact.test(a.name)) ??
    typed.find((a) => a.name.startsWith(prefix) && a.name.toLowerCase().endsWith(".zip")) ??
    null
  );
}

interface ReleasePayload {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function checkLatestRelease(
  target: PackageTarget,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<LatestRelease> {
  const response = await fetchImpl(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const payload = (await response.json()) as ReleasePayload;
  const version = versionFromTag(payload.tag_name);
  if (!version) throw new Error("Release tag is not a version");
  const asset = pickAsset(payload.assets, target);
  return {
    version,
    pageUrl: typeof payload.html_url === "string" ? payload.html_url : RELEASE_PAGE,
    downloadUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
  };
}
