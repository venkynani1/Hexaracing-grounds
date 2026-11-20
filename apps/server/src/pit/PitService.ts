import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fuelTransactions, pitStops, type Db } from '@redline/db';
import { BALANCE, SQUAD_RUBRIC, createRng, type PitPlan, type PitStage, type PitView, type Role, type StationDef } from '@redline/shared';
import { badRequest, conflict, forbidden } from '../http/errors';
import type { SquadService, Actor } from '../squad/SquadService';
import type { WorldSim } from '../world/WorldSim';
import { SYSTEMS, SYSTEM_SERVICE, makeDiagnostics, makeReports, type Diagnostics, type Reports } from './content';

interface Stop {
  id: string;
  teamId: string;
  station: StationDef;
  stage: PitStage;
  arrivedAt: number;
  bay: number | null;
  bayAt: number | null;
  plan: PitPlan | null;
  diag: Diagnostics | null;
  diagChosen: string | null;
  reports: Reports | null;
  reportChosen: number | null;
  confirmed: boolean;
  serviceEndsAt: number | null;
  result: PitView['result'];
  forced: boolean;
}

/**
 * Shared service stations (SPEC Part 9): ≥ 4 bays per station, FIFO queue per station, max dwell 60 s from bay
 * assignment, cars inside a station are non-collidable, so no squad can block another. The 6 steps:
 *   1 Racer enters (server-detected) → 2 Captain selects services → 3 Engineer diagnostics →
 *   4 Deceiver spots the false report → 5 Captain confirms → 6 car released onto the road.
 * Steps 2–4 can happen in parallel inside the bay; confirmation needs a plan. All decisions server-side.
 */
export class PitService {
  private readonly stations = new Map<string, { def: StationDef; bays: (string | null)[]; queue: string[] }>();
  private readonly stops = new Map<string, Stop>();
  private readonly count = new Map<string, number>();
  private readonly cooldown = new Map<string, { station: string; until: number }>();

  constructor(
    private readonly db: Db,
    private readonly seed: string,
    private readonly sim: WorldSim,
    private readonly squad: SquadService,
    private readonly elapsed: () => number,
    private readonly fuelPriceMul: () => number,
  ) {
    for (const def of sim.map.stations) this.stations.set(def.id, { def, bays: Array(BALANCE.pit.bays).fill(null), queue: [] });
  }

  snapshot() {
    return {
      stations: [...this.stations].map(([id, st]) => ({ id, bays: st.bays, queue: st.queue })),
      stops: [...this.stops].map(([t, st]) => ({ ...st, station: st.station.id })),
      count: [...this.count],
      cooldown: [...this.cooldown],
    };
  }

  restore(snap: ReturnType<PitService['snapshot']>) {
    for (const s of snap.stations) {
      const st = this.stations.get(s.id);
      if (st) (st.bays = s.bays), (st.queue = s.queue);
    }
    for (const st of snap.stops) {
      const def = this.stations.get(st.station)?.def;
      if (def) this.stops.set(st.teamId, { ...st, station: def });
    }
    for (const [k, v] of snap.count) this.count.set(k, v);
    for (const [k, v] of snap.cooldown) this.cooldown.set(k, v);
  }

  stopOf(teamId: string) {
    const s = this.stops.get(teamId);
    return s && s.stage !== 'done' ? s : null;
  }

  /** Called every simulation step (after sim.step). */
  async tick() {
    const now = this.sim.simMs;
    // Step 1: arrivals detected by the sim (slow, inside a station zone).
    for (const a of this.sim.pitArrivals.splice(0)) {
      const cd = this.cooldown.get(a.teamId);
      if (this.stopOf(a.teamId) || (cd && cd.station === a.stationId && cd.until > now)) continue;
      await this.arrive(a.teamId, a.stationId);
    }
    for (const st of this.stations.values()) {
      // FIFO bay assignment.
      for (let b = 0; b < st.bays.length && st.queue.length; b++) {
        if (st.bays[b]) continue;
        const teamId = st.queue.shift()!;
        this.assignBay(this.stops.get(teamId)!, b);
      }
      for (const teamId of st.bays) {
        if (!teamId) continue;
        const stop = this.stops.get(teamId)!;
        if (stop.stage === 'servicing' && stop.serviceEndsAt! <= now) await this.release(stop);
        else if (stop.stage === 'in_bay' && now - stop.bayAt! >= BALANCE.pit.maxDwellMs) await this.force(stop);
      }
    }
    // Roadside recoveries (fuel exhaustion): charge credits (free if broke), record the transaction.
    for (const r of this.sim.recoveries.splice(0)) {
      const cost = Math.min(BALANCE.recovery.cost, this.squad.credits(r.teamId));
      this.squad.spend(r.teamId, cost);
      await this.fuelTx(r.teamId, BALANCE.recovery.fuelPct, 'roadside_recovery', -cost, `recovery:${r.teamId}:${r.tick}`);
      this.squad.onTeamChanged(r.teamId);
    }
  }

