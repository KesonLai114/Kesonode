# Changelog

All notable changes to Konode. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/).

> **Kesonode fork note.** This file is kept in sync with the upstream project's changelog
> so upstream fixes can be ported. "Konode" in the historical entries below refers to
> upstream releases, not to this fork's product name. Kesonode-only changes are recorded
> in the section immediately below and never change the upstream wire contract.

## [Unreleased]

### Fixed

- **The upgrade button now asks for the zip first.** Previous builds opened
  `showDirectoryPicker()` before the package picker on the first run. macOS titles that
  dialog "where should this site save changes" and greys out every `.zip`, so pressing
  "Upgrade now" looked like it refused to let users select the latest package. The first
  dialog is now the file picker; the folder picker appears only after a package has been
  chosen and verified, and only on first use or when the browser revoked the grant. The
  same main button becomes that second step, so there is still only one primary action.
  Both pickers are opened synchronously inside their click — this also removes a latent
  failure where Chrome would not open the file picker at the end of the async chain.
  Cancelling the folder dialog keeps the verified package for a retry.

## [1.5.23] - 2026-11-15

### Fixed

- **The bookmark baseline card no longer reads as a contradiction.** Settings → Device
  now labels the status value as "Current baseline". Opening the confirmation shows a
  tinted block that says the change has not been applied yet: the value on the left is
  the state *before* the pending action, and it changes only after the second click.
  While the worker publishes the bookmark tree the confirmation stays on screen
  (disabled, with a spinner) and the status reads "Setting this browser as the
  baseline…" — it no longer snaps back to "Not set" beside a disabled "Use this browser
  as baseline" button, which looked like the click had been undone. Success, warning
  and failure messages are colour-coded instead of all being grey.

## [1.5.22] - 2026-11-15

### Changed

- **Software update is one button.** Settings → Advanced → Software update now shows a
  single primary action instead of a six-button wizard: it binds the install folder on
  first use, lets the user pick the downloaded zip, verifies it, writes the new version
  and restarts the extension. On Firefox the same button downloads the upgrade script.
  Release checking, folder management and the manual script download moved behind an
  "Advanced options" disclosure, and a failed release check now says plainly that a
  local package still works.

## [1.5.21] - 2026-11-15

### Added

- **A one-click upgrade in Chromium.** Settings → Advanced → Software update now lets you
  bind the folder Kesonode was loaded from — the browser asks permission to write to it
  once, and remembers it — and "Upgrade now" writes a downloaded package into that
  folder, removes the files the new version does not have, and restarts the extension.
  The version being replaced is kept in `.kesonode-backup/<version>/` inside the folder,
  so a release that misbehaves can be put back by hand. The package's manifest `key` is
  compared with the installed one before a single file is written: an upgrade that would
  change the extension ID — and with it every setting, every login and every snapshot —
  is refused with an explanation instead of quietly renaming the extension. Firefox has
  no such API, and says so; the upgrade script stays the way in there.
- **The settings page says what the upgrade does.** The section explains that the new
  version is written into the folder Kesonode was loaded from and that the extension
  restarts, instead of claiming that a locally loaded extension cannot replace its own
  code — which was true of what the section did, and no longer is.

### Changed

- **A release package unpacks into one folder named `Kesonode`.** The name has no
  version in it and never changes, which is what makes an upgrade an upgrade: the new
  files replace the old ones in the folder the browser already loads from, the extension
  ID stays the same and the settings stay where they are. The Chrome Web Store package
  is unchanged — the store requires the manifest at the archive root — and both layouts
  are understood by the upgrade.
- **The upgrade script installs into that same folder.** It used to unpack into a fresh
  `Kesonode-v<version>` directory, so every upgrade left another directory behind and
  the user had to choose which one to load. It now installs into `~/Downloads/Kesonode`
  and renames the previous one to `Kesonode.old-<timestamp>` rather than deleting it.

## [1.5.20] - 2026-11-14

### Added

- **Two batch actions on AI search results.** When a question returns more than one
  bookmark, the popup offers "save all to the reading list" and "open all". Saving is
  deduplicated by canonical URL, so a page already in the list is counted as neither
  added nor lost, and the message reports how many pages were actually new. Opening uses
  background tabs, so the popup stays where it is.

### Changed

- **The popup says nothing at all when the AI assistant is off.** It used to print a line
  in every popup, for every user, telling them a feature they had not turned on was
  turned off. The panel appears the moment the switch is on; Settings → AI assistant is
  where the feature lives.
- **A wrong interface address now says what is wrong with it.** "Fill in the API address"
  is useless advice to someone who already filled it in. The address is checked for the
  reason it fails — not https, plain http away from this machine, a username or password
  embedded in the URL, or no address at all — and each has its own sentence. Plain http is
  still refused off this machine, because the key travels in the Authorization header;
  `http://localhost:11434/v1` for a local model server keeps working.
- **The organisation plan drops the rows that would change nothing.** A bookmark the model
  listed twice is one suggestion, not two to tick, and a bookmark it wants to file in the
  folder it is already in is not work. A bookmark sitting directly in a root is never
  treated as already filed.
- **Settings → AI assistant says that changes need saving.** The switch and the fields
  take effect after the save at the bottom of the page; saying so beats a user turning
  everything on and wondering why the popup is unchanged.
- **The Firefox package declares the optional bookmark transfer.** The manifest now states
  `required: ["none"]` — nothing is collected, by us or by Mozilla — with
  `optional: ["bookmarksInfo"]`, Mozilla's own category for bookmark names, websites and
  folder names, which is exactly what a question sends. The switch in Settings is the
  consent in substance. `web-ext lint` accepts it.

### Fixed

- **The bookmark baseline survives a reload.** Setting this browser as the group's
  bookmark baseline wrote the marker to the storage but showed "not set" again on the next
  reload. The marker is now read back from the storage, and the local record is kept when
  the storage no longer holds the marker — the card then says so, instead of quietly
  claiming there is no baseline.
- **The baseline keeps pointing at the tree it published.** The marker pinned the exact
  tree it named, but the baseline browser's own next upload replaced that file under the
  same name, so the marker named a copy that was no longer there: a browser joining later
  waited forever, and the baseline stopped reaching it. The marker is now restamped with
  the checksum of the tree just published, after re-reading it, so a baseline taken over
  by another browser in between is not quietly undone.
- **The baseline is verified against the storage before it is reported.** A storage that
  accepts the marker file and loses it would show "this browser is the baseline" now and
  "not set" after the next reload, with nothing in between to say why. The write is read
  back, and the baseline is only reported once the storage actually holds it.
- **A browser that does not sync bookmarks cannot be the baseline.** Its bookmarks would
  never keep up with the other browsers. It is refused, with the reason, and nothing is
  changed.
- **The baseline handover is atomic.** The other browsers' published copies are removed
  first and the marker is written afterwards, so a failure in between leaves the group as
  it was instead of half-replaced. The restore point is taken before anything is removed.
- **The error message after a failed handover says what actually happened.** It used to
  claim nothing had changed, although the other browsers' files had already been removed.
- **The baseline card can no longer be "saved" into nothing.** Choosing the baseline opens
  a confirmation, and its confirm button carried the same label as the one that opened it.
  With the page's "Save changes" right below, "click set, then click Save, then reload"
  looked complete — and came back as "Not set", because Save does not apply the baseline
  and the confirmation was never confirmed. The confirm button now says what it does
  ("Yes, set this browser"), and pressing "Save changes" while a confirmation is still
  open says so in the card: it takes effect immediately, and Save does not apply to it.
  Clearing the baseline gets the same treatment.

## [1.5.19] - 2026-11-14

### Added

- **An optional AI assistant for bookmarks — off by default, bring your own key.** Settings →
  AI assistant takes an OpenAI-compatible base URL, a key and a model name; nothing leaves
  the device until the feature is enabled AND a question is asked. One non-streaming
  `/chat/completions` request carries only a reduced bookmark list — title, hostname and
  folder path — after sync exclusions, unsafe schemes and URLs carrying tokens have been
  removed. **The candidates are picked on this device**: a local text match on the question
  (Chinese questions included) plus the most recently added bookmarks, at most 120 entries,
  searched in small batches, so a deep tree is never cut off silently the way a fixed
  "newest N" slice would. The organisation plan looks only at bookmarks filed directly in a
  root, at most 400. The endpoint's host permission is requested on first use, not at
  install. Three things share that one channel: natural-language bookmark search in the
  popup, organisation suggestions in Settings (a plan only — tick rows, take a pinned
  restore point, then apply), and one-tap explanations of the last sync receipt or pending
  conflicts. Provider status codes are surfaced (401/403, 404, 429, 5xx) so a wrong key is
  told apart from a rate limit, and a request can be cancelled. Model output is untrusted:
  every returned id is checked against the ids actually sent, and answers are rendered as
  text. The key stays in `storage.local`, is never synced, and is stripped from every
  settings export including the encrypted one. README.md, README.en.md and PRIVACY.md now
  spell out the single new data recipient.

### Fixed

- **A Chinese browser no longer loses bookmark moves.** The root-kind resolver knew the
  English root titles and nothing else, so a profile whose root ids it did not recognise
  AND whose interface was in Chinese had no root kind at all — and that answer carries
  the folder paths, so the delete, rename and reposition records were never written. The
  symptom was a device where deletions arrived but moves never did. Simplified and
  Traditional Chinese root titles are now recognised (书签栏 / 收藏夹栏 / 其他书签 /
  書籤工具列 / …), in every engine's wording.
- **A reorganization made during a sync is no longer discarded.** The recorders used to
  suppress anything that happened while an import was running, and the merge's own writes
  were told apart by a title-and-node ledger that covered renames only. A move or a
  deletion the user made while a merge was folding therefore lost its record — and that
  record is the only thing that carries such an edit to the peers, since a tree alone
  relocates and removes nothing. The moved bookmarks stayed in the old folder everywhere
  else, deleted ones came back, and an emptied folder could never be pruned; from the
  field this read as "sync stopped working". The ledger now covers moves and removals by
  their target parent and node id, a merge no longer suppresses the recorders wholesale
  (only a wholesale import does), and the logs are folded into their CURRENT value rather
  than into the snapshot read at the start of the fold — a change recorded during those
  seconds is no longer overwritten.

## [1.5.18] - 2026-11-12

### Added

- **Search in the popup.** One field searches bookmarks, history and the reading list
  together and opens the result in a new tab. Everything is scanned from what this
  browser already holds — no index to build, no index to go stale, nothing uploaded.
- **A reading list that rides the existing bookmark sync.** Saving the current tab adds
  it to an ordinary folder called `Kesonode Reading List`, which means it appears in the
  browser's own bookmark manager, survives restore points and reaches other devices with
  the next bookmark sync. A new data type would have needed a new file, a new encryption
  path and a new merge; a folder needs none of that. The name is deliberately not
  translated, because it is an identity that travels between devices. Saving the tab
  uses the new `activeTab` permission rather than broad tab access.
- **A sync receipt, and an Undo that goes with it.** Activity now answers "what did the
  last sync actually change here" instead of only "success": items added and removed per
  type, which device published, how many bookmarks moved or were retitled, and a sample
  of what left. When a merge is about to remove a meaningful share of this browser's
  bookmarks (at least 5 and at least 10%), a restore point is saved *before* it is
  applied and **Undo this sync** restores that tree. The last 30 receipts are kept.
- **Bookmark cleanup.** Settings → Bookmarks finds duplicate URLs (case- and
  trailing-slash-insensitive) and, behind its own button, dead links. Duplicates are
  shown with their folders and dates, and nothing is removed until the rows are chosen
  and confirmed. The link check is opt-in and capped at 300 links per run because it is
  one network request per host from this device; only 404 and 410 count as dead, so
  timeouts, login walls and rate limits are left alone. Contacting arbitrary sites is
  why `http://*/*` was added to the optional host permissions — it is requested when the
  check is first used, not at install.
- **Bookmark export in three forms.** Netscape HTML for any browser's bookmark importer,
  Raindrop CSV for bookmark managers, and a self-contained read-only page that a phone
  can open without the extension. The page can be published to the configured storage
  device and removed again; publishing states plainly that this copy is not encrypted,
  because a page meant to open anywhere cannot be.
- **Session snapshots, kept locally.** The last 20 sessions this browser saw are kept in
  a local ring, so a crash, a closed window or an unsynced interval leaves a way back to
  the tabs. They are taken after a session sync, deduplicated by a signature over the tab
  URLs, never uploaded, and only shown in Settings.
- **A sync doctor.** Settings → Advanced runs local checks and copies a diagnostic
  bundle for a bug report: versions, backend type, held permissions, relevant settings
  and the last error. Passphrases, tokens, passwords and credentials embedded in storage
  addresses are removed by construction, so the bundle is safe to paste into an issue.
- **Per-type conflict strategies.** The global strategy can now be overridden for
  bookmarks, history, sessions and extensions, so "merge history automatically, ask me
  about bookmarks" is one setting rather than a compromise.
- **A bookmark order mode.** With **Keep this browser's order**, a peer's recorded move
  no longer repositions bookmarks here; additions, deletions and renames still converge.
  This is for browsers that sort a folder automatically and would otherwise push that
  order everywhere.
- **An `kesonode` omnibox keyword.** Type the keyword and a few letters to get the same
  local search from the address bar. Suggestion text is escaped, since Chrome parses it
  as a small XML fragment and bookmark titles routinely contain `&` and `<`.

### Changed

- **Exported settings no longer carry credentials unless you ask for them.** The default
  backup (format v2) restores providers, folders, schedules, preferences and the device
  ID, but not the WebDAV password, GitHub token, Google Drive session or E2EE passphrase.
  A restore signs in again, or keeps the credentials this browser already holds for the
  same server and account.
- **An opt-in encrypted backup.** Ticking **Include sign-in credentials** adds the
  secrets and encrypts the whole file with a password you set (AES-256-GCM) before it is
  written; there is no path that produces a plaintext credentials file. Importing an
  encrypted backup asks for that password, and a redacted one that enables E2EE asks for
  the passphrase it deliberately left out. Plaintext v1 files from older versions remain
  importable and still show the "contains credentials" confirmation. The setup wizard
  accepts the same file and asks for the missing secret in the same panel.
- **Conflict buttons say what they do to this browser.** The popup now reads **Keep this
  device** / **Use the other device** (保留本机 / 采用对方), the card's header action is
  **View changes**, and each button's tooltip names the device it applies to instead of
  relying on the heading above it. "Use the other device" still merges its copy into
  this one; it does not replace this browser's bookmarks.
- **A warning when the extension's text is out of date.** Replacing the source files
  without reloading the extension leaves the browser serving the old language catalogue,
  so new buttons show their raw keys. Settings detects this and shows a banner telling you
  to reload the extension and refresh the page; the install guide ends with the same step.

### Fixed

- **A configuration import is checked against where it actually points.** The risk
  confirmation already flagged a different backend type, but a backup of the same type
  aimed at a different server, repo or folder slipped through unannounced — so restoring
  it could silently redirect sync. The endpoint is compared now, and a device ID or storage
  path that could escape its folder is refused rather than written.
- **The diagnostic bundle redacts the storage username too.** It already stripped
  passphrases, tokens and passwords and scrubbed credentials out of URLs; the WebDAV
  account name and email were still copied verbatim. Both are removed now.
- **Reusing this browser's GitHub token on import requires the same repository.** Keeping
  the stored token while importing a backup that named a different repo handed the token to
  a repo it was never meant for; it is kept only when the repo matches.
- **The generated recovery key is unbiased.** It mapped random bytes onto its alphabet with
  a remainder, which slightly over-weighted the first characters; rejection sampling now
  makes every character equally likely.
- **A failed reading-list load no longer looks like an empty list.** The popup says it
  couldn't load the list, with the reason, instead of showing nothing.

## [1.5.17] - 2026-11-12

### Fixed

- **Importing a configuration no longer logs a gesture failure it could not avoid.** The
  import asked for the WebDAV server's host permission after the file read and the
  overwrite/risk questions, by which point the click's user gesture was spent — so Chrome
  answered `permissions.request` with "This function must be called during a user
  gesture", and the warning was also written to Activity for a permission nobody had
  refused. Settings now reads what is held and shows the one-click **Grant access** row
  instead, whose button still carries the gesture.

## [1.5.16] - 2026-11-11

### Added

- **A bookmark baseline that survives the one-time direction question.** "Use this
  browser's copy" was asked once and could not be corrected afterwards, and an install
  that imported another browser's configuration usually counted as already set up, so
  the question could go unanswered while sync stayed parked and nothing was merged.
  Designating a baseline now publishes this browser's tree and writes a shared,
  E2EE-aware `konode_baseline.json` marker naming that exact packet. Every other browser
  saves its own restore point, aligns with that tree once, and merges both ways from then
  on. Activity shows which browser is the baseline and whether this one has aligned;
  Settings → Device can designate or clear it. A follower waits for the checksummed packet
  the marker names instead of adopting whatever copy is in the folder, an empty tree is
  refused, and forgetting the baseline device clears the marker.

### Fixed

- **"Test Connection" now tests the address in the form, not the last saved one.** The
  button sits under the fields it checks, but it asked the service worker to test the
  saved configuration, so correcting a WebDAV URL and pressing Test still reported the
  previous URL's error every time — a 404 that survived switching back to an address
  that had just worked. The test uses the on-screen configuration now, and a 404 says
  what it means on WebDAV: no collection at that exact path (paths are case-sensitive).

