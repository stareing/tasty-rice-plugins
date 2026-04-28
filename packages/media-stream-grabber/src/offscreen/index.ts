/**
 * Offscreen worker — runs in a regular DOM page, so it can use fetch(),
 * SharedArrayBuffer (when COOP/COEP allow), Web Workers, IndexedDB and
 * ffmpeg.wasm.
 *
 * Listens for `download:probe` (returns variants/audio tracks) and
 * `download:start` (runs the HLS/DASH pipeline, with segment-level retries
 * and IDB-backed resume). Routes only messages whose `target` is
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

const cancelled = new Set<string>();
const SEGMENT_RETRIES = 3;
const SEGMENT_RETRY_DELAY_MS = 600;
const SEGMENT_CONCURRENCY = 6;
const IDB_NAME = "msg.segments";
const IDB_STORE = "buffers";
const DASH_KEY_PREFIX = "dash::";
const DASH_AUDIO_PREFIX = "dash-audio::";
const DASH_TEXT_PREFIX = "dash-text::";
const HLS_CHILD_PLAYLIST_RE = /_(?:\d+w|audio)\.m3u8(\?|$|#)/i;

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

async function fetchBytes(
  url: string,
  headers?: Record<string, string>,
): Promise<Uint8Array> {
  const res = await fetch(url, { headers, credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
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

/* ---------------------------- IDB segment cache ----------------------- */
//
// Persist downloaded segments by (jobId, channel, index) so SW restart
// doesn't waste the user's bandwidth. Cleared on job completion or cancel.

let idbPromise: Promise<IDBDatabase> | null = null;

function openIdb(): Promise<IDBDatabase> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

function idbKey(jobId: string, channel: "v" | "a", index: number): string {
  return `${jobId}::${channel}::${index}`;
}

