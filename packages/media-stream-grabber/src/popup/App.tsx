import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioTrackOption,
  DetectedStream,
  DownloadProgress,
  DownloadSelection,
  ProbeResult,
  RuntimeMessage,
  StreamKind,
  SubtitleTrackOption,
  VariantOption,
} from "@/lib/types";

const BATCH_AUTO_QUALITY_KEY = "msg.batchAutoQuality.v1";

function useActiveTab(): chrome.tabs.Tab | null {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      setTab(tabs[0] ?? null);
    });
  }, []);
  return tab;
}

function send<T = unknown>(msg: RuntimeMessage): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...msg, target: "sw" }, (resp: T) => resolve(resp));
  });
}

// Wait for the SW's probe reply for a single jobId. The handler detaches
// itself on first match — without the jobId guard, batches running probes
// back-to-back would cross-resolve.
function waitForProbeResult(jobId: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const handler = (msg: RuntimeMessage) => {
      if (msg.target && msg.target !== "sw") return;
      if (msg.type !== "download:probe:result" || msg.jobId !== jobId) return;
      chrome.runtime.onMessage.removeListener(handler);
      resolve(msg.result);
    };
    chrome.runtime.onMessage.addListener(handler);
  });
}

// Resolve when the SW reports done/error for jobId — the batch driver awaits
// this between iterations so we never have two HLS jobs racing for ffmpeg /
// IndexedDB / DNR rules at the same time.
function waitForJobEnd(jobId: string): Promise<DownloadProgress> {
  return new Promise((resolve) => {
    const handler = (msg: RuntimeMessage) => {
      if (msg.target && msg.target !== "sw") return;
      if (msg.type !== "download:progress") return;
      const p = msg.payload;
      if (p.jobId !== jobId) return;
      if (p.phase !== "done" && p.phase !== "error") return;
      chrome.runtime.onMessage.removeListener(handler);
      resolve(p);
    };
    chrome.runtime.onMessage.addListener(handler);
  });
}

const KIND_LABEL: Record<StreamKind, string> = {
  hls: "HLS",
  dash: "DASH",
  mp4: "MP4",
  audio: "AUDIO",
  image: "IMG",
  text: "TEXT",
  other: "FILE",
};

type CategoryKey = "all" | "video" | "audio" | "image" | "text";

const VIDEO_KINDS: ReadonlySet<StreamKind> = new Set(["hls", "dash", "mp4"]);

function categoryOf(kind: StreamKind): Exclude<CategoryKey, "all"> | null {
  if (VIDEO_KINDS.has(kind)) return "video";
  if (kind === "audio") return "audio";
  if (kind === "image") return "image";
  if (kind === "text") return "text";
  return null;
}

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Audio" },
  { key: "image", label: "Image" },
  { key: "text", label: "Subs" },
];

interface PendingPicker {
  jobId: string;
  stream: DetectedStream;
  result: ProbeResult;
}

interface BatchState {
  total: number;
  completed: number;
  currentStreamId?: string;
}

const EMPTY_PROBE: ProbeResult = {
  variants: [],
  audioTracks: [],
  subtitleTracks: [],
  singlePlaylist: false,
};

