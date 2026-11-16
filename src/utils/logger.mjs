import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const logRoot = path.resolve(process.env.INTELLIGENSICUS_LOG_DIR || path.resolve(moduleDirectory, '../../../logs/intelligensicus'));
const levels = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const configuredLevel = String(process.env.LOG_LEVEL || 'INFO').toUpperCase();
const minimumLevel = levels[configuredLevel] ?? levels.INFO;
const sensitiveField = /authorization|cookie|password|secret|token|api.?key/i;
const activeStreams = new Map();

function safeText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|auth|token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b((?:authorization|cookie|password|secret|token|[\w-]*api[\w-]*key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeValue(value, key = '') {
  if (sensitiveField.test(key)) return '[REDACTED]';
  if (value instanceof Error) {
    return {
      name: safeText(value.name),
      message: safeText(value.message),
      code: value.code || null,
      stack: value.stack ? safeText(value.stack) : null
    };
  }
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(item => safeValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, safeValue(item, field)]));
  }
  return value;
}

function getDailyStreams(serviceName) {
  const date = new Date().toISOString().slice(0, 10);
  const active = activeStreams.get(serviceName);
  if (active?.date === date) return active.streams;
  if (active) {
    active.streams.combined.end();
    active.streams.error.end();
  }

  const serviceLogRoot = path.join(logRoot, serviceName);
  fs.mkdirSync(serviceLogRoot, { recursive: true });
  const streams = {
    combined: fs.createWriteStream(path.join(serviceLogRoot, `combined-${date}.log`), { flags: 'a' }),
    error: fs.createWriteStream(path.join(serviceLogRoot, `error-${date}.log`), { flags: 'a' })
  };
  for (const stream of Object.values(streams)) {
    stream.on('error', error => {
      const notice = JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', event: 'log_write_failed', code: error.code || 'UNKNOWN' });
      process.stderr.write(`${notice}\n`);
    });
  }
  activeStreams.set(serviceName, { date, streams });
  return streams;
}

export function createLogger(service = 'server') {
  const serviceName = safeText(service).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);

  function emit(level, event, fields = {}) {
    if (levels[level] < minimumLevel) return;
    const record = safeValue({
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      event: safeText(event),
      ...fields
    });
    const line = JSON.stringify(record);
    const streams = getDailyStreams(serviceName);
    try {
      streams.combined.write(`${line}\n`);
      if (level === 'ERROR') streams.error.write(`${line}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', event: 'log_write_failed', code: error.code || 'UNKNOWN' })}\n`);
    }
    const consoleMethod = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[consoleMethod](line);
  }

  return {
    debug: (event, fields) => emit('DEBUG', event, fields),
    info: (event, fields) => emit('INFO', event, fields),
    warn: (event, fields) => emit('WARN', event, fields),
    error: (event, fields) => emit('ERROR', event, fields)
  };
}

process.on('exit', () => {
  for (const { streams } of activeStreams.values()) {
    streams.combined.end();
    streams.error.end();
  }
});