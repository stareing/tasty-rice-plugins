import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Media Stream Grabber",
  short_name: "MSG",
  description: pkg.description,
  version: pkg.version,
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
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
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
  ],
  host_permissions: ["<all_urls>"],
  // SharedArrayBuffer (needed by ffmpeg.wasm) requires cross-origin isolation.
  // We only enable COEP/COOP on the offscreen document by serving its HTML
  // with appropriate headers via the dynamic file URL — the popup itself
  // does not need isolation.
  web_accessible_resources: [
    {
      resources: ["src/offscreen/index.html", "assets/*"],
      matches: ["<all_urls>"],
    },
  ],
});