  private async arrive(teamId: string, stationId: string) {
    const st = this.stations.get(stationId)!;
    const car = this.sim.cars.get(teamId)!;
    const n = (this.count.get(teamId) ?? 0) + 1;
    this.count.set(teamId, n);
    const stop: Stop = {
      id: randomUUID(),
      teamId,
      station: st.def,
      stage: 'queued',
      arrivedAt: this.sim.simMs,
      bay: null,
      bayAt: null,
      plan: null,
      diag: null,
      diagChosen: null,
      reports: null,
      reportChosen: null,
      confirmed: false,
      serviceEndsAt: null,
      result: null,
      forced: false,
    };
    this.stops.set(teamId, stop);
    st.queue.push(teamId);
    // Queued cars wait where they stopped inside the station zone (non-collidable there).
    this.sim.hold(teamId, { x: car.state.x, z: car.state.z, heading: car.state.heading }, 'pit');
    await this.db.insert(pitStops).values({ id: stop.id, teamId, stationId, stage: 'queued', startedAt: new Date() }).onConflictDoNothing();
    this.squad.onTeamChanged(teamId);
  }

  private assignBay(stop: Stop, bay: number) {
    const st = this.stations.get(stop.station.id)!;
    st.bays[bay] = stop.teamId;
    stop.bay = bay;
    stop.bayAt = this.sim.simMs;
    stop.stage = 'in_bay';
    const rng = createRng(this.seed, `pit:${stop.teamId}:${this.count.get(stop.teamId)}`);
    stop.diag = makeDiagnostics(rng);
    stop.reports = makeReports(rng, this.sim.cars.get(stop.teamId)!.state);
    const b = stop.station.bays[bay]!;
    this.sim.hold(stop.teamId, b, 'pit'); // pit crew rolls the car into its bay (disclosed in the UI)
    this.squad.onTeamChanged(stop.teamId);
  }

  private prices() {
    const m = this.fuelPriceMul();
    return { fuelPerPct: BALANCE.pit.fuelCostPerPct * m, repairPerPt: BALANCE.pit.repairCostPerPt, tyres: BALANCE.pit.tyresCost };
  }

  private cost(teamId: string, plan: PitPlan) {
    const car = this.sim.cars.get(teamId)!.state;
    const p = this.prices();
    return Math.round(plan.fuelPct * p.fuelPerPct + (plan.repair ? (100 - car.health) * p.repairPerPt : 0) + (plan.tyres ? p.tyres : 0));
  }

  private requireBay(actor: Actor, role: Role) {
    if (actor.role !== role) throw forbidden('WRONG_ROLE', `Only the ${role.toLowerCase()} does this pit step`);
    const stop = this.stopOf(actor.teamId);
    if (!stop || stop.stage !== 'in_bay') throw conflict('NOT_IN_BAY', 'Your squad car is not in a service bay');
    return stop;
  }

