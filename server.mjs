import { createServer } from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from './src/utils/logger.mjs';
import { createAuthStore } from './src/auth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 5510);
const logger = createLogger('server');
const clientLogger = createLogger('client');
const authDirectory = process.env.INTELLIGENSICUS_AUTH_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Intelligensicus');
await mkdir(authDirectory, { recursive: true, mode: 0o700 });
const authStore = createAuthStore(path.join(authDirectory, 'accounts.sqlite'));
const maxClientLogBytes = 16 * 1024;
const allowedClientLogHosts = new Set([
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  ...(process.env.INTELLIGENSICUS_ALLOWED_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean)
]);
let clientLogWindowStartedAt = Date.now();
let clientLogRequestsThisWindow = 0;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};
const allowedFile = relative => relative === '/index.html'
  || relative === '/download.html'
  || relative === '/download-page.css'
  || relative === '/download-page.js'
  || relative === '/robots.txt'
  || relative === '/sitemap.xml'
  || relative === '/styles.css'
  || relative === '/vendor/vq/frontend/styles/theme.css'
  || relative === '/vendor/fflate/fflate.browser.js'
  || relative === '/client-logger.js'
  || relative === '/research-package.mjs'
  || relative === '/app.js'
  || relative.startsWith('/intelligensicus-library/');
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};

const authAttempts = { startedAt: Date.now(), count: 0 };

function sessionToken(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const matches = cookies.map(cookie => cookie.trim()).filter(cookie => cookie.startsWith('intelligensicus_session='));
  return matches.length === 1 ? matches[0].slice('intelligensicus_session='.length) : '';
}

function originForHost(host) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;
}

