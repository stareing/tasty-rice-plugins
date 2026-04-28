/**
 * Background service worker.
 *
 * Responsibilities:
 *   1. Sniff `webRequest` for media URLs and bucket them per-tab.
 *   2. Maintain a small in-memory store keyed by tabId — service workers can
 *      be evicted, so the store is also persisted to chrome.storage.session.
 *   3. Expose a message API for the popup (list / clear / start download).
 *   4. Spawn the offscreen document on demand for HLS/DASH merging via ffmpeg.wasm.
 */

import type { DetectedStream, RuntimeMessage } from "@/lib/types";
import { classify, hashId, suggestedFilename } from "@/lib/streamClassify";

const MAX_STREAMS_PER_TAB = 64;
const SESSION_KEY = "msg.streamsByTab.v1";

/** Per-tab map. Reloaded from chrome.storage.session on SW wake. */
let streamsByTab: Map<number, DetectedStream[]> = new Map();
let restored = false;

async function restoreFromSession(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const data = await chrome.storage.session.get(SESSION_KEY);
    const raw = data[SESSION_KEY] as Record<string, DetectedStream[]> | undefined;
    if (!raw) return;
    streamsByTab = new Map(
      Object.entries(raw).map(([k, v]) => [Number(k), v]),
    );
  } catch {
    // session storage may be unavailable in older Chromes — non-fatal.
  }
}

async function persist(): Promise<void> {
  const obj: Record<string, DetectedStream[]> = {};
  for (const [tabId, streams] of streamsByTab) obj[String(tabId)] = streams;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: obj });
  } catch {
    /* ignore */
  }
}

function addStream(tabId: number, stream: DetectedStream): boolean {
  const list = streamsByTab.get(tabId) ?? [];
  if (list.some((s) => s.id === stream.id)) return false;
  const next = [stream, ...list].slice(0, MAX_STREAMS_PER_TAB);
  streamsByTab.set(tabId, next);
  return true;
}

/* ------------------------------ context menus ----------------------------- */

const MENU_VIDEO = "msg.download-video";
const MENU_AUDIO = "msg.download-audio";
const MENU_LINK = "msg.download-link";
const MENU_IMAGE = "msg.download-image";
const MENU_DETECTED = "msg.show-detected";

/** Recreate menus on install / update — chrome.runtime.onInstalled fires for
 *  fresh installs *and* extension updates / SW restarts after browser update. */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_VIDEO,
      title: "Download this video",
      contexts: ["video"],
    });
    chrome.contextMenus.create({
      id: MENU_AUDIO,
      title: "Download this audio",
      contexts: ["audio"],
    });
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      title: "Download this image",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: "Download link target",
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_DETECTED,
      title: "Show detected streams (open popup)",
      contexts: ["page", "frame"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextClick(info, tab);
});

async function handleContextClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  await restoreFromSession();

  switch (info.menuItemId) {
    case MENU_VIDEO:
    case MENU_AUDIO:
    case MENU_IMAGE: {
      const url = info.srcUrl;
      if (!url) return notify("No source URL on this element.");
      if (url.startsWith("blob:")) {
        // blob: URLs cannot be downloaded across contexts. Fall back to the
        // streams the sniffer caught for this tab.
        return offerDetectedFallback(tab?.id);
      }
      // If it's an HLS playlist, route through the merge pipeline.
      if (/\.m3u8(\?|$|#)/i.test(url)) {
        const stream: DetectedStream = {
          id: hashId(url),
          url,
          kind: "hls",
          suggestedName: suggestedFilename(url, "hls"),
          detectedAt: Date.now(),
          pageUrl: info.pageUrl,
          pageTitle: tab?.title,
        };
        await startDownload(stream, `ctx-${Date.now().toString(36)}`);
        return;
      }
      try {
        await chrome.downloads.download({ url, saveAs: true });
      } catch (err) {
        notify(`Download failed: ${(err as Error).message}`);
      }
      return;
    }
    case MENU_LINK: {
      if (!info.linkUrl) return;
      try {
        await chrome.downloads.download({ url: info.linkUrl, saveAs: true });
      } catch (err) {
        notify(`Download failed: ${(err as Error).message}`);
      }
      return;
    }
    case MENU_DETECTED: {
      // The popup must be opened by user action. We can flash the badge so
      // the user knows which streams are available.
      await offerDetectedFallback(tab?.id);
      return;
    }
  }
}

async function offerDetectedFallback(tabId: number | undefined): Promise<void> {
  if (tabId == null) return;
  const list = streamsByTab.get(tabId) ?? [];
  if (!list.length) {
    notify("No streams detected on this tab yet — start playing the video first.");
    return;
  }
  notify(
    `${list.length} stream(s) detected. Click the toolbar icon to choose what to download.`,
  );
}