async function idbGet(key: string): Promise<Uint8Array | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: Uint8Array): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClearJob(jobId: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const key = String(cursor.key);
      if (key.startsWith(`${jobId}::`)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
    reportProbe(jobId, { variants: [], audioTracks: [], subtitleTracks: [], singlePlaylist: true });
    return;
  }

  const variants: VariantOption[] = parsed.variants.map((v) => ({
    uri: v.uri,
    bandwidth: v.bandwidth,
    resolution: v.resolution,
    height: v.height,
    codecs: v.codecs,
    audioGroup: v.audioGroup,
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

  reportProbe(jobId, {
    variants,
    audioTracks,
    subtitleTracks,
    singlePlaylist: false,
    recommendedVariantUri,
    recommendedAudioId,
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
  if (stream.kind === "hls") {
    await runDownloadHls(stream, jobId, selection);
    return;
  }
  if (stream.kind === "dash") {
    await runDownloadDash(stream, jobId, selection);
    return;
  }
  throw new Error(`Offscreen pipeline does not handle kind=${stream.kind}.`);
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
    u.pathname = u.pathname.replace(/_(?:\d+w|audio)\.m3u8$/i, ".m3u8");
    return u.toString();
  } catch {
    return url.replace(/_(?:\d+w|audio)\.m3u8(\?|$|#)/i, ".m3u8$1");
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
  if (!/_(?:\d+w)\.m3u8(\?|$|#)/i.test(videoPlaylistUrl)) return undefined;
  try {
    const u = new URL(videoPlaylistUrl);
    u.pathname = u.pathname.replace(/_\d+w\.m3u8$/i, "_audio.m3u8");
    return u.toString();
  } catch {
    return videoPlaylistUrl.replace(/_\d+w\.m3u8(\?|$|#)/i, "_audio.m3u8$1");
  }
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
  const videoBytes = await downloadChannel(
    { channel: "v", segments: videoSegments, initBytes: videoInit },
    jobId,
    keyCache,
    "downloading-segments",
  );

  let audioBytes: Uint8Array | undefined;
  if (audioSegments && audioSegments.length) {
    audioBytes = await downloadChannel(
      { channel: "a", segments: audioSegments, initBytes: audioInit },
      jobId,
      keyCache,
      "downloading-audio",
    );
  }

  reportProgress({ jobId, phase: "merging", ratio: 0.95, message: "Remuxing to MP4…" });
  const output = await remuxToPlayable(videoBytes, audioBytes, jobId);

  reportProgress({ jobId, phase: "saving", ratio: 0.99 });
  await saveBlob(
    new Blob([toArrayBuffer(output.bytes)], { type: output.mimeType }),
    withExtension(stream.suggestedName, output.extension),
  );

  reportProgress({ jobId, phase: "done", ratio: 1 });
  await idbClearJob(jobId);
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
  keyCache: Map<string, Uint8Array>,
  phaseName: "downloading-segments" | "downloading-audio",
): Promise<Uint8Array> {
  const { segments, initBytes } = job;
  const buffers = new Array<Uint8Array | null>(segments.length).fill(null);
  let done = 0;
  let cursor = 0;
  let totalRetries = 0;

  // Hydrate from IDB to skip already-downloaded segments.
  for (let i = 0; i < segments.length; i++) {
    const cached = await idbGet(idbKey(jobId, job.channel, i));
    if (cached) {
      buffers[i] = cached;
      done++;
    }
  }
  if (done) {
    reportProgress({
      jobId,
      phase: phaseName,
      ratio: done / segments.length,
      segmentsDone: done,
      segmentsTotal: segments.length,
      message: `Resumed ${done}/${segments.length} from cache.`,
    });
  } else {
    reportProgress({
      jobId,
      phase: phaseName,
      ratio: 0,
      segmentsDone: 0,
      segmentsTotal: segments.length,
    });
  }

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
      while (cursor < segments.length && buffers[cursor] !== null) cursor++;

      while (active < SEGMENT_CONCURRENCY && cursor < segments.length) {
        const idx = cursor++;
        if (buffers[idx] !== null) continue;
        active++;
        void downloadSegmentWithRetry(segments[idx], idx, keyCache)
          .then(async ({ bytes, retries }) => {
            buffers[idx] = bytes;
            totalRetries += retries;
            done++;
            await idbSet(idbKey(jobId, job.channel, idx), bytes).catch(() => {
              /* IDB best effort */
            });
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

  // Concatenate: init segment first (if fMP4), then media segments in order.
  const initLen = initBytes?.byteLength ?? 0;
  const totalLen = buffers.reduce((acc, b) => acc + (b?.byteLength ?? 0), initLen);
  const concatenated = new Uint8Array(totalLen);
  let off = 0;
  if (initBytes) {
    concatenated.set(initBytes, 0);
    off = initBytes.byteLength;
  }
  for (const b of buffers) {
    if (!b) continue;
    concatenated.set(b, off);
    off += b.byteLength;
  }
  return concatenated;
}

async function downloadSegmentWithRetry(
  seg: HlsSegment,
  index: number,
  keyCache: Map<string, Uint8Array>,
): Promise<{ bytes: Uint8Array; retries: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
    try {
      const bytes = await downloadSegment(seg, index, keyCache);
      return { bytes, retries: attempt };
    } catch (err) {
      lastErr = err;
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
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (seg.byteRange) {
    headers.Range = `bytes=${seg.byteRange.offset}-${seg.byteRange.offset + seg.byteRange.length - 1}`;
  }
  let bytes = await fetchBytes(seg.uri, headers);
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

let ffmpegPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;
const ffmpegLogTail: string[] = [];

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ff = new FFmpeg();
      ff.on("log", ({ message }) => {
        if (!message) return;
        ffmpegLogTail.push(message);
        if (ffmpegLogTail.length > 20) ffmpegLogTail.shift();
      });
      const coreURL = chrome.runtime.getURL("ffmpeg/ffmpeg-core.js");
      const wasmURL = chrome.runtime.getURL("ffmpeg/ffmpeg-core.wasm");
      await ff.load({
        coreURL,
        wasmURL,
      });
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

async function remuxToPlayable(
  videoBytes: Uint8Array,
  audioBytes: Uint8Array | undefined,
  jobId: string,
): Promise<RemuxOutput> {
  const ff = await getFfmpeg();
  await ff.writeFile("video.bin", videoBytes);
  if (audioBytes) await ff.writeFile("audio.bin", audioBytes);

  const attempts = audioBytes
    ? [
        [
          "-i", "video.bin",
          "-i", "audio.bin",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c", "copy",
          "-shortest",
        ],
        [
          "-i", "video.bin",
          "-i", "audio.bin",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c", "copy",
          "-bsf:a", "aac_adtstoasc",
          "-shortest",
        ],
        [
          "-fflags", "+genpts",
          "-i", "video.bin",
          "-i", "audio.bin",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c", "copy",
          "-shortest",
        ],
        [
          "-i", "video.bin",
          "-i", "audio.bin",
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c:v", "copy",
          "-c:a", "aac",
          "-b:a", "160k",
          "-shortest",
        ],
      ]
    : [
        ["-i", "video.bin", "-c", "copy"],
        ["-i", "video.bin", "-c", "copy", "-bsf:a", "aac_adtstoasc"],
      ];

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const output = `output-${i}.mp4`;
    try {
      const code = await ff.exec([...attempts[i], output]);
      if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
      await assertPlayableOutput(ff, output, Boolean(audioBytes));
      const out = await ff.readFile(output);
      if (typeof out === "string") throw new Error("ffmpeg returned text, expected binary.");
      return { bytes: out as Uint8Array, mimeType: "video/mp4", extension: ".mp4" };
    } catch (err) {
      lastErr = err;
    }
  }

  if (audioBytes) {
    reportProgress({
      jobId,
      phase: "merging",
      ratio: 0.97,
      message: `ffmpeg mux failed; trying Chrome MediaRecorder fallback. ${formatFfmpegError(lastErr)}`,
    });
    try {
      const webm = await recordWithChromeMediaRecorder(videoBytes, audioBytes);
      return { bytes: webm, mimeType: "video/webm", extension: ".webm" };
    } catch (nativeErr) {
      const nativeMsg = errorMessage(nativeErr);
      throw new Error(
        `Audio was downloaded, but neither ffmpeg nor Chrome MediaRecorder could mux it. ffmpeg: ${formatFfmpegError(lastErr)}. native: ${nativeMsg}`,
      );
    }
  }

  try {
    reportProgress({
      jobId,
      phase: "merging",
      ratio: 0.97,
      message: `Video-only remux failed (${formatFfmpegError(lastErr)}); saving raw bytes.`,
    });
    return { bytes: videoBytes, mimeType: "video/mp4", extension: ".mp4" };
  } catch {
    return { bytes: videoBytes, mimeType: "video/mp4", extension: ".mp4" };
  }
}

async function assertPlayableOutput(
  ff: import("@ffmpeg/ffmpeg").FFmpeg,
  filename: string,
  requireAudio: boolean,
): Promise<void> {
  const probeFile = `${filename}.probe.txt`;
  const code = await ff.ffprobe([
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    filename,
    "-o", probeFile,
  ]);
  if (code !== 0) throw new Error(`ffprobe exited with code ${code}`);
  const raw = await ff.readFile(probeFile, "utf8");
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const streams = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!streams.includes("video")) throw new Error("ffmpeg output has no video track.");
  if (requireAudio && !streams.includes("audio")) {
    throw new Error("ffmpeg output has no audio track.");
  }
}

async function recordWithChromeMediaRecorder(
  videoBytes: Uint8Array,
  audioBytes: Uint8Array,
): Promise<Uint8Array> {
  if (!("MediaSource" in self)) throw new Error("MediaSource is unavailable.");
  if (!("MediaRecorder" in self)) throw new Error("MediaRecorder is unavailable.");

  const videoMime = pickSupportedMime([
    'video/mp4; codecs="avc1.64001f"',
    'video/mp4; codecs="avc1.4d401f"',
    'video/mp4; codecs="avc1.42e01e"',
    'video/mp4; codecs="hvc1"',
    "video/mp4",
  ]);
  const audioMime = pickSupportedMime([
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/mp4; codecs="mp4a.40.5"',
    "audio/mp4",
  ]);
  if (!videoMime || !audioMime) {
    throw new Error("Chrome cannot append these MP4 tracks via MediaSource.");
  }

  const mediaSource = new MediaSource();
  const video = document.createElement("video");
  video.playsInline = true;
  video.volume = 1;
  video.src = URL.createObjectURL(mediaSource);
  document.body.append(video);

  try {
    await once(mediaSource, "sourceopen");
    const videoBuffer = mediaSource.addSourceBuffer(videoMime);
    const audioBuffer = mediaSource.addSourceBuffer(audioMime);
    await appendSourceBuffer(videoBuffer, videoBytes);
    await appendSourceBuffer(audioBuffer, audioBytes);
    mediaSource.endOfStream();

    await video.play();
    const stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
    const recorderMime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
      ? "video/webm;codecs=vp9,opus"
      : "video/webm";
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType: recorderMime });
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = once(recorder, "stop");
    recorder.start(1000);
    if (!stream.getAudioTracks().length) {
      throw new Error("MediaSource produced no audio track.");
    }
    await Promise.race([
      once(video, "ended"),
      sleep(Math.max(30_000, Math.ceil((video.duration || 0) * 1000) + 5000)),
    ]);
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (!chunks.length) throw new Error("MediaRecorder produced no data.");
    return new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
  } finally {
    URL.revokeObjectURL(video.src);
    video.remove();
  }
}

function pickSupportedMime(candidates: string[]): string | undefined {
  return candidates.find((mime) => MediaSource.isTypeSupported(mime));
}

function appendSourceBuffer(buffer: SourceBuffer, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      buffer.removeEventListener("updateend", onDone);
      buffer.removeEventListener("error", onError);
    };
    const onDone = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("SourceBuffer append failed."));
    };
    buffer.addEventListener("updateend", onDone, { once: true });
    buffer.addEventListener("error", onError, { once: true });
    buffer.appendBuffer(toArrayBuffer(bytes));
  });
}

function once(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve, reject) => {
    target.addEventListener(type, resolve, { once: true });
    target.addEventListener("error", () => reject(new Error(`${type} failed.`)), { once: true });
  });
}

function formatFfmpegError(err: unknown): string {
  const msg = errorMessage(err);
  const log = ffmpegLogTail.slice(-6).join(" | ");
  return [msg, log].filter(Boolean).join(" — ") || "ffmpeg failed without details";
}

function errorMessage(err: unknown): string {
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
