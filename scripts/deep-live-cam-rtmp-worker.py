#!/usr/bin/env python3
"""
Headless RTMP worker for Deep-Live-Cam.

This script is meant to run from this repo while importing a separate
Deep-Live-Cam checkout via --deep-live-cam-root. It reads one live stream,
swaps one synthetic avatar face onto detected target faces, and publishes the
processed video plus original source audio to one RTMP/RTMPS destination.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Any, List


RUNNING = True
PROCS: List[subprocess.Popen] = []


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--deep-live-cam-root", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--avatar", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--resolution", default="1280x720")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--bitrate", default="3000k")
    parser.add_argument("--execution-provider", default="cuda")
    parser.add_argument("--execution-threads", type=int, default=2)
    parser.add_argument("--encoder", default="auto")
    parser.add_argument("--audio-sync-ms", type=int, default=0)
    parser.add_argument("--disclosure-text", default="AI avatar")
    parser.add_argument("--no-disclosure", action="store_true")
    parser.add_argument("--many-faces", action="store_true")
    return parser.parse_args()


def on_signal(_signum: int, _frame: Any) -> None:
    global RUNNING
    RUNNING = False
    for proc in PROCS:
      try:
          if proc.poll() is None:
              proc.terminate()
      except Exception:
          pass


def configure_deep_live_cam(root: str) -> None:
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise RuntimeError(f"Deep-Live-Cam root not found: {root}")

    sys.path.insert(0, root)
    os.environ["PATH"] = root + os.pathsep + os.environ.get("PATH", "")

    if sys.platform == "win32":
        site_packages = [
            os.path.join(sys.prefix, "Lib", "site-packages"),
            os.path.join(root, "venv", "Lib", "site-packages"),
        ]
        for sp in site_packages:
            torch_lib = os.path.join(sp, "torch", "lib")
            if os.path.isdir(torch_lib):
                os.environ["PATH"] = torch_lib + os.pathsep + os.environ["PATH"]
            nvidia_dir = os.path.join(sp, "nvidia")
            if os.path.isdir(nvidia_dir):
                for pkg in os.listdir(nvidia_dir):
                    bin_dir = os.path.join(nvidia_dir, pkg, "bin")
                    if os.path.isdir(bin_dir):
                        os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]


def decode_execution_provider(requested: str) -> List[str]:
    import onnxruntime

    aliases = {"directml": "dml"}
    wanted = aliases.get(requested.lower(), requested.lower())
    available = onnxruntime.get_available_providers()
    matches = [
        provider
        for provider in available
        if wanted in provider.replace("ExecutionProvider", "").lower()
    ]
    if not matches:
        raise RuntimeError(
            f"execution provider '{requested}' is not available; available={available}"
        )
    return matches


def choose_encoder(ffmpeg: str, requested: str, provider: str) -> str:
    if requested != "auto":
        return requested
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-encoders"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
        if provider.lower() == "cuda" and "h264_nvenc" in out:
            return "h264_nvenc"
    except Exception:
        pass
    return "libx264"


def double_bitrate(bitrate: str) -> str:
    unit = bitrate[-1]
    value = float(bitrate[:-1]) * 2
    if value.is_integer():
        value = int(value)
    return f"{value}{unit}"


def escape_drawtext_text(value: str) -> str:
    return (
        str(value)
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
    )


def escape_drawtext_path(value: str) -> str:
    return str(value).replace("\\", "/").replace(":", "\\:")


def default_drawtext_font() -> str | None:
    if sys.platform != "win32":
        return None
    for font in ("arial.ttf", "segoeui.ttf", "calibri.ttf"):
        path = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", font)
        if os.path.exists(path):
            return path
    return None


def is_stream_output(output: str) -> bool:
    return output.lower().startswith(("rtmp://", "rtmps://", "srt://"))


def segment_file_output(output: str) -> str:
    if is_stream_output(output):
        return output
    root, ext = os.path.splitext(output)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return f"{root}-{stamp}{ext or '.flv'}"


def output_format(output: str) -> str:
    if is_stream_output(output):
        return "flv"
    ext = os.path.splitext(output)[1].lower()
    if ext == ".mp4":
        return "mp4"
    return "flv"


def build_reader_cmd(args: argparse.Namespace, width: int, height: int) -> List[str]:
    return [
        args.ffmpeg,
        "-hide_banner",
        "-loglevel",
        "warning",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-i",
        args.source,
        "-vf",
        f"scale={width}:{height},fps={args.fps}",
        "-an",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-",
    ]


def build_writer_cmd(args: argparse.Namespace, width: int, height: int, encoder: str) -> List[str]:
    gop = max(2, args.fps * 2)
    fmt = output_format(args.output)
    audio_filter = "asetpts=PTS-STARTPTS"
    if args.audio_sync_ms > 0:
        audio_filter = f"adelay={args.audio_sync_ms}:all=1,asetpts=PTS-STARTPTS"
    elif args.audio_sync_ms < 0:
        audio_filter = f"atrim=start={abs(args.audio_sync_ms) / 1000:.3f},asetpts=PTS-STARTPTS"
    cmd = [
        args.ffmpeg,
        "-hide_banner",
        "-y",
        "-loglevel",
        "warning",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "-s",
        f"{width}x{height}",
        "-r",
        str(args.fps),
        "-i",
        "-",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-thread_queue_size",
        "512",
        "-i",
        args.source,
    ]

    cmd.extend(
        [
            "-filter_complex",
            f"[1:a:0]{audio_filter}[aout]",
            "-map",
            "0:v:0",
            "-map",
            "[aout]",
        ]
    )
    cmd.extend(["-c:v", encoder])

    if encoder == "h264_nvenc":
        cmd.extend(["-preset", "p4", "-tune", "ll", "-rc", "vbr"])
    else:
        cmd.extend(["-preset", "veryfast", "-tune", "zerolatency"])

    cmd.extend(
        [
            "-b:v",
            args.bitrate,
            "-maxrate",
            args.bitrate,
            "-bufsize",
            double_bitrate(args.bitrate),
            "-g",
            str(gop),
            "-keyint_min",
            str(gop),
            "-pix_fmt",
            "yuv420p",
        ]
    )

    if not args.no_disclosure and args.disclosure_text:
        text = escape_drawtext_text(args.disclosure_text)
        font = default_drawtext_font()
        font_option = f":fontfile='{escape_drawtext_path(font)}'" if font else ""
        cmd.extend(
            [
                "-vf",
                f"drawtext=text='{text}'{font_option}:x=20:y=20:fontcolor=white:fontsize=24:box=1:boxcolor=black@0.55",
            ]
        )

    cmd.extend(["-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-shortest"])
    if fmt == "mp4":
        cmd.extend(["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", args.output])
    else:
        cmd.extend(["-f", "flv", args.output])
    return cmd


def forward_ffmpeg_stderr(proc: subprocess.Popen, label: str) -> None:
    def run() -> None:
        if proc.stderr is None:
            return
        for raw in iter(proc.stderr.readline, b""):
            line = raw.decode(errors="replace").strip()
            if line:
                print(f"{label}: {line}", file=sys.stderr, flush=True)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()


def start_ffmpeg(cmd: List[str], label: str, stdin=None, stdout=None) -> subprocess.Popen:
    proc = subprocess.Popen(cmd, stdin=stdin, stdout=stdout, stderr=subprocess.PIPE)
    forward_ffmpeg_stderr(proc, label)
    PROCS.append(proc)
    return proc


class LatestFrameReader:
    def __init__(self, proc: subprocess.Popen, frame_size: int):
        self.proc = proc
        self.frame_size = frame_size
        self.latest = None
        self.seq = 0
        self.ended = False
        self.partial_size = 0
        self.condition = threading.Condition()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self.thread.start()

    def _run(self) -> None:
        if self.proc.stdout is None:
            self._mark_ended(0)
            return
        while RUNNING:
            raw = self.proc.stdout.read(self.frame_size)
            if len(raw) != self.frame_size:
                self._mark_ended(len(raw))
                return
            with self.condition:
                self.latest = raw
                self.seq += 1
                self.condition.notify_all()

    def _mark_ended(self, partial_size: int) -> None:
        with self.condition:
            self.partial_size = partial_size
            self.ended = True
            self.condition.notify_all()

    def get_next(self, last_seq: int, timeout: float = 5.0):
        deadline = time.time() + timeout
        with self.condition:
            while RUNNING and not self.ended and self.seq == last_seq:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None, last_seq
                self.condition.wait(remaining)
            if self.seq != last_seq:
                return self.latest, self.seq
            return None, last_seq


def configure_globals(args: argparse.Namespace) -> None:
    import modules.globals as dlc_globals

    dlc_globals.source_path = args.avatar
    dlc_globals.target_path = args.source
    dlc_globals.output_path = args.output
    dlc_globals.frame_processors = ["face_swapper"]
    dlc_globals.keep_fps = True
    dlc_globals.keep_audio = True
    dlc_globals.keep_frames = False
    dlc_globals.many_faces = args.many_faces
    dlc_globals.map_faces = False
    dlc_globals.mouth_mask = False
    dlc_globals.nsfw_filter = False
    dlc_globals.video_encoder = "libx264"
    dlc_globals.video_quality = 18
    dlc_globals.headless = True
    dlc_globals.execution_providers = decode_execution_provider(args.execution_provider)
    dlc_globals.execution_threads = args.execution_threads
    dlc_globals.max_memory = 16
    dlc_globals.fp_ui = {
        "face_enhancer": False,
        "face_enhancer_gpen256": False,
        "face_enhancer_gpen512": False,
    }


def load_deep_live_cam(args: argparse.Namespace):
    import cv2
    import numpy as np
    from modules.face_analyser import detect_many_faces_fast, detect_one_face_fast, get_one_face
    from modules.processors.frame.core import get_frame_processors_modules

    avatar = cv2.imread(args.avatar)
    if avatar is None:
        raise RuntimeError(f"could not read avatar image: {args.avatar}")
    source_face = get_one_face(avatar)
    if source_face is None:
        height, width = avatar.shape[:2]
        for pad_fraction in (0.1, 0.2, 0.35, 0.5):
            border = int(max(height, width) * pad_fraction)
            padded_avatar = cv2.copyMakeBorder(
                avatar,
                border,
                border,
                border,
                border,
                cv2.BORDER_CONSTANT,
                value=(255, 255, 255),
            )
            source_face = get_one_face(padded_avatar)
            if source_face is not None:
                print(
                    f"detected source face after avatar padding "
                    f"({pad_fraction:.0%}, border={border}px)",
                    flush=True,
                )
                break
    if source_face is None:
        raise RuntimeError(f"no face detected in avatar image: {args.avatar}")

    frame_processors = get_frame_processors_modules(["face_swapper"])
    for processor in frame_processors:
        if not processor.pre_check():
            raise RuntimeError(f"{processor.NAME} pre_check failed")
        if not processor.pre_start():
            raise RuntimeError(f"{processor.NAME} pre_start failed")

    return cv2, np, source_face, frame_processors, detect_one_face_fast, detect_many_faces_fast


def main() -> int:
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    args = parse_args()
    if not shutil.which(args.ffmpeg) and not os.path.exists(args.ffmpeg):
        raise RuntimeError(f"ffmpeg not found: {args.ffmpeg}")

    configure_deep_live_cam(args.deep_live_cam_root)
    configure_globals(args)
    cv2, np, source_face, frame_processors, detect_one, detect_many = load_deep_live_cam(args)
    actual_output = segment_file_output(args.output)
    args.output = actual_output

    width, height = [int(part) for part in args.resolution.lower().split("x", 1)]
    frame_size = width * height * 3
    encoder = choose_encoder(args.ffmpeg, args.encoder, args.execution_provider)

    print(
        f"starting source={args.source} avatar={os.path.basename(args.avatar)} "
        f"resolution={width}x{height} fps={args.fps} encoder={encoder} output={actual_output}",
        flush=True,
    )

    reader = start_ffmpeg(build_reader_cmd(args, width, height), "reader", stdout=subprocess.PIPE)
    writer = start_ffmpeg(build_writer_cmd(args, width, height, encoder), "writer", stdin=subprocess.PIPE)
    frame_reader = LatestFrameReader(reader, frame_size)
    frame_reader.start()

    processed = 0
    total_processed = 0
    unexpected_stop = False
    last_seq = 0
    last_report = time.time()
    try:
        while RUNNING:
            raw, last_seq = frame_reader.get_next(last_seq)
            if raw is None:
                if not frame_reader.ended and reader.poll() is None:
                    print("reader produced no frame within timeout", flush=True)
                    continue
                try:
                    reader.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                print(
                    f"reader ended or returned a partial frame "
                    f"(bytes={frame_reader.partial_size}/{frame_size}, code={reader.poll()})",
                    flush=True,
                )
                unexpected_stop = True
                break

            frame = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 3)).copy()

            if args.many_faces:
                for processor in frame_processors:
                    frame = processor.process_frame(source_face, frame)
            else:
                target_face = detect_one(frame)
                for processor in frame_processors:
                    frame = processor.process_frame(source_face, frame, target_face=target_face)

            try:
                writer.stdin.write(frame.tobytes())
            except BrokenPipeError:
                try:
                    writer.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                print(f"writer pipe closed; writer exited code={writer.poll()}", flush=True)
                unexpected_stop = True
                break
            processed += 1
            total_processed += 1

            now = time.time()
            if now - last_report >= 5:
                print(f"processed_frames={processed} approx_fps={processed / max(now - last_report, 1):.1f}", flush=True)
                processed = 0
                last_report = now

            if reader.poll() is not None:
                print(f"reader exited code={reader.returncode}", flush=True)
                unexpected_stop = True
                break
            if writer.poll() is not None:
                print(f"writer exited code={writer.returncode}", flush=True)
                unexpected_stop = True
                break
    finally:
        try:
            if writer.stdin:
                writer.stdin.close()
        except Exception:
            pass
        on_signal(signal.SIGTERM, None)

    if unexpected_stop:
        return 2
    return 0 if total_processed > 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"fatal: {exc}", file=sys.stderr, flush=True)
        on_signal(signal.SIGTERM, None)
        sys.exit(1)
