export type StreamKind = "hls" | "dash" | "mp4" | "audio" | "image" | "text" | "other";

/**
 * Media-shape metadata captured at sniff time. All fields are optional —
 * the page-side hook only fills what the DOM exposes (img.naturalWidth,
 * audio.duration), and URL-only sniffs (webRequest path) leave most empty.
 *
 * `lossless`/`isIcon` are URL/extension heuristics, not authoritative — they
 * exist purely to bias `scoreStream`, not to gate downloads. A FLAC tagged as
 * `lossless: true` is still ranked above a 128 kbps mp3, but a misidentified
 * flag changes ranking, never visibility.
 */
export interface StreamMetadata {
  /** Image natural width (px). Set by the page-side `<img>` probe only. */
  width?: number;
  height?: number;
  /** Audio duration in seconds, from HTMLMediaElement.duration. */
  durationSec?: number;
  /** URL/extension classified as a lossless audio container. */
  lossless?: boolean;
  /** URL pattern classified as an icon / favicon / sprite. */
  isIcon?: boolean;
}

export interface DetectedStream {
  /** Stable id derived from URL — used for dedupe + UI keys. */
  id: string;
  url: string;
  kind: StreamKind;
  /** Best-effort filename guess, no extension forcing. */
  suggestedName: string;
  /** Container/codec hint from Content-Type when available. */
  mimeType?: string;
  /** Bytes if known (only for completed direct downloads). */
  sizeBytes?: number;
  /** Page that triggered the request. */
  pageUrl?: string;
  pageTitle?: string;
  /** Frame the request originated from — drives precise context-menu attribution. */
  frameId?: number;
  /** Referer header — required by some CDNs to allow segment fetches. */
  referer?: string;
  /**
   * Single-frame thumbnail extracted by ffmpeg from the first media segment.
   * `data:image/jpeg;base64,…`. The SW enqueues an extraction shortly after
   * sniffing; the popup updates the row when the result arrives.
   */
  thumbDataUrl?: string;
  /**
   * Set when the page-side crawler detected EME / requestMediaKeySystemAccess
   * around the time this stream was sniffed. The probe pipeline still has the
   * authoritative answer (via `ProbeResult.drm`), but surfacing it on the
   * row lets the user skip the probe round-trip on obviously-encrypted streams.
   */
  drmDetected?: boolean;
  /**
   * Set when the page is feeding the player through MSE (SourceBuffer.appendBuffer).
   * Useful as a "this is the real underlying source" signal when the visible
   * `<video>.src` is just `blob:`.
   */
  mseDetected?: boolean;
  /**
   * Origin of the sniff. `web-request` is the SW's webRequest sniffer, which
   * sees every media URL the tab issues but knows nothing about the DOM
   * element triggering it. `page-crawler` is the MAIN-world hook in
   * injected.ts — it only fires for fetch/XHR the page itself initiated, so
   * it's a stronger signal that the URL belongs to the page's player.
   */
  source?: "web-request" | "page-crawler";
  /**
   * Shape metadata from the page-side probe (image dimensions, audio duration)
   * or URL/extension heuristics (lossless container, icon-like path). The
   * scorer reads this to bias ranking — a 4096×2160 image outranks a 24×24
   * icon, a 4-minute FLAC outranks a 30-second WAV chime. Empty when neither
   * the DOM probe nor the URL heuristic produced a signal.
   */
  metadata?: StreamMetadata;
  /**
   * Synthetic stream surfaced when the page has no sniffable manifest URL.
   * The popup treats `virtual: "mse"` rows as "click to arm MSE capture" —
   * the URL is a placeholder (`mse://capture/<tabId>/<ts>`) and must never
   * reach `chrome.downloads.download`.
   */
  virtual?: "mse";
  /**
   * 0..100 confidence that this row is the stream the user intended to grab.
   * Computed by `scoreStream()` against the right-click focus context (which
   * frame was clicked, when, and on what element). Used by the popup to sort
   * the list and badge the top candidate — never gates capture or download.
   */
  score?: number;
  detectedAt: number;
}

