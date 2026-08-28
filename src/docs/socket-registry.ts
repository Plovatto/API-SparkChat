export type SocketEventDirection = 'client-to-server' | 'server-to-client';

export interface SocketEventDescriptor {
  event: string;
  direction: SocketEventDirection;
  module: string;
  payloadSchema?: object;
}

const events: SocketEventDescriptor[] = [];

export function registerSocketEvent(descriptor: SocketEventDescriptor): void {
  events.push(descriptor);
}

export function listSocketEvents(): SocketEventDescriptor[] {
  return events;
}
