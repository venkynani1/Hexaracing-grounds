import { auditLogs, type Executor } from '@redline/db';

export type ActorType = 'system' | 'host' | 'player' | 'director';

export async function audit(
  db: Executor,
  eventId: string,
  actorType: ActorType,
  actorId: string | null,
  action: string,
  payload?: unknown,
  ipHash?: string | null,
): Promise<void> {
  await db.insert(auditLogs).values({ eventId, actorType, actorId, action, payload: payload ?? null, ipHash: ipHash ?? null });
}
