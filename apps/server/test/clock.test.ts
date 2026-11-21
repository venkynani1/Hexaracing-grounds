import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { auditLogs, eventStates } from '@redline/db';
import { BALANCE, BEATS, PHASES } from '@redline/shared';
import { EventClock } from '../src/clock/EventClock';
import { WorldRoom } from '../src/world/WorldRoom';
import { HOST_KEY, fullSquad, makeServer, post } from './helpers';

const MIN = 60_000;

describe('clock: EventClock (fake timers)', () => {
  afterEach(() => vi.useRealTimers());

  it('pause/resume preserves elapsed time exactly', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const c = new EventClock();
    expect(c.status(Date.now())).toBe('REGISTRATION_OPEN');
    c.start(Date.now());
    expect(c.status(Date.now())).toBe('COUNTDOWN');
    vi.advanceTimersByTime(BALANCE.countdownMs);
    expect(c.status(Date.now())).toBe('LIVE');
    vi.advanceTimersByTime(5 * MIN + 1234);
    expect(c.elapsedMs(Date.now())).toBe(5 * MIN + 1234);
    c.pause(Date.now());
    expect(c.status(Date.now())).toBe('PAUSED');
    vi.advanceTimersByTime(17 * MIN + 77);
    expect(c.elapsedMs(Date.now())).toBe(5 * MIN + 1234);
    c.resume(Date.now());
    expect(c.elapsedMs(Date.now())).toBe(5 * MIN + 1234);
    vi.advanceTimersByTime(1);
    expect(c.elapsedMs(Date.now())).toBe(5 * MIN + 1235);
    // Pause during countdown too.
    const c2 = new EventClock();
    c2.start(Date.now());
    vi.advanceTimersByTime(4000);
    c2.pause(Date.now());
    vi.advanceTimersByTime(60_000);
    c2.resume(Date.now());
    expect(c2.snapshot(Date.now()).countdownRemainingMs).toBe(BALANCE.countdownMs - 4000);
  });

  it('phase at given elapsed ms matches the timeline table', () => {
    vi.useFakeTimers({ now: 0 });
    const c = new EventClock();
    c.start(Date.now());
    vi.advanceTimersByTime(BALANCE.countdownMs);
    for (const p of PHASES) {
      vi.setSystemTime(BALANCE.countdownMs + p.startMs);
      expect(c.snapshot(Date.now()).phase).toBe(p.id);
    }
    vi.setSystemTime(BALANCE.countdownMs + 60 * MIN);
    expect(c.status(Date.now())).toBe('FINISHED');
  });

  it('rejects illegal transitions', () => {
    const c = new EventClock();
    expect(() => c.pause(0)).toThrow();
    expect(() => c.resume(0)).toThrow();
    c.start(0);
    expect(() => c.start(1)).toThrow();
  });
});

describe('clock: Director + host START', () => {
  it('START transitions REGISTRATION_LOCKED → COUNTDOWN → LIVE, persisted in event_states; beats fire once', async () => {
    const s = await makeServer({}, { manualClock: true });
    try {
      const notReady = await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      expect(notReady.status).toBe(409);
      await fullSquad(s, 'Alpha');
      const start = await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY });
      expect(start.status).toBe(200);
      expect(start.body.clock.status).toBe('COUNTDOWN');
      expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).body.error).toBe('ALREADY_STARTED');

      s.advance(BALANCE.countdownMs - 1);
      await s.room.tick();
      expect(s.room.clockState().status).toBe('COUNTDOWN');
      s.advance(1);
      await s.room.tick();
      expect(s.room.clockState().status).toBe('LIVE');
      expect(s.room.clockState().phase).toBe('IGNITION');

      // Walk through the whole event in 5 s ticks with a pause in the middle.
      for (let t = 0; t < 30 * MIN; t += 5000) {
        s.advance(5000);
        await s.room.tick();
      }
      const paused = await post(s, '/api/host/pause', {}, { 'x-host-key': HOST_KEY });
      expect(paused.body.clock.status).toBe('PAUSED');
      const frozen = paused.body.clock.elapsedMs;
      s.advance(10 * MIN);
      await s.room.tick();
      expect(s.room.clockState().elapsedMs).toBe(frozen);
      const resumed = await post(s, '/api/host/resume', {}, { 'x-host-key': HOST_KEY });
      expect(resumed.body.clock.elapsedMs).toBe(frozen);
      for (let t = 0; t < 31 * MIN; t += 5000) {
        s.advance(5000);
        await s.room.tick();
      }
      expect(s.room.clockState().status).toBe('FINISHED');

      const states = await s.db.db.select().from(eventStates).where(eq(eventStates.eventId, s.eventId)).orderBy(asc(eventStates.transitionedAt), asc(eventStates.createdAt));
      const statuses = states.map((r) => r.status);
      expect(statuses.slice(0, 3)).toEqual(['REGISTRATION_LOCKED', 'COUNTDOWN', 'LIVE']);
      expect(statuses).toContain('PAUSED');
      expect(statuses.at(-1)).toBe('FINISHED');
      const phases = [...new Set(states.filter((r) => r.status === 'LIVE').map((r) => r.phase))];
      expect(phases).toEqual(PHASES.map((p) => p.id));

      const beats = await s.db.db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, 'beat.fire'), eq(auditLogs.eventId, s.eventId)))
        .orderBy(asc(auditLogs.at));
      expect(beats.map((b) => (b.payload as { beat: string }).beat)).toEqual(BEATS.map((b) => b.id));
    } finally {
      await s.dispose();
    }
  }, 60_000);
});

describe('one world', () => {
  it('exactly one WorldRoom per event; a second is refused', async () => {
    const s = await makeServer();
    try {
      expect(WorldRoom.liveRoomsFor(s.eventId)).toBe(1);
      expect(() =>
        WorldRoom.create({ eventId: s.eventId, eventName: 'dup', clock: new EventClock(), db: s.db, sim: s.room.sim }),
      ).toThrow(/one world/);
    } finally {
      await s.dispose();
    }
    expect(WorldRoom.liveRoomsFor(s.eventId)).toBe(0);
  });
});
