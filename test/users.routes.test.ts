import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

describe('POST /api/users/validate-code', () => {
  it('returns 400 when loginCode is missing from the body', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/validate-code').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Código de login é obrigatório!' });
  });

  it('returns 404 when loginCode does not match any user', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/validate-code').send({ loginCode: '000000' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Código de login inválido ou não encontrado!' });
  });

  it('returns 200 with the public user when loginCode matches an existing account', async () => {
    const { app, userService } = await buildTestApp();
    const created = await userService.joinOrCreate({
      nickname: 'RouteTest',
      avatar: 0,
      socketId: 'socket-1',
    });

    const response = await request(app)
      .post('/api/users/validate-code')
      .send({ loginCode: created.loginCode });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Código validado com sucesso!',
      user: {
        id: created.id,
        nickname: 'RouteTest',
        avatar: 0,
        loginCode: created.loginCode,
        chatCode: created.chatCode,
        status: 'online',
        theme: { baseTheme: 'dark', colorTheme: 'standard' },
      },
    });
  });
});
