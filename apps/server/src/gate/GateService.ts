import { eq } from 'drizzle-orm';
import { offerLetters, players, teams, type Db } from '@redline/db';
import {
  BALANCE,
  SQUAD_RUBRIC,
  coursePolyline,
  createRng,
  gateLayout,
  type ArrivalMode,
  type ConvoyTimeline,
  type GateView,
  type Role,
  type Standing,
} from '@redline/shared';
import { badRequest, conflict, forbidden } from '../http/errors';
import type { Actor, SquadService } from '../squad/SquadService';
import type { WorldSim } from '../world/WorldSim';
import { computeStandings } from './championship';
import { makeAuthTask, makeDebugTask, type AuthTask, type DebugTask } from './content';

const MIN = 60_000;
export const GATE_OPEN_MS = 50 * MIN;
export const GATE_CLOSE_MS = 55 * MIN;
export const REVEAL_MS = 58 * MIN;

interface GateTeam {
  digits: [number, number, number, number];
  debug: DebugTask;
  auth: AuthTask;
  debugChosen: string | null;
  authChosen: number | null;
  spot: number;
  parkingPoints: number | null;
  stillMs: number;
  codeAttempts: number;
  codeSolved: boolean;
  points: { parking: number; debug: number; auth: number; code: number };
}

/**
 * Hexaware Gate (SPEC Part 13), Welcome Convoy (Part 15), championship reveal and offer letters (Part 14, 16).
 * The assessment is open to EVERY squad 50:00–55:00 wherever its car is; squads not at the gate may take a
 * disclosed escort (0 driving points for skipped checkpoints). At 55:00 everyone not arrived gets assisted entry,
 * and all real cars form ONE convoy in the shared world.
 */
