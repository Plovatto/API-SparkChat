import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCanonicalRequest,
  EMPTY_BODY_SHA256,
  NonceCache,
  SessionSignatureVerifier,
  sha256Base64Url,
  SOCKET_JOIN_METHOD,
  SOCKET_JOIN_PATH,
} from '@/modules/users/user.session-signature.js';
import { buildTestApp } from './support/build-test-app.js';
import { startSocketHarness, TEST_PASSWORD, waitForEvent, type TestClient } from './support/socket-harness.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;

interface DeviceKey {
  publicKey: string;
  privateKey: KeyObject;
}

function createDeviceKey(): DeviceKey {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), privateKey: pair.privateKey };
}

function signProof(device: DeviceKey, userId: string, method: string, path: string, bodyHash: string, timestamp = Date.now()) {
  const nonce = randomBytes(16).toString('base64url');
  const canonical = buildCanonicalRequest(userId, { method, path, bodyHash }, { timestamp, nonce });
  const signature = sign('sha256', Buffer.from(canonical), { key: device.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { timestamp, nonce, signature };
}

function signedHeaders(device: DeviceKey, userId: string, method: string, path: string, body?: string, timestamp?: number) {
  const proof = signProof(device, userId, method, path, body === undefined ? EMPTY_BODY_SHA256 : sha256Base64Url(body), timestamp);
  return { 'x-spark-timestamp': String(proof.timestamp), 'x-spark-nonce': proof.nonce, 'x-spark-signature': proof.signature };
}

async function loginWith(testApp: TestApp, nickname: string, devicePublicKey?: string) {
  const authKey = randomBytes(32).toString('base64url');
  await testApp.userService.registerAccount({
    nickname,
    avatar: 0,
    password: authKey,
    authSalt: randomBytes(16).toString('base64url'),
    recoveryVerifier: randomBytes(32).toString('base64url'),
  });
  const response = await request(testApp.app)
    .post('/api/users/login')
    .send({ nickname, password: authKey, ...(devicePublicKey ? { devicePublicKey } : {}) });
  expect(response.status).toBe(200);
  const body = response.body as { user: { id: string }; sessionToken: string; deviceKeyBound: boolean };
  return { userId: body.user.id, bearer: `Bearer ${body.user.id}:${body.sessionToken}`, deviceKeyBound: body.deviceKeyBound };
}

describe('session device binding over HTTP', () => {
  it('binds the key at login and requires a valid signature afterwards', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const session = await loginWith(testApp, 'Bound', device.publicKey);

    const unsigned = await request(testApp.app).get('/api/gifs/status').set('Authorization', session.bearer);
    const signed = await request(testApp.app)
      .get('/api/gifs/status')
      .set('Authorization', session.bearer)
      .set(signedHeaders(device, session.userId, 'GET', '/api/gifs/status'));

    expect(session.deviceKeyBound).toBe(true);
    expect(unsigned.status).toBe(401);
    expect(unsigned.body).toMatchObject({ code: 'auth.signatureRequired' });
    expect(signed.status).toBe(200);
  });

  it('rejects a replayed signature', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const session = await loginWith(testApp, 'Replay', device.publicKey);
    const headers = signedHeaders(device, session.userId, 'GET', '/api/gifs/status');

    const first = await request(testApp.app).get('/api/gifs/status').set('Authorization', session.bearer).set(headers);
    const replay = await request(testApp.app).get('/api/gifs/status').set('Authorization', session.bearer).set(headers);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'auth.signatureReplayed' });
  });

  it('rejects a signature made by another key, for another path or over another body', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const thief = createDeviceKey();
    const session = await loginWith(testApp, 'Forgery', device.publicKey);
    const body = JSON.stringify({ url: 'https://example.com' });

    const foreignKey = await request(testApp.app)
      .get('/api/gifs/status')
      .set('Authorization', session.bearer)
      .set(signedHeaders(thief, session.userId, 'GET', '/api/gifs/status'));
    const otherPath = await request(testApp.app)
      .get('/api/gifs/status')
      .set('Authorization', session.bearer)
      .set(signedHeaders(device, session.userId, 'GET', '/api/gifs/trending'));
    const tamperedBody = await request(testApp.app)
      .post('/api/link-preview')
      .set('Authorization', session.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(device, session.userId, 'POST', '/api/link-preview', body))
      .send(JSON.stringify({ url: 'https://evil.example' }));

    for (const response of [foreignKey, otherPath, tamperedBody]) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'auth.signatureInvalid' });
    }
  });

  it('accepts a signed JSON body', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const session = await loginWith(testApp, 'JsonBody', device.publicKey);
    const body = JSON.stringify({ url: 'https://example.com' });

    const response = await request(testApp.app)
      .post('/api/link-preview')
      .set('Authorization', session.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(device, session.userId, 'POST', '/api/link-preview', body))
      .send(body);

    expect(response.status).not.toBe(401);
  });

  it('reports the server time when the timestamp is outside the window', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const session = await loginWith(testApp, 'Stale', device.publicKey);

    const response = await request(testApp.app)
      .get('/api/gifs/status')
      .set('Authorization', session.bearer)
      .set(signedHeaders(device, session.userId, 'GET', '/api/gifs/status', undefined, Date.now() - 10 * 60 * 1000));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'auth.signatureStale', params: { serverTime: expect.any(Number) as number } });
  });

  it('keeps legacy sessions without a key working and still lets them log out unsigned', async () => {
    const testApp = await buildTestApp();
    const session = await loginWith(testApp, 'Legacy');

    const status = await request(testApp.app).get('/api/gifs/status').set('Authorization', session.bearer);
    const logout = await request(testApp.app).post('/api/users/logout').set('Authorization', session.bearer);

    expect(session.deviceKeyBound).toBe(false);
    expect(status.status).toBe(200);
    expect(logout.status).toBe(204);
  });

  it('allows unsigned logout for a bound session', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const session = await loginWith(testApp, 'BoundOut', device.publicKey);

    const logout = await request(testApp.app).post('/api/users/logout').set('Authorization', session.bearer);

    expect(logout.status).toBe(204);
  });

  it('migrates a legacy session once, with proof of possession, and enforces it afterwards', async () => {
    const testApp = await buildTestApp();
    const device = createDeviceKey();
    const other = createDeviceKey();
    const session = await loginWith(testApp, 'Migrate');
    const path = '/api/users/session/device-key';
    const body = JSON.stringify({ publicKey: device.publicKey });

    const unproven = await request(testApp.app).post(path).set('Authorization', session.bearer).set('Content-Type', 'application/json').send(body);
    const bound = await request(testApp.app)
      .post(path)
      .set('Authorization', session.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(device, session.userId, 'POST', path, body))
      .send(body);
    const again = await request(testApp.app)
      .post(path)
      .set('Authorization', session.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(device, session.userId, 'POST', path, body))
      .send(body);
    const otherBody = JSON.stringify({ publicKey: other.publicKey });
    const conflict = await request(testApp.app)
      .post(path)
      .set('Authorization', session.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(other, session.userId, 'POST', path, otherBody))
      .send(otherBody);
    const unsignedAfter = await request(testApp.app).get('/api/gifs/status').set('Authorization', session.bearer);

    expect(unproven.status).toBe(401);
    expect(unproven.body).toMatchObject({ code: 'auth.signatureRequired' });
    expect(bound.status).toBe(200);
    expect(bound.body).toEqual({ status: 'bound' });
    expect(again.body).toEqual({ status: 'unchanged' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'auth.deviceKeyConflict' });
    expect(unsignedAfter.status).toBe(401);
  });

  it('rejects an invalid public key', async () => {
    const testApp = await buildTestApp();
    const session = await loginWith(testApp, 'BadKey');

    const response = await request(testApp.app)
      .post('/api/users/session/device-key')
      .set('Authorization', session.bearer)
      .send({ publicKey: randomBytes(65).toString('base64url') });
    const login = await request(testApp.app).post('/api/users/login').send({ nickname: 'BadKey', password: 'x', devicePublicKey: 'not-a-key' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'auth.deviceKeyInvalid' });
    expect(login.status).toBe(400);
  });

  it('rejects keyless sessions and migration in required mode', async () => {
    const testApp = await buildTestApp({ signatureMode: 'required' });
    const device = createDeviceKey();
    const legacy = await loginWith(testApp, 'Required');
    const bound = await loginWith(testApp, 'RequiredBound', device.publicKey);
    const path = '/api/users/session/device-key';
    const body = JSON.stringify({ publicKey: device.publicKey });

    const legacyStatus = await request(testApp.app).get('/api/gifs/status').set('Authorization', legacy.bearer);
    const migration = await request(testApp.app)
      .post(path)
      .set('Authorization', legacy.bearer)
      .set('Content-Type', 'application/json')
      .set(signedHeaders(device, legacy.userId, 'POST', path, body))
      .send(body);
    const boundStatus = await request(testApp.app)
      .get('/api/gifs/status')
      .set('Authorization', bound.bearer)
      .set(signedHeaders(device, bound.userId, 'GET', '/api/gifs/status'));

    expect(legacyStatus.status).toBe(401);
    expect(legacyStatus.body).toMatchObject({ code: 'auth.deviceKeyRequired' });
    expect(migration.status).toBe(403);
    expect(boundStatus.status).toBe(200);
  });
});

