/**
 * Levels 3–4 Deceiver ops + alliances, and the Racer safe-hold during major puzzles.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { scoringEvents } from '@redline/db';
import { INTEL } from '@redline/shared';
import { HOST_KEY, fullSquad, makeServer, post, type TestServer } from './helpers';

const MIN = 60_000;
async function goTo(s: TestServer, ms: number) {
  s.advance(ms - s.room.clockState().elapsedMs);
  await s.room.tick();
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
type Sq = Awaited<ReturnType<typeof fullSquad>>;
const role = (q: Sq, r: 'RACER' | 'ENGINEER' | 'DECEIVER') => q.others[['RACER', 'ENGINEER', 'DECEIVER'].indexOf(r)]!.sessionToken;

async function setup(n: number) {
  const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
  const sq: Sq[] = [];
  for (let i = 0; i < n; i++) sq.push(await fullSquad(s, `Team${i}`));
  await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
  await s.room.tick();
  return { s, sq };
}

describe('Deceiver intel ops + alliances (24:00–42:00)', () => {
  it('jam is bounded (role, window, cooldown, protection, shield, allies) and never stops the car', async () => {
    const { s, sq } = await setup(4);
    try {
      const [A, B, C, D] = sq as [Sq, Sq, Sq, Sq];
      const id = (q: Sq) => q.captain.teamId;
      expect((await post(s, '/api/squad/intel/jam', { target: id(B) }, auth(role(A, 'DECEIVER')))).body.error).toBe('INTEL_CLOSED');
      await goTo(s, 24 * MIN);
      expect((await post(s, '/api/squad/intel/jam', { target: id(B) }, auth(role(A, 'ENGINEER')))).body.error).toBe('DECEIVER_ONLY');
      expect((await post(s, '/api/squad/intel/jam', { target: id(A) }, auth(role(A, 'DECEIVER')))).body.error).toBe('BAD_TARGET');
      const j = await post(s, '/api/squad/intel/jam', { target: id(B) }, auth(role(A, 'DECEIVER')));
      expect(j.body).toMatchObject({ landed: true });
      const vB = s.room.squad!.viewFor(id(B), 'RACER', B.others[0]!.playerId);
      expect(vB.intel!.jammedForMs).toBe(INTEL.jam.durationMs);
      expect(s.room.sim.cars.get(id(B))!.held).toBeNull(); // information only — the car keeps driving
      expect((await post(s, '/api/squad/intel/jam', { target: id(C) }, auth(role(A, 'DECEIVER')))).body.error).toBe('COOLDOWN');
      expect((await post(s, '/api/squad/intel/jam', { target: id(B) }, auth(role(C, 'DECEIVER')))).body.error).toBe('TARGET_PROTECTED');

      // shield: after B's protection window, B raises a shield; D's jam is blocked and B earns the block points
      await goTo(s, 24 * MIN + INTEL.jam.targetProtectionMs + 1000);
      expect((await post(s, '/api/squad/intel/shield', {}, auth(role(B, 'DECEIVER')))).status).toBe(200);
      expect((await post(s, '/api/squad/intel/jam', { target: id(B) }, auth(role(D, 'DECEIVER')))).body).toMatchObject({ landed: false, blocked: true });
      await new Promise((r) => setTimeout(r, 30));
      const pts = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.category, 'DECEPTION'));
      expect(pts.filter((p) => p.teamId === id(A) && p.sourceType === 'intel_jam')).toHaveLength(1);
      expect(pts.filter((p) => p.teamId === id(B) && p.sourceType === 'intel_block')).toHaveLength(1);

      // alliance: both Captains agree; allies cannot jam each other; one alliance per squad
      expect((await post(s, '/api/squad/intel/ally/propose', { target: id(C) }, auth(role(A, 'DECEIVER')))).body.error).toBe('CAPTAIN_ONLY');
      expect((await post(s, '/api/squad/intel/ally/propose', { target: id(C) }, auth(A.captain.sessionToken))).status).toBe(200);
      expect((await post(s, '/api/squad/intel/ally/accept', { from: id(D) }, auth(C.captain.sessionToken))).body.error).toBe('NO_PROPOSAL');
      expect((await post(s, '/api/squad/intel/ally/accept', { from: id(A) }, auth(C.captain.sessionToken))).body).toEqual({ ally: id(A) });
      const vA = s.room.squad!.viewFor(id(A), 'DECEIVER', A.others[2]!.playerId);
      expect(vA.intel!.ally?.teamId).toBe(id(C));
      expect(vA.intel!.deceiver!.targets.map((t) => t.teamId)).not.toContain(id(C));
      expect((await post(s, '/api/squad/intel/ally/propose', { target: id(D) }, auth(A.captain.sessionToken))).body.error).toBe('ALREADY_ALLIED');

      // non-Deceivers never see the Deceiver toolset; non-Captains never see alliance controls
      expect(s.room.squad!.viewFor(id(A), 'RACER', A.others[0]!.playerId).intel!.deceiver).toBeNull();
      expect(s.room.squad!.viewFor(id(A), 'ENGINEER', A.others[1]!.playerId).intel!.alliance).toBeNull();

      // restore round-trip
      const intel = s.room.intel!;
      const snap = JSON.parse(JSON.stringify(intel.snapshot()));
      intel.restore(snap);
      expect(intel.viewFor(id(A), 'CAPTAIN')!.ally?.teamId).toBe(id(C));

      await goTo(s, 42 * MIN);
      expect((await post(s, '/api/squad/intel/shield', {}, auth(role(C, 'DECEIVER')))).body.error).toBe('INTEL_CLOSED');
    } finally {
      await s.dispose();
    }
  });

  it('Racer safe-hold: only during an open major puzzle, once per puzzle, bounded, released when solved', async () => {
    const { s, sq } = await setup(1);
    try {
      const [A] = sq as [Sq];
      const tid = A.captain.teamId;
      await goTo(s, 5 * MIN);
      expect((await post(s, '/api/squad/safe-hold', { on: true }, auth(role(A, 'RACER')))).body.error).toBe('NO_PUZZLE');
      await goTo(s, 10 * MIN + 1000); // fourkey-1 open
      expect(s.room.squad!.viewFor(tid, 'RACER', A.others[0]!.playerId).safeHold).toMatchObject({ available: true, active: false });
      expect((await post(s, '/api/squad/safe-hold', { on: true }, auth(A.captain.sessionToken))).body.error).toBe('RACER_ONLY');
      const h = await post(s, '/api/squad/safe-hold', { on: true }, auth(role(A, 'RACER')));
      expect(h.body).toMatchObject({ held: true });
      const car = s.room.sim.cars.get(tid)!;
      expect(car.held?.reason).toBe('safe');
      expect(car.held!.until! - s.room.sim.simMs).toBeLessThanOrEqual(90_000);
      expect((await post(s, '/api/squad/safe-hold', { on: true }, auth(role(A, 'RACER')))).body.error).toBe('ALREADY_HELD');
      await post(s, '/api/squad/safe-hold', { on: false }, auth(role(A, 'RACER')));
      expect(car.held).toBeNull();
      expect((await post(s, '/api/squad/safe-hold', { on: true }, auth(role(A, 'RACER')))).body.error).toBe('HOLD_USED');

      // a hold during the next puzzle is released as soon as the squad solves it
      await goTo(s, 24 * MIN + 1000); // nav-1 open
      expect((await post(s, '/api/squad/safe-hold', { on: true }, auth(role(A, 'RACER')))).body).toMatchObject({ held: true });
      const ans = s.room.squad!.answerFor('navigation', 'nav-1', tid)!;
      const r = await post(s, '/api/squad/navigation/nav-1', { answer: ans, idempotencyKey: 'safehold-nav-1' }, auth(A.captain.sessionToken));
      expect(r.body.correct).toBe(true);
      await s.room.tick();
      expect(car.held).toBeNull();
    } finally {
      await s.dispose();
    }
  });
});
