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
- `@ffmpeg/ffmpeg` 0.12 — bundled locally (no unpkg fetch at runtime), single-thread build
- Chrome `webRequest` + `offscreen` + `declarativeNetRequest` + `downloads` APIs

## Project layout

```
src/
├── background/
│   ├── index.ts          # Service worker — right-click menu, gated webRequest
│   │                     #   sniffer (only fires for armed tabs / armed frames),
│   │                     #   message router, DNR Referer rules, job persistence,
│   │                     #   focus context capture for the scorer
│   └── injected.ts       # MAIN-world page hooks (installed only after the user
│                         #   arms a tab) — <video>/<audio> retro sweep,
│                         #   fetch/XHR/JSON.parse instrumentation that surfaces
│                         #   inline m3u8/mpd URLs the SW's webRequest can't see,
│                         #   DRM (EME) + MSE detection, optional appendBuffer mirror
├── popup/                # React popup (action UI, batch-download queue,
│                         #   variant/audio/subtitle picker, arm + sniff + MSE
│                         #   capture toggles, FOCUS confidence badges)
├── manager/              # Standalone "Downloads" page (chrome.storage.local
│                         #   mirror of every job, live progress via broadcasts,
│                         #   retry / cancel / remove)
├── options/              # Standalone options page — per-site filename rules
│                         #   (host suffix + URL regex + filename template)
├── offscreen/            # Offscreen doc — HLS + DASH pipelines, ffmpeg.wasm,
│                         #   IndexedDB-backed segment resume, WebVTT subtitle merge,
│                         #   MSE appendBuffer capture writer (OPFS)
└── lib/
    ├── types.ts          # Shared message + stream types (target-routed envelope,
    │                     #   FocusContext, ManagedJobRecord, …)
    ├── streamClassify.ts # URL/Content-Type → StreamKind, filename slugifier
    ├── streamScore.ts    # Pure scorer ranking sniffed streams against the
    │                     #   recorded right-click focus (frame, time, host, kind)
    ├── siteRules.ts      # Built-in + user-defined per-site filename overrides
    ├── m3u8.ts           # HLS playlist parser (master, media, EXT-X-MAP/MEDIA,
    │                     #   AES-128 with rotation, EXT-X-MEDIA-SEQUENCE)
    └── mpd.ts            # DASH MPD parser (SegmentTemplate, SegmentTimeline)
```

The `installCrawler` MAIN-world hook in `background/injected.ts` is **only**
injected via `chrome.scripting.executeScript` after the user opts in (right-
click arm or "Sniff page" toggle). There is no `content_scripts` manifest
entry — a passive `all_urls` content script would violate the
opt-in-only capture contract.

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

The extension does nothing on its own. The right-click menu and the popup
toggles are the only entry points; nothing observes the network until you opt
in.

| You want to…                                 | Right-click → Media Stream Grabber → …                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Grab the HLS / DASH stream a player is using | **Capture next 30s of media on this tab**, then start (or restart) playback           |
| Save a `<video>`/`<audio>` with a real `src` | **Download this video element** / **Download this audio element**                     |
| Save the file behind a link                  | **Download link target**                                                              |
| Save an image                                | **Download this image**                                                               |

When **Capture** is armed the toolbar badge turns red with a `•`. If anything
is captured during the window, the badge switches to a count and the popup
lists every detected URL with resolution / audio / subtitle pickers.

### Smart sniffing — focus scoring