describe('SessionSignatureVerifier', () => {
  it('does not burn a nonce on a forged signature', () => {
    const verifier = new SessionSignatureVerifier('bound');
    const device = createDeviceKey();
    const thief = createDeviceKey();
    const session = { id: 's1', userId: 'u1', devicePublicKey: device.publicKey };
    const requestShape = { method: 'GET', path: '/x', bodyHash: EMPTY_BODY_SHA256 };
    const genuine = signProof(device, 'u1', 'GET', '/x', EMPTY_BODY_SHA256);
    const forged = { ...signProof(thief, 'u1', 'GET', '/x', EMPTY_BODY_SHA256), nonce: genuine.nonce };

    expect(verifier.verify(session, forged, requestShape)).toEqual({ code: 'auth.signatureInvalid' });
    expect(verifier.verify(session, genuine, requestShape)).toBeNull();
  });

  it('caps the nonce cache', () => {
    const cache = new NonceCache(3);
    const now = 1_000;
    for (const nonce of ['a', 'b', 'c', 'd']) {
      expect(cache.claim(nonce, now + 10, now)).toBe(true);
    }
    expect(cache.size).toBe(3);
    expect(cache.claim('d', now + 10, now)).toBe(false);
  });
});

describe('session device binding over the socket', () => {
  let harness: Awaited<ReturnType<typeof startSocketHarness>> | null = null;

  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  async function boundAccount(nickname: string, device: DeviceKey) {
    if (!harness) {
      throw new Error('harness not started');
    }
    return harness.userService.registerAccount({
      nickname,
      avatar: 0,
      password: TEST_PASSWORD,
      authSalt: randomBytes(16).toString('base64url'),
      recoveryVerifier: randomBytes(32).toString('base64url'),
      devicePublicKey: device.publicKey,
    });
  }

  function joinProof(device: DeviceKey, userId: string) {
    return signProof(device, userId, SOCKET_JOIN_METHOD, SOCKET_JOIN_PATH, EMPTY_BODY_SHA256);
  }

  async function resumeWith(client: TestClient, payload: Record<string, unknown>) {
    const outcome = Promise.race([
      waitForEvent<{ user: { id: string } }>(client, 'user:resumed').then(() => ({ ok: true as const })),
      waitForEvent<{ code: string; reason: string }>(client, 'user:auth-failed').then((failure) => ({ ok: false as const, failure })),
    ]);
    client.emit('user:join', { mode: 'resume', ...payload });
    return outcome;
  }

  it('requires a join proof for a bound session and rejects its replay', async () => {
    harness = await startSocketHarness();
    const device = createDeviceKey();
    const account = await boundAccount('SockBound', device);
    const proof = joinProof(device, account.user.id);

    const withoutProof = await resumeWith(await harness.connect(), { userId: account.user.id, sessionToken: account.sessionToken });
    const withProof = await resumeWith(await harness.connect(), { userId: account.user.id, sessionToken: account.sessionToken, proof });
    const replayed = await resumeWith(await harness.connect(), { userId: account.user.id, sessionToken: account.sessionToken, proof });

    expect(withoutProof).toMatchObject({ ok: false, failure: { code: 'auth.signatureRequired', reason: 'invalid' } });
    expect(withProof).toEqual({ ok: true });
    expect(replayed).toMatchObject({ ok: false, failure: { code: 'auth.signatureReplayed' } });
  });

  it('still resumes legacy sessions without a proof', async () => {
    harness = await startSocketHarness();
    const account = await harness.createAccount('SockLegacy');

    const outcome = await resumeWith(await harness.connect(), { userId: account.user.id, sessionToken: account.sessionToken });

    expect(outcome).toEqual({ ok: true });
  });

  it('binds the key sent on socket registration', async () => {
    harness = await startSocketHarness();
    const device = createDeviceKey();
    const client = await harness.connect();
    const registered = waitForEvent<{ deviceKeyBound: boolean }>(client, 'user:registered');

    client.emit('user:join', {
      mode: 'register',
      nickname: 'SockSignup',
      avatar: 0,
      password: randomBytes(32).toString('base64url'),
      authSalt: randomBytes(16).toString('base64url'),
      recoveryVerifier: randomBytes(32).toString('base64url'),
      passwordLength: 16,
      devicePublicKey: device.publicKey,
    });

    expect(await registered).toMatchObject({ deviceKeyBound: true });
  });
});
