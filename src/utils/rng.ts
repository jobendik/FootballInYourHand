/**
 * Seedable deterministic RNG (mulberry32). Determinism matters for the match
 * simulation: foul arbitration, AI jitter, and pack openings all draw from a seeded
 * stream so a replay/seed reproduces identically. A single shared instance lives on
 * the GameWorld; the metagame creates its own instance for pack rolls.
 */
export class Rng {
  private state: number;

  constructor(seed = 1) {
    // Avoid a zero state which would lock mulberry32 at 0.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Re-seed in place. */
  seed(seed: number): void {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return Math.floor(min + this.next() * (max - min + 1));
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Symmetric jitter in [-amount, amount). */
  jitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }

  /** Pick a random element. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  /**
   * Weighted pick: `weights[i]` is the relative weight of `items[i]`.
   * Returns the chosen item (falls back to the last item on rounding edge cases).
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll <= 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /** Standard-normal-ish sample via the central limit theorem (sum of 3 uniforms). */
  gaussian(mean = 0, stdDev = 1): number {
    const u = (this.next() + this.next() + this.next()) / 3; // mean 0.5, narrower tails
    return mean + (u - 0.5) * 2 * Math.sqrt(3) * stdDev;
  }
}

/** A process-wide instance for non-deterministic UI flourishes (never gameplay). */
export const uiRng = new Rng(0x1234abcd);