  /** Step 2 (Captain): choose services. Re-selectable until confirmation. */
  plan(actor: Actor, raw: unknown) {
    const stop = this.requireBay(actor, 'CAPTAIN');
    const r = (raw ?? {}) as Record<string, unknown>;
    const car = this.sim.cars.get(actor.teamId)!.state;
    const fuelPct = Math.round(Number(r.fuelPct ?? 0));
    if (!Number.isFinite(fuelPct) || fuelPct < 0 || fuelPct > Math.ceil(100 - car.fuel)) throw badRequest('INVALID_PLAN', `Fuel must be 0–${Math.ceil(100 - car.fuel)}%`);
    const plan: PitPlan = { fuelPct, repair: r.repair === true, tyres: r.tyres === true };
    if (this.cost(actor.teamId, plan) > this.squad.credits(actor.teamId)) throw conflict('NOT_ENOUGH_CREDITS', 'Not enough garage credits for that plan');
    stop.plan = plan;
    this.squad.onTeamChanged(actor.teamId);
    return { plan, cost: this.cost(actor.teamId, plan) };
  }

  /** Step 3 (Engineer): which system is out of spec? One answer. */
  diagnose(actor: Actor, answer: unknown) {
    const stop = this.requireBay(actor, 'ENGINEER');
    if (stop.diagChosen) throw conflict('ALREADY_DONE', 'Diagnostics already submitted');
    if (typeof answer !== 'string' || !(SYSTEMS as readonly string[]).includes(answer)) throw badRequest('INVALID_ANSWER', 'Pick a system');
    stop.diagChosen = answer;
    this.squad.onTeamChanged(actor.teamId);
    return { submitted: true };
  }

