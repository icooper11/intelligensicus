(() => {
  const maxReportsPerMinute = 20;
  let windowStartedAt = Date.now();
  let reportsThisWindow = 0;
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  function safeText(value, maxLength) {
    return String(value || '')
      .replace(/[\u0000-\u001f\u007f]/g, '?')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/([?&](?:access_token|auth|token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/\b((?:authorization|cookie|password|secret|token|[\w-]*api[\w-]*key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .slice(0, maxLength);
  }

  function localSourcePath(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const source = new URL(value, window.location.href);
      return source.origin === window.location.origin ? source.pathname.slice(0, 300) : '<external>';
    } catch {
      return '<invalid>';
    }
  }

  function report(type, details) {
    const now = Date.now();
    if (now - windowStartedAt >= 60_000) {
      windowStartedAt = now;
      reportsThisWindow = 0;
    }
    if (reportsThisWindow >= maxReportsPerMinute) return;
    reportsThisWindow += 1;

    const body = JSON.stringify({ type, timestamp: new Date().toISOString(), ...details });
    if (body.length > 12_000) return;
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body
    }).catch(() => {});
  }

  function summarizeConsoleArgs(args) {
    return args.map(value => {
      if (value instanceof Error) return `${value.name}: ${safeText(value.message, 500)}${value.stack ? `\n${safeText(value.stack, 2500)}` : ''}`;
      if (typeof value === 'string') return safeText(value, 500);
      try { return safeText(JSON.stringify(value), 500); }
      catch { return '[unserializable console value]'; }
    }).join(' ').slice(0, 1000);
  }

  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    report('console_error', {
      name: 'ConsoleError', message: summarizeConsoleArgs(args),
      source: location.pathname, line: null, column: null, stack: ''
    });
    if (isLocalHost) originalConsoleError(...args);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const request = args[0];
    const requestUrl = request instanceof Request ? request.url : String(request || '');
    const requestPath = localSourcePath(requestUrl);
    const method = String(args[1]?.method || (request instanceof Request ? request.method : 'GET')).toUpperCase();
    if (requestPath === '/api/client-log') return originalFetch(...args);
    try {
      const response = await originalFetch(...args);
      if (!response.ok) {
        report('fetch_failure', {
          name: 'HTTPError', message: `${method} ${requestPath} returned ${response.status}`,
          source: requestPath, line: null, column: null, stack: '', status: response.status, method
        });
      }
      return response;
    } catch (error) {
      report('fetch_failure', {
        name: safeText(error?.name || 'NetworkError', 80),
        message: safeText(`${method} ${requestPath}: ${error?.message || 'network request failed'}`, 1000),
        source: requestPath, line: null, column: null, stack: safeText(error?.stack || '', 2500), method
      });
      throw error;
    }
  };

  window.addEventListener('error', event => {
    if (!(event instanceof ErrorEvent) || !event.message) return;
    report('window_error', {
      name: safeText(event.error?.name || 'Error', 80),
      message: safeText(event.message, 1000),
      source: localSourcePath(event.filename),
      line: Number.isSafeInteger(event.lineno) ? event.lineno : null,
      column: Number.isSafeInteger(event.colno) ? event.colno : null,
      stack: safeText(event.error?.stack || '', 4000)
    });
  });

  window.addEventListener('unhandledrejection', event => {
    const reason = event.reason;
    if (reason instanceof Error) {
      report('unhandled_rejection', {
        name: safeText(reason.name, 80),
        message: safeText(reason.message, 1000),
        source: localSourcePath(reason.stack?.match(/https?:\/\/[^\s)]+/)?.[0] || ''),
        stack: safeText(reason.stack || '', 4000)
      });
    } else {
      report('unhandled_rejection', {
        name: 'UnhandledRejection',
        message: typeof reason === 'string' ? safeText(reason, 1000) : 'Non-error rejection value',
        source: '',
        stack: ''
      });
    }
  });
})();