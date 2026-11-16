# Troubleshooting

Common issues and how to fix them. This fork is distributed locally and has no issue
tracker of its own; when asking for help elsewhere, include your browser, the backend
you use, the compatibility mode under Settings → Tools & diagnostics, and what you saw.

## Loading the extension

**The extension page shows `Unexpected token 'export'`, or a wall of minified
`lucide-react` code, and the popup / options page is blank.**

That text is not the error message — it is the source line the browser choked on:
`chunks/puzzle-*.js`, an ES module. It fails when a module is executed as a classic
script, which happens when HTML from one build is mixed with chunks from another.
The usual cause is extracting a newer zip **over** the folder the old version is
loaded from. Vite content-hashes chunk filenames, so unzipping adds the new files
but never removes the old ones; the folder ends up holding two builds at once.

Fix it on the browser side (the build itself is fine):

1. Remove the extension in `chrome://extensions` / `about:debugging`.
2. Delete the whole extracted folder — do not unzip on top of it.
3. Extract the new zip into a **brand-new** folder and load that folder.
4. Click ↻ on the extension card so the MV3 service worker is replaced.

From 1.5.3 on the extension ID is pinned by the manifest `key`, so a new folder does
NOT lose settings. Overwriting the old folder was needed only for the one-time
1.5.1 → 1.5.2 migration. If a clean install still fails, note the *first* line of the
error and which surface shows it (popup, options, or the extension list) — that is
what distinguishes a stale install from a genuine module-loading bug.

**The version shown in the extension list is older than the zip's filename.** The zip
name comes from `package.json` while the manifest inside is copied from `dist/`.
Early 1.5.5 packages were built from a stale `dist/` and contained a 1.5.4 manifest,
so fixes made in source were not actually in them. Packaging now refuses to produce
such a zip; rebuild with `npm run package:source:pinned` and check that the version
inside the extracted `manifest.json` matches the filename.

## Sync

**Changes take a while to show up on my other device.**
Edit a bookmark and this device uploads in about a second, as long as **Sync on change** is
on (it is by default, under Settings → This device). The *receiving* device finds out
on its next scheduled pull, which is every 60 seconds by default. You can move that to
anywhere between 30 and 600 seconds under **Settings → This device → Sync interval**; 30s is the
browser's minimum for a background check, so that's the floor, not a bug. History, open
tabs and the extension list have no instant path at all: they travel on that same interval.

**Bookmarks I deleted came back / a big cleanup didn't propagate.**
Kesonode has a safety cap: it won't apply other devices' deletions that would remove more
than a threshold of your local bookmarks within 24 hours (default **60%**), to guard
against a corrupt deletion log wiping your tree. A deletion that arrives in several pieces
counts as one, so the piece that takes the day's total over the threshold is the one held
back, and the card says how many went before it. The device receiving the deletion saves a
restore point and shows "an unusual deletion was blocked", so nothing is lost either way.

**To let the deletion through**, open **Settings → Sync history** on the device showing the
warning and use **Apply the deletion** on the card at the top. It names the device that
is asking and how many bookmarks are involved, and the restore point is already saved
before you decide.

**To keep the bookmarks instead**, undo the deletion on the device that made it: open
**Settings → Sync history** there and restore a point from before the cleanup. That puts the
bookmarks back and clears the deletion record, so it stops being sent to your other
devices.

Raising **Max bulk delete from a peer** under **Settings → This device → Safety** (50-95%)
also lets a large cleanup through, but only up to 95% of your tree, so it cannot help
when a device asks to clear nearly everything. It is a standing setting rather than a
one-time approval, so prefer the card above.

**"Publishing is paused" / my other devices aren't getting this device's bookmarks.**
The local change guard noticed that this device's bookmark tree kept changing by a large
amount on several sync cycles in a row without settling. That pattern usually means two
sync systems are feeding each other's writes back and forth, or an extension is
rebuilding a bookmark folder. Kesonode pauses **only this device's upload**; it still
receives everyone else's changes, and nothing here was deleted or reverted. A restore
point was saved automatically.

You don't have to do anything: one cycle in which the tree stays quiet clears the hold and
publishing resumes. If it keeps coming back, check whether Chrome Sync / Firefox Sync is
running alongside Kesonode on this profile. Picking one system for bookmarks is the
simple answer; **Exclude bookmarks from sync** can also keep a folder another tool owns
out of Kesonode entirely.

