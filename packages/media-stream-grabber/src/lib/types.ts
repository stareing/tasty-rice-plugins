export type StreamKind = "hls" | "dash" | "mp4" | "audio" | "image" | "other";

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
  /** Referer header — required by some CDNs to allow segment fetches. */
  referer?: string;
  detectedAt: number;
}

export type DownloadPhase =
  | "idle"
  | "fetching-playlist"
  | "downloading-segments"
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
  bytesDone?: number;
  message?: string;
  error?: string;
}

/* ---- Message envelope between popup ⇄ background ⇄ offscreen ---- */

export type RuntimeMessage =
  | { type: "streams:list"; tabId: number }
  | { type: "streams:list:result"; streams: DetectedStream[] }
  | { type: "streams:clear"; tabId: number }
  | { type: "streams:added"; tabId: number; stream: DetectedStream }
  | { type: "download:start"; stream: DetectedStream; jobId: string }
  | { type: "download:progress"; payload: DownloadProgress }
  | { type: "download:cancel"; jobId: string }
  | { type: "offscreen:ready" };
