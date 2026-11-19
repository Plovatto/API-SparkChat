import { Writable } from 'node:stream';
import express from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { scrubRequestLog } from '@/config/request-log.js';

describe('scrubRequestLog', () => {
  it('drops the query string of link preview requests', () => {
    const scrubbed = scrubRequestLog({
      method: 'GET',
      url: '/api/link-preview/image?url=https%3A%2F%2Fsecret.example%2Ft%3Dtoken',
      query: { url: 'x' },
    });

    expect(scrubbed).toEqual({ method: 'GET', url: '/api/link-preview/image' });
  });

  it('leaves other routes untouched', () => {
    const request = { method: 'GET', url: '/api/rooms?limit=5', query: { limit: '5' } };

    expect(scrubRequestLog(request)).toBe(request);
  });

  it('does not match routes that merely share the prefix', () => {
    const request = { url: '/api/link-previewer?x=1' };

    expect(scrubRequestLog(request)).toBe(request);
  });
});

describe('request logging of gif routes', () => {
  it('drops the query string of gif requests', () => {
    expect(scrubRequestLog({ method: 'POST', url: '/api/gifs/search?q=segredo', query: { q: 'segredo' } })).toEqual({
      method: 'POST',
      url: '/api/gifs/search',
    });
  });

  it('never writes the request body to the log', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf8'));
        callback();
      },
    });
    const app = express();
    app.use(express.json());
    app.use(pinoHttp({ logger: pino(stream), serializers: { req: scrubRequestLog } }));
    app.post('/api/gifs/search', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    await request(app).post('/api/gifs/search?q=termo-secreto').send({ q: 'termo-secreto', url: 'https://static.klipy.com/ii/secretsecret/1/2/abcd.webp' });

    const output = lines.join('');
    expect(output).toContain('/api/gifs/search');
    expect(output).not.toContain('termo-secreto');
    expect(output).not.toContain('secretsecret');
  });
});
