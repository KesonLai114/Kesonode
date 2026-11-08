import { describe, it, expect } from "vitest";
import { isSafeContentUrl, isSafeBookmarkUrl, isSecureBackendUrl, isSensitiveUrl } from "@/lib/utils/url";

describe("isSafeContentUrl", () => {
  it("allows web URLs and Norton Neo's kept form (chrome://newtab/ kept as neo://newtab/, #41)", () => {
    expect(isSafeContentUrl("https://example.com/page")).toBe(true);
    expect(isSafeContentUrl("http://example.com")).toBe(true);
    expect(isSafeContentUrl("neo://newtab/")).toBe(true);
  });
  it("rejects injection, local-file and browser-internal schemes", () => {
    expect(isSafeContentUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeContentUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeContentUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeContentUrl("chrome://settings")).toBe(false);
    expect(isSafeContentUrl("about:blank")).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(isSafeContentUrl("")).toBe(false);
    expect(isSafeContentUrl(undefined)).toBe(false);
    expect(isSafeContentUrl("not a url")).toBe(false);
  });
});

describe("isSafeBookmarkUrl", () => {
  it("allows web, browser-internal and Norton Neo's kept form (#41)", () => {
    expect(isSafeBookmarkUrl("https://example.com/page")).toBe(true);
    expect(isSafeBookmarkUrl("http://example.com")).toBe(true);
    expect(isSafeBookmarkUrl("chrome://newtab/")).toBe(true); // #41: kept as neo://
    expect(isSafeBookmarkUrl("neo://newtab/")).toBe(true);
    expect(isSafeBookmarkUrl("about:blank")).toBe(true);
    expect(isSafeBookmarkUrl("chrome-extension://abc/panel.html")).toBe(true);
  });
  it("rejects script / data / local-file schemes", () => {
    expect(isSafeBookmarkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeBookmarkUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeBookmarkUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isSafeBookmarkUrl("blob:https://x/abc")).toBe(false);
    expect(isSafeBookmarkUrl("file:///etc/passwd")).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(isSafeBookmarkUrl("")).toBe(false);
    expect(isSafeBookmarkUrl(undefined)).toBe(false);
    expect(isSafeBookmarkUrl("not a url")).toBe(false);
  });
});

describe("isSensitiveUrl", () => {
  it("flags an OAuth token in the fragment (the sopronfest callback case)", () => {
    expect(isSensitiveUrl("https://sopronfest.hu/account/callback#access_token=eyJhbGciOiJ")).toBe(true);
  });
  it("flags token-bearing query params", () => {
    expect(isSensitiveUrl("https://x.com/cb?id_token=abc")).toBe(true);
    expect(isSensitiveUrl("https://x.com/reset?token=abc123")).toBe(true);
    expect(isSensitiveUrl("https://x.com/?refresh_token=z")).toBe(true);
    expect(isSensitiveUrl("https://x.com/login?password=hunter2")).toBe(true);
  });
  it("does NOT flag ordinary URLs (no over-filtering)", () => {
    expect(isSensitiveUrl("https://telex.hu/belfold/2026/07/21/cikk")).toBe(false);
    expect(isSensitiveUrl("https://shop.com/list?code=US&sort=price")).toBe(false); // discount/country code
    expect(isSensitiveUrl("https://example.com/page")).toBe(false);
    expect(isSensitiveUrl(undefined)).toBe(false);
    expect(isSensitiveUrl("not a url")).toBe(false);
  });
});

describe("isSecureBackendUrl", () => {
  it("allows https", () => {
    expect(isSecureBackendUrl("https://cloud.example.com/remote.php/dav")).toBe(true);
  });
  it("allows http only for loopback hosts", () => {
    expect(isSecureBackendUrl("http://localhost:8080/dav")).toBe(true);
    expect(isSecureBackendUrl("http://127.0.0.1/dav")).toBe(true);
    expect(isSecureBackendUrl("http://[::1]:5000/dav")).toBe(true);
  });
  it("rejects http to any non-loopback host", () => {
    expect(isSecureBackendUrl("http://cloud.example.com/dav")).toBe(false);
    expect(isSecureBackendUrl("http://192.168.1.10/dav")).toBe(false);
  });
  it("rejects empty / malformed input", () => {
    expect(isSecureBackendUrl("")).toBe(false);
    expect(isSecureBackendUrl(undefined)).toBe(false);
  });
});
