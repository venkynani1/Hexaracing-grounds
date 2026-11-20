import type { RoadNetwork } from '@redline/shared';

export interface MapDot {
  id: string | number;
  x: number;
  z: number;
  heading: number;
  label?: string;
  me?: boolean;
  ghost?: boolean;
  color?: string;
}

interface View {
  s: number;
  ox: number;
  oz: number;
  px: (x: number) => number;
  pz: (z: number) => number;
}

function viewFor(net: RoadNetwork, width: number, height: number, pad: number): View {
  const b = net.bounds;
  const s = Math.min((width - pad * 2) / (b.maxX - b.minX), (height - pad * 2) / (b.maxZ - b.minZ));
  const ox = (width - (b.maxX - b.minX) * s) / 2;
  const oz = (height - (b.maxZ - b.minZ) * s) / 2;
  return { s, ox, oz, px: (x) => ox + (x - b.minX) * s, pz: (z) => height - (oz + (z - b.minZ) * s) };
}

/** The road network is drawn ONCE per (network, size) into an offscreen canvas; frames only draw dots on top. */
const bgCache = new WeakMap<RoadNetwork, Map<string, HTMLCanvasElement>>();
function background(net: RoadNetwork, width: number, height: number, pad: number) {
  let per = bgCache.get(net);
  if (!per) bgCache.set(net, (per = new Map()));
  const key = `${width}x${height}`;
  let c = per.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const v = viewFor(net, width, height, pad);
  ctx.fillStyle = 'rgba(11,13,18,0.85)';
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = 'round';
  // minor roads first, majors on top
  for (const cls of [5, 4, 3, 2, 1, 0]) {
    ctx.strokeStyle = cls <= 1 ? '#7d879c' : cls === 2 ? '#5f687c' : '#3f4757';
    ctx.lineWidth = Math.max(cls <= 1 ? 1.6 : 1, (net.halfWidth || 6) * 2 * v.s);
    ctx.beginPath();
    for (const e of net.edges) {
      if (e.cls !== cls) continue;
      const a = net.nodes[e.a]!;
      const b = net.nodes[e.b]!;
      ctx.moveTo(v.px(a.x), v.pz(a.z));
      ctx.lineTo(v.px(b.x), v.pz(b.z));
    }
    ctx.stroke();
  }
  per.set(key, c);
  return c;
}

/**
 * Top-down map of the ONE world (racer minimap and host/projector map). North up.
 * Only real server positions are drawn — never fabricated ones (SPEC Part 17).
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  net: RoadNetwork,
  dots: MapDot[],
  opts: { labels?: boolean; dpr?: number; route?: { x: number; z: number }[]; marks?: { x: number; z: number; next?: boolean }[]; target?: { x: number; z: number } | null } = {},
) {
  const { width, height } = ctx.canvas;
  const dpr = opts.dpr ?? 1;
  const pad = 8 * dpr;
  const v = viewFor(net, width, height, pad);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(background(net, width, height, pad), 0, 0);
  if (opts.route && opts.route.length > 1) {
    ctx.strokeStyle = 'rgba(56,200,255,0.85)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    opts.route.forEach((p, i) => (i ? ctx.lineTo(v.px(p.x), v.pz(p.z)) : ctx.moveTo(v.px(p.x), v.pz(p.z))));
    ctx.stroke();
  }
  for (const m of opts.marks ?? []) {
    ctx.fillStyle = m.next ? '#ffb020' : 'rgba(56,200,255,0.9)';
    ctx.fillRect(v.px(m.x) - 2 * dpr, v.pz(m.z) - 2 * dpr, 4 * dpr, 4 * dpr);
  }
  if (opts.target) {
    ctx.strokeStyle = '#38c8ff';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(v.px(opts.target.x), v.pz(opts.target.z), 5 * dpr, 0, Math.PI * 2);
    ctx.stroke();
  }
  const r = Math.max(3, 4 * dpr);
  const font = Math.round(10 * dpr);
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  for (const d of [...dots].sort((a, b) => Number(!!a.me) - Number(!!b.me))) {
    const x = v.px(d.x);
    const y = v.pz(d.z);
    ctx.globalAlpha = d.ghost ? 0.4 : 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(d.heading);
    ctx.fillStyle = d.me ? '#ffffff' : d.color ?? '#e8112d';
    ctx.beginPath();
    ctx.moveTo(0, -r * (d.me ? 2 : 1.6));
    ctx.lineTo(r, r);
    ctx.lineTo(-r, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (opts.labels && d.label) {
      ctx.fillStyle = 'rgba(238,241,247,0.9)';
      ctx.fillText(d.label, x + r + 3, y + font / 3);
    }
    ctx.globalAlpha = 1;
  }
}
