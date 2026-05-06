/**
 * FFmpeg argument builders for stream-fanout-runner.
 *
 * Phase 1 legacy builders (`-c copy`):
 *   - buildTeeArg(destinations)
 *   - buildLegacyTeeArgs(source, destinations)
 *   - buildLegacyCopyArgs(source, dest)
 *
 * Phase 3 variant builders (re-encode with filter chain):
 *   - buildVariantArgs(source, destUrl, variant): full args array for spawn.
 *   - buildFilterComplex(variant, hasOverlayInput): filter_complex string.
 *   - buildEncoderArgs(variant): libx264 ultrafast + aac audio encoder flags.
 *   - escapeDrawtextValue(str): escape `\`, `'`, `:`, `%` for drawtext.
 *   - doubleBitrate(bitrateStr): "3000k" -> "6000k", supports decimals (L1 fix).
 *
 * All pure — no spawn, no I/O. Easy to unit-test by inspecting returned arrays.
 *
 * H1 decision (phase 2 review): `antiDuplicate.enabled` MUST be explicit `true` to
 * activate variant execution. No auto-enable when variant dest detected — keeps the
 * user in control and avoids surprise CPU burn when copying legacy configs.
 *
 * Phase 7 will extend with NVENC encoder branch, tpad delay filter, and audio filter
 * (anti-fingerprint). See plans/260424-1053-anti-duplicate-fanout/reports/
 * planner-260424-1510-scale-to-50-streams.md for HW encoder roadmap.
 */

// ----- Legacy builders (phase 1) -----

export function buildTeeArg(destinations) {
  return destinations.map((d) => `[f=flv]${d}`).join("|");
}

export function buildLegacyTeeArgs(source, destinations) {
  return [
    "-i", source,
    "-map", "0:v",
    "-map", "0:a",
    "-c", "copy",
    "-f", "tee",
    buildTeeArg(destinations),
  ];
}

export function buildLegacyCopyArgs(source, dest) {
  return [
    "-i", source,
    "-map", "0:v",
    "-map", "0:a",
    "-c", "copy",
    "-f", "flv",
    dest,
  ];
}

// ----- Variant builders (phase 3) -----

// Escape a drawtext text value that will be wrapped in single quotes.
// Reference: https://ffmpeg.org/ffmpeg-filters.html#drawtext
// Escape \, ', :, % to survive both the filter parser and drawtext parser.
// Phase 7 may relax % escaping to allow %{localtime} style dynamic text.
export function escapeDrawtextValue(str) {
  const escaped = String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
  return `'${escaped}'`;
}

// Escape a drawtext fontfile path. Same rules as escapeDrawtextValue but preserves
// forward-slash path separators. Windows drive letters ("C:") must be escaped or the
// filter parser treats the colon as a key/value separator. Phase 5 fix — previously
// drawtext fell back to fontconfig which warns "Cannot load default config file" on
// ffmpeg static builds that lack FONTCONFIG_PATH.
export function escapeDrawtextFontfile(pathStr) {
  const escaped = String(pathStr)
    .replace(/\\/g, "/")       // normalize to forward slashes (filter parser-safe)
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%");
  return `'${escaped}'`;
}

// "3000k" -> "6000k", "2.5M" -> "5M". Supports decimal mantissa (L1 fix).
export function doubleBitrate(bitrateStr) {
  const m = String(bitrateStr).match(/^(\d+(?:\.\d+)?)([kKmM])$/);
  if (!m) throw new Error(`invalid bitrate format: ${bitrateStr}`);
  const n = parseFloat(m[1]) * 2;
  // Drop trailing .0 to keep output clean ("6000k" not "6000.0k").
  const num = Number.isInteger(n) ? String(n) : n.toString();
  return `${num}${m[2]}`;
}

