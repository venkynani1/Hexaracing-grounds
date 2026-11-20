/** SERVER-ONLY Hexaware Gate content (original, seeded per squad). */
import type { Rng } from '@redline/shared';

export interface DebugTask {
  prompt: string;
  lines: string[];
  answer: string;
}

const pick = <T>(rng: Rng, xs: readonly T[]) => xs[rng.int(xs.length)]!;

const DEBUG_TEMPLATES: ((rng: Rng) => { lines: string[]; bug: number; what: string })[] = [
  (rng) => {
    const f = pick(rng, ['average', 'meanSpeed', 'avgLap']);
    return {
      lines: [`function ${f}(xs) {`, '  let sum = 0;', '  for (let i = 1; i < xs.length; i++) sum += xs[i];', '  return sum / xs.length;', '}'],
      bug: 3,
      what: `${f}([4, 6, 8]) returns 4.67 instead of 6`,
    };
  },
  (rng) => {
    const f = pick(rng, ['canEnter', 'isCleared', 'hasPass']);
    return {
      lines: [`function ${f}(level) {`, '  if (level = 3) {', '    return true;', '  }', '  return false;', '}'],
      bug: 2,
      what: `${f}(1) returns true`,
    };
  },
  (rng) => {
    const f = pick(rng, ['maxOf', 'peak', 'highest']);
    return {
      lines: [`function ${f}(xs) {`, '  let m = 0;', '  for (const x of xs) {', '    if (x > m) m = x;', '  }', '  return m;', '}'],
      bug: 2,
      what: `${f}([-5, -2, -9]) returns 0 instead of -2`,
    };
  },
  (rng) => {
    const f = pick(rng, ['countVowels', 'vowelCount', 'tally']);
    return {
      lines: [`function ${f}(s) {`, '  let n = 0;', '  for (const c of s) {', "    if ('aeiou'.includes(c)) n++;", '  }', '  return c;', '}'],
      bug: 6,
      what: `${f}("gate") throws ReferenceError`,
    };
  },
];

export function makeDebugTask(rng: Rng): DebugTask {
  const t = DEBUG_TEMPLATES[rng.int(DEBUG_TEMPLATES.length)]!(rng);
  return { prompt: `Bug report: ${t.what}. Which line has the bug?`, lines: t.lines.map((l, i) => `${i + 1}  ${l}`), answer: `Line ${t.bug}` };
}

export interface AuthTask {
  prompt: string;
  badges: string[];
  forged: number;
}

/** Gate badges HX-dddd-c with check digit c = (sum of the four digits) mod 10; exactly one is forged. */
export function makeAuthTask(rng: Rng): AuthTask {
  const forged = rng.int(3);
  const badges = [0, 1, 2].map((i) => {
    const d = [rng.int(10), rng.int(10), rng.int(10), rng.int(10)];
    const sum = d.reduce((a, b) => a + b, 0) % 10;
    const check = i === forged ? (sum + 1 + rng.int(8)) % 10 : sum;
    return `HX-${d.join('')}-${check}`;
  });
  return {
    prompt: 'Gate access badges carry a check digit: the last digit equals the sum of the four middle digits, mod 10. Which badge is forged?',
    badges,
    forged,
  };
}
