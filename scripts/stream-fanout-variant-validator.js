/**
 * Variant schema validators for stream-fanout-runner config.
 *
 * Split from stream-fanout-config-loader.js in phase 2 once the loader exceeded
 * the 200-LOC cap. Keeps "load and merge" separate from "validate the schema".
 *
 * Exports:
 *   - normalizeDestinations(destinations): string URL → legacy, object with .url → variant.
 *     Returns [{ url, variant, isLegacy, idx }]. Throws on malformed entries.
 *   - validateVariant(variant, idx): regex + presence checks on resolution, bitrate,
 *     startOffsetSec, crop, overlayImage (file must exist), overlayPos, drawtext.text.
 *     Returns errors array (never throws).
 *   - validateAntiDuplicate(adConfig): bool/int bounds on the antiDuplicate block.
 *     Returns errors array.
 *
 * Phase 7 will extend validateVariant with tpadDurationSec and audioFilter.
 */

import fs from "fs";

const RESOLUTION_RE = /^\d+x\d+$/;
// L1 (phase 2 review): accept decimals so "2.5M", "1.75k" pass. Still require explicit
// K/k/M/m unit — bare "3000" is rejected to avoid ambiguity with FFmpeg defaults.
const BITRATE_RE = /^\d+(\.\d+)?[kKmM]$/;

export function normalizeDestinations(destinations) {
  return destinations.map((dest, idx) => {
    if (typeof dest === "string") {
      return { url: dest, variant: null, isLegacy: true, idx };
    }
    if (typeof dest === "object" && dest !== null && typeof dest.url === "string") {
      return { url: dest.url, variant: dest.variant || null, isLegacy: !dest.variant, idx };
    }
    throw new Error(`destinations[${idx}] must be a string URL or object with .url`);
  });
}

export function validateVariant(variant, idx) {
  const errors = [];
  const prefix = `destinations[${idx}].variant`;

  // H2 (phase 2 review): catch non-object variant early so user sees one friendly
  // error instead of a pile of regex fallout from downstream checks.
  if (typeof variant !== "object" || variant === null || Array.isArray(variant)) {
    const got = Array.isArray(variant) ? "array" : typeof variant;
    return [`${prefix}: must be an object (got ${got})`];
  }

  if (!variant.resolution || !RESOLUTION_RE.test(variant.resolution)) {
    errors.push(`${prefix}.resolution: required, must match WxH format (got ${JSON.stringify(variant.resolution)})`);
  }
  if (!variant.bitrate || !BITRATE_RE.test(variant.bitrate)) {
    errors.push(`${prefix}.bitrate: required, must match \\d+[kKmM] (got ${JSON.stringify(variant.bitrate)})`);
  }
  if (variant.startOffsetSec !== undefined) {
    const n = variant.startOffsetSec;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 30) {
      errors.push(`${prefix}.startOffsetSec: must be number 0..30 (got ${n})`);
    }
  }
  if (variant.crop !== undefined && typeof variant.crop !== "string") {
    errors.push(`${prefix}.crop: must be string FFmpeg expression`);
  }
  if (variant.overlayImage !== undefined) {
    if (typeof variant.overlayImage !== "string") {
      errors.push(`${prefix}.overlayImage: must be string path`);
    } else if (!fs.existsSync(variant.overlayImage)) {
      errors.push(`${prefix}.overlayImage: file not found at ${variant.overlayImage}`);
    }
  }
  if (variant.overlayPos !== undefined && typeof variant.overlayPos !== "string") {
    errors.push(`${prefix}.overlayPos: must be string (x:y FFmpeg expression)`);
  }
  if (variant.drawtext !== undefined) {
    const dt = variant.drawtext;
    if (typeof dt !== "object" || dt === null) {
      errors.push(`${prefix}.drawtext: must be object`);
    } else {
      if (typeof dt.text !== "string" || dt.text.length === 0) {
        errors.push(`${prefix}.drawtext.text: required non-empty string when drawtext is set`);
      }
      // Phase 5 fix: validate fontfile to prevent fontconfig fallback noise on Windows
      // static FFmpeg builds. Check existence here so user fails fast instead of at runtime.
      if (dt.fontfile !== undefined) {
        if (typeof dt.fontfile !== "string") {
          errors.push(`${prefix}.drawtext.fontfile: must be string path`);
        } else if (!fs.existsSync(dt.fontfile)) {
          errors.push(`${prefix}.drawtext.fontfile: file not found at ${dt.fontfile}`);
        }
      }
    }
  }
  return errors;
}

export function validateAntiDuplicate(adConfig) {
  const errors = [];
  if (!adConfig || typeof adConfig !== "object") return errors;
  if (adConfig.enabled !== undefined && typeof adConfig.enabled !== "boolean") {
    errors.push(`antiDuplicate.enabled: must be boolean`);
  }
  if (adConfig.preflightBenchmark !== undefined && typeof adConfig.preflightBenchmark !== "boolean") {
    errors.push(`antiDuplicate.preflightBenchmark: must be boolean`);
  }
  if (adConfig.maxStreams !== undefined) {
    const m = adConfig.maxStreams;
    if (!Number.isInteger(m) || m < 1 || m > 10) {
      errors.push(`antiDuplicate.maxStreams: must be integer 1..10 (got ${m})`);
    }
  }
  return errors;
}
