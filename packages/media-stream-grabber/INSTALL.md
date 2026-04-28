# Install — Media Stream Grabber

[中文版](./INSTALL.zh.md)

This is the full install guide for end users. Five minutes from zero to a
working extension.

---

## 1. Supported browsers

Any Chromium-based browser that supports Manifest V3:

| Browser            | Status     | Notes                                         |
| ------------------ | ---------- | --------------------------------------------- |
| Google Chrome ≥ 88 | ✅ Tested  | Recommended                                   |
| Microsoft Edge     | ✅ Tested  | Same flow, page is `edge://extensions`        |
| Brave              | ✅ Works   | `brave://extensions`                          |
| Vivaldi            | ✅ Works   | `vivaldi://extensions`                        |
| Opera              | ✅ Works   | `opera://extensions`                          |
| Arc                | ✅ Works   | Same as Chrome                                |
| Firefox            | ❌ Not yet | Different extension format (MV3 + WebExt API) |

Throughout this guide we'll say `chrome://extensions` — substitute the right
prefix for your browser.

---

## 2. Download the package

Always grab the latest stable build from the unversioned alias URL — no need
to know the current version number:

> https://github.com/stareing/tasty-rice-plugins/releases/latest/download/media-stream-grabber.zip

What you'll get:

- A single `.zip` file, ~200 KB.
- Filename: `media-stream-grabber.zip`.

**Why a ZIP and not a one-click install?** Chrome blocks `.crx` installs from
outside the Chrome Web Store on the consumer channel for security. The "Load
unpacked" path is the supported alternative for self-distributed extensions.

---

## 3. Unzip

Pick a folder you won't accidentally delete — the extension keeps running
from this folder, so don't put it in `~/Downloads/`.

| OS              | Recommended location                                       |
| --------------- | ---------------------------------------------------------- |
| Windows         | `C:\Tools\MediaStreamGrabber\`                             |
| macOS           | `~/Applications/MediaStreamGrabber/`                       |
| Linux           | `~/.local/share/media-stream-grabber/`                     |

**Windows:** right-click the ZIP → **Extract All…** → pick the destination.
Don't use the read-only "open inside the ZIP" preview view — Chrome cannot
load from there.

**macOS:** double-click the ZIP. Finder unzips into a folder next to it.

**Linux:** `unzip media-stream-grabber.zip -d ~/.local/share/media-stream-grabber/`

After unzipping you should see at least these entries inside the folder:

```
manifest.json
service-worker-loader.js
assets/
icons/
src/
```

If you only see another `.zip` — you didn't extract, you previewed.

---

## 4. Load the unpacked extension

1. Open `chrome://extensions` in the address bar.
2. Toggle **Developer mode** on, top-right corner. The page expands and
   reveals three new buttons on the top-left.
3. Click **Load unpacked**.
4. In the file picker, **select the folder** from step 3 (the one
   containing `manifest.json`). On macOS, click the folder once and press
   "Select"; on Windows, click "Select Folder".
5. The extension card appears with the **MSG** icon and version number.

A small **MSG** icon will appear in the browser toolbar. If it's hidden,
click the extensions puzzle-piece icon and pin Media Stream Grabber.

---

## 5. First run — quick walkthrough

1. Open any page that plays a video — YouTube, Twitch, a documentary site,
   anywhere with HLS / DASH / direct media.
2. Start the video. The toolbar icon shows a small badge with the count of
   media streams the extension has detected.
3. Click the **MSG** icon. The popup lists every detected stream with:
   - Codec / format guess (`HLS .m3u8`, `MP4`, `audio/mp3`, …)
   - Resolution (when available)
   - Source URL
4. For each stream you can:
   - **Copy URL** — just the link, useful for `yt-dlp` or `curl`.
   - **Download** — direct media downloads instantly via Chrome's download
     manager. HLS streams open the offscreen pipeline: parse playlist →
     fetch segments in parallel → AES-128 decrypt → ffmpeg remux → MP4.

Right-click context menus also work on `<video>`, `<audio>`, `<img>` and
detected stream URLs — pick **Download with Media Stream Grabber**.

---

## 6. What the extension can and can't grab

| Source                                  | Status                                        |
| --------------------------------------- | --------------------------------------------- |
| Direct `.mp4` / `.m4v` / `.webm` etc.   | ✅ Native `chrome.downloads.download()`       |
| Direct audio (`.mp3` / `.m4a` / etc.)   | ✅ Same as above                              |
| HLS `.m3u8` (master + media playlists)  | ✅ Parse → fetch → AES-128 → ffmpeg → MP4     |
| HLS with byte-range segments            | ✅ Range header                               |
| HLS with rotating keys                  | ⚠️ Single key only (v1 limitation)            |
| DASH `.mpd`                             | 🚧 Detected, not yet downloadable (roadmap)   |
| MSE / `blob:` URLs                      | ❌ Out of scope — needs page-context injection |
| DRM-protected (Widevine / FairPlay)    | ❌ By design                                  |

If a site uses MSE without exposing playlist URLs, the popup will be empty.
That's expected.

---

