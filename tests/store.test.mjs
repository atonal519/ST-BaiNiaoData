import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordStore } from '../src/store.mjs';
const roots = []; const fresh = async () => { const root = await mkdtemp(join(tmpdir(), 'bainiao-store-')); roots.push(root); return root; };
test('batch writes preserve ordered CAS results and atomic files with at most four saves', async () => {
  const root = await fresh(); let active = 0, maxActive = 0;
  const { rename } = await import('node:fs/promises');
  const store = new RecordStore({ rename: async (from, to) => {
    active++; maxActive = Math.max(maxActive, active);
    try { await new Promise(resolve => setTimeout(resolve, 2)); if (to.endsWith('/broken.json')) throw new Error('fixture failure'); await rename(from, to); }
    finally { active--; }
  } });
  await store.put(root, 'n', 'c', 'existing', { old: true }, 0);
  const records = Array.from({ length: 64 }, (_, index) => ({ recordId: `r-${index}`, data: { text: `中性材料${index}` }, expectedRevision: 0 }));
  records[1].recordId = 'existing'; records[2].recordId = 'broken';
  const saved = await store.putMany(root, 'n', 'c', records);
  assert.deepEqual(saved.map(item => item.recordId), records.map(item => item.recordId));
  assert.equal(saved[1].status, 409); assert.equal(saved[1].currentRevision, 1); assert.equal(saved[2].status, 500);
  for (const [index, item] of saved.entries()) if (![1, 2].includes(index)) {
    assert.equal(item.status, 200); assert.equal(item.envelope.revision, 1);
    assert.deepEqual((await store.get(root, 'n', 'c', item.recordId)), item.envelope);
  }
  assert.ok(maxActive > 1); assert.ok(maxActive <= 4); assert.equal(active, 0);
  assert.deepEqual((await store.get(root, 'n', 'c', 'existing')).data, { old: true });
  assert.equal((await readdir(join(root, '.st-bainiaodata/storage-v1/records/n/c'))).some(name => name.endsWith('.tmp')), false);
});

