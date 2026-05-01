/**
 * Offscreen worker — runs in a regular DOM page, so it can use fetch(),
 * SharedArrayBuffer (when COOP/COEP allow), Web Workers, OPFS and
 * ffmpeg.wasm.
 *
 * Listens for `download:probe` (returns variants/audio tracks) and
 * `download:start` (runs the HLS/DASH pipeline, with segment-level retries
 * and OPFS-backed resume). Routes only messages whose `target` is
 * "offscreen", per CLAUDE.md cross-context conventions.
 */

import type {
  AudioTrackOption,
  DetectedStream,
  DownloadProgress,
  DownloadSelection,
  ProbeResult,
  RuntimeMessage,
  SubtitleTrackOption,
  VariantOption,
} from "@/lib/types";
import {
  parseM3U8,
  type HlsByteRange,
  type HlsRendition,
  type HlsSegment,
  compareVariantsBest,
} from "@/lib/m3u8";
import {
  parseMpd,
  compareRepresentationsBest,
  type DashAdaptationSet,
  type DashRepresentation,
  type DashSegmentRef,
} from "@/lib/mpd";
import { FFFSType } from "@ffmpeg/ffmpeg";
import {
  openSegmentStore,
  sweepOrphanedJobDirs,
  type Channel,
  type SegmentStore,
} from "./segmentStorage";
import { TailLossTracker } from "./tailLoss";