/**
 * Snapshot of the user's last right-click on `tabId`. Captured by the SW
 * context-menu handler and used by `scoreStream()` to weight sniffed
 * candidates against the page element the user actually pointed at.
 *
 * Lives in `chrome.storage.session` alongside `streamsByTab`. Cleared when
 * the tab navigates or closes — same lifecycle as the streams list, so a
 * stale focus from a previous page can't bias scores after a new sniff.
 */
export interface FocusContext {
  tabId: number;
  frameId?: number;
  /** UNIX ms of the right-click. */
  clickedAt: number;
  /** `info.srcUrl` / `info.linkUrl` when present (skipped for blob:/data:). */
  srcUrl?: string;
  /** Which menu item the user picked — "page" covers the bare arm path. */
  mediaTag: "video" | "audio" | "image" | "link" | "page";
}

export type DownloadPhase =
  | "idle"
  | "probing"
  | "fetching-playlist"
  | "downloading-segments"
  | "downloading-audio"
  | "merging"
  | "saving"
  | "done"
  | "error";

export interface DownloadProgress {
  jobId: string;
  phase: DownloadPhase;
  /** 0..1, may stay at 0 during indeterminate phases. */
  ratio: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  retries?: number;
  bytesDone?: number;
  message?: string;
  error?: string;
}

/* ------------------------------- variants -------------------------------- */

/** SDR / HLG / PQ — surfaced to the popup as an HDR badge. */
export type VideoRange = "SDR" | "HLG" | "PQ";

export interface VariantOption {
  /** Playlist URI for this video rendition. */
  uri: string;
  bandwidth: number;
  /** "1920x1080" if announced. */
  resolution?: string;
  /** Parsed height in pixels — sortable. 0 when unknown. */
  height: number;
  /** Frame rate from FRAME-RATE attribute (HLS only); undefined when omitted. */
  frameRate?: number;
  codecs?: string;
  /** SDR / HLG / PQ. Undefined → assume SDR per HLS spec. */
  videoRange?: VideoRange;
  /** Audio group id if the variant references one. */
  audioGroup?: string;
  /** Set when the rendition is content-protected (FairPlay, Widevine, …). */
  drm?: string;
}

export interface AudioTrackOption {
  groupId: string;
  /** Stable id for UI selection — `${groupId}::${name}`. */
  id: string;
  name: string;
  language?: string;
  default: boolean;
  /** Some EXT-X-MEDIA AUDIO entries omit URI (audio is muxed into video). */
  uri?: string;
}

export interface SubtitleTrackOption {
  /** Stable id for UI selection. */
  id: string;
  name: string;
  language?: string;
  default: boolean;
  /** Subtitle playlist URL (HLS) or synthetic id resolved by offscreen (DASH). */
  uri?: string;
}

export interface ProbeResult {
  /** Empty when the source is already a media (non-master) playlist. */
  variants: VariantOption[];
  audioTracks: AudioTrackOption[];
  subtitleTracks: SubtitleTrackOption[];
  /** Default selection: highest resolution → highest bandwidth. */
  recommendedVariantUri?: string;
  recommendedAudioId?: string;
  /** No default subtitle — picker leaves it unchecked unless the user opts in. */
  singlePlaylist: boolean;
  /** When the source is a live / event playlist; merging it into one MP4 is nonsense. */
  isLive?: boolean;
  /** DRM systems referenced anywhere in the manifest (master or media). */
  drm?: string[];
  /** Set by the SW probe path when the manifest is unfit for download — popup
   *  surfaces it inline without a half-rendered picker. */
  unsupported?: { reason: string };
}

export interface DownloadSelection {
  variantUri?: string;
  audioId?: string;
  subtitleId?: string;
}

/* ----------------------------- persisted jobs ---------------------------- */

export interface PersistedJob {
  jobId: string;
  stream: DetectedStream;
  selection: DownloadSelection;
  /** ISO-ish timestamp; used to GC stale jobs. */
  startedAt: number;
  /**
   * Tab that originated the job — used as the proxy-fetch target so the
   * offscreen document can ask that tab's page context to refetch on its
   * behalf when a CDN rejects the direct fetch (page-runtime auth). Absent
   * when the job came from a path that never had a tab (e.g. resumed
   * after a crash; the proxy-fetch fallback then no-ops).
   */
  tabId?: number;
}