- **A metered cycle stops at the first refusal instead of walking every data type.**
  When Nutstore's window was already spent, each remaining type still ran, was refused
  by the backend's own guard, and added its own copy of the quota explanation — the popup
  ended up with the same paragraph once per type plus a "Couldn't read N device file(s)"
  line, which framed a storage-wide quota as a broken file. The cycle now stops as soon
  as the backend reports the window spent, says one sentence without a type prefix, and
  marks every type that got no attempt as not-synced, which is the truth about them.

## [1.5.15] - 2026-11-11

### Changed

- **The first-sync direction is asked only in setup, and only once.** "Which side wins"
  was a card in Settings → Activity as well as a step in the wizard; it is now the
  wizard's step alone (the Activity tab keeps conflicts). The popup's primary button and
  the pending notice both lead there, and the step has a "Set up later" button next to
  the answer, so the way out is not just a sentence of small print.

### Fixed

- **"Use the other device's copy" no longer reports a replacement it did not perform.**
  A peer packet can open cleanly and still hold an empty tree; the import refuses to wipe
  this browser for it, but the first-sync step still logged "Replaced this device's
  bookmarks" and marked the question answered. It now refuses up front, with the reason,
  leaves the tree untouched, saves no restore point, and keeps the question open.

- **An unreadable peer packet no longer leaves a restore point behind.** For the
  "use the remote copy" answer the point is a precondition, and it was written before
  the packet was opened — so a version mismatch, an E2EE disagreement or a bad checksum
  left a point for a replacement that never happened. The packet is opened first now.

- **The rate-limit window belongs to the storage that refused.** Pointing Kesonode at a
  different backend, folder or repo during Nutstore's half hour left automatic sync
  parked against a storage that had never refused anything, and the UI blamed that one.
  Saving a different connection target now drops the window; changing only the
  credential keeps it, since re-signing in does not un-meter the same server.

- **The first-sync question is asked only when this browser has bookmarks to protect.**
  It used to be asked whenever anything was publishable, including a device with an empty
  tree and a deletion log; the "use this browser's copy" answer would then have emptied
  the group's bookmark files with nothing to offer in return.

- **"Use this browser's copy" re-publishes only bookmarks.** Clearing the whole upload
  checksum made history, sessions and extensions upload again in the same cycle, spending
  a metered window on files nothing had changed.

- **An answered direction cannot be applied twice.** A second setup tab, or one left open
  while the answer was given elsewhere, ran the destructive half again — deleting files
  the peers had already re-uploaded, or replacing the tree from a different "newest" peer.

- **Device names are no longer re-decorated on a fresh read.** Peers whose labels were
  written by older builds ("Macbook · Edge · 451dbeb9") were stripped only when served
  from the local cache, so the same device changed name between refreshes. Following a
  "Forget" the device also no longer reappears from that cache during a refused listing.

- **Restore points keep the name the device had when they were created**, and an offline
  snapshot list merges a partial local entry with the shared index instead of letting it
  erase the device name and count.

- **The popup no longer throws on open**, and its stream dots distinguish "never synced"
  and "last run failed" from "synced": a green dot next to an error banner said both.

## [1.5.14] - 2026-11-10

### Added

- **Settings → Activity now shows whether sync is working, not just how much moved.** The
  page had three numbers (transferred, runs, last sync) while the actual status and reason
  for failure lived only in the popup banner. A persistent status bar now shows the state,
  how long ago the last sync ran (hover for the exact time), when the next one is due —
  read from the real `chrome.alarms` schedule instead of inferring it from
  last-sync + interval — and the last error when there is one. A row of per-type totals
  follows, with disabled types dimmed but still counted, which answers "why is history
  always 0". The popup's timestamp is now "3 minutes ago", the same wording as the device
  list.

### Fixed

- **A bulk-delete approval no longer outlives the sync that read it.** The allowance the
  safety guard consumes is one cycle's budget, but it stayed on the engine instance after
  the sync finished. Any later operation that consulted it — most visibly "Use remote"
  on a conflict card seconds later — inherited a consent the user gave for a different
  run. It is now reset in the same `finally` that releases the sync flag and passed to
  the bookmark merge as an explicit argument.

- **"Use remote" on a conflict now says when the safety guard stopped it.** Applying the
  remote side could block a mass deletion, but the card was still removed and the
  resolution remembered, so the conflict looked resolved while nothing had been deleted.
  The resolution now throws with the numbers (how many of how many bookmarks, the cap and
  the percentage), leaves the conflict pending, and points at Settings → Safety.

- **Turning automatic sync off actually stops it, including after a restart.** The periodic
  alarm ignored `auto_sync`: a window that was open before the setting changed, or an
  alarm left over from an older build, kept syncing. The worker now clears the alarm at
  startup when the setting is off and re-checks it each time the alarm fires.

- **Two windows saving settings at the same moment no longer lose one change.** Settings,
  sync state and the sync lock were read-modify-write of the whole object, so the options
  page changing the passphrase while the popup disconnected a backend could drop one of
  the two writes. All three now run through the same serialized `updateKey` as the
  bookmark logs; a settings backup imported at the same time goes through the same path.

- **A restore point can no longer lose its annotation to a race or a cached listing.** The
  shared index is written only conditionally on every attempt; exhausting the retries
  leaves the remote index untouched instead of overwriting another device's work. An entry
  is dropped only when this device successfully deleted that file — a name missing from a
  cached listing (WebDAV) is not proof of deletion. A pending pin rename that fails for an
  unknown reason is kept for retry with its retention protection, and moving a point reads
  the actual files rather than a listing before deciding the source is gone.

- **A rate-limit window no longer feeds itself, and Nutstore's 503 is recognised as one.**
  The "Reset stuck syncing state" recovery wrote to the audit log on every worker wake, so
  a 200-entry log could fill with 120+ of them and push the real 403s out. It is now a
  console line. Nutstore answers 503 (not 403) for some methods when the window is
  exhausted; that used to be reported as "check the path and that the account may write"
  and did not start the cool-down, so the worker kept spending an empty window every
  minute. Other hosts keep the path explanation for a 5xx, so one blip does not park a NAS
  for 30 minutes.

- **"Use remote" on the first sync no longer leaves a restore point that replaced
  nothing.** The point was written before the download; a refused download then left a
  point with identical content and no cool-down, so the next click failed the same way.
  The peer is read first, the restore point written only after that succeeds, and a
  refusal now starts the rate-limit cool-down. The "use this browser" branch also stops
  deleting peer files once the account is meter-limited.

- **Overlapping bookmark import and restore no longer record each other's writes as user
  edits.** The suppression flag was a boolean, so whichever operation finished first
  exposed the other's create/remove churn; a restore running during a merge could
  tombstone the bookmarks the merge had just written. It is now a counter. URL comparisons
  for "is this bookmark really gone" also use the same canonical form as the rest of the
  merge.

- **Restoring a session checks the tab it asked for, not the total count.** A failed open
  was inferred from "the number of open tabs did not grow by two", so closing a tab while
  a restore ran produced a wrong "blocked" verdict that stranded every later restore in
  one window. It now confirms the new tab id exists, and only a restore that actually got
  a second tab open records that this browser allows more than one — a one-tab session no
  longer claims it measured anything.

- **A history visit-time rejection is only assumed when the error is about visit times.**
  Any failure of `addUrl` with a visit time marked this browser as not supporting them,
  even when the real cause was something else. The plain add is retried first, and the
  capability is only disabled when the error names `visitTime`.

- **Drive and GitHub writes are safer around versions and paths.** Drive listings now
  follow pagination, conditional writes take the ETag from the response headers, and a
  404 while storing a versioned file is reported as "gone" instead of being recreated.
  GitHub encodes each path segment and the branch, and a 422 that carries a SHA is
  surfaced as a real error rather than a lost race. OAuth sessions are generation-checked
  and refreshed once for concurrent callers; an explicit sign-out is not undone by a
  queued auto sign-in, and token responses are never logged.

- **A restore point keeps naming the device that actually took it.** The default name is
  `Bookmark restore point · <device> · <short id>`, and the device half was re-derived from
  the CURRENT settings — so renaming the computer, or importing a settings backup that
  changed its name, re-labelled points that had been sitting on the backend for weeks. One
  machine's restore points could be found under three different names on the same screen.
  The tag is now frozen into the shared index (`auto_name`) at the moment the point is
  saved; later settings changes reach only new points. Points saved before this build keep
  the device recorded in their own entry, which was already frozen per point.

- **The extension no longer quietly renames the computer, which renamed its restore
  points.** `cleanDeviceLabel()` strips the `<browser> · <short id>` halves that old builds
  glued onto the device name — but it stripped a browser word from ANY label ending in one,
  so a name its owner typed ("Macbook · Edge", natural on a machine that runs several
  browsers) was rewritten to "Macbook" the first time settings were read. Since a restore
  point is named after its device, that surfaced as "the names changed by themselves". A
  browser word is now only treated as machine-written when the machine's short id came off
  the same string; the old `<OS> · <browser> · <id>` form is still cleaned.

- **A restore point named after your own machine keeps that name.** `snapshotIsUnnamed()`
  treated any name starting with the device label as machine-generated, so "Macbook 升级前"
  silently reverted to the default the next time the list was drawn. Only an 8-character
  device id inside the name is proof that a machine wrote it.

## [1.5.13] - 2026-11-10

### Added

