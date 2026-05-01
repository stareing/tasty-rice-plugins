import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

// Pinning the public key freezes the extension ID across "Load unpacked"
// reloads — Chrome treats every reload as an update of the same extension
// instead of installing a fresh copy each time. Generated locally with
// `openssl genrsa -out key.pem 2048`; the matching private key is kept in
// `key.pem` (gitignored) and is only needed if we ever sign a CRX.
const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArFJfrRIZnb/iGZa201PwFv0+U9oa0UJhHQWtGKnz9Y8lLBboXcTprKXgPltSN5v6tV/Vm6mnZdATbYqhOGFc9NMqFrAQnnBsaoLVUF1fCt/VAeciBf3XXjvlDgQhX6bfEkQE54bfRr1s4V/fWuj7mH4plw4dxwA0o4xcXBDBdjrSGXTPFzEpYh2gzqr5x88jzCV2keKNWamBkU/wziEzeSLYWSSWwIAVozxoGNwSQUl7CXtsJKi4J+y9QipVTuxbMgAVX6TyeMoS29dfbpq+xpjR+uRg7uEl3PO2iWWaADvRIfezCrN0KT7XiCHvEOADJGVT0rZ3MjxloF2WjnvjfwIDAQAB";

export default defineManifest({
  manifest_version: 3,
  name: "Media Stream Grabber",
  short_name: "MSG",
  description: pkg.description,
  version: pkg.version,
  key: EXTENSION_PUBLIC_KEY,
  icons: {
    16: "public/icons/icon-16.png",
    32: "public/icons/icon-32.png",
    48: "public/icons/icon-48.png",
    128: "public/icons/icon-128.png",
  },
  action: {
    default_title: "Media Stream Grabber",
    default_popup: "src/popup/index.html",
    default_icon: {
      16: "public/icons/icon-16.png",
      32: "public/icons/icon-32.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  permissions: [
    "webRequest",
    "storage",
    "activeTab",
    "tabs",
    "downloads",
    "scripting",
    "offscreen",
    "contextMenus",
    "notifications",
    "declarativeNetRequestWithHostAccess",
  ],
  host_permissions: ["<all_urls>"],
  // ffmpeg.wasm calls WebAssembly.instantiate(), which the MV3 default CSP
  // ("script-src 'self'") blocks. `wasm-unsafe-eval` is the MV3-approved
  // token for running bundled wasm in extension pages; it does NOT relax
  // 'unsafe-eval' for JS, so this is still safe.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  // We ship the single-thread ffmpeg-core build, so neither the popup nor
  // the offscreen document need COOP/COEP cross-origin isolation.
  web_accessible_resources: [
    {
      resources: ["src/offscreen/index.html", "assets/*"],
      matches: ["<all_urls>"],
    },
  ],
});
