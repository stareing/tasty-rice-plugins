/**
 * Background service worker.
 *
 * Responsibilities:
 *   1. Sniff `webRequest` for media URLs and bucket them per-tab + frame.
 *   2. Maintain a small in-memory store keyed by tabId — service workers can
 *      be evicted, so the store is also persisted to chrome.storage.session.
 *   3. Maintain a dynamic right-click menu listing every detected stream on
 *      the current tab so the user can download a specific resource without
 *      ever opening the popup.
 *   4. Inject a temporary `Referer` header (via declarativeNetRequest) for the
 *      duration of an HLS download so segment CDNs don't 403.
 *   5. Spawn / re-attach the offscreen document for ffmpeg.wasm work and
 *      shuttle messages with a `target` discriminator so SW and offscreen
 *      don't both react to the same broadcast.
 */

import type {
  DetectedStream,
  PersistedJob,
  RuntimeMessage,
} from "@/lib/types";
import { classify, hashId, suggestedFilename } from "@/lib/streamClassify";

const MAX_STREAMS_PER_TAB = 64;
const SESSION_KEY = "msg.streamsByTab.v1";
const JOBS_KEY = "msg.jobs.v1";
const DNR_RULE_BASE = 9000;

/** Per-tab map. Reloaded from chrome.storage.session on SW wake. */
let streamsByTab: Map<number, DetectedStream[]> = new Map();
let jobsById: Map<string, PersistedJob> = new Map();
let restored = false;
let menuRebuildTimer: ReturnType<typeof setTimeout> | null = null;

async function restoreFromSession(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const data = await chrome.storage.session.get([SESSION_KEY, JOBS_KEY]);
    const rawStreams = data[SESSION_KEY] as Record<string, DetectedStream[]> | undefined;
    if (rawStreams) {
      streamsByTab = new Map(
        Object.entries(rawStreams).map(([k, v]) => [Number(k), v]),
      );
    }
    const rawJobs = data[JOBS_KEY] as Record<string, PersistedJob> | undefined;
    if (rawJobs) {
      jobsById = new Map(Object.entries(rawJobs));
    }
  } catch {
    // session storage may be unavailable in older Chromes — non-fatal.
  }
}

async function persistStreams(): Promise<void> {
  const obj: Record<string, DetectedStream[]> = {};
  for (const [tabId, streams] of streamsByTab) obj[String(tabId)] = streams;
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: obj });
  } catch {
    /* ignore */
  }
}

async function persistJobs(): Promise<void> {
  const obj: Record<string, PersistedJob> = {};
  for (const [k, v] of jobsById) obj[k] = v;
  try {
    await chrome.storage.session.set({ [JOBS_KEY]: obj });
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

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => tabs[0])
    .catch(() => undefined);
}

/* ------------------------------ context menus ----------------------------- */
//
// Static items live for the SW lifetime. Dynamic items (one per detected
// stream on the active tab) are rebuilt whenever the active tab's stream
// list changes; we track their ids so we only remove what we created.

const MENU_PARENT = "msg.parent";
const MENU_VIDEO = "msg.download-video";
const MENU_AUDIO = "msg.download-audio";
const MENU_LINK = "msg.download-link";
const MENU_IMAGE = "msg.download-image";
const MENU_EMPTY = "msg.empty";
const DYNAMIC_PREFIX = "msg.dyn.";

const dynamicIds: Set<string> = new Set();

chrome.runtime.onInstalled.addListener(() => {
  void rebuildStaticMenus();
});
chrome.runtime.onStartup.addListener(() => {
  void rebuildStaticMenus();
});

