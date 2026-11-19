import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './support/build-test-app.js';

const PASSWORD = 'correct-horse-battery-staple';

function clientSecret(): string {
  return randomBytes(32).toString('base64url');
}

function authSalt(): string {
  return randomBytes(16).toString('base64url');
}

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

async function registerV2(userService: TestApp['userService'], nickname: string) {
  const credentials = { authKey: clientSecret(), authSalt: authSalt(), recoveryVerifier: clientSecret() };
  const { user } = await userService.registerAccount({
    nickname,
    avatar: 0,
    password: credentials.authKey,
    authSalt: credentials.authSalt,
    recoveryVerifier: credentials.recoveryVerifier,
  });
  return { user, ...credentials };
}

describe('POST /api/users/auth-params', () => {
  it('returns version 1 for legacy accounts', async () => {
    const { app, userService } = await buildTestApp();
    await userService.registerAccount({ nickname: 'Legacy', avatar: 0, password: PASSWORD });

    const response = await request(app).post('/api/users/auth-params').send({ nickname: 'Legacy' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 1 });
  });

  it('returns the stored salt for v2 accounts', async () => {
    const { app, userService } = await buildTestApp();
    const { authSalt: salt } = await registerV2(userService, 'Modern');

    const response = await request(app).post('/api/users/auth-params').send({ nickname: 'modern' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: 2, salt });
  });

  it('returns the same fake salt for an unknown nickname on every call', async () => {
    const { app } = await buildTestApp();

    const first = await request(app).post('/api/users/auth-params').send({ nickname: 'Ghost' });
    const second = await request(app).post('/api/users/auth-params').send({ nickname: 'Ghost' });

    expect(first.status).toBe(200);
    expect(first.body).toEqual(second.body);
    expect((first.body as { version: number; salt: string }).salt).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('returns 400 without a nickname', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/auth-params').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'user.nicknameRequired' });
  });

  it('returns 429 after too many lookups from the same IP', async () => {
    const { app } = await buildTestApp();

    for (let i = 0; i < 60; i += 1) {
      await request(app).post('/api/users/auth-params').send({ nickname: `Ghost${i}` });
    }
    const response = await request(app).post('/api/users/auth-params').send({ nickname: 'Ghost' });

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: 'rateLimit.loginAttempts' });
  });
});

describe('POST /api/users/login authVersion', () => {
  it('reports version 1 for legacy logins and version 2 for derived-key logins', async () => {
    const { app, userService } = await buildTestApp();
    await userService.registerAccount({ nickname: 'Legacy', avatar: 0, password: PASSWORD });
    const { authKey } = await registerV2(userService, 'Modern');

    const legacy = await request(app).post('/api/users/login').send({ nickname: 'Legacy', password: PASSWORD });
    const modern = await request(app).post('/api/users/login').send({ nickname: 'Modern', password: authKey });

    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ authVersion: 1 });
    expect(modern.status).toBe(200);
    expect(modern.body).toMatchObject({ authVersion: 2 });
  });

  it('keeps the legacy recovery token and adds authVersion on keyfile login', async () => {
    const { app, userService } = await buildTestApp();
    const { recoveryFile } = await userService.registerAccount({ nickname: 'Legacy', avatar: 0, password: PASSWORD });

    const response = await request(app)
      .post('/api/users/login-with-keyfile')
      .attach('keyfile', recoveryFile ?? Buffer.alloc(0), { filename: 'sparkchat-legacy.sparkkey' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authVersion: 1, recoveryToken: expect.any(String) as unknown });
  });
});

describe('POST /api/users/login-with-recovery', () => {
  it('returns a session for a matching recovery key', async () => {
    const { app, userService } = await buildTestApp();
    const { user, recoveryVerifier } = await registerV2(userService, 'Modern');

    const response = await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: recoveryVerifier });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      message: 'Login realizado com sucesso!',
      user: { id: user.id },
      sessionToken: expect.any(String) as unknown,
      authVersion: 2,
    });
    expect(response.body).not.toHaveProperty('recoveryToken');
  });

  it('grants the one-time password reset of a keyfile session', async () => {
    const { app, userService, userRepository } = await buildTestApp();
    const { user, recoveryVerifier } = await registerV2(userService, 'Modern');

    const response = await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: recoveryVerifier });
    const resumed = await userService.resumeSession(user.id, (response.body as { sessionToken: string }).sessionToken);
    const newAuthSalt = authSalt();

    await userService.changePassword(user.id, {
      newPassword: clientSecret(),
      newAuthSalt,
      encryptedPrivateKeyByPassword: 'wrapped-by-password',
      sessionId: resumed?.sessionId ?? '',
    });

    expect(resumed?.authMethod).toBe('keyfile');
    expect((await userRepository.findById(user.id))?.authSalt).toBe(newAuthSalt);
  });

  it('returns 401 with the keyfile error for a wrong or malformed key', async () => {
    const { app, userService } = await buildTestApp();
    const { user } = await registerV2(userService, 'Modern');

    const wrong = await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: clientSecret() });
    const malformed = await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: 'nope' });

    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ message: 'Arquivo de recuperação inválido.', code: 'auth.keyfileInvalid' });
    expect(malformed.status).toBe(401);
  });

  it('returns 400 when the body is missing', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).post('/api/users/login-with-recovery').send({});

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'auth.keyfileRequired' });
  });

  it('shares the keyfile rate limit per IP', async () => {
    const { app, userService } = await buildTestApp();
    const { user, recoveryVerifier } = await registerV2(userService, 'Modern');

    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: clientSecret() });
    }
    const response = await request(app).post('/api/users/login-with-recovery').send({ userId: user.id, recoveryKey: recoveryVerifier });

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: 'rateLimit.loginAttempts' });
  });

  it('is documented in the OpenAPI document with auth-params', async () => {
    const { app } = await buildTestApp();

    const response = await request(app).get('/docs/openapi.json');
    const paths = (response.body as { paths?: Record<string, unknown> }).paths ?? {};

    expect(paths).toHaveProperty('/api/users/login-with-recovery');
    expect(paths).toHaveProperty('/api/users/auth-params');
  });
});
