import type { SyncBookmark } from "@/lib/types";
import { isSafeBookmarkUrl } from "@/lib/utils/url";

/**
 * Escape hatches. The sync is the product, but "get my data out in a form another program
 * understands" is what makes leaving safe, and safe leaving is what makes staying easy.
 *
 * Three formats, all generated locally from the tree in hand:
 *  - Netscape HTML, which every browser imports.
 *  - Raindrop CSV, which every bookmark manager imports.
 *  - A self-contained read-only HTML page for a phone or a shared link.
 */

export interface ExportResult {
  filename: string;
  mime: string;
  content: string;
}

function rootsOf(tree: SyncBookmark[]): SyncBookmark[] {
  return tree[0]?.children ?? tree;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function seconds(ms: number | undefined): number {
  return Math.max(0, Math.floor((ms ?? 0) / 1000));
}

function walkBookmarks(
  nodes: SyncBookmark[],
  path: string[],
  visit: (node: SyncBookmark, path: string[]) => void
): void {
  for (const node of nodes) {
    if (node.url) {
      if (isSafeBookmarkUrl(node.url)) visit(node, path);
    } else {
      walkBookmarks(node.children ?? [], [...path, node.title ?? ""], visit);
    }
  }
}

/** A Netscape bookmark file, the interchange format browsers have read since 1996. */
export function toNetscapeHtml(tree: SyncBookmark[], title = "Bookmarks"): string {
  const lines: string[] = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(title)}</TITLE>`,
    `<H1>${escapeHtml(title)}</H1>`,
    "<DL><p>",
  ];
  const emit = (nodes: SyncBookmark[], depth: number): void => {
    const pad = "    ".repeat(depth);
    for (const node of nodes) {
      if (node.url) {
        if (!isSafeBookmarkUrl(node.url)) continue;
        lines.push(
          `${pad}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${seconds(node.dateAdded)}">${escapeHtml(node.title ?? "")}</A>`
        );
      } else {
        lines.push(
          `${pad}<DT><H3 ADD_DATE="${seconds(node.dateAdded)}">${escapeHtml(node.title ?? "")}</H3>`,
          `${pad}<DL><p>`
        );
        emit(node.children ?? [], depth + 1);
        lines.push(`${pad}</DL><p>`);
      }
    }
  };
  emit(rootsOf(tree), 1);
  lines.push("</DL><p>");
  return lines.join("\n");
}

function csvCell(value: string): string {
  // A title is attacker-controlled data from someone else's browser. Cells starting
  // with one of these are executed as formulas by Excel and Sheets on import; a
  // leading apostrophe keeps them text in both.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Raindrop's CSV importer expects `title,url,folder,tags,created,notes`. `created` is an
 * ISO date; an absent one is left empty rather than faked with today.
 */
export function toRaindropCsv(tree: SyncBookmark[]): string {
  const rows: string[] = ["title,url,folder,tags,created,notes"];
  for (const root of rootsOf(tree)) {
    // Start INSIDE the root: its title is prepended below, so walking the root itself
    // would put "Bookmarks bar" in the folder path twice.
    walkBookmarks(root.children ?? [], [], (node, path) => {
      const created = node.dateAdded ? new Date(node.dateAdded).toISOString() : "";
      rows.push(
        [
          csvCell(node.title ?? ""),
          csvCell(node.url ?? ""),
          csvCell([root.title ?? "", ...path].filter(Boolean).join(" / ")),
          "",
          created,
          "",
        ].join(",")
      );
    });
  }
  return rows.join("\r\n");
}

export interface SelfContainedOptions {
  title?: string;
  deviceLabel?: string;
  generatedAt?: number;
}

/**
 * One HTML file with everything embedded: no scripts from anywhere else, no network
 * requests, no credentials. The search box filters the rendered list in place, which is
 * what makes it usable on a phone where the extension cannot be installed.
 */
export function toSelfContainedHtml(
  tree: SyncBookmark[],
  opts: SelfContainedOptions = {}
): string {
  const title = opts.title ?? "Kesonode bookmarks";
  const generated = new Date(opts.generatedAt ?? Date.now());
  let count = 0;
  const render = (nodes: SyncBookmark[]): string => {
    const items: string[] = [];
    for (const node of nodes) {
      if (node.url) {
        if (!isSafeBookmarkUrl(node.url)) continue;
        count++;
        items.push(
          `<li class="bm"><a href="${escapeHtml(node.url)}" rel="noreferrer noopener">${escapeHtml(node.title || node.url)}</a><span class="url">${escapeHtml(node.url)}</span></li>`
        );
      } else {
        const children = render(node.children ?? []);
        if (!children) continue;
        items.push(
          `<li class="folder"><details open><summary>${escapeHtml(node.title ?? "")}</summary><ul>${children}</ul></details></li>`
        );
      }
    }
    return items.join("\n");
  };
  const body = rootsOf(tree)
    .map((root) => `<section><h2>${escapeHtml(root.title ?? "")}</h2><ul>${render(root.children ?? [])}</ul></section>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0 auto; padding: 20px; max-width: 760px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .meta { color: #888; font-size: .85rem; margin-bottom: 16px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 1rem; border: 1px solid #aaa6; border-radius: 10px; margin-bottom: 18px; }
  h2 { font-size: 1.05rem; margin: 22px 0 6px; }
  ul { list-style: none; padding-left: 14px; margin: 4px 0; }
  li { margin: 6px 0; }
  summary { cursor: pointer; font-weight: 600; }
  a { text-decoration: none; }
  a:hover { text-decoration: underline; }
  .url { display: block; color: #888; font-size: .78rem; word-break: break-all; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="meta">${count} bookmarks${opts.deviceLabel ? ` · ${escapeHtml(opts.deviceLabel)}` : ""} · ${escapeHtml(generated.toISOString().slice(0, 10))} · read-only snapshot</div>
<input id="q" type="search" placeholder="Search bookmarks" aria-label="Search bookmarks">
<main id="list">
${body}
</main>
<script>
(function () {
  var q = document.getElementById('q');
  var list = document.getElementById('list');
  function filter() {
    var term = q.value.toLowerCase().trim();
    var items = list.querySelectorAll('li.bm');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var hit = !term || (el.textContent || '').toLowerCase().indexOf(term) !== -1;
      el.classList.toggle('hidden', !hit);
    }
    var folders = list.querySelectorAll('li.folder');
    for (var j = 0; j < folders.length; j++) {
      var folder = folders[j];
      var visible = folder.querySelector('li.bm:not(.hidden)');
      folder.classList.toggle('hidden', !!term && !visible);
    }
  }
  q.addEventListener('input', filter);
})();
</script>
</body>
</html>`;
}

export function exportResult(format: "netscape" | "raindrop" | "view", tree: SyncBookmark[], opts: SelfContainedOptions = {}): ExportResult {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "netscape") {
    return { filename: `kesonode-bookmarks-${stamp}.html`, mime: "text/html", content: toNetscapeHtml(tree) };
  }
  if (format === "raindrop") {
    return { filename: `kesonode-bookmarks-${stamp}.csv`, mime: "text/csv", content: toRaindropCsv(tree) };
  }
  return {
    filename: `kesonode-view-${stamp}.html`,
    mime: "text/html",
    content: toSelfContainedHtml(tree, opts),
  };
}
