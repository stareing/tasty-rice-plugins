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
  FocusContext,
  ManagedJobRecord,
  PersistedJob,
  RuntimeMessage,
} from "@/lib/types";
import {
  classify,
  hashId,
  suggestedFilename,
  suggestedFilenameAsync,
} from "@/lib/streamClassify";
import { scoreStream } from "@/lib/streamScore";
import { installBridge, installCrawler, installProxyFetch } from "./injected";

const STREAM_SEGMENT_RE = /\.(ts|m4s|cmfv|cmfa|mp4v|mp4a)(\?|$|#)/i;
/**
 * URL fingerprints for the major DRM license servers. Matched against the
 * outgoing webRequest URL — when one fires inside an armed tab we mark the
 * tab as DRM-protected so the popup can warn before a wasted download.
 *
 * The patterns favour false negatives over false positives: a `.../license/`
 * suffix on a non-DRM resource is rare, but a "license"-shaped path on an
 * unrelated CDN endpoint shouldn't poison the flag. Where we can be more
 * specific (Widevine "proxy-license", PlayReady ".../Rights/", FairPlay
 * "FPSCertificate"), we are.
 */
const LICENSE_URL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Widevine", re: /\/widevine(?:\/|[?_-])/i },
  { name: "Widevine", re: /\/(?:proxy-)?license(?:[?/]|$)/i },
  { name: "PlayReady", re: /\/playready(?:\/|[?_-])/i },
  { name: "PlayReady", re: /\/Rights(?:Manager)?(?:\.svc|\/)/i },
  { name: "FairPlay", re: /\/fairplay(?:\/|[?_-])/i },
  { name: "FairPlay", re: /\/FPSCertificate/i },
  { name: "DRM", re: /\/keyserver(?:\/|[?_-])/i },
  { name: "DRM", re: /\/(?:get)?license[s]?(?:\?|$)/i },
];

function detectLicenseUrl(url: string): string | undefined {
  for (const p of LICENSE_URL_PATTERNS) {
    if (p.re.test(url)) return p.name;
  }
  return undefined;
}
/**
 * Patterns that mark an `.m3u8` URL as an ABR child playlist. Any match
 * means we'll fold the URL onto its parent master via `canonicalHlsMasterUrl`.
 *
 *   - `_1080w` / `_video` / `-audio` / `_v1` / `_a2` — common TV/CDN naming
 *   - `_720p` / `-1080p_4500k` — height / bitrate suffixes
 *   - `index_3` / `chunklist_w012345.m3u8` — Wowza / Akamai conventions
 *   - `track_2.m3u8` — DASH-derived HLS exports
 *
 * Everything is collapsed back to `<basename>.m3u8` for the dedupe key only;
 * `stream.url` keeps the actual sniffed URL so downloads still target what
 * the CDN actually serves.
 */
const HLS_CHILD_PLAYLIST_RE =
  /(_(?:\d+w|\d+p|audio|video|v\d+|a\d+|\d+k|\d+kbps|hd|sd)|-(?:video|audio|av|\d+p|\d+kbps?)\d*|index_\w+|chunklist[_-]?\w*|track[_-]?\d+|playlist[_-]?\w*)\.m3u8(\?|$|#)/i;
const MAX_STREAMS_PER_TAB = 64;
const SESSION_KEY = "msg.streamsByTab.v1";
const JOBS_KEY = "msg.jobs.v1";
const ARMED_KEY = "msg.armedUntil.v1";
const ARMED_FRAME_KEY = "msg.armedFrame.v1";
const PAGE_SNIFF_KEY = "msg.pageSniff.v1";
const FOCUS_KEY = "msg.focusByTab.v1";
const DNR_RULE_BASE = 9000;
const CAPTURE_WINDOW_MS = 30_000;
const PAGE_SNIFF_ARM_MS = 365 * 24 * 60 * 60 * 1000;
const OFFSCREEN_READY_TIMEOUT_MS = 4_000;

let streamsByTab: Map<number, DetectedStream[]> = new Map();
let jobsById: Map<string, PersistedJob> = new Map();
let armedUntil: Map<number, number> = new Map();
/**
 * When set, the armed window for that tab only accepts requests originating
 * from the named frame. Driven by the right-click "download this video
 * element" path so a page with multiple players / ad iframes / preload
 * streams doesn't pollute the picker with sibling frames' traffic. Absent
 * entry = tab-wide capture (the page-level "Capture next 30s" affordance).
 */
let armedFrame: Map<number, number> = new Map();
/**
 * Tabs in long-lived page-sniff mode. Distinct from `armedUntil` — page-sniff
 * has no auto-expiry, ignores frame focus, and is the only mode that admits
 * `kind === "image"` results. Toggled exclusively from the popup; tab
 * navigation / close clears the entry so the privacy contract still holds
 * (no silent observation of pages the user hasn't opted in to).
 */
let pageSniffTabs: Set<number> = new Set();
/**
 * Latest right-click focus per tab — feeds `scoreStream()` so sniffed rows
 * that originate from the same frame, soon after the click, on the same
 * host as the clicked element rank above tab-wide noise. Cleared on
 * navigation / tab close in lockstep with `streamsByTab`.
 */
let focusByTab: Map<number, FocusContext> = new Map();
/**
 * Per-tab DRM / MSE detection cache. Populated by the page-side crawler's
 * `streams:report-flag` events; applied to existing streams immediately and
 * to streams that arrive afterwards inside `admitStream`. Cleared on
 * navigation / tab close in lockstep with the other tab-bound state.
 */
const tabFlags: Map<number, { drm?: boolean; mse?: boolean }> = new Map();

/**
 * Tabs that have MSE capture armed. Per-session chunk-stats accumulate as
 * `mse:chunk` messages flow in; the popup queries `mse:status:query` for
 * a snapshot.
 */
const mseCaptureTabs = new Set<number>();
interface MseSessionStats {
  sessionId: string;
  tabId: number;
  mimeType?: string;
  bytes: number;
  chunks: number;
  startedAt: number;
}
const mseSessions = new Map<string, MseSessionStats>();
let restored = false;
let offscreenReady = false;
let offscreenReadyWaiters: Array<() => void> = [];

async function restoreFromSession(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const data = await chrome.storage.session.get([
      SESSION_KEY,
      JOBS_KEY,
      ARMED_KEY,
      ARMED_FRAME_KEY,
      PAGE_SNIFF_KEY,
      FOCUS_KEY,
    ]);
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
    const rawArmedFrame = data[ARMED_FRAME_KEY] as
      | Record<string, number>
      | undefined;
    if (rawArmedFrame) {
      armedFrame = new Map(
        Object.entries(rawArmedFrame)
          .map(([k, v]) => [Number(k), Number(v)] as [number, number])
          .filter(([tabId]) => armedUntil.has(tabId)),
      );
    }
    const rawPageSniff = data[PAGE_SNIFF_KEY] as number[] | undefined;
    if (Array.isArray(rawPageSniff)) {
      pageSniffTabs = new Set(rawPageSniff.filter((n) => Number.isFinite(n)));
    }
    const rawFocus = data[FOCUS_KEY] as Record<string, FocusContext> | undefined;
    if (rawFocus) {
      focusByTab = new Map(
        Object.entries(rawFocus)
          .map(([k, v]) => [Number(k), v] as [number, FocusContext])
          .filter(([tabId]) => Number.isFinite(tabId)),
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
  const frameObj: Record<string, number> = {};
  for (const [k, v] of armedFrame) frameObj[String(k)] = v;
  try {
    await chrome.storage.session.set({
      [ARMED_KEY]: obj,
      [ARMED_FRAME_KEY]: frameObj,
    });
  } catch {
    /* ignore */
  }
}

async function persistPageSniff(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [PAGE_SNIFF_KEY]: Array.from(pageSniffTabs),
    });
  } catch {
    /* ignore */
  }
}

