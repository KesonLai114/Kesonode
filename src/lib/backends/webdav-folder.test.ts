import { describe, it, expect, afterEach, vi } from "vitest";
import { WebDAVBackend, forbiddenMessage } from "./webdav-backend";
import { HttpError } from "@/lib/utils/retry";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// ensureFolder only ever WARNED. So connect() went on to log "WebDAV connected" and Test
// connection reported success even when the sync folder had not been created — and every
// upload afterwards failed against a folder that wasn't there. It also waved a bare 301
// through as if it meant success.

const cfg: BackendConfig = {
  type: "webdav", label: "WebDAV", enabled: true,
  webdav: { url: "https://dav.example.com/dav/", username: "u", password: "p" },
};

async function auditText(): Promise<string> {
  await new Promise((r) => setTimeout(r, 0)); // logger fires appendAudit unawaited
  const r = await chrome.storage.local.get(KEYS.AUDIT_LOG);
  return JSON.stringify(r[KEYS.AUDIT_LOG] ?? []);
}

/** MKCOL answers `mkcol`; the follow-up PROPFIND answers `propfind`. */
function server(mkcol: number, propfind = 404, redirected = false): void {
  vi.stubGlobal("fetch", (_url: string, init?: { method?: string }) => {
    const status = init?.method === "PROPFIND" ? propfind : mkcol;
    return Promise.resolve({
      ok: status >= 200 && status < 300, status, redirected,
      text: () => Promise.resolve(""),
    } as Response);
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("WebDAV: ensuring the sync folder exists", () => {
  it("connects when MKCOL creates it", async () => {
    server(201);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("connects when the folder is already there (405)", async () => {
    server(405);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("does NOT report a successful connection when the folder couldn't be created", async () => {
    server(403, 404); // may not create it, and it isn't there
    await expect(new WebDAVBackend(cfg).connect()).rejects.toThrow(/sync folder/);
  });

  it("accepts a refused MKCOL when the folder does in fact exist", async () => {
    // A 403 can mean "you may not create collections here" on a path that already exists,
    // so the status alone can't decide it — ask the server instead of guessing.
    server(403, 207);
    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();
  });

  it("treats a bare 301 as a failure, not as success", async () => {
    // fetch follows redirects by default, so a 301 only reaches us when it could NOT be
    // followed — which is a failure. It used to be listed alongside 405 as "fine".
    server(301, 404);
    await expect(new WebDAVBackend(cfg).connect()).rejects.toThrow(/301/);
  });

  it("warns when the configured URL redirects, and still connects", async () => {
    // Plenty of servers and proxies drop the Authorization header across a redirect, which
    // surfaces later as a 401 on a password that is perfectly correct.
    server(201, 207, true);

    await expect(new WebDAVBackend(cfg).connect()).resolves.toBeUndefined();

    const log = await auditText();
    expect(log).toContain("redirects");
    expect(log).toContain("dav.example.com");
    expect(log).not.toContain("://u:"); // never the credentials
  });
});

describe("WebDAV: what a 403 says", () => {
  // Nutstore answers its WebDAV frequency limit with 403 rather than 429, so it reached a
  // QuarkPC user as a bare "WebDAV GET failed: 403" every sync, with nothing to act on.
  it("names the frequency limit on Nutstore hosts", () => {
    const msg = forbiddenMessage("dav.jianguoyun.com");
    expect(msg).toContain("600 requests per 30 minutes");
    expect(msg).toContain("dav.jianguoyun.com");
    expect(forbiddenMessage("dav.nutstore.com")).toContain("600");
  });

  it("points other servers at the path and the account's rights", () => {
    const msg = forbiddenMessage("dav.example.com");
    expect(msg).not.toContain("600");
    expect(msg).toContain("dav.example.com");
  });

  it("a 403 from GET carries the explanation instead of a bare status", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve({ ok: false, status: 403 } as Response));
    const nutstore: BackendConfig = {
      type: "webdav", label: "WebDAV", enabled: true,
      webdav: { url: "https://dav.jianguoyun.com/dav/", username: "u", password: "p" },
    };
    await expect(new WebDAVBackend(nutstore).getFile("x.json")).rejects.toThrow(/Forbidden \(403\)/);
    await expect(new WebDAVBackend(nutstore).getFile("x.json")).rejects.toThrow(/Sync interval/);
  });
});

describe("WebDAV: a metered MKCOL is a rate limit, not a wrong path", () => {
  // A field report (2026-11-10) showed `MKCOL 503` once a minute for six minutes against
  // Nutstore, each time as "Check the path and that the account may write to it" — a path
  // and a permission that were both fine. Nutstore answers a spent window with 503 on some
  // methods rather than its usual 403, so it was wrong twice: the advice was wrong, and
  // nothing parked the sync, which is how the window stayed spent.
  const NUTSTORE: BackendConfig = {
    ...cfg,
    webdav: { url: "https://dav.jianguoyun.com/dav/", username: "u", password: "p" },
  };

  it("flags Nutstore's 503 so automatic sync parks instead of retrying every minute", async () => {
    server(503, 503);
    const backend = new WebDAVBackend(NUTSTORE);

    const err = await backend.connect().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).rateLimited).toBe(true);
    expect(backend.rateLimited).toBe(true);
    expect((err as Error).message).toContain("600 requests");
    expect((err as Error).message).not.toContain("Check the path");
  });

  it("keeps the path advice for a store that merely had a bad moment", async () => {
    server(503, 503);
    const backend = new WebDAVBackend(cfg);

    const err = await backend.connect().catch((e: unknown) => e);

    // Not every 503 is a meter. Parking a self-hosted NAS for 30 minutes on one bad
    // moment would be worse than the retry it replaces.
    expect((err as HttpError).rateLimited).toBe(false);
    expect(backend.rateLimited).toBe(false);
    expect((err as Error).message).toContain("Check the path");
  });
});
