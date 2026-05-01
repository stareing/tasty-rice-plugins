/**
 * Adaptive per-fetch timeout. Tracks recent successful segment durations and
 * derives a tighter ceiling for outliers — a "long-tail" segment lingering
 * on a slow CDN edge gets aborted early and re-issued instead of stalling
 * the whole job behind one connection.
 *
 * Stays conservative until enough samples accumulate (`MIN_SAMPLES`) and
 * never drops below `MIN_BUDGET_MS`, so the first few segments — and
 * legitimately-slow content — aren't penalised. Returns `undefined` when
 * the global ceiling is the right answer; the caller falls back to it.
 */

const WINDOW = 16;
const STALL_FACTOR = 3;
const MIN_SAMPLES = 4;
const MIN_BUDGET_MS = 5_000;

export class TailLossTracker {
  private readonly samples: number[] = [];

  observe(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push(durationMs);
    if (this.samples.length > WINDOW) this.samples.shift();
  }

  /**
   * Returns a per-attempt fetch budget in milliseconds when enough recent
   * samples justify a tighter-than-default ceiling, undefined otherwise.
   *
   * The caller is expected to clamp this against its absolute maximum
   * (so a wildly slow run doesn't extend a stall past the global limit).
   */
  budgetMs(): number | undefined {
    if (this.samples.length < MIN_SAMPLES) return undefined;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.max(MIN_BUDGET_MS, median * STALL_FACTOR);
  }
}
