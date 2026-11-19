import { describe, expect, it } from 'vitest';
import { AppError, errorPayload } from '@/lib/app-error.js';
import { ERROR_CATALOG, ERROR_CODES, type ErrorCode } from '@/lib/error-catalog.js';

const SAMPLE_PARAMS: Partial<Record<ErrorCode, object>> = {
  'user.nicknameInvalid': { minLength: 2, maxLength: 20, minLetters: 2 },
  'user.passwordTooShort': { minLength: 12 },
  'user.passwordTooLong': { maxLength: 1024 },
  'upload.missingFile': { kind: 'audio' },
  'upload.tooLarge': { kind: 'audio', maxSize: '8MB' },
  'upload.invalidType': { kind: 'file' },
  'internal.routeNotFound': { method: 'GET', path: '/api/x' },
  'e2e.lookupTooLarge': { maxItems: 200 },
};

const CODE_PATTERN = /^(auth|user|room|message|e2e|upload|linkPreview|rateLimit|validation|internal)\.[a-z][A-Za-z]+$/;

describe('error catalog', () => {
  it('lists every catalog entry in ERROR_CODES', () => {
    expect(ERROR_CODES).toEqual(Object.keys(ERROR_CATALOG));
  });

  it.each(ERROR_CODES)('names %s by domain', (code) => {
    expect(code).toMatch(CODE_PATTERN);
  });

  it.each(ERROR_CODES)('has a non-empty fallback text for %s', (code) => {
    const render = ERROR_CATALOG[code] as (params?: object) => string;
    if (render.length > 0) {
      expect(SAMPLE_PARAMS[code]).toBeDefined();
    }

    expect(render(SAMPLE_PARAMS[code]).trim()).not.toBe('');
  });

  it('only declares sample params for codes that take params', () => {
    for (const code of Object.keys(SAMPLE_PARAMS) as ErrorCode[]) {
      expect(ERROR_CATALOG[code].length).toBe(1);
    }
  });
});

describe('errorPayload', () => {
  it('omits params when the text has no values', () => {
    expect(errorPayload('user.nicknameTaken')).toEqual({ message: 'Esse nickname já está em uso.', code: 'user.nicknameTaken' });
  });

  it('renders the portuguese fallback and keeps the params', () => {
    expect(errorPayload('upload.tooLarge', { kind: 'audio', maxSize: '8MB' })).toEqual({
      message: 'O áudio excede o tamanho máximo permitido de 8MB.',
      code: 'upload.tooLarge',
      params: { kind: 'audio', maxSize: '8MB' },
    });
  });
});

describe('AppError', () => {
  it('carries the code, the params and the fallback text as its message', () => {
    const error = AppError.of('user.passwordTooShort', { minLength: 12 });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('A senha deve ter pelo menos 12 caracteres.');
    expect(error.toPayload()).toEqual({
      message: 'A senha deve ter pelo menos 12 caracteres.',
      code: 'user.passwordTooShort',
      params: { minLength: 12 },
    });
  });
});