## 7. Upgrade to a new version

When a new release ships, the **MSG** icon won't auto-update — you're
running unpacked, not Web Store. The upgrade flow:

1. Download the new `media-stream-grabber.zip` from the same URL.
2. Extract it **over the existing folder** (overwrite all). On Windows
   make sure to "Replace the files in the destination."
3. Open `chrome://extensions` → find Media Stream Grabber → click the
   small refresh / reload icon on its card.

That's it. Browser state, settings and the extension ID all stay intact.

---

## 8. Uninstall

1. Open `chrome://extensions`.
2. Find Media Stream Grabber → click **Remove**.
3. Optionally delete the unzipped folder from your filesystem.

The extension stores nothing outside `chrome.storage.session`, which Chrome
auto-clears on uninstall. No registry entries, no system-level files.

---

## 9. Troubleshooting

### The extension card shows a red error after loading

Most common causes:

- **Wrong folder picked.** You need the folder *containing* `manifest.json`,
  not its parent. Re-pick.
- **Folder is read-only.** macOS sometimes mounts the unzipped folder as a
  DMG-style read-only volume. Move it to `~/Applications/` first.
- **Antivirus or system policy blocking unpacked extensions.** Check your
  enterprise policy (`chrome://policy`) — if `ExtensionInstallBlocklist` is
  set, ask your admin or use a personal profile.

### The MSG icon shows no badge / popup is empty

- The page hasn't fired a media request yet — start playing the video.
- Some single-page-app sites delay the manifest until interaction. Click
  play, wait 1–2 seconds, then re-open the popup.
- Check `chrome://extensions` → Service worker → **Inspect**. If the SW is
  showing 500-class errors, the extension may have crashed; reload it.

### HLS download fails halfway with "ffmpeg load failed"

`ffmpeg.wasm` is fetched from `unpkg.com` on first use (~30 MB, cached).
Symptoms and fixes:

- **No internet during first merge.** Connect once with the popup open;
  the WASM core caches into the SW for offline use thereafter.
- **Corporate proxy blocks unpkg.** Whitelist `unpkg.com` or use the
  roadmap's "bundle ffmpeg locally" build (planned).

### The download saves with a weird filename

Chrome decides filenames based on `Content-Disposition` and the URL path.
Rename in your downloads folder afterwards — there's no rename UI in the
popup yet. Tracking issue: planned for v0.2.

### Right-click "Download with Media Stream Grabber" missing

- Required permissions: `contextMenus`, `notifications` — these were added
  in v0.1.0. If you're on an older build, upgrade.
- Some sites' overlays absorb right-clicks. Try right-clicking on the
  bottom edge of the video, or use the popup instead.

### Page Not Found on `/apps/media-stream-grabber`

That's the blog detail page, not the extension. If `https://tastyrice.org/apps/media-stream-grabber`
404s, the blog is deploying. Refresh in 30 seconds.

---

## 10. Permissions explained

The extension declares `host_permissions: <all_urls>` and `webRequest`.
That sounds dramatic, so here's exactly what they're used for:

| Permission                      | Why                                                             |
| ------------------------------- | --------------------------------------------------------------- |
| `webRequest`                    | Observe network responses to spot media URLs. Read-only.        |
| `host_permissions: <all_urls>`  | Required by `webRequest` to actually see those responses.       |
| `downloads`                     | Save the merged MP4 / direct media to your downloads folder.    |
| `offscreen`                     | Host `ffmpeg.wasm` (service workers can't run wasm reliably).   |
| `storage`                       | `chrome.storage.session` only — per-tab stream state, no sync.  |
| `tabs` / `activeTab`            | Read the current tab id and title for the popup UI.             |
| `scripting`                     | Reserved for future page-scoped helpers (e.g. `<video>` probe). |
| `contextMenus`                  | Right-click "Download with Media Stream Grabber".               |
| `notifications`                 | Toast when a download starts / fails / blob URL falls back.     |

**No analytics. No remote logging. No auth. No telemetry.** The only
outbound network call the extension itself makes is fetching `ffmpeg-core`
from unpkg the first time you merge an HLS stream. Everything else is
either user-initiated (downloading the segments you asked for) or local
(running ffmpeg in your browser).

You can verify by opening DevTools on the popup (right-click → Inspect)
and watching the Network tab.

---

## 11. Build it yourself (developers)

If you'd rather build from source instead of trusting the prebuilt ZIP:

```bash
git clone https://github.com/stareing/tasty-rice-plugins.git
cd tasty-rice-plugins
npm install
cd packages/media-stream-grabber
npm run build
```

Then point "Load unpacked" at `packages/media-stream-grabber/dist/`.

For HMR during development:

```bash
npm run dev
```

CRXJS will write a dev manifest into the project root — point "Load
unpacked" there instead of `dist/`. Reload on save.

---

## Need help?

- Open an issue: https://github.com/stareing/tasty-rice-plugins/issues
- Source for this guide: [`packages/media-stream-grabber/INSTALL.md`](https://github.com/stareing/tasty-rice-plugins/blob/main/packages/media-stream-grabber/INSTALL.md)