function notify(message: string): void {
  // chrome.notifications requires the "notifications" permission; if the user
  // has denied OS-level notifications we still want the call not to throw.
  try {
    void chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("public/icons/icon-128.png"),
      title: "Media Stream Grabber",
      message,
    });
  } catch {
    /* permission missing — silent */
  }
}

/* --------------------------- webRequest sniffer --------------------------- */

const headerLookup = (headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string | undefined => {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) return h.value;
  }
  return undefined;
};

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method !== "GET") return;

    const contentType = headerLookup(details.responseHeaders, "content-type");
    const kind = classify(details.url, contentType);
    if (!kind) return;

    // Skip the noisy stuff: HLS sub-segments (.ts) and image thumbnails.
    // We keep the master/media playlist and the user can drive the merge.
    if (kind === "mp4" && /\.ts(\?|$|#)/i.test(details.url)) return;
    if (kind === "image") return;

    void restoreFromSession().then(() => {
      const stream: DetectedStream = {
        id: hashId(details.url),
        url: details.url,
        kind,
        suggestedName: suggestedFilename(details.url, kind),
        mimeType: contentType,
        detectedAt: Date.now(),
      };
      const added = addStream(details.tabId, stream);
      if (!added) return;
      void persist();
      void chrome.runtime
        .sendMessage({ type: "streams:added", tabId: details.tabId, stream } satisfies RuntimeMessage)
        .catch(() => {
          /* popup not open — fine */
        });
      void updateBadge(details.tabId);
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

/* Annotate streams with the page they came from. */
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading" && change.url) {
    // Reset on top-level navigation.
    streamsByTab.delete(tabId);
    void persist();
    void updateBadge(tabId);
    return;
  }
  if (change.title || change.url) {
    const list = streamsByTab.get(tabId);
    if (!list?.length) return;
    for (const s of list) {
      if (!s.pageUrl && tab.url) s.pageUrl = tab.url;
      if (!s.pageTitle && tab.title) s.pageTitle = tab.title;
    }
    void persist();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
  void persist();
});

async function updateBadge(tabId: number): Promise<void> {
  const count = streamsByTab.get(tabId)?.length ?? 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#2563eb" });
  } catch {
    /* tab gone */
  }
}

/* ------------------------------ message API ------------------------------ */

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  void (async () => {
    await restoreFromSession();

    switch (msg.type) {
      case "streams:list": {
        const streams = streamsByTab.get(msg.tabId) ?? [];
        sendResponse({ type: "streams:list:result", streams } satisfies RuntimeMessage);
        return;
      }
      case "streams:clear": {
        streamsByTab.delete(msg.tabId);
        await persist();
        await updateBadge(msg.tabId);
        sendResponse({ ok: true });
        return;
      }
      case "download:start": {
        try {
          await startDownload(msg.stream, msg.jobId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "download:cancel": {
        await sendToOffscreen({ type: "download:cancel", jobId: msg.jobId });
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: "unhandled" });
    }
  })();
  return true; // async sendResponse
});

/* ------------------------------ download flow ----------------------------- */

async function startDownload(stream: DetectedStream, jobId: string): Promise<void> {
  if (stream.kind === "mp4" || stream.kind === "audio") {
    // Direct download via chrome.downloads — let the browser handle it.
    await chrome.downloads.download({
      url: stream.url,
      filename: stream.suggestedName,
      saveAs: true,
    });
    void chrome.runtime.sendMessage({
      type: "download:progress",
      payload: { jobId, phase: "done", ratio: 1 },
    } satisfies RuntimeMessage);
    return;
  }

  // HLS / DASH — needs the offscreen document for ffmpeg.wasm.
  await ensureOffscreen();
  await sendToOffscreen({ type: "download:start", stream, jobId });
}

const OFFSCREEN_PATH = "src/offscreen/index.html";

async function ensureOffscreen(): Promise<void> {
  // chrome.offscreen.hasDocument() — modern API.
  const has = await chrome.offscreen
    .hasDocument?.()
    .catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS" as chrome.offscreen.Reason],
    justification: "Run ffmpeg.wasm to merge HLS/DASH segments into a playable file.",
  });
}

async function sendToOffscreen(msg: RuntimeMessage): Promise<void> {
  // Messages to the offscreen doc go through chrome.runtime.sendMessage; the
  // offscreen page subscribes and filters by type.
  await chrome.runtime.sendMessage(msg).catch(() => {
    /* offscreen may have been torn down — caller will retry */
  });
}
