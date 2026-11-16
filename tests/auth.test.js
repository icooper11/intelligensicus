import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthStore } from '../src/auth.mjs';

test('accounts persist and sessions are revocable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intelligensicus-auth-'));
  let store = createAuthStore(path.join(directory, 'accounts.sqlite'));
  try {
    const user = await store.register({ name: 'Researcher', email: 'Researcher@example.org', password: 'a long test password' });
    assert.equal(user.email, 'researcher@example.org');
    assert.equal(await store.login({ email: user.email, password: 'incorrect password' }), null);
    assert.equal(await store.login({ email: 'unknown@example.org', password: 'a long test password' }), null);
    const session = await store.login({ email: user.email, password: 'a long test password' });
    assert.equal(store.getSession(session.token).id, user.id);
    store.close();
    store = createAuthStore(path.join(directory, 'accounts.sqlite'));
    assert.equal(store.getSession(session.token).id, user.id);
    store.logout(session.token);
    assert.equal(store.getSession(session.token), null);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration validates input and refuses duplicate accounts', async () => {
  const store = createAuthStore(':memory:');
  try {
    await assert.rejects(store.register({ name: 'Researcher', email: 'bad', password: 'a long test password' }), /email/);
    await assert.rejects(store.register({ name: 'Researcher', email: 'researcher@example.org', password: 'short' }), /Password/);
    await store.register({ name: 'Researcher', email: 'researcher@example.org', password: 'a long test password' });
    await assert.rejects(store.register({ name: 'Researcher', email: 'RESEARCHER@example.org', password: 'a long test password' }), /already exists/);
    assert.equal(store.getSession('invalid'), null);
  } finally { store.close(); }
});

test('password changes require the current password and revoke prior sessions', async () => {
  const store = createAuthStore(':memory:');
  try {
    const user = await store.register({ name: 'Researcher', email: 'password@example.org', password: 'original passphrase 2026' });
    const previousSession = await store.login({ email: user.email, password: 'original passphrase 2026' });
    await assert.rejects(store.changePassword(user.id, 'incorrect passphrase', 'replacement passphrase 2026'), /Current password is incorrect/);
    await assert.rejects(store.changePassword(user.id, 'original passphrase 2026', 'short'), /New password/);
    const replacement = await store.changePassword(user.id, 'original passphrase 2026', 'replacement passphrase 2026');
    assert.equal(store.getSession(previousSession.token), null);
    assert.equal(store.getSession(replacement.token).id, user.id);
    assert.equal(await store.login({ email: user.email, password: 'original passphrase 2026' }), null);
    assert.ok(await store.login({ email: user.email, password: 'replacement passphrase 2026' }));
  } finally { store.close(); }
});

test('profile avatars accept bounded raster images and remain removable', async () => {
  const store = createAuthStore(':memory:');
  try {
    const user = await store.register({ name: 'Researcher', email: 'avatar@example.org', password: 'researcher passphrase 2026' });
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
    const updated = store.setAvatar(user.id, 'image/png', png);
    assert.equal(updated.hasAvatar, true);
    assert.equal(store.getSession((await store.login({ email: user.email, password: 'researcher passphrase 2026' })).token).hasAvatar, true);
    assert.equal(store.getAvatar(user.id).mime, 'image/png');
    assert.throws(() => store.setAvatar(user.id, 'image/svg+xml', '<svg/>'), /PNG, JPEG, or WebP/);
    assert.throws(() => store.setAvatar(user.id, 'image/png', Buffer.from('<svg/>').toString('base64')), /does not match/);
    assert.equal(store.removeAvatar(user.id).hasAvatar, false);
    assert.equal(store.getAvatar(user.id), null);
  } finally { store.close(); }
});

test('project access and ownership are enforced by persisted membership', async () => {
  const store = createAuthStore(':memory:');
  try {
    const owner = await store.register({ name: 'Owner', email: 'owner@example.org', password: 'a long test password' });
    const editor = await store.register({ name: 'Editor', email: 'editor@example.org', password: 'a long test password' });
    const outsider = await store.register({ name: 'Outsider', email: 'outsider@example.org', password: 'a long test password' });
    const project = store.createProject(owner.id, { code: 'PRJ01', name: 'Research project' });
    assert.equal(store.listProjects(outsider.id).length, 0);
    assert.throws(() => store.listProjectMembers(project.id, outsider.id), /access denied/);
    store.addProjectMember(project.id, owner.id, editor.email, 'editor');
    assert.equal(store.listProjects(editor.id)[0].role, 'editor');
    assert.throws(() => store.addProjectMember(project.id, editor.id, outsider.email, 'viewer'), /access denied/);
    assert.throws(() => store.transferProjectOwnership(project.id, owner.id, outsider.id), /existing project member/);
    store.transferProjectOwnership(project.id, owner.id, editor.id);
    assert.equal(store.listProjects(editor.id)[0].role, 'owner');
    assert.equal(store.listProjects(owner.id)[0].role, 'editor');
    assert.throws(() => store.addProjectMember(project.id, owner.id, outsider.email, 'viewer'), /access denied/);
  } finally { store.close(); }
});

test('existing account databases gain project-record columns without losing membership', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'intelligensicus-auth-migration-'));
  const filename = path.join(directory, 'accounts.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
      UNIQUE(owner_id, code)
    );
    CREATE TABLE project_members (
      project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('owner', 'editor', 'viewer')),
      PRIMARY KEY(project_id, user_id)
    );
    INSERT INTO users VALUES ('legacy-user', 'legacy@example.org', 'Legacy Researcher', X'00', X'00', 1);
    INSERT INTO projects VALUES ('550e8400-e29b-41d4-a716-446655440000', 'PRJ01', 'Legacy project', 'legacy-user', 1);
    INSERT INTO project_members VALUES ('550e8400-e29b-41d4-a716-446655440000', 'legacy-user', 'owner');
  `);
  legacy.close();
  const store = createAuthStore(filename);
  try {
    const [project] = store.listProjects('legacy-user');
    assert.equal(project.name, 'Legacy project');
    assert.equal(project.role, 'owner');
    const data = store.getProjectData(project.id, 'legacy-user');
    assert.equal(data.project, null);
    assert.equal(data.version, 0);
    const saved = store.saveProjectData(project.id, 'legacy-user', {
      id: project.id, code: project.code, name: project.name, animals: [], events: []
    }, 0);
    assert.equal(saved.version, 1);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});