function sessionCookie(token, host, maxAge = 43200) {
  const secure = originForHost(host).startsWith('https:') ? '; Secure' : '';
  return `intelligensicus_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

async function handleAuth(req, res, pathname) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedClientLogHosts.has(host)) { res.writeHead(403, securityHeaders).end('Forbidden'); return; }
  if (pathname === '/api/auth/avatar') {
    const user = authStore.getSession(sessionToken(req));
    if (!user) { res.writeHead(401, securityHeaders).end('Authentication required'); return; }
    if (req.method === 'GET') {
      const avatar = authStore.getAvatar(user.id);
      if (!avatar) { res.writeHead(404, securityHeaders).end('Profile image not set'); return; }
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': avatar.mime,
        'Content-Length': avatar.data.length,
        'Cache-Control': 'private, no-store',
        'Cross-Origin-Resource-Policy': 'same-origin'
      }).end(avatar.data);
      return;
    }
    if (req.method === 'PUT') {
      const payload = await readAuthJson(req, res, host, 3 * 1024 * 1024);
      if (payload === null) return;
      try {
        const updatedUser = authStore.setAvatar(user.id, payload.mime, payload.data);
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ user: updatedUser }));
      } catch (error) {
        const invalidImage = ['Choose a PNG, JPEG, or WebP image smaller than 2 MiB', 'Profile image must be smaller than 2 MiB', 'Image content does not match the selected file type'].includes(error.message);
        if (invalidImage) res.writeHead(400, securityHeaders).end(error.message);
        else throw error;
      }
      return;
    }
    if (req.method === 'DELETE') {
      if (req.headers.origin !== originForHost(host)) { res.writeHead(403, securityHeaders).end('Forbidden'); return; }
      const updatedUser = authStore.removeAvatar(user.id);
      res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ user: updatedUser }));
      return;
    }
    res.writeHead(405, { Allow: 'GET, PUT, DELETE', ...securityHeaders }).end('Method not allowed');
    return;
  }
  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = authStore.getSession(sessionToken(req));
    res.writeHead(user ? 200 : 401, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(user ? { user } : { error: 'Not authenticated' }));
    return;
  }
  if (pathname === '/api/projects' && ['GET', 'POST'].includes(req.method)) {
    const user = authStore.getSession(sessionToken(req));
    if (!user) { res.writeHead(401, securityHeaders).end('Authentication required'); return; }
    if (req.method === 'GET') {
      res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ projects: authStore.listProjects(user.id) }));
      return;
    }
    const payload = await readAuthJson(req, res, host);
    if (payload === null) return;
    try {
      const project = authStore.createProject(user.id, payload);
      res.writeHead(201, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ project }));
    } catch (error) {
      res.writeHead(400, securityHeaders).end(error.message);
    }
    return;
  }
  const projectResource = pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
  if (projectResource && req.method === 'DELETE') {
    const user = authStore.getSession(sessionToken(req));
    if (!user) { res.writeHead(401, securityHeaders).end('Authentication required'); return; }
    try { authStore.deleteProject(projectResource[1], user.id); res.writeHead(204, securityHeaders).end(); }
    catch (error) { res.writeHead(error.message === 'Project access denied' ? 403 : 400, securityHeaders).end(error.message); }
    return;
  }
  const projectRoute = pathname.match(/^\/api\/projects\/([0-9a-f-]+)\/(members|ownership|data)$/i);
  if (projectRoute) {
    const user = authStore.getSession(sessionToken(req));
    if (!user) { res.writeHead(401, securityHeaders).end('Authentication required'); return; }
    const [, projectId, resource] = projectRoute;
    try {
      if (resource === 'members' && req.method === 'GET') {
        const members = authStore.listProjectMembers(projectId, user.id);
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ members }));
        return;
      }
      if (resource === 'members' && req.method === 'POST') {
        const payload = await readAuthJson(req, res, host);
        if (payload === null) return;
        const member = authStore.addProjectMember(projectId, user.id, payload.email, payload.role);
        res.writeHead(201, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ member }));
        return;
      }
      if (resource === 'data' && req.method === 'GET') {
        const result = authStore.getProjectData(projectId, user.id);
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }
      if (resource === 'data' && req.method === 'PUT') {
        const payload = await readAuthJson(req, res, host, 8 * 1024 * 1024);
        if (payload === null) return;
        const result = authStore.saveProjectData(projectId, user.id, payload.project, payload.expectedVersion);
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }
      if (resource === 'ownership' && req.method === 'POST') {
        const payload = await readAuthJson(req, res, host);
        if (payload === null) return;
        const result = authStore.transferProjectOwnership(projectId, user.id, payload.nextOwnerId);
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, securityHeaders).end('Not found');
    } catch (error) {
      const forbidden = error.message === 'Project access denied';
      const conflict = ['Account not found', 'User is already a project member', 'Project code already exists for the new owner', 'Choose an existing project member', 'Project data conflict'].includes(error.message);
      res.writeHead(forbidden || error.message === 'Project is read-only' ? 403 : conflict ? 409 : 400, securityHeaders).end(error.message);
    }
    return;
  }
  if (req.method !== 'POST' || !['/api/auth/register', '/api/auth/login', '/api/auth/logout', '/api/auth/change-password'].includes(pathname)) {
    res.writeHead(404, securityHeaders).end('Not found'); return;
  }
  if (req.headers.origin !== originForHost(host) || String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(403, securityHeaders).end('Forbidden'); return;
  }
  if (pathname === '/api/auth/logout') {
    authStore.logout(sessionToken(req));
    res.writeHead(204, { ...securityHeaders, 'Set-Cookie': sessionCookie('', host, 0) }).end();
    return;
  }
  if (pathname === '/api/auth/change-password') {
    if (req.headers.origin !== originForHost(host) || String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      res.writeHead(403, securityHeaders).end('Forbidden');
      return;
    }
    const user = authStore.getSession(sessionToken(req));
    if (!user) { res.writeHead(401, securityHeaders).end('Authentication required'); return; }
    const now = Date.now();
    if (now - authAttempts.startedAt >= 15 * 60 * 1000) { authAttempts.startedAt = now; authAttempts.count = 0; }
    if (authAttempts.count >= 20) { res.writeHead(429, { ...securityHeaders, 'Retry-After': '900' }).end('Too many requests'); return; }
    authAttempts.count++;
    let payload;
    try { payload = await readAuthJson(req, res, host); }
    catch { if (!res.headersSent) res.writeHead(400, securityHeaders).end('Invalid request'); return; }
    if (payload === null) return;
    try {
      const session = await authStore.changePassword(user.id, payload.currentPassword, payload.newPassword);
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': sessionCookie(session.token, host)
      }).end(JSON.stringify({ user: session.user }));
    } catch (error) {
      const invalidPassword = error.message === 'New password must be at least 12 characters and no more than 1024 UTF-8 bytes';
      res.writeHead(invalidPassword ? 400 : 401, securityHeaders).end(error.message);
    }
    return;
  }
  const now = Date.now();
  if (now - authAttempts.startedAt >= 15 * 60 * 1000) { authAttempts.startedAt = now; authAttempts.count = 0; }
  if (authAttempts.count >= 20) { res.writeHead(429, { ...securityHeaders, 'Retry-After': '900' }).end('Too many requests'); return; }
  authAttempts.count++;
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 4096) { res.writeHead(413, securityHeaders).end('Request too large'); req.resume(); return; }
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400, securityHeaders).end('Invalid request'); return; }
  try {
    if (pathname === '/api/auth/register') {
      const user = await authStore.register(payload);
      res.writeHead(201, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ user }));
      return;
    }
    const session = await authStore.login(payload);
    if (!session) { res.writeHead(401, securityHeaders).end('Invalid email or password'); return; }
    res.writeHead(200, {
      ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': sessionCookie(session.token, host)
    }).end(JSON.stringify({ user: session.user }));
  } catch (error) {
    const known = ['Invalid email address', 'Password must be at least 12 characters and no more than 1024 UTF-8 bytes', 'Name must be between 1 and 100 characters', 'Account already exists'];
    if (known.includes(error.message)) { res.writeHead(error.message === 'Account already exists' ? 409 : 400, securityHeaders).end(error.message); return; }
    logger.error('auth_request_failed', { code: error.code || 'UNKNOWN' });
    res.writeHead(500, securityHeaders).end('Authentication unavailable');
  }
}

async function readAuthJson(req, res, host, maxBytes = 4096) {
  if (!['POST', 'PUT'].includes(req.method) || req.headers.origin !== originForHost(host) || String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(403, securityHeaders).end('Forbidden'); return null;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) { res.writeHead(413, securityHeaders).end('Request too large'); req.resume(); return null; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400, securityHeaders).end('Invalid request'); return null; }
}

async function receiveClientLog(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  const origin = String(req.headers.origin || '');
  let originMatchesHost = false;
  try { originMatchesHost = new URL(origin).origin === originForHost(host); }
  catch { originMatchesHost = false; }
  if (!allowedClientLogHosts.has(host) || !originMatchesHost) {
    res.writeHead(403, securityHeaders).end('Forbidden');
    return;
  }
  if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    res.writeHead(415, securityHeaders).end('Unsupported media type');
    return;
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxClientLogBytes) {
    res.writeHead(413, securityHeaders).end('Payload too large');
    return;
  }
  const now = Date.now();
  if (now - clientLogWindowStartedAt >= 60_000) {
    clientLogWindowStartedAt = now;
    clientLogRequestsThisWindow = 0;
  }
  if (clientLogRequestsThisWindow >= 60) {
    res.writeHead(429, securityHeaders).end('Too many requests');
    return;
  }
  clientLogRequestsThisWindow += 1;

  const timeout = setTimeout(() => req.destroy(), 5000);
  timeout.unref();
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxClientLogBytes) {
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      if (!tooLarge) chunks.push(chunk);
    }
  } catch (error) {
    if (!res.headersSent) res.writeHead(400, securityHeaders).end('Bad request');
    return;
  } finally {
    clearTimeout(timeout);
  }
  if (tooLarge) {
    res.writeHead(413, securityHeaders).end('Payload too large');
    return;
  }

  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    res.writeHead(400, securityHeaders).end('Bad request');
    return;
  }
  const eventLevels = {
    window_error: 'ERROR',
    unhandled_rejection: 'WARN',
    console_error: 'ERROR',
    fetch_failure: 'WARN'
  };
  if (!payload || !Object.hasOwn(eventLevels, payload.type)) {
    res.writeHead(400, securityHeaders).end('Invalid client log event');
    return;
  }

  let source = '';
  if (typeof payload.source === 'string') {
    try {
      const sourceUrl = new URL(payload.source, origin);
      source = sourceUrl.origin === origin ? sourceUrl.pathname.slice(0, 300) : '<external>';
    } catch { source = '<invalid>'; }
  }
  const fields = {
    clientTimestamp: typeof payload.timestamp === 'string' ? payload.timestamp.slice(0, 40) : null,
    name: typeof payload.name === 'string' ? payload.name.slice(0, 80) : 'Error',
    message: typeof payload.message === 'string' ? payload.message.slice(0, 1000) : '',
    source,
    line: Number.isSafeInteger(payload.line) ? payload.line : null,
    column: Number.isSafeInteger(payload.column) ? payload.column : null,
    status: Number.isInteger(payload.status) ? payload.status : null,
    method: typeof payload.method === 'string' ? payload.method.slice(0, 12).toUpperCase() : null,
    stack: typeof payload.stack === 'string' ? payload.stack.slice(0, 4000) : ''
  };
  const level = payload.type === 'fetch_failure' && fields.status >= 500 ? 'ERROR' : eventLevels[payload.type];
  if (level === 'ERROR') clientLogger.error(`frontend_${payload.type}`, fields);
  else clientLogger.warn(`frontend_${payload.type}`, fields);
  res.writeHead(204, securityHeaders).end();
}

createServer(async (req, res) => {
  const startedAt = Date.now();
  let requestPath = '/<invalid-url>';
  res.once('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http_request_completed', {
      method: req.method || 'GET',
      path: requestPath,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  let pathname;
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
  catch { res.writeHead(400, securityHeaders).end('Bad request'); return; }
  requestPath = pathname.slice(0, 512);
  if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/projects')) {
    try { await handleAuth(req, res, pathname); }
    catch (error) { logger.error('auth_request_failed', { code: error.code || 'UNKNOWN' }); if (!res.headersSent) res.writeHead(500, securityHeaders).end('Authentication unavailable'); }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/client-log') {
    await receiveClientLog(req, res);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
    res.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders }).end('Method not allowed');
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, app: 'Intelligensicus', bind: '127.0.0.1' }));
    return;
  }
  if (pathname === '/downloads/intelligensicus-win-x64.exe') {
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      res.writeHead(405, { Allow: 'GET, HEAD', ...securityHeaders }).end('Method not allowed');
      return;
    }
    const installerPath = path.resolve(process.env.INTELLIGENSICUS_INSTALLER_PATH || path.join(root, 'release', 'Intelligensicus-Setup-0.1.0-win-x64.exe'));
    try {
      const installer = await stat(installerPath);
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': installer.size,
        'Content-Disposition': 'attachment; filename="Intelligensicus-Setup-0.1.0-win-x64.exe"',
        'Cache-Control': 'public, max-age=300'
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(installerPath);
      stream.on('error', error => {
        logger.error('desktop_installer_stream_failed', { code: error.code || 'UNKNOWN' });
        if (!res.headersSent) res.writeHead(500, securityHeaders).end('Installer unavailable');
        else res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        res.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' }).end('Windows installer is not available yet.');
      } else {
        logger.error('desktop_installer_stat_failed', { code: error.code || 'UNKNOWN' });
        res.writeHead(500, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' }).end('Installer unavailable');
      }
    }
    return;
  }
  let relative;
  try { relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch { res.writeHead(400, securityHeaders).end('Bad request'); return; }
  if (relative.includes('\\') || relative.split('/').some(segment => segment === '.' || segment === '..')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders }).end('Not found');
    return;
  }
  if (!allowedFile(relative)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders }).end('Not found');
    return;
  }
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403, securityHeaders).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      ...securityHeaders
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const safePath = relative.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);
    const safeMessage = String(error.message || 'Unknown file read error').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
    logger.error('static_file_read_failed', { path: safePath, code: error.code || 'UNKNOWN', message: safeMessage });
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders }).end('Internal server error');
  }
}).listen(port, '127.0.0.1', () => {
  logger.info('server_started', { bind: '127.0.0.1', port });
});