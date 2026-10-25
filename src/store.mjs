import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackendError, assertSerializable, expectedRevision, validateKeys, validateSegment } from './validation.mjs';
import { API_CURRENT, API_SUPPORTED, PLUGIN_ID, PLUGIN_NAME, VERSION } from './config.mjs';

const ROOT_DIR = join('.st-bainiaodata', 'storage-v1'); const RECORDS_DIR = 'records'; const TRASH_DIR = 'system-trash'; const RESERVED_NAMESPACE = TRASH_DIR; const LIST_READ_CONCURRENCY = 32; const BATCH_READ_CONCURRENCY = 16; const BATCH_READ_LIMIT = 64; const locks = new Map();
const now = () => new Date().toISOString();
const queue = (key, action) => { const previous = locks.get(key) ?? Promise.resolve(); const current = previous.catch(() => {}).then(action); const settled = current.then(() => { if (locks.get(key) === settled) locks.delete(key); }, () => { if (locks.get(key) === settled) locks.delete(key); }); locks.set(key, settled); return current; };
const userRoot = (root) => { if (typeof root !== 'string' || root.length === 0) throw new BackendError('validation', 'user data root is required'); return root; };
const paths = (root, namespace, collection, recordId) => { const keys = validateKeys(namespace, collection, recordId); if (keys.namespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved'); const base = join(userRoot(root), ROOT_DIR, RECORDS_DIR, keys.namespace, keys.collection); return { ...keys, base, file: join(base, `${keys.recordId}.json`) }; };
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function atomicWrite(file, value, renameFile = rename) {
  const dir = dirname(file); await mkdir(dir, { recursive: true, mode: 0o700 }); const temporary = join(dir, `.${basename(file)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await renameFile(temporary, file); }
  catch { await rm(temporary, { force: true }).catch(() => {}); throw new BackendError('storage_error', 'Unable to save record'); }
}
async function readEnvelope(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') throw new BackendError('not_found', 'Record not found'); if (error instanceof SyntaxError) throw new BackendError('storage_error', 'Stored record is invalid JSON'); throw new BackendError('storage_error', 'Unable to read record'); } }
function validateTrashItem(item, expected, containerNamespace, fileTrashId) { if (!item || typeof item !== 'object') throw new BackendError('storage_error', 'Invalid trash record'); const namespace = validateSegment(item.namespace, 'namespace'); const collection = validateSegment(item.collection, 'collection'); const recordId = validateSegment(item.recordId, 'record_id'); const generationId = validateSegment(item.generationId, 'generationId'); const revision = expectedRevision(item.revision); const expectedTrashId = `${generationId}-${revision}`; if (namespace === RESERVED_NAMESPACE || item.trashId !== expectedTrashId || (containerNamespace !== undefined && namespace !== containerNamespace) || (fileTrashId !== undefined && item.trashId !== fileTrashId) || !item.envelope || item.envelope.generationId !== generationId || item.envelope.revision !== revision || item.originalPath !== `${namespace}/${collection}/${recordId}.json`) throw new BackendError('storage_error', 'Invalid trash record'); if (expected && (!sameJson(item.envelope, expected.envelope) || namespace !== expected.namespace || collection !== expected.collection || recordId !== expected.recordId)) throw new BackendError('conflict', 'Trash record conflicts with current record', { currentRevision: expected.revision }); return { namespace, collection, recordId, generationId, revision }; }

export class RecordStore {
  constructor({ remove = rm, rename: renameFile = rename } = {}) { this.removeFile = remove; this.renameFile = renameFile; }
  async readListEnvelope(file) { return readEnvelope(file); }
  async health(root) { try { await stat(userRoot(root)); } catch { throw new BackendError('validation', 'user data root is unavailable'); } return { ok: true, plugin: { id: PLUGIN_ID, name: PLUGIN_NAME, version: VERSION }, api: { current: API_CURRENT, supported: API_SUPPORTED }, storage: { scope: 'user-root', path: 'hidden', envelopeSchemaVersion: 1 }, capabilities: { records: true, recordList: true, recordBatchRead: true, recordBatchWrite: true, recordIdList: true, optimisticRevision: true, atomicReplace: true, trash: true, trashRestore: true, permanentDelete: true, pagination: false, batchTransactions: false, trashGc: false, auditLog: false, diagnosticExport: false } }; }
  async get(root, namespace, collection, recordId) { return readEnvelope(paths(root, namespace, collection, recordId).file); }
  async putMany(root, namespace, collection, records) {
    const safeRoot = userRoot(root);
    if (!Array.isArray(records) || records.length < 1 || records.length > 64) throw new BackendError('validation', 'records must contain between 1 and 64 items');
    const ids = new Set();
    for (const item of records) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, 'data')) throw new BackendError('validation', 'Invalid batch record');
      paths(safeRoot, namespace, collection, item.recordId);
      expectedRevision(item.expectedRevision);
      if (ids.has(item.recordId)) throw new BackendError('validation', 'Duplicate record ID');
      ids.add(item.recordId);
    }
    if (Buffer.byteLength(assertSerializable({ records }), 'utf8') > 1048576) throw new BackendError('validation', 'Batch body exceeds 1048576 bytes');
    const results = new Array(records.length); let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++; if (index >= records.length) return;
        const item = records[index];
        try { results[index] = { recordId: item.recordId, status: 200, envelope: await this.put(safeRoot, namespace, collection, item.recordId, item.data, item.expectedRevision) }; }
        catch (error) {
          const known = error instanceof BackendError;
          results[index] = { recordId: item.recordId, status: error?.code === 'conflict' ? 409 : error?.code === 'validation' ? 400 : 500,
            error: known ? error.code : 'storage_error', message: known ? error.message : 'Unable to save record',
            ...(Number.isSafeInteger(error?.details?.currentRevision) ? { currentRevision: error.details.currentRevision } : {}) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, worker));
    return results;
  }
  async getMany(root, namespace, collection, recordIds) {
    const safeRoot = userRoot(root);
    const safeNamespace = validateSegment(namespace, 'namespace'); const safeCollection = validateSegment(collection, 'collection');
    if (safeNamespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved');
    if (!Array.isArray(recordIds) || recordIds.length < 1 || recordIds.length > BATCH_READ_LIMIT) throw new BackendError('validation', 'recordIds must contain between 1 and 64 record IDs');
    const ids = recordIds.map((recordId) => validateSegment(recordId, 'record_id'));
    const results = new Array(ids.length); let cursor = 0;
    const worker = async () => {
      while (true) {
        const index = cursor++; if (index >= ids.length) return;
        const recordId = ids[index];
        try { results[index] = { recordId, status: 200, envelope: await this.get(safeRoot, safeNamespace, safeCollection, recordId) }; }
        catch (error) {
          const status = error?.code === 'not_found' ? 404 : 500;
          const message = status === 404 ? 'Record not found' : error?.code === 'storage_error' ? error.message : 'Unable to read record';
          results[index] = { recordId, status, error: status === 404 ? 'not_found' : 'storage_error', message };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_READ_CONCURRENCY, ids.length) }, () => worker()));
    return results;
  }
  async listRecordIds(root, namespace, collection) {
    const safeNamespace = validateSegment(namespace, 'namespace'); const safeCollection = validateSegment(collection, 'collection');
    if (safeNamespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved');
    const dir = join(userRoot(root), ROOT_DIR, RECORDS_DIR, safeNamespace, safeCollection); let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to list records'); }
    return entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => entry.name.slice(0, -5));
  }
  async put(root, namespace, collection, recordId, data, revision) { const p = paths(root, namespace, collection, recordId); let serialized; try { serialized = assertSerializable(data); } catch (error) { throw error; } const expected = expectedRevision(revision); return queue(`${userRoot(root)}:${p.namespace}/${p.collection}/${p.recordId}`, async () => { let current; try { current = await readEnvelope(p.file); } catch (error) { if (error.code !== 'not_found') throw error; } const actual = current?.revision ?? 0; if (actual !== expected) throw new BackendError('conflict', 'Revision conflict', { currentRevision: actual }); const timestamp = now(); const generationId = current?.generationId ? validateSegment(current.generationId, 'generationId') : randomUUID(); const envelope = { schemaVersion: 1, revision: actual + 1, generationId, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp, data: JSON.parse(serialized) }; await atomicWrite(p.file, envelope, this.renameFile); return envelope; }); }
  async list(root, namespace, collection) { const safeNamespace = validateSegment(namespace, 'namespace'); const safeCollection = validateSegment(collection, 'collection'); if (safeNamespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved'); const dir = join(userRoot(root), ROOT_DIR, RECORDS_DIR, safeNamespace, safeCollection); let entries = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to list records'); } const files = entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)); const records = new Array(files.length); let cursor = 0, firstError = null; const worker = async () => { while (!firstError) { const index = cursor; if (index >= files.length) return; cursor += 1; const entry = files[index]; try { records[index] = { recordId: entry.name.slice(0, -5), ...(await this.readListEnvelope(join(dir, entry.name))) }; } catch (error) { firstError ??= error; } } }; await Promise.all(Array.from({ length: Math.min(LIST_READ_CONCURRENCY, files.length) }, () => worker())); if (firstError) throw firstError; return records; }
  async remove(root, namespace, collection, recordId, revision) { const p = paths(root, namespace, collection, recordId); const expected = expectedRevision(revision); return queue(`${userRoot(root)}:${p.namespace}/${p.collection}/${p.recordId}`, async () => { const current = await readEnvelope(p.file); if (current.revision !== expected) throw new BackendError('conflict', 'Revision conflict', { currentRevision: current.revision }); const generationId = current.generationId ? validateSegment(current.generationId, 'generationId') : randomUUID(); const deletionEnvelope = current.generationId ? current : { ...current, generationId }; const trashId = `${generationId}-${current.revision}`; const trashFile = join(userRoot(root), ROOT_DIR, TRASH_DIR, p.namespace, `${trashId}.json`); let trash; let created = false; try { trash = await readEnvelope(trashFile); } catch (error) { if (error.code !== 'not_found') throw error; } if (!trash) { trash = { trashId, namespace: p.namespace, collection: p.collection, recordId: p.recordId, generationId, revision: current.revision, originalPath: `${p.namespace}/${p.collection}/${p.recordId}.json`, deletedAt: now(), deletedRevision: current.revision, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), envelope: deletionEnvelope }; created = true; } if (created) await atomicWrite(trashFile, trash, this.renameFile); else validateTrashItem(trash, { ...p, generationId, envelope: deletionEnvelope, revision: current.revision }); await this.removeFile(p.file).catch((error) => { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to remove record'); }); return { trashId, deletedAt: trash.deletedAt, deletedRevision: current.revision }; }); }
  async removePermanent(root, namespace, collection, recordId, revision) { const p = paths(root, namespace, collection, recordId); const expected = expectedRevision(revision); return queue(`${userRoot(root)}:${p.namespace}/${p.collection}/${p.recordId}`, async () => { const current = await readEnvelope(p.file); if (current.revision !== expected) throw new BackendError('conflict', 'Revision conflict', { currentRevision: current.revision }); await this.removeFile(p.file).catch((error) => { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to remove record'); }); return { permanentlyDeleted: true, deletedRevision: current.revision }; }); }
  async listTrash(root, namespace) { const safeNamespace = validateSegment(namespace, 'namespace'); if (safeNamespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved'); const dir = join(userRoot(root), ROOT_DIR, TRASH_DIR, safeNamespace); let entries = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to list trash'); } const out = []; for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) { const fileTrashId = entry.name.slice(0, -5); const item = await readEnvelope(join(dir, entry.name)); validateTrashItem(item, undefined, safeNamespace, fileTrashId); const { envelope, ...rest } = item; out.push({ ...rest, revision: envelope.revision }); } return out; }
  async restore(root, namespace, trashId) { const safeNamespace = validateSegment(namespace, 'namespace'); const safeTrashId = validateSegment(trashId, 'trashId'); if (safeNamespace === RESERVED_NAMESPACE) throw new BackendError('validation', 'namespace is reserved'); const trashPath = join(userRoot(root), ROOT_DIR, TRASH_DIR, safeNamespace, `${safeTrashId}.json`); const item = await readEnvelope(trashPath); const itemKeys = validateTrashItem(item, undefined, safeNamespace, safeTrashId); const p = paths(root, itemKeys.namespace, itemKeys.collection, itemKeys.recordId); const removeTrash = async () => { try { await this.removeFile(trashPath); } catch (error) { if (error.code !== 'ENOENT') throw new BackendError('storage_error', 'Unable to finalize trash restore'); } }; return queue(`${userRoot(root)}:${p.namespace}/${p.collection}/${p.recordId}`, async () => { try { const existing = await readEnvelope(p.file); if (!sameJson(existing, item.envelope)) throw new BackendError('conflict', 'Record already exists', { currentRevision: existing.revision }); await removeTrash(); return existing; } catch (error) { if (error.code !== 'not_found') throw error; } await atomicWrite(p.file, item.envelope, this.renameFile); await removeTrash(); return item.envelope; }); }
}