  /** Step 4 (Deceiver): which mechanic report is false? One answer. */
  verify(actor: Actor, index: unknown) {
    const stop = this.requireBay(actor, 'DECEIVER');
    if (stop.reportChosen !== null) throw conflict('ALREADY_DONE', 'Report check already submitted');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 2) throw badRequest('INVALID_ANSWER', 'Pick a report');
    stop.reportChosen = i;
    this.squad.onTeamChanged(actor.teamId);
    return { submitted: true };
  }

  /** Step 5 (Captain): confirm → credits charged, service time starts (always within the dwell cap). */
  async confirm(actor: Actor) {
    const stop = this.requireBay(actor, 'CAPTAIN');
    if (!stop.plan) throw conflict('NO_PLAN', 'Select services first');
    await this.startService(stop, stop.plan);
    return { serviceEndsInMs: stop.serviceEndsAt! - this.sim.simMs };
  }

  private async startService(stop: Stop, plan: PitPlan) {
    const P = BALANCE.pit;
    const cost = this.cost(stop.teamId, plan);
    this.squad.spend(stop.teamId, cost);
    stop.confirmed = true;
    stop.stage = 'servicing';
    const want = P.baseServiceMs + plan.fuelPct * P.fuelMsPerPct + (plan.repair ? P.repairMs : 0) + (plan.tyres ? P.tyresMs : 0);
    const left = P.maxDwellMs - (this.sim.simMs - stop.bayAt!);
    stop.serviceEndsAt = this.sim.simMs + Math.max(0, Math.min(want, left));
    const diagnosisCorrect = stop.diagChosen === null ? null : stop.diagChosen === stop.diag!.answer;
    const falseSpotted = stop.reportChosen === null ? null : stop.reportChosen === stop.reports!.falseIndex;
    stop.result = { diagnosisCorrect, falseSpotted, applied: plan, cost };
    await this.score(stop, plan, diagnosisCorrect, falseSpotted);
    this.squad.onTeamChanged(stop.teamId);
  }

  /** Max dwell reached without confirmation: apply the selected plan (or an affordable refuel) and release. */
  private async force(stop: Stop) {
    stop.forced = true;
    let plan = stop.plan;
    if (!plan || this.cost(stop.teamId, plan) > this.squad.credits(stop.teamId)) {
      const car = this.sim.cars.get(stop.teamId)!.state;
      const affordable = Math.floor(this.squad.credits(stop.teamId) / this.prices().fuelPerPct);
      plan = { fuelPct: Math.max(0, Math.min(Math.floor(100 - car.fuel), affordable)), repair: false, tyres: false };
    }
    await this.startService(stop, plan);
    stop.serviceEndsAt = this.sim.simMs;
    await this.release(stop);
  }

  /** Step 6: apply the service to the REAL car and return it to the shared road at the station exit. */
  private async release(stop: Stop) {
    const plan = stop.result?.applied ?? { fuelPct: 0, repair: false, tyres: false };
    const car = this.sim.cars.get(stop.teamId)!;
    car.state = {
      ...car.state,
      fuel: Math.min(100, car.state.fuel + plan.fuelPct),
      health: plan.repair ? 100 : car.state.health,
      tires: plan.tyres ? 100 : car.state.tires,
    };
    const st = this.stations.get(stop.station.id)!;
    if (stop.bay !== null) st.bays[stop.bay] = null;
    st.queue = st.queue.filter((t) => t !== stop.teamId);
    stop.stage = 'done';
    this.sim.release(stop.teamId, stop.station.exit);
    this.cooldown.set(stop.teamId, { station: stop.station.id, until: this.sim.simMs + BALANCE.pit.reentryCooldownMs });
    if (plan.fuelPct > 0) await this.fuelTx(stop.teamId, plan.fuelPct, 'pit_refuel', -Math.round(plan.fuelPct * this.prices().fuelPerPct), `pit:${stop.id}:fuel`);
    await this.db
      .update(pitStops)
      .set({ stage: 'done', completedAt: new Date(), outcome: { ...stop.result, forced: stop.forced, dwellMs: this.sim.simMs - (stop.bayAt ?? stop.arrivedAt) } })
      .where(eq(pitStops.id, stop.id));
    this.squad.onTeamChanged(stop.teamId);
  }

  private async score(stop: Stop, plan: PitPlan, diagnosisCorrect: boolean | null, falseSpotted: boolean | null) {
    const elapsed = this.elapsed();
    const win = BALANCE.serviceWindows.find((w) => elapsed >= w.fromMs && elapsed < w.toMs);
    if (!win) return;
    const R = SQUAD_RUBRIC.pit;
    await this.squad.award(stop.teamId, 'FUEL_MANAGEMENT', diagnosisCorrect ? R.fuel : R.fuelWrong, `${win.id}: pit stop (diagnosis ${diagnosisCorrect ? 'correct' : 'missed'})`, 'pit_fuel', win.id);
    const service = stop.diag ? SYSTEM_SERVICE[stop.diag.answer] : null;
    const covered = service === 'fuelPct' ? plan.fuelPct > 0 : service ? plan[service] === true : false;
    if (covered && falseSpotted) await this.squad.award(stop.teamId, 'CAPTAIN_STRATEGY', R.strategy, `${win.id}: plan covered the diagnosed fault, false report spotted`, 'pit_strategy', win.id);
  }

  private async fuelTx(teamId: string, delta: number, reason: string, credits: number, key: string) {
    await this.db.insert(fuelTransactions).values({ teamId, deltaFuel: delta, reason, creditsDelta: credits, atTick: this.sim.tick, idempotencyKey: key }).onConflictDoNothing();
  }

  /** The squad's pit stop as seen by one role (diagnostics only for the Engineer, reports only for the Deceiver). */
  viewFor(teamId: string, role: Role): PitView | null {
    const stop = this.stops.get(teamId);
    if (!stop) return null;
    const st = this.stations.get(stop.station.id)!;
    const now = this.sim.simMs;
    return {
      stopId: stop.id,
      stationId: stop.station.id,
      stationName: stop.station.name,
      stage: stop.stage,
      queuePosition: stop.stage === 'queued' ? st.queue.indexOf(teamId) + 1 : 0,
      bay: stop.bay,
      dwellLeftMs: stop.stage === 'in_bay' ? Math.max(0, BALANCE.pit.maxDwellMs - (now - stop.bayAt!)) : null,
      serviceLeftMs: stop.stage === 'servicing' ? Math.max(0, stop.serviceEndsAt! - now) : null,
      steps: {
        enter: true,
        select: !!stop.plan,
        diagnose: stop.diagChosen !== null,
        verify: stop.reportChosen !== null,
        confirm: stop.confirmed,
        release: stop.stage === 'done',
      },
      plan: stop.plan,
      prices: this.prices(),
      diagnostics: role === 'ENGINEER' && stop.diag ? { readings: stop.diag.readings, options: [...SYSTEMS], chosen: stop.diagChosen } : undefined,
      reports: role === 'DECEIVER' && stop.reports ? { items: stop.reports.items, chosen: stop.reportChosen } : undefined,
      result: stop.stage === 'done' || stop.stage === 'servicing' ? stop.result : null,
    };
  }
}
