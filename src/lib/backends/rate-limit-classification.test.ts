import { describe, it, expect, afterEach, vi } from "vitest";
import { GDriveBackend } from "./gdrive-backend";
import { GitHubBackend } from "./github-backend";
import { HttpError } from "@/lib/utils/retry";
import { KEYS } from "@/lib/utils/storage";
import type { BackendConfig } from "@/lib/types";

// A metered storage refuses for a WINDOW, not for one request. WebDAV learned that the hard
// way (Nutstore: 600 requests per 30 minutes, answered with 403 rather than 429), and the
// engine's response is to park automatic sync for the whole window. That response keys off
// `HttpError.rateLimited` / `backend.rateLimited`, and only WebDAV ever set them — so Drive
// and GitHub refusals came back as ordinary hard errors and were retried every interval,
// spending the next window's quota too.
//
// These are the two providers' real shapes:
//  - Drive: 403 with `error.errors[0].reason` (`rateLimitExceeded`, `quotaExceeded`), almost
//    never a 429, and a 403 for a genuinely forbidden folder looks identical otherwise.
//  - GitHub: 403 with `x-ratelimit-remaining: 0`, or `retry-after` for the secondary limit.

const driveCfg: BackendConfig = {
  type: "gdrive", label: "Google Drive", enabled: true, gdrive: { folderId: "pinned" },
};
const githubCfg: BackendConfig = {
  type: "github", label: "GitHub", enabled: true, github: { token: "t", repo: "owner/repo" },
};

/** A Drive failure response, with the reason in the body where Drive actually puts it. */
function driveFailure(status: number, reason?: string): Response {
  const body = reason ? { error: { errors: [{ reason }], message: reason } } : {};
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
    // `httpError` clones so a caller that still wants the body can read it.
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response;
}

/** A GitHub failure response, with whatever rate-limit headers the case needs. */
function githubFailure(status: number, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: () => Promise.resolve({ message: "" }),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

async function signInToDrive(): Promise<void> {
  await chrome.storage.local.set({
    [KEYS.GDRIVE_SESSION]: {
      access_token: "t", expires_at: Date.now() + 3_600_000,
      email: "", displayName: "", savedAt: Date.now(),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Drive — a quota 403 must park the sync, not repeat every minute", () => {
  it("flags a rateLimitExceeded 403 and says what to do about it", async () => {
    await signInToDrive();
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls++;
      return Promise.resolve(driveFailure(403, "rateLimitExceeded"));
    });
    const backend = new GDriveBackend(driveCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).rateLimited).toBe(true);
    expect((err as HttpError).status).toBe(403);
    expect(backend.rateLimited).toBe(true);
    expect((err as HttpError).message).toContain("Too many requests");
    expect(calls).toBe(1); // terminal: retrying spends the next window's quota
  });

  it("treats quotaExceeded the same way", async () => {
    await signInToDrive();
    vi.stubGlobal("fetch", () => Promise.resolve(driveFailure(403, "quotaExceeded")));
    const backend = new GDriveBackend(driveCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(true);
    expect(backend.rateLimited).toBe(true);
  });

  it("an empty Drive is not a rate limit, and says so in the words of the fix", async () => {
    await signInToDrive();
    vi.stubGlobal("fetch", () => Promise.resolve(driveFailure(403, "storageQuotaExceeded")));
    const backend = new GDriveBackend(driveCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(false);
    expect(backend.rateLimited).toBe(false);
    expect((err as HttpError).message).toContain("out of space");
  });

  it("a 403 with no reason stays an ordinary permission error", async () => {
    await signInToDrive();
    vi.stubGlobal("fetch", () => Promise.resolve(driveFailure(403)));
    const backend = new GDriveBackend(driveCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(false);
    expect(backend.rateLimited).toBe(false);
    expect((err as HttpError).message).toBe("Drive list failed: 403");
  });

  it("a 429 is a rate limit even without a reason", async () => {
    await signInToDrive();
    vi.stubGlobal("fetch", () => Promise.resolve(driveFailure(429)));
    const backend = new GDriveBackend(driveCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(true);
  });
});

describe("GitHub — the hourly and secondary limits arrive as 403", () => {
  it("flags x-ratelimit-remaining: 0", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(githubFailure(403, { "x-ratelimit-remaining": "0" })));
    const backend = new GitHubBackend(githubCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(true);
    expect(backend.rateLimited).toBe(true);
    expect((err as HttpError).message).toContain("Too many requests");
  });

  it("flags a secondary limit, which is only visible as retry-after", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(githubFailure(403, { "retry-after": "60" })));
    const backend = new GitHubBackend(githubCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(true);
  });

  it("a plain 403 (bad token scope, missing repo) is NOT a rate limit", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(githubFailure(403, { "x-ratelimit-remaining": "4231" })));
    const backend = new GitHubBackend(githubCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(false);
    expect(backend.rateLimited).toBe(false);
    expect((err as HttpError).message).toBe("GitHub list failed: 403");
  });

  it("a 429 counts without any header", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(githubFailure(429)));
    const backend = new GitHubBackend(githubCfg);

    const err = await backend.listFiles("konode_").catch((e) => e);

    expect((err as HttpError).rateLimited).toBe(true);
  });
});
