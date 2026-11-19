import type { HostOverview, Role, Roster, SessionResponse, SquadPreview, ClockState } from '@redline/shared';

const BASE = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, data.error ?? 'HTTP_ERROR', data.message ?? res.statusText);
  return data as T;
}

export const api = {
  event: () => req<{ eventName: string; clock: ClockState; registrationOpen: boolean }>('GET', '/api/event'),
  createSquad: (squadName: string, displayName: string) => req<SessionResponse>('POST', '/api/squads', { squadName, displayName }),
  preview: (code: string) => req<SquadPreview>('GET', `/api/squads/${encodeURIComponent(code)}`),
  join: (code: string, displayName: string, role: Role) => req<SessionResponse>('POST', '/api/squads/join', { code, displayName, role }),
  rejoin: (rejoinToken: string) => req<SessionResponse>('POST', '/api/session/rejoin', { rejoinToken }),
  me: (token: string) =>
    req<{ playerId: string; role: Role; slot: number; roster: Roster; clock: ClockState }>('GET', '/api/me', undefined, {
      authorization: `Bearer ${token}`,
    }),
  assignRoles: (token: string, assignments: { playerId: string; role: Role }[]) =>
    req<{ roster: Roster }>('POST', '/api/team/roles', { assignments }, { authorization: `Bearer ${token}` }),
  host: {
    overview: (key: string) => req<HostOverview>('GET', '/api/host/overview', undefined, { 'x-host-key': key }),
    start: (key: string, force = false) => req<{ clock: ClockState }>('POST', '/api/host/start', { force }, { 'x-host-key': key }),
    pause: (key: string) => req<{ clock: ClockState }>('POST', '/api/host/pause', {}, { 'x-host-key': key }),
    resume: (key: string) => req<{ clock: ClockState }>('POST', '/api/host/resume', {}, { 'x-host-key': key }),
  },
};

export function wsUrl(): string {
  const explicit = import.meta.env.VITE_WS_URL as string | undefined;
  if (explicit) return `${explicit.replace(/\/$/, '')}/ws`;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
