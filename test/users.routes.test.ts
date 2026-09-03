import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

const PASSWORD = 'correct-horse-battery-staple';

describe('POST /api/users/login', () => {
  it('returns 400 when nickname or password is missing from the body', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Nickname e senha são obrigatórios!' });
  });

  it('returns 401 when the nickname does not exist', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').send({ nickname: 'Ghost', password: PASSWORD });

    expect(response.status).toBe(401);
  });

  it('returns 200 with the public user and a session token on success', async () => {
    const { app, userService } = await buildTestApp();
    const { user } = await userService.registerAccount({
      nickname: 'RouteTest',
      avatar: 0,
      password: PASSWORD,
      socketId: 'socket-1',
    });

    const response = await request(app).post('/api/users/login').send({ nickname: 'RouteTest', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: 'Login realizado com sucesso!',
      user: {
        id: user.id,
        nickname: 'RouteTest',
        avatar: 0,
        status: 'online',
        theme: { baseTheme: 'dark', colorTheme: 'standard' },
      },
    });
    expect((response.body as { sessionToken: string }).sessionToken).toBeTruthy();
  });

  it('returns 429 after too many failed attempts for the same nickname', async () => {
    const { app, userService } = await buildTestApp();
    await userService.registerAccount({ nickname: 'RateLimited', avatar: 0, password: PASSWORD, socketId: 'socket-1' });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/users/login').send({ nickname: 'RateLimited', password: 'wrong-password' });
    }

    const response = await request(app).post('/api/users/login').send({ nickname: 'RateLimited', password: PASSWORD });

    expect(response.status).toBe(429);
  });
});

describe('POST /api/users/login-with-keyfile', () => {
  it('returns 400 when no file is attached', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login-with-keyfile');

    expect(response.status).toBe(400);
  });

  it('returns 401 for a corrupted file', async () => {
    const { app } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', Buffer.from('not a real keyfile'), { filename: 'sparkchat-ghost.sparkkey' });

    expect(response.status).toBe(401);
  });

  it('returns 200 with the public user and a session token for a valid keyfile', async () => {
    const { app, userService } = await buildTestApp();
    const { user, recoveryFile } = await userService.registerAccount({
      nickname: 'KeyfileUser',
      avatar: 0,
      password: PASSWORD,
      socketId: 'socket-1',
    });

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', recoveryFile, { filename: 'sparkchat-keyfileuser.sparkkey' });

    expect(response.status).toBe(200);
    expect((response.body as { user: { id: string } }).user.id).toBe(user.id);
  });

  it('returns 429 after too many failed attempts from the same ip', async () => {
    const { app } = await buildTestApp();

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/users/login-with-keyfile')
        .attach('keyfile', Buffer.from('not a real keyfile'), { filename: 'sparkchat-ghost.sparkkey' });
    }

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', Buffer.from('not a real keyfile'), { filename: 'sparkchat-ghost.sparkkey' });

    expect(response.status).toBe(429);
  });
});

describe('GET /api/users/nickname-availability', () => {
  it('returns 400 when nickname is missing', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/users/nickname-availability');

    expect(response.status).toBe(400);
  });

  it('returns invalid for a nickname with special characters', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/users/nickname-availability').query({ nickname: 'a!b' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'invalid' });
  });

  it('returns available for a free nickname', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/users/nickname-availability').query({ nickname: 'FreeNick' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'available' });
  });

  it('returns taken for a nickname already in use, regardless of case', async () => {
    const { app, userService } = await buildTestApp();
    await userService.registerAccount({ nickname: 'TakenNick', avatar: 0, password: PASSWORD, socketId: 'socket-1' });

    const response = await request(app).get('/api/users/nickname-availability').query({ nickname: 'takennick' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'taken' });
  });
});
