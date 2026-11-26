const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const express = require('express');
const { NestFactory } = require('@nestjs/core');
const cors = createRequire(require.resolve('@nestjs/platform-express'))('cors');
const { createQorvexApiApp } = require('../dist/bootstrap');

test('preflight y accesos válidos no bloquean login; intentos fallidos mantienen límite y CORS', async () => {
  const server = express();
  const origin = 'https://workshop.example.test';
  const settings = { TRUST_PROXY: '1', JWT_SECRET: 'isolated-test-secret', CORS_ORIGIN: origin, AUTH_RATE_LIMIT_MAX: 2, AUTH_RATE_LIMIT_WINDOW_MS: 60000, API_RATE_LIMIT_MAX: 1000 };
  const config = { get: (key, fallback) => settings[key] ?? fallback };
  const originalCreate = NestFactory.create;
  NestFactory.create = async () => ({
    get: () => config,
    getHttpAdapter: () => ({ getInstance: () => server }),
    use: (...args) => server.use(...args),
    enableCors: (options) => server.use(cors(options)),
    useGlobalPipes: () => {},
    useGlobalFilters: () => {},
  });
  let listener;
  try {
    await createQorvexApiApp();
    server.post('/auth/login', (req, res) => res.status(req.body.fail ? 401 : 201).json({ ok: !req.body.fail }));
    listener = await new Promise(resolve => { const value = server.listen(0, '127.0.0.1', () => resolve(value)); });
    const url = `http://127.0.0.1:${listener.address().port}/auth/login`;
    for (let i = 0; i < 5; i++) {
      const response = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
      assert.equal(response.status, 204, 'Browser preflight must not exhaust login limit');
    }
    const login = (fail, ip = '192.0.2.10') => fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify({ fail }) });
    for (let i = 0; i < 5; i++) assert.equal((await login(false)).status, 201, 'Successful sign-ins must not consume failed-attempt allowance');
    for (let i = 0; i < 2; i++) assert.equal((await login(true)).status, 401);
    const blocked = await login(true);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('access-control-allow-origin'), origin, 'Browser must be able to read rate-limit response');
    assert.ok(blocked.headers.get('retry-after'));
    assert.equal((await login(false, '192.0.2.11')).status, 201, 'Different clients retain independent allowance');
    const unknownOrigin = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://untrusted.example.test', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(unknownOrigin.headers.get('access-control-allow-origin'), null);
  } finally {
    NestFactory.create = originalCreate;
    if (listener) await new Promise(resolve => listener.close(resolve));
  }
});