async function persistFocus(): Promise<void> {
  const obj: Record<string, FocusContext> = {};
  for (const [k, v] of focusByTab) obj[String(k)] = v;
  try {
    await chrome.storage.session.set({ [FOCUS_KEY]: obj });
  } catch {
    /* ignore */
  }
}

/**
 * Record a right-click focus for `tabId`. The focus snapshot feeds
 * `scoreStream()` for ~5 minutes — long enough that streams sniffed after
 * the user actually starts playback still benefit, short enough that an
 * abandoned click doesn't keep biasing future sniffs forever. Persisted
 * to session storage so an SW evict doesn't lose the bias mid-arm.
 */
function recordFocus(focus: FocusContext): void {
  focusByTab.set(focus.tabId, focus);
  void persistFocus();
}

function snapshotMseSessions(tabId: number): {
  sessionId: string;
  mimeType?: string;
  bytes: number;
  chunks: number;
}[] {
  const out: { sessionId: string; mimeType?: string; bytes: number; chunks: number }[] = [];
  for (const stat of mseSessions.values()) {
    if (stat.tabId !== tabId) continue;
    out.push({
      sessionId: stat.sessionId,
      mimeType: stat.mimeType,
      bytes: stat.bytes,
      chunks: stat.chunks,
    });
  }
  return out;
}

function isBurstArmed(tabId: number): boolean {
  const until = armedUntil.get(tabId);
  if (!until) return false;
  if (until < Date.now()) {
    armedUntil.delete(tabId);
    armedFrame.delete(tabId);
    void persistArmed();
    return false;
  }
  return true;
}

/**
 * True only if the request belongs to a frame the user actually opted in
 * to capture. Page-sniff is always tab-wide; burst arm honours the focused
 * frame from `armedFrame` (set by right-click on a specific <video>).
 */
function isCapturingFrame(
  tabId: number,
  frameId: number | undefined,
): boolean {
  if (pageSniffTabs.has(tabId)) return true;
  if (!isBurstArmed(tabId)) return false;
  const focused = armedFrame.get(tabId);
  if (focused === undefined) return true;
  return frameId === focused;
}

function armCapture(tabId: number, frameId?: number): number {
  const until = Date.now() + CAPTURE_WINDOW_MS;
  armedUntil.set(tabId, until);
  if (typeof frameId === "number") {
    armedFrame.set(tabId, frameId);
  } else {
    // Re-arming without a frameId means "broaden capture again" — explicitly
    // drop any prior focused-frame restriction so a follow-up tab-wide arm
    // doesn't keep filtering against a frame the user no longer cares about.
    armedFrame.delete(tabId);
  }
  void persistArmed();
  void injectPageCrawler(tabId, until, frameId);
  setTimeout(() => {
    if (armedUntil.get(tabId) === until) {
      armedUntil.delete(tabId);
      armedFrame.delete(tabId);
      void persistArmed();
      void updateBadge(tabId);
    }
  }, CAPTURE_WINDOW_MS + 250);
  return until;
}

/**
 * Inject the page-side crawler into every frame of the armed tab. The
 * MAIN-world hook surfaces media URLs that webRequest can't see — typically
 * URLs the player constructs at runtime from JSON config — by hooking
 * fetch/XHR. The ISOLATED-world bridge forwards results to the SW with a
 * per-arm nonce so untrusted page scripts can't spoof reports.
 *
 * Both scripts are idempotent and gated on `armedUntil`; re-arming the same
 * tab just bumps the timestamp instead of stacking hooks. Injection failures
 * (chrome:// pages, the Web Store, extension pages) are swallowed — the
 * webRequest sniffer still works on its own.
 */
