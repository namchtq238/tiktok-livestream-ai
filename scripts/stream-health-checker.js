#!/usr/bin/env node
/**
 * Stream Health Checker — monitors RTMP paths on MediaMTX.
 *
 * Replaces ffplay-based verification (which stalls on Windows — see note13).
 * Uses ffprobe to check each path is publishing valid H264+AAC streams.
 *
 * Usage:
 *   node stream-health-checker.js
 *   node stream-health-checker.js --config custom-config.json
 *
 * Zero external dependencies (built-in Node modules only).
 * Config: stream-health-checker.config.json (same folder).
 * Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md (§2.4)
 */

import { exec } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as twitchChecker from "./twitch-upstream-checker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Default config — overridden by config.json if present
const DEFAULT_CONFIG = {
  // Check method — "hls" (recommended: HTTP, light, works at scale)
  // or "ffprobe" (legacy: RTMP probe, can false-positive under load).
  checkMethod: "hls",
  // HLS base URL (MediaMTX serves HLS at :8888 by default)
  hlsBase: "http://127.0.0.1:8888",
  // RTMP server (used only when checkMethod=ffprobe)
  server: "rtmp://127.0.0.1",
  paths: ["live/stream", "fan1", "fan2", "fan3"],
  intervalMs: 10000,
  hlsTimeoutMs: 2000,
  ffprobeTimeoutMs: 3000,
  ffprobePath: "C:\\Users\\LENOVO\\Downloads\\ffmpeg-8.1-essentials_build\\ffmpeg-8.1-essentials_build\\bin\\ffprobe.exe",
  consecutiveFailuresToAlert: 2,
  quiet: false,
  includeSource: true,
  sourcePath: "live/stream",
  fanoutPrefix: "fan",
  // Upstream check — verify channels actually live on Twitch (not just local MediaMTX).
  // Requires scripts/twitch-api.json (gitignored) with Client ID/Secret + userLogins.
  twitch: {
    enabled: false,
    configFile: "twitch-api.json",
    intervalMs: 60000,
  },
};

