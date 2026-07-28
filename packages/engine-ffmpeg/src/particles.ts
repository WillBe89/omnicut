/** Deterministic PRNG (mulberry32) so dust is reproducible across re-renders. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  born: number; // seconds
  life: number; // seconds
  size: number;
  color: [number, number, number];
}

export interface DustOptions {
  seed?: number;
  /** Fraction of the track (0..1) after which dust may start appearing. */
  startFraction?: number;
  /** Baseline spawn probability per frame; scaled by the driver signal. */
  spawnChance?: number;
  maxAlive?: number;
}

const PALETTE: [number, number, number][] = [
  [255, 225, 170],
  [255, 255, 255],
  [255, 190, 220],
  [190, 210, 255],
];

/**
 * Simulate dust motes falling from above, like debris shaken loose by the
 * bass in a warehouse rig. Density is driven by `intensity` — pass the SAME
 * signal driving the EQ/shake (a smoothed kick envelope) so dust visibly
 * thickens in the heavy sections rather than following an unrelated cue.
 */
export function simulateDust(
  nf: number,
  fps: number,
  W: number,
  H: number,
  intensity: Float64Array,
  opts: DustOptions = {},
): Particle[][] {
  const rnd = mulberry32(opts.seed ?? 20260728);
  const startF = Math.floor(nf * (opts.startFraction ?? 0.5));
  const baseChance = opts.spawnChance ?? 0.4;
  const maxAlive = opts.maxAlive ?? 55;

  const alive: Particle[] = [];
  const perFrame: Particle[][] = new Array(nf);

  for (let f = 0; f < nf; f++) {
    const t = f / fps;
    if (f >= startF && alive.length < maxAlive) {
      const heat = intensity[f] ?? 0;
      // Near-silent in light sections, busy in heavy ones — density tracks
      // the same kick/EQ signal, not a separate cue. sqrt softens the ramp
      // so it doesn't saturate the instant a section gets moderately heavy.
      const chance = baseChance * (0.04 + 0.9 * Math.sqrt(heat));
      let spawned = 0;
      while (rnd() < chance && spawned < 4) {
        alive.push({
          x: rnd() * W,
          y: -H * 0.04 + rnd() * H * 0.06, // spawn just above/at the very top
          vx: (rnd() - 0.5) * 16,
          vy: 26 + rnd() * 34,             // falling downward
          gravity: 26 + rnd() * 30,        // gentle downward acceleration
          born: t,
          life: 2.2 + rnd() * 2.2,
          size: 1.6 + rnd() * 3.4,
          color: PALETTE[Math.floor(rnd() * PALETTE.length)]!,
        });
        spawned++;
      }
    }
    for (let i = alive.length - 1; i >= 0; i--) {
      if (t - alive[i]!.born > alive[i]!.life) alive.splice(i, 1);
    }
    perFrame[f] = alive.slice();
  }
  return perFrame;
}