/* ---- Message envelope between popup ⇄ background ⇄ offscreen ---- */

export type MessageTarget = "sw" | "offscreen";

interface Targeted {
  /** Discriminator so SW and offscreen don't both react to the same broadcast. */
  target?: MessageTarget;
}

export type RuntimeMessage = Targeted &
  (
    | { type: "streams:list"; tabId: number }
    | { type: "streams:list:result"; streams: DetectedStream[] }
    | { type: "streams:clear"; tabId: number }
    | { type: "streams:added"; tabId: number; stream: DetectedStream }
    /**
     * SW → popup: a previously-broadcast stream has been removed from
     * `streamsByTab` (currently the image-dedup pipeline is the only
     * caller — when two sniffed images turn out to be the same photo at
     * different resolutions, the smaller one is dropped). The popup
     * filters its local state by `streamId`.
     */
    | { type: "streams:removed"; tabId: number; streamId: string }
    /**
     * Page-side crawler hit. The MAIN-world hook in the target tab posts to
     * the ISOLATED-world bridge, which forwards as this message. Honoured
     * only while the tab is armed; the SW fills tab/frame from `sender`.
     */
    | {
        type: "streams:report-direct";
        url: string;
        contentType?: string;
        pageUrl?: string;
        /**
         * Optional shape metadata from the page-side probe — width/height
         * for `<img>`, durationSec for `<audio>`. Forwarded straight onto
         * `DetectedStream.metadata`.
         */
        metadata?: StreamMetadata;
      }
    /**
     * Page-side DRM / MSE detection. Emitted by the MAIN-world crawler when
     * `requestMediaKeySystemAccess` resolves or `MediaSource.addSourceBuffer`
     * fires — surfaces the flag to every stream already detected on this tab
     * (and every future stream until the tab navigates).
     */
    | {
        type: "streams:report-flag";
        /**
         * `drm` / `mse` are page-runtime *capabilities* — they fire once per
         * page lifetime when the EME / MediaSource APIs are first touched.
         * `mse-active` is the *activity* signal — it fires only after the
         * SourceBuffer has actually accepted multiple `appendBuffer` payloads,
         * so the SW can distinguish "page constructed a MediaSource but
         * never used it" (rare) from "page is actively playing through MSE
         * but hasn't exposed a manifest URL we could sniff" (common — Bilibili,
         * YouTube, etc.). Only the latter triggers the virtual MSE stream.
         */
        flag: "drm" | "mse" | "mse-active";
        pageUrl?: string;
      }
    | { type: "capture:arm"; tabId: number }
    | { type: "capture:status"; tabId: number; armedUntil: number }
    /**
     * Page-sniff mode: long-lived tab-wide capture, opt-in from the popup.
     * Distinct from the 30s burst arm — page-sniff stays on until the user
     * disables it or the tab navigates / closes, and it's the only mode
     * that captures images (the burst arm intentionally filters them out).
     */
    | { type: "pagesniff:toggle"; tabId: number; enable: boolean }
    | { type: "pagesniff:query"; tabId: number }
    | { type: "pagesniff:status"; tabId: number; active: boolean }
    | { type: "download:probe"; stream: DetectedStream; jobId: string }
    | { type: "download:probe:result"; jobId: string; result: ProbeResult }
    | {
        type: "download:start";
        stream: DetectedStream;
        jobId: string;
        selection: DownloadSelection;
        /**
         * Set by the popup's batch driver. Direct downloads (image/audio/
         * mp4/text) skip the save-as dialog and auto-rename on filename
         * conflict instead of prompting; manifest streams (HLS/DASH) thread
         * the same flag through to the offscreen so the final remuxed
         * file lands in the Downloads folder without a per-job picker.
         */
        batched?: boolean;
      }
    | { type: "download:progress"; payload: DownloadProgress }
    | { type: "download:cancel"; jobId: string }
    | {
        type: "downloads:save";
        url: string;
        filename: string;
        saveAs: boolean;
        /** Forwarded to chrome.downloads.download — defaults to "prompt"
         *  when omitted (matches the previous single-download behavior). */
        conflictAction?: "uniquify" | "overwrite" | "prompt";
      }
    | { type: "thumb:request"; streamId: string; stream: DetectedStream }
    | { type: "thumb:result"; streamId: string; dataUrl?: string; error?: string }
    /**
     * SW → offscreen: compute a perceptual-hash fingerprint for `url`.
     * Offscreen does the GPU resize + 2D DCT and returns a 64-element
     * Float32Array (low-frequency 8×8 block, DC zeroed). Used by the
     * image-dedup pipeline to compare same-aspect-ratio images via
     * cosine similarity ≥ 0.99.
     */
    | {
        type: "image:fingerprint:request";
        requestId: string;
        url: string;
        referer?: string;
      }
    | {
        type: "image:fingerprint:result";
        requestId: string;
        vector?: Float32Array;
        width?: number;
        height?: number;
        error?: string;
      }
    | { type: "offscreen:ready" }
    /**
     * Offscreen → SW: ask the page hosting `jobId`'s tab to refetch `url`
     * with the page's own auth state. SW forwards to the content-script
     * bridge via `chrome.tabs.sendMessage` and replies through `sendResponse`.
     */
    | {
        type: "proxy:fetch";
        jobId: string;
        url: string;
        method?: string;
        headers?: Record<string, string>;
      }
    /**
     * Page-side MSE capture stream. The MAIN-world hook posts every
     * `SourceBuffer.appendBuffer` chunk through the bridge → SW → offscreen
     * pipeline; offscreen writes the chunks straight to OPFS so a fully-
     * encrypted-network fMP4 can still be saved when the page already
     * decrypted it for the player.
     */
    | {
        type: "mse:chunk";
        sessionId: string;
        mimeType?: string;
        bytes: Uint8Array;
        isInit: boolean;
        ordinal: number;
      }
    /** SW → offscreen: stop the in-progress MSE write session and remux. */
    | {
        type: "mse:finish";
        sessionId: string;
        suggestedName: string;
        saveAs?: boolean;
      }
    /**
     * Persisted-job storage shape (chrome.storage.local) used by the
     * standalone manager page. Pure data — no bridging behaviour beyond
     * what `download:progress` already provides.
     */
    | { type: "jobs:list" }
    | { type: "jobs:list:result"; jobs: ManagedJobRecord[] }
    | { type: "jobs:remove"; jobId: string }
    /**
     * MSE capture: opt-in mode where the page-side hook clones every
     * SourceBuffer.appendBuffer payload. The SW arms the page hook,
     * accumulates chunk metadata for the popup, and finalises the file
     * when the user clicks "Save".
     */
    | { type: "mse:arm"; tabId: number; enable: boolean }
    | {
        type: "mse:status";
        tabId: number;
        active: boolean;
        sessions: { sessionId: string; mimeType?: string; bytes: number; chunks: number }[];
      }
    | { type: "mse:status:query"; tabId: number }
    | { type: "mse:save"; sessionId: string; suggestedName: string }
  );

/* ----------------------- managed-job persistence ----------------------- */

/**
 * Long-lived record of every job the user starts, surfaced by the
 * standalone downloads manager page. Distinct from `PersistedJob`, which
 * lives in `chrome.storage.session` and is deleted as soon as the job
 * resolves — `ManagedJobRecord` survives the resolution and stores the
 * outcome (saved filename, error message) for the user to inspect later.
 */
export interface ManagedJobRecord {
  jobId: string;
  /** Source stream snapshot — enough to retry without re-sniffing. */
  stream: DetectedStream;
  selection: DownloadSelection;
  /** UNIX ms; useful for sorting in the manager UI. */
  startedAt: number;
  finishedAt?: number;
  /** Last seen progress phase. Manager UI mirrors what the popup shows. */
  phase: DownloadPhase;
  ratio: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  retries?: number;
  message?: string;
  error?: string;
  /** Filled in from the SW when chrome.downloads accepts the file. */
  savedFilename?: string;
}
