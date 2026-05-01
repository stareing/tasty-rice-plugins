/**
 * Per-job segment cache backed by OPFS (Origin Private File System).
 *
 * Replaces the prior IndexedDB cache. Two motivations:
 *
 *  1. RAM. The previous pipeline materialised every downloaded segment as
 *     `Uint8Array` in JS heap, then concatenated them into a single buffer
 *     (~2× video size in JS), then handed that buffer to ffmpeg's MEMFS
 *     (~3× video size end-to-end). For a 2 GB video that crossed the
 *     offscreen tab's memory ceiling and crashed the document.
 *  2. Throughput. IndexedDB transactions serialise binary blobs through a
 *     storage layer not designed for high-rate writes; at SEGMENT_CONCURRENCY
 *     we measured the IDB writes blocking the offscreen event loop.
 *
 * OPFS gives us a real filesystem with stream-friendly writes, zero
 * serialisation, and `File` handles that ffmpeg.wasm WORKERFS can mount
 * directly so the bytes never round-trip through JS heap on the merge step.
 *
 * Browsers without OPFS (Firefox in private mode, very old Chromium) get a
 * `NullSegmentStore` — downloads still succeed, resume is a best-effort
 * no-op for the duration of the session.
 */

export type Channel = "v" | "a";

export interface SegmentStore {
  has(channel: Channel, index: number): Promise<boolean>;
  /** Resolve to a `File` handle suitable for ffmpeg WORKERFS mount. */
  getFile(channel: Channel, index: number): Promise<File | undefined>;
  write(channel: Channel, index: number, bytes: Uint8Array): Promise<void>;
  /**
   * Append `bytes` to a single per-channel "merged" file. Used by the
   * pre-merge consolidation pass to turn N segment files into one
   * sequentially-readable stream that ffmpeg can mount + demux.
   */
  appendMerged(channel: Channel, bytes: Uint8Array): Promise<void>;
  /** Open (or reset) the merged file for `channel` ahead of consolidation. */
  beginMerged(channel: Channel): Promise<void>;
  /** Finalise the merged file so callers can mount it. */
  endMerged(channel: Channel): Promise<void>;
  /** Stream-copy a previously-stored segment into the merged file. */
  appendSegmentToMerged(channel: Channel, index: number): Promise<number>;
  /** Resolve to the merged-file handle for WORKERFS mount. Undefined when empty. */
  getMergedFile(channel: Channel): Promise<File | undefined>;
  /** Delete every file owned by this job. Safe to call even if never written. */
  destroy(): Promise<void>;
}

const JOB_DIR_PREFIX = "msg-job-";
const MERGED_FILENAME: Record<Channel, string> = {
  v: "merged_v.bin",
  a: "merged_a.bin",
};

/**
 * Resolve a SegmentStore for `jobId`, creating its OPFS directory on demand.
 * Falls back to a no-op store when OPFS is unavailable so callers never
 * have to branch on capability detection.
 */
export async function openSegmentStore(jobId: string): Promise<SegmentStore> {
  if (!hasOpfs()) return new NullSegmentStore();
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(JOB_DIR_PREFIX + jobId, {
      create: true,
    });
    return new OpfsSegmentStore(root, dir, JOB_DIR_PREFIX + jobId);
  } catch {
    return new NullSegmentStore();
  }
}

/**
 * Drop OPFS directories for jobs that are no longer active. Called from the
 * offscreen module once at startup so a previous tab crash (or a "cancel"
 * that leaves the persisted job out of `jobsById`) doesn't accumulate
 * gigabytes of orphaned segment files.
 */
