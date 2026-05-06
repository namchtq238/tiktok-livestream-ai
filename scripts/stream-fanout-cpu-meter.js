/**
 * CPU measurement utilities for pre-flight benchmark (phase 4).
 *
 * Uses os.cpus() (system-wide) with baseline subtraction to estimate FFmpeg's
 * marginal CPU cost. Cross-platform (Win + Linux + macOS), zero external deps.
 *
 * Why system-wide instead of per-PID wmic/ps/proc?
 *   - No platform-specific tooling (wmic deprecated on Win11, /proc missing on mac).
 *   - Baseline captures other processes (browser, Discord) so projection stays honest.
 *   - Accuracy is fine for the question we ask ("can we fit N more FFmpegs?"),
 *     not precise attribution ("exactly how much did THIS process consume").
 *
 * Units: busy pct is in range [0, 100 × cores]. So 100 = 1 core saturated,
 * 400 = 4 cores saturated. Easier to reason about than raw 0-100.
 */

import os from "os";

// Snapshot total + idle tick counters across all cores.
// Units are OS-internal ticks; only differences between snapshots are meaningful.
export function snapshotCpuTicks() {
  const cpus = os.cpus();
  let total = 0;
  let idle = 0;
  for (const c of cpus) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { total, idle, cores: cpus.length };
}

// Busy percentage between two snapshots, scaled by core count.
// Returns 0 if the interval was too short or negative (clock skew, sleep drift).
export function busyPctBetween(before, after) {
  const dTotal = after.total - before.total;
  const dIdle = after.idle - before.idle;
  if (dTotal <= 0) return 0;
  const busyFrac = 1 - dIdle / dTotal;
  return Math.max(0, busyFrac * 100 * after.cores);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
