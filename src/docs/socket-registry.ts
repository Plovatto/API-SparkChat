import type { ZodType } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type SocketEventDirection = 'client-to-server' | 'server-to-client';

export interface SocketEventDescriptor {
  event: string;
  direction: SocketEventDirection;
  module: string;
  payloadSchema?: object;
}

const events: SocketEventDescriptor[] = [];

export function registerClientEvents(module: string, definitions: Record<string, ZodType<unknown> | null>): void {
  for (const [event, schema] of Object.entries(definitions)) {
    events.push({
      event,
      direction: 'client-to-server',
      module,
      ...(schema ? { payloadSchema: zodToJsonSchema(schema) } : {}),
    });
  }
}

export function registerServerEvents(module: string, eventNames: string[]): void {
  for (const event of eventNames) {
    events.push({ event, direction: 'server-to-client', module });
  }
}

export function listSocketEvents(): SocketEventDescriptor[] {
  return events;
}
