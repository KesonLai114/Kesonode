import type { SearchHit, SearchSource } from "@/lib/types";
import { canonicalUrlKey } from "@/lib/utils/url";

/**
 * Search across everything Kesonode already knows locally: bookmarks, history and the
 * reading list. No index is built and nothing is uploaded — the collections are small
 * enough to scan, and scanning them means a result can never be stale.
 */

export interface SearchDoc {
  source: SearchSource;
  title: string;
  url: string;
  folder?: string;
  id?: string;
  /** Epoch ms for history recency, or dateAdded for a bookmark. */
  at?: number;
}

export const MAX_SEARCH_RESULTS = 25;

/** Terms shorter than this are ignored, so one letter does not match the whole library. */
const MIN_TERM = 2;

function normalize(text: string): string {
  return text.toLocaleLowerCase();
}

function scoreDoc(doc: SearchDoc, terms: string[]): number {
  const title = normalize(doc.title);
  const url = normalize(doc.url);
  const folder = normalize(doc.folder ?? "");
  let host = "";
  try {
    host = normalize(new URL(doc.url).hostname);
  } catch {
    // A bookmark URL the URL parser rejects still gets title/url matching.
  }

  let score = 0;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inUrl = url.includes(term);
    const inFolder = folder.includes(term);
    const inHost = host.includes(term);
    if (!inTitle && !inUrl && !inFolder && !inHost) return -1;
    if (title.startsWith(term)) score += 100;
    else if (inTitle) score += 55;
    if (inHost) score += 35;
    else if (inUrl) score += 25;
    if (inFolder) score += 12;
  }
  // Shorter titles are usually the more specific match ("GitHub" over "GitHub — Where...").
  score += Math.max(0, 20 - Math.floor(doc.title.length / 8));
  if (doc.source === "reading") score += 8;
  if (doc.source === "bookmark") score += 4;
  return score;
}

export function searchDocs(
  docs: SearchDoc[],
  query: string,
  limit = MAX_SEARCH_RESULTS
): SearchHit[] {
  const terms = normalize(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TERM);
  if (!terms.length) return [];

  // One representative per (source, canonical URL). Keep the BEST-scoring one, not merely
  // the first seen: the same page can appear twice with different titles (a history row
  // and a renamed bookmark), and first-seen-wins buried the prefix/short-title match under
  // a worse one. Ties keep the first, so input order still decides equal scores.
  const best = new Map<string, SearchHit>();
  for (const doc of docs) {
    if (!doc.url) continue;
    const key = `${doc.source}:${canonicalUrlKey(doc.url)}`;
    const score = scoreDoc(doc, terms);
    if (score < 0) continue;
    const prev = best.get(key);
    if (prev && prev.score >= score) continue;
    best.set(key, {
      source: doc.source,
      title: doc.title || doc.url,
      url: doc.url,
      ...(doc.folder ? { folder: doc.folder } : {}),
      ...(doc.id ? { id: doc.id } : {}),
      score,
    });
  }
  const hits = [...best.values()];

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.localeCompare(b.title);
  });
  return hits.slice(0, Math.max(1, limit));
}

/**
 * The words offered to the address bar while the user types.
 *
 * The omnibox API wants a short list and a description per suggestion; this keeps the
 * same ranking and caps it at the API's practical size.
 */
export function omniboxSuggestions(docs: SearchDoc[], query: string): SearchHit[] {
  return searchDocs(docs, query, 6);
}

/**
 * Make a title/URL safe inside an omnibox suggestion description.
 *
 * Chrome parses that description as a small XML fragment (`<match>`, `<dim>`, `<url>`),
 * so user text containing `&` or `<` is either rejected or rendered literally. Escaping
 * is the documented requirement, and bookmark titles hit it constantly ("Q&A", "a < b").
 */
export function escapeOmniboxText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
