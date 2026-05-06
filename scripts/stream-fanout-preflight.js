/**
 * Pre-flight checks for stream-fanout-runner.
 *
 * Phase 1 — source RTMP availability:
 *   - checkSourceAvailable(config): probes config.source via ffprobe, returns
 *     { ok, reason?, skipped? }. Generous 8s timeout to tolerate MediaMTX contention.
 *
 * Phase 4 — CPU benchmark + libfreetype check + hard cap:
 *   - checkLibfreetype(ffmpegPath): sync grep ffmpeg -version for drawtext support.
 *   - runBenchmarkWorker(config, variant): spawn 1 FFmpeg with -f null - output.
 *   - runPreflightBenchmark(config): orchestrate hard cap → libfreetype → CPU measure →
 *     project N variants → compare against budget. Returns rich result object.
 *
 * Benchmark flow (system-wide CPU via os.cpus()):
 *   [0-2s]   baseline sampling (other-process load)
 *   [2-6s]   spawn FFmpeg, warmup 4s (skip init spikes — libx264 cold start is slow)
 *   [6-12s]  sample window (6s steady-state CPU)
 *   [12s]    kill benchmark worker, compute projection
 *
 * Timing tuned in phase 5 follow-up: 2s warmup + 5s sample caused false-negatives on
 * cold starts where libx264 was still initializing during the sample window (measured
 * ~0% CPU). Expanded to 4s warmup + 6s sample to cover x264 init reliably.
 *
 * Projection:  sampleCpu × variantCount × 1.15 (safety) ≤ cores × 100 × 0.8 (budget)
 */

import { execFileSync, spawn, exec } from "child_process";
import fs from "fs";
import os from "os";

import { buildBenchmarkArgs } from "./stream-fanout-ffmpeg-args.js";
import { normalizeDestinations } from "./stream-fanout-variant-validator.js";
import { snapshotCpuTicks, busyPctBetween, sleep } from "./stream-fanout-cpu-meter.js";

const SAFETY_FACTOR = 1.15;    // project 15% higher than measured (cache/scheduler overhead)
const BUDGET_FRACTION = 0.8;   // leave 20% headroom for OS/MediaMTX/user apps

