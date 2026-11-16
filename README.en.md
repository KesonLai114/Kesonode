<p align="center">
  <img src="public/icons/wordmark.svg" alt="Kesonode" width="320">
</p>

> **Fork notice.** Kesonode is an independent fork of
> [Konode](https://github.com/konabe-studio/konode) by Kōnabe Studio, released under
> [MPL-2.0](LICENSE). That link is the licence attribution to the upstream project, not
> this fork's home. Sync file names, the default folder name, storage keys, data formats
> and extension IDs are deliberately unchanged so existing data stays compatible;
> see [Which folder?](#which-folder-three-compatibility-modes). Kesonode has no store
> listings of its own.

<p align="center">
  <strong>Sync your browser to storage you own: no middleman, no account, no tracking.</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a> ·
  <a href="LICENSE">MPL-2.0</a> ·
  <a href="插件版本/安装说明.md">中文安装说明</a> ·
  <a href="https://github.com/KesonLai114/Kesonode/releases">Download</a>
</p>

<p align="center">
  Bookmarks · Open tabs · History · Extension list &nbsp;•&nbsp; Google Drive · GitHub · WebDAV &nbsp;•&nbsp; Optional end-to-end encryption
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-brightgreen" alt="License: MPL-2.0"></a>
</p>

<p align="center">
  <img src="docs/hero-en.png" alt="Kesonode overview illustration: bookmarks, open tabs, history and extension list synced to Google Drive, GitHub or WebDAV, with optional end-to-end encryption" width="100%">
</p>

---

Kesonode keeps your bookmarks, open tabs, history, and installed-extension list in sync
across your browsers, but instead of routing everything through a company's servers,
it writes to **storage you already own**: your Google Drive, a GitHub repository, or
any WebDAV server.

There's no Kesonode account to create and no Kesonode server to trust. Your data goes
straight from your browser to the place you picked, and your credentials never leave
your device. If you want, you can turn on end-to-end encryption so even your storage
provider can't read it.

## Why Kesonode

- **Your storage, your rules.** Pick Google Drive, GitHub, or WebDAV. Delete your data
  any time, straight from the provider.
- **No server, no telemetry.** Kesonode operates nothing in the middle. There's nothing
  to log, sell, or breach, because we never see your data.
- **Optional end-to-end encryption.** AES-256-GCM, chosen explicitly during setup. On
  or off, it's your call. Nothing is silently uploaded behind a hidden default.
- **Works across browsers.** Any Chromium browser, plus Firefox and Firefox-based browsers.
- **Light by design.** No background bloat, no third-party scripts, no external
  requests beyond your own storage backend.
- **Settings you can carry over.** Export and import backend accounts, the device ID and
  the encryption passphrase as a JSON file, so an unpacked upgrade doesn't start from an
  empty setup.
- **Choose your compatibility mode.** Keep reading existing upstream data, use your own
  file names, or run a fully separate sync group. See
  [Which folder?](#which-folder-three-compatibility-modes).

## What you can sync

| Data | What it does |
|------|--------------|
| **Bookmarks** | Two-way sync that preserves your folder structure. Renames, moves and folder reorders travel too, and so do deletions, so no old bookmarks quietly come back. Keep any folder or bookmark out of the sync on a device, for example one another extension fills. |
| **Open tabs / sessions** | Save the current tab set and restore another device's session whenever you want, tab groups included (with their names and colours, if you allow it). Restoring opens only the tabs you don't already have. |
| **History** | Keep a synced, de-duplicated history list. *(On Firefox the original visit time is preserved; on Chrome the API can't set visit times, so restored entries show the sync moment.)* |
| **Installed extensions** | Sync the list and see at a glance which extensions are missing on the device you're on. |

When two devices disagree, you choose how it's resolved: newest change wins, always
prefer this device, always prefer the other, or resolve it yourself from the popup.

## Where your data goes

| Backend | Auth | Notes |
|---------|------|-------|
| **Google Drive** | One-time sign-in | Scoped to `drive.file`, so Kesonode only ever touches the files it creates. |
| **GitHub** | Fine-grained token | Point it at a single private repository. |
| **WebDAV** | Username + password | Presets fill in the address for Nextcloud / ownCloud, pCloud, Koofr, Fastmail, and Nutstore (坚果云), which works from mainland China where Google Drive can't be reached. **WebDAV (other)** takes Synology, kDrive, or any standard WebDAV server. |

## How Kesonode compares

**Pick by what you need.** Your browser's own sync is the least work if you use one
browser everywhere, and Firefox and Brave encrypt it end to end by default. floccus is the
one to look at if you want your bookmarks in a phone app, or synced to Nextcloud
Bookmarks, Linkwarden or Karakeep. Kesonode is for mixing browser families, Chromium and
Firefox, and syncing open tabs, history and the extension list along with your bookmarks,
to storage you already have.

| | Kesonode | floccus | Built-in sync |
|---|---|---|---|
| **What syncs** | Bookmarks, open tabs with their groups, history, extension list | Bookmarks, or open tabs (one per profile) | Bookmarks, tabs, history, passwords, settings and more |
| **Where it is stored** | Google Drive, GitHub, WebDAV | Nextcloud Bookmarks, WebDAV, Git, Google Drive, Dropbox, Linkwarden, Karakeep | The browser maker's servers |
| **Mixes Chromium and Firefox** | Yes | Yes | No, each syncs only with itself |
| **On phones** | Firefox for Android: open tabs and the extension list | Android and iOS apps, with your bookmarks inside the app | Everything, in the browser's own app |
| **End-to-end encryption** | Optional, on every backend | Optional, on WebDAV, Google Drive and Dropbox | Firefox and Brave always. Chrome only with a sync passphrase |
| **Account** | None beyond your storage | None beyond your storage | A Mozilla or Google account. Brave uses a sync code |
| **Around since** | 2026 | Years, with a much larger user base | As long as the browser |
| **Open source** | Yes, MPL-2.0 | Yes, MPL-2.0 | Clients open. Firefox's server too, Chrome's not |

A few details the cells are too small for. floccus syncs open tabs as an alternative to
bookmarks inside one sync profile, so doing both means setting up a second profile. Its
phone apps keep your bookmarks inside the app rather than in the phone's browser. Chrome's
sync passphrase covers everything except payment methods and addresses. xBrowserSync,
which this table used to list, has had no release since 2020. Checked November 2026 from
each project's own documentation and store pages.

**Running Kesonode alongside your browser's own sync.** You can, and people do, but it is
untested rather than known to work, so here is what to expect. The concern isn't that the
two will fight over your data. It's churn. The bookmarks API tells an extension that a
bookmark appeared, changed or was removed, and never who did it, so a bookmark that Chrome
Sync or Brave Sync has just brought in looks exactly like one you added yourself. Kesonode
publishes it, the other system carries it to its own devices, and the same change travels
twice. If both systems cover the same devices, you end up where you would have with either
one alone, just with more writes to your storage along the way. If they cover different
sets of devices, they bridge those sets together, deletions included, which may not be what
you had in mind. Picking one system for bookmarks is the simple answer.

## Privacy & security

- **No Kesonode servers exist.** Your data goes only to the backend you configure, and
  none of it is ever sent to us or to any third party. The one exception is the optional,
  **off-by-default** AI assistant described below, whose data goes to a provider *you* pick.
- **Optional E2EE** (AES-256-GCM, PBKDF2-SHA256, 600k iterations): encrypt every
  payload before it leaves your browser. It's an explicit choice you make during
  onboarding. Default off, never silently enabled or disabled. Honest threat model:
  encrypted files sit on storage others can read, so a passphrase is guessable
  *offline*. The 600k-round derivation makes each guess slow, a new passphrase must
  be 12+ characters, and the generated key (recommended) is effectively unguessable.
- **Credentials stay local.** Access tokens, GitHub tokens, WebDAV passwords, and your
  encryption passphrase live only in the browser's own extension storage
  (`storage.local`) on your device and are
  never uploaded. (That store isn't encrypted at rest, so a fine-grained GitHub token
  and a dedicated WebDAV app password are good habits.)
- **Integrity checks.** Every payload carries a SHA-256 checksum that's verified on
  download before anything is imported.
- **Least privilege.** `history`, `tabs`, and `management` are requested only when you
  turn those data types on. The extension-list permission is read-only: Kesonode never
  installs or removes anything.
- **Optional AI assistant (off by default).** After entering your own API address, key
  and model in Settings → AI assistant, you can search bookmarks in natural language,
  get organisation suggestions, and have sync receipts or conflicts explained. A
  question sends only a **reduced bookmark list** — title, hostname and folder path
  (at most 400 entries). Full URLs, history, tabs, your sync storage and your credentials
  are never sent; explaining a sync receipt or conflicts sends only counts, data-type names
  and flags, never titles or URL samples. Requests go only to the address you entered;
  Kesonode has no server and
  never sees the key or the answer. The key stays on this device, is not synced, and is
  **not included in a settings export**. Organisation suggestions are a list only:
  nothing is written until you tick rows and a pinned restore point has been taken.
  See [PRIVACY.md](PRIVACY.md#optional-ai-assistant).

> With the AI assistant off, the "never sent to any third party" promise above has no
> exceptions. With it on, the only new recipient is the model provider you chose and pay.

## Browser support

- **Chromium**: Chrome, Edge, Brave, Helium, ungoogled-chromium, and other Chromium
  browsers. Install the local package by loading the unpacked folder; this fork has no
  store listing of its own (see [Install](#install)).
- **Firefox**: Firefox and Firefox-based browsers (e.g. Waterfox, Zen), from a
  dedicated build in the same version folder. Same sync folder and same files as your
  Chromium browsers, so a Firefox install joins a group that is already running. In Zen,
  only the workspace in front shares its open tabs ([why](TROUBLESHOOTING.md#zen)).
  A temporary add-on has to be loaded again after each browser restart.
- **Firefox for Android**: open tabs and the extension list, on GitHub or WebDAV storage.
  Firefox for Android gives extensions no bookmarks, history or Google sign-in
  ([details](TROUBLESHOOTING.md#firefox-for-android)).

> On non-Chrome Chromium browsers, Google Drive sign-in uses the OAuth PKCE flow
> (`launchWebAuthFlow`), so Drive sync works even where `chrome.identity.getAuthToken`
> isn't available.

## Translations

Kesonode speaks **English, Hungarian, German, Spanish, Italian, Russian and Chinese
(Simplified and Traditional)**, and follows your browser's language. Every screen is
translated: the popup, the setup wizard, and Settings. Dates and numbers follow your
browser's locale everywhere.

**Japanese**, **Estonian** and **Arabic** have been started. A language reaches a release
once it is complete, because a screen that is half translated reads worse than an English
one. Arabic also needs the pages laid out right to left, which comes with it.

The strings live in this repository under `public/_locales/<lang>/messages.json`.
This fork does not use the upstream project's Weblate instance; edit the JSON files here
directly if you want to improve a translation. The repository's default README is in
Simplified Chinese; [安装说明](插件版本/安装说明.md) is the Chinese installation guide.
`GETTING_STARTED.md`, `TROUBLESHOOTING.md` and `PRIVACY.md` are still in English.

About half the strings carry a note explaining what they are and why they are worded the
way they are; a few of them make promises about not losing your data, and those have to be
translated literally. If a string's meaning isn't clear, leave it and ask. An
untranslated string falls back to English, which is safe.

## Install

Kesonode is distributed as a local package, not through any extension store. Pick a
version folder under [`插件版本/`](插件版本/) or download a
[release](https://github.com/KesonLai114/Kesonode/releases), unzip it, and follow the
[Chinese installation guide](插件版本/安装说明.md): the package unpacks into one folder
named `Kesonode` (no version number in the name), so load that folder in Chromium, or its
`manifest.json` in Firefox. If you already have Kesonode installed from an earlier
package, keep that install — a second install joins the sync group as a new device.

**Upgrading.** Download the new zip, then in Chromium go to Settings → Tools & diagnostics →
Software update and press "Upgrade now". The first dialog asks for that zip, and Kesonode
verifies it. On the first upgrade the same button becomes "Choose folder & finish
upgrade": one more click picks the folder Kesonode was loaded from (the one that directly
contains `manifest.json`) and grants write access; the new version is then written, the
leftovers of the old one removed and the extension restarted automatically. Later upgrades
only need the zip. The previous version is kept in `.kesonode-backup/`. Release checking, folder management and
the manual script download live under "Advanced options" on the same page. Firefox has no
such API — browsers do not let an extension write to a local folder there — so the same
primary button downloads the upgrade script, which installs the new version into the
same `Kesonode` folder.

New to Kesonode? The **[Getting Started guide](GETTING_STARTED.md)** walks through setup
and connecting each backend.

## Build from source

```bash
npm install          # install dependencies
npm run type-check   # tsc --noEmit, should be clean
npm run build        # → dist/           (Chromium)
npm run build:firefox # → dist-firefox/  (Firefox)
```

**Chromium:** open `chrome://extensions`, enable Developer mode, click **Load
unpacked**, and select `dist/`. After any rebuild, click ↻ reload on the extension
(MV3 won't swap a running service worker automatically).

**Firefox:** open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and
pick `dist-firefox/manifest.json`.

> Building the Google Drive backend yourself requires your own Google OAuth client
> (scope `drive.file`). GitHub and WebDAV need no setup beyond your own credentials.

### Publishing a release (maintainers)

Packaging is only half of shipping: a **GitHub Release appears only after a `v*` tag is
pushed** (`.github/workflows/release.yml` is tag-triggered). In the past a version was
zipped, committed under `插件版本/` and pushed to main, but the tag was forgotten — leaving
the Releases page stale and requiring a manual fix every time. That step is now centralized:

```bash
npm run version:patch          # 1) bump explicitly (skip if already on the target version)
npm run package:source:pinned  # 2) produce the two fixed-ID zips
#    copy both zips + 安装说明.md into 插件版本/vX.Y.Z/ and commit
npm run release                # 3) tag + push tag + create the Release (re-runnable)
npm run release:dry            #    preview step 3 without changing anything
```

`npm run release` reads the version from `package.json`, verifies both zips exist under
`插件版本/vX.Y.Z/` and the working tree is clean, then tags `vX.Y.Z`, pushes it and creates
the Release from the **committed zips** (byte-identical to past release assets, pinned ID
verified, no built-in secret). It is **idempotent**: an existing tag on HEAD is reused and an
existing Release keeps its assets, so re-running is safe. The body is generated from the
matching `CHANGELOG.md` section, or pass `npm run release -- --notes-file path.md`. Requires
`gh auth login` with repo scope.

> Pushing the tag also triggers `release.yml`, which rebuilds the pinned package; its
> create step is idempotent too, so the two paths cannot conflict.

## Verifying a build

`npm run checksum` prints a **build fingerprint**, a deterministic SHA-256 over the built
`dist/`. Check out a release tag and run:

```bash
npm ci && npm run build && npm run checksum
```

Two honest caveats. The release notes don't carry the fingerprint yet, so today this shows
you that the build reproduces, not that a particular download came from this tag. It also
assumes a comparable toolchain; the pinned lockfile keeps dependencies identical. A build
with a Google OAuth client compiled in cannot match one without it.

## How it works

For each device and data type, Kesonode writes one JSON file (a `SyncPacket`) to a sync
folder on your backend. Every sync pulls in each peer device's file, merges it
non-destructively, and pushes the result back. Bookmarks use tombstones so deletions
travel between devices without resurrecting old entries, and a safety cap stops a
corrupt deletion log from wiping your tree.

### Which folder? Three compatibility modes

Settings → Cloud & encryption → Compatibility decides where this device publishes. **Every device
in one sync group must pick the same mode** — the folder is where devices find each other.

| Mode | Folder (WebDAV/GitHub · Google Drive) | Files |
|------|---------------------------------------|-------|
| **Upstream** (default) | `konode` · `Konode` | writes and reads `konode_*` |
| **Own file names** | `konode` · `Konode` | writes `kesonode_*`, reads both prefixes |
| **Fully separate** | `kesonode` · `Kesonode` | writes and reads `kesonode_*` only |

The upstream folder name is frozen wire data, not product copy: that is why the default
mode still creates a folder called `konode`. Switching modes does **not** move existing
files — the new folder starts empty and this device re-uploads its own data. In "Fully
separate" mode an upstream Konode device cannot see this device's data. The `konode_*`
file prefix, SyncPacket format, E2EE parameters, storage keys and extension IDs are
unchanged in every mode.

When E2EE is on, the payload is encrypted on the device and the checksum is still
computed over the plaintext, so identical content matches across devices without
revealing anything to the backend.

## When Kesonode syncs

Three things start a sync, and nothing else does:

- **A bookmark changes on this device.** The upload goes out about a second later, with a
  30-second backstop in case the browser suspends the extension mid-edit. Bookmarks only,
  and only while **Sync on change** is on (it is by default, under Settings → This device).
- **The scheduled pull**, every 60 seconds by default. This is how a device learns about
  its *peers'* changes, and it covers every data type you have enabled. Adjust it from 30
  to 600 seconds under **Settings → This device → Sync interval**, or turn it off with **Auto
  sync**.
- **You press Sync now** in the popup.

That's the whole list. History, open tabs and the extension list have no instant path, so
they travel on the scheduled pull. Starting the browser doesn't sync by itself either: it
re-arms the schedule, and the first pull arrives on the next tick.

Why the receiving side waits at all: Drive, GitHub and WebDAV are ordinary file storage
with no way to tell a device that something changed, so Kesonode has to go and look. 30
seconds is also the fastest a browser will run an extension's background timer, whichever
backend you pick, so that's the floor rather than a setting we're being cautious with.

## Why there's no password sync

Browser extensions **cannot** read the browser's native password store. That's an
intentional security boundary in the browser, not a Kesonode limitation. For passwords,
use a dedicated manager like [Bitwarden](https://bitwarden.com),
[Proton Pass](https://proton.me/pass), or self-hosted
[Vaultwarden](https://github.com/dani-garcia/vaultwarden).

## Roadmap

- **Shipped**: bookmarks / sessions / history / extension-list sync · Google Drive +
  GitHub + WebDAV · WebDAV provider presets, Nutstore (坚果云) included · multi-device
  merge · per-item conflict resolution · opt-in E2EE · Drive OAuth refresh (PKCE) ·
  cross-browser extension matching · bookmarks kept out of sync · tab groups in sessions ·
  three compatibility modes · **translated interface** (English, Hungarian, German,
  Spanish, Italian, Russian, Chinese (Simplified and Traditional)) · settings import /
  export with a versioned backup format · conflicts that show what differs before you
  choose · a blocked deletion that lists the bookmarks it would remove · device list
  with last-upload age, browser engine and an INACTIVE mark.
- **Next**: the reading list · more backends (Dropbox, S3-compatible, OneDrive) ·
  faster history sync · more languages (Japanese, Estonian, Arabic).
- **Later**: right-to-left languages · incremental diff for very large bookmark trees ·
  diffs between restore points.

## Support & feedback

Something not working? Check **[Troubleshooting](TROUBLESHOOTING.md)** first. Kesonode is
built and distributed locally: the release folders under [`插件版本/`](插件版本/) are the
authoritative packages. This fork has no store listing, issue tracker or support address
of its own; links that used to point at the upstream project's listings, rating pages and
feedback addresses have been cleared until this fork has addresses of its own.

## Sponsor

If this software is useful to you, consider sponsoring the author to support ongoing
maintenance and development. Sponsorship is entirely voluntary and does not affect any
feature.

Scan the code for the platform you prefer:

<table align="center">
  <tr>
    <td align="center">
      <img src="docs/sponsors/wechat.png" alt="WeChat QR code" width="220"><br>
      <strong>WeChat Pay</strong>
    </td>
    <td align="center">
      <img src="docs/sponsors/alipay.png" alt="Alipay QR code" width="220"><br>
      <strong>Alipay</strong>
    </td>
  </tr>
</table>

## License

See [LICENSE](LICENSE).

## About this fork

Kesonode is an independent fork. It ports upstream code and fixes, but does not carry the
upstream project's store listings, sponsorship pages, site, issue tracker or author
branding. The wire contract — file prefixes, folder names, SyncPacket format, checksum and
E2EE parameters, extension IDs and OAuth configuration — stays frozen so existing data
remains readable. Fork-only changes are recorded at the top of
[CHANGELOG.md](CHANGELOG.md); upstream release history is kept there for comparison.
See [LICENSE](LICENSE) for the MPL-2.0 terms and upstream attribution.

---

<p align="center"><sub>Kesonode is not affiliated with Google, GitHub, Mozilla, or any storage provider.</sub></p>
