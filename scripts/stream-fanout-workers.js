/**
 * Worker spawning logic for stream-fanout-runner.
 *
 * Phase 1 legacy modes (`-c copy`):
 *   - runTeeMode(config): 1 FFmpeg process, tee muxer fans out to N destinations.
 *     Simple, but crash blast radius = N (one bad sink kills all).
 *   - runMultiMode(config): N FFmpeg processes (1 per destination). Crash isolation;
 *     recommended for N >= 10. Filters noisy `frame=` progress lines.
 *
 * Phase 5 variant mode (re-encode with staggered start):
 *   - spawnVariantWorker(config, destNormalized, idx): spawn 1 FFmpeg with the variant
 *     filter chain. Returns { id, proc, dest }.
 *   - scheduleWorker(spawnFn, offsetMs): setTimeout wrapper with cancel().
 *   - runMultiVariantMode(config): sort variants by startOffsetSec, spawn staggered,
 *     aggregate SIGINT cleanup for pending timers + live workers.
 *
 * All three runX modes register their own SIGINT handler. They are mutually exclusive
 * (runner.js picks one per invocation), so duplicate registration is theoretical.
 */

import { spawn } from "child_process";
import { buildLegacyTeeArgs, buildLegacyCopyArgs, buildVariantArgs } from "./stream-fanout-ffmpeg-args.js";
import { normalizeDestinations } from "./stream-fanout-variant-validator.js";

// Shared stderr forwarder: prefix each non-progress line with [workerId].
function forwardStderr(proc, id) {
  proc.stderr.on("data", (data) => {
    const lines = data.toString().split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      if (/^frame=\s*\d/.test(line.trim())) continue; // skip flood
      process.stderr.write(`[${id}] ${line}\n`);
    }
  });
}

export function runTeeMode(config) {
  const args = buildLegacyTeeArgs(config.source, config.destinations);

  console.log(`Stream Fanout Runner — TEE MODE`);
  console.log(`  source:       ${config.source}`);
  console.log(`  destinations: ${config.destinations.length}`);
  console.log(`  first 3:      ${config.destinations.slice(0, 3).join(", ")}${config.destinations.length > 3 ? ", ..." : ""}`);
  console.log(`  ----`);

  const proc = spawn(config.ffmpegPath, args, { stdio: "inherit" });

  process.on("SIGINT", () => {
    console.log(`\nShutdown requested, stopping FFmpeg...`);
    proc.kill("SIGTERM");
  });

  proc.on("exit", (code) => {
    console.log(`FFmpeg exited with code ${code}`);
    process.exit(code || 0);
  });
}

export function runMultiMode(config) {
  console.log(`Stream Fanout Runner — MULTI MODE`);
  console.log(`  source:       ${config.source}`);
  console.log(`  processes:    ${config.destinations.length}`);
  console.log(`  ----`);

  const workers = config.destinations.map((dest, idx) => {
    const id = `w${String(idx + 1).padStart(2, "0")}`;
    const args = buildLegacyCopyArgs(config.source, dest);
    const proc = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    forwardStderr(proc, id);
    proc.on("exit", (code, signal) => {
      console.log(`[${id}] exited code=${code} signal=${signal || "-"} dest=${dest}`);
    });
    return { id, proc, dest };
  });

  const aliveInterval = setInterval(() => {
    const alive = workers.filter((w) => w.proc.exitCode === null).length;
    console.log(`[status] ${alive}/${workers.length} workers alive`);
  }, 30000);

  process.on("SIGINT", () => {
    console.log(`\nShutdown requested, stopping ${workers.length} processes...`);
    clearInterval(aliveInterval);
    workers.forEach((w) => {
      if (w.proc.exitCode === null) w.proc.kill("SIGTERM");
    });
    setTimeout(() => process.exit(0), 1500);
  });
}

