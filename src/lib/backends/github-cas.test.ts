import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubBackend } from "@/lib/backends/github-backend";
import { HttpError } from "@/lib/utils/retry";
import type { BackendConfig } from "@/lib/types";

// GitHub is where restore points are written conditionally, and the only backend whose
// folder and branch are free text. A raw `${path}` in the URL turned a configured space
// or `#` into a different request than the one meant, so the folder read as empty and a
// restore point as missing.
const backend = (over: Partial<BackendConfig["github"]> = {}, label = "GitHub") =>
  new GitHubBackend({
    type: "github", label, enabled: true,
    github: { token: "ghp_test", repo: "owner/repo", branch: "main", path: "konode", ...over },
  } as BackendConfig);

interface Call { url: string; method: string; body?: Record<string, unknown> }

/** Answer the repo check, then script the call under test. */
function stubFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), method: init.method ?? "GET" };
    if (init.body) call.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(call);
    if (new URL(String(url)).pathname === "/repos/owner/repo") {
      return Promise.resolve(json({ private: true, default_branch: "main" }));
    }
    return Promise.resolve(answer(call));
  });
  return calls;
}

const json = (body: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(),
  json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)),
} as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

describe("GitHub folder and branch names reach the right URL", () => {
  it("encodes every folder segment and the branch", async () => {
    const calls = stubFetch((call) => (call.method === "PUT" ? json({}) : json([])));

    await backend({ path: "sync dir/#1", branch: "release/2026 #1" }).listFiles("konode_");

    const list = calls.at(-1)!;
    expect(list.method).toBe("GET");
    expect(list.url).toBe(
      "https://api.github.com/repos/owner/repo/contents/sync%20dir/%231?ref=release%2F2026%20%231"
    );
  });

  it("encodes the file name as well, including a restore point's", async () => {
    const calls = stubFetch(() => json({}));

    await backend({ path: "a b" }).putFileIfVersion("konode_snap_kept_1.json", "{}", "sha-old");

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/owner/repo",
      "https://api.github.com/repos/owner/repo/contents/a%20b/konode_snap_kept_1.json",
    ]);
    expect(calls.at(-1)!.body).toMatchObject({ sha: "sha-old", branch: "main" });
  });
});

describe("GitHub refuses a conditional write without hiding a real failure", () => {
  const put = async (status: number, version: string | null) => {
    stubFetch((call) => (call.method === "PUT" ? json({ message: "refused" }, status) : json({ sha: "sha-old" })));
    return backend().putFileIfVersion("konode_snap_index.json", "{}", version);
  };

  it("reports a lost race on 409", async () => {
    await expect(put(409, "sha-old")).resolves.toBe(false);
  });

  it("reports a lost race on 422 when no sha was named (the file appeared since we looked)", async () => {
    await expect(put(422, null)).resolves.toBe(false);
  });

  it("surfaces a 422 that a re-read cannot fix instead of retrying it as a race", async () => {
    // Content too large, bad encoding, protected branch: none of them change when the
    // caller re-reads the index, and returning false made them look like contention.
    const err = await put(422, "sha-old").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
  });
});
