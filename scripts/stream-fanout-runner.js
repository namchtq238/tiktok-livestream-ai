#!/usr/bin/env node
/**
 * Stream Fanout Runner — entrypoint.
 *
 * Spawns FFmpeg fanout for N destinations using one of two legacy modes (Phase 1):
 *   tee    — 1 FFmpeg process with -f tee muxer. Simple. Blast radius = N.
 *   multi  — N FFmpeg processes, 1 destination each. Crash isolation. Recommended N >= 10.
 *
 * Usage:
 *   node stream-fanout-runner.js                           # from config.json
 *   node stream-fanout-runner.js --count 10                # 10 loopback destinations, tee mode
 *   node stream-fanout-runner.js --count 50 --mode multi   # 50 destinations, multi-process
 *   node stream-fanout-runner.js --config custom.json      # custom destinations (real TikTok keys)
 *
 * Modular layout (Phase 1 refactor):
 *   stream-fanout-runner.js          → this entrypoint (parse → load → preflight → dispatch)
 *   stream-fanout-config-loader.js   → DEFAULT_CONFIG, parseArgs, loadConfig, validateConfig
 *   stream-fanout-ffmpeg-args.js     → buildLegacyTeeArgs, buildLegacyCopyArgs (pure)
 *   stream-fanout-preflight.js       → checkSourceAvailable (ffprobe)
 *   stream-fanout-workers.js         → runTeeMode, runMultiMode (spawn + lifecycle)
 *
 * Phase 2-5 will extend each sibling module independently — entrypoint stays small.
 *
 * Zero external dependencies.
 * Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md
 */

import path from "path";
import { fileURLToPath } from "url";

import { parseArgs, loadConfig, validateConfig } from "./stream-fanout-config-loader.js";
import { normalizeDestinations } from "./stream-fanout-variant-validator.js";
import { checkSourceAvailable, runPreflightBenchmark } from "./stream-fanout-preflight.js";
import { runTeeMode, runMultiMode, runMultiVariantMode } from "./stream-fanout-workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = parseArgs();
  const defaultConfigPath = path.join(__dirname, "stream-fanout-runner.config.json");
  const config = loadConfig(args, defaultConfigPath);
  if (!validateConfig(config)) process.exit(1);

  // Pre-flight source check
  process.stdout.write(`Checking source ${config.source} ... `);
  const check = await checkSourceAvailable(config);
  if (check.ok) {
    console.log(check.skipped ? "skipped (ffprobe not found)" : "OK");
  } else {
    console.log("FAIL");
    console.error(`\nERROR: source is not publishing.`);
    console.error(`  reason: ${check.reason}`);
    console.error(`\nFix checklist:`);
    console.error(`  1. Is MediaMTX running?       docker ps | grep mediamtx`);
    console.error(`  2. Is OBS Start Streaming?    check OBS Studio`);
    console.error(`  3. Verify publisher on server:`);
    console.error(`     docker logs <container> | grep "publishing to path"`);
    process.exit(2);
  }

  const hasVariant = normalizeDestinations(config.destinations).some((d) => d.variant);

  // Phase 4: run pre-flight benchmark when variants are configured and antiDuplicate
  // is explicitly enabled. Skippable via --skip-benchmark (debug). Exit 3 on abort.
  if (hasVariant && config.antiDuplicate && config.antiDuplicate.enabled && !args.skipBenchmark) {
    process.stdout.write(`Pre-flight benchmark (up to ~12s)... `);
    const bench = await runPreflightBenchmark(config);
    // L3 fix (phase 4 review): print warnings BEFORE branching so libfreetype/baseline
    // warnings are surfaced even when the benchmark aborts.
    for (const w of bench.warnings || []) console.warn(`  WARN: ${w}`);

    if (bench.skipped) {
      console.log(`skipped`);
    } else if (bench.ok) {
      console.log(`OK`);
      if (bench.sampleCpuPct !== undefined) {
        console.log(`  1 variant ≈ ${bench.sampleCpuPct}% CPU (baseline ${bench.baselinePct || 0}%).`);
        console.log(`  ${bench.variantCount} variants projected ${bench.projectedCpuPct}% / budget ${bench.totalBudget}% (${bench.totalCores} cores)`);
      }
    } else {
      console.log(`FAIL`);
      console.error(`\nERROR: pre-flight benchmark aborted.`);
      console.error(`  reason: ${bench.reason}`);
      console.error(`\nFix:`);
      console.error(`  - Reduce variant count in config`);
      console.error(`  - Lower resolution (1080p → 720p) or bitrate`);
      console.error(`  - Use hardware encoder (NVENC/QSV) — see plans/260424-1053-anti-duplicate-fanout/reports/planner-260424-1510-scale-to-50-streams.md`);
      console.error(`  - Debug bypass: --skip-benchmark (not recommended for production)`);
      process.exit(3);
    }
  } else if (hasVariant && args.skipBenchmark) {
    console.warn(`WARN: --skip-benchmark set. Pre-flight CPU check bypassed.`);
  }

  // H2 fix (phase 5 review): surface silent mode override when variants are present.
  // Variant dispatch ignores config.mode — warn user in case they meant legacy.
  if (hasVariant && config.mode === "tee") {
    console.warn(`WARN: config.mode="tee" ignored — variant destinations always use multi-variant dispatch.`);
  }

  // Phase 5 dispatch: variant destinations use re-encode pipeline with stagger.
  // Legacy (string) destinations keep the zero-CPU `-c copy` path (tee or multi).
  if (hasVariant) runMultiVariantMode(config);
  else if (config.mode === "tee") runTeeMode(config);
  else runMultiMode(config);
}

main();
