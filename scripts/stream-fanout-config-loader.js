/**
 * Config loader and CLI argument parser for stream-fanout-runner.
 *
 * Responsibilities:
 *   - DEFAULT_CONFIG constant (legacy: 3 loopback destinations, tee mode + antiDuplicate off)
 *   - parseArgs(): parse CLI flags (--count, --mode, --config, --help)
 *   - printHelp(): usage banner
 *   - loadConfig(args, defaultConfigPath): merge defaults + config file + CLI overrides.
 *     Resolves relative `overlayImage` paths against the config file directory so the
 *     config stays portable (works regardless of cwd when invoked).
 *   - validateConfig(config): top-level ffmpeg + destinations + mode checks, then delegates
 *     to stream-fanout-variant-validator for schema validation. Enforces antiDuplicate.maxStreams.
 *
 * Variant schema validation lives in stream-fanout-variant-validator.js to keep this
 * module under the 200-LOC cap. Legacy config (destinations as string[]) still passes
 * validation and runs through the `-c copy` path unchanged.
 */

import fs from "fs";
import path from "path";

import {
  normalizeDestinations,
  validateVariant,
  validateAntiDuplicate,
} from "./stream-fanout-variant-validator.js";

export const DEFAULT_CONFIG = {
  ffmpegPath: "C:\\Users\\LENOVO\\Downloads\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffmpeg.exe",
  source: "rtmp://127.0.0.1/live/stream",
  loopbackBase: "rtmp://127.0.0.1",
  destinations: [
    "rtmp://127.0.0.1/fan1",
    "rtmp://127.0.0.1/fan2",
    "rtmp://127.0.0.1/fan3",
  ],
  mode: "tee",
  antiDuplicate: {
    enabled: false,
    preflightBenchmark: true,
    maxStreams: 5,
  },
};

export function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--count") parsed.count = parseInt(args[++i], 10);
    else if (a === "--mode") parsed.mode = args[++i];
    else if (a === "--config") parsed.configFile = args[++i];
    else if (a === "--skip-benchmark") parsed.skipBenchmark = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

export function printHelp() {
  console.log(`Stream Fanout Runner

Usage:
  node stream-fanout-runner.js [options]

Options:
  --count N       Auto-generate N loopback destinations (rtmp://127.0.0.1/fan1..fanN)
  --mode MODE     'tee' (1 process, simple) or 'multi' (N processes, crash isolation)
                  Default: tee. Recommended: multi for N >= 10.
  --config FILE   Read destinations from FILE (JSON)
  --skip-benchmark Bypass phase-4 CPU benchmark (debug/testing only)
  --help, -h      Show this help

Examples:
  node stream-fanout-runner.js                               # 3 loopback destinations, tee
  node stream-fanout-runner.js --count 10                    # 10 destinations, tee
  node stream-fanout-runner.js --count 50 --mode multi       # 50 destinations, multi-process
  node stream-fanout-runner.js --config tiktok-keys.json     # real TikTok URLs
`);
}

// Resolve relative overlay paths against the config file's directory so the config
// is portable (cwd-independent). Mutates variant.overlayImage in place.
function resolveVariantPaths(config, configFileDir) {
  if (!Array.isArray(config.destinations) || !configFileDir) return;
  for (const dest of config.destinations) {
    if (typeof dest !== "object" || dest === null || !dest.variant) continue;
    const v = dest.variant;
    if (typeof v.overlayImage === "string" && !path.isAbsolute(v.overlayImage)) {
      v.overlayImage = path.resolve(configFileDir, v.overlayImage);
    }
  }
}

export function loadConfig(args, defaultConfigPath) {
  let config = { ...DEFAULT_CONFIG };
  const configFile = args.configFile || defaultConfigPath;
  let configFileDir = null;
  if (configFile && fs.existsSync(configFile)) {
    try {
      const file = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      config = { ...config, ...file };
      // Deep-merge antiDuplicate so partial config doesn't wipe defaults.
      if (file.antiDuplicate) {
        config.antiDuplicate = { ...DEFAULT_CONFIG.antiDuplicate, ...file.antiDuplicate };
      }
      configFileDir = path.dirname(path.resolve(configFile));
    } catch (err) {
      console.error(`Config parse error (${configFile}): ${err.message}`);
      process.exit(1);
    }
  }
  // CLI overrides
  if (args.count) {
    config.destinations = [];
    for (let i = 1; i <= args.count; i++) {
      config.destinations.push(`${config.loopbackBase}/fan${i}`);
    }
  }
  if (args.mode) config.mode = args.mode;

  resolveVariantPaths(config, configFileDir);
  return config;
}

export function validateConfig(config) {
  if (!fs.existsSync(config.ffmpegPath)) {
    console.error(`ERROR: ffmpeg not found at ${config.ffmpegPath}`);
    console.error(`Fix: set "ffmpegPath" in stream-fanout-runner.config.json`);
    return false;
  }
  if (!Array.isArray(config.destinations) || config.destinations.length === 0) {
    console.error(`ERROR: config.destinations must be a non-empty array`);
    return false;
  }
  if (!["tee", "multi"].includes(config.mode)) {
    console.error(`ERROR: config.mode must be 'tee' or 'multi', got '${config.mode}'`);
    return false;
  }

  let normalized;
  try {
    normalized = normalizeDestinations(config.destinations);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return false;
  }

  // Aggregate all schema errors so user sees everything in one pass.
  const errors = [
    ...validateAntiDuplicate(config.antiDuplicate),
    ...normalized
      .filter((d) => d.variant)
      .flatMap((d) => validateVariant(d.variant, d.idx)),
  ];
  if (errors.length > 0) {
    for (const e of errors) console.error(`ERROR ${e}`);
    return false;
  }

  // Hard cap: when antiDuplicate is enabled, cap how many variant destinations may run.
  // Prevents silently overloading the host before phase-4 CPU benchmark even measures.
  if (config.antiDuplicate && config.antiDuplicate.enabled) {
    const variantCount = normalized.filter((d) => d.variant).length;
    const maxStreams = config.antiDuplicate.maxStreams ?? DEFAULT_CONFIG.antiDuplicate.maxStreams;
    if (variantCount > maxStreams) {
      console.error(`ERROR: ${variantCount} variant destinations exceeds antiDuplicate.maxStreams=${maxStreams}`);
      console.error(`Fix: reduce destinations or raise maxStreams (upper limit 10).`);
      return false;
    }
  }
  return true;
}