// Track consecutive failures per path — suppress flapping noise
const failureCount = new Map();

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--count") parsed.count = parseInt(args[++i], 10);
    else if (a === "--config") parsed.configFile = args[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Stream Health Checker

Usage:
  node stream-health-checker.js [options]

Options:
  --count N       Auto-generate paths to monitor: live/stream + fan1..fanN
                  (matches --count used with stream-fanout-runner.js)
  --config FILE   Read config from FILE (JSON) instead of default
  --help, -h      Show this help

Examples:
  node stream-health-checker.js                 # use config paths
  node stream-health-checker.js --count 10      # monitor live/stream + fan1..fan10
  node stream-health-checker.js --count 50      # monitor 51 paths
`);
}

function loadConfig(cliArgs) {
  const configFile = cliArgs.configFile || path.join(__dirname, "stream-health-checker.config.json");
  let config = { ...DEFAULT_CONFIG };

  if (fs.existsSync(configFile)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      config = { ...config, ...fileConfig };
    } catch (err) {
      console.error(`Config parse error (${configFile}): ${err.message}`);
      process.exit(1);
    }
  }

  // --count N overrides paths: live/stream + fan1..fanN
  if (cliArgs.count && cliArgs.count > 0) {
    const generated = [];
    if (config.includeSource) generated.push(config.sourcePath);
    for (let i = 1; i <= cliArgs.count; i++) {
      generated.push(`${config.fanoutPrefix}${i}`);
    }
    config.paths = generated;
  }

  return config;
}

// HLS-based check: fetch index.m3u8. Fast (~50-200ms), no RTMP contention.
// MediaMTX returns 200 when path is publishing, 404 when not.
function checkPathViaHLS(config, streamPath) {
  return new Promise((resolve) => {
    const url = `${config.hlsBase}/${streamPath}/index.m3u8`;
    const startTime = Date.now();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, elapsedMs: Date.now() - startTime });
    };

    const req = http.get(url, { timeout: config.hlsTimeoutMs }, (res) => {
      // Drain response to free socket
      res.resume();
      if (res.statusCode === 200) {
        done({ path: streamPath, healthy: true });
      } else {
        done({ path: streamPath, healthy: false, reason: `HTTP ${res.statusCode}` });
      }
    });

    req.on("timeout", () => {
      req.destroy();
      done({ path: streamPath, healthy: false, reason: "timeout" });
    });
    req.on("error", (err) => {
      done({ path: streamPath, healthy: false, reason: err.code || err.message });
    });
  });
}

// Legacy ffprobe check — kept as optional fallback. Heavy on MediaMTX under load.
function checkPathViaFFprobe(config, streamPath) {
  return new Promise((resolve) => {
    const url = `${config.server}/${streamPath}`;
    const cmd = `"${config.ffprobePath}" -v error -rw_timeout ${config.ffprobeTimeoutMs * 1000} -show_streams -of json "${url}"`;
    const startTime = Date.now();

    exec(cmd, { timeout: config.ffprobeTimeoutMs + 1000, windowsHide: true }, (err, stdout, stderr) => {
      const elapsedMs = Date.now() - startTime;

      if (err) {
        const reason = err.killed ? "timeout" : (stderr?.trim().split("\n")[0] || err.message);
        resolve({ path: streamPath, healthy: false, reason, elapsedMs });
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const video = data.streams?.find((s) => s.codec_type === "video");
        const audio = data.streams?.find((s) => s.codec_type === "audio");

        if (video && audio) {
          resolve({
            path: streamPath,
            healthy: true,
            codecs: `${video.codec_name}/${audio.codec_name}`,
            resolution: `${video.width}x${video.height}`,
            elapsedMs,
          });
        } else {
          const missing = [];
          if (!video) missing.push("video");
          if (!audio) missing.push("audio");
          resolve({ path: streamPath, healthy: false, reason: `missing_${missing.join("_")}`, elapsedMs });
        }
      } catch (parseErr) {
        resolve({ path: streamPath, healthy: false, reason: `parse_error: ${parseErr.message}`, elapsedMs });
      }
    });
  });
}

function checkPath(config, streamPath) {
  return config.checkMethod === "ffprobe"
    ? checkPathViaFFprobe(config, streamPath)
    : checkPathViaHLS(config, streamPath);
}

function formatTimestamp() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

async function runCheck(config) {
  // HLS checks (HTTP) are light — parallel is fine.
  // ffprobe (RTMP) checks must be sequential to avoid MediaMTX contention.
  const results = config.checkMethod === "ffprobe"
    ? await (async () => {
        const out = [];
        for (const p of config.paths) out.push(await checkPath(config, p));
        return out;
      })()
    : await Promise.all(config.paths.map((p) => checkPath(config, p)));
  const ts = formatTimestamp();

  const alerts = [];
  const pending = []; // failed but below alert threshold
  const healthy = [];

  for (const result of results) {
    if (result.healthy) {
      failureCount.set(result.path, 0);
      healthy.push(result);
    } else {
      const prev = failureCount.get(result.path) || 0;
      const next = prev + 1;
      failureCount.set(result.path, next);
      if (next >= config.consecutiveFailuresToAlert) {
        alerts.push({ ...result, failCount: next });
      } else {
        pending.push({ ...result, failCount: next });
      }
    }
  }

  // Choose log level: ALERT > WARN > OK
  if (alerts.length > 0) {
    console.warn(`[${ts}] ALERT ${alerts.length}/${results.length} unhealthy (>= ${config.consecutiveFailuresToAlert} consecutive fails):`);
    for (const a of alerts) {
      console.warn(`  - ${a.path} (failed ${a.failCount}x): ${a.reason}  [${a.elapsedMs}ms]`);
    }
    if (pending.length > 0) {
      console.warn(`  pending: ${pending.map((p) => `${p.path}(${p.failCount}x)`).join(", ")}`);
    }
    if (healthy.length > 0) {
      console.log(`  healthy: ${healthy.map((h) => h.path).join(", ")}`);
    }
  } else if (pending.length > 0) {
    console.warn(`[${ts}] WARN ${pending.length}/${results.length} failing (below alert threshold):`);
    for (const p of pending) {
      console.warn(`  - ${p.path} (failed ${p.failCount}x): ${p.reason}  [${p.elapsedMs}ms]`);
    }
    if (healthy.length > 0) {
      console.log(`  healthy: ${healthy.map((h) => h.path).join(", ")}`);
    }
  } else if (!config.quiet) {
    const summary = healthy.map((h) => `${h.path}(${h.elapsedMs}ms)`).join(" ");
    console.log(`[${ts}] OK  ${healthy.length}/${results.length} healthy  ${summary}`);
  }
}

// Twitch upstream poll — runs on its own interval (lighter than RTMP checks).
// Reuses twitch-upstream-checker.js module so config/auth logic stays in one place.
async function runTwitchCheck(twitchCreds, twitchConfigFile) {
  try {
    const results = await twitchChecker.checkOnce(twitchCreds, twitchConfigFile);
    const ts = formatTimestamp();
    const live = results.filter((r) => r.live);
    const offline = results.filter((r) => !r.live);
    if (offline.length > 0) {
      console.warn(`[${ts}] TWITCH OFFLINE  ${offline.map((r) => r.login).join(", ")}`);
    }
    if (live.length > 0) {
      const summary = live.map((r) => `${r.login}(viewers=${r.viewers})`).join(" ");
      console.log(`[${ts}] TWITCH LIVE     ${summary}`);
    }
  } catch (err) {
    console.error(`[${formatTimestamp()}] TWITCH ERROR  ${err.message}`);
  }
}

function startTwitchPoll(config) {
  const twCfg = config.twitch;
  if (!twCfg || !twCfg.enabled) return null;
  const twitchConfigFile = path.isAbsolute(twCfg.configFile)
    ? twCfg.configFile
    : path.join(__dirname, twCfg.configFile);
  let twitchCreds;
  try {
    twitchCreds = twitchChecker.loadCredentials(twitchConfigFile);
  } catch (err) {
    console.error(`Twitch check disabled — ${err.message}`);
    return null;
  }
  console.log(`  twitch:       enabled  channels=${twitchCreds.userLogins.join(",")}  interval=${twCfg.intervalMs}ms`);
  runTwitchCheck(twitchCreds, twitchConfigFile);
  return setInterval(() => runTwitchCheck(twitchCreds, twitchConfigFile), twCfg.intervalMs);
}

function validateConfig(config) {
  if (config.checkMethod === "ffprobe" && !fs.existsSync(config.ffprobePath)) {
    console.error(`ERROR: ffprobe not found at ${config.ffprobePath}`);
    console.error(`Fix: set "ffprobePath" in config, or switch checkMethod to "hls"`);
    return false;
  }
  if (!["hls", "ffprobe"].includes(config.checkMethod)) {
    console.error(`ERROR: checkMethod must be "hls" or "ffprobe", got "${config.checkMethod}"`);
    return false;
  }
  if (!Array.isArray(config.paths) || config.paths.length === 0) {
    console.error(`ERROR: config.paths must be a non-empty array`);
    return false;
  }
  return true;
}

function main() {
  const cliArgs = parseArgs();
  const config = loadConfig(cliArgs);
  if (!validateConfig(config)) process.exit(1);

  console.log(`Stream Health Checker`);
  console.log(`  method:       ${config.checkMethod}`);
  console.log(`  target:       ${config.checkMethod === "hls" ? config.hlsBase : config.server}`);
  console.log(`  paths:        ${config.paths.length <= 6 ? config.paths.join(", ") : `${config.paths.slice(0, 3).join(", ")}, ..., ${config.paths.slice(-1)[0]} (total ${config.paths.length})`}`);
  console.log(`  interval:     ${config.intervalMs}ms`);
  console.log(`  probe timeout:${config.checkMethod === "hls" ? config.hlsTimeoutMs : config.ffprobeTimeoutMs}ms`);
  console.log(`  alert after:  ${config.consecutiveFailuresToAlert} consecutive failures`);
  console.log(`  ----`);

  // Initial check, then periodic
  runCheck(config);
  const intervalId = setInterval(() => runCheck(config), config.intervalMs);
  const twitchIntervalId = startTwitchPoll(config);

  process.on("SIGINT", () => {
    console.log(`\nShutdown requested, stopping...`);
    clearInterval(intervalId);
    if (twitchIntervalId) clearInterval(twitchIntervalId);
    process.exit(0);
  });
}

main();
