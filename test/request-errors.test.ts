import type { Request, Response } from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/config/logger.js';
import { errorHandler } from '@/middleware/errorHandler.js';
import { buildTestApp } from './support/build-test-app.js';

describe('malformed requests', () => {
  it('answers invalid JSON with 400 instead of 500', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').set('Content-Type', 'application/json').send('{"nickname":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation.invalidPayload' });
  });

  it('never logs the raw body of a malformed JSON request', async () => {
    const { app } = await buildTestApp();
    const warn = vi.spyOn(logger, 'warn');

    try {
      const response = await request(app)
        .post('/api/users/login')
        .set('Content-Type', 'application/json')
        .send('{"nickname":"ada","password":"SECRETSECRETSECRET",}');

      expect(response.status).toBe(400);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETSECRETSECRET');
    } finally {
      warn.mockRestore();
    }
  });

  it('answers a multer error that reaches the global handler with 400 instead of 500', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    errorHandler(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'unexpected'), {} as Request, { status } as unknown as Response, vi.fn());

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'validation.invalidPayload' }));
  });
});