export class GateService {
  private readonly teams = new Map<string, GateTeam>();
  private convoyStarted = false;
  private revealed = false;
  timeline: ConvoyTimeline | null = null;
  standings: Standing[] | null = null;
  standingsAt = 0;
  /** WorldRoom hooks */
  onConvoy: (t: ConvoyTimeline) => void = () => {};
  onChampionship: (s: Standing[], at: number) => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly eventId: string,
    private readonly seed: string,
    private readonly sim: WorldSim,
    private readonly squad: SquadService,
    private readonly elapsed: () => number,
    private readonly now: () => number,
  ) {}

  activate(teamIds: string[]) {
    const ordered = [...teamIds].sort((a, b) => (this.sim.cars.get(a)?.cid ?? 0) - (this.sim.cars.get(b)?.cid ?? 0));
    ordered.forEach((teamId, i) => {
      if (this.teams.has(teamId)) return;
      const rng = createRng(this.seed, `gate:${teamId}`);
      this.teams.set(teamId, {
        digits: [rng.int(10), rng.int(10), rng.int(10), rng.int(10)],
        debug: makeDebugTask(rng),
        auth: makeAuthTask(rng),
        debugChosen: null,
        authChosen: null,
        spot: i % 30,
        parkingPoints: null,
        stillMs: 0,
        codeAttempts: 0,
        codeSolved: false,
        points: { parking: 0, debug: 0, auth: 0, code: 0 },
      });
    });
  }

  status(): GateView['status'] {
    const e = this.elapsed();
    return e < GATE_OPEN_MS ? 'upcoming' : e < GATE_CLOSE_MS ? 'open' : 'closed';
  }

  private requireOpen() {
    if (this.status() !== 'open') throw conflict('GATE_CLOSED', 'The Hexaware Gate assessment runs 50:00–55:00');
  }

  private team(teamId: string) {
    const t = this.teams.get(teamId);
    if (!t) throw conflict('NO_CAR', 'Squad car not in the world');
    return t;
  }

  /* ---------------- Director-clock hook ---------------- */

  async onTick() {
    const e = this.elapsed();
    if (this.status() === 'open') {
      // Disclosed auto-escort for squads still on the road at 51:30.
      if (e >= BALANCE.escort.autoAtMs)
        for (const c of this.sim.cars.values()) if (!c.arrival && !c.auto && !c.held) this.startEscort(c.teamId);
    }
    if (e >= GATE_CLOSE_MS && !this.convoyStarted) {
      this.convoyStarted = true;
      this.startConvoy();
    }
    if (e >= REVEAL_MS && !this.revealed) {
      this.revealed = true;
      await this.reveal();
    }
  }

  /** Per simulation step: arrivals + precision parking. */
  async tickWorld() {
    for (const a of this.sim.arrivals.splice(0)) this.squad.onTeamChanged(a.teamId);
    if (this.status() !== 'open') return;
    const lay = gateLayout(this.sim.map);
    for (const [teamId, t] of this.teams) {
      const car = this.sim.cars.get(teamId);
      if (!car || !car.arrival || car.auto || t.parkingPoints !== null) continue;
      const spot = lay.spots[t.spot]!;
      const d = Math.hypot(car.state.x - spot.x, car.state.z - spot.z);
      const still = Math.hypot(car.state.vx, car.state.vz) < 0.3;
      if (d <= BALANCE.parking.radius && still) t.stillMs += 50;
      else t.stillMs = 0;
      if (t.stillMs >= BALANCE.parking.stillMs) {
        const align = Math.abs(Math.cos(car.state.heading - spot.heading));
        t.parkingPoints = Math.round(SQUAD_RUBRIC.gate.parking * Math.max(0, 1 - d / BALANCE.parking.radius) * (0.5 + 0.5 * align));
        t.points.parking = t.parkingPoints;
        await this.squad.award(teamId, 'HEXAWARE_GATE', t.parkingPoints, `gate: precision parking (${d.toFixed(1)} m off)`, 'gate_parking', 'gate');
        this.squad.onTeamChanged(teamId);
      }
    }
  }

  /* ---------------- escort (disclosed assisted transition) ---------------- */

  private startEscort(teamId: string) {
    const car = this.sim.cars.get(teamId);
    const course = car && this.sim.map.courses[car.course];
    if (!car || !course) return false;
    const pts = coursePolyline(this.sim.net, course.des, 5);
    // Resume from the nearest point of the squad's own course at or after its next checkpoint's segment.
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dd = (pts[i]!.x - car.state.x) ** 2 + (pts[i]!.z - car.state.z) ** 2;
      if (dd < bd) (bd = dd), (best = i);
    }
    const path = pts.slice(best).map((p) => ({ x: p.x, z: p.z, d: p.d - pts[best]!.d }));
    if (path.length < 2) return false;
    const len = path[path.length - 1]!.d;
    const E = BALANCE.escort;
    const speed = Math.max(E.minSpeed, Math.min(E.maxSpeed, len / (E.targetMs / 1000)));
    this.sim.startAuto(teamId, 'escort', path, 0, speed);
    this.squad.onTeamChanged(teamId);
    return true;
  }

  requestEscort(actor: Actor) {
    if (actor.role !== 'RACER' && actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'The Racer or Captain requests the escort');
    this.requireOpen();
    const car = this.sim.cars.get(actor.teamId);
    if (!car) throw conflict('NO_CAR', 'Squad car not in the world');
    if (car.arrival) throw conflict('ARRIVED', 'Already at the gate');
    if (car.auto) throw conflict('ESCORTING', 'Escort already under way');
    if (car.held) throw conflict('HELD', 'Finish the pit stop first');
    if (!this.startEscort(actor.teamId)) throw conflict('NO_ROUTE', 'No course to escort along');
    return { escorting: true };
  }

  /* ---------------- tasks ---------------- */

  async debug(actor: Actor, answer: unknown) {
    if (actor.role !== 'ENGINEER') throw forbidden('WRONG_ROLE', 'Only the Engineer debugs at the gate');
    this.requireOpen();
    const t = this.team(actor.teamId);
    if (t.debugChosen !== null) throw conflict('ALREADY_DONE', 'Already submitted');
    if (typeof answer !== 'string') throw badRequest('INVALID_ANSWER', 'Pick a line');
    t.debugChosen = answer;
    if (answer === t.debug.answer) {
      t.points.debug = SQUAD_RUBRIC.gate.debug;
      await this.squad.award(actor.teamId, 'HEXAWARE_GATE', t.points.debug, 'gate: debugging', 'gate_debug', 'gate');
    }
    this.squad.onTeamChanged(actor.teamId);
    return { correct: answer === t.debug.answer, digit: t.digits[1] };
  }

  async auth(actor: Actor, index: unknown) {
    if (actor.role !== 'DECEIVER') throw forbidden('WRONG_ROLE', 'Only the Deceiver verifies authorization');
    this.requireOpen();
    const t = this.team(actor.teamId);
    if (t.authChosen !== null) throw conflict('ALREADY_DONE', 'Already submitted');
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i > 2) throw badRequest('INVALID_ANSWER', 'Pick a badge');
    t.authChosen = i;
    if (i === t.auth.forged) {
      t.points.auth = SQUAD_RUBRIC.gate.auth;
      await this.squad.award(actor.teamId, 'HEXAWARE_GATE', t.points.auth, 'gate: authorization verification', 'gate_auth', 'gate');
    }
    this.squad.onTeamChanged(actor.teamId);
    return { correct: i === t.auth.forged, digit: t.digits[2] };
  }

  async code(actor: Actor, code: unknown) {
    if (actor.role !== 'CAPTAIN') throw forbidden('WRONG_ROLE', 'Only the Captain submits the access code');
    this.requireOpen();
    const t = this.team(actor.teamId);
    const R = SQUAD_RUBRIC.gate.code;
    if (t.codeSolved || t.codeAttempts >= R.length) throw conflict('NO_ATTEMPTS', 'No attempts left');
    const c = String(code ?? '').replace(/\D/g, '');
    if (c.length !== 4) throw badRequest('INVALID_CODE', 'Enter 4 digits');
    t.codeAttempts++;
    const correct = c === t.digits.join('');
    if (correct) {
      t.codeSolved = true;
      t.points.code = R[t.codeAttempts - 1]!;
      // This row's created_at is the "final gate submission" time used by the predeclared tie-break.
      await this.squad.award(actor.teamId, 'HEXAWARE_GATE', t.points.code, `gate: access code (attempt ${t.codeAttempts})`, 'gate_code', 'gate');
    }
    this.squad.onTeamChanged(actor.teamId);
    return { correct, points: t.points.code, attemptsLeft: R.length - t.codeAttempts };
  }

  /* ---------------- 55:00 convoy, 58:00 reveal ---------------- */

  private startConvoy() {
    const lay = gateLayout(this.sim.map);
    const C = BALANCE.convoy;
    // Assisted entry (disclosed) for every squad not at the gate yet.
    for (const c of this.sim.cars.values()) {
      if (c.auto?.kind === 'escort') c.auto = null;
      if (!c.arrival) c.arrival = { mode: 'assisted', tick: this.sim.tick };
      c.held = null;
    }
    // Leaders first (current derived totals), ties by car id — deterministic.
    const cars = [...this.sim.cars.values()].sort((a, b) => this.squad.scoreOf(b.teamId).total - this.squad.scoreOf(a.teamId).total || a.cid - b.cid);
    const L = lay.convoyPath[lay.convoyPath.length - 1]!.d;
    const runMs = REVEAL_MS - GATE_CLOSE_MS - 3000;
    const lead = Math.max(cars.length * C.spacing, L - 30 - (C.speed * runMs) / 1000);
    const startAtSimMs = this.sim.simMs + 3000; // 3 s formation hold
    const slots: ConvoyTimeline['slots'] = cars.map((c, order) => {
      const s0 = Math.max(0, lead - order * C.spacing);
      this.sim.startAuto(c.teamId, 'convoy', lay.convoyPath, s0, C.speed, startAtSimMs);
      return { cid: c.cid, teamId: c.teamId, name: c.name, order, s0, assisted: c.arrival?.mode === 'assisted' };
    });
    this.timeline = {
      startsAtElapsedMs: GATE_CLOSE_MS + 3000,
      startsAtServerTime: this.now() + 3000,
      speed: C.speed,
      spacing: C.spacing,
      pathLength: L,
      slots,
    };
    this.onConvoy(this.timeline);
  }

  private async reveal() {
    this.standings = await computeStandings(this.db, this.eventId, this.seed, (teamId) => this.sim.cars.get(teamId)?.arrival?.mode ?? null);
    this.standingsAt = this.now();
    await this.writeOfferLetters(this.standings);
    this.onChampionship(this.standings, this.standingsAt);
  }

  /** One commemorative letter per player (idempotent). */
  private async writeOfferLetters(standings: Standing[]) {
    const byTeam = new Map(standings.map((s) => [s.teamId, s]));
    const rows = await this.db
      .select({ id: players.id, teamId: players.teamId, role: players.role })
      .from(players)
      .innerJoin(teams, eq(players.teamId, teams.id))
      .where(eq(teams.eventId, this.eventId));
    for (const p of rows) {
      const st = byTeam.get(p.teamId);
      if (!st) continue;
      await this.db
        .insert(offerLetters)
        .values({ playerId: p.id, achievement: achievement(st.rank, p.role), finalScore: st.total, arrivalStatus: arrivalText(st.arrival as ArrivalMode | null), pdfUrl: '/api/offer-letter' })
        .onConflictDoNothing();
    }
  }

  /* ---------------- views ---------------- */

  viewFor(teamId: string, role: Role): GateView | null {
    const t = this.teams.get(teamId);
    if (!t) return null;
    const car = this.sim.cars.get(teamId);
    const status = this.status();
    const lay = gateLayout(this.sim.map);
    const spot = lay.spots[t.spot]!;
    const arrived = !!car?.arrival;
    const roleIdx = { RACER: 0, ENGINEER: 1, DECEIVER: 2, CAPTAIN: 3 }[role];
    const revealed = [arrived, t.debugChosen !== null, t.authChosen !== null, true];
    const hints = ['Revealed when your car reaches the gate', 'Revealed when you submit the debug answer', 'Revealed when you submit the badge check', 'Your own access digit'];
    const open = status !== 'upcoming';
    return {
      status,
      arrival: car?.arrival?.mode ?? null,
      escortAvailable: status === 'open' && !arrived && !car?.auto && (role === 'RACER' || role === 'CAPTAIN'),
      escorting: car?.auto?.kind === 'escort',
      parking: { spot: t.spot + 1, x: spot.x, z: spot.z, heading: spot.heading, points: t.parkingPoints },
      debug: role === 'ENGINEER' && open ? { prompt: t.debug.prompt, lines: t.debug.lines, options: t.debug.lines.map((_, i) => `Line ${i + 1}`), chosen: t.debugChosen } : undefined,
      auth: role === 'DECEIVER' && open ? { prompt: t.auth.prompt, badges: t.auth.badges, chosen: t.authChosen } : undefined,
      myDigit: { index: roleIdx + 1, digit: open && revealed[roleIdx] ? t.digits[roleIdx]! : null, hint: hints[roleIdx]! },
      code:
        role === 'CAPTAIN' && open
          ? {
              prompt: 'Combine the four access digits: Racer (1), Engineer (2), Deceiver (3), you (4). Teammates see theirs once their part is done.',
              revealed,
              attempts: t.codeAttempts,
              maxAttempts: SQUAD_RUBRIC.gate.code.length,
              solved: t.codeSolved,
            }
          : undefined,
      points: t.points,
    };
  }

  /** SERVER-INTERNAL (tests / host tooling): never routed to a client. */
  answers(teamId: string) {
    const t = this.teams.get(teamId)!;
    return { code: t.digits.join(''), debug: t.debug.answer, forged: t.auth.forged, spot: gateLayout(this.sim.map).spots[t.spot]! };
  }
}

export function achievement(rank: number, role: Role): string {
  const rankTitle = rank === 1 ? 'Champion Squad' : rank <= 3 ? 'Podium Finisher' : 'Road to Hexaware Finisher';
  const roleTitle = { RACER: 'Chief Racer', ENGINEER: 'Lead Engineer', DECEIVER: 'Master of Deception', CAPTAIN: 'Squad Captain' }[role];
  return `${rankTitle} · ${roleTitle}`;
}

export function arrivalText(mode: ArrivalMode | null): string {
  if (mode === 'driven') return 'Arrived at Hexaware under own power';
  if (mode === 'escort') return 'Arrived at Hexaware via disclosed escort';
  return 'Assisted entry for the Welcome Convoy';
}
