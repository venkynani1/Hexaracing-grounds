/**
 * Level 4 rival system: automatic matchmaking, Captain-only duel with server-side answers, atomic Captain-approved
 * trades with bounds + idempotency, depot fallback for solo squads, window closing, snapshot/restore.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { fuelTransactions, scoringEvents } from '@redline/db';
import { RIVAL } from '@redline/shared';
import { duelQuestion } from '../src/rival/content';
import { RivalService } from '../src/rival/RivalService';
import { HOST_KEY, fullSquad, makeServer, post, type TestServer } from './helpers';

const MIN = 60_000;
async function goTo(s: TestServer, ms: number) {
  s.advance(ms - s.room.clockState().elapsedMs);
  await s.room.tick();
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function setup() {
  const s = await makeServer({ countdownMs: 0, releaseAtMs: 0, trafficCount: 0 }, { manualClock: true });
  const sq = [await fullSquad(s, 'Alpha'), await fullSquad(s, 'Bravo'), await fullSquad(s, 'Charlie')];
  await post(s, '/api/host/start', { force: true }, { 'x-host-key': HOST_KEY });
  await s.room.tick();
  return { s, sq, rival: s.room.rival! };
}

describe('Level 4: rival duels + trades', () => {
  it('matches automatically at 33:00 (pairs + one fair solo), Captain-only duel, first correct wins, idempotent', async () => {
    const { s, sq, rival } = await setup();
    try {
      expect(rival.viewFor(sq[0]!.captain.teamId, 'CAPTAIN')).toBeNull();
      await goTo(s, 33 * MIN);
      const views = sq.map((q) => rival.viewFor(q.captain.teamId, 'CAPTAIN')!);
      expect(views.every((v) => v && v.window === 'duel')).toBe(true);
      const solo = views.filter((v) => v.partner === null);
      expect(solo).toHaveLength(1);
      const paired = sq.filter((_, i) => views[i]!.partner);
      expect(paired).toHaveLength(2);
      expect(views.find((v) => v.partner?.teamId === paired[0]!.captain.teamId)).toBeTruthy();

      // non-captains never see the question options
      const eng = rival.viewFor(paired[0]!.captain.teamId, 'ENGINEER')!;
      expect(eng.duel!.options).toBeNull();
      expect((await post(s, '/api/squad/rival/duel', { answer: 'x' }, auth(paired[0]!.others[1].sessionToken))).body.error).toBe('CAPTAIN_ONLY');

      const pairId = (rival as any).pairOf.get(paired[0]!.captain.teamId) as string;
      const seed = (rival as any).seed as string;
      const answer = duelQuestion(seed, pairId).answer;
      const a = await post(s, '/api/squad/rival/duel', { answer, key: 'k1' }, auth(paired[0]!.captain.sessionToken));
      expect(a.body).toMatchObject({ correct: true, result: 'won', points: RIVAL.points.duelWin });
      // replay with the same key → same result, no second award
      const again = await post(s, '/api/squad/rival/duel', { answer, key: 'k1' }, auth(paired[0]!.captain.sessionToken));
      expect(again.body).toMatchObject({ result: 'won' });
      const b = await post(s, '/api/squad/rival/duel', { answer, key: 'k2' }, auth(paired[1]!.captain.sessionToken));
      expect(b.body).toMatchObject({ correct: true, result: 'second', points: RIVAL.points.duelSecond });
      // public ticker announced the round and the duel winner (no answers in it)
      expect(s.room.tickerItems.some((t) => t.kind === 'duel' && /rival round/.test(t.text))).toBe(true);
      expect(s.room.tickerItems.some((t) => t.kind === 'duel' && /wins the duel/.test(t.text))).toBe(true);
      expect(s.room.tickerItems.every((t) => !t.text.includes(answer))).toBe(true);
      const soloTeam = sq.find((x) => rival.viewFor(x.captain.teamId, 'CAPTAIN')!.partner === null)!;
      const wrong1 = await post(s, '/api/squad/rival/duel', { answer: 'nope', key: 'w1' }, auth(soloTeam.captain.sessionToken));
      expect(wrong1.body).toMatchObject({ correct: false, result: 'pending' });
      const wrong2 = await post(s, '/api/squad/rival/duel', { answer: 'nope', key: 'w2' }, auth(soloTeam.captain.sessionToken));
      expect(wrong2.body).toMatchObject({ correct: false, result: 'lost' });
      await new Promise((r) => setTimeout(r, 30));
      const rows = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.sourceType, 'rival_duel'));
      expect(rows.map((r) => r.points).sort()).toEqual([RIVAL.points.duelSecond, RIVAL.points.duelWin].sort());

      // window closes automatically: pending duels resolve as failed
      await goTo(s, 37 * MIN);
      expect((await post(s, '/api/squad/rival/duel', { answer, key: 'late' }, auth(paired[0]!.captain.sessionToken))).body.error).toBe('DUEL_CLOSED');
    } finally {
      await s.dispose();
    }
  });

  it('trades need both Captains, are bounded, atomic, ledgered once; depot is the solo path; state survives restore', async () => {
    const { s, sq, rival } = await setup();
    try {
      await goTo(s, 34 * MIN);
      const [A, B] = sq.filter((x) => rival.viewFor(x.captain.teamId, 'CAPTAIN')!.partner);
      const soloT = sq.find((x) => rival.viewFor(x.captain.teamId, 'CAPTAIN')!.partner === null)!;
      const sqd = s.room.squad!;
      const fuel = (t: string) => s.room.sim.cars.get(t)!.state.fuel;
      const credA0 = sqd.credits(A!.captain.teamId);
      const credB0 = sqd.credits(B!.captain.teamId);
      const fuelA0 = fuel(A!.captain.teamId);
      const fuelB0 = fuel(B!.captain.teamId);

      expect((await post(s, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 999 }, want: { kind: 'fuel', amount: 10 } }, auth(A!.captain.sessionToken))).status).toBe(400);
      expect((await post(s, '/api/squad/rival/offer', { give: { kind: 'fuel', amount: 10 }, want: { kind: 'fuel', amount: 5 } }, auth(A!.captain.sessionToken))).status).toBe(400);
      expect((await post(s, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 50 }, want: { kind: 'fuel', amount: 10 } }, auth(A!.others[0].sessionToken))).body.error).toBe('CAPTAIN_ONLY');
      expect((await post(s, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 50 }, want: { kind: 'fuel', amount: 10 } }, auth(soloT.captain.sessionToken))).body.error).toBe('NO_PARTNER');

      const off = await post(s, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 50 }, want: { kind: 'fuel', amount: 10 }, key: 'o1' }, auth(A!.captain.sessionToken));
      const offerId = off.body.offerId as string;
      expect(offerId).toBeTruthy();
      // the proposer cannot accept its own offer; a third squad cannot either
      expect((await post(s, '/api/squad/rival/respond', { offerId, accept: true }, auth(A!.captain.sessionToken))).body.error).toBe('NOT_YOUR_OFFER');
      expect((await post(s, '/api/squad/rival/respond', { offerId, accept: true }, auth(soloT.captain.sessionToken))).body.error).toBe('NOT_YOUR_OFFER');
      const acc = await post(s, '/api/squad/rival/respond', { offerId, accept: true }, auth(B!.captain.sessionToken));
      expect(acc.body.status).toBe('accepted');
      expect(sqd.credits(A!.captain.teamId)).toBe(credA0 - 50);
      expect(sqd.credits(B!.captain.teamId)).toBe(credB0 + 50);
      expect(fuel(A!.captain.teamId)).toBeCloseTo(Math.min(100, fuelA0 + 10), 3);
      expect(fuel(B!.captain.teamId)).toBeCloseTo(fuelB0 - 10, 3);
      // double accept is a no-op; pair can't trade again
      expect((await post(s, '/api/squad/rival/respond', { offerId, accept: true }, auth(B!.captain.sessionToken))).body.status).toBe('accepted');
      expect((await post(s, '/api/squad/rival/offer', { give: { kind: 'credits', amount: 10 }, want: { kind: 'fuel', amount: 5 } }, auth(B!.captain.sessionToken))).body.error).toBe('TRADE_DONE');
      await new Promise((r) => setTimeout(r, 30));
      const ledger = await s.db.db.select().from(fuelTransactions).where(eq(fuelTransactions.reason, 'rival_trade'));
      expect(ledger).toHaveLength(2);
      expect(ledger.reduce((a, r) => a + r.creditsDelta, 0)).toBe(0);
      const tradePts = await s.db.db.select().from(scoringEvents).where(eq(scoringEvents.sourceType, 'rival_trade'));
      expect(tradePts).toHaveLength(2);

      // depot: solo path, once
      const soloC0 = sqd.credits(soloT.captain.teamId);
      const soloF0 = fuel(soloT.captain.teamId);
      expect((await post(s, '/api/squad/rival/depot', { option: 'fuel' }, auth(soloT.captain.sessionToken))).body.status).toBe('ok');
      expect(sqd.credits(soloT.captain.teamId)).toBe(soloC0 - RIVAL.depot.fuel.credits);
      expect(fuel(soloT.captain.teamId)).toBeCloseTo(Math.min(100, soloF0 + RIVAL.depot.fuel.fuel), 3);
      expect((await post(s, '/api/squad/rival/depot', { option: 'fuel' }, auth(soloT.captain.sessionToken))).body.status).toBe('already-used');

      // restart safety: snapshot → fresh service → identical views
      const snap = JSON.parse(JSON.stringify(rival.snapshot()));
      const fresh = new RivalService(s.db.db, s.eventId, (rival as any).seed, s.room.sim, sqd, () => s.room.clockState().elapsedMs);
      fresh.restore(snap);
      for (const t of sq) expect(fresh.viewFor(t.captain.teamId, 'CAPTAIN')).toEqual(rival.viewFor(t.captain.teamId, 'CAPTAIN'));

      // window closes at 42:00
      await goTo(s, 42 * MIN);
      expect((await post(s, '/api/squad/rival/depot', { option: 'nitro' }, auth(A!.captain.sessionToken))).body.error).toBe('TRADE_CLOSED');
    } finally {
      await s.dispose();
    }
  });
});