A single large cleanup is NOT held — deleting 40 bookmarks in one go publishes
immediately. Only repeated, never-settling churn (or one cycle changing more than 500
entries) trips the guard.

**Nothing syncs unless I keep a DevTools window open (dev builds).**
After rebuilding an unpacked extension you must click **↻ reload** on it
(`chrome://extensions`). The background service worker is suspended when idle and
wakes on the next event; a normal install handles this automatically.

**My history shows the wrong times.**
On Chromium browsers, by design. Chrome, Brave and the rest give an extension no way to
set a page's original visit time, so an arriving page carries the moment it reached you.
Firefox does allow it and Kesonode uses it there, so the same sync keeps the original dates
on Firefox. Visit counts can't be restored on either. History is a synced list, not a
faithful timeline.

## Encryption

**"Your passphrase doesn't match your other devices."**
Every device must use the exact same E2EE passphrase. Open **Settings → Cloud & encryption** and find
the **Encryption** card, reveal or re-enter the passphrase so it matches your other
device(s), and sync again. Kesonode fails loudly here on purpose: it won't silently fork your
data into unreadable files. Note what it does *not* do, though. The sync isn't cancelled.
This device still uploads its own file correctly, and the peer it couldn't read is reported
as a warning, so the group recovers as soon as the passphrases agree. A new typed
passphrase needs at least 12 characters, or you can generate a key.

**I turned encryption off on one device.**
That's a downgrade: that device re-uploads its data unencrypted, and Kesonode nudges you
there, on the device that can actually fix it, that your other devices are still encrypted.
Those encrypted devices stay quiet about it on purpose, because a plaintext file on the
backend is usually just a leftover from a device that's gone. To converge again, either
turn E2EE off everywhere or back on everywhere (with the same passphrase).

## Google Drive

**"redirect_uri_mismatch" on Orion or Quetta (installed from a store).**
Try Drive sign-in again first: this was fixed on our side in September 2026, and there's
nothing to update or reinstall. Those browsers implement `identity.getRedirectURL("gdrive")`
but drop the path, so they hand back the bare `https://<extension-id>.chromiumapp.org/`
instead of `.../gdrive`, and that form had to be registered with the OAuth client
separately. The extension ID in the request is the right one, which is what makes this look
like a Kesonode bug rather than a missing redirect. If it still fails, read the
`Request details: redirect_uri=...` line on Google's own error page: a different extension
ID there means the browser assigned its own ID to Kesonode, which can't be registered ahead
of time, and GitHub or WebDAV are the backends to use on that browser. The Activity log
can't tell the two cases apart, because from Kesonode's side a mismatch is a window that
closed: it logs `Sign-in ended (window closed)` with the redirect Kesonode asked for, which
you can compare with the one on Google's page.

**Google sign-in is approved, but Kesonode returns to the start of setup (Quetta for Android).**
**Update Quetta first.** The browser fixed this on its side, and a reporter confirmed on
2026-09-19 that Drive sign-in completes on the newest version. What follows describes an
older build. Look at the address the sign-in window ended on. If it starts with
`https://<extension-id>.chromiumapp.org/` and contains `code=`, then Google accepted
everything and the sign-in itself worked. That address is not a real website. It is a
signal meaning "the sign-in is finished", and the browser is supposed to recognize it,
close the window and hand the result to the extension. An older Quetta doesn't recognize
it, so it tries to load the address as an ordinary page, which is why you get an error
page. Kesonode never receives the result, so all it can say is that the sign-in window closed
before the sign-in came back, and on older versions the setup wizard also started over.
Nothing is wrong with your Google account or your Drive, and there is nothing to reinstall. Kesonode can't work around it from inside, because the step
that fails happens in the browser before any Kesonode code runs, which is why updating is
the fix. GitHub and WebDAV need no Google sign-in at all and sync the same data on any
version. If you were partway through setup, the wizard picks up where it was when you open
it again within a day, apart from the encryption step, which asks again.

**"Connected as ()" / Drive sync fails (building from source).**
Your own Google Cloud project needs the **Google Drive API enabled**
(APIs & Services → Library → Google Drive API → Enable). The OAuth sign-in can succeed
while Drive API calls fail if the API isn't enabled. This doesn't affect installs from
the store.

**"redirect_uri_mismatch" (building from source).**
Your OAuth client must list your extension's redirect URI. On Chromium, load `dist/` and
read the extension ID at `chrome://extensions`; the redirect is
`https://<extension-id>.chromiumapp.org/gdrive`. On Firefox the host is not the add-on ID
but its SHA-1 hex digest, so don't try to assemble it by hand:
`npm run build:firefox` prints the exact URL at the end of the build. Add whichever you
need to your OAuth client's **Authorized redirect URIs**.

