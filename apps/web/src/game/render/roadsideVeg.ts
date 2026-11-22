/**
 * Roadside planting for the streamed Chennai world (visual only — plants are not obstacles on the server or in
 * prediction). Deterministic per road edge, so every phone sees the same trees in the same places.
 * Placement: both verges, 3–7 m beyond the kerb, never on a carriageway, junction mouth, building lot, station pad or
 * the gate lot. Species mix follows the OMR reference photos: coconut palms, broadleaf avenue trees, shrubs.
 */
import { createRng, edgesNear, nearestEdge, type Building, type RoadNetwork } from '@redline/shared';
import type { VegItem } from '../slice/build';

const SPACING = 12; // m between candidate spots along a verge (measured: 21 m looked bare)
const PICK: [string, number][] = [
  ['palm_straight', 0.16],
  ['palm_bend', 0.08],
  ['palm_dual', 0.05],
  ['ficus', 0.17],
  ['copal', 0.1],
  ['cecropia', 0.06],
  ['bush_01', 0.13],
  ['bush_04', 0.13],
  ['bush_05', 0.12],
];

function pick(r: number) {
  let acc = 0;
  for (const [sp, w] of PICK) if ((acc += w) >= r) return sp;
  return PICK[PICK.length - 1]![0];
}

const isTree = (sp: string) => !sp.startsWith('bush');

export function roadsideVegForCell(
  net: RoadNetwork,
  cellKey: string,
  cellSize: number,
  seed: string,
  buildingsNear: (x: number, z: number, r: number) => Building[],
  exclusions: readonly { x: number; z: number; r: number }[],
): VegItem[] {
  const [ci, cj] = cellKey.split(',').map(Number) as [number, number];
  const x0 = ci * cellSize;
  const z0 = cj * cellSize;
  const out: VegItem[] = [];
  const cx = x0 + cellSize / 2;
  const cz = z0 + cellSize / 2;
  for (const id of edgesNear(net, cx, cz, cellSize * 0.75)) {
    const e = net.edges[id]!;
    const a = net.nodes[e.a]!;
    const b = net.nodes[e.b]!;
    const L = e.length;
    if (L < 30) continue;
    const fx = (b.x - a.x) / L;
    const fz = (b.z - a.z) / L;
    const rng = createRng(seed, `veg-edge:${id}`);
    const margin = Math.max(a.radius ?? 12, b.radius ?? 12) + 10;
    for (let s = margin + rng.next() * SPACING; s < L - margin; s += SPACING * (0.75 + rng.next() * 0.5)) {
      for (const side of [-1, 1]) {
        const r1 = rng.next();
        const r2 = rng.next();
        const r3 = rng.next();
        const r4 = rng.next();
        if (r1 < 0.2) continue; // natural gaps
        const sp = pick(r2);
        const off = e.halfWidth + (isTree(sp) ? 4 : 2.6) + r3 * 3;
        const x = a.x + fx * s - fz * off * side;
        const z = a.z + fz * s + fx * off * side;
        if (x < x0 || x >= x0 + cellSize || z < z0 || z >= z0 + cellSize) continue;
        if (nearestEdge(net, x, z, 40).clearance < (isTree(sp) ? 3 : 1.8)) continue;
        if (exclusions.some((q) => Math.hypot(q.x - x, q.z - z) < q.r + 3)) continue;
        if (buildingsNear(x, z, 25).some((bd) => Math.hypot(bd.x - x, bd.z - z) < Math.max(bd.w, bd.d) / 2 + 2.5)) continue;
        out.push({ sp, x, z, yaw: r4 * Math.PI * 2, s: isTree(sp) ? 0.85 + r3 * 0.35 : 0.8 + r4 * 0.4, tint: 0.86 + r1 * 0.18 });
        // second row: a tree 7–11 m further back on about half the spots (depth, not a single fence of plants)
        if (r4 < 0.5) {
          const sp2 = pick(0.0001 + ((r2 * 7.31) % 0.45)); // palms / broadleaf only
          const off2 = off + 7 + r1 * 4;
          const x2 = a.x + fx * s - fz * off2 * side;
          const z2 = a.z + fz * s + fx * off2 * side;
          if (x2 >= x0 && x2 < x0 + cellSize && z2 >= z0 && z2 < z0 + cellSize && nearestEdge(net, x2, z2, 40).clearance >= 3 && !exclusions.some((q) => Math.hypot(q.x - x2, q.z - z2) < q.r + 3) && !buildingsNear(x2, z2, 25).some((bd) => Math.hypot(bd.x - x2, bd.z - z2) < Math.max(bd.w, bd.d) / 2 + 2.5))
            out.push({ sp: sp2, x: x2, z: z2, yaw: r3 * Math.PI * 2, s: 0.9 + r2 * 0.35, tint: 0.84 + r3 * 0.2 });
        }
      }
    }
  }
  return out;
}