test('batch writes validate all keys, revisions, count and canonical UTF8 bytes before saving', async () => {
  const root = await fresh(), store = new RecordStore();
  const entry = { recordId: 'valid', data: { text: '正常' }, expectedRevision: 0 };
  for (const records of [[], Array.from({ length: 65 }, (_, i) => ({ ...entry, recordId: `r-${i}` })), [entry, entry], [entry, { ...entry, recordId: '../bad' }], [entry, { ...entry, recordId: 'bad', expectedRevision: -1 }], [entry, { ...entry, recordId: 'bad', data: undefined }], [entry, { ...entry, recordId: 'big', data: '字'.repeat(350000) }]]) {
    await assert.rejects(store.putMany(root, 'n', 'c', records), error => error.code === 'validation');
    assert.deepEqual(await store.listRecordIds(root, 'n', 'c'), []);
  }
  const exact = [{ recordId: 'exact', data: '', expectedRevision: 0 }];
  const overhead = Buffer.byteLength(JSON.stringify({ records: exact })); exact[0].data = 'a'.repeat(1048576 - overhead);
  assert.equal(Buffer.byteLength(JSON.stringify({ records: exact })), 1048576);
  assert.equal((await store.putMany(root, 'n', 'c', exact))[0].status, 200);
  exact[0] = { ...exact[0], recordId: 'over', data: exact[0].data + 'aa' };
  await assert.rejects(store.putMany(root, 'n', 'c', exact), error => error.code === 'validation');
});
test.afterEach(async () => { while (roots.length) await rm(roots.pop(), { recursive: true, force: true }); });
test('CRUD, isolation, optimistic conflict, trash and restore', async () => { const a = await fresh(); const b = await fresh(); const s = new RecordStore(); const created = await s.put(a, 'n', 'c', 'r', { owner: 'A' }, 0); assert.equal(created.revision, 1); const updated = await s.put(a, 'n', 'c', 'r', { owner: 'A2' }, 1); assert.equal(updated.revision, 2); await assert.rejects(s.put(a, 'n', 'c', 'r', { owner: 'bad' }, 1), e => e.code === 'conflict'); assert.equal((await s.get(a, 'n', 'c', 'r')).data.owner, 'A2'); await assert.rejects(s.get(b, 'n', 'c', 'r'), e => e.code === 'not_found'); const removed = await s.remove(a, 'n', 'c', 'r', 2); assert.equal((await s.listTrash(a, 'n')).length, 1); await assert.rejects(s.get(a, 'n', 'c', 'r'), e => e.code === 'not_found'); const restored = await s.restore(a, 'n', removed.trashId); assert.equal(restored.data.owner, 'A2'); assert.equal((await s.list(a, 'n', 'c'))[0].recordId, 'r'); });
test('合法 JSON 数据键可完整存取，函数型 toJSON 仍被拒绝', async () => {
  const root = await fresh(); const s = new RecordStore();
  const longKey = '界'.repeat(171);
  const data = JSON.parse(`{"nested":{"toJSON":"普通字段","${longKey}":[1,{"ok":true}]}}`);
  await s.put(root, 'n', 'c', 'r', data, 0);
  assert.deepEqual((await s.get(root, 'n', 'c', 'r')).data, data);
  await assert.rejects(s.put(root, 'n', 'c', 'function-to-json', { toJSON() { return {}; } }, 0), error => error.code === 'validation' && error.message === 'data must be JSON serializable');
});
test('permanent remove 校验 revision 后直接删除且不生成 trash', async () => {
  const root = await fresh(); const s = new RecordStore();
  await s.put(root, 'n', 'c', 'r', { value: 1 }, 0);
  await assert.rejects(s.removePermanent(root, 'n', 'c', 'r', 0), error => error.code === 'conflict' && error.details.currentRevision === 1);
  assert.equal((await s.get(root, 'n', 'c', 'r')).revision, 1);
  assert.deepEqual(await s.removePermanent(root, 'n', 'c', 'r', 1), { permanentlyDeleted: true, deletedRevision: 1 });
  await assert.rejects(s.get(root, 'n', 'c', 'r'), error => error.code === 'not_found');
  await assert.rejects(s.removePermanent(root, 'n', 'c', 'r', 1), error => error.code === 'not_found');
  assert.deepEqual(await s.listTrash(root, 'n'), []);
});
test('namespace and collection isolation', async () => { const root = await fresh(); const s = new RecordStore(); await s.put(root, 'n1', 'c', 'r', { value: 1 }, 0); await s.put(root, 'n1', 'other', 'r', { value: 2 }, 0); await s.put(root, 'n2', 'c', 'r', { value: 3 }, 0); assert.equal((await s.get(root, 'n1', 'c', 'r')).data.value, 1); assert.equal((await s.get(root, 'n1', 'other', 'r')).data.value, 2); assert.equal((await s.get(root, 'n2', 'c', 'r')).data.value, 3); assert.equal((await s.list(root, 'n1', 'c')).length, 1); });
test('bounded batch reads preserve input order and isolate missing or malformed records', async () => {
  const root = await fresh(); const s = new RecordStore();
  await s.put(root, 'n', 'c', 'a', { value: 'A' }, 0); await s.put(root, 'n', 'c', 'c', { value: 'C' }, 0);
  const dir = join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c'); await writeFile(join(dir, 'broken.json'), '{');
  assert.deepEqual((await s.getMany(root, 'n', 'c', ['c', 'missing', 'broken', 'a'])).map(item => [item.recordId, item.status]), [['c', 200], ['missing', 404], ['broken', 500], ['a', 200]]);
  assert.deepEqual((await s.getMany(root, 'n', 'c', ['c', 'a'])).map(item => item.envelope.data.value), ['C', 'A']);
});
test('batch reads validate every input before any record read and cap concurrency at 16', async () => {
  const root = await fresh(); let active = 0, peak = 0, reads = 0;
  class ObservedStore extends RecordStore { async get(...args) { reads += 1; active += 1; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active -= 1; return super.get(...args); } }
  const observed = new ObservedStore(); const ids = Array.from({ length: 64 }, (_, i) => `r${i}`);
  await Promise.all(ids.map(id => observed.put(root, 'n', 'c', id, { id }, 0)));
  await assert.rejects(observed.getMany(root, 'n', 'c', [...ids.slice(0, 63), '../bad']), error => error.code === 'validation');
  assert.equal(reads, 0);
  const result = await observed.getMany(root, 'n', 'c', ids); assert.equal(result.length, 64); assert.ok(peak <= 16); assert.ok(peak > 1);
});
test('record ID listing sorts names without reading record envelopes', async () => {
  const root = await fresh(); const dir = join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c'); await mkdir(dir, { recursive: true });
  await Promise.all(['z.json', 'a.json', 'ignore.txt'].map(name => writeFile(join(dir, name), '{')));
  class ObservedStore extends RecordStore { async readListEnvelope() { throw new Error('must not read records'); } }
  assert.deepEqual(await new ObservedStore().listRecordIds(root, 'n', 'c'), ['a', 'z']);
});
test('batch read requires 1..64 valid IDs', async () => {
  const s = new RecordStore(); const root = await fresh();
  await assert.rejects(s.getMany(root, 'n', 'c', []), error => error.code === 'validation');
  await assert.rejects(s.getMany(root, 'n', 'c', Array.from({ length: 65 }, (_, i) => `r${i}`)), error => error.code === 'validation');
});
test('record list 保持文件名顺序并将并发读取限制为32', async () => { const root = await fresh(); const dir = join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c'); await mkdir(dir, { recursive: true }); const names = Array.from({ length: 65 }, (_, index) => `record-${String(index).padStart(3, '0')}`); await Promise.all(names.map(name => writeFile(join(dir, `${name}.json`), '{}'))); class ObservedStore extends RecordStore { active = 0; peak = 0; async readListEnvelope(file) { this.active += 1; this.peak = Math.max(this.peak, this.active); await new Promise(resolve => setImmediate(resolve)); this.active -= 1; return { schemaVersion: 1, revision: 1, data: { file } }; } } const s = new ObservedStore(); const listed = await s.list(root, 'n', 'c'); assert.deepEqual(listed.map(item => item.recordId), names); assert.equal(s.peak, 32); });
test('record list 任一文件读取失败仍按原 storage_error 语义整体失败', async () => { const root = await fresh(); const dir = join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c'); await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'a.json'), JSON.stringify({ revision: 1, data: {} })); await writeFile(join(dir, 'b.json'), '{'); await assert.rejects(new RecordStore().list(root, 'n', 'c'), error => error.code === 'storage_error' && error.message === 'Stored record is invalid JSON'); });
test('formal root is used and pre-existing temporary prototype root is untouched', async () => { const root = await fresh(); const oldFile = join(root, '.temporary-plugin-backend-prototype', 'sentinel.json'); await mkdir(join(root, '.temporary-plugin-backend-prototype'), { recursive: true }); await writeFile(oldFile, '{"legacy":true}\n'); const s = new RecordStore(); await s.put(root, 'n', 'c', 'r', {}, 0); assert.deepEqual(await readdir(join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c')), ['r.json']); assert.equal(await readFile(oldFile, 'utf8'), '{"legacy":true}\n'); });
test('atomic rename failure preserves old record and temp cleanup', async () => { const root = await fresh(); let calls = 0; const s = new RecordStore({ rename: async (from, to) => { calls += 1; if (calls === 2) throw new Error('injected absolute /secret/path'); return (await import('node:fs/promises')).rename(from, to); } }); await s.put(root, 'n', 'c', 'r', { value: 0 }, 0); await assert.rejects(s.put(root, 'n', 'c', 'r', { value: 1 }, 1), e => e.code === 'storage_error' && !e.message.includes(root)); assert.equal((await s.get(root, 'n', 'c', 'r')).data.value, 0); assert.deepEqual(await readdir(join(root, '.st-bainiaodata', 'storage-v1', 'records', 'n', 'c')), ['r.json']); });
test('trash URL namespace, filename and content trashId must match', async () => { const root = await fresh(); const s = new RecordStore(); await s.put(root, 'n', 'c', 'r', {}, 0); const deleted = await s.remove(root, 'n', 'c', 'r', 1); const dir = join(root, '.st-bainiaodata', 'storage-v1', 'system-trash'); const file = join(dir, 'n', `${deleted.trashId}.json`); const item = JSON.parse(await readFile(file, 'utf8')); item.trashId = 'wrong'; await writeFile(file, JSON.stringify(item)); await assert.rejects(s.listTrash(root, 'n'), e => e.code === 'storage_error' && !e.message.includes(root)); await assert.rejects(s.restore(root, 'n', deleted.trashId), e => e.code === 'storage_error' && !e.message.includes(root)); await writeFile(file, JSON.stringify({ ...item, trashId: deleted.trashId })); await mkdir(join(dir, 'other'), { recursive: true }); await writeFile(join(dir, 'other', `${deleted.trashId}.json`), JSON.stringify({ ...item, trashId: deleted.trashId, namespace: 'n' })); await assert.rejects(s.listTrash(root, 'other'), e => e.code === 'storage_error' && !e.message.includes(root)); });
test('restore cleanup failure returns storage_error and retry is idempotent', async () => { const root = await fresh(); let fail = true; const s = new RecordStore({ remove: async (file) => { if (file.includes('system-trash') && fail) { fail = false; const error = new Error('absolute /private/path'); error.code = 'EIO'; throw error; } return rm(file); } }); await s.put(root, 'n', 'c', 'r', {}, 0); const deleted = await s.remove(root, 'n', 'c', 'r', 1); await assert.rejects(s.restore(root, 'n', deleted.trashId), e => e.code === 'storage_error' && !e.message.includes(root)); assert.equal((await s.get(root, 'n', 'c', 'r')).revision, 1); const retried = await s.restore(root, 'n', deleted.trashId); assert.equal(retried.revision, 1); assert.deepEqual(await s.listTrash(root, 'n'), []); });
test('restore conflicts with a rebuilt record', async () => { const root = await fresh(); const s = new RecordStore(); await s.put(root, 'n', 'c', 'r', { value: 1 }, 0); const deleted = await s.remove(root, 'n', 'c', 'r', 1); await s.put(root, 'n', 'c', 'r', { value: 2 }, 0); await assert.rejects(s.restore(root, 'n', deleted.trashId), e => e.code === 'conflict' && e.details.currentRevision === 1); });