// Phase 5: spawn one FFmpeg with the variant filter + encoder chain.
function spawnVariantWorker(config, destNormalized, idx) {
  const id = `vw${String(idx + 1).padStart(2, "0")}`;
  const args = buildVariantArgs(config.source, destNormalized.url, destNormalized.variant);
  const proc = spawn(config.ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  forwardStderr(proc, id);
  // M2 fix (phase 5 review): surface spawn failures (EACCES, ENOMEM, PATH issues)
  // so the runner can see them instead of silently hanging on a dead worker.
  proc.on("error", (err) => {
    console.error(`[${id}] spawn error: ${err.message}`);
  });
  proc.on("exit", (code, signal) => {
    console.log(`[${id}] exited code=${code} signal=${signal || "-"} dest=${destNormalized.url}`);
  });
  return { id, proc, dest: destNormalized.url };
}

// Phase 5: fire spawnFn now or after offsetMs. Returns cancel() for SIGINT cleanup.
function scheduleWorker(spawnFn, offsetMs) {
  if (offsetMs <= 0) {
    spawnFn();
    return { timer: null, cancel: () => {} };
  }
  const timer = setTimeout(spawnFn, offsetMs);
  return { timer, cancel: () => clearTimeout(timer) };
}

// Phase 5: stagger N variant workers by startOffsetSec, manage lifecycle + cleanup.
export function runMultiVariantMode(config) {
  const variantDests = normalizeDestinations(config.destinations)
    .filter((d) => d.variant)
    .sort((a, b) => (a.variant.startOffsetSec || 0) - (b.variant.startOffsetSec || 0));

  console.log(`Stream Fanout Runner — MULTI-VARIANT MODE`);
  console.log(`  source:       ${config.source}`);
  console.log(`  variants:     ${variantDests.length}`);
  for (const d of variantDests) {
    const offset = d.variant.startOffsetSec || 0;
    console.log(`  → ${d.url} @ T+${offset}s (${d.variant.resolution} ${d.variant.bitrate})`);
  }
  console.log(`  ----`);

  const workers = [];
  const pending = [];
  const startTime = Date.now();
  const maxOffsetMs = Math.max(0, ...variantDests.map((d) => (d.variant.startOffsetSec || 0) * 1000));

  variantDests.forEach((dest, idx) => {
    const offsetMs = (dest.variant.startOffsetSec || 0) * 1000;
    const spawnFn = () => {
      try {
        const w = spawnVariantWorker(config, dest, idx);
        // Order matters: push BEFORE log so SIGINT arriving mid-spawn sees the worker
        // in the kill list (prevents orphan FFmpeg from narrow race window).
        workers.push(w);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${w.id}] spawned at T+${elapsed}s → ${dest.url}`);
      } catch (err) {
        console.error(`[vw${String(idx + 1).padStart(2, "0")}] spawn failed: ${err.message}`);
      }
    };
    const handle = scheduleWorker(spawnFn, offsetMs);
    if (handle.timer) pending.push({ idx, handle });
  });

  // Status interval starts 1s after the last worker spawns.
  let aliveInterval = null;
  const statusStart = setTimeout(() => {
    aliveInterval = setInterval(() => {
      const alive = workers.filter((w) => w.proc.exitCode === null).length;
      console.log(`[status] ${alive}/${workers.length} workers alive`);
    }, 30000);
  }, maxOffsetMs + 1000);

  // H1 fix (phase 5 review): idempotent SIGINT handler so double Ctrl+C doesn't
  // re-enter the cleanup path (which would double-kill workers and log spam).
  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutdown requested, cleaning up...`);
    pending.forEach((p) => p.handle.cancel());
    clearTimeout(statusStart);
    if (aliveInterval) clearInterval(aliveInterval);
    workers.forEach((w) => {
      if (w.proc.exitCode === null) w.proc.kill("SIGTERM");
    });
    setTimeout(() => process.exit(0), 1500);
  });
}