export function App(): JSX.Element {
  const tab = useActiveTab();
  const [streams, setStreams] = useState<DetectedStream[]>([]);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [picker, setPicker] = useState<PendingPicker | null>(null);
  const [armedUntil, setArmedUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const [thumbsRequesting, setThumbsRequesting] = useState<Set<string>>(() => new Set());
  const [sniffActive, setSniffActive] = useState<boolean>(false);
  const [category, setCategory] = useState<CategoryKey>("all");
  const [mseActive, setMseActive] = useState<boolean>(false);
  const [mseSessions, setMseSessions] = useState<
    { sessionId: string; mimeType?: string; bytes: number; chunks: number }[]
  >([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [autoQuality, setAutoQuality] = useState<boolean>(false);
  const [batch, setBatch] = useState<BatchState | null>(null);
  const jobToStreamRef = useRef<Map<string, string>>(new Map());
  // Single-slot resolver for the picker — the batch driver runs sequentially,
  // so the popup never has to juggle multiple concurrent picks.
  const pickerResolveRef = useRef<((sel: DownloadSelection | null) => void) | null>(null);
  // Stop signal for the queue. The currently-running download keeps going
  // (its per-row Cancel button still works); only the queue advances stop.
  const batchCancelRef = useRef<boolean>(false);

  const refresh = useCallback(async () => {
    if (!tab?.id) return;
    const resp = await send<RuntimeMessage>({ type: "streams:list", tabId: tab.id });
    if (resp && (resp as RuntimeMessage).type === "streams:list:result") {
      setStreams((resp as Extract<RuntimeMessage, { type: "streams:list:result" }>).streams);
    }
  }, [tab?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull the current page-sniff state once on mount. Subsequent state changes
  // (toggle, navigation-driven auto-disable) arrive via `pagesniff:status`
  // broadcasts in the listener below.
  useEffect(() => {
    if (!tab?.id) return;
    void send<RuntimeMessage>({ type: "pagesniff:query", tabId: tab.id }).then(
      (resp) => {
        if (resp && (resp as RuntimeMessage).type === "pagesniff:status") {
          setSniffActive(
            (resp as Extract<RuntimeMessage, { type: "pagesniff:status" }>)
              .active,
          );
        }
      },
    );
  }, [tab?.id]);

  useEffect(() => {
    const handler = (msg: RuntimeMessage) => {
      // CLAUDE.md cross-context convention: every context early-returns on
      // mismatched target. The popup is only a consumer of "sw"-tagged
      // broadcasts (status updates, probe results, fresh stream rows).
      if (msg.target && msg.target !== "sw") return;
      if (msg.type === "streams:added" && tab?.id && msg.tabId === tab.id) {
        setStreams((prev) => {
          // Merge by id; the SW may re-emit `streams:added` for the same id
          // (e.g. when a sibling child playlist is sniffed and dedupes).
          const idx = prev.findIndex((s) => s.id === msg.stream.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...msg.stream };
            return next;
          }
          return [msg.stream, ...prev];
        });
      }
      if (msg.type === "streams:removed" && tab?.id && msg.tabId === tab.id) {
        setStreams((prev) => prev.filter((s) => s.id !== msg.streamId));
      }
      if (msg.type === "thumb:result" && msg.dataUrl) {
        setStreams((prev) => {
          const idx = prev.findIndex((s) => s.id === msg.streamId);
          if (idx < 0) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], thumbDataUrl: msg.dataUrl };
          return next;
        });
        setThumbsRequesting((prev) => {
          if (!prev.has(msg.streamId)) return prev;
          const next = new Set(prev);
          next.delete(msg.streamId);
          return next;
        });
      }
      if (msg.type === "thumb:result" && msg.error) {
        setThumbsRequesting((prev) => {
          if (!prev.has(msg.streamId)) return prev;
          const next = new Set(prev);
          next.delete(msg.streamId);
          return next;
        });
      }
      if (msg.type === "download:progress") {
        setProgress((prev) => ({ ...prev, [msg.payload.jobId]: msg.payload }));
      }
      if (msg.type === "capture:status" && tab?.id && msg.tabId === tab.id) {
        setArmedUntil(msg.armedUntil);
      }
      if (
        msg.type === "pagesniff:status" &&
        tab?.id &&
        msg.tabId === tab.id
      ) {
        setSniffActive(msg.active);
      }
      if (msg.type === "mse:status" && tab?.id && msg.tabId === tab.id) {
        setMseActive(msg.active);
        setMseSessions(msg.sessions);
      }
      // Probe replies are awaited explicitly by the run driver via
      // `waitForProbeResult` — keeping a parallel auto-start in this
      // listener would race the driver and double-dispatch download:start.
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [tab?.id]);

  const onClear = useCallback(async () => {
    if (!tab?.id) return;
    await send({ type: "streams:clear", tabId: tab.id });
    setStreams([]);
    setProgress({});
    setSelectedIds(new Set());
  }, [tab?.id]);

  // Persist the "auto-pick recommended" preference across popup opens — the
  // batch toolbar is the only place it's set, so a single key is enough.
  useEffect(() => {
    chrome.storage.local.get(BATCH_AUTO_QUALITY_KEY).then((got) => {
      if (got[BATCH_AUTO_QUALITY_KEY] === true) setAutoQuality(true);
    });
  }, []);

  // Drop selections whose streams no longer exist (tab navigated, user hit
  // Clear, etc.) so stale ids can't leak into the next batch.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(streams.map((s) => s.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [streams]);

  const onArm = useCallback(async () => {
    if (!tab?.id) return;
    const resp = await send<RuntimeMessage>({ type: "capture:arm", tabId: tab.id });
    if (resp && (resp as RuntimeMessage).type === "capture:status") {
      setArmedUntil((resp as Extract<RuntimeMessage, { type: "capture:status" }>).armedUntil);
    }
  }, [tab?.id]);

  // Pull MSE capture state once on mount; updates arrive via mse:status broadcasts.
  useEffect(() => {
    if (!tab?.id) return;
    void send<RuntimeMessage>({ type: "mse:status:query", tabId: tab.id }).then(
      (resp) => {
        if (resp && (resp as RuntimeMessage).type === "mse:status") {
          const m = resp as Extract<RuntimeMessage, { type: "mse:status" }>;
          setMseActive(m.active);
          setMseSessions(m.sessions);
        }
      },
    );
  }, [tab?.id]);

  // Poll session stats while capturing — chunks are throttled by the page,
  // so a 1s tick is enough to keep the byte counter alive without spam.
  useEffect(() => {
    if (!mseActive || !tab?.id) return;
    const id = setInterval(() => {
      void send<RuntimeMessage>({
        type: "mse:status:query",
        tabId: tab.id!,
      }).then((resp) => {
        if (resp && (resp as RuntimeMessage).type === "mse:status") {
          setMseSessions(
            (resp as Extract<RuntimeMessage, { type: "mse:status" }>).sessions,
          );
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, [mseActive, tab?.id]);

  const onToggleMse = useCallback(async () => {
    if (!tab?.id) return;
    await send({ type: "mse:arm", tabId: tab.id, enable: !mseActive });
  }, [tab?.id, mseActive]);

  const onSaveMse = useCallback(async (sessionId: string) => {
    const name = `mse-capture-${Date.now().toString(36)}`;
    await send({ type: "mse:save", sessionId, suggestedName: name });
  }, []);

  const onToggleSniff = useCallback(async () => {
    if (!tab?.id) return;
    const next = !sniffActive;
    // Optimistic flip — the SW broadcast will reconcile if anything
    // (e.g. a parallel popup, an auto-disable on navigation) disagrees.
    setSniffActive(next);
    await send({
      type: "pagesniff:toggle",
      tabId: tab.id,
      enable: next,
    });
  }, [tab?.id, sniffActive]);

  // Tick the countdown while the capture window is open. The interval is cheap
  // and only mounts while the popup is visible.
  useEffect(() => {
    if (armedUntil <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [armedUntil]);

  const armedSecondsLeft = Math.max(0, Math.ceil((armedUntil - now) / 1000));
  const isArmed = armedSecondsLeft > 0;

  const onCopy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard blocked — silently ignore */
    }
  }, []);

  // Drive a single download from start to finish: probe (HLS/DASH only),
  // pick a selection (auto-recommended or via the modal), start, then await
  // done/error. Both the per-row Download button and the batch driver call
  // through here, so there is one source of truth for the flow.
  const runStreamDownload = useCallback(
    async (
      stream: DetectedStream,
      opts: { autoQuality: boolean; batched?: boolean },
    ): Promise<void> => {
      // Synthetic MSE-recording row: clicking "Download" arms the page-side
      // SourceBuffer capture instead of fetching the placeholder URL. The
      // MSE panel renders automatically once the SW broadcasts `mse:status`
      // back, so we don't need to also drive a job through the normal flow.
      if (stream.virtual === "mse") {
        if (!tab?.id) return;
        await send({ type: "mse:arm", tabId: tab.id, enable: true });
        return;
      }

      const jobId = `${stream.id}-${Date.now().toString(36)}`;
      jobToStreamRef.current.set(jobId, stream.id);
      setProgress((prev) => ({
        ...prev,
        [jobId]: { jobId, phase: "probing", ratio: 0 },
      }));

      const isManifest = stream.kind === "hls" || stream.kind === "dash";

      if (isManifest) {
        if (!opts.autoQuality) {
          // Show the modal in its "probing" placeholder state immediately so
          // the user knows the click registered.
          setPicker({ jobId, stream, result: EMPTY_PROBE });
        }

        // Race the probe against an early-cancel so pressing Close while
        // still probing aborts the run instead of falling through to a
        // stale picker once the result eventually arrives.
        const probePromise = waitForProbeResult(jobId);
        const earlyCancelPromise = opts.autoQuality
          ? new Promise<"canceled">(() => {})
          : new Promise<"canceled">((resolve) => {
              pickerResolveRef.current = (sel) => {
                if (sel === null) resolve("canceled");
              };
            });

        await send({ type: "download:probe", stream, jobId });

        const racing = await Promise.race([
          probePromise.then((r) => ({ kind: "probe" as const, result: r })),
          earlyCancelPromise.then(() => ({ kind: "canceled" as const })),
        ]);

        if (racing.kind === "canceled") {
          pickerResolveRef.current = null;
          setProgress((prev) => {
            const next = { ...prev };
            delete next[jobId];
            return next;
          });
          jobToStreamRef.current.delete(jobId);
          return;
        }

        // Probe won the race — the cancel resolver above is now dead weight.
        pickerResolveRef.current = null;
        const result = racing.result;

        if (result.unsupported || result.isLive) {
          if (opts.autoQuality) {
            setProgress((prev) => ({
              ...prev,
              [jobId]: {
                jobId,
                phase: "error",
                ratio: 0,
                error:
                  result.unsupported?.reason ||
                  (result.isLive
                    ? "Live stream — not mergeable."
                    : "Refused."),
              },
            }));
            return;
          }
          // Manual: surface the refusal in the picker; the only action is
          // Close, which resolves null below.
          setPicker((prev) =>
            prev?.jobId === jobId ? { ...prev, result } : prev,
          );
          await new Promise<DownloadSelection | null>((resolve) => {
            pickerResolveRef.current = resolve;
          });
          pickerResolveRef.current = null;
          setProgress((prev) => {
            const next = { ...prev };
            delete next[jobId];
            return next;
          });
          jobToStreamRef.current.delete(jobId);
          return;
        }

        let selection: DownloadSelection;
        if (result.singlePlaylist || result.variants.length === 0) {
          selection = {};
          if (!opts.autoQuality) {
            setPicker((prev) => (prev?.jobId === jobId ? null : prev));
          }
        } else if (opts.autoQuality) {
          const playable = result.variants.filter((v) => !v.drm);
          if (!playable.length) {
            setProgress((prev) => ({
              ...prev,
              [jobId]: {
                jobId,
                phase: "error",
                ratio: 0,
                error: "All renditions DRM-protected.",
              },
            }));
            return;
          }
          const variantUri =
            result.recommendedVariantUri &&
            playable.some((v) => v.uri === result.recommendedVariantUri)
              ? result.recommendedVariantUri
              : playable[0].uri;
          selection = {
            variantUri,
            audioId: result.recommendedAudioId,
          };
        } else {
          // Update the modal with real choices; await user confirm/cancel.
          setPicker((prev) =>
            prev?.jobId === jobId ? { ...prev, result } : prev,
          );
          const picked = await new Promise<DownloadSelection | null>((resolve) => {
            pickerResolveRef.current = resolve;
          });
          pickerResolveRef.current = null;
          if (picked === null) {
            setProgress((prev) => {
              const next = { ...prev };
              delete next[jobId];
              return next;
            });
            jobToStreamRef.current.delete(jobId);
            return;
          }
          selection = picked;
        }

        await send({ type: "download:start", stream, jobId, selection, batched: opts.batched });
      } else {
        await send({ type: "download:start", stream, jobId, selection: {}, batched: opts.batched });
      }

      await waitForJobEnd(jobId);
    },
    [tab?.id],
  );

  const onDownload = useCallback(
    (stream: DetectedStream) => {
      void runStreamDownload(stream, { autoQuality: false });
    },
    [runStreamDownload],
  );

  const onCancel = useCallback(async (jobId: string) => {
    await send({ type: "download:cancel", jobId });
  }, []);

  const onRequestThumb = useCallback(async (stream: DetectedStream) => {
    if (thumbsRequesting.has(stream.id)) return;
    setThumbsRequesting((prev) => {
      const next = new Set(prev);
      next.add(stream.id);
      return next;
    });
    await send({ type: "thumb:request", streamId: stream.id, stream });
  }, [thumbsRequesting]);

  const onPickerConfirm = useCallback((selection: DownloadSelection) => {
    setPicker(null);
    pickerResolveRef.current?.(selection);
    pickerResolveRef.current = null;
  }, []);

  const onPickerCancel = useCallback(() => {
    setPicker(null);
    pickerResolveRef.current?.(null);
    pickerResolveRef.current = null;
  }, []);

  const onToggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Skip-rules: never queue a stream that already has an in-flight job, and
  // dedupe by URL/id at queue-build time. Virtual MSE rows are excluded —
  // clicking them arms the page-side capture, which doesn't compose with
  // the sequential per-stream queue. Image / audio rows are batchable; the
  // SW skips the save-as dialog and auto-renames on filename conflict when
  // the popup passes `batched: true` through `download:start`.
  const isStreamBatchable = useCallback(
    (s: DetectedStream): boolean => {
      if (s.virtual === "mse") return false;
      for (const [jobId, sid] of jobToStreamRef.current) {
        if (sid !== s.id) continue;
        const p = progress[jobId];
        if (p && p.phase !== "done" && p.phase !== "error") return false;
      }
      return true;
    },
    [progress],
  );

  const onToggleAutoQuality = useCallback(() => {
    setAutoQuality((prev) => {
      const next = !prev;
      void chrome.storage.local.set({ [BATCH_AUTO_QUALITY_KEY]: next });
      return next;
    });
  }, []);

  const onStopBatch = useCallback(() => {
    batchCancelRef.current = true;
    // If a picker is open for the current batch item, treat Stop as cancel-
    // this-item too — otherwise the loop sits forever waiting for input.
    if (pickerResolveRef.current) {
      pickerResolveRef.current(null);
      pickerResolveRef.current = null;
    }
    setPicker(null);
  }, []);

  const onStartBatch = useCallback(
    async (targets: DetectedStream[]) => {
      if (!targets.length || batch) return;
      batchCancelRef.current = false;
      setBatch({
        total: targets.length,
        completed: 0,
        currentStreamId: targets[0].id,
      });
      const useAutoQuality = autoQuality;
      for (let i = 0; i < targets.length; i++) {
        if (batchCancelRef.current) break;
        const s = targets[i];
        setBatch({
          total: targets.length,
          completed: i,
          currentStreamId: s.id,
        });
        try {
          await runStreamDownload(s, { autoQuality: useAutoQuality, batched: true });
        } catch {
          // Per-job error is already surfaced via download:progress; keep
          // the queue moving.
        }
        // Drop the row from the selection so re-clicking Download doesn't
        // re-queue a finished job by accident.
        setSelectedIds((prev) => {
          if (!prev.has(s.id)) return prev;
          const next = new Set(prev);
          next.delete(s.id);
          return next;
        });
      }
      setBatch(null);
      batchCancelRef.current = false;
    },
    [autoQuality, batch, runStreamDownload],
  );

  const progressByStream = useMemo(() => {
    const map: Record<string, DownloadProgress> = {};
    for (const [jobId, sid] of jobToStreamRef.current) {
      const p = progress[jobId];
      if (p) map[sid] = p;
    }
    return map;
  }, [progress]);

  const counts = useMemo(() => {
    const c: Record<CategoryKey, number> = { all: streams.length, video: 0, audio: 0, image: 0, text: 0 };
    for (const s of streams) {
      const cat = categoryOf(s.kind);
      if (cat) c[cat]++;
    }
    return c;
  }, [streams]);

  const visibleStreams = useMemo(() => {
    const inCategory =
      category === "all"
        ? streams
        : streams.filter((s) => categoryOf(s.kind) === category);
    // Score-first ordering surfaces the right-click target above tab-wide
    // noise (preloads, ad iframes, sibling players). detectedAt breaks ties
    // so newer rows still win when two scores match — the SW sets a sane
    // default score on every insert, but treat undefined as 0 to avoid an
    // unranked row floating randomly between scored ones.
    return [...inCategory].sort((a, b) => {
      const sa = a.score ?? 0;
      const sb = b.score ?? 0;
      if (sa !== sb) return sb - sa;
      return b.detectedAt - a.detectedAt;
    });
  }, [streams, category]);

  // "Select all" only operates on what the user can actually queue from the
  // current category — images and in-flight streams stay untouched.
  const batchableVisible = useMemo(
    () => visibleStreams.filter((s) => isStreamBatchable(s)),
    [visibleStreams, isStreamBatchable],
  );
  const visibleSelectedCount = useMemo(
    () => visibleStreams.filter((s) => selectedIds.has(s.id)).length,
    [visibleStreams, selectedIds],
  );
  const allVisibleSelected =
    batchableVisible.length > 0 &&
    batchableVisible.every((s) => selectedIds.has(s.id));

  // Resolve the queue at click time so subsequent sniff events can't change
  // the batch shape mid-flight. Dedupes by id and URL.
  const batchTargets = useMemo<DetectedStream[]>(() => {
    const seenUrls = new Set<string>();
    const seenIds = new Set<string>();
    const out: DetectedStream[] = [];
    for (const s of visibleStreams) {
      if (!selectedIds.has(s.id)) continue;
      if (!isStreamBatchable(s)) continue;
      if (seenIds.has(s.id) || seenUrls.has(s.url)) continue;
      seenIds.add(s.id);
      seenUrls.add(s.url);
      out.push(s);
    }
    return out;
  }, [visibleStreams, selectedIds, isStreamBatchable]);

  const onToggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const s of batchableVisible) next.delete(s.id);
      } else {
        for (const s of batchableVisible) next.add(s.id);
      }
      return next;
    });
  }, [allVisibleSelected, batchableVisible]);

  const onClickDownloadSelected = useCallback(() => {
    if (!batchTargets.length) return;
    void onStartBatch(batchTargets);
  }, [batchTargets, onStartBatch]);

  const batchActive = batch !== null;

  return (
    <div className="app">
      <header className="app__header">
        <span className="app__title">Media Stream Grabber</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="app__count">{streams.length} found</span>
          <button
            className={`app__btn${mseActive ? " app__btn--active" : ""}`}
            onClick={onToggleMse}
            disabled={!tab?.id}
            title={
              mseActive
                ? "Stop capturing MediaSource buffer chunks."
                : "Capture every SourceBuffer.appendBuffer payload on this tab — useful when the page only exposes a blob: URL."
            }
          >
            {mseActive ? "Stop MSE" : "Capture MSE"}
          </button>
          <button
            className={`app__btn${sniffActive ? " app__btn--active" : ""}`}
            onClick={onToggleSniff}
            disabled={!tab?.id}
            title={
              sniffActive
                ? "Stop capturing every media request on this tab."
                : "Capture every media request on this tab until you stop or the page navigates. Includes images."
            }
          >
            {sniffActive ? "Stop sniffing" : "Sniff page"}
          </button>
          <button
            className="app__btn"
            onClick={onArm}
            disabled={!tab?.id || isArmed || sniffActive}
            title={
              sniffActive
                ? "Page-sniff is on — broader capture is already active."
                : "Arm a 30s capture window for this tab. Nothing is sniffed otherwise."
            }
          >
            {isArmed ? `Capturing… ${armedSecondsLeft}s` : "Arm 30s"}
          </button>
          <button
            className="app__btn"
            onClick={() => {
              void chrome.tabs.create({
                url: chrome.runtime.getURL("src/manager/index.html"),
              });
            }}
            title="Open the standalone downloads manager"
          >
            Manager
          </button>
          <button className="app__btn" onClick={onClear} disabled={!streams.length}>
            Clear
          </button>
        </div>
      </header>

      {mseActive && mseSessions.length > 0 ? (
        <div className="stream" style={{ marginBottom: 10 }}>
          <div className="stream__head">
            <span className="stream__tag stream__tag--mp4">MSE</span>
            <span className="stream__name">Captured buffer sessions</span>
          </div>
          {mseSessions.map((s) => (
            <div
              key={s.sessionId}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}
            >
              <span className="stream__url" style={{ margin: 0 }}>
                {s.mimeType ?? "unknown"} · {(s.bytes / 1024 / 1024).toFixed(2)} MB · {s.chunks} chunks
              </span>
              <button className="app__btn" onClick={() => onSaveMse(s.sessionId)}>
                Save
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <nav className="cats" role="tablist" aria-label="Filter by media type">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={category === c.key}
            className={`cats__btn${category === c.key ? " cats__btn--active" : ""}`}
            onClick={() => setCategory(c.key)}
          >
            {c.label}
            <span className="cats__count">{counts[c.key]}</span>
          </button>
        ))}
      </nav>

      {streams.length > 0 ? (
        <div className="batchbar">
          <label
            className="batchbar__select"
            title="Toggle every queue-eligible row in this category"
          >
            <input
              type="checkbox"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    !allVisibleSelected && visibleSelectedCount > 0;
              }}
              onChange={onToggleSelectAllVisible}
              disabled={batchableVisible.length === 0 || batchActive}
            />
            <span>
              {visibleSelectedCount > 0
                ? `${visibleSelectedCount} selected`
                : "Select"}
            </span>
          </label>
          <label
            className="batchbar__auto"
            title="HLS/DASH: auto-pick the recommended rendition without showing the picker."
          >
            <input
              type="checkbox"
              checked={autoQuality}
              onChange={onToggleAutoQuality}
              disabled={batchActive}
            />
            <span>Auto recommended</span>
          </label>
          {batchActive ? (
            <button
              className="app__btn"
              onClick={onStopBatch}
              title="Stop the queue. The currently-running download keeps going — use its row Cancel button to abort it."
            >
              {`Stop (${batch!.completed}/${batch!.total})`}
            </button>
          ) : (
            <button
              className="app__btn app__btn--active"
              onClick={onClickDownloadSelected}
              disabled={batchTargets.length === 0}
              title={
                batchTargets.length === 0
                  ? "Select one or more queue-eligible rows first."
                  : autoQuality
                    ? "Run the queue with the recommended rendition for HLS/DASH."
                    : "Run the queue. HLS/DASH rows show the picker per stream."
              }
            >
              {`Download${batchTargets.length ? ` ${batchTargets.length}` : ""}`}
            </button>
          )}
        </div>
      ) : null}

      {streams.length === 0 ? (
        <div className="empty">
          Nothing captured on this tab.
          <br />
          Click <strong>Sniff page</strong> for whole-page capture, or right-click
          a video and pick
          <br />
          <strong>Media Stream Grabber → Capture next 30s of media</strong>.
        </div>
      ) : visibleStreams.length === 0 ? (
        <div className="empty">No {category} captured on this tab.</div>
      ) : (
        visibleStreams.map((s) => {
          const job = [...jobToStreamRef.current.entries()].find(([, sid]) => sid === s.id);
          const jobId = job?.[0];
          const selected = selectedIds.has(s.id);
          // A row is "selectable" when toggling will register: in-flight or
          // image rows are skipped, but a stream that's already selected
          // remains togglable so the user can deselect it after it kicked off.
          const selectable = selected || isStreamBatchable(s);
          return (
            <StreamCard
              key={s.id}
              stream={s}
              progress={progressByStream[s.id]}
              thumbLoading={thumbsRequesting.has(s.id)}
              selected={selected}
              selectable={selectable}
              batchActive={batchActive}
              onCopy={() => onCopy(s.url)}
              onDownload={() => onDownload(s)}
              onCancel={jobId ? () => onCancel(jobId) : undefined}
              onRequestThumb={() => onRequestThumb(s)}
              onToggleSelect={() => onToggleSelected(s.id)}
            />
          );
        })
      )}

      {picker ? (
        <PickerModal
          picker={picker}
          onConfirm={onPickerConfirm}
          onCancel={onPickerCancel}
        />
      ) : null}
    </div>
  );
}

function StreamCard({
  stream,
  progress,
  thumbLoading,
  selected,
  selectable,
  batchActive,
  onCopy,
  onDownload,
  onCancel,
  onRequestThumb,
  onToggleSelect,
}: {
  stream: DetectedStream;
  progress?: DownloadProgress;
  thumbLoading: boolean;
  selected: boolean;
  selectable: boolean;
  batchActive: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onCancel?: () => void;
  onRequestThumb: () => void;
  onToggleSelect: () => void;
}): JSX.Element {
  const isVirtualMse = stream.virtual === "mse";
  const tagClass = `stream__tag stream__tag--${stream.kind}`;
  const inFlight = progress && progress.phase !== "done" && progress.phase !== "error";
  const ratio = Math.max(0, Math.min(1, progress?.ratio ?? 0));
  // For images we just render the resource URL itself — no ffmpeg round
  // trip needed. Everything else uses the ffmpeg-extracted first frame
  // (auto-enqueued by the SW; the "Preview" button is a manual retry).
  const thumbSrc =
    stream.kind === "image" ? stream.url : stream.thumbDataUrl;
  // Virtual MSE rows have no fetchable URL — preview / copy / thumb extract
  // all rely on a real source, so suppress those affordances.
  const canExtract =
    !isVirtualMse &&
    (stream.kind === "hls" ||
      stream.kind === "dash" ||
      stream.kind === "mp4" ||
      stream.kind === "audio");
  const showPreviewButton = !stream.thumbDataUrl && canExtract;

  return (
    <div className={`stream${selected ? " stream--selected" : ""}`}>
      <div className="stream__body">
        <label
          className="stream__select"
          title={
            selectable
              ? "Include in batch download"
              : stream.virtual === "mse"
                ? "Recording rows are not part of the batch downloader"
                : "This stream is already downloading"
          }
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            disabled={!selectable}
          />
        </label>
        <div className={`stream__thumb${thumbSrc ? "" : " stream__thumb--placeholder"}`}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
          ) : thumbLoading ? (
            <span className="stream__thumb-label">…</span>
          ) : (
            <span className="stream__thumb-label">{KIND_LABEL[stream.kind]}</span>
          )}
        </div>
        <div className="stream__meta">
          <div className="stream__head">
            <span className={tagClass}>
              {isVirtualMse ? "REC" : KIND_LABEL[stream.kind]}
            </span>
            <span className="stream__name" title={stream.suggestedName}>
              {stream.suggestedName}
            </span>
            {stream.drmDetected ? (
              <span
                className="stream__pill stream__pill--drm"
                title="The page uses Encrypted Media Extensions. Segments will not decode without the license key."
              >
                DRM
              </span>
            ) : null}
            {stream.mseDetected && !stream.drmDetected && !isVirtualMse ? (
              <span
                className="stream__pill stream__pill--mse"
                title="The page feeds the player through MediaSource. The visible video.src may be a blob: URL — this row is the underlying source."
              >
                MSE
              </span>
            ) : null}
            {(stream.score ?? 0) >= 70 ? (
              <span
                className="stream__pill stream__pill--focus"
                title={`Confidence ${stream.score}/100 — likely the stream you right-clicked.`}
              >
                FOCUS
              </span>
            ) : null}
          </div>
          <p className="stream__url" title={isVirtualMse ? "Synthetic stream — clicking Record arms the SourceBuffer capture pipeline." : stream.url}>
            {isVirtualMse
              ? "Page is playing through MediaSource without exposing a manifest URL — record the buffer instead."
              : stream.url}
          </p>
        </div>
      </div>
      <div className="stream__actions">
        {isVirtualMse ? null : <button onClick={onCopy}>Copy URL</button>}
        {showPreviewButton ? (
          <button onClick={onRequestThumb} disabled={thumbLoading}>
            {thumbLoading ? "Extracting…" : "Preview"}
          </button>
        ) : null}
        {inFlight && onCancel ? (
          <button onClick={onCancel}>Cancel</button>
        ) : (
          <button
            className="primary"
            onClick={onDownload}
            disabled={!!inFlight || batchActive}
            title={batchActive ? "Batch download is running — wait for the queue to finish or stop it." : undefined}
          >
            {isVirtualMse ? "Record" : inFlight ? "Working…" : "Download"}
          </button>
        )}
      </div>
      {progress ? (
        <>
          <div className="progress">
            <div className="progress__bar" style={{ width: `${ratio * 100}%` }} />
          </div>
          <p
            className={
              progress.phase === "error"
                ? "progress__label progress__label--error"
                : progress.phase === "done"
                  ? "progress__label progress__label--done"
                  : "progress__label"
            }
          >
            {formatPhase(progress)}
          </p>
        </>
      ) : null}
    </div>
  );
}