**"Google hasn't verified this app."**
Kesonode requests only the `drive.file` scope (non-sensitive: app-created files only),
so this warning normally doesn't appear. If it does, it's safe to proceed: you're
authorizing access to your own Kesonode files, and no data goes to any Kesonode server
(there isn't one).

## GitHub

**"Public repositories aren't allowed" / connection refused.**
Point Kesonode at a **private** repository. Sync data shouldn't sit in a public repo.

**403 / permission errors.**
Use a **fine-grained** token scoped to the one repo, with
**Contents: Read and write**. A token missing that permission (or scoped to the wrong
repo) will fail.

## WebDAV

**"WebDAV must use https" / connection rejected.**
Plain `http://` is rejected for security (credentials would travel in the clear). Use
`https://`. `http://localhost` is allowed for local testing.

**Connected but I don't see my files.**
Check that the account can create the sync folder at that path — `konode/` in the two
compatibility modes, `kesonode/` in **Fully separate** mode. Some providers gate WebDAV
behind a paid tier or a per-app password; check your provider's WebDAV docs.

**I switched compatibility mode and the data looks gone.**
Switching does not move existing files: the new folder starts empty and this device
re-uploads its own data on the next sync. Switch **every** device in the group to the same
mode, or switch back. See
[Which folder?](README.md#which-folder-three-compatibility-modes).

## Firefox

**The extension list differs from my Chromium device.**
Extension IDs don't cross stores, so between a Chromium browser and Firefox Kesonode matches
on the extension's name and on the developer's homepage host instead. That catches the
common cases, but an extension published under different names in the two stores still
shows up as "missing on this device". The list is most exact between same-browser peers.

## Firefox for Android

Firefox for Android runs extensions on GeckoView, which implements a smaller slice of the
extension APIs than desktop Firefox. Two of those gaps affect Kesonode directly, and neither
is something Kesonode can work around, so it tells you about them instead of failing.

**Bookmarks and History can't be synced there.** Firefox for Android ships no bookmarks
API and no history API, so an extension has nothing to read or write
([bookmarks](https://github.com/mozilla-mobile/fenix/issues/21830)). Kesonode marks both as
unavailable in Settings → Synced content and skips them, rather than reporting an error every
sync for something you can't fix. Open tabs still sync, and your desktop devices carry on
syncing everything among themselves. Bookmarks you have on Android are not touched. The
extension list syncs too.

**Google Drive can't sign in there.** Firefox for Android has no identity API, which is what
an extension uses to open Google's sign-in, so the Drive card says up front that it isn't
available in this browser. Use GitHub or a WebDAV provider on the phone, the same one your
other devices use.

**"This browser can't show permission prompts."** Firefox for Android doesn't implement
runtime permission requests
([bug 1601420](https://bugzilla.mozilla.org/show_bug.cgi?id=1601420)), so when Kesonode asks
for access to your WebDAV server, no prompt appears and the request comes back refused. To
grant it by hand: open Firefox's **Settings → Extensions → Kesonode → Permissions**, allow
the permissions there, then return to Kesonode and try again. Kesonode checks what you've
already granted before asking, so once it's allowed there, setup and Test connection go
through.

## Zen

**Only the workspace in front syncs its open tabs.** Zen gives extensions the tabs of the
workspace you are looking at and nothing else: to an extension, the tabs of your other
workspaces don't exist, not even as hidden tabs. So the session a Zen device shares is the
workspace that was active when it last synced, and what your other devices see changes when
you switch workspaces. A restored session opens in whichever workspace is active, and which
workspace a tab came from isn't carried, because no extension API can name a workspace.
Kesonode can't work around this; it would take Zen offering workspaces to extensions.
Bookmarks, history and the extension list are not affected. (Measured on Zen 1.24b,
November 2026.)

A separate Zen **profile** is a different matter: each profile is its own Kesonode device,
with its own file in your storage, as in any browser.

## Starting over

Google Drive has a **Disconnect** button in **Settings → Cloud & encryption**. GitHub and WebDAV
don't: to leave one of those, either pick a different provider in the same place and enter
its credentials, or remove and reinstall the extension (which clears all local data and
credentials). Your synced files on the backend are untouched. Delete those directly through your storage provider if you want
a full wipe.
