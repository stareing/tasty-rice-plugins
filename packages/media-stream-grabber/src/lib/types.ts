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
  /** Frame the request originated from — drives precise context-menu attribution. */
  frameId?: number;
  /** Referer header — required by some CDNs to allow segment fetches. */
  referer?: string;
  detectedAt: number;
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

export interface VariantOption {
  /** Playlist URI for this video rendition. */
  uri: string;
  bandwidth: number;
  /** "1920x1080" if announced. */
  resolution?: string;
  /** Parsed height in pixels — sortable. 0 when unknown. */
  height: number;
  codecs?: string;
  /** Audio group id if the variant references one. */
  audioGroup?: string;
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
    | { type: "streams:report-direct"; url: string; pageTitle: string; pageUrl: string }
    | { type: "download:probe"; stream: DetectedStream; jobId: string }
    | { type: "download:probe:result"; jobId: string; result: ProbeResult }
    | {
        type: "download:start";
        stream: DetectedStream;
        jobId: string;
        selection: DownloadSelection;
      }
    | { type: "download:progress"; payload: DownloadProgress }
    | { type: "download:cancel"; jobId: string }
    | { type: "offscreen:ready" }
  );