const cancelled = new Set<string>();
const SEGMENT_RETRIES = 3;
const SEGMENT_RETRY_DELAY_MS = 600;
// Empirically 4 is the sweet spot — high enough to saturate residential
// links, low enough that CDNs (esp. Akamai/Cloudflare with per-IP throttle
// shaping) don't start returning 429 / connection-reset mid-job. Mirrors the
// production-validated default in other open-source HLS downloaders.
const SEGMENT_CONCURRENCY = 4;
// Per-fetch wall-clock budget. A stalled segment behind a flaky CDN was
// previously able to hang the whole job indefinitely; the AbortController
// below converts that into a normal retry path.
const SEGMENT_FETCH_TIMEOUT_MS = 30_000;
const DASH_KEY_PREFIX = "dash::";
const DASH_AUDIO_PREFIX = "dash-audio::";
const DASH_TEXT_PREFIX = "dash-text::";
const HLS_CHILD_PLAYLIST_RE = /(_(?:\d+w|audio|video|v\d+|a\d+)|-(?:video|audio|av)\d*)\.m3u8(\?|$|#)/i;
// WORKERFS mount point inside the ffmpeg.wasm worker — the per-channel
// merged OPFS files are exposed to ffmpeg under this directory so the
// muxer reads them lazily without copying through MEMFS first.
const FF_INPUT_MOUNT = "/in";
const FF_VIDEO_INPUT = `${FF_INPUT_MOUNT}/video.bin`;
const FF_AUDIO_INPUT = `${FF_INPUT_MOUNT}/audio.bin`;

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  if (msg.type === "download:probe") {
    void runProbe(msg.stream, msg.jobId).catch((err) => {
      reportProgress({
        jobId: msg.jobId,
        phase: "error",
        ratio: 0,
        error: errorMessage(err),
      });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "download:start") {
    void runDownload(msg.stream, msg.jobId, msg.selection ?? {}).catch((err) => {
      reportProgress({
        jobId: msg.jobId,
        phase: "error",
        ratio: 0,
        error: errorMessage(err),
      });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "download:cancel") {
    cancelled.add(msg.jobId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "thumb:request") {
    void runThumbnail(msg.stream)
      .then((dataUrl) => sendThumbResult(msg.streamId, dataUrl))
      .catch((err) =>
        sendThumbResult(msg.streamId, undefined, errorMessage(err)),
      );
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "mse:chunk") {
    void appendMseChunk(msg.sessionId, msg.bytes, msg.ordinal, msg.mimeType, msg.isInit).catch(
      (err) => {
        // Chunks are best-effort: the page is still feeding the live
        // player, so a failed write here just means the saved file will
        // be incomplete. Log via the same channel as ffmpeg errors.
        void err;
      },
    );
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "mse:finish") {
    void finaliseMseSession(msg.sessionId, msg.suggestedName).catch(() => {
      /* surfaces via download:progress error already */
    });
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

void chrome.runtime
  .sendMessage({ type: "offscreen:ready", target: "sw" } satisfies RuntimeMessage)
  .catch(() => {
    /* SW may not be listening yet — non-fatal */
  });

function reportProgress(p: DownloadProgress): void {
  void chrome.runtime
    .sendMessage({
      type: "download:progress",
      payload: p,
      target: "sw",
    } satisfies RuntimeMessage)
    .catch(() => {
      /* nobody listening */
    });
}

/* --------------------------------- HTTP --------------------------------- */

/** Categorised fetch failure — surfaces to the popup as a meaningful phase. */
export class HttpStatusError extends Error {
  readonly kind = "http" as const;
  constructor(public readonly status: number, public readonly url: string) {
    super(`HTTP ${status}`);
  }
}

export class FetchTimeoutError extends Error {
  readonly kind = "timeout" as const;
  constructor(public readonly url: string, public readonly ms: number) {
    super(`Timed out after ${ms}ms`);
  }
}

export class FetchAbortedError extends Error {
  readonly kind = "abort" as const;
  constructor(public readonly url: string) {
    super(`Aborted`);
  }
}

async function fetchWithBudget(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new FetchTimeoutError(url, timeoutMs);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new FetchAbortedError(url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Job-id is threaded through fetch calls so the proxy-fetch fallback can
 * reach the right tab. Set by `runDownload` / `runDownloadHls` etc. for
 * the duration of one job; null for one-shot calls (probes, thumbnail
 * extraction) where there's no committed origin tab to proxy through.
 */
let activeJobId: string | undefined;

function setActiveJobId(id: string | undefined): void {
  activeJobId = id;
}

async function fetchBytes(
  url: string,
  headers?: Record<string, string>,
  timeoutMs: number = SEGMENT_FETCH_TIMEOUT_MS,
): Promise<Uint8Array> {
  try {
    const res = await fetchWithBudget(
      url,
      { headers, credentials: "include" },
      timeoutMs,
    );
    if (!res.ok) {
      // 401/403 from the CDN almost always means the offscreen request
      // doesn't carry the page-runtime auth (signed-cookie token, custom
      // header, etc.). Page-proxy fetch reissues the request from the
      // page itself so the CDN sees the same identity it normally does.
      if ((res.status === 401 || res.status === 403) && activeJobId) {
        const proxied = await proxyFetchBytes(activeJobId, url, headers).catch(
          () => undefined,
        );
        if (proxied) return proxied;
      }
      throw new HttpStatusError(res.status, url);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch (err) {
    // Network-level failure (TypeError "Failed to fetch", CORS rejection
    // before status). Try the proxy fetch once before surfacing the error.
    if (activeJobId && (err instanceof TypeError || (err as Error).message?.includes("Failed to fetch"))) {
      const proxied = await proxyFetchBytes(activeJobId, url, headers).catch(
        () => undefined,
      );
      if (proxied) return proxied;
    }
    throw err;
  }
}

/**
 * Ask the SW to refetch `url` from the page that started this job.
 * Returns the bytes on success; throws on failure so the caller sees the
 * proxy attempt as a clean "couldn't recover" signal.
 */
async function proxyFetchBytes(
  jobId: string,
  url: string,
  headers?: Record<string, string>,
): Promise<Uint8Array> {
  const reply = await new Promise<{
    ok: boolean;
    status: number;
    bytes?: Uint8Array | { [k: number]: number; length?: number };
    error?: string;
  }>((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "proxy:fetch",
        jobId,
        url,
        method: "GET",
        headers: headers ?? {},
        target: "sw",
      } satisfies RuntimeMessage,
      (resp: any) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message || "proxy-fetch-no-sw"));
          return;
        }
        resolve(resp ?? { ok: false, status: 0, error: "no-response" });
      },
    );
  });
  if (!reply.ok || !reply.bytes) {
    throw new HttpStatusError(reply.status || 0, url);
  }
  // The bytes traverse two structured-clone hops (page → SW → offscreen).
  // Either side can leave them as a plain object with numeric keys —
  // normalise to Uint8Array so callers don't have to defend against shape.
  if (reply.bytes instanceof Uint8Array) return reply.bytes;
  const arr = reply.bytes as { [k: number]: number; length?: number };
  const length = typeof arr.length === "number" ? arr.length : Object.keys(arr).length;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = arr[i] ?? 0;
  return out;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithBudget(
    url,
    { credentials: "include" },
    SEGMENT_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new HttpStatusError(res.status, url);
  return res.text();
}

/* ----------------------------- AES-128 -------------------------------- */

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

async function decryptAes128(
  data: Uint8Array,
  keyBytes: Uint8Array,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const out = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(data),
  );
  return new Uint8Array(out);
}

function ivForSequence(explicit: Uint8Array | undefined, sequence: number): Uint8Array {
  if (explicit) return explicit;
  const iv = new Uint8Array(16);
  iv[12] = (sequence >>> 24) & 0xff;
  iv[13] = (sequence >>> 16) & 0xff;
  iv[14] = (sequence >>> 8) & 0xff;
  iv[15] = sequence & 0xff;
  return iv;
}

/* ---------------------------- segment cache ----------------------- */
//
// Persisted segment storage now lives in segmentStorage.ts (OPFS-backed).
// This module just owns the orphan-dir GC at startup so a previous
// crash/cancel doesn't leak job directories indefinitely.

void runOrphanedSweep();

async function runOrphanedSweep(): Promise<void> {
  // Active jobs are tracked in the SW (`jobsById`); the offscreen doesn't
  // see them directly. Conservatively wait until any in-flight start/probe
  // has registered its jobId in `cancelled`-or-active state, then sweep
  // anything else. In practice this runs once per offscreen wake.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await sweepOrphanedJobDirs((jobId) => isJobInFlight(jobId));
}

const inFlightJobs = new Set<string>();

function isJobInFlight(jobId: string): boolean {
  return inFlightJobs.has(jobId);
}

/* ------------------------------ probe ------------------------------- */

async function runProbe(stream: DetectedStream, jobId: string): Promise<void> {
  reportProgress({ jobId, phase: "probing", ratio: 0, message: "Probing playlist…" });

  if (stream.kind === "hls") {
    await probeHls(stream, jobId);
    return;
  }
  if (stream.kind === "dash") {
    await probeDash(stream, jobId);
    return;
  }
  // Direct file (mp4 / audio) — no choices to offer.
  reportProbe(jobId, { variants: [], audioTracks: [], subtitleTracks: [], singlePlaylist: true });
}

async function probeHls(stream: DetectedStream, jobId: string): Promise<void> {
  const text = await fetchText(stream.url);
  const parsed = parseM3U8(text, stream.url);
  if (parsed.kind === "media") {
    const isLive = parsed.playlist.liveness !== "vod";
    const drm = parsed.playlist.drmSystems.length
      ? [...parsed.playlist.drmSystems]
      : undefined;
    reportProbe(jobId, {
      variants: [],
      audioTracks: [],
      subtitleTracks: [],
      singlePlaylist: true,
      isLive: isLive || undefined,
      drm,
      unsupported: drm
        ? { reason: `Content is protected (${drm.join(", ")}); the segments stay encrypted.` }
        : isLive
          ? { reason: "This is a live or event stream; merging a sliding window into one MP4 isn't supported." }
          : undefined,
    });
    return;
  }

  const variants: VariantOption[] = parsed.variants.map((v) => ({
    uri: v.uri,
    bandwidth: v.bandwidth,
    resolution: v.resolution,
    height: v.height,
    frameRate: v.frameRate,
    codecs: v.codecs,
    videoRange: v.videoRange,
    audioGroup: v.audioGroup,
    // Master-level DRM applies to every variant; per-variant flag is what
    // the picker needs so it can grey individual rows out.
    drm: parsed.drmSystems[0],
  }));

  const audioTracks: AudioTrackOption[] = dedupeAudioTracks(
    parsed.renditions
      .filter((r) => r.type === "AUDIO")
      .map((r) => ({
        groupId: r.groupId,
        id: `${r.groupId}::${r.name}`,
        name: r.name,
        language: r.language,
        default: r.default,
        uri: r.uri,
      })),
  );

  const subtitleTracks: SubtitleTrackOption[] = parsed.renditions
    .filter((r) => r.type === "SUBTITLES" && r.uri)
    .map((r) => ({
      id: `${r.groupId}::${r.name}`,
      name: r.name,
      language: r.language,
      default: r.default,
      uri: r.uri,
    }));

  const recommendedVariantUri = variants[0]?.uri;
  const top = parsed.variants[0];
  const recommendedAudioId = top?.audioGroup
    ? audioTracks.find((a) => a.groupId === top.audioGroup && (a.default || true))?.id
    : audioTracks.find((a) => a.default)?.id;

  const drm = parsed.drmSystems.length ? [...parsed.drmSystems] : undefined;
  reportProbe(jobId, {
    variants,
    audioTracks,
    subtitleTracks,
    singlePlaylist: false,
    recommendedVariantUri,
    recommendedAudioId,
    drm,
    unsupported: drm
      ? { reason: `Content is protected (${drm.join(", ")}); the segments stay encrypted.` }
      : undefined,
  });
}

async function probeDash(stream: DetectedStream, jobId: string): Promise<void> {
  const text = await fetchText(stream.url);
  const mpd = parseMpd(text, stream.url);

  if (!mpd.videoSets.length && !mpd.audioSets.length) {
    reportProbe(jobId, { variants: [], audioTracks: [], subtitleTracks: [], singlePlaylist: true });
    return;
  }

  const videoSet = mpd.videoSets[0];
  const variants: VariantOption[] = videoSet
    ? [...videoSet.representations]
        .sort(compareRepresentationsBest)
        .map((r) => ({
          uri: dashVariantId(videoSet.id, r.id),
          bandwidth: r.bandwidth,
          resolution: r.width && r.height ? `${r.width}x${r.height}` : undefined,
          height: r.height ?? 0,
          codecs: r.codecs,
        }))
    : [];

  // For DASH audio, expose one row per (audio AdaptationSet × Representation).
  // Most assets ship one Representation per language; the multi-bitrate case
  // is rare and the picker copes either way.
  const audioTracks: AudioTrackOption[] = [];
  for (const set of mpd.audioSets) {
    const reps = [...set.representations].sort((a, b) => b.bandwidth - a.bandwidth);
    for (const r of reps) {
      const kbps = r.bandwidth ? ` · ${Math.round(r.bandwidth / 1000)} kbps` : "";
      audioTracks.push({
        groupId: set.id,
        id: dashAudioId(set.id, r.id),
        name: `${set.lang || set.id}${kbps}`,
        language: set.lang,
        default: set.default,
      });
    }
  }

  const subtitleTracks: SubtitleTrackOption[] = [];
  for (const set of mpd.textSets) {
    for (const r of set.representations) {
      subtitleTracks.push({
        id: dashSubtitleId(set.id, r.id),
        name: set.lang || set.id,
        language: set.lang,
        default: set.default,
      });
    }
  }

  const recommendedVariantUri = variants[0]?.uri;
  const recommendedAudioId =
    audioTracks.find((a) => a.default)?.id ?? audioTracks[0]?.id;

  reportProbe(jobId, {
    variants,
    audioTracks,
    subtitleTracks,
    singlePlaylist: false,
    recommendedVariantUri,
    recommendedAudioId,
  });
}

function dashVariantId(setId: string, repId: string): string {
  return `${DASH_KEY_PREFIX}${setId}::${repId}`;
}
function dashAudioId(setId: string, repId: string): string {
  return `${DASH_AUDIO_PREFIX}${setId}::${repId}`;
}
function dashSubtitleId(setId: string, repId: string): string {
  return `${DASH_TEXT_PREFIX}${setId}::${repId}`;
}

function dedupeAudioTracks(tracks: AudioTrackOption[]): AudioTrackOption[] {
  const seen = new Set<string>();
  const out: AudioTrackOption[] = [];
  for (const track of tracks) {
    const key = track.uri ? `uri:${track.uri}` : `meta:${track.groupId}::${track.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function parseDashId(value: string, prefix: string): { setId: string; repId: string } | undefined {
  if (!value.startsWith(prefix)) return undefined;
  const [setId, repId] = value.slice(prefix.length).split("::");
  if (!setId || !repId) return undefined;
  return { setId, repId };
}

function reportProbe(jobId: string, result: ProbeResult): void {
  void chrome.runtime
    .sendMessage({
      type: "download:probe:result",
      jobId,
      result,
      target: "sw",
    } satisfies RuntimeMessage)
    .catch(() => {
      /* nobody */
    });
  reportProgress({ jobId, phase: "idle", ratio: 0 });
}

/* ----------------------------- download dispatch ---------------------- */

interface SegmentJob {
  channel: "v" | "a";
  segments: HlsSegment[];
  initBytes?: Uint8Array;
}

async function runDownload(
  stream: DetectedStream,
  jobId: string,
  selection: DownloadSelection,
): Promise<void> {
  setActiveJobId(jobId);
  try {
    if (stream.kind === "hls") {
      await runDownloadHls(stream, jobId, selection);
      return;
    }
    if (stream.kind === "dash") {
      await runDownloadDash(stream, jobId, selection);
      return;
    }
    throw new Error(`Offscreen pipeline does not handle kind=${stream.kind}.`);
  } finally {
    setActiveJobId(undefined);
  }
}

/* ------------------------------ HLS pipeline -------------------------- */

async function runDownloadHls(
  stream: DetectedStream,
  jobId: string,
  selection: DownloadSelection,
): Promise<void> {
  reportProgress({ jobId, phase: "fetching-playlist", ratio: 0, message: "Fetching playlist…" });

  const masterSource = await fetchCanonicalHls(stream.url);
  const masterParsed = parseM3U8(masterSource.text, masterSource.url);

  // Fail fast on master-level DRM. Going any further just downloads
  // segments we can't decrypt.
  if (masterParsed.kind === "master" && masterParsed.drmSystems.length) {
    throw new Error(
      `Stream is protected by ${masterParsed.drmSystems.join(", ")}; segments cannot be decrypted.`,
    );
  }

  let videoPlaylistUrl: string;
  let audioRendition: HlsRendition | undefined;

  if (masterParsed.kind === "master") {
    const variant = selection.variantUri
      ? masterParsed.variants.find((v) => v.uri === selection.variantUri)
      : [...masterParsed.variants].sort(compareVariantsBest)[0];
    if (!variant) throw new Error("Master playlist has no variants.");
    videoPlaylistUrl = variant.uri;
    if (variant.audioGroup) {
      const audioCandidates = masterParsed.renditions.filter(
        (r) => r.type === "AUDIO" && r.groupId === variant.audioGroup,
      );
      if (selection.audioId) {
        audioRendition = audioCandidates.find(
          (a) => `${a.groupId}::${a.name}` === selection.audioId,
        );
      }
      audioRendition = audioRendition || audioCandidates.find((a) => a.default) || audioCandidates[0];
    }
    audioRendition =
      audioRendition ||
      masterParsed.renditions.find((r) => r.type === "AUDIO" && r.default) ||
      masterParsed.renditions.find((r) => r.type === "AUDIO");
  } else {
    videoPlaylistUrl = stream.url;
  }

  const videoPlaylist = parseM3U8(await fetchText(videoPlaylistUrl), videoPlaylistUrl);
  if (videoPlaylist.kind !== "media") throw new Error("Failed to resolve media playlist.");
  if (!videoPlaylist.playlist.segments.length) throw new Error("Playlist contains no segments.");
  if (videoPlaylist.playlist.drmSystems.length) {
    throw new Error(
      `Media playlist references ${videoPlaylist.playlist.drmSystems.join(", ")} content protection; cannot continue.`,
    );
  }
  if (videoPlaylist.playlist.liveness !== "vod") {
    // Live windows trim segments we'd need to fetch — there's no fixed end
    // to mux to. Bailing early is friendlier than producing a half-MP4.
    throw new Error(
      "Live / event playlists aren't supported; merging a sliding window into one MP4 isn't meaningful.",
    );
  }

  let audioSegments: HlsSegment[] | undefined;
  let audioInit: Uint8Array | undefined;
  if (audioRendition?.uri) {
    const audio = await fetchHlsAudioPlaylist(
      audioRendition.uri,
      videoPlaylist.playlist.totalDuration,
      jobId,
      true,
    );
    audioSegments = audio?.segments;
    audioInit = audio?.init;
  } else {
    const audio = await fetchHlsAudioPlaylist(
      deriveSiblingAudioPlaylistUrl(videoPlaylistUrl),
      videoPlaylist.playlist.totalDuration,
      jobId,
    );
    audioSegments = audio?.segments;
    audioInit = audio?.init;
  }

  const keyCache = await resolveKeys([
    videoPlaylist.playlist.segments,
    audioSegments,
  ]);

  const videoInit = videoPlaylist.playlist.initSegment
    ? await fetchInitSegment(videoPlaylist.playlist.initSegment)
    : undefined;

  await finishDownload(
    stream,
    jobId,
    videoPlaylist.playlist.segments,
    videoInit,
    audioSegments,
    audioInit,
    keyCache,
  );

  if (selection.subtitleId && masterParsed.kind === "master") {
    await downloadSubtitleHls(stream, masterParsed.renditions, selection.subtitleId).catch(
      (err) => reportSubtitleError(jobId, err),
    );
  }
}

function canonicalHlsMasterUrl(url: string): string {
  if (!HLS_CHILD_PLAYLIST_RE.test(url)) return url;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/(_(?:\d+w|audio|video|v\d+|a\d+)|-(?:video|audio|av)\d*)\.m3u8$/i, ".m3u8");
    return u.toString();
  } catch {
    return url.replace(/(_(?:\d+w|audio|video|v\d+|a\d+)|-(?:video|audio|av)\d*)\.m3u8(\?|$|#)/i, ".m3u8$2");
  }
}

async function fetchCanonicalHls(url: string): Promise<{ url: string; text: string }> {
  const masterUrl = canonicalHlsMasterUrl(url);
  if (masterUrl !== url) {
    try {
      return { url: masterUrl, text: await fetchText(masterUrl) };
    } catch {
      /* fall back to the exact sniffed playlist */
    }
  }
  return { url, text: await fetchText(url) };
}

function deriveSiblingAudioPlaylistUrl(videoPlaylistUrl: string): string | undefined {
  if (/(_(?:\d+w|video|v\d+)|-video\d*)\.m3u8(\?|$|#)/i.test(videoPlaylistUrl)) {
    try {
      const u = new URL(videoPlaylistUrl);
      u.pathname = u.pathname.replace(/(_(?:\d+w|video|v\d+)|-video\d*)\.m3u8$/i, "_audio.m3u8");
      return u.toString();
    } catch {
      return videoPlaylistUrl.replace(/(_(?:\d+w|video|v\d+)|-video\d*)\.m3u8(\?|$|#)/i, "_audio.m3u8$2");
    }
  }
  return undefined;
}

async function fetchHlsAudioPlaylist(
  url: string | undefined,
  videoDuration: number,
  jobId: string,
  required = false,
): Promise<{ segments: HlsSegment[]; init?: Uint8Array } | undefined> {
  if (!url) return undefined;
  try {
    const text = await fetchText(url);
    const parsed = parseM3U8(text, url);
    if (parsed.kind !== "media" || !parsed.playlist.segments.length) return undefined;
    // An encrypted or live audio rendition can't be paired with a working
    // video track — bail before we waste bandwidth on segments we can't use.
    if (parsed.playlist.drmSystems.length) {
      throw new Error(
        `Audio rendition is protected by ${parsed.playlist.drmSystems.join(", ")}.`,
      );
    }
    if (parsed.playlist.liveness !== "vod") {
      throw new Error("Audio rendition is a live / event stream — not mergeable.");
    }
    if (!durationsCompatible(videoDuration, parsed.playlist.totalDuration)) {
      throw new Error(
        `Audio playlist duration (${parsed.playlist.totalDuration.toFixed(2)}s) does not match video (${videoDuration.toFixed(2)}s).`,
      );
    }
    const init = parsed.playlist.initSegment
      ? await fetchInitSegment(parsed.playlist.initSegment)
      : undefined;
    return { segments: parsed.playlist.segments, init };
  } catch (err) {
    if (required) throw err;
    reportProgress({
      jobId,
      phase: "fetching-playlist",
      ratio: 0,
      message: `Audio track ignored: ${errorMessage(err)}`,
    });
    return undefined;
  }
}

function durationsCompatible(videoDuration: number, audioDuration: number): boolean {
  if (!videoDuration || !audioDuration) return true;
  const delta = Math.abs(videoDuration - audioDuration);
  return delta <= Math.max(2, videoDuration * 0.08);
}

async function resolveKeys(
  segmentLists: (HlsSegment[] | undefined)[],
): Promise<Map<string, Uint8Array>> {
  const cache = new Map<string, Uint8Array>();
  for (const list of segmentLists) {
    if (!list) continue;
    for (const seg of list) {
      if (seg.key && !cache.has(seg.key.uri)) {
        cache.set(seg.key.uri, await fetchBytes(seg.key.uri));
      }
    }
  }
  return cache;
}

/* ----------------------------- DASH pipeline -------------------------- */

async function runDownloadDash(
  stream: DetectedStream,
  jobId: string,
  selection: DownloadSelection,
): Promise<void> {
  reportProgress({ jobId, phase: "fetching-playlist", ratio: 0, message: "Fetching MPD…" });

  const text = await fetchText(stream.url);
  const mpd = parseMpd(text, stream.url);
  if (!mpd.videoSets.length) throw new Error("MPD has no video AdaptationSet.");

  const videoPick = pickDashVariant(mpd.videoSets, selection.variantUri);
  if (!videoPick) throw new Error("MPD video Representation not found.");

  const audioPick = selection.audioId
    ? pickDashAudio(mpd.audioSets, selection.audioId)
    : pickDefaultDashAudio(mpd.audioSets);

  const videoInit = videoPick.rep.initUrl
    ? await fetchBytes(videoPick.rep.initUrl)
    : undefined;
  const audioInit = audioPick?.rep.initUrl
    ? await fetchBytes(audioPick.rep.initUrl)
    : undefined;

  const videoSegs = dashAsHls(videoPick.rep.segments);
  const audioSegs = audioPick ? dashAsHls(audioPick.rep.segments) : undefined;

  await finishDownload(
    stream,
    jobId,
    videoSegs,
    videoInit,
    audioSegs,
    audioInit,
    new Map(), // DASH has no AES-128 key cache; DRM unsupported
  );

  if (selection.subtitleId) {
    await downloadSubtitleDash(stream, mpd.textSets, selection.subtitleId).catch((err) =>
      reportSubtitleError(jobId, err),
    );
  }
}

function dashAsHls(refs: DashSegmentRef[]): HlsSegment[] {
  // DASH segments are unencrypted in the supported (non-DRM) path, so the
  // sequence value never reaches AES-128 IV derivation. We still populate it
  // for type compatibility — using the array index is fine here.
  return refs.map((s, i) => ({ uri: s.uri, duration: s.duration, sequence: i }));
}

function pickDashVariant(
  sets: DashAdaptationSet[],
  variantUri: string | undefined,
): { set: DashAdaptationSet; rep: DashRepresentation } | undefined {
  if (variantUri) {
    const parsed = parseDashId(variantUri, DASH_KEY_PREFIX);
    if (parsed) {
      const set = sets.find((s) => s.id === parsed.setId);
      const rep = set?.representations.find((r) => r.id === parsed.repId);
      if (set && rep) return { set, rep };
    }
  }
  // Default: highest-resolution rep across all video sets.
  for (const set of sets) {
    const sorted = [...set.representations].sort(compareRepresentationsBest);
    if (sorted[0]) return { set, rep: sorted[0] };
  }
  return undefined;
}

function pickDashAudio(
  sets: DashAdaptationSet[],
  audioId: string,
): { set: DashAdaptationSet; rep: DashRepresentation } | undefined {
  const parsed = parseDashId(audioId, DASH_AUDIO_PREFIX);
  if (!parsed) return undefined;
  const set = sets.find((s) => s.id === parsed.setId);
  const rep = set?.representations.find((r) => r.id === parsed.repId);
  return set && rep ? { set, rep } : undefined;
}

function pickDefaultDashAudio(
  sets: DashAdaptationSet[],
): { set: DashAdaptationSet; rep: DashRepresentation } | undefined {
  const def = sets.find((s) => s.default) ?? sets[0];
  if (!def) return undefined;
  const rep = [...def.representations].sort((a, b) => b.bandwidth - a.bandwidth)[0];
  return rep ? { set: def, rep } : undefined;
}

/* --------------------------- shared finish path ------------------------ */

async function finishDownload(
  stream: DetectedStream,
  jobId: string,
  videoSegments: HlsSegment[],
  videoInit: Uint8Array | undefined,
  audioSegments: HlsSegment[] | undefined,
  audioInit: Uint8Array | undefined,
  keyCache: Map<string, Uint8Array>,
): Promise<void> {
  inFlightJobs.add(jobId);
  const store = await openSegmentStore(jobId);
  try {
    await downloadChannel(
      { channel: "v", segments: videoSegments, initBytes: videoInit },
      jobId,
      store,
      keyCache,
      "downloading-segments",
    );
    if (audioSegments && audioSegments.length) {
      await downloadChannel(
        { channel: "a", segments: audioSegments, initBytes: audioInit },
        jobId,
        store,
        keyCache,
        "downloading-audio",
      );
    }

    reportProgress({ jobId, phase: "merging", ratio: 0.92, message: "Consolidating…" });
    await consolidateChannel(store, "v", videoInit, videoSegments.length);
    if (audioSegments && audioSegments.length) {
      await consolidateChannel(store, "a", audioInit, audioSegments.length);
    }

    reportProgress({ jobId, phase: "merging", ratio: 0.95, message: "Remuxing to MP4…" });
    const output = await remuxFromStore(store, Boolean(audioSegments?.length), jobId);

    reportProgress({ jobId, phase: "saving", ratio: 0.99 });
    await saveBlob(
      new Blob([toArrayBuffer(output.bytes)], { type: output.mimeType }),
      withExtension(stream.suggestedName, output.extension),
    );

    reportProgress({ jobId, phase: "done", ratio: 1 });
  } finally {
    inFlightJobs.delete(jobId);
    await store.destroy().catch(() => {
      /* OPFS cleanup is best-effort; orphan sweep on next wake reclaims */
    });
  }
}

/**
 * Stream every per-segment OPFS file into one merged file the muxer can
 * mount. We could mount each segment via WORKERFS individually, but argv
 * length and the concat-demuxer's unfriendliness with init-less fMP4
 * fragments both push us toward "one big file the demuxer parses as
 * one continuous bitstream" — same shape ffmpeg saw before, sourced from
 * disk instead of from a 2 GB ArrayBuffer in JS heap.
 */
async function consolidateChannel(
  store: SegmentStore,
  channel: Channel,
  initBytes: Uint8Array | undefined,
  segmentCount: number,
): Promise<void> {
  await store.beginMerged(channel);
  try {
    if (initBytes) await store.appendMerged(channel, initBytes);
    for (let i = 0; i < segmentCount; i++) {
      await store.appendSegmentToMerged(channel, i);
    }
  } finally {
    await store.endMerged(channel);
  }
}

async function fetchInitSegment(init: {
  uri: string;
  byteRange?: HlsByteRange;
}): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (init.byteRange) {
    headers.Range = `bytes=${init.byteRange.offset}-${init.byteRange.offset + init.byteRange.length - 1}`;
  }
  return fetchBytes(init.uri, headers);
}

async function downloadChannel(
  job: SegmentJob,
  jobId: string,
  store: SegmentStore,
  keyCache: Map<string, Uint8Array>,
  phaseName: "downloading-segments" | "downloading-audio",
): Promise<void> {
  const { segments, channel } = job;
  const completed = new Array<boolean>(segments.length).fill(false);
  let done = 0;
  let cursor = 0;
  let totalRetries = 0;
  const tracker = new TailLossTracker();

  // Hydrate from OPFS — single metadata check per segment, no full read.
  // Segments already on disk count as done; the merge step picks them up
  // by index when consolidating into the per-channel merged file.
  for (let i = 0; i < segments.length; i++) {
    if (await store.has(channel, i)) {
      completed[i] = true;
      done++;
    }
  }
  reportProgress({
    jobId,
    phase: phaseName,
    ratio: segments.length === 0 ? 1 : done / segments.length,
    segmentsDone: done,
    segmentsTotal: segments.length,
    message: done ? `Resumed ${done}/${segments.length} from cache.` : undefined,
  });

  if (done === segments.length) return;

  await new Promise<void>((resolve, reject) => {
    let active = 0;
    let failed = false;

    const launchNext = (): void => {
      if (failed) return;
      if (cancelled.has(jobId)) {
        failed = true;
        reject(new Error("Cancelled."));
        return;
      }
      while (cursor < segments.length && completed[cursor]) cursor++;

      while (active < SEGMENT_CONCURRENCY && cursor < segments.length) {
        const idx = cursor++;
        if (completed[idx]) continue;
        active++;
        const startedAt = performance.now();
        void downloadSegmentWithRetry(segments[idx], idx, keyCache, tracker)
          .then(async ({ bytes, retries }) => {
            await store.write(channel, idx, bytes);
            tracker.observe(performance.now() - startedAt);
            completed[idx] = true;
            totalRetries += retries;
            done++;
            reportProgress({
              jobId,
              phase: phaseName,
              ratio: done / segments.length,
              segmentsDone: done,
              segmentsTotal: segments.length,
              retries: totalRetries,
            });
          })
          .catch((err) => {
            failed = true;
            reject(err);
          })
          .finally(() => {
            active--;
            if (failed) return;
            if (done === segments.length) resolve();
            else launchNext();
          });
      }
    };
    launchNext();
  });
}

async function downloadSegmentWithRetry(
  seg: HlsSegment,
  index: number,
  keyCache: Map<string, Uint8Array>,
  tracker: TailLossTracker,
): Promise<{ bytes: Uint8Array; retries: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
    try {
      const adaptive = tracker.budgetMs();
      const budget = adaptive != null
        ? Math.min(adaptive, SEGMENT_FETCH_TIMEOUT_MS)
        : SEGMENT_FETCH_TIMEOUT_MS;
      const bytes = await downloadSegment(seg, index, keyCache, budget);
      return { bytes, retries: attempt };
    } catch (err) {
      lastErr = err;
      if (!isRetriable(err)) break;
      if (attempt < SEGMENT_RETRIES) {
        await sleep(SEGMENT_RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  throw new Error(
    `Segment ${index} failed after ${SEGMENT_RETRIES + 1} attempts: ${errorMessage(lastErr)}`,
  );
}

async function downloadSegment(
  seg: HlsSegment,
  index: number,
  keyCache: Map<string, Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (seg.byteRange) {
    headers.Range = `bytes=${seg.byteRange.offset}-${seg.byteRange.offset + seg.byteRange.length - 1}`;
  }
  let bytes = await fetchBytes(seg.uri, headers, timeoutMs);
  if (seg.key) {
    const keyBytes = keyCache.get(seg.key.uri);
    if (!keyBytes) throw new Error(`Missing key for segment ${index}.`);
    const iv = ivForSequence(seg.key.iv, seg.sequence);
    bytes = await decryptAes128(bytes, keyBytes, iv);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------- ffmpeg.wasm remux ------------------------- */
//
// The mux step has two jobs: (1) put the video bitstream into an MP4
// container, (2) merge the optional audio rendition. We pick filename
// extensions that match the input bitstream so ffmpeg's demuxer auto-
// detects without ambiguity (".bin" used to be passed in here and the
// AAC/TS path occasionally mis-probed). For unencrypted HLS we know the
// container from #EXT-X-MAP — fMP4 when init segment exists, MPEG-TS or
// raw ADTS otherwise — and confirm via a magic-bytes sniff.

let ffmpegPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;
const ffmpegLogTail: string[] = [];
const FFMPEG_LOG_KEEP = 60;

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ff = new FFmpeg();
      ff.on("log", ({ message }) => {
        if (!message) return;
        ffmpegLogTail.push(message);
        if (ffmpegLogTail.length > FFMPEG_LOG_KEEP) ffmpegLogTail.shift();
      });
      const coreURL = chrome.runtime.getURL("ffmpeg/ffmpeg-core.js");
      const wasmURL = chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm");
      await ff.load({ coreURL, wasmURL });
      return ff;
    })();
  }
  return ffmpegPromise;
}

interface RemuxOutput {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

type StreamFormat = "fmp4" | "mpegts" | "aac" | "mp3" | "unknown";

/** Read the leading bytes of an OPFS-backed file without materialising
 *  the whole 2 GB blob in JS heap — only the first 256 bytes are needed
 *  for the magic-bytes sniff. */
async function detectFormatFromFile(file: File): Promise<StreamFormat> {
  const head = await file.slice(0, 256).arrayBuffer();
  return detectFormat(new Uint8Array(head));
}

/** Sniff container/codec from leading bytes — way more reliable than the
 *  URL extension on CDNs that hand out everything as `.ts`. */
function detectFormat(bytes: Uint8Array): StreamFormat {
  if (bytes.byteLength >= 8) {
    // ISO Base Media: any ftyp/styp/moov/moof box at offset 4
    const tag = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (tag === "ftyp" || tag === "styp" || tag === "moov" || tag === "moof") {
      return "fmp4";
    }
  }
  if (bytes.byteLength >= 188 && bytes[0] === 0x47 && bytes[188] === 0x47) {
    return "mpegts";
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0) {
    // ADTS AAC sync (0xFFF…) or MPEG audio frame sync (0xFFE…).
    return (bytes[1] & 0x06) === 0 ? "aac" : "mp3";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "mp3"; // ID3-tagged MP3 (sometimes prepended to ADTS too).
  }
  return "unknown";
}

function extensionFor(format: StreamFormat): string {
  switch (format) {
    case "fmp4": return "mp4";
    case "mpegts": return "ts";
    case "aac": return "aac";
    case "mp3": return "mp3";
    default: return "bin";
  }
}

async function remuxFromStore(
  store: SegmentStore,
  hasAudio: boolean,
  jobId: string,
): Promise<RemuxOutput> {
  const ff = await getFfmpeg();

  const videoFile = await store.getMergedFile("v");
  if (!videoFile) throw new Error("Consolidated video file is empty.");
  const videoFmt = await detectFormatFromFile(videoFile);

  let audioFile: File | undefined;
  let audioFmt: StreamFormat = "unknown";
  if (hasAudio) {
    audioFile = await store.getMergedFile("a");
    if (audioFile) audioFmt = await detectFormatFromFile(audioFile);
  }

  // WORKERFS exposes the OPFS-backed merged file(s) to the ffmpeg worker by
  // name; the muxer reads them lazily, so MEMFS never has to hold the
  // 2 GB input the previous pipeline needed. We unmount no matter how the
  // run ends so a retry doesn't see a stale mount layered on the previous
  // attempt's files.
  await ensureFfInputDir(ff);
  await ff.mount(FFFSType.WORKERFS, {
    blobs: [
      { name: "video.bin", data: videoFile },
      ...(audioFile ? [{ name: "audio.bin", data: audioFile }] : []),
    ],
  }, FF_INPUT_MOUNT);

  // ADTS audio inside an MP4 container needs the aac_adtstoasc bitstream
  // filter; fMP4 audio is already AudioSpecificConfig and rejects the
  // filter (ffmpeg errors out). MPEG-TS audio is usually ADTS-wrapped too,
  // so apply the same filter there. MP3 / fMP4 stay as-is.
  const needsAdtsToAsc = audioFmt === "aac" || audioFmt === "mpegts";
  const audioCopyArgs: string[] = needsAdtsToAsc
    ? ["-c:a", "copy", "-bsf:a", "aac_adtstoasc"]
    : ["-c:a", "copy"];

  const attempts: { args: string[]; reason: string }[] = audioFile
    ? [
        {
          reason: "copy-both",
          args: [
            "-i", FF_VIDEO_INPUT, "-i", FF_AUDIO_INPUT,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", ...audioCopyArgs,
            "-movflags", "+faststart",
            "-shortest",
          ],
        },
        {
          // Some CDN audio renditions ship as TS-wrapped AAC; treating them
          // as raw audio with -c copy fails. Re-encode audio as a last resort.
          reason: "copy-video-transcode-audio",
          args: [
            "-i", FF_VIDEO_INPUT, "-i", FF_AUDIO_INPUT,
            "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-shortest",
          ],
        },
      ]
    : [
        {
          reason: "copy-video-only",
          args: [
            "-i", FF_VIDEO_INPUT,
            "-c", "copy",
            "-movflags", "+faststart",
          ],
        },
      ];
  // Silence unused-var warnings on videoFmt while keeping the sniff for
  // future log/diagnostic surface — the format is announced in ffmpeg's log
  // tail anyway, but we still want the sniff for telemetry parity.
  void videoFmt;

  let lastErr: unknown;
  try {
    for (let i = 0; i < attempts.length; i++) {
      const output = `output-${i}.mp4`;
      ffmpegLogTail.length = 0;
      try {
        const code = await ff.exec([...attempts[i].args, output]);
        if (code !== 0) {
          throw new Error(`ffmpeg exited with code ${code} (${attempts[i].reason})`);
        }
        const out = await ff.readFile(output);
        if (typeof out === "string") {
          throw new Error("ffmpeg returned text, expected binary.");
        }
        const bytes = out as Uint8Array;
        if (bytes.byteLength < 1024) {
          throw new Error(`ffmpeg produced ${bytes.byteLength}-byte output (${attempts[i].reason})`);
        }
        await ff.deleteFile(output).catch(() => {});
        return { bytes, mimeType: "video/mp4", extension: ".mp4" };
      } catch (err) {
        lastErr = err;
        reportProgress({
          jobId,
          phase: "merging",
          ratio: 0.96,
          message: `Mux attempt "${attempts[i].reason}" failed; ${i + 1 < attempts.length ? "trying fallback" : "no more fallbacks"}.`,
        });
      }
    }
  } finally {
    await ff.unmount(FF_INPUT_MOUNT).catch(() => {});
  }

  throw new Error(`Mux failed: ${formatFfmpegError(lastErr)}`);
}

let ffInputDirReady = false;

async function ensureFfInputDir(
  ff: import("@ffmpeg/ffmpeg").FFmpeg,
): Promise<void> {
  if (ffInputDirReady) return;
  // createDir throws if the dir already exists from a prior session — we
  // don't bother distinguishing, the only path that needs the dir is mount
  // and that creates intermediate directories on demand on most ffmpeg
  // builds. Best-effort.
  await ff.createDir(FF_INPUT_MOUNT).catch(() => {});
  ffInputDirReady = true;
}

function formatFfmpegError(err: unknown): string {
  const msg = errorMessage(err);
  // Surface the tail of the ffmpeg log — that's where the demuxer or muxer
  // explains why it gave up. Keep it bounded so the popup stays readable.
  const log = ffmpegLogTail.slice(-12).join(" | ");
  return [msg, log].filter(Boolean).join(" — ") || "ffmpeg failed without details";
}

/* ------------------------ thumbnail extraction ------------------------ */
//
// Decodes a single keyframe out of the first media segment and returns it
// as a data URL. Goal: 240px-wide JPEG, ~10–20 KB. Used by the popup as a
// "Preview" affordance when no DOM-derived poster was available. The
// thumbnail extraction shares the same ffmpeg.wasm instance as the merge
// pipeline; the first call pays the wasm load tax (~2 s), subsequent
// calls are sub-second.

const THUMB_MAX_SAMPLE_BYTES = 6 * 1024 * 1024;

function sendThumbResult(streamId: string, dataUrl?: string, error?: string): void {
  void chrome.runtime
    .sendMessage({
      type: "thumb:result",
      streamId,
      dataUrl,
      error,
      target: "sw",
    } satisfies RuntimeMessage)
    .catch(() => {
      /* popup may be closed; SW still caches the result */
    });
}

async function runThumbnail(stream: DetectedStream): Promise<string> {
  const sample = await sampleStreamBytes(stream);
  if (!sample) throw new Error("Could not read a media sample.");
  return await extractThumbJpeg(sample.bytes, sample.format);
}

interface StreamSample {
  bytes: Uint8Array;
  format: StreamFormat;
}

async function sampleStreamBytes(stream: DetectedStream): Promise<StreamSample | undefined> {
  if (stream.kind === "hls") return await sampleHls(stream);
  if (stream.kind === "dash") return await sampleDash(stream);
  if (stream.kind === "mp4" || stream.kind === "audio") {
    // For direct files: a leading byte-range is enough for ffmpeg to find
    // the first keyframe in `moov`-at-front MP4s. CDN-served `audio/*`
    // files get the same treatment — the muxer can decode a few hundred
    // ms even from an MP3/AAC mid-stream.
    const bytes = await fetchBytes(stream.url, {
      Range: `bytes=0-${THUMB_MAX_SAMPLE_BYTES - 1}`,
    }).catch(() => fetchBytes(stream.url));
    return { bytes, format: detectFormat(bytes) };
  }
  return undefined;
}

async function sampleHls(stream: DetectedStream): Promise<StreamSample | undefined> {
  const playlistText = await fetchText(stream.url);
  const parsed = parseM3U8(playlistText, stream.url);

  let mediaUrl = stream.url;
  if (parsed.kind === "master") {
    if (parsed.drmSystems.length || !parsed.variants.length) return undefined;
    // Pick the *lowest* rendition we can find — frame extraction only needs
    // one keyframe and the lowest variant is fastest to fetch.
    const sorted = [...parsed.variants].sort(compareVariantsBest);
    const lowest = sorted[sorted.length - 1] ?? sorted[0];
    if (!lowest) return undefined;
    mediaUrl = lowest.uri;
  }

  const mediaText = parsed.kind === "media" ? playlistText : await fetchText(mediaUrl);
  const media = parseM3U8(mediaText, mediaUrl);
  if (media.kind !== "media" || !media.playlist.segments.length) return undefined;
  if (media.playlist.drmSystems.length) return undefined;

  const initBytes = media.playlist.initSegment
    ? await fetchInitSegment(media.playlist.initSegment).catch(() => undefined)
    : undefined;

  const firstSeg = media.playlist.segments[0];
  let segBytes = await fetchSegmentBytes(firstSeg);
  if (firstSeg.key) {
    // Resolve the AES-128 key just for this segment.
    const keyBytes = await fetchBytes(firstSeg.key.uri).catch(() => undefined);
    if (!keyBytes) return undefined;
    const iv = ivForSequence(firstSeg.key.iv, firstSeg.sequence);
    segBytes = await decryptAes128(segBytes, keyBytes, iv);
  }

  const merged = initBytes ? concatBytes(initBytes, segBytes) : segBytes;
  return { bytes: merged, format: detectFormat(merged) };
}

async function sampleDash(stream: DetectedStream): Promise<StreamSample | undefined> {
  const text = await fetchText(stream.url);
  const mpd = parseMpd(text, stream.url);
  const set = mpd.videoSets[0];
  if (!set || !set.representations.length) return undefined;
  // Lowest-bandwidth rep — fastest single-segment fetch.
  const rep = [...set.representations].sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (!rep || !rep.segments.length) return undefined;
  const initBytes = rep.initUrl
    ? await fetchBytes(rep.initUrl).catch(() => undefined)
    : undefined;
  const segBytes = await fetchBytes(rep.segments[0].uri);
  const merged = initBytes ? concatBytes(initBytes, segBytes) : segBytes;
  return { bytes: merged, format: detectFormat(merged) };
}

async function fetchSegmentBytes(seg: HlsSegment): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (seg.byteRange) {
    headers.Range = `bytes=${seg.byteRange.offset}-${seg.byteRange.offset + seg.byteRange.length - 1}`;
  }
  return fetchBytes(seg.uri, headers);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

async function extractThumbJpeg(bytes: Uint8Array, format: StreamFormat): Promise<string> {
  const ff = await getFfmpeg();
  const inputName = `thumb-in.${extensionFor(format)}`;
  const outputName = "thumb-out.jpg";
  ffmpegLogTail.length = 0;
  await ff.writeFile(inputName, bytes);
  // -ss 0 + -frames:v 1 yields the first decodable frame; -an drops audio
  // streams (some MP3-only "video" files would otherwise demux as audio).
  const code = await ff.exec([
    "-i", inputName,
    "-an",
    "-frames:v", "1",
    "-vf", "scale=240:-2",
    "-q:v", "5",
    outputName,
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg thumb extraction failed: ${formatFfmpegError(undefined)}`);
  }
  const out = await ff.readFile(outputName);
  if (typeof out === "string") throw new Error("ffmpeg returned text, expected JPEG.");
  const jpeg = out as Uint8Array;
  if (jpeg.byteLength < 100) {
    throw new Error(`ffmpeg produced a ${jpeg.byteLength}-byte thumb (likely empty).`);
  }
  // ffmpeg.wasm's MEMFS retains files between calls; clean up so a long
  // session doesn't accumulate megabytes of stale thumbnails.
  await ff.deleteFile(inputName).catch(() => {});
  await ff.deleteFile(outputName).catch(() => {});
  return await bytesToDataUrl(jpeg, "image/jpeg");
}

/**
 * Bytes → `data:` URL via the browser's native FileReader path. Avoids the
 * `String.fromCharCode(...subarray)` argument-spread that previously blew
 * the stack on JPEGs the size of a stack frame, and avoids the GC pressure
 * of accumulating megabytes of intermediate strings.
 */
function bytesToDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("FileReader produced non-string result."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.readAsDataURL(new Blob([toArrayBuffer(bytes)], { type: mimeType }));
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof HttpStatusError) {
    return `${err.message} for ${err.url}`;
  }
  if (err instanceof FetchTimeoutError) {
    return `Network timeout (${err.ms}ms) for ${err.url}`;
  }
  if (err instanceof FetchAbortedError) {
    return `Network request aborted: ${err.url}`;
  }
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }
  return String(err || "unknown");
}

/** A 4xx response will not magically heal between attempts; retrying just
 *  delays the inevitable. 5xx and network/timeout errors are worth retrying. */
function isRetriable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof FetchTimeoutError) return true;
  if (err instanceof FetchAbortedError) return false; // user/system aborted
  return true; // unknown network glitch — give it another shot
}

function withExtension(filename: string, extension: string): string {
  return filename.replace(/\.[a-z0-9]{1,5}$/i, "") + extension;
}

/* --------------------------- subtitles --------------------------- */
//
// Best-effort WebVTT pipeline. HLS subtitle playlists serve raw .vtt
// segments; DASH usually serves raw .vtt too, but some assets wrap them in
// fMP4 wvtt boxes which we currently pass through as-is (the file ends up
// unplayable — flag with `Subtitles unsupported` in the message stream).

function reportSubtitleError(jobId: string, err: unknown): void {
  reportProgress({
    jobId,
    phase: "saving",
    ratio: 0.99,
    message: `Subtitle download failed: ${errorMessage(err)}`,
  });
}

async function downloadSubtitleHls(
  stream: DetectedStream,
  renditions: HlsRendition[],
  subtitleId: string,
): Promise<void> {
  const rendition = renditions.find(
    (r) => r.type === "SUBTITLES" && `${r.groupId}::${r.name}` === subtitleId,
  );
  if (!rendition?.uri) return;

  const playlistText = await fetchText(rendition.uri);
  const parsed = parseM3U8(playlistText, rendition.uri);
  if (parsed.kind !== "media" || !parsed.playlist.segments.length) return;

  const parts = await Promise.all(parsed.playlist.segments.map((s) => fetchText(s.uri)));
  await saveSubtitle(stream, parts, rendition.language);
}

async function downloadSubtitleDash(
  stream: DetectedStream,
  textSets: DashAdaptationSet[],
  subtitleId: string,
): Promise<void> {
  const parsed = parseDashId(subtitleId, DASH_TEXT_PREFIX);
  if (!parsed) return;
  const set = textSets.find((s) => s.id === parsed.setId);
  const rep = set?.representations.find((r) => r.id === parsed.repId);
  if (!set || !rep || !rep.segments.length) return;

  const parts: string[] = [];
  for (const seg of rep.segments) parts.push(await fetchText(seg.uri));
  await saveSubtitle(stream, parts, set.lang);
}

async function saveSubtitle(
  stream: DetectedStream,
  parts: string[],
  language: string | undefined,
): Promise<void> {
  if (!parts.length) return;
  const isVtt = parts[0].trimStart().startsWith("WEBVTT");
  const merged = isVtt ? mergeWebVtt(parts) : parts.join("\n");
  const filename = subtitleFilename(stream.suggestedName, language, isVtt);
  const blob = new Blob([merged], { type: isVtt ? "text/vtt" : "text/plain" });
  const url = URL.createObjectURL(blob);
  try {
    await requestSwDownload(url, filename, false);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function subtitleFilename(
  videoName: string,
  language: string | undefined,
  isVtt: boolean,
): string {
  const stripped = videoName.replace(/\.(mp4|m4v|webm|mkv|mov|ts)$/i, "");
  const langTag = language ? `.${language}` : "";
  const ext = isVtt ? ".vtt" : ".txt";
  return `${stripped}${langTag}${ext}`;
}

/** Strip per-segment WEBVTT headers, apply X-TIMESTAMP-MAP MPEGTS offsets so
 *  cue times stay monotonic across segment boundaries, prepend a single
 *  WEBVTT header. */
export function mergeWebVtt(parts: string[]): string {
  const cueChunks: string[] = [];
  for (const part of parts) {
    const offsetSec = parseTimestampMapOffset(part);
    const body = stripVttHeader(part);
    if (!body) continue;
    cueChunks.push(offsetSec ? offsetCueTimes(body, offsetSec) : body);
  }
  return `WEBVTT\n\n${cueChunks.join("\n").trim()}\n`;
}

function parseTimestampMapOffset(vtt: string): number {
  const m = /X-TIMESTAMP-MAP\s*=[^\n]*MPEGTS\s*[:=]\s*(\d+)/i.exec(vtt);
  return m ? Number(m[1]) / 90000 : 0;
}

function stripVttHeader(vtt: string): string {
  // Header is everything up to the first blank line.
  const idx = vtt.search(/\r?\n\r?\n/);
  return idx < 0 ? "" : vtt.slice(idx).replace(/^\s+/, "");
}

const VTT_TIMESTAMP_RE = /(\d{2,}:[0-5]\d:[0-5]\d\.\d{3})\s+-->\s+(\d{2,}:[0-5]\d:[0-5]\d\.\d{3})/g;

function offsetCueTimes(body: string, offsetSec: number): string {
  return body.replace(
    VTT_TIMESTAMP_RE,
    (_, a: string, b: string) => `${addOffset(a, offsetSec)} --> ${addOffset(b, offsetSec)}`,
  );
}

function addOffset(timestamp: string, offsetSec: number): string {
  if (!offsetSec) return timestamp;
  const [hh, mm, ssMs] = timestamp.split(":");
  const [ss, ms] = ssMs.split(".");
  const total =
    Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000 + offsetSec;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(millis)}`;
}
function pad2(n: number): string { return String(n).padStart(2, "0"); }
function pad3(n: number): string { return String(n).padStart(3, "0"); }

/* --------------------------- MSE capture ----------------------------- */
//
// Page-side `SourceBuffer.appendBuffer` payloads land here as `mse:chunk`
// messages. Each session corresponds to one SourceBuffer in the page (so
// audio + video on a multi-track player are kept distinct). Chunks are
// streamed to OPFS as a single growing per-session file so we don't burn
// JS heap on the bytes — ffmpeg mounts the file via WORKERFS at finalise
// time, just like the HLS / DASH pipeline.

const MSE_DIR = "msg-mse";
const mseWritables = new Map<string, FileSystemWritableFileStream>();
const mseSessionMime = new Map<string, string | undefined>();

async function getMseDir(): Promise<FileSystemDirectoryHandle | undefined> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return undefined;
  }
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(MSE_DIR, { create: true });
}

async function appendMseChunk(
  sessionId: string,
  bytes: Uint8Array | { [k: number]: number; length?: number },
  _ordinal: number,
  mimeType: string | undefined,
  _isInit: boolean,
): Promise<void> {
  const dir = await getMseDir();
  if (!dir) return;
  let writable = mseWritables.get(sessionId);
  if (!writable) {
    const handle = await dir.getFileHandle(`${sessionId}.bin`, { create: true });
    writable = await handle.createWritable({ keepExistingData: true });
    mseWritables.set(sessionId, writable);
    if (mimeType) mseSessionMime.set(sessionId, mimeType);
  }
  const view =
    bytes instanceof Uint8Array
      ? bytes
      : (() => {
          // Structured-clone may have flattened the Uint8Array into a
          // plain object with numeric keys — defensive shape coercion.
          const len = typeof bytes.length === "number" ? bytes.length : Object.keys(bytes).length;
          const u = new Uint8Array(len);
          for (let i = 0; i < len; i++) u[i] = bytes[i] ?? 0;
          return u;
        })();
  // Wrap as Blob — same trick as segmentStorage.asWritableChunk: dodges
  // the strict lib.dom rejection of `Uint8Array<ArrayBufferLike>`.
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  await writable.write(new Blob([copy]));
}

async function finaliseMseSession(
  sessionId: string,
  suggestedName: string,
): Promise<void> {
  const writable = mseWritables.get(sessionId);
  if (writable) {
    await writable.close().catch(() => {});
    mseWritables.delete(sessionId);
  }
  const dir = await getMseDir();
  if (!dir) {
    reportProgress({
      jobId: sessionId,
      phase: "error",
      ratio: 0,
      error: "OPFS unavailable — MSE capture has nothing to save.",
    });
    return;
  }
  const fileHandle = await dir.getFileHandle(`${sessionId}.bin`).catch(() => undefined);
  if (!fileHandle) {
    reportProgress({
      jobId: sessionId,
      phase: "error",
      ratio: 0,
      error: "MSE session has no captured bytes.",
    });
    return;
  }
  const file = await fileHandle.getFile();
  if (file.size === 0) {
    reportProgress({
      jobId: sessionId,
      phase: "error",
      ratio: 0,
      error: "MSE session produced 0 bytes.",
    });
    return;
  }

  // Try to remux the captured bytes into a clean MP4 — most MSE buffers
  // are fMP4 in practice. Fall back to raw `.bin` save when ffmpeg refuses
  // the input (rare; some ABR players hand the SourceBuffer init segments
  // out of order and the remux fails).
  reportProgress({
    jobId: sessionId,
    phase: "merging",
    ratio: 0.9,
    message: `Remuxing MSE capture (${(file.size / 1024 / 1024).toFixed(1)} MB)…`,
  });
  try {
    const ff = await getFfmpeg();
    await ensureFfInputDir(ff);
    await ff.mount(FFFSType.WORKERFS, {
      blobs: [{ name: "mse.bin", data: file }],
    }, FF_INPUT_MOUNT);
    try {
      const output = "mse-out.mp4";
      ffmpegLogTail.length = 0;
      const code = await ff.exec([
        "-i", `${FF_INPUT_MOUNT}/mse.bin`,
        "-c", "copy",
        "-movflags", "+faststart",
        output,
      ]);
      if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
      const out = await ff.readFile(output);
      if (typeof out === "string") throw new Error("ffmpeg returned text.");
      const bytes = out as Uint8Array;
      await ff.deleteFile(output).catch(() => {});
      reportProgress({ jobId: sessionId, phase: "saving", ratio: 0.99 });
      await saveBlob(
        new Blob([toArrayBuffer(bytes)], { type: "video/mp4" }),
        withExtension(suggestedName, ".mp4"),
      );
      reportProgress({ jobId: sessionId, phase: "done", ratio: 1 });
    } finally {
      await ff.unmount(FF_INPUT_MOUNT).catch(() => {});
    }
  } catch (err) {
    // Fallback: save the raw captured bytes as `.bin`. Better a partly-
    // playable file than nothing — many MP4 inspectors will still load it.
    reportProgress({
      jobId: sessionId,
      phase: "saving",
      ratio: 0.95,
      message: `Mux failed (${errorMessage(err)}); saving raw capture.`,
    });
    await saveBlob(
      new Blob([await file.arrayBuffer()], { type: "application/octet-stream" }),
      withExtension(suggestedName, ".bin"),
    );
    reportProgress({ jobId: sessionId, phase: "done", ratio: 1 });
  } finally {
    // Clean up the OPFS file so a follow-up capture under the same id
    // doesn't append to the previous run's bytes.
    await dir.removeEntry(`${sessionId}.bin`).catch(() => {});
    mseSessionMime.delete(sessionId);
  }
}

/* ------------------------- save ------------------------- */
//
// chrome.downloads is not exposed in offscreen documents — calling it here
// throws "Cannot read properties of undefined (reading 'download')". Route
// the actual download through the service worker, which does have the API.
// The offscreen document keeps the generated blob URL alive long enough for
// the SW to pass it to chrome.downloads.

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await requestSwDownload(url, filename, true);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

async function requestSwDownload(
  url: string,
  filename: string,
  saveAs: boolean,
): Promise<void> {
  const resp = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "downloads:save",
        url,
        filename,
        saveAs,
        target: "sw",
      } satisfies RuntimeMessage,
      (response: { ok: boolean; error?: string } | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(`Failed to hand off download to service worker: ${err.message}`));
          return;
        }
        resolve(response ?? { ok: false, error: "No response from service worker." });
      },
    );
  });
  if (!resp?.ok) {
    throw new Error(resp?.error || "Service worker failed to save the file.");
  }
}
