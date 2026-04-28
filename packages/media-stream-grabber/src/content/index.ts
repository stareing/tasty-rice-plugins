/**
 * Content script — runs in the page context (isolated world).
 *
 * Job: catch <video src=...> / <audio src=...> URLs that webRequest doesn't
 * surface (mostly preloaded MP4s referenced as direct attributes), and report
 * them up to the SW so the right-click menu / popup can offer them.
 *
 * We deliberately do NOT inject into the main world or scrape MSE/blob
 * buffers — that path is fragile and player-specific. Real HLS/DASH manifest
 * URLs are already covered by the background sniffer.
 */

import type { RuntimeMessage } from "@/lib/types";

const reported = new Set<string>();

function annotateOnce(): void {
  const elements = document.querySelectorAll<HTMLMediaElement>("video, audio");
  if (!elements.length) return;

  for (const el of Array.from(elements)) {
    const src = el.currentSrc || el.src;
    if (!src || reported.has(src)) continue;
    if (src.startsWith("blob:") || src.startsWith("data:")) continue;
    reported.add(src);
    // The SW fills tabId / frameId from the message sender — content scripts
    // never know their own tab id, so don't try to guess.
    void chrome.runtime
      .sendMessage({
        type: "streams:report-direct",
        url: src,
        pageTitle: document.title,
        pageUrl: location.href,
        target: "sw",
      } satisfies RuntimeMessage)
      .catch(() => {
        /* SW asleep — it'll re-pick up via webRequest anyway */
      });
  }
}

annotateOnce();

const obs = new MutationObserver(() => annotateOnce());
obs.observe(document.documentElement, { childList: true, subtree: true });

// Disconnect after 30s to avoid wasting CPU on infinite-scroll pages; players
// almost always finish loading their <video> elements within this window.
setTimeout(() => obs.disconnect(), 30_000);
