/**
 * Background service worker.
 *
 * Sniffer policy: NO global capture by default. The webRequest listeners are
 * registered (MV3 forces top-level registration) but every callback bails
 * unless the request's tab is in an "armed" window — armed windows are
 * created exclusively by the right-click menu. This is the privacy contract:
 * the extension does not silently observe pages the user has not opted in to.
 *
 * The right-click menu offers two affordances:
 *   1. Direct: "Download this video / audio / image / link target". When the
 *      element exposes a usable srcUrl/linkUrl, we download it (or queue an
 *      HLS/DASH job) without ever arming the sniffer.
 *   2. Arm: "Capture next 30s of media on this tab". Used when the player
 *      lives behind a blob:/MSE source — we open a short capture window so
 *      manifest fetches in that one tab become visible.
 *
 * The cross-context bus uses the `target: "sw" | "offscreen"` discriminator
 * (see CLAUDE.md). The SW also waits for an `offscreen:ready` handshake
 * before forwarding messages, so freshly-created offscreen documents never
 * see the "Receiving end does not exist" race.
 */

import type {
  DetectedStream,
  PersistedJob,
  RuntimeMessage,
} from "@/lib/types";
import { classify, hashId, suggestedFilename } from "@/lib/streamClassify";

const STREAM_SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|mp4v|mp4a)(\?|$|#)/i;
const HLS_CHILD_PLAYLIST_RE = /_(?:\d+w|audio)\.m3u8(\?|$|#)/i;
const MAX_STREAMS_PER_TAB = 64;
const SESSION_KEY = "msg.streamsByTab.v1";
const JOBS_KEY = "msg.jobs.v1";
const ARMED_KEY = "msg.armedUntil.v1";
const DNR_RULE_BASE = 9000;
const CAPTURE_WINDOW_MS = 30_000;
const OFFSCREEN_READY_TIMEOUT_MS = 4_000;

let streamsByTab: Map<number, DetectedStream[]> = new Map();
let jobsById: Map<string, PersistedJob> = new Map();
let armedUntil: Map<number, number> = new Map();
let restored = false;
let offscreenReady = false;
let offscreenReadyWaiters: Array<() => void> = [];

async function restoreFromSession(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const data = await chrome.storage.session.get([SESSION_KEY, JOBS_KEY, ARMED_KEY]);
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
    const rawArmed = data[ARMED_KEY] as Record<string, number> | undefined;
    if (rawArmed) {
      const now = Date.now();
      armedUntil = new Map(
        Object.entries(rawArmed)
          .map(([k, v]) => [Number(k), Number(v)] as [number, number])
          .filter(([, until]) => until > now),
      );
    }
  } catch {
    /* session storage unavailable — non-fatal */
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

async function persistArmed(): Promise<void> {
  const obj: Record<string, number> = {};
  for (const [k, v] of armedUntil) obj[String(k)] = v;
  try {
    await chrome.storage.session.set({ [ARMED_KEY]: obj });
  } catch {
    /* ignore */
  }
}

function isArmed(tabId: number): boolean {
  const until = armedUntil.get(tabId);
  if (!until) return false;
  if (until < Date.now()) {
    armedUntil.delete(tabId);
    void persistArmed();
    return false;
  }
  return true;
}

function armCapture(tabId: number): number {
  const until = Date.now() + CAPTURE_WINDOW_MS;
  armedUntil.set(tabId, until);
  void persistArmed();
  setTimeout(() => {
    if (armedUntil.get(tabId) === until) {
      armedUntil.delete(tabId);
      void persistArmed();
      void updateBadge(tabId);
    }
  }, CAPTURE_WINDOW_MS + 250);
  return until;
}

function addStream(tabId: number, stream: DetectedStream): boolean {
  const list = streamsByTab.get(tabId) ?? [];
  if (list.some((s) => s.id === stream.id)) return false;
  const next = [stream, ...list].slice(0, MAX_STREAMS_PER_TAB);
  streamsByTab.set(tabId, next);
  return true;
}

/* ------------------------------ context menus ----------------------------- */

const MENU_PARENT = "msg.parent";
const MENU_ARM = "msg.arm";
const MENU_VIDEO = "msg.download-video";
const MENU_AUDIO = "msg.download-audio";
const MENU_LINK = "msg.download-link";
const MENU_IMAGE = "msg.download-image";

chrome.runtime.onInstalled.addListener(() => {
  void rebuildStaticMenus();
});
chrome.runtime.onStartup.addListener(() => {
  void rebuildStaticMenus();
});

async function rebuildStaticMenus(): Promise<void> {
  await new Promise<void>((resolve) => chrome.contextMenus.removeAll(resolve));
  chrome.contextMenus.create({
    id: MENU_PARENT,
    title: "Media Stream Grabber",
    contexts: ["page", "frame", "video", "audio", "image", "link"],
  });
  chrome.contextMenus.create({
    id: MENU_ARM,
    parentId: MENU_PARENT,
    title: `Capture next ${CAPTURE_WINDOW_MS / 1000}s of media on this tab`,
    contexts: ["page", "frame", "video", "audio"],
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
  const tabId = tab?.id;

  switch (id) {
    case MENU_ARM: {
      if (tabId == null) return;
      const until = armCapture(tabId);
      void updateBadge(tabId);
      void chrome.runtime
        .sendMessage({ type: "capture:status", tabId, armedUntil: until, target: "sw" } satisfies RuntimeMessage)
        .catch(() => {
          /* popup closed — fine */
        });
      notify(
        `Capturing media on this tab for ${CAPTURE_WINDOW_MS / 1000}s — start playback now.`,
      );
      return;
    }
    case MENU_VIDEO:
    case MENU_AUDIO:
    case MENU_IMAGE: {
      const url = info.srcUrl;
      // blob:/MSE players can't be downloaded by URL; arm the capture window
      // so the player's manifest fetches become visible.
      if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
        if (tabId != null) {
          streamsByTab.delete(tabId);
          void persistStreams();
          armCapture(tabId);
          void updateBadge(tabId);
        }
        notify(
          "This element uses an in-memory source — capture window armed for 30s. Restart playback to surface the manifest.",
        );
        return;
      }
      if (isStreamSegment(url)) {
        notify("This is a media segment, not a standalone playable file. Capture the HLS/DASH manifest instead.");
        return;
      }
      // HLS / DASH playlists go through the merge pipeline; everything else
      // is a direct browser download.
      if (/\.m3u8(\?|$|#)/i.test(url) || /\.mpd(\?|$|#)/i.test(url)) {
        const kind: DetectedStream["kind"] = /\.mpd(\?|$|#)/i.test(url) ? "dash" : "hls";
        const stream: DetectedStream = {
          id: hashId(url),
          url,
          kind,
          suggestedName: suggestedFilename(url, kind, tab?.title),
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
      if (isStreamSegment(info.linkUrl)) {
        notify("This is a media segment, not a standalone playable file. Capture the HLS/DASH manifest instead.");
        return;
      }
      try {
        await chrome.downloads.download({ url: info.linkUrl, saveAs: true });
      } catch (err) {
        notify(`Download failed: ${(err as Error).message}`);
      }
      return;
    }
  }
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
//
// Listeners are always registered, but every callback returns immediately
// unless the request's tab has been armed via the right-click menu. The
// "armed" set is the only thing standing between us and the previous
// behaviour of capturing every media URL across every site.

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

const pendingReferers = new Map<string, { referer: string; frameId: number }>();

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method !== "GET") return;
    if (!isArmed(details.tabId)) return;
    const referer = headerLookup(details.requestHeaders, "referer");
    if (!referer) return;
    pendingReferers.set(details.url, { referer, frameId: details.frameId });
    if (pendingReferers.size > 256) {
      const oldest = pendingReferers.keys().next().value;
      if (oldest) pendingReferers.delete(oldest);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"],
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.method !== "GET") return;
    if (!isArmed(details.tabId)) return;

    const contentType = headerLookup(details.responseHeaders, "content-type");
    const kind = classify(details.url, contentType);
    if (!kind) return;
    if (isStreamSegment(details.url)) return;
    if (kind === "image") return;

    void restoreFromSession().then(async () => {
      const refererEntry = pendingReferers.get(details.url);
      pendingReferers.delete(details.url);
      const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
      const streamUrl = kind === "hls" ? canonicalHlsMasterUrl(details.url) : details.url;
      const stream: DetectedStream = {
        id: hashId(streamUrl),
        url: streamUrl,
        kind,
        suggestedName: suggestedFilename(streamUrl, kind, tab?.title),
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
          /* popup closed — fine */
        });
      void updateBadge(details.tabId);
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && change.url) {
    streamsByTab.delete(tabId);
    armedUntil.delete(tabId);
    void persistStreams();
    void persistArmed();
    void updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
  armedUntil.delete(tabId);
  void persistStreams();
  void persistArmed();
});

async function updateBadge(tabId: number): Promise<void> {
  const count = streamsByTab.get(tabId)?.length ?? 0;
  const armed = isArmed(tabId);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? String(count) : armed ? "•" : "",
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: armed ? "#dc2626" : "#2563eb",
    });
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
      case "offscreen:ready": {
        offscreenReady = true;
        const waiters = offscreenReadyWaiters;
        offscreenReadyWaiters = [];
        for (const w of waiters) w();
        sendResponse({ ok: true });
        return;
      }
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
        sendResponse({ ok: true });
        return;
      }
      case "capture:arm": {
        const until = armCapture(msg.tabId);
        await updateBadge(msg.tabId);
        sendResponse({
          type: "capture:status",
          tabId: msg.tabId,
          armedUntil: until,
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "download:probe": {
        try {
          await ensureOffscreen();
          await waitForOffscreenReady();
          await chrome.runtime
            .sendMessage({ ...msg, target: "offscreen" } satisfies RuntimeMessage)
            .catch(() => {
              /* offscreen has the listener; if Chrome still races, the user
                 will retry from the popup. */
            });
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
            /* offscreen not alive — nothing to cancel */
          });
        await dropJob(msg.jobId);
        sendResponse({ ok: true });
        return;
      }
      case "downloads:save": {
        try {
          await chrome.downloads.download({
            url: msg.url,
            filename: msg.filename,
            saveAs: msg.saveAs,
          });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "download:progress": {
        if (msg.payload.phase === "done" || msg.payload.phase === "error") {
          await dropJob(msg.payload.jobId);
        }
        return;
      }
      default:
        sendResponse({ ok: false, error: "unhandled" });
        // Surface unrelated suppressed senders so we don't silently lose
        // events — e.g. a stale content script from a prior install.
        if (sender.id && sender.id !== chrome.runtime.id) return;
    }
  })();
  return true;
});

/* ------------------------------ download flow ----------------------------- */

async function startDownload(
  stream: DetectedStream,
  jobId: string,
  selection: { variantUri?: string; audioId?: string; subtitleId?: string },
): Promise<void> {
  await restoreFromSession();

  if (stream.kind === "mp4" || stream.kind === "audio") {
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
    void chrome.runtime
      .sendMessage({
        type: "download:progress",
        payload: { jobId, phase: "done", ratio: 1 },
        target: "sw",
      } satisfies RuntimeMessage)
      .catch(() => {});
    return;
  }

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
  await waitForOffscreenReady();
  await chrome.runtime
    .sendMessage({
      type: "download:start",
      stream,
      jobId,
      selection,
      target: "offscreen",
    } satisfies RuntimeMessage)
    .catch(() => {
      /* the offscreen handler installs at module top — if this still races,
         the resume-on-wake loop at the bottom of this file picks it up. */
    });
}

async function dropJob(jobId: string): Promise<void> {
  jobsById.delete(jobId);
  await persistJobs();
  await removeRefererRule(jobId);
}

function isStreamSegment(url: string): boolean {
  return STREAM_SEGMENT_RE.test(url.split("#")[0]);
}

function canonicalHlsMasterUrl(url: string): string {
  if (!HLS_CHILD_PLAYLIST_RE.test(url)) return url;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/_(?:\d+w|audio)\.m3u8$/i, ".m3u8");
    return u.toString();
  } catch {
    return url.replace(/_(?:\d+w|audio)\.m3u8(\?|$|#)/i, ".m3u8$1");
  }
}

/* --------------------------- DNR Referer rules ---------------------------- */

function ruleIdFor(jobId: string): number {
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
  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS" as chrome.offscreen.Reason],
    justification: "Run ffmpeg.wasm to merge HLS/DASH segments into a playable file.",
  });
}

/**
 * `chrome.offscreen.createDocument` resolves once the document exists, but
 * the offscreen module's onMessage listener is not installed until its top-
 * level script runs. Forwarding before that race produces "Could not
 * establish connection. Receiving end does not exist." We block until the
 * offscreen sends `offscreen:ready`, with a short timeout so a stuck
 * offscreen doesn't deadlock the SW.
 */
function waitForOffscreenReady(): Promise<void> {
  if (offscreenReady) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    offscreenReadyWaiters.push(finish);
    setTimeout(finish, OFFSCREEN_READY_TIMEOUT_MS);
  });
}

void (async () => {
  await restoreFromSession();
  if (jobsById.size) {
    await ensureOffscreen();
    await waitForOffscreenReady();
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
