import { describe, it, expect } from "vitest";
import {
  MAX_SEARCH_RESULTS,
  escapeOmniboxText,
  omniboxSuggestions,
  searchDocs,
  type SearchDoc,
} from "@/lib/search";

function doc(over: Partial<SearchDoc> & Pick<SearchDoc, "title" | "url">): SearchDoc {
  return { source: "bookmark", ...over };
}

describe("searchDocs", () => {
  it("matches title, URL, host and folder", () => {
    const docs = [
      doc({ title: "Rust book", url: "https://doc.rust-lang.org/book/", folder: "bar / Reading" }),
      doc({ title: "Shopping", url: "https://shop.example.com/", folder: "bar" }),
    ];

    expect(searchDocs(docs, "rust").map((h) => h.title)).toEqual(["Rust book"]);
    expect(searchDocs(docs, "example").map((h) => h.title)).toEqual(["Shopping"]);
    expect(searchDocs(docs, "reading").map((h) => h.title)).toEqual(["Rust book"]);
    expect(searchDocs(docs, "shop").map((h) => h.title)).toEqual(["Shopping"]);
  });

  it("requires every term, so extra words narrow the result", () => {
    const docs = [doc({ title: "Rust book", url: "https://rust-lang.org/" })];

    expect(searchDocs(docs, "rust book")).toHaveLength(1);
    expect(searchDocs(docs, "rust python")).toEqual([]);
  });

  it("ignores one-letter terms instead of matching everything", () => {
    const docs = [doc({ title: "A", url: "https://a.com/" })];

    expect(searchDocs(docs, "a")).toEqual([]);
    expect(searchDocs(docs, " a ")).toEqual([]);
  });

  it("drops a duplicate URL inside one source but keeps the source distinct", () => {
    const docs = [
      doc({ title: "First", url: "https://dup.com/" }),
      doc({ title: "Second", url: "https://dup.com" }),
      doc({ title: "Visit", url: "https://dup.com/", source: "history" }),
    ];

    const hits = searchDocs(docs, "dup");
    expect(hits.map((h) => `${h.source}:${h.title}`).sort()).toEqual([
      "bookmark:First",
      "history:Visit",
    ]);
  });

  it("falls back to the URL as the title, and skips rows with no URL", () => {
    const hits = searchDocs(
      [doc({ title: "", url: "https://untitled.example/" }), doc({ title: "No URL", url: "" })],
      "untitled"
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("https://untitled.example/");
  });

  it("keeps ids and folders only when the source has them", () => {
    const [hit] = searchDocs(
      [doc({ title: "Docs", url: "https://docs.example/", id: "42", folder: "bar / Work" })],
      "docs"
    );
    expect(hit).toMatchObject({ id: "42", folder: "bar / Work", source: "bookmark" });

    const [history] = searchDocs(
      [doc({ title: "Docs", url: "https://docs.example/", source: "history" })],
      "docs"
    );
    expect(history.id).toBeUndefined();
    expect(history.folder).toBeUndefined();
  });

  it("ranks a title prefix over a mid-title match", () => {
    const hits = searchDocs(
      [
        doc({ title: "The GitHub guide", url: "https://guide.example/" }),
        doc({ title: "GitHub", url: "https://github.example/" }),
      ],
      "github"
    );
    expect(hits[0].title).toBe("GitHub");
  });

  it("respects the limit and never returns more than the cap", () => {
    const docs = Array.from({ length: 40 }, (_, i) => doc({ title: `Item ${i}`, url: `https://i${i}.example/` }));
    expect(searchDocs(docs, "item", 5)).toHaveLength(5);
    expect(searchDocs(docs, "item").length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });
});

describe("omniboxSuggestions", () => {
  it("caps the address-bar list at six rows", () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc({ title: `Page ${i}`, url: `https://p${i}.example/` }));
    expect(omniboxSuggestions(docs, "page")).toHaveLength(6);
  });

  it("escapes the description because Chrome parses it as markup", () => {
    expect(escapeOmniboxText(`A & B <script> "x" 'y'`)).toBe(
      "A &amp; B &lt;script&gt; &quot;x&quot; &#39;y&#39;"
    );
  });
});