async function injectPageCrawler(
  tabId: number,
  until: number,
  frameId?: number,
  mseCapture?: boolean,
): Promise<void> {
  if (!chrome.scripting?.executeScript) return;
  const nonce = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  // Focused arm: pin the injection to the right-clicked frame so we don't
  // hook unrelated iframes (ad players, preload widgets, sibling videos).
  // Tab-wide arm: hit every frame so any in-page player surfaces its URLs.
  const target: chrome.scripting.InjectionTarget =
    typeof frameId === "number"
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED" as chrome.scripting.ExecutionWorld,
      func: installBridge,
      args: [{ nonce }],
      injectImmediately: true,
    });
  } catch {
    /* page refused isolated injection — bridge unavailable, abort */
    return;
  }
  try {
    // mseCapture defaults to whatever the SW currently tracks for this
    // tab. Callers that don't pass it (the burst-arm path, page-sniff
    // toggle) inherit the existing flag instead of accidentally turning
    // capture off because they didn't specify.
    const captureFlag =
      typeof mseCapture === "boolean" ? mseCapture : mseCaptureTabs.has(tabId);
    await chrome.scripting.executeScript({
      target,
      world: "MAIN" as chrome.scripting.ExecutionWorld,
      func: installCrawler,
      args: [{ nonce, armedUntil: until, mseCapture: captureFlag }],
      injectImmediately: true,
    });
  } catch {
    /* MAIN-world injection refused — webRequest sniffer carries on */
  }
  // The proxy-fetch endpoint shares the same nonce as the crawler; it
  // simply enables the page to refetch on the offscreen's behalf when a
  // CDN rejects the offscreen's direct request. Install only after the
  // bridge above succeeded — without the ISOLATED-world bridge the proxy
  // hook can't be reached.
  try {
    await chrome.scripting.executeScript({
      target,
      world: "MAIN" as chrome.scripting.ExecutionWorld,
      func: installProxyFetch,
      args: [{ nonce }],
      injectImmediately: true,
    });
  } catch {
    /* MAIN-world injection refused — webRequest sniffer carries on */
  }
}

function addStream(tabId: number, stream: DetectedStream): boolean {
  const list = streamsByTab.get(tabId) ?? [];
  if (list.some((s) => s.id === stream.id)) return false;
  const next = [stream, ...list].slice(0, MAX_STREAMS_PER_TAB);
  streamsByTab.set(tabId, next);
  return true;
}

/**
 * Single point where a sniffed URL becomes a `DetectedStream`. Both the
 * webRequest sniffer and the page-side crawler funnel through here so
 * dedupe (`streamGroupKey` + `hashId`), persistence, badge update, and
 * thumbnail enqueue all behave identically regardless of source.
 *
 * Returns the stored stream (existing or newly-added) for the rare caller
 * that wants to react further; returns undefined when the URL was rejected
 * (segment, image, classify-miss, blob:/data:).
 */
async function admitStream(args: {
  tabId: number;
  url: string;
  kind?: DetectedStream["kind"];
  contentType?: string;
  pageUrl?: string;
  pageTitle?: string;
  frameId?: number;
  referer?: string;
  source?: DetectedStream["source"];
}): Promise<DetectedStream | undefined> {
  const { tabId, url } = args;
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return undefined;
  if (isStreamSegment(url)) return undefined;
  const kind = args.kind ?? classify(url, args.contentType);
  if (!kind || kind === "other") return undefined;
  // Images only flow through here when the tab is in long-lived page-sniff
  // mode — the webRequest gate already enforces that, but admitStream is
  // the second authority because the page-side crawler can also hand us
  // arbitrary URLs and we want one consistent answer to "is this admissible".
  if (kind === "image" && !pageSniffTabs.has(tabId)) return undefined;

  // Don't rewrite the URL at sniff time — `canonicalHlsMasterUrl` is a
  // pattern guess, and rewriting to a path that doesn't exist on the
  // CDN broke downloads. Keep `stream.url` as the actual sniffed URL;
  // use a canonical *key* purely for dedupe so multiple child variants
  // of the same master collapse into one row.
  const dedupeKey = streamGroupKey(kind, url);
  const flags = tabFlags.get(tabId);
  const stream: DetectedStream = {
    id: hashId(dedupeKey),
    url,
    kind,
    // User-defined site rules can rewrite the filename hint; the await
    // here costs one storage roundtrip per *new* stream, cached after
    // the first lookup. Built-in rules + page-title path remain fully
    // synchronous through `suggestedFilename`.
    suggestedName: await suggestedFilenameAsync(
      url,
      kind,
      args.pageTitle,
      args.pageUrl,
    ),
    mimeType: args.contentType,
    detectedAt: Date.now(),
    pageUrl: args.pageUrl,
    pageTitle: args.pageTitle,
    frameId: args.frameId,
    referer: args.referer,
    drmDetected: flags?.drm,
    mseDetected: flags?.mse,
    source: args.source ?? "web-request",
  };
  // Score after the rest of the record is built so all fields the scorer
  // reads (kind, source, frameId, drmDetected, mseDetected, …) are settled.
  stream.score = scoreStream(stream, focusByTab.get(tabId), Date.now());
  const added = addStream(tabId, stream);
  if (!added) return undefined;
  void persistStreams();
  void chrome.runtime
    .sendMessage({
      type: "streams:added",
      tabId,
      stream,
      target: "sw",
    } satisfies RuntimeMessage)
    .catch(() => {
      /* popup closed — fine */
    });
  void updateBadge(tabId);
  enqueueThumb(tabId, stream);
  return stream;
}

/**
 * Mark every existing stream on `tabId` as DRM-protected and rebroadcast the
 * patched rows so an open popup updates without a fresh sniff. Mirrors the
 * EME-hook path that came from `streams:report-flag`.
 */
async function applyDrmFlagToTab(tabId: number, family: string): Promise<void> {
  const list = streamsByTab.get(tabId);
  if (!list) return;
  let mutated = false;
  const focus = focusByTab.get(tabId);
  const now = Date.now();
  const updated = list.map((s) => {
    if (s.drmDetected) return s;
    mutated = true;
    // DRM penalty changes the score — recompute alongside the flag flip
    // so the popup re-sorts the row in the same broadcast.
    const patched: DetectedStream = { ...s, drmDetected: true };
    patched.score = scoreStream(patched, focus, now);
    return patched;
  });
  if (!mutated) return;
  streamsByTab.set(tabId, updated);
  await persistStreams();
  for (const s of updated) {
    void chrome.runtime
      .sendMessage({
        type: "streams:added",
        tabId,
        stream: s,
        target: "sw",
      } satisfies RuntimeMessage)
      .catch(() => {
        /* popup closed — fine */
      });
  }
  // Cosmetic: family is the licence-server family ("Widevine", …); not
  // surfaced in UI yet but kept available so the eventual probe path can
  // cross-check against the per-rendition DRM hints from the manifest.
  void family;
}

/** Update an existing stream in place; returns the merged record or undefined. */
function patchStream(
  tabId: number,
  streamId: string,
  patch: Partial<DetectedStream>,
): DetectedStream | undefined {
  const list = streamsByTab.get(tabId);
  if (!list) return undefined;
  const idx = list.findIndex((s) => s.id === streamId);
  if (idx < 0) return undefined;
  const merged = { ...list[idx], ...patch };
  const next = [...list];
  next[idx] = merged;
  streamsByTab.set(tabId, next);
  return merged;
}

