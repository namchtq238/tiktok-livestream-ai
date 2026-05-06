# Deep-Live-Cam Worker Runner Setup

This mode sends the same clean source stream to multiple workers. Each worker
loads one synthetic avatar face, runs Deep-Live-Cam headlessly, and publishes
directly to one RTMP/RTMPS destination.

Use only synthetic or consented likenesses. Keep the default disclosure overlay
enabled unless the streaming platform provides an equivalent disclosure.

## Local NVIDIA GPU

1. Install Python 3.11, FFmpeg, NVIDIA driver, CUDA, cuDNN, and Deep-Live-Cam.
2. Place Deep-Live-Cam models in its `models` folder.
3. Copy `scripts/deepfake-worker-runner.example.config.json` to
   `scripts/deepfake-worker-runner.config.json`.
4. Set:
   - `deepLiveCamRoot` to the Deep-Live-Cam checkout.
   - `avatarPath` per worker.
   - `TIKTOK_RTMP_1`, `TIKTOK_RTMP_2`, `TIKTOK_RTMP_3` in the shell environment.
5. Start OBS to publish the clean source to `rtmp://127.0.0.1/live/source`.
6. Run:

```powershell
npm run deepfake:run
```

Start with one worker by adding `--worker avatar-1` to the underlying command:

```powershell
node scripts/deepfake-worker-runner.js --config scripts/deepfake-worker-runner.config.json --worker avatar-1
```

## Rented Single GPU VM

1. Use a persistent Linux GPU VM or pod with NVIDIA runtime support.
2. Install FFmpeg, Python 3.11, Deep-Live-Cam, CUDA-compatible dependencies,
   and the required Deep-Live-Cam models.
3. Run MediaMTX or another RTMP server on the VM.
4. Push the clean OBS source to the VM source URL, for example:
   `rtmp://VM_PUBLIC_HOST/live/source`.
5. Store TikTok destinations in environment variables, not in config files.
6. Run the same `deepfake-worker-runner.js` config with Linux paths.
7. Use systemd, pm2, or supervisord for long-running operation. The runner has
   per-worker restart limits, but the outer process should also be supervised.

## Health Checks

- Verify source availability before workers start. The runner uses ffprobe when
  available.
- Test local loopback RTMP outputs before using TikTok stream keys.
- Watch GPU utilization and dropped frames. Scale from 1 worker to 3 workers,
  then to 5 only after a stable 30-minute run.
