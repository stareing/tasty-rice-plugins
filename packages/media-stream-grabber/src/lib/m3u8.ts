/**
 * Minimal HLS playlist parser. Handles:
 *   - master playlist (#EXT-X-STREAM-INF) → highest-bandwidth variant
 *   - media playlist with relative or absolute URIs
 *   - byte-range segments (#EXT-X-BYTERANGE)
 *   - AES-128 keys (#EXT-X-KEY METHOD=AES-128, IV=...) — single key only
 *
 * What it does NOT do (yet): SAMPLE-AES, multi-key rotation per segment,
 * #EXT-X-MAP init segments (most modern fMP4 streams). For the v1 we focus on
 * classic .ts segment HLS — the format you actually find on most "right click,
 * blocked" sites.
 */

export interface HlsKey {
  method: "AES-128";
  uri: string;
  iv?: Uint8Array;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  byteRange?: { length: number; offset: number };
  key?: HlsKey;
}

export interface HlsMediaPlaylist {
  segments: HlsSegment[];
  totalDuration: number;
}

export interface HlsVariant {
  bandwidth: number;
  resolution?: string;
  uri: string;
}

export type HlsParseResult =
  | { kind: "master"; variants: HlsVariant[] }
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

function resolveUri(base: string, ref: string): string {
  return new URL(ref, base).toString();
}

export function parseM3U8(text: string, baseUrl: string): HlsParseResult {
  const lines = text.split(/\r?\n/);
  const variants: HlsVariant[] = [];
  const segments: HlsSegment[] = [];
  let currentKey: HlsKey | undefined;
  let pendingDuration = 0;
  let pendingByteRange: HlsSegment["byteRange"] | undefined;
  let lastEndOffset = 0;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const attrs = parseAttrs(line.slice("#EXT-X-STREAM-INF:".length));
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith("#")) {
        variants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution: attrs.RESOLUTION,
          uri: resolveUri(baseUrl, next),
        });
        i++;
      }
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

    if (line.startsWith("#EXTINF:")) {
      const v = line.slice("#EXTINF:".length).split(",")[0];
      pendingDuration = parseFloat(v) || 0;
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const v = line.slice("#EXT-X-BYTERANGE:".length);
      const [lenStr, offStr] = v.split("@");
      const length = parseInt(lenStr, 10);
      const offset = offStr !== undefined ? parseInt(offStr, 10) : lastEndOffset;
      pendingByteRange = { length, offset };
      lastEndOffset = offset + length;
      continue;
    }

    if (line.startsWith("#")) continue;

    // Non-comment line under media playlist == segment URI.
    segments.push({
      uri: resolveUri(baseUrl, line),
      duration: pendingDuration,
      byteRange: pendingByteRange,
      key: currentKey,
    });
    pendingDuration = 0;
    pendingByteRange = undefined;
  }

  if (isMaster) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { kind: "master", variants };
  }
  const totalDuration = segments.reduce((acc, s) => acc + s.duration, 0);
  return { kind: "media", playlist: { segments, totalDuration } };
}