/* ----------------------------- thumb queue ----------------------------- */
//
// Thumbnails are the actual first-frame extracted by ffmpeg from the media
// stream — no DOM scraping, so the popup can never display the page's stock
// `og:image` and pretend it's a video preview. Extraction is sent to the
// offscreen document on a serial queue: ffmpeg.wasm is single-threaded in
// our build, and a burst of parallel `runThumbnail` calls would just queue
// inside MEMFS. One concurrent job → predictable ordering, no MEMFS races.

interface ThumbJob {
  tabId: number;
  streamId: string;
  stream: DetectedStream;
}

const thumbQueue: ThumbJob[] = [];
const thumbQueued = new Set<string>();
let thumbBusy = false;

function enqueueThumb(tabId: number, stream: DetectedStream): void {
  if (stream.thumbDataUrl) return;
  if (stream.kind !== "hls" && stream.kind !== "dash" && stream.kind !== "mp4" && stream.kind !== "audio") {
    return;
  }
  if (thumbQueued.has(stream.id)) return;
  thumbQueued.add(stream.id);
  thumbQueue.push({ tabId, streamId: stream.id, stream });
  void runThumbQueue();
}

async function runThumbQueue(): Promise<void> {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQueue.length) {
      const job = thumbQueue.shift()!;
      // Drop the dedupe gate before processing — if extraction fails the user
      // can still click "Preview" to retry, and that path needs to re-enqueue.
      thumbQueued.delete(job.streamId);
      try {
        await ensureOffscreen();
        await waitForOffscreenReady();
        await chrome.runtime.sendMessage({
          type: "thumb:request",
          streamId: job.streamId,
          stream: job.stream,
          target: "offscreen",
        } satisfies RuntimeMessage).catch(() => {
          /* offscreen will reply via thumb:result; if it's gone the next
             enqueue recreates it */
        });
        await waitForThumbResult(job.streamId);
      } catch {
        /* keep draining the queue even if a single extraction throws */
      }
    }
  } finally {
    thumbBusy = false;
  }
}

const thumbWaiters = new Map<string, () => void>();
const THUMB_RESULT_TIMEOUT_MS = 30_000;

function waitForThumbResult(streamId: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      thumbWaiters.delete(streamId);
      resolve();
    };
    thumbWaiters.set(streamId, finish);
    setTimeout(finish, THUMB_RESULT_TIMEOUT_MS);
  });
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

/**
 * Dedupes concurrent rebuilds. `onInstalled` and `onStartup` both fire on a
 * fresh-profile + freshly-installed extension, and their `await removeAll`
 * resolves in lockstep — without a lock, both then call `create` with the
 * same ids and the second batch fails with "Cannot create item with
 * duplicate id". A single in-flight promise lets the second caller observe
 * the first's completion instead of racing the create calls.
 */
let menuRebuildInflight: Promise<void> | null = null;

function rebuildStaticMenus(): Promise<void> {
  if (menuRebuildInflight) return menuRebuildInflight;
  menuRebuildInflight = (async () => {
    try {
      await new Promise<void>((resolve) => chrome.contextMenus.removeAll(() => {
        // Discard removeAll's lastError — happens on cold install when
        // the menu set is already empty. We're about to recreate them.
        void chrome.runtime.lastError;
        resolve();
      }));
      createStaticMenus();
    } finally {
      menuRebuildInflight = null;
    }
  })();
  return menuRebuildInflight;
}

