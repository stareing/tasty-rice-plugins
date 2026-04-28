/**
 * Content script — runs in the page context (isolated world).
 *
 * Job: catch <video src="blob:..."> / MediaSource-fed players that webRequest
 * cannot see, and surface basic metadata (page title, current playing src) so
 * the popup can offer reasonable filenames.
 *
 * We deliberately do NOT try to inject into the main world or scrape MSE
 * buffers — that path is fragile and player-specific. Real HLS/DASH is
 * already covered by the background sniffer reading the manifest URL.
 */

import type { RuntimeMessage } from "@/lib/types";

function annotateOnce(): void {
  const videos = document.querySelectorAll<HTMLMediaElement>("video, audio");
  if (!videos.length) return;

  for (const v of Array.from(videos)) {
    const src = v.currentSrc || v.src;
    if (!src || src.startsWith("blob:")) continue;
    void chrome.runtime
      .sendMessage({
        type: "streams:added",
        tabId: -1, // background fills in tabId from sender
        stream: {
          id: btoa(src).slice(0, 12),
          url: src,
          kind: src.includes(".m3u8") ? "hls" : src.includes(".mpd") ? "dash" : "mp4",
          suggestedName: document.title.replace(/[\\/:*?"<>|]+/g, "_") || "media",
          pageUrl: location.href,
          pageTitle: document.title,
          detectedAt: Date.now(),
        },
      } satisfies RuntimeMessage)
      .catch(() => {
        /* SW asleep */
      });
  }
}

// One pass at idle, then a single MutationObserver pass — players load late.
annotateOnce();
const obs = new MutationObserver(() => annotateOnce());
obs.observe(document.documentElement, { childList: true, subtree: true });
// Disconnect after 30s — long-running observers waste CPU on infinite-scroll pages.
setTimeout(() => obs.disconnect(), 30_000);
