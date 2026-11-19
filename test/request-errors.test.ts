import type { Request, Response } from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '@/middleware/errorHandler.js';
import { buildTestApp } from './support/build-test-app.js';

describe('malformed requests', () => {
  it('answers invalid JSON with 400 instead of 500', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').set('Content-Type', 'application/json').send('{"nickname":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation.invalidPayload' });
  });

  it('answers a multer error that reaches the global handler with 400 instead of 500', () => {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));

    errorHandler(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'unexpected'), {} as Request, { status } as unknown as Response, vi.fn());

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'validation.invalidPayload' }));
  });
});
