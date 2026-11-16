import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync, strToU8 } from '../vendor/fflate/fflate.browser.js';
import { readResearchPackage } from '../research-package.mjs';

function archive(record, extra = {}) {
  return new Blob([zipSync({ 'research-record.json': strToU8(JSON.stringify(record)), ...extra })], { type: 'application/zip' });
}

function manifest() {
  return {
    schema: 'intelligensicus.research-export', schemaVersion: 1,
    project: { id: 'project', code: 'PRJ01', name: 'Research', createdAt: '2026-01-01' },
    individuals: [{ id: 'animal', code: 'PRJ01-001', name: 'Individual' }],
    events: [{ id: 'event', type: 'evidence', title: 'photo.jpg', at: '2026-01-01', mediaId: 'media', animalId: 'animal' }],
    mediaManifest: [{ eventId: 'event', mediaId: 'media', fileName: 'photo.jpg', mimeType: 'image/jpeg', binaryIncluded: true, archivePath: 'evidence/photo.jpg' }]
  };
}

test('reads research records and original evidence from an exported package', async () => {
  const result = await readResearchPackage(archive(manifest(), { 'evidence/photo.jpg': strToU8('original') }));
  assert.equal(result.project.animals[0].id, 'animal');
  assert.equal(result.project.events[0].animalId, 'animal');
  assert.equal(result.media[0].id, 'media');
  assert.equal(await result.media[0].blob.text(), 'original');
});

test('rejects packages missing referenced evidence', async () => {
  await assert.rejects(readResearchPackage(archive(manifest())), /invalid evidence reference/);
});

test('rejects unexpected archive paths', async () => {
  await assert.rejects(readResearchPackage(archive(manifest(), { '../outside': strToU8('bad') })), /unsupported path/);
});

test('rejects unsupported manifest versions', async () => {
  const record = manifest();
  record.schemaVersion = 2;
  await assert.rejects(readResearchPackage(archive(record)), /Unsupported or incomplete/);
});

test('rejects a truncated archive even if its local entries are intact', async () => {
  const data = zipSync({ 'research-record.json': strToU8(JSON.stringify(manifest())), 'evidence/photo.jpg': strToU8('original') });
  await assert.rejects(readResearchPackage(new Blob([data.subarray(0, data.length - 22)])), /incomplete or invalid/);
});