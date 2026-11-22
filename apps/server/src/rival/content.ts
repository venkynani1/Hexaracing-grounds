/**
 * SERVER-ONLY Level 4 duel bank. Original, deterministic per (seed, pair) — both squads of a pair get the same
 * question (it's a contest), different pairs get different variants. Never import from the web app.
 */
import { createRng, type Rng } from '@redline/shared';

export interface DuelQuestion {
  pattern: string;
  prompt: string;
  options: string[];
  answer: string;
}

type Gen = (r: Rng) => { pattern: string; prompt: string; answer: number; unit?: string };

const GENS: Gen[] = [
  (r) => {
    const a = 3 + r.int(20);
    const d = 2 + r.int(9);
    return { pattern: 'arithmetic', prompt: `Checkpoint codes: ${a}, ${a + d}, ${a + 2 * d}, ${a + 3 * d}, … What is the next code?`, answer: a + 4 * d };
  },
  (r) => {
    const a = 2 + r.int(4);
    const k = 2 + r.int(2);
    return { pattern: 'geometric', prompt: `A signal doubles its pattern: ${a}, ${a * k}, ${a * k * k}, ${a * k ** 3}, … Next value?`, answer: a * k ** 4 };
  },
  (r) => {
    const a = 5 + r.int(10);
    const x = 2 + r.int(5);
    const y = 6 + r.int(6);
    return { pattern: 'alternating', prompt: `Toll counters read ${a}, ${a + x}, ${a + x + y}, ${a + 2 * x + y}, ${a + 2 * x + 2 * y}, … Next reading?`, answer: a + 3 * x + 2 * y };
  },
  (r) => {
    const k = 1 + r.int(9);
    const s = 2 + r.int(4);
    return { pattern: 'squares', prompt: `Flyover pillar numbers: ${s * s + k}, ${(s + 1) ** 2 + k}, ${(s + 2) ** 2 + k}, … Next pillar?`, answer: (s + 3) ** 2 + k };
  },
  (r) => {
    const a = 1 + r.int(5);
    const b = 2 + r.int(6);
    const seq = [a, b, a + b, a + 2 * b, 2 * a + 3 * b];
    return { pattern: 'fibonacci', prompt: `Each lane code is the sum of the previous two: ${seq.join(', ')}, … Next code?`, answer: 3 * a + 5 * b };
  },
  (r) => {
    const d1 = 6 + r.int(10);
    const v1 = [30, 40, 60][r.int(3)]!;
    const d2 = d1 + 2 + r.int(8);
    const v2 = v1 + 20;
    const t1 = Math.round((d1 / v1) * 60);
    const t2 = Math.round((d2 / v2) * 60);
    return { pattern: 'route-time', prompt: `Route A: ${d1} km at ${v1} km/h. Route B: ${d2} km at ${v2} km/h. How many minutes does the FASTER route take (rounded)?`, answer: Math.min(t1, t2), unit: 'min' };
  },
  (r) => {
    const per = [2, 3, 4][r.int(3)]!;
    const km = 4 + r.int(12);
    const reserve = 5 * (1 + r.int(3));
    return { pattern: 'fuel', prompt: `The car burns ${per}% fuel per km. The stretch to Siruseri is ${km} km and the Engineer wants a ${reserve}% reserve. Minimum fuel % needed?`, answer: per * km + reserve, unit: '%' };
  },
  (r) => {
    const cycle = [60, 90, 120][r.int(3)]!;
    const green = [20, 30, 40][r.int(3)]!;
    const arrive = green + 5 + r.int(cycle - green - 10);
    return { pattern: 'signal', prompt: `A junction light is green for the first ${green} s of every ${cycle} s cycle. You arrive ${arrive} s into the cycle. How many seconds until green?`, answer: cycle - arrive, unit: 's' };
  },
];

export function duelQuestion(seed: string, pairId: string): DuelQuestion {
  const r = createRng(seed, `duel:${pairId}`);
  const g = GENS[r.int(GENS.length)]!(r);
  const opts = new Set<number>([g.answer]);
  const deltas = [1, 2, 3, 5, 10, -1, -2, -3, -5, -10];
  while (opts.size < 4) {
    const v = g.answer + deltas[r.int(deltas.length)]!;
    if (v >= 0) opts.add(v);
  }
  const list = [...opts];
  for (let i = list.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  const fmt = (n: number) => `${n}${g.unit ? ' ' + g.unit : ''}`;
  return { pattern: g.pattern, prompt: g.prompt, options: list.map(fmt), answer: fmt(g.answer) };
}

export const DUEL_PATTERNS = GENS.length;
