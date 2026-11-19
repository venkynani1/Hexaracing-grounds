import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WAYPOINTS, createRng, createTestNetwork } from '@redline/shared';
import { BLUFF_PROMPTS, CODING_TEMPLATES, FOUR_KEY_TEMPLATES, navigationVariant, normalizeAnswer } from '../src/squad/content';

const runJs = (code: string) => {
  const out: string[] = [];
  new Function('console', code)({ log: (...a: unknown[]) => out.push(a.map(String).join(' ')) });
  return out.join('\n');
};
const runPy = (code: string) => spawnSync('python3', ['-c', code], { encoding: 'utf8' }).stdout.trim();
const hasPython = spawnSync('python3', ['--version']).status === 0;

describe('challenge content is correct (answer keys verified by execution)', () => {
  for (const [name, gen] of Object.entries(CODING_TEMPLATES)) {
    it(`coding template ${name}: stored answer equals real output for 40 seeds`, () => {
      for (let i = 0; i < 40; i++) {
        const v = gen(createRng('content', `${name}:${i}`));
        if (v.options) expect(v.options).toContain(v.answer);
        if (name === 'offByOne') continue; // conceptual MC, checked below
        const isPy = v.code.startsWith('print(');
        if (isPy && !hasPython) continue;
        const actual = isPy ? runPy(v.code) : runJs(v.code);
        expect(normalizeAnswer(actual), v.code).toBe(normalizeAnswer(v.answer));
      }
    });
  }

  it('off-by-one question really returns NaN for the shown input', () => {
    const v = CODING_TEMPLATES.offByOne!(createRng('x'));
    const arr = v.prompt.match(/\[(.*?)\]/)![1];
    expect(runJs(`${v.code}\nconsole.log(total([${arr}]))`)).toBe('NaN');
  });

  it('four-key clues decode to the stored answer (digits + word, 300 seeds each)', () => {
    for (let i = 0; i < 300; i++) {
      const d = FOUR_KEY_TEMPLATES.digits!(createRng('fk', `d${i}`));
      const r = Number(d.clues.RACER.match(/plus (\d+)/)![1]) + 2;
      const [, k, j] = d.clues.ENGINEER.match(/power (\d+), minus (\d+)/)!.map(Number) as [number, number, number];
      const w = d.clues.DECEIVER.match(/“(.+)”/)![1]!.length;
      const [, m, n] = d.clues.CAPTAIN.match(/(\d+) × 3, minus (\d+)/)!.map(Number) as [number, number, number];
      const digits = [r, 2 ** k - j, w, 3 * m - n];
      for (const x of digits) expect(x >= 0 && x <= 9, d.clues.ENGINEER).toBe(true);
      expect(digits.join('')).toBe(d.answer);

      const v = FOUR_KEY_TEMPLATES.word!(createRng('fk', `w${i}`));
      const l1m = v.clues.RACER.match(/start at “(.)” and count (\d+)/);
      const l1 = l1m ? String.fromCharCode(l1m[1]!.charCodeAt(0) + Number(l1m[2])) : v.clues.RACER.match(/is “(.)”/)![1];
      const l2 = String.fromCharCode(Number(v.clues.ENGINEER.match(/code (\d+)/)![1]));
      const ords = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
      const [, ord, word] = v.clues.DECEIVER.match(/the (\w+) letter of the word “(.+)”/)!;
      const l3 = word![ords.indexOf(ord!)];
      const l4 = String.fromCharCode(64 + Number(v.clues.CAPTAIN.match(/number (\d+)/)![1]));
      expect(`${l1}${l2}${l3}${l4}`).toBe(v.answer);
    }
  });

  it('navigation answer is the strictly nearest waypoint and is an option', () => {
    const net = createTestNetwork();
    for (let i = 0; i < 200; i++) {
      const v = navigationVariant(createRng('nav', String(i)));
      const [, x, z] = v.prompt.match(/map point \((-?\d+), (-?\d+)\)/)!.map(Number) as [number, number, number];
      const d = WAYPOINTS.map((w) => ({ l: w.label, d: Math.hypot(net.nodes[w.node]!.x - x, net.nodes[w.node]!.z - z) })).sort((a, b) => a.d - b.d);
      expect(v.answer).toBe(d[0]!.l);
      expect(v.options).toContain(v.answer);
    }
  });

  it('bluff prompts have non-empty true answers', () => {
    for (const b of BLUFF_PROMPTS) expect(b.truth.length).toBeGreaterThan(2);
  });
});
