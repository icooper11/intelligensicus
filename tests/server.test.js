import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body;
    const headers = { ...(options.headers || {}) };
    if (body !== undefined && !headers['Content-Length']) headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method: options.method || 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

async function waitForServer(port, process) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Server exited before health check: ${process.exitCode}`);
    try {
      const response = await request(port, '/healthz');
      if (response.status === 200) return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become healthy within five seconds.');
}

async function waitForLog(logFile, marker) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(logFile, 'utf8');
      if (content.includes(marker)) return content;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Expected structured server log entry was not written.');
}

test('static server enforces the local asset boundary', async t => {
  const port = await reservePort();
  const authDirectory = await mkdtemp(path.join(os.tmpdir(), 'intelligensicus-auth-test-'));
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: packageRoot,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: 'INFO', INTELLIGENSICUS_AUTH_DIR: authDirectory, INTELLIGENSICUS_ALLOWED_HOSTS: 'intelligensicus.theamanuensis.com' },
    stdio: 'ignore'
  });

  try {
    await waitForServer(port, child);

    await t.test('registers, signs in, revokes sessions, and rejects cross-origin requests', async () => {
      const body = JSON.stringify({ name: 'Researcher', email: 'researcher@example.org', password: 'a long test password' });
      const headers = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
      const crossOrigin = await request(port, '/api/auth/register', { method: 'POST', headers: { ...headers, Origin: 'http://attacker.invalid' }, body });
      assert.equal(crossOrigin.status, 403);
      const registration = await request(port, '/api/auth/register', { method: 'POST', headers, body });
      assert.equal(registration.status, 201);
      const duplicate = await request(port, '/api/auth/register', { method: 'POST', headers, body });
      assert.equal(duplicate.status, 409);
      const invalid = await request(port, '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: 'researcher@example.org', password: 'wrong password' }) });
      assert.equal(invalid.status, 401);
      const login = await request(port, '/api/auth/login', { method: 'POST', headers, body });
      assert.equal(login.status, 200);
      const cookie = login.headers['set-cookie'][0];
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.equal(login.body.includes('a long test password'), false);
      const httpsLogin = await request(port, '/api/auth/login', {
        method: 'POST',
        headers: { Host: 'intelligensicus.theamanuensis.com', Origin: 'https://intelligensicus.theamanuensis.com', 'Content-Type': 'application/json' },
        body
      });
      assert.equal(httpsLogin.status, 200);
      assert.match(httpsLogin.headers['set-cookie'][0], /; Secure/);
      const sessionCookie = cookie.split(';')[0];
      const session = await request(port, '/api/auth/me', { headers: { Cookie: sessionCookie } });
      assert.equal(JSON.parse(session.body).user.email, 'researcher@example.org');
      const logout = await request(port, '/api/auth/logout', { method: 'POST', headers: { ...headers, Cookie: sessionCookie }, body: '{}' });
      assert.equal(logout.status, 204);
      const afterLogout = await request(port, '/api/auth/me', { headers: { Cookie: sessionCookie } });
      assert.equal(afterLogout.status, 401);

      const passwordRegistration = await request(port, '/api/auth/register', {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'Password Researcher', email: 'password@example.org', password: 'original passphrase 2026' })
      });
      assert.equal(passwordRegistration.status, 201);
      const passwordLogin = await request(port, '/api/auth/login', {
        method: 'POST', headers,
        body: JSON.stringify({ email: 'password@example.org', password: 'original passphrase 2026' })
      });
      const oldPasswordCookie = passwordLogin.headers['set-cookie'][0].split(';')[0];
      const passwordChange = await request(port, '/api/auth/change-password', {
        method: 'POST', headers: { ...headers, Cookie: oldPasswordCookie },
        body: JSON.stringify({ currentPassword: 'original passphrase 2026', newPassword: 'replacement passphrase 2026' })
      });
      assert.equal(passwordChange.status, 200);
      assert.match(passwordChange.headers['set-cookie'][0], /HttpOnly/);
      assert.notEqual(passwordChange.headers['set-cookie'][0].split(';')[0], oldPasswordCookie);
      const activePasswordCookie = passwordChange.headers['set-cookie'][0].split(';')[0];
      const revokedPasswordSession = await request(port, '/api/auth/me', { headers: { Cookie: oldPasswordCookie } });
      assert.equal(revokedPasswordSession.status, 401);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
      const avatarUpload = await request(port, '/api/auth/avatar', {
        method: 'PUT', headers: { ...headers, Cookie: activePasswordCookie },
        body: JSON.stringify({ mime: 'image/png', data: png })
      });
      assert.equal(avatarUpload.status, 200);
      assert.equal(JSON.parse(avatarUpload.body).user.hasAvatar, true);
      const avatar = await request(port, '/api/auth/avatar', { headers: { Cookie: activePasswordCookie } });
      assert.equal(avatar.status, 200);
      assert.equal(avatar.headers['content-type'], 'image/png');
      const invalidAvatar = await request(port, '/api/auth/avatar', {
        method: 'PUT', headers: { ...headers, Cookie: activePasswordCookie },
        body: JSON.stringify({ mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') })
      });
      assert.equal(invalidAvatar.status, 400);
      const avatarRemoval = await request(port, '/api/auth/avatar', {
        method: 'DELETE', headers: { ...headers, Cookie: activePasswordCookie }, body: '{}'
      });
      assert.equal(avatarRemoval.status, 200);
      assert.equal(JSON.parse(avatarRemoval.body).user.hasAvatar, false);
      const replacementLogin = await request(port, '/api/auth/login', {
        method: 'POST', headers,
        body: JSON.stringify({ email: 'password@example.org', password: 'replacement passphrase 2026' })
      });
      assert.equal(replacementLogin.status, 200);

      const ownerLogin = await request(port, '/api/auth/login', { method: 'POST', headers, body });
      const ownerCookie = ownerLogin.headers['set-cookie'][0].split(';')[0];
      const secondRegistration = await request(port, '/api/auth/register', {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'Editor', email: 'editor@example.org', password: 'another long test password' })
      });
      assert.equal(secondRegistration.status, 201);
      const editorLogin = await request(port, '/api/auth/login', {
        method: 'POST', headers,
        body: JSON.stringify({ email: 'editor@example.org', password: 'another long test password' })
      });
      const editorCookie = editorLogin.headers['set-cookie'][0].split(';')[0];
      const created = await request(port, '/api/projects', {
        method: 'POST', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000', code: 'PRJ01', name: 'Field research' })
      });
      assert.equal(created.status, 201);
      const projectId = JSON.parse(created.body).project.id;
      const workspace = { id: projectId, code: 'PRJ01', name: 'Field research', animals: [], events: [{ id: 'event-1', title: 'Initial observation' }] };
      const initialData = await request(port, `/api/projects/${projectId}/data`, {
        method: 'PUT', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ project: workspace, expectedVersion: 0 })
      });
      assert.equal(initialData.status, 200);
      assert.equal(JSON.parse(initialData.body).version, 1);
      const denied = await request(port, `/api/projects/${projectId}/members`, { headers: { Cookie: editorCookie } });
      assert.equal(denied.status, 403);
      const added = await request(port, `/api/projects/${projectId}/members`, {
        method: 'POST', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ email: 'editor@example.org', role: 'editor' })
      });
      assert.equal(added.status, 201);
      const sharedData = await request(port, `/api/projects/${projectId}/data`, { headers: { Cookie: editorCookie } });
      assert.equal(sharedData.status, 200);
      assert.equal(JSON.parse(sharedData.body).project.events[0].title, 'Initial observation');
      const updatedWorkspace = { ...workspace, events: [{ id: 'event-1', title: 'Editor update' }] };
      const editorUpdate = await request(port, `/api/projects/${projectId}/data`, {
        method: 'PUT', headers: { ...headers, Cookie: editorCookie },
        body: JSON.stringify({ project: updatedWorkspace, expectedVersion: 1 })
      });
      assert.equal(editorUpdate.status, 200);
      const staleUpdate = await request(port, `/api/projects/${projectId}/data`, {
        method: 'PUT', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ project: workspace, expectedVersion: 1 })
      });
      assert.equal(staleUpdate.status, 409);
      const viewerRegistration = await request(port, '/api/auth/register', {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'Viewer', email: 'viewer@example.org', password: 'a third long password' })
      });
      assert.equal(viewerRegistration.status, 201);
      const viewerLogin = await request(port, '/api/auth/login', {
        method: 'POST', headers,
        body: JSON.stringify({ email: 'viewer@example.org', password: 'a third long password' })
      });
      const viewerCookie = viewerLogin.headers['set-cookie'][0].split(';')[0];
      const viewerAdded = await request(port, `/api/projects/${projectId}/members`, {
        method: 'POST', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ email: 'viewer@example.org', role: 'viewer' })
      });
      assert.equal(viewerAdded.status, 201);
      const viewerData = await request(port, `/api/projects/${projectId}/data`, { headers: { Cookie: viewerCookie } });
      assert.equal(JSON.parse(viewerData.body).project.events[0].title, 'Editor update');
      const viewerWrite = await request(port, `/api/projects/${projectId}/data`, {
        method: 'PUT', headers: { ...headers, Cookie: viewerCookie },
        body: JSON.stringify({ project: updatedWorkspace, expectedVersion: 2 })
      });
      assert.equal(viewerWrite.status, 403);
      const transferred = await request(port, `/api/projects/${projectId}/ownership`, {
        method: 'POST', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ nextOwnerId: JSON.parse(added.body).member.id })
      });
      assert.equal(transferred.status, 200);
      const formerOwner = await request(port, `/api/projects/${projectId}/members`, {
        method: 'POST', headers: { ...headers, Cookie: ownerCookie },
        body: JSON.stringify({ email: 'researcher@example.org', role: 'viewer' })
      });
      assert.equal(formerOwner.status, 403);
    });

    await t.test('rejects encoded Windows backslash traversal', async () => {
      const response = await request(port, '/intelligensicus-library/%5C..%5Cserver.mjs');
      assert.equal(response.status, 404);
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(response.body.includes("import { createServer } from 'node:http'"), false);
    });

    await t.test('rejects encoded slash traversal', async () => {
      const response = await request(port, '/intelligensicus-library/%2e%2e%2fserver.mjs');
      assert.equal(response.status, 404);
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
      assert.equal(response.body.includes("import { createServer } from 'node:http'"), false);
    });

    await t.test('does not expose internal logger source', async () => {
      const response = await request(port, '/src/utils/logger.mjs');
      assert.equal(response.status, 404);
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    });

    await t.test('accepts same-origin browser errors and redacts sensitive values', async () => {
      const date = new Date().toISOString().slice(0, 10);
      const logFile = path.resolve(packageRoot, '../logs/intelligensicus/client', `combined-${date}.log`);
      const secret = 'client-log-test-secret';
      const response = await request(port, '/api/client-log', {
        method: 'POST',
        headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'window_error', timestamp: new Date().toISOString(),
          name: 'Error', message: `Failure token=${secret}`,
          source: `/app.js?token=${secret}`, line: 12, column: 3,
          stack: `Error: token=${secret}`
        })
      });
      assert.equal(response.status, 204);
      const content = await waitForLog(logFile, 'frontend_error');
      assert.equal(content.includes(secret), false);
      assert.equal(content.includes('"source":"/app.js"'), true);
      assert.equal(content.includes('[REDACTED]'), true);
    });

    await t.test('rejects cross-origin browser log writes', async () => {
      const response = await request(port, '/api/client-log', {
        method: 'POST',
        headers: { Origin: 'http://attacker.invalid', 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'window_error', message: 'not accepted' })
      });
      assert.equal(response.status, 403);
      assert.match(response.headers['content-security-policy'], /default-src 'self'/);
    });

    await t.test('accepts HTTPS production browser failures and redacts query secrets', async () => {
      const date = new Date().toISOString().slice(0, 10);
      const logFile = path.resolve(packageRoot, '../logs/intelligensicus/client', `combined-${date}.log`);
      const secret = 'production-client-log-secret';
      const response = await request(port, '/api/client-log', {
        method: 'POST',
        headers: {
          Host: 'intelligensicus.theamanuensis.com',
          Origin: 'https://intelligensicus.theamanuensis.com',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          type: 'fetch_failure', timestamp: new Date().toISOString(), name: 'HTTPError',
          message: `GET /api/example?token=${secret} returned 503`,
          source: `/api/example?token=${secret}`, status: 503, method: 'GET'
        })
      });
      assert.equal(response.status, 204);
      const content = await waitForLog(logFile, 'frontend_fetch_failure');
      assert.equal(content.includes(secret), false);
      assert.equal(content.includes('"status":503'), true);
      assert.equal(content.includes('"source":"/api/example"'), true);
    });

    await t.test('serves the app shell and required map data', async () => {
      const [shell, mapData, favicon] = await Promise.all([
        request(port, '/'),
        request(port, '/intelligensicus-library/outposts.json'),
        request(port, '/intelligensicus-library/assets/favicon-octopus.ico')
      ]);
      assert.equal(shell.status, 200);
      assert.match(shell.headers['content-security-policy'], /default-src 'self'/);
      assert.match(shell.headers['content-security-policy'], /media-src 'self' blob:/);
      assert.equal(mapData.status, 200);
      assert.doesNotThrow(() => JSON.parse(mapData.body));
      assert.equal(favicon.status, 200);
      assert.equal(favicon.headers['content-type'], 'image/x-icon');
    });

    await t.test('writes structured logs without query-string secrets', async () => {
      const date = new Date().toISOString().slice(0, 10);
      const logFile = path.resolve(packageRoot, '../logs/intelligensicus/server', `combined-${date}.log`);
      await request(port, '/app.js?token=log-test-secret');
      const content = await waitForLog(logFile, 'http_request_completed');
      assert.equal(content.includes('"path":"/app.js"'), true);
      assert.equal(content.includes('log-test-secret'), false);
    });
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(authDirectory, { recursive: true, force: true });
  }
});