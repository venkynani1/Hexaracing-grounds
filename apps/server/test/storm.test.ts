/**
 * M8: reconnection storm — 120 clients connected, 40 dropped at once, all rejoin to the same slots within 10 s.
 */
import { describe, expect, it } from 'vitest';
import { Bot, registerFullSquad, rejoin, type FullSquad } from '@redline/loadtest';
import type { Role } from '@redline/shared';
import { HOST_KEY, makeServer, post, until } from './helpers';

const ROLES: Role[] = ['CAPTAIN', 'RACER', 'ENGINEER', 'DECEIVER'];

describe('M8: reconnection storm', () => {
  it('drop 40 of 120 clients at once → all 40 rejoin to the same player slots within 10 s; the world keeps running', async () => {
    const s = await makeServer({ trafficCount: 30, countdownMs: 0, releaseAtMs: 0 });
    const base = await s.listen(0);
    const ws = base.replace('http', 'ws');
    const bots: { bot: Bot; squad: FullSquad; role: Role }[] = [];
    try {
      const squads: FullSquad[] = [];
      for (let i = 0; i < 30; i++) squads.push(await registerFullSquad(base, `Storm${i}`));
      await Promise.all(
        squads.flatMap((sq) =>
          ROLES.map(async (role) => {
            const bot = new Bot(`${sq.name}-${role}`);
            await bot.connect(ws, sq.members[role].sessionToken);
            bots.push({ bot, squad: sq, role });
          }),
        ),
      );
      expect(bots).toHaveLength(120);
      expect((await post(s, '/api/host/start', {}, { 'x-host-key': HOST_KEY })).status).toBe(200);
      await until(() => s.room.clients.size === 120);

      // Drop 40 at once: 10 whole squads (all roles, incl. their racers).
      const victims = bots.filter((b) => squads.indexOf(b.squad) < 10);
      expect(victims).toHaveLength(40);
      for (const v of victims) v.bot.drop();
      await until(() => s.room.clients.size === 80, 5000);

      const t0 = Date.now();
      const results = await Promise.all(
        victims.map(async (v) => {
          const fresh = await rejoin(base, v.squad.members[v.role].rejoinToken);
          const bot = new Bot(`${v.bot.label}-back`);
          await bot.connect(ws, fresh.sessionToken);
          return { v, fresh, bot };
        }),
      );
      const elapsed = Date.now() - t0;
      console.log(`[M8] 40 clients rejoined in ${elapsed} ms`);
      expect(elapsed).toBeLessThan(10_000);
      for (const r of results) {
        const orig = r.v.squad.members[r.v.role];
        expect(r.fresh.playerId).toBe(orig.playerId);
        expect(r.fresh.slot).toBe(orig.slot);
        expect(r.fresh.teamId).toBe(orig.teamId);
        expect(r.bot.roomId).toBe(s.room.roomId);
      }
      await until(() => s.room.clients.size === 120);
      // Every rejoined player shows as connected in its squad roster again (server truth).
      for (const r of results) expect(s.room.isConnected(r.fresh.playerId)).toBe(true);
      const team = await s.registration.getTeam(results[0]!.fresh.teamId);
      expect(s.room.toRoster(team!).players.every((p) => p.connected)).toBe(true);
      for (const r of results) r.bot.close();
    } finally {
      for (const b of bots) b.bot.close();
      await s.dispose();
    }
  }, 120_000);
});
