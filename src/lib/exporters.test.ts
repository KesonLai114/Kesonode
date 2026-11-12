import { describe, it, expect } from "vitest";
import { exportResult, toNetscapeHtml, toRaindropCsv, toSelfContainedHtml } from "@/lib/exporters";
import type { SyncBookmark } from "@/lib/types";

function link(title: string, url: string, dateAdded = 1_700_000_000_000): SyncBookmark {
  return { id: `p-${url}`, parentId: null, title, url, dateAdded };
}

function folder(title: string, children: SyncBookmark[]): SyncBookmark {
  return { id: `f-${title}`, parentId: null, title, dateAdded: 1, children };
}

/** The exported payload shape: one virtual root whose children are the three roots. */
function tree(bar: SyncBookmark[]): SyncBookmark[] {
  return [
    {
      id: "0",
      parentId: null,
      title: "",
      dateAdded: 0,
      children: [
        folder("Bookmarks bar", bar),
        folder("Other bookmarks", [link("Other", "https://other.com/")]),
      ],
    },
  ];
}

describe("toNetscapeHtml", () => {
  it("writes the interchange preamble and one anchor per bookmark", () => {
    const html = toNetscapeHtml(tree([link("Example", "https://example.com/")]));
    const seconds = Math.floor(1_700_000_000_000 / 1000);

    expect(html.startsWith("<!DOCTYPE NETSCAPE-Bookmark-file-1>")).toBe(true);
    expect(html).toContain(`<A HREF="https://example.com/" ADD_DATE="${seconds}">Example</A>`);
    expect(html).toContain("<H3 ADD_DATE=\"0\">Bookmarks bar</H3>");
  });

  it("escapes titles, URLs and the document title", () => {
    const html = toNetscapeHtml(
      tree([link('A <b> & "quote"', "https://example.com/?a=1&b=2")]),
      'My <bookmarks> & "stuff"'
    );

    expect(html).toContain("<TITLE>My &lt;bookmarks&gt; &amp; &quot;stuff&quot;</TITLE>");
    expect(html).toContain("A &lt;b&gt; &amp; &quot;quote&quot;");
    expect(html).toContain('HREF="https://example.com/?a=1&amp;b=2"');
  });

  it("leaves out a URL the browser would execute", () => {
    const html = toNetscapeHtml(tree([link("Bad", "javascript:alert(1)"), link("Good", "https://good.com/")]));

    expect(html).not.toContain("javascript:");
    expect(html).toContain("https://good.com/");
  });
});

describe("toRaindropCsv", () => {
  it("writes the header Raindrop expects, with CRLF line endings", () => {
    const csv = toRaindropCsv(tree([link("Example", "https://example.com/")]));
    const rows = csv.split("\r\n");

    expect(rows[0]).toBe("title,url,folder,tags,created,notes");
    expect(rows).toHaveLength(3); // header + one link under the bar + one under "Other"
  });

  it("quotes cells containing commas, quotes or newlines", () => {
    const csv = toRaindropCsv(tree([link('A, "B"', "https://example.com/?a=1,2")]));

    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain('"https://example.com/?a=1,2"');
  });

  it("uses the full folder path and an ISO creation date", () => {
    const csv = toRaindropCsv(tree([folder("Work", [link("Docs", "https://docs.example/")])]));

    expect(csv).toContain("Docs,https://docs.example/,Bookmarks bar / Work,");
    expect(csv).toContain("2023-11-14T22:13:20.000Z");
  });

  it("leaves created empty rather than inventing today", () => {
    const csv = toRaindropCsv(tree([link("No date", "https://nodate.example/", 0)]));
    expect(csv).toContain("No date,https://nodate.example/,Bookmarks bar,,,");
  });

  it("skips unsafe URLs", () => {
    const csv = toRaindropCsv(tree([link("Bad", "data:text/html,<script>"), link("Good", "https://good.com/")]));
    expect(csv).not.toContain("data:text/html");
    expect(csv).toContain("https://good.com/");
  });

  it("prefixes spreadsheet formulas so an imported title cannot execute", () => {
    const csv = toRaindropCsv(
      tree([
        link("=1+1", "https://a.example/"),
        link("+cmd", "https://b.example/"),
        link("-2+3", "https://c.example/"),
        link("@SUM(A1)", "https://d.example/"),
      ])
    );

    expect(csv).toContain("'=1+1,https://a.example/");
    expect(csv).toContain("'+cmd,https://b.example/");
    expect(csv).toContain("'-2+3,https://c.example/");
    expect(csv).toContain("'@SUM(A1),https://d.example/");
  });
});

describe("toSelfContainedHtml", () => {
  const html = toSelfContainedHtml(tree([link("Example", "https://example.com/")]), {
    deviceLabel: "Laptop <work>",
    generatedAt: Date.UTC(2026, 0, 2),
  });

  it("is one file with no external script or stylesheet", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).toContain("<script>");
    expect(html).toContain('<input id="q"');
  });

  it("states the count, device and date without escaping bugs", () => {
    expect(html).toContain("2 bookmarks");
    expect(html).toContain("Laptop &lt;work&gt;");
    expect(html).toContain("2026-01-02");
  });

  it("drops empty folders and unsafe links", () => {
    const compact = toSelfContainedHtml([
      {
        id: "0",
        parentId: null,
        title: "",
        dateAdded: 0,
        children: [
          folder("Bar", [
            folder("Empty", []),
            link("Bad", "javascript:alert(1)"),
            link("Good", "https://good.com/"),
          ]),
        ],
      },
    ]);

    expect(compact).not.toContain("<summary>Empty</summary>");
    expect(compact).not.toContain("javascript:");
    expect(compact).toContain("https://good.com/");
  });
});

describe("exportResult", () => {
  it("names and types each format", () => {
    const netscape = exportResult("netscape", tree([]));
    const raindrop = exportResult("raindrop", tree([]));
    const view = exportResult("view", tree([]));

    expect(netscape.filename).toMatch(/^kesonode-bookmarks-\d{4}-\d{2}-\d{2}\.html$/);
    expect(netscape.mime).toBe("text/html");
    expect(raindrop.filename).toMatch(/^kesonode-bookmarks-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(raindrop.mime).toBe("text/csv");
    expect(view.filename).toMatch(/^kesonode-view-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it("carries the snapshot title into the read-only page", () => {
    expect(exportResult("view", tree([]), { title: "My archive" }).content).toContain("<h1>My archive</h1>");
  });
});
