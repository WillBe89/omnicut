/** Minimal RGBA frame-buffer drawing for the hand-rendered EQ + dust layer. */

export type RGB = [number, number, number];

export function makeFrameBuffer(W: number, H: number): Uint8Array {
  return new Uint8Array(W * H * 4);
}

export function clearBuffer(buf: Uint8Array): void {
  buf.fill(0);
}

export interface Gradient4 {
  c0: RGB;
  c1: RGB;
  c2: RGB;
  c3: RGB;
}

/** Sample a 4-stop linear gradient at u in [0,1]. */
export function gradientColorAt(u: number, g: Gradient4): RGB {
  const stops = [g.c0, g.c1, g.c2, g.c3];
  const seg = Math.min(2, Math.max(0, Math.floor(u * 3)));
  const localT = Math.min(1, Math.max(0, u * 3 - seg));
  const a = stops[seg]!, b = stops[seg + 1]!;
  return [
    a[0] + (b[0] - a[0]) * localT,
    a[1] + (b[1] - a[1]) * localT,
    a[2] + (b[2] - a[2]) * localT,
  ];
}

/** Draw one EQ bar growing up from the bottom of [x, x+width) x [0, H). */
export function drawBar(
  buf: Uint8Array,
  W: number,
  H: number,
  xStart: number,
  width: number,
  heightFrac: number,
  color: RGB,
): void {
  const barH = Math.round(H * Math.max(0, Math.min(1, heightFrac)));
  if (barH <= 0) return;
  const yTop = H - barH;
  const x0 = Math.max(0, xStart);
  const x1 = Math.min(W, xStart + width);
  if (x1 <= x0) return;

  for (let y = yTop; y < H; y++) {
    const t = (y - yTop) / Math.max(1, barH); // 0 at tip .. 1 at base
    const bright = 1 + (1 - t) * 0.35;
    const r = Math.min(255, color[0] * bright) | 0;
    const g = Math.min(255, color[1] * bright) | 0;
    const b = Math.min(255, color[2] * bright) | 0;
    const rowOff = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const o = rowOff + x * 4;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 232;
    }
  }
  // Bright flash cap on strong hits — extra "it just spiked" pop.
  if (heightFrac > 0.8) {
    const y = Math.max(0, yTop - 2);
    const rowOff = y * W * 4;
    for (let x = x0; x < x1; x++) {
      const o = rowOff + x * 4;
      buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 210;
    }
  }
}

/** Broad translucent flash across a band (a "the kick just hit" screen pulse). */
export function drawFlash(buf: Uint8Array, W: number, H: number, yTop: number, yBottom: number, alpha: number): void {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha) * 60;
  const y0 = Math.max(0, yTop), y1 = Math.min(H, yBottom);
  for (let y = y0; y < y1; y++) {
    const rowOff = y * W * 4;
    for (let x = 0; x < W; x++) {
      const o = rowOff + x * 4;
      buf[o] = Math.min(255, buf[o]! + a) | 0;
      buf[o + 1] = Math.min(255, buf[o + 1]! + a) | 0;
      buf[o + 2] = Math.min(255, buf[o + 2]! + a) | 0;
      buf[o + 3] = Math.min(255, Math.max(buf[o + 3]!, a * 3)) | 0;
    }
  }
}

/** Additive soft-glow dot (for dust motes). */
export function drawGlowDot(
  buf: Uint8Array,
  W: number,
  H: number,
  cx: number,
  cy: number,
  radius: number,
  color: RGB,
  alpha: number,
): void {
  if (alpha <= 0 || radius <= 0) return;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const rowOff = y * W * 4;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const falloff = 1 - Math.sqrt(d2) / radius;
      const a = alpha * falloff * falloff;
      const o = rowOff + x * 4;
      buf[o] = Math.min(255, buf[o]! + color[0] * a) | 0;
      buf[o + 1] = Math.min(255, buf[o + 1]! + color[1] * a) | 0;
      buf[o + 2] = Math.min(255, buf[o + 2]! + color[2] * a) | 0;
      buf[o + 3] = Math.min(255, Math.max(buf[o + 3]!, 255 * a)) | 0;
    }
  }
}