// Phase 1: source probe. Prevents cryptic "I/O error" from FFmpeg when OBS isn't streaming.
export function checkSourceAvailable(config) {
  return new Promise((resolve) => {
    const ffprobePath = config.ffmpegPath.replace(/ffmpeg\.exe$/i, "ffprobe.exe");
    if (!fs.existsSync(ffprobePath)) {
      resolve({ ok: true, skipped: true });
      return;
    }
    const PROBE_TIMEOUT_MS = 8000;
    const cmd = `"${ffprobePath}" -v error -rw_timeout ${PROBE_TIMEOUT_MS * 1000} -show_streams -of json "${config.source}"`;
    exec(cmd, { timeout: PROBE_TIMEOUT_MS + 2000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const stderrLine = stderr?.trim().split("\n").find((l) => l.trim() && !l.startsWith('"'));
        const reason = stderrLine || (err.killed ? `timeout (ffprobe did not respond in ${PROBE_TIMEOUT_MS / 1000}s)` : "source not reachable");
        resolve({ ok: false, reason });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

// Phase 4: grep ffmpeg build for libfreetype. drawtext fails without it.
export function checkLibfreetype(ffmpegPath) {
  try {
    const out = execFileSync(ffmpegPath, ["-version"], {
      encoding: "utf-8",
      windowsHide: true,
      timeout: 5000,
    });
    return /enable-libfreetype/.test(out);
  } catch {
    return false;
  }
}

// Phase 4: spawn a representative variant worker with -f null (no RTMP, no disk).
// Uses lavfi testsrc2 instead of config.source so the benchmark never stalls waiting
// for RTMP frames — testsrc2 generates synthetic video immediately, giving a clean
// CPU measurement of the encode pipeline regardless of network/source state.
// Caller owns lifecycle — must call kill() when done.
export function runBenchmarkWorker(config, variant) {
  const benchArgs = buildBenchmarkArgs(variant);

  // Debug: log the exact command so failures are diagnosable.
  process.stderr.write(`[benchmark] ffmpeg ${benchArgs.join(" ")}\n`);

  const proc = spawn(config.ffmpegPath, benchArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  // Capture stderr so premature-exit errors surface in the benchmark failure message.
  const stderrLines = [];
  proc.stderr.on("data", (data) => {
    const lines = data.toString().split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      // Keep only error/warning lines — skip progress spam.
      if (/error|invalid|unknown|failed|cannot|no such/i.test(line)) {
        stderrLines.push(line.trim());
      }
    }
  });

  proc.on("error", () => {});
  return {
    proc,
    stderrLines,
    kill: () => {
      try {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      } catch { /* already dead */ }
    },
  };
}

// Phase 4: full pre-flight. Returns { ok, sampleCpuPct?, projectedCpuPct?, totalBudget?,
// totalCores?, variantCount, warnings[], reason?, skipped? }.
export async function runPreflightBenchmark(config) {
  const totalCores = os.cpus().length;
  const normalized = normalizeDestinations(config.destinations);
  const variantDests = normalized.filter((d) => d.variant);
  const warnings = [];

  // NOTE: hard cap is enforced in validateConfig (config-loader). This function trusts
  // that validation has already run and focuses on CPU measurement.

  // Gate: libfreetype check (warning only — drawtext will fail at runtime but not here).
  const hasDrawtext = variantDests.some((d) => d.variant.drawtext);
  if (hasDrawtext && !checkLibfreetype(config.ffmpegPath)) {
    warnings.push("FFmpeg build lacks --enable-libfreetype: drawtext filters will fail at runtime.");
  }

  // Skip CPU measurement when no variants or preflightBenchmark disabled.
  if (variantDests.length === 0 || config.antiDuplicate?.preflightBenchmark === false) {
    return { ok: true, variantCount: variantDests.length, totalCores, warnings, skipped: true };
  }

  // Baseline: measure other-process load for 2s so we can subtract it later.
  const baseBefore = snapshotCpuTicks();
  await sleep(2000);
  const baseAfter = snapshotCpuTicks();
  const baselinePct = busyPctBetween(baseBefore, baseAfter);

  // Strip runtime-only fields (startOffsetSec would skew warmup idle-sampling if >0).
  const benchVariant = { ...variantDests[0].variant };
  delete benchVariant.startOffsetSec;

  // L7 fix: register SIGINT cleanup so Ctrl+C mid-benchmark doesn't leak FFmpeg.
  const worker = runBenchmarkWorker(config, benchVariant);
  const sigintHandler = () => { worker.kill(); process.exit(130); };
  process.once("SIGINT", sigintHandler);

  let sampleCpuPct = 0;
  try {
    await sleep(4000); // warmup (FFmpeg init, filter graph setup, libx264 cold start)
    const t0 = snapshotCpuTicks();
    await sleep(6000); // steady-state sample
    const t1 = snapshotCpuTicks();

    // M5 fix: detect spawn failure / early exit. If benchmark died, sampleCpuPct is
    // measuring noise and the projection will falsely read "0% CPU per variant" → OK.
    if (worker.proc.exitCode !== null) {
      const stderrHint = worker.stderrLines.length > 0
        ? ` | ffmpeg stderr: ${worker.stderrLines.slice(-3).join(" | ")}`
        : "";
      return {
        ok: false,
        reason: `benchmark worker exited prematurely (code=${worker.proc.exitCode})${stderrHint}`,
        variantCount: variantDests.length,
        warnings,
      };
    }

    const measuredPct = busyPctBetween(t0, t1);
    sampleCpuPct = Math.max(0, measuredPct - baselinePct);

    // M5 fix: sanity — expect ≥5% CPU for a real 720p+ encode. Below that = spawn failure
    // or FFmpeg stalled on source.
    if (sampleCpuPct < 5) {
      return {
        ok: false,
        reason: `benchmark measured ${sampleCpuPct.toFixed(1)}% CPU (<5% sanity floor) — FFmpeg may have stalled or failed silently`,
        variantCount: variantDests.length,
        warnings,
      };
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    worker.kill();
  }

  const projectedCpuPct = sampleCpuPct * variantDests.length * SAFETY_FACTOR;
  const totalBudget = totalCores * 100 * BUDGET_FRACTION;

  const result = {
    ok: projectedCpuPct <= totalBudget,
    sampleCpuPct: Math.round(sampleCpuPct),
    projectedCpuPct: Math.round(projectedCpuPct),
    totalBudget: Math.round(totalBudget),
    totalCores,
    variantCount: variantDests.length,
    baselinePct: Math.round(baselinePct),
    warnings,
  };
  if (!result.ok) {
    result.reason = `projected ${result.projectedCpuPct}% exceeds budget ${result.totalBudget}% on ${totalCores} cores`;
  }
  return result;
}
