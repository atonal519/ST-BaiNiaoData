export class BackendError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'BackendError'; this.code = code; this.details = details; }
}

export function validateSegment(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || Buffer.byteLength(value, 'utf8') > 512 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw new BackendError('validation', `Invalid ${label}`);
  return value;
}

export function validateKeys(namespace, collection, recordId) {
  return { namespace: validateSegment(namespace, 'namespace'), collection: validateSegment(collection, 'collection'), recordId: validateSegment(recordId, 'record_id') };
}

export function assertSerializable(value) {
  const visit = (item, seen) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw new Error('non-finite'); return; }
    if (typeof item !== 'object') throw new Error('unsupported type');
    if (seen.has(item)) throw new Error('cycle'); seen.add(item);
    if (Array.isArray(item)) {
      for (const key of Reflect.ownKeys(item)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^\d+$/u.test(key) || String(Number(key)) !== key || Number(key) >= item.length || Number(key) >= 2 ** 32 - 1) throw new Error('array property');
        const descriptor = Object.getOwnPropertyDescriptor(item, key); if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('array descriptor');
      }
      for (let index = 0; index < item.length; index += 1) { if (!Object.prototype.hasOwnProperty.call(item, index)) throw new Error('sparse'); visit(item[index], seen); }
    } else {
      const prototype = Object.getPrototypeOf(item); if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain');
      for (const key of Reflect.ownKeys(item)) { if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') > 512) throw new Error('key'); const descriptor = Object.getOwnPropertyDescriptor(item, key); if (!descriptor?.enumerable || !('value' in descriptor) || key === 'toJSON') throw new Error('descriptor'); visit(descriptor.value, seen); }
    }
    seen.delete(item);
  };
  try { visit(value, new Set()); return JSON.stringify(value); } catch { throw new BackendError('validation', 'data must be JSON serializable'); }
}

export function expectedRevision(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new BackendError('validation', 'expectedRevision must be a non-negative integer');
  return value;
}
