import type { IBackend, BackendConfig, DataType, ListedFile, SyncPacket } from "@/lib/types";
import { withRetry, withPeerRetry, HttpError, rateLimitMessage } from "@/lib/utils/retry";
import { logger } from "@/lib/utils/logger";
import { isSecureBackendUrl } from "@/lib/utils/url";
import { utf8ToBase64 } from "@/lib/utils/base64";
import { folderPath, isPeerFileName, packetFileName, peerDeviceIdFromName } from "@/lib/compat/protocol";
import { cachedPeerPacket, peerFileVersion, rememberPeerPackets } from "@/lib/utils/peer-packet-cache";

const INSECURE_URL_MSG =
  "WebDAV over plain http:// is not allowed. Your username and password would be sent unencrypted on every request. Use an https:// URL (http is permitted only for localhost).";

// Cap on how many peer files a single PROPFIND may yield. A hostile or buggy server
// could otherwise hand back an unbounded list and force a runaway download loop that
// leaks our Basic-auth header to every name it returns (it is checked per-href below).
const MAX_PEER_FILES = 1000;
// 单个 peer 文件大小上限（25MB）。恶意/畸形后端可返回超大包拖死 Service Worker，
// downloadAll 在解析前按 Content-Length（若提供）与正文长度双重检查。
const MAX_PACKET_BYTES = 25 * 1024 * 1024;

/** The last path segment of a PROPFIND href, decoded when it can be. */
function hrefBasename(href: string): string {
  try { return decodeURIComponent(href).split("/").pop() ?? ""; }
  catch { return href.split("/").pop() ?? ""; }
}

/**
 * What to say about a 403 Forbidden from a WebDAV server.
 *
 * A 403 is "authenticated, then refused", and on Nutstore the standing cause is the
 * WebDAV frequency limit: 600 requests per 30 minutes on a free account, 1500 on paid,
 * counted across EVERY app that uses the account's WebDAV, not just Kesonode. Nutstore
 * answers that refusal with 403 rather than 429, so it reached a QuarkPC user as a bare
 * "WebDAV GET failed: 403" repeated every sync, with nothing anywhere to act on
 * (field report, 2026-11-08). Name the limit where it is the known answer; elsewhere a
 * 403 really is the path or the account's rights, so say that instead.
 */
/** The hosts whose 403 means "over your request quota" rather than "wrong path". */
export function isNutstoreHost(host: string): boolean {
  return /jianguoyun\.com|nutstore\.(com|net)/i.test(host);
}

export function forbiddenMessage(host: string): string {
  if (isNutstoreHost(host)) {
    return `Forbidden (403): ${host} refused the request. Nutstore (坚果云) limits WebDAV by frequency — 600 requests per 30 minutes on a free account, 1500 on paid — counted across EVERY app using this account, and it answers with 403 rather than 429. Wait for the window to pass, or raise Sync interval in Settings → Device; another device or app syncing against this same account can use the quota up on its own.`;
  }
  return `Forbidden (403): ${host} refused the request. The login was accepted, so this is the path or the account's rights: check the URL path and what the account may access.`;
}

/**
 * The files in a PROPFIND multistatus, each with its `getlastmodified` where the server sent
 * one. Servers disagree on the namespace prefix (`d:`, `D:`, `lp1:` on Apache, none at all),
 * so every element is matched with any prefix. The collection itself comes back as an href
 * ending in `/`, whose basename is empty, and callers filter it out by prefix.
 */
export function parsePropfindListing(xml: string): ListedFile[] {
  return parseDavEntries(xml).map((e) =>
    e.size == null ? { name: e.name, modified: e.modified } : { name: e.name, modified: e.modified, size: e.size }
  );
}

/** One entry of a PROPFIND multistatus, with the href it came from. */
interface DavEntry {
  name: string;
  href: string;
  modified: number | null;
  size: number | null;
}

/**
 * The PROPFIND multistatus, in full.
 *
 * The href is kept because it is the only thing that says WHICH file a row is about;
 * the basename alone can collide with a file in another folder, and the origin check
 * in `downloadAll` needs the path the server actually pointed at. The size is a second
 * version signal for the local packet cache (see peer-packet-cache.ts).
 */
