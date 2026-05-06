# TikTok Live Automation

Utilities for TikTok Live stream-key/account workflows and a Deep-Live-Cam
worker runner for local testing or RTMP/RTMPS streaming.

## Safety

Use only synthetic or consented likenesses. Keep disclosure enabled for real
streams unless the platform provides equivalent disclosure.

## Requirements

- Windows PowerShell
- Node.js LTS
- Python 3.11 for Deep-Live-Cam
- FFmpeg and FFprobe
- NVIDIA CUDA stack for CUDA execution
- Microsoft Visual C++ Build Tools for Python native packages

See [scripts/deepfake-new-local-pc-setup.md](scripts/deepfake-new-local-pc-setup.md)
for a full fresh-PC setup.

## Install

```powershell
npm.cmd install
```

Use `npm.cmd` on Windows if PowerShell blocks `npm.ps1`.

## Commands

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run deepfake:run
npm.cmd run deepfake:example
```

Run one deepfake worker:

```powershell
npm.cmd run deepfake:run -- --worker avatar-1
```

Run one worker without automatic restart:

```powershell
npm.cmd run deepfake:run -- --worker avatar-1 --no-restart
```

## Deepfake Worker Config

Copy the example config when setting up a new machine:

```powershell
Copy-Item scripts\deepfake-worker-runner.example.config.json scripts\deepfake-worker-runner.config.json
```

Edit:

```text
scripts/deepfake-worker-runner.config.json
```

Important fields:

```json
{
  "pythonPath": "C:\\Users\\Kai\\IdeaProjects\\Deep-Live-Cam\\venv\\Scripts\\python.exe",
  "deepLiveCamRoot": "C:\\Users\\Kai\\IdeaProjects\\Deep-Live-Cam",
  "ffmpegPath": "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
  "source": "rtmp://127.0.0.1/live/source"
}
```

Local file outputs can use MP4:

```json
"destinationUrl": "D:\\TEMP\\trump-output.mp4"
```

RTMP/RTMPS outputs are streamed with the FLV muxer automatically:

```json
"destinationUrlEnv": "TIKTOK_RTMP_1"
```

## Source Stream

The worker expects a clean source RTMP stream:

```text
rtmp://127.0.0.1/live/source
```

Verify it before starting workers:

```powershell
ffmpeg -hide_banner -loglevel info -i rtmp://127.0.0.1/live/source -t 180 -f null -
```

If this exits early, fix OBS or the RTMP server first.

## Current Local Worker Defaults

The current local config is tuned for stability with multiple workers:

```json
{
  "resolution": "1280x720",
  "fps": 15,
  "bitrate": "2500k"
}
```

If two workers lag, reduce to `10 fps` or `960x540`.

## Output Behavior

- Local `.mp4` outputs are timestamped automatically.
- Local `.flv` outputs are timestamped automatically.
- RTMP/RTMPS outputs are not timestamped and stream directly to the destination.
- MP4 files need a clean shutdown to finalize. Stop with `Ctrl+C`.

Example local output:

```text
D:\TEMP\trump-output-20260507-012116.mp4
```

## Config and Secrets

Real local configs and stream keys are ignored by Git:

```text
config/accounts.json
scripts/tiktok-keys.json
scripts/twitch-api.json
scripts/deepfake-worker-runner.config.json
```

Keep example files committed, but do not commit account files, stream keys, or
machine-specific config.

## More Docs

- [Deepfake worker setup](scripts/deepfake-worker-setup.md)
- [Fresh local PC setup](scripts/deepfake-new-local-pc-setup.md)
