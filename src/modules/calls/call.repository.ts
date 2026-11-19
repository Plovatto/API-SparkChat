import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { callUsage, calls } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import type { CallEndReason, CallKind, CallRecord, CallRole, CallState } from './call.types.js';

type CallRow = typeof calls.$inferSelect;

function toRecord(row: CallRow): CallRecord {
  return {
    ...row,
    kind: row.kind as CallKind,
    state: row.state as CallState,
    endReason: row.endReason as CallEndReason | null,
  };
}

export interface NewCall {
  id: string;
  roomId: string;
  callerId: string;
  calleeId: string;
  kind: CallKind;
  createdAt: string;
}

export class CallRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<CallRecord | null> {
    const [row] = await this.db.select().from(calls).where(eq(calls.id, id));
    return row ? toRecord(row) : null;
  }

  async findOpenForUser(userId: string): Promise<CallRecord | null> {
    const [row] = await this.db
      .select()
      .from(calls)
      .where(and(ne(calls.state, 'ended'), or(eq(calls.callerId, userId), eq(calls.calleeId, userId))))
      .orderBy(calls.createdAt)
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async findOpen(): Promise<CallRecord[]> {
    const rows = await this.db.select().from(calls).where(ne(calls.state, 'ended'));
    return rows.map(toRecord);
  }

  async insertIfBothFree(call: NewCall): Promise<boolean> {
    const result = await this.db.run(sql`
      INSERT INTO calls (id, room_id, caller_id, callee_id, kind, state, created_at, relay_used)
      SELECT ${call.id}, ${call.roomId}, ${call.callerId}, ${call.calleeId}, ${call.kind}, 'ringing', ${call.createdAt}, 0
      WHERE NOT EXISTS (
        SELECT 1 FROM calls
        WHERE state != 'ended'
          AND (caller_id IN (${call.callerId}, ${call.calleeId}) OR callee_id IN (${call.callerId}, ${call.calleeId}))
      )
    `);
    return result.rowsAffected > 0;
  }

  async insertEnded(call: NewCall, reason: CallEndReason): Promise<void> {
    await this.db.insert(calls).values({
      ...call,
      state: 'ended',
      endedAt: call.createdAt,
      endReason: reason,
      relayUsed: 0,
    });
  }

  async accept(id: string, calleeId: string, deviceId: string, nowIso: string, ringCutoffIso: string): Promise<CallRecord | null> {
    const [row] = await this.db
      .update(calls)
      .set({ state: 'accepted', answeredAt: nowIso, lastHeartbeatAt: nowIso, acceptedDeviceId: deviceId })
      .where(and(eq(calls.id, id), eq(calls.calleeId, calleeId), eq(calls.state, 'ringing'), sql`${calls.createdAt} > ${ringCutoffIso}`))
      .returning();
    return row ? toRecord(row) : null;
  }

  async markActive(id: string): Promise<boolean> {
    const rows = await this.db
      .update(calls)
      .set({ state: 'active' })
      .where(and(eq(calls.id, id), eq(calls.state, 'accepted')))
      .returning({ id: calls.id });
    return rows.length > 0;
  }

  async rebindAcceptedDevice(id: string, deviceId: string): Promise<void> {
    await this.db
      .update(calls)
      .set({ acceptedDeviceId: deviceId })
      .where(and(eq(calls.id, id), inArray(calls.state, ['accepted', 'active'])));
  }

  async touchHeartbeat(id: string, nowIso: string): Promise<void> {
    await this.db
      .update(calls)
      .set({ lastHeartbeatAt: nowIso })
      .where(and(eq(calls.id, id), inArray(calls.state, ['accepted', 'active'])));
  }

  async end(id: string, fromState: CallState, reason: CallEndReason, endedAtIso: string): Promise<CallRecord | null> {
    const [row] = await this.db
      .update(calls)
      .set({ state: 'ended', endReason: reason, endedAt: endedAtIso })
      .where(and(eq(calls.id, id), eq(calls.state, fromState)))
      .returning();
    return row ? toRecord(row) : null;
  }

  async recordTurnIssued(id: string, role: CallRole, username: string): Promise<boolean> {
    const rows = await this.db
      .update(calls)
      .set({
        ...(role === 'caller' ? { turnUsername: username } : { calleeTurnUsername: username }),
        relayUsed: sql`${calls.relayUsed} + 1`,
      })
      .where(and(eq(calls.id, id), inArray(calls.state, ['accepted', 'active'])))
      .returning({ id: calls.id });
    return rows.length > 0;
  }

  async findEndedWithUnrevokedCredentials(limit: number): Promise<CallRecord[]> {
    const rows = await this.db
      .select()
      .from(calls)
      .where(
        and(eq(calls.state, 'ended'), isNull(calls.turnRevokedAt), or(isNotNull(calls.turnUsername), isNotNull(calls.calleeTurnUsername))),
      )
      .limit(limit);
    return rows.map(toRecord);
  }

  async markRevoked(id: string, nowIso: string): Promise<void> {
    await this.db.update(calls).set({ turnRevokedAt: nowIso }).where(eq(calls.id, id));
  }

  async addUsage(month: string, bytes: number): Promise<void> {
    await this.db
      .insert(callUsage)
      .values({ month, estimatedBytes: bytes })
      .onConflictDoUpdate({ target: callUsage.month, set: { estimatedBytes: sql`${callUsage.estimatedBytes} + ${bytes}` } });
  }

  async getUsage(month: string): Promise<number> {
    const [row] = await this.db.select().from(callUsage).where(eq(callUsage.month, month));
    return row?.estimatedBytes ?? 0;
  }
}