function formatPhase(p: DownloadProgress): string {
  if (p.phase === "error") return `Error: ${p.error || "unknown"}`;
  if (p.phase === "done") return "Saved.";
  const seg = p.segmentsTotal ? ` (${p.segmentsDone ?? 0}/${p.segmentsTotal})` : "";
  const retries = p.retries ? ` · ${p.retries} retries` : "";
  const msg = p.message ? ` — ${p.message}` : "";
  return `${p.phase}${seg}${retries}${msg}`;
}

function PickerModal({
  picker,
  onConfirm,
  onCancel,
}: {
  picker: PendingPicker;
  onConfirm: (sel: DownloadSelection) => void;
  onCancel: () => void;
}): JSX.Element {
  const {
    variants,
    audioTracks,
    subtitleTracks,
    recommendedVariantUri,
    recommendedAudioId,
    isLive,
    unsupported,
  } = picker.result;
  const playableVariants = variants.filter((v) => !v.drm);
  const [variantUri, setVariantUri] = useState<string | undefined>(
    recommendedVariantUri && playableVariants.some((v) => v.uri === recommendedVariantUri)
      ? recommendedVariantUri
      : playableVariants[0]?.uri,
  );
  const [audioId, setAudioId] = useState<string | undefined>(recommendedAudioId);
  const [subtitleId, setSubtitleId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!variantUri && playableVariants[0]) setVariantUri(playableVariants[0].uri);
  }, [playableVariants, variantUri]);
  useEffect(() => {
    if (!audioId && audioTracks[0]) setAudioId(audioTracks[0].id);
  }, [audioTracks, audioId]);

  const probing =
    !variants.length &&
    !audioTracks.length &&
    !subtitleTracks.length &&
    !unsupported &&
    !isLive;
  const blocked = !!unsupported || !!isLive || (variants.length > 0 && playableVariants.length === 0);

  return (
    <div className="modal">
      <div className="modal__panel">
        <div className="modal__title">Pick what to download</div>
        <p className="modal__sub" title={picker.stream.url}>
          {picker.stream.suggestedName}
        </p>

        {probing ? (
          <div className="modal__probing">Probing playlist…</div>
        ) : blocked ? (
          <div className="modal__probing modal__probing--error">
            {unsupported?.reason ||
              (isLive
                ? "This is a live or event stream; merging a sliding window into one MP4 isn't supported."
                : "Every rendition in this manifest is DRM-protected.")}
          </div>
        ) : (
          <>
            {variants.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Resolution</div>
                <div className="modal__list">
                  {variants.map((v) => (
                    <VariantRow
                      key={v.uri}
                      variant={v}
                      selected={variantUri === v.uri}
                      recommended={v.uri === recommendedVariantUri}
                      onPick={() => setVariantUri(v.uri)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {audioTracks.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Audio track</div>
                <div className="modal__list">
                  {audioTracks.map((a) => (
                    <AudioRow
                      key={a.id}
                      track={a}
                      selected={audioId === a.id}
                      onPick={() => setAudioId(a.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {subtitleTracks.length > 0 ? (
              <div className="modal__section">
                <div className="modal__label">Subtitles (optional)</div>
                <div className="modal__list">
                  <button
                    className={`row${!subtitleId ? " row--selected" : ""}`}
                    onClick={() => setSubtitleId(undefined)}
                  >
                    <span className="row__main">None</span>
                  </button>
                  {subtitleTracks.map((t) => (
                    <SubtitleRow
                      key={t.id}
                      track={t}
                      selected={subtitleId === t.id}
                      onPick={() => setSubtitleId(t.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}

        <div className="modal__actions">
          <button onClick={onCancel}>{blocked ? "Close" : "Cancel"}</button>
          {blocked ? null : (
            <button
              className="primary"
              disabled={probing || !variantUri}
              onClick={() => onConfirm({ variantUri, audioId, subtitleId })}
            >
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function VariantRow({
  variant,
  selected,
  recommended,
  onPick,
}: {
  variant: VariantOption;
  selected: boolean;
  recommended: boolean;
  onPick: () => void;
}): JSX.Element {
  const label = variant.height
    ? `${variant.height}p`
    : variant.resolution || "unknown";
  const fps =
    variant.frameRate && variant.frameRate >= 1
      ? `${Math.round(variant.frameRate)}`
      : null;
  const mbps = variant.bandwidth
    ? ` · ${(variant.bandwidth / 1_000_000).toFixed(2)} Mbps`
    : "";
  const codec = variant.codecs ? ` · ${variant.codecs}` : "";
  // VIDEO-RANGE: HLS marks PQ for HDR10 / HLG for hybrid log-gamma. SDR is
  // the default and not worth a badge.
  const hdr = variant.videoRange && variant.videoRange !== "SDR" ? variant.videoRange : null;
  const drm = variant.drm ? variant.drm.toUpperCase() : null;
  return (
    <button
      className={`row${selected ? " row--selected" : ""}${drm ? " row--disabled" : ""}`}
      onClick={drm ? undefined : onPick}
      disabled={!!drm}
      title={drm ? "Encrypted by DRM — segments cannot be saved." : undefined}
    >
      <span className="row__main">
        {label}
        {fps ? `@${fps}` : ""}
        {mbps}
        {codec}
      </span>
      {hdr ? <span className="row__pill row__pill--hdr">{hdr}</span> : null}
      {drm ? <span className="row__pill row__pill--drm">DRM · {drm}</span> : null}
      {!drm && recommended ? <span className="row__pill">recommended</span> : null}
    </button>
  );
}

function AudioRow({
  track,
  selected,
  onPick,
}: {
  track: AudioTrackOption;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const lang = track.language ? ` · ${track.language}` : "";
  return (
    <button
      className={`row${selected ? " row--selected" : ""}`}
      onClick={onPick}
    >
      <span className="row__main">
        {track.name}
        {lang}
      </span>
      {track.default ? <span className="row__pill">default</span> : null}
    </button>
  );
}

function SubtitleRow({
  track,
  selected,
  onPick,
}: {
  track: SubtitleTrackOption;
  selected: boolean;
  onPick: () => void;
}): JSX.Element {
  const lang = track.language ? ` · ${track.language}` : "";
  return (
    <button
      className={`row${selected ? " row--selected" : ""}`}
      onClick={onPick}
    >
      <span className="row__main">
        {track.name}
        {lang}
      </span>
      {track.default ? <span className="row__pill">default</span> : null}
    </button>
  );
}
