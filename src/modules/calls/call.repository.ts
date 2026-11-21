import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { callUsage, calls } from '../../database/schema.js';
import type { Database } from '../../database/turso-client.js';
import { BITRATE_CEILING_BYTES_PER_SECOND, relaySecondsOf } from './call-budget.js';
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

function relaySecondsSql(prefix: 'caller' | 'callee'): string {
  return `(${prefix}_relay_ms + CASE WHEN ${prefix}_relay_since IS NOT NULL THEN MAX(0, ROUND((julianday(ended_at) - julianday(${prefix}_relay_since)) * 86400000)) ELSE 0 END) / 1000.0`;
}

const ENDED_RELAY_SECONDS = sql.raw(`(${relaySecondsSql('caller')}) + (${relaySecondsSql('callee')})`);

export interface EndOptions {
  markRevoked?: boolean;
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

  async closeRelayWindow(id: string, role: CallRole, nowIso: string, expected: string, remaining: string | null): Promise<boolean> {
    const since = role === 'caller' ? calls.callerRelaySince : calls.calleeRelaySince;
    const username = role === 'caller' ? calls.turnUsername : calls.calleeTurnUsername;
    const ms = role === 'caller' ? calls.callerRelayMs : calls.calleeRelayMs;
    const closed = sql`${ms} + MAX(0, CAST(ROUND((julianday(${nowIso}) - julianday(${since})) * 86400000) AS INTEGER))`;
    const values =
      remaining === null
        ? role === 'caller'
          ? { turnUsername: null, callerRelayMs: closed, callerRelaySince: null }
          : { calleeTurnUsername: null, calleeRelayMs: closed, calleeRelaySince: null }
        : role === 'caller'
          ? { turnUsername: remaining }
          : { calleeTurnUsername: remaining };
    const rows = await this.db
      .update(calls)
      .set(values)
      .where(and(eq(calls.id, id), inArray(calls.state, ['accepted', 'active']), isNotNull(since), eq(username, expected)))
      .returning({ id: calls.id });
    return rows.length > 0;
  }

  async end(id: string, fromState: CallState, reason: CallEndReason, endedAtIso: string, options: EndOptions = {}): Promise<CallRecord | null> {
    const endStatement = this.db
      .update(calls)
      .set({ state: 'ended', endReason: reason, endedAt: endedAtIso })
      .where(and(eq(calls.id, id), eq(calls.state, fromState)))
      .returning();
    const usageStatement = this.db.run(sql`
      INSERT INTO call_usage (month, estimated_bytes)
      SELECT substr(ended_at, 1, 7),
        CAST((${ENDED_RELAY_SECONDS}) * ${BITRATE_CEILING_BYTES_PER_SECOND} AS INTEGER)
      FROM calls
      WHERE id = ${id} AND changes() > 0 AND (caller_relay_ms > 0 OR callee_relay_ms > 0 OR caller_relay_since IS NOT NULL OR callee_relay_since IS NOT NULL) AND answered_at IS NOT NULL AND ended_at IS NOT NULL
      ON CONFLICT(month) DO UPDATE SET estimated_bytes = estimated_bytes + excluded.estimated_bytes
    `);
    const markerStatement = options.markRevoked
      ? this.db
          .update(calls)
          .set({ turnRevokedAt: endedAtIso })
          .where(and(eq(calls.id, id), eq(calls.state, 'ended'), or(isNotNull(calls.turnUsername), isNotNull(calls.calleeTurnUsername))))
      : this.db.run(sql`SELECT 1`);
    const [rows] = await this.db.batch([endStatement, usageStatement, markerStatement]);
    const [row] = rows;
    return row ? toRecord(row) : null;
  }

  async recordTurnIssued(id: string, role: CallRole, stored: string, nowIso: string): Promise<boolean> {
    const rows = await this.db
      .update(calls)
      .set(
        role === 'caller'
          ? { turnUsername: stored, relayUsed: sql`1 + (${calls.calleeTurnUsername} IS NOT NULL)`, callerRelaySince: sql`COALESCE(${calls.callerRelaySince}, ${nowIso})` }
          : { calleeTurnUsername: stored, relayUsed: sql`(${calls.turnUsername} IS NOT NULL) + 1`, calleeRelaySince: sql`COALESCE(${calls.calleeRelaySince}, ${nowIso})` },
      )
      .where(and(eq(calls.id, id), inArray(calls.state, ['accepted', 'active'])))
      .returning({ id: calls.id });
    return rows.length > 0;
  }

  async relaySecondsForUser(userId: string, monthStartIso: string, nowIso: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(calls)
      .where(
        and(
          sql`${calls.answeredAt} >= ${monthStartIso}`,
          or(eq(calls.callerId, userId), eq(calls.calleeId, userId)),
        ),
      );
    const nowMs = Date.parse(nowIso);
    return rows.reduce((total, row) => {
      const record = toRecord(row);
      return total + (record.callerId === userId ? relaySecondsOf(record, 'caller', nowMs) : 0) + (record.calleeId === userId ? relaySecondsOf(record, 'callee', nowMs) : 0);
    }, 0);
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
