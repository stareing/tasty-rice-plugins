/**
 * Offscreen worker — runs in a regular DOM page, so it can use fetch(),
 * SharedArrayBuffer (when COOP/COEP allow), Web Workers, and ffmpeg.wasm.
 *
 * It listens for `download:start` messages from the background SW, runs the
 * HLS pipeline, and streams progress back. All heavy work happens here so the
 * SW (which can be evicted at any time) is not blocked.
 */

import type {
  DetectedStream,
  DownloadProgress,
  RuntimeMessage,
} from "@/lib/types";
import { parseM3U8, type HlsSegment } from "@/lib/m3u8";

const cancelled = new Set<string>();

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === "download:start") {
    void runHls(msg.stream, msg.jobId).catch((err) => {
      reportProgress({
        jobId: msg.jobId,
        phase: "error",
        ratio: 0,
        error: (err as Error).message,
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
  .sendMessage({ type: "offscreen:ready" } satisfies RuntimeMessage)
  .catch(() => {
    /* SW may not be listening yet — non-fatal */
  });

function reportProgress(p: DownloadProgress): void {
  void chrome.runtime.sendMessage({ type: "download:progress", payload: p } satisfies RuntimeMessage);
}

async function fetchBytes(url: string, headers?: Record<string, string>): Promise<Uint8Array> {
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

/* --- AES-128 segment decryption (HLS keys are 16 bytes, IV 16 bytes) --- */

/** Copy a Uint8Array into a fresh ArrayBuffer — needed because TS DOM types
 * require BufferSource (ArrayBufferView<ArrayBuffer>) and our buffers may be
 * typed as ArrayBufferLike (could in theory be SharedArrayBuffer). */
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
  // Big-endian sequence number in the last 4 bytes — per RFC 8216.
  iv[12] = (sequence >>> 24) & 0xff;
  iv[13] = (sequence >>> 16) & 0xff;
  iv[14] = (sequence >>> 8) & 0xff;
  iv[15] = sequence & 0xff;
  return iv;
}

/* ------------------------- HLS pipeline ------------------------- */

async function runHls(stream: DetectedStream, jobId: string): Promise<void> {
  if (stream.kind !== "hls") {
    throw new Error(`Offscreen pipeline only handles HLS (got ${stream.kind}).`);
  }

  reportProgress({ jobId, phase: "fetching-playlist", ratio: 0, message: "Fetching playlist…" });

  let playlistUrl = stream.url;
  let parsed = parseM3U8(await fetchText(playlistUrl), playlistUrl);

  // Master playlist → pick the top-bandwidth variant and refetch.
  if (parsed.kind === "master") {
    const top = parsed.variants[0];
    if (!top) throw new Error("Master playlist has no variants.");
    playlistUrl = top.uri;
    parsed = parseM3U8(await fetchText(playlistUrl), playlistUrl);
  }
  if (parsed.kind !== "media") throw new Error("Failed to resolve media playlist.");

  const { segments } = parsed.playlist;
  if (!segments.length) throw new Error("Playlist contains no segments.");

  // Resolve unique key URIs once — most playlists reuse a single key.
  const keyCache = new Map<string, Uint8Array>();
  for (const seg of segments) {
    if (seg.key && !keyCache.has(seg.key.uri)) {
      keyCache.set(seg.key.uri, await fetchBytes(seg.key.uri));
    }
  }

  reportProgress({
    jobId,
    phase: "downloading-segments",
    ratio: 0,
    segmentsDone: 0,
    segmentsTotal: segments.length,
  });

  const concurrency = 6;
  const buffers = new Array<Uint8Array | null>(segments.length).fill(null);
  let done = 0;
  let cursor = 0;

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
      while (active < concurrency && cursor < segments.length) {
        const idx = cursor++;
        active++;
        void downloadSegment(segments[idx], idx, keyCache)
          .then((bytes) => {
            buffers[idx] = bytes;
            done++;
            reportProgress({
              jobId,
              phase: "downloading-segments",
              ratio: done / segments.length,
              segmentsDone: done,
              segmentsTotal: segments.length,
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

  // All segments are MPEG-TS — concatenation is byte-safe.
  const totalLen = buffers.reduce((acc, b) => acc + (b?.byteLength ?? 0), 0);
  const concatenated = new Uint8Array(totalLen);
  let off = 0;
  for (const b of buffers) {
    if (!b) continue;
    concatenated.set(b, off);
    off += b.byteLength;
  }

  reportProgress({ jobId, phase: "merging", ratio: 0.95, message: "Remuxing to MP4…" });
  const mp4 = await remuxTsToMp4(concatenated, jobId);

  reportProgress({ jobId, phase: "saving", ratio: 0.99 });
  await saveBlob(new Blob([toArrayBuffer(mp4)], { type: "video/mp4" }), stream.suggestedName);

  reportProgress({ jobId, phase: "done", ratio: 1 });
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
    const iv = ivForSequence(seg.key.iv, index);
    bytes = await decryptAes128(bytes, keyBytes, iv);
  }
  return bytes;
}

/* ------------------------- ffmpeg.wasm remux ------------------------- */

let ffmpegPromise: Promise<import("@ffmpeg/ffmpeg").FFmpeg> | null = null;

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ff = new FFmpeg();
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      await ff.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ff;
    })();
  }
  return ffmpegPromise;
}

async function remuxTsToMp4(ts: Uint8Array, jobId: string): Promise<Uint8Array> {
  try {
    const ff = await getFfmpeg();
    await ff.writeFile("input.ts", ts);
    // -c copy avoids re-encoding; this is a remux not a transcode.
    await ff.exec(["-i", "input.ts", "-c", "copy", "-bsf:a", "aac_adtstoasc", "output.mp4"]);
    const out = await ff.readFile("output.mp4");
    if (typeof out === "string") throw new Error("ffmpeg returned text, expected binary.");
    return out as Uint8Array;
  } catch (err) {
    // Fallback: ship the raw TS so the user at least gets the bytes.
    reportProgress({
      jobId,
      phase: "merging",
      ratio: 0.97,
      message: `Remux failed (${(err as Error).message}); saving as .ts.`,
    });
    return ts;
  }
}

/* ------------------------- save ------------------------- */

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: true });
  } finally {
    // Revoke after a short delay to make sure the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
