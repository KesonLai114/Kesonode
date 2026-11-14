import { describe, expect, it, vi } from "vitest";
import {
  AiError,
  aiEndpoint,
  aiOrigin,
  askBookmarks,
  callModel,
  candidatePool,
  CANDIDATE_BATCH,
  explainSync,
  parseModelJson,
  planRemovals,
  questionTerms,
  rankCandidates,
  renderAiBookmarkList,
  sanitizeAiBookmarks,
  suggestOrganization,
  syncExplanationContext,
  toAiBookmarks,
  type AiBookmark,
  type AiConfig,
  type AiDuplicateGroup,
} from "@/lib/ai-assistant";
import type { FlatBookmark } from "@/lib/handlers/reading-list-handler";
import type { SyncState } from "@/lib/types";

const CONFIG: AiConfig = {
  enabled: true,
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  model: "test-model",
};

function chat(text: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function flat(id: string, url: string, title = `Page ${id}`): FlatBookmark {
  return { id, title, url, folder: "Bookmarks bar / Work", dateAdded: 1 };
}

const BOOKMARKS: AiBookmark[] = [
  { id: "a", title: "WebDAV guide", host: "example.com", folder: "Work" },
  { id: "b", title: "Recipe", host: "cook.example", folder: "Personal" },
];

describe("endpoint handling", () => {
  it("builds a chat-completions URL from a base URL", () => {
    expect(aiEndpoint("https://api.example.com/v1")).toBe("https://api.example.com/v1/chat/completions");
    expect(aiEndpoint(" https://api.example.com/v1/ ")).toBe("https://api.example.com/v1/chat/completions");
  });

  it("accepts an explicit endpoint and strips query/hash", () => {
    expect(aiEndpoint("https://api.example.com/v1/chat/completions?x=1#f"))
      .toBe("https://api.example.com/v1/chat/completions");
  });

  it("refuses plaintext off loopback, non-http schemes and embedded credentials", () => {
    expect(aiEndpoint("http://api.example.com/v1")).toBeNull();
    expect(aiEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434/v1/chat/completions");
    expect(aiEndpoint("ftp://api.example.com/v1")).toBeNull();
    expect(aiEndpoint("https://user:pass@api.example.com/v1")).toBeNull();
    expect(aiEndpoint("")).toBeNull();
  });

  it("derives the origin for the permission request", () => {
    expect(aiOrigin("https://api.example.com/v1/")).toBe("https://api.example.com");
    expect(aiOrigin("not a url")).toBeNull();
  });
});

describe("bookmark reduction", () => {
  it("keeps only title, host and folder — never the full URL", () => {
    const items = sanitizeAiBookmarks([
      flat("a", "https://example.com/docs?utm=source"),
      flat("b", "javascript:alert(1)"),
      flat("c", "https://example.com/cb#access_token=secret"),
      flat("d", "chrome://settings"),
      flat("e", "neo://kept/123"),
    ]);
    expect(items.map((i) => i.id)).toEqual(["a"]);
    expect(items[0].host).toBe("example.com");
    expect(JSON.stringify(items)).not.toContain("access_token");
    expect(JSON.stringify(items)).not.toContain("utm=source");
  });

  it("honours the ceiling", () => {
    const many = Array.from({ length: 10 }, (_, i) => flat(String(i), `https://e.com/${i}`));
    expect(sanitizeAiBookmarks(many, 3)).toHaveLength(3);
  });

  it("spends the ceiling on the newest bookmarks, not the tree's prefix", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...flat(String(i), `https://e.com/${i}`),
      dateAdded: i,
    }));
    expect(sanitizeAiBookmarks(many, 3).map((b) => b.id)).toEqual(["9", "8", "7"]);
  });

  it("renders a numbered list keyed by id", () => {
    const text = renderAiBookmarkList(BOOKMARKS);
    expect(text).toContain("1. [a] WebDAV guide | example.com | Work");
    expect(text).toContain("2. [b] Recipe");
  });
});

