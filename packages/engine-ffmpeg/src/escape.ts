/** Helpers for building FFmpeg filtergraph strings safely. */

/** "#RRGGBB" → "0xRRGGBB", optionally with alpha "@0.5". */
export function ffColor(hex: string, opacity?: number): string {
  const clean = hex.replace(/^#/, "").replace(/^0x/i, "");
  const base = `0x${clean.toUpperCase()}`;
  return opacity === undefined ? base : `${base}@${clamp01(opacity)}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Escape a filesystem path for use INSIDE a filtergraph option value
 * (e.g. drawtext textfile=/fontfile=). On Windows the drive colon and
 * backslashes must be escaped; we normalize to forward slashes and escape ':'.
 */
export function filterPath(p: string): string {
  const fwd = p.replace(/\\/g, "/");
  // Escape the drive-letter colon (C:/...) → C\:/...
  return fwd.replace(/:/g, "\\:");
}

/** Numeric formatting that avoids scientific notation and trims noise. */
export function num(n: number): string {
  return (Math.round(n * 1e6) / 1e6).toString();
}
