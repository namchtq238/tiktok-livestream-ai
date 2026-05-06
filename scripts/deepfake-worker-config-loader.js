/**
 * Config loader for worker-per-destination Deep-Live-Cam streaming.
 *
 * This mode is intentionally separate from stream-fanout-runner.js:
 * every worker pulls the same clean source, swaps one synthetic avatar face,
 * then publishes directly to one RTMP/RTMPS destination.
 */

import fs from "fs";
import path from "path";

export const DEFAULT_CONFIG = {
  pythonPath: "python",
  deepLiveCamRoot: "C:\\path\\to\\Deep-Live-Cam",
  ffmpegPath: "ffmpeg",
  source: "rtmp://127.0.0.1/live/source",
  executionProvider: "cuda",
  executionThreads: 2,
  statusIntervalMs: 30000,
  restartPolicy: {
    enabled: true,
    maxRestarts: 3,
    delayMs: 5000,
  },
  disclosure: {
    enabled: true,
    text: "AI avatar",
  },
  workers: [],
};

const RESOLUTION_RE = /^\d+x\d+$/;
const BITRATE_RE = /^\d+(?:\.\d+)?[kKmM]$/;

export function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") parsed.configFile = argv[++i];
    else if (a === "--source") parsed.source = argv[++i];
    else if (a === "--worker") parsed.workerId = argv[++i];
    else if (a === "--no-restart") parsed.noRestart = true;
    else if (a === "--no-disclosure") parsed.noDisclosure = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

export function printHelp() {
  console.log(`Deepfake Worker Runner

Usage:
  node deepfake-worker-runner.js --config deepfake-worker-runner.example.config.json

Options:
  --config FILE       Read worker config JSON
  --source URL        Override source stream URL
  --worker ID         Run only one worker from config
  --no-restart        Disable per-worker restart policy
  --no-disclosure     Disable default AI avatar disclosure overlay
  --help, -h          Show this help
`);
}

function mergeConfig(base, fileConfig) {
  const config = { ...base, ...fileConfig };
  config.restartPolicy = {
    ...base.restartPolicy,
    ...(fileConfig.restartPolicy || {}),
  };
  config.disclosure = {
    ...base.disclosure,
    ...(fileConfig.disclosure || {}),
  };
  return config;
}

function resolveWorkerPaths(config, configDir) {
  if (!Array.isArray(config.workers) || !configDir) return;
  for (const worker of config.workers) {
    if (typeof worker.avatarPath === "string" && !path.isAbsolute(worker.avatarPath)) {
      worker.avatarPath = path.resolve(configDir, worker.avatarPath);
    }
  }
}

export function loadConfig(args, defaultConfigPath) {
  const configFile = args.configFile || defaultConfigPath;
  let config = { ...DEFAULT_CONFIG };
  let configDir = null;

  if (configFile && fs.existsSync(configFile)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      config = mergeConfig(DEFAULT_CONFIG, fileConfig);
      configDir = path.dirname(path.resolve(configFile));
    } catch (err) {
      console.error(`Config parse error (${configFile}): ${err.message}`);
      process.exit(1);
    }
  }

  if (args.source) config.source = args.source;
  if (args.noRestart) config.restartPolicy.enabled = false;
  if (args.noDisclosure) config.disclosure.enabled = false;
  if (args.workerId && Array.isArray(config.workers)) {
    config.workers = config.workers.filter((worker) => worker.id === args.workerId);
  }

  resolveWorkerPaths(config, configDir);
  return config;
}

function workerDestination(worker) {
  if (worker.destinationUrl) return worker.destinationUrl;
  if (worker.destinationUrlEnv) return process.env[worker.destinationUrlEnv];
  return null;
}

export function redactUrl(url) {
  if (!url || typeof url !== "string") return "<missing>";
  const lastSlash = url.lastIndexOf("/");
  if (lastSlash === -1) return "<redacted>";
  const prefix = url.slice(0, lastSlash + 1);
  const key = url.slice(lastSlash + 1);
  if (key.length <= 8) return `${prefix}<redacted>`;
  return `${prefix}${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function getResolvedWorkers(config) {
  return (config.workers || []).map((worker, idx) => ({
    ...worker,
    idx,
    destinationUrl: workerDestination(worker),
  }));
}

export function validateConfig(config) {
  const errors = [];

  if (!config.deepLiveCamRoot || config.deepLiveCamRoot === DEFAULT_CONFIG.deepLiveCamRoot) {
    errors.push(`deepLiveCamRoot must point to a local Deep-Live-Cam checkout`);
  } else if (!fs.existsSync(config.deepLiveCamRoot)) {
    errors.push(`deepLiveCamRoot not found: ${config.deepLiveCamRoot}`);
  }

  if (!config.source || typeof config.source !== "string") {
    errors.push(`source must be a non-empty RTMP/RTMPS URL`);
  }

  if (!Array.isArray(config.workers) || config.workers.length === 0) {
    errors.push(`workers must be a non-empty array`);
  }

  if (!["cuda", "cpu", "directml", "dml", "coreml", "openvino", "rocm"].includes(config.executionProvider)) {
    errors.push(`executionProvider must be cuda, cpu, directml, dml, coreml, openvino, or rocm`);
  }

  const resolvedWorkers = getResolvedWorkers(config);
  const ids = new Set();
  for (const worker of resolvedWorkers) {
    const prefix = `workers[${worker.idx}]`;
    if (!worker.id || typeof worker.id !== "string") {
      errors.push(`${prefix}.id must be a non-empty string`);
    } else if (ids.has(worker.id)) {
      errors.push(`${prefix}.id duplicates '${worker.id}'`);
    } else {
      ids.add(worker.id);
    }

    if (!worker.avatarPath || typeof worker.avatarPath !== "string") {
      errors.push(`${prefix}.avatarPath must be a non-empty path`);
    } else if (!fs.existsSync(worker.avatarPath)) {
      errors.push(`${prefix}.avatarPath not found: ${worker.avatarPath}`);
    }

    if (!worker.destinationUrl && !worker.destinationUrlEnv) {
      errors.push(`${prefix} must define destinationUrl or destinationUrlEnv`);
    } else if (!worker.destinationUrl) {
      errors.push(`${prefix}.destinationUrlEnv '${worker.destinationUrlEnv}' is not set in the environment`);
    }

    if (!worker.resolution || !RESOLUTION_RE.test(worker.resolution)) {
      errors.push(`${prefix}.resolution must match WxH, e.g. 1280x720`);
    }

    if (!Number.isInteger(worker.fps) || worker.fps < 1 || worker.fps > 60) {
      errors.push(`${prefix}.fps must be an integer 1..60`);
    }

    if (!worker.bitrate || !BITRATE_RE.test(worker.bitrate)) {
      errors.push(`${prefix}.bitrate must include k or M, e.g. 3000k`);
    }

    if (worker.startOffsetSec !== undefined) {
      const offset = worker.startOffsetSec;
      if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 120) {
        errors.push(`${prefix}.startOffsetSec must be a number 0..120`);
      }
    }
  }

  if (!Number.isInteger(config.executionThreads) || config.executionThreads < 1 || config.executionThreads > 16) {
    errors.push(`executionThreads must be an integer 1..16`);
  }

  if (!Number.isInteger(config.statusIntervalMs) || config.statusIntervalMs < 1000) {
    errors.push(`statusIntervalMs must be an integer >= 1000`);
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`ERROR: ${err}`);
    return false;
  }
  return true;
}
