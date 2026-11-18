import { describe, expect, it, vi } from 'vitest';
import type { AppSocket } from '@/sockets/events.js';
import { runSocketHandler } from '@/sockets/socket-handler.js';

function fakeSocket() {
  const emit = vi.fn();
  return { socket: { id: 'socket-1', connected: true, emit } as unknown as AppSocket, emit };
}

describe('runSocketHandler', () => {
  it('turns a rejected handler into a generic error without leaking the message', async () => {
    const { socket, emit } = fakeSocket();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    runSocketHandler(socket, 'rooms:get', () => Promise.reject(new Error('SQLITE_BUSY: database is locked')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('error', { message: 'Erro inesperado.', code: 'internal.unexpected', event: 'rooms:get' });
  });

  it('catches handlers that throw synchronously', () => {
    const { socket, emit } = fakeSocket();

    expect(() =>
      runSocketHandler(socket, 'typing:start', () => {
        throw new Error('boom');
      }),
    ).not.toThrow();
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'internal.unexpected' }));
  });
});