export async function sweepOrphanedJobDirs(
  isActive: (jobId: string) => boolean,
): Promise<void> {
  if (!hasOpfs()) return;
  try {
    const root = await navigator.storage.getDirectory();
    const iter = (root as unknown as {
      keys: () => AsyncIterableIterator<string>;
    }).keys();
    for await (const name of iter) {
      if (!name.startsWith(JOB_DIR_PREFIX)) continue;
      const jobId = name.slice(JOB_DIR_PREFIX.length);
      if (isActive(jobId)) continue;
      await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    /* OPFS unavailable or transient storage error — non-fatal */
  }
}

function hasOpfs(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

/* ------------------------------ OPFS impl ------------------------------ */

class OpfsSegmentStore implements SegmentStore {
  private mergedWritables: Partial<Record<Channel, FileSystemWritableFileStream>> = {};

  constructor(
    private readonly root: FileSystemDirectoryHandle,
    private readonly dir: FileSystemDirectoryHandle,
    private readonly dirName: string,
  ) {}

  private filename(channel: Channel, index: number): string {
    return `${channel}_${index}.bin`;
  }

  async has(channel: Channel, index: number): Promise<boolean> {
    try {
      await this.dir.getFileHandle(this.filename(channel, index));
      return true;
    } catch {
      return false;
    }
  }

  async getFile(channel: Channel, index: number): Promise<File | undefined> {
    try {
      const handle = await this.dir.getFileHandle(this.filename(channel, index));
      return await handle.getFile();
    } catch {
      return undefined;
    }
  }

  async write(channel: Channel, index: number, bytes: Uint8Array): Promise<void> {
    const handle = await this.dir.getFileHandle(this.filename(channel, index), {
      create: true,
    });
    const writable = await handle.createWritable();
    try {
      // Wrap as Blob so we feed the writable a `BufferSource | Blob` that's
      // independent of the (possibly SharedArrayBuffer-backed) underlying
      // buffer type — the strict lib.dom typing rejects the bare Uint8Array.
      await writable.write(asWritableChunk(bytes));
    } finally {
      await writable.close();
    }
  }

  async beginMerged(channel: Channel): Promise<void> {
    await this.endMerged(channel);
    const handle = await this.dir.getFileHandle(MERGED_FILENAME[channel], {
      create: true,
    });
    this.mergedWritables[channel] = await handle.createWritable();
  }

  async appendMerged(channel: Channel, bytes: Uint8Array): Promise<void> {
    const writable = this.mergedWritables[channel];
    if (!writable) throw new MergedNotOpenError(channel);
    await writable.write(asWritableChunk(bytes));
  }

  async appendSegmentToMerged(channel: Channel, index: number): Promise<number> {
    const writable = this.mergedWritables[channel];
    if (!writable) throw new MergedNotOpenError(channel);
    const file = await this.getFile(channel, index);
    if (!file) return 0;
    // Streaming Blob write — Chromium pipes from disk to disk without
    // materialising the file in JS heap.
    await writable.write(file);
    return file.size;
  }

  async endMerged(channel: Channel): Promise<void> {
    const writable = this.mergedWritables[channel];
    if (!writable) return;
    delete this.mergedWritables[channel];
    await writable.close().catch(() => {
      /* close throws if the stream was already errored; nothing to do */
    });
  }

  async getMergedFile(channel: Channel): Promise<File | undefined> {
    try {
      const handle = await this.dir.getFileHandle(MERGED_FILENAME[channel]);
      const file = await handle.getFile();
      return file.size > 0 ? file : undefined;
    } catch {
      return undefined;
    }
  }

  async destroy(): Promise<void> {
    for (const channel of Object.keys(this.mergedWritables) as Channel[]) {
      await this.endMerged(channel);
    }
    await this.root.removeEntry(this.dirName, { recursive: true }).catch(() => {});
  }
}

/* ------------------------------ null impl ------------------------------ */

class NullSegmentStore implements SegmentStore {
  async has(): Promise<boolean> { return false; }
  async getFile(): Promise<undefined> { return undefined; }
  async write(): Promise<void> { /* dropped */ }
  async beginMerged(): Promise<void> { throw new OpfsUnavailableError(); }
  async appendMerged(): Promise<void> { throw new OpfsUnavailableError(); }
  async appendSegmentToMerged(): Promise<number> { throw new OpfsUnavailableError(); }
  async endMerged(): Promise<void> { /* nothing to flush */ }
  async getMergedFile(): Promise<undefined> { return undefined; }
  async destroy(): Promise<void> { /* nothing persisted */ }
}

/**
 * Convert a Uint8Array to a `Blob` so it's accepted by
 * `FileSystemWritableFileStream.write` regardless of the underlying buffer
 * type. The Uint8Array itself is technically a `BufferSource`, but strict
 * lib.dom typings now reject it because its `.buffer` could be a
 * `SharedArrayBuffer`. Wrapping in a Blob sidesteps that without copying.
 */
function asWritableChunk(bytes: Uint8Array): Blob {
  // Copy into a fresh ArrayBuffer so the BlobPart we hand off is independent
  // of the source's underlying buffer type (Uint8Array's `.buffer` is
  // `ArrayBufferLike`, which strict lib.dom narrows out of `BlobPart`). The
  // copy is unavoidable for type-safety and matches what the prior IDB
  // serializer would have done internally.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new Blob([copy]);
}

/* --------------------------- typed errors ---------------------------- */

export class OpfsUnavailableError extends Error {
  readonly kind = "opfs-unavailable" as const;
  constructor() {
    super("OPFS is unavailable in this browser context.");
  }
}

export class MergedNotOpenError extends Error {
  readonly kind = "merged-not-open" as const;
  constructor(public readonly channel: Channel) {
    super(`Merged stream for channel "${channel}" was not opened via beginMerged().`);
  }
}
