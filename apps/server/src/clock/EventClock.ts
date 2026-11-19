import { BALANCE, EVENT_DURATION_MS, phaseAt, type ClockState, type EventStatus } from '@redline/shared';

export interface ClockPersisted {
  /** Wall time START was pressed; null before START. */
  startedAt: number | null;
  /** Accumulated paused ms (excluding an in-progress pause). */
  pausedMs: number;
  /** Wall time a pause began; null when running. */
  pausedAt: number | null;
  /** Registration status before START. */
  preStartStatus: 'REGISTRATION_OPEN' | 'REGISTRATION_LOCKED' | 'DRAFT';
}

/**
 * The single server-authoritative event clock.
 * running = now − startedAt − pausedMs (− in-progress pause). Countdown occupies the first
 * BALANCE.countdownMs of running time; LIVE elapsed = running − countdown. Pause freezes it exactly.
 */
export class EventClock {
  constructor(
    private state: ClockPersisted = { startedAt: null, pausedMs: 0, pausedAt: null, preStartStatus: 'REGISTRATION_OPEN' },
    private readonly countdownMs: number = BALANCE.countdownMs,
  ) {}

  get persisted(): Readonly<ClockPersisted> {
    return this.state;
  }

  get started() {
    return this.state.startedAt !== null;
  }

  get paused() {
    return this.state.pausedAt !== null;
  }

  runningMs(now: number): number {
    if (this.state.startedAt === null) return 0;
    const end = this.state.pausedAt ?? now;
    return Math.max(0, end - this.state.startedAt - this.state.pausedMs);
  }

  elapsedMs(now: number): number {
    return Math.min(EVENT_DURATION_MS, Math.max(0, this.runningMs(now) - this.countdownMs));
  }

  /** Status ignoring pause. */
  private baseStatus(now: number): EventStatus {
    if (this.state.startedAt === null) return this.state.preStartStatus;
    const running = this.runningMs(now);
    if (running < this.countdownMs) return 'COUNTDOWN';
    if (running - this.countdownMs < EVENT_DURATION_MS) return 'LIVE';
    return 'FINISHED';
  }

  status(now: number): EventStatus {
    const base = this.baseStatus(now);
    return this.paused && base !== 'FINISHED' ? 'PAUSED' : base;
  }

  /** Status the event will return to on resume (COUNTDOWN or LIVE). */
  resumeTarget(now: number): EventStatus {
    return this.baseStatus(now);
  }

  lockRegistration() {
    if (this.started) throw new Error('already started');
    this.state = { ...this.state, preStartStatus: 'REGISTRATION_LOCKED' };
  }

  start(now: number) {
    if (this.started) throw new Error('already started');
    this.state = { ...this.state, startedAt: now, preStartStatus: 'REGISTRATION_LOCKED' };
  }

  pause(now: number) {
    const s = this.status(now);
    if (s !== 'COUNTDOWN' && s !== 'LIVE') throw new Error(`cannot pause from ${s}`);
    this.state = { ...this.state, pausedAt: now };
  }

  resume(now: number) {
    if (this.state.pausedAt === null) throw new Error('not paused');
    this.state = { ...this.state, pausedMs: this.state.pausedMs + (now - this.state.pausedAt), pausedAt: null };
  }

  snapshot(now: number): ClockState {
    const status = this.status(now);
    const running = this.runningMs(now);
    const elapsed = this.elapsedMs(now);
    const started = this.started;
    return {
      status,
      serverTime: now,
      countdownRemainingMs: started ? Math.max(0, this.countdownMs - running) : this.countdownMs,
      elapsedMs: elapsed,
      phase: started && running >= this.countdownMs ? phaseAt(elapsed) : null,
      paused: this.paused,
    };
  }
}
