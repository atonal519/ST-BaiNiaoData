import { BackendError, expectedRevision } from './validation.mjs';
import { RecordStore } from './store.mjs';

const rootOf = (request) => request?.user?.directories?.root;
const send = (response, status, body) => { response.status(status).json(body); };
const wrap = (handler) => async (request, response) => {
  try { send(response, 200, await handler(request)); }
  catch (error) {
    const e = error instanceof BackendError ? error : new BackendError('storage_error', 'Storage operation failed');
    const status = e.code === 'conflict' ? 409 : e.code === 'not_found' ? 404 : e.code === 'validation' ? 400 : 500;
    send(response, status, { error: e.code, message: e.message, ...(e.details ?? {}) });
  }
};

export function registerRoutes(router, store = new RecordStore()) {
  router.get('/v1/health', wrap((req) => store.health(rootOf(req))));
  router.get('/v1/records/:namespace/:collection/:recordId', wrap((req) => store.get(rootOf(req), req.params.namespace, req.params.collection, req.params.recordId)));
  router.put('/v1/records/:namespace/:collection/:recordId', wrap((req) => store.put(rootOf(req), req.params.namespace, req.params.collection, req.params.recordId, req.body?.data, expectedRevision(req.body?.expectedRevision))));
  router.get('/v1/records/:namespace/:collection', wrap((req) => store.list(rootOf(req), req.params.namespace, req.params.collection)));
  router.delete('/v1/records/:namespace/:collection/:recordId', wrap((req) => store.remove(rootOf(req), req.params.namespace, req.params.collection, req.params.recordId, expectedRevision(req.body?.expectedRevision))));
  router.get('/v1/trash/:namespace', wrap((req) => store.listTrash(rootOf(req), req.params.namespace)));
  router.post('/v1/trash/:namespace/:trashId/restore', wrap((req) => store.restore(rootOf(req), req.params.namespace, req.params.trashId)));
  return router;
}
