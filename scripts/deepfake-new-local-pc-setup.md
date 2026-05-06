# Deepfake Worker Setup on a New Local PC

This guide sets up the current worker runner on a fresh Windows PC.

Use only synthetic or consented likenesses. Keep disclosure enabled for real
streams unless the platform provides equivalent disclosure.

## 1. Install System Tools

Run PowerShell:

```powershell
winget install Python.Python.3.11
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
```

Open a new PowerShell window, then verify:

```powershell
py -0p
node --version
npm.cmd --version
ffmpeg -version
ffprobe -version
```

## 2. Set Up Deep-Live-Cam

```powershell
cd C:\Users\Kai\IdeaProjects\Deep-Live-Cam

py -3.11 -m venv venv
.\venv\Scripts\python.exe -m pip install --upgrade pip setuptools wheel cython
.\venv\Scripts\python.exe -m pip install -r requirements.txt

.\venv\Scripts\python.exe -m pip install -U torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
.\venv\Scripts\python.exe -m pip uninstall onnxruntime onnxruntime-gpu -y
.\venv\Scripts\python.exe -m pip install onnxruntime-gpu==1.21.0
```

Verify imports and CUDA:

```powershell
.\venv\Scripts\python.exe -c "import sys, cv2, insightface, onnxruntime; print(sys.version); print(cv2.__version__); print(insightface.__version__); print(onnxruntime.get_available_providers())"
```

`CUDAExecutionProvider` should appear in the providers list.

## 3. Install Deep-Live-Cam Models

Place models in:

```text
C:\Users\Kai\IdeaProjects\Deep-Live-Cam\models
```

Required files:

```text
inswapper_128_fp16.onnx
GFPGANv1.4.pth
```

## 4. Set Up This Repo

```powershell
cd C:\Users\Kai\Downloads\tiktok\tiktok
npm.cmd install
```

Check:

```text
C:\Users\Kai\Downloads\tiktok\tiktok\scripts\deepfake-worker-runner.config.json
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

For local tests, use MP4 destinations:

```json
"destinationUrl": "D:\\TEMP\\trump-output.mp4"
```

For TikTok streaming, use an RTMP/RTMPS destination URL or environment variable.
RTMP/RTMPS outputs automatically use the FLV muxer internally.

## 5. Start the Source Stream

Start OBS or another publisher and stream the clean source to:

```text
rtmp://127.0.0.1/live/source
```

Verify the source stays live:

```powershell
ffmpeg -hide_banner -loglevel info -i rtmp://127.0.0.1/live/source -t 180 -f null -
```

If this exits early, fix OBS or the RTMP server before running workers.

## 6. Run Workers

Start with one worker:

```powershell
cd C:\Users\Kai\Downloads\tiktok\tiktok
npm.cmd run deepfake:run -- --worker avatar-1 --no-restart
```

Run all configured workers:

```powershell
npm.cmd run deepfake:run
```

Current stable local settings:

```json
{
  "resolution": "1280x720",
  "fps": 15,
  "bitrate": "2500k"
}
```

If two workers lag, reduce to `10 fps` or `960x540`.

## Notes

- Use `npm.cmd`, not `npm`, if PowerShell blocks `npm.ps1`.
- Local MP4 files are timestamped automatically, for example
  `D:\TEMP\trump-output-20260507-012116.mp4`.
- MP4 files need a clean shutdown to finalize. Stop with `Ctrl+C`.
- Extremely tight avatar crops are padded in memory automatically before face
  detection.