// Build the filter_complex string. Each stage is optional except scale (always runs).
// Labels: [0:v] source → [v1] crop → [v2] scale → [v3] overlay → [vout] drawtext.
// Missing stages are skipped; final stage is always labeled [vout] so downstream
// -map stays consistent.
export function buildFilterComplex(variant, hasOverlayInput) {
  const segments = [];
  let prev = "[0:v]";
  let counter = 0;
  const nextLabel = () => `[v${++counter}]`;

  if (variant.crop) {
    const label = nextLabel();
    segments.push(`${prev}crop=${variant.crop}${label}`);
    prev = label;
  }

  // Scale always runs — resolution is a required variant field.
  const [w, h] = variant.resolution.split("x");
  const scaleLabel = nextLabel();
  segments.push(`${prev}scale=${w}:${h}${scaleLabel}`);
  prev = scaleLabel;

  if (hasOverlayInput) {
    const overlayPos = variant.overlayPos || "10:10";
    const label = nextLabel();
    segments.push(`${prev}[1:v]overlay=${overlayPos}${label}`);
    prev = label;
  }

  if (variant.drawtext) {
    const dt = variant.drawtext;
    const parts = [`text=${escapeDrawtextValue(dt.text)}`];
    // Emit fontfile first so drawtext never falls back to fontconfig on Windows
    // static FFmpeg builds (which trigger "Cannot load default config file" warnings).
    if (dt.fontfile !== undefined) parts.push(`fontfile=${escapeDrawtextFontfile(dt.fontfile)}`);
    // Use `!== undefined` consistently so box=0 / fontsize=0 are emittable.
    if (dt.x !== undefined) parts.push(`x=${dt.x}`);
    if (dt.y !== undefined) parts.push(`y=${dt.y}`);
    if (dt.fontcolor !== undefined) parts.push(`fontcolor=${dt.fontcolor}`);
    if (dt.fontsize !== undefined) parts.push(`fontsize=${dt.fontsize}`);
    if (dt.box !== undefined) parts.push(`box=${dt.box}`);
    if (dt.boxcolor !== undefined) parts.push(`boxcolor=${dt.boxcolor}`);
    segments.push(`${prev}drawtext=${parts.join(":")}[vout]`);
  } else {
    // Null filter just renames the last label to [vout] so -map works uniformly.
    segments.push(`${prev}null[vout]`);
  }

  return segments.join(";");
}

export function buildEncoderArgs(variant) {
  // GOP = fps × 2 (2-second keyframe interval — what TikTok/RTMP ingests expect).
  // x264 default is ~250 frames (~8s @ 30fps) which causes slow seek + choppy rebuffer
  // when viewers join mid-stream. `-sc_threshold 0` disables scene-cut keyframe insertion
  // so keyframe cadence is strictly fixed (some RTMP receivers require this for
  // timestamp alignment). Assumes 30fps source — phase 7 can add variant.fps override.
  const fps = 30;
  const gop = fps * 2;
  return [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-b:v", variant.bitrate,
    "-maxrate", variant.bitrate,
    "-bufsize", doubleBitrate(variant.bitrate),
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
  ];
}

export function buildVariantArgs(source, destUrl, variant) {
  const hasOverlay = Boolean(variant.overlayImage);
  const inputs = ["-i", source];
  if (hasOverlay) inputs.push("-i", variant.overlayImage);

  return [
    ...inputs,
    "-filter_complex", buildFilterComplex(variant, hasOverlay),
    "-map", "[vout]",
    "-map", "0:a",
    ...buildEncoderArgs(variant),
    "-f", "flv",
    destUrl,
  ];
}

// Build FFmpeg args for the pre-flight CPU benchmark.
// Uses lavfi testsrc2 as input instead of the live RTMP source so the benchmark
// never stalls waiting for network frames — testsrc2 generates synthetic video
// immediately, giving a clean measurement of the encode pipeline CPU cost.
// testsrc2 produces a colour-bar + moving-element pattern that exercises the
// encoder more representatively than the simpler testsrc.
// -t 14 covers 4s warmup + 6s sample + 4s margin (see runPreflightBenchmark).
export function buildBenchmarkArgs(variant) {
  const [w, h] = variant.resolution.split("x");
  const hasOverlay = Boolean(variant.overlayImage);

  // Synthetic source at the variant's target resolution so scale has realistic work.
  // testsrc2 is video-only — no audio stream. We use -an to suppress audio output
  // and build video-only encoder args (no -c:a/-b:a/-ar) to avoid FFmpeg rejecting
  // the command due to audio codec flags with no audio input.
  //
  // No duration parameter = infinite loop. testsrc2 will keep generating frames until
  // the orchestrator kills the worker after 12s (see runPreflightBenchmark).
  // This allows FFmpeg to encode at full speed (no -re throttle) so we measure max CPU.
  const inputs = ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=30`];
  if (hasOverlay) inputs.push("-i", variant.overlayImage);

  const fps = 30;
  const gop = fps * 2;
  const videoEncoderArgs = [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-b:v", variant.bitrate,
    "-maxrate", variant.bitrate,
    "-bufsize", doubleBitrate(variant.bitrate),
    "-g", String(gop),
    "-keyint_min", String(gop),
    "-sc_threshold", "0",
    "-pix_fmt", "yuv420p",
  ];

  return [
    ...inputs,
    "-filter_complex", buildFilterComplex(variant, hasOverlay),
    "-map", "[vout]",
    "-an",
    ...videoEncoderArgs,
    "-f", "null",
    "-",
  ];
}
