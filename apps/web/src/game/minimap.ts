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

/**
 * Top-down map of the ONE world (used by the racer minimap and the host/projector map). North up.
 * Only real server positions are drawn — never fabricated ones (SPEC Part 17).
 */
export function drawMap(ctx: CanvasRenderingContext2D, net: RoadNetwork, dots: MapDot[], opts: { labels?: boolean; dpr?: number } = {}) {
  const { width, height } = ctx.canvas;
  const b = net.bounds;
  const pad = 8 * (opts.dpr ?? 1);
  const sx = (width - pad * 2) / (b.maxX - b.minX);
  const sz = (height - pad * 2) / (b.maxZ - b.minZ);
  const s = Math.min(sx, sz);
  const ox = (width - (b.maxX - b.minX) * s) / 2;
  const oz = (height - (b.maxZ - b.minZ) * s) / 2;
  const px = (x: number) => ox + (x - b.minX) * s;
  const pz = (z: number) => height - (oz + (z - b.minZ) * s);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(11,13,18,0.82)';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#4a5368';
  ctx.lineWidth = Math.max(2, net.halfWidth * 2 * s);
  ctx.lineCap = 'round';
  for (const e of net.edges) {
    const a = net.nodes[e.a]!;
    const c = net.nodes[e.b]!;
    ctx.beginPath();
    ctx.moveTo(px(a.x), pz(a.z));
    ctx.lineTo(px(c.x), pz(c.z));
    ctx.stroke();
  }
  const r = Math.max(3, 4 * (opts.dpr ?? 1));
  const font = Math.round(10 * (opts.dpr ?? 1));
  ctx.font = `600 ${font}px system-ui, sans-serif`;
  for (const d of [...dots].sort((a, b) => Number(!!a.me) - Number(!!b.me))) {
    const x = px(d.x);
    const y = pz(d.z);
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
