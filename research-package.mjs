import { Unzip, UnzipInflate } from './vendor/fflate/fflate.browser.js';

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 10000;

export async function readResearchPackage(file) {
  if (!file || file.size === 0 || file.size > MAX_ARCHIVE_BYTES) throw new Error('Research ZIP must be non-empty and no larger than 256 MiB.');
  const tailOffset = Math.max(0, file.size - 65557);
  const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === tail.length) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('Research ZIP is incomplete or invalid.');
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0 || view.getUint16(endOffset + 8, true) !== entryCount || entryCount === 65535 || entryCount > MAX_ENTRIES || directoryOffset + directorySize > tailOffset + endOffset) {
    throw new Error('Research ZIP uses an unsupported or invalid archive structure.');
  }
  const entries = new Map();
  let total = 0;
  let count = 0;
  const unzip = new Unzip(entry => {
    count++;
    if (count > MAX_ENTRIES) throw new Error('Research ZIP contains too many entries.');
    if (entries.has(entry.name)) throw new Error('Research ZIP contains duplicate paths.');
    if (entry.name !== 'research-record.json' && entry.name !== 'README.txt' && !/^evidence\/[^/\\\u0000-\u001f]+$/.test(entry.name)) {
      throw new Error('Research ZIP contains an unsupported path.');
    }
    const limit = entry.name === 'research-record.json' ? MAX_MANIFEST_BYTES : MAX_ENTRY_BYTES;
    if (entry.originalSize != null && entry.originalSize > limit) throw new Error('A research ZIP entry exceeds its size limit.');
    const item = { chunks: [], size: 0, complete: false };
    entries.set(entry.name, item);
    entry.ondata = (error, chunk, final) => {
      if (error) throw error;
      item.size += chunk.length;
      total += chunk.length;
      if (item.size > limit || total > MAX_TOTAL_BYTES) throw new Error('Research ZIP exceeds its decompressed size limit.');
      if (chunk.length) item.chunks.push(chunk);
      if (final) item.complete = true;
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.length; offset += 65536) unzip.push(value.subarray(offset, offset + 65536));
    }
    unzip.push(new Uint8Array(0), true);
  } finally {
    reader.releaseLock();
  }
  if (count !== entryCount) throw new Error('Research ZIP entry count is inconsistent.');
  if ([...entries.values()].some(entry => !entry.complete)) throw new Error('Research ZIP is incomplete.');
  const manifest = entries.get('research-record.json');
  if (!manifest) throw new Error('Research ZIP has no research-record.json.');
  let record;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await new Blob(manifest.chunks).arrayBuffer())); }
  catch { throw new Error('Research ZIP manifest is invalid.'); }
  if (record?.schema !== 'intelligensicus.research-export' || record.schemaVersion !== 1 || !record.project || !Array.isArray(record.individuals) || !Array.isArray(record.events) || !Array.isArray(record.mediaManifest)) {
    throw new Error('Unsupported or incomplete research ZIP manifest.');
  }
  const { project } = record;
  if (typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !project.name || !/^[A-Z]{3}\d{2}$/.test(project.code || '') || typeof project.createdAt !== 'string') {
    throw new Error('Research ZIP project details are invalid.');
  }
  const events = new Map();
  for (const event of record.events) {
    if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' || typeof event.title !== 'string' || typeof event.at !== 'string' || events.has(event.id)) throw new Error('Research ZIP event records are invalid.');
    events.set(event.id, event);
  }
  const individualIds = new Set();
  for (const individual of record.individuals) {
    if (!individual || typeof individual.id !== 'string' || !individual.id || typeof individual.name !== 'string' || typeof individual.code !== 'string' || individualIds.has(individual.id)) throw new Error('Research ZIP individual records are invalid.');
    individualIds.add(individual.id);
  }
  const media = new Map();
  const referencedEvents = new Set();
  for (const item of record.mediaManifest) {
    const event = events.get(item?.eventId);
    if (!event || event.type !== 'evidence' || typeof event.mediaId !== 'string' || !event.mediaId || event.mediaId !== item.mediaId || item.binaryIncluded !== true || typeof item.archivePath !== 'string' || !item.archivePath.startsWith('evidence/') || !entries.has(item.archivePath) || referencedEvents.has(item.eventId)) {
      throw new Error('Research ZIP contains an invalid evidence reference.');
    }
    referencedEvents.add(item.eventId);
    const previous = media.get(item.mediaId);
    if (previous && previous.path !== item.archivePath) throw new Error('Research ZIP has conflicting media references.');
    if (!previous) {
      const entry = entries.get(item.archivePath);
      media.set(item.mediaId, { id: item.mediaId, path: item.archivePath, name: item.fileName || event.title, type: item.mimeType || 'application/octet-stream', blob: new Blob(entry.chunks, { type: item.mimeType || 'application/octet-stream' }) });
    }
  }
  for (const event of record.events) if (event.type === 'evidence' && !referencedEvents.has(event.id)) throw new Error('Research ZIP is missing an evidence file.');
  return { project: { ...project, animals: record.individuals, events: record.events, references: [] }, media: [...media.values()] };
}