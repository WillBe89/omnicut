/** Time helpers. All timeline math is in floating-point seconds. */

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Round to the nearest microsecond to avoid float drift accumulating in edits. */
export function snap(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

/** "01:23.456" style for humans / logs. */
export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = sec.toFixed(3).padStart(6, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${secStr}`;
  return `${String(m).padStart(2, "0")}:${secStr}`;
}

/** Parse "mm:ss.mmm" / "hh:mm:ss" / "12.5" into seconds. */
export function parseTimecode(input: string | number): number {
  if (typeof input === "number") return input;
  const trimmed = input.trim();
  if (!trimmed.includes(":")) return Number(trimmed);
  const parts = trimmed.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
