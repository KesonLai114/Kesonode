import { describe, it, expect } from "vitest";
import {
  checkLatestRelease,
  pickAsset,
  versionFromTag,
  RELEASE_API,
  RELEASE_PAGE,
} from "@/lib/utils/release-check";

function response(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

const assets = [
  { name: "kesonode-chrome-1.5.19.zip", browser_download_url: "https://example.invalid/chrome.zip" },
  { name: "kesonode-firefox-1.5.19.zip", browser_download_url: "https://example.invalid/firefox.zip" },
  { name: "kesonode-chrome-1.5.19.zip.sha256", browser_download_url: "https://example.invalid/hash" },
];

describe("versionFromTag", () => {
  it("strips a leading v and accepts only real release versions", () => {
    expect(versionFromTag("v1.5.19")).toBe("1.5.19");
    expect(versionFromTag("1.5.19")).toBe("1.5.19");
    expect(versionFromTag(" v1.5.18 ")).toBe("1.5.18");
    expect(versionFromTag("latest")).toBeNull();
    expect(versionFromTag(undefined)).toBeNull();
  });
});

describe("pickAsset", () => {
  it("picks the package for the running browser", () => {
    expect(pickAsset(assets, "chromium")?.name).toBe("kesonode-chrome-1.5.19.zip");
    expect(pickAsset(assets, "firefox")?.name).toBe("kesonode-firefox-1.5.19.zip");
  });

  it("ignores checksum sidecars and malformed entries", () => {
    expect(pickAsset([{ name: "kesonode-chrome-1.5.19.zip.sha256", browser_download_url: "x" }], "chromium")).toBeNull();
    expect(pickAsset([{ name: "kesonode-chrome-1.5.19.zip" }], "chromium")).toBeNull();
    expect(pickAsset(null, "chromium")).toBeNull();
  });

  it("still finds an unversioned package name", () => {
    const loose = [{ name: "kesonode-chrome-custom.zip", browser_download_url: "x" }];
    expect(pickAsset(loose, "chromium")?.browser_download_url).toBe("x");
  });
});

describe("checkLatestRelease", () => {
  it("reads the latest release and asks GitHub for no stored data", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await checkLatestRelease("chromium", async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return response({
        tag_name: "v1.5.19",
        html_url: "https://github.com/KesonLai114/Kesonode/releases/tag/v1.5.19",
        published_at: "2026-11-12T00:00:00Z",
        assets,
      });
    });
    expect(seenUrl).toBe(RELEASE_API);
    expect(seenInit?.cache).toBe("no-store");
    expect(result).toEqual({
      version: "1.5.19",
      pageUrl: "https://github.com/KesonLai114/Kesonode/releases/tag/v1.5.19",
      downloadUrl: "https://example.invalid/chrome.zip",
      assetName: "kesonode-chrome-1.5.19.zip",
      publishedAt: "2026-11-12T00:00:00Z",
    });
  });

  it("falls back to the releases page and a null download when data is missing", async () => {
    const result = await checkLatestRelease("firefox", async () =>
      response({ tag_name: "1.5.19", assets: [] })
    );
    expect(result.pageUrl).toBe(RELEASE_PAGE);
    expect(result.downloadUrl).toBeNull();
    expect(result.assetName).toBeNull();
  });

  it("fails cleanly on a blocked network or an unexpected tag", async () => {
    await expect(
      checkLatestRelease("chromium", async () => response({}, 403))
    ).rejects.toThrow("GitHub answered 403");
    await expect(
      checkLatestRelease("chromium", async () => response({ tag_name: "nightly" }))
    ).rejects.toThrow("Release tag is not a version");
  });
});
