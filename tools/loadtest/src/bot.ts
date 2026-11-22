/**
 * Headless bot that speaks the REAL protocol (HTTP registration + WebSocket world channel) and runs the
 * same shared client prediction as the browser. Used by integration tests (N = 5/10/20/30 in one world)
 * and by the real-time load-test CLI.
 */
import WebSocket from 'ws';
import { chennaiMap } from '@redline/shared/map/chennai';
import {
  Predictor,
  ProceduralBuildings,
  generateBuildings,
  testMap,
  NEUTRAL_INPUT,
  type ClientMessage,
  type MapMessage,
  type ServerMessage,
  type SessionResponse,
  type Snapshot,
  type VehicleInput,
} from '@redline/shared';

export interface Squad {
  captain: SessionResponse;
  racer: SessionResponse;
  name: string;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

/** Create a squad (captain) and join a racer to it via the public HTTP API. */
export async function registerSquad(base: string, name: string): Promise<Squad> {
  const captain = await postJson<SessionResponse>(`${base}/api/squads`, { squadName: name, displayName: `${name} Cap` });
  const racer = await postJson<SessionResponse>(`${base}/api/squads/join`, { code: captain.joinCode, displayName: `${name} Racer`, role: 'RACER' });
  return { captain, racer, name };
}

/** Exchange a rejoin credential for a fresh session (same player, same slot). */
export async function rejoin(base: string, rejoinToken: string): Promise<SessionResponse> {
  return postJson<SessionResponse>(`${base}/api/session/rejoin`, { rejoinToken });
}

export interface FullSquad {
  name: string;
  members: Record<'CAPTAIN' | 'RACER' | 'ENGINEER' | 'DECEIVER', SessionResponse>;
}

/** Register a full squad of four through the public API. */
export async function registerFullSquad(base: string, name: string): Promise<FullSquad> {
  const captain = await postJson<SessionResponse>(`${base}/api/squads`, { squadName: name, displayName: `${name} Cap` });
  const join = (role: string) => postJson<SessionResponse>(`${base}/api/squads/join`, { code: captain.joinCode, displayName: `${name} ${role}`, role });
  return { name, members: { CAPTAIN: captain, RACER: await join('RACER'), ENGINEER: await join('ENGINEER'), DECEIVER: await join('DECEIVER') } };
}

export interface BotStats {
  messages: number;
  bytes: number;
  byType: Record<string, number>;
  snaps: number;
  corrections: number[];
}

export class Bot {
  ws!: WebSocket;
  roomId = '';
  seed = '';
  lastSnap: Snapshot | null = null;
  lastMap: MapMessage | null = null;
  /** Snapshots by tick (kept when `keepSnaps` is on). */
  readonly snaps = new Map<number, Snapshot>();
  readonly maps: MapMessage[] = [];
  /** Every raw message received (when keepLog) — used to prove what a player could ever see. */
  readonly log: string[] = [];
  lastSquad: Extract<ServerMessage, { t: 'squad' }>['view'] | null = null;
  predictor: Predictor | null = null;
  readonly stats: BotStats = { messages: 0, bytes: 0, byType: {}, snaps: 0, corrections: [] };
  closed = false;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(
    readonly label: string,
    private readonly opts: { keepSnaps?: boolean; keepLog?: boolean; origin?: string } = {},
  ) {}

  /** Connect to the world channel and complete the hello handshake. */
  async connect(wsUrl: string, sessionToken: string): Promise<void> {
    this.ws = new WebSocket(`${wsUrl.replace(/\/$/, '')}/ws`, { origin: this.opts.origin ?? 'http://localhost:5173' });
    this.ws.on('message', (d) => this.onMessage(d.toString()));
    this.ws.on('close', () => (this.closed = true));
    await new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.send({ t: 'hello', sessionToken });
    const w = await this.next((m) => m.t === 'welcome' || m.t === 'error', 10_000);
    if (w.t !== 'welcome' || w.kind !== 'player') throw new Error(`${this.label}: hello failed ${JSON.stringify(w)}`);
    this.roomId = w.roomId;
    this.seed = w.world.seed;
    // Same map + same procedural obstacles as the server, so prediction matches.
    const map = w.world.map === 'chennai' ? chennaiMap() : testMap();
    if (map.id === 'test') this.predictor = new Predictor(map.net, generateBuildings(map.net, this.seed));
    else {
      const pb = new ProceduralBuildings(map.net, this.seed);
      this.predictor = new Predictor(map.net, (x, z) => pb.near(x, z, 40));
    }
  }

  private onMessage(raw: string) {
    this.stats.messages++;
    this.stats.bytes += raw.length;
    if (this.opts.keepLog) this.log.push(raw);
    const m = JSON.parse(raw) as ServerMessage;
    this.stats.byType[m.t] = (this.stats.byType[m.t] ?? 0) + 1;
    if (m.t === 'snap') {
      this.stats.snaps++;
      this.lastSnap = m;
      if (this.opts.keepSnaps) this.snaps.set(m.tick, m);
      if (this.predictor) {
        const had = !!this.predictor.state;
        this.predictor.onSnapshot(m);
        if (had) this.stats.corrections.push(this.predictor.lastCorrection);
      }
    } else if (m.t === 'squad') {
      this.lastSquad = m.view;
    } else if (m.t === 'map') {
      this.lastMap = m;
      if (this.opts.keepSnaps) this.maps.push(m);
    }
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
  }

  next(pred: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: timeout waiting for message`)), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  send(m: ClientMessage) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** One 50 ms input step through the shared predictor (seq + redundancy). Returns the seq sent, or 0. */
  drive(input: Partial<VehicleInput>): number {
    if (!this.predictor?.state) return 0;
    const msg = this.predictor.stepMessage({ ...NEUTRAL_INPUT, ...input });
    this.send(msg);
    return msg.seq;
  }

  close() {
    this.ws?.close();
  }

  /** Simulate a dropped connection (no close handshake). */
  drop() {
    this.ws?.terminate();
  }
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}