async function rebuildStaticMenus(): Promise<void> {
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(resolve));
  dynamicIds.clear();
  chrome.contextMenus.create({
    id: MENU_PARENT,
    title: "Media Stream Grabber",
    contexts: ["page", "frame", "video", "audio", "image", "link"],
  });
  chrome.contextMenus.create({
    id: MENU_VIDEO,
    parentId: MENU_PARENT,
    title: "Download this video element",
    contexts: ["video"],
  });
  chrome.contextMenus.create({
    id: MENU_AUDIO,
    parentId: MENU_PARENT,
    title: "Download this audio element",
    contexts: ["audio"],
  });
  chrome.contextMenus.create({
    id: MENU_IMAGE,
    parentId: MENU_PARENT,
    title: "Download this image",
    contexts: ["image"],
  });
  chrome.contextMenus.create({
    id: MENU_LINK,
    parentId: MENU_PARENT,
    title: "Download link target",
    contexts: ["link"],
  });
  // Placeholder shown when nothing has been sniffed yet on the current tab.
  chrome.contextMenus.create({
    id: MENU_EMPTY,
    parentId: MENU_PARENT,
    title: "No streams sniffed on this tab",
    enabled: false,
    contexts: ["page", "frame", "video", "audio"],
  });
  // Repopulate dynamic items for the currently active tab.
  void scheduleDynamicRebuild();
}

function scheduleDynamicRebuild(): void {
  if (menuRebuildTimer) clearTimeout(menuRebuildTimer);
  menuRebuildTimer = setTimeout(() => {
    menuRebuildTimer = null;
    void rebuildDynamicMenus();
  }, 80);
}

async function rebuildDynamicMenus(): Promise<void> {
  await restoreFromSession();
  const tab = await activeTab();
  const list = tab?.id != null ? streamsByTab.get(tab.id) ?? [] : [];

  // Wipe previous dynamic items.
  for (const id of dynamicIds) {
    await new Promise<void>((resolve) =>
      chrome.contextMenus.remove(id, () => {
        // ignore "no such id" errors during races
        void chrome.runtime.lastError;
        resolve();
      }),
    );
  }
  dynamicIds.clear();

  // Toggle the empty placeholder vs a real list.
  await new Promise<void>((resolve) =>
    chrome.contextMenus.update(
      MENU_EMPTY,
      { visible: list.length === 0 },
      () => {
        void chrome.runtime.lastError;
        resolve();
      },
    ),
  );

  if (!list.length) return;

  // Cap dynamic items so the right-click menu doesn't span the screen.
  const visible = list.slice(0, 12);
  for (const s of visible) {
    const id = `${DYNAMIC_PREFIX}${s.id}`;
    const title = formatMenuTitle(s);
    try {
      chrome.contextMenus.create({
        id,
        parentId: MENU_PARENT,
        title,
        contexts: ["page", "frame", "video", "audio", "image", "link"],
      });
      dynamicIds.add(id);
    } catch {
      // duplicate id (race) — fine
    }
  }
  if (list.length > visible.length) {
    const id = `${DYNAMIC_PREFIX}__more`;
    chrome.contextMenus.create({
      id,
      parentId: MENU_PARENT,
      title: `… ${list.length - visible.length} more — open the popup`,
      contexts: ["page", "frame", "video", "audio"],
      enabled: false,
    });
    dynamicIds.add(id);
  }
}

function formatMenuTitle(s: DetectedStream): string {
  const parts: string[] = [];
  parts.push(s.kind.toUpperCase());
  if (s.suggestedName) parts.push(s.suggestedName);
  const url = s.url.length > 60 ? `${s.url.slice(0, 57)}…` : s.url;
  return `${parts.join(" · ")}  ${url}`;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void handleContextClick(info, tab);
});

