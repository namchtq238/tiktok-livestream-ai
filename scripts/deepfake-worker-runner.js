#!/usr/bin/env node
/**
 * Worker-per-TikTok Deep-Live-Cam runner.
 *
 * One clean source stream is pulled independently by each worker. Every worker
 * applies a different synthetic avatar face and publishes directly to one
 * RTMP/RTMPS destination.
 */

import path from "path";
import { fileURLToPath } from "url";

import { parseArgs, loadConfig, validateConfig } from "./deepfake-worker-config-loader.js";
import { checkSourceAvailable } from "./stream-fanout-preflight.js";
import { runDeepfakeWorkers } from "./deepfake-worker-workers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = parseArgs();
  const defaultConfigPath = path.join(__dirname, "deepfake-worker-runner.config.json");
  const config = loadConfig(args, defaultConfigPath);
  if (!validateConfig(config)) process.exit(1);

  process.stdout.write(`Checking source ${config.source} ... `);
  const check = await checkSourceAvailable(config);
  if (check.ok) {
    console.log(check.skipped ? "skipped (ffprobe not found)" : "OK");
  } else {
    console.log("FAIL");
    console.error(`\nERROR: source is not publishing.`);
    console.error(`  reason: ${check.reason}`);
    console.error(`\nFix checklist:`);
    console.error(`  1. Start MediaMTX or your RTMP server.`);
    console.error(`  2. Start OBS streaming to ${config.source}.`);
    console.error(`  3. Confirm ffprobe can read the source before starting workers.`);
    process.exit(2);
  }

  runDeepfakeWorkers(config);
}

main();
