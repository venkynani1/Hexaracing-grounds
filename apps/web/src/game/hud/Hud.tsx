/**
 * Premium racing HUD — compact, out of the driving view's centre. Shared by the live RacerView and the
 * offline Test Drive. Pure presentation: values come from the caller.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Control, InputState } from '../input';

export function RaceClock({ phase, time, accent }: { phase: string; time: string; accent?: 'red' | 'amber' }) {
  return (
    <div className={`rh-clock ${accent ?? 'red'}`} data-testid="hud-clock">
      <span className="rh-phase">{phase}</span>
      <span className="rh-time">{time}</span>
    </div>
  );
}

/** Arc speedometer (0–220 km/h), nitro ring, fuel + health mini bars. */
export function Speedo({ speed, nitro, fuel, health, tires, nitroOn }: { speed: number; nitro: number; fuel: number; health: number; tires: number; nitroOn?: boolean }) {
  const max = 220;
  const a0 = 135;
  const sweep = 270;
  const arc = (r: number, frac: number) => {
    const f = Math.max(0.0001, Math.min(1, frac));
    const s = (a0 * Math.PI) / 180;
    const e = ((a0 + sweep * f) * Math.PI) / 180;
    const p = (a: number) => `${60 + r * Math.cos(a)} ${60 + r * Math.sin(a)}`;
    return `M ${p(s)} A ${r} ${r} 0 ${sweep * f > 180 ? 1 : 0} 1 ${p(e)}`;
  };
  return (
    <div className="rh-speedo" data-testid="hud-speed" data-speed={Math.round(speed)}>
      <svg viewBox="0 0 120 120" aria-hidden>
        <path d={arc(50, 1)} className="rh-track" />
        <path d={arc(50, speed / max)} className="rh-speed-arc" />
        <path d={arc(42, 1)} className="rh-track thin" />
        <path d={arc(42, nitro / 100)} className={`rh-nitro-arc ${nitroOn ? 'on' : ''}`} />
      </svg>
      <div className="rh-speed-num">
        <b>{Math.round(speed)}</b>
        <small>km/h</small>
      </div>
      <div className="rh-bars">
        <Bar label="FUEL" v={fuel} warn={20} testid="hud-fuel" />
        <Bar label="HP" v={health} warn={30} />
        <Bar label="TYR" v={tires} warn={30} />
      </div>
    </div>
  );
}

function Bar({ label, v, warn, testid }: { label: string; v: number; warn: number; testid?: string }) {
  return (
    <div className={`rh-bar ${v <= warn ? 'warn' : ''}`} data-testid={testid} data-value={Math.round(v)}>
      <span>{label}</span>
      <i>
        <em style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
      </i>
    </div>
  );
}

/** Major announcement: animates in large for ~3 s, then minimises to a small chip until it expires. */
export function Announce({ id, text, expired }: { id: string; text: string; expired: boolean }) {
  const [big, setBig] = useState(true);
  useEffect(() => {
    setBig(true);
    const t = setTimeout(() => setBig(false), 3200);
    return () => clearTimeout(t);
  }, [id]);
  if (expired) return null;
  return (
    <div className={`rh-announce ${big ? 'big' : 'mini'}`} data-testid="announcement">
      {text}
    </div>
  );
}

export function Toasts({ children }: { children: ReactNode }) {
  return <div className="rh-toasts">{children}</div>;
}

export function Toast({ tone, children, testid }: { tone?: 'info' | 'warn' | 'good' | 'gold'; children: ReactNode; testid?: string }) {
  return (
    <div className={`rh-toast ${tone ?? 'info'}`} data-testid={testid}>
      {children}
    </div>
  );
}

export function Arrow({ angle }: { angle: number }) {
  return (
    <span className="rh-arrow" style={{ transform: `rotate(${angle}rad)` }}>
      ▲
    </span>
  );
}

/** Ergonomic touch controls: steer pads bottom-left, pedals bottom-right, NOS + DRIFT within thumb reach. */
export function Pedals({ input }: { input: InputState }) {
  const hold = (c: Control) => ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      input.set(c, true);
      (e.currentTarget as HTMLElement).classList.add('down');
    },
    onPointerUp: (e: React.PointerEvent) => (input.set(c, false), (e.currentTarget as HTMLElement).classList.remove('down')),
    onPointerCancel: (e: React.PointerEvent) => (input.set(c, false), (e.currentTarget as HTMLElement).classList.remove('down')),
    onPointerLeave: (e: React.PointerEvent) => (input.set(c, false), (e.currentTarget as HTMLElement).classList.remove('down')),
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  return (
    <>
      <div className="rh-steer">
        <button className="rh-pad" {...hold('left')} data-testid="btn-left" aria-label="Steer left">
          <svg viewBox="0 0 24 24"><path d="M15 5 8 12l7 7" /></svg>
        </button>
        <button className="rh-pad" {...hold('right')} data-testid="btn-right" aria-label="Steer right">
          <svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      </div>
      <div className="rh-pedals">
        <div className="rh-aux">
          <button className="rh-pad sm nos" {...hold('nitro')} aria-label="Nitro">NOS</button>
          <button className="rh-pad sm" {...hold('handbrake')} aria-label="Handbrake">DRIFT</button>
        </div>
        <button className="rh-pad brake" {...hold('brake')} data-testid="btn-brake" aria-label="Brake">
          <span>BRAKE</span>
        </button>
        <button className="rh-pad gas" {...hold('throttle')} data-testid="btn-throttle" aria-label="Throttle">
          <span>GAS</span>
        </button>
      </div>
    </>
  );
}

/** Round route minimap frame (the canvas is drawn by the caller). */
export function MiniMap({ canvasRef, onClick }: { canvasRef: React.RefObject<HTMLCanvasElement | null>; onClick?: () => void }) {
  return (
    <div className="rh-map" onClick={onClick}>
      <canvas ref={canvasRef} width={240} height={240} data-testid="minimap" aria-label="Map of all squads" />
    </div>
  );
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
