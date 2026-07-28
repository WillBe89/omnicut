/** Minimal iterative radix-2 Cooley-Tukey FFT, in-place, power-of-two size only. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = i + k + half;
        const uRe = re[a]!, uIm = im[a]!;
        const vRe = re[b]! * curWr - im[b]! * curWi;
        const vIm = re[b]! * curWi + im[b]! * curWr;
        re[a] = uRe + vRe; im[a] = uIm + vIm;
        re[b] = uRe - vRe; im[b] = uIm - vIm;
        const nWr = curWr * wr - curWi * wi;
        const nWi = curWr * wi + curWi * wr;
        curWr = nWr; curWi = nWi;
      }
    }
  }
}
