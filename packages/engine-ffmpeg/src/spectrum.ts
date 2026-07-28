import { fftInPlace } from "./fft.js";

export interface SpectrumOptions {
  bands?: number;
  fLow?: number;
  fHigh?: number;
  fftSize?: number;
  decay?: number; // 0..1 multiplier per frame after a peak (fast attack, this decay)
  floor?: number; // gate: values below this (post-normalize) read as 0
  gamma?: number; // <1 = more punch at the top, >1 = softer
}

export interface SpectrumResult {
  nf: number;
  bands: number;
  /** Row-major [frame*bands + band], each 0..1, already smoothed/normalized/gated. */
  data: Float32Array;
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Per-frame log-spaced multi-band spectrum, normalized against THIS TRACK's
 * own dynamic range per band (so the loudest hit in a song always reaches
 * full height, however loud the mix is) — this is what makes each song's
 * visual pattern genuinely unique. Fast attack + decay gives punchy spikes
 * on kicks without frame-to-frame jitter.
 */
export function analyzeSpectrum(
  pcm: Float32Array,
  sr: number,
  fps: number,
  duration: number,
  opts: SpectrumOptions = {},
): SpectrumResult {
  const bands = opts.bands ?? 32;
  const fLow = opts.fLow ?? 40;
  const fHigh = Math.min(opts.fHigh ?? 11000, sr * 0.49);
  const fftSize = opts.fftSize ?? 2048;
  const decay = opts.decay ?? 0.78;
  const floor = opts.floor ?? 0.1;
  const gamma = opts.gamma ?? 0.8;

  const nf = Math.floor(duration * fps);
  const win = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const half = fftSize / 2;

  const bandBinRanges: [number, number][] = [];
  const binHz = sr / fftSize;
  for (let b = 0; b < bands; b++) {
    const loHz = fLow * Math.pow(fHigh / fLow, b / bands);
    const hiHz = fLow * Math.pow(fHigh / fLow, (b + 1) / bands);
    const lo = Math.max(1, Math.round(loHz / binHz));
    const hi = Math.max(lo + 1, Math.min(half, Math.round(hiHz / binHz)));
    bandBinRanges.push([lo, hi]);
  }

  const raw = new Float64Array(nf * bands);
  for (let f = 0; f < nf; f++) {
    const center = Math.floor((f / fps) * sr);
    const start = center - fftSize / 2;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const s = start + i;
      re[i] = (s >= 0 && s < pcm.length ? pcm[s]! : 0) * win[i]!;
    }
    fftInPlace(re, im);
    for (let b = 0; b < bands; b++) {
      const [lo, hi] = bandBinRanges[b]!;
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += Math.sqrt(Math.hypot(re[k]!, im[k]!));
      raw[f * bands + b] = sum / (hi - lo);
    }
  }

  // Per-band percentile normalization: THIS track's own 96.5th percentile
  // becomes "full height" for that band.
  const norm = new Float64Array(nf * bands);
  const col = new Float64Array(nf);
  for (let b = 0; b < bands; b++) {
    for (let f = 0; f < nf; f++) col[f] = raw[f * bands + b]!;
    const sorted = Float64Array.from(col).sort();
    const p = sorted[Math.min(nf - 1, Math.floor(0.965 * nf))]! + 1e-9;
    for (let f = 0; f < nf; f++) norm[f * bands + b] = Math.min(1, col[f]! / p);
  }

  // Fast-attack / decay envelope per band, then floor-gate + gamma.
  const data = new Float32Array(nf * bands);
  for (let b = 0; b < bands; b++) {
    let s = 0;
    for (let f = 0; f < nf; f++) {
      const v = norm[f * bands + b]!;
      s = v > s ? v : s * decay;
      const gated = Math.max(0, Math.min(1, (s - floor) / (1 - floor)));
      data[f * bands + b] = Math.pow(gated, gamma);
    }
  }
  return { nf, bands, data };
}
