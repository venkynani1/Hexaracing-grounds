import {
  BEATS,
  BEAT_EFFECTS,
  ENVELOPE_OPTIONS,
  FUEL_CRISIS_PRICE_MUL,
  INITIAL_WORLD_STATE,
  TRAFFIC_SHOCK_SPEED_MUL,
  createRng,
  type BeatId,
  type WorldState,
} from '@redline/shared';
import type { WorldSim } from '../world/WorldSim';
import type { SquadService } from '../squad/SquadService';
import { chooseClosure } from './closures';

const MIN = 60_000;
export const MONSOON_END_MS = 45 * MIN;

/**
 * The Redline Director's world effects. Every decision is a pure function of (EVENT_SEED, beat id) over a bounded,
 * pre-validated option list — never of player positions — so the same seed reproduces the same beat log.
 */
export class Director {
  state: WorldState = structuredClone(INITIAL_WORLD_STATE);
  /** Every beat's decision, in firing order (audit + determinism tests). */
  readonly log: { beat: BeatId; atMs: number; decision: string }[] = [];

  constructor(
    private readonly seed: string,
    private readonly sim: WorldSim,
    private readonly squad: SquadService | null,
    private readonly onChange: (s: WorldState) => void,
  ) {}

  snapshot() {
    return { state: this.state, log: [...this.log] };
  }

  restore(snap: ReturnType<Director['snapshot']>) {
    this.state = structuredClone(snap.state);
    this.log.splice(0, this.log.length, ...snap.log);
    this.applyToSim();
  }

  private commit(mut: (s: WorldState) => void) {
    const next = structuredClone(this.state);
    mut(next);
    next.rev = this.state.rev + 1;
    this.state = next;
    this.applyToSim();
    this.onChange(this.state);
  }

  /** Push the world state into the simulation (rain grip, closures, slow roads). */
  private applyToSim() {
    this.sim.rain = this.state.rain;
    this.sim.setClosures(this.state.closures);
    const mul = new Map<number, number>();
    for (const r of this.state.slowRoads) for (const e of r.edges) mul.set(e, r.mul);
    this.sim.traffic.edgeSpeedMul = mul;
  }

  fire(beat: BeatId, atMs: number): string {
    const rng = createRng(this.seed, `beat:${beat}`);
    const eff = BEAT_EFFECTS[beat];
    let decision = 'announce';
    let text = eff.text;
    const map = this.sim.map;
    this.commit((s) => {
      switch (beat) {
        case 'TRAFFIC_SHOCK': {
          const names = [...new Set(Object.values(map.courses).flatMap((c) => c.des.map((de) => map.net.edges[de >> 1]!).filter((e) => e.cls <= 2 && e.name).map((e) => e.name!)))].sort();
          if (names.length) {
            const name = rng.pick(names);
            const edges = map.net.edges.filter((e) => e.name === name).map((e) => e.id);
            s.slowRoads.push({ label: name, edges, mul: TRAFFIC_SHOCK_SPEED_MUL, untilMs: atMs + eff.durationMs! });
            decision = `jam:${name}`;
            text = `${eff.text} Jammed: ${name}.`;
          }
          break;
        }
        case 'FUEL_CRISIS':
          s.fuelPriceMul = FUEL_CRISIS_PRICE_MUL;
          decision = `fuel_price:x${FUEL_CRISIS_PRICE_MUL}`;
          break;
        case 'CLASSIFIED_ENVELOPE': {
          const kind = rng.pick(ENVELOPE_OPTIONS);
          this.squad?.grantAll(kind);
          decision = `envelope:${kind}`;
          text = `${eff.text} Inside: ${kind.replace('_', ' ')}.`;
          break;
        }
        case 'ROUTE_LOCKDOWN': {
          const { closure, tried } = chooseClosure(map, rng, atMs + eff.durationMs!);
          if (closure) {
            s.closures.push(closure);
            decision = `closure:${closure.label}#${closure.edges[0]} (tried ${tried})`;
            text = `${eff.text} Closed: ${closure.label}.`;
          } else decision = 'closure:none-valid';
          break;
        }
        case 'MONSOON_PROTOCOL':
          s.rain = true;
          decision = 'rain:on';
          break;
        case 'TOTAL_REDLINE':
          for (const c of this.sim.cars.values()) this.sim.refillNitro(c.teamId);
          decision = 'nitro:refill_all';
          break;
        default:
          break;
      }
      s.announcement = { beat, text, atMs };
      s.beats.push({ beat, atMs, decision });
    });
    this.log.push({ beat, atMs, decision });
    return decision;
  }

  /** Expire timed effects. Called every Director tick with LIVE elapsed ms. */
  update(elapsedMs: number) {
    const s = this.state;
    const expired =
      s.closures.some((c) => c.untilMs <= elapsedMs) ||
      s.slowRoads.some((r) => r.untilMs <= elapsedMs) ||
      (s.fuelPriceMul !== 1 && this.fuelUntil(elapsedMs)) ||
      (s.rain && elapsedMs >= MONSOON_END_MS);
    if (!expired) return;
    this.commit((n) => {
      n.closures = n.closures.filter((c) => c.untilMs > elapsedMs);
      n.slowRoads = n.slowRoads.filter((r) => r.untilMs > elapsedMs);
      if (this.fuelUntil(elapsedMs)) n.fuelPriceMul = 1;
      if (elapsedMs >= MONSOON_END_MS) n.rain = false;
    });
  }

  private fuelUntil(elapsedMs: number) {
    const fired = this.state.beats.find((b) => b.beat === 'FUEL_CRISIS');
    return !!fired && elapsedMs >= fired.atMs + BEAT_EFFECTS.FUEL_CRISIS.durationMs!;
  }
}

export { BEATS };
