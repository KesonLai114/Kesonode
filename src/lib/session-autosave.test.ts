import { describe, it, expect } from "vitest";
import {
  MAX_AUTOSAVED_SESSIONS,
  autosavedFrom,
  rememberAutosave,
  searchAutosaved,
} from "@/lib/session-autosave";
import type { AutosavedSession, SyncSession } from "@/lib/types";

function session(urls: string[], label?: string): SyncSession {
  return {
    id: "s",
    device_id: "dev",
    savedAt: "2026-01-01T00:00:00.000Z",
    ...(label ? { label } : {}),
    tabs: urls.map((url, i) => ({ url, title: `Tab ${i}`, pinned: i === 0 })),
  };
}

describe("autosavedFrom", () => {
  it("canonicalizes URLs, so a trailing slash is not a different window", () => {
    const a = autosavedFrom(session(["https://a.com"]), 1000);
    const b = autosavedFrom(session(["https://a.com/"]), 2000);

    expect(a.signature).toBe(b.signature);
    expect(a.tabs[0].url).toBe("https://a.com"); // stored as the browser gave it
  });

  it("keeps the label and pinned flags but drops a copy of the whole session", () => {
    const saved = autosavedFrom(session(["https://a.com"], "Work"), 1000);

    expect(saved).toMatchObject({
      label: "Work",
      saved_at: new Date(1000).toISOString(),
      tabs: [{ url: "https://a.com", title: "Tab 0", pinned: true }],
    });
    expect(saved).not.toHaveProperty("device_id");
  });
});

describe("rememberAutosave", () => {
  it("puts the newest window first", () => {
    const older = rememberAutosave([], session(["https://a.com"]), 1000);
    const newer = rememberAutosave(older, session(["https://b.com"]), 2000);

    expect(newer.map((s) => s.tabs[0].url)).toEqual(["https://b.com", "https://a.com"]);
  });

  it("refreshes an unchanged window instead of adding a duplicate row", () => {
    const first = rememberAutosave([], session(["https://a.com"]), 1000);
    const again = rememberAutosave(first, session(["https://a.com/"]), 2000);

    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(first[0].id);
    expect(again[0].saved_at).toBe(new Date(2000).toISOString());
    expect(again[0].tabs).toEqual(first[0].tabs);
  });

  it("moves an unchanged window back to the front so recency is real", () => {
    let ring = rememberAutosave([], session(["https://a.com"]), 1000);
    ring = rememberAutosave(ring, session(["https://b.com"]), 2000);
    ring = rememberAutosave(ring, session(["https://a.com/"]), 3000);

    expect(ring.map((s) => s.tabs[0].url)).toEqual(["https://a.com", "https://b.com"]);
    expect(ring[0].saved_at).toBe(new Date(3000).toISOString());
  });

  it("ignores an empty window", () => {
    const current: AutosavedSession[] = [];
    expect(rememberAutosave(current, session([]), 1000)).toBe(current);
  });

  it("keeps the ring bounded, evicting the oldest", () => {
    let ring: AutosavedSession[] = [];
    for (let i = 0; i < MAX_AUTOSAVED_SESSIONS + 5; i++) {
      ring = rememberAutosave(ring, session([`https://${i}.example/`]), 1000 + i);
    }

    expect(ring).toHaveLength(MAX_AUTOSAVED_SESSIONS);
    expect(ring[0].tabs[0].url).toBe(`https://${MAX_AUTOSAVED_SESSIONS + 4}.example/`);
    expect(ring.at(-1)?.tabs[0].url).toBe("https://5.example/");
  });
});

describe("searchAutosaved", () => {
  const list = rememberAutosave(
    rememberAutosave([], session(["https://github.com/", "https://docs.example/"], "Work"), 2000),
    session(["https://news.example/"], "Evening"),
    1000
  );

  it("returns everything for a one-letter or empty query", () => {
    expect(searchAutosaved(list, "")).toBe(list);
    expect(searchAutosaved(list, "a")).toBe(list);
  });

  it("matches on the label, tab titles and URLs", () => {
    expect(searchAutosaved(list, "work")).toHaveLength(1);
    expect(searchAutosaved(list, "github")).toHaveLength(1);
    expect(searchAutosaved(list, "tab 0")).toHaveLength(2);
  });

  it("requires every term", () => {
    expect(searchAutosaved(list, "work github")).toHaveLength(1);
    expect(searchAutosaved(list, "work news")).toEqual([]);
  });
});
