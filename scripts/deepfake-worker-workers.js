/**
 * Process supervision for Deep-Live-Cam worker-per-destination mode.
 */

import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { getResolvedWorkers, redactUrl } from "./deepfake-worker-config-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKER_SCRIPT = path.join(__dirname, "deep-live-cam-rtmp-worker.py");

function forwardOutput(proc, id) {
  const forward = (stream, write) => {
    stream.on("data", (data) => {
      const lines = data.toString().split(/\r?\n/).filter((line) => line.trim());
      for (const line of lines) write(`[${id}] ${line}\n`);
    });
  };
  forward(proc.stdout, (line) => process.stdout.write(line));
  forward(proc.stderr, (line) => process.stderr.write(line));
}

export function buildWorkerArgs(config, worker) {
  const scriptPath = config.workerScriptPath || DEFAULT_WORKER_SCRIPT;
  const args = [
    scriptPath,
    "--deep-live-cam-root", config.deepLiveCamRoot,
    "--source", config.source,
    "--avatar", worker.avatarPath,
    "--output", worker.destinationUrl,
    "--ffmpeg", config.ffmpegPath,
    "--resolution", worker.resolution,
    "--fps", String(worker.fps),
    "--bitrate", worker.bitrate,
    "--execution-provider", worker.executionProvider || config.executionProvider,
    "--execution-threads", String(worker.executionThreads || config.executionThreads),
  ];

  const disclosure = worker.disclosure || config.disclosure;
  if (disclosure && disclosure.enabled !== false) {
    args.push("--disclosure-text", disclosure.text || "AI avatar");
  } else {
    args.push("--no-disclosure");
  }

  if (worker.manyFaces) args.push("--many-faces");
  if (worker.encoder) args.push("--encoder", worker.encoder);
  return args;
}

function scheduleWorker(spawnFn, offsetMs) {
  if (offsetMs <= 0) {
    spawnFn();
    return { timer: null, cancel: () => {} };
  }
  const timer = setTimeout(spawnFn, offsetMs);
  return { timer, cancel: () => clearTimeout(timer) };
}

export function runDeepfakeWorkers(config) {
  const workersConfig = getResolvedWorkers(config)
    .sort((a, b) => (a.startOffsetSec || 0) - (b.startOffsetSec || 0));

  console.log(`Deepfake Worker Runner`);
  console.log(`  source:       ${config.source}`);
  console.log(`  workers:      ${workersConfig.length}`);
  console.log(`  provider:     ${config.executionProvider}`);
  console.log(`  root:         ${config.deepLiveCamRoot}`);
  for (const worker of workersConfig) {
    const offset = worker.startOffsetSec || 0;
    console.log(`  -> ${worker.id} @ T+${offset}s ${worker.resolution}/${worker.fps}fps ${worker.bitrate} dest=${redactUrl(worker.destinationUrl)}`);
  }
  console.log(`  ----`);

  const live = new Map();
  const pending = [];
  const restarts = new Map();
  let shuttingDown = false;

  const stopWorker = (record) => {
    if (record && record.proc.exitCode === null) record.proc.kill("SIGTERM");
  };

  const spawnOne = (worker) => {
    const id = worker.id;
    const args = buildWorkerArgs(config, worker);
    const proc = spawn(config.pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: config.deepLiveCamRoot,
    });

    const record = { id, proc, worker, startedAt: Date.now() };
    live.set(id, record);
    forwardOutput(proc, id);

    proc.on("error", (err) => {
      console.error(`[${id}] spawn error: ${err.message}`);
    });

    proc.on("exit", (code, signal) => {
      live.delete(id);
      console.log(`[${id}] exited code=${code} signal=${signal || "-"} dest=${redactUrl(worker.destinationUrl)}`);
      if (shuttingDown || code === 0 || !config.restartPolicy?.enabled) return;

      const count = restarts.get(id) || 0;
      const max = config.restartPolicy.maxRestarts ?? 0;
      if (count >= max) {
        console.error(`[${id}] restart limit reached (${count}/${max}); leaving worker stopped`);
        return;
      }

      const nextCount = count + 1;
      restarts.set(id, nextCount);
      const delayMs = config.restartPolicy.delayMs ?? 5000;
      console.warn(`[${id}] restarting in ${delayMs}ms (${nextCount}/${max})`);
      setTimeout(() => {
        if (!shuttingDown) spawnOne(worker);
      }, delayMs);
    });
  };

  for (const worker of workersConfig) {
    const offsetMs = (worker.startOffsetSec || 0) * 1000;
    const handle = scheduleWorker(() => spawnOne(worker), offsetMs);
    if (handle.timer) pending.push(handle);
  }

  const statusInterval = setInterval(() => {
    const ids = Array.from(live.keys()).join(", ") || "none";
    console.log(`[status] ${live.size}/${workersConfig.length} workers alive (${ids})`);
  }, config.statusIntervalMs);

  process.on("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutdown requested, stopping deepfake workers...`);
    for (const handle of pending) handle.cancel();
    clearInterval(statusInterval);
    for (const record of live.values()) stopWorker(record);
    setTimeout(() => process.exit(0), 1500);
  });
}
