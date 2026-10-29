require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JwtAuthGuard } = require('../dist/common/guards/jwt-auth.guard');

test('peticiones simultáneas comparten lectura de usuario y vuelven a consultar al vencer', async () => {
  JwtAuthGuard.userCache.clear();
  let calls = 0;
  let status = 'ACTIVE';
  const prisma = {
    $queryRaw: async () => {
      calls++;
      return [
        {
          id: 'user-cache-test',
          email: 'test@example.com',
          name: 'Prueba',
          status,
          memberships: [],
        },
      ];
    },
  };
  const config = { getOrThrow: () => 'test-secret' };
  const jwt = { verifyAsync: async () => ({ sub: 'user-cache-test', email: 'test@example.com' }) };
  const guards = [new JwtAuthGuard(config, jwt, prisma), new JwtAuthGuard(config, jwt, prisma)];
  const context = () => {
    const request = { headers: { authorization: 'Bearer test-token' } };
    return { request, switchToHttp: () => ({ getRequest: () => request }) };
  };
  const first = context();
  const second = context();
  await Promise.all([guards[0].canActivate(first), guards[1].canActivate(second)]);
  assert.equal(calls, 1);
  assert.equal(first.request.user.id, 'user-cache-test');
  assert.equal(second.request.user.id, 'user-cache-test');

  status = 'INACTIVE';
  JwtAuthGuard.userCache.get('user-cache-test').expiresAt = 0;
  await assert.rejects(guards[0].canActivate(context()), /User is not active/);
  assert.equal(calls, 2);
  JwtAuthGuard.userCache.clear();
});
