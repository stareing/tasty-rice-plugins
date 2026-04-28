# Media Stream Grabber

Chrome extension (Manifest V3) that captures HLS / DASH / direct media URLs
from a single page — driven entirely by the right-click menu — and merges
them into a playable MP4 via `ffmpeg.wasm` running in an offscreen document.

> **Privacy contract.** The extension does **not** sniff network traffic by
> default. It only observes a tab while a 30-second capture window is open,
> and that window is opened only by you, via the right-click menu.

## Stack

- **TypeScript** + **React** + **Vite**
- `@crxjs/vite-plugin` for MV3 bundling
- `@ffmpeg/ffmpeg` 0.12 (loaded at runtime from unpkg, ~30 MB but cached)
- Chrome `webRequest` + `offscreen` + `downloads` APIs

## Project layout

```
src/
├── background/index.ts   # Service worker — right-click menu, gated webRequest
│                         #   sniffer (only fires while a tab is "armed"),
│                         #   message router, DNR Referer rules, job persistence,
│                         #   offscreen handshake gating
├── popup/                # React popup (action UI + variant/audio/subtitle picker
│                         #   + arm-capture button + countdown)
├── offscreen/            # Offscreen doc — HLS + DASH pipelines, ffmpeg.wasm,
│                         #   IndexedDB-backed segment resume, WebVTT subtitle merge
└── lib/
    ├── types.ts          # Shared message + stream types (target-routed envelope)
    ├── streamClassify.ts # URL/Content-Type → StreamKind, filename slugifier
    ├── m3u8.ts           # HLS playlist parser (master, media, EXT-X-MAP/MEDIA,
    │                     #   AES-128 with rotation, EXT-X-MEDIA-SEQUENCE)
    └── mpd.ts            # DASH MPD parser (SegmentTemplate, SegmentTimeline)
```

There is intentionally no content script: an `all_urls` content script would
violate the right-click-only capture contract.

## Develop

```bash
npm install
npm run dev          # Vite dev server with HMR for the popup
```

Then in Chrome → `chrome://extensions` → toggle **Developer mode** →
**Load unpacked** → pick the `dist/` directory after `npm run build`, or for
HMR pick the project root (CRXJS will write the dev manifest).

## Build

```bash
npm run build        # Type-check + production bundle in dist/
npm run zip          # (optional) produce a .zip for the Chrome Web Store
```

## Install (end users)

The fastest path that doesn't require a Chrome Web Store listing:

1. Grab the latest release ZIP:
   <https://github.com/stareing/tasty-rice-plugins/releases/latest/download/media-stream-grabber.zip>
2. Unzip it anywhere on disk.
3. Open `chrome://extensions`, turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and pick the unzipped folder.

To upgrade later, download the new ZIP, point "Load unpacked" at the new
folder, or hit the refresh icon on the extension card. Chrome treats this as
a normal extension — popup, context menus, badge counts and all.

For the full walkthrough — supported browsers, OS-specific unzip tips,
first-run usage, troubleshooting, permission explanations and a "build
from source" path — see [`INSTALL.md`](./INSTALL.md) (English) /
[`INSTALL.zh.md`](./INSTALL.zh.md) (中文).

## How to use

The extension does nothing on its own. The right-click menu is the entry
point for every download.

| You want to…                                | Right-click → Media Stream Grabber → …                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Grab the HLS / DASH stream a player is using | **Capture next 30s of media on this tab**, then start (or restart) playback           |
| Save a `<video>`/`<audio>` with a real `src`| **Download this video element** / **Download this audio element**                     |
| Save the file behind a link                  | **Download link target**                                                              |
| Save an image                                | **Download this image**                                                               |

When **Capture** is armed the toolbar badge turns red with a `•`. If anything
is captured during the window, the badge switches to a count and the popup
lists every detected URL with resolution/audio/subtitle pickers.

The popup also has an **Arm capture** button if you prefer the keyboard /
toolbar path over the right-click menu — both routes go through the same
30-second tab-scoped window.

## What it currently handles

| Source                                  | Status                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| Direct `.mp4` / `.m4v` / `.webm` / etc. | ✅ Native `chrome.downloads.download()`                           |
| Direct audio (`.mp3` / `.m4a` / etc.)   | ✅ Same as above                                                  |
| HLS `.m3u8` (master + media)            | ✅ Variant picker (height-first), AES-128, ffmpeg remux to MP4    |
| HLS fMP4 (`#EXT-X-MAP`)                 | ✅ Init segment prepended, modern ≥1080p sources work             |
| HLS byte-range segments                 | ✅ Range header                                                   |
| HLS rotating AES-128 keys               | ✅ Per-segment key from the most recent `#EXT-X-KEY`              |
| HLS `#EXT-X-MEDIA-SEQUENCE` ≠ 0         | ✅ Default IV uses absolute sequence — encrypted streams stay playable |
| HLS multi-audio (`#EXT-X-MEDIA AUDIO`)  | ✅ Audio rendition picker; ffmpeg `-map 0:v:0 -map 1:a:0` merge   |
| HLS subtitles (`SUBTITLES` group)       | ✅ Best-effort WebVTT merge with X-TIMESTAMP-MAP offset           |
| DASH `.mpd`                             | ✅ SegmentTemplate (`$Number$` + SegmentTimeline), variant picker |
| DASH multi-audio                        | ✅ Audio AdaptationSet picker                                     |
| DASH text Representations               | ⚠️ Raw WebVTT only — fMP4-wrapped (`wvtt` boxes) not extracted   |
| Resume across browser restart           | ✅ Per-segment IndexedDB cache (`${jobId}::v\|a::idx`)            |
| Referer-locked CDNs                     | ✅ DNR session rule injects `Referer` / `Origin` for the job      |
| Right-click direct download             | ✅ srcUrl / linkUrl from the click is used immediately            |
| MSE / `blob:` URLs                      | ⚠️ Right-click arms a 30s capture window — restart playback so the manifest fetches become visible |
| HLS SAMPLE-AES, DASH DRM (Widevine)     | ❌ Out of scope — segments stay encrypted                         |

## Permissions explained

- `webRequest` + `host_permissions: <all_urls>` — required so that, **only
  while a tab is armed via the right-click menu**, the extension can observe
  manifest responses on whatever site you're on. The listener early-returns
  on every other tab and outside the 30-second capture window. **Read-only.**
- `declarativeNetRequestWithHostAccess` — used only while a download is
  running, to inject the page's `Referer` / `Origin` into outbound segment
  fetches so CDNs don't 403. Rule is removed when the job ends.
- `downloads` — to save files.
- `offscreen` — to host `ffmpeg.wasm` (service workers can't run wasm reliably).
- `storage` — `chrome.storage.session` for per-tab stream state and active job
  resume across service-worker eviction.
- `contextMenus` — dynamic right-click menu listing detected streams.
- `notifications` — surfaces "no streams sniffed yet" and similar hints.
- `tabs` / `activeTab` — pull the current tab id and title.
- `scripting` — reserved for future page-scoped helpers.

No analytics, no remote logging, no auth. The only outbound network call the
extension makes on its own is fetching `ffmpeg-core.js/.wasm` from unpkg the
first time you merge an HLS stream.

## Roadmap

- [ ] DASH text Representations: extract WebVTT from fMP4 `wvtt` boxes
- [ ] Bundle `ffmpeg-core` locally for fully offline operation
- [ ] Live HLS / dynamic MPD support (currently static playlists only)