async function handleContextClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  await restoreFromSession();
  const id = String(info.menuItemId);

  // Dynamic stream item: download it directly without going through the popup.
  if (id.startsWith(DYNAMIC_PREFIX) && id !== `${DYNAMIC_PREFIX}__more`) {
    const streamId = id.slice(DYNAMIC_PREFIX.length);
    const list = tab?.id != null ? streamsByTab.get(tab.id) ?? [] : [];
    const stream = list.find((s) => s.id === streamId);
    if (!stream) return notify("Stream is no longer available — reload and try again.");
    await startDownload(stream, `ctx-${Date.now().toString(36)}`, {});
    return;
  }

  switch (id) {
    case MENU_VIDEO:
    case MENU_AUDIO:
    case MENU_IMAGE: {
      const url = info.srcUrl;
      // blob: / MSE players expose a blob URL that is unusable cross-context.
      // Fall back to whatever was sniffed for this exact frame.
      if (!url || url.startsWith("blob:")) {
        return downloadBestForFrame(tab?.id, info.frameId);
      }
      // HLS playlist → merge pipeline.
      if (/\.m3u8(\?|$|#)/i.test(url)) {
        const stream: DetectedStream = {
          id: hashId(url),
          url,
          kind: "hls",
          suggestedName: suggestedFilename(url, "hls", tab?.title),
          detectedAt: Date.now(),
          pageUrl: info.pageUrl,
          pageTitle: tab?.title,
          frameId: info.frameId,
        };
        await startDownload(stream, `ctx-${Date.now().toString(36)}`, {});
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
  }
}

async function downloadBestForFrame(
  tabId: number | undefined,
  frameId: number | undefined,
): Promise<void> {
  if (tabId == null) return;
  const list = streamsByTab.get(tabId) ?? [];
  if (!list.length) return notify("No streams sniffed on this tab yet — start playing the video first.");
  // Prefer a stream from the same frame the user clicked in.
  const fromFrame = frameId != null ? list.filter((s) => s.frameId === frameId) : [];
  const candidates = fromFrame.length ? fromFrame : list;
  const KIND_PRIORITY: Record<DetectedStream["kind"], number> = {
    hls: 0,
    dash: 1,
    mp4: 2,
    audio: 3,
    image: 4,
    other: 5,
  };
  candidates.sort(
    (a, b) =>
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.detectedAt - a.detectedAt,
  );
  await startDownload(candidates[0], `ctx-${Date.now().toString(36)}`, {});
}

function notify(message: string): void {
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

const headerLookup = (
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string | undefined => {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) return h.value;
  }
  return undefined;
};

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method !== "GET") return;
    const referer = headerLookup(details.requestHeaders, "referer");
    if (!referer) return;
    // Stash the referer keyed by URL so the sniffer can attach it when the
    // headers come back. webRequest doesn't give us request headers and
    // response headers in the same callback.
    pendingReferers.set(details.url, { referer, frameId: details.frameId });
    if (pendingReferers.size > 256) {
      // Bound the map — first entry is oldest in insertion order.
      const oldest = pendingReferers.keys().next().value;
      if (oldest) pendingReferers.delete(oldest);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

const pendingReferers = new Map<string, { referer: string; frameId: number }>();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method !== "GET") return;

    const contentType = headerLookup(details.responseHeaders, "content-type");
    const kind = classify(details.url, contentType);
    if (!kind) return;

    // Skip the noisy stuff: HLS sub-segments (.ts) and image thumbnails.
    if (kind === "mp4" && /\.ts(\?|$|#)/i.test(details.url)) return;
    if (kind === "image") return;

    void restoreFromSession().then(async () => {
      const refererEntry = pendingReferers.get(details.url);
      pendingReferers.delete(details.url);
      const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
      const stream: DetectedStream = {
        id: hashId(details.url),
        url: details.url,
        kind,
        suggestedName: suggestedFilename(details.url, kind, tab?.title),
        mimeType: contentType,
        detectedAt: Date.now(),
        pageUrl: tab?.url,
        pageTitle: tab?.title,
        frameId: details.frameId,
        referer: refererEntry?.referer,
      };
      const added = addStream(details.tabId, stream);
      if (!added) return;
      void persistStreams();
      void chrome.runtime
        .sendMessage({
          type: "streams:added",
          tabId: details.tabId,
          stream,
          target: "sw",
        } satisfies RuntimeMessage)
        .catch(() => {
          /* popup not open — fine */
        });
      void updateBadge(details.tabId);
      scheduleDynamicRebuild();
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "loading" && change.url) {
    streamsByTab.delete(tabId);
    void persistStreams();
    void updateBadge(tabId);
    scheduleDynamicRebuild();
    return;
  }
  if (change.title || change.url) {
    const list = streamsByTab.get(tabId);
    if (!list?.length) return;
    for (const s of list) {
      if (!s.pageUrl && tab.url) s.pageUrl = tab.url;
      if (!s.pageTitle && tab.title) s.pageTitle = tab.title;
    }
    void persistStreams();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
  void persistStreams();
  scheduleDynamicRebuild();
});

chrome.tabs.onActivated.addListener(() => {
  scheduleDynamicRebuild();
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

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
  if (msg.target && msg.target !== "sw") return false;

  void (async () => {
    await restoreFromSession();

    switch (msg.type) {
      case "streams:list": {
        const streams = streamsByTab.get(msg.tabId) ?? [];
        sendResponse({
          type: "streams:list:result",
          streams,
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "streams:clear": {
        streamsByTab.delete(msg.tabId);
        await persistStreams();
        await updateBadge(msg.tabId);
        scheduleDynamicRebuild();
        sendResponse({ ok: true });
        return;
      }
      case "streams:report-direct": {
        // Content script picked up a <video src=...> the SW couldn't see.
        // Fill in the bits only the SW knows.
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no tab" });
          return;
        }
        if (msg.url.startsWith("blob:") || msg.url.startsWith("data:")) {
          sendResponse({ ok: true, ignored: true });
          return;
        }
        const kind = classify(msg.url) ?? "other";
        if (kind === "image" || kind === "other") {
          sendResponse({ ok: true, ignored: true });
          return;
        }
        const stream: DetectedStream = {
          id: hashId(msg.url),
          url: msg.url,
          kind,
          suggestedName: suggestedFilename(msg.url, kind, msg.pageTitle),
          pageUrl: msg.pageUrl,
          pageTitle: msg.pageTitle,
          frameId: sender.frameId,
          detectedAt: Date.now(),
        };
        if (addStream(tabId, stream)) {
          await persistStreams();
          void updateBadge(tabId);
          scheduleDynamicRebuild();
          void chrome.runtime
            .sendMessage({
              type: "streams:added",
              tabId,
              stream,
              target: "sw",
            } satisfies RuntimeMessage)
            .catch(() => {
              /* popup not open */
            });
        }
        sendResponse({ ok: true });
        return;
      }
      case "download:probe": {
        try {
          await ensureOffscreen();
          const fwd: RuntimeMessage = { ...msg, target: "offscreen" };
          await chrome.runtime.sendMessage(fwd);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "download:start": {
        try {
          await startDownload(msg.stream, msg.jobId, msg.selection ?? {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "download:cancel": {
        await chrome.runtime
          .sendMessage({ ...msg, target: "offscreen" } satisfies RuntimeMessage)
          .catch(() => {
            /* offscreen not alive */
          });
        await dropJob(msg.jobId);
        sendResponse({ ok: true });
        return;
      }
      case "download:progress": {
        // Forwarded from offscreen → re-broadcast to popup, GC finished jobs.
        if (msg.payload.phase === "done" || msg.payload.phase === "error") {
          await dropJob(msg.payload.jobId);
        }
        return;
      }
      default:
        sendResponse({ ok: false, error: "unhandled" });
    }
  })();
  return true; // async sendResponse
});

/* ------------------------------ download flow ----------------------------- */

async function startDownload(
  stream: DetectedStream,
  jobId: string,
  selection: { variantUri?: string; audioId?: string },
): Promise<void> {
  await restoreFromSession();

  if (stream.kind === "mp4" || stream.kind === "audio") {
    // Direct download — let the browser handle it. Inject a temporary Referer
    // rule if we observed one for this URL during sniffing.
    await applyRefererRule(jobId, stream);
    try {
      await chrome.downloads.download({
        url: stream.url,
        filename: stream.suggestedName,
        saveAs: true,
      });
    } finally {
      await removeRefererRule(jobId);
    }
    void chrome.runtime.sendMessage({
      type: "download:progress",
      payload: { jobId, phase: "done", ratio: 1 },
      target: "sw",
    } satisfies RuntimeMessage);
    return;
  }

  // HLS / DASH — needs the offscreen document for ffmpeg.wasm.
  const job: PersistedJob = {
    jobId,
    stream,
    selection,
    startedAt: Date.now(),
  };
  jobsById.set(jobId, job);
  await persistJobs();
  await applyRefererRule(jobId, stream);
  await ensureOffscreen();
  await chrome.runtime
    .sendMessage({ type: "download:start", stream, jobId, selection, target: "offscreen" } satisfies RuntimeMessage)
    .catch(() => {
      /* offscreen will retry on its onMessage handler installation */
    });
}

async function dropJob(jobId: string): Promise<void> {
  jobsById.delete(jobId);
  await persistJobs();
  await removeRefererRule(jobId);
}

/* --------------------------- DNR Referer rules ---------------------------- */
//
// Many CDNs serve segments only when Referer matches the original page. The
// offscreen `fetch` runs from a chrome-extension:// origin which the CDN
// doesn't trust. We register a session-scoped DNR rule that rewrites Referer
// for non-tab requests to the segment host while a download is running.

function ruleIdFor(jobId: string): number {
  // Stable numeric id derived from jobId — fits in DNR's int32 id space.
  let h = 0;
  for (let i = 0; i < jobId.length; i++) {
    h = (h * 31 + jobId.charCodeAt(i)) | 0;
  }
  return DNR_RULE_BASE + (Math.abs(h) % 100000);
}

async function applyRefererRule(jobId: string, stream: DetectedStream): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const referer = stream.referer || stream.pageUrl;
  if (!referer) return;
  let host: string;
  try {
    host = new URL(stream.url).host;
  } catch {
    return;
  }
  const id = ruleIdFor(jobId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 1,
          condition: {
            requestDomains: [host],
            tabIds: [chrome.tabs.TAB_ID_NONE ?? -1],
            resourceTypes: [
              "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
              "media" as chrome.declarativeNetRequest.ResourceType,
              "other" as chrome.declarativeNetRequest.ResourceType,
            ],
          },
          action: {
            type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              {
                header: "referer",
                operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
                value: referer,
              },
              {
                header: "origin",
                operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
                value: new URL(referer).origin,
              },
            ],
          },
        },
      ],
    });
  } catch {
    /* DNR may reject on some Chrome versions — ignore, download still tries */
  }
}

async function removeRefererRule(jobId: string): Promise<void> {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  const id = ruleIdFor(jobId);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {
    /* ignore */
  }
}

/* ----------------------------- offscreen lifecycle ------------------------ */

const OFFSCREEN_PATH = "src/offscreen/index.html";

async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS" as chrome.offscreen.Reason],
    justification: "Run ffmpeg.wasm to merge HLS/DASH segments into a playable file.",
  });
}

// Resume any persisted jobs as soon as the SW wakes up.
void (async () => {
  await restoreFromSession();
  if (jobsById.size) {
    await ensureOffscreen();
    for (const job of jobsById.values()) {
      await chrome.runtime
        .sendMessage({
          type: "download:start",
          stream: job.stream,
          jobId: job.jobId,
          selection: job.selection,
          target: "offscreen",
        } satisfies RuntimeMessage)
        .catch(() => {
          /* offscreen will be ready momentarily */
        });
    }
  }
})();
