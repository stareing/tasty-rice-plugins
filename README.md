# Tasty Rice Plugins — Inventory

[![CI](https://github.com/stareing/tasty-rice-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/stareing/tasty-rice-plugins/actions/workflows/ci.yml)
[![Release](https://github.com/stareing/tasty-rice-plugins/actions/workflows/release.yml/badge.svg)](https://github.com/stareing/tasty-rice-plugins/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/stareing/tasty-rice-plugins?label=release&color=blue)](https://github.com/stareing/tasty-rice-plugins/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://opensource.org/licenses/MIT)

> Self-published browser extensions, desktop addons, CLIs and small utilities.
> Surfaced on the main site at <https://tastyrice.org/apps>.
> Plugins live under `packages/<slug>/` and ship via tag-driven GitHub Releases.

---

## At a glance

| Metric                          | Value                                       |
| ------------------------------- | ------------------------------------------- |
| **Total plugins**               | 1                                           |
| Stable releases                 | 0                                           |
| Beta releases                   | 1                                           |
| Unreleased / WIP                | 0                                           |
| Categories shipped              | Chrome extension                            |
| Total source LOC (TS/TSX/CSS)   | ~9,000                                      |
| Total source files              | 20                                          |
| Latest published release        | [`v0.5.0`](https://github.com/stareing/tasty-rice-plugins/releases/latest) |
| Release flow                    | tag-driven (`v*` → GitHub Actions → ZIP attached) |

---

## Plugins

### `media-stream-grabber`

![status](https://img.shields.io/badge/status-beta-yellow)
![category](https://img.shields.io/badge/category-Chrome%20MV3-blue)
![version](https://img.shields.io/badge/dynamic/json?label=source&query=%24.version&url=https%3A%2F%2Fraw.githubusercontent.com%2Fstareing%2Ftasty-rice-plugins%2Fmain%2Fpackages%2Fmedia-stream-grabber%2Fpackage.json)
![license](https://img.shields.io/badge/license-MIT-green)

Chrome extension that sniffs HLS / DASH / direct media URLs from any page and
merges segmented streams into a single playable file.

| Field             | Value                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Slug**          | `media-stream-grabber`                                                                                                      |
| **Status**        | Beta                                                                                                                        |
| **Category**      | Chrome MV3 extension (Chromium ≥ 88: Chrome / Edge / Brave / Vivaldi / Arc / Opera)                                         |
| **Latest tag**    | [`v0.5.0`](https://github.com/stareing/tasty-rice-plugins/releases/tag/v0.5.0)                                              |
| **Source version**| `0.6.0` (unreleased — focus scoring + batch download, see commits)                                                          |
| **Stack**         | TypeScript · React · Vite · CRXJS · `ffmpeg.wasm` (bundled)                                                                 |
| **Source LOC**    | ~9,000 across 20 files                                                                                                      |
| **Runtime deps**  | 4 (`@ffmpeg/core`, `@ffmpeg/ffmpeg`, `react`, `react-dom`)                                                                  |
| **Dev deps**      | 8                                                                                                                           |
| **Build size**    | 32 MB unpacked (ffmpeg-core wasm bundled) · **~11 MB zipped**                                                               |
| **Permissions**   | `webRequest` · `declarativeNetRequestWithHostAccess` · `downloads` · `offscreen` · `storage` · `tabs` · `activeTab` · `scripting` · `contextMenus` · `notifications` |
| **Install**       | [Download latest ZIP](https://github.com/stareing/tasty-rice-plugins/releases/latest/download/media-stream-grabber.zip)     |
| **Docs**          | [README](./packages/media-stream-grabber/README.md) · [Install (EN)](./packages/media-stream-grabber/INSTALL.md) · [Install (中文)](./packages/media-stream-grabber/INSTALL.zh.md) |
| **Source**        | [`packages/media-stream-grabber/`](./packages/media-stream-grabber/)                                                        |
| **Public page**   | <https://tastyrice.org/apps/media-stream-grabber>                                                                           |

---

## Release history

| Version  | Plugins changed         | Asset (ZIP)                                                                                              | Highlights                                                                       |
| -------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `v0.5.0` | `media-stream-grabber`  | [`media-stream-grabber.zip`](https://github.com/stareing/tasty-rice-plugins/releases/latest/download/media-stream-grabber.zip) (~11 MB) | Page-sniff mode · category filter · audio-track validation                       |
| `v0.4.x` | `media-stream-grabber`  | versioned ZIPs only                                                                                      | ffmpeg-core bundled locally · targeted HLS capture · audio-mux verification      |
| `v0.3.0` | `media-stream-grabber`  | versioned ZIPs only                                                                                      | Right-click capture · AES-128 sequence-number fix                                |
| `v0.2.0` | `media-stream-grabber`  | versioned ZIPs only                                                                                      | DASH MPD pipeline · WebVTT subtitle merging                                      |
| `v0.1.0` | `media-stream-grabber`  | versioned ZIPs only                                                                                      | First public release · HLS pipeline · context menus                              |

Stable URL — always points at the latest release of any plugin:
`https://github.com/stareing/tasty-rice-plugins/releases/latest/download/<slug>.zip`

---

## Repo footprint

| Item                     | Count                                                |
| ------------------------ | ---------------------------------------------------- |
| Plugins                  | 1                                                    |
| Workspace commits        | 16 (`git rev-list --count HEAD`)                     |
| GitHub Actions workflows | 2 (`ci.yml`, `release.yml`)                          |
| Languages                | TypeScript (97%) · CSS (3%)                          |
| Workspace shared deps    | 2 dev (`adm-zip`, `typescript`)                      |

---

## How it's structured

```
plugins/
├── package.json              # npm workspaces root (workspaces: ["packages/*"])
├── tsconfig.base.json        # shared TS compiler options — extend per-plugin
├── scripts/release.mjs       # node + adm-zip → dist-release/<slug>.zip
├── .github/workflows/
│   ├── ci.yml                # type-check + build on push/PR
│   └── release.yml           # tag-driven release, attaches ZIPs to GH Release
└── packages/                 # all plugins live here, one dir each
    └── <plugin-slug>/        # directory name === /apps URL slug
        ├── package.json
        ├── tsconfig.json     # extends ../../tsconfig.base.json
        ├── README.md
        └── src/
```

Conventions:

- Directory name **equals** the `/apps/[slug]` URL **and** the entry in
  `apps/web/lib/apps.ts` on the main site. No mismatches.
- One plugin = one product. No cross-plugin imports — extract a real package
  if two need to share code.
- Each plugin owns its own `dist/` (gitignored). The workspace root only
  produces release ZIPs in `dist-release/` (gitignored).

---

## Adding a plugin

1. `cd packages && mkdir <slug> && cd <slug>` — slug must match the `/apps` entry.
2. `npm init -y`, set `"private": true`, add `build` and `type-check` scripts.
3. `tsconfig.json` extends `../../tsconfig.base.json` (note the two-level path).
4. From the workspace root: `npm install` to link it into the workspace.
5. Add an entry to `my-blog/apps/web/lib/apps.ts` so the website knows about it.

---

## Releasing

Tag-driven and fully automated:

```bash
# 1. Bump the plugin's package.json version
cd packages/<slug> && npm version patch

# 2. Tag and push from the workspace root
cd ../..
git commit -am "release(<slug>): vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

The `Release` workflow then:

1. `npm ci` + `npm run type-check` + `npm run build` across all plugins.
2. `npm run release:pack` → `dist-release/<slug>-vX.Y.Z.zip` + `<slug>.zip`.
3. Creates a GitHub Release with all ZIPs attached and Chrome install steps
   in the body.

Each release publishes two assets per plugin:

- `<slug>-v<version>.zip` — versioned, immutable.
- `<slug>.zip` — unversioned alias. Stable URL:
  `releases/latest/download/<slug>.zip`.

---

## Local commands

| From            | Command                  | What it does                                              |
| --------------- | ------------------------ | --------------------------------------------------------- |
| workspace root  | `npm install`            | Install every plugin via npm workspaces                   |
| workspace root  | `npm run build`          | Build every plugin (skipped if no `build` script)         |
| workspace root  | `npm run type-check`     | Type-check every plugin                                   |
| workspace root  | `npm run release:local`  | Build + pack release ZIPs into `dist-release/`            |
| workspace root  | `npm run release:pack`   | Pack only (assumes build already ran)                     |
| workspace root  | `npm run clean`          | Wipe all `dist/`, `node_modules/`, `dist-release/`        |
| `packages/<slug>/` | `npm run dev`         | Per-plugin dev server (Vite + HMR for the popup)          |
| `packages/<slug>/` | `npm run build`       | Per-plugin production build                               |

---

## Public surface

- **Storefront**: <https://tastyrice.org/apps>
- **Per-plugin pages**: `https://tastyrice.org/apps/<slug>`
- **Releases**: <https://github.com/stareing/tasty-rice-plugins/releases>
- **Issues**: <https://github.com/stareing/tasty-rice-plugins/issues>

`my-blog/apps/web/lib/apps.ts` is the static source of truth on the website
side — it carries the bilingual descriptions, badge, accent colors and
download URL pattern used by `/apps/[slug]`.
