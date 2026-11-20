/**
 * SERVER-ONLY challenge content. Never import from the web app. Every question is original.
 * Generators take a seeded RNG stream per (event, squad, challenge) so each squad gets an equivalent but
 * different variant (numbers/words differ, difficulty identical) — copying another squad's answer won't work.
 */
import { type Rng, type Role, type WorldMap } from '@redline/shared';

export interface CodingVariant {
  prompt: string;
  code: string;
  options: string[] | null;
  answer: string;
}

export interface FourKeyVariant {
  prompt: string;
  clues: Record<Role, string>;
  answer: string;
}

export interface NavigationVariant {
  prompt: string;
  options: string[];
  answer: string;
}

export interface BluffPrompt {
  prompt: string;
  truth: string;
}

/** Normalise free-text answers: case, whitespace, quotes, trailing punctuation. */
export function normalizeAnswer(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;!]+$/, '')
    .trim();
}

const pickN = <T>(rng: Rng, n: number, lo: number, hi: number) => Array.from({ length: n }, () => lo + rng.int(hi - lo + 1)) as T[];

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/* ---------------- Coding (Engineer) ---------------- */

type CodingTemplate = (rng: Rng) => CodingVariant;

export const CODING_TEMPLATES: Record<string, CodingTemplate> = {
  mapFilter: (rng) => {
    const xs = pickN<number>(rng, 6, 1, 9);
    const k = 2 + rng.int(3);
    const t = 6 + rng.int(10);
    return {
      prompt: 'What does this JavaScript print?',
      code: `const xs = [${xs.join(', ')}];\nconsole.log(xs.map(x => x * ${k}).filter(x => x > ${t}).length);`,
      options: null,
      answer: String(xs.map((x) => x * k).filter((x) => x > t).length),
    };
  },
  loopContinue: (rng) => {
    const n = 6 + rng.int(6);
    const m = 2 + rng.int(2);
    let s = 0;
    for (let i = 0; i < n; i++) if (i % m !== 0) s += i;
    return {
      prompt: 'What does this JavaScript print?',
      code: `let s = 0;\nfor (let i = 0; i < ${n}; i++) {\n  if (i % ${m} === 0) continue;\n  s += i;\n}\nconsole.log(s);`,
      options: null,
      answer: String(s),
    };
  },
  pySetLen: (rng) => {
    const xs = pickN<number>(rng, 8, 1, 6);
    return {
      prompt: 'What does this Python print?',
      code: `print(len(set([${xs.join(', ')}])))`,
      options: null,
      answer: String(new Set(xs).size),
    };
  },
  offByOne: (rng) => {
    const correct = 'The loop reads one element past the end (i <= a.length)';
    const options = shuffle(rng, [correct, 't must start at 1, not 0', 'a[i] must be converted with parseInt', 'The return must be inside the loop']);
    const xs = pickN<number>(rng, 3, 1, 9);
    return {
      prompt: `Why does total([${xs.join(', ')}]) return NaN?`,
      code: 'function total(a) {\n  let t = 0;\n  for (let i = 0; i <= a.length; i++) t += a[i];\n  return t;\n}',
      options,
      answer: correct,
    };
  },
  reverseUpper: (rng) => {
    const w = rng.pick(['redline', 'siruseri', 'convoy', 'engineer', 'nitro', 'flyover', 'captain']);
    return {
      prompt: 'What does this JavaScript print?',
      code: `console.log([..."${w}"].reverse().join("").toUpperCase());`,
      options: null,
      answer: [...w].reverse().join('').toUpperCase(),
    };
  },
  pySlice: (rng) => {
    const w = rng.pick(['ab', 'xyz', 'go', 'gear']);
    const n = 3 + rng.int(2);
    const a = 1 + rng.int(2);
    const b = a + 2 + rng.int(3);
    return {
      prompt: 'What does this Python print?',
      code: `print(("${w}" * ${n})[${a}:${b}])`,
      options: null,
      answer: w.repeat(n).slice(a, b),
    };
  },
  floatEq: (rng) => {
    const pairs: [string, string, boolean][] = [
      ['0.1 + 0.2', '0.3', false],
      ['0.5 + 0.25', '0.75', true],
      ['0.1 + 0.7', '0.8', false],
      ['0.25 + 0.25', '0.5', true],
    ];
    const [l, r, eq] = rng.pick(pairs);
    return {
      prompt: 'What does this JavaScript print?',
      code: `console.log(${l} === ${r});`,
      options: shuffle(rng, ['true', 'false', 'undefined', 'TypeError']),
      answer: String(eq),
    };
  },
  pyDivMod: (rng) => {
    const a = 20 + rng.int(60);
    const b = 3 + rng.int(6);
    return {
      prompt: 'What does this Python print? (two numbers separated by a space)',
      code: `print(${a} // ${b}, ${a} % ${b})`,
      options: null,
      answer: `${Math.floor(a / b)} ${a % b}`,
    };
  },
};

/** Which templates each coding round uses (same for every squad, seeded per event). */
export function codingRoundTemplates(eventRng: Rng, rounds: number, perRound: number): string[][] {
  const names = shuffle(eventRng, Object.keys(CODING_TEMPLATES));
  return Array.from({ length: rounds }, (_, r) => names.slice(r * perRound, r * perRound + perRound));
}

/* ---------------- Four-key puzzles (all four roles hold one private clue; Captain submits) ---------------- */

