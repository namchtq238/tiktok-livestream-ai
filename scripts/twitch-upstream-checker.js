#!/usr/bin/env node
/**
 * Twitch Upstream Checker — verifies channels are actually live on Twitch.
 *
 * Complements stream-health-checker.js (which only sees local MediaMTX).
 * Uses Twitch Helix API: GET /helix/streams?user_login=X
 *   - non-empty data[] => channel live
 *   - empty data[]     => offline (key rejected, upstream broke, or OBS stopped)
 *
 * Auth: App access token via client_credentials. Token cached to disk,
 * auto-refreshed when <5 min TTL or on 401.
 *
 * Usage:
 *   node twitch-upstream-checker.js                 # poll forever
 *   node twitch-upstream-checker.js --once          # single check, exit
 *   node twitch-upstream-checker.js --config FILE   # custom creds file
 *
 * Zero external deps. Docs: ../docs/twitch-upstream-check-setup.md
 */

import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh if <5m left

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { once: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--once") parsed.once = true;
    else if (a === "--config") parsed.configFile = args[++i];
    else if (a === "--interval") parsed.intervalMs = parseInt(args[++i], 10);
    else if (a === "--help" || a === "-h") {
      console.log(`Twitch Upstream Checker

Usage:
  node twitch-upstream-checker.js [options]

Options:
  --once             One-shot check, then exit (good for cron)
  --config FILE      Credentials JSON (default: twitch-api.json)
  --interval MS      Poll interval (default: 60000 = 1 min)
  --help, -h         Show this help

Config file format (twitch-api.json):
  {
    "clientId":     "xxxxxxxx",
    "clientSecret": "xxxxxxxx",
    "userLogins":   ["votuanbk232"]
  }
`);
      process.exit(0);
    }
  }
  return parsed;
}

export function loadCredentials(configFile) {
  const file = configFile || path.join(__dirname, "twitch-api.json");
  if (!fs.existsSync(file)) {
    console.error(`ERROR: credentials file not found: ${file}`);
    console.error(`Hint: copy twitch-api.json.example → twitch-api.json and fill in Client ID/Secret.`);
    console.error(`Setup guide: docs/twitch-upstream-check-setup.md`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error(`ERROR: ${file} missing clientId or clientSecret`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.userLogins) || cfg.userLogins.length === 0) {
    console.error(`ERROR: ${file} must have userLogins: ["name1", ...]`);
    process.exit(1);
  }
  return cfg;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let chunks = "";
      res.on("data", (d) => (chunks += d));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: chunks, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Token cache kept beside the credentials file — same gitignore scope
function tokenCachePath(configFile) {
  const base = configFile ? path.dirname(configFile) : __dirname;
  return path.join(base, ".twitch-token-cache.json");
}

function loadCachedToken(configFile) {
  const p = tokenCachePath(configFile);
  if (!fs.existsSync(p)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (cache.expiresAt && cache.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cache.accessToken;
    }
  } catch { /* ignore corrupt cache, will refetch */ }
  return null;
}

function saveCachedToken(configFile, accessToken, expiresInSec) {
  const p = tokenCachePath(configFile);
  const data = { accessToken, expiresAt: Date.now() + expiresInSec * 1000 };
  fs.writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
}

async function fetchAppToken(creds) {
  const body = `client_id=${encodeURIComponent(creds.clientId)}&client_secret=${encodeURIComponent(creds.clientSecret)}&grant_type=client_credentials`;
  const res = await httpsRequest({
    method: "POST",
    hostname: "id.twitch.tv",
    path: "/oauth2/token",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);
  if (res.status !== 200) {
    throw new Error(`Token fetch failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
  }
  const data = JSON.parse(res.body);
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function getAccessToken(creds, configFile, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = loadCachedToken(configFile);
    if (cached) return cached;
  }
  const { accessToken, expiresIn } = await fetchAppToken(creds);
  saveCachedToken(configFile, accessToken, expiresIn);
  return accessToken;
}

async function fetchStreams(creds, token, userLogins) {
  const query = userLogins.map((l) => `user_login=${encodeURIComponent(l)}`).join("&");
  const res = await httpsRequest({
    method: "GET",
    hostname: "api.twitch.tv",
    path: `/helix/streams?${query}`,
    headers: {
      "Client-Id": creds.clientId,
      "Authorization": `Bearer ${token}`,
    },
  });
  return { status: res.status, body: res.body };
}

export async function checkOnce(creds, configFile) {
  let token = await getAccessToken(creds, configFile);
  let { status, body } = await fetchStreams(creds, token, creds.userLogins);

  // Token expired/revoked mid-session — refresh once and retry
  if (status === 401) {
    token = await getAccessToken(creds, configFile, true);
    ({ status, body } = await fetchStreams(creds, token, creds.userLogins));
  }
  if (status !== 200) {
    throw new Error(`Helix streams failed: HTTP ${status} ${body.slice(0, 200)}`);
  }

  const data = JSON.parse(body);
  const liveByLogin = new Map();
  for (const s of data.data || []) liveByLogin.set(s.user_login.toLowerCase(), s);

  return creds.userLogins.map((login) => {
    const lower = login.toLowerCase();
    const stream = liveByLogin.get(lower);
    return stream
      ? { login, live: true, viewers: stream.viewer_count, startedAt: stream.started_at, title: stream.title }
      : { login, live: false };
  });
}

function formatTimestamp() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

function logResults(results) {
  const ts = formatTimestamp();
  const live = results.filter((r) => r.live);
  const offline = results.filter((r) => !r.live);

  if (live.length > 0) {
    for (const r of live) {
      const mins = Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60000);
      console.log(`[${ts}] TWITCH LIVE  ${r.login}  viewers=${r.viewers}  up=${mins}m`);
    }
  }
  if (offline.length > 0) {
    console.warn(`[${ts}] TWITCH OFFLINE  ${offline.map((r) => r.login).join(", ")}`);
  }
}

async function main() {
  const args = parseArgs();
  const creds = loadCredentials(args.configFile);
  const intervalMs = args.intervalMs || 60000;

  if (args.once) {
    try {
      const results = await checkOnce(creds, args.configFile);
      logResults(results);
      process.exit(results.every((r) => r.live) ? 0 : 2);
    } catch (err) {
      console.error(`[${formatTimestamp()}] TWITCH ERROR  ${err.message}`);
      process.exit(1);
    }
  }

  console.log(`Twitch Upstream Checker`);
  console.log(`  channels:  ${creds.userLogins.join(", ")}`);
  console.log(`  interval:  ${intervalMs}ms`);
  console.log(`  ----`);

  const tick = async () => {
    try {
      const results = await checkOnce(creds, args.configFile);
      logResults(results);
    } catch (err) {
      console.error(`[${formatTimestamp()}] TWITCH ERROR  ${err.message}`);
    }
  };
  await tick();
  const id = setInterval(tick, intervalMs);
  process.on("SIGINT", () => {
    console.log(`\nShutdown requested, stopping...`);
    clearInterval(id);
    process.exit(0);
  });
}

// Run main() only when this file is the entrypoint (ESM equivalent of require.main === module)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