- **A first sync between two devices that both have bookmarks now asks which side wins.**
  The old behaviour was a silent, non-destructive merge — safe, but a new browser had no
  way to say "replace my bookmarks with my other machine's" or "start this group from the
  bookmarks I already have here". When a device has bookmarks, has never published a packet,
  and peers already have bookmark files, sync pauses without merging or publishing; the
  popup shows a card and Settings → Activity offers **Merge** (the old behaviour), **Use the
  remote copy** (clear this tree and rebuild it from the newest peer, with a restore point
  saved first), and **Use the copy in this browser** (delete the peers' bookmark files).
  The decision is per-install and never travels in a settings backup, so a browser restored
  from another browser's config still gets to choose. The card also stays in Activity as a
  manual "choose again" entry point, e.g. after a storage outage. A probe that fails (a
  WebDAV 503) falls through to the ordinary merge instead of parking sync. No new shared
  file type and no SyncPacket change: the frozen wire contract is untouched.

- **The first page of setup can restore a settings backup.** Reinstalling used to mean
  closing the wizard, finding Settings → Advanced and importing there. The welcome screen
  now offers **Choose a backup file and import**, with the same overwrite / new-device /
  sensitive-change questions as Settings. It marks setup complete, drops the draft, and
  asks for a WebDAV host permission if the imported config needs one. Both entry points
  share one implementation (`utils/settings-import.ts`), so they cannot drift apart.

- **An update that needs a permission opens a one-click grant page.** A new version can
  require an optional permission, and an imported WebDAV config can bring a host permission
  nobody granted. After `onInstalled(reason: "update")` the worker checks what the CURRENT
  setup needs (`missingPermissionsFor`) and opens `onboarding.html?reason=permissions`,
  which lists what is missing and asks in one click. `permissions.request()` needs a user
  gesture, so the worker never tries to ask by itself; the Settings **Grant access** rows
  remain the way back in if that page was closed. That first page carries the same
  backup-import option as the welcome screen, so an update never sends anyone into
  Settings just to restore a config.

- **Setup asks for a device name on the first page.** A browser does not expose the
  computer's own name to an extension: the automatic label can only be
  `Mac · Chromium · <short id>`, never `Mac mini M4pro`, and two identical machines look
  identical. The welcome screen now carries the name field (shared with the storage step)
  and says why it has to be typed; Settings → Device says the same under its field.

- **The first-sync direction question is asked in the setup wizard, where the sync was
  paused waiting for it.** Choosing a side was implemented on Settings → Activity, so a
  fresh install that met another device's bookmarks ran its progress step into the
  20-second timeout and left the user on a "done" screen with nothing synced and no
  visible next step — the answer lived on a screen nobody opens on their first day. The
  wizard now watches for `first_sync_pending` and, before it times out, shows the three
  answers (Merge / Use the remote copy / Use the copy in this browser) on a step of its
  own, taken from the same message keys Activity uses so the two screens cannot come to
  describe the consequences differently. Answering resumes the progress step and finishes
  the remaining data types; closing the page instead is safe and is said on screen — sync
  stays paused, and the question is still waiting in Activity. Reloading the wizard midway
  now returns to that question rather than to "welcome" for an install whose settings were
  already saved.

### Changed

- **The settings-backup warning is now localized, and the export file's contents are
  documented.** Settings → Advanced has always said the file holds credentials in plain
  text, but the confirmation dialog was Chinese-only in every locale. It goes through
  `_locales` now (all 11 locales), and `PRIVACY.md` gained a **Settings backup** section:
  the file really does contain the WebDAV password, the GitHub token, the Google refresh
  token and the encryption passphrase, it is checksummed rather than locked, and no lock
  is possible because the file is what holds the passphrase. It is a password, and should
  be treated as one.

### Fixed

- **A failure that repeats identically stops being retried every minute.** A wrong
  password, a revoked token, a repository that no longer exists: these fail the same way
  on every cycle, and the engine used exactly the same cycle to say so — rewriting the
  status, appending a kept line to the 200-entry Activity log and waking any open popup
  with a sentence it had already shown. Left alone for an afternoon the log was nothing
  but copies of that line, which is how the entries the popup sends people in to read
  disappear (#20 again). The same message in consecutive cycles now buys a growing pause
  (2 → 4 → 8 → 15 minutes, the message itself being what identifies "the same failure"),
  said once in the log while it grows. A different error starts over immediately, "Sync
  now" is never gated and clears the count, and saving settings clears it too — which are
  the two things someone does after fixing the cause. Rate limits keep their own
  30-minute cooldown and are not counted twice.

- **A restore point saved by hand is no longer rotated away by automatic ones.** Ten
  slots, shared: a week of blocked deletions (a browser whose own bookmark sync runs
  alongside Kesonode will produce exactly that) evicted the backup someone took on purpose
  before an upgrade, silently, with nothing left to restore. Points now carry their kind
  in the FILE NAME — the same mechanism `konode_snap_kept_` already uses — with
  `konode_snap_manual_` in a ring of its own (10), so automatic points cannot reach the
  ones you saved, an unreadable index cannot blur the distinction, and a device on an
  older build simply does not see them (and therefore cannot prune them).

- **Two devices saving a restore point at the same moment no longer lose one's name and
  count.** `konode_snap_index.json` is the ONE file several devices write, and it was
  read-merge-written with nothing to stop the later write from replacing the earlier one's
  entry — which looks, from the outside, exactly like "my restore point lost its name
  again". `IBackend` gained `getFileVersion` / `putFileIfVersion`: WebDAV uses `If-Match`
  (or `If-None-Match: *`) with the ETag, GitHub uses the blob SHA it already sent, Drive
  uses the file's `etag`. A lost race is simply redone — re-read, merge, write — up to
  three times, and the last attempt is unconditional so the improvement can never cost
  the write. Renaming and keep-forever go through the same path.

- **A safety-net restore point no longer pays for a second connection.** The blocked-
  deletion and held-drift paths called `snapshotNow()` from inside a sync, which built a
  NEW backend and connected it — an extra MKCOL/PROPFIND on the one cycle that can least
  afford it, since those incidents usually happen while a metered storage is refusing
  requests. They now reuse the connection the sync already holds. The held-drift point
  also records `origin: "auto"` now, so Activity stops presenting it as one you saved.

- **Drive and GitHub rate limits now park the sync the same way WebDAV's do.** The
  30-minute cooldown keyed off `HttpError.rateLimited`, which only the WebDAV backend ever
  set — and neither of the other two providers says "slow down" in a status code. Drive
  answers with **403** and puts `rateLimitExceeded` / `quotaExceeded` in
  `error.errors[0].reason`; GitHub answers with **403** plus `x-ratelimit-remaining: 0`, or
  `retry-after` for its secondary limit. Read as ordinary hard errors, both produced
  "Drive list failed: 403" once a minute, forever, and spent the next window's quota on the
  same refusal — the Nutstore failure mode in a different costume. Both backends now
  classify the refusal (`IBackend.rateLimited`), say what to do about it, and Drive's
  `storageQuotaExceeded` gets its own message, because an out-of-space Drive is not
  something waiting fixes.

- **"Use the remote copy" no longer replaces a bookmark tree it could not back up first.**
  The first-sync answer that rebuilds this browser's bookmarks from a peer used to save a
  restore point and carry on if that failed — a warning in the log instead of a backup, on
  the one action that can destroy local data in a single click. A failed restore point now
  aborts before anything is touched, keeps the question on screen with the reason, and
  leaves the answer open. The other destructive answer (delete the peers' files) still only
  warns: it deletes nothing on this device, and those devices re-upload.

- **A peer file that is present but unreadable is reported, not skipped in silence.**
  `downloadAll` skips an oversized file (25 MB guard) or a corrupt one so the other peers
  still merge, but neither was recorded as a failed peer — so the cycle called itself clean
  with one device's data missing from the merge, every time. It does not heal by itself
  either: `uploadIfChanged` skips a re-upload while the owner's checksum still matches, so a
  file that is corrupt at rest stays corrupt. Both cases now go into `failedPeers` with the
  size or the reason, which is what turns it into a visible problem.

- **A rate-limited WebDAV account now actually backs off, instead of retrying every
  minute for as long as it stays over quota.** Nutstore's free plan allows 600 requests
  per 30 minutes, counted across every app using the account, and answers 403 rather than
  429. A 30-minute cooldown existed, but it only fired when the sync loop itself threw —
  and the two paths that mattered most (the device list and the restore-point list) caught
  their 403 and carried on. So the cycle "succeeded", the next minute asked again, and the
  account could never climb back under its quota: one Activity log held 25 refusals in five
  minutes. A metered backend now reports it (`IBackend.rateLimited`), the engine parks
  automatic sync for a window from EVERY path that can hit a refusal, and a refused
  backend stops sending requests for the rest of the cycle. The report also names the
  cause it found instead of showing a raw status: that account was 3 devices on a 60-second
  interval, which is more than 600 requests per 30 minutes before anyone types anything.

- **A sync cycle asks the storage once, not once per question.** `listFiles`,
  `listFilesWithTimes` and `downloadAll` each ran their own PROPFIND, and the restore-point
  list asked twice more, for folders whose contents were identical. One PROPFIND per
  backend instance now answers all of them (invalidated by any write), each peer file that
  has not changed since the last download is merged from a local copy of its bytes (same
  merge, same conflict resolution, same delete guard — only the round trip is skipped), and
  the device list reads a name from the local cache before spending a request on it. With
  three devices on a one-minute interval this is the difference between ~1300 requests per
  window and well under a hundred.

- **Restore points keep their device name and bookmark count while the shared index is
  unreadable.** `konode_snap_index.json` is the only place a restore point records who
  saved it and how many bookmarks it held, and a metered storage refuses it for whole
  windows. The list then showed one bare "Bookmark restore point" per point — the newest
  one named only because this device had created it. The last index this device managed to
  read is now kept locally and used as a read-only fallback, so a refused index costs
  nothing on screen. It is never written back, so it cannot resurrect a stale index over a
  newer one. A folder that cannot be listed at all now shows the points this device knows
  about instead of an empty list that reads like "you have no backups".

- **The device name no longer carries a machine half the user cannot delete.**
  `device_label` stored `<OS> · <browser> · <short id>`, so the Settings field read
  `Mac · Edge · 451dbeb9`, editing it produced `Macbook · Edge · 451dbeb9`, and every
  restore point inherited that hybrid. The label is now the user's own words only
  (default: the plain OS name), with the browser and the 8-char id derived at display
  time — the device list shows both next to the name, and restore points keep the id they
  are matched by. Existing labels are migrated once on read: the trailing `· <8 hex>` and
  `· <browser>` are stripped, names that merely look numeric (`工作机 · 20240101`) are left
  alone, and a name the user typed is never overwritten.

- **A peer's cached packets are scoped to the storage they came from.** File names are
  `konode_<type>_<device_id>.json`, and the same device id can exist in two accounts (a
  config imported with "keep this identity", or a folder copied between servers). Switching
  the active backend would then merge the old account's data into the new one. The local
  packet cache is keyed by origin + folder + account, so it never crosses that line.

- **A storage that refuses to serve a peer's file no longer looks like a successful sync.**
  WebDAV, GitHub and Drive each skipped an unreadable peer file with a warning and carried
  on; the cycle then published this device's packet and reported "Synced" with FEWER
  devices than the folder actually held. That is exactly the shape of the "both browsers
  mind their own business" report when a WebDAV answers 503: both sides showed a clean
  sync, neither had merged the other. A single peer-file GET now gets one short retry for
  transient statuses (5xx/429/408/423 — not 401/403/404), and a failure that persists is
  collected on the backend and turned into a visible sync ERROR that names the files and
  says their data was not merged. One bad file still does not stop the other peers.

- **"Use the copy in this browser" no longer reports success when deletions fail.** A 503
  during the peer-file deletions used to be logged and ignored, leaving the group half
  reset while the choice was marked done. It now throws with the number of files that
  could and could not be removed, keeps the choice open for a retry, and logs the follow-up
  needed on the other devices (choose "Use the remote copy" there).

- **Peers are no longer called "Unnamed device" when their files cannot be read.** The
  device list depended on downloading one of a peer's files at the moment the page opened,
  and gave up on the FIRST file that came back empty or threw — a WebDAV rate limit was
  enough to make two perfectly named machines call each other unnamed, as in the field
  report. Every sync now keeps a small local `device_id → name` cache from the packets it
  already downloaded, the list tries a device's other files before giving up, and falls
  back to that cache. The cache is display-only: nothing keys off it and the frozen wire
  contract is untouched.

- **Restore points keep their name when the shared index is refused.** With the index
  unreadable (Nutstore's 403), points with no annotation anywhere were relabelled with the
  name of whichever device happened to be viewing the list. Renaming a device, or importing
  a backup that changed it, therefore looked like somebody had silently renamed every
  older restore point. An unknown origin now stays unknown; a name the user chose, the
  shared index, and this device's own local annotations still win in that order.

- **The device list names data types in the page's language (upstream #87).** Its second
  line printed the internal ids ("bookmarks, sessions") inside a translated sentence. It
  now uses the same words as the data-type switches, joined by `Intl.ListFormat` so each
  language supplies its own punctuation; the Forget confirmation uses the same list.

- **Plain `http://` WebDAV no longer sounds like a risk you may accept.** The note under
  the address said the password "would be sent unencrypted", as if the connection worked.
  It now says Kesonode does not connect over it and what to use instead (upstream #83's
  wording change; the multi-screen `http://` validation is still upstream).

- **"Keep forever" no longer fails while the storage refuses writes.** The mark is the
  file name, so the click needed a PUT and a DELETE; Nutstore's 403 frequency cap
  rejects writes too, and one refused write made the whole click fail with a wall of
  403 text — while the pencil (rename) kept working because it has a local fallback.
  The intent is now kept in a device-local queue and shown as kept immediately; the
  rename is finished on the first sync or Settings visit that reaches the backend
  again, retention protects the queued point meanwhile, and a half-finished attempt
  (write done, delete refused) is completed without leaving a duplicate.

- **A rate-limited WebDAV server is no longer polled through its whole window.** The 403
  explanation added in 1.5.4 told a QuarkPC user to "wait for the window to pass", but
  the alarm kept running every 60 seconds, spending the NEXT 30-minute Nutstore window
  before it opened — a field report logged 403s five minutes apart with no recovery.
  A 429, or a 403 from a Nutstore host, now parks AUTOMATIC sync for one 30-minute
  window; "Sync now" and applying a blocked deletion are never gated, a clean cycle
  clears the pause immediately, and the Activity log says what happened once.

- **A missing optional permission no longer warns every minute, and can be granted with
  one click.** `extensions` stayed switched on with `management` never granted, so every
  cycle wrote the same "permission any more, switch it off and on again" warning (×1276
  in one night) while nothing synced. On QuarkPC that detour produced no prompt at all.
  The warning is now one per incident, names the browser's own permissions screen as the
  fallback, and Settings → Data Types has a **Grant access** button that only re-asks,
  re-checks the API and syncs that type immediately.

- **QuarkPC is named in the default device label.** Its user agent is Chrome's plus a
  `QuarkPC/` token, so a fresh install called itself "Mac · Chromium" and every peer's
  device list missed it entirely. Both the default label and the browser carried in a
  sync packet now read 夸克浏览器.

- **Restore points keep their default name even when the shared index is refused.**
  A WebDAV backend answering 403 (Nutstore's frequency cap) made `getIndex()` unreadable,
  so `mergeIndex()` wrote nothing and every point reached the UI with no device label,
  short id or count — `snapshotDisplayName()` had no data to build `Bookmark restore point ·
  <device> · <short id>` with and fell back to the bare prefix. That is why several rounds
  of naming changes never showed up. Annotations for points this install creates or renames
  are now also kept in `chrome.storage.local` and merged into the list when the shared index
  is unavailable; renaming and keeping a point no longer fail on an unreadable index. The
  local copy never reaches the backend, so cross-device names still depend on the index and
  the frozen wire contract is unchanged. Points saved before this build have no annotation
  anywhere; while the index is wholly unreadable, their display name falls back to the
  identity of the device viewing the list (display-only, never stored), so the corrected rule
  is visible immediately instead of only on points created after the upgrade.

- **A package can no longer carry a version different from its own filename.**
  `sync-version.mjs` used to bump the patch on EVERY run, and `build`, `build:firefox`
  and `package:source` each call it — one release could therefore produce several
  different versions. Zip filenames are built from `package.json`, but the
  `manifest.json` inside is copied verbatim from `dist/`: v1.5.5 shipped as a
  1.5.5-named zip containing a 1.5.4 manifest, which is also why source fixes looked
  like they never reached the installed build. Stamping is now idempotent and bumps
  are explicit (`npm run version:patch`, also repairing `package-lock.json`). Both
  package scripts refuse to zip unless `package.json`, `public/manifest.json` and the
  built manifest agree, and refuse a bundle whose HTML pages reference missing
  chunks or lack `type="module"` — the two halves of an `Unexpected token 'export'`
  failure when a new version is extracted over an old folder.

- **Importing a settings backup onto another browser no longer clones that device.**
  Restoring `device_id` verbatim made both installs write the same
  `konode_<type>_<id>.json` file and appear as one device. Import now asks once:
  "as a new device" (recommended) mints a fresh UUID and a default label of
  `<OS> · <browser> · <8-char id>`, while "restore this machine's identity" keeps the
  backup's values for a same-machine upgrade/reinstall. Accounts, tokens, passphrase
  and Drive session are restored either way.

- **Restore points finally use one naming rule.** The 1.5.3 rule
  `Bookmark restore point · <device label> · <short id>` was implemented three times:
  baked into the shared index at creation, duplicated as a UI fallback, and spread
  across locale suffixes. Changing it could never reach points an older build had
  already written. The default name is now computed at display time by
  `snapshotDisplayName()` and never stored as a user label; legacy automatic labels
  are recognised as unnamed by device + short id, and a name the user chose always wins.

## [Unreleased]

## [1.5.4] - 2026-11-09

### Fixed

- **A WebDAV 403 now says what it means.** Nutstore (坚果云) answers its WebDAV frequency
  limit with 403 Forbidden rather than 429 — 600 requests per 30 minutes on a free
  account, 1500 on paid, counted across EVERY app using the account — and that reached a
  QuarkPC user (field report, 2026-11-08) as a bare "WebDAV GET failed: 403" repeated
  every sync with nothing to act on. Every WebDAV 403 now names the host and, on Nutstore,
  the limit and the lever (wait for the window, or raise Sync interval); on other servers
  it points at the path and the account's rights instead. Test connection says the same.

- **Importing a config with a WebDAV backend now asks for host permission.** Previously the
  import replaced the settings but never requested the server's host permission, so the next
  sync failed with "Failed to fetch" and no prompt explained why. Import now requests the
  origin immediately, and if that is refused (e.g. the click's user gesture has elapsed),
  Settings → Advanced shows a "Grant access" button for the exact host.

### Added

- **The version is shown where copies are easy to confuse.** The extension name now carries the
  version (e.g. `Kesonode | 私人书签与标签页同步 v1.5.4`), so several unpacked installs loaded
  from different folders are tellable apart in the browser's extension list, and the popup
  footer shows `v1.5.4`.

## [1.5.3] - 2026-11-09

### Added

- **A local change guard keeps a runaway bookmark rewrite from reaching the whole group.**
  Running Kesonode alongside a browser's own bookmark sync is untested upstream: the
  bookmarks API never says WHO changed a bookmark, so a batch Chrome Sync just pushed in
  looks like a local edit and was published to every peer within a second. Nothing
  protected the SENDING side. Each cycle now compares this device's tree with the previous
  one; after several consecutive cycles of large, never-settling change (or one change of
  500+ entries) this device's upload is held, a restore point is saved and Settings →
  Activity explains why. Peers are still pulled and merged, nothing is deleted or
  reverted, and one quiet cycle clears the hold automatically — so a single bulk edit by
  the user still publishes immediately. The guard is local working state only: the frozen
  upstream wire contract (SyncPacket v1.0, `konode_*` names, folder, checksum, E2EE
  parameters) is untouched, and every device runs its own guard independently.

- **Restore points can be named, kept forever, and say which device saved them.** A
  point now leads with the name you gave it (or "Bookmark restore point"), with the
  device name, exact date and bookmark count as the supporting line underneath. The
  pencil renames it in place; the pin keeps it forever. "Forever" is a property of the
  FILE NAME (`konode_snap_kept_<epochms>.json`): retention walks only the ordinary
  `konode_snap_bookmarks_` prefix, so a kept point cannot be pruned by this build, by an
  older Kesonode, or by upstream Konode — it does not depend on every device being able
  to read (or decrypt) the shared index. Unpinning puts it back into the rolling ten.
  The frozen upstream names, the index format and SyncPacket v1.0 are unchanged; all new
  index fields are optional, and an index written by an older build still reads. Points
  saved by hand and points the bulk-delete guard saved are labelled separately.

- **A restore point with no name now names its device (+ short id) by default.** The
  unnamed row used to read only "Bookmark restore point", so on a multi-device group you
  could not tell which machine a point came from without opening it. The default title is
  now "Bookmark restore point · <device label> · <short id>" when the index carries the
  origin, and the supporting line keeps showing the device under a name you gave it. The
  short id is the first 8 hex chars of the saving device's id. Points the shared index has
  no device info for (older builds, or an index this device could not read) still fall
  back to "Bookmark restore point" alone.

- **Settings backups now have a versioned compatibility contract.** Import reads every
  supported format version and walks an explicit migration chain instead of refusing
  anything but a hard-coded `version: 1`; a file written by a newer build is refused with
  a message telling you to update, rather than being silently misread. Export and import
  share one table of settings and their validators, so a new setting can no longer be
  exported and then silently dropped on import, and a damaged value falls back to its
  default. A literal export file from each release is replayed in the test suite. The
  format is still v1: adding an optional setting does not need a new version.

- **Data exports now carry a format marker and a checked version.** `kesonode-backup-*.json`
  has a `format` field that older builds simply ignore, so the file still opens there.
  Import refuses a wrong marker or an unknown version with a message telling you to
  update, instead of parsing a future file under old rules. Files written before the
  marker existed, including the older top-level layout, still open; damaged entries are
  normalised out rather than aborting the import. Literal exports from both layouts are
  replayed in the test suite.

- **Both export files now carry a checksum.** `kesonode-settings-*.json` and
  `kesonode-backup-*.json` hash their whole envelope (minus the checksum itself) with
  SHA-256 over a canonical, key-sorted serialisation, so a truncated or half-written file
  is refused with a clear message instead of being partly imported. Files written before
  the field existed have none and are still accepted. This detects accidental damage only:
  there is no secret, so it is not an authentication code and can be recomputed.

- **Three compatibility modes** under Settings → Advanced → Compatibility: **Upstream**
  (default, `konode` / `Konode` folder + `konode_*` files), **Own file names** (same folder,
  `kesonode_*` files while still reading upstream ones), and **Fully separate**
  (`kesonode` / `Kesonode` folder + `kesonode_*` files only). The frozen upstream folder
  names stay byte-for-byte unchanged; the new ones are separate data. No double-read of two
  folders: switching starts a separate sync group and this device re-uploads its own data,
  because both the destination tag and the upload tag change with the mode.

### Fixed

- No user-facing links pointed at this fork's own home: the About GitHub link, feedback
  issue/email links, the store-rating row and popup card, and the crash-screen issue URL
  all referred to the upstream project or its store listings. They are now removed or read
  from a single `FORK_LINKS` constant, empty until the fork has addresses of its own.
- Activity log lines and the Drive-folder placeholder no longer present the upstream
  folder name as the product's name; the Settings page now shows the folder name the
  selected mode actually uses and explains why the default one is frozen.

## [Unreleased]

### Added

- **Settings can be exported and imported, so an unpacked upgrade no longer has to start
  from an empty setup.** Settings → Advanced → Import / Export has two new buttons that
  save and restore the backend accounts, the device ID, the encryption passphrase and the
  Google Drive refresh token as a JSON file. Chrome isolates `chrome.storage.local` per
  extension ID, and an unpacked build loaded from a new version folder gets a new ID, so
  until now every upgrade meant re-entering the backend and the passphrase. Export from the
  old install, import into the new one, and the wizard stays away. The file holds
  credentials in plain text and is kept on the user's machine; no data is sent anywhere.
  **From 1.5.3, local packages also keep the manifest `key`** (`npm run
  package:source:pinned`), which pins the ID so upgrading to a new folder needs no export
  at all. 1.5.2 deliberately ships without the key: it has to be loaded over the old folder
  so the old settings are still readable when they are exported.

- **A conflict shows what differs before you choose (#35).** With conflict resolution set
  to Manual, the popup asked you to Keep local or Use remote and said nothing about either
  version, so the choice was a guess. The card now has a Resolve button that opens
  Settings → Activity, where each conflict lists what is different: the bookmarks or
  visited pages the other device has and this one does not, and the ones only this device
  has, by title and address, with "and 43 more" under a long list. Bookmarks that both
  devices have, but under another title or in another folder, are counted too. Keep local
  and Use remote are right there and do exactly what they do in the popup, which keeps its
  own two buttons as well. The lists compare against this device as it is when you look,
  and looking changes nothing on either device.

- **The device list says how long ago each device last uploaded, and which browser it is.**
  Settings showed the exact date and time of a device's last upload, which is precise and
  hard to read at a glance. It now says "last upload 39 days ago" in your language, and the
  exact time is still there when you hover over it. A device that has uploaded nothing for
  more than 30 days gets a quiet INACTIVE mark and a line saying what that can mean: a
  browser uploads only when something it syncs has changed, so a long silence is either a
  quiet browser or one that is gone. Nothing happens to it on its own. Forgetting a device
  is still something only you do.

  Each row also names the browser and its engine, for example "Brave (Chromium)" or
  "Firefox (Gecko)", which tells the Chrome build and the Firefox build on one computer
  apart. Chrome itself reads "Chromium": Helium and other Chromium-based browsers announce
  themselves to sites exactly as Chrome does, and an extension cannot tell them apart, so
  naming any of them Chrome would be a guess shown as fact. Brave, Edge and Opera keep their
  names. That is all a device records about itself: no version, no operating system, no
  hardware details. A device shows it once it has synced on this version, and every device
  uploads its files once more after updating to carry it. Two identical computers still
  look identical here, and the upload time is what tells those apart (#10).

### Changed

- **A blocked deletion shows which bookmarks it would remove (#23).** When another device
  asks to delete more of your bookmarks than the bulk-delete limit allows, the card in
  Settings → Activity used to say how many, and who asked, and nothing about which ones.
  It now lists the first five by title and address, with "and 43 more" under them. They are
  the bookmarks Apply would remove, so you can tell at a glance whether this is a cleanup
  you meant or something you never touched. Ones that other devices already removed earlier
  in the day are not in the list, since they are gone from this device already.

- **The conflict resolution options say what they do with deletions.** Settings → Device
  described them only as which side wins, and deletions are where they differ most. Prefer
  Local never deletes a bookmark here because another device deleted it. Manual applies no
  bookmark change from another device, deletions included, until you choose that device's
  version in the popup. Last Write Wins and Prefer Remote handle deletions the same way: a
  bookmark deleted elsewhere goes here too, unless you added it again after that.

- **Settings calls a restore point a restore point everywhere.** Under the Restore points
  heading, three of its own lines said "Snapshot saved", "Save a snapshot now" and "Create
  snapshot", and Spanish, Italian, Russian and both Chinese followed the English. Simplified
  Chinese also had two words for the same thing, 还原点 in the heading and 恢复点 in the rest.
  It is one word now, in every language Konode ships.

### Fixed

- **Renaming a device now reaches the device list and the other devices.** The name rides
  on each sync packet, but the "already uploaded" check compared only the data inside it,
  so editing the name in Settings → Device changed nothing in the storage folder until a
  bookmark happened to change. Settings → Activity then read that stale file and showed
  the old name, or "Unnamed device" for a file written by an older build. The name is now
  part of that check, so a rename re-uploads each file once; the Activity list takes this
  device's name straight from its own settings, and looks in another file when the
  smallest one is too old to carry a name.

- **A new device on a Chromium-based browser is named after the engine, not after Chrome.**
  Every Chromium-based browser carries Chrome's name in what it tells websites, so a fresh
  install on Helium, Vivaldi or ungoogled-chromium was called "Linux · Chrome". It is now
  "Linux · Chromium". Brave and Edge are still recognized by name, and a name you already
  have, or typed yourself, stays as it is.

- **Simplified Chinese reads properly in five more places.** "Never" in Settings was a
  word that means nothing (用不, now 从未), the device ID label had a typo (设备iD), the
  idle status said "finished" (完成) where it means "ready" (就绪), the warning about
  encryption without a passphrase was a broken sentence about a "plaintext password", and
  the passphrase fields in Settings said "password" (密码) where setup says "passphrase"
  (密码短语).

## [1.5.1] - 2026-11-02

### Fixed

- **A folder renamed while a sync was running never reached your other devices.** Konode
  syncs about once a minute and a sync takes a few seconds, so a rename made in that window
  was dropped. The folder kept its new name here, but nothing told your other devices it had
  one: they went on matching it by the old name, so what you had in it arrived into a second
  folder under the new name, beside the one they already had — and the pair then came back to
  this device on the next sync. Renaming the folder again at a quieter moment was the only
  way through, and a folder already doubled up this way still has to be tidied up by hand.

  The window was there to keep Konode from mistaking its own work for yours, which is what
  the sync loop fixed in 1.5.0 came down to. It now tells the two apart by what the change
  was rather than by when it arrived, so a rename Konode applies during a sync is still
  ignored while yours is recorded, whichever moment you make it. Renaming a bookmark was
  dropped the same way, and is not any more.

- **A bookmark renamed inside an excluded folder stayed renamed only here.** Konode records
  nothing that happens inside a folder you keep out of the sync, which is the point of it —
  but taking the folder back out of the exclusion never caught up on what you had changed
  meanwhile. The new name sat there on this device, nothing told your other devices it had
  one, and renaming it a second time was the only way through. Unticking the box now
  publishes what comes back as it stands here — the bookmarks in the folder, and the
  folder's own name. A device that renamed the same bookmark more recently loses to that,
  which is the way round it should be: unticking the box is you asking for this device's
  copy to be the shared one again.

  Renaming the folder itself works because the exclusion remembers what it was called when
  you ticked it, which is still the name your other devices are using. Two things do not
  come back, and nothing remembers them: a folder renamed *inside* the excluded one keeps
  its old name elsewhere, and a bookmark moved to a different folder while excluded does
  not take its new place with it.

## [1.5.0] - 2026-11-01

### Added

- **Copy the Activity log for a bug report.** Settings → Activity has a **Copy log** button
  that puts the whole log on the clipboard as plain text, oldest first, with the Konode
  version and your browser at the top, ready to paste into an issue. Until now that meant
  selecting up to 200 rows by hand. The copy is word for word, so it includes the address of
  your storage server and of any pages Konode couldn't sync, and the button says so: read it
  before you post it anywhere public.
- **Rate Konode from Settings.** Settings → Advanced → Feedback has a row that opens Konode's
  page in the store you installed it from, the Chrome Web Store or Firefox Add-ons.
- **Konode asks for a rating once, and only once it has earned it.** After two weeks and
  200 syncs that went through cleanly with another device in your storage, the popup shows
  a small card at the bottom. Never during setup and never next to an error, a conflict or a
  held-back deletion. Rate it or say no thanks, and either way it is gone for good; rating
  from the Settings row counts too. Nothing about it leaves your device.
- **Keep bookmarks out of sync (#54).** An extension that keeps a big bookmark folder of its
  own had Konode syncing every entry in it, and the browser froze until it was done. Under
  Bookmarks, in setup and in Settings → Data Types, **Exclude bookmarks from sync** opens
  your bookmark tree with a box in front of every folder and bookmark. Whatever you tick
  stays on this device untouched: it is never uploaded, nothing your other devices do
  changes it, and changes inside it no longer start a sync. A ticked folder stays excluded
  when you rename it, and so does whatever the extension adds to it later. Excluding deletes
  nothing, so copies your other devices already have stay there. Moving a bookmark into an
  excluded folder takes it off your other devices, as deleting it would, and moving it back
  out brings it back to them, even one you saved a moment ago.
- **Open tabs keep their tab groups (#11).** A session now carries which of its tabs share a
  group, and Restore puts them back together. Allow group names and colours when Konode
  asks for open tabs, or later in Settings → Data Types, and those come back too; without
  that, the groups come back unnamed and your browser picks the colours. Chrome, Edge,
  Brave and the other Chromium browsers have groups, and so does Firefox from version 138
  (names and colours from 139). Where a browser has none, a session restores as before.
  Pinned tabs stay pinned and are never grouped, and a group's collapsed state is not
  synced: a restore shows you everything it brought back. Restoring a session you have
  restored before opens only the tabs you do not already have, and a new one joins the
  group already on your screen rather than starting a second one beside it; a tab you have
  since dragged out of a group is left where you put it.

### Changed

- **Settings fits a phone better.** A row whose button cannot fit beside its text now puts
  the button underneath, instead of squeezing the text into a narrow column: in Hungarian,
  Copy log's explanation ran to fourteen lines at phone width. Switches stay beside their
  labels.
- **Nutstore comes first when Konode is in Simplified Chinese.** The storage picker in setup
  and in Settings led with Google Drive for everyone, and from mainland China Drive answers
  only through a VPN that every sync would need open. In Simplified Chinese the first card
  is now Nutstore / 坚果云, which works there without one. Every other language, Traditional
  Chinese included, keeps the order it had.

### Fixed

- **Renaming a bookmark folder and then renaming it back could leave Konode syncing in a
  loop.** The folder's name flipped between the two every few seconds, on every device at
  once, and the Activity log filled with the same line — one report had sixty-nine of them
  in nine minutes. A rename travels to your other devices as an instruction filed under the
  name the folder had before it, so renaming `Nextend` to `Nextendweb` and back left two of
  them, neither cancelling the other. Replaying the pair renamed the folder twice and landed
  exactly where it started, and because each rewrite counted as a change, the next sync began
  at once.

  What kept it going was that the rename a sync itself applies was recorded as one you had
  just made, freshly timestamped. Published, that outranked every other device's copy of the
  same rename, so none of them could ever settle whose was newer: each re-stamped what the
  other had just applied. A rename is now read from the folder as it stands rather than from
  the notification that it changed, so a change Konode makes is no longer mistaken for one of
  yours. Renaming the folder to a third name was the way out before, and still works; a
  folder already in that state otherwise settles by itself once every device syncing it has
  updated, since one left on an older version goes on re-stamping for the rest.

  With **Prefer Remote** chosen under Conflict resolution, an instruction that had already
  been carried out could be carried out again on every sync for the same reason. It is not
  any more.

- **On Edge, everything arriving from your other devices landed in "Other favorites".**
  Konode worked out which root an arriving bookmark belonged in — the bar, other, mobile —
  from the number the browser gives that folder, which on Chromium has been 1, 2 and 3 for
  as long as there has been a bookmarks API. Edge 142 renumbered every bookmark on the
  profile, once and permanently, so the Favorites bar stopped being 1. With nothing left to
  recognise, Konode fell back to the one root it knows is always writable, and your bar,
  your folders and your mobile bookmarks all came down into "Other favorites" together.
  Syncing between other browsers was unaffected, which is why it looked like Edge was
  simply unsupported.
  Konode now asks the browser what each folder *is* rather than inferring it from a number,
  which is renumbering-proof and the same answer on Chrome, Edge, Brave and Opera. Each
  device also publishes that answer alongside its roots, so your other devices never have
  to guess from ids that only ever meant anything on the machine that wrote them, and an
  Edge whose titles are in your own language maps correctly too. Bookmarks already sitting
  in "Other favorites" are not moved back for you — Konode has no record of where they came
  from — but nothing new will be put there.
  Two things found alongside it are fixed as well. A "Managed bookmarks" root, the one your
  employer's policy fills, is never written to any more: it rejects every write, so anything
  routed there was quietly lost, and a peer's managed bookmarks now arrive in the ordinary
  "Other bookmarks" instead. And on a Chrome signed in to a Google account, which keeps a
  second set of roots for the account alongside the local ones, arriving bookmarks now
  consistently go to the account's bar instead of whichever of the two the browser happened
  to list first — the same tearing-in-half that Orion used to cause.

- **Setup can finish on Firefox for Android.** Firefox for Android has no history, but
  Konode offered History as a switch there, in setup and in Settings. Switched on, it made
  setup ask for a permission that Firefox for Android does not have, so **Finish & Sync**
  sent you to Firefox's extension settings again and again, where there was nothing to
  switch on. History now reads as not available there, as Bookmarks already did, and open
  tabs and the extension list set up as they should.
- **Prefer Remote keeps your bookmarks in order when a folder moves in front of them.** On a
  device set to Prefer Remote, dragging a folder in front of loose bookmarks on another
  device sent those bookmarks to the end of the bar here, behind the folder. The folder now
  takes its new place first, and the bookmarks around it stay where they were. The Activity
  line no longer counts them as moved either.
- **The Google Drive card says up front when this browser cannot sign in to Google.** On
  Firefox for Android, which has no way to, the card looked like any other until you picked
  it, and in Settings the explanation was in English only. In setup and in Settings the card
  is now dimmed and gives the reason in your language.
- **Setup tidies up after itself.** An error from the last step stayed on screen after you
  went Back from it. The final screen named WebDAV for Koofr, Nutstore and the other cards
  built on it, instead of the card you picked, and a line in its checklist that ran onto a
  second line was centred while the others were not. On Firefox for Android the Bookmarks
  row's icon was squeezed to a dot beside its explanation.
- **The storage cards speak your language all the way through.** In Settings the badge on
  your storage card read "active" and the Google Drive card's button "Disconnect" in every
  language, and the catch-all card was "WebDAV (other)" in setup too. They now follow the
  language Konode is in, and so does the name a screen reader gives each card in Settings.
- **Folders that share a name stay separate (#51).** Konode tells folders apart by their
  name, so several folders of one name side by side, unnamed ones most often, were merged
  into the first of them on your other devices, with all their bookmarks in it. The same
  happened when you brought bookmarks back from a restore point. Such folders now stay
  separate and in their order: each one is matched by the bookmarks it holds, and a new
  bookmark goes into the folder that holds the bookmarks around it. A folder that was
  already merged stays that way until you split it up again on that device; the bookmarks
  you move out of it go to the right folder on your other devices too.
- **Renaming or reordering one of several folders that share a name reaches the right folder
  (#51).** A folder rename travels as "the folder called X here is now called Y", and your
  other devices gave the new name to the first folder called X, which with several of them
  was not always the one you renamed. Moving such a folder among its neighbours went wrong
  the same way, and renaming an unnamed folder never reached your other devices at all. Now
  a folder that shares its name with a neighbour sends one of its bookmarks along, and your
  other devices rename or move the folder that holds it. Both devices need this version; with
  an older one on either side, it works as it did before.
- **A Nextcloud server set up on the WebDAV card stays on the WebDAV card (#51).** Settings
  marked the Nextcloud / ownCloud card as active for any address with `/remote.php/dav/` in
  it. That card rebuilds the address from the username, so changing the username or the
  server there could quietly break a setup that only the WebDAV card can hold: a Nextcloud
  app password created while signed in with an email address needs the email as the
  username, while the address keeps the plain account name. Now the Nextcloud card counts as
  active only when the address is exactly the one it would build itself.
- **Restoring a session no longer opens tabs you already have open.** Every restore opened
  the whole session again, so restoring another device's 10 tabs, letting it open an 11th
  and restoring once more left you with 21. A restore now opens only the tabs that aren't
  open in this browser yet, and the popup says how many of a session's tabs are already open
  here. When all of them are, the button reads **All open** instead of opening them again,
  in Firefox too while the tabs a restore just opened are still loading.
- **A deletion that arrives in pieces no longer slips past the bulk-delete limit.** The
  limit on how much of your bookmarks another device may delete judged each sync on its own,
  so a large deletion that reached this device a piece at a time went through piece by
  piece, every one of them under the limit, and could empty the tree just the same. Konode
  now adds up what other devices removed here over the last 24 hours and holds back the
  piece that takes the total over, with a restore point saved first and the usual choice in
  Settings → Activity, where the card now says how many went before it. Approve it and the
  rest of a cleanup you meant goes through without asking again.
  The limit also counts bookmarks now, not copies of them. A pile of duplicates, such as the
  New Tab copies Norton Neo made before 1.4.0, made your tree look many times its size, so a
  deletion of most of your real bookmarks could stay under the limit. And a bookmark you hold in
  several copies counts once when another device deletes it, instead of asking you to approve
  "50 bookmarks" that were one. Only the device receiving the deletion needs this version.
- **A warning that lasts no longer fills the Activity log.** Most warnings describe
  something Konode checks again on every sync, such as a permission you took away, a device
  on a different passphrase, or a file that will not download, and each one wrote a new line
  every sync for as long as it lasted. A passphrase mismatch wrote one per device per data
  type, so three devices filled the whole log in about a quarter of an hour and pushed out
  the entries that explained what had gone wrong. A warning that keeps coming back is now one
  entry that says how many times it happened (×120) and when it last did, under the time it
  began. Anything else happening in between, such as a merge or a restore, starts a new entry,
  so the log still reads in the order things happened. A device whose setup is not finished
  yet also no longer starts its log with a warning that it has no storage, written every
  minute until setup was done.
- **Deleting many bookmarks at once is one line in the Activity log.** The browser reports
  every deleted bookmark separately, and Konode wrote a line for each, so selecting 25
  bookmarks and pressing Delete left 25 identical lines, and a large cleanup pushed everything
  else out of the log. It now waits until the deletions stop and writes one line with the
  total. The deletions themselves are recorded straight away, as before.
- **A Google Drive sign-in that fails no longer tells you something untrue.** When the
  sign-in window closed before the sign-in came back, Konode said "Sign-in cancelled", even
  to people who had approved it: a Google error page, or a browser that never hands the
  result back, ends the same way as closing the window yourself. It now says the window
  closed before the sign-in came back, and says you cancelled only when Google itself reports
  that you did. Other failures no longer suggest a redirect address that "may not be
  registered", which stopped being a likely cause in September. Every message now names
  GitHub and WebDAV, which need no Google sign-in, and Settings → Activity records which way
  the sign-in ended, with the address the browser was asked to return to.
- **Setup no longer forgets your answers when the page reloads.** Reload the setup page, or
  let a phone put it to sleep while you sign in to Google, and it used to come back at the
  start with everything you had entered gone, a GitHub token GitHub will not show you twice
  included. It now comes back to the step you were on, with your storage choice, its
  address and sign-in, the data types and the device name as you left them, for up to a
  day. A Google Drive sign-in that finished before the reload is recognised instead of asked
  for again. The encryption step is the exception: your passphrase is never written down,
  so that step asks again. What setup kept is removed as soon as setup completes, and after
  a day if you never finish.
- **Clicking the conflict notification opens Konode.** The notification says "Open Konode to
  resolve it", and clicking it did nothing. It now brings your browser window to the front
  and opens Konode's popup there, where conflicts are answered. Where the browser does not
  let an extension open its popup, the same screen opens in a small window of its own, or in
  a tab on a phone.
- **Manual conflict resolution asks only when your bookmarks really differ.** With
  **Settings → Device → Conflict resolution** on **Manual**, Konode asked which bookmarks
  to keep on the first sync between any two devices, and asked again whenever the other
  device changed anything at all, because it compared the files rather than the bookmarks
  in them. Each browser gives a bookmark its own ID and the date it arrived, so two devices
  never had identical files even with identical bookmarks. It now compares the bookmarks
  themselves: the folder each is in, its address and its title. Two devices that hold the
  same bookmarks are not asked about, and once you answer, the question stays answered
  until the other device's bookmarks change. Cards already waiting for devices that turn
  out to agree go away on the next sync. The order of bookmarks within a folder is not
  counted, since Konode does not carry it reliably between browsers.
- **Settings gives one piece of advice, not two, when it cannot list your devices.** With
  Konode's permission to reach your storage taken away, the device list and the restore
  points said to open Storage and press Save, and then added "Check the connection in
  Storage and reopen this tab" as well. That second line now appears only when the error
  gives no advice of its own. In Simplified Chinese the restore-point message also said you
  had no devices, and the device list left "Storage" untranslated. Both are corrected.
- **An encryption warning appears once, not once per device.** A device without end-to-end
  encryption, joining a folder where several devices use it, finished setup with "Some of
  your devices are end-to-end encrypted..." printed once for each of them, the same sentence
  two or three times in a row. The popup and the setup screen now show each message once.
- **"Too many requests" now says what to do about it.** Some storage providers limit how
  many requests an account may make, Nutstore's free plan the best known, and when Konode
  went over, all it said was "HTTP 429". It now names the server, says it is turning Konode
  away for a while, and points you to **Sync interval** in **Settings → Device**, the one
  setting that keeps you under the limit. The same goes for **Test connection**, and when
  every data type hits the limit at once, it is said once rather than once per type.
- **A large session asks before it opens.** Restoring another device's session with more
  than 20 tabs used to open them all on the first click. The button now changes to "Open
  142 tabs", and only a second click opens them; Cancel leaves it. Smaller sessions still
  restore in one click.
- **Setup no longer looks frozen when the browser shows no permission prompt.** Vivaldi on
  Android neither showed the prompt for the permissions Konode asks for at the last step nor
  answered the request, so **Finish & Sync** did nothing at all. The button now says it is
  waiting for permission as soon as you press it, and if no answer comes within a few seconds,
  a note explains that some browsers show no prompt: allow Konode's permissions in the
  browser's extension settings and press the button again, or go back and turn off the data
  types that need them. A prompt that is on screen can still be answered as before.
- **Names in Hebrew, Arabic or Persian keep their punctuation where it belongs.** A device
  called "מחשב!" was laid out together with the left-to-right text around it, so the "!"
  that ends the name was drawn at its start. Device names, extension names and your GitHub
  name are now kept apart from the text around them, in the popup, Settings and setup, and
  the device name field lines up with what you type in it.

## [1.4.0] - 2026-09-29

### Added

- **Konode now speaks Italian, Russian and Traditional Chinese.** Every screen is translated,
  and Konode picks the language your browser is set to, as it already did for English,
  Hungarian, German, Spanish and Simplified Chinese. Traditional Chinese is its own
  translation, with the words used in Taiwan, rather than Simplified Chinese converted
  character by character, and a native speaker reviewed it.
- **Nutstore (坚果云) has a storage card.** The dominant hosted-WebDAV provider in mainland
  China, and the one that matters most there for a reason that has nothing to do with
  Nutstore: Google Drive cannot be reached from the mainland, so the backend Konode's setup
  leads with is unusable for that whole audience, and WebDAV against a domestic provider is
  the only route that works. Pick the card, sign in with your Nutstore email and a
  third-party app password, and there is nothing else to configure.
  One thing the card tells you that the others do not need to. Nutstore allows 600 WebDAV
  requests every 30 minutes on a free account, and a sync costs roughly one request per data
  type plus one per other device, so four devices at the default one-minute interval sit
  right on that ceiling. Raise **Sync interval** to 120 seconds or more once you have three
  devices and it stays well clear. A paid Nutstore account allows 1500 and does not need it.

### Fixed

- **A bookmark to a browser's own page no longer multiplies on Norton Neo.** Neo stores a
  `chrome://` address under its own `neo://` name, so a New Tab bookmark synced from Chrome
  arrived as `neo://newtab/`, Konode did not recognise it on the next sync, and added it
  again, about twice a minute, until the list held thousands. Konode now checks what the
  browser actually stored and treats the two addresses as one bookmark, and Settings →
  Activity says so when it happens. Your other devices go on seeing the `chrome://` address,
  so deleting New Tab on either side removes it from both. The copies already made stay
  until you delete them: keep one and delete the rest, because deleting every copy deletes
  New Tab on your other devices too, as it is the same bookmark. A bookmark a browser does
  not keep at all is no longer added again on every sync either. Only the browser that
  changes the address needs this version.
- **Firefox no longer takes the same history again on every sync.** Firefox stores the time
  of a visit in whole milliseconds, while Chrome, Brave, Helium and the other Chromium-based
  browsers report fractions of one. Konode rounded the time when it saved a visit but not when
  it checked whether a visit was new, so about half of the pages from a Chromium-based
  device always looked newer than Firefox's copy, and Firefox added the same visits again,
  every minute, since 1.0.2. Each visit now arrives once. Only Firefox needs this version.
- **A folder deleted on another device no longer stays behind, empty.** Deleting a folder
  together with its bookmarks removed the bookmarks everywhere and left the folder standing
  on every other device, for good. Approving a blocked deletion did the same, so saying yes
  to deleting 80 bookmarks left their ten folders behind with nothing in them. Konode now
  records the folder deletion too, and a device removes a folder the deletion emptied when
  the other device deleted that folder, or when you approved the deletion. A folder the other
  device only emptied and kept stays, and so does one you created here afterwards. Empty a
  folder first and delete it later, and it goes from your other devices too; an empty folder
  you made on one device is never removed because of another. For a
  deleted folder to follow, the device you delete it on needs this version; approving a
  blocked deletion clears the folders whatever version the other device runs.
- **Deleting a folder in Firefox sticks.** Firefox reports a deleted folder without what was
  inside it, so Konode recorded no deletion for the folder's bookmarks, and the next sync
  brought the folder straight back, contents and all, from any other device that still had
  it. Konode now takes the folder's contents from the last state it synced. Deleting
  bookmarks one at a time was never affected, and neither was deleting a folder in a
  Chromium-based browser such as Chrome, Brave or Helium.
- **Settings keeps up while it is open.** The Activity tab read everything once, so with
  Settings open a blocked deletion showed up in the popup and nowhere on the page, the restore
  point it saved was missing, and the device list went on quoting the old upload times until
  you reloaded. The log, the numbers and the blocked-deletion card now follow each sync as it
  happens, and the devices and restore points are read again when a sync finishes while you
  are looking at them, or as soon as you come back to the tab if one finished while it was
  hidden behind another window. Reloading Settings also keeps the tab you were on instead of
  going back to Storage.
- **A momentary Google Drive error no longer fails a whole sync.** Konode looks up its
  folder on Drive at the start of every sync, and that one request gave up on the first
  error, so a brief hiccup on Google's side cost a sync and put an error in Settings →
  Activity. It now tries again, as every other Drive request already did.
- **Restoring bookmarks from your browser's own backup is no longer undone.** Import an
  exported bookmarks file after deleting some of them, and the next sync deleted them again,
  without asking, for up to 90 days. The import keeps each bookmark's original date, so
  Konode took the restored bookmarks for older than the deletion. It now notes when a
  bookmark actually arrived on the device, and the restore reaches your other devices too
  instead of stopping on this one.
- **Restoring a restore point puts bookmarks back where they were.** The bookmarks it brought
  back were added at the end of their folder, so wherever something had survived they came
  back out of order: a folder that used to be last on the bookmarks bar ended up ahead of
  bookmarks that used to come before it. Each one now goes back right after the bookmark it
  used to follow.
- **The device list shows when each device really uploaded last.** Settings → Activity could
  say a device last uploaded days ago while it synced every minute, because the date came
  from its extension list, which is only uploaded when it changes. On Google Drive and WebDAV
  the date is now the newest upload across all of that device's files, and the list is
  ordered by it. A GitHub folder has no cheap way to tell, so it shows what it did before.
- **Several Spanish labels said something other than what they do.** A restore point whose
  bookmark count could not be read was labelled with the verb "mark", a snapshot was called
  an "imagen", and the bulk-delete limit read as a number of items when it is a share of
  your bookmarks. The Spanish text is corrected throughout.
- **Konode's own pages could fail to draw if your browser is not set to English.** They
  declared themselves English while showing your language, so Chrome treated them as pages
  worth translating, and anyone who has told it to always translate English got that done
  silently, with no prompt. Machine translation rewrites a page while Konode is still
  drawing it, and the setup wizard is where the two collided most often: clicking "Sign in
  with Google" left you looking at "Konode couldn't show this screen" instead. Your synced
  data and your storage were never part of this. Every Konode page now declares the
  language it is actually in, and asks the browser not to translate it.
- **Cancelling Google Drive sign-in signed you out of Drive.** Pressing the Google
  button in Settings and then closing the consent window left the device with no Drive
  session at all, while Settings went on showing the account as connected. Sign-in used
  to clear the stored session before it opened the window, so a cancel took the refresh
  token with it and every sync from then on asked you to sign in again. Your session now
  survives anything short of a sign-in that actually completes. And if Google hands back
  no refresh token on a repeat consent, the one already stored is kept, unless you signed
  in as a different account.
- **Settings could list extensions you already have as missing.** When Konode loses the
  permission it needs to read your extension list, taken away from your browser's own
  extensions screen for example, it has no way to tell what is installed on this device.
  Settings answered that by treating everything your other devices have as missing here,
  with Install buttons for extensions sitting right there in the toolbar. It now shows
  nothing at all while it cannot tell, the way the popup already did, and fills the list
  back in as soon as the permission returns, with no reload.
- **Every sync read your open tabs and your extension list twice.** Konode reads what it is
  about to publish once before merging your other devices in and once after. That is right
  for bookmarks and history, which merging changes, but open tabs and the extension list are
  not changed by merging, so the second read produced exactly the same thing at twice the
  cost. If it had anything to warn about, that warning also landed twice per sync in the
  Activity log, which filled the log with duplicates.
- **One missing permission made every sync stream look broken.** When a data type lost the
  permission it needs, the popup turned all four Active Streams red and their tooltips said
  the data was stale, including the streams that had just synced successfully in that same
  cycle. The colors now follow the data type the problem actually belongs to. A failure that
  is nobody's type in particular, such as a storage backend Konode cannot reach, still marks
  every stream, because then every one of them really has stopped.

## [1.3.2] - 2026-09-10

One fix, for the worst thing Konode has done to anyone's bookmarks. If you have been
seeing "an unusual deletion was blocked" come back every minute for bookmarks that are
still sitting there on every one of your devices, this is that. Nothing was ever lost:
the guard that refused the deletion did its job every single time. What it could not do
was stop being asked.

### Fixed

- **Your devices could end up demanding that each other delete bookmarks none of them had
  deleted.** When one device refused an unusual deletion, it filed the request away and
  then published it again under its own name on the next sync. The device that read it did
  the same. Within a few cycles every device was asking every other device to delete
  bookmarks that all of them still had, and each one refused, saved a restore point, and
  passed the request on. That is why the warning never cleared no matter what you set, why
  it named a different device each time, and why the counts kept changing: they were not
  one deletion but everyone's, added together and going round. Nothing you could do on one
  device ended it, including restoring from a restore point, because the request was no
  longer coming from anywhere in particular.

  A device now only ever asks for the deletions it made itself. It never asks you to delete
  a bookmark it is advertising to you in the same breath, which is what the old files were
  doing. And it ignores that request when another device makes it, so the warning should
  stop on the first sync after you update, even while your other devices are still on the
  old version. Update them too and they will stop making the request at all.

  If you had a device set to Prefer Local to keep this at bay, you can put it back to Last
  Write Wins.

## [1.3.1] - 2026-09-10

A release with nothing in it but fixes. If you use Firefox, the one to know about is that
Konode can be set up there again: since 1.2.1 it never asked Firefox for the permissions
it needed, and then told you that you had refused them. The other two were costing people
something quietly. A device asking to delete nearly all of your bookmarks was blocked with
no way to say yes, so the warning could not be cleared at any setting; and a device's open
tabs or extension list could get stuck on an old version while every sync went on
reporting success. Around those, a WebDAV server that refuses passwords now says so
instead of blaming yours, history sync stops getting slower with every device you add, and
several things that filled the Activity log with the same line a minute do not any more.

### Fixed

- **On Firefox, Konode never asked for the permissions it needed, and then blamed you for
  not granting them.** Pointing Konode at a WebDAV server, or turning on history, open tabs
  or the extension list, is something Firefox has to ask you to allow. From 1.2.1 onwards
  it never asked: no window appeared, and setup stopped on "Konode needs permission to
  reach your WebDAV server. Please allow them to continue" with nothing on screen to allow.
  The data type switches in Settings did the same thing, springing back with a message
  saying the permission had not been given. Firefox shows that window only if it is asked
  while your click is still being handled, and Konode had taken to checking something else
  first, which is enough to be too late. It asks first now. Chromium browsers allow a few
  seconds rather than the one moment, so nothing there ever showed this.
- **Conflict cards outlived the setting that made them.** With conflict resolution set to
  Manual, Konode asks which version to keep. Switch back to Last Write Wins without
  answering, and the questions stayed on screen: the next sync merged those devices
  itself, exactly as Last Write Wins is supposed to, while the popup went on offering a
  choice whose outcome had already been decided. Nothing ever cleared them, so the only
  way to be rid of the banner was to answer questions that no longer meant anything.
  Leaving Manual now clears them on the next sync, once the merge that replaces them has
  actually run, and the Activity log says why they went.
- **Conflicts are now one card per device, and the card says which device.** With
  resolution set to Manual, Konode asks about each device that disagrees with this one,
  separately for your bookmarks and for your history. Every one of those questions looked
  the same: the same sentence, the same two buttons, and nothing saying who was asking. Two
  other devices made four of them, three would have made six, and they were stacked above
  the part of the popup that scrolls, so answering them left almost no room to see anything
  else. Each device now gets one card that names it, with a row for bookmarks and a row for
  history inside it. The two keep their own buttons, because keeping your bookmarks while
  taking the other device's history is a real answer, and the list has a ceiling of its own
  now, so no number of devices can push the rest of the popup off the bottom.
- **The Restore button on a restore point was a size nothing else on the page used.**
  Konode gives every standalone button one height, taken from a single value, so that
  controls next to each other line up. The ordinary secondary button never got it and came
  out at whatever its text happened to measure, which was fine until it stood next to the
  delete button on a restore point, which does take it: sharing a row stretched the pair to
  a height nothing else in Settings had. Both now state their height, so the row matches
  every other button on the page.
- **Updates could sit downloaded for weeks without being installed.** Your browser holds an
  update back while an extension is running and installs it the next time it finds a quiet
  moment, which for anyone who rarely restarts their browser can be a long wait. Konode now
  takes the update as soon as it is offered, or the moment a sync in progress has finished,
  so a fix reaches you in about a minute rather than whenever you next close your browser.
  This one only helps from this version onwards, since it has to be the installed version
  that does the asking.
- **Giving a permission back left Settings still complaining about it.** Konode reads what
  it is allowed to do when the page opens, and never looked again. So after granting a
  permission from the browser's own extensions page, the rows went on saying it was missing:
  syncing had recovered, the storage was connected, and three rows still told you it had
  not. Switching between the tabs in Settings did not help, because they are one page.
  Reloading was the only way. It now notices a permission being granted or taken away while
  it is open, wherever that happens, and the rows follow.
- **Taking a permission back said so for some data types and not others.** Every optional
  permission can be withdrawn from the browser's own extensions page, and Konode tells you
  when one it needs has gone. History and the extension list did. Open tabs did not, and
  the difference was invisible from the outside: those two lose their whole API when the
  permission goes, while the tabs API stays and simply stops telling Konode any addresses.
  So the row looked healthy while nothing it produced was usable. Your other devices were
  never at risk, since a session with no tabs in it is never published over a good one, but
  nothing said why the tabs had stopped travelling. Now it says the same thing the other
  two say.
- **A withdrawn storage permission read as a network error.** The permission to reach your
  storage can be taken back the same way, and it is the one on that screen that stops
  everything at once. Konode reported it as "NetworkError when attempting to fetch
  resource", which names neither your server nor the reason, and reads like the storage is
  down. Your device list and your restore points said the same thing, and then told you to
  check a connection that was fine. All of them now say the permission is missing, name the
  server, and say where to grant it again, while still carrying the original message for
  anyone reporting a bug.
- **"Sync now" reported a sync it never ran.** Every data type can be switched off,
  including the last one. With nothing left to sync, Konode still went out to your storage,
  came back with nothing to report, and said "Synced", once a minute and again on every
  press of Sync now. It says Ready now, which is what a device with nothing turned on
  actually is, and Sync now tells you nothing is turned on rather than claiming to have
  synced it, and that message is now the way to the screen it names rather than a mention
  of it: clicking it opens Data Types. It also stops making that round trip, so a paused
  device no longer talks to your storage to do nothing.
- **A missing extension said it came "from Chrome" on devices that have no Chrome.** The
  line under a missing extension names the store you can install it from, and it named it
  by the browser's brand. Sitting a few rows under a list of devices called "Windows ·
  Firefox" and "Windows · Helium", that reads as a device rather than a store, and it named
  one you may well not own. It says Chrome Web Store and Firefox Add-ons now.
- **Switching to Google Drive in Settings left Konode with nowhere to sync.** The Storage
  tab records two things about your provider: which one is active, and the settings for
  reaching it. Picking one of the WebDAV cards wrote both, because the second comes along
  with the server address you type in. Google Drive has nothing to type, so only the first
  was written. The card said ACTIVE and showed you signed in, the sign-in really had
  worked, and every sync from then on did nothing and reported that no storage was set up.
  Both are written now, and a device already left in that state repairs itself the next
  time it starts, without going near the Storage tab again.
- **A conflict button gave no sign it had been pressed.** Answering a conflict is seconds
  of real work: keeping yours reads your whole bookmark tree, unlocks your passphrase if
  encryption is on, and uploads it; taking theirs unlocks and merges what they sent. For
  those two or three seconds nothing on screen changed, so the press looked like a miss and
  the natural thing to do was press again. The button you pressed now shows it is working,
  and the others hold still until it finishes.
- **Answering several conflicts at once could fail on "WebDAV PUT failed: 423".** With
  resolution set to Manual, two devices disagreeing about your bookmarks raises two
  questions, and answering both with Keep local uploaded the same file twice in a row.
  Some servers, Koofr among them, lock a file while a write to it is in flight and refuse
  the second one, so the answer came back as a WebDAV error and the question stayed on
  screen. The repeat was never doing anything, since the first upload had already put that
  exact version on your storage, so it no longer happens. And a locked file is now treated
  as what it is, something to come back to in a moment, rather than as a failure.
- **Buttons in Settings could spin forever, and one screen could lie.** Every action on
  the Activity tab talks to Konode's background worker, and if that conversation failed
  outright rather than answering with an error, nothing was said: the spinner kept
  turning and the click looked ignored. Worst of them was Clear log, which emptied the
  list on screen whether or not anything had been cleared, on the one screen where being
  told your history is gone is alarming. Settings itself could do the same thing on load,
  showing a spinner that never resolved. All of them now say what went wrong, and the
  load offers to try again.
- **A sync file with an unreadable date beat everything else.** A file from another device
  carries the moment it was written, and Konode compares those to decide which version of
  something is newer. A file whose date could not be read did not lose that comparison, it
  won it, every time; and it left the order Konode folds your other devices in unspecified,
  which is what makes every device agree on the same answer. A file nobody can date is now
  treated as the oldest thing there is.
- **History sync got slower the more devices you had.** Before storing a page from another
  device, Konode checks whether it already holds a newer visit for it, and answering that
  means reading your whole local history. It was reading it again for every other device,
  so three of them meant three full passes over your history every sync, once a minute.
  It reads it once per sync now and shares the answer. Nothing about what gets synced
  changes; on a large history with several devices, the work behind it drops by roughly
  the number of devices you have.
- **A damaged encrypted file said something nobody could act on.** A restore point or
  sync file that had been truncated or corrupted failed with a message about an internal
  decoding function rather than about your data. It now says the same thing a wrong
  passphrase does, because from where you are standing those are the same problem: this
  did not decrypt.
- **Restoring another device's tabs is bounded.** A session is a file on your storage,
  and Konode was willing to open however many tabs one claimed to hold. The count has
  always been shown before you click, and now it is also the most that can open: 200,
  which is well past any real window.
- **A blocked deletion you had no way to allow.** Konode refuses a sync that would remove
  more than 60% of your bookmarks at once, saves a restore point, and tells you about it.
  What it never did was give you a way to say yes. The advice was to raise **Max bulk
  delete from a peer**, but that setting stops at 95%, so a device asking to clear nearly
  all of its bookmarks stayed blocked at every position of the slider, and the warning
  never went away. **Settings → Activity** now shows what is being held back, which device
  asked for it, and how much of your tree it is, with a button that applies it. Saying yes
  covers the sync that follows it and nothing beyond that, so a deletion that turns up
  later is stopped and shown to you like any other, and the restore point is already saved
  before you are asked. Reported by @klausbreyer.
- **The activity log said bookmarks had been deleted when they had not.** A blocked
  deletion was logged as "Merged +0 / -48" directly above the warning explaining that
  those 48 had been refused. It was counting what the other device asked for rather than
  what was removed, which was nothing. It now reports what it actually applied.
- **A blocked deletion filled the activity log.** The guard re-checks the same deletion on
  every sync, so it wrote the same two lines every minute for as long as the situation
  lasted, pushing everything else out of a 200-entry log. The warning is now written once
  per incident, the same way restore points have been saved once per incident since 1.3.0.
- **A device's open tabs or extension list could get stuck on an old version.** The popup
  lists the tabs each of your other devices has open, and counts the extensions they have
  that this one doesn't. For one device, either of those could stop moving and stay
  stopped: every sync after it reported success, and nothing on that screen ever caught up.
  There were three separate ways to get there, and all three are fixed. Two devices whose
  data arrived in the same instant could overwrite each other's entry instead of both being
  kept. On Google Drive, a folder that had ended up holding two files for one device could
  read the older of them and keep it. And if you had set conflicts to be resolved by hand,
  no device's tabs or extensions were stored at all, because they were going through the
  same gate as bookmarks, where Konode stops and waits for you to choose. There is nothing
  to choose between two devices' open tabs. They are both yours, and both are listed. If an
  earlier version left you holding one of those questions, the first sync after this one
  clears it.
- **Turning the extension permission off emptied your extension list everywhere.** Reading
  the list needs a permission you can withdraw at any time, from your browser's own
  extensions page. Konode treated withdrawing it as a failure, and reported a failed sync
  for as long as it stayed off. It now stops publishing the list and leaves what your other
  devices already have exactly where it is.
- **The popup's numbers stood still while you watched a sync finish.** Leaving the popup
  open across a sync left the list of other devices' tabs, and the count of extensions
  missing here, showing what they held before it ran. They keep up with the sync now.
- **"Sync on change" promised more than it does.** The setting said bookmarks and tabs go
  out the moment they change. Bookmarks do. Open tabs travel on the regular interval, the
  same as your history and extension list, and Auto sync now says which things those are.
- **A storage folder Konode couldn't read said nothing about it.** Once per sync Konode
  checks that its own files are still in the folder, which is how a device notices it was
  forgotten from somewhere else. If the folder couldn't be listed, the check gave up in
  silence and the Activity log showed an ordinary, healthy sync. It now reports that it
  couldn't tell.
- **"Check your username and password", when the password was never the problem.** Some
  servers don't accept a username and password over WebDAV at all. ownCloud Infinite Scale
  is the one that came up: it arrives with HTTP Basic switched off and authenticates through
  OpenID Connect instead, so it refuses every login Konode is able to make, however correct
  that login is. Konode read the refusal as a bad password and said exactly that, and the
  person who reported it spent their time on the one thing that was fine. A server refusing
  this way also states what it would accept, and Konode now reads that: it says the server
  won't take a password here, names what it asked for instead, and mentions that an app
  token goes in the same field. On a first sync it was worse, because setup saves and syncs
  rather than testing the connection, so the same refusal surfaced as a complaint about the
  sync folder and whether your account may write to it. That path now reports the
  authentication problem it actually hit, and stops asking the server twice to find out.

## [1.3.0] - 2026-08-17

Konode speaks your language on every screen it has. Settings was the last one still in
English whatever the rest of Konode was reading in, and it now comes from the same
translation files as everything else. Alongside that, three fixes for browsers built on
WebKit, where a first install could leave you with no way into setup at all, and a device
you thought you had forgotten no longer haunts your other machines.

### Added

- **Settings speaks your language too.** The popup and the setup wizard already followed
  the language your browser is set to, but Settings stayed in English whatever the rest of
  Konode was reading in, which made it the one screen you had to switch languages for.
  Every tab, label and explanation on it now comes from the same translation files as
  everything else.
- **A way back into setup, from the popup.** Konode opens the setup wizard once, in a tab,
  the moment it installs. If you closed that tab, or were looking elsewhere when it
  appeared, or are on a browser where it never opened at all, there was nothing telling you
  what to do next, and setup had to be found by opening Settings and knowing what to look
  for. The popup now offers to finish setting up until a storage provider has been chosen.
- **Konode speaks Spanish and Chinese.** Both are complete, all 308 strings, translated by
  native speakers who volunteered for it. That brings the languages Konode ships finished
  to five: English, Hungarian, German, Spanish and Chinese (Simplified). There is nothing
  to choose in Settings, because Konode follows the language your browser is already set
  to.
- **Anyone can translate Konode, without touching the code.** Translations are edited on
  [Hosted Weblate](https://hosted.weblate.org/projects/konode/): no git, no pull request,
  and nothing to install. A language reaches a release once it is complete, because a
  screen that is half translated reads worse than an English one, and working out which
  half you were given is not something anyone should have to do.

### Fixed

- **A device you forgot went on haunting your other machines.** Forgetting a device deletes
  its files from your storage, and the machine you did it on stopped listing it straight
  away. Every other device carried on exactly as before: the forgotten machine's tabs were
  still offered for you to restore, and its extensions still counted toward what is
  "missing on this device", with nothing left in your storage to justify either. Each device
  now checks what it remembers about the others against what your storage actually holds,
  and drops whatever is no longer there. Not at the same moment, though: your other devices
  notice on their next sync, not the instant you click Forget. A device whose file simply
  couldn't be read that time is left alone, because "I couldn't reach it" and "it's gone"
  are not the same thing, and only one of them is a reason to forget a machine you still
  use.
- **On Orion, your bookmarks were being split between two places.** Orion keeps both a
  "Bookmarks Bar" and a "Favorites", and Konode recognised both of them as the bookmarks
  bar. Which one an arriving bookmark went into came down to the order Orion happened to
  list them in, so the same folder could end up existing in both, with its contents
  divided. On a real 80-bookmark tree it arrived as 32 in one and 48 in the other. Nothing
  was ever lost, but the tree was torn in half. Arriving bookmarks now go to the real
  bookmarks bar, consistently. A related case is fixed with it: Konode no longer treats
  Chrome's "Mobile bookmarks" and Orion's "Favorites" as the same place, which it did
  because the two browsers happen to number them alike.
- **Restoring a session on Orion brought back a single tab.** Orion allows one tab or
  window to open per click, and Konode spent that one allowance checking whether it was
  allowed to open more, leaving nothing to open the rest with. A 10-tab session arrived as
  1 tab, silently, with nothing in the log to explain it. Konode now settles the question
  before it opens anything, so the whole session arrives in one window. On a browser it
  hasn't met before, the first restore may still fall short, and it now says so and gets
  it right from then on. Chrome, Brave and Firefox are unaffected and keep restoring into
  the window you are already in, pinned tabs still pinned.

- **An unfinished translation no longer fails the build.** The check that stops a
  translation from losing a `$COUNT$`, and taking the number out of the sentence with it,
  treated a string nobody had translated yet as a loss. Every language still in progress
  therefore broke the build, and the real problems were buried: of 22 reported on the
  first contribution from Weblate, 21 were simply work not done yet. The same check also
  objected to one placeholder used twice in a sentence, which Chinese needs and which the
  browser substitutes correctly both times. It now reports only what it was written to
  catch, a placeholder that went missing or one that was never in English.

### Where you can get it

1.3.0 went to both stores at once, and each reviews on its own schedule.
**[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/) is serving it
already**, so Firefox and Waterfox update themselves with nothing for you to do. The Chrome
Web Store listing serves 1.2.1 until its own review is done, and Chrome updates itself
after that. If you would rather not wait, both zips are on the
[v1.3.0 release](https://github.com/konabe-studio/konode/releases/tag/v1.3.0) page. Note
that the release zips are built without Konode's own Google OAuth client, so Google Drive
sign-in in those needs an OAuth client of your own. GitHub and WebDAV work with no extra
setup.

## [1.2.1] - 2026-08-07

### Changed

- **The store listing is easier to find.** The Web Store takes its title from the
  extension's name, and ours was the bare word "Konode", which matches nothing anyone
  types. It is now "Konode | Private Bookmark & Tab Sync": the name first, then what it
  actually does. The title goes through the translation files, so it appears in your own
  language wherever Konode has been translated.

### Fixed

- **A crash no longer leaves you with a blank page.** If any screen fails to draw, you now
  get a short explanation, the error text to quote in a report, and a reload button,
  instead of an empty window with nothing to go on. Your synced data was never involved in
  those failures, and the new screen says so, because that is the first thing anyone wants
  to know.
- **The "missing on this device" list could quietly hide extensions you really don't have.**
  Matching a neighbour's extension against your own used the developer's homepage address
  as one of its signals, and a large share of extensions point that at their source
  repository. So a single extension of yours homepaged on github.com marked every
  extension sharing that host as already installed. On a real list of ten genuinely absent
  extensions, six vanished this way.
- **The same list dropped anything the browser doesn't call an extension.** Chrome reports
  apps under their own type names, and the list only ever showed the exact word
  "extension", so those entries were synced all the way across and then discarded at the
  last step, with nothing to distinguish them from something never published.
- **The provider logos in the setup wizard were squashed narrower than they should be.**
- **The Settings page could open blank.** On a fresh 1.2.0 install, opening Settings showed
  nothing at all, with `management.getAll is not a function` in the console. 1.2.0 made the
  extension-list permission optional so the install prompt stays small, and Konode then
  asked the browser for your extension list before that permission existed. Chrome answers
  that with an error thrown on the spot rather than a failed promise, which took the whole
  page down with it. Konode now checks that the call is really available before making it.
  Settings opens normally whether or not extension sync is switched on.
- **A data type could stay switched on after losing its permission, and sync nothing.**
  History and the extension list need a permission you grant separately, and browsers let
  you take it back from their own extension settings without telling the extension. When
  that happened, the type still looked enabled, synced nothing, and left an unreadable
  error in the log once a cycle. Konode now says which permission is missing and how to
  restore it, both in Settings and in the sync status, and the rest of your data keeps
  syncing meanwhile.
- **One unsupported browser feature no longer takes the rest of Konode with it.** Konode
  attaches its background listeners the moment it starts, one after another, so a browser
  that didn't implement one of them stopped the whole sequence there. Everything after it
  was never set up, on a Konode that had started and looked fine. Each one is now attached
  on its own, and a browser missing a feature loses only what depends on it. Conflict
  notifications work the same way: a browser that can't show one still records the conflict
  and still lets you resolve it in Konode.

### Fixed: Firefox for Android

All four of these come from one detailed field report, and they share one cause: Konode
assumed that a permission its manifest asks for is a feature the browser actually has.
On Firefox for Android that isn't true, and every symptom below is what happens when the
two disagree. Konode now checks what the browser can really do, and says so plainly where
it can't.

- **Setup blamed your WebDAV server for a permission it was never asked about.** Firefox
  for Android doesn't implement runtime permission prompts, so the request came back
  refused with no prompt ever shown, and the wizard reported that as "Konode needs
  permission to reach your WebDAV server". Konode now checks the permissions you already
  hold *before* asking, so a permission granted by hand in Firefox's add-on settings is
  simply accepted. If it still can't ask, it says so, and tells you where to grant it,
  instead of telling you that you refused.
- **The History toggle silently refused to move.** Turning a data type on asks for its
  optional permission first, and if that came back refused the switch just sprang back
  with no explanation anywhere. It now says why, on the row you clicked.
- **Bookmarks failed with a "getTree" error.** Firefox for Android provides no bookmarks
  API at all. Bookmarks and History are now shown as unavailable there, with the reason,
  and are skipped by the sync rather than failing it every cycle. Open tabs still sync,
  and nothing changes for your desktop devices.
- **The extension could load half-built.** Konode registers its bookmark-change listeners
  when the background script starts. On a browser with no bookmarks API that line threw
  and took the rest of the script down with it, leaving an extension that had started but
  wasn't finished, which looks like it's working.

### Where you can get it

1.2.1 is live on **[Firefox Add-ons](https://addons.mozilla.org/firefox/addon/konode/)**,
so Firefox and Waterfox update to it on their own. On the Chrome Web Store it is in review,
and the listing serves 1.2.0 until that clears; Chrome updates itself once it does. If you
would rather not wait, the Chrome zip is on the
[v1.2.1 release](https://github.com/konabe-studio/konode/releases/tag/v1.2.1) page. Note
that the release zips are built without Konode's own Google OAuth client, so Google Drive
sign-in in those needs an OAuth client of your own. GitHub and WebDAV work with no extra
setup.

## [1.2.0] - 2026-08-04

A full code-review pass over the sync engine, the storage backends and the interface,
plus a Firefox build you can install. Almost all of the rest is correctness: several ways
your data could quietly fail to reach your other devices, and several places Konode
reported success it had never actually checked. The sync file format is unchanged, so
existing setups keep working, but every device re-uploads each of its files once on the
first sync after updating. See Upgrade notes.

### Added

- **A Firefox build, in the release.** Konode has been built for Firefox since 1.0.0, but
  this is the first release you can actually download it from. It syncs against the same
  folder as your Chromium browsers, with the same providers and the same files, so a
  Firefox install joins a group that is already running. Tested here across Firefox,
  Brave and Helium on one sync folder: each device names itself to the others, bookmarks
  and renames travel in both directions, and history arrives with its original dates,
  which is something only Firefox lets an extension do. It is on **[Firefox
  Add-ons](https://addons.mozilla.org/en-US/firefox/addon/konode/)**, so it installs and
  updates like any other add-on.

### Fixed: data not reaching your other devices

- **Changing where you sync synced nothing.** Konode skips an upload when the data hasn't
  changed, but it only compared the data, not where it was going. So after switching
  provider, or changing the GitHub repository, branch or folder, or pointing at a
  different WebDAV server, the new location stayed empty while the popup reported a clean
  sync. Only a later bookmark edit fixed it, which on a settled bookmark tree can be days.
- **The extension list could stop being uploaded altogether.** Your device identity was
  regenerated instead of being saved, and because the "already uploaded" record survived
  that, the new identity's files were never written for anything that doesn't change on
  its own. The installed-extension list is exactly that, which is why it was the one that
  went missing. The identity is now created once and written down.
- **"Manual" conflict resolution never published this device's data.** Manual is meant to
  ask you before pulling a change IN. It also stopped this device sending anything OUT, so
  as soon as another device existed, your changes reached nobody.
- **Renaming a bookmark or a folder never reached your other devices.** The rename was
  sent every time, and every device threw it away on arrival. There was no way to tell
  whose title was newer, so the safe thing was to change nothing. Renames now carry a
  timestamp and the newest one wins. Folders are renamed in place instead of a
  second folder appearing under the new name.
- **Deleted bookmarks came back.** Deleting several bookmarks at once fired several
  events, and they overwrote each other's record of the deletion, so only one was
  remembered and the rest returned from your other devices on the next sync.
- **Some bookmarks were silently never added.** When a device had fewer bookmarks in a
  folder than the device it was syncing from, the browser rejected the position Konode
  asked for and the bookmark was dropped without a word, on every sync, indefinitely.
- **Deleting all of your bookmarks never reached your other devices.** An empty tree was
  treated as "nothing to say", so the deletions never left the device.
- **A device that had been offline for a while could undo your deletions.** Its older copy
  was merged in before the newer deletion was known, and the freshly re-created bookmark
  then looked newer than the deletion, so it survived and spread to every device.
- **One data type failing stopped the rest.** Turning off Konode's optional history or
  extension permission in your browser made that part of the sync fail, which silently
  stopped your BOOKMARKS syncing too.
- **GitHub: setting up an empty repository could silently half-finish.** The first commit
  Konode writes to a new repository wasn't checked, so a token without write access failed
  there but was reported later as an unexplained upload error, once per data type, with
  nothing saying why. That commit also always went to `main`, so if you'd chosen any other
  branch, every upload afterwards failed against a branch that was never created.
- **WebDAV: "Connected" no longer appears when the sync folder couldn't be created.** The
  failure was only logged, so setup looked fine and every upload afterwards failed against
  a folder that wasn't there. Konode now checks whether the folder exists before deciding,
  which also stops it from giving up on servers that refuse the create call for a folder
  that's already present. If your server redirects the address you entered, it says so.
  That still works, but some servers drop the login across a redirect and then reject a
  correct password.
- **Google Drive: two devices set up at the same moment could end up in separate folders.**
  Both created a "Konode" folder and each kept its own, so they never saw each other.
  They now agree on one, and a device whose folder changes re-uploads into the new one.

### Fixed: privacy

- **Open tabs no longer sync local file paths or sign-in links.** Only `chrome://` pages
  were being excluded, so `file://` paths from your disk, Firefox `about:` pages, and
  sign-in pages still holding a token in their address were uploaded, and Konode refuses
  to reopen all of those anyway, so it was the most sensitive thing it handled, sent for
  no benefit. The same rule the history sync already used now applies here.
- **Restore points could have their index written back unencrypted.** A device that had
  turned end-to-end encryption off, but still had the passphrase saved, could read the
  shared restore-point index and write it back in the clear. It now leaves alone anything
  it shouldn't be reading, and never overwrites an index it couldn't read.
- **The activity log no longer records your WebDAV account name.** Every upload wrote the
  full server address, which on Nextcloud and ownCloud contains your username.

### Fixed: the interface telling you the truth

- **"No restore points yet" was shown when the list had simply failed to load.** On a
  recovery screen that is the worst possible thing to get wrong. It now tells you it
  couldn't read them, and says plainly that this does not mean you have none.
- **Save could do nothing, with no explanation.** Problems from saving were only ever
  displayed on the Storage Backend tab, including the passphrase problems, whose field
  lives on Advanced. All four tabs now show them.
- **"Test connection" now actually tests the connection.** Google Drive reported success
  from saved sign-in details without contacting Drive at all, so revoked access still
  said "Connected". GitHub never checked the branch, so a typo passed the test and then
  failed every upload, permanently and silently.
- **Sync now, Use remote and Restore no longer look like dead buttons.** When the
  background couldn't do what you asked, the reason was thrown away. It is now shown.
- **A waiting conflict is visible on the toolbar**, and the popup no longer reports
  "Synced" while one is still waiting for your decision.
- **The popup could stay stuck on "Syncing…"** with the button disabled, if a sync had
  been interrupted. It's told about the repair now.
- **The data-type icons no longer show green "synced"** before anything has ever synced,
  or right after a sync that failed. Those two states look different now.
- **Setting up GitHub: a rejected token now says so.** Continue simply stayed greyed out
  with nothing on screen. The token is also checked once you stop typing, rather than on
  every keystroke.
- **The activity log no longer shows deliberate skips as errors.** A warning and a failure
  were stored identically, so anything Konode chose not to sync appeared as a red error.
  One reported log had 176 of 188 entries flagged that way, nearly all of them harmless. It
  now distinguishes them, and the messages say what was skipped and why instead of leaving
  you to guess.
- **Restoring a session opens the tabs in the window you're in again**, and pinned tabs
  come back pinned. Since 1.0.2 a restore always opened a new window and lost the pinned
  state, as a workaround for one browser that refuses to open more than one tab at a time.
  Konode now checks whether the tabs actually opened rather than assuming, so that browser
  still gets all its tabs while everyone else gets the old behaviour back.
- **Settings now says that arriving history is stamped with the time it arrived.** On
  Chromium browsers a page from another device can only be recorded at the moment it
  reached you: the browser gives extensions no way to set the original date (Firefox
  does, and Konode uses it there). Nothing said so, which made a working sync look broken:
  you check yesterday on the other machine, find nothing, and reasonably conclude the
  history never came through.
- **A device that couldn't be read just disappeared from the sync.** If one device's file
  couldn't be downloaded (a permission problem on the server, a transient error), it was
  skipped without a word, and the sync still reported success with fewer devices than were
  really there. Konode now names the file, the error, and what it means for you.

### Fixed: other browsers

- **WebDAV passwords with accented or non-Latin characters.** A password containing `ő`,
  `ű`, Cyrillic, an emoji or `€` made every sync fail outright; one with `á`, `ö` or `ü`
  was sent in the wrong encoding, so a correct password was rejected as wrong, forever.
- **A Firefox "Bookmarks Menu" landed in Chrome's bookmarks bar** instead of Other
  bookmarks, because the fallback depended on the order a browser happens to list its
  bookmark roots.
- **Your device is no longer labelled with the wrong operating system.** A Windows 10
  machine was called Windows 11 (both send the same identifier, and they can't be told
  apart this way), an Android phone on a Chromium browser was called Linux, and an iPhone
  was called a Mac. The label names your device in Settings and names the other device
  whose tabs or extensions you're looking at, so it was wrong in the place it's most read.
- **Google sign-in failures no longer blame your browser.** Anything other than a cancel
  was reported as "Google Drive sign-in isn't available in this browser", including
  problems that had nothing to do with the browser.

### Fixed: history and extensions

- **Synced history was re-added on every single sync.** Browsers normalize a web address
  when they store it, and Konode compared the un-normalized one, so the same page was
  recorded as a new visit every cycle, inflating visit counts and your most-visited
  list. It also meant pages you only received from another device were published back out
  as your own visits.
- **History sync only carried pages your other device had never seen, so browsing the
  same sites on two machines synced nothing.** A page already in the receiving device's
  history was skipped outright, which meant a *new visit* was never transferred and the
  log read "Added 0 new history entries". If you and your other device visit a similar set
  of sites (the normal case), history sync did almost nothing. A visit newer than
  anything that device already holds now comes through.
- **History from your other devices was almost never saved on Chrome, Brave or any other
  Chromium browser.** Konode sent the original visit date along with each page, and those
  browsers reject the whole request when it is present rather than ignoring it. Since
  nearly every page carries a visit date, nearly every page from another device was turned
  away, and the reason was being discarded before anyone could see it. The date is now
  only sent to browsers that accept it, which is why pages arriving on Chromium are dated
  when they arrive.
- **The first sync is much faster, especially on Firefox.** Konode wrote incoming pages
  one at a time, waiting for each before starting the next, so a first sync of a few
  thousand pages meant a few thousand round trips end to end. They overlap now.
- **History could stop being published from a device entirely.** Konode remembers which
  pages arrived from another device so it doesn't send them back out as your own visits,
  but nothing ever left that list. Once a page had arrived from any device, this one
  stopped publishing it forever, even after you genuinely browsed there yourself. With
  three devices that had each already received most of the shared history, a full day of
  browsing familiar sites could export nothing at all. It looked exactly like history
  being filtered out. Konode now records *when* a page arrived, so your own later visit to
  it is published while the arrival itself still isn't.
- **Konode kept re-trying pages your browser had already refused, forever.** Nothing
  remembered a rejection, so every sync attempted them again and wrote a log line for each
  one. On one reported setup an idle sync still did a hundred pointless attempts a minute,
  and the activity log filled up so fast that anything useful was gone within two cycles.
  Rejections are now remembered for a week, long enough to stop the churn, short enough
  that a temporary problem still fixes itself.
- **Local files and browser-internal pages are no longer published from your history.**
  Only addresses containing a sign-in token were filtered, so `file://` paths from your
  disk and `chrome://` pages went to your storage. The tab sync already refused those for
  the same reason. They were also the pages other browsers reject, which is what kept the
  retrying going.
- **"Missing extensions" was effectively always empty.** Chrome uses the Web Store page as
  an extension's homepage when the extension doesn't provide one, so almost every
  extension looked like a match for almost every other. A store page is no longer treated
  as evidence.

### Changed

- **A device now notices when its own file has gone missing from your storage, and puts it
  back.** Konode skips an upload when nothing has changed since the last one, but it decided
  that from a record kept on the device itself, which knew nothing about the file being
  deleted at the other end. So if you tidied your sync folder by hand, or your provider lost
  a file, anything that does not change on its own was never uploaded again. The installed
  extension list is exactly that: it can sit unchanged for months. The device carried on
  syncing and silently stopped publishing. It only says so when it is actually putting the
  file back: there is one case where it cannot (a browser whose only open tab is Konode's
  own page has no session worth sending), and saying it anyway meant the same line once a
  minute in the log this release is trying to make readable.
- **You can see your devices, and forget the ones you no longer use.** Activity now lists
  every device with files in your sync folder, by name, with what it last uploaded and
  when. A device you have retired can be removed from there, which deletes its files from
  your storage. It removes no bookmarks from any browser: your other devices merged in
  whatever it contributed long ago, and all this stops is a machine that is gone from going
  on offering its old state forever. A device that is still running will upload itself again
  on its next sync, and the screen says so.
- **Devices carry their name to your other devices now**, and existing setups pick it up on
  the first sync after updating rather than showing every machine as unnamed. It used to travel only with your
  open tabs, so a device with Sessions turned off had no name anywhere but its own screen.
  Onboarding also lets you set the name during setup, which matters once you have two
  laptops the browser describes identically.
- **Statistics and Activity are one tab.** They answered the same question at different
  resolutions: how much has synced, and what happened. Encryption also moves to Storage,
  next to the provider it protects you from, instead of sitting in Advanced among the
  backups and developer options.
- **Settings has been reworked.** The panels now sit on one sheet rather than floating as
  separate cards, spacing and type follow a single scale, and the interface scales with
  your browser's font-size setting instead of ignoring it. Icons that only repeated the
  label next to them are gone. Long lists fade at the edge when there is more to scroll,
  and only then. Narrow windows and phones get a layout that fits, which matters because
  Konode does run on a phone today.
- **The activity log keeps what matters.** It used to fill with routine per-sync lines and
  turned over completely in about 17 minutes, so the "unusual deletion blocked" warning
  it points you to was usually gone before you looked. Warnings, errors and notable events
  (restore points, sign-ins, deletions recorded, recoveries) are kept; routine detail goes
  to the console only, where Debug mode already shows it.
- **A blocked mass deletion saves one restore point per incident, not one per sync.** It
  used to save one every cycle, which pushed all ten of your existing restore points out
  within about ten minutes, exactly when you'd want them.
- **The Git provider is listed as "GitHub".** It was labelled "GitHub / Gitea / GitLab",
  but only GitHub is supported; anyone following the label sent a self-hosted instance's
  token to GitHub and got a confusing "invalid token" back.
- **Firefox add-on id is now `konabe@proton.me`** (it was `konode@konode.org`, a domain
  that isn't ours). Nothing is published on Firefox Add-ons yet, so this is free to change
  now, but a Firefox test install has to be removed and re-added, and its Drive redirect
  URL changes with it.

- **Debug mode now fills the activity log, not just the console.** Verbose logging only
  ever reached the browser's developer console, so "turn on Debug mode and send us your
  activity log" couldn't produce anything. While the mode is on those lines are kept in
  Settings → Activity, where you can read and share them; turning it off stops that
  immediately.

### Upgrade notes

- **Nothing to do on Chrome.** Every device re-uploads each of its files once on the first
  sync after updating; after that it settles down. If a sync had previously got stuck,
  updating clears that too.
- **Your other devices may show "an unusual deletion was blocked"** if bookmarks you
  deleted a while ago never managed to propagate. That is the safety net doing its job.
  A restore point is saved, and nothing is lost.
- **"Test connection" may now report a problem it used to hide**. That's the fix, not a
  new fault.
- **Sensitive tab addresses that were already synced stay in the file's history** if you
  sync to GitHub, because every sync is a commit. Konode stops sending them, and
  overwrites the current file, but it can't rewrite your repository's past.
- **A Firefox test install must be removed and re-added** because of the add-on id change;
  it starts fresh, and its old files on your storage become unused.
- **Optional:** clearing the activity log (Settings → Activity) drops the old noisy
  entries, and with them the WebDAV addresses recorded before this release.

### Tooling

- The test suite went from 180 to 407 tests. Every fix was checked by putting the old
  behaviour back and confirming the new tests fail, including four places where the test
  doubles were hiding the bug and had to be made to behave like a real browser
  (bookmark position validation, alarm scheduling, history normalization and visit counts).
- `npm run build:firefox` now prints the Drive redirect URL derived from the add-on id, so
  the link between the two can't drift silently again.

## [1.1.0] - 2026-07-27

Bookmark restore points, a storage picker built around real providers, and two new
Settings tabs. Nothing about the sync format changed, so existing setups keep syncing
and map onto their new provider card without a re-sync.

### Added
- **Bookmark restore points**: timestamped copies of your bookmark tree, stored on
  your own backend. Create one by hand in Settings, Activity, or let Konode save one
  automatically when it refuses an unusual mass deletion from another device.
  Restoring adds back bookmarks missing here and never deletes anything; the newest
  10 are kept and you can delete any of them yourself. Encrypted like everything else
  when end-to-end encryption is on. The bookmark count for each restore point is held
  in a small index on your backend, encrypted with your passphrase, so every device
  shows it while the storage provider cannot read it.
- **A card per storage provider** in both Settings and first-run setup: Google Drive,
  Nextcloud/ownCloud, pCloud (EU or US), Koofr, Fastmail, GitHub/Gitea/GitLab, and
  WebDAV for anything else. Each has its real logo, inlined so nothing is fetched
  from another server. Nextcloud takes just your server host and keeps a
  subdirectory install intact; pCloud has a region switch. Picking a card no longer
  means digging through a dropdown inside a WebDAV row.
- **Activity tab**: the audit log moved out of the popup into a full-width tab,
  newest first, with an errors-only filter and Clear log. The popup keeps a link to
  it.
- **Statistics tab**: counts for this device, sync activity including how much data
  has moved, and how many other devices you are reaching. All computed locally.
- **Setup card** in Settings until a backend and a data type are configured, with
  buttons that jump to the right tab. Useful where the first-run tab never opens.
- **Feedback links** in Settings, Advanced: a GitHub issues link and a mailto.
  Both only do something when you click them. Konode still has no server, sends no
  telemetry, and pings nothing when you uninstall it.
- **Popup** shows your provider's actual name (for example "Koofr") instead of the
  underlying backend type, plus a banner when a mass deletion was blocked.

### Fixed
- **Data transferred always read 0** in the new Statistics tab: the counter was
  declared but never written. It now tallies every payload pulled and pushed.
- **Restore points were never cleaned up across devices**: retention walked a
  device-local list rather than the files actually on the backend, so two devices
  each holding fewer than ten between them pruned nothing and the folder grew
  without limit. "Newest 10 kept" is now true on every device.
- **Two restore points taken in the same millisecond** collided on their filename
  and the second silently replaced the first.
- **Button heights** across Settings were set by text metrics, so neighboring
  buttons rendered 2-3px apart (Save changes sat shorter than Test Connection).
  They now share one height.
- **Unknown Statistics values** showed a dash that read like a missing number; they
  now say "n/a", which is what an ungranted permission actually means.

### Changed
- **American English throughout**, and em and en dashes removed from everything a
  user or visitor reads, including the extension description shown in your browser's
  extensions page.
- The README now states plainly that Konode is built with AI assistance and
  human-reviewed.

## [1.0.2] - 2026-07-21

Cross-engine hardening from testing sync across Brave, Firefox, and Orion (WebKit).

### Fixed
- **Bare-origin bookmark duplication across engines**: Chromium/Firefox store a
  bare origin as `https://site/` (trailing slash) while WebKit stores `https://site`;
  the merge keyed on the raw string and re-added the peer's form every sync
  (unbounded; seen live as one bookmark multiplying). URL identity is now matched on
  a canonical key; distinct paths still stay distinct.
- **Session restore only opened the first tab on WebKit/Orion**: the per-tab
  `tabs.create` loop was cut short by the popup blocker. Restores now open all tabs
  in a single `windows.create`.
- **Orion "Favorites" bookmarks landed in the wrong root**: WebKit reuses Chrome's
  numeric root ids with different meaning (id 3 = Favorites, not mobile). A root
  titled "Favorites" now maps to the bookmarks bar.
- **History visit times & Firefox import**: the original visit time is preserved on
  Firefox (via `visitTime`, rounded to an integer since Chrome emits fractional ms);
  Chrome is unchanged (its API can't set visit times).
- **Auth tokens no longer synced in history**: history URLs carrying an OAuth/reset
  token (`…#access_token=…`, `?id_token=…`, etc.) are excluded from sync (they stay
  in the local browser history); a per-URL import failure is now a quiet host-only
  warning instead of an error logging the full URL.
- **Popup "No backend configured" flash**: the popup read settings via a message to
  a possibly-cold worker and painted its empty initial state first; it now reads
  storage directly and gates the banner on settings having loaded.

### Added
- **Cross-browser extension matching**: synced extensions are tagged with their
  source store; "installed here?" matches same-store by id and cross-store by name /
  homepage, and install links are host-pinned to the current browser's store (a Chrome
  Web Store id can't resolve on Firefox, so cross-store links go to a name search).

## [1.0.1] - 2026-07-20

First post-launch patch, from testing the published build on more browsers.

### Fixed
- **Google Drive sign-in on engines without `launchWebAuthFlow`**: on iOS WebKit
  browsers (e.g. Orion) the interactive sign-in either isn't implemented or throws an
  opaque native error (`undefined is not an object (evaluating 'parameters.length')`).
  The Drive option is now feature-gated (hidden behind a "not available in this
  browser; use GitHub or WebDAV" note when the API is absent), and any non-cancel
  sign-in failure surfaces that friendly message instead of the raw engine error.
  iOS / WebKit remains unsupported overall (onboarding also doesn't open there); this
  just keeps the Drive path from dead-ending. GitHub and WebDAV are unaffected.

## [1.0.0] - 2026-07-19

The build submitted to the Chrome Web Store for review (2026-07-19) and **published
2026-07-20** (item `mmlfiiimnpnjcjhhbldenpcmnibedkfa`): E2EE hardened end-to-end,
Firefox supported, the brand applied everywhere, store packaging + releases wired up,
and a round of pre-submission security hardening.

### Security / E2EE hardening
- **Stopped uploading the passphrase verifier**: `encrypt("konode-verify-v1")`
  on third-party storage was an offline brute-force oracle on the passphrase.
  A mismatch now surfaces via the payload's GCM decrypt failure (same loud
  `PassphraseError`); legacy peers' verifiers are still checked on download.
- **Passphrase strength floor**: a new manually-typed E2EE passphrase must be
  ≥12 characters (options + onboarding, with an honest "guessable offline"
  explanation); generated keys and already-saved passphrases are unaffected.
  PRIVACY.md and the README now document the offline-guessing threat model.
- **E2EE mixed-state self-healing**: encryption disagreements between devices
  no longer hard-abort or deadlock the group: the device uploads its own
  (correctly-encrypted) file first, mismatches are per-device warnings, an
  orphaned plaintext file is skipped silently instead of warning forever, and
  enabling/rotating E2EE forces a re-upload in the new form so a mixed group
  converges in one cycle.
- **No plaintext downgrade paths**: a device with E2EE off no longer decrypts
  encrypted peers (it gets an "enable E2EE here" nudge instead of silently
  re-publishing the group's data in plaintext), and a manual conflict-resolve
  can't import a plaintext packet into an encrypted device.
- **Passphrase UX**: double-entry confirm for new passphrases (options +
  onboarding), content-free saved-secret masking, reveal-on-demand eye,
  explicit confirmation before turning E2EE off.
- **Leaked OAuth client retired**: the Google OAuth client secret briefly
  committed to source now lives in a gitignored `.env` and is injected at build
  time (`VITE_GOOGLE_CLIENT_SECRET`); the exposed client was deleted in the
  Google Cloud Console and replaced with a fresh one.
- **Peer extension `storeUrl` rebuilt locally**: the popup/options opened a peer's
  synced `storeUrl` verbatim; with E2EE off, anyone with backend write access could
  forge it and point "Install" at a phishing page. It is now reconstructed from the
  extension id, pinning the host to the Web Store.
- **`management` is strictly read-only**: dropped the dead `SET_EXTENSION_ENABLED`
  handler (no UI ever sent it), so the code matches the read-only permission
  justification and PRIVACY.md.

### Added
- **Firefox support**: runtime APIs routed through `webextension-polyfill`,
  browser-agnostic bookmark-root resolution (Chrome `1/2/3` ⇄ Firefox
  `toolbar_____`/`menu________`/`unfiled_____` by kind), a Firefox manifest
  variant (`npm run build:firefox` → `dist-firefox/`, event-page background,
  gecko id `konode@konode.org`, `data_collection_permissions: none`), web-ext
  packaging + lint, and a per-browser OAuth redirect. Runtime-verified on
  Waterfox 140 (onboarding, Drive OAuth, sync, session restore, history).
- **Folder reorder sync**: a folder repositioned among its siblings propagates
  via a path-keyed move-log with **anchor-based** placement (lands next to the
  same neighbor on every device, not at a raw index that doesn't translate);
  cross-parent folder moves relocate their bookmarks and the emptied shell is
  pruned on the receiver.
- **Configurable mass-delete guard**: the bookmark bulk-delete safety cap is a
  setting (default 60%, 50-95% in Settings → Advanced) instead of a hard 50%,
  so a legitimate bulk cleanup propagates while a corrupt tombstone log still
  can't wipe a tree.
- **Per-device sessions & extensions everywhere**: the popup lists every peer
  device's session with per-device restore, and unions every peer's extension
  list.
- **Brand**: peer-mesh logo mark, reproducible icon generation, full UI
  re-skin (popup, options, onboarding) with system light/dark, self-hosted
  fonts, and the Proton-Pass-style top-tab settings layout.
- **Docs for launch**: marketing README with screenshot, GETTING_STARTED,
  TROUBLESHOOTING, PRIVACY.md (near-final), STORE_LISTING.md (CWS listing +
  OAuth consent copy), MPL-2.0 LICENSE, build-fingerprint verification script
  (`npm run checksum`).

### Fixed
- **Move-to-last-position convergence**: Chromium's same-parent move quirk
  (an index measured against the pre-removal array) made "move to the end"
  land one slot short forever; the corrective nudge now clamps to the child
  count so it actually reaches the last slot.
- **Cross-root move safety**: a peer root that can't be confidently mapped
  (e.g. an older build's foreign id) can no longer yank an existing bookmark
  into the default root.
- **Duplicate-URL deletion safety**: deleting one of several identical-URL
  bookmarks no longer tombstones (deletes) the URL on every peer.
- **Audit backlog cleared** (4-agent review, 2026-07-07): sticky manual
  conflict resolutions (no more re-notify loop), the sync-lock race, backend
  list errors no longer masquerade as "no peers", export works without the
  history permission, SecretField renders the generated key.
- **Onboarding permission request**: the WebDAV server origin and the optional
  data-type permissions are now requested in a single `permissions.request` call; a
  second call after an `await` could be rejected for lacking a user gesture,
  stranding WebDAV users who also enabled a data type.

### Tooling
- CI now **enforces** lint (`continue-on-error` removed), runs `npm ci` from
  the committed lockfile, and `eslint-plugin-react-hooks` is wired in
  (rules-of-hooks as an error, exhaustive-deps advisory).
- Single-source version (`scripts/sync-version.mjs` stamps the manifests from
  `package.json`).
- **Chrome Web Store packaging**: `npm run package:chrome` builds, then zips a
  staging copy of `dist/` with the manifest `key` removed (the CWS rejects `key` on
  a first upload) while `dist/` keeps it for unpacked-dev ID stability.
- **Release workflow**: pushing a `v*` tag builds and publishes a GitHub release
  with the packaged Chrome zip (source build, no client secret); v1.0.0 released.

## [0.1.0]

The first working build, hardened over a review + fix pass. Highlights:

### Added
- **End-to-end encryption (opt-in)**: AES-256-GCM + PBKDF2 (600k), wired into the
  sync engine. Toggle + passphrase in Settings → Advanced. Data is encrypted
  before it leaves the device; the storage provider can't read it.
- **WebDAV backend made functional**: requests an `optional_host_permissions`
  grant for the user's server origin at runtime (it couldn't reach arbitrary
  hosts before).
- **Bookmark deletion sync (tombstones)**: deletes now propagate across devices
  instead of resurrecting; folder hierarchy preserved; 90-day tombstone GC; a
  >50% mass-delete is refused as a safety net.
- **Conflict resolution UI**: popup banner (Keep local / Use remote) + a working
  "Manual" strategy; per-item (per-URL) resolution.
- **Session restore** and **extension re-enable** message handlers; audit log
  mounted in the popup with a Clear action.
- Onboarding requests optional permissions for the chosen data types.
- **Session-manager UI**: the popup now lists the open-tab session of **each** peer
  device (name, tab count, last-synced time) with a per-device Restore button,
  instead of a single "Restore tabs from another device" button. Remote sessions are
  stored device-keyed (`konode_remote_sessions` is now a map), so every peer's
  session survives instead of only the newest. Sessions carry the device label so
  the list is human-readable.
- **Cross-peer extension aggregation**: `konode_remote_extensions` is now device-keyed
  too; the popup unions every peer's installed-extension list (deduped by id), so
  "missing on this device" reflects extensions installed on **any** other device, not
  just the most recently synced one.

### Changed
- **Saved secrets are masked in Settings**: once a token / WebDAV password / E2EE
  passphrase is saved, the field shows a `••••••` summary (last 4 chars) instead of
  binding the raw value into the DOM; a "Replace" action re-enters edit mode. The
  reveal (eye) toggle is now per-field, so unmasking one secret no longer unmasks the
  others. (A `type="password"` field always exposes its value in the DOM; this keeps
  the saved secret out of casual inspection / screenshots / screen-sharing. Note:
  credentials are still stored in `chrome.storage.local`, the standard extension
  model, since there's no OS secret store.)
- **GitHub upload 409 fixed at the root**: GitHub sends `Cache-Control: max-age=60`
  on contents reads, so the browser HTTP cache returned a *stale* SHA for up to a
  minute after a write; every PUT (and every retry) then 409'd with "…does not
  match". All backend reads (GitHub, WebDAV, Drive) now use `cache: "no-store"` so a
  peer file / SHA is always fresh; the GitHub SHA is re-read on each attempt and a 409
  is retried with exponential backoff (up to 5 attempts).
- **No redundant uploads**: each data type now records the checksum it last uploaded
  and skips the upload when nothing changed, so a sync that finds nothing new no
  longer writes a fresh commit every interval (which also removed the main 409
  trigger). Made the bookmark payload deterministic (a missing `dateAdded`, e.g. on
  the root node, now falls back to `0` instead of `Date.now()`) so an unchanged tree
  hashes identically across syncs and devices.
- **Resilient downloads**: a single corrupt or partially-written remote file (e.g.
  trailing bytes after the JSON: "Unexpected non-whitespace character after JSON")
  no longer aborts the whole sync. Each backend skips a file it can't parse, and the
  engine skips any peer whose file fails to apply (parse / checksum / import), folding
  in the rest. The owning device rewrites its file cleanly on the next sync.
- **Forgiving GitHub repository field**: the backend now normalizes the Repository
  value to an `owner/repo` slug (`normalizeRepoSlug`), accepting a pasted
  `https://github.com/owner/repo` URL, a `.git` suffix, a trailing slash, or the
  `git@github.com:` SSH form. Previously these produced a confusing "repository not
  found" because the GitHub API 404s on a full URL or a trailing slash.
- **Sync model**: pull peer file first (excluding our own), then for additive
  data types always merge the peer in and push the merged result. Fixes "remote
  changes never arrived" under Last Write Wins.
- **Multi-device merge**: `IBackend.download` → `downloadAll`, returning every
  peer file; the engine folds them all in per sync (oldest→newest) so 3+ devices
  converge in one cycle instead of relying on slow transitive propagation.
  Per-strategy deletion handling stays inside the bookmark merge; prefer-local now
  consistently adds peers' new bookmarks while ignoring their deletions.
- **Newest-peer ordering**: the engine now sorts downloaded peer packets newest-first
  by their `timestamp` (`orderPeersByTime`) before resolving conflicts and folding
  them in. GitHub and WebDAV list files in arbitrary order, so `peers[0]` (the LWW /
  manual-conflict baseline) was previously an arbitrary peer rather than the most
  recent one. Uses the same clock LWW relies on, with no per-backend commit/mtime lookups.
- **Near-instant sync-on-change** (~1s debounced fast path) with a 30s backstop
  alarm; periodic pull floor lowered from 60s to Chrome's real 30s minimum.
- Integrity: checksums are now **SHA-256** (was a mislabeled djb2) and **verified
  on download**; payload shape validated before import.
- Retry policy: only transient failures (network, 408/429/5xx via `HttpError`)
  are retried; deterministic 4xx no longer waste attempts.
- Google Drive backend: `res.ok` checks everywhere (no more silent "success" on a
  failed upload); create path uses `multipart/related`; downloads via the
  authenticated GitHub Contents API instead of the unauthenticated `download_url`.
- Permissions: `history`/`tabs`/`management` moved to `optional_permissions`
  (requested on enable); unused `sessions` permission and dead Mega host removed;
  `api.github.com` added.
- Security/UX: fine-grained GitHub token link (single repo) instead of classic
  `repo` scope; WebDAV `http://` warning; honest Drive credential copy; external
  Google Fonts fetch removed (privacy).
- Bookmark merge preserves the remote folder structure (no longer flattened into
  "Other Bookmarks"); replace guards against an empty/malformed remote tree and
  snapshots local first; root matching uses Chrome's stable IDs.

### Fixed
- **Bookmark moves now propagate.** The URL-keyed merge ignored a bookmark's
  folder, so moving one between folders didn't sync. Added a per-URL move log
  (`konode_bm_moves`, recorded on `onMoved`) carried in the payload; the merge
  relocates a locally-present bookmark to the peer's folder with last-write-wins
  (prefer-local keeps local placement; prefer-remote always adopts the peer's).
  The merge also passes the **position/index** from the peer's tree to
  create/move, so a moved or added bookmark lands at the peer's spot instead of
  always at the end of the folder.
- **Empty folders no longer resurrect.** Folders carry no tombstone (those are
  URL-keyed), so a deleted folder's bookmarks were removed but the empty folder
  synced back from a peer. Now the merge creates folders lazily (only when a
  descendant bookmark is actually added) and empty folders are pruned from the
  synced payload, so deleting a folder propagates fully.
- `type-check` now passes (non-existent `SyncTab` type; `includes("tabs")` against
  a value no longer in `DataType`; `Uint8Array<ArrayBuffer>` for Web Crypto).
- Live popup status (the MV3 `chrome.extension.getViews` broadcast gate was dead).
- **MV3 race**: every entry point awaits `ensureInit()`, so sync works with the
  worker cold, not only while the SW DevTools console is held open.
- Multi-device: `download()` excludes the caller's own file across all backends,
  so a device stops masking its peers.
- `bufferToBase64` RangeError on large encrypted payloads (chunked encoding).

### Removed
- Unused deps (`zustand`, `webextension-polyfill`) and dead components
  (StatusBadge, SyncButton, DataTypeRow).

### Tooling
- **Vitest** suite (encryption, retry policy, conflict resolver, tombstone
  helpers, remote-session/extension normalizers, peer ordering, **bookmark merge +
  `SyncEngine.syncType`**) with an in-memory `chrome.storage` + `chrome.bookmarks`
  stub; **ESLint** flat config; **GitHub Actions CI** (type-check + test on every
  push). Scripts: `test`, `test:watch`, `lint`, `check`.

### Drive OAuth (refresh token)
- Replaced the implicit grant (token died after ~1h, silent re-auth unreliable on
  Brave) with **PKCE authorization-code + refresh token** (new shared module
  `lib/backends/gdrive-oauth.ts`). One interactive consent stores a refresh token;
  access tokens then refresh via a plain POST (no UI, no browser session), so
  background sync survives indefinitely on every Chromium browser. backend +
  options + onboarding share the one implementation.
- _Needs runtime verification (re-sign-in required to mint the first refresh
  token)._

### UI / brand re-skin
- **Popup re-skinned** to a system-following light/dark theme (new `sk-*` design
  tokens; opts in via a `.sk-body` class). Content-fit height with a pinned
  header + a single scrolling body, so the audit log grows the popup instead of
  pushing the header off the top at Chrome's ~600px ceiling; the leftover black
  strip after toggling the audit log is gone. Active streams became a 4-circle
  icon grid (green = OK, amber spinner = syncing) and the wordmark header was
  dropped (settings moved into the status row).
- **Options + onboarding re-skinned** to the same palette: accent moved from
  Google blue to the signal green, with light/dark surfaces, borders and focus
  rings retuned. Fixed green-on-green contrast where the selected-card tint and
  the icon chips were the same pale green (account avatar, Disconnect button,
  selected backend icon, sidebar/onboarding logo).
- **Self-hosted fonts**: Inter + JetBrains Mono (latin-subset woff2, OFL) bundled
  under `public/fonts`, wired via `@font-face`; the external Google Fonts fetch is
  gone for good and DM Sans is no longer referenced. Nothing leaves the device.
