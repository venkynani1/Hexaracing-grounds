/** SERVER-ONLY pit-stop content (seeded per squad and stop). */
import type { PitPlan, Rng, VehicleState } from '@redline/shared';

export const SYSTEMS = ['Fuel system', 'Tyres', 'Cooling', 'Brakes'] as const;
export type System = (typeof SYSTEMS)[number];

/** Which service fixes which system. */
export const SYSTEM_SERVICE: Record<System, keyof PitPlan> = { 'Fuel system': 'fuelPct', Tyres: 'tyres', Cooling: 'repair', Brakes: 'repair' };

export interface Diagnostics {
  readings: string[];
  answer: System;
}

/** Four sensor readings with spec ranges; exactly one system is out of spec. */
export function makeDiagnostics(rng: Rng): Diagnostics {
  const faulty = SYSTEMS[rng.int(SYSTEMS.length)]!;
  const r = (lo: number, hi: number, dp = 1) => +(lo + rng.next() * (hi - lo)).toFixed(dp);
  const readings: Record<System, string> = {
    'Fuel system': `Fuel rail pressure ${faulty === 'Fuel system' ? r(1.6, 2.6) : r(3.05, 3.45)} bar (spec 3.0–3.5)`,
    Tyres: `Tyre tread depth ${faulty === 'Tyres' ? r(0.8, 2.4) : r(3.4, 6.5)} mm (spec ≥ 3.0)`,
    Cooling: `Coolant temperature ${faulty === 'Cooling' ? r(104, 118, 0) : r(82, 93, 0)} °C (spec 80–95)`,
    Brakes: `Brake pad thickness ${faulty === 'Brakes' ? r(1.0, 3.2) : r(4.5, 9.0)} mm (spec ≥ 4.0)`,
  };
  return { readings: SYSTEMS.map((s) => readings[s]), answer: faulty };
}

export interface Reports {
  items: string[];
  falseIndex: number;
}

/** Three mechanic reports about the REAL car; one is falsified by ≥ 20 points. */
export function makeReports(rng: Rng, s: VehicleState): Reports {
  const facts = [
    { label: 'Fuel tank at', v: Math.round(s.fuel) },
    { label: 'Body health at', v: Math.round(s.health) },
    { label: 'Tyre condition at', v: Math.round(s.tires) },
  ];
  const falseIndex = rng.int(3);
  const items = facts.map((f, i) => {
    if (i !== falseIndex) return `${f.label} ${f.v}%`;
    const up = f.v <= 50 || (f.v < 80 && rng.next() < 0.5);
    const delta = 20 + rng.int(16);
    return `${f.label} ${Math.max(0, Math.min(100, up ? f.v + delta : f.v - delta))}%`;
  });
  return { items, falseIndex };
}