Right-clicking on a `<video>` element records a `FocusContext` (tab, frame,
click time, the element's `src`, the menu item picked) and every sniffed
stream is scored 0–100 against it. The popup sorts the list score-first, so
the player you actually pointed at outranks ad iframes, sibling players, and
preload requests on the same page. Rows with score ≥ 70 get a green **FOCUS**
badge — these are the ones you almost certainly meant to grab.

Scoring runs entirely in the SW and is purely local. It uses signals already
on the stream record — `kind`, `source` (`web-request` vs `page-crawler`),
`frameId`, `detectedAt`, `mseDetected`, `drmDetected`, host of `pageUrl` and
`url` — plus the recorded focus. No `chrome.debugger`, no extra permissions.

### Popup affordances

In addition to the right-click menu, the popup gives you:

- **Arm capture** — same 30-second tab-scoped window as the right-click item.
- **Sniff page** — long-lived tab-wide capture. Stays on until you stop it or
  the page navigates. The only mode that surfaces images.
- **Capture MSE** — opt-in mirror of every `SourceBuffer.appendBuffer` payload.
  The offscreen document writes the chunks to OPFS and remuxes on **Save**;
  use this when the page only exposes `blob:` URLs and the segments have
  already been decrypted in the player.
- **Batch download** — checkbox per row plus a top-bar "Download N" button.
  Runs strictly sequentially (HLS jobs sharing ffmpeg / IndexedDB / DNR rules
  cannot safely run in parallel). Toggle **Auto recommended** to bypass the
  variant picker and take the SW-recommended rendition for every job.

### Standalone pages

| Page                                                   | URL fragment              | What it's for                                            |
| ------------------------------------------------------ | ------------------------- | -------------------------------------------------------- |
| **Downloads** (`src/manager/`)                         | `src/manager/index.html`  | Persistent log of every job, with retry / cancel / remove. Mirrors the `chrome.storage.local` job log. |
| **Options** (`src/options/`)                           | `src/options/index.html`  | Per-site filename overrides — host suffix, URL regex with one capture group, filename template using `${name}` / `${id}` / `${title}`. |

The popup links to both via `chrome.runtime.getURL(...)`; Options is also the
extension's standard "options page".

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
| Right-click focus scoring               | ✅ Streams ranked against click frame / time / host; FOCUS badge ≥70 |
| Page-side fetch/XHR/JSON.parse hooks    | ✅ `installCrawler` (MAIN world) — surfaces inline m3u8/mpd       |
| Page-sniff mode (long-lived tab capture)| ✅ Toggle from popup; includes images; expires on navigation only |
| Batch download (sequential queue)       | ✅ Checkbox per row + Auto-recommended toggle for HLS/DASH        |
| MSE appendBuffer capture                | ✅ Opt-in popup toggle; chunks → OPFS → ffmpeg remux on Save      |
| MSE / `blob:` URLs without MSE capture  | ⚠️ Arm a 30s window — restart playback so the manifest fetches become visible |
| HLS SAMPLE-AES, DASH DRM (Widevine)     | ❌ Out of scope — segments stay encrypted                         |

## Permissions explained

- `webRequest` + `host_permissions: <all_urls>` — required so that, **only
  while a tab is armed (right-click) or in page-sniff mode (popup toggle)**,
  the extension can observe manifest responses on whatever site you're on.
  The listener early-returns on every other tab and outside the capture
  window. **Read-only.**
- `declarativeNetRequestWithHostAccess` — used only while a download is
  running, to inject the page's `Referer` / `Origin` into outbound segment
  fetches so CDNs don't 403. Rule is removed when the job ends.
- `scripting` — required to inject the MAIN-world `installCrawler` hook
  into a tab once the user opts in. The hook surfaces fetch/XHR-only manifest
  URLs the SW's webRequest can't see (e.g. URLs the player constructs from
  inline JSON config). Idempotent; gated on the same arm/sniff state as
  `webRequest`. Never installed automatically.
- `downloads` — to save files.
- `offscreen` — to host `ffmpeg.wasm` (service workers can't run wasm reliably).
- `storage` — `chrome.storage.session` for per-tab stream state, focus
  context, and active job resume across service-worker eviction;
  `chrome.storage.local` for the long-lived Downloads-manager job log and
  user-defined site rules from the options page.
- `contextMenus` — right-click menu entry points.
- `notifications` — surfaces "no streams sniffed yet" and similar hints.
- `tabs` / `activeTab` — pull the current tab id and title.

No analytics, no remote logging, no auth. The extension does not fetch
`ffmpeg-core` from the internet — the wasm core is bundled into `dist/` at
build time, so the extension can run fully offline.

## Roadmap

- [ ] DASH text Representations: extract WebVTT from fMP4 `wvtt` boxes
- [ ] Live HLS / dynamic MPD support (currently static playlists only)
- [ ] Page hydration scan: extract m3u8/mpd from `__INITIAL_STATE__` /
      `__NEXT_DATA__` JSON without waiting for a fetch hit
