const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 5513;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let serverProcess;
let mainWindow;

function writeDesktopLog(level, event, details = {}) {
  try {
    const root = path.join(app.getPath('userData'), 'logs', 'electron');
    fs.mkdirSync(root, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'electron', event, ...details });
    fs.appendFileSync(path.join(root, `combined-${date}.log`), `${line}\n`, 'utf8');
    if (level === 'ERROR') fs.appendFileSync(path.join(root, `error-${date}.log`), `${line}\n`, 'utf8');
  } catch {}
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error('The local research service stopped during startup.');
    try {
      const response = await fetch(`${ORIGIN}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error('The local research service did not become ready.');
}

function startServer() {
  const runtimeRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : app.getAppPath();
  serverProcess = spawn(process.execPath, [path.join(runtimeRoot, 'server.mjs')], {
    cwd: runtimeRoot,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      INTELLIGENSICUS_AUTH_DIR: app.getPath('userData'),
      INTELLIGENSICUS_LOG_DIR: path.join(app.getPath('userData'), 'logs'),
      INTELLIGENSICUS_ALLOWED_HOSTS: ''
    },
    stdio: 'ignore'
  });
  serverProcess.once('error', error => writeDesktopLog('ERROR', 'research_server_spawn_failed', { code: error.code || 'UNKNOWN' }));
  serverProcess.once('exit', (code, signal) => {
    if (!app.isQuitting) writeDesktopLog('ERROR', 'research_server_exited', { code, signal });
  });
}

async function openWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    title: 'Intelligensicus Wildlife Research',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeDesktopLog('ERROR', 'renderer_process_gone', { reason: details.reason, exitCode: details.exitCode });
  });
  await mainWindow.loadURL(ORIGIN);
}

app.setName('Intelligensicus');
app.setAppUserModelId('org.intelligensicus.research');
app.isQuitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      let permittedOrigin = false;
      try { permittedOrigin = new URL(webContents.getURL()).origin === ORIGIN; } catch {}
      callback(permittedOrigin && ['media', 'audioCapture', 'videoCapture'].includes(permission));
    });
    try {
      startServer();
      await waitForServer();
      await openWindow();
      writeDesktopLog('INFO', 'desktop_started', { port: PORT });
    } catch (error) {
      writeDesktopLog('ERROR', 'desktop_start_failed', { message: String(error.message || 'Unknown startup error').slice(0, 500) });
      dialog.showErrorBox('Intelligensicus could not start', error.message);
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    serverProcess?.kill();
    writeDesktopLog('INFO', 'desktop_stopped');
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
