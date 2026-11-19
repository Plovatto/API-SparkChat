import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

const PASSWORD = 'correct-horse-battery-staple';

describe('POST /api/users/login', () => {
  it('returns 400 when nickname or password is missing from the body', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Nickname e senha são obrigatórios!', code: 'auth.missingCredentials' });
  });

  it('returns 401 when the nickname does not exist', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login').send({ nickname: 'Ghost', password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Nickname ou senha inválidos.', code: 'auth.invalidCredentials' });
  });

  it('returns 200 with the public user and a session token on success', async () => {
    const { app, userService } = await buildTestApp();
    const { user } = await userService.registerAccount({
      nickname: 'RouteTest',
      avatar: 0,
      password: PASSWORD,
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
    await userService.registerAccount({ nickname: 'RateLimited', avatar: 0, password: PASSWORD });

    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/users/login').send({ nickname: 'RateLimited', password: 'wrong-password' });
    }

    const response = await request(app).post('/api/users/login').send({ nickname: 'RateLimited', password: PASSWORD });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({ message: 'Muitas tentativas de login. Tente novamente mais tarde.', code: 'rateLimit.loginAttempts' });
  });
});

describe('POST /api/users/login-with-keyfile', () => {
  it('returns 400 when no file is attached', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login-with-keyfile');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Arquivo de recuperação é obrigatório!', code: 'auth.keyfileRequired' });
  });

  it('returns 401 for a corrupted file', async () => {
    const { app } = await buildTestApp();

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', Buffer.from('not a real keyfile'), { filename: 'sparkchat-ghost.sparkkey' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ message: 'Arquivo de recuperação inválido.', code: 'auth.keyfileInvalid' });
  });

  it('returns 200 with the public user and a session token for a valid keyfile', async () => {
    const { app, userService } = await buildTestApp();
    const { user, recoveryFile } = await userService.registerAccount({
      nickname: 'KeyfileUser',
      avatar: 0,
      password: PASSWORD,
    });

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', recoveryFile ?? Buffer.alloc(0), { filename: 'sparkchat-keyfileuser.sparkkey' });

    expect(response.status).toBe(200);
    expect((response.body as { user: { id: string } }).user.id).toBe(user.id);
    expect((response.body as { recoveryToken: string }).recoveryToken).toBeTruthy();
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
    expect(response.body).toEqual({ message: 'Muitas tentativas de login. Tente novamente mais tarde.', code: 'rateLimit.loginAttempts' });
  });
});

describe('login failures', () => {
  it('answers auth.loginFailed when the password login throws unexpectedly', async () => {
    const { app, userService } = await buildTestApp();
    vi.spyOn(userService, 'login').mockRejectedValue(new Error('database is locked'));

    const response = await request(app).post('/api/users/login').send({ nickname: 'Ada', password: PASSWORD });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Erro ao entrar. Tente novamente!', code: 'auth.loginFailed' });
  });

  it('answers auth.loginFailed when the keyfile login throws unexpectedly', async () => {
    const { app, userService } = await buildTestApp();
    vi.spyOn(userService, 'loginWithKeyfile').mockRejectedValue(new Error('database is locked'));

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', Buffer.from('anything'), { filename: 'sparkchat-ada.sparkkey' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Erro ao entrar. Tente novamente!', code: 'auth.loginFailed' });
  });
});

describe('GET /api/users/nickname-availability', () => {
  it('returns 400 when nickname is missing', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/api/users/nickname-availability');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ message: 'Nickname é obrigatório!', code: 'user.nicknameRequired' });
  });

  it('answers user.nicknameCheckFailed when the lookup throws unexpectedly', async () => {
    const { app, userService } = await buildTestApp();
    vi.spyOn(userService, 'getUserByNickname').mockRejectedValue(new Error('database is locked'));

    const response = await request(app).get('/api/users/nickname-availability').query({ nickname: 'FreeNick' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: 'Erro ao verificar nickname. Tente novamente!', code: 'user.nicknameCheckFailed' });
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
    await userService.registerAccount({ nickname: 'TakenNick', avatar: 0, password: PASSWORD });

    const response = await request(app).get('/api/users/nickname-availability').query({ nickname: 'takennick' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'taken' });
  });
});

describe('POST /api/users/login under parallel load', () => {
  it('lets at most five parallel guesses for the same nickname reach the password check', async () => {
    const { app, userService } = await buildTestApp();
    await userService.registerAccount({ nickname: 'Parallel', avatar: 0, password: PASSWORD });
    const loginSpy = vi.spyOn(userService, 'login');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app).post('/api/users/login').send({ nickname: 'Parallel', password: 'wrong-password' })),
    );

    expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(loginSpy).toHaveBeenCalledTimes(5);
  });
});

describe('POST /api/users/logout', () => {
  it('returns 401 without a session token', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/logout');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'auth.required' });
  });

  it('revokes only the current session, notifies the socket layer and answers 204', async () => {
    const { app, userService, sessionRevocations } = await buildTestApp();
    const { user, sessionToken, sessionId } = await userService.registerAccount({ nickname: 'Leaving', avatar: 0, password: PASSWORD });
    const other = await userService.login('Leaving', PASSWORD);
    const notified: { userId: string; sessionId: string }[] = [];
    sessionRevocations.subscribe((revoked) => notified.push(revoked));

    const response = await request(app).post('/api/users/logout').set('Authorization', `Bearer ${user.id}:${sessionToken}`);

    expect(response.status).toBe(204);
    expect(notified).toEqual([{ userId: user.id, sessionId }]);
    await expect(userService.isSessionActive(user.id, sessionId)).resolves.toBe(false);
    await expect(userService.isSessionActive(user.id, other?.sessionId ?? '')).resolves.toBe(true);

    const again = await request(app).post('/api/users/logout').set('Authorization', `Bearer ${user.id}:${sessionToken}`);
    expect(again.status).toBe(401);
  });

  it('is documented in the OpenAPI document', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/docs/openapi.json');

    const paths = (response.body as { paths: Record<string, { post?: { security?: unknown[] } }> }).paths;
    expect(paths['/api/users/logout']?.post?.security).toEqual([{ sessionAuth: [] }]);
  });
});
