/**
 * HLS playlist parser. Handles:
 *   - master playlist (#EXT-X-STREAM-INF) with all variant attrs
 *   - alternate renditions (#EXT-X-MEDIA TYPE=AUDIO/SUBTITLES/VIDEO)
 *   - media playlist with relative or absolute URIs
 *   - byte-range segments (#EXT-X-BYTERANGE)
 *   - AES-128 keys (#EXT-X-KEY METHOD=AES-128, IV=...) with rotation
 *   - fMP4 init segments (#EXT-X-MAP) — required for any modern ≥1080p stream
 *   - #EXT-X-MEDIA-SEQUENCE (required to compute the default IV per RFC 8216
 *     §5.2 when an explicit IV attribute is absent — using array index would
 *     decrypt to garbage on any stream where MEDIA-SEQUENCE != 0)
 *
 * Still NOT handled: SAMPLE-AES.
 */

export interface HlsKey {
  method: "AES-128";
  uri: string;
  iv?: Uint8Array;
}

export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  byteRange?: HlsByteRange;
  key?: HlsKey;
  /**
   * Absolute Media Sequence Number (RFC 8216 §4.3.3.2). Required to compute
   * the default AES-128 IV — using the playlist-relative array index instead
   * decrypts to garbage on any stream that does not start with sequence 0.
   */
  sequence: number;
}

export interface HlsInitSegment {
  uri: string;
  byteRange?: HlsByteRange;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  totalDuration: number;
  /** From #EXT-X-MAP — fMP4 init segment, played before any media segment. */
  initSegment?: HlsInitSegment;
  /** Media Sequence Number of the first segment. Defaults to 0 per spec. */
  mediaSequence: number;
}

export interface HlsVariant {
  bandwidth: number;
  resolution?: string;
  /** Pixel height parsed out of resolution; 0 when unknown. */
  height: number;
  codecs?: string;
  uri: string;
  audioGroup?: string;
  subtitleGroup?: string;
}

export interface HlsRendition {
  type: "AUDIO" | "SUBTITLES" | "VIDEO" | "CLOSED-CAPTIONS";
  groupId: string;
  name: string;
  language?: string;
  default: boolean;
  uri?: string;
}

export type HlsParseResult =
  | { kind: "master"; variants: HlsVariant[]; renditions: HlsRendition[] }
  | { kind: "media"; playlist: HlsMediaPlaylist };

const ATTR_RE = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;

function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) {
    out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function parseByteRange(value: string, prevEnd: number): HlsByteRange {
  const [lenStr, offStr] = value.split("@");
  const length = parseInt(lenStr, 10);
  const offset = offStr !== undefined ? parseInt(offStr, 10) : prevEnd;
  return { length, offset };
}

function parseHeight(resolution: string | undefined): number {
  if (!resolution) return 0;
  const m = /(\d+)x(\d+)/i.exec(resolution);
  return m ? Number(m[2]) || 0 : 0;
}

function resolveUri(base: string, ref: string): string {
  return new URL(ref, base).toString();
}

/** Sort by visible height first, fall back to bandwidth.
 *  HEVC 1080p with lower bandwidth must rank above H.264 720p. */
export function compareVariantsBest(a: HlsVariant, b: HlsVariant): number {
  if (a.height !== b.height) return b.height - a.height;
  return b.bandwidth - a.bandwidth;
}

export function parseM3U8(text: string, baseUrl: string): HlsParseResult {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  const segments: HlsSegment[] = [];
  let currentKey: HlsKey | undefined;
  let initSegment: HlsInitSegment | undefined;
  let pendingDuration = 0;
  let pendingByteRange: HlsByteRange | undefined;
  let lastEndOffset = 0;
  let isMaster = false;
  let mediaSequence = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith("#")) {
        const resolution = attrs.RESOLUTION;
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution,
          height: parseHeight(resolution),
          codecs: attrs.CODECS,
          uri: resolveUri(baseUrl, next),
          audioGroup: attrs.AUDIO,
          subtitleGroup: attrs.SUBTITLES,
        });
        i++;
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      isMaster = true;
      const attrs = parseAttrs(line.slice("#EXT-X-MEDIA:".length));
      const type = attrs.TYPE as HlsRendition["type"] | undefined;
      if (!type) continue;
      renditions.push({
        type,
        groupId: attrs["GROUP-ID"] || "",
        name: attrs.NAME || "",
        language: attrs.LANGUAGE,
        default: attrs.DEFAULT === "YES",
        uri: attrs.URI ? resolveUri(baseUrl, attrs.URI) : undefined,
      });
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-KEY:".length));
      if (attrs.METHOD === "NONE") {
        currentKey = undefined;
      } else if (attrs.METHOD === "AES-128" && attrs.URI) {
        currentKey = {
          method: "AES-128",
          uri: resolveUri(baseUrl, attrs.URI),
          iv: attrs.IV ? hexToBytes(attrs.IV) : undefined,
        };
      }
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttrs(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) {
        let byteRange: HlsByteRange | undefined;
        if (attrs.BYTERANGE) {
          byteRange = parseByteRange(attrs.BYTERANGE, 0);
        }
        initSegment = { uri: resolveUri(baseUrl, attrs.URI), byteRange };
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      const v = line.slice("#EXTINF:".length).split(",")[0];
      pendingDuration = parseFloat(v) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const v = line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim();
      const parsed = parseInt(v, 10);
      if (Number.isFinite(parsed) && parsed >= 0) mediaSequence = parsed;
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseByteRange(
        line.slice("#EXT-X-BYTERANGE:".length),
        lastEndOffset,
      );
      lastEndOffset = pendingByteRange.offset + pendingByteRange.length;
      continue;
    }

    if (line.startsWith("#")) continue;

    // Non-comment line under media playlist == segment URI.
    segments.push({
      uri: resolveUri(baseUrl, line),
      duration: pendingDuration,
      byteRange: pendingByteRange,
      key: currentKey,
      sequence: mediaSequence + segments.length,
    });
    pendingDuration = 0;
    pendingByteRange = undefined;
  }

  if (isMaster) {
    variants.sort(compareVariantsBest);
    return { kind: "master", variants, renditions };
  }
  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
  return {
    kind: "media",
    playlist: { segments, totalDuration, initSegment, mediaSequence },
  };
}