function createStaticMenus(): void {
  // Each create's duplicate-id failure is delivered via chrome.runtime.lastError
  // in the callback; without a callback it logs "Unchecked runtime.lastError".
  // The dedup lock above already prevents the race in normal flow — this just
  // silences the residual case where Chrome retains menus from the previous SW
  // life on extension reload.
  const swallow = () => { void chrome.runtime.lastError; };
  chrome.contextMenus.create({
    id: MENU_PARENT,
    title: "Media Stream Grabber",
    contexts: ["page", "frame", "video", "audio", "image", "link"],
  }, swallow);
  chrome.contextMenus.create({
    id: MENU_ARM,
    parentId: MENU_PARENT,
    title: `Capture next ${CAPTURE_WINDOW_MS / 1000}s of media on this tab`,
    contexts: ["page", "frame", "video", "audio"],
  }, swallow);
  chrome.contextMenus.create({
    id: MENU_VIDEO,
    parentId: MENU_PARENT,
    title: "Download this video element",
    contexts: ["video"],
  }, swallow);
  chrome.contextMenus.create({
    id: MENU_AUDIO,
    parentId: MENU_PARENT,
    title: "Download this audio element",
    contexts: ["audio"],
  }, swallow);
  chrome.contextMenus.create({
    id: MENU_IMAGE,
    parentId: MENU_PARENT,
    title: "Download this image",
    contexts: ["image"],
  }, swallow);
  chrome.contextMenus.create({
    id: MENU_LINK,
    parentId: MENU_PARENT,
    title: "Download link target",
    contexts: ["link"],
  }, swallow);
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

  // Focus snapshot feeds scoreStream(): which frame, when, what element.
  // Recorded for every menu item before the per-id branches, so even the
  // bare arm path biases subsequent sniffs toward the clicked frame.
  if (tabId != null) {
    const tag: FocusContext["mediaTag"] =
      id === MENU_VIDEO
        ? "video"
        : id === MENU_AUDIO
          ? "audio"
          : id === MENU_IMAGE
            ? "image"
            : id === MENU_LINK
              ? "link"
              : "page";
    const rawSrc = id === MENU_LINK ? info.linkUrl : info.srcUrl;
    recordFocus({
      tabId,
      frameId: info.frameId,
      clickedAt: Date.now(),
      srcUrl:
        rawSrc && !rawSrc.startsWith("blob:") && !rawSrc.startsWith("data:")
          ? rawSrc
          : undefined,
      mediaTag: tag,
    });
  }

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
      // blob:/MSE players can't be downloaded by URL — they're MSE buffers
      // with no canonical source. Arm the sniffer so the underlying manifest
      // fetches become visible; the user can then download the real stream
      // from the popup. We do NOT inject a captureStream/MediaRecorder UI
      // here — that's screen recording, not downloading the source.
      if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
        if (tabId != null) {
          // Focused arm: only this frame's traffic counts. Page right-click
          // on a specific <video>/<audio> means "I want THIS player," not
          // "I want everything on the page." The webRequest sniffer and
          // page-side crawler both honour this scope via isArmedForFrame.
          armCapture(tabId, info.frameId);
          void updateBadge(tabId);
        }
        notify(
          `Sniffer armed for ${CAPTURE_WINDOW_MS / 1000}s — start (or restart) playback to capture the underlying stream.`,
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
          suggestedName: suggestedFilename(url, kind, tab?.title, tab?.url ?? info.pageUrl),
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
      const linkKind = classify(info.linkUrl);
      if (!linkKind || linkKind === "other") {
        if (tabId != null) {
          armCapture(tabId);
          void updateBadge(tabId);
        }
        notify(
          `That link points to a page, not a media file — sniffer armed for ${CAPTURE_WINDOW_MS / 1000}s. Play the target video now.`,
        );
        return;
      }
      if (linkKind === "hls" || linkKind === "dash") {
        const stream: DetectedStream = {
          id: hashId(info.linkUrl),
          url: info.linkUrl,
          kind: linkKind,
          suggestedName: suggestedFilename(info.linkUrl, linkKind, tab?.title, tab?.url ?? info.pageUrl),
          detectedAt: Date.now(),
          pageUrl: info.pageUrl,
          pageTitle: tab?.title,
          frameId: info.frameId,
        };
        await startDownload(stream, `ctx-${Date.now().toString(36)}`, {});
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
    if (!isCapturingFrame(details.tabId, details.frameId)) return;
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
    if (!isCapturingFrame(details.tabId, details.frameId)) return;

    // License-server fingerprint — fires on the same network round-trip the
    // EME hook would observe in the page, but webRequest sees the URL even
    // when the page-side hook is absent (extension installed mid-playback,
    // injection refused on some host). Apply the flag tab-wide and patch
    // every existing stream so the popup row updates without re-sniffing.
    const licenseFamily = detectLicenseUrl(details.url);
    if (licenseFamily) {
      const cur = tabFlags.get(details.tabId) || {};
      if (!cur.drm) {
        tabFlags.set(details.tabId, { ...cur, drm: true });
        void applyDrmFlagToTab(details.tabId, licenseFamily);
      }
    }

    if (details.method !== "GET") return;
    const contentType = headerLookup(details.responseHeaders, "content-type");
    const kind = classify(details.url, contentType);
    if (!kind) return;
    if (isStreamSegment(details.url)) return;
    // Images surface only in long-lived page-sniff mode. The 30s burst arm
    // is for "capture the underlying stream of this <video>" — pulling in
    // every <img> on the page would just bury the actual media.
    if (kind === "image" && !pageSniffTabs.has(details.tabId)) return;

    void restoreFromSession().then(async () => {
      const refererEntry = pendingReferers.get(details.url);
      pendingReferers.delete(details.url);
      const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
      await admitStream({
        tabId: details.tabId,
        url: details.url,
        kind,
        contentType,
        pageUrl: tab?.url,
        pageTitle: tab?.title,
        frameId: details.frameId,
        referer: refererEntry?.referer,
      });
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && change.url) {
    streamsByTab.delete(tabId);
    armedUntil.delete(tabId);
    armedFrame.delete(tabId);
    tabFlags.delete(tabId);
    focusByTab.delete(tabId);
    mseCaptureTabs.delete(tabId);
    for (const [sid, stat] of mseSessions) {
      if (stat.tabId === tabId) mseSessions.delete(sid);
    }
    // Page-sniff is also bound to the page the user opted in to. A
    // navigation switches to a different page, so explicit re-opt-in is
    // required — keeps the privacy contract intact.
    const wasSniffing = pageSniffTabs.delete(tabId);
    void persistStreams();
    void persistArmed();
    void persistFocus();
    if (wasSniffing) void persistPageSniff();
    void updateBadge(tabId);
    if (wasSniffing) {
      void chrome.runtime
        .sendMessage({
          type: "pagesniff:status",
          tabId,
          active: false,
          target: "sw",
        } satisfies RuntimeMessage)
        .catch(() => {});
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  streamsByTab.delete(tabId);
  armedUntil.delete(tabId);
  armedFrame.delete(tabId);
  pageSniffTabs.delete(tabId);
  tabFlags.delete(tabId);
  focusByTab.delete(tabId);
  mseCaptureTabs.delete(tabId);
  for (const [sid, stat] of mseSessions) {
    if (stat.tabId === tabId) mseSessions.delete(sid);
  }
  void persistStreams();
  void persistArmed();
  void persistFocus();
  void persistPageSniff();
});

async function updateBadge(tabId: number): Promise<void> {
  const count = streamsByTab.get(tabId)?.length ?? 0;
  const sniffing = pageSniffTabs.has(tabId);
  const armed = isBurstArmed(tabId);
  try {
    await chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? String(count) : sniffing || armed ? "•" : "",
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: sniffing ? "#16a34a" : armed ? "#dc2626" : "#2563eb",
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
      case "streams:report-direct": {
        // The bridge already validated the per-arm nonce inside the page;
        // we still re-check `isCapturingFrame` because the page can outlive
        // the burst window AND a focused arm should reject sibling-frame
        // reports. tab/frame come from `sender` only (per CLAUDE.md —
        // content scripts must not invent their own ids).
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no-tab" });
          return;
        }
        if (!isCapturingFrame(tabId, sender.frameId)) {
          sendResponse({ ok: false, error: "not-armed" });
          return;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        await admitStream({
          tabId,
          url: msg.url,
          contentType: msg.contentType,
          pageUrl: msg.pageUrl ?? tab?.url,
          pageTitle: tab?.title,
          frameId: sender.frameId,
          source: "page-crawler",
        });
        sendResponse({ ok: true });
        return;
      }
      case "streams:report-flag": {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: "no-tab" });
          return;
        }
        // Same gate as `streams:report-direct` — only honour reports from
        // tabs the user has actively opted in to (burst arm or page-sniff).
        // The bridge nonce already authenticated the source page, but we
        // re-check here because the page can outlive the burst window.
        if (!isCapturingFrame(tabId, sender.frameId)) {
          sendResponse({ ok: false, error: "not-armed" });
          return;
        }
        const cur = tabFlags.get(tabId) || {};
        const next = { ...cur, [msg.flag]: true };
        tabFlags.set(tabId, next);
        // Patch every existing stream on the tab so the popup row shows
        // the badge without waiting for a new sniff. Re-broadcast each
        // patched record via `streams:added` so an open popup updates
        // in place (the listener already merges by id).
        const list = streamsByTab.get(tabId);
        if (list) {
          let mutated = false;
          const focus = focusByTab.get(tabId);
          const now = Date.now();
          const updated = list.map((s) => {
            const patched: DetectedStream = {
              ...s,
              drmDetected: msg.flag === "drm" ? true : s.drmDetected,
              mseDetected: msg.flag === "mse" ? true : s.mseDetected,
            };
            if (
              patched.drmDetected !== s.drmDetected ||
              patched.mseDetected !== s.mseDetected
            ) {
              mutated = true;
              patched.score = scoreStream(patched, focus, now);
            }
            return patched;
          });
          if (mutated) {
            streamsByTab.set(tabId, updated);
            await persistStreams();
            for (const s of updated) {
              void chrome.runtime
                .sendMessage({
                  type: "streams:added",
                  tabId,
                  stream: s,
                  target: "sw",
                } satisfies RuntimeMessage)
                .catch(() => {
                  /* popup closed — fine */
                });
            }
          }
        }
        sendResponse({ ok: true });
        return;
      }
      case "streams:clear": {
        streamsByTab.delete(msg.tabId);
        tabFlags.delete(msg.tabId);
        focusByTab.delete(msg.tabId);
        await persistStreams();
        await persistFocus();
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
      case "pagesniff:query": {
        sendResponse({
          type: "pagesniff:status",
          tabId: msg.tabId,
          active: pageSniffTabs.has(msg.tabId),
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "pagesniff:toggle": {
        if (msg.enable) {
          pageSniffTabs.add(msg.tabId);
          await persistPageSniff();
          // Inject the page-side crawler tab-wide; the long-lived expiry
          // mirrors the SW state. The crawler hook is idempotent so a
          // tab that was previously burst-armed just gets its expiry
          // bumped instead of stacking hooks.
          void injectPageCrawler(
            msg.tabId,
            Date.now() + PAGE_SNIFF_ARM_MS,
          );
        } else {
          pageSniffTabs.delete(msg.tabId);
          await persistPageSniff();
        }
        await updateBadge(msg.tabId);
        sendResponse({
          type: "pagesniff:status",
          tabId: msg.tabId,
          active: pageSniffTabs.has(msg.tabId),
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
          await startDownload(
            msg.stream,
            msg.jobId,
            msg.selection ?? {},
            sender.tab?.id,
          );
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "proxy:fetch": {
        // Offscreen → SW. Find the originating tab, forward to its bridge,
        // relay the page-fetch reply back. The bridge replies via
        // `sendResponse`, which arrives here as the awaited resolve value.
        try {
          const job = jobsById.get(msg.jobId);
          const tabId = job?.tabId;
          if (tabId == null) {
            sendResponse({ ok: false, status: 0, error: "no-origin-tab" });
            return;
          }
          const reply = await new Promise<{ ok: boolean; status: number; bytes?: Uint8Array; error?: string }>(
            (resolve) => {
              try {
                chrome.tabs.sendMessage(
                  tabId,
                  {
                    target: "page-proxy",
                    type: "page-proxy:fetch",
                    url: msg.url,
                    method: msg.method ?? "GET",
                    headers: msg.headers ?? {},
                  },
                  (resp) => {
                    const lastErr = chrome.runtime.lastError;
                    if (lastErr) {
                      resolve({ ok: false, status: 0, error: lastErr.message || "no-bridge" });
                      return;
                    }
                    resolve(resp ?? { ok: false, status: 0, error: "no-response" });
                  },
                );
              } catch (err) {
                resolve({ ok: false, status: 0, error: (err as Error).message });
              }
            },
          );
          sendResponse(reply);
        } catch (err) {
          sendResponse({ ok: false, status: 0, error: (err as Error).message });
        }
        return;
      }
      case "mse:chunk": {
        // Page → SW relay. The bridge already validated the per-arm nonce
        // in the page; we trust the SW boundary to authenticate the sender
        // by extension-id (chrome ensures `sender.id === chrome.runtime.id`).
        // Reject chunks from tabs that aren't actively capturing — the page
        // hook can race a disarm in flight.
        const senderTab = sender.tab?.id;
        if (senderTab == null || !mseCaptureTabs.has(senderTab)) {
          sendResponse({ ok: false, error: "not-capturing" });
          return;
        }
        // Tally per-session stats so the popup can show "captured 142 MB
        // across 3 chunks" without subscribing to every chunk.
        const stats = mseSessions.get(msg.sessionId) ?? {
          sessionId: msg.sessionId,
          tabId: senderTab,
          mimeType: msg.mimeType,
          bytes: 0,
          chunks: 0,
          startedAt: Date.now(),
        };
        stats.bytes += msg.bytes?.byteLength ?? 0;
        stats.chunks += 1;
        if (!stats.mimeType && msg.mimeType) stats.mimeType = msg.mimeType;
        mseSessions.set(msg.sessionId, stats);

        try {
          await ensureOffscreen();
          await waitForOffscreenReady();
          await chrome.runtime
            .sendMessage({ ...msg, target: "offscreen" } satisfies RuntimeMessage)
            .catch(() => {
              /* offscreen will rehydrate next message */
            });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "mse:finish": {
        try {
          await ensureOffscreen();
          await waitForOffscreenReady();
          await chrome.runtime
            .sendMessage({ ...msg, target: "offscreen" } satisfies RuntimeMessage)
            .catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "mse:arm": {
        if (msg.enable) {
          mseCaptureTabs.add(msg.tabId);
          // Re-inject crawler with mseCapture=true. The hook is idempotent
          // — only the flag flips; existing hooks stay in place.
          void injectPageCrawler(
            msg.tabId,
            Date.now() + PAGE_SNIFF_ARM_MS,
            undefined,
            true,
          );
        } else {
          mseCaptureTabs.delete(msg.tabId);
          // Drop accumulated session stats for the tab — the offscreen's
          // OPFS files outlive this and are cleaned up by the orphan sweep.
          for (const [sid, stat] of mseSessions) {
            if (stat.tabId === msg.tabId) mseSessions.delete(sid);
          }
          // Re-inject with mseCapture=false to silence further chunk forwards.
          void injectPageCrawler(
            msg.tabId,
            Date.now() + PAGE_SNIFF_ARM_MS,
            undefined,
            false,
          );
        }
        sendResponse({
          type: "mse:status",
          tabId: msg.tabId,
          active: mseCaptureTabs.has(msg.tabId),
          sessions: snapshotMseSessions(msg.tabId),
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "mse:status:query": {
        sendResponse({
          type: "mse:status",
          tabId: msg.tabId,
          active: mseCaptureTabs.has(msg.tabId),
          sessions: snapshotMseSessions(msg.tabId),
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "mse:save": {
        try {
          await ensureOffscreen();
          await waitForOffscreenReady();
          await chrome.runtime
            .sendMessage({
              type: "mse:finish",
              sessionId: msg.sessionId,
              suggestedName: msg.suggestedName,
              saveAs: true,
              target: "offscreen",
            } satisfies RuntimeMessage)
            .catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "jobs:list": {
        sendResponse({
          type: "jobs:list:result",
          jobs: await readManagedJobs(),
          target: "sw",
        } satisfies RuntimeMessage);
        return;
      }
      case "jobs:remove": {
        await removeManagedJob(msg.jobId);
        sendResponse({ ok: true });
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
      case "thumb:request": {
        try {
          await ensureOffscreen();
          await waitForOffscreenReady();
          await chrome.runtime
            .sendMessage({ ...msg, target: "offscreen" } satisfies RuntimeMessage)
            .catch(() => {
              /* offscreen will reply via thumb:result */
            });
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: (err as Error).message });
        }
        return;
      }
      case "thumb:result": {
        // Cache on the stream record so a re-opened popup gets it from
        // `streams:list` without re-extracting. The popup is a sibling
        // listener to the SW for `target: "sw"` messages and will already
        // see this broadcast directly — no need to re-emit.
        for (const [tabId, list] of streamsByTab) {
          if (!list.some((s) => s.id === msg.streamId)) continue;
          if (msg.dataUrl) {
            patchStream(tabId, msg.streamId, { thumbDataUrl: msg.dataUrl });
            await persistStreams();
          }
          break;
        }
        // Release the queued enqueueThumb waiter (success or error both
        // unblock the next job — the queue isn't a retry policy).
        const waiter = thumbWaiters.get(msg.streamId);
        if (waiter) waiter();
        return;
      }
      case "download:progress": {
        // Mirror progress into the managed-job log so the standalone
        // manager page reflects state without subscribing to the live
        // broadcast itself.
        const p = msg.payload;
        await patchManagedJob(p.jobId, {
          phase: p.phase,
          ratio: p.ratio,
          segmentsDone: p.segmentsDone,
          segmentsTotal: p.segmentsTotal,
          retries: p.retries,
          message: p.message,
          error: p.phase === "error" ? p.error : undefined,
          finishedAt:
            p.phase === "done" || p.phase === "error" ? Date.now() : undefined,
        });
        if (p.phase === "done" || p.phase === "error") {
          await dropJob(p.jobId);
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
  originTabId?: number,
): Promise<void> {
  await restoreFromSession();

  if (stream.kind === "mp4" || stream.kind === "audio" || stream.kind === "image" || stream.kind === "text") {
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
    tabId: originTabId,
  };
  jobsById.set(jobId, job);
  await persistJobs();
  await recordManagedJob(job);
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

/* ----------------- managed-job log (downloads manager) ----------------- */
//
// `chrome.storage.session` clears on browser restart — fine for in-flight
// state but the user's *history* of downloads should outlive a restart.
// `chrome.storage.local` keeps the manager-page log durable. Cap entries
// so a long-running install doesn't bloat indefinitely; oldest are trimmed.

const MANAGER_LOG_KEY = "msg.managerLog.v1";
const MANAGER_LOG_MAX = 200;

async function readManagedJobs(): Promise<ManagedJobRecord[]> {
  try {
    const data = await chrome.storage.local.get(MANAGER_LOG_KEY);
    const raw = data[MANAGER_LOG_KEY] as ManagedJobRecord[] | undefined;
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function writeManagedJobs(jobs: ManagedJobRecord[]): Promise<void> {
  try {
    const trimmed = jobs.slice(-MANAGER_LOG_MAX);
    await chrome.storage.local.set({ [MANAGER_LOG_KEY]: trimmed });
  } catch {
    /* storage.local quota exceeded — non-fatal */
  }
}

async function recordManagedJob(job: PersistedJob): Promise<void> {
  const all = await readManagedJobs();
  if (all.some((r) => r.jobId === job.jobId)) return;
  all.push({
    jobId: job.jobId,
    stream: job.stream,
    selection: job.selection,
    startedAt: job.startedAt,
    phase: "fetching-playlist",
    ratio: 0,
  });
  await writeManagedJobs(all);
}

async function patchManagedJob(
  jobId: string,
  patch: Partial<ManagedJobRecord>,
): Promise<void> {
  const all = await readManagedJobs();
  const idx = all.findIndex((r) => r.jobId === jobId);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  await writeManagedJobs(all);
}

async function removeManagedJob(jobId: string): Promise<void> {
  const all = await readManagedJobs();
  const next = all.filter((r) => r.jobId !== jobId);
  if (next.length !== all.length) await writeManagedJobs(next);
}

function isStreamSegment(url: string): boolean {
  return STREAM_SEGMENT_RE.test(url.split("#")[0]);
}

// Same shape as HLS_CHILD_PLAYLIST_RE without the trailing `\.m3u8(?…)` —
// used by the rewrite below. Kept in sync manually because regex composition
// across flags is awkward in JS.
const HLS_CHILD_SUFFIX_RE =
  /(_(?:\d+w|\d+p|audio|video|v\d+|a\d+|\d+k|\d+kbps|hd|sd)|-(?:video|audio|av|\d+p|\d+kbps?)\d*|index_\w+|chunklist[_-]?\w*|track[_-]?\d+|playlist[_-]?\w*)\.m3u8/i;

function canonicalHlsMasterUrl(url: string): string {
  if (!HLS_CHILD_PLAYLIST_RE.test(url)) return url;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(HLS_CHILD_SUFFIX_RE, ".m3u8");
    return u.toString();
  } catch {
    return url.replace(
      /(_(?:\d+w|\d+p|audio|video|v\d+|a\d+|\d+k|\d+kbps|hd|sd)|-(?:video|audio|av|\d+p|\d+kbps?)\d*|index_\w+|chunklist[_-]?\w*|track[_-]?\d+|playlist[_-]?\w*)\.m3u8(\?|$|#)/i,
      ".m3u8$2",
    );
  }
}

/**
 * Query-param keys that a CDN typically uses to encode a single rendition's
 * quality/bandwidth — different values for `resolution` / `quality` / `br`
 * almost always point at the *same logical stream*, just at different ABR
 * tiers. Stripping them before computing the dedupe key collapses those
 * variants onto one row even when the URL pathname is identical.
 *
 * Conservative list: only params widely documented as quality knobs across
 * Akamai, Cloudflare Stream, Bilibili, AWS Elemental, and the major OTT
 * stacks. Token-shaped params (`token`, `signature`, `expires`) are
 * deliberately not in this list — they don't change between renditions on
 * the same job, so leaving them in the key is harmless and removes the
 * risk of collapsing unrelated streams that happen to share a path.
 */
const ABR_QUERY_PARAMS = [
  "resolution",
  "quality",
  "vq",
  "br",
  "bitrate",
  "bw",
  "bandwidth",
  "level",
  "profile",
  "format",
  "codec",
  "codecs",
  "fmt",
  "hd",
  "size",
  "rate",
];

/**
 * Strip ABR-quality query params and return a normalised pathname+query
 * suitable for a dedupe key. Keeps non-quality params (auth tokens, sig,
 * expires) so unrelated streams that happen to share a path stay distinct.
 */
function normaliseQueryForGroupKey(u: URL): string {
  const drop = new Set(ABR_QUERY_PARAMS);
  const remaining: [string, string][] = [];
  // Iterate snapshot — mutating searchParams while iterating drops entries.
  u.searchParams.forEach((value, key) => {
    if (drop.has(key.toLowerCase())) return;
    remaining.push([key, value]);
  });
  remaining.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = remaining.map(([k, v]) => `${k}=${v}`).join("&");
  return qs ? `${u.pathname}?${qs}` : u.pathname;
}

/**
 * Best-effort dedupe key. Two URLs that map to the same key are treated as
 * the same stream — used to collapse the multiple child playlists a master
 * fans out to during ABR. The key includes the canonical-master pathname
 * when the regex recognises it, plus the surviving non-quality query params
 * (so different videos that happen to share a `manifest.m3u8` path but
 * carry different `vid=` tokens stay distinct). The key is **not** the
 * stream URL — we still keep the original sniffed URL on the record,
 * because the canonical-master path can 404 on some CDNs.
 */
function streamGroupKey(kind: DetectedStream["kind"], streamUrl: string): string {
  if (kind !== "hls") {
    try {
      const u = new URL(streamUrl);
      return `${kind}:${u.origin}${normaliseQueryForGroupKey(u)}`;
    } catch {
      return `${kind}:${streamUrl}`;
    }
  }
  try {
    const u = new URL(canonicalHlsMasterUrl(streamUrl));
    return `hls:${u.origin}${normaliseQueryForGroupKey(u)}`;
  } catch {
    return `hls:${canonicalHlsMasterUrl(streamUrl).split("?")[0].split("#")[0]}`;
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
  // Some CDNs reject segment fetches that smell like a cross-context request:
  // a stale Cookie from the page context, or an Authorization header bound to
  // a different origin. Stripping them isn't security-relevant (these requests
  // run inside a session-scoped DNR rule already, on a TAB_ID_NONE worker
  // origin — they were never authenticated to begin with), but removing them
  // makes header negotiation predictable and avoids 401/403 from the CDN.
  const setOp = "set" as chrome.declarativeNetRequest.HeaderOperation;
  const removeOp = "remove" as chrome.declarativeNetRequest.HeaderOperation;
  // The headers below either leak identity (cookie/authorization) or signal
  // "this is an extension fetch" to the CDN (Sec-Fetch-*) — both can trip
  // origin-checked CDN rules and produce 403s on segments. Date is removed
  // for cosmetic hygiene; the browser will set a fresh one regardless.
  const requestHeaders = [
    { header: "referer", operation: setOp, value: referer },
    { header: "origin", operation: setOp, value: new URL(referer).origin },
    { header: "cookie", operation: removeOp },
    { header: "authorization", operation: removeOp },
    { header: "date", operation: removeOp },
    { header: "sec-fetch-site", operation: removeOp },
    { header: "sec-fetch-mode", operation: removeOp },
    { header: "sec-fetch-dest", operation: removeOp },
  ];
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
            requestHeaders,
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

/**
 * Remove session rules in our id range whose owning job is no longer alive.
 *
 * A SW crash, browser kill, or any path that bypassed `dropJob` (extension
 * disable while a job runs, OOM in offscreen, etc.) leaks the corresponding
 * session rule. Orphans linger for the rest of the browser session, count
 * against the per-extension session-rule cap, and silently rewrite headers
 * for unrelated future requests on the same domain. We sweep once per SW
 * wake — `restoreFromSession` has just rebuilt `jobsById`, so anything
 * outside that set is by definition orphaned.
 */
async function sweepOrphanedReferRules(): Promise<void> {
  if (!chrome.declarativeNetRequest?.getSessionRules) return;
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const live = new Set<number>();
    for (const jobId of jobsById.keys()) live.add(ruleIdFor(jobId));
    const stale = existing
      .map((r) => r.id)
      .filter((id) => id >= DNR_RULE_BASE && id < DNR_RULE_BASE + 100_000 && !live.has(id));
    if (!stale.length) return;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale });
  } catch {
    /* DNR may reject the query on certain Chrome versions — non-fatal */
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
  await sweepOrphanedReferRules();
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
