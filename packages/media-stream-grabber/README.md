# Media Stream Grabber

Chrome extension (Manifest V3) that sniffs HLS / DASH / direct media URLs from any
page and downloads them — including merging HLS `.ts` segments into a single MP4
via `ffmpeg.wasm` running in an offscreen document.

## Stack

- **TypeScript** + **React** + **Vite**
- `@crxjs/vite-plugin` for MV3 bundling
- `@ffmpeg/ffmpeg` 0.12 (loaded at runtime from unpkg, ~30 MB but cached)
- Chrome `webRequest` + `offscreen` + `downloads` APIs

## Project layout

```
src/
├── background/index.ts   # Service worker — webRequest sniffer + message router
├── content/index.ts      # Content script — picks up <video src=...> the SW can't see
├── popup/                # React popup (action UI)
├── offscreen/            # Offscreen doc — ffmpeg.wasm + HLS pipeline
└── lib/
    ├── types.ts          # Shared message + stream types
    ├── streamClassify.ts # URL/Content-Type → StreamKind
    └── m3u8.ts           # Minimal HLS playlist parser
```

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

## What it currently handles

| Source                                  | Status                                 |
| --------------------------------------- | -------------------------------------- |
| Direct `.mp4` / `.m4v` / `.webm` / etc. | ✅ Native `chrome.downloads.download()` |
| Direct audio (`.mp3` / `.m4a` / etc.)   | ✅ Same as above                        |
| HLS `.m3u8` (master + media)            | ✅ Parse → fetch → AES-128 → ffmpeg → MP4 |
| HLS with byte-range segments            | ✅ Range header                         |
| HLS with rotating keys                  | ⚠️ Single key only (v1 limitation)     |
| DASH `.mpd`                             | 🚧 Detected, not yet downloaded        |
| MSE / blob: URLs                        | ❌ Not feasible without page injection  |

## Permissions explained

- `webRequest` + `host_permissions: <all_urls>` — required to observe network
  responses on every site. **Read-only.**
- `downloads` — to save files.
- `offscreen` — to host `ffmpeg.wasm` (service workers can't run wasm reliably).
- `storage` — `chrome.storage.session` for per-tab stream state across SW evictions.
- `tabs` / `activeTab` — pull the current tab id and title.
- `scripting` — reserved for future page-scoped helpers.

No analytics, no remote logging, no auth. The only outbound network call the
extension makes on its own is fetching `ffmpeg-core.js/.wasm` from unpkg the
first time you merge an HLS stream.

## Roadmap

- [ ] DASH manifest parser + segment muxer
- [ ] Pause / resume + retry on transient segment failures
- [ ] Subtitle track download
- [ ] Bundle `ffmpeg-core` locally for fully offline operation