function parseDavEntries(xml: string): DavEntry[] {
  const out: DavEntry[] = [];
  for (const block of xml.matchAll(/<(?:[a-z0-9]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?response>/gi)) {
    const href = /<(?:[a-z0-9]+:)?href>([^<]+)<\/(?:[a-z0-9]+:)?href>/i.exec(block[1]);
    if (!href) continue;
    const stamp = /<(?:[a-z0-9]+:)?getlastmodified[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?getlastmodified>/i.exec(block[1]);
    const t = stamp ? Date.parse(stamp[1].trim()) : NaN;
    const len = /<(?:[a-z0-9]+:)?getcontentlength[^>]*>([^<]+)<\/(?:[a-z0-9]+:)?getcontentlength>/i.exec(block[1]);
    const size = len ? Number(len[1].trim()) : NaN;
    out.push({
      name: hrefBasename(href[1].trim()),
      href: href[1].trim(),
      modified: Number.isNaN(t) ? null : t,
      size: Number.isNaN(size) ? null : size,
    });
  }
  return out;
}

export class WebDAVBackend implements IBackend {
  readonly type = "webdav" as const;
  /** Peer files this sync could not read; the engine surfaces these as a visible problem. */
  readonly failedPeers: string[] = [];
  /**
   * Did the storage meter us? Set on a 429 anywhere and on Nutstore's 403 (which is its
   * way of saying 429). The engine reads it after the cycle and parks automatic sync
   * for a whole window — because a refusal that is only logged is a refusal that comes
   * back next minute, and each attempt spends quota the window still has.
   */
  rateLimited = false;

  /**
   * The folder listing, fetched ONCE per backend instance.
   *
   * Every list in a sync cycle asked the server the same question: `listFiles`,
   * `listFilesWithTimes` and `downloadAll` each ran their own PROPFIND, and the
   * restore-point code asked twice more (once for the rolling points, once for the
   * kept-forever ones). On Nutstore every one of those counted against the 600-requests-
   * per-30-minutes free quota, so a single cycle could spend a tenth of the window on
   * listings that all returned the same rows.
   *
   * Invalidated by any write (a PUT or a DELETE changes the listing), so a file this
   * device just uploaded is never missing from a later list in the same cycle.
   */
  private listing: DavEntry[] | null = null;
  private listingPromise: Promise<DavEntry[]> | null = null;

  constructor(private config: BackendConfig) {}

  /**
   * Refuse to send another request once the storage has metered us.
   *
   * A Nutstore window is 30 minutes long and every request inside it is refused, so
   * continuing to ask only burns the quota that the next window needs. The error is
   * the same one the server would have sent, so callers cannot tell the difference
   * between "refused locally" and "refused by the server" — which is the point: they
   * must both park the sync.
   */
  private guardRateLimit(): void {
    if (!this.rateLimited) return;
    const host = new URL(this.w.url).host;
    throw new HttpError(403, forbiddenMessage(host), true);
  }

  /** The error for a refused response, with the rate-limit case flagged. */
  private httpError(res: Response, verb: string): HttpError {
    if (res.status === 403) {
      const host = new URL(this.w.url).host;
      // A Nutstore 403 IS a rate limit, so the sync loop has to back off for a whole
      // window; a 403 from any other server is the path or the account's rights and
      // must not park sync for half an hour.
      const nut = isNutstoreHost(host);
      if (nut) this.rateLimited = true;
      return new HttpError(403, forbiddenMessage(host), nut);
    }
    if (res.status === 429) this.rateLimited = true;
    return new HttpError(res.status, `WebDAV ${verb} failed: ${res.status}`, res.status === 429);
  }

  isConfigured(): boolean {
    const w = this.config.webdav;
    return !!(w?.url && w?.username && w?.password);
  }

  private get w() {
    if (!this.config.webdav?.url) throw new Error("WebDAV not configured");
    return this.config.webdav;
  }

  private get baseUrl(): string {
    return this.w.url.replace(/\/$/, "") + "/" + (this.w.path ?? folderPath()).replace(/^\//, "");
  }

  /**
   * The Basic-auth header value. Credentials are UTF-8 encoded before base64: raw
   * `btoa` throws on any code point above U+00FF (`ő`, `ű`, `ł`, `€`, Cyrillic, emoji)
   * — and that DOMException is neither an HttpError nor a network TypeError, so
   * `defaultShouldRetry` won't retry it and every sync failed hard and permanently. For
   * U+0080–U+00FF (`á`, `ö`, `ü`) it didn't throw but emitted ISO-8859-1 bytes, while
   * Nextcloud/ownCloud/SabreDAV and Apache decode UTF-8 — so a CORRECT password was
   * rejected forever with "Authentication failed. Check username/password".
   * RFC 7617 recommends UTF-8 and every mainstream DAV server expects it.
   *
   * Single accessor on purpose: this used to be inlined twice (here and in
   * downloadAll), which is how the two copies could drift.
   */
  private authHeader(): string {
    return `Basic ${utf8ToBase64(`${this.w.username}:${this.w.password}`)}`;
  }

  private headers(): HeadersInit {
    return {
      Authorization: this.authHeader(),
      "Content-Type": "application/json",
    };
  }

  /**
   * Which storage this instance talks to, as a cache scope: origin, folder, account.
   *
   * The cached peer packets are local working state, and a file name alone does not
   * identify them — `konode_bookmarks_<device_id>.json` can exist in two different
   * accounts, and switching the active backend must not merge one account's data into
   * the other. Never includes the password. Empty when the URL is unparseable, which
   * disables the cache rather than making it ambiguous.
   */
  private get packetScope(): string {
    try {
      const u = new URL(this.w.url);
      return `${u.origin}/${(this.w.path ?? folderPath()).replace(/^\/+/, "")}#${this.w.username ?? ""}`;
    } catch {
      return "";
    }
  }

  /**
   * The HttpError for a failed request, with a 403 explained (see `forbiddenMessage`):
   * a bare "WebDAV GET failed: 403" told someone it failed and not what to do, while the
   * one server that 403s for a fixable reason was left undescribed. Other statuses keep
   * the plain form — 401 already has `authFailureMessage` at the doors that need it.
   */
  private fail(res: Response, verb: string): never {
    throw this.httpError(res, verb);
  }

  /**
   * What to say about a 401. "Check username/password" is the obvious reading and it is
   * wrong on a whole class of server: a 401 means "not authenticated", and
   * `WWW-Authenticate` says WHICH scheme the server is willing to accept. A server that
   * offers `Bearer` and not `Basic` will refuse a perfectly correct username and password
   * forever, so sending that user to re-check their credentials sends them to look at the
   * one thing that isn't broken.
   *
   * The case that prompted this, from a field report: ownCloud Infinite Scale ships with
   * `PROXY_ENABLE_BASIC_AUTH=false` and authenticates over OIDC, so every attempt got
   * "Authentication failed. Check username/password" and the reporter spent their time on
   * the password. The fix on their side is an app token (`PROXY_ENABLE_APP_AUTH`), which
   * travels in this same Basic header, so it is worth naming.
   *
   * Absent or unparseable header means we know nothing extra, so say the ordinary thing.
   * Reading response headers is fine here: the request runs under a host permission, so
   * it is not CORS-restricted and nothing is hidden from us.
   */
  private authFailureMessage(res: Response): string {
    const credentials = "Authentication failed. Check username/password";
    let challenge = "";
    try {
      challenge = res.headers?.get("WWW-Authenticate") ?? "";
    } catch {
      return credentials; // a stubbed or exotic Response without headers
    }
    if (!challenge.trim()) return credentials;

    // Scheme tokens only: a challenge is `Scheme param=..., param=...` and may list
    // several, so the parameters (which can contain the word "basic" inside a realm)
    // must not be mistaken for one. A scheme sits at the start or after a comma and is
    // followed by whitespace or the end.
    const schemes = [...challenge.matchAll(/(?:^|,)\s*([A-Za-z][\w!#$%&'*+.^`|~-]*)(?=\s|$)/g)]
      .map((m) => m[1]);
    if (!schemes.length || schemes.some((s) => s.toLowerCase() === "basic")) return credentials;

    return `This server won't take a username and password over WebDAV: it refused the login and asked for ${schemes.join(" or ")} instead. Some servers want an app token in the password field, and ownCloud Infinite Scale has HTTP Basic switched off by default (its admin can turn on app tokens with PROXY_ENABLE_APP_AUTH). Your password is probably fine.`;
  }

  async connect(): Promise<void> {
    // Refuse to send Basic-auth credentials over plaintext http:// (loopback aside).
    if (!isSecureBackendUrl(this.w.url)) throw new Error(INSECURE_URL_MSG);
    await this.ensureFolder();
    // Log the host only (not the full URL/path) — the audit log is device-local
    // but shouldn't persist more backend detail than needed (PR-L2).
    logger.info("WebDAV connected", new URL(this.w.url).hostname);
  }

  async disconnect(): Promise<void> {}

  private async ensureFolder(): Promise<void> {
    // MKCOL creates the folder if it doesn't exist
    // 405 = already exists, which is fine
    const res = await fetch(this.baseUrl, {
      method: "MKCOL",
      headers: this.headers(),
    });

    // The configured URL is not the canonical one. fetch followed the redirect for us, so
    // this still worked — but it costs an extra round trip on every request, and plenty of
    // servers and reverse proxies DROP the Authorization header when redirecting, which
    // shows up later as a baffling 401 on a password that is perfectly correct. Say so
    // now, while the user is looking at the connection settings.
    if (res.redirected) {
      logger.warn(
        "WebDAV.ensureFolder",
        `The server redirects ${new URL(this.w.url).hostname} to a different address. Sync should still work, but use the final URL your server shows — some servers drop the login across a redirect and then reject a correct password.`
      );
    }

    // A 401 is answered here rather than below, because the folder question is moot: the
    // server refused the login at the door, so the PROPFIND check would 401 too and the
    // user would be told to look at the path and their write permissions for what is an
    // authentication problem. This is the message a FIRST-RUN user gets, since onboarding
    // saves and syncs instead of running Test connection, so it is the one that has to be
    // right.
    if (res.status === 401) throw new HttpError(401, this.authFailureMessage(res));

    // 405 means the collection is already there. A bare 301 used to be waved through as
    // well, which was wrong twice over: fetch follows redirects by default, so a 301 only
    // ever reaches this line when it could NOT be followed (no usable Location), and that
    // is a failure, not a success.
    if (res.ok || res.status === 405) return;

    // Anything else: this used to be a warning and nothing more, so connect() went on to
    // log "WebDAV connected" and Test connection reported success even when the folder had
    // not been created — every upload then failed against a folder that wasn't there.
    // Don't guess from the status code, though: WebDAV servers answer MKCOL with a wide
    // spread of codes, and a 403 can mean "you may not create it" on a collection that
    // already exists. Ask.
    const check = await fetch(this.baseUrl + "/", {
      method: "PROPFIND",
      headers: { ...this.headers(), Depth: "0" },
      cache: "no-store",
    });
    if (check.ok) {
      logger.info("WebDAV.ensureFolder", `MKCOL returned ${res.status}, but the folder is there`);
      return;
    }
    // A metered server refuses the MKCOL too, and that refusal must park the sync —
    // not just be described. Flag it here, where the first 403 of a cycle lands.
    if (res.status === 429) this.rateLimited = true;
    if (res.status === 403 && isNutstoreHost(new URL(this.w.url).host)) this.rateLimited = true;
    throw new HttpError(
      res.status,
      `Couldn't create the sync folder on the WebDAV server (MKCOL ${res.status}, and it isn't there: ${check.status}). Check the path and that the account may write to it.`,
      this.rateLimited
    );
  }

  /**
   * The folder listing, fetched at most once per backend instance.
   *
   * One PROPFIND answers every list a cycle needs — the device list, the peer files and
   * the restore points — so a cycle that asked four questions now asks the server once.
   * The listing carries each file's modification time and size, which is what lets an
   * unchanged peer file be recognised without downloading it again.
   */
  private async folderListing(): Promise<DavEntry[]> {
    if (this.listing) return this.listing;
    if (!this.listingPromise) {
      this.listingPromise = this.fetchListing()
        .then((entries) => {
          this.listing = entries;
          return entries;
        })
        .finally(() => {
          this.listingPromise = null;
        });
    }
    return this.listingPromise;
  }

  private async fetchListing(): Promise<DavEntry[]> {
    this.guardRateLimit();
    const res = await fetch(this.baseUrl + "/", {
      method: "PROPFIND",
      headers: { ...this.headers(), Depth: "1" },
      body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`,
      cache: "no-store",
    });
    // 404 = the sync folder doesn't exist yet (no peers).
    if (res.status === 404) return [];
    if (!res.ok) this.fail(res, "list");
    return parseDavEntries(await res.text());
  }

  /** A write changes the listing, so the cached one is no longer true. */
  private invalidateListing(): void {
    this.listing = null;
  }

  async upload(packet: SyncPacket): Promise<void> {
    await withRetry(async () => {
      this.guardRateLimit();
      const name = packetFileName(packet.data_type, packet.device_id);
      const res = await fetch(`${this.baseUrl}/${name}`, {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(packet, null, 2),
      });
      if (!res.ok) this.fail(res, "PUT");
      // The folder now holds a file the cached listing doesn't know about.
      this.invalidateListing();
      // Log the FILE NAME, never the URL. `baseUrl` carries the account username on
      // Nextcloud/ownCloud (…/remote.php/dav/files/<user>/…) and the audit log is
      // persisted to disk — connect() already logs the hostname only for exactly this
      // reason (PR-L2). The name is what's actually useful when troubleshooting.
      logger.info("WebDAV.upload", `${packet.data_type} → ${name}`);
    });
  }

  async downloadAll(data_type: DataType, excludeDeviceId?: string): Promise<SyncPacket[]> {
    return withRetry(async () => {
      // One PROPFIND for the whole cycle: the listing is cached on the instance, and
      // every list in this cycle asks the server the same question.
      const entries = await this.folderListing();

      const peers = entries.filter((e) => {
        if (!isPeerFileName(e.name, data_type)) return false;
        // Exclude by DEVICE ID, not by exact file name: an isolated-mode device may
        // still find its own old upstream file in the folder.
        return !(excludeDeviceId && peerDeviceIdFromName(e.name, data_type) === excludeDeviceId);
      });

      const packets: SyncPacket[] = [];
      // Packets downloaded in THIS cycle, written to the local cache in one go after the
      // loop rather than re-reading and re-writing a multi-megabyte value per file.
      const fresh: { name: string; version: string; packet: SyncPacket }[] = [];
      const scope = this.packetScope;
      // Credentials must only be sent to THIS WebDAV server. An attacker who can influence
      // the PROPFIND response (rogue/infected server, shared account, poisoned cache) could
      // otherwise redirect our Basic-auth header to an arbitrary host, or downgrade to
      // plaintext http://. Resolve every href against the configured base and refuse any
      // that leave this origin or are not a secure scheme.
      const baseOrigin = new URL(this.w.url).origin;
      for (const entry of peers) {
        const href = entry.href;
        let fullUrl: string;
        try { fullUrl = new URL(href, this.w.url).href; } catch { continue; }
        let target: URL;
        try { target = new URL(fullUrl); } catch { continue; }
        if (target.origin !== baseOrigin || !isSecureBackendUrl(fullUrl)) {
          logger.warn(
            "WebDAV.downloadAll",
            `Skipping peer file with untrusted href (${target.origin}): credentials are not sent off-server.`
          );
          continue;
        }
        if (packets.length >= MAX_PEER_FILES) {
          logger.warn(
            "WebDAV.downloadAll",
            `Stopping after ${MAX_PEER_FILES} peer files to avoid a runaway download loop.`
          );
          break;
        }

        // ── The unchanged-file shortcut ────────────────────────────────────
        // A peer file that has not changed since we last downloaded it is merged from
        // the local copy instead of from the network. The bytes are the same ones the
        // server would have sent, so the merge, the conflict resolution and the
        // bulk-delete guard all still run — only the round trip is saved, and that is
        // the difference between fitting inside Nutstore's 600-requests-per-30-minutes
        // free quota and blowing straight through it every single minute.
        //
        // The listing has to carry a modification time for this to be possible; the
        // GitHub-style listings that carry none simply never hit this path.
        const version = peerFileVersion(entry.modified, entry.size);
        const cached = await cachedPeerPacket(entry.name, version, scope);
        if (cached) {
          packets.push(cached);
          continue;
        }

        let r: Response;
        try {
          // A 503 from a NAS/metered WebDAV is often a one-off. Retry just THIS file,
          // without re-running the whole listing.
          r = await withPeerRetry(async () => {
            this.guardRateLimit();
            const res = await fetch(fullUrl, {
              headers: { Authorization: this.authHeader() },
              cache: "no-store", // avoid a stale peer file from the browser HTTP cache
            });
            if (!res.ok) throw this.httpError(res, "GET");
            return res;
          });
        } catch (err) {
          // NOT silent, and no longer just a log line: record it so the engine reports a
          // degraded sync as an ERROR instead of "Synced" with fewer devices than the
          // folder holds. Degraded, not fatal — one unreadable file must not stop the
          // other peers from being merged.
          const detail = err instanceof HttpError
            ? `HTTP ${err.status}`
            : err instanceof Error ? err.message : String(err);
          this.failedPeers.push(`${entry.name} (${detail})`);
          logger.warn(
            "WebDAV.downloadAll",
            `Couldn't download ${entry.name} (${detail}) — that device is left out of this sync`
          );
          continue;
        }
        // 拒绝超大包：先看 Content-Length（存在则不必下载正文），再核对正文长度，
        // 避免恶意/畸形后端用超大文件耗尽内存、拖死 Service Worker。
        const lenHeader = r?.headers?.get("content-length");
        if (lenHeader && Number(lenHeader) > MAX_PACKET_BYTES) {
          // Reported, not just skipped. Every cycle would otherwise drop this peer in
          // silence while the sync said "Synced" — one browser's data simply never
          // merging, for as long as the file stays that big.
          this.failedPeers.push(`${entry.name} (${lenHeader} bytes, over the ${Math.round(MAX_PACKET_BYTES / 1024 / 1024)} MB limit)`);
          logger.warn(
            "WebDAV.downloadAll",
            `Skipping oversized peer file (${lenHeader} bytes): ${entry.name}`
          );
          continue;
        }
        const body = await r.text();
        if (body.length > MAX_PACKET_BYTES) {
          this.failedPeers.push(`${entry.name} (${body.length} bytes, over the ${Math.round(MAX_PACKET_BYTES / 1024 / 1024)} MB limit)`);
          logger.warn(
            "WebDAV.downloadAll",
            `Skipping oversized peer file (${body.length} bytes): ${entry.name}`
          );
          continue;
        }
        try {
          const packet = JSON.parse(body) as SyncPacket;
          packets.push(packet);
          // Remember it, so the next cycle can merge it without another request.
          fresh.push({ name: entry.name, version, packet });
        } catch {
          // A corrupt/partial file (e.g. trailing junk from a non-truncating write)
          // must not abort the whole sync — skip it; the owner rewrites it next sync.
          // Name only: an href is a full DAV path, which on Nextcloud/ownCloud embeds
          // the account username (see the note in upload()).
          //
          // Recorded as a failed peer because "the owner rewrites it next sync" is only
          // true if its payload CHANGES: `uploadIfChanged` skips an unchanged payload, so
          // a file that is corrupt at rest can sit there for months. Silently skipping it
          // meant a permanent divergence that the UI called a clean sync.
          this.failedPeers.push(`${entry.name} (unreadable JSON)`);
          logger.warn("WebDAV.downloadAll", `Skipping unreadable sync file: ${entry.name}`);
        }
      }
      // One write for everything this cycle read. A file whose bytes were served from
      // the cache is already in the map, so it costs nothing to leave it out here.
      await rememberPeerPackets(scope, fresh);
      return packets;
    });
  }

  async putFile(name: string, content: string): Promise<void> {
    await withRetry(async () => {
      this.guardRateLimit();
      const res = await fetch(`${this.baseUrl}/${name}`, { method: "PUT", headers: this.headers(), body: content });
      if (!res.ok) this.fail(res, "PUT");
      this.invalidateListing();
    });
  }

  async getFile(name: string): Promise<string | null> {
    return withRetry(async () => {
      this.guardRateLimit();
      const res = await fetch(`${this.baseUrl}/${name}`, { headers: this.headers(), cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok) this.fail(res, "GET");
      return res.text();
    });
  }

  /** The file's ETag, or null when it isn't there. HEAD keeps it to headers only.
   *
   *  A server that sends no ETag cannot answer "did this change since I read it", and
   *  guessing would be worse than saying so: throwing leaves the shared index on the
   *  plain read-merge-write it has always used. */
  async getFileVersion(name: string): Promise<string | null> {
    return withRetry(async () => {
      this.guardRateLimit();
      const res = await fetch(`${this.baseUrl}/${name}`, {
        method: "HEAD", headers: this.headers(), cache: "no-store",
      });
      if (res.status === 404) return null;
      if (!res.ok) this.fail(res, "HEAD");
      const etag = res.headers?.get("etag")?.trim();
      if (!etag) throw new Error("This WebDAV server sends no ETag, so writes cannot be made conditional");
      return etag;
    });
  }

  /** PUT that only lands if the file still has `version`.
   *
   *  `If-None-Match: *` for a file that must not exist yet; `If-Match` otherwise. A 412 is
   *  the answer we want — the caller re-reads and merges again — so it is not an error. */
  async putFileIfVersion(name: string, content: string, version: string | null): Promise<boolean> {
    return withRetry(async () => {
      this.guardRateLimit();
      const headers: Record<string, string> = {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
        // `If-None-Match: *` for a file that must not exist yet; `If-Match` otherwise.
        [version === null ? "If-None-Match" : "If-Match"]: version === null ? "*" : version,
      };
      const res = await fetch(`${this.baseUrl}/${name}`, {
        method: "PUT", headers, body: content,
      });
      if (res.status === 412) return false;
      if (!res.ok) this.fail(res, "PUT");
      this.invalidateListing();
      return true;
    });
  }

  async listFiles(prefix: string): Promise<string[]> {
    return withRetry(async () => {
      const entries = await this.folderListing();
      return entries.map((e) => e.name).filter((name) => name.startsWith(prefix));
    });
  }

  async listFilesWithTimes(prefix: string): Promise<ListedFile[]> {
    return withRetry(async () => {
      const entries = await this.folderListing();
      return entries
        .filter((e) => e.name.startsWith(prefix))
        .map((e) => (e.size == null
          ? { name: e.name, modified: e.modified }
          : { name: e.name, modified: e.modified, size: e.size }));
    });
  }

  async deleteFile(name: string): Promise<void> {
    await withRetry(async () => {
      this.guardRateLimit();
      const res = await fetch(`${this.baseUrl}/${name}`, { method: "DELETE", headers: this.headers() });
      if (!res.ok && res.status !== 404) this.fail(res, "DELETE");
      // The folder no longer holds what the cached listing says it holds.
      this.invalidateListing();
    });
  }


  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      if (!isSecureBackendUrl(this.w.url)) return { ok: false, message: INSECURE_URL_MSG };
      const res = await fetch(this.w.url, {
        method: "PROPFIND",
        headers: { ...this.headers(), Depth: "0" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`,
      });
      if (res.ok || res.status === 207) {
        return { ok: true, message: `Connected to ${new URL(this.w.url).hostname}` };
      }
      if (res.status === 401) return { ok: false, message: this.authFailureMessage(res) };
      if (res.status === 429) return { ok: false, message: rateLimitMessage(new URL(this.w.url).host) };
      if (res.status === 403) return { ok: false, message: forbiddenMessage(new URL(this.w.url).host) };
      return { ok: false, message: `Server returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}
