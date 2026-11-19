import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { PHASES, formatClock, type ClockState } from '@redline/shared';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'brand brand-small' : 'brand'}>
      <div className="brand-mark">CODE <span>REDLINE</span></div>
      {!small && <div className="brand-sub">Road to Hexaware · Race. Decode. Survive. Arrive.</div>}
    </div>
  );
}

export function Qr({ value, size = 200, label }: { value: string; size?: number; label?: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: size * 2, color: { dark: '#0b0d12', light: '#ffffff' } }).then(setSrc, () => setSrc(''));
  }, [value, size]);
  return (
    <figure className="qr">
      {src ? <img src={src} width={size} height={size} alt={`QR code for ${value}`} /> : <div style={{ width: size, height: size }} />}
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}

/** Renders the authoritative clock, advancing locally between server updates using the measured offset. */
export function useLiveClock(clock: ClockState | null, offset: number) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  if (!clock) return null;
  const drift = Math.max(0, Date.now() + offset - clock.serverTime);
  if (clock.status === 'COUNTDOWN') return { ...clock, countdownRemainingMs: Math.max(0, clock.countdownRemainingMs - drift) };
  if (clock.status === 'LIVE') return { ...clock, elapsedMs: clock.elapsedMs + drift };
  return clock;
}

export function ClockPanel({ clock }: { clock: ClockState | null }) {
  if (!clock) return null;
  const phase = PHASES.find((p) => p.id === clock.phase);
  let big = '';
  let caption = '';
  switch (clock.status) {
    case 'REGISTRATION_OPEN':
      big = 'LOBBY';
      caption = 'Waiting for the host to press START';
      break;
    case 'REGISTRATION_LOCKED':
      big = 'LOCKED';
      caption = 'Registration locked';
      break;
    case 'COUNTDOWN':
      big = String(Math.ceil(clock.countdownRemainingMs / 1000));
      caption = 'Ignition in';
      break;
    case 'LIVE':
      big = formatClock(clock.elapsedMs);
      caption = phase ? phase.label : '';
      break;
    case 'PAUSED':
      big = clock.elapsedMs > 0 ? formatClock(clock.elapsedMs) : `T-${Math.ceil(clock.countdownRemainingMs / 1000)}`;
      caption = 'Paused by host';
      break;
    case 'FINISHED':
      big = '60:00';
      caption = 'Event complete';
      break;
    default:
      big = clock.status;
  }
  return (
    <div className={`clock clock-${clock.status.toLowerCase()}`} data-testid="clock" data-status={clock.status}>
      <div className="clock-caption">{caption}</div>
      <div className="clock-big">{big}</div>
    </div>
  );
}
