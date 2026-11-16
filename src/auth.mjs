import { randomBytes, randomUUID, scrypt as scryptCallback, createHash, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 12 * 60 * 60 * 1000;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_HASH = Buffer.alloc(64);

function normalizedEmail(value) {
  if (typeof value !== 'string') throw new Error('Invalid email address');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email address');
  return email;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 1024;
}

function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthStore(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at INTEGER NOT NULL,
      avatar_mime TEXT, avatar_data BLOB
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
      data_json TEXT, data_version INTEGER NOT NULL DEFAULT 0, data_updated_at INTEGER,
      UNIQUE(owner_id, code)
    );
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY(project_id, user_id)
    );
  `);
  const userColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  if (!userColumns.has('avatar_mime')) database.exec('ALTER TABLE users ADD COLUMN avatar_mime TEXT');
  if (!userColumns.has('avatar_data')) database.exec('ALTER TABLE users ADD COLUMN avatar_data BLOB');
  const projectColumns = new Set(database.prepare('PRAGMA table_info(projects)').all().map(column => column.name));
  if (!projectColumns.has('data_json')) database.exec('ALTER TABLE projects ADD COLUMN data_json TEXT');
  if (!projectColumns.has('data_version')) database.exec('ALTER TABLE projects ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0');
  if (!projectColumns.has('data_updated_at')) database.exec('ALTER TABLE projects ADD COLUMN data_updated_at INTEGER');
  const findUser = database.prepare('SELECT * FROM users WHERE email = ?');
  const findUserById = database.prepare('SELECT * FROM users WHERE id = ?');
  const addUser = database.prepare('INSERT INTO users (id, email, name, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const addSession = database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
  const findSession = database.prepare('SELECT users.id, users.email, users.name, users.avatar_mime, sessions.expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?');
  const deleteSession = database.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const deleteExpired = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const memberRole = database.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?');
  const selectProject = database.prepare('SELECT id, code, name, owner_id, created_at, data_json, data_version, data_updated_at FROM projects WHERE id = ?');

  function requireOwner(projectId, userId) {
    if (memberRole.get(projectId, userId)?.role !== 'owner') throw new Error('Project access denied');
  }

  function transaction(operation) {
    database.exec('BEGIN IMMEDIATE');
    try { const result = operation(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }

  return {
    async register({ email, password, name } = {}) {
      email = normalizedEmail(email);
      if (!validPassword(password)) throw new Error('Password must be at least 12 characters and no more than 1024 UTF-8 bytes');
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Name must be between 1 and 100 characters');
      const salt = randomBytes(16);
      const hash = await scrypt(password, salt, 64, SCRYPT_OPTIONS);
      const id = randomUUID();
      try { addUser.run(id, email, name.trim(), salt, hash, Date.now()); }
      catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' && error.message.includes('UNIQUE constraint failed')) throw new Error('Account already exists');
        throw error;
      }
      return { id, email, name: name.trim(), hasAvatar: false };
    },
    async login({ email, password } = {}) {
      let normalized;
      try { normalized = normalizedEmail(email); } catch { normalized = ''; }
      const user = findUser.get(normalized);
      const candidate = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 1024 ? password : '';
      const salt = user ? Buffer.from(user.password_salt) : DUMMY_SALT;
      const expected = user ? Buffer.from(user.password_hash) : DUMMY_HASH;
      const actual = await scrypt(candidate, salt, 64, SCRYPT_OPTIONS);
      if (!user || expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_MS;
      deleteExpired.run(Date.now());
      addSession.run(sessionHash(token), user.id, expiresAt);
      return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name, hasAvatar: Boolean(user.avatar_mime) } };
    },
    getSession(token) {
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
      const session = findSession.get(sessionHash(token), Date.now());
      return session ? { id: session.id, email: session.email, name: session.name, hasAvatar: Boolean(session.avatar_mime), expiresAt: session.expires_at } : null;
    },
    logout(token) {
      if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) deleteSession.run(sessionHash(token));
    },
    async changePassword(userId, currentPassword, newPassword) {
      if (!validPassword(newPassword)) throw new Error('New password must be at least 12 characters and no more than 1024 UTF-8 bytes');
      const user = findUserById.get(userId);
      const candidate = typeof currentPassword === 'string' && Buffer.byteLength(currentPassword, 'utf8') <= 1024 ? currentPassword : '';
      const salt = user ? Buffer.from(user.password_salt) : DUMMY_SALT;
      const expected = user ? Buffer.from(user.password_hash) : DUMMY_HASH;
      const actual = await scrypt(candidate, salt, 64, SCRYPT_OPTIONS);
      if (!user || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Current password is incorrect');

      const nextSalt = randomBytes(16);
      const nextHash = await scrypt(newPassword, nextSalt, 64, SCRYPT_OPTIONS);
      const token = randomBytes(32).toString('hex');
      const expiresAt = Date.now() + SESSION_MS;
      transaction(() => {
        database.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(nextSalt, nextHash, userId);
        database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
        addSession.run(sessionHash(token), userId, expiresAt);
      });
      return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name, hasAvatar: Boolean(user.avatar_mime) } };
    },
    setAvatar(userId, mime, encodedImage) {
      const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
      if (!supportedTypes.has(mime) || typeof encodedImage !== 'string' || encodedImage.length > 2_800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedImage)) {
        throw new Error('Choose a PNG, JPEG, or WebP image smaller than 2 MiB');
      }
      const image = Buffer.from(encodedImage, 'base64');
      if (!image.length || image.length > 2 * 1024 * 1024) throw new Error('Profile image must be smaller than 2 MiB');
      const validSignature = mime === 'image/png'
        ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
          : image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP';
      if (!validSignature) throw new Error('Image content does not match the selected file type');
      database.prepare('UPDATE users SET avatar_mime = ?, avatar_data = ? WHERE id = ?').run(mime, image, userId);
      const user = findUserById.get(userId);
      if (!user) throw new Error('Account not found');
      return { id: user.id, email: user.email, name: user.name, hasAvatar: true };
    },
    getAvatar(userId) {
      const row = database.prepare('SELECT avatar_mime, avatar_data FROM users WHERE id = ?').get(userId);
      return row?.avatar_data ? { mime: row.avatar_mime, data: Buffer.from(row.avatar_data) } : null;
    },
    removeAvatar(userId) {
      database.prepare('UPDATE users SET avatar_mime = NULL, avatar_data = NULL WHERE id = ?').run(userId);
      const user = findUserById.get(userId);
      if (!user) throw new Error('Account not found');
      return { id: user.id, email: user.email, name: user.name, hasAvatar: false };
    },
    createProject(userId, { id: requestedId, code, name } = {}) {
      if (typeof code !== 'string' || !/^[A-Z]{3}\d{2}$/.test(code) || typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Invalid project details');
      const id = requestedId === undefined ? randomUUID() : requestedId;
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid project ID');
      const createdAt = Date.now();
      return transaction(() => {
        database.prepare('INSERT INTO projects (id, code, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, code, name.trim(), userId, createdAt);
        database.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')").run(id, userId);
        return { id, code, name: name.trim(), ownerId: userId, createdAt, role: 'owner' };
      });
    },
    listProjects(userId) {
      return database.prepare('SELECT p.id, p.code, p.name, p.owner_id AS ownerId, p.created_at AS createdAt, p.data_version AS dataVersion, m.role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at DESC').all(userId);
    },
    getProjectData(projectId, userId) {
      const role = memberRole.get(projectId, userId)?.role;
      if (!role) throw new Error('Project access denied');
      const project = selectProject.get(projectId);
      return {
        project: project.data_json ? JSON.parse(project.data_json) : null,
        version: project.data_version,
        updatedAt: project.data_updated_at,
        role
      };
    },
    saveProjectData(projectId, userId, projectData, expectedVersion) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Invalid project version');
      if (!projectData || typeof projectData !== 'object' || Array.isArray(projectData)) throw new Error('Invalid project data');
      const serialized = JSON.stringify(projectData);
      if (Buffer.byteLength(serialized, 'utf8') > 8 * 1024 * 1024) throw new Error('Project data exceeds the 8 MiB limit');
      return transaction(() => {
        const role = memberRole.get(projectId, userId)?.role;
        if (!role) throw new Error('Project access denied');
        if (role === 'viewer') throw new Error('Project is read-only');
        const project = selectProject.get(projectId);
        if (!project || projectData.id !== project.id || projectData.code !== project.code || projectData.name !== project.name) throw new Error('Project data identity does not match');
        if (project.data_version !== expectedVersion) throw new Error('Project data conflict');
        const updatedAt = Date.now();
        database.prepare('UPDATE projects SET data_json = ?, data_version = data_version + 1, data_updated_at = ? WHERE id = ?').run(serialized, updatedAt, projectId);
        return { version: expectedVersion + 1, updatedAt };
      });
    },
    listProjectMembers(projectId, userId) {
      if (!memberRole.get(projectId, userId)) throw new Error('Project access denied');
      return database.prepare('SELECT u.id, u.email, u.name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name').all(projectId);
    },
    addProjectMember(projectId, ownerId, email, role) {
      requireOwner(projectId, ownerId);
      if (!['editor', 'viewer'].includes(role)) throw new Error('Invalid project role');
      const user = findUser.get(normalizedEmail(email));
      if (!user) throw new Error('Account not found');
      if (memberRole.get(projectId, user.id)) throw new Error('User is already a project member');
      database.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(projectId, user.id, role);
      return { id: user.id, email: user.email, name: user.name, role };
    },
    deleteProject(projectId, ownerId) {
      requireOwner(projectId, ownerId);
      return transaction(() => {
        database.prepare('DELETE FROM project_members WHERE project_id = ?').run(projectId);
        database.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').run(projectId, ownerId);
      });
    },
    transferProjectOwnership(projectId, ownerId, nextOwnerId) {
      return transaction(() => {
        requireOwner(projectId, ownerId);
        if (nextOwnerId === ownerId || !memberRole.get(projectId, nextOwnerId)) throw new Error('Choose an existing project member');
        const project = selectProject.get(projectId);
        const duplicate = database.prepare('SELECT id FROM projects WHERE owner_id = ? AND code = ? AND id <> ?').get(nextOwnerId, project.code, projectId);
        if (duplicate) throw new Error('Project code already exists for the new owner');
        database.prepare("UPDATE project_members SET role = 'editor' WHERE project_id = ? AND user_id = ?").run(projectId, ownerId);
        database.prepare("UPDATE project_members SET role = 'owner' WHERE project_id = ? AND user_id = ?").run(projectId, nextOwnerId);
        database.prepare('UPDATE projects SET owner_id = ? WHERE id = ?').run(nextOwnerId, projectId);
        return { id: projectId, ownerId: nextOwnerId };
      });
    },
    close() { database.close(); }
  };
}