describe("untrusted model output", () => {
  it("extracts JSON from a code fence and leading chatter", () => {
    expect(parseModelJson<{ a: number }>("Sure!\n```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseModelJson<string[]>("Here you go: [\"x\"]")).toEqual(["x"]);
  });

  it("returns null for malformed output instead of throwing", () => {
    expect(parseModelJson("no json here")).toBeNull();
    expect(parseModelJson("{\"broken\":")).toBeNull();
  });
});

describe("callModel", () => {
  it("sends the minimal non-streaming shape with the key only in the header", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => chat("ok"));
    await callModel(CONFIG, [{ role: "user", content: "hi" }], { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
    // The key must never appear in the body or the URL.
    expect(init?.body).not.toContain("sk-test");
    expect(url).not.toContain("sk-test");
  });

  it("refuses to run when disabled or configured badly", async () => {
    await expect(callModel({ ...CONFIG, enabled: false }, [], { fetchImpl: async () => chat("x") }))
      .rejects.toMatchObject({ code: "disabled" });
    await expect(callModel({ ...CONFIG, apiKey: "" }, [], { fetchImpl: async () => chat("x") }))
      .rejects.toMatchObject({ code: "config" });
  });

  it("classifies failures without echoing the provider's response body", async () => {
    const error = await callModel(CONFIG, [], { fetchImpl: async () => chat("leaked key: sk-test", 429) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("rate");
    expect((error as AiError).status).toBe(429);
    expect((error as Error).message).not.toContain("sk-test");
  });

  it("maps HTTP statuses to actionable codes", async () => {
    const cases: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "notfound"],
      [429, "rate"], [500, "provider"], [503, "provider"], [418, "http"],
    ];
    for (const [status, code] of cases) {
      const error = await callModel(CONFIG, [], { fetchImpl: async () => chat("x", status) })
        .catch((e: unknown) => e);
      expect((error as AiError).code, `status ${status}`).toBe(code);
      expect((error as AiError).status).toBe(status);
    }
  });

  it("tells a missing host permission apart from a network failure", async () => {
    const boom = async () => { throw new TypeError("Failed to fetch"); };
    const perms = chrome.permissions as { contains: (req: chrome.permissions.Permissions) => Promise<boolean> };
    const original = perms.contains;
    perms.contains = async () => false;
    await expect(callModel(CONFIG, [], { fetchImpl: boom }))
      .rejects.toMatchObject({ code: "permission" });
    perms.contains = async () => true;
    await expect(callModel(CONFIG, [], { fetchImpl: boom }))
      .rejects.toMatchObject({ code: "network" });
    perms.contains = original;
  });

  it("reports an empty answer and a timeout", async () => {
    await expect(callModel(CONFIG, [], { fetchImpl: async () => chat("") }))
      .rejects.toMatchObject({ code: "empty" });
    const never = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(callModel(CONFIG, [], { fetchImpl: never, timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "timeout" });
  });

  it("reports a user cancel separately from a timeout", async () => {
    const controller = new AbortController();
    const never = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = callModel(CONFIG, [], { fetchImpl: never, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("the three capabilities", () => {
  it("askBookmarks drops ids the model invented", async () => {
    const fetchImpl = vi.fn(async () => chat(
      '```json\n{"ids":["a","invented","b"],"explanation":"Two guides match."}\n```',
    ));
    const answer = await askBookmarks(CONFIG, "that WebDAV article", BOOKMARKS, { fetchImpl });
    expect(answer.ids).toEqual(["a", "b"]);
    expect(answer.explanation).toBe("Two guides match.");
  });

  it("suggestOrganization keeps only known ids and existing folders", async () => {
    const fetchImpl = vi.fn(async () => chat(JSON.stringify({
      moves: [
        { id: "a", folder: "Work", reason: "belongs here" },
        { id: "ghost", folder: "Work", reason: "no" },
        { id: "b", folder: "Made up folder", reason: "no" },
      ],
      duplicates: [
        { ids: ["a", "b"], reason: "same page" },
        { ids: ["a", "ghost"], reason: "no" },
      ],
    })));
    const plan = await suggestOrganization(CONFIG, BOOKMARKS, ["Work", "Personal"], { fetchImpl });
    expect(plan.moves).toEqual([{ id: "a", folder: "Work", reason: "belongs here" }]);
    expect(plan.duplicates).toEqual([{ ids: ["a", "b"], reason: "same page" }]);
  });

  it("explainSync returns one clipped line", async () => {
    const fetchImpl = vi.fn(async () => chat("Three bookmarks  were\nrenamed on the other device."));
    const text = await explainSync(CONFIG, "bookmarks: retitled 3", { fetchImpl });
    expect(text).toBe("Three bookmarks were renamed on the other device.");
  });

  it("syncExplanationContext redacts titles, URLs and device names", () => {
    const state = {
      sync_report: {
        at: "2026-11-13T00:00:00Z", duration_ms: 100,
        added: 2, removed: 1, total_before: 10, total_after: 11, dangerous: false,
        types: [{
          data_type: "bookmarks", peers: 1, local_before: 10, local_after: 11,
          added: 2, removed: 1, moved: 0, retitled: 0, uploaded: true, held: false,
          snapshot: "konode_snap_x",
          preview: {
            added: 2, removed: 1, moved: 0, local_total: 10, peer_total: 12,
            sample: [{ title: "SECRET TITLE", url: "https://secret.example/p?token=abc" }],
          },
        }],
      },
      pending_conflicts: [{
        id: "c1", data_type: "bookmarks", device_id: "d1", device_label: "Laptop",
      }],
    } as unknown as SyncState;
    const receipt = syncExplanationContext(state, "receipt");
    expect(receipt).toContain("bookmarks");
    expect(receipt).toContain("has_restore_point");
    expect(receipt).not.toContain("SECRET TITLE");
    expect(receipt).not.toContain("secret.example");
    expect(receipt).not.toContain("token=abc");
    expect(receipt).not.toContain("konode_snap_x");
    const conflict = syncExplanationContext(state, "conflict");
    expect(conflict).toContain("1 conflicts");
    expect(conflict).not.toContain("Laptop");
    expect(syncExplanationContext(null, "receipt")).toBe("");
  });
});

describe("output limits and plan selection", () => {
  it("caps a long question instead of silently keeping all of it", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => chat('{"ids":[],"explanation":"none"}'));
    await askBookmarks(CONFIG, "q".repeat(600), BOOKMARKS, { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) as { messages: { content: string }[] };
    const user = body.messages[1].content;
    expect(user).toContain("q".repeat(500) + "…");
    expect(user).not.toContain("q".repeat(501));
  });

  it("keeps a three-sentence sync explanation intact up to its own cap", async () => {
    const long = "word ".repeat(60).trim(); // 299 chars: far past a title's 120, under 400
    const fetchImpl = vi.fn(async () => chat(long));
    expect(await explainSync(CONFIG, "bookmarks: retitled 3", { fetchImpl })).toBe(long);
  });

  it("gives the organisation plan a larger output budget than a search", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => chat(JSON.stringify({ moves: [], duplicates: [] })));
    await suggestOrganization(CONFIG, BOOKMARKS, ["Work"], { fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) as { max_tokens: number };
    expect(body.max_tokens).toBeGreaterThan(700);
  });

  it("matches a folder on the clipped form the model actually saw", async () => {
    const raw = "F".repeat(150);
    const clipped = "F".repeat(120) + "…";
    const fetchImpl = vi.fn(async () => chat(JSON.stringify({
      moves: [{ id: "a", folder: clipped, reason: "r" }],
      duplicates: [],
    })));
    const plan = await suggestOrganization(CONFIG, BOOKMARKS, [raw], { fetchImpl });
    expect(plan.moves).toEqual([{ id: "a", folder: clipped, reason: "r" }]);
  });

  it("planRemovals never deletes a keeper chosen in another selected group", () => {
    const groups: AiDuplicateGroup[] = [
      { ids: ["1", "2"], reason: "a" },
      { ids: ["2", "3"], reason: "b" },
    ];
    const selected = new Set(["1|2", "2|3"]);
    // Group two keeps "2", which group one would otherwise delete.
    const keepers = new Map([["2|3", "2"]]);
    expect(planRemovals(groups, selected, keepers).sort()).toEqual(["3"]);
  });

  it("planRemovals honours a custom keeper and ignores unselected groups", () => {
    const groups: AiDuplicateGroup[] = [
      { ids: ["1", "2", "3"], reason: "a" },
      { ids: ["4", "5"], reason: "b" },
    ];
    const selected = new Set(["1|2|3"]);
    const keepers = new Map([["1|2|3", "3"]]);
    expect(planRemovals(groups, selected, keepers).sort()).toEqual(["1", "2"]);
  });

  it("planRemovals falls back to the first id for an unknown keeper", () => {
    const groups: AiDuplicateGroup[] = [{ ids: ["1", "2"], reason: "a" }];
    const selected = new Set(["1|2"]);
    const keepers = new Map([["1|2", "ghost"]]);
    expect(planRemovals(groups, selected, keepers)).toEqual(["2"]);
  });
});

describe("choosing the candidates on this device", () => {
  const ITEMS: AiBookmark[] = [
    { id: "a", title: "WebDAV guide", host: "example.com", folder: "Work", added: 1 },
    { id: "b", title: "Recipe", host: "cook.example", folder: "Personal", added: 2 },
    { id: "c", title: "自建笔记", host: "notes.example", folder: "Personal", added: 3 },
  ];

  it("keeps latin words whole and breaks CJK runs into pairs", () => {
    expect(questionTerms("WebDAV setup")).toContain("webdav");
    expect(questionTerms("那个讲自建 WebDAV 的教程")).toContain("自建");
    expect(questionTerms("that WebDAV one")).toContain("that");
    // A single latin letter is not a term; a single CJK character is.
    expect(questionTerms("a")).toEqual([]);
    expect(questionTerms("书")).toEqual(["书"]);
  });

  it("ranks the literal matches first and leaves the rest out", () => {
    expect(rankCandidates("webdav", ITEMS, 10).map((b) => b.id)).toEqual(["a"]);
    expect(rankCandidates("自建", ITEMS, 10).map((b) => b.id)).toEqual(["c"]);
    expect(rankCandidates("nothing in here", ITEMS, 10)).toEqual([]);
  });

  it("fills the rest of the pool with the most recently added bookmarks", () => {
    const pool = candidatePool("webdav", ITEMS, 2);
    expect(pool).toHaveLength(2);
    expect(pool[0].id).toBe("a");
    expect(pool[1].added).toBe(3);
  });

  it("keeps every entry until the caller applies a ceiling", () => {
    const many = Array.from({ length: 5 }, (_, i) => flat(String(i), `https://e.com/${i}`));
    expect(toAiBookmarks(many)).toHaveLength(5);
    expect(sanitizeAiBookmarks(many, 3)).toHaveLength(3);
  });
});

describe("asking in batches", () => {
  const many: AiBookmark[] = Array.from({ length: CANDIDATE_BATCH + 2 }, (_, i) => ({
    id: `b${i}`,
    title: `Page ${i}`,
    host: `e${i}.example`,
    folder: "Work",
    added: i,
  }));

  it("looks at a second batch when the first one comes back empty", async () => {
    const fetchImpl = vi.fn(async () => chat('{"ids":[],"explanation":"nothing here"}'));
    const answer = await askBookmarks(CONFIG, "something", many, { fetchImpl });
    expect(answer.ids).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("accepts an id from the batch it was offered", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(chat('{"ids":[],"explanation":"nothing here"}'))
      .mockResolvedValueOnce(chat('{"ids":["b60"],"explanation":"found it"}'));
    const answer = await askBookmarks(CONFIG, "something", many, { fetchImpl });
    expect(answer.ids).toEqual(["b60"]);
    expect(answer.explanation).toBe("found it");
  });

  it("never accepts an id that was not offered", async () => {
    const fetchImpl = vi.fn(async () => chat('{"ids":["not-in-the-list"],"explanation":"sure"}'));
    const answer = await askBookmarks(CONFIG, "something", many, { fetchImpl });
    expect(answer.ids).toEqual([]);
  });
});