const WORDS = ['GATE', 'ROAD', 'GEAR', 'LANE', 'TURN', 'PARK', 'DASH', 'FUEL', 'KERB', 'LAPS', 'TYRE', 'ZOOM', 'BOLT', 'HORN'];
const ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
const CARRIER_WORDS = ['FLYOVER', 'JUNCTION', 'CORRIDOR', 'ENGINEER', 'MONSOON', 'SIGNAL', 'HIGHWAY', 'CAPTAIN', 'BRIDGE', 'TRAFFIC'];

export const FOUR_KEY_TEMPLATES: Record<string, (rng: Rng) => FourKeyVariant> = {
  digits: (rng) => {
    const a = rng.int(8);
    const d1 = 2 + a;
    const k = 2 + rng.int(2);
    const j = Math.max(0, 2 ** k - 1 - rng.int(Math.min(9, 2 ** k)));
    const d2 = 2 ** k - j;
    const word = rng.pick(['CAR', 'CODE', 'RACER', 'SIGNAL', 'CONVOY', 'FLYOVER', 'TRAFFICS', 'ENGINEERS']);
    const d3 = word.length;
    const m = 1 + rng.int(3);
    const n = rng.int(3 * m + 1);
    const d4 = 3 * m - n;
    return {
      prompt: 'Combine your squad’s four private clues into a 4-digit gate code (digit 1 first). Only the Captain can submit.',
      clues: {
        RACER: `Digit 1 = the number of wheels on a motorcycle, plus ${a}.`,
        ENGINEER: `Digit 2 = 2 to the power ${k}, minus ${j}.`,
        DECEIVER: `Digit 3 = the number of letters in the word “${word}”.`,
        CAPTAIN: `Digit 4 = ${m} × 3, minus ${n}.`,
      },
      answer: `${d1}${d2}${d3}${d4}`,
    };
  },
  word: (rng) => {
    const w = rng.pick(WORDS);
    const [l1, l2, l3, l4] = [...w] as [string, string, string, string];
    const room = l1.charCodeAt(0) - 65; // letters available before l1
    const k = room > 0 ? 1 + rng.int(Math.min(3, room)) : 0;
    const prev = String.fromCharCode(l1.charCodeAt(0) - k);
    const carrier = CARRIER_WORDS.find((c) => c.includes(l3) && c.indexOf(l3) < ORD.length) ?? `${l3}AAAA`;
    const pos = carrier.indexOf(l3);
    const alphaPos = l4.charCodeAt(0) - 64;
    const prevOk = k > 0;
    return {
      prompt: 'Combine your squad’s four private clues into a 4-letter word (letter 1 first). Only the Captain can submit.',
      clues: {
        RACER: prevOk ? `Letter 1: start at “${prev}” and count ${k} letter${k > 1 ? 's' : ''} forward in the alphabet.` : `Letter 1 is “${l1}”.`,
        ENGINEER: `Letter 2 has the ASCII code ${l2.charCodeAt(0)}.`,
        DECEIVER: `Letter 3 is the ${ORD[pos]} letter of the word “${carrier}”.`,
        CAPTAIN: `Letter 4 is letter number ${alphaPos} of the alphabet.`,
      },
      answer: w,
    };
  },
};

/* ---------------- Navigation (Captain) ---------------- */

export function navigationVariant(rng: Rng, map: WorldMap): NavigationVariant {
  const net = map.net;
  const wpsAll = map.waypoints.map((w) => ({ ...w, n: net.nodes[w.node]! }));
  // Map point drawn inside the hull of the waypoints so the question stays local and unambiguous-ish.
  const xs = wpsAll.map((w) => w.n.x);
  const zs = wpsAll.map((w) => w.n.z);
  const x = Math.round(Math.min(...xs) + rng.next() * (Math.max(...xs) - Math.min(...xs)));
  const z = Math.round(Math.min(...zs) + rng.next() * (Math.max(...zs) - Math.min(...zs)));
  const wps = wpsAll.map((w) => ({ ...w, n: { x: Math.round(w.n.x), z: Math.round(w.n.z) } }));
  const dist = (w: (typeof wps)[number]) => Math.hypot(w.n.x - x, w.n.z - z);
  const sorted = [...wps].sort((a, c) => dist(a) - dist(c));
  // Avoid ambiguous ties: re-draw is unnecessary because positions are continuous; document coords.
  const list = wps.map((w) => `${w.label} (${w.n.x}, ${w.n.z})`).join('; ');
  return {
    prompt: `Intel: a route lockdown is coming. Your squad car must regroup at the waypoint nearest to map point (${x}, ${z}) — straight-line distance in world metres from the Hexaware gate, x = east, z = north. Waypoints: ${list}. Which one?`,
    options: shuffle(rng, wps.map((w) => w.label)),
    answer: sorted[0]!.label,
  };
}

/* ---------------- Bluffing (Deceiver) — verified, true answers ---------------- */

export const BLUFF_PROMPTS: BluffPrompt[] = [
  { prompt: 'The first logged computer “bug” (Harvard Mark II, 1947) was a real ___ found in a relay.', truth: 'moth' },
  { prompt: 'The programming language Python is named after ___.', truth: 'Monty Python' },
  { prompt: 'The word “robot” first appeared in a 1920 play by Czech writer ___.', truth: 'Karel Čapek' },
  { prompt: 'Ada Lovelace published an algorithm for Charles Babbage’s proposed ___.', truth: 'Analytical Engine' },
  { prompt: 'Chennai’s Marina Beach lies on the coast of the ___.', truth: 'Bay of Bengal' },
  { prompt: 'The QWERTY keyboard layout was originally designed for ___.', truth: 'typewriters' },
];
