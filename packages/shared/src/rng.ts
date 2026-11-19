/**
 * Seeded, reproducible RNG (sfc32 seeded via splitmix32 from a string/number seed).
 * Every Director decision must draw from a stream created here and be audit-logged.
 */
function splitmix32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface Rng {
  /** float in [0,1) */
  next(): number;
  /** integer in [0, maxExclusive) */
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: string | number, stream = ''): Rng {
  const sm = splitmix32(hash32(`${seed}:${stream}`));
  let a = sm(), b = sm(), c = sm(), d = sm();
  const next32 = () => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next32();
  const next = () => next32() / 4294967296;
  return {
    next,
    int: (max) => {
      if (!Number.isInteger(max) || max <= 0) throw new RangeError('max must be a positive integer');
      return Math.floor(next() * max);
    },
    pick: (items) => {
      if (items.length === 0) throw new RangeError('cannot pick from empty list');
      return items[Math.floor(next() * items.length)]!;
    },
  };
}

/** Predeclared final tie-break key: hex of hash32(seed:teamId). */
export function tieBreakHash(seed: string | number, teamId: string): string {
  return hash32(`${seed}:tiebreak:${teamId}`).toString(16).padStart(8, '0');
}
