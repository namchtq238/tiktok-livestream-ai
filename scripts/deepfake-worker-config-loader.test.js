import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  getResolvedWorkers,
  redactUrl,
  validateConfig,
} from "./deepfake-worker-config-loader.js";
import { buildWorkerArgs } from "./deepfake-worker-workers.js";

function makeTempAsset() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dlc-worker-test-"));
  const avatar = path.join(dir, "avatar.png");
  fs.writeFileSync(avatar, "not-a-real-image");
  return { dir, avatar };
}

describe("deepfake worker config", () => {
  const envKeys = [];

  afterEach(() => {
    for (const key of envKeys.splice(0)) delete process.env[key];
  });

  it("resolves destinationUrlEnv without leaking the full URL in redaction", () => {
    const key = "TEST_TIKTOK_DEST_1";
    envKeys.push(key);
    process.env[key] = "rtmps://push-live.tiktokcdn.com/live/live_1234567890abcdef";

    const config = {
      workers: [{ id: "a", destinationUrlEnv: key }],
    };

    const workers = getResolvedWorkers(config);
    expect(workers[0].destinationUrl).toBe(process.env[key]);
    expect(redactUrl(workers[0].destinationUrl)).toBe("rtmps://push-live.tiktokcdn.com/live/live...cdef");
  });

  it("validates a minimal worker config", () => {
    const { dir, avatar } = makeTempAsset();
    try {
      const key = "TEST_TIKTOK_DEST_2";
      envKeys.push(key);
      process.env[key] = "rtmp://127.0.0.1/live/test";

      const config = {
        deepLiveCamRoot: dir,
        source: "rtmp://127.0.0.1/live/source",
        executionProvider: "cuda",
        executionThreads: 2,
        statusIntervalMs: 30000,
        workers: [
          {
            id: "avatar-1",
            avatarPath: avatar,
            destinationUrlEnv: key,
            resolution: "1280x720",
            fps: 30,
            bitrate: "3000k",
            startOffsetSec: 0,
          },
        ],
      };

      expect(validateConfig(config)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds a headless Python worker command", () => {
    const worker = {
      id: "avatar-1",
      avatarPath: "C:\\avatars\\avatar-1.png",
      destinationUrl: "rtmp://127.0.0.1/live/a",
      resolution: "1280x720",
      fps: 30,
      bitrate: "3000k",
    };
    const config = {
      deepLiveCamRoot: "C:\\Deep-Live-Cam",
      source: "rtmp://127.0.0.1/live/source",
      ffmpegPath: "ffmpeg",
      executionProvider: "cuda",
      executionThreads: 2,
      disclosure: { enabled: true, text: "AI avatar" },
    };

    const args = buildWorkerArgs(config, worker);
    expect(args).toContain("--deep-live-cam-root");
    expect(args).toContain("C:\\Deep-Live-Cam");
    expect(args).toContain("--avatar");
    expect(args).toContain("C:\\avatars\\avatar-1.png");
    expect(args).toContain("--output");
    expect(args).toContain("rtmp://127.0.0.1/live/a");
    expect(args).toContain("--disclosure-text");
  });
});
