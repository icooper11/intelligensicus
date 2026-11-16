import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function saveEvidenceTransfer(');
const end = source.indexOf('\nasync function saveEvidenceUploads(', start);
if (start < 0 || end < 0) throw new Error('Evidence transfer helper not found');

function fixture() {
  const records = {
    evidence: new Map([
      ['source', { id: 'source', projectId: 'original', blob: 'media' }],
      ['occupied', { id: 'occupied', projectId: 'other', blob: 'existing' }]
    ]),
    workspace: new Map([['root', { id: 'root', projects: [{ id: 'original' }] }]])
  };
  const state = { projects: [{ id: 'destination' }], connectivity: [], appearance: {}, userReferences: [] };
  let closed = false;
  const database = {
    close() { closed = true; },
    transaction(names, mode) {
      assert.deepEqual(Array.from(names), ['evidence', 'workspace']);
      assert.equal(mode, 'readwrite');
      const pending = [];
      const transaction = {
        error: null,
        aborted: false,
        abort() { this.aborted = true; },
        objectStore(name) {
          return {
            get(id) {
              const request = { result: records[name].get(id) };
              queueMicrotask(() => {
                request.onsuccess();
                if (!transaction.aborted) {
                  for (const operation of pending) {
                    if (operation.add && records[operation.name].has(operation.value.id)) {
                      transaction.error = new Error('Duplicate key');
                      transaction.aborted = true;
                      break;
                    }
                  }
                }
                if (transaction.aborted) transaction.onabort();
                else {
                  for (const operation of pending) records[operation.name].set(operation.value.id, operation.value);
                  transaction.oncomplete();
                }
              });
              return request;
            },
            add(value) { pending.push({ name, value, add: true }); },
            put(value) { pending.push({ name, value, add: false }); }
          };
        }
      };
      return transaction;
    }
  };
  const transfer = runInNewContext(`(${source.slice(start, end)})`, {
    openMediaDatabase: async () => database, state, Date, Error, workspaceRevision: 0,
    queueWorkspaceWrite(transaction, expectedRevision, onConflict) {
      if ((records.workspace.get('root')?.revision || 0) !== expectedRevision) {
        onConflict();
        transaction.abort();
        return;
      }
      transaction.objectStore('workspace').put({ id: 'root', projects: state.projects, revision: expectedRevision + 1 });
    }
  });
  return { records, transfer, isClosed: () => closed };
}

test('evidence copy commits media and workspace together', async () => {
  const { records, transfer, isClosed } = fixture();
  await transfer('source', 'copy', 'original', 'destination', 'copy');
  assert.equal(records.evidence.get('source').projectId, 'original');
  assert.equal(records.evidence.get('copy').projectId, 'destination');
  assert.equal(records.workspace.get('root').projects[0].id, 'destination');
  assert.equal(isClosed(), true);
});

test('evidence move updates ownership and workspace together', async () => {
  const { records, transfer } = fixture();
  await transfer('source', 'source', 'original', 'destination', 'move');
  assert.equal(records.evidence.get('source').projectId, 'destination');
  assert.equal(records.workspace.get('root').projects[0].id, 'destination');
});

test('a failed copy leaves media and workspace unchanged', async () => {
  const { records, transfer, isClosed } = fixture();
  await assert.rejects(transfer('source', 'occupied', 'original', 'destination', 'copy'), /Duplicate key/);
  assert.equal(records.evidence.get('source').projectId, 'original');
  assert.equal(records.evidence.get('occupied').projectId, 'other');
  assert.equal(records.workspace.get('root').projects[0].id, 'original');
  assert.equal(isClosed(), true);
});

test('a transfer rejects evidence belonging to another project', async () => {
  const { records, transfer } = fixture();
  await assert.rejects(transfer('source', 'copy', 'wrong-project', 'destination', 'copy'), /unavailable in this project/);
  assert.equal(records.evidence.has('copy'), false);
  assert.equal(records.workspace.get('root').projects[0].id, 'original');
});

test('a stale transfer leaves media ownership and workspace unchanged', async () => {
  const { records, transfer } = fixture();
  records.workspace.set('root', { id: 'root', revision: 1, projects: [{ id: 'newer' }] });
  await assert.rejects(transfer('source', 'source', 'original', 'destination', 'move'), /Workspace changed in another tab/);
  assert.equal(records.evidence.get('source').projectId, 'original');
  assert.equal(records.workspace.get('root').projects[0].id, 'newer');
});

test('moving evidence preserves the original event and individual history', () => {
  const historyStart = source.indexOf('function preserveMovedEvidence(');
  const historyEnd = source.indexOf('\nfunction openEvidenceTransfer(', historyStart);
  assert.ok(historyStart >= 0 && historyEnd > historyStart);
  const preserve = runInNewContext(`(${source.slice(historyStart, historyEnd)})`);
  const original = { id: 'event-1', type: 'evidence', mediaId: 'media-1', animalId: 'animal-1', detail: 'Original notes', at: '2026-01-01' };
  const unrelated = { id: 'event-2', type: 'observation' };
  const result = preserve([original, unrelated], 'event-1', { id: 'destination', code: 'DST01' }, '2026-02-01');
  assert.equal(result.length, 2);
  assert.equal(result[0].id, original.id);
  assert.equal(result[0].mediaId, original.mediaId);
  assert.equal(result[0].animalId, original.animalId);
  assert.equal(result[0].detail, original.detail);
  assert.equal(result[0].at, original.at);
  assert.equal(result[0].movedToProjectId, 'destination');
  assert.equal(result[0].movedToProjectCode, 'DST01');
  assert.equal(result[0].movedAt, '2026-02-01');
  assert.equal(result[1], unrelated);
  assert.equal(original.movedToProjectId, undefined);
});

test('metadata exports include the moved evidence destination', () => {
  const exportStart = source.indexOf('function exportEventTime(');
  const exportEnd = source.indexOf('\nfunction safeArchiveFileName(', exportStart);
  const markdownStart = source.indexOf('function mediaManifestMarkdown(');
  const markdownEnd = source.indexOf('\nfunction openProjectExport(', markdownStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart && markdownStart >= 0 && markdownEnd > markdownStart);
  const render = runInNewContext(`${source.slice(exportStart, exportEnd)}\n${source.slice(markdownStart, markdownEnd)}\nprojectExportText`);
  const project = { id: 'source', code: 'SRC01', name: 'Source', animals: [], events: [{
    id: 'event-1', type: 'evidence', title: 'Evidence', at: '2026-01-01', detail: 'Original notes',
    mediaId: 'media-1', movedToProjectId: 'destination', movedToProjectCode: 'DST01', movedAt: '2026-02-01'
  }] };
  const json = JSON.parse(render(project, 'json'));
  assert.equal(json.mediaManifest[0].movedToProjectId, 'destination');
  assert.equal(json.mediaManifest[0].movedToProjectCode, 'DST01');
  assert.match(render(project, 'csv'), /"movedToProjectCode"/);
  assert.match(render(project, 'csv'), /"DST01"/);
  assert.match(render(project, 'markdown'), /moved to DST01 at 2026-02-01/);
});

test('observation exports retain source evidence and separate observation and entry times', () => {
  const exportStart = source.indexOf('function exportEventTime(');
  const exportEnd = source.indexOf('\nfunction safeArchiveFileName(', exportStart);
  const markdownStart = source.indexOf('function mediaManifestMarkdown(');
  const markdownEnd = source.indexOf('\nfunction openProjectExport(', markdownStart);
  const render = runInNewContext(`${source.slice(exportStart, exportEnd)}\n${source.slice(markdownStart, markdownEnd)}\nprojectExportText`);
  const project = { id: 'project', code: 'PRJ01', name: 'Research', animals: [], events: [{
    id: 'observation', type: 'observation', title: 'Behavior', at: '2025-03-04T17:15:00.000Z',
    observedAt: '2025-03-04T17:15:00.000Z', recordedAt: '2026-11-14T00:00:00.000Z', observationTimeSource: 'researcher-entered',
    evidenceLinks: [{ eventId: 'source-event', mediaId: 'source-media', fileName: 'recording.webm', offsetSeconds: 12.5 }]
  }] };
  const json = JSON.parse(render(project, 'json'));
  assert.equal(json.events[0].observedAt, '2025-03-04T17:15:00.000Z');
  assert.equal(json.events[0].recordedAt, '2026-11-14T00:00:00.000Z');
  assert.equal(json.events[0].evidenceLinks[0].mediaId, 'source-media');
  assert.match(render(project, 'csv'), /"observationTimeSource"/);
  assert.match(render(project, 'csv'), /"evidenceLinks"/);
  assert.match(render(project, 'markdown'), /recording\.webm \(event source-event, 12\.5s\)/);
});