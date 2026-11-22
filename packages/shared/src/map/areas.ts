/**
 * Area recognisability — real place names (OSM `place=*` nodes, © OpenStreetMap contributors, ODbL 1.0) and the
 * roadside signs generated from them along every course. Pure data + lookups; the same on server, client and tests.
 */

export type AreaKind = 'city' | 'town' | 'suburb' | 'quarter' | 'neighbourhood' | 'village' | 'locality' | 'hamlet';

export interface AreaDef {
  name: string;
  kind: AreaKind;
  x: number;
  z: number;
  /** influence radius in world metres */
  r: number;
}

/** A roadside sign on a course, on the LEFT verge of travel (India drives on the left), facing oncoming drivers. */
export interface RouteSign {
  course: string;
  kind: 'place' | 'direction';
  x: number;
  z: number;
  /** travel heading at the sign (0 = north, clockwise) — the board faces traffic coming from behind */
  heading: number;
  /** distance along the course (world m) */
  s: number;
  title: string;
  sub?: string;
}

export interface PlacesJson {
  mapVersion: string;
  attribution: string;
  areas: AreaDef[];
  signs: RouteSign[];
}

/** Influence radius per kind, real metres (multiplied by the map scale at build time). */
export const AREA_RADIUS_M: Record<AreaKind, number> = {
  city: 5000,
  town: 3000,
  suburb: 2000,
  quarter: 1200,
  neighbourhood: 1100,
  village: 1400,
  locality: 800,
  hamlet: 600,
};

/** Grid index: `at(x, z)` = the place whose (distance / radius) is smallest, if inside its radius. */
export class AreaIndex {
  private readonly cell = 1000;
  private readonly grid = new Map<string, AreaDef[]>();
  private readonly maxR: number;

  constructor(readonly areas: readonly AreaDef[]) {
    this.maxR = Math.max(0, ...areas.map((a) => a.r));
    for (const a of areas) {
      const k = this.key(Math.floor(a.x / this.cell), Math.floor(a.z / this.cell));
      const list = this.grid.get(k);
      if (list) list.push(a);
      else this.grid.set(k, [a]);
    }
  }

  private key(i: number, j: number) {
    return `${i},${j}`;
  }

  at(x: number, z: number): AreaDef | null {
    const n = Math.ceil(this.maxR / this.cell);
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(z / this.cell);
    let best: AreaDef | null = null;
    let bestF = 1;
    for (let i = ci - n; i <= ci + n; i++)
      for (let j = cj - n; j <= cj + n; j++)
        for (const a of this.grid.get(this.key(i, j)) ?? []) {
          const f = Math.hypot(a.x - x, a.z - z) / a.r;
          if (f < bestF) {
            bestF = f;
            best = a;
          }
        }
    return best;
  }
}

/** Friendly road label: OSM name, with the common Chennai alias for the IT corridor. */
export function roadLabel(name: string | undefined): string | null {
  if (!name) return null;
  if (/rajiv gandhi salai|old mahabalipuram road/i.test(name)) return 'OMR — Rajiv Gandhi Salai';
  if (/east coast road/i.test(name)) return 'ECR — East Coast Road';
  if (/grand southern trunk|gst road/i.test(name)) return 'GST Road';
  return name;
}
