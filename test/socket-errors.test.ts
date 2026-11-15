import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '@/lib/app-error.js';
import { extractErrorPayload } from '@/sockets/socket-errors.js';

describe('extractErrorPayload', () => {
  it('returns the code and params of an AppError', () => {
    expect(extractErrorPayload(AppError.of('room.notFound'))).toEqual({ message: 'Sala não encontrada.', code: 'room.notFound' });
  });

  it('maps a payload validation failure to validation.invalidPayload keeping the original message', () => {
    const result = z.object({ roomId: z.string() }).safeParse({});
    if (result.success) {
      throw new Error('expected the payload to be invalid');
    }

    expect(extractErrorPayload(result.error)).toEqual({ message: result.error.message, code: 'validation.invalidPayload' });
  });

  it('maps an error without a code to internal.unexpected keeping its message', () => {
    expect(extractErrorPayload(new Error('database is locked'))).toEqual({
      message: 'database is locked',
      code: 'internal.unexpected',
    });
  });

  it('maps a thrown value that is not an Error to internal.unexpected', () => {
    expect(extractErrorPayload('boom')).toEqual({ message: 'Erro inesperado.', code: 'internal.unexpected' });
  });
});
