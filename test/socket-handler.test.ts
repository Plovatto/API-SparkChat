import { describe, expect, it, vi } from 'vitest';
import type { AppSocket } from '@/sockets/events.js';
import { AppError } from '@/lib/app-error.js';
import { runAuthedSocketHandler, runSocketHandler } from '@/sockets/socket-handler.js';

function fakeSocket(userId?: string) {
  const emit = vi.fn();
  return { socket: { id: 'socket-1', connected: true, emit, data: { userId } } as unknown as AppSocket, emit };
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

describe('runAuthedSocketHandler', () => {
  it('refuses an unauthenticated socket without running the work', async () => {
    const { socket, emit } = fakeSocket();
    const work = vi.fn();

    runAuthedSocketHandler(socket, 'push:subscribe', work);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(work).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'auth.unauthenticated' }));
  });

  it('passes the session user id to the work', async () => {
    const { socket, emit } = fakeSocket('user-1');
    const work = vi.fn(() => Promise.resolve());

    runAuthedSocketHandler(socket, 'push:subscribe', work);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(work).toHaveBeenCalledWith('user-1');
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports a failure as the error payload tagged with the event', async () => {
    const { socket, emit } = fakeSocket('user-1');

    runAuthedSocketHandler(socket, 'kt:get-head', () => Promise.reject(AppError.of('room.notFound')));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({ code: 'room.notFound', event: 'kt:get-head' }));
  });
});
