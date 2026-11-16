import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function searchProjectRecords(');
const end = source.indexOf('\nfunction bindRecordActions(', start);
if (start < 0 || end < 0) throw new Error('Research search helper not found');
const search = runInNewContext(`(${source.slice(start, end)})`);
const project = {
  animals: [{ id: 'a', code: 'PRJ01-001', name: 'Mira', species: 'Canid' }],
  events: [
    { id: 'obs', type: 'observation', title: 'Puzzle', animalId: 'a', welfare: 'Calm', evidenceLinks: [{ fileName: 'field-video.webm' }] },
    { id: 'media', type: 'evidence', title: 'field-photo.jpg', detail: 'Morning' }
  ]
};

test('search combines individual and record terms case-insensitively', () => {
  const result = search(project, 'MIRA calm');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].id, 'obs');
});

test('search filters records and searches linked evidence names', () => {
  assert.equal(search(project, 'field', 'evidence').events[0].id, 'media');
  assert.equal(search(project, 'field-video', 'observation').events[0].id, 'obs');
  assert.equal(search(project, 'mira', 'animal').animals[0].id, 'a');
  assert.equal(search(project, 'mira', 'animal').events.length, 0);
});

test('empty searches and other projects do not invent results', () => {
  assert.equal(search(project, ' ').events.length, 0);
  assert.equal(search({ animals: [], events: [] }, 'mira').animals.length, 0);